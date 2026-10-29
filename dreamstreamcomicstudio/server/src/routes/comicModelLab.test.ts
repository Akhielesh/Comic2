// @vitest-environment node
// /api/comic/models/lab — admin-only (401 signed out, 403 signed-in non-admin, before the lab is touched), behind the
// mount's requireAdmin + admin rate limit and never the text limiter; no call without ack; one call per click with
// an idempotency key; the $2/day cap answered before any call; the blind pair hides names until the vote; unknown
// lab paths answer here and never reach the studio. Fakes only: the "provider" is a scripted fetch.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router, type RequestHandler } from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetImageClientForTests } from '../comic/imageClient.js';
import { fakeModelHealth } from '../comic/models/health.fakes.js';
import { registryPriceBook } from '../comic/models/index.js';
import { createMemoryLabStore, createModelLab, labItems, type LabOverview, type ModelLab } from '../comic/models/lab.js';
import { MODEL_LAB_BASE, comicModelLabRouter, createComicModelLabRouter } from './comicModelLab.js';
import { mountComicOwnerRoutes } from './comicMounts.js';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const T0 = Date.parse('2026-10-29T09:00:00Z');

let png: Buffer;
const providerCalls: string[] = [];
let store = createMemoryLabStore({ now: () => T0 });
const objects = new Map<string, Buffer>();
const makeLab = (): ModelLab =>
  createModelLab({
    store,
    storage: {
      put: async (path, buffer) => void objects.set(path, buffer),
      loadDataUrl: async (path) => `data:image/webp;base64,${objects.get(path)!.toString('base64')}`,
      signUrls: async (paths) => Object.fromEntries(paths.map((p) => [p, `https://signed.example/${p}`]))
    },
    keys: () => ({ openrouter: { key: 'sk-or-platform-test', byok: false } }),
    prices: async () => registryPriceBook(),
    health: fakeModelHealth({ now: T0 }),
    network: (async (input: RequestInfo | URL, init?: RequestInit) => {
      providerCalls.push(`${init?.method || 'GET'} ${String(input).replace(/^.*\/api\/v1/, '')}`);
      const model = String(JSON.parse(String(init?.body || '{}')).model || '');
      return new Response(JSON.stringify({ model: `${model}-v1`, data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }], usage: { cost: model.startsWith('qwen') ? 0.0184 : 0.018 } }), {
        status: 200
      });
    }) as typeof fetch,
    now: () => T0
  });
let lab = makeLab();
const labSpy = vi.fn(() => lab);

const requireAdmin: RequestHandler = (req, res, next) => (req.header('x-admin') ? next() : res.status(403).json({ error: { message: 'Admin access required' } }));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  const user = req.header('x-user');
  if (user) (req as unknown as { user: { id: string } }).user = { id: user };
  next();
});
app.use('/api/comic', createComicModelLabRouter({ lab: labSpy, requireAdmin }));
app.use((_req, res) => res.status(418).json({ route: 'fallthrough' }));

// The real mount (comicMounts.ts): its own requireAdmin + admin limiter sit on the lab prefix before any feature router.
const adminLimited: string[] = [];
const textLimited: string[] = [];
const mounted = express();
mounted.use(express.json());
mounted.use((req, _res, next) => {
  const user = req.header('x-user');
  if (user) (req as unknown as { user: { id: string } }).user = { id: user };
  next();
});
mountComicOwnerRoutes(mounted, {
  textRateLimit: (req, _res, next) => (textLimited.push(req.originalUrl), next()),
  adminRateLimit: (req, _res, next) => (adminLimited.push(req.originalUrl), next()),
  moderationRateLimit: (_req, _res, next) => next(),
  requireAdmin,
  requireModerator: requireAdmin,
  requireActive: (_req, _res, next) => next(),
  limits: { upload: [], publish: [], translateQuote: [] },
  comicRouter: Router().all('*', (_req, res) => res.json({ route: 'studio' })),
  // The lab router under test, with its own guard left permissive so this proves the MOUNT's guard.
  featureRouters: [createComicModelLabRouter({ lab: labSpy, requireAdmin: (_req, _res, next) => next() })]
});

