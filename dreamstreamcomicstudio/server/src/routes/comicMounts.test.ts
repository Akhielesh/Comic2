// Mount order (contract §14.1): the new public routes are never captured by /public/:id,
// owner routers sit behind requireAuth, feature routers answer only their own paths, and
// admin/moderation consoles sit behind their role checks.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router, type RequestHandler } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mountComicOwnerRoutes, mountComicPublicRoutes, onlyWrites } from './comicMounts.js';

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

const app = express();
app.use(express.json());
mountComicPublicRoutes(app, { systemRateLimit: pass, optionalAuth: pass, limits: { report: [report.mw] }, comicPublicRouter: fakePublic });
app.use('/api', (req, res, next) => (req.header('x-user') ? next() : res.status(401).json({ error: { code: 'UNAUTHORIZED' } })));
mountComicOwnerRoutes(app, {
  textRateLimit: text.mw,
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
  it('/api/comic/public/library is the library router, not /public/:id', async () => {
    const r = await call('/api/comic/public/library');
    expect(r.status).toBe(501);
    expect(r.body).toEqual({ error: { message: expect.any(String), code: 'NOT_AVAILABLE' } });
  });

  it('/api/comic/public/s/x/report is the report router (rate limited), not /public/:id', async () => {
    const r = await call('/api/comic/public/s/x/report', { method: 'POST', body: { reason: 'spam' } });
    expect(r.status).toBe(501);
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
    expect((await call('/api/comic/projects/p1/publication', { headers: user })).status).toBe(501);
    expect((await call('/api/comic/projects/p1/publication/regenerate', { method: 'POST', headers: user })).status).toBe(501);
    expect((await call('/api/comic/projects/p1/refs', { method: 'POST', headers: user })).status).toBe(501);
    expect((await call('/api/comic/projects/p1/translation-quote?langs=hi', { headers: user })).status).toBe(501);
    expect((await call('/api/comic/projects/p1/safety-review', { method: 'POST', headers: user })).status).toBe(501);
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
    expect((await call('/api/comic/admin/library/manifest', { headers: { ...user, 'x-admin': '1' } })).status).toBe(501);
    expect((await call('/api/comic/admin/storage/migrate-refs', { method: 'POST', headers: { ...user, 'x-admin': '1' }, body: { dryRun: true } })).status).toBe(501);
    expect((await call('/api/moderation/comic-cases', { headers: user })).status).toBe(403);
    expect((await call('/api/moderation/comic-cases', { headers: { ...user, 'x-moderator': '1' } })).status).toBe(501);
    expect((await call('/api/moderation/projects/queue', { headers: user })).body).toEqual({ route: 'moderation' });
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
