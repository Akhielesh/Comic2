// Comic History server seams (versions plan §4.1, §14 H0): the session calls its history hooks at the right moments
// and a failing hook never reaches a save, a turn or a render; the stubs are honest no-ops (nothing committed, nothing
// spent); the director group exists only while COMIC_HISTORY is on; the request time zone rides on the turn context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { MAX_ARCHIVE } from '../../../../shared/comic/limits.js';
import { fakeDocStore, newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';
import { HISTORY_ACTIONS } from '../actions/history.js';
import { HISTORY_ALTERNATIVE_ACTIONS } from '../actions/historyAlternatives.js';
import { actionHandlerFor } from '../actions/index.js';
import { historyToolGroup, historyToolGroupEnabled } from '../tools/history.js';
import { StudioSession, __resetSessionsForTests, archiveEvictionNotice, drainStudioSessions, getStudioSession, sweepIdleSessions, SESSION_IDLE_MS } from '../session.js';
import { createDirectorTurn } from '../tools.js';
import { NOOP_HISTORY_HOOKS, createHistoryHooks, isHistoryEnabled, rememberTurnTimeZone, turnTimeZone, type HistoryHooks } from './hooks.js';
import { loadLegacyVersionState } from './legacyImport.js';
import { classicProjectState } from '../../../../shared/comic/history/__fixtures__/books.js';

/** The hooks createHistoryHooks hands to the next session getStudioSession builds (null: the real stub). */
const hookHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./hooks.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./hooks.js')>();
  return { ...mod, createHistoryHooks: (scope: Parameters<typeof mod.createHistoryHooks>[0]) => (hookHolder.current as HistoryHooks | null) ?? mod.createHistoryHooks(scope) };
});

interface Recorded {
  commits: { before: ComicDoc; next: ComicDoc; ops: DocOp[]; origin?: string; label?: string }[];
  flushes: { rev: number; final: boolean }[];
  loads: number[];
}

const spyHooks = (overrides: Partial<HistoryHooks> = {}): { hooks: HistoryHooks; rec: Recorded } => {
  const rec: Recorded = { commits: [], flushes: [], loads: [] };
  const hooks: HistoryHooks = {
    recording: false,
    onCommit: (before, next, ops, origin, label) => void rec.commits.push({ before, next, ops, origin, label }),
    onFlush: (doc, opts) => void rec.flushes.push({ rev: doc.rev, final: opts.final }),
    onLoad: (doc) => void rec.loads.push(doc.rev),
    ...overrides
  };
  return { hooks, rec };
};

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  hookHolder.current = null;
  __resetSessionsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the history hooks stub', () => {
  it('is a no-op that records nothing, whatever the env says', () => {
    expect(createHistoryHooks({ projectId: 'p', userId: 'u' })).toBe(NOOP_HISTORY_HOOKS);
    expect(NOOP_HISTORY_HOOKS.recording).toBe(false);
    expect(isHistoryEnabled({})).toBe(false);
    expect(isHistoryEnabled({ COMIC_HISTORY: '1' })).toBe(true);
    expect(isHistoryEnabled({ COMIC_HISTORY: '0' })).toBe(false);
    // A session gets the stub by default.
    expect(newSession(plannedDoc()).history).toBe(NOOP_HISTORY_HOOKS);
  });
});

