// @vitest-environment node
//
// P1-REFS upload API (refs.md §4.1, §9 routes): POST /projects/:id/refs and DELETE …?owner=inbox.
// Owner-only (404 for others), private storage, honest 409 caps (also under parallel uploads),
// 413/415 by magic bytes, exact + near duplicates, and — with the safety fake — a blocked upload
// stores NOTHING. Uploads never redraw: the only op is ref_add.
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc, RefAsset } from '../../../shared/comic/doc.js';
import { REF_LIMITS } from '../../../shared/comic/refs.js';
import { encodeUploadBuffer } from '../comic/assets.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, plannedDoc, scriptedLlm, type FakeAssetStore, type FakeDocStore } from '../comic/orchestrator.fakes.js';
import { StudioSession, __resetSessionsForTests } from '../comic/session.js';
import { StudioError } from '../comic/types.js';
import { mountComicOwnerRoutes } from './comicMounts.js';
import { __resetRefUploadsForTests, createComicRefsRouter } from './comicRefs.js';

type Screen = NonNullable<Parameters<typeof createComicRefsRouter>[0]>['screen'];

const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n, ...extra });

let png: Buffer;
let png2: Buffer;
let png3: Buffer;
beforeAll(async () => {
  const make = (r: number) => sharp({ create: { width: 320, height: 240, channels: 3, background: { r, g: 90, b: 40 } } }).png().toBuffer();
  [png, png2, png3] = await Promise.all([make(200), make(20), make(120)]);
});

interface Harness {
  base: string;
  store: FakeDocStore;
  assets: FakeAssetStore;
  screen: ReturnType<typeof vi.fn>;
  saveRef: ReturnType<typeof vi.spyOn>;
  doc(): ComicDoc;
  close(): Promise<void>;
}

const servers: Harness[] = [];

