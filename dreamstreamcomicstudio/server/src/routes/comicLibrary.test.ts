// @vitest-environment node
// Library HTTP surface (contract §14.1, assets.md §8): the public index is never captured by
// /api/comic/public/:id, serves only published rows with an ETag, survives a missing table; the
// admin console is admin-only, quotes without side effects, needs an explicit confirm to create
// a run, and steps it client-side.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router, type RequestHandler } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mountComicOwnerRoutes, mountComicPublicRoutes } from './comicMounts.js';
import { createLibraryAdminRouter, createLibraryPublicRouter } from '../comic/library/index.js';
import { testLibrary, type TestLibrary } from '../comic/library/testkit.js';

const pass: RequestHandler = (_req, _res, next) => next();
const ADMIN = '00000000-0000-4000-8000-000000000001';

let t: TestLibrary;
let server: http.Server;
let base = '';

beforeAll(async () => {
  const fakePublic = Router();
  fakePublic.get('/:id', (req, res) => res.status(404).json({ route: 'public-reader', id: req.params.id }));
  const app = express();
  app.use(express.json());
  // Deps are resolved per request so each test gets a fresh in-memory library.
  mountComicPublicRoutes(app, {
    systemRateLimit: pass,
    optionalAuth: pass,
    limits: { report: [] },
    comicPublicRouter: fakePublic,
    libraryPublicRouter: createLibraryPublicRouter(() => t.deps),
    reportRouter: Router()
  });
  app.use('/api', (req, res, next) => {
    const user = req.header('x-user');
    if (!user) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    (req as typeof req & { user?: { id: string } }).user = { id: user };
    next();
  });
  const requireAdmin: RequestHandler = (req, res, next) => (req.header('x-admin') ? next() : res.status(403).json({ error: { code: 'FORBIDDEN' } }));
  mountComicOwnerRoutes(app, {
    textRateLimit: pass,
    adminRateLimit: pass,
    moderationRateLimit: pass,
    requireAdmin,
    requireModerator: requireAdmin,
    limits: { upload: [], publish: [], translateQuote: [] },
    comicRouter: Router(),
    requireActive: pass,
    libraryAdminRouter: createLibraryAdminRouter(() => t.deps),
    storageAdminRouter: Router(),
    moderationRouter: Router(),
    featureRouters: [Router()]
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  t = testLibrary();
});

const admin = { 'content-type': 'application/json', 'x-user': ADMIN, 'x-admin': '1' };
const post = (path: string, body: unknown, headers: Record<string, string> = admin) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

describe('public index', () => {
  it('is served by the library router, never parsed as a comic id by /:id', async () => {
    const res = await fetch(`${base}/api/comic/public/library`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ manifestVersion: 1, generatedAt: 0, assets: [] });
    expect(body.route).toBeUndefined();
    expect(res.headers.get('cache-control')).toMatch(/max-age=300/);
    // The reader route still answers its own ids.
    expect((await (await fetch(`${base}/api/comic/public/abc`)).json()).route).toBe('public-reader');
  });

  it('serves published rows only, with an ETag and 304', async () => {
    const run = await (await post('/api/comic/admin/library/runs', { confirm: true, ids: ['style.test-one', 'style.test-two'] })).json();
    expect(run.run.counts.total).toBe(2);
    // One publishes, one is still pending: only the published one is public.
    const step = await (await post(`/api/comic/admin/library/runs/${run.run.id}/step`, { n: 1 })).json();
    expect(step.counts.published).toBe(1);
    // The admin router's deps here don't share the production cache invalidator: build a fresh router.
    const fresh = express();
    fresh.use('/lib', createLibraryPublicRouter(() => t.deps));
    const s2 = http.createServer(fresh);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}/lib`;
    const res = await fetch(url);
    const body = await res.json();
    expect(body.assets.map((a: { id: string }) => a.id)).toEqual(['style.test-one']);
    expect(JSON.stringify(body)).not.toMatch(/prompt|Test scene/);
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"\w+"$/);
    expect((await fetch(url, { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await fetch(`${url}/anything`)).status).toBe(404);
    await new Promise<void>((r) => s2.close(() => r()));
  });

  it('a missing table is an empty 200, never an error', async () => {
    t.repo.missing = true;
    const fresh = express();
    fresh.use('/lib', createLibraryPublicRouter(() => t.deps));
    const s2 = http.createServer(fresh);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/lib`);
    expect(res.status).toBe(200);
    expect((await res.json()).assets).toEqual([]);
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
    await new Promise<void>((r) => s2.close(() => r()));
  });
});

