// @vitest-environment node
// A2 TURN (agent-editor plan §3 A2, §4 wave 1) through the real router: the BUSY race is closed by a synchronous turn
// reservation (G19, regardless of flags), and POST /projects/:id/steer (COMIC_STEER) screens a note like a chat
// message, commits it as a `steered` user message and hands it to the running director turn.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEER_LIMITS, type StudioEvent } from '../../../shared/comic/events.js';
import type { ContentRating } from '../../../shared/comic/safety.js';
import type { RefAsset } from '../../../shared/comic/doc.js';
import { __resetAccessCacheForTests } from '../comic/access.js';
import { __resetSessionsForTests, peekStudioSession } from '../comic/session.js';
import type { ScreenResult } from '../comic/safety/index.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, plannedDoc, scriptedLlm, type FakeAssetStore, type FakeDocStore, type ScriptedLlm } from '../comic/orchestrator.fakes.js';
import { registryPriceBook } from '../comic/models/index.js';
import { __setModelHealthForTests, type ModelHealthPort } from '../comic/models/health.js';
import { fakeModelHealth } from '../comic/models/health.fakes.js';
import { LONG_MESSAGE_CHARS } from '../comic/session.js';
import {
  MAX_STEER_CHARS,
  STEER_BLOCKED_MESSAGE,
  STEER_FULL_MESSAGE,
  STEER_NOT_RUNNING_MESSAGE,
  STEER_OFF_MESSAGE,
  createComicRouter,
  parseSteerRequest
} from './comic.js';

let store: FakeDocStore;
let assets: FakeAssetStore;
let llm: ScriptedLlm;
let moderation: 'active' | 'suspended';
/** What cooldownFor answers next (a function, so a test can hold one call open). */
let cooldown: (userId: string) => Promise<{ until: number } | null>;
let cooldownCalls: number;
let screen: (input: { text: string; attachments: RefAsset[]; rating: ContentRating }) => Promise<ScreenResult>;
let screenCalls: string[];
/** The COMIC_STEER stage the caps read (unset = the D2 default, off). */
let steerStage: string | undefined;
let realHealth: ModelHealthPort;

const ALLOW: ScreenResult = { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use((req, _res, next) => {
  const user = req.header('x-test-user');
  if (user) req.user = { id: user };
  next();
});
app.use('/api/comic', (req, res, next) =>
  createComicRouter({
    store,
    assets,
    contextDeps: () => ({ keys: KEYS, llm, images: fakeImages().generate, billing: fakeBilling(), prices: async () => registryPriceBook() }),
    qualityAccess: async () => ({ ok: true }),
    capsDeps: {
      billingEnabled: true,
      planFor: async () => 'free',
      isAdminFor: async () => false,
      accountCeilingFor: async () => 'PG-13',
      env: { COMIC_STEER: steerStage }
    },
    requireActive: (_req, res, next) => {
      if (moderation === 'suspended') {
        res.status(403).json({ error: { message: 'This account is suspended.', code: 'FORBIDDEN' } });
        return;
      }
      res.locals.moderationStatus = 'active';
      next();
    },
    safety: {
      cooldownFor: async (userId) => {
        cooldownCalls += 1;
        return cooldown(userId);
      },
      screenTurnInput: async (_ctx, input) => {
        screenCalls.push(input.text);
        return screen(input);
      },
      respondBlocked: async () => undefined
    },
    usageFor: async () => undefined,
    fastIntents: false,
    backfillVariants: false,
    heartbeatMs: 20
  })(req, res, next)
);

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  store = fakeDocStore();
  assets = fakeAssetStore();
  llm = scriptedLlm();
  moderation = 'active';
  cooldown = async () => null;
  cooldownCalls = 0;
  screen = async () => ALLOW;
  screenCalls = [];
  steerStage = 'all';
  __resetAccessCacheForTests();
  realHealth = __setModelHealthForTests(fakeModelHealth());
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  __resetSessionsForTests();
  __setModelHealthForTests(realHealth);
  vi.restoreAllMocks();
});

