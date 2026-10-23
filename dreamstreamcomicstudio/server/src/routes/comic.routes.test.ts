import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { emptyRender, type ComicDoc, type RefAsset } from '../../../shared/comic/doc.js';
import { NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES } from '../../../shared/comic/ops.js';
import type { PublicComicPayload, PublicPublicationInfo } from '../../../shared/comic/publication.js';
import type { StudioUsage } from '../../../shared/comic/capabilities.js';
import type { ContentRating, SafetyVerdict } from '../../../shared/comic/safety.js';
import { __resetSessionsForTests, peekStudioSession } from '../comic/session.js';
import { __resetAccessCacheForTests } from '../comic/access.js';
import { runDirectorTurn } from '../comic/director.js';
import { respondBlocked, type ScreenResult } from '../comic/safety/index.js';
import type { RoutedIntent } from '../comic/intents.js';
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
import { JOB_TIMINGS, noticeCard } from '../comic/jobs.js';
import { StudioError } from '../comic/types.js';
import {
  HIDDEN_MESSAGE_TEXT,
  RESTRICTED_SPEND_MESSAGE,
  STREAM_ACTION_TYPES,
  blockedAssetPaths,
  createComicPublicRouter,
  createComicRouter,
  isCostlyRequest,
  legacyImportOps,
  parseFocus,
  parseStreamRequest,
  restrictedRefusal
} from './comic.js';

// Wrap the real director so tests can see what the route handed it (focus, safety note).
vi.mock('../comic/director.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../comic/director.js')>();
  return { ...mod, runDirectorTurn: vi.fn(mod.runDirectorTurn) };
});

let store: FakeDocStore;
let assets: FakeAssetStore;
let llm: ScriptedLlm;
let images: FakeImages;
let server: http.Server;
let base: string;
/** Moderation state the fake requireActiveUser() reports for every request. */
let moderation: 'active' | 'restricted' | 'suspended';
let cooldown: { until: number } | null;
let screen: (input: { text: string; attachments: RefAsset[]; sourceText?: string; rating: ContentRating }) => Promise<ScreenResult>;
let screenCalls: { text: string; attachments: RefAsset[]; sourceText?: string; rating: ContentRating }[];
let blockedResponses: string[];
let intent: ((text: string) => RoutedIntent | null) | null;
let plans: Map<string, string>;
let publications: Map<string, PublicComicPayload>;
let publicLoads: string[];
/** caps.usage the router reports (P2-SERVER); undefined = the usage lookup is off. */
let usage: StudioUsage | undefined;
/** COMIC_FAST_INTENTS for the router under test. */
let fast: boolean;

