// Mount order (contract §14.1): the new public routes are never captured by /public/:id,
// owner routers sit behind requireAuth, feature routers answer only their own paths, and
// admin/moderation consoles sit behind their role checks. The DEFAULT (real, wave-1) routers are
// mounted here, so each assertion is that router's real contract in a server without storage keys
// (P2-AMEND rewrote the wave-0 501 expectations). Early 401/429 refusals leave one structured line.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router, type RequestHandler } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from '../lib/logger.js';
import { REFUSAL_LOG_PER_MINUTE, comicRefusalObserver, comicRoutePattern, mountComicOwnerRoutes, mountComicPublicRoutes, onlyWrites, refusalIpHash } from './comicMounts.js';

const pass: RequestHandler = (_req, _res, next) => next();
const counter = () => {
  const hits: string[] = [];
  const mw: RequestHandler = (req, _res, next) => {
    hits.push(`${req.method} ${req.originalUrl}`);
    next();
  };
  return { hits, mw };
};

const text = counter();
const upload = counter();
const publishLimit = counter();
const report = counter();
const quote = counter();
const active = counter();

const fakePublic = Router();
fakePublic.get('/:id', (req, res) => res.json({ route: 'public-reader', id: req.params.id }));
const fakeStudio = Router();
fakeStudio.all('*', (req, res) => res.json({ route: 'studio', path: req.path }));

const role =
  (header: string): RequestHandler =>
  (req, res, next) =>
    req.header(header) ? next() : res.status(403).json({ error: { code: 'FORBIDDEN' } });
/** A limiter that refuses when the request carries x-limit (stands in for the text-tier 429). */
const textLimit: RequestHandler = (req, res, next) => (req.header('x-limit') ? void res.status(429).json({ error: { code: 'LIMIT' } }) : text.mw(req, res, next));

const app = express();
app.use(express.json());
mountComicPublicRoutes(app, { systemRateLimit: pass, optionalAuth: pass, limits: { report: [report.mw] }, comicPublicRouter: fakePublic });
app.use('/api', (req, res, next) => (req.header('x-user') ? next() : res.status(401).json({ error: { code: 'UNAUTHORIZED' } })));
mountComicOwnerRoutes(app, {
  textRateLimit: textLimit,
  adminRateLimit: pass,
  moderationRateLimit: pass,
  requireAdmin: role('x-admin'),
  requireModerator: role('x-moderator'),
  requireActive: active.mw,
  limits: { upload: [upload.mw], publish: [publishLimit.mw], translateQuote: [quote.mw] },
  comicRouter: fakeStudio
});
app.use('/api/moderation', (_req, res) => res.json({ route: 'moderation' }));

let server: http.Server;
let base: string;
beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const user = { 'x-user': 'u1' };

describe('public mounts', () => {
  it('/api/comic/public/library is the library router (empty index until the owner builds), not /public/:id', async () => {
    const r = await call('/api/comic/public/library');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ manifestVersion: 1, generatedAt: 0, assets: [] });
  });

  it('/api/comic/public/s/x/report is the report router (rate limited, always 202), not /public/:id', async () => {
    const r = await call('/api/comic/public/s/x/report', { method: 'POST', body: { reason: 'spam' } });
    expect(r.status).toBe(202);
    expect(r.body).not.toHaveProperty('route');
    expect(report.hits).toContain('POST /api/comic/public/s/x/report');
  });

  it('the reader still serves /public/:id without a session', async () => {
    expect(await call('/api/comic/public/abc-123')).toEqual({ status: 200, body: { route: 'public-reader', id: 'abc-123' } });
  });
});

