// @vitest-environment node
// GET /api/comic/models/{catalog,trends,:id} (models.md §4.3–§4.6): signed-in only, owner-scoped fit, honest
// errors, per-user answers never cached publicly. The catalog runs on fetch fakes from the 17:51Z JSON.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveStudioCaps } from '../../../shared/comic/capabilities.js';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic.js';
import { logger } from '../lib/logger.js';
import { fakeDocStore } from '../comic/orchestrator.fakes.js';
import { FAKE_BASE, FIXTURE_NOW, fakeOpenRouterFetch } from '../comic/models/__fixtures__/catalogFakes.js';
import { createModelCatalog, type ModelCatalog } from '../comic/models/catalog.js';
import { createQualitySource } from '../comic/models/quality.js';
import { MODELS_PATHS, NOT_BUILT, comicModelsRouter, createComicModelsRouter } from './comicModels.js';

const PROJECT = 'models-route-test-1';
const store = fakeDocStore();
store.docs.set(PROJECT, { userId: 'owner-1', doc: makeLakeComic((d) => (d.id = PROJECT)) });

const fetch = fakeOpenRouterFetch();
const catalog = createModelCatalog({ fetch, baseUrl: FAKE_BASE, now: () => FIXTURE_NOW, quality: createQualitySource({ fetch: null }) });
let current: ModelCatalog = catalog;
const capsCalls: { byok: boolean }[] = [];

const app = express();
app.use((req, _res, next) => {
  const user = req.header('x-user');
  if (user) (req as unknown as { user: { id: string } }).user = { id: user };
  next();
});
app.use(
  '/api/comic',
  createComicModelsRouter({
    catalog: () => current,
    store,
    keysFor: () => ({ openrouter: { key: 'k', byok: true } }),
    capsFor: async (_req, opts) => {
      capsCalls.push(opts);
      return resolveStudioCaps({ planId: 'free', byok: opts.byok, isAdmin: false });
    }
  })
);
app.use((req, res) => res.status(418).json({ route: 'fallthrough', path: req.path }));

let server: http.Server;
let base: string;
beforeAll(async () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = async (path: string, user?: string) => {
  const res = await globalThis.fetch(`${base}${path}`, { headers: user ? { 'x-user': user } : {} });
  return { status: res.status, body: (await res.json()) as any, cache: res.headers.get('cache-control') };
};

describe('model catalog routes', () => {
  it('keeps its export names and answers only its own paths', async () => {
    expect(NOT_BUILT).toEqual({ error: 'not built yet' });
    expect(typeof comicModelsRouter).toBe('function');
    expect(MODELS_PATHS).toEqual(['/models/catalog', '/models/trends', '/models/:id']);
    // The static list, status and the lab belong to other routers.
    expect((await get('/api/comic/models', 'owner-1')).body).toMatchObject({ route: 'fallthrough' });
    expect((await get('/api/comic/models/status', 'owner-1')).body).toMatchObject({ route: 'fallthrough' });
    expect((await get('/api/comic/models/lab', 'owner-1')).body).toMatchObject({ route: 'fallthrough' });
  });

  it('unauthenticated calls get 401 and cause no catalog work', async () => {
    const before = fetch.calls.length;
    for (const path of ['/api/comic/models/catalog', '/api/comic/models/catalog?projectId=' + PROJECT, '/api/comic/models/trends?range=30d', '/api/comic/models/nano-banana-2.1']) {
      const r = await get(path);
      expect(r.status, path).toBe(401);
      expect(r.body.error.message).toBe('Sign in to use the comic studio.');
    }
    expect(fetch.calls.length).toBe(before);
  });

  it('GET /models/catalog: every registry model with live prices, sources and times; private, no-store; no fit without a project', async () => {
    const r = await get('/api/comic/models/catalog', 'owner-1');
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, no-store');
    expect(Array.isArray(r.body)).toBe(true);
    const nb = r.body.find((x: { id: string }) => x.id === 'nano-banana-2.1');
    expect(nb.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    expect(nb.endpoints[0].uptime1d).toBeCloseTo(97.72, 2);
    expect(nb.fetchedAt.catalog).toBe('2026-10-22T17:51:00.000Z');
    expect(nb.fit).toBeUndefined();
    expect(capsCalls).toEqual([]);
  });

  it("GET /models/catalog?projectId=: the owner gets fit against their comic and caps (BYOK from the request's keys)", async () => {
    const r = await get(`/api/comic/models/catalog?projectId=${PROJECT}`, 'owner-1');
    expect(r.status).toBe(200);
    const by = (id: string) => r.body.find((x: { id: string }) => x.id === id);
    expect(by('nano-banana-2.1')).toMatchObject({ current: true });
    expect(by('nano-banana-2.1').fit.filter((f: { severity: string }) => f.severity === 'block')).toEqual([]);
    expect(by('nano-banana-pro').fit.filter((f: { severity: string }) => f.severity === 'block')).toEqual([]); // own key → model choice
    expect(by('gpt-image-2.5').fit).toContainEqual({ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" });
    expect(capsCalls.at(-1)).toEqual({ byok: true });
  });

  it('someone else\'s or a missing comic is the same 404; a malformed id is a 404 too', async () => {
    const other = await get(`/api/comic/models/catalog?projectId=${PROJECT}`, 'someone-else');
    const missing = await get('/api/comic/models/catalog?projectId=no-such-comic', 'someone-else');
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect((await get('/api/comic/models/catalog?projectId=bad%20id!', 'owner-1')).status).toBe(404);
    expect((await get(`/api/comic/models/nano-banana-2.1?projectId=${PROJECT}`, 'someone-else')).status).toBe(404);
  });

  it('GET /models/trends: 30d by default, 90d on request, anything else is a 400', async () => {
    const d = await get('/api/comic/models/trends', 'owner-1');
    expect(d.status).toBe(200);
    expect(d.body.range).toBe('30d');
    expect(d.body.t7).toEqual({ available: false, copy: 'Not enough data yet', sinceDays: 90 });
    expect((await get('/api/comic/models/trends?range=90d', 'owner-1')).body.range).toBe('90d');
    const bad = await get('/api/comic/models/trends?range=7y', 'owner-1');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
  });

  it('GET /models/:id: the detail for a registry or (encoded) provider id; unknown ids are a 404', async () => {
    const d = await get('/api/comic/models/nano-banana-pro', 'owner-1');
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ id: 'nano-banana-pro', facts: { factsAsOf: '2026-10-22' } });
    expect(d.body.fit).toBeUndefined();
    const withFit = await get(`/api/comic/models/gpt-image-2.5?projectId=${PROJECT}`, 'owner-1');
    expect(withFit.body.fit).toContainEqual({ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" });
    expect((await get(`/api/comic/models/${encodeURIComponent('google/gemini-nano-banana-2.1')}`, 'owner-1')).body.id).toBe('nano-banana-2.1');
    const unknown = await get('/api/comic/models/not-a-model', 'owner-1');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe("We don't know that model.");
  });

  it('a catalog failure is an honest 500 without internals', async () => {
    current = { rows: async () => Promise.reject(new Error('secret internals')), model: async () => null, trends: async () => Promise.reject(new Error('x')), priceSources: async () => ({ rows: [] }) };
    try {
      const r = await get('/api/comic/models/catalog', 'owner-1');
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain('secret internals');
      expect(r.body.error.code).toBe('INTERNAL');
    } finally {
      current = catalog;
    }
  });
});