const ALLOW: ScreenResult = { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => {
  const user = req.header('x-test-user');
  if (user) req.user = { id: user };
  next();
});
app.use('/api/comic/public', (req, res, next) =>
  createComicPublicRouter({
    store,
    assets,
    loadPublicByProjectId: async (id) => {
      publicLoads.push(id);
      return publications.get(id) ?? null;
    }
  })(req, res, next)
);
app.use('/api/comic', (req, res, next) =>
  createComicRouter({
    store,
    assets,
    contextDeps: () => ({ keys: KEYS, llm, images: images.generate, billing: fakeBilling() }),
    qualityAccess: async () => ({ ok: true }),
    capsDeps: {
      billingEnabled: true,
      planFor: async (userId) => plans.get(userId) ?? 'free',
      isAdminFor: async (r) => r.user?.id === 'admin-1',
      accountCeilingFor: async () => 'PG-13'
    },
    requireActive: (_req, res, next) => {
      if (moderation === 'suspended') {
        res.status(403).json({ error: { message: 'This account is suspended.', code: 'FORBIDDEN' } });
        return;
      }
      res.locals.moderationStatus = moderation;
      next();
    },
    safety: {
      cooldownFor: async () => cooldown,
      screenTurnInput: async (_ctx, input) => {
        screenCalls.push(input);
        return screen(input);
      },
      respondBlocked: async (ctx, prepared, result) => {
        blockedResponses.push(prepared.userMsgId);
        await respondBlocked(ctx, prepared, result);
      }
    },
    ...(intent ? { routeIntent: (_doc, text) => intent!(text) } : {}),
    usageFor: async () => usage,
    fastIntents: fast,
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
  moderation = 'active';
  cooldown = null;
  screen = async () => ALLOW;
  screenCalls = [];
  blockedResponses = [];
  intent = null;
  plans = new Map();
  publications = new Map();
  publicLoads = [];
  usage = undefined;
  fast = false;
  __resetAccessCacheForTests();
  vi.mocked(runDirectorTurn).mockClear();
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

/** Every structured log line printed to console.info, parsed. */
const infoLines = (): Record<string, unknown>[] =>
  vi
    .mocked(console.info)
    .mock.calls.map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
const refusals = () => infoLines().filter((l) => l.event === 'comic_stream_refused');

const BLOCKED: SafetyVerdict = { assessed: 'X', categories: ['graphic_gore'], by: 'qc', at: 1 };
const ref = (path: string, extra: Partial<RefAsset> = {}): RefAsset => ({ path, source: 'upload', at: Date.now(), ...extra });

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
    expect(refusals()).toEqual([expect.objectContaining({ code: 'BUSY', stage: 'stream', kind: 'message', userId: 'user-1' })]);
    expect(JSON.stringify(refusals())).not.toContain('two');
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
    // Legacy data URLs are stored as PRIVATE refs (saveRef → u/<user>/p/<project>/ref/…), never the public lane.
    expect(userMsg.attachments![0].path).toMatch(/^u\/user-1\/p\/proj-1\/ref\/.+\.webp$/);
    // …and measured for free (dHash for near-duplicates, quality flags) like an inbox upload.
    expect(userMsg.attachments![0].dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(userMsg.text).toContain('[Attached “script.txt” —');
    const lastTurn = llm.calls[0].messages[llm.calls[0].messages.length - 1].content;
    expect(JSON.stringify(lastTurn)).toContain('image_url');
    // The safety screen saw the stored image and the long script.
    expect(screenCalls[0].attachments.map((a) => a.path)).toEqual([userMsg.attachments![0].path]);
    expect(screenCalls[0].sourceText).toBe(script.trim());

    // An unsupported file is a plain 400 and nothing is stored, even next to a valid image.
    const before = assets.files.size;
    const unsupported = await stream('proj-1', {
      kind: 'message',
      text: 'pdf',
      attachments: [
        { name: 'ok.png', mimeType: 'image/png', dataUrl: image },
        { name: 'a.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,AAAA' }
      ]
    });
    expect(unsupported.res.status).toBe(400);
    expect(assets.files.size).toBe(before);
    // A non-base64 image data URL can't be read.
    const notBase64 = await stream('proj-1', { kind: 'message', text: 'x', attachments: [{ name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png,abc' }] });
    expect(notBase64.res.status).toBe(400);
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

describe('public reader (GET /api/comic/public/:id)', () => {
  const publication = (over: Partial<PublicPublicationInfo> = {}): PublicPublicationInfo => ({
    slug: 'AbCdEfGhIjKlMnOpQ',
    visibility: 'public',
    languages: ['en'],
    allowDownload: true,
    allowEmbed: false,
    publishedAt: 1,
    updatedAt: 2,
    card: {} as PublicPublicationInfo['card'],
    ...over
  });
  const snapshot = (): ComicDoc => {
    const doc = plannedDoc();
    doc.conversation = [];
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'pub/AAAAAAAAAAAAAAAAAAAAAA/p1-0123456789ab.webp', source: 'generated', at: 1 } };
    return doc;
  };

  const privateDoc = () => {
    const doc = plannedDoc();
    doc.conversation = [{ id: 'm', role: 'user', text: 'secret', at: 1, attachments: [{ path: 'u/user-1/p/proj-1/ref/photo.webp', source: 'upload', at: 1 }] }];
    doc.spend = { totalUsd: 1.2, byKind: { page: 1.2 }, entries: [{ id: 's', at: 1, kind: 'page', label: 'Page 1', usd: 1.2, byok: false, estimated: false }] };
    doc.source = { script: 'private script' };
    doc.memory = 'private memory';
    doc.settings.budgetUsd = 10;
    doc.cast[0].refs = [{ path: 'u/user-1/p/proj-1/ref/face.webp', source: 'upload', at: 1 }];
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/page1.webp', source: 'generated', at: 1 } };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 1 } };
    return doc;
  };

  it('a comic with no live PUBLIC publication is a 404 for anonymous readers and other users — even if the old is_public flag is set', async () => {
    store.docs.set('proj-1', { userId: 'user-1', doc: privateDoc(), isPublic: true });
    const anon = await api('/api/comic/public/proj-1');
    const other = await api('/api/comic/public/proj-1', { user: 'intruder' });
    const missing = await api('/api/comic/public/does-not-exist', { user: 'intruder' });
    const malformed = await api('/api/comic/public/bad%20id!', { user: 'intruder' });
    const bodies = await Promise.all([anon, other, missing, malformed].map((r) => r.text()));
    for (const r of [anon, other, missing, malformed]) {
      expect(r.status).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    // One canonical body: nothing distinguishes private, unknown and malformed ids.
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: { message: "This comic isn't available.", code: 'NOT_FOUND' } });
    // Same lookups for an existing private comic and an unknown id (no timing oracle by short-circuit).
    expect(publicLoads).toEqual(['proj-1', 'proj-1', 'does-not-exist']);
  });

  it('an UNLISTED publication is never reachable by project id (only by its slug)', async () => {
    seed(privateDoc());
    publications.set('proj-1', { publication: publication({ visibility: 'unlisted' }), doc: snapshot(), urls: {} });
    expect((await api('/api/comic/public/proj-1')).status).toBe(404);
    expect((await api('/api/comic/public/proj-1', { user: 'intruder' })).status).toBe(404);
  });

  it('serves the live public snapshot as-is (no live doc), with publication.slug for the legacy replaceState', async () => {
    seed(privateDoc());
    const snap = snapshot();
    publications.set('proj-1', { publication: publication(), doc: snap, urls: { [snap.pages[0].render.asset!.path]: 'https://cdn.test/p1.webp' } });
    for (const user of [undefined, 'intruder']) {
      const res = await api('/api/comic/public/proj-1', { user });
      expect(res.status).toBe(200);
      // Never cached: an unpublish must stop the comic being served at once.
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('vary')).toMatch(/authorization/i);
      const body = await res.json();
      expect(body.publication.slug).toBe('AbCdEfGhIjKlMnOpQ');
      expect(body.doc).toEqual(JSON.parse(JSON.stringify(snap)));
      expect(body.urls).toEqual({ [snap.pages[0].render.asset!.path]: 'https://cdn.test/p1.webp' });
      const json = JSON.stringify(body);
      for (const secret of ['private script', 'private memory', '/ref/', 'u/user-1/']) expect(json).not.toContain(secret);
      expect(body.languages).toEqual([{ code: 'en', endonym: 'English', english: 'English', complete: true, isSource: true }]);
    }
    expect(assets.signed).toEqual([]); // public copies are never re-signed from the private lanes
  });

  it('the owner previews the live doc sanitized, with no-store and page/cover urls only', async () => {
    store.docs.set('proj-1', { userId: 'user-1', doc: privateDoc(), isPublic: false });
    const res = await api('/api/comic/public/proj-1', { user: 'user-1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toMatch(/authorization/i);
    const body = await res.json();
    expect(body.preview).toBe(true);
    expect(body.doc.conversation).toEqual([]);
    expect(body.doc.spend).toEqual({ totalUsd: 0, byKind: {}, entries: [] });
    expect(body.doc.source).toEqual({});
    expect(body.doc.memory).toBeUndefined();
    expect(body.doc.gate).toBeNull();
    expect(body.doc.settings.budgetUsd).toBeUndefined();
    expect(body.doc.cast[0].refs).toEqual([]);
    expect(Object.keys(body.urls).sort()).toEqual(['u/user-1/p/proj-1/img/cover.webp', 'u/user-1/p/proj-1/img/page1.webp']);
    expect(publicLoads).toEqual([]); // the owner never needs the publication lookup
  });

  it('owner preview carries no render history, archive/trash/inbox, sheets, board or private text (P0-SEC)', async () => {
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
    seed(doc);
    const res = await api('/api/comic/public/proj-1', { user: 'user-1' });
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
  });

  it('owner preview withholds blocked art (no url, withheld placeholder) and localizes with ?lang', async () => {
    const doc = privateDoc();
    doc.pages[0].render.asset = { ...doc.pages[0].render.asset!, safety: BLOCKED };
    doc.format = { ...doc.format, language: 'en' };
    const line = doc.pages[0].panels[1].lines[0];
    doc.i18n = {
      editions: { te: { lang: 'te', lines: { [line.id]: { text: 'తెలుగు పంక్తి', status: 'machine', sourceHash: 'x', at: 1 } }, balloons: {} } },
      glossary: []
    } as unknown as ComicDoc['i18n'];
    seed(doc);
    const res = await api('/api/comic/public/proj-1?lang=te', { user: 'user-1' });
    const body = await res.json();
    expect(body.lang).toBe('te');
    expect(body.doc.format.language).toBe('te');
    expect(body.doc.pages[0].panels[1].lines[0].text).toBe('తెలుగు పంక్తి');
    expect(body.languages.map((l: { code: string; isSource: boolean }) => [l.code, l.isSource])).toEqual([
      ['en', true],
      ['te', false]
    ]);
    expect(body.doc.pages[0].render.asset).toBeUndefined();
    expect(body.doc.pages[0].render.withheld).toBe('safety');
    expect(Object.keys(body.urls)).toEqual(['u/user-1/p/proj-1/img/cover.webp']);
    // An unknown language is ignored (source shown), never an error.
    const plain = await (await api('/api/comic/public/proj-1?lang=xx', { user: 'user-1' })).json();
    expect(plain.lang).toBeUndefined();
    expect(plain.doc.format.language).toBe('en');
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

  it('accepts exactly the shared spend + non-spend action sets (single source in shared/comic/ops.ts)', () => {
    expect([...STREAM_ACTION_TYPES].sort()).toEqual([...SPEND_ACTION_TYPES, ...NON_SPEND_ACTION_TYPES].sort());
    for (const type of ['fit_render', 'show_breakdown', 'use_preset', 'ref_crop', 'publish', 'unpublish', 'safety_recheck', 'swap_source_language', 'accept_translation_issue', 'library_use']) {
      expect(NON_SPEND_ACTION_TYPES.has(type)).toBe(true);
      expect(parseStreamRequest({ kind: 'action', action: { type } })).toEqual({ kind: 'action', action: { type } });
    }
    for (const type of ['translate', 'render_pages', 'render_cover']) expect(() => parseStreamRequest({ kind: 'action', action: { type } })).not.toThrow();
    for (const type of ['', '__proto__', 'constructor', 'render_everything', 'restore_render ']) expect(() => parseStreamRequest({ kind: 'action', action: { type } })).toThrow('Unknown action');
  });

  it('passes focus through, keeping only valid parts', () => {
    const lineIds = Array.from({ length: 90 }, (_, i) => `ln_${i}`);
    const parsed = parseStreamRequest({ kind: 'message', text: 'make these red', focus: { pageId: 'pg_2', lineIds: [...lineIds, 'bad id!', 4], panelN: 3, surface: 'page_editor', extra: 'x' } });
    expect(parsed).toEqual({ kind: 'message', text: 'make these red', focus: { pageId: 'pg_2', lineIds: lineIds.slice(0, 80), panelN: 3, surface: 'page_editor' } });
    expect(parseFocus({ pageId: '<script>', panelN: 99, surface: 'kitchen' })).toBeUndefined();
    expect(parseFocus('nope')).toBeUndefined();
  });

  it('accepts {inboxPath} items up to 12 images, de-duplicated, mixed with legacy data URLs', () => {
    const inbox = Array.from({ length: 12 }, (_, i) => ({ inboxPath: `u/user-1/p/proj-1/ref/r${i}.webp` }));
    expect(parseStreamRequest({ kind: 'message', text: '', attachments: inbox })).toEqual({ kind: 'message', text: '', attachments: inbox });
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [...inbox, { inboxPath: 'u/user-1/p/proj-1/ref/r12.webp' }] })).toThrow('up to 12 images');
    // 11 inbox + 2 legacy images = 13 images → refused; a duplicate path counts once.
    const legacy = { name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA' };
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [...inbox.slice(0, 11), legacy, legacy] })).toThrow('up to 12 images');
    const dup = parseStreamRequest({ kind: 'message', text: 'x', attachments: [inbox[0], inbox[0], legacy] }) as { attachments: unknown[] };
    expect(dup.attachments).toHaveLength(2);
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [{ inboxPath: '' }] })).toThrow('could not be read');
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [{ inboxPath: 'a\nb' }] })).toThrow('could not be read');
    expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments: [{ inboxPath: 'x'.repeat(600) }] })).toThrow('could not be read');
  });

  it('validates attachment targets', () => {
    const attachments = [{ inboxPath: 'u/user-1/p/proj-1/ref/a.webp' }, { inboxPath: 'u/user-1/p/proj-1/ref/b.webp' }];
    expect(
      parseStreamRequest({ kind: 'message', text: '', attachments, attachmentTargets: [{ kind: 'new_character', name: '  Biscuit  ', castKind: 'animal' }, { kind: 'character', id: 'c_maya' }] })
    ).toMatchObject({ attachmentTargets: [{ kind: 'new_character', name: 'Biscuit', castKind: 'animal' }, { kind: 'character', id: 'c_maya' }] });
    // All-null targets are dropped; an inbox "target" means "leave it".
    expect(parseStreamRequest({ kind: 'message', text: 'x', attachments, attachmentTargets: [null, { kind: 'inbox' }] })).not.toHaveProperty('attachmentTargets');
    for (const bad of [[{ kind: 'character' }], [{ kind: 'new_character', name: '   ' }], [{ kind: 'villain', id: 'x' }], 'x', Array.from({ length: 13 }, () => null)]) {
      expect(() => parseStreamRequest({ kind: 'message', text: 'x', attachments, attachmentTargets: bad })).toThrow('photo assignment');
    }
  });
});

