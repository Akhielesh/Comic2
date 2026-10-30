// Comic History H2 through the real session (versions plan §4.1, §14 H2): getStudioSession builds the hooks with
// createHistoryHooks, so these tests run the recorder exactly as production does — COMIC_HISTORY, the process store
// (H1's fake swapped in), the live `history` event through the session event path, a director turn, a paid render
// run on the fakes. No paid call, no network, no timer of the recorder's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../../../shared/comic/doc.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { historyV4Doc } from '../../../shared/comic/history/__fixtures__/books.js';
import { JOB_TIMINGS, runAction } from './jobs.js';
import { fakeDocStore, plannedDoc, testContext, type FakeDocStore } from './orchestrator.fakes.js';
import { StudioSession, __resetSessionsForTests, drainStudioSessions, getStudioSession } from './session.js';
import { buildDirectorTools, createDirectorTurn } from './tools.js';
import { writePagePlan } from './writer.js';
import { NOOP_HISTORY_HOOKS } from './history/hooks.js';
import { createFakeHistoryStore, type FakeHistoryStore } from './history/store.fake.js';
import { __setHistoryStoreForTests } from './history/store.js';
import type { HistoryStore } from './history/storeTypes.js';
import { StudioError } from './types.js';

vi.mock('./writer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./writer.js')>();
  return { ...actual, writePagePlan: vi.fn() };
});
vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(async () => Promise.reject(new Error('no vision in tests'))) };
});

const USER = 'user-1';
const TIMINGS = { ...JOB_TIMINGS };

let fake: FakeHistoryStore;
let docs: FakeDocStore;
let emitted: StudioEvent[];

/** Every event any session emitted (the stream subscribes to exactly these). */
const historyEvents = () => emitted.filter((e): e is Extract<StudioEvent, { type: 'history' }> => e.type === 'history');

const open = async (doc: ComicDoc) => {
  docs.docs.set(doc.id, { userId: USER, doc });
  const session = await getStudioSession(doc.id, USER, docs, { saveDebounceMs: 5 });
  return session;
};
const rowsOf = (projectId: string) => fake.rows({ projectId, userId: USER }).reverse();
const say = (pageId: string, text: string): Parameters<StudioSession['commit']>[0] => {
  const n = Number(pageId.slice(3));
  return [{ op: 'line', pageId, panelId: `pn_${n}_2`, id: `ln_${n}_2`, patch: { text } }];
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  fake = createFakeHistoryStore();
  __setHistoryStoreForTests(fake);
  docs = fakeDocStore();
  emitted = [];
  const emit = StudioSession.prototype.emit;
  vi.spyOn(StudioSession.prototype, 'emit').mockImplementation(function (this: StudioSession, event: StudioEvent) {
    emitted.push(event);
    return emit.call(this, event);
  });
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  __resetSessionsForTests();
  __setHistoryStoreForTests(null);
  vi.mocked(writePagePlan).mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('with COMIC_HISTORY unset', () => {
  it('a session makes zero store calls and emits zero history events, through load, edits, a flush and shutdown', async () => {
    vi.stubEnv('COMIC_HISTORY', '');
    const session = await open(plannedDoc());
    expect(session.history).toBe(NOOP_HISTORY_HOOKS);
    session.commit(say('pg_1', 'Hello'), { origin: 'user' });
    session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 }, origin: 'render' } }], { origin: 'job' });
    await session.flush();
    await drainStudioSessions(1_000);
    expect(fake.calls).toEqual([]);
    expect(historyEvents()).toEqual([]);
    expect(session.history.recording).toBe(false);
  });
});

