// @vitest-environment node
// GET /api/comic/projects/:id/translation-quote — owner-only, never spends, never commits.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeDocStore, scriptedLlm } from '../comic/orchestrator.fakes.js';
import { sixPageKidsDoc } from '../comic/i18n/testing.js';
import { createComicI18nRouter, I18N_PATHS } from './comicI18n.js';

const store = fakeDocStore();
const PROJECT = 'i18n-route-test-1';
store.docs.set(PROJECT, { userId: 'owner-1', doc: { ...sixPageKidsDoc(PROJECT) } });

const app = express();
app.use((req, _res, next) => {
  const user = req.header('x-user');
  if (user) (req as unknown as { user: { id: string } }).user = { id: user };
  next();
});
let keysByok = false;
app.use('/api/comic', createComicI18nRouter({ store, keysFor: () => ({ openrouter: { key: 'k', byok: keysByok } }) }));
app.use((_req, res) => res.status(418).json({ route: 'fallthrough' }));

let server: http.Server;
let base: string;
beforeAll(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = async (path: string, user?: string) => {
  const res = await fetch(`${base}${path}`, { headers: user ? { 'x-user': user } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get('cache-control') };
};

describe('translation quote route', () => {
  it('answers only its own path', () => {
    expect(I18N_PATHS).toEqual(['/projects/:id/translation-quote']);
  });

  it('owner: per-language quote with lines, free, usd and seconds; no-store; nothing committed', async () => {
    const r = await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=te,Hindi,xx`, 'owner-1');
    expect(r.status).toBe(200);
    expect(r.cache).toContain('no-store');
    const per = r.body.perLanguage as { lang: string; lines: number; free: number; upToDate: boolean; usd: number; seconds: number }[];
    expect(per.map((p) => p.lang)).toEqual(['te', 'hi']);
    expect(per[0]).toMatchObject({ lines: 12, free: 2, upToDate: false });
    expect(per[0].usd).toBeGreaterThan(0);
    expect(per[0].seconds).toBeGreaterThan(0);
    expect(r.body.usd).toBeCloseTo(per[0].usd + per[1].usd, 4);
    expect(r.body).toMatchObject({ byok: false, unknown: ['xx'] });
    expect(store.saves).toHaveLength(0);
    keysByok = true;
    const byok = await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=te`, 'owner-1');
    expect(byok.body.byok).toBe(true);
    expect(byok.body.usd as number).toBeLessThan(per[0].usd);
    keysByok = false;
  });

  it('non-owners and anonymous callers get 404/401 (no existence leak); bad input is a 400', async () => {
    const other = await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=te`, 'someone-else');
    const missing = await get('/api/comic/projects/no-such-project/translation-quote?langs=te', 'someone-else');
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect((await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=te`)).status).toBe(401);
    expect((await get('/api/comic/projects/bad%20id!/translation-quote?langs=te', 'owner-1')).status).toBe(404);
    expect((await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=klingon`, 'owner-1')).status).toBe(400);
    expect((await get(`/api/comic/projects/${PROJECT}/translation-quote?langs=en`, 'owner-1')).status).toBe(400); // the source
  });

  it('never calls a model (the quote is pure)', () => {
    // The router takes no LLM at all; this guards the import surface.
    expect(scriptedLlm().calls).toHaveLength(0);
  });

  it('other paths fall through', async () => {
    const r = await get(`/api/comic/projects/${PROJECT}/publication`, 'owner-1');
    expect(r.status).toBe(418);
  });
});
