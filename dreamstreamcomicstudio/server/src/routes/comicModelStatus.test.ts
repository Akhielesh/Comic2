// @vitest-environment node
// GET /api/comic/models/status — auth'd, cheap, cached: ModelHealth[] for registry ids, routes limited to the
// caller's keys; /status/admin is admin-only and lists every model + this container's breaker events.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_MODELS, getImageModel, pickableImageModels } from '../../../shared/comic/models.js';
import type { ModelHealth } from '../../../shared/comic/modelHealth.js';
import { fakeModelHealth } from '../comic/models/health.fakes.js';
import type { StudioKeys } from '../comic/types.js';
import { MODEL_STATUS_PATHS, createComicModelStatusRouter, specsForIds, type ProviderStatusReport } from './comicModelStatus.js';

const T0 = 1_760_000_000_000;
const NB21 = getImageModel('nano-banana-2.1')!;
const OR_ID = NB21.routes.openrouter!;

const health = fakeModelHealth({ now: T0 });
let keys: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };
const requireAdmin: RequestHandler = (req, res, next) => (req.header('x-admin') ? next() : res.status(403).json({ error: { message: 'Admin access required' } }));

const app = express();
app.use((req, _res, next) => {
  const user = req.header('x-user');
  if (user) (req as unknown as { user: { id: string } }).user = { id: user };
  next();
});
app.use('/api/comic', createComicModelStatusRouter({ health, keysFor: () => keys, requireAdmin }));
app.use((_req, res) => res.status(418).json({ route: 'fallthrough' }));

let server: http.Server;
let base: string;
beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  health.reset();
  keys = { openrouter: { key: 'sk-or-platform', byok: false } };
});

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as unknown, cache: res.headers.get('cache-control') };
};

describe('GET /api/comic/models/status', () => {
  it('answers only its own paths', () => {
    expect(MODEL_STATUS_PATHS).toEqual(['/models/status', '/models/status/admin']);
  });

  it('needs a signed-in user; unknown ids are dropped; no ids = the pickable models', async () => {
    expect((await get('/api/comic/models/status?ids=nano-banana-2.1')).status).toBe(401);
    const r = await get('/api/comic/models/status?ids=nano-banana-2.1,no-such-model,nano-banana-2.1', { 'x-user': 'u1' });
    expect(r.status).toBe(200);
    expect(r.cache).toContain('no-store');
    const list = r.body as ModelHealth[];
    expect(list.map((m) => m.modelId)).toEqual(['nano-banana-2.1']);
    const all = await get('/api/comic/models/status', { 'x-user': 'u1' });
    expect((all.body as ModelHealth[]).map((m) => m.modelId)).toEqual(pickableImageModels().map((m) => m.id));
    expect(specsForIds('  ,,')).toBeNull();
    expect(specsForIds(['a'])).toBeNull();
  });

  it('reports the caller-reachable routes with public + observed data, never a key', async () => {
    health.setPublic(OR_ID, [{ name: 'Google AI Studio', status: -1, uptime30m: 40, uptime1d: 92 }]);
    const r = await get('/api/comic/models/status?ids=nano-banana-2.1', { 'x-user': 'u1' });
    const [m] = r.body as ModelHealth[];
    expect(m.state).toBe('down');
    expect(m.routes.map((x) => x.route)).toEqual(['openrouter']); // no Gemini key → not a reachable route
    expect(m.routes[0]).toMatchObject({ state: 'down', source: 'openrouter', checkedAt: T0 });
    expect(JSON.stringify(r.body)).not.toMatch(/sk-or/);
    // With a Gemini key the model is "unknown" overall (best reachable route wins; unknown never blocks).
    keys = { ...keys, gemini: { key: 'AIza-platform', byok: false } };
    const both = await get('/api/comic/models/status?ids=nano-banana-2.1', { 'x-user': 'u1' });
    expect((both.body as ModelHealth[])[0].routes.map((x) => `${x.route}:${x.state}`)).toEqual(['openrouter:down', 'gemini:unknown']);
    expect((both.body as ModelHealth[])[0].state).toBe('unknown');
    // One public fetch served every read (cached).
    expect(health.fetches).toHaveLength(1);
    expect(health.fetches[0].headers).toEqual({});
  });

  it('/status/admin is admin-only and lists every registry model plus the breaker events since boot', async () => {
    expect((await get('/api/comic/models/status/admin', { 'x-user': 'u1' })).status).toBe(403);
    for (let i = 0; i < 3; i += 1) health.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
    const r = await get('/api/comic/models/status/admin', { 'x-user': 'u1', 'x-admin': '1' });
    expect(r.status).toBe(200);
    expect(r.cache).toContain('no-store');
    const report = r.body as ProviderStatusReport;
    expect(report.models.map((m) => m.modelId)).toEqual(IMAGE_MODELS.map((m) => m.id));
    expect(report.models.find((m) => m.modelId === 'nano-banana-2.1')?.routes.map((x) => x.route)).toEqual(['openrouter', 'gemini']);
    expect(report.breakerEvents).toEqual([{ at: T0, route: 'openrouter', model: OR_ID, event: 'opened', code: 'RATE_LIMIT', failures: 3 }]);
    expect(report.bootedAt).toBe(T0);
    expect(typeof report.now).toBe('number');
  });

  it('everything else falls through', async () => {
    expect((await get('/api/comic/models/catalog', { 'x-user': 'u1' })).status).toBe(418);
    expect((await get('/api/comic/models/status/extra', { 'x-user': 'u1' })).status).toBe(418);
  });
});