async function harness(opts: { doc?: ComicDoc; screen?: Screen; locals?: Record<string, unknown>; now?: () => number } = {}): Promise<Harness> {
  const store = fakeDocStore();
  const doc = opts.doc || plannedDoc();
  store.docs.set(doc.id, { userId: 'user-1', doc });
  const assets = fakeAssetStore();
  const saveRef = vi.spyOn(assets, 'saveRef');
  const screen = vi.fn(
    opts.screen ||
      (async () => ({
        decision: 'allow' as const,
        verdict: { assessed: 'G' as const, by: 'upload' as const, at: 1 },
        describe: { subject: 'person' as const, view: 'front' as const, caption: 'a girl with a red scarf', multipleSubjects: false }
      }))
  );
  const app = express();
  app.use((req, res, next) => {
    const id = req.header('x-test-user');
    if (id) (req as unknown as { user: { id: string } }).user = { id };
    Object.assign(res.locals, opts.locals || {});
    next();
  });
  app.use(
    '/api/comic',
    createComicRefsRouter({
      store,
      screen: screen as unknown as Screen,
      now: opts.now,
      contextDeps: () => ({ assets, keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, billing: fakeBilling() })
    })
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const h: Harness = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    store,
    assets,
    screen,
    saveRef,
    doc: () => store.docs.get(doc.id)!.doc,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
  servers.push(h);
  return h;
}

beforeEach(() => {
  __resetSessionsForTests();
  __resetRefUploadsForTests();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  __resetSessionsForTests();
  vi.restoreAllMocks();
});

const upload = (h: Harness, query: string, body: Buffer | string = png, opts: { user?: string | null; type?: string } = {}) =>
  fetch(`${h.base}/api/comic/projects/proj-1/refs?${query}`, {
    method: 'POST',
    headers: { 'content-type': opts.type ?? 'image/png', ...(opts.user === null ? {} : { 'x-test-user': opts.user ?? 'user-1' }) },
    body
  });

const refFiles = (h: Harness) => [...h.assets.files.keys()].filter((p) => p.includes('/ref/'));

describe('POST /projects/:id/refs', () => {
  it('201: stores PRIVATELY, commits one ref_add with server metadata, signs a short-lived URL', async () => {
    const h = await harness();
    const res = await upload(h, 'to=character:c_maya&name=IMG_2041.jpg&hash=0123456789abcdef&index=0');
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.ref.path).toMatch(/^u\/user-1\/p\/proj-1\/ref\/[A-Za-z0-9_-]+\.webp$/);
    expect(body.ref).toMatchObject({
      source: 'upload',
      addedBy: 'user',
      name: 'IMG_2041.jpg',
      hash: '0123456789abcdef',
      label: 'front', // the vision "view" suggestion (no label was passed)
      caption: 'a girl with a red scarf',
      subject: 'person',
      safety: { assessed: 'G' }
    });
    expect(body.ref.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.ops).toEqual([{ op: 'ref_add', owner: { kind: 'character', id: 'c_maya' }, ref: body.ref, index: 0 }]);
    expect(typeof body.rev).toBe('number');
    expect(body.urls[body.ref.path]).toBe(`https://signed.test/${body.ref.path}`);
    expect(h.assets.signedTtl).toContain(300);
    // Persisted (flushed) on the owner's doc.
    expect(h.doc().cast[0].refs.map((r) => r.path)).toEqual([body.ref.path]);
    // The screen saw the in-memory preview BEFORE anything was stored.
    expect(h.screen).toHaveBeenCalledTimes(1);
    expect(h.screen.mock.invocationCallOrder[0]).toBeLessThan(h.saveRef.mock.invocationCallOrder[0]);
  });

  it('a user label wins over the vision suggestion; quality flags and multi-subject are recorded', async () => {
    const h = await harness({
      screen: async () => ({ decision: 'allow', describe: { subject: 'animal', view: 'face', caption: 'two dogs', multipleSubjects: true } }) as never
    });
    h.assets.measureRef = async () => ({ dhash: 'aaaaaaaaaaaaaaaa', quality: { blurry: true } });
    const body = await (await upload(h, 'to=character:c_maya&label=side')).json();
    expect(body.ref).toMatchObject({ label: 'side', quality: { blurry: true, multiSubject: true }, subject: 'animal' });
    // A place can't take a character view: the suggestion is dropped.
    const place = await (await upload(h, 'to=place:pl_market', png2)).json();
    expect(place.ref.label).toBeUndefined();
  });

  it('never marks a ready sheet stale and never draws (the only op is ref_add)', async () => {
    const doc = plannedDoc();
    const sheet = { path: 'u/user-1/p/proj-1/img/sheet.webp', source: 'generated' as const, at: 1 };
    doc.cast[0].refs = [ref(1)];
    doc.cast[0].sheet = { status: 'ready', asset: sheet, history: [], refPaths: [ref(1).path] };
    const h = await harness({ doc });
    const body = await (await upload(h, 'to=character:c_maya')).json();
    expect(body.ops.map((o: { op: string }) => o.op)).toEqual(['ref_add']);
    expect(h.doc().cast[0].sheet).toMatchObject({ status: 'ready', asset: sheet });
  });

  it('owner-only: 404 for another user, 401 when signed out; bad owners are 400', async () => {
    const h = await harness();
    expect((await upload(h, 'to=style', png, { user: 'user-2' })).status).toBe(404);
    expect((await upload(h, 'to=style', png, { user: null })).status).toBe(401);
    const gone = await upload(h, 'to=character:c_gone');
    expect(gone.status).toBe(400);
    expect((await gone.json()).error.message).toBe('That character is no longer in the cast.');
    expect((await upload(h, 'to=character:../x')).status).toBe(400);
    expect((await upload(h, 'to=everything')).status).toBe(400);
    expect((await upload(h, 'to=style&label=banana')).status).toBe(400);
    expect(refFiles(h)).toEqual([]);
  });

  it('restricted accounts cannot upload', async () => {
    const h = await harness({ locals: { moderationStatus: 'restricted' } });
    const res = await upload(h, 'to=style');
    expect(res.status).toBe(403);
    expect(refFiles(h)).toEqual([]);
  });

  it('409 LIMIT at the owner cap and at the 150-per-comic cap — named, never silent, nothing stored', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: REF_LIMITS.character }, (_, i) => ref(100 + i));
    const h = await harness({ doc });
    const res = await upload(h, 'to=character:c_maya');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'LIMIT', message: 'MAYA already has 12 photos (the limit) — remove one to add another.' } });

    const big = plannedDoc();
    for (let k = 0; k < 13; k += 1) {
      big.cast.push({ id: `c_x${k}`, name: `X${k}`, tier: 'support', look: { summary: '' }, refs: Array.from({ length: k < 12 ? 12 : 6 }, (_, i) => ref(1000 + k * 20 + i)), sheet: { status: 'none', history: [] } });
    }
    big.id = 'proj-1';
    __resetSessionsForTests();
    const h2 = await harness({ doc: big });
    const full = await upload(h2, 'to=style');
    expect(full.status).toBe(409);
    expect((await full.json()).error.message).toMatch(/already has 150 reference photos/);
    expect(refFiles(h)).toEqual([]);
    expect(refFiles(h2)).toEqual([]);
  });

  it('parallel uploads near the cap: exactly the free slots land, the rest get an honest 409', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = Array.from({ length: REF_LIMITS.character - 1 }, (_, i) => ref(100 + i));
    const h = await harness();
    h.store.docs.get('proj-1')!.doc = doc;
    const results = await Promise.all([png, png2, png3].map((b) => upload(h, 'to=character:c_maya', b)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    expect(h.doc().cast[0].refs).toHaveLength(REF_LIMITS.character);
    expect(refFiles(h)).toHaveLength(1);
  });

  it('415 by magic bytes even with a spoofed Content-Type (SVG, HTML, HEIC); 413 over 10 MB', async () => {
    const h = await harness();
    h.assets.encodeUploadBuffer = encodeUploadBuffer; // the real sniff + sharp encode
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect((await upload(h, 'to=style', svg, { type: 'image/png' })).status).toBe(415);
    expect((await upload(h, 'to=style', '<html><body>hi</body></html>', { type: 'image/jpeg' })).status).toBe(415);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic'), Buffer.alloc(64)]);
    const heicRes = await upload(h, 'to=style', heic, { type: 'image/jpeg' });
    expect(heicRes.status).toBe(415);
    expect((await heicRes.json()).error.message).toMatch(/HEIC/);
    expect((await upload(h, 'to=style', png, { type: 'image/svg+xml' })).status).toBe(415);
    const tooBig = await upload(h, 'to=style', Buffer.alloc(REF_LIMITS.maxUploadBytes + 1, 1));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error.message).toMatch(/larger than 10 MB/);
    // A real PNG goes through the real encoder to WebP.
    const ok = await upload(h, 'to=style');
    expect(ok.status).toBe(201);
    expect((await ok.json()).ref).toMatchObject({ w: 320, h: 240 });
    expect(refFiles(h)).toHaveLength(1);
  });

  it('exact duplicate (same original file hash) → 200 duplicateOf, nothing screened or stored', async () => {
    const doc = plannedDoc();
    doc.cast[0].refs = [ref(1, { hash: 'abcdefabcdefabcd' })];
    const h = await harness({ doc });
    const res = await upload(h, 'to=character:c_maya&hash=abcdefabcdefabcd');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicateOf: ref(1).path, ops: [] });
    expect(h.screen).not.toHaveBeenCalled();
    expect(h.saveRef).not.toHaveBeenCalled();
  });

  it('near duplicate (dHash) → stored anyway with a notice naming the look-alike', async () => {
    const h = await harness();
    const dhash = await h.assets.dHash(png);
    h.store.docs.get('proj-1')!.doc.cast[0].refs = [ref(1, { dhash })];
    const res = await upload(h, 'to=character:c_maya');
    expect(res.status).toBe(201);
    expect((await res.json()).notice).toEqual({ kind: 'near_duplicate', of: ref(1).path });
  });

  it('SAFETY: a blocked upload stores NOTHING (no saveRef, no file, no op)', async () => {
    const h = await harness({ screen: async () => ({ decision: 'block', verdict: { assessed: 'X', by: 'upload', at: 1 } }) as never });
    const rev = h.doc().rev;
    const res = await upload(h, 'to=character:c_maya');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: 'CONTENT_POLICY', message: "This image doesn't fit DreamStream's content rules, so it wasn't added." } });
    expect(h.saveRef).not.toHaveBeenCalled();
    expect(refFiles(h)).toEqual([]);
    expect(h.doc().cast[0].refs).toEqual([]);
    expect(h.doc().rev).toBe(rev);
  });

  it('a commit the session refuses (doc too large) leaves no orphan file behind and says why', async () => {
    const h = await harness();
    const commit = vi.spyOn(StudioSession.prototype, 'commit').mockImplementation(function (this: StudioSession, ops) {
      if (ops.some((o) => o.op === 'ref_add')) {
        throw new StudioError('LIMIT', 'This comic has grown too large to save more changes.', { status: 409 });
      }
      return this.doc;
    });
    const remove = vi.spyOn(h.assets, 'remove');
    const res = await upload(h, 'to=character:c_maya');
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toMatch(/too large/);
    expect(h.saveRef).toHaveBeenCalledTimes(1);
    const stored = (await h.saveRef.mock.results[0].value) as RefAsset;
    expect(remove).toHaveBeenCalledWith([stored.path]);
    expect(h.doc().cast[0].refs).toEqual([]);
    commit.mockRestore();
  });

  it('safety unavailable (or erroring) → stored unchecked, gated lazily before first render use', async () => {
    const h = await harness({ screen: async () => ({ decision: 'unavailable' }) as never });
    const body = await (await upload(h, 'to=style')).json();
    expect(body.ref.path).toBeTruthy();
    expect(body.ref.safety).toBeUndefined();
    const h2 = await harness({
      screen: async () => {
        throw new Error('classifier down');
      }
    });
    const res = await upload(h2, 'to=style');
    expect(res.status).toBe(201);
    expect((await res.json()).ref.safety).toBeUndefined();
  });

  it('inbox: uploads land in the inbox, expired drafts are pruned first, a full inbox is a 409', async () => {
    // The session prunes on load too; this item expires between the load and the upload.
    const now = Date.now() + 60_000;
    const doc = plannedDoc();
    doc.refInbox = [ref(1, { at: now - REF_LIMITS.inboxTtlMs - 5 }), ...Array.from({ length: REF_LIMITS.inbox - 1 }, (_, i) => ref(200 + i, { at: now - 1000 }))];
    const h = await harness({ doc, now: () => now });
    const res = await upload(h, 'to=inbox');
    expect(res.status).toBe(201);
    const inbox = h.doc().refInbox!.map((r) => r.path);
    expect(inbox).not.toContain(ref(1).path);
    expect(inbox).toHaveLength(REF_LIMITS.inbox);
    const full = await upload(h, 'to=inbox', png2);
    expect(full.status).toBe(409);
    expect((await full.json()).error.message).toMatch(/waiting to be sent or assigned/);
  });
});

