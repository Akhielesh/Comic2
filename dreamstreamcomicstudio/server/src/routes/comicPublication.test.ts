// @vitest-environment node
// Owner publication routes: a share-link holder (no JWT) or another user can never mutate
// (sharing.md §11 #19/#25; addendum §1). Status codes and error shapes.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc.js';
import { fakeAssetStore, fakeDocStore, plannedDoc } from '../comic/orchestrator.fakes.js';
import { __resetSessionsForTests } from '../comic/session.js';
import { __resetPublishBudget, configurePublication } from '../comic/publication/publication.js';
import { createMemoryPublicationStore } from '../comic/publication/store.js';
import { createComicPublicationRouter } from './comicPublication.js';

const PID = '11111111-1111-4111-8111-111111111111';
let server: http.Server;
let base = '';
const docs = fakeDocStore();
const pubStore = createMemoryPublicationStore();

const drawnDoc = (): ComicDoc => {
  const doc = plannedDoc(PID);
  doc.pages = doc.pages.map((p) => ({ ...p, render: { status: 'ready', history: [], asset: { path: `u/owner/p/${PID}/img/p${p.n}.webp`, source: 'generated', at: 1, safety: { assessed: 'G', at: 1 } } } }));
  return doc;
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const user = req.header('x-test-user');
    if (user) req.user = { id: user } as never;
    if (req.header('x-test-restricted')) res.locals.moderationStatus = 'restricted';
    next();
  });
  app.use(
    '/api/comic',
    createComicPublicationRouter({
      store: docs,
      assets: fakeAssetStore(),
      capsDeps: { billingEnabled: false, isAdminFor: async () => false, accountCeilingFor: async () => 'PG-13' } as never
    })
  );
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configurePublication({
    store: pubStore,
    gate: (async (_c: unknown, _d: unknown, o: { pageIds: string[] }) => ({
      status: 'cleared',
      rating: 'PG',
      pages: Object.fromEntries(o.pageIds.map((id) => [id, { status: 'pass', reasons: [] }])),
      cover: null,
      text: { status: 'pass', reasons: [] },
      checkedHash: '',
      costUsd: 0
    })) as never,
    renderOg: async () => ({ jpeg: Buffer.from('x'), w: 1200, h: 630, themeColor: '#000000' }),
    publicUrl: (p) => `https://cdn.test/${p}`
  });
});
afterAll(() => server?.close());
beforeEach(() => {
  __resetSessionsForTests();
  __resetPublishBudget();
  docs.docs.clear();
  pubStore.rows.clear();
  pubStore.projects.clear();
  docs.docs.set(PID, { userId: 'owner', doc: drawnDoc() });
  pubStore.seedProject(PID, 'owner');
});

const call = (method: string, path: string, opts: { user?: string; body?: unknown; restricted?: boolean } = {}) =>
  fetch(`${base}/api/comic/projects/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.user ? { 'x-test-user': opts.user } : {}),
      ...(opts.restricted ? { 'x-test-restricted': '1' } : {})
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
  });

describe('owner publication routes', () => {
  it('every route without a JWT (e.g. a share-link holder) → 401, nothing changes', async () => {
    for (const [method, path] of [
      ['GET', `${PID}/publication`],
      ['POST', `${PID}/publication`],
      ['PATCH', `${PID}/publication`],
      ['DELETE', `${PID}/publication`],
      ['POST', `${PID}/publication/regenerate`]
    ] as const) {
      const res = await call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : { visibility: 'public' } });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(pubStore.rows.size).toBe(0);
  });

  it("another user's project → 404 (never 403), for reads and writes", async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const res = await call(method, `${PID}/publication`, { user: 'intruder', body: method === 'GET' || method === 'DELETE' ? undefined : { visibility: 'public' } });
      expect(res.status).toBe(404);
    }
    expect((await call('POST', `${PID}/publication/regenerate`, { user: 'intruder' })).status).toBe(404);
    expect((await call('GET', `not a uuid!/publication`, { user: 'owner' })).status).toBe(404);
    expect(pubStore.rows.size).toBe(0);
  });

  it('owner: 201 first publish, 200 update, PATCH, regenerate, DELETE idempotent; no-store everywhere', async () => {
    const view = await call('GET', `${PID}/publication`, { user: 'owner' });
    expect(view.status).toBe(200);
    expect(view.headers.get('cache-control')).toBe('private, no-store');
    expect((await view.json()).visibility).toBe('private');

    const first = await call('POST', `${PID}/publication`, { user: 'owner', body: { visibility: 'unlisted' } });
    expect(first.status).toBe(201);
    const v1 = await first.json();
    expect(v1.slug).toMatch(/^[A-Za-z0-9]{17}$/);
    expect((await call('POST', `${PID}/publication`, { user: 'owner', body: { visibility: 'unlisted' } })).status).toBe(200);
    const patched = await call('PATCH', `${PID}/publication`, { user: 'owner', body: { allowEmbed: false } });
    expect((await patched.json()).allowEmbed).toBe(false);
    const regen = await (await call('POST', `${PID}/publication/regenerate`, { user: 'owner' })).json();
    expect(regen.slug).not.toBe(v1.slug);
    expect((await call('DELETE', `${PID}/publication`, { user: 'owner' })).status).toBe(200);
    expect((await call('DELETE', `${PID}/publication`, { user: 'owner' })).status).toBe(200);
  });

  it('strict bodies: unknown keys 400 with the error shape; restricted accounts cannot publish', async () => {
    const bad = await call('POST', `${PID}/publication`, { user: 'owner', body: { visibility: 'public', userId: 'owner' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('BAD_REQUEST');
    const restricted = await call('POST', `${PID}/publication`, { user: 'owner', body: { visibility: 'public' }, restricted: true });
    expect(restricted.status).toBe(403);
    // Taking content down stays allowed.
    expect((await call('DELETE', `${PID}/publication`, { user: 'owner', restricted: true })).status).toBe(200);
  });

  it('PATCH/regenerate before publishing → 404 NOT_FOUND; other methods → 404', async () => {
    const res = await call('PATCH', `${PID}/publication`, { user: 'owner', body: { allowDownload: false } });
    expect(res.status).toBe(404);
    expect((await call('POST', `${PID}/publication/regenerate`, { user: 'owner' })).status).toBe(404);
    expect((await call('PUT', `${PID}/publication`, { user: 'owner', body: {} })).status).toBe(404);
  });
});