describe('owner mounts', () => {
  it('owner routers sit behind requireAuth', async () => {
    for (const path of ['/api/comic/projects/p1/publication', '/api/comic/projects/p1/refs', '/api/comic/projects/p1/translation-quote', '/api/comic/admin/library/manifest']) {
      expect((await call(path)).status).toBe(401);
    }
  });

  it('feature routers answer only their own paths; everything else reaches the studio once', async () => {
    // The real feature routers own these paths: they answer (401 — this fake auth sets no req.user) and
    // never fall through to the studio router.
    for (const [method, path] of [
      ['GET', '/api/comic/projects/p1/publication'],
      ['POST', '/api/comic/projects/p1/publication/regenerate'],
      ['POST', '/api/comic/projects/p1/refs'],
      ['GET', '/api/comic/projects/p1/translation-quote?langs=hi'],
      ['POST', '/api/comic/projects/p1/safety-review']
    ] as const) {
      const r = await call(path, { method, headers: user });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body, `${method} ${path}`).not.toHaveProperty('route');
    }
    text.hits.length = 0;
    const studio = await call('/api/comic/projects/p1/stream', { method: 'POST', headers: user, body: {} });
    expect(studio.body).toEqual({ route: 'studio', path: '/projects/p1/stream' });
    expect(text.hits).toEqual(['POST /api/comic/projects/p1/stream']); // counted exactly once
    expect((await call('/api/comic/projects/p1/refsx', { headers: user })).body).toMatchObject({ route: 'studio' });
  });

  it('applies the per-route limits to their exact paths only', async () => {
    upload.hits.length = 0;
    publishLimit.hits.length = 0;
    quote.hits.length = 0;
    active.hits.length = 0;
    await call('/api/comic/projects/p1/refs', { method: 'POST', headers: user });
    await call('/api/comic/projects/p1/publication', { headers: user }); // a read: no publish count
    await call('/api/comic/projects/p1/publication', { method: 'POST', headers: user, body: { visibility: 'unlisted' } });
    await call('/api/comic/projects/p1/translation-quote', { headers: user });
    await call('/api/comic/projects/p1', { headers: user });
    expect(upload.hits).toEqual(['POST /api/comic/projects/p1/refs']);
    expect(publishLimit.hits).toEqual(['POST /api/comic/projects/p1/publication']);
    expect(quote.hits).toEqual(['GET /api/comic/projects/p1/translation-quote']);
    expect(active.hits).toHaveLength(3); // refs + both publication calls
  });

  it('admin and moderation consoles need their roles and mount before /api/comic and /api/moderation', async () => {
    expect((await call('/api/comic/admin/library/manifest', { headers: user })).status).toBe(403);
    // With the role, the real consoles answer — honestly unavailable without storage (503), never the studio.
    const lib = await call('/api/comic/admin/library/runs', { headers: { ...user, 'x-admin': '1' } });
    expect(lib).toEqual({ status: 503, body: { error: { code: 'NOT_AVAILABLE', message: expect.any(String) } } });
    const storage = await call('/api/comic/admin/storage/migrate-refs', { method: 'POST', headers: { ...user, 'x-admin': '1' }, body: { dryRun: true } });
    expect(storage.status).toBe(503);
    expect(storage.body).not.toHaveProperty('route');
    expect((await call('/api/moderation/comic-cases', { headers: user })).status).toBe(403);
    const cases = await call('/api/moderation/comic-cases', { headers: { ...user, 'x-moderator': '1' } });
    expect(cases.status).toBe(401); // the real moderator router re-checks req.user (this fake auth sets none)
    expect(cases.body).not.toHaveProperty('route');
    expect((await call('/api/moderation/projects/queue', { headers: user })).body).toEqual({ route: 'moderation' });
  });
});

