// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  __resetAssetCachesForTests,
  buildAssetPath,
  buildOutlineSvg,
  createMemoryAssetStore,
  createSupabaseAssetStore,
  DataUrlLru,
  isOwnedAssetPath,
  isSafeStoragePath,
  quarantinePathFor
} from './assets.js';
import { StudioError } from './types.js';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { resolveCase, runAppeal } from './safety/cases.js';
import { quarantineAsset, restoreFromQuarantine } from './safety/deps.js';
import { cleanAnswer } from './safety/fakes.js';
import { installSafetyFakes, resetSafety } from './safety/testkit.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const pngDataUrl = async (width: number, height: number, color = { r: 255, g: 255, b: 255 }) => {
  const buf = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
};

const decode = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

const makeAdmin = () => {
  const objects = new Map<string, Buffer>();
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const bucketApi = {
    upload: vi.fn(async (path: string, data: Buffer) => {
      objects.set(path, data);
      return { data: { path }, error: null };
    }),
    download: vi.fn((path: string) =>
      Promise.resolve(
        objects.has(path)
          ? { data: new Blob([new Uint8Array(objects.get(path)!)], { type: 'image/webp' }), error: null }
          : { data: null, error: Object.assign(new Error('Object not found'), { statusCode: '404' }) }
      )
    ),
    createSignedUrls: vi.fn(async (paths: string[], ttl: number) => ({
      data: paths.map((p) =>
        objects.has(p) ? { path: p, signedUrl: `https://signed.example/${p}?ttl=${ttl}`, error: null } : { path: p, signedUrl: '', error: 'Object not found' }
      ),
      error: null
    }))
  };
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    inserts.push({ table: 'image_assets', row });
    return { error: null };
  });
  const client = {
    storage: { from: vi.fn(() => bucketApi) },
    from: vi.fn(() => ({ insert }))
  };
  return { client: client as unknown as SupabaseClient, objects, inserts, bucketApi, insert };
};

beforeEach(() => __resetAssetCachesForTests());

describe('paths', () => {
  it('scopes to the project only for real UUIDs', () => {
    expect(buildAssetPath(USER, PROJECT, 'abc')).toBe(`u/${USER}/p/${PROJECT}/img/abc.webp`);
    expect(buildAssetPath(USER, 'not-a-uuid', 'abc')).toBe(`u/${USER}/tmp/abc.webp`);
    expect(buildAssetPath('a/../b', PROJECT, 'x')).toBe(`u/a----b/p/${PROJECT}/img/x.webp`);
  });

  it('rejects unsafe paths and recognises ownership', () => {
    expect(isSafeStoragePath('u/x/p/y/img/z.webp')).toBe(true);
    expect(isSafeStoragePath('../etc/passwd')).toBe(false);
    expect(isSafeStoragePath('/abs')).toBe(false);
    expect(isSafeStoragePath('a\\b')).toBe(false);
    expect(isSafeStoragePath('x'.repeat(600))).toBe(false);
    // Percent-encoded traversal: URL parsing would collapse %2e%2e into '..' after the owner check.
    expect(isSafeStoragePath(`u/${USER}/%2e%2e/victim/p/${PROJECT}/ref/a.webp`)).toBe(false);
    expect(isSafeStoragePath(`u/${USER}/%2E%2E/victim/a.webp`)).toBe(false);
    expect(isSafeStoragePath('u/x/p/y/img/z.webp?x=1')).toBe(false);
    expect(isSafeStoragePath('u/x/p/y/img/z.webp#frag')).toBe(false);
    expect(isSafeStoragePath('u/x//p/y/img/z.webp')).toBe(false);
    expect(isSafeStoragePath('u/x/./p/y/img/z.webp')).toBe(false);
    expect(isSafeStoragePath('u/x/p/y/img/z\u0000.webp')).toBe(false);
    expect(isOwnedAssetPath(`u/${USER}/%2e%2e/someone-else/p/${PROJECT}/ref/a.webp`, USER)).toBe(false);
    expect(isOwnedAssetPath(`u/${USER}/p/${PROJECT}/img/a.webp`, USER)).toBe(true);
    expect(isOwnedAssetPath(`${USER}/legacy.webp`, USER)).toBe(true);
    expect(isOwnedAssetPath(`u/someone-else/p/${PROJECT}/img/a.webp`, USER)).toBe(false);
  });
});