describe('caps (GET/POST projects)', () => {
  it('GET and POST carry caps resolved from the plan, own key, admin role and ceiling', async () => {
    const created = await (await api('/api/comic/projects', { user: 'user-1', body: { title: 'Caps' } })).json();
    expect(created.caps).toMatchObject({ plan: 'free', qualityTiers: ['draft', 'standard'], modelOverride: false, maxPages: 40, proEditor: true, ratingCeiling: 'PG-13', admin: false });
    plans.set('user-1', 'creator');
    __resetAccessCacheForTests();
    const res = await api(`/api/comic/projects/${created.projectId}`, { user: 'user-1' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await res.json()).caps).toMatchObject({ plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true, defaultMode: 'pro' });
    const admin = await (await api('/api/comic/projects', { user: 'admin-1', body: {} })).json();
    expect(admin.caps).toMatchObject({ plan: 'admin', admin: true });
  });

  it('a storybook starts with its free title and end plates; an unknown kind is ignored', async () => {
    const storybook = await (await api('/api/comic/projects', { user: 'user-1', body: { title: 'Bedtime', kind: 'storybook' } })).json();
    expect(storybook.doc.format.kind).toBe('storybook');
    expect(storybook.doc.book).toMatchObject({ titlePage: true, endPage: true });
    const plain = await (await api('/api/comic/projects', { user: 'user-1', body: { title: 'Plain', kind: 'hologram' } })).json();
    expect(plain.doc.format.kind).not.toBe('hologram');
    expect(plain.doc.book?.titlePage ?? false).toBe(false);
  });

  it('the stream context carries caps and the effective rating', async () => {
    seed();
    plans.set('user-1', 'studio');
    llm.script.director = [{ text: 'Hi.' }];
    await stream('proj-1', { kind: 'message', text: 'hello there' });
    const ctx = vi.mocked(runDirectorTurn).mock.calls[0][0];
    expect(ctx.caps).toMatchObject({ plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'] });
    expect(ctx.rating).toBe('PG-13');
  });
});

describe('POST /projects/:id/urls', () => {
  it('signs only servable paths of this doc; private paths get the 300 s TTL', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 } };
    doc.pages[1].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/bad.webp', source: 'generated', at: 1, safety: BLOCKED, variants: [{ path: 'u/user-1/p/proj-1/img/bad_w480.webp', w: 480, h: 600 }] } as never };
    doc.cast[0].refs = [ref('u/user-1/p/proj-1/ref/face.webp')];
    seed(doc);
    const res = await api('/api/comic/projects/proj-1/urls', {
      user: 'user-1',
      body: { paths: ['u/user-1/p/proj-1/img/p1.webp', 'u/user-1/p/proj-1/ref/face.webp', 'u/user-1/p/proj-1/img/bad.webp', 'u/user-1/p/proj-1/img/bad_w480.webp', 'u/other/secret.webp', 'u/other/p/x/ref/r.webp', 42] }
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Object.keys((await res.json()).urls).sort()).toEqual(['u/user-1/p/proj-1/img/p1.webp', 'u/user-1/p/proj-1/ref/face.webp']);
    const privateCall = assets.signed.findIndex((paths) => paths.includes('u/user-1/p/proj-1/ref/face.webp'));
    expect(assets.signed[privateCall]).toEqual(['u/user-1/p/proj-1/ref/face.webp']);
    expect(assets.signedTtl[privateCall]).toBe(300);
    const publicCall = assets.signed.findIndex((paths) => paths.includes('u/user-1/p/proj-1/img/p1.webp'));
    expect(assets.signedTtl[publicCall]).toBeUndefined();
    expect((await api('/api/comic/projects/proj-1/urls', { user: 'user-1', body: {} })).status).toBe(400);
  });

  it('GET /projects/:id signs display paths only (no history) and never a blocked asset', async () => {
    const doc = plannedDoc();
    const old = { path: 'u/user-1/p/proj-1/img/old.webp', source: 'generated' as const, at: 1 };
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 2 }, history: [old] };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 2, safety: BLOCKED } };
    seed(doc);
    const body = await (await api('/api/comic/projects/proj-1', { user: 'user-1' })).json();
    expect(Object.keys(body.urls)).toEqual(['u/user-1/p/proj-1/img/p1.webp']);
    expect([...blockedAssetPaths(doc)]).toEqual(['u/user-1/p/proj-1/img/cover.webp']);
  });
});

