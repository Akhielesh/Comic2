import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { fakeDocStore, plannedDoc } from './orchestrator.fakes.js';
import {
  GATE_EXPIRY_MS,
  INTERRUPTED_RENDER_ERROR,
  INTERRUPTED_RENDER_MS,
  SESSION_IDLE_MS,
  StudioSession,
  __resetSessionsForTests,
  getStudioSession,
  peekStudioSession,
  projectSummary,
  recoveryOps,
  sweepIdleSessions
} from './session.js';
import { StudioError } from './types.js';

const flushMicrotasks = () => new Promise((r) => setImmediate(r));

describe('StudioSession.commit', () => {
  it('applies ops, bumps rev, stamps updatedAt and emits an ops event', () => {
    const store = fakeDocStore();
    const doc = createEmptyDoc('p1', 'Start', 1000);
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store, now: () => 5000 });
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));
    const next = session.commit([{ op: 'brief', patch: { title: 'Spice Run' } }, { op: 'note_add', text: 'no gore' }]);
    expect(next.rev).toBe(1);
    expect(next.updatedAt).toBe(5000);
    expect(next.brief.title).toBe('Spice Run');
    expect(session.doc).toBe(next);
    expect(events).toEqual([{ type: 'ops', rev: 1, ops: [{ op: 'brief', patch: { title: 'Spice Run' } }, { op: 'note_add', text: 'no gore' }] }]);
    session.dispose();
  });

  it('ignores empty batches and never mutates the previous doc', () => {
    const doc = createEmptyDoc('p1');
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store: fakeDocStore() });
    expect(session.commit([])).toBe(doc);
    session.commit([{ op: 'brief', patch: { title: 'X' } }]);
    expect(doc.brief.title).toBe('Untitled comic');
    expect(doc.rev).toBe(0);
    session.dispose();
  });

  it('isolates a throwing listener from the others', () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const seen: string[] = [];
    session.subscribe(() => {
      throw new Error('boom');
    });
    session.subscribe((e) => seen.push(e.type));
    session.commit([{ op: 'note_add', text: 'a' }]);
    expect(seen).toEqual(['ops']);
    session.dispose();
  });
});

describe('StudioSession persistence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces saves: many commits within the window become one save with the listing summary', async () => {
    const store = fakeDocStore();
    const doc = plannedDoc('p1');
    store.docs.set('p1', { userId: 'u1', doc });
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store });
    session.commit([{ op: 'note_add', text: 'one' }]);
    session.commit([{ op: 'note_add', text: 'two' }]);
    session.commit([
      { op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'ready', asset: { path: 'u/u1/p/p1/img/p2.webp', source: 'generated', at: 1 } } }
    ]);
    expect(store.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(store.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toMatchObject({ rev: 3, summary: { title: 'Spice Run', coverPath: 'u/u1/p/p1/img/p2.webp', logline: 'A courier races through a spice market.' } });
    expect(session.persisted).toBe(true);
    session.dispose();
  });

  it('a later commit never postpones the first scheduled save (≤500 ms latency)', async () => {
    const store = fakeDocStore();
    const doc = createEmptyDoc('p1');
    store.docs.set('p1', { userId: 'u1', doc });
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store });
    session.commit([{ op: 'note_add', text: 'one' }]);
    await vi.advanceTimersByTimeAsync(400);
    session.commit([{ op: 'note_add', text: 'two' }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.saves.map((s) => s.rev)).toEqual([2]);
    session.dispose();
  });

  it('flush saves immediately, coalesces with an in-flight save, and is a no-op when clean', async () => {
    const store = fakeDocStore();
    const doc = createEmptyDoc('p1');
    store.docs.set('p1', { userId: 'u1', doc });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realSave = store.save;
    let inFlight = 0;
    store.save = async (args) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await gate;
      await realSave(args);
      inFlight -= 1;
    };
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store });
    session.commit([{ op: 'note_add', text: 'one' }]);
    const first = session.flush();
    session.commit([{ op: 'note_add', text: 'two' }]);
    const second = session.flush();
    release();
    await Promise.all([first, second]);
    expect(store.saves.map((s) => s.rev)).toEqual([1, 2]);
    await session.flush();
    expect(store.saves).toHaveLength(2);
    session.dispose();
  });

  it('save failures are logged, never thrown, and retried on the next flush', async () => {
    const store = fakeDocStore();
    const doc = createEmptyDoc('p1');
    store.docs.set('p1', { userId: 'u1', doc });
    store.failSaves = 1;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store });
    session.commit([{ op: 'note_add', text: 'one' }]);
    await expect(session.flush()).resolves.toBeUndefined();
    expect(store.saves).toHaveLength(0);
    expect(session.persisted).toBe(false);
    await session.flush();
    expect(store.saves.map((s) => s.rev)).toEqual([1]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    session.dispose();
  });

  it('retries a failed debounced save on a backoff without any further activity', async () => {
    const store = fakeDocStore();
    const doc = createEmptyDoc('p1');
    store.docs.set('p1', { userId: 'u1', doc });
    store.failSaves = 1;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store });
    session.commit([{ op: 'note_add', text: 'one' }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.saves.map((s) => s.rev)).toEqual([1]);
    errors.mockRestore();
    session.dispose();
  });
});

