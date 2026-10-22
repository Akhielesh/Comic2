import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { emptyRender } from '../../../shared/comic/doc.js';
import { __resetSessionsForTests, peekStudioSession } from '../comic/session.js';
import {
  KEYS,
  fakeAssetStore,
  fakeBilling,
  fakeDocStore,
  fakeImages,
  plannedDoc,
  scriptedLlm,
  type FakeAssetStore,
  type FakeDocStore,
  type FakeImages,
  type ScriptedLlm
} from '../comic/orchestrator.fakes.js';
import { JOB_TIMINGS } from '../comic/jobs.js';
import { StudioError } from '../comic/types.js';
import { createComicPublicRouter, createComicRouter, legacyImportOps, parseStreamRequest, publicComicDoc } from './comic.js';

let store: FakeDocStore;
let assets: FakeAssetStore;
let llm: ScriptedLlm;
let images: FakeImages;
let server: http.Server;
let base: string;

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
  const user = req.header('x-test-user');
  if (user) req.user = { id: user };
  next();
});
app.use('/api/comic/public', (req, res, next) => createComicPublicRouter({ store, assets })(req, res, next));
app.use('/api/comic', (req, res, next) =>
  createComicRouter({
    store,
    assets,
    contextDeps: () => ({ keys: KEYS, llm, images: images.generate, billing: fakeBilling() }),
    qualityAccess: async () => ({ ok: true }),
    heartbeatMs: 20
  })(req, res, next)
);

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  store = fakeDocStore();
  assets = fakeAssetStore();
  llm = scriptedLlm();
  images = fakeImages();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  __resetSessionsForTests();
  vi.restoreAllMocks();
});

const api = (path: string, init: { method?: string; user?: string; body?: unknown } = {}) =>
  fetch(`${base}${path}`, {
    method: init.method || (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(init.user ? { 'x-test-user': init.user } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });

/** Parse a complete SSE body into events (comments skipped), checking the framing. */
const parseSse = (body: string): StudioEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.trim() && !block.startsWith(':'))
    .map((block) => {
      const lines = block.split('\n');
      expect(lines[0]).toMatch(/^event: [a-z]+$/);
      expect(lines[1]).toMatch(/^data: /);
      const event = JSON.parse(lines[1].slice(6)) as StudioEvent;
      expect(lines[0]).toBe(`event: ${event.type}`);
      return event;
    });

const stream = async (projectId: string, body: unknown, user = 'user-1') => {
  const res = await api(`/api/comic/projects/${projectId}/stream`, { user, body });
  return { res, events: res.headers.get('content-type')?.includes('text/event-stream') ? parseSse(await res.text()) : [], raw: res };
};

const seed = (doc = plannedDoc(), userId = 'user-1') => {
  store.docs.set(doc.id, { userId, doc });
  return doc;
};

describe('auth and ownership', () => {
  it('requires a user', async () => {
    const res = await api('/api/comic/projects', { body: {} });
    expect(res.status).toBe(401);
  });

  it('creates a project and only its owner can open it', async () => {
    const res = await api('/api/comic/projects', { user: 'user-1', body: { title: 'Spice Run' } });
    expect(res.status).toBe(201);
    const { projectId, doc, urls } = await res.json();
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc).toMatchObject({ id: projectId, rev: 0, brief: { title: 'Spice Run' }, conversation: [] });
    expect(urls).toEqual({});
    expect(store.docs.get(projectId)?.userId).toBe('user-1');

    const mine = await api(`/api/comic/projects/${projectId}`, { user: 'user-1' });
    expect(mine.status).toBe(200);
    expect((await mine.json()).doc.brief.title).toBe('Spice Run');
    const theirs = await api(`/api/comic/projects/${projectId}`, { user: 'intruder' });
    expect(theirs.status).toBe(404);
    expect((await theirs.json()).error.code).toBe('NOT_FOUND');
    const streamed = await stream(projectId, { kind: 'message', text: 'hi' }, 'intruder');
    expect(streamed.res.status).toBe(404);
    const cancel = await api(`/api/comic/projects/${projectId}/cancel`, { user: 'intruder', body: {} });
    expect(cancel.status).toBe(404);
  });

  it('GET /models lists the registry, tiers and presets', async () => {
    const body = await (await api('/api/comic/models', { user: 'user-1' })).json();
    expect(body.models.map((m: { id: string }) => m.id)).toContain('nano-banana-2.1');
    expect(Object.keys(body.tiers)).toEqual(['draft', 'standard', 'pro']);
    expect(body.presets.length).toBeGreaterThan(5);
  });

  it('POST /urls signs only paths that belong to the doc', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 } };
    seed(doc);
    const res = await api('/api/comic/projects/proj-1/urls', { user: 'user-1', body: { paths: ['u/user-1/p/proj-1/img/p1.webp', 'u/other/secret.webp', 42] } });
    expect(await res.json()).toEqual({ urls: { 'u/user-1/p/proj-1/img/p1.webp': 'https://signed.test/u/user-1/p/proj-1/img/p1.webp' } });
    expect((await api('/api/comic/projects/proj-1/urls', { user: 'user-1', body: {} })).status).toBe(400);
  });

  it('POST /cancel aborts the session; the next request starts with a fresh controller', async () => {
    seed();
    expect(await (await api('/api/comic/projects/proj-1/cancel', { user: 'user-1', body: {} })).json()).toEqual({ ok: true });
    expect(peekStudioSession('proj-1')?.abort.signal.aborted).toBe(true);
    llm.script.director = [{ text: 'Back at it.' }];
    const { events } = await stream('proj-1', { kind: 'message', text: 'continue' });
    expect(events.some((e) => e.type === 'delta' && e.text === 'Back at it.')).toBe(true);
    expect(peekStudioSession('proj-1')?.abort.signal.aborted).toBe(false);
  });
});