describe('IDOR: every /projects/:id route needs the JWT owner', () => {
  const routes: { name: string; method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
    { name: 'GET project', method: 'GET', path: '/api/comic/projects/proj-1' },
    { name: 'cancel', method: 'POST', path: '/api/comic/projects/proj-1/cancel', body: {} },
    { name: 'urls', method: 'POST', path: '/api/comic/projects/proj-1/urls', body: { paths: ['u/user-1/p/proj-1/img/p1.webp'] } },
    { name: 'stream message', method: 'POST', path: '/api/comic/projects/proj-1/stream', body: { kind: 'message', text: 'rename it to Owned', userId: 'user-1' } },
    { name: 'stream patch', method: 'POST', path: '/api/comic/projects/proj-1/stream', body: { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Owned' } }] }, userId: 'user-1' } },
    { name: 'stream spend', method: 'POST', path: '/api/comic/projects/proj-1/stream', body: { kind: 'action', action: { type: 'render_cover' } } },
    { name: 'stream publish', method: 'POST', path: '/api/comic/projects/proj-1/stream', body: { kind: 'action', action: { type: 'unpublish' } } }
  ];

  it.each(routes)('$name: anonymous → 401, another user → the same 404 as a missing project, nothing changes', async ({ method, path, body }) => {
    const doc = seed();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 } };
    const init = { method, ...(body !== undefined ? { body } : {}) };
    const anon = await api(path, init);
    expect(anon.status).toBe(401);
    const intruder = await api(path, { ...init, user: 'intruder' });
    const missing = await api(path.replace('proj-1', 'proj-404'), { ...init, user: 'intruder' });
    expect(intruder.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await intruder.text()).toBe(await missing.text());
    expect(llm.calls).toHaveLength(0);
    expect(images.calls).toHaveLength(0);
    expect(assets.signed).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect(store.docs.get('proj-1')!.doc.brief.title).toBe('Spice Run');
    expect(peekStudioSession('proj-1')?.abort.signal.aborted ?? false).toBe(false);
  });

  it('the owner id comes from the token, never the body', async () => {
    seed(plannedDoc(), 'victim');
    const res = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Pwned' } }] }, userId: 'victim', user: 'victim' }, 'attacker');
    expect(res.res.status).toBe(404);
    expect(store.docs.get('proj-1')!.doc.brief.title).toBe('Spice Run');
  });
});

