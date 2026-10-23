import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type ArchivedVersion, type ComicDoc } from '../../../shared/comic/doc.js';
import { DOC_LIMITS as SHARED_LIMITS, MAX_ARCHIVE, MAX_RENDER_HISTORY } from '../../../shared/comic/limits.js';
import type { StudioEvent } from '../../../shared/comic/events.js';
import { fakeAssetStore, fakeDocStore, plannedDoc } from './orchestrator.fakes.js';
import {
  REF_INBOX_TTL_MS,
  archiveEvictionNotice,
  evictedArchivePaths,
  pruneRefInboxOps,
  GATE_EXPIRY_MS,
  INTERRUPTED_RENDER_ERROR,
  INTERRUPTED_RENDER_MS,
  SESSION_IDLE_MS,
  StudioSession,
  __resetSessionsForTests,
  drainStudioSessions,
  getStudioSession,
  peekStudioSession,
  projectSummary,
  recoveryOps,
  scheduleVariantBackfill,
  sweepIdleSessions,
  variantBackfillTargets
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

  it('reports busy while exclusive work is in flight', async () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    expect(session.busy).toBe(false);
    let release!: () => void;
    const run = session.runExclusive(() => new Promise<void>((r) => (release = r)));
    await flushMicrotasks();
    expect(session.busy).toBe(true);
    release();
    await run;
    expect(session.busy).toBe(false);
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

  it('refreshes the idle clock on a cache hit so a just-looked-up session is not swept', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    let clock = 1_000_000;
    const now = () => clock;
    const session = await getStudioSession('p1', 'u1', store, { now });
    // Far past the idle threshold, but a lookup lands just before the next sweep.
    clock += SESSION_IDLE_MS + 1000;
    expect(await getStudioSession('p1', 'u1', store, { now })).toBe(session); // touches it
    expect(await sweepIdleSessions(clock)).toBe(0);
    expect(peekStudioSession('p1')).toBe(session);
  });

  it('drainStudioSessions flushes debounced commits before shutdown', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    const session = await getStudioSession('p1', 'u1', store);
    const before = store.saves.length;
    session.commit([{ op: 'note_add', text: 'pending' }]);
    expect(session.persisted).toBe(false);
    await drainStudioSessions(1000);
    expect(session.persisted).toBe(true);
    expect(store.saves.length).toBe(before + 1);
  });

  it('retires a session on a terminal save failure: notifies, aborts, and reports persisted', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = await getStudioSession('p1', 'u1', store);
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));
    store.docs.delete('p1'); // comic deleted out from under the session
    session.commit([{ op: 'note_add', text: 'late edit' }]);
    await session.flush();
    expect(session.isGone).toBe(true);
    expect(session.persisted).toBe(true); // gone sessions report persisted so flush/sweep never block
    expect(session.abort.signal.aborted).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'NOT_FOUND' }));
    // The next lookup must not return the dead session.
    await expect(getStudioSession('p1', 'u1', store)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    errors.mockRestore();
  });

  it('a gone session is swept out at once, without waiting for the idle window', async () => {
    const store = fakeDocStore();
    store.docs.set('p1', { userId: 'u1', doc: plannedDoc('p1') });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const session = await getStudioSession('p1', 'u1', store);
    store.docs.delete('p1');
    session.commit([{ op: 'note_add', text: 'x' }]);
    await session.flush();
    expect(session.isGone).toBe(true);
    expect(peekStudioSession('p1')).toBe(session);
    expect(await sweepIdleSessions(Date.now())).toBe(1); // evicted though never idle
    expect(peekStudioSession('p1')).toBeUndefined();
    errors.mockRestore();
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

// ── v5 (contract §12.4) ──────────────────────────────────────────────────────

describe('commit origin/label, archive eviction notice, inbox prune, size guard', () => {
  afterEach(() => __resetSessionsForTests());

  it('the ops event carries origin and label', () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const events: StudioEvent[] = [];
    session.subscribe((e) => events.push(e));
    session.commit([{ op: 'note_add', text: 'x' }], { origin: 'director', label: 'Add note' });
    expect(events[0]).toMatchObject({ type: 'ops', origin: 'director', label: 'Add note' });
    session.dispose();
  });

  const fullArchive = (): ArchivedVersion[] =>
    Array.from({ length: MAX_ARCHIVE }, (_, i) => ({
      path: `arch-${i}.webp`,
      source: 'generated' as const,
      at: i,
      targetKey: 'page:pg_9',
      label: 'Page 9',
      archivedAt: 1_000 + i
    }));

  it('a commit that evicts archived versions is followed by an info notice (never silent)', () => {
    const doc = plannedDoc('p1');
    doc.archive = fullArchive();
    doc.archive[0] = { ...doc.archive[0], starred: true }; // starred: never evicted
    const history = Array.from({ length: MAX_RENDER_HISTORY }, (_, i) => ({ path: `h-${i}.webp`, source: 'generated' as const, at: i }));
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'cur.webp', source: 'generated', at: 9 }, history };
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc, store: fakeDocStore() });
    const events: StudioEvent[] = [];
    session.subscribe((e) => events.push(e));
    session.commit([{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: 'new.webp', source: 'generated', at: 10 }, updatedAt: 999_999 } }]);
    const after = session.doc;
    expect(after.archive).toHaveLength(MAX_ARCHIVE);
    expect(after.archive!.some((a) => a.path === 'arch-0.webp')).toBe(true);
    expect(after.archive!.some((a) => a.path === 'arch-1.webp')).toBe(false);
    const notice = after.conversation.at(-1)!;
    expect(notice.text).toBe(`Version archive is full (${MAX_ARCHIVE}): removed 1 oldest unstarred version that nothing uses. Star a version to keep it forever.`);
    expect(notice.cards?.[0]).toMatchObject({ type: 'notice', tone: 'info' });
    expect(events.filter((e) => e.type === 'ops')).toHaveLength(2);
    expect(events[1]).toMatchObject({ origin: 'job' });
    session.dispose();
  });

  it('no notice when nothing was evicted; a version restored out of the archive is not an eviction', () => {
    const before = plannedDoc('p1');
    before.archive = fullArchive();
    const restored = { ...before, archive: before.archive.slice(1), pages: before.pages.map((p, i) => (i === 0 ? { ...p, render: { ...p.render, asset: { path: 'arch-0.webp', source: 'generated' as const, at: 0 } } } : p)) };
    expect(evictedArchivePaths(before, restored)).toEqual([]);
    expect(evictedArchivePaths(before, { ...before, archive: before.archive.slice(2) })).toEqual([]); // under the cap ⇒ not an eviction
    expect(evictedArchivePaths(before, before)).toEqual([]);
    expect(archiveEvictionNotice(3, 1).msg.text).toContain('removed 3 oldest unstarred versions');
  });

  it('prunes composer uploads older than 24 h on load and on the sweeper, keeping fresh ones', async () => {
    const now = Date.now();
    const store = fakeDocStore();
    const doc = plannedDoc('p1');
    doc.refInbox = [
      { path: 'u/u1/p/p1/ref/old.webp', source: 'upload', at: now - REF_INBOX_TTL_MS - 1000 },
      { path: 'u/u1/p/p1/ref/new.webp', source: 'upload', at: now - 1000 }
    ];
    expect(pruneRefInboxOps(doc, now)).toEqual([{ op: 'ref_remove', owner: { kind: 'inbox' }, path: 'u/u1/p/p1/ref/old.webp' }]);
    store.docs.set('p1', { userId: 'u1', doc });
    const session = await getStudioSession('p1', 'u1', store, { now: () => now });
    expect(session.doc.refInbox!.map((r) => r.path)).toEqual(['u/u1/p/p1/ref/new.webp']);
    const unsubscribe = session.subscribe(() => undefined); // live, so not evicted
    await sweepIdleSessions(now + REF_INBOX_TTL_MS + 5000);
    expect(session.doc.refInbox).toEqual([]);
    expect(peekStudioSession('p1')).toBe(session);
    unsubscribe();
  });

  it('refuses a user/director edit past docBytesMax with 409 LIMIT; server job commits still land', () => {
    const session = new StudioSession({ projectId: 'p1', userId: 'u1', doc: createEmptyDoc('p1'), store: fakeDocStore() });
    const big = 'x'.repeat(SHARED_LIMITS.docBytesMax + 10);
    const rev = session.doc.rev;
    expect(() => session.commit([{ op: 'source', patch: { script: big } }], { origin: 'user' })).toThrow(expect.objectContaining({ code: 'LIMIT', status: 409 }));
    expect(session.doc.rev).toBe(rev);
    expect(session.doc.source.script).toBeUndefined();
    session.commit([{ op: 'note_add', text: 'job work' }], { origin: 'job' });
    expect(session.doc.brief.notes).toEqual(['job work']);
    session.dispose();
  });
});