describe('with COMIC_HISTORY on', () => {
  beforeEach(() => {
    vi.stubEnv('COMIC_HISTORY', '1');
  });

  it('a v4-shaped load writes exactly one pinned start row and tells the open session; a later load writes none', async () => {
    const v4 = normalizeDoc(historyV4Doc());
    const session = await open(v4);
    expect(session.history).not.toBe(NOOP_HISTORY_HOOKS);
    await session.flush(); // awaits the history capture
    let rows = rowsOf(v4.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'start', pinned: true, label: 'History starts here', alternativeId: null });
    expect(historyEvents().map((e) => e.version)).toEqual([expect.objectContaining({ id: rows[0].id, kind: 'start', alternativeId: null })]);
    expect(session.history.recording).toBe(true);
    // Every call carried this comic AND its owner.
    expect(fake.calls.every((c) => c.projectId === v4.id && c.userId === USER)).toBe(true);

    __resetSessionsForTests();
    const again = await open(v4);
    await again.flush();
    rows = rowsOf(v4.id);
    expect(rows).toHaveLength(1);
  });

  it('a revise_pages request gives exactly before_ai + ai rows with the right parent and words', async () => {
    const session = await open(plannedDoc());
    await session.flush();
    session.commit(say('pg_3', 'A line of yours first'), { origin: 'user' });
    vi.mocked(writePagePlan).mockImplementation(async ({ doc, pageIds }) => ({
      pages: doc.pages.filter((p) => pageIds!.includes(p.id)).map((p) => ({ ...p, summary: 'Splash!' })),
      newCast: [],
      model: 'w'
    }));
    const ctx = testContext(session);
    const tools = new Map(buildDirectorTools(ctx, createDirectorTurn({ attachments: [], userText: 'make page 2 a splash' })).map((t) => [t.spec.function.name, t]));
    expect(await tools.get('revise_pages')!.execute({ pages: [2], instructions: 'make it a splash' })).toMatch(/^Revised 1 page: 2\. Splash!/);
    await ctx.settled();
    await session.flush(); // the stream's own flush at the end of the request
    const rows = rowsOf(session.projectId);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'before_ai', 'ai']);
    const [, before, ai] = rows;
    expect(before).toMatchObject({ label: 'Before the AI revised page 2', actor: 'system' });
    expect(before.changes).toEqual([expect.objectContaining({ what: 'dialogue', by: 'you', pageIds: ['pg_3'] })]);
    expect(ai).toMatchObject({ kind: 'ai', actor: 'ai', label: 'AI revised page 2', parentId: before.id });
    expect(ai.changes).toEqual([expect.objectContaining({ what: 'page_text', by: 'ai', pageIds: ['pg_2'] })]);
    expect(historyEvents().map((e) => e.version.kind)).toEqual(['start', 'before_ai', 'ai']);
  });

  it('a paid render run never awaits a history write: it finishes while its before_ai put is still pending (BYOK spend kept)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: HistoryStore = {
      ...fake,
      async put(scope, version, chunks, policy) {
        order.push(`put:${version.kind}`);
        if (version.kind === 'before_ai') await held;
        const out = await fake.put(scope, version, chunks, policy);
        order.push(`put:${version.kind}:done`);
        return out;
      }
    };
    __setHistoryStoreForTests(slow);
    const session = await open(plannedDoc());
    await session.flush();
    session.commit(say('pg_1', 'Before drawing'), { origin: 'user' });
    const ctx = testContext(session, { keys: { openrouter: { key: 'sk-or-mine', byok: true } } });
    ctx.imagesFake.behave = (_req, i) => {
      order.push(`image:${i}`);
      return { byok: true }; // drawn on the user's own key
    };
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true, origin: 'user' });
    await ctx.settled();
    // The whole paid run (2 sheets + 3 pages) finished; the history write it started is still waiting.
    expect(ctx.imagesFake.calls).toHaveLength(5);
    expect(session.doc.pages.every((p) => p.render.status === 'ready')).toBe(true);
    expect(order).toContain('put:before_ai');
    expect(order).not.toContain('put:before_ai:done');
    expect(order.indexOf('put:before_ai')).toBeLessThan(order.indexOf('image:4'));
    expect(rowsOf(session.projectId).map((r) => r.kind)).toEqual(['start']);
    release();
    await session.flush();
    const rows = rowsOf(session.projectId);
    expect(rows.map((r) => r.kind)).toEqual(['start', 'before_ai', 'ai']);
    const ai = rows[2];
    expect(ai).toMatchObject({ parentId: rows[1].id, label: 'AI drew pages 1–3 and updated 2 characters' });
    const paid = session.doc.spend.entries.filter((e) => e.usd > 0);
    expect(paid.length).toBeGreaterThanOrEqual(5);
    expect(paid.every((e) => e.byok)).toBe(true);
    expect(ai.stats.spend).toEqual({ usd: Math.round(paid.reduce((n, e) => n + e.usd, 0) * 10_000) / 10_000, byok: true, estimated: false });
  });

  it('a store rejection never throws into a commit, a turn or a render, and is retried at the next commit', async () => {
    const session = await open(plannedDoc());
    await session.flush();
    session.commit(say('pg_1', 'mine'), { origin: 'user' });
    fake.failNext('put');
    fake.failNext('missing');
    const ctx = testContext(session);
    await expect(runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: true, origin: 'user' })).resolves.toBeUndefined();
    await ctx.settled();
    expect(session.doc.pages[0].render.status).toBe('ready');
    // A director turn's commit still lands.
    expect(() => session.commit(say('pg_2', 'still yours'), { origin: 'director' })).not.toThrow();
    session.commit([{ op: 'message', msg: { id: 'm1', role: 'assistant', text: 'Done.', at: Date.now() } }], { origin: 'job' });
    await session.flush();
    const kinds = rowsOf(session.projectId).map((r) => r.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds).toContain('before_ai');
    expect(kinds).toContain('ai');
    expect(String(vi.mocked(console.warn).mock.calls.map((c) => c[0]).join('\n'))).toContain('comic_history_capture_failed');
  });

  it('a store that is down entirely: the session saves, renders and flushes as if History were off', async () => {
    const down = new Proxy({} as HistoryStore, {
      get: (_t, key) => (key === 'then' ? undefined : async () => Promise.reject(new StudioError('INTERNAL', 'down', { status: 503, retryable: true })))
    });
    __setHistoryStoreForTests(down);
    const session = await open(plannedDoc());
    session.commit(say('pg_1', 'mine'), { origin: 'user' });
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages', pageIds: ['pg_1'] }, { confirmed: true, origin: 'user' });
    await ctx.settled();
    await expect(session.flush({ final: true })).resolves.toBeUndefined();
    expect(docs.saves.length).toBeGreaterThan(0);
    expect(session.doc.pages[0].render.status).toBe('ready');
    expect(historyEvents()).toEqual([]);
  });

  it('a publication op writes a pinned publish row', async () => {
    const session = await open(plannedDoc());
    await session.flush();
    session.commit(say('pg_2', 'Final words'), { origin: 'user' });
    const rev = session.doc.rev;
    session.commit([{ op: 'publication', value: { visibility: 'unlisted', status: 'live', publishedRev: rev, publishedAt: Date.now(), languages: ['en'] } }], { origin: 'user' });
    await session.flush();
    const rows = rowsOf(session.projectId);
    expect(rows.map((r) => [r.kind, r.pinned, r.publishedRev])).toEqual([
      ['start', true, undefined],
      ['publish', true, rev]
    ]);
  });
});