let server: http.Server;
let base: string;
let mountedServer: http.Server;
let mountedBase: string;
const listen = async (a: express.Express) => {
  const s = a.listen(0);
  await new Promise<void>((r) => s.once('listening', () => r()));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};
beforeAll(async () => {
  png = await sharp({ create: { width: 120, height: 180, channels: 3, background: '#335577' } }).png().toBuffer();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  ({ s: server, url: base } = await listen(app));
  ({ s: mountedServer, url: mountedBase } = await listen(mounted));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => mountedServer.close(() => r()));
});
beforeEach(() => {
  __resetImageClientForTests();
  providerCalls.length = 0;
  store = createMemoryLabStore({ now: () => T0 });
  objects.clear();
  lab = makeLab();
  labSpy.mockClear();
});

const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; at?: string } = {}) => {
  const res = await fetch(`${init.at ?? base}${path}`, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, cache: res.headers.get('cache-control') };
};
const admin = { 'x-user': ADMIN, 'x-admin': '1' };
let n = 0;
const key = () => `route-click-${String(++n).padStart(8, '0')}`;

describe('admin-only', () => {
  it('signed out → 401, signed-in non-admin → 403, and the lab is never touched', async () => {
    for (const [method, path] of [
      ['GET', '/api/comic/models/lab'],
      ['POST', '/api/comic/models/lab/runs'],
      ['POST', '/api/comic/models/lab/runs/r1/watermark'],
      ['POST', '/api/comic/models/lab/blind/d4-sheet-1/vote'],
      ['GET', '/api/comic/models/lab/anything']
    ] as const) {
      const out = await call(path, { method, body: method === 'POST' ? { itemId: 'd1-nano-banana-2.1-4k', idempotencyKey: key(), ack: true, quotedUsd: 0.113 } : undefined });
      expect(out.status, `${method} ${path}`).toBe(401);
      expect(out.cache).toContain('no-store');
      const user = await call(path, { method, headers: { 'x-user': 'u-not-admin' }, body: method === 'POST' ? {} : undefined });
      expect(user, `${method} ${path}`).toMatchObject({ status: 403, body: { error: { message: 'Admin access required' } } });
    }
    expect(labSpy).not.toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
  });

  it('behind the real mount: the mount’s requireAdmin and admin limiter guard the prefix; the text limiter never counts it', async () => {
    adminLimited.length = 0;
    textLimited.length = 0;
    expect((await call('/api/comic/models/lab', { at: mountedBase, headers: { 'x-user': 'u-not-admin' } })).status).toBe(403);
    expect(labSpy).not.toHaveBeenCalled();
    const ok = await call('/api/comic/models/lab', { at: mountedBase, headers: admin });
    expect(ok.status).toBe(200);
    expect(adminLimited).toEqual(['/api/comic/models/lab', '/api/comic/models/lab']);
    expect(textLimited).toEqual([]);
  });

  it('answers only its own paths: other /api/comic paths fall through; unknown lab paths answer 404 here', async () => {
    expect(await call('/api/comic/models/status', { headers: admin })).toMatchObject({ status: 418, body: { route: 'fallthrough' } });
    expect(await call('/api/comic/models/labs', { headers: admin })).toMatchObject({ status: 418 });
    expect(await call(`/api/comic${MODEL_LAB_BASE}/nope`, { headers: admin })).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    expect(await call(`/api/comic${MODEL_LAB_BASE}`, { method: 'DELETE', headers: admin })).toMatchObject({ status: 404 });
  });

  it('keeps the exported router (mounted by comicMounts.ts)', () => {
    expect(typeof comicModelLabRouter).toBe('function');
  });
});