const seed = () => {
  const doc = plannedDoc();
  store.docs.set(doc.id, { userId: 'user-1', doc });
  return doc;
};
const post = (path: string, body: unknown, user = 'user-1') =>
  fetch(`${base}/api/comic${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) });
const parseSse = (body: string): StudioEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.trim() && !block.startsWith(':'))
    .map((block) => JSON.parse(block.split('\n')[1].slice(6)) as StudioEvent);
const stream = async (projectId: string, body: unknown) => {
  const res = await post(`/projects/${projectId}/stream`, body);
  return res.headers.get('content-type')?.includes('text/event-stream') ? parseSse(await res.text()) : [];
};
const steer = async (projectId: string, body: unknown, user = 'user-1') => {
  const res = await post(`/projects/${projectId}/steer`, body, user);
  return { status: res.status, json: (await res.json()) as { ok?: boolean; msgId?: string; error?: { code?: string; message?: string } } };
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
/** Resolves once `check` holds (polled on the event loop; the stream request runs in the same process). */
const until = async (check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i += 1) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
};
const conversation = (projectId: string) => (peekStudioSession(projectId)?.doc ?? store.docs.get(projectId)!.doc).conversation;

describe('the BUSY race (G19): the check and the reservation are one synchronous step, whatever the flags', () => {
  it('a second message while the first still awaits its cooldown lookup is BUSY (before: both passed the check)', async () => {
    steerStage = undefined; // steering off: the race fix does not depend on it
    const doc = seed();
    const held = deferred<{ until: number } | null>();
    cooldown = () => (cooldownCalls === 1 ? held.promise : Promise.resolve(null));
    llm.script.director = [{ text: 'First done.' }, { text: 'Second done.' }];
    const first = stream(doc.id, { kind: 'message', text: 'one' });
    await until(() => cooldownCalls === 1);
    const second = await stream(doc.id, { kind: 'message', text: 'two' });
    expect(second.map((e) => e.type)).toEqual(['hello', 'error', 'done']);
    expect(second[1]).toMatchObject({ code: 'BUSY' });
    held.resolve(null);
    const firstEvents = await first;
    expect(firstEvents.some((e) => e.type === 'error')).toBe(false);
    expect(conversation(doc.id).map((m) => m.text)).toEqual(['one', 'First done.']);
    // Released once the turn ended: the next message runs.
    const third = await stream(doc.id, { kind: 'message', text: 'three' });
    expect(third.some((e) => e.type === 'error')).toBe(false);
    expect(peekStudioSession(doc.id)!.turnRunning).toBe(false);
  });

  it('a refused message (COOLDOWN) releases its reservation: the next message is not BUSY', async () => {
    const doc = seed();
    cooldown = async () => ({ until: Date.now() + 60_000 });
    const refused = await stream(doc.id, { kind: 'message', text: 'one' });
    expect(refused[1]).toMatchObject({ type: 'error', code: 'COOLDOWN' });
    cooldown = async () => null;
    llm.script.director = [{ text: 'Back.' }];
    const next = await stream(doc.id, { kind: 'message', text: 'two' });
    expect(next.filter((e) => e.type === 'error')).toEqual([]);
    expect(peekStudioSession(doc.id)!.turnRunning).toBe(false);
  });

  it('a message that fails before streaming (a stale upload, 400) releases its reservation', async () => {
    const doc = seed();
    const bad = await post(`/projects/${doc.id}/stream`, { kind: 'message', text: 'see photo', attachments: [{ inboxPath: 'user-1/proj/inbox/missing.webp' }] });
    expect(bad.status).toBe(400);
    expect(peekStudioSession(doc.id)!.turnRunning).toBe(false);
    llm.script.director = [{ text: 'Ok.' }];
    const next = await stream(doc.id, { kind: 'message', text: 'two' });
    expect(next.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('actions never reserve: a free edit during a reserved message still runs', async () => {
    const doc = seed();
    const held = deferred<{ until: number } | null>();
    cooldown = () => (cooldownCalls === 1 ? held.promise : Promise.resolve(null));
    const first = stream(doc.id, { kind: 'message', text: 'one' });
    await until(() => cooldownCalls === 1);
    const edit = await stream(doc.id, { kind: 'action', action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Renamed' } }] } });
    expect(edit.filter((e) => e.type === 'error')).toEqual([]);
    held.resolve(null);
    await first;
    expect(peekStudioSession(doc.id)!.doc.brief.title).toBe('Renamed');
  });
});

describe('POST /projects/:id/steer', () => {
  /** Start a message whose first model call waits for `release`; resolves once that call is out. */
  const startTurn = async (projectId: string, after: () => { text: string }) => {
    const gate = deferred<void>();
    const out = deferred<void>();
    llm.script.director = [
      async () => {
        out.resolve();
        await gate.promise;
        return after();
      }
    ];
    const done = stream(projectId, { kind: 'message', text: 'Make the market busier' });
    await out.promise;
    return { release: () => gate.resolve(), done };
  };

  it('with a director turn running: screened, committed as a steered user message, read by the director (one extra round)', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Busier it is.' }));
    llm.script.director!.push({ text: 'And it rains now.' });
    const res = await steer(doc.id, { text: 'add rain', focus: { pageId: doc.pages[0].id, bogus: 1 } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, msgId: expect.stringMatching(/^msg_/) });
    expect(screenCalls).toEqual(['Make the market busier', 'add rain']);
    // Committed at once (the stream's subscribers see it now), marked steered.
    const steered = conversation(doc.id).find((m) => m.id === res.json.msgId)!;
    expect(steered).toMatchObject({ role: 'user', text: 'add rain', steered: true });
    turn.release();
    const events = await turn.done;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(llm.calls.filter((c) => c.role === 'director')).toHaveLength(2);
    const note = llm.calls.filter((c) => c.role === 'director')[1].messages.at(-1)!;
    expect(String(note.content)).toMatch(/^\(The user added while you were working:\) add rain\nFocus: the user is looking at page 1/);
    expect(conversation(doc.id).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Make the market busier'],
      ['user', 'add rain'],
      ['assistant', 'Busier it is.\n\nAnd it rains now.']
    ]);
  });

  it('with no director turn running: 409 NOT_RUNNING, nothing committed, nothing screened', async () => {
    const doc = seed();
    const before = conversation(doc.id).length;
    const res = await steer(doc.id, { text: 'add rain' });
    expect(res.status).toBe(409);
    expect(res.json.error).toEqual({ code: 'NOT_RUNNING', message: STEER_NOT_RUNNING_MESSAGE });
    expect(screenCalls).toEqual([]);
    expect(conversation(doc.id)).toHaveLength(before);
  });

  it('a reserved message that has not reached the director yet is NOT_RUNNING too (the client queues the note)', async () => {
    const doc = seed();
    const held = deferred<{ until: number } | null>();
    cooldown = () => (cooldownCalls === 1 ? held.promise : Promise.resolve(null));
    llm.script.director = [{ text: 'Done.' }];
    const first = stream(doc.id, { kind: 'message', text: 'one' });
    await until(() => cooldownCalls === 1);
    expect((await steer(doc.id, { text: 'two' })).json.error?.code).toBe('NOT_RUNNING');
    held.resolve(null);
    await first;
  });

  it('the steer text is screened like a chat message: a block answers 422 CONTENT_POLICY and keeps nothing', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    screen = async (input) => (input.text.includes('forbidden') ? { decision: 'block', categories: ['graphic_gore'], strike: 3, blockedAttachmentPaths: [], note: 'x' } : ALLOW);
    const before = conversation(doc.id).length;
    const res = await steer(doc.id, { text: 'something forbidden' });
    expect(res.status).toBe(422);
    expect(res.json.error).toEqual({ code: 'CONTENT_POLICY', message: STEER_BLOCKED_MESSAGE });
    expect(conversation(doc.id)).toHaveLength(before);
    turn.release();
    await turn.done;
    // The director never saw it: one model call, no note.
    expect(llm.calls.filter((c) => c.role === 'director')).toHaveLength(1);
    expect(JSON.stringify(llm.calls)).not.toContain('forbidden');
  });

  it('an adapt verdict passes the safety note along with the note', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    llm.script.director!.push({ text: 'Done.' });
    screen = async (input) => (input.text === 'make it gory' ? { decision: 'adapt', categories: ['graphic_gore'], strike: 0, blockedAttachmentPaths: [], note: 'SAFETY NOTE: keep it PG-13.' } : ALLOW);
    expect((await steer(doc.id, { text: 'make it gory' })).status).toBe(200);
    turn.release();
    await turn.done;
    expect(String(llm.calls.filter((c) => c.role === 'director')[1].messages.at(-1)!.content)).toBe(
      '(The user added while you were working:) make it gory\nSAFETY NOTE: keep it PG-13.'
    );
  });

  it(`holds at most ${STEER_LIMITS.inbox} waiting notes: the next is 409 BUSY and not committed`, async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    for (let i = 0; i < STEER_LIMITS.inbox; i += 1) expect((await steer(doc.id, { text: `note ${i}` })).status).toBe(200);
    const full = await steer(doc.id, { text: 'one too many' });
    expect(full.status).toBe(409);
    expect(full.json.error?.code).toBe('BUSY');
    expect(conversation(doc.id).some((m) => m.text === 'one too many')).toBe(false);
    expect(screenCalls).not.toContain('one too many');
    turn.release();
    await turn.done;
  });

  it('COMIC_STEER off (the default): 501 NOT_AVAILABLE even while a turn runs, nothing screened or committed', async () => {
    steerStage = undefined;
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    const res = await steer(doc.id, { text: 'add rain' });
    expect(res.status).toBe(501);
    expect(res.json.error).toEqual({ code: 'NOT_AVAILABLE', message: STEER_OFF_MESSAGE });
    expect(screenCalls).toEqual(['Make the market busier']);
    turn.release();
    await turn.done;
    expect(conversation(doc.id).some((m) => m.text === 'add rain')).toBe(false);
  });

  it('COMIC_STEER off answers 501 NOT_AVAILABLE whatever the body (a long note is not LIMIT, an empty one not 400), so the client takes D2', async () => {
    steerStage = undefined;
    const doc = seed();
    for (const body of [{ text: 'x'.repeat(MAX_STEER_CHARS + 1) }, { text: '   ' }, {}]) {
      const res = await steer(doc.id, body);
      expect(res.status).toBe(501);
      expect(res.json.error?.code).toBe('NOT_AVAILABLE');
    }
  });

  it('the turn ends while the note is being screened: 409 NOT_RUNNING and nothing committed (never a 200 for a note no turn reads)', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    const held = deferred<ScreenResult>();
    screen = (input) => (input.text === 'add rain' ? held.promise : Promise.resolve(ALLOW));
    const pending = steer(doc.id, { text: 'add rain' });
    await until(() => screenCalls.includes('add rain'));
    turn.release();
    await turn.done;
    held.resolve(ALLOW);
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json.error).toEqual({ code: 'NOT_RUNNING', message: STEER_NOT_RUNNING_MESSAGE });
    expect(conversation(doc.id).some((m) => m.text === 'add rain')).toBe(false);
    // The director never read it either: one model call, no note.
    expect(llm.calls.filter((c) => c.role === 'director')).toHaveLength(1);
  });

  it('the inbox fills while the note is being screened: 409 BUSY and nothing committed', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    llm.script.director!.push({ text: 'Read your notes.' });
    const held = deferred<ScreenResult>();
    screen = (input) => (input.text === 'add rain' ? held.promise : Promise.resolve(ALLOW));
    const pending = steer(doc.id, { text: 'add rain' });
    await until(() => screenCalls.includes('add rain'));
    const session = peekStudioSession(doc.id)!;
    for (let i = 0; i < STEER_LIMITS.inbox; i += 1) expect(session.pushSteer({ msgId: `direct_${i}`, text: `direct ${i}`, at: Date.now() })).toBe(true);
    held.resolve(ALLOW);
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json.error).toEqual({ code: 'BUSY', message: STEER_FULL_MESSAGE });
    expect(conversation(doc.id).some((m) => m.text === 'add rain')).toBe(false);
    turn.release();
    await turn.done;
    expect(JSON.stringify(llm.calls)).not.toContain('add rain');
  });

  it(`at most ${STEER_LIMITS.inbox} notes are screened at once: a further steer during their screens is BUSY and never screened`, async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    llm.script.director!.push({ text: 'Read your notes.' });
    const held = deferred<ScreenResult>();
    screen = (input) => (input.text.startsWith('held') ? held.promise : Promise.resolve(ALLOW));
    const inFlight = Array.from({ length: STEER_LIMITS.inbox }, (_, i) => steer(doc.id, { text: `held ${i}` }));
    await until(() => screenCalls.filter((t) => t.startsWith('held')).length === STEER_LIMITS.inbox);
    const extra = await steer(doc.id, { text: 'held extra' });
    expect(extra.status).toBe(409);
    expect(extra.json.error?.code).toBe('BUSY');
    expect(screenCalls).not.toContain('held extra');
    held.resolve(ALLOW);
    expect((await Promise.all(inFlight)).map((r) => r.status)).toEqual(Array(STEER_LIMITS.inbox).fill(200));
    expect(conversation(doc.id).filter((m) => m.steered).map((m) => m.text).sort()).toEqual(Array.from({ length: STEER_LIMITS.inbox }, (_, i) => `held ${i}`));
    turn.release();
    await turn.done;
    // Every seat came back: the turn is over, so a new steer is NOT_RUNNING (not BUSY).
    expect((await steer(doc.id, { text: 'after' })).json.error?.code).toBe('NOT_RUNNING');
  });

  it('a failed cooldown lookup or screen still gives the seat back', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    llm.script.director!.push({ text: 'Read your notes.' });
    cooldown = async () => ({ until: Date.now() + 60_000 });
    for (let i = 0; i < STEER_LIMITS.inbox + 1; i += 1) expect((await steer(doc.id, { text: `c ${i}` })).status).toBe(429);
    cooldown = async () => null;
    for (let i = 0; i < STEER_LIMITS.inbox; i += 1) expect((await steer(doc.id, { text: `ok ${i}` })).status).toBe(200);
    turn.release();
    await turn.done;
  });

  it('a safety cooldown answers 429 COOLDOWN before any screen', async () => {
    const doc = seed();
    const turn = await startTurn(doc.id, () => ({ text: 'Ok.' }));
    cooldown = async () => ({ until: Date.now() + 120_000 });
    const res = await steer(doc.id, { text: 'add rain' });
    expect(res.status).toBe(429);
    expect(res.json.error?.code).toBe('COOLDOWN');
    expect(screenCalls).toEqual(['Make the market busier']);
    turn.release();
    await turn.done;
  });

  it('owner only (404 for another user), the moderation gate applies (403), and bad bodies are 400 / LIMIT', async () => {
    const doc = seed();
    expect((await steer(doc.id, { text: 'hi' }, 'user-2')).status).toBe(404);
    moderation = 'suspended';
    expect((await steer(doc.id, { text: 'hi' })).status).toBe(403);
    moderation = 'active';
    expect((await steer(doc.id, { text: '   ' })).status).toBe(400);
    const long = await steer(doc.id, { text: 'x'.repeat(MAX_STEER_CHARS + 1) });
    expect(long.status).toBe(409);
    expect(long.json.error?.code).toBe('LIMIT');
  });

  it('the steer cap is the pasted-script threshold: a note at the cap is sent again as an ordinary message', () => {
    expect(MAX_STEER_CHARS).toBe(LONG_MESSAGE_CHARS);
  });

  it('parseSteerRequest trims, keeps valid focus parts only, and bounds the text', () => {
    expect(parseSteerRequest({ text: '  red  ', focus: { pageId: 'pg_1', lineIds: ['ln_1', 7], junk: true } })).toEqual({
      text: 'red',
      focus: { pageId: 'pg_1', lineIds: ['ln_1'] }
    });
    expect(parseSteerRequest({ text: 'x'.repeat(MAX_STEER_CHARS) }).text).toHaveLength(MAX_STEER_CHARS);
    expect(() => parseSteerRequest(null)).toThrow(/Type a note/);
    expect(() => parseSteerRequest({ text: 5 })).toThrow(/Type a note/);
  });
});