describe('size-variant backfill on session load (contract §12.4)', () => {
  const img = (name: string, extra: Record<string, unknown> = {}) => ({ path: `u/user-1/p/proj-1/img/${name}.webp`, source: 'generated' as const, at: 1, w: 2048, h: 3072, ...extra });

  it('targets on-screen images first, skips blocked, already-sized, too-small, pub/, library/ and variant paths, capped', () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: img('p1'), history: [img('p1-old'), img('tiny', { w: 400, h: 600 })] };
    doc.pages[1].render = { ...emptyRender(), status: 'ready', asset: img('p2', { variants: [{ path: 'u/user-1/p/proj-1/img/p2_w480.webp', w: 480, h: 720 }] }) };
    doc.pages[2].render = { ...emptyRender(), status: 'ready', asset: img('p3', { safety: { assessed: 'X', at: 1 } }) };
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { ...img('c'), path: 'pub/AAAAAAAAAAAAAAAAAAAAAA/cover-0123456789ab.webp' } };
    doc.cast[0].sheet = { ...emptyRender(), status: 'ready', asset: img('maya') };
    doc.style.refs = [{ ...img('lib'), path: 'library/style/x.webp' }];
    expect(variantBackfillTargets(doc).map((a) => a.path.split('/').pop())).toEqual(['p1.webp', 'maya.webp', 'p1-old.webp']);
    expect(variantBackfillTargets(doc, 1)).toHaveLength(1);
  });

  it('records variants one image at a time with asset_meta (origin job), once per session', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: img('p1') };
    doc.pages[1].render = { ...emptyRender(), status: 'ready', asset: img('p2') };
    const session = new StudioSession({ projectId: doc.id, userId: 'user-1', doc, store: fakeDocStore(), saveDebounceMs: 5 });
    const events: StudioEvent[] = [];
    session.subscribe((e) => events.push(e));
    const assets = fakeAssetStore();
    let inFlight = 0;
    let maxInFlight = 0;
    const ensure = assets.ensureVariants.bind(assets);
    assets.ensureVariants = async (a) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return ensure(a);
    };
    const urls: string[][] = [];
    expect(await scheduleVariantBackfill(session, assets, { onUrls: async (p) => void urls.push(p) })).toBe(2);
    expect(maxInFlight).toBe(1);
    expect(session.doc.pages[0].render.asset!.variants!.map((v) => v.w)).toEqual([480, 1080]);
    const metaOps = events.filter((e) => e.type === 'ops' && e.ops[0].op === 'asset_meta');
    expect(metaOps).toHaveLength(2);
    expect(metaOps.every((e) => e.type === 'ops' && e.origin === 'job')).toBe(true);
    expect(urls.flat()).toContain('u/user-1/p/proj-1/img/p1_w480.webp');
    expect(scheduleVariantBackfill(session, assets)).toBeNull(); // once per session
    session.dispose();
  });
});

