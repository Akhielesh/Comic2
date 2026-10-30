// routes/comic.ts history seams (versions plan §3.3, §11; H0): the stream request's time zone reaches the turn
// context; caps carry `history` only while COMIC_HISTORY is on; POST /projects reads `fromVersionId` only while it is
// on (the H0 stub has no server-side snapshot: the same 404 as a missing project) and calls onImported once.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefAsset } from '../../../shared/comic/doc.js';
import type { ContentRating } from '../../../shared/comic/safety.js';
import { __resetSessionsForTests } from '../comic/session.js';
import { __resetAccessCacheForTests } from '../comic/access.js';
import { turnTimeZone } from '../comic/history/hooks.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, plannedDoc, scriptedLlm, type FakeDocStore } from '../comic/orchestrator.fakes.js';
import { registryPriceBook } from '../comic/models/index.js';
import { __setModelHealthForTests, type ModelHealthPort } from '../comic/models/health.js';
import { fakeModelHealth } from '../comic/models/health.fakes.js';
import type { ScreenResult } from '../comic/safety/index.js';
import { createComicRouter, parseStreamRequest } from './comic.js';

const imported = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../comic/history/hooks.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../comic/history/hooks.js')>();
  return { ...mod, createHistoryHooks: () => ({ ...mod.NOOP_HISTORY_HOOKS, onImported: (info: unknown) => void imported.calls.push(info) }) };
});

