import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { cleanAnswer } from '../safety/fakes.js';
import { installSafetyFakes, resetSafety } from '../safety/testkit.js';
import { sha256 } from './book.js';
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
  const folder = join(root, 'tide');
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
    expect(name).toBe('studio_claim_original');
    if (!dbRow.book_key)
      Object.assign(dbRow, {
        book_key: params.p_key,
        slug: params.p_slug,
        source_digest: params.p_digest,
        asset_key: params.p_asset_key,
        status: 'staging'
      });
    if (dbRow.source_digest !== params.p_digest || dbRow.status === 'blocked') return { data: null, error: { message: 'unavailable' } };
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
    objects,
    upload,
    failOnUpload: (at: number) => {
      failUploadAt = at;
    }
  };
}

describe('Studio Originals publication', () => {
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
      await expect(publishBundledOriginal('tide', root)).rejects.toThrow('did not clear');
      expect(db.dbRow.status).toBe(outcome === 'blocked' ? 'blocked' : 'staging');
      expect(db.dbRow.lease_token).toBeNull();
      expect(db.dbRow.snapshot).toBeUndefined();
      expect(db.objects.size).toBe(0);
      expect(db.upload).not.toHaveBeenCalled();
      expect(fakes.store.actions).toEqual([]);
    },
    20000
  );

  it('resumes a partial upload after the complete real gate, verifies all uploaded bytes and preserves transcripts', async () => {
    const fakes = installSafetyFakes();
    const db = localBackend();
    db.failOnUpload(3);
    await expect(publishBundledOriginal('tide', root)).rejects.toThrow('upload failed');
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
    await expect(publishBundledOriginal('tide', root)).resolves.toEqual({ slug: 'DSOriginalTide001' });
    expect(fakes.llm.calls).toHaveLength(checks);
    const doc = db.dbRow.snapshot as ComicDoc;
    expect(doc.id).toBe('DSOriginalTide001');
    expect(doc.createdAt).toBe(Date.parse(String(db.dbRow.published_at)));
    expect(doc.pages).toHaveLength(15);
    expect(doc.cover.readerAlt).toBe(source.coverAlt);
    for (let i = 0; i < 16; i++) {
      const target = i ? doc.pages[i - 1] : doc.cover;
      const asset = target.render.asset!;
      const file = i ? 'p' + String(i).padStart(2, '0') + '.webp' : 'cover.webp';
      expect(asset.path).toMatch(/^pub\/[A-Za-z0-9]{22}\//);
      expect(sha256(db.objects.get(asset.path)!)).toBe(sha256(await readFile(join(root, 'tide', file))));
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
    await expect(publishBundledOriginal('tide', root)).resolves.toEqual({ slug: 'DSOriginalTide001' });
    expect(db.upload).toHaveBeenCalledTimes(uploads);
    expect(fakes.llm.calls).toHaveLength(checks);
  }, 30000);

  it('refuses an immutable object if its existing bytes differ', async () => {
    installSafetyFakes();
    const db = localBackend();
    db.failOnUpload(2);
    await expect(publishBundledOriginal('tide', root)).rejects.toThrow('upload failed');
    const [path] = db.objects.keys();
    db.objects.set(path, Buffer.from('corrupt'));
    await expect(publishBundledOriginal('tide', root)).rejects.toThrow('checksum mismatch');
    expect(db.dbRow.status).toBe('checked');
    expect(db.dbRow.snapshot).toBeUndefined();
  }, 20000);
});