describe('early refusals (requireAuth 401, rate-limit 429) leave one structured line', () => {
  afterEach(() => vi.restoreAllMocks());
  const refusals = (spy: ReturnType<typeof vi.spyOn>) =>
    (spy.mock.calls as [string, Record<string, unknown>][]).filter(([event]) => event === 'comic_edge_refused').map(([, fields]) => fields);

  it('logs the route pattern, status and an ip hash for an anonymous 401 — never the raw URL, query or body', async () => {
    const spy = vi.spyOn(logger, 'info');
    await call('/api/comic/projects/proj_9f8e7d/publication?token=SECRET', { method: 'POST', body: { note: 'PRIVATE' } });
    await vi.waitFor(() => expect(refusals(spy)).toHaveLength(1));
    const [line] = refusals(spy);
    expect(line).toMatchObject({ method: 'POST', route: '/api/comic/projects/:id/publication', status: 401, userId: null, ipHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(JSON.stringify(line)).not.toMatch(/SECRET|PRIVATE|proj_9f8e7d|127\.0\.0\.1/);
  });

  it('logs a text-tier 429 on the studio path, and nothing for successful or other refused requests', async () => {
    const spy = vi.spyOn(logger, 'info');
    const limited = await call('/api/comic/projects/p1/stream', { method: 'POST', headers: { ...user, 'x-limit': '1' }, body: {} });
    expect(limited.status).toBe(429);
    await vi.waitFor(() => expect(refusals(spy)).toHaveLength(1));
    expect(refusals(spy)[0]).toMatchObject({ route: '/api/comic/projects/:id/stream', status: 429 });
    await call('/api/comic/projects/p1/stream', { method: 'POST', headers: user, body: {} }); // 200
    await call('/api/comic/admin/library/manifest', { headers: user }); // 403 (role) — logged by its owner, not here
    await new Promise((r) => setTimeout(r, 20));
    expect(refusals(spy)).toHaveLength(1);
  });

  it('a refusal flood is capped per minute and summarized once, without timers', () => {
    const spy = vi.spyOn(logger, 'info');
    let clock = 1_000_000;
    const observe = comicRefusalObserver(() => clock);
    const refuse = (status: number) => {
      let onFinish: () => void = () => undefined;
      const res = { statusCode: status, locals: {}, once: (_e: string, fn: () => void) => (onFinish = fn) };
      observe({ method: 'POST', originalUrl: '/api/comic/projects/p1/stream', ip: '9.9.9.9' } as never, res as never, () => undefined);
      onFinish();
    };
    for (let i = 0; i < REFUSAL_LOG_PER_MINUTE + 5; i += 1) refuse(429);
    refuse(200); // never counted
    expect(refusals(spy)).toHaveLength(REFUSAL_LOG_PER_MINUTE);
    clock += 60_000;
    refuse(401);
    const summary = (spy.mock.calls as [string, Record<string, unknown>][]).filter(([e]) => e === 'comic_edge_refused_suppressed');
    expect(summary).toEqual([['comic_edge_refused_suppressed', { count: 5, windowStart: 1_000_000 }]]);
    expect(refusals(spy)).toHaveLength(REFUSAL_LOG_PER_MINUTE + 1);
  });

  it('comicRoutePattern keeps route words and masks ids/slugs; the observer never answers', () => {
    expect(comicRoutePattern('/api/comic/public/s/Ab3dE5fG7hJ9kL1mN/report?x=1')).toBe('/api/comic/public/s/:id/report');
    expect(comicRoutePattern('/api/comic/projects/0b9c-uuid/refs/u%2Fx%2Fref.webp')).toBe('/api/comic/projects/:id/refs/:id');
    expect(comicRoutePattern('/api/moderation/comic-cases/c_1/appeal')).toBe('/api/moderation/comic-cases/:id/appeal');
    expect(refusalIpHash('1.2.3.4', 0)).toBe(refusalIpHash('1.2.3.4', 1000));
    expect(refusalIpHash('1.2.3.4', 0)).not.toBe(refusalIpHash('1.2.3.5', 0));
    const next = vi.fn();
    const res = { once: vi.fn(), statusCode: 200, locals: {} };
    comicRefusalObserver()({ method: 'GET', originalUrl: '/api/comic/x' } as never, res as never, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.once).toHaveBeenCalledWith('finish', expect.any(Function));
  });
});

describe('onlyWrites', () => {
  it('skips reads and chains every limiter for writes, stopping at a rejection', async () => {
    const seen: string[] = [];
    const a: RequestHandler = (_req, _res, next) => (seen.push('a'), next());
    const deny: RequestHandler = (_req, res) => void res.status(429).end();
    const next = vi.fn();
    onlyWrites([a])({ method: 'GET' } as never, {} as never, next);
    expect(seen).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
    onlyWrites([a, a])({ method: 'POST' } as never, {} as never, next);
    expect(seen).toEqual(['a', 'a']);
    expect(next).toHaveBeenCalledTimes(2);
    const status = vi.fn(() => ({ end: vi.fn() }));
    onlyWrites([a, deny, a])({ method: 'DELETE' } as never, { status } as never, next);
    expect(status).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