describe('admin console API', () => {
  it('is admin-only (401 signed out, 403 non-admin)', async () => {
    expect((await fetch(`${base}/api/comic/admin/library/manifest`)).status).toBe(401);
    expect((await fetch(`${base}/api/comic/admin/library/manifest`, { headers: { 'x-user': ADMIN } })).status).toBe(403);
    const ok = await fetch(`${base}/api/comic/admin/library/manifest`, { headers: admin });
    expect(ok.status).toBe(200);
    const m = await ok.json();
    expect(m.entries).toHaveLength(5);
    expect(m.platformKey).toBe(true);
    expect(m.tableReady).toBe(true);
  });

  it('quote is a dry run: no images, no rows, no runs', async () => {
    const res = await post('/api/comic/admin/library/quote', { budgetUsd: 3 });
    expect(res.status).toBe(200);
    expect((await res.json()).quote.images).toBe(5);
    expect(t.images.calls).toHaveLength(0);
    expect(t.repo.assets.size).toBe(0);
    expect(t.repo.runs.size).toBe(0);
  });

  it('creating a run needs an explicit confirm; bad input is a 400', async () => {
    expect((await post('/api/comic/admin/library/runs', {})).status).toBe(400);
    expect((await post('/api/comic/admin/library/runs', { confirm: true, maxRetries: 7 })).status).toBe(400);
    expect((await post('/api/comic/admin/library/runs', { confirm: true, ids: ['nope.x'] })).status).toBe(400);
    expect(t.repo.runs.size).toBe(0);
    const created = await post('/api/comic/admin/library/runs', { confirm: true });
    expect(created.status).toBe(201);
    expect((await post('/api/comic/admin/library/runs', { confirm: true })).status).toBe(409);
    expect(t.images.calls).toHaveLength(0);
  });

  it('steps a run to completion (n ≤ 3 per call) and validates n and ids', async () => {
    const { run } = await (await post('/api/comic/admin/library/runs', { confirm: true })).json();
    expect((await post(`/api/comic/admin/library/runs/${run.id}/step`, { n: 9 })).status).toBe(400);
    expect((await post('/api/comic/admin/library/runs/not-a-uuid/step', { n: 1 })).status).toBe(404);
    const a = await (await post(`/api/comic/admin/library/runs/${run.id}/step`, { n: 3 })).json();
    expect(a.counts.done).toBe(3);
    expect(t.images.calls).toHaveLength(3);
    const b = await (await post(`/api/comic/admin/library/runs/${run.id}/step`, { n: 3 })).json();
    expect(b.status).toBe('completed');
    const view = await (await fetch(`${base}/api/comic/admin/library/runs/${run.id}`, { headers: admin })).json();
    expect(view.counts.published).toBe(5);
    const runs = await (await fetch(`${base}/api/comic/admin/library/runs?limit=5`, { headers: admin })).json();
    expect(runs.runs[0]).toMatchObject({ id: run.id, status: 'completed', total: 5 });
  });

  it('no platform key → 503 with an honest message', async () => {
    t = testLibrary({ keys: null });
    const res = await post('/api/comic/admin/library/runs', { confirm: true });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toMatch(/platform image key/);
  });
});