let store: FakeDocStore;
let zones: (string | undefined)[];
let server: http.Server;
let base: string;
let realHealth: ModelHealthPort;
const ALLOW: ScreenResult = { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const user = req.header('x-test-user');
  if (user) req.user = { id: user };
  next();
});
app.use('/api/comic', (req, res, next) =>
  createComicRouter({
    store,
    assets: fakeAssetStore(),
    contextDeps: () => ({ keys: KEYS, llm: scriptedLlm(), images: fakeImages().generate, billing: fakeBilling(), prices: async () => registryPriceBook() }),
    qualityAccess: async () => ({ ok: true }),
    capsDeps: { billingEnabled: true, planFor: async () => 'free', isAdminFor: async () => false, accountCeilingFor: async () => 'PG-13' },
    requireActive: (_req, _res, n) => n(),
    safety: {
      cooldownFor: async () => null,
      screenTurnInput: async (ctx: object, _input: { text: string; attachments: RefAsset[]; rating: ContentRating }) => {
        zones.push(turnTimeZone(ctx));
        return ALLOW;
      },
      respondBlocked: async () => undefined
    },
    routeIntent: () => ({ kind: 'nothing_to_draw', reply: 'Done.', cards: [], nextSteps: [] }),
    fastIntents: true,
    usageFor: async () => undefined,
    backfillVariants: false,
    heartbeatMs: 20
  } as never)(req, res, next)
);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  store = fakeDocStore();
  zones = [];
  imported.calls.length = 0;
  __resetAccessCacheForTests();
  realHealth = __setModelHealthForTests(fakeModelHealth());
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  __resetSessionsForTests();
  __setModelHealthForTests(realHealth);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const api = (path: string, init: { user?: string; body?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    method: init.body !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(init.user ? { 'x-test-user': init.user } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });

describe('parseStreamRequest tz', () => {
  it('keeps a valid IANA zone on messages and actions, drops anything else (never a 400)', () => {
    expect(parseStreamRequest({ kind: 'message', text: 'hi', tz: 'Asia/Kolkata' })).toEqual({ kind: 'message', text: 'hi', tz: expect.stringMatching(/^Asia\//) });
    expect(parseStreamRequest({ kind: 'action', action: { type: 'approve_plan' }, tz: 'America/Los_Angeles' })).toEqual({ kind: 'action', action: { type: 'approve_plan' }, tz: 'America/Los_Angeles' });
    expect(parseStreamRequest({ kind: 'message', text: 'hi', tz: 'Mars/Olympus' })).toEqual({ kind: 'message', text: 'hi' });
    expect(parseStreamRequest({ kind: 'message', text: 'hi', tz: { evil: true } })).toEqual({ kind: 'message', text: 'hi' });
  });
});

describe('history actions on the stream follow COMIC_HISTORY', () => {
  it('off: a history action is an unknown action (400), exactly as before H0; on: it reaches its (stub) handler', async () => {
    for (const type of ['history_save', 'history_restore', 'history_undo_ai', 'history_forget_photo', 'history_alternative']) {
      expect(() => parseStreamRequest({ kind: 'action', action: { type } }), type).toThrow(`Unknown action "${type}".`);
    }
    const doc = plannedDoc();
    store.docs.set(doc.id, { userId: 'user-1', doc });
    const off = await api(`/api/comic/projects/${doc.id}/stream`, { user: 'user-1', body: { kind: 'action', action: { type: 'history_restore', versionId: 'v', scope: { kind: 'book' } } } });
    expect(off.status).toBe(400);
    expect((await off.json()).error).toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown action "history_restore".' });
    vi.stubEnv('COMIC_HISTORY', '1');
    expect(parseStreamRequest({ kind: 'action', action: { type: 'history_restore' } })).toEqual({ kind: 'action', action: { type: 'history_restore' } });
    const on = await api(`/api/comic/projects/${doc.id}/stream`, { user: 'user-1', body: { kind: 'action', action: { type: 'history_restore', versionId: 'v', scope: { kind: 'book' } } } });
    expect(on.status).toBe(200);
    expect(await on.text()).toContain('NOT_AVAILABLE');
  });
});

describe('the turn context carries the request time zone', () => {
  it('a message stream remembers tz on its StudioContext (what the history tools read)', async () => {
    const doc = plannedDoc();
    store.docs.set(doc.id, { userId: 'user-1', doc });
    const res = await api(`/api/comic/projects/${doc.id}/stream`, { user: 'user-1', body: { kind: 'message', text: 'show me yesterday', tz: 'America/Los_Angeles' } });
    await res.text();
    expect(zones).toEqual(['America/Los_Angeles']);
    const res2 = await api(`/api/comic/projects/${doc.id}/stream`, { user: 'user-1', body: { kind: 'message', text: 'hello again' } });
    await res2.text();
    expect(zones).toEqual(['America/Los_Angeles', undefined]);
  });
});

describe('caps.history follows COMIC_HISTORY', () => {
  it('absent while off (nothing added), true with maxAlternatives 5 while on', async () => {
    const doc = plannedDoc();
    store.docs.set(doc.id, { userId: 'user-1', doc });
    const off = await (await api(`/api/comic/projects/${doc.id}`, { user: 'user-1' })).json();
    expect('history' in off.caps).toBe(false);
    expect('maxAlternatives' in off.caps).toBe(false);
    vi.stubEnv('COMIC_HISTORY', '1');
    const on = await (await api(`/api/comic/projects/${doc.id}`, { user: 'user-1' })).json();
    expect(on.caps).toMatchObject({ history: true, maxAlternatives: 5 });
  });
});

describe('POST /projects from a classic snapshot', () => {
  const classic = () =>
    store.legacy.set('old-9', { userId: 'user-1', name: 'Kites', state: { title: 'Kites', overview: 'Two friends race kites.', script: 'PAGE 1. Rooftops.' } });

  it('while off, fromVersionId is ignored: the live classic state imports as before, and onImported runs once', async () => {
    classic();
    const res = await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9', fromVersionId: 'snap_2' } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.doc.brief.title).toBe('Kites');
    expect(imported.calls).toEqual([expect.objectContaining({ projectId: body.projectId, userId: 'user-1', fromProjectId: 'old-9' })]);
    expect(imported.calls[0]).not.toHaveProperty('fromVersionId');
  });

  it('while on, a snapshot the server does not hold answers the same 404 as a missing project (H0 stub), nothing created', async () => {
    classic();
    vi.stubEnv('COMIC_HISTORY', '1');
    const before = store.docs.size;
    const res = await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9', fromVersionId: 'snap_2' } });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(store.docs.size).toBe(before);
    expect(imported.calls).toEqual([]);
    // Without a snapshot id the live state still imports.
    expect((await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9' } })).status).toBe(201);
  });

  it('while on, a malformed snapshot id answers that same 404 instead of importing the live classic state', async () => {
    classic();
    vi.stubEnv('COMIC_HISTORY', '1');
    const before = store.docs.size;
    for (const fromVersionId of ['bad id!', '', 42, { id: 'snap_2' }, 'x'.repeat(200)]) {
      const res = await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9', fromVersionId } });
      expect(res.status, JSON.stringify(fromVersionId)).toBe(404);
      expect((await res.json()).error.code).toBe('NOT_FOUND');
    }
    expect(store.docs.size).toBe(before);
    expect(imported.calls).toEqual([]);
    // null means "no snapshot": the live state imports, as without the field.
    expect((await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9', fromVersionId: null } })).status).toBe(201);
  });

  it('while off, a malformed snapshot id is ignored as before (the live classic state imports)', async () => {
    classic();
    expect((await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-9', fromVersionId: 'bad id!' } })).status).toBe(201);
  });

  it('a plain new comic never calls onImported', async () => {
    expect((await api('/api/comic/projects', { user: 'user-1', body: { title: 'Fresh' } })).status).toBe(201);
    expect(imported.calls).toEqual([]);
  });
});
