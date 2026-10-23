// The in-memory fakes implement the WHOLE AssetStore contract (§12.5) so feature tests run without
// storage; the real stores expose the same surface, and since P1-STORAGE landed the real v5 methods
// enforce the storage guards themselves (P2-AMEND replaced the wave-0 NOT_AVAILABLE assertion).
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryAssetStore, createSupabaseAssetStore } from './assets.js';
import { fakeAssetStore } from './orchestrator.fakes.js';
import { restoreFromQuarantine } from './safety/deps.js';
import { installSafetyFakes, resetSafety } from './safety/testkit.js';
import { isPrivatePath } from './storagePaths.js';

const V5_METHODS = [
  'encodeUploadBuffer', 'saveRef', 'previewDataUrl', 'measureRef', 'dHash', 'cropRef', 'fitToAspect',
  'ensureVariants', 'quarantine', 'remove', 'copyObject', 'putObject', 'removePrefix'
] as const;
const ALL_METHODS = ['saveGenerated', 'saveUpload', 'loadDataUrl', 'signUrls', 'outlineRegion', ...V5_METHODS];

describe('AssetStore conformance', () => {
  it('fake, memory and Supabase stores expose every method', () => {
    for (const store of [fakeAssetStore(), createMemoryAssetStore(), createSupabaseAssetStore({ admin: (() => { throw new Error('no db'); }) as never })]) {
      for (const m of ALL_METHODS) expect(typeof (store as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('the real memory store enforces the upload and lane guards (magic bytes, no SVG/HTML, min edge, pub/library only)', async () => {
    const mem = createMemoryAssetStore();
    const KEY = 'a'.repeat(22);
    // Uploads: contents decide, never the claimed type.
    await expect(mem.encodeUploadBuffer(Buffer.from('x'), 'image/png')).rejects.toMatchObject({ status: 415 });
    await expect(mem.encodeUploadBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml')).rejects.toMatchObject({ status: 415 });
    await expect(mem.encodeUploadBuffer(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png')).rejects.toMatchObject({ status: 415 });
    const tiny = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#336699' } }).png().toBuffer();
    await expect(mem.encodeUploadBuffer(tiny, 'image/png')).rejects.toMatchObject({ status: 422 });
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#336699' } }).png().toBuffer();
    expect(await mem.encodeUploadBuffer(png, 'image/png')).toMatchObject({ mime: 'image/webp', w: 300, h: 200 });
    // Lanes: only a publication folder can be removed; quarantine is never a copy source; writes go to pub/ or library/ only.
    await expect(mem.removePrefix('u/x/')).rejects.toMatchObject({ status: 400 });
    await expect(mem.removePrefix(`pub/${KEY}/`)).resolves.toBe(0);
    await expect(mem.copyObject('q/u/x/p/y/img/a.webp', `pub/${KEY}/a.webp`)).rejects.toMatchObject({ status: 400 });
    await expect(mem.putObject('u/x/p/y/img/a.webp', png, 'image/png')).rejects.toMatchObject({ status: 400 });
    await expect(mem.putObject(`pub/${KEY}/og.webp`, png, 'image/webp')).rejects.toMatchObject({ status: 415 });
    await expect(mem.putObject(`pub/${KEY}/og.png`, png, 'image/png')).resolves.toBeUndefined();
    // Free, local measurements.
    expect(await mem.dHash(png)).toMatch(/^[0-9a-f]{16}$/);
    expect(await mem.measureRef(png)).toMatchObject({ dhash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });
});

describe('fakeAssetStore v5 methods work', () => {
  it('encodes, stores a private ref, hashes deterministically and previews', async () => {
    const store = fakeAssetStore();
    const bytes = Buffer.from('photo-bytes');
    const encoded = await store.encodeUploadBuffer(bytes, 'image/jpeg');
    expect(encoded).toMatchObject({ mime: 'image/webp', w: 1024, h: 1024, bytes: bytes.byteLength });
    const saved = await store.saveRef({ userId: 'user-1', projectId: 'proj-1', encoded });
    expect(isPrivatePath(saved.path)).toBe(true);
    expect(await store.dHash(bytes)).toBe(await store.dHash(Buffer.from('photo-bytes')));
    expect((await store.measureRef(bytes)).dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.previewDataUrl(saved.path)).toMatch(/^data:image\/webp;base64,/);
    await expect(store.encodeUploadBuffer(bytes, 'image/svg+xml')).rejects.toMatchObject({ status: 415 });
    store.encodeSize = { w: 100, h: 900 };
    await expect(store.encodeUploadBuffer(bytes, 'image/png')).rejects.toMatchObject({ status: 422 });
  });

  it('crops, fits, makes variants, quarantines, copies, puts and removes', async () => {
    const store = fakeAssetStore();
    const src = 'u/user-1/p/proj-1/img/page.webp';
    store.files.set(src, 'data:image/webp;base64,AAAA');
    const crop = await store.cropRef({ userId: 'user-1', projectId: 'proj-1', path: src, aspect: '3:4' });
    expect(crop).toMatchObject({ source: 'derived', derivedFrom: src, w: 768, h: 1024 });
    const fit = await store.fitToAspect({ userId: 'user-1', projectId: 'proj-1', path: src, aspect: '4:5', mode: 'pad' });
    expect(fit).toMatchObject({ source: 'derived', derivedFrom: src, w: 1024, h: 1280 });
    expect(await store.ensureVariants({ path: src, source: 'generated', at: 1, w: 2048, h: 2560 })).toEqual([
      { path: 'u/user-1/p/proj-1/img/page_w480.webp', w: 480, h: 600 },
      { path: 'u/user-1/p/proj-1/img/page_w1080.webp', w: 1080, h: 1350 }
    ]);
    await store.copyObject(src, 'pub/Ab3dEf6hIj9kLm2nOp5qRs/p1-0123456789ab.webp');
    await store.putObject('pub/Ab3dEf6hIj9kLm2nOp5qRs/og-en-0123456789ab.jpg', Buffer.from('jpg'), 'image/jpeg', 'public, max-age=31536000');
    expect(await store.removePrefix('pub/Ab3dEf6hIj9kLm2nOp5qRs/')).toBe(2);
    const { quarantinePath } = await store.quarantine(src, 'blocked');
    expect(quarantinePath).toMatch(/^q\/user-1\/proj-1\//);
    await expect(store.loadDataUrl(src)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.remove([quarantinePath]);
    expect(store.files.has(quarantinePath)).toBe(false);
    await store.signUrls(['a'], { ttlSec: 300 });
    expect(store.signedTtl.at(-1)).toBe(300);
  });

  // P2-GATE L9: production has restoreQuarantined (assets.ts), so the fake has it by default and answers
  // like the production guard: 400 for a wrong pairing or a non-q/ source, idempotent repeat, 404 when
  // nothing is held. Only an explicit `false` models a store without it (the copyObject fallback).
  it('restoreQuarantined is ON by default, like the production store; false removes it', async () => {
    expect(typeof fakeAssetStore().restoreQuarantined).toBe('function');
    expect(typeof createMemoryAssetStore().restoreQuarantined).toBe('function');
    expect(fakeAssetStore({ restoreQuarantined: true }).restoreQuarantined).toBeTypeOf('function');
    expect(fakeAssetStore({ restoreQuarantined: false }).restoreQuarantined).toBeUndefined();
  });

  it('restoreQuarantined only moves a held q/ object back to the path it left (production answers)', async () => {
    const store = fakeAssetStore();
    const src = 'u/user-1/p/proj-1/img/page.webp';
    store.files.set(src, 'data:image/webp;base64,AAAA');
    const { quarantinePath } = await store.quarantine(src, 'blocked');
    // A wrong pairing or a source outside the hold: 400, like assets.ts assertRestorePair (not 404).
    await expect(store.restoreQuarantined!(quarantinePath, 'u/user-1/p/proj-1/img/other.webp')).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    await expect(store.restoreQuarantined!('u/user-1/p/proj-1/img/x.webp', src)).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(store.files.has(quarantinePath)).toBe(true); // a refused call moves nothing
    await store.restoreQuarantined!(quarantinePath, src);
    expect(await store.loadDataUrl(src)).toBe('data:image/webp;base64,AAAA');
    expect(store.files.has(quarantinePath)).toBe(false);
    expect(store.quarantined).toEqual([]);
    expect(store.restored).toEqual([{ quarantinePath, originalPath: src }]);
    // Idempotent like production: a repeat after a finished restore resolves and moves nothing more…
    await expect(store.restoreQuarantined!(quarantinePath, src)).resolves.toBeUndefined();
    expect(store.restored).toHaveLength(1);
    // …but still never to another path.
    await expect(store.restoreQuarantined!(quarantinePath, 'u/user-1/p/proj-1/img/other.webp')).rejects.toMatchObject({ status: 400 });
    // Nothing held at all: an honest 404 with the production wording.
    await expect(store.restoreQuarantined!('q/user-1/proj-1/never.webp', src)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404, userMessage: expect.stringMatching(/no longer in the safety hold/) });
  });

  it('the safety restore path (restoreFromQuarantine) moves the object back through restoreQuarantined, never copyObject', async () => {
    const safety = installSafetyFakes();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = fakeAssetStore();
      const src = 'u/user-1/p/proj-1/img/p1.webp';
      store.files.set(src, 'data:image/webp;base64,CCCC');
      const { quarantinePath } = await store.quarantine(src, 'blocked');
      safety.store.quarantine.set(src, quarantinePath);
      expect(await restoreFromQuarantine(store, quarantinePath, src, 'proj-1')).toBe(true);
      expect(store.restored).toEqual([{ quarantinePath, originalPath: src }]);
      expect(store.copies).toEqual([]);
      expect(await store.loadDataUrl(src)).toBe('data:image/webp;base64,CCCC');
      // A wrong pairing is refused by the store and reported as "still held", honestly.
      const other = 'u/user-1/p/proj-1/img/p2.webp';
      store.files.set(other, 'data:image/webp;base64,DDDD');
      const second = await store.quarantine(other, 'blocked');
      expect(await restoreFromQuarantine(store, second.quarantinePath, src, 'proj-1')).toBe(false);
      expect(store.files.has(second.quarantinePath)).toBe(true);
    } finally {
      resetSafety();
      vi.restoreAllMocks();
    }
  });

  it('a held object whose q/ copy is gone: 404 unless the original is already back', async () => {
    const store = fakeAssetStore();
    const src = 'u/user-1/p/proj-1/img/gone.webp';
    store.files.set(src, 'data:image/webp;base64,BBBB');
    const { quarantinePath } = await store.quarantine(src, 'blocked');
    store.files.delete(quarantinePath);
    await expect(store.restoreQuarantined!(quarantinePath, src)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    store.files.set(src, 'data:image/webp;base64,BBBB');
    await expect(store.restoreQuarantined!(quarantinePath, src)).resolves.toBeUndefined();
  });

  // Gate review (F6/L9): production's 'exists' branch re-uploads the HELD bytes over whatever sits at the
  // original path (S6: the verdict being restored must describe the bytes that are served). The fake must
  // answer the same, or a swap-while-held test would pass against the fake and fail in production.
  it('bytes put at the original path while it was held lose to the held bytes (same as the memory store)', async () => {
    for (const store of [fakeAssetStore(), createMemoryAssetStore()]) {
      const src = 'u/user-1/p/proj-1/img/swap.webp';
      store.files.set(src, 'data:image/webp;base64,HELD');
      const { quarantinePath } = await store.quarantine(src, 'blocked');
      expect(store.files.has(src)).toBe(false);
      // Something else lands at the original path while the image is held (bytes swapped after the check).
      store.files.set(src, 'data:image/webp;base64,SWAP');
      await store.restoreQuarantined!(quarantinePath, src);
      expect(store.files.get(src)).toBe('data:image/webp;base64,HELD');
      expect(store.files.has(quarantinePath)).toBe(false);
      expect(store.restored).toEqual([{ quarantinePath, originalPath: src }]);
    }
  });
});