describe('StudioSession turn lock and abort', () => {
  it('runExclusive serializes work and reports turnRunning', async () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = session.runExclusive(async () => {
      order.push('first:start');
      await new Promise<void>((r) => (releaseFirst = r));
      order.push('first:end');
    });
    const second = session.runExclusive(async () => {
      order.push('second');
      return 42;
    });
    await flushMicrotasks();
    expect(session.turnRunning).toBe(true);
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await expect(second).resolves.toBe(42);
    await first;
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(session.turnRunning).toBe(false);
    session.dispose();
  });

  it('a failing exclusive task does not poison the queue', async () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    await expect(session.runExclusive(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    await expect(session.runExclusive(async () => 'ok')).resolves.toBe('ok');
    session.dispose();
  });

  it('resetAbort replaces the controller', () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const before = session.abort;
    before.abort();
    const after = session.resetAbort();
    expect(after).not.toBe(before);
    expect(session.abort).toBe(after);
    expect(after.signal.aborted).toBe(false);
    session.dispose();
  });
});

describe('recovery', () => {
  const stuck = (doc: ComicDoc, updatedAt: number) => {
    doc.pages[0].render = { ...emptyRender(), status: 'rendering', updatedAt };
    doc.pages[1].render = { ...emptyRender(), status: 'queued', updatedAt };
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: { path: 'x.webp', source: 'generated', at: 1 } };
    doc.cover.render = { ...emptyRender(), status: 'rendering', updatedAt };
    return doc;
  };

  it('fails every in-flight render when the session is fresh in this process', () => {
    const now = 10_000_000;
    const ops = recoveryOps(stuck(plannedDoc(), now - 1000), { now, allInFlight: true });
    expect(ops).toHaveLength(3);
    for (const op of ops) expect(op).toMatchObject({ op: 'render', patch: { status: 'failed', error: INTERRUPTED_RENDER_ERROR } });
  });

  it('only fails renders older than 3 minutes otherwise', () => {
    const now = 10_000_000;
    const doc = stuck(plannedDoc(), now - 1000);
    doc.pages[2].render = { ...emptyRender(), status: 'rendering', updatedAt: now - INTERRUPTED_RENDER_MS - 1 };
    const ops = recoveryOps(doc, { now, allInFlight: false });
    expect(ops).toEqual([{ op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'failed', error: INTERRUPTED_RENDER_ERROR, updatedAt: now } }]);
  });

  it('declines an open gate older than a day, keeps a fresh one', () => {
    const now = 100 * GATE_EXPIRY_MS;
    const doc = plannedDoc();
    const gate = { id: 'g1', action: { type: 'render_cover' as const }, title: 't', summary: 's', estimateUsd: 0.1, imageCount: 1, model: 'NB', createdAt: now - GATE_EXPIRY_MS - 1, status: 'open' as const, reason: 'policy' as const };
    expect(recoveryOps({ ...doc, gate }, { now, allInFlight: true })).toEqual([{ op: 'gate', gate: { ...gate, status: 'declined' } }]);
    expect(recoveryOps({ ...doc, gate: { ...gate, createdAt: now - 1000 } }, { now, allInFlight: true })).toEqual([]);
  });
});

describe('getStudioSession', () => {
  afterEach(() => __resetSessionsForTests());

  it('loads, recovers interrupted renders, persists the repair and caches the session', async () => {
    const store = fakeDocStore();
    const doc = plannedDoc('p1');
    doc.pages[0].render = { ...emptyRender(), status: 'rendering', updatedAt: Date.now() };
    store.docs.set('p1', { userId: 'u1', doc });
    const session = await getStudioSession('p1', 'u1', store);
    expect(session.doc.pages[0].render).toMatchObject({ status: 'failed', error: INTERRUPTED_RENDER_ERROR });
    expect(session.doc.rev).toBe(doc.rev + 1);
    await session.flush();
    expect(store.saves).toHaveLength(1);
    expect(await getStudioSession('p1', 'u1', store)).toBe(session);
    expect(peekStudioSession('p1')).toBe(session);
  });

  it('throws NOT_FOUND for a missing project or another user — even when a session is cached', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    await expect(getStudioSession('nope', 'u1', store)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const owner = await getStudioSession('p1', 'u1', store);
    const err = await getStudioSession('p1', 'intruder', store).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err.code).toBe('NOT_FOUND');
    expect(await getStudioSession('p1', 'u1', store)).toBe(owner);
  });

  it('concurrent first loads share one session', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    const [a, b] = await Promise.all([getStudioSession('p1', 'u1', store), getStudioSession('p1', 'u1', store)]);
    expect(a).toBe(b);
  });

  it('evicts idle sessions only (no subscribers, no work) after flushing', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    store.docs.set('p2', { userId: 'u1', doc: plannedDoc('p2') });
    const idle = await getStudioSession('p1', 'u1', store);
    const watched = await getStudioSession('p2', 'u1', store);
    idle.commit([{ op: 'note_add', text: 'unsaved' }]);
    const unsubscribe = watched.subscribe(() => undefined);
    expect(await sweepIdleSessions(Date.now() + 1000)).toBe(0);
    expect(await sweepIdleSessions(Date.now() + SESSION_IDLE_MS + 1000)).toBe(1);
    expect(peekStudioSession('p1')).toBeUndefined();
    expect(peekStudioSession('p2')).toBe(watched);
    expect(store.docs.get('p1')!.doc.brief.notes).toContain('unsaved');
    unsubscribe();
    const release = watched.retain();
    expect(await sweepIdleSessions(Date.now() + SESSION_IDLE_MS + 1000)).toBe(0);
    release();
  });
});

describe('projectSummary', () => {
  it('prefers the cover, then the first drawn page', () => {
    const doc = plannedDoc();
    expect(projectSummary(doc).coverPath).toBeUndefined();
    doc.pages[1].render = { ...emptyRender(), status: 'ready', asset: { path: 'p2.webp', source: 'generated', at: 1 } };
    expect(projectSummary(doc).coverPath).toBe('p2.webp');
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'cover.webp', source: 'generated', at: 1 } };
    expect(projectSummary(doc).coverPath).toBe('cover.webp');
  });
});