describe('StudioSession calls its history hooks', () => {
  it('onCommit gets before, next, ops, origin and label on every commit; onFlush runs after the save', async () => {
    const { hooks, rec } = spyHooks();
    const store = fakeDocStore();
    const doc = plannedDoc();
    store.docs.set(doc.id, { userId: 'user-1', doc });
    const session = new StudioSession({ projectId: doc.id, userId: 'user-1', doc, store, saveDebounceMs: 5, history: hooks });
    const before = session.doc;
    session.commit([{ op: 'brief', patch: { title: 'New title' } }], { origin: 'user', label: 'Rename' });
    expect(rec.commits).toHaveLength(1);
    expect(rec.commits[0]).toMatchObject({ before, next: session.doc, ops: [{ op: 'brief', patch: { title: 'New title' } }], origin: 'user', label: 'Rename' });
    await session.flush();
    expect(rec.flushes).toEqual([{ rev: session.doc.rev, final: false }]);
    expect(store.saves.length).toBeGreaterThan(0); // the save happened before the capture
    await session.flush({ final: true });
    expect(rec.flushes.at(-1)).toEqual({ rev: session.doc.rev, final: true });
  });

  it('a throwing or rejecting hook never breaks a commit or a flush (logged as comic_history_capture_failed)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { hooks } = spyHooks({
      onCommit: () => {
        throw new Error('boom');
      },
      onFlush: async () => {
        throw new Error('store down');
      }
    });
    const doc = plannedDoc();
    const session = new StudioSession({ projectId: doc.id, userId: 'user-1', doc, store: fakeDocStore(), saveDebounceMs: 5, history: hooks });
    expect(() => session.commit([{ op: 'brief', patch: { title: 'Still saved' } }], { origin: 'user' })).not.toThrow();
    expect(session.doc.brief.title).toBe('Still saved');
    await expect(session.flush()).resolves.toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('comic_history_capture_failed');
  });

  it('onLoad runs once after getStudioSession hydrates; the sweeper eviction and shutdown flush with final:true', async () => {
    const { hooks, rec } = spyHooks();
    hookHolder.current = hooks;
    const store = fakeDocStore();
    const doc = plannedDoc();
    store.docs.set(doc.id, { userId: 'user-1', doc });
    const session = await getStudioSession(doc.id, 'user-1', store);
    expect(session.history).toBe(hooks);
    expect(rec.loads).toEqual([session.doc.rev]);
    await getStudioSession(doc.id, 'user-1', store); // a cache hit does not load again
    expect(rec.loads).toHaveLength(1);
    await drainStudioSessions(1_000);
    expect(rec.flushes.at(-1)).toMatchObject({ final: true });
    rec.flushes.length = 0;
    await sweepIdleSessions(Date.now() + SESSION_IDLE_MS + 1);
    expect(rec.flushes).toEqual([{ rev: session.doc.rev, final: true }]);
  });

  it('the archive notice says "History still keeps them" only while history really records', () => {
    expect(archiveEvictionNotice(2, 1).msg.text).not.toContain('History');
    expect(archiveEvictionNotice(2, 1, { history: false }).msg.text).not.toContain('History');
    expect(archiveEvictionNotice(2, 1, { history: true }).msg.text).toBe(
      `Version archive is full (${MAX_ARCHIVE}): removed 2 oldest unstarred versions that nothing uses. Star a version to keep it forever. History still keeps them.`
    );
  });
});

describe('history action stubs', () => {
  it('every history action is registered, non-spend, and refuses honestly: NOT_AVAILABLE, nothing committed, nothing spent', async () => {
    const types = [...HISTORY_ACTIONS, ...HISTORY_ALTERNATIVE_ACTIONS].map((h) => h.type).sort();
    expect(types).toEqual(['history_alternative', 'history_forget_photo', 'history_restore', 'history_save', 'history_undo_ai']);
    const session = newSession(plannedDoc());
    const ctx = testContext(session);
    const rev = session.doc.rev;
    for (const type of types) {
      const handler = actionHandlerFor(type)!;
      expect(handler.spend, type).toBe(false);
      await expect(handler.run(ctx, { type } as never, { confirmed: true })).rejects.toMatchObject({ code: 'NOT_AVAILABLE', status: 501 });
    }
    expect(session.doc.rev).toBe(rev);
    expect(ctx.billingFake.reserves).toEqual([]);
  });
});

describe('history director group', () => {
  it('is listed only while COMIC_HISTORY is on, and the stub offers no tool', () => {
    expect(historyToolGroupEnabled()).toBe(false);
    vi.stubEnv('COMIC_HISTORY', '1');
    expect(historyToolGroupEnabled()).toBe(true);
    const ctx = testContext(newSession(plannedDoc()));
    expect(historyToolGroup.id).toBe('history');
    expect(historyToolGroup.when?.(ctx, createDirectorTurn())).toBe(false);
    expect(historyToolGroup.tools(ctx, createDirectorTurn())).toEqual([]);
  });
});

describe('the request time zone on the turn context', () => {
  it('keeps a valid IANA zone per context and ignores anything else', () => {
    const a = {};
    const b = {};
    expect(rememberTurnTimeZone(a, 'America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(rememberTurnTimeZone(b, 'Not/AZone')).toBeUndefined();
    expect(turnTimeZone(a)).toBe('America/Los_Angeles');
    expect(turnTimeZone(b)).toBeUndefined();
    expect(turnTimeZone(null)).toBeUndefined();
  });
});

describe('legacy snapshot import stub', () => {
  it('has no server-side snapshot yet (H6), for a classic-shaped project', async () => {
    const classic = classicProjectState();
    const snapshotId = (classic.state.versions as { id: string }[])[1].id;
    expect(await loadLegacyVersionState({ projectId: 'old-1', userId: 'user-1' }, 'old-1', snapshotId)).toBeNull();
  });
});
