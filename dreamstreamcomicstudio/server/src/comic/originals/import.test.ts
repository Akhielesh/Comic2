// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { EditorialReview } from './review.js';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { ORIGINAL_SLUGS, collectionEdition, type OriginalKey } from '../../../../shared/comic/originals.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { cleanAnswer } from '../safety/fakes.js';
import { installSafetyFakes, resetSafety } from '../safety/testkit.js';
import { inspectOriginal, originalMetadata, sha256 } from './book.js';
import { publishBundledOriginal } from './import.js';

vi.mock('../../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/supabase.js')>()),
  getSupabaseAdmin: vi.fn()
}));

const source = {
  title: 'A Paper Boat',
  summary: 'The boat reaches a garden.',
  coverAlt: 'A folded boat on a stream.',
  style: 'Watercolor',
  rating: 'G',
  language: 'en',
  pages: Array.from({ length: 15 }, (_, i) => ({
    n: i + 1,
    alt: 'Boat scene ' + (i + 1),
    transcript: 'Narrator: Story passage ' + (i + 1) + '\nBo: I see the garden.'
  }))
};
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'editorial-edition-'));
  const folder = join(root, 'harbor');
  await mkdir(folder);
  await writeFile(join(folder, 'book.json'), JSON.stringify(source));
  for (let i = 0; i <= 15; i++) {
    const image = await sharp({
      create: { width: 520, height: 700, channels: 3, background: { r: 15 + i * 14, g: 200 - i * 8, b: 90 + i * 4 } }
    })
      .webp()
      .toBuffer();
    await writeFile(join(folder, i ? 'p' + String(i).padStart(2, '0') + '.webp' : 'cover.webp'), image);
  }
});
function collectionSource(key: OriginalKey) {
  const { pages: count, ...format } = collectionEdition(key)!;
  return {
    ...source,
    ...format,
    pages: Array.from({ length: count }, (_, i) => ({
      n: i + 1,
      alt: 'Panel description ' + (i + 1),
      transcript: 'Lettered line ' + (i + 1)
    }))
  };
}
beforeAll(async () => {
  for (const key of ['margin', 'glass-hills'] as const) {
    const book = collectionSource(key);
    const dir = join(root, key);
    await mkdir(dir);
    await writeFile(join(dir, 'book.json'), JSON.stringify(book));
    const landscape = book.orientation === 'landscape';
    for (let i = 0; i <= book.pages.length; i++) {
      const bytes = await sharp({
        create: {
          width: landscape ? 720 : 480,
          height: landscape ? 480 : 720,
          channels: 3,
          background: { r: 30 + 5 * i, g: 150 - 3 * i, b: 180 + 2 * i }
        }
      })
        .webp()
        .toBuffer();
      await writeFile(join(dir, i ? 'p' + String(i).padStart(2, '0') + '.webp' : 'cover.webp'), bytes);
    }
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  resetSafety();
  vi.resetAllMocks();
});

/** PostgREST & immutable object transport. PostgreSQL independently tests the actual constraints, locks and ACLs. */
function localBackend() {
  const objects = new Map<string, Buffer>();
  const dbRow: Record<string, unknown> = {};
  const revision: Record<string, unknown> = {};
  let failUploadAt = 0;
  let attempts = 0;
  const rpc = vi.fn(async (name: string, params: Record<string, string>) => {
    if (name === 'comic_originals_public_payload') {
      return {
        error: null,
        data:
          dbRow.status === 'live' && dbRow.slug === params.p_slug
            ? { publication: { assetKey: dbRow.asset_key }, doc: dbRow.snapshot }
            : null
      };
    }
    if (name === 'studio_claim_original_revision') {
      if (dbRow.status !== 'blocked' || dbRow.gate_hash !== params.p_prior_gate || dbRow.source_digest !== params.p_prior_digest)
        return { data: null, error: { message: 'Receipt mismatch' } };
      Object.assign(revision, { token: params.p_token, priorDigest: dbRow.source_digest, rating: params.p_rating });
      return { data: true, error: null };
    }
    if (name === 'studio_finish_original_revision') {
      expect(dbRow.status).toBe('blocked');
      expect(dbRow.source_digest).toBe(revision.priorDigest);
      expect(objects.size).toBe(0);
      expect(params.p_token).toBe(revision.token);
      Object.assign(revision, { status: params.p_status, report: params.p_report });
      if (params.p_status === 'cleared')
        Object.assign(dbRow, {
          status: 'checked',
          rating: revision.rating,
          source_digest: params.p_digest,
          checked_digest: params.p_digest,
          review_report: params.p_report
        });
      return { data: true, error: null };
    }
    expect(name).toBe('studio_claim_original');
    if (!dbRow.book_key)
      Object.assign(dbRow, {
        book_key: params.p_key,
        slug: params.p_slug,
        source_digest: params.p_digest,
        asset_key: params.p_asset_key,
        status: 'staging'
      });
    if (dbRow.source_digest !== params.p_digest)
      return { data: null, error: { code: 'P0001', message: 'This source differs from the registered edition' } };
    if (dbRow.status === 'blocked') return { data: null, error: { message: 'unavailable' } };
    Object.assign(dbRow, { lease_token: params.p_token, lease_until: new Date(Date.now() + 3600000).toISOString() });
    return {
      data: { status: dbRow.status, assetKey: dbRow.asset_key, publishedAt: dbRow.published_at, moderationUsd: dbRow.moderation_usd ?? 0 },
      error: null
    };
  });
  const from = (name: string) => {
    expect(name).toBe('studio_original_editions');
    return {
      update: (values: Record<string, unknown>) => {
        const predicates: Array<() => boolean> = [];
        const apply = () => {
          if (!predicates.every((test) => test())) return { data: null, error: null };
          Object.assign(dbRow, values);
          return { data: { book_key: dbRow.book_key }, error: null };
        };
        const builder = {
          eq(field: string, value: unknown) {
            predicates.push(() => dbRow[field] === value);
            return this;
          },
          in(field: string, allow: unknown[]) {
            predicates.push(() => allow.includes(dbRow[field]));
            return this;
          },
          gt(field: string, value: string) {
            predicates.push(() => String(dbRow[field]) > value);
            return this;
          },
          select() {
            return this;
          },
          maybeSingle: async () => apply(),
          then(resolve: (result: ReturnType<typeof apply>) => unknown) {
            return Promise.resolve(apply()).then(resolve);
          }
        };
        return builder;
      }
    };
  };
  const upload = vi.fn(async (path: string, bytes: Buffer, options: { upsert: boolean }) => {
    expect(dbRow.status).toBe('checked');
    expect(options.upsert).toBe(false);
    if (++attempts === failUploadAt) return { error: { message: 'Temporary storage error', statusCode: 503 } };
    if (objects.has(path)) return { error: { message: 'Already exists', statusCode: 409 } };
    objects.set(path, Buffer.from(bytes));
    return { error: null };
  });
  const storage = {
    getBucket: async () => ({ data: { public: true }, error: null }),
    from: () => ({
      upload,
      download: async (path: string) => ({ error: null, data: { arrayBuffer: async () => new Uint8Array(objects.get(path)!).buffer } })
    })
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from, rpc, storage } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return {
    dbRow,
    revision,
    rpc,
    objects,
    upload,
    failOnUpload: (at: number) => {
      failUploadAt = at;
    }
  };
}

describe('Studio Originals publication', () => {
  it('keeps the historical Tide record and never opens storage or contacts a reviewer to release it', async () => {
    const fakes = installSafetyFakes();
    const db = localBackend();
    await expect(publishBundledOriginal('tide', root)).rejects.toThrow('held from publication');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(db.upload).not.toHaveBeenCalled();
    expect(fakes.llm.calls).toHaveLength(0);
  });

  it.each(['blocked', 'unavailable'] as const)(
    'withholds every public byte on a %s provider assessment',
    async (outcome) => {
      const fakes = installSafetyFakes(outcome === 'unavailable' ? { llm: null } : {});
      if (outcome === 'blocked') {
        fakes.llm.fallback = (req) =>
          req.jsonSchema?.name === 'comic_safety_image'
            ? { ...cleanAnswer(req), rating: 'X', categories: ['graphic_gore'] }
            : cleanAnswer(req);
      }
      const db = localBackend();
      await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('did not clear');
      expect(db.dbRow.status).toBe(outcome === 'blocked' ? 'blocked' : 'staging');
      const report = db.dbRow.review_report as EditorialReview['report'];
      expect(report.pages).toHaveLength(15);
      for (const target of [report.cover, ...report.pages]) {
        expect(target).toEqual(
          outcome === 'blocked'
            ? { status: 'blocked', assessed: 'X', categories: ['graphic_gore'] }
            : { status: 'unchecked', assessed: null, categories: [] }
        );
      }
      expect(db.dbRow.lease_token).toBeNull();
      expect(db.dbRow.snapshot).toBeUndefined();
      expect(db.objects.size).toBe(0);
      expect(db.upload).not.toHaveBeenCalled();
      expect(fakes.store.actions).toEqual([]);
    },
    20000
  );

  it('retains a hard category even if the provider gives the same image an allowed age', async () => {
    const fake = installSafetyFakes();
    fake.llm.fallback = (req) =>
      req.jsonSchema?.name === 'comic_safety_image' ? { ...cleanAnswer(req), rating: 'G', categories: ['dangerous'] } : cleanAnswer(req);
    const db = localBackend();
    await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('did not clear');
    expect(db.dbRow.status).toBe('blocked');
    const report = db.dbRow.review_report as EditorialReview['report'];
    expect(report.cover).toMatchObject({ assessed: 'G', categories: ['dangerous'] });
    expect(db.objects.size).toBe(0);
  }, 20000);

  it('resumes a partial upload after the complete real gate, verifies all uploaded bytes and preserves transcripts', async () => {
    const fakes = installSafetyFakes();
    const db = localBackend();
    db.failOnUpload(3);
    await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('upload failed');
    expect(db.dbRow).toMatchObject({ status: 'checked', checked_digest: db.dbRow.source_digest, lease_token: null });
    expect(db.objects.size).toBe(2);
    expect(db.dbRow.snapshot).toBeUndefined();
    const imageCalls = fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image');
    expect(imageCalls).toHaveLength(16);
    expect(new Set(imageCalls.map((call) => JSON.stringify(call.messages))).size).toBe(16);
    const readText = JSON.stringify(fakes.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_text'));
    for (const page of source.pages) {
      expect(readText).toContain(page.alt);
      expect(readText).toContain(page.transcript.split('\n')[0]);
    }
    expect(readText).toContain(source.coverAlt);
    const checks = fakes.llm.calls.length;
    await expect(publishBundledOriginal('harbor', root)).resolves.toEqual({ slug: 'DSOriginalPort001' });
    expect(fakes.llm.calls).toHaveLength(checks);
    const doc = db.dbRow.snapshot as ComicDoc;
    expect(doc.id).toBe('DSOriginalPort001');
    expect(doc.createdAt).toBe(Date.parse(String(db.dbRow.published_at)));
    expect(doc.pages).toHaveLength(15);
    expect(doc.cover.readerAlt).toBe(source.coverAlt);
    for (let i = 0; i < 16; i++) {
      const target = i ? doc.pages[i - 1] : doc.cover;
      const asset = target.render.asset!;
      const file = i ? 'p' + String(i).padStart(2, '0') + '.webp' : 'cover.webp';
      expect(asset.path).toMatch(/^pub\/[A-Za-z0-9]{22}\//);
      expect(sha256(db.objects.get(asset.path)!)).toBe(sha256(await readFile(join(root, 'harbor', file))));
      expect(asset.variants).toHaveLength(1);
      expect((await sharp(db.objects.get(asset.variants![0].path)).metadata()).width).toBe(480);
      if (i) {
        expect(target.readerAlt).toBe(source.pages[i - 1].alt);
        expect(doc.pages[i - 1].panels[0].lines.map((line) => line.text).join('\n')).toBe(source.pages[i - 1].transcript);
      }
    }
    expect(db.objects.size).toBe(33);
    expect(db.dbRow.card).toMatchObject({ pageCount: 15, creator: 'DreamStream Studio Originals' });
    expect(JSON.stringify(doc)).not.toContain('library/studio-originals');
    const uploads = db.upload.mock.calls.length;
    await expect(publishBundledOriginal('harbor', root)).resolves.toEqual({ slug: 'DSOriginalPort001' });
    expect(db.upload).toHaveBeenCalledTimes(uploads);
    expect(fakes.llm.calls).toHaveLength(checks);
  }, 30000);

  it('refuses an immutable object if its existing bytes differ', async () => {
    installSafetyFakes();
    const db = localBackend();
    db.failOnUpload(2);
    await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('upload failed');
    const [path] = db.objects.keys();
    db.objects.set(path, Buffer.from('corrupt'));
    await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('checksum mismatch');
    expect(db.dbRow.status).toBe('checked');
    expect(db.dbRow.snapshot).toBeUndefined();
  }, 20000);
});

const bundledRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/originals');
it('publishes Harbor from its separate manuscript and sixteen original plates through a first-time gate', async () => {
  const fake = installSafetyFakes();
  const db = localBackend();
  const files = ['cover.webp', ...Array.from({ length: 15 }, (_, i) => 'p' + String(i + 1).padStart(2, '0') + '.webp')];
  const prior = new Set<string>();
  for (const key of ['tide', 'orchard', 'fox', 'table-nine']) {
    for (const file of files) prior.add(sha256(await readFile(join(bundledRoot, key, file))));
  }
  const manuscript = JSON.parse(await readFile(join(bundledRoot, 'harbor', 'book.json'), 'utf8')) as typeof source;
  expect(manuscript.title).toBe('The Harbor That Listened');
  expect(manuscript.rating).toBe('PG');
  await expect(publishBundledOriginal('harbor', bundledRoot)).resolves.toEqual({ slug: 'DSOriginalPort001' });
  const doc = db.dbRow.snapshot as ComicDoc;
  const locators = [doc.cover.render.asset!, ...doc.pages.map((p) => p.render.asset!)];
  expect(locators).toHaveLength(files.length);
  for (const [i, file] of files.entries()) {
    const digest = sha256(await readFile(join(bundledRoot, 'harbor', file)));
    expect(prior.has(digest)).toBe(false);
    expect(sha256(db.objects.get(locators[i].path)!)).toBe(digest);
    if (i) {
      expect(doc.pages[i - 1].readerAlt).toBe(manuscript.pages[i - 1].alt);
      expect(doc.pages[i - 1].panels[0].lines.map((l) => l.text)).toEqual(
        manuscript.pages[i - 1].transcript
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      );
    }
  }
  expect(doc.cover.readerAlt).toBe(manuscript.coverAlt);
  expect(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image')).toHaveLength(16);
  expect(db.rpc.mock.calls.some(([name]) => name === 'studio_claim_original_revision')).toBe(false);
  expect(db.dbRow.card).toMatchObject({ title: manuscript.title, pageCount: 15 });
}, 40000);

const historicalOrchard = {
  book_key: 'orchard',
  slug: 'DSOriginalTree001',
  asset_key: 'EditorialTestFixture01',
  status: 'blocked',
  rating: 'G',
  source_digest: 'dbcb04155d5e7db8b818dc1ed20fadd979a249c0d89023d59804ab01bdafd0a3',
  gate_hash: 'b293c8b66d1b68d397ddbf04'
};

describe('registered collection reading formats', () => {
  it.each(['margin', 'parrots', 'bubble', 'glass-hills', 'night-atlas'] as const)(
    'rejects a short, mislabeled or reordered %s edition',
    (key) => {
      const raw = collectionSource(key);
      expect(originalMetadata(key, raw)).toMatchObject({ kind: raw.kind, readingDirection: raw.readingDirection });
      expect(() => originalMetadata(key, { ...raw, pages: raw.pages.slice(0, -1) })).toThrow('story pages');
      expect(() => originalMetadata(key, { ...raw, pages: [...raw.pages].reverse() })).toThrow('reading order');
      expect(() => originalMetadata(key, { ...raw, readingDirection: raw.readingDirection === 'rtl' ? 'ltr' : 'rtl' })).toThrow(
        'reading format'
      );
      expect(() => originalMetadata(key, { ...raw, title: 'Another title' })).toThrow('registered edition');
    }
  );
  it.each(['margin', 'glass-hills'] as const)(
    'checks every illustrated leaf of %s and publishes the native reading format',
    async (key) => {
      const fake = installSafetyFakes();
      const db = localBackend();
      const edition = collectionEdition(key)!;
      const count = edition.pages;
      await expect(publishBundledOriginal(key, root)).resolves.toEqual({ slug: ORIGINAL_SLUGS[key] });
      const report = db.dbRow.review_report as EditorialReview['report'];
      expect(report.pages).toHaveLength(count);
      expect([report.text, report.cover, ...report.pages].every((t) => t.status === 'pass')).toBe(true);
      expect(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image')).toHaveLength(count + 1);
      expect(JSON.stringify(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_text'))).toContain('Lettered line ' + count);
      expect(db.rpc.mock.calls.some(([name]) => name === 'studio_claim_original_revision')).toBe(false);
      const doc = db.dbRow.snapshot as ComicDoc;
      const aspect = edition.orientation === 'landscape' ? '3:2' : '2:3';
      expect(doc.format).toMatchObject({
        pageCount: count,
        kind: edition.kind,
        readingDirection: edition.readingDirection,
        pageAspect: aspect
      });
      expect(db.dbRow.card).toMatchObject({ pageCount: count, aspect, kindLabel: edition.kind === 'manga' ? 'Manga' : 'Comic' });
      expect(doc.pages.at(-1)?.readerAlt).toBe('Panel description ' + count);
    },
    40000
  );
  it.each(['margin', 'parrots', 'bubble', 'glass-hills', 'night-atlas'] as const)(
    'builds the reader from every frozen source plate in the published %s bundle',
    async (key) => {
      const fake = installSafetyFakes();
      const db = localBackend();
      const edition = collectionEdition(key)!;
      const manuscript = JSON.parse(await readFile(join(bundledRoot, key, 'book.json'), 'utf8')) as typeof source;
      await expect(publishBundledOriginal(key, bundledRoot)).resolves.toEqual({ slug: ORIGINAL_SLUGS[key] });
      expect(db.dbRow.status).toBe('live');
      const doc = db.dbRow.snapshot as ComicDoc;
      expect(doc.format).toMatchObject({ kind: edition.kind, readingDirection: edition.readingDirection, pageCount: edition.pages });
      expect(doc.format.colorMode).toBe(edition.colorMode ?? 'color');
      expect(doc.pages.map((p) => p.readerAlt)).toEqual(manuscript.pages.map((p) => p.alt));
      expect(doc.pages.map((p) => p.panels[0].lines.map((line) => line.text))).toEqual(
        manuscript.pages.map((p) =>
          p.transcript
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        )
      );
      const uploaded = [doc.cover.render.asset!, ...doc.pages.map((p) => p.render.asset!)];
      for (const [index, asset] of uploaded.entries()) {
        const file = index ? 'p' + String(index).padStart(2, '0') + '.webp' : 'cover.webp';
        expect(sha256(db.objects.get(asset.path)!)).toBe(sha256(await readFile(join(bundledRoot, key, file))));
      }
      const report = db.dbRow.review_report as EditorialReview['report'];
      expect(report.pages).toHaveLength(edition.pages);
      expect([report.text, report.cover, ...report.pages].every((v) => v.status === 'pass')).toBe(true);
      expect(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image')).toHaveLength(edition.pages + 1);
    },
    90_000
  );

  it('catches a late-page moderation refusal before any long-book artwork is uploaded', async () => {
    const fake = installSafetyFakes();
    let images = 0;
    fake.llm.fallback = (req) =>
      req.jsonSchema?.name === 'comic_safety_image' && ++images === 30
        ? { ...cleanAnswer(req), rating: 'X', categories: ['graphic_gore'] }
        : cleanAnswer(req);
    const db = localBackend();
    await expect(publishBundledOriginal('margin', root)).rejects.toThrow('did not clear');
    expect(images).toBe(31);
    expect(db.dbRow.status).toBe('blocked');
    expect(db.dbRow.snapshot).toBeUndefined();
    expect(db.objects.size).toBe(0);
  }, 40000);
  it('rejects an extra original leaf and a portrait image in a registered landscape book', async () => {
    const dir = join(root, 'glass-hills');
    const extra = join(dir, 'p21.webp');
    const page = join(dir, 'p19.webp');
    const original = await readFile(page);
    try {
      await writeFile(extra, original);
      await expect(inspectOriginal(root, 'glass-hills')).rejects.toThrow('roster');
      await rm(extra);
      await writeFile(page, await readFile(join(root, 'margin', 'p19.webp')));
      await expect(inspectOriginal(root, 'glass-hills')).rejects.toThrow('landscape orientation');
    } finally {
      await rm(extra, { force: true });
      await writeFile(page, original);
    }
  }, 20000);
});

describe('review of the PG metadata revision', () => {
  it.each(['cleared', 'blocked', 'needs_check'] as const)(
    'publishes the exact reviewed artwork only when the independent check clears (%s)',
    async (status) => {
      const fake = installSafetyFakes(status === 'needs_check' ? { llm: null } : {});
      fake.llm.fallback = (req) =>
        req.jsonSchema?.name === 'comic_safety_image'
          ? {
              ...cleanAnswer(req),
              rating: status === 'blocked' ? 'X' : 'PG',
              categories: status === 'blocked' ? ['graphic_gore'] : [],
              notes: ['Provider note should stay private']
            }
          : cleanAnswer(req);
      const db = localBackend();
      Object.assign(db.dbRow, historicalOrchard);
      const result = publishBundledOriginal('orchard', bundledRoot);
      if (status === 'cleared') {
        await expect(result).resolves.toEqual({ slug: historicalOrchard.slug });
        expect(db.dbRow.status).toBe('live');
        expect(db.dbRow.rating).toBe('PG');
        expect(db.objects.size).toBeGreaterThan(16);
      } else {
        await expect(result).rejects.toThrow('did not clear');
        expect(db.dbRow).toMatchObject(historicalOrchard);
        expect(db.objects.size).toBe(0);
      }
      expect(db.revision).toMatchObject({ status, priorDigest: historicalOrchard.source_digest });
      const report = db.revision.report as EditorialReview['report'];
      expect(report.pages).toHaveLength(15);
      expect(JSON.stringify(report)).not.toContain('Provider note');
      expect(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image')).toHaveLength(status === 'needs_check' ? 0 : 16);
      if (status === 'cleared') expect(report.pages.every((p) => p.status === 'pass' && p.assessed === 'PG')).toBe(true);
    },
    40000
  );

  it.each([
    ['fox', 'b3d967ad9be467d6514cf905e06e9902088b4715b5fc02ecc648c52203c8424a', 'de6ee2218e6d1062d8316b27'],
    ['table-nine', '3604e39f18cec4934f2d14266d03e3f2d5fddabc141843f0ee47e0409d4e57ea', '25764e0472c44bc160b8defe']
  ] as const)(
    'rechecks the individually pinned %s edition before releasing its distinct fifteen pages and cover',
    async (key, digest, gate) => {
      const fake = installSafetyFakes();
      fake.llm.fallback = (req) =>
        req.jsonSchema?.name === 'comic_safety_image' ? { ...cleanAnswer(req), rating: 'PG' } : cleanAnswer(req);
      const db = localBackend();
      Object.assign(db.dbRow, { ...historicalOrchard, book_key: key, slug: ORIGINAL_SLUGS[key], source_digest: digest, gate_hash: gate });
      await expect(publishBundledOriginal(key, bundledRoot)).resolves.toEqual({ slug: ORIGINAL_SLUGS[key] });
      expect(db.revision.priorDigest).toBe(digest);
      expect(db.dbRow.rating).toBe('PG');
      const reports = db.revision.report as EditorialReview['report'];
      expect(reports.pages).toHaveLength(15);
      expect(reports.cover).toMatchObject({ status: 'pass', assessed: 'PG' });
      expect(fake.llm.calls.filter((c) => c.jsonSchema?.name === 'comic_safety_image')).toHaveLength(16);
    },
    40000
  );

  it('never sends a review request for different source art or an unmatched prior decision', async () => {
    const fake = installSafetyFakes();
    const db = localBackend();
    Object.assign(db.dbRow, { ...historicalOrchard, book_key: 'harbor', slug: ORIGINAL_SLUGS.harbor });
    await expect(publishBundledOriginal('harbor', root)).rejects.toThrow('or its source changed'); // synthetic manuscript
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual(['studio_claim_original']);
    Object.assign(db.dbRow, historicalOrchard, { gate_hash: 'ffffffffffffffffffffffff' });
    await expect(publishBundledOriginal('orchard', bundledRoot)).rejects.toThrow('revision is unavailable');
    expect(fake.llm.calls).toHaveLength(0);
    expect(db.objects.size).toBe(0);
    expect(db.dbRow.status).toBe('blocked');
  }, 20000);
});