describe('DELETE /projects/:id/refs?owner=inbox', () => {
  it('removes an unsent composer upload (idempotent); other owners use the patch path', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref(1, { at: Date.now() }), ref(2, { at: Date.now() })];
    const h = await harness({ doc });
    const del = (q: string, user = 'user-1') => fetch(`${h.base}/api/comic/projects/proj-1/refs?${q}`, { method: 'DELETE', headers: { 'x-test-user': user } });
    const res = await del(`owner=inbox&path=${encodeURIComponent(ref(1).path)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).ops).toEqual([{ op: 'ref_remove', owner: { kind: 'inbox' }, path: ref(1).path }]);
    expect(h.doc().refInbox!.map((r) => r.path)).toEqual([ref(2).path]);
    expect((await (await del(`owner=inbox&path=${encodeURIComponent(ref(1).path)}`)).json()).ops).toEqual([]);
    expect((await del(`owner=character:c_maya&path=${encodeURIComponent(ref(2).path)}`)).status).toBe(400);
    expect((await del(`owner=inbox&path=${encodeURIComponent(ref(2).path)}`, 'user-2')).status).toBe(404);
    expect(h.doc().refInbox!.map((r) => r.path)).toEqual([ref(2).path]);
  });
});

describe('mounting: the upload rate limit covers exactly the refs path', () => {
  it('429 from comicUploadRateLimit on the refs path; other studio paths are not counted', async () => {
    const store = fakeDocStore();
    store.docs.set('proj-1', { userId: 'user-1', doc: plannedDoc() });
    const assets = fakeAssetStore();
    let hits = 0;
    const limiter: express.RequestHandler = (_req, res, next) => {
      hits += 1;
      if (hits > 2) {
        res.status(429).set('Retry-After', '30').json({ error: { message: 'Too many uploads — try again in 30 s.', code: 'RATE_LIMIT' } });
        return;
      }
      next();
    };
    const pass: express.RequestHandler = (_req, _res, next) => next();
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string } }).user = { id: 'user-1' };
      next();
    });
    const studio = express.Router();
    studio.get('/projects/:id', (_req, res) => {
      res.json({ ok: true });
    });
    mountComicOwnerRoutes(app, {
      textRateLimit: pass,
      adminRateLimit: pass,
      moderationRateLimit: pass,
      requireAdmin: pass,
      requireModerator: pass,
      requireActive: pass,
      limits: { upload: [limiter], publish: [], translateQuote: [] },
      comicRouter: studio,
      libraryAdminRouter: pass,
      storageAdminRouter: pass,
      moderationRouter: pass,
      featureRouters: [
        createComicRefsRouter({ store, screen: (async () => ({ decision: 'allow' })) as never, contextDeps: () => ({ assets, keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, billing: fakeBilling() }) })
      ]
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (b: Buffer) => fetch(`${base}/api/comic/projects/proj-1/refs?to=style`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: b });
      expect((await post(png)).status).toBe(201);
      expect((await post(png2)).status).toBe(201);
      const limited = await post(png3);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('30');
      expect((await fetch(`${base}/api/comic/projects/proj-1`)).status).toBe(200);
      expect(hits).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