describe('running checks over HTTP', () => {
  it('overview → confirm → one call; no ack → 400 with no call; a repeat of the same click → the stored result', async () => {
    const o = await call('/api/comic/models/lab', { headers: admin });
    expect(o.status).toBe(200);
    expect(o.cache).toBe('private, no-store');
    const overview = o.body as LabOverview;
    expect(overview.checks.map((c) => c.id)).toEqual(['D1', 'D2', 'D3', 'D4']);
    const d1 = overview.checks[0].items[0];
    expect(d1.quote!.usd).toBe(0.113);

    const noAck = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: d1.id, idempotencyKey: key(), quotedUsd: 0.113 } });
    expect(noAck).toMatchObject({ status: 400, body: { error: { code: 'ACK_REQUIRED' } } });
    expect(noAck.body.error.message).toMatch(/Nothing was charged/);
    expect(providerCalls).toEqual([]);

    const k = key();
    const first = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: d1.id, idempotencyKey: k, ack: true, quotedUsd: d1.quote!.usd } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ replayed: false, run: { status: 'ok', checkId: 'D1', facts: { width: 120, height: 180, providerModelVersion: 'google/gemini-nano-banana-2.1-v1' } } });
    const again = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: d1.id, idempotencyKey: k, ack: true, quotedUsd: d1.quote!.usd } });
    expect(again.body).toMatchObject({ replayed: true, run: { id: first.body.run.id } });
    expect(providerCalls).toEqual(['POST /images']);
    expect(store.imageCalls).toHaveLength(1);
    expect(JSON.stringify([first.body, again.body])).not.toContain('sk-or-platform-test');
  });

  it('cap reached → 409 with the numbers, before any call', async () => {
    await store.reserve({ key: key(), adminId: ADMIN, checkId: 'D2', itemId: 'd2-gpt-image-2.5-flare', modelId: 'gpt-image-2.5-flare', providerModel: null, kind: 'page', res: '1K', aspect: '2:3', refs: 4, quotedUsd: 1.99, capUsd: 2 });
    const r = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: 'd4-seedream-5-0-flash-sheet-1', idempotencyKey: key(), ack: true, quotedUsd: 0.018 } });
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'LAB_CAP_REACHED', details: { spentUsd: 1.99, capUsd: 2, quoteUsd: 0.018 } } } });
    expect(providerCalls).toEqual([]);
  });

  it('blind pair over HTTP: no names before the vote, revealed after it', async () => {
    for (const item of labItems().filter((i) => i.pair?.id === 'd4-sheet-2')) {
      const quote = item.research!.baseUsd;
      const r = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: item.id, idempotencyKey: key(), ack: true, quotedUsd: quote } });
      expect(r.status).toBe(200);
      expect(r.body.run).not.toHaveProperty('imageUrl');
    }
    const o = (await call('/api/comic/models/lab', { headers: admin })).body as LabOverview;
    const pair = o.blind.find((p) => p.id === 'd4-sheet-2')!;
    expect(pair.state).toBe('ready');
    expect(JSON.stringify(pair)).not.toMatch(/seedream|qwen|Seedream|Qwen/);
    expect(pair.seen).toMatch(/^[0-9a-f]{24}$/);
    // A vote without the tag of the drawings it was cast on records nothing.
    expect(await call('/api/comic/models/lab/blind/d4-sheet-2/vote', { method: 'POST', headers: admin, body: { pick: 'tie' } })).toMatchObject({ status: 409, body: { error: { code: 'PAIR_CHANGED' } } });
    const voted = await call('/api/comic/models/lab/blind/d4-sheet-2/vote', { method: 'POST', headers: admin, body: { pick: 'tie', seen: pair.seen } });
    expect(voted.status).toBe(200);
    expect([voted.body.a.run.model.nickname, voted.body.b.run.model.nickname].sort()).toEqual(['Qwen 2.1 Turbo', 'Seedream 5 Flash']);
    expect(await call('/api/comic/models/lab/blind/d4-sheet-2/vote', { method: 'POST', headers: admin, body: { pick: 'A', seen: pair.seen } })).toMatchObject({ status: 409, body: { error: { code: 'ALREADY_VOTED' } } });
    expect(await call('/api/comic/models/lab/blind/NOT_A_PAIR!/vote', { method: 'POST', headers: admin, body: { pick: 'A' } })).toMatchObject({ status: 404 });
  });

  it('watermark checkbox on a D3 result', async () => {
    const r = await call('/api/comic/models/lab/runs', { method: 'POST', headers: admin, body: { itemId: 'd3-seedream-5-pro-2k', idempotencyKey: key(), ack: true, quotedUsd: 0.102 } });
    const w = await call(`/api/comic/models/lab/runs/${r.body.run.id}/watermark`, { method: 'POST', headers: admin, body: { visible: false } });
    expect(w).toMatchObject({ status: 200, body: { facts: { watermark: { visible: false, by: ADMIN } } } });
  });
});