describe('refusals before anything is persisted', () => {
  it('a cooldown refuses messages and spend with a COOLDOWN event; free edits still work', async () => {
    seed();
    cooldown = { until: Date.now() + 9 * 60_000 };
    const image = { name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    const msg = await stream('proj-1', { kind: 'message', text: 'draw a dragon', attachments: [image] });
    expect(msg.events.map((e) => e.type)).toEqual(['hello', 'error', 'done']);
    expect(msg.events[1]).toMatchObject({ code: 'COOLDOWN', message: expect.stringContaining('9 min') });
    const spend = await stream('proj-1', { kind: 'action', action: { type: 'render_cover' } });
    expect(spend.events[1]).toMatchObject({ code: 'COOLDOWN' });
    expect(llm.calls).toHaveLength(0);
    expect(images.calls).toHaveLength(0);
    expect(assets.files.size).toBe(0); // the upload was never stored
    expect(store.docs.get('proj-1')!.doc.conversation).toEqual([]);
    const edit = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Still editable' } }] } });
    expect(edit.events.map((e) => e.type)).toEqual(['hello', 'ops', 'done']);
    // Each refusal left one structured log line with codes only — never the user's text.
    const lines = refusals();
    expect(lines.map((l) => l.code)).toEqual(['COOLDOWN', 'COOLDOWN']);
    expect(lines[0]).toMatchObject({ projectId: 'proj-1', userId: 'user-1', stage: 'stream', kind: 'message' });
    expect(lines[1]).toMatchObject({ kind: 'action', action: 'render_cover' });
    expect(JSON.stringify(lines)).not.toContain('dragon');
    // An expired cooldown no longer applies.
    cooldown = { until: Date.now() - 1 };
    llm.script.director = [{ text: 'Back.' }];
    expect((await stream('proj-1', { kind: 'message', text: 'hi' })).events.some((e) => e.type === 'delta')).toBe(true);
  });

  it('a restricted account cannot spend, upload or publish, but can read, edit and chat', async () => {
    const doc = seed();
    doc.settings.confirm = 'never';
    moderation = 'restricted';
    const spend = await stream('proj-1', { kind: 'action', action: { type: 'render_cover' } });
    expect(spend.events[1]).toMatchObject({ code: 'FORBIDDEN', message: RESTRICTED_SPEND_MESSAGE });
    const gate = await stream('proj-1', { kind: 'action', action: { type: 'approve_gate', gateId: 'g1' } });
    expect(gate.events[1]).toMatchObject({ code: 'FORBIDDEN' });
    const publish = await stream('proj-1', { kind: 'action', action: { type: 'publish', request: { visibility: 'public' } } });
    expect(publish.events[1]).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('publishing is paused') });
    const upload = await stream('proj-1', { kind: 'message', text: 'here', attachments: [{ name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
    expect(upload.events[1]).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('uploads are paused') });
    expect(assets.files.size).toBe(0);
    expect(images.calls).toHaveLength(0);
    expect(refusals().map((l) => l.code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);

    const edit = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Edited' } }] } });
    expect(edit.events.map((e) => e.type)).toEqual(['hello', 'ops', 'done']);
    expect((await api('/api/comic/projects/proj-1', { user: 'user-1' })).status).toBe(200);

    // A chat turn runs, but the director's draw request can't reserve image spend.
    llm.script.director = [
      { toolCalls: [{ id: 't1', name: 'render_cover', arguments: '{}' }] },
      { text: 'I tried the cover.' }
    ];
    const chat = await stream('proj-1', { kind: 'message', text: 'draw the cover now please' });
    expect(chat.events[chat.events.length - 1].type).toBe('done');
    expect(images.calls).toHaveLength(0);
    expect(vi.mocked(runDirectorTurn).mock.calls[0][0]).toMatchObject({ spendBlocked: RESTRICTED_SPEND_MESSAGE });
  });

  it('pre-stream refusals (401, 400, 404, stale inbox path) are logged without user text', async () => {
    seed();
    expect((await stream('proj-1', { kind: 'message', text: 'secret plot' }, '')).res.status).toBe(401);
    expect((await stream('proj-1', { kind: 'message', text: 'x'.repeat(60_001) })).res.status).toBe(400);
    expect((await stream('proj-404', { kind: 'message', text: 'secret plot' })).res.status).toBe(404);
    expect((await stream('proj-1', { kind: 'message', text: 'see', attachments: [{ inboxPath: 'u/user-1/p/proj-1/ref/not-in-inbox.webp' }] })).res.status).toBe(400);
    const lines = refusals();
    expect(lines.map((l) => [l.code, l.status, l.stage])).toEqual([
      ['FORBIDDEN', 401, 'pre_stream'],
      ['BAD_REQUEST', 400, 'pre_stream'],
      ['NOT_FOUND', 404, 'pre_stream'],
      ['BAD_REQUEST', 400, 'pre_stream']
    ]);
    expect(lines[2]).toMatchObject({ projectId: 'proj-404', userId: 'user-1', kind: 'message' });
    expect(JSON.stringify(lines)).not.toContain('secret plot');
    expect(JSON.stringify(lines)).not.toContain('not-in-inbox');
    expect(store.docs.get('proj-1')!.doc.conversation).toEqual([]);
  });

  it('a suspended account is refused by the moderation gate, and the refusal is logged (codes only)', async () => {
    seed();
    moderation = 'suspended';
    const res = await api('/api/comic/projects/proj-1/stream', { user: 'user-1', body: { kind: 'message', text: 'secret plot' } });
    expect(res.status).toBe(403);
    await res.text();
    const created = await api('/api/comic/projects', { user: 'user-1', body: { title: 'Secret title' } });
    expect(created.status).toBe(403);
    await created.text();
    expect(store.docs.size).toBe(1); // no project was created
    expect(refusals()).toEqual([expect.objectContaining({ code: 'FORBIDDEN', status: 403, stage: 'pre_stream', reason: 'moderation', kind: 'message', projectId: 'proj-1', userId: 'user-1' })]);
    const created403 = infoLines().filter((l) => l.event === 'comic_request_refused');
    expect(created403).toEqual([expect.objectContaining({ code: 'FORBIDDEN', status: 403, reason: 'moderation', method: 'POST', userId: 'user-1' })]);
    expect(JSON.stringify(infoLines())).not.toMatch(/secret plot|Secret title/);
  });

  it('non-stream studio refusals (open, sign, cancel, import) leave one structured line with the route pattern', async () => {
    seed();
    expect((await api('/api/comic/projects/proj-1', { user: 'intruder' })).status).toBe(404);
    expect((await api('/api/comic/projects/proj-1/urls', { user: 'user-1', body: {} })).status).toBe(400);
    expect((await api('/api/comic/projects/proj-1/cancel', { body: {} })).status).toBe(401);
    expect((await api('/api/comic/projects', { user: 'user-1', body: { importFromProjectId: 'someone-elses' } })).status).toBe(404);
    const lines = infoLines().filter((l) => l.event === 'comic_request_refused');
    expect(lines.map((l) => [l.method, l.route, l.code, l.status, l.userId])).toEqual([
      ['GET', '/projects/:id', 'NOT_FOUND', 404, 'intruder'],
      ['POST', '/projects/:id/urls', 'BAD_REQUEST', 400, 'user-1'],
      ['POST', '/projects/:id/cancel', 'FORBIDDEN', 401, null],
      ['POST', '/projects', 'NOT_FOUND', 404, 'user-1']
    ]);
    expect(lines[0].projectId).toBe('proj-1');
    expect(JSON.stringify(lines)).not.toContain('someone-elses');
  });

  it('isCostlyRequest / restrictedRefusal classify requests', () => {
    expect(isCostlyRequest({ kind: 'message', text: 'hi' })).toBe(true);
    expect(isCostlyRequest({ kind: 'action', action: { type: 'patch', ops: [] } })).toBe(false);
    expect(isCostlyRequest({ kind: 'action', action: { type: 'plan_pages' } })).toBe(true);
    expect(isCostlyRequest({ kind: 'action', action: { type: 'relayout_balloons', pageId: 'p' } })).toBe(false);
    expect(isCostlyRequest({ kind: 'action', action: { type: 'relayout_balloons', pageId: 'p', useVision: true } })).toBe(true);
    expect(restrictedRefusal({ kind: 'message', text: 'hi', attachments: [{ inboxPath: 'u/x/p/y/ref/a.webp' }] })).toBeNull();
    expect(restrictedRefusal({ kind: 'action', action: { type: 'unpublish' } })).toBeNull();
    // A new link re-publishes the comic: refused like publish (the REST route refuses it too).
    expect(restrictedRefusal({ kind: 'action', action: { type: 'regenerate_link' } })).toContain('publishing is paused');
    expect(restrictedRefusal({ kind: 'action', action: { type: 'translate', languages: ['te'] } })).toBe(RESTRICTED_SPEND_MESSAGE);
    // The paid page re-check (lettering.md §9) and its legacy alias are spends; the free re-layout is not.
    expect(restrictedRefusal({ kind: 'action', action: { type: 'recheck_page', pageId: 'p' } })).toBe(RESTRICTED_SPEND_MESSAGE);
    expect(restrictedRefusal({ kind: 'action', action: { type: 'relayout_balloons', pageId: 'p', useVision: true } })).toBe(RESTRICTED_SPEND_MESSAGE);
    expect(restrictedRefusal({ kind: 'action', action: { type: 'relayout_balloons', pageId: 'p' } })).toBeNull();
    expect(isCostlyRequest({ kind: 'action', action: { type: 'recheck_page', pageId: 'p' } })).toBe(true);
  });
});

describe('message pipeline: screen → intent router → director', () => {
  it('a blocked message gets the deterministic reply: hidden text, no model call, nothing of it kept', async () => {
    seed();
    screen = async () => ({ decision: 'block', categories: ['graphic_gore'], strike: 1, blockedAttachmentPaths: [] });
    const long = 'GORY SCRIPT '.repeat(600);
    const { events } = await stream('proj-1', { kind: 'message', text: long });
    expect(events[events.length - 1].type).toBe('done');
    expect(llm.calls).toHaveLength(0);
    expect(runDirectorTurn).not.toHaveBeenCalled();
    const doc = store.docs.get('proj-1')!.doc;
    expect(doc.conversation[0]).toMatchObject({ role: 'user', text: HIDDEN_MESSAGE_TEXT });
    expect(doc.conversation[0].id).toBe(blockedResponses[0]);
    expect(doc.conversation[1]).toMatchObject({ role: 'assistant' });
    expect(doc.conversation[1].text.length).toBeGreaterThan(0);
    expect(doc.source.script).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('GORY');
    const line = refusals().find((l) => l.code === 'CONTENT_POLICY');
    expect(line).toMatchObject({ categories: ['graphic_gore'], strike: 1 });
    expect(JSON.stringify(line)).not.toContain('GORY');
  });

  it('adapt passes the safety note to the director; blocked images are dropped from the turn', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref('u/user-1/p/proj-1/ref/ok.webp'), ref('u/user-1/p/proj-1/ref/bad.webp'), ref('u/user-1/p/proj-1/ref/keep.webp')];
    seed(doc);
    screen = async () => ({ decision: 'adapt', categories: ['violence'], note: 'SAFETY NOTE: keep it spooky, not gory.', strike: 0, blockedAttachmentPaths: ['u/user-1/p/proj-1/ref/bad.webp'] });
    llm.script.director = [{ text: 'Spooky, not gory.' }];
    await stream('proj-1', { kind: 'message', text: 'zombie ambush', attachments: [{ inboxPath: 'u/user-1/p/proj-1/ref/ok.webp' }, { inboxPath: 'u/user-1/p/proj-1/ref/bad.webp' }] });
    const input = vi.mocked(runDirectorTurn).mock.calls[0][1];
    expect(input.safetyNote).toBe('SAFETY NOTE: keep it spooky, not gory.');
    expect(input.attachments.map((a) => a.path)).toEqual(['u/user-1/p/proj-1/ref/ok.webp']);
    expect(input.text).toContain("One image was removed");
    const saved = store.docs.get('proj-1')!.doc;
    // Both sent images left the inbox; the untouched one stays.
    expect((saved.refInbox || []).map((r) => r.path)).toEqual(['u/user-1/p/proj-1/ref/keep.webp']);
  });

  it('a crashing screen fails open for the owner turn (logged), never silently', async () => {
    seed();
    screen = async () => {
      throw new Error('classifier down');
    };
    llm.script.director = [{ text: 'On it.' }];
    const { events } = await stream('proj-1', { kind: 'message', text: 'hello' });
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('comic_screen_failed_open'))).toBe(true);
  });

  it('the intent router answers read-only requests for $0 with no model call', async () => {
    seed();
    intent = (text) =>
      /show me the pages/i.test(text)
        ? { kind: 'show_pages', reply: '3 pages, 9 panels.', cards: [noticeCard('info', 'breakdown')], nextSteps: [] }
        : null;
    const { events } = await stream('proj-1', { kind: 'message', text: 'show me the pages' });
    expect(events.map((e) => e.type)).toEqual(['hello', 'ops', 'done']);
    expect(llm.calls).toHaveLength(0);
    expect(runDirectorTurn).not.toHaveBeenCalled();
    expect((events[2] as { spentUsd: number }).spentUsd).toBe(0);
    const convo = store.docs.get('proj-1')!.doc.conversation;
    expect(convo.map((m) => [m.role, m.text])).toEqual([
      ['user', 'show me the pages'],
      ['assistant', '3 pages, 9 panels.']
    ]);
    expect(convo[1].cards).toHaveLength(1);
    expect(infoLines().some((l) => l.event === 'comic_intent_routed' && l.kind === 'show_pages')).toBe(true);
    // Anything else goes to the director.
    llm.script.director = [{ text: 'Sure.' }];
    await stream('proj-1', { kind: 'message', text: 'make Maya taller' });
    expect(runDirectorTurn).toHaveBeenCalledTimes(1);
  });

  it('the real intent hook makes no LLM call for "show me the pages"', async () => {
    seed();
    const { events } = await stream('proj-1', { kind: 'message', text: 'show me the pages' });
    expect(events[events.length - 1].type).toBe('done');
    expect(llm.calls).toHaveLength(0);
    const convo = store.docs.get('proj-1')!.doc.conversation;
    expect(convo[convo.length - 1].role).toBe('assistant');
    expect(convo[convo.length - 1].text.length).toBeGreaterThan(0);
  });

  it('the intent router is skipped when images are attached', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref('u/user-1/p/proj-1/ref/a.webp')];
    seed(doc);
    intent = () => ({ kind: 'show_pages', reply: 'nope', cards: [], nextSteps: [] });
    llm.script.director = [{ text: 'Nice photo.' }];
    await stream('proj-1', { kind: 'message', text: 'show me the pages', attachments: [{ inboxPath: 'u/user-1/p/proj-1/ref/a.webp' }] });
    expect(runDirectorTurn).toHaveBeenCalledTimes(1);
  });

  it('focus reaches the director', async () => {
    seed();
    llm.script.director = [{ text: 'Done.' }];
    await stream('proj-1', { kind: 'message', text: 'make these balloons red', focus: { pageId: 'pg_1', lineIds: ['ln_1_2'], surface: 'page_editor' } });
    expect(vi.mocked(runDirectorTurn).mock.calls[0][1].focus).toEqual({ pageId: 'pg_1', lineIds: ['ln_1_2'], surface: 'page_editor' });
  });
});