describe('POST /projects/:id/stream', () => {
  it('rejects invalid requests with JSON before streaming', async () => {
    seed();
    for (const body of [{}, { kind: 'message', text: '' }, { kind: 'action', action: { type: 'hack' } }, { kind: 'message', text: 'x'.repeat(60_001) }]) {
      const { res } = await stream('proj-1', body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('BAD_REQUEST');
    }
  });

  it('streams hello → ops/deltas → done for a director turn, with chat-style SSE framing', async () => {
    seed();
    llm.script.director = [
      { toolCalls: [{ id: 't1', name: 'upsert_character', arguments: JSON.stringify({ name: 'Nani', tier: 'support', look: { summary: 'tiny grandmother' } }) }] },
      { text: 'Added Nani.' }
    ];
    const { res, events } = await stream('proj-1', { kind: 'message', text: 'Add Nani, a tiny grandmother.' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(events[0]).toMatchObject({ type: 'hello', rev: 0, turnId: expect.any(String) });
    const done = events[events.length - 1];
    expect(done.type).toBe('done');
    const ops = events.filter((e) => e.type === 'ops');
    expect(ops.length).toBeGreaterThan(0);
    expect(done).toMatchObject({ rev: (ops[ops.length - 1] as { rev: number }).rev, spentUsd: expect.any(Number) });
    expect((done as { spentUsd: number }).spentUsd).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'delta' && e.text === 'Added Nani.')).toBe(true);
    // Persisted at the end of the request.
    const saved = store.docs.get('proj-1')!.doc;
    expect(saved.cast.map((c) => c.name)).toContain('Nani');
    expect(saved.rev).toBe((done as { rev: number }).rev);
  });

  it('a UI spend click is confirmed, renders server-side and keeps the stream open until done', async () => {
    const doc = seed();
    doc.settings.confirm = 'always';
    const { events } = await stream('proj-1', { kind: 'action', action: { type: 'render_cover' } });
    expect(images.calls).toHaveLength(1);
    const urls = events.find((e) => e.type === 'urls');
    expect(urls).toBeTruthy();
    const done = events[events.length - 1] as Extract<StudioEvent, { type: 'done' }>;
    expect(done.spentUsd).toBeGreaterThan(0);
    expect(store.docs.get('proj-1')!.doc.cover.render.status).toBe('ready');
  });

  it('patch actions apply instantly; invalid ones become an error event', async () => {
    seed();
    const ok = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Renamed' } }] } });
    expect(ok.events.map((e) => e.type)).toEqual(['hello', 'ops', 'done']);
    const bad = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'spend', entry: {} }] } });
    expect(bad.events.map((e) => e.type)).toEqual(['hello', 'error', 'done']);
    expect(bad.events[1]).toMatchObject({ code: 'BAD_REQUEST' });
    expect(store.docs.get('proj-1')!.doc.brief.title).toBe('Renamed');
  });

  it('rejects a second concurrent message with a BUSY event', async () => {
    seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    llm.script.director = [
      async () => {
        markStarted();
        await held;
        return { text: 'First done.' };
      }
    ];
    const first = stream('proj-1', { kind: 'message', text: 'one' });
    await started;
    const second = await stream('proj-1', { kind: 'message', text: 'two' });
    expect(second.events.map((e) => e.type)).toEqual(['hello', 'error', 'done']);
    expect(second.events[1]).toMatchObject({ code: 'BUSY' });
    release();
    const firstResult = await first;
    expect(firstResult.events.some((e) => e.type === 'delta')).toBe(true);
    expect(store.docs.get('proj-1')!.doc.conversation.map((m) => m.text)).toEqual(['one', 'First done.']);
  });

  it('a client disconnect aborts the director loop (not the session) and still persists', async () => {
    seed();
    let markWaiting!: () => void;
    const waiting = new Promise<void>((r) => (markWaiting = r));
    let sawAbort!: () => void;
    const aborted = new Promise<void>((r) => (sawAbort = r));
    llm.script.director = [
      async (req) => {
        markWaiting();
        await new Promise<void>((r) => req.signal!.addEventListener('abort', () => r(), { once: true }));
        sawAbort();
        return new StudioError('CANCELLED', 'Cancelled.');
      }
    ];
    const client = new AbortController();
    const pending = fetch(`${base}/api/comic/projects/proj-1/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-1' },
      body: JSON.stringify({ kind: 'message', text: 'draw something' }),
      signal: client.signal
    }).then((r) => r.text()).catch(() => 'closed');
    await waiting;
    client.abort();
    await aborted;
    await pending;
    await new Promise((r) => setTimeout(r, 30));
    const session = peekStudioSession('proj-1')!;
    expect(session.abort.signal.aborted).toBe(false);
    expect(store.docs.get('proj-1')!.doc.conversation.map((m) => m.role)).toEqual(['user']);
  });

  it('stores image attachments and turns a long text file into the source script', async () => {
    seed();
    const script = 'PAGE 1. Maya runs. '.repeat(120);
    const textFile = `data:text/plain;base64,${Buffer.from(script).toString('base64')}`;
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    llm.script.director = [{ text: 'Got your script and photo.' }];
    const { events } = await stream('proj-1', {
      kind: 'message',
      text: 'Here is my script and Maya',
      attachments: [
        { name: 'script.txt', mimeType: 'text/plain', dataUrl: textFile },
        { name: 'maya.png', mimeType: 'image/png', dataUrl: image }
      ]
    });
    expect(events[events.length - 1].type).toBe('done');
    const doc = store.docs.get('proj-1')!.doc;
    expect(doc.source.script).toBe(script.trim());
    const userMsg = doc.conversation.find((m) => m.role === 'user')!;
    expect(userMsg.attachments).toHaveLength(1);
    expect(userMsg.text).toContain('[Attached “script.txt” —');
    expect(llm.calls[0].messages[llm.calls[0].messages.length - 1].content).toEqual(
      expect.arrayContaining([{ type: 'image_url', image_url: { url: image } }])
    );
    const unsupported = await stream('proj-1', { kind: 'message', text: 'pdf', attachments: [{ name: 'a.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,AAAA' }] });
    expect(unsupported.res.status).toBe(400);
  });
});

describe('legacy import', () => {
  it('maps a classic project into the doc with a welcome message', async () => {
    store.legacy.set('old-1', {
      userId: 'user-1',
      name: 'Old Comic',
      state: {
        script: 'Maya meets Arjun at the market.',
        overview: 'A market caper.',
        stylePrompt: 'Bold inks and flat colors',
        styleCategory: 'Pop',
        styleAspectRatio: '3:4',
        characters: [
          {
            id: 'x',
            name: 'Maya',
            bio: 'Brave',
            description: 'Young courier',
            structured: { ageBand: 'teen', genderPresentation: 'girl', physicalTraits: 'wiry', outfit: 'red scarf', distinguishingFeatures: 'scar on chin' },
            imageId: 'u/user-1/p/old-1/img/maya.webp',
            referenceImageIds: ['u/other-user/p/x/img/stolen.webp']
          },
          { id: 'y', name: 'Arjun', bio: '', description: 'Vendor', castTier: 'extra', referenceImageIds: [] }
        ],
        locations: [{ id: 'l', name: 'Market', description: 'Busy lanes', structured: { lighting: 'noon sun' }, referenceImageIds: [] }]
      }
    });
    const res = await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'old-1' } });
    expect(res.status).toBe(201);
    const { doc } = await res.json();
    expect(doc.brief).toMatchObject({ title: 'Old Comic', logline: 'A market caper.' });
    expect(doc.source.script).toBe('Maya meets Arjun at the market.');
    expect(doc.cast.map((c: { name: string; tier: string }) => [c.name, c.tier])).toEqual([
      ['Maya', 'lead'],
      ['Arjun', 'extra']
    ]);
    expect(doc.cast[0].look).toMatchObject({ summary: 'Young courier. wiry', age: 'teen', gender: 'girl', outfit: 'red scarf', marks: 'scar on chin' });
    expect(doc.cast[0].refs.map((r: { path: string }) => r.path)).toEqual(['u/user-1/p/old-1/img/maya.webp']);
    expect(doc.places[0]).toMatchObject({ name: 'Market', look: 'Busy lanes. noon sun' });
    expect(doc.style).toMatchObject({ status: 'drafted', name: 'Pop', spec: 'Bold inks and flat colors' });
    expect(doc.format.pageAspect).toBe('3:4');
    expect(doc.conversation).toHaveLength(1);
    expect(doc.conversation[0].text).toContain('the script (6 words), 2 characters (MAYA, ARJUN), 1 location and your style');

    expect((await api('/api/comic/projects', { user: 'intruder', body: { importFromProjectId: 'old-1' } })).status).toBe(404);
  });

  it('legacyImportOps ignores junk safely', () => {
    const { ops, summary } = legacyImportOps({ name: '', state: { characters: [null, { name: '' }, 'x'], styleAspectRatio: '99:1' } }, 'u');
    expect(summary).toMatchObject({ title: 'Untitled comic', cast: [], places: 0, style: false });
    expect(ops).toEqual([{ op: 'brief', patch: { title: 'Untitled comic' } }]);
  });
});

describe('public reader', () => {
  it('serves only published comics, sanitized, with page/cover urls only', async () => {
    const doc = plannedDoc();
    doc.conversation = [{ id: 'm', role: 'user', text: 'secret', at: 1, attachments: [{ path: 'u/user-1/p/proj-1/img/photo.webp', source: 'upload', at: 1 }] }];
    doc.spend = { totalUsd: 1.2, byKind: { page: 1.2 }, entries: [{ id: 's', at: 1, kind: 'page', label: 'Page 1', usd: 1.2, byok: false, estimated: false }] };
    doc.source = { script: 'private script' };
    doc.memory = 'private memory';
    doc.settings.budgetUsd = 10;
    doc.cast[0].refs = [{ path: 'u/user-1/p/proj-1/img/face.webp', source: 'upload', at: 1 }];
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'sheet.webp', source: 'generated', at: 1 } };
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'page1.webp', source: 'generated', at: 1 } };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } };
    store.docs.set('proj-1', { userId: 'user-1', doc, isPublic: false });

    expect((await api('/api/comic/public/proj-1')).status).toBe(404);
    // The owner can preview an unpublished comic.
    expect((await api('/api/comic/public/proj-1', { user: 'user-1' })).status).toBe(200);

    store.docs.get('proj-1')!.isPublic = true;
    const res = await api('/api/comic/public/proj-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doc.conversation).toEqual([]);
    expect(body.doc.spend).toEqual({ totalUsd: 0, byKind: {}, entries: [] });
    expect(body.doc.source).toEqual({});
    expect(body.doc.memory).toBeUndefined();
    expect(body.doc.gate).toBeNull();
    expect(body.doc.settings.budgetUsd).toBeUndefined();
    expect(body.doc.cast[0].refs).toEqual([]);
    expect(Object.keys(body.urls).sort()).toEqual(['cover.webp', 'page1.webp']);
  });

  it('public payload carries no render history, archive/trash/inbox, sheets, board or private text (P0-SEC)', async () => {
    const doc = plannedDoc();
    const draft = { path: 'u/user-1/p/proj-1/img/discarded.webp', source: 'generated' as const, at: 1 };
    doc.style = { ...doc.style, spec: 'SECRET STYLE SPEC', board: { path: 'u/user-1/p/proj-1/img/board.webp', source: 'generated', at: 1 } };
    doc.cast[0].look = { ...doc.cast[0].look, summary: 'SECRET LOOK' };
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/sheet.webp', source: 'generated', at: 1 }, history: [draft] };
    doc.pages[0].summary = 'SECRET SUMMARY';
    if (doc.pages[0].panels[0]) doc.pages[0].panels[0].action = 'SECRET ACTION';
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/page1.webp', source: 'generated', at: 2 }, history: [draft], qc: { score: 0.3, issues: ['SECRET QC'], checkedAt: 1 } };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 2 }, history: [draft] };
    Object.assign(doc as unknown as Record<string, unknown>, {
      archive: [{ id: 'a1', asset: draft }],
      trash: [{ page: { id: 'pg_gone', summary: 'SECRET TRASH' } }],
      refInbox: [{ path: 'u/user-1/p/proj-1/ref/photo.webp' }]
    });
    store.docs.set('proj-1', { userId: 'user-1', doc, isPublic: true });

    for (const user of [undefined, 'user-1']) {
      const res = await api('/api/comic/public/proj-1', { user });
      expect(res.status).toBe(200);
      const body = await res.json();
      const json = JSON.stringify(body);
      for (const secret of ['SECRET', 'discarded.webp', 'board.webp', 'sheet.webp', '/ref/']) expect(json).not.toContain(secret);
      expect(body.doc.archive).toBeUndefined();
      expect(body.doc.trash).toBeUndefined();
      expect(body.doc.refInbox).toBeUndefined();
      expect(body.doc.pages[0].render.history).toEqual([]);
      expect(body.doc.style.board).toBeUndefined();
      expect(Object.keys(body.urls).sort()).toEqual(['u/user-1/p/proj-1/img/cover.webp', 'u/user-1/p/proj-1/img/page1.webp']);
    }
  });

  it('publicComicDoc is idempotent', () => {
    const once = publicComicDoc(plannedDoc());
    expect(publicComicDoc(once)).toEqual(once);
  });
});

describe('parseStreamRequest', () => {
  it('validates message limits and action names', () => {
    expect(parseStreamRequest({ kind: 'message', text: '  hi  ' })).toEqual({ kind: 'message', text: 'hi' });
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: Array.from({ length: 7 }, () => ({ dataUrl: 'data:image/png;base64,AA' })) })).toThrow('at most 6');
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [{ dataUrl: 'https://evil' }] })).toThrow('could not be read');
    expect(parseStreamRequest({ kind: 'action', action: { type: 'approve_plan' } })).toEqual({ kind: 'action', action: { type: 'approve_plan' } });
    expect(() => parseStreamRequest({ kind: 'action', action: { type: 'drop_tables' } })).toThrow('Unknown action');
  });
});
