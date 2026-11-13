// @vitest-environment node
// B-TOOL wave note 1 (S2b integration): the stream route calls the free dialogue fast path (intents.dialogueFastIntent)
// right after the free intent router. With COMIC_DIALOGUE_FAST on (caps.dialogueFast), "make it a whisper" on a selected
// line is applied by the deterministic engine with NO director model call, and the reply carries the Undo chip. With
// the flag off (the default) the same message goes to the director, as before.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { __resetAccessCacheForTests } from '../comic/access.js';
import { __resetSessionsForTests, peekStudioSession } from '../comic/session.js';
import type { ScreenResult } from '../comic/safety/index.js';
import { KEYS, fakeAssetStore, fakeBilling, fakeDocStore, fakeImages, plannedDoc, scriptedLlm, type FakeAssetStore, type FakeDocStore, type ScriptedLlm } from '../comic/orchestrator.fakes.js';
import { registryPriceBook } from '../comic/models/index.js';
import { __setModelHealthForTests, type ModelHealthPort } from '../comic/models/health.js';
import { fakeModelHealth } from '../comic/models/health.fakes.js';
import { createComicRouter } from './comic.js';

let store: FakeDocStore;
let assets: FakeAssetStore;
let llm: ScriptedLlm;
/** The COMIC_DIALOGUE_FAST stage the caps read (unset = the D4 default, off). */
let fastStage: string | undefined;
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
      env: { COMIC_DIALOGUE_FAST: fastStage }
    },
    requireActive: (_req, res, next) => {
      res.locals.moderationStatus = 'active';
      next();
    },
    safety: {
      cooldownFor: async () => null,
      screenTurnInput: async () => ALLOW,
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
  fastStage = undefined;
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
const parseSse = (body: string): StudioEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.trim() && !block.startsWith(':'))
    .map((block) => JSON.parse(block.split('\n')[1].slice(6)) as StudioEvent);
const stream = async (projectId: string, body: unknown) => {
  const res = await fetch(`${base}/api/comic/projects/${projectId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify(body)
  });
  return res.headers.get('content-type')?.includes('text/event-stream') ? parseSse(await res.text()) : [];
};
const docOf = (projectId: string) => peekStudioSession(projectId)?.doc ?? store.docs.get(projectId)!.doc;
const directorCalls = () => llm.calls.filter((c) => c.role === 'director');
const WHISPER = { kind: 'message', text: 'make it a whisper', focus: { pageId: 'pg_2', lineIds: ['ln_2_2'] } };

describe('the stream route and the dialogue fast path (B-TOOL #1)', () => {
  it('COMIC_DIALOGUE_FAST on: 0 director calls, the selected line becomes a whisper, the reply leads with Undo', async () => {
    fastStage = 'all';
    const doc = seed();
    const events = await stream(doc.id, WHISPER);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(directorCalls()).toHaveLength(0);
    const after = docOf(doc.id);
    expect(after.pages[1].panels[1].lines[0]).toMatchObject({ id: 'ln_2_2', kind: 'whisper' });
    const [user, reply] = after.conversation.slice(-2);
    expect(user).toMatchObject({ role: 'user', text: 'make it a whisper' });
    expect(reply.role).toBe('assistant');
    expect(reply.text).toMatch(/whisper/i);
    expect(reply.text).not.toContain('$');
    expect(reply.nextSteps?.[0]).toEqual({ label: 'Undo', client: { type: 'undo' } });
    expect(peekStudioSession(doc.id)!.turnRunning).toBe(false);
  });

  it('COMIC_DIALOGUE_FAST off (the default): the director runs and the fast path writes nothing', async () => {
    const doc = seed();
    llm.script.director = [{ text: 'Sure, which line?' }];
    const events = await stream(doc.id, WHISPER);
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(directorCalls().length).toBeGreaterThan(0);
    const after = docOf(doc.id);
    expect(after.pages[1].panels[1].lines[0]).toMatchObject({ id: 'ln_2_2', kind: 'speech' });
    expect(after.conversation.at(-1)).toMatchObject({ role: 'assistant', text: 'Sure, which line?' });
  });
});