describe('inbox attachments and quick-assign', () => {
  it('takes images from the inbox into the message and assigns them to the cast', async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref('u/user-1/p/proj-1/ref/dog.webp'), ref('u/user-1/p/proj-1/ref/maya.webp')];
    seed(doc);
    llm.script.director = [{ text: 'Got Biscuit and Maya.' }];
    const { events } = await stream('proj-1', {
      kind: 'message',
      text: 'these are my characters',
      attachments: [{ inboxPath: 'u/user-1/p/proj-1/ref/dog.webp' }, { inboxPath: 'u/user-1/p/proj-1/ref/maya.webp' }],
      attachmentTargets: [{ kind: 'new_character', name: 'Biscuit', castKind: 'animal' }, { kind: 'character', id: 'c_maya' }]
    });
    expect(events[events.length - 1].type).toBe('done');
    const saved = store.docs.get('proj-1')!.doc;
    expect(saved.refInbox || []).toEqual([]);
    const biscuit = saved.cast.find((c) => c.name === 'Biscuit')!;
    expect(biscuit.kind).toBe('animal');
    expect(biscuit.refs.map((r) => r.path)).toEqual(['u/user-1/p/proj-1/ref/dog.webp']);
    expect(saved.cast.find((c) => c.id === 'c_maya')!.refs.map((r) => r.path)).toEqual(['u/user-1/p/proj-1/ref/maya.webp']);
    const userMsg = saved.conversation.find((m) => m.role === 'user')!;
    expect(userMsg.attachments!.map((a) => a.path)).toEqual(['u/user-1/p/proj-1/ref/dog.webp', 'u/user-1/p/proj-1/ref/maya.webp']);
    expect(userMsg.text).toContain('[Photos assigned:');
  });

  it("a path that isn't in this project's inbox is a 400 and nothing is committed", async () => {
    const doc = plannedDoc();
    doc.refInbox = [ref('u/user-1/p/proj-1/ref/mine.webp')];
    seed(doc);
    const res = await stream('proj-1', { kind: 'message', text: 'x', attachments: [{ inboxPath: 'u/user-1/p/proj-1/ref/mine.webp' }, { inboxPath: 'u/victim/p/other/ref/theirs.webp' }] });
    expect(res.res.status).toBe(400);
    const saved = store.docs.get('proj-1')!.doc;
    expect((saved.refInbox || []).map((r) => r.path)).toEqual(['u/user-1/p/proj-1/ref/mine.webp']);
    expect(saved.conversation).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('allowance notices', () => {
  it('commit an assistant message with text, never an empty bubble', async () => {
    seed();
    const local = express();
    local.use(express.json());
    local.use((req, _res, next) => {
      req.user = { id: 'user-1' };
      req.allowanceNotices = [{ level: 'warn', message: "You've used 80% of your monthly DreamStream allowance — resets Nov 1." }] as never;
      next();
    });
    local.use('/api/comic', createComicRouter({
      store,
      assets,
      contextDeps: () => ({ keys: KEYS, llm, images: images.generate, billing: fakeBilling() }),
      qualityAccess: async () => ({ ok: true }),
      capsDeps: { billingEnabled: false, isAdminFor: async () => false, accountCeilingFor: async () => 'PG-13' },
      requireActive: (_req, _res, next) => next(),
      safety: { cooldownFor: async () => null, screenTurnInput: async () => ALLOW },
      heartbeatMs: 20
    }));
    const srv = local.listen(0);
    await new Promise<void>((r) => srv.once('listening', () => r()));
    try {
      const port = (srv.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/comic/projects/proj-1/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'T' } }] } })
      });
      await res.text();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    const convo = store.docs.get('proj-1')!.doc.conversation;
    const last = convo[convo.length - 1];
    expect(last).toMatchObject({ role: 'assistant', text: expect.stringContaining('80% of your monthly') });
    expect(convo.every((m) => m.text.trim().length > 0)).toBe(true);
  });
});