describe('createSupabaseAssetStore', () => {
  it('saves generated images as uncropped WebP with an image_assets row and primes the reference cache', async () => {
    const admin = makeAdmin();
    const store = createSupabaseAssetStore({ admin: () => admin.client, bucket: 'test-bucket' });
    const ref = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: await pngDataUrl(300, 450), model: 'google/gemini-nano-banana-2.1' });

    expect(ref.path).toMatch(new RegExp(`^u/${USER}/p/${PROJECT}/img/[0-9a-f-]{36}\\.webp$`));
    expect(ref).toMatchObject({ w: 300, h: 450, source: 'generated', model: 'google/gemini-nano-banana-2.1' });
    expect(typeof ref.at).toBe('number');
    const [path, data, opts] = admin.bucketApi.upload.mock.calls[0] as unknown as [string, Buffer, Record<string, unknown>];
    expect(path).toBe(ref.path);
    expect(opts).toMatchObject({ contentType: 'image/webp', cacheControl: '31536000', upsert: false });
    const meta = await sharp(data).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([300, 450]);
    expect(admin.inserts[0].row).toMatchObject({
      user_id: USER,
      project_id: PROJECT,
      bucket: 'test-bucket',
      path: ref.path,
      mime_type: 'image/webp',
      width: 300,
      height: 450,
      source: 'openrouter'
    });
    // Cached: the continuity reference never round-trips to Storage.
    const loaded = await store.loadDataUrl(ref.path);
    expect(loaded.startsWith('data:image/webp;base64,')).toBe(true);
    expect(admin.bucketApi.download).not.toHaveBeenCalled();
  });

  it('uses the tmp lane and a null project_id for non-UUID projects', async () => {
    const admin = makeAdmin();
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    const ref = await store.saveGenerated({ userId: USER, projectId: 'draft', dataUrl: await pngDataUrl(10, 10), model: 'gemini-nano-banana-2.1' });
    expect(ref.path.startsWith(`u/${USER}/tmp/`)).toBe(true);
    expect(admin.inserts[0].row.project_id).toBeNull();
    expect(admin.inserts[0].row.source).toBe('gemini');
  });

  it('retries a failed upload once, then fails honestly', async () => {
    const admin = makeAdmin();
    admin.bucketApi.upload.mockResolvedValueOnce({ data: null, error: new Error('socket hang up') } as never);
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    await expect(store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: await pngDataUrl(8, 8) })).resolves.toMatchObject({
      source: 'generated'
    });
    expect(admin.bucketApi.upload).toHaveBeenCalledTimes(2);

    admin.bucketApi.upload.mockResolvedValue({ data: null, error: new Error('storage down') } as never);
    const err = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: await pngDataUrl(8, 8) }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err).toMatchObject({ code: 'INTERNAL', retryable: true });
  });

  it('keeps the render when the image_assets insert fails (never throws away a paid image)', async () => {
    const admin = makeAdmin();
    admin.insert.mockResolvedValue({ error: { code: '500', message: 'db down' } } as never);
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    const ref = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: await pngDataUrl(8, 8) });
    expect(admin.objects.has(ref.path)).toBe(true);
    expect(admin.insert).toHaveBeenCalledTimes(2);
  });

  it('rejects bad generated payloads', async () => {
    const store = createSupabaseAssetStore({ admin: () => makeAdmin().client });
    await expect(store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: 'nope' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}` })
    ).rejects.toMatchObject({ code: 'NO_IMAGE' });
  });

  it('normalizes uploads: allowed types only, ≤10 MB, long edge ≤2048, WebP', async () => {
    const admin = makeAdmin();
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toBuffer();
    const ref = await store.saveUpload({ userId: USER, projectId: PROJECT, dataUrl: `data:image/jpeg;base64,${big.toString('base64')}` });
    expect(ref).toMatchObject({ source: 'upload', w: 2048, h: 683 });
    expect(ref.model).toBeUndefined();
    expect(admin.inserts[0].row.source).toBe('upload');

    const small = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).gif().toBuffer();
    await expect(store.saveUpload({ userId: USER, projectId: PROJECT, dataUrl: `data:image/gif;base64,${small.toString('base64')}` })).resolves.toMatchObject({
      w: 40,
      h: 20
    });

    await expect(store.saveUpload({ userId: USER, projectId: PROJECT, dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).rejects.toMatchObject({
      code: 'BAD_REQUEST'
    });
    const huge = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`;
    await expect(store.saveUpload({ userId: USER, projectId: PROJECT, dataUrl: huge })).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 413 });
    const lying = `data:image/png;base64,${Buffer.from('plain text pretending').toString('base64')}`;
    await expect(store.saveUpload({ userId: USER, projectId: PROJECT, dataUrl: lying })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('loads references once (cached, coalesced) and reports missing ones', async () => {
    const admin = makeAdmin();
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer();
    admin.objects.set('u/x/p/y/img/a.webp', webp);
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    const [a, b] = await Promise.all([store.loadDataUrl('u/x/p/y/img/a.webp'), store.loadDataUrl('u/x/p/y/img/a.webp')]);
    expect(a).toBe(`data:image/webp;base64,${webp.toString('base64')}`);
    expect(b).toBe(a);
    await store.loadDataUrl('u/x/p/y/img/a.webp');
    expect(admin.bucketApi.download).toHaveBeenCalledTimes(1);

    await expect(store.loadDataUrl('u/x/p/y/img/missing.webp')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.loadDataUrl('../secret')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('signs in batches, omits failures and reuses fresh signatures', async () => {
    const admin = makeAdmin();
    admin.objects.set('u/x/a.webp', Buffer.from('a'));
    admin.objects.set('u/x/b.webp', Buffer.from('b'));
    const store = createSupabaseAssetStore({ admin: () => admin.client });
    const urls = await store.signUrls(['u/x/a.webp', 'u/x/b.webp', 'u/x/missing.webp', 'u/x/a.webp', '../bad']);
    expect(urls).toEqual({
      'u/x/a.webp': 'https://signed.example/u/x/a.webp?ttl=3600',
      'u/x/b.webp': 'https://signed.example/u/x/b.webp?ttl=3600'
    });
    expect(admin.bucketApi.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(admin.bucketApi.createSignedUrls.mock.calls[0][0]).toEqual(['u/x/a.webp', 'u/x/b.webp', 'u/x/missing.webp']);

    await store.signUrls(['u/x/a.webp']);
    expect(admin.bucketApi.createSignedUrls).toHaveBeenCalledTimes(1);

    admin.bucketApi.createSignedUrls.mockResolvedValueOnce({ data: null, error: new Error('boom') } as never);
    expect(await store.signUrls(['u/x/new.webp'])).toEqual({});
  });

  it('outlines the Mark-up region in thick red on a same-size copy', async () => {
    const store = createSupabaseAssetStore({ admin: () => makeAdmin().client });
    const out = await store.outlineRegion(await pngDataUrl(400, 200), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(out.startsWith('data:image/webp;base64,')).toBe(true);
    const { data, info } = await sharp(decode(out)).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([400, 200]);
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const [r, g, b] = px(100, 100); // left edge of the box (x = 0.25 * 400)
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(px(200, 100).every((c) => c > 230)).toBe(true); // inside stays untouched
    expect(px(20, 20).every((c) => c > 230)).toBe(true); // outside stays untouched
  });
});

describe('buildOutlineSvg', () => {
  it('scales the stroke with the long edge and keeps it inside the image', () => {
    const svg = buildOutlineSvg(2000, 3000, { x: 0, y: 0, w: 1, h: 1 });
    expect(svg).toContain('stroke-width="18"');
    expect(svg).toContain('x="9" y="9" width="1982" height="2982"');
    expect(buildOutlineSvg(100, 100, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toContain('stroke-width="3"');
  });

  it('clamps out-of-range boxes and rejects empty ones', () => {
    expect(buildOutlineSvg(100, 100, { x: -1, y: 0.5, w: 5, h: 5 })).toContain('height="48.5"');
    expect(() => buildOutlineSvg(100, 100, { x: 0.5, y: 0.5, w: 0, h: 0.2 })).toThrow(StudioError);
  });
});

describe('DataUrlLru', () => {
  it('evicts by entry count and by total bytes, least recently used first', () => {
    const lru = new DataUrlLru(2, 100);
    lru.set('a', 'x'.repeat(10));
    lru.set('b', 'x'.repeat(10));
    lru.get('a');
    lru.set('c', 'x'.repeat(10));
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBeDefined();

    const bytes = new DataUrlLru(10, 25);
    bytes.set('a', 'x'.repeat(10));
    bytes.set('b', 'x'.repeat(10));
    bytes.set('c', 'x'.repeat(10));
    expect(bytes.size).toBe(2);
    expect(bytes.totalBytes).toBe(20);
    bytes.set('huge', 'x'.repeat(30));
    expect(bytes.get('huge')).toBeUndefined();
  });
});

describe('createMemoryAssetStore', () => {
  it('stores data URLs, signs with mem:// and records outlines', async () => {
    const store = createMemoryAssetStore();
    const png = await pngDataUrl(4, 4);
    const ref = await store.saveGenerated({ userId: 'u1', projectId: 'p1', dataUrl: png, model: 'm' });
    expect(ref).toMatchObject({ source: 'generated', model: 'm' });
    expect(await store.loadDataUrl(ref.path)).toBe(png);
    const up = await store.saveUpload({ userId: 'u1', projectId: 'p1', dataUrl: png });
    expect(up.source).toBe('upload');
    expect(await store.signUrls([ref.path, 'u/other/seeded.webp'])).toEqual({
      [ref.path]: `mem://${ref.path}`,
      'u/other/seeded.webp': 'mem://u/other/seeded.webp'
    });
    await expect(store.loadDataUrl('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.outlineRegion(png, { x: 0, y: 0, w: 1, h: 1 })).toBe(png);
    expect(store.outlines).toHaveLength(1);
    store.put('seed/path.webp', png);
    expect(store.files.get('seed/path.webp')).toBe(png);
    await expect(store.saveUpload({ userId: 'u1', projectId: 'p1', dataUrl: 'data:text/plain;base64,aGk=' })).rejects.toMatchObject({
      code: 'BAD_REQUEST'
    });
  });
});

// ── v5 (contract §12.5): buckets, variants, refs, derive, quarantine, publication primitives ──

type StoredObject = { data: Buffer; type?: string };

/** A two-bucket Supabase fake: per-bucket objects plus a tiny image_assets table. */
const makeBuckets = () => {
  const buckets = new Map<string, Map<string, StoredObject>>();
  const bucket = (name: string) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name)!;
  };
  const calls = {
    upload: [] as { bucket: string; path: string; opts: Record<string, unknown> }[],
    sign: [] as { bucket: string; paths: string[]; ttl: number }[],
    copy: [] as { bucket: string; from: string; to: string; dst: string }[],
    remove: [] as { bucket: string; paths: string[] }[],
    download: [] as { bucket: string; path: string }[]
  };
  const fail = {
    upload: null as null | ((path: string) => boolean),
    /** An older Storage server that refuses cross-bucket copies (the store then moves the bytes itself). */
    crossBucketCopy: false,
    remove: null as null | ((bucket: string, paths: string[]) => boolean),
    /** Storage can't answer an existence check (network / 5xx: storage-js throws). */
    exists: false
  };
  const err = (message: string, statusCode: string) => Object.assign(new Error(message), { statusCode });
  const api = (name: string) => ({
    upload: async (path: string, data: Buffer, opts: Record<string, unknown>) => {
      calls.upload.push({ bucket: name, path, opts });
      if (fail.upload?.(path)) return { data: null, error: err('storage down', '500') };
      if (bucket(name).has(path) && !opts?.upsert) return { data: null, error: err('The resource already exists', '409') };
      bucket(name).set(path, { data: Buffer.from(data), type: String(opts?.contentType || '') });
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      calls.download.push({ bucket: name, path });
      const hit = bucket(name).get(path);
      return hit
        ? { data: new Blob([new Uint8Array(hit.data)], { type: hit.type || 'image/webp' }), error: null }
        : { data: null, error: err('Object not found', '404') };
    },
    createSignedUrls: async (paths: string[], ttl: number) => {
      calls.sign.push({ bucket: name, paths, ttl });
      return {
        data: paths.map((p) =>
          bucket(name).has(p) ? { path: p, signedUrl: `https://signed.example/${name}/${p}?ttl=${ttl}`, error: null } : { path: p, signedUrl: '', error: 'Object not found' }
        ),
        error: null
      };
    },
    copy: async (from: string, to: string, opts?: { destinationBucket?: string }) => {
      const dst = opts?.destinationBucket || name;
      calls.copy.push({ bucket: name, from, to, dst });
      if (fail.crossBucketCopy && dst !== name) return { data: null, error: err('Cross-bucket copy is not supported', '400') };
      const hit = bucket(name).get(from);
      if (!hit) return { data: null, error: err('Object not found', '404') };
      if (bucket(dst).has(to)) return { data: null, error: err('The resource already exists', '409') };
      bucket(dst).set(to, { ...hit });
      return { data: { path: to }, error: null };
    },
    remove: async (paths: string[]) => {
      calls.remove.push({ bucket: name, paths });
      if (fail.remove?.(name, paths)) return { data: null, error: err('storage down', '500') };
      for (const p of paths) bucket(name).delete(p);
      return { data: [], error: null };
    },
    exists: async (path: string) => {
      if (fail.exists) throw err('storage down', '500');
      return bucket(name).has(path) ? { data: true, error: null } : { data: false, error: err('Object not found', '404') };
    },
    list: async (folder: string, opts: { limit: number; offset: number }) => {
      const prefix = `${folder}/`;
      const names = [...bucket(name).keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .sort()
        .map((k) => ({ name: k.slice(prefix.length), id: `id-${k}` }));
      return { data: names.slice(opts.offset, opts.offset + opts.limit), error: null };
    }
  });
  const rows: Record<string, unknown>[] = [];
  const updateIn = (patch: Record<string, unknown>) => ({
    in: async (col: string, values: unknown[]) => {
      rows.filter((r) => values.includes(r[col])).forEach((r) => Object.assign(r, patch));
      return { data: null, error: null };
    }
  });
  const client = {
    storage: { from: (name: string) => api(name) },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        if (rows.some((r) => r.path === row.path)) return { error: { code: '23505' } };
        rows.push({ ...row });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => updateIn(patch)
    })
  };
  return { client: client as unknown as SupabaseClient, bucket, calls, rows, fail };
};

const PUB = 'comic-assets';
const PRIV = 'comic-private';
const KEY22 = 'Ab3dEf6hIj9kLm2nOp5qRs';

const solidPng = (width: number, height: number, background: string | { r: number; g: number; b: number } = '#ffffff') =>
  sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

/** Deterministic noise (sharp detail everywhere): a 32-bit LCG. */
const noisePng = async (width: number, height: number, seed = 7) => {
  const raw = Buffer.alloc(width * height * 3);
  let s = seed >>> 0;
  for (let i = 0; i < raw.length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    raw[i] = s >>> 24;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

/** A photo-like image with real structure (smooth waves at seed-dependent frequencies). */
const wavesPng = (width: number, height: number, seed = 1) => {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Low-frequency structure (what dHash is built for): 1–3 periods across the frame.
      const v = 127 + 70 * Math.sin((x / width) * Math.PI * (seed + 1) + seed) + 50 * Math.cos((y / height) * Math.PI * (seed % 3 + 1));
      const i = (y * width + x) * 3;
      raw[i] = Math.max(0, Math.min(255, v));
      raw[i + 1] = Math.max(0, Math.min(255, 255 - v));
      raw[i + 2] = Math.max(0, Math.min(255, (v + x) % 256));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
};

const v5Store = () => {
  const fake = makeBuckets();
  const store = createSupabaseAssetStore({ admin: () => fake.client });
  return { fake, store };
};

describe('v5: size variants (480/1080, inline, best-effort)', () => {
  it('writes only the widths narrower than the original, ascending, and registers them', async () => {
    const { fake, store } = v5Store();
    const ref = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: `data:image/png;base64,${(await solidPng(2000, 1000)).toString('base64')}`, model: 'm/x' });
    expect(ref.variants).toEqual([
      { path: ref.path.replace(/\.webp$/, '_w480.webp'), w: 480, h: 240 },
      { path: ref.path.replace(/\.webp$/, '_w1080.webp'), w: 1080, h: 540 }
    ]);
    for (const v of ref.variants!) {
      expect(fake.bucket(PUB).has(v.path)).toBe(true);
      const meta = await sharp(fake.bucket(PUB).get(v.path)!.data).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', v.w, v.h]);
    }
    expect(fake.rows.filter((r) => r.source === 'variant').map((r) => r.path)).toEqual(ref.variants!.map((v) => v.path));
  });

  it('never enlarges: an 800 px wide image gets only the 480 variant, a 300 px one none', async () => {
    const { store } = v5Store();
    const mid = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: `data:image/png;base64,${(await solidPng(800, 1000)).toString('base64')}` });
    expect(mid.variants?.map((v) => [v.w, v.h])).toEqual([[480, 600]]);
    const small = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: `data:image/png;base64,${(await solidPng(300, 450)).toString('base64')}` });
    expect(small.variants).toBeUndefined();
  });

  it('a variant failure never fails the save (the render is kept, variants omitted)', async () => {
    const { fake, store } = v5Store();
    fake.fail.upload = (path) => path.includes('_w');
    const ref = await store.saveGenerated({ userId: USER, projectId: PROJECT, dataUrl: `data:image/png;base64,${(await solidPng(1600, 1600)).toString('base64')}` });
    expect(fake.bucket(PUB).has(ref.path)).toBe(true);
    expect(ref.variants).toBeUndefined();
  });

  it('ensureVariants backfills an older asset idempotently and skips private-quarantine and publication lanes', async () => {
    const { fake, store } = v5Store();
    const path = `u/${USER}/p/${PROJECT}/img/old.webp`;
    fake.bucket(PUB).set(path, { data: await sharp(await solidPng(1200, 1500)).webp().toBuffer(), type: 'image/webp' });
    const first = await store.ensureVariants({ path, source: 'generated', at: 1, w: 1200, h: 1500 });
    expect(first).toEqual([
      { path: `u/${USER}/p/${PROJECT}/img/old_w480.webp`, w: 480, h: 600 },
      { path: `u/${USER}/p/${PROJECT}/img/old_w1080.webp`, w: 1080, h: 1350 }
    ]);
    const again = await store.ensureVariants({ path, source: 'generated', at: 1, w: 1200, h: 1500 });
    expect(again).toEqual(first); // existing objects count as made
    expect(await store.ensureVariants({ path, source: 'generated', at: 1, w: 1200, h: 1500, variants: first })).toEqual(first);
    expect(await store.ensureVariants({ path: `pub/${KEY22}/p1-0123456789ab.webp`, source: 'generated', at: 1, w: 2000 })).toEqual([]);
    expect(await store.ensureVariants({ path: `q/${USER}/${PROJECT}/x.webp`, source: 'generated', at: 1, w: 2000 })).toEqual([]);
    expect(await store.ensureVariants({ path: `u/${USER}/p/${PROJECT}/img/old_w1080.webp`, source: 'generated', at: 1, w: 1080 })).toEqual([]);
  });
});

describe('v5: reference uploads (encodeUploadBuffer + saveRef)', () => {
  it('stores refs in the PRIVATE bucket under …/ref/ and registers them there', async () => {
    const { fake, store } = v5Store();
    const encoded = await store.encodeUploadBuffer(await noisePng(640, 480), 'image/png');
    expect(encoded).toMatchObject({ mime: 'image/webp', w: 640, h: 480 });
    expect(encoded.bytes).toBe(encoded.buffer.byteLength);
    const ref = await store.saveRef({ userId: USER, projectId: PROJECT, encoded });
    expect(ref.path).toMatch(new RegExp(`^u/${USER}/p/${PROJECT}/ref/[0-9a-f-]{36}\\.webp$`));
    expect(ref).toMatchObject({ source: 'upload', w: 640, h: 480 });
    expect(fake.bucket(PRIV).has(ref.path)).toBe(true);
    expect(fake.bucket(PUB).has(ref.path)).toBe(false);
    expect(fake.rows.find((r) => r.path === ref.path)).toMatchObject({ bucket: PRIV, user_id: USER, project_id: PROJECT, source: 'upload' });
    // Its 480 variant is private too.
    expect(ref.variants?.map((v) => v.w)).toEqual([480]);
    expect(fake.bucket(PRIV).has(ref.variants![0].path)).toBe(true);
  });

  it('accepts AVIF and normalizes it to WebP', async () => {
    const { store } = v5Store();
    const avif = await sharp(await noisePng(300, 200)).avif({ quality: 60 }).toBuffer();
    const out = await store.encodeUploadBuffer(avif, 'image/avif');
    expect(out).toMatchObject({ mime: 'image/webp', w: 300, h: 200 });
    expect((await sharp(out.buffer).metadata()).format).toBe('webp');
  });

  it('rejects by magic bytes, never by the claimed type: text, SVG, HTML and HEIC', async () => {
    const { store } = v5Store();
    await expect(store.encodeUploadBuffer(Buffer.from('plain text pretending to be a png'), 'image/png')).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 415 });
    await expect(store.encodeUploadBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')).rejects.toMatchObject({ status: 415 });
    await expect(store.encodeUploadBuffer(Buffer.from('  <!doctype html><script>alert(1)</script>'), 'image/jpeg')).rejects.toMatchObject({ status: 415 });
    await expect(store.encodeUploadBuffer(Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toMatchObject({ status: 415 });
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic'), Buffer.alloc(64)]);
    const heicErr = await store.encodeUploadBuffer(heic, 'image/jpeg').catch((e) => e);
    expect(heicErr).toMatchObject({ status: 415 });
    expect(heicErr.userMessage).toMatch(/HEIC/);
    await expect(store.encodeUploadBuffer(await solidPng(200, 200), 'image/heic')).rejects.toMatchObject({ status: 415 });
    await expect(store.encodeUploadBuffer(await solidPng(200, 200), 'application/pdf')).rejects.toMatchObject({ status: 415 });
  });

  it('a mislabelled but real image is accepted on its content (camera rolls lie about types)', async () => {
    const { store } = v5Store();
    await expect(store.encodeUploadBuffer(await solidPng(200, 200), 'image/jpeg; charset=binary')).resolves.toMatchObject({ w: 200, h: 200 });
  });

  it('enforces the minimum edge (128 px), the size cap and the pixel cap', async () => {
    const { store } = v5Store();
    await expect(store.encodeUploadBuffer(await solidPng(100, 400), 'image/png')).rejects.toMatchObject({ status: 422 });
    await expect(store.encodeUploadBuffer(await solidPng(128, 128), 'image/png')).resolves.toMatchObject({ w: 128, h: 128 });
    await expect(store.encodeUploadBuffer(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')).rejects.toMatchObject({ status: 413 });
    const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(store.encodeUploadBuffer(huge, 'image/png')).rejects.toMatchObject({ status: 413 });
  });

  it('downscales to a 2048 long edge and honours EXIF orientation', async () => {
    const { store } = v5Store();
    const rotated = await sharp(await solidPng(3000, 1000)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await store.encodeUploadBuffer(rotated, 'image/jpeg');
    expect([out.w, out.h]).toEqual([683, 2048]); // stored upright (90° turn)
  });
});

describe('v5: dHash and reference quality flags', () => {
  it('dHash is 16 hex, stable across calls and re-encodes, and far for different images', async () => {
    const { store } = v5Store();
    const a = await wavesPng(400, 300, 1);
    const h1 = await store.dHash(a);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.dHash(a)).toBe(h1);
    const reencoded = await sharp(a).webp({ quality: 85 }).toBuffer();
    const distance = (x: string, y: string) => [...x].reduce((n, c, i) => n + ((parseInt(c, 16) ^ parseInt(y[i], 16)).toString(2).split('1').length - 1), 0);
    expect(distance(h1, await store.dHash(reencoded))).toBeLessThanOrEqual(4);
    expect(distance(h1, await store.dHash(await wavesPng(400, 300, 5)))).toBeGreaterThan(10);
    // Resizing (what the upload encoder does) keeps it a near-duplicate too.
    expect(distance(h1, await store.dHash(await sharp(a).resize(200).png().toBuffer()))).toBeLessThanOrEqual(4);
    expect((await store.measureRef(a)).dhash).toBe(h1); // one implementation
  });

  it('flags blurry, dark and low-res photos — and nothing on a sharp, bright, large one', async () => {
    const { store } = v5Store();
    const sharpPhoto = await noisePng(800, 600);
    expect(await store.measureRef(sharpPhoto)).toEqual({ dhash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const blurred = await sharp(sharpPhoto).blur(6).png().toBuffer();
    expect((await store.measureRef(blurred)).quality).toMatchObject({ blurry: true });
    const dark = await sharp(await noisePng(800, 600, 3)).linear(0.12, 0).png().toBuffer();
    expect((await store.measureRef(dark)).quality).toMatchObject({ dark: true });
    expect((await store.measureRef(await noisePng(300, 400))).quality).toEqual({ lowRes: true });
    await expect(store.measureRef(Buffer.from('nope'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('v5: signed URLs per bucket', () => {
  it('signs refs from the private bucket for 300 s (never longer), art from the public one for 1 h', async () => {
    const { fake, store } = v5Store();
    const refPath = `u/${USER}/p/${PROJECT}/ref/a.webp`;
    const artPath = `u/${USER}/p/${PROJECT}/img/b.webp`;
    fake.bucket(PRIV).set(refPath, { data: Buffer.from('r') });
    fake.bucket(PUB).set(artPath, { data: Buffer.from('a') });
    const urls = await store.signUrls([refPath, artPath]);
    expect(urls[refPath]).toBe(`https://signed.example/${PRIV}/${refPath}?ttl=300`);
    expect(urls[artPath]).toBe(`https://signed.example/${PUB}/${artPath}?ttl=3600`);
    expect(fake.calls.sign).toEqual([
      { bucket: PRIV, paths: [refPath], ttl: 300 },
      { bucket: PUB, paths: [artPath], ttl: 3600 }
    ]);
    // Asking for longer never stretches a private URL.
    __resetAssetCachesForTests();
    const long = await store.signUrls([refPath], { ttlSec: 86_400 });
    expect(long[refPath]).toMatch(/ttl=300$/);
    // A ref path is never looked up in the public bucket.
    expect(fake.calls.sign.every((c) => c.bucket === PRIV || !c.paths.includes(refPath))).toBe(true);
  });

  it('loads a private ref from the private bucket', async () => {
    const { fake, store } = v5Store();
    const refPath = `u/${USER}/p/${PROJECT}/ref/c.webp`;
    fake.bucket(PRIV).set(refPath, { data: await sharp(await solidPng(10, 10)).webp().toBuffer(), type: 'image/webp' });
    expect(await store.loadDataUrl(refPath)).toMatch(/^data:image\/webp;base64,/);
    expect(fake.calls.download).toEqual([{ bucket: PRIV, path: refPath }]);
  });
});

describe('v5: previews, crops and fits', () => {
  it('previewDataUrl gives ≤ 768 px WebP and caches it per path', async () => {
    const { fake, store } = v5Store();
    const path = `u/${USER}/p/${PROJECT}/ref/big.webp`;
    fake.bucket(PRIV).set(path, { data: await sharp(await noisePng(2000, 1000)).webp().toBuffer(), type: 'image/webp' });
    const url = await store.previewDataUrl(path);
    const meta = await sharp(decode(url)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 768, 384]);
    await store.previewDataUrl(path);
    expect(fake.calls.download).toHaveLength(1);
    const fromBuffer = await store.previewDataUrl(await solidPng(300, 200), 128);
    expect((await sharp(decode(fromBuffer)).metadata()).width).toBe(128);
  });

  it('cropRef crops a box into a new PRIVATE ref and records crop + original', async () => {
    const { fake, store } = v5Store();
    const src = `u/${USER}/p/${PROJECT}/ref/photo.webp`;
    fake.bucket(PRIV).set(src, { data: await sharp(await noisePng(1000, 800)).webp().toBuffer(), type: 'image/webp' });
    const out = await store.cropRef({ userId: USER, projectId: PROJECT, path: src, box: { x: 0.1, y: 0.25, w: 0.5, h: 0.5 } });
    expect(out.path).toMatch(new RegExp(`^u/${USER}/p/${PROJECT}/ref/`));
    expect(fake.bucket(PRIV).has(out.path)).toBe(true);
    expect(out).toMatchObject({ source: 'derived', derivedFrom: src, w: 500, h: 400, crop: { x: 0.1, y: 0.25, w: 0.5, h: 0.5 }, original: { path: src, w: 1000, h: 800 } });
  });

  it('cropRef with an aspect follows the attention point (an object on the right)', async () => {
    const { fake, store } = v5Store();
    const W = 1000;
    const H = 400;
    const raw = Buffer.alloc(W * H * 3, 120);
    for (let y = 150; y < 250; y += 1) {
      for (let x = 800; x < 900; x += 1) {
        const i = (y * W + x) * 3;
        const on = ((x >> 3) + (y >> 3)) & 1;
        raw[i] = 255;
        raw[i + 1] = on ? 255 : 0;
        raw[i + 2] = on ? 255 : 0;
      }
    }
    const src = `u/${USER}/p/${PROJECT}/ref/wide.webp`;
    fake.bucket(PRIV).set(src, { data: await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).webp().toBuffer(), type: 'image/webp' });
    const out = await store.cropRef({ userId: USER, projectId: PROJECT, path: src, aspect: '1:1' });
    expect([out.w, out.h]).toEqual([400, 400]);
    expect(out.crop!.x).toBeGreaterThan(0.45); // window moved toward the object (x 0.8–0.9)
    expect(out.crop!.x + out.crop!.w).toBeGreaterThanOrEqual(0.9 - 1e-6);
  });

  it('crop and fit refuse other users’ paths and quarantine', async () => {
    const { store } = v5Store();
    const OTHER = '33333333-3333-4333-8333-333333333333';
    await expect(store.cropRef({ userId: USER, projectId: PROJECT, path: `u/${OTHER}/p/${PROJECT}/ref/x.webp`, aspect: '1:1' })).rejects.toMatchObject({ status: 403 });
    await expect(store.fitToAspect({ userId: USER, projectId: PROJECT, path: `u/${OTHER}/p/${PROJECT}/img/x.webp`, aspect: '4:5', mode: 'pad' })).rejects.toMatchObject({ status: 403 });
    await expect(store.cropRef({ userId: USER, projectId: PROJECT, path: `q/${USER}/${PROJECT}/x.webp`, aspect: '1:1' })).rejects.toMatchObject({ status: 404 });
  });

  it('fitToAspect stores a NEW derived asset in the art lane with variants (2048² → 4:5 pad = 1638×2048)', async () => {
    const { fake, store } = v5Store();
    const src = `u/${USER}/p/${PROJECT}/img/square.webp`;
    fake.bucket(PUB).set(src, { data: await sharp(await solidPng(2048, 2048, '#f4f1ea')).webp().toBuffer(), type: 'image/webp' });
    const out = await store.fitToAspect({ userId: USER, projectId: PROJECT, path: src, aspect: '4:5', mode: 'pad' });
    expect(out.path).not.toBe(src);
    expect(out.path).toMatch(new RegExp(`^u/${USER}/p/${PROJECT}/img/`));
    expect(out).toMatchObject({ source: 'derived', derivedFrom: src, w: 1638, h: 2048 });
    expect(out.variants?.map((v) => [v.w, v.h])).toEqual([
      [480, 600],
      [1080, 1350]
    ]);
    expect(fake.bucket(PUB).has(src)).toBe(true); // the original is never touched
    expect(fake.rows.find((r) => r.path === out.path)).toMatchObject({ source: 'derived', bucket: PUB });
  });
});

describe('v5: quarantine, remove and the publication primitives', () => {
  it('quarantine moves the object (and its variants) to the private q/ lane with a 90-day hold', async () => {
    const { fake, store } = v5Store();
    const path = `u/${USER}/p/${PROJECT}/img/bad.webp`;
    fake.bucket(PUB).set(path, { data: Buffer.from('bad-bytes') });
    fake.bucket(PUB).set(`u/${USER}/p/${PROJECT}/img/bad_w480.webp`, { data: Buffer.from('v') });
    const { quarantinePath } = await store.quarantine(path, 'blocked:violence');
    expect(quarantinePath).toMatch(new RegExp(`^q/${USER}/${PROJECT}/bad-[0-9a-f]{8}\\.webp$`));
    expect(fake.bucket(PRIV).get(quarantinePath)?.data.toString()).toBe('bad-bytes');
    expect(fake.bucket(PUB).has(path)).toBe(false);
    expect(fake.bucket(PUB).has(`u/${USER}/p/${PROJECT}/img/bad_w480.webp`)).toBe(false);
    const row = fake.rows.find((r) => r.path === quarantinePath)!;
    expect(row).toMatchObject({ bucket: PRIV, source: 'quarantine' });
    const holdDays = (Date.parse(String(row.expires_at)) - Date.now()) / 86_400_000;
    expect(holdDays).toBeGreaterThan(89.9);
    expect(holdDays).toBeLessThanOrEqual(90);
    // Retried after the source is gone: same quarantine path, no error.
    expect(await store.quarantine(path, 'blocked:violence')).toEqual({ quarantinePath });
    // A quarantined object is never signed as the original path again and never removed by remove().
    await store.remove([quarantinePath]);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(true);
  });

  it('quarantine drops every cached preview size of the original (no stale preview reaches the director or safety)', async () => {
    const { fake, store } = v5Store();
    const path = `u/${USER}/p/${PROJECT}/ref/flagged.webp`;
    fake.bucket(PRIV).set(path, { data: await sharp(await noisePng(900, 600)).webp().toBuffer(), type: 'image/webp' });
    // Two unusual edges, each cached after one read of the stored object.
    for (const edge of [300, 640, 300, 640]) await store.previewDataUrl(path, edge);
    expect(fake.calls.download).toHaveLength(2);
    await store.quarantine(path, 'blocked:sexual');
    // Both previews now go back to storage — where the original no longer exists.
    await expect(store.previewDataUrl(path, 300)).rejects.toMatchObject({ status: 404 });
    await expect(store.previewDataUrl(path, 640)).rejects.toMatchObject({ status: 404 });
  });

  it('remove deletes per bucket and marks the image_assets rows deleted', async () => {
    const { fake, store } = v5Store();
    const art = `u/${USER}/p/${PROJECT}/img/a.webp`;
    const ref = `u/${USER}/p/${PROJECT}/ref/b.webp`;
    fake.bucket(PUB).set(art, { data: Buffer.from('a') });
    fake.bucket(PRIV).set(ref, { data: Buffer.from('b') });
    fake.rows.push({ path: art, deleted_at: null }, { path: ref, deleted_at: null });
    await store.remove([art, ref, '../escape']);
    expect(fake.bucket(PUB).has(art)).toBe(false);
    expect(fake.bucket(PRIV).has(ref)).toBe(false);
    expect(fake.calls.remove).toEqual([
      { bucket: PUB, paths: [art] },
      { bucket: PRIV, paths: [ref] }
    ]);
    expect(fake.rows.every((r) => r.deleted_at)).toBe(true);
  });

  it('copyObject copies across buckets into pub/ only; putObject writes real images to pub/ or library/ only', async () => {
    const { fake, store } = v5Store();
    const art = `u/${USER}/p/${PROJECT}/img/page.webp`;
    fake.bucket(PUB).set(art, { data: Buffer.from('page') });
    const dst = `pub/${KEY22}/p1-0123456789ab.webp`;
    await store.copyObject(art, dst);
    await store.copyObject(art, dst); // idempotent (content-hashed name)
    expect(fake.bucket(PUB).get(dst)?.data.toString()).toBe('page');
    await expect(store.copyObject(art, `u/${USER}/p/${PROJECT}/img/guessable.webp`)).rejects.toMatchObject({ status: 400 });
    await expect(store.copyObject(`q/${USER}/${PROJECT}/x.webp`, dst)).rejects.toMatchObject({ status: 400 });

    const jpg = await sharp(await solidPng(40, 20)).jpeg().toBuffer();
    await store.putObject(`pub/${KEY22}/og-en-0123456789ab.jpg`, jpg, 'image/jpeg', 'public, max-age=31536000');
    const put = fake.calls.upload.find((c) => c.path.endsWith('og-en-0123456789ab.jpg'))!;
    expect(put).toMatchObject({ bucket: PUB, opts: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000', upsert: true } });
    await expect(store.putObject(`pub/${KEY22}/x.svg`, Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toMatchObject({ status: 415 });
    await expect(store.putObject(`pub/${KEY22}/x.jpg`, Buffer.from('<html>'), 'image/jpeg')).rejects.toMatchObject({ status: 415 });
    await expect(store.putObject(`u/${USER}/p/${PROJECT}/img/x.webp`, jpg, 'image/jpeg')).rejects.toMatchObject({ status: 400 });
  });

  it('removePrefix sweeps one publication folder and refuses anything else', async () => {
    const { fake, store } = v5Store();
    for (let i = 0; i < 3; i += 1) fake.bucket(PUB).set(`pub/${KEY22}/p${i}-0123456789ab.webp`, { data: Buffer.from('x') });
    fake.bucket(PUB).set(`pub/Zb3dEf6hIj9kLm2nOp5qRs/keep.webp`, { data: Buffer.from('x') });
    expect(await store.removePrefix(`pub/${KEY22}/`)).toBe(3);
    expect(fake.bucket(PUB).has('pub/Zb3dEf6hIj9kLm2nOp5qRs/keep.webp')).toBe(true);
    await expect(store.removePrefix(`u/${USER}/`)).rejects.toMatchObject({ status: 400 });
    await expect(store.removePrefix('pub/')).rejects.toMatchObject({ status: 400 });
  });
});

describe('v5: restoreQuarantined (appeal cleared / moderator restore)', () => {
  const art = `u/${USER}/p/${PROJECT}/img/page-1.webp`;
  const ref = `u/${USER}/p/${PROJECT}/ref/face-1.webp`;
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const realWebp = async () => sharp(await noisePng(1200, 900)).webp().toBuffer();

  it('moves held art back to its own path in the public bucket: copy, then delete the hold; rows live again; variants rebuilt', async () => {
    const { fake, store } = v5Store();
    const bytes = await realWebp();
    fake.bucket(PUB).set(art, { data: bytes, type: 'image/webp' });
    fake.rows.push({ path: art, deleted_at: null, expires_at: null }, { path: art.replace('.webp', '_w480.webp'), deleted_at: null });
    const { quarantinePath } = await store.quarantine(art, 'blocked:violence');
    expect(quarantinePath).toBe(quarantinePathFor(art));
    expect(fake.rows.find((r) => r.path === art)?.deleted_at).toBeTruthy();

    await store.restoreQuarantined!(quarantinePath, art);
    expect(fake.bucket(PUB).get(art)?.data.equals(bytes)).toBe(true);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(false);
    // Copy first, delete after (the delete only ever touches the q/ object in the private bucket).
    const copyAt = fake.calls.copy.findIndex((c) => c.from === quarantinePath);
    expect(fake.calls.copy[copyAt]).toMatchObject({ bucket: PRIV, to: art, dst: PUB });
    expect(fake.calls.remove.at(-1)).toEqual({ bucket: PRIV, paths: [quarantinePath] });
    // The original's row tracks it again; the hold row is closed.
    expect(fake.rows.find((r) => r.path === art)).toMatchObject({ deleted_at: null, expires_at: null });
    expect(fake.rows.find((r) => r.path === quarantinePath)?.deleted_at).toBeTruthy();
    // The variants that left with it are back at the paths the doc still lists (and their rows live).
    expect(fake.bucket(PUB).has(art.replace('.webp', '_w480.webp'))).toBe(true);
    expect(fake.bucket(PUB).has(art.replace('.webp', '_w1080.webp'))).toBe(true);
    expect(fake.rows.find((r) => r.path === art.replace('.webp', '_w480.webp'))?.deleted_at).toBeNull();
    // Nothing is signed or made public by a restore.
    expect(fake.calls.sign).toEqual([]);
    // It reads like a fresh object (no stale "missing" cache).
    await expect(store.loadDataUrl(art)).resolves.toMatch(/^data:image\/webp;base64,/);
  });

  it('is idempotent: a repeat after a finished restore resolves and moves nothing', async () => {
    const { fake, store } = v5Store();
    fake.bucket(PUB).set(art, { data: Buffer.from('art') });
    const { quarantinePath } = await store.quarantine(art, 'blocked');
    await store.restoreQuarantined!(quarantinePath, art);
    const removes = fake.calls.remove.length;
    await expect(store.restoreQuarantined!(quarantinePath, art)).resolves.toBeUndefined();
    expect(fake.calls.remove.length).toBe(removes);
    expect(fake.bucket(PUB).get(art)?.data.toString()).toBe('art');
  });

  it('a reference photo goes back to the PRIVATE bucket only (the private ACL is kept, nothing is signed)', async () => {
    const { fake, store } = v5Store();
    fake.bucket(PRIV).set(ref, { data: Buffer.from('face') });
    const { quarantinePath } = await store.quarantine(ref, 'blocked:sexual');
    expect(fake.bucket(PRIV).has(ref)).toBe(false);
    await store.restoreQuarantined!(quarantinePath, ref);
    expect(fake.bucket(PRIV).get(ref)?.data.toString()).toBe('face');
    expect(fake.bucket(PUB).has(ref)).toBe(false);
    expect([...fake.bucket(PUB).keys()]).toEqual([]);
    expect(fake.calls.copy.at(-1)).toMatchObject({ bucket: PRIV, from: quarantinePath, to: ref, dst: PRIV });
    expect(fake.calls.sign).toEqual([]);
  });

  it('only the q/ object of that very path, back to that path — anything else is a 400 and nothing moves', async () => {
    const { fake, store } = v5Store();
    fake.bucket(PUB).set(art, { data: Buffer.from('art') });
    const { quarantinePath } = await store.quarantine(art, 'blocked');
    const copies = fake.calls.copy.length;
    const refused = [
      [quarantinePath, `u/${USER}/p/${PROJECT}/img/page-2.webp`], // another path of the same project
      [quarantinePath, `u/${OTHER}/p/${PROJECT}/img/page-1.webp`], // another user's lane
      [quarantinePath, `pub/${KEY22}/p1-0123456789ab.webp`], // the public publication lane
      [quarantinePath, quarantinePath], // back into the vault
      [quarantinePath, `u/${USER}/p/${PROJECT}/img/../img/page-1.webp`], // traversal
      [art, art], // the source must be a held object
      [`q/${USER}/${PROJECT}/../../x.webp`, art],
      [`library/v1/a/b.webp`, art],
      [quarantinePath, ''],
      [undefined, art],
      [quarantinePath, 'u/---/p/x/img/page-1.webp'] // a degenerate owner segment: a 400, never a raw Error
    ] as const;
    for (const [q, dst] of refused) {
      await expect(store.restoreQuarantined!(q as string, dst as string)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    }
    expect(fake.calls.copy.length).toBe(copies);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(true);
    expect(fake.bucket(PUB).has(`u/${USER}/p/${PROJECT}/img/page-2.webp`)).toBe(false);
  });

  it('honest failures: nothing held and nothing back → 404; Storage unable to say → 503 (retryable)', async () => {
    const { fake, store } = v5Store();
    const q = quarantinePathFor(art);
    await expect(store.restoreQuarantined!(q, art)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, userMessage: expect.stringMatching(/no longer in the safety hold/) });
    fake.fail.exists = true;
    await expect(store.restoreQuarantined!(q, art)).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fake.bucket(PUB).has(art)).toBe(false);
  });

  it('an older Storage server without cross-bucket copies: the bytes move through the server once, into the original bucket', async () => {
    const { fake, store } = v5Store();
    fake.bucket(PUB).set(art, { data: Buffer.from('art-bytes'), type: 'image/webp' });
    const { quarantinePath } = await store.quarantine(art, 'blocked');
    fake.fail.crossBucketCopy = true;
    await store.restoreQuarantined!(quarantinePath, art);
    expect(fake.bucket(PUB).get(art)?.data.toString()).toBe('art-bytes');
    expect(fake.calls.upload.at(-1)).toMatchObject({ bucket: PUB, path: art, opts: { upsert: false } });
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(false);
  });

  it('a failed hold cleanup never reports a restored image as failed; the next call finishes it', async () => {
    const { fake, store } = v5Store();
    fake.bucket(PUB).set(art, { data: Buffer.from('art') });
    const { quarantinePath } = await store.quarantine(art, 'blocked');
    fake.fail.remove = (bucket) => bucket === PRIV;
    await expect(store.restoreQuarantined!(quarantinePath, art)).resolves.toBeUndefined();
    expect(fake.bucket(PUB).has(art)).toBe(true);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(true); // still private, never signed, under its 90-day expiry
    fake.fail.remove = null;
    await store.restoreQuarantined!(quarantinePath, art); // copy answers 'exists'; the delete completes
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(false);
    expect(fake.bucket(PUB).get(art)?.data.toString()).toBe('art');
  });

  it('the memory store has the same guard and semantics', async () => {
    const store = createMemoryAssetStore();
    const path = 'u/user-1/p/proj-1/img/page.webp';
    store.put(path, `data:image/png;base64,${(await solidPng(1200, 900)).toString('base64')}`);
    const { quarantinePath } = await store.quarantine(path, 'blocked');
    expect(quarantinePath).toBe(quarantinePathFor(path));
    await expect(store.restoreQuarantined!(quarantinePath, 'u/user-1/p/proj-1/img/other.webp')).rejects.toMatchObject({ status: 400 });
    await store.restoreQuarantined!(quarantinePath, path);
    expect(store.files.has(path)).toBe(true);
    expect(store.files.has(quarantinePath)).toBe(false);
    expect(store.files.has('u/user-1/p/proj-1/img/page_w480.webp')).toBe(true);
    expect(store.restored).toEqual([{ quarantinePath, originalPath: path }]);
    await expect(store.restoreQuarantined!(quarantinePath, path)).resolves.toBeUndefined(); // idempotent
    expect(store.restored).toHaveLength(1);
    await expect(store.restoreQuarantined!(quarantinePathFor('u/user-1/p/proj-1/img/gone.webp'), 'u/user-1/p/proj-1/img/gone.webp')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('restoreQuarantined through the safety restore paths (production store)', () => {
  const OWNER = USER;
  const page = `u/${USER}/p/${PROJECT}/img/p1.webp`;
  afterEach(() => {
    resetSafety();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  const heldPageDoc = (): ComicDoc => {
    const doc = plannedDoc(PROJECT);
    doc.settings.rating = 'PG';
    doc.pages[0].render = {
      ...emptyRender(),
      status: 'ready',
      asset: { path: page, source: 'generated', at: 1, safety: { assessed: 'X', categories: ['graphic_gore'], at: 1, by: 'qc', quarantined: true } }
    };
    return doc;
  };

  const heldPage = async () => {
    const { fake, store } = v5Store();
    fake.bucket(PUB).set(page, { data: await sharp(await noisePng(640, 800)).webp().toBuffer(), type: 'image/webp' });
    const fakes = installSafetyFakes({ assets: store });
    fakes.store.projects.set(PROJECT, { ownerUserId: OWNER, name: 'Spice Run', isForcedPrivate: false });
    const quarantinePath = await quarantineAsset(store, { path: page, projectId: PROJECT, userId: OWNER, categories: ['graphic_gore'] });
    expect(quarantinePath).toBe(quarantinePathFor(page));
    expect(fake.bucket(PUB).has(page)).toBe(false);
    return { fake, store, fakes, quarantinePath: quarantinePath! };
  };

  it('a moderator restore moves the object back, clears the hold and tells the owner the truth', async () => {
    const { fake, fakes, quarantinePath } = await heldPage();
    const session = newSession(heldPageDoc(), undefined, OWNER);
    fakes.sessions.set(PROJECT, session);
    const opened = await fakes.store.openCase({
      kind: 'appeal',
      projectId: PROJECT,
      ownerUserId: OWNER,
      target: { target: { kind: 'page', id: 'pg_1' }, path: page, quarantinePath },
      reason: 'second opinion agreed'
    });
    const out = await resolveCase('mod-1', opened.id!, { action: 'restore', assessed: 'PG', reason: 'ketchup, not blood' });
    expect(out.effects).toEqual(['restored']);
    expect(fake.bucket(PUB).has(page)).toBe(true);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(false);
    expect(fakes.store.quarantine.has(page)).toBe(false);
    expect(session.doc.pages[0].render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'admin' });
    expect(session.doc.pages[0].render.asset?.safety?.quarantined).toBeUndefined();
    expect(fakes.store.notifications.at(-1)).toMatchObject({ userId: OWNER, title: 'Your image is back' });
  });

  it('an appeal the second opinion clears brings the page back (it was refused by copyObject before)', async () => {
    const { fake, store, fakes, quarantinePath } = await heldPage();
    const ctx = testContext(newSession(heldPageDoc(), undefined, OWNER));
    (ctx as { assets: unknown }).assets = store;
    fakes.llm.script.writer = [{ ...cleanAnswer({ role: 'vision', messages: [], jsonSchema: { name: 'comic_safety_image', schema: {} } }), rating: 'PG' }];
    const r = await runAppeal(ctx, { kind: 'page', id: 'pg_1' }, 'It is a ketchup fight!');
    expect(r).toMatchObject({ status: 'cleared', rating: 'PG' });
    expect(fake.bucket(PUB).has(page)).toBe(true);
    expect(fake.bucket(PRIV).has(quarantinePath)).toBe(false);
    expect(ctx.session.doc.pages[0].render.asset?.safety).toMatchObject({ assessed: 'PG', by: 'second_opinion' });
    expect(fakes.store.quarantine.size).toBe(0);
  });

  it('safety reports an honest false (never a servable image) when the pairing is wrong or the object is gone', async () => {
    const { fake, store, quarantinePath } = await heldPage();
    expect(await restoreFromQuarantine(store, quarantinePath, `u/${USER}/p/${PROJECT}/img/p2.webp`, PROJECT)).toBe(false);
    fake.bucket(PRIV).delete(quarantinePath);
    expect(await restoreFromQuarantine(store, quarantinePath, page, PROJECT)).toBe(false);
    expect(fake.bucket(PUB).has(page)).toBe(false);
  });
});

describe('restoreQuarantined has one caller', () => {
  it('only safety/deps.ts (the moderation and appeal restore paths) calls it — never a route, tool or job', () => {
    const root = fileURLToPath(new URL('..', import.meta.url)); // server/src
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    const callers = files
      .filter((f) => /restoreQuarantined\s*(?:\?\.|!)?\s*\(/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((f) => relative(root, f).split('\\').join('/'))
      .sort();
    // Declarations (types.ts, the stores) don't count; the call is in safety/deps.ts alone.
    const calls = callers.filter((f) => !['comic/assets.ts', 'comic/types.ts', 'comic/orchestrator.fakes.ts'].includes(f));
    expect(calls).toEqual(['comic/safety/deps.ts']);
  });
});

describe('v5: memory store implements the whole surface', () => {
  it('saves private refs, measures, crops, fits, makes variants and quarantines', async () => {
    const store = createMemoryAssetStore();
    const encoded = await store.encodeUploadBuffer(await noisePng(1200, 900), 'image/png');
    const ref = await store.saveRef({ userId: 'user-1', projectId: 'proj-1', encoded });
    expect(ref.path).toMatch(/^u\/user-1\/p\/proj-1\/ref\//);
    expect(ref.variants?.map((v) => v.w)).toEqual([480, 1080]);
    expect(await store.signUrls([ref.path], { ttlSec: 3600 })).toEqual({ [ref.path]: `mem://${ref.path}` });
    expect(store.signedTtl[ref.path]).toBe(300);
    const crop = await store.cropRef({ userId: 'user-1', projectId: 'proj-1', path: ref.path, aspect: '3:4' });
    expect(crop).toMatchObject({ source: 'derived', derivedFrom: ref.path, w: 675, h: 900 });
    store.put('u/user-1/p/proj-1/img/page.webp', `data:image/png;base64,${(await solidPng(2048, 2048)).toString('base64')}`);
    const fit = await store.fitToAspect({ userId: 'user-1', projectId: 'proj-1', path: 'u/user-1/p/proj-1/img/page.webp', aspect: '4:5', mode: 'pad' });
    expect([fit.w, fit.h]).toEqual([1638, 2048]);
    const { quarantinePath } = await store.quarantine('u/user-1/p/proj-1/img/page.webp', 'blocked');
    expect(quarantinePath.startsWith('q/user-1/proj-1/')).toBe(true);
    expect(store.files.has('u/user-1/p/proj-1/img/page.webp')).toBe(false);
  });
});
