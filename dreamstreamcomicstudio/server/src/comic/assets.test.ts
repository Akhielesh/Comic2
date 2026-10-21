// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  isSafeStoragePath
} from './assets.js';
import { StudioError } from './types.js';

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