describe('P2-SERVER route integration', () => {
  it('UI actions commit with origin "user" (their own undo); caps carry usage (percentages only) and governed text has no dollars', async () => {
    usage = { governed: true, pctLeft: 64, exhausted: false, pctPerStandardPage: 1.5 };
    const doc = seed();
    doc.settings.confirm = 'always';
    doc.planStatus = 'approved';
    const body = await (await api('/api/comic/projects/proj-1', { user: 'user-1' })).json();
    expect(body.caps.usage).toEqual(usage);
    expect(JSON.stringify(body.caps)).not.toMatch(/usd|\$/i);
    const edit = await stream('proj-1', { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Renamed' } }] } });
    expect(edit.events.find((e) => e.type === 'ops')).toMatchObject({ origin: 'user' });
    // A click on "Draw the cover": the progress and completion messages word the price as usage.
    const drawn = await stream('proj-1', { kind: 'action', action: { type: 'render_cover' } });
    expect(drawn.events.at(-1)).toMatchObject({ type: 'done', spentUsd: expect.any(Number) });
    const saved = store.docs.get('proj-1')!.doc;
    const said = saved.conversation.filter((m) => m.role === 'assistant').map((m) => m.text);
    expect(said.length).toBeGreaterThan(0);
    for (const t of said) expect(t).not.toMatch(/\$/);
    expect(said.join(' ')).toMatch(/% of your usage/);
  });

  it('COMIC_FAST_INTENTS: "swap pages 2 and 3" runs its one free tool — no model call, an Undo chip, one user + one reply', async () => {
    fast = true;
    seed();
    const { events } = await stream('proj-1', { kind: 'message', text: 'swap pages 2 and 3' });
    expect(events.at(-1)!.type).toBe('done');
    expect(vi.mocked(runDirectorTurn)).not.toHaveBeenCalled();
    expect(llm.calls).toHaveLength(0);
    const doc = store.docs.get('proj-1')!.doc;
    expect(doc.pages.find((p) => p.id === 'pg_3')!.n).toBe(2);
    const [user, reply] = doc.conversation.slice(-2);
    expect(user).toMatchObject({ role: 'user', text: 'swap pages 2 and 3' });
    expect(reply.role).toBe('assistant');
    expect(reply.text).toMatch(/\S/);
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Undo', client: { type: 'undo' } });
    // Off (the default): the same words go to the director.
    fast = false;
    llm.script.director = [{ text: 'Done.' }];
    await stream('proj-1', { kind: 'message', text: 'swap pages 2 and 3' });
    expect(vi.mocked(runDirectorTurn)).toHaveBeenCalledTimes(1);
  });

  it('opening a project backfills missing size variants in the background (≤ 40, once per session) and publishes their urls', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 2, w: 2048, h: 3072 } };
    seed(doc);
    await api('/api/comic/projects/proj-1', { user: 'user-1' });
    await vi.waitFor(() => expect(peekStudioSession('proj-1')!.doc.pages[0].render.asset!.variants?.map((v) => v.w)).toEqual([480, 1080]));
    // Once per session: a second open does not re-run it.
    const signedBefore = assets.signed.length;
    await api('/api/comic/projects/proj-1', { user: 'user-1' });
    expect(assets.signed.length).toBe(signedBefore + 1); // only the display signing
  });
});
