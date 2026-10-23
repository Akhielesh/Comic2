// In-process studio sessions for Comic Studio (v4).
//
// One StudioSession per open project holds the authoritative ComicDoc in memory. Every
// change goes through commit(ops): the same pure applyOps the client runs, a rev bump,
// an `ops` event to every subscribed stream, and a debounced save (≤500 ms after the
// first unsaved change, never postponed by later commits). flush() persists right away
// and is awaited at the end of every request. A failed save is logged and retried — it
// never throws into a director turn or a render.
//
// Sessions are cached per project and verified against the requesting user on every
// lookup (a session is never handed to anyone but its owner). They are evicted after
// 20 idle minutes with no subscribers, no running turn and no running jobs; all timers
// are unref'd so an idle backend can sleep. See docs/features/comic-studio-v4.md §4.
//
// v5 (contract §12.4): every commit carries its origin/label on the ops event; a commit that
// evicted archived versions (cap 300) is followed by an info notice — never silent
// (decisions-final #8); composer uploads older than 24 h are pruned from the ref inbox on load
// and by the sweeper; a user/director edit that would grow the doc past DOC_LIMITS.docBytesMax
// is refused with 409 LIMIT (server work — renders, spend, messages — always lands).

import { applyOps, type DocOp } from '../../../shared/comic/ops.js';
import type { OpsOrigin, StudioEvent } from '../../../shared/comic/events.js';
import { DOC_LIMITS as SHARED_DOC_LIMITS, MAX_ARCHIVE } from '../../../shared/comic/limits.js';
import { REF_LIMITS } from '../../../shared/comic/refs.js';
import { archiveOf, collectAssetPaths, mapAssetRefs, newId, refInboxOf, type AssetRef, type ComicDoc, type RenderState, type RenderTarget } from '../../../shared/comic/doc.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
import { logger } from '../lib/logger.js';
import { isLibraryPath, isPublicationPath, isQuarantinePath } from './storagePaths.js';
import { StudioError, type AssetStore, type DocStore, type ProjectRowSummary, type StudioEventListener, type StudioSessionApi } from './types.js';

/**
 * Hard size limits on a document. Every source of new entities (client patches, director
 * tools, the writer's new cast) funnels through commit(), so the caps live here: one user
 * must never be able to grow an in-memory session until the shared backend runs out of heap.
 */
export const DOC_LIMITS = {
  ...SHARED_DOC_LIMITS,
  /** Legacy alias (= refsPerCharacter). Ref caps are per owner now: REF_LIMITS.character / .place. */
  refsPerEntity: SHARED_DOC_LIMITS.refsPerCharacter
} as const;

/** Ref cap for a character or place patch that sets `refs` wholesale (shared REF_LIMITS, same as capFor). */
const refCapFor = (op: 'character' | 'place'): number => (op === 'character' ? REF_LIMITS.character : REF_LIMITS.place);

/** Drop ops that would create entities past DOC_LIMITS (edits to existing ones always pass). */
export function enforceDocLimits(doc: ComicDoc, ops: DocOp[]): DocOp[] {
  const cast = new Set(doc.cast.map((c) => c.id));
  const places = new Set(doc.places.map((p) => p.id));
  // Running set of line ids per panel, so deletes earlier in the same batch make room for
  // adds later in it (e.g. edit_panel_text replaces a full panel with N deletes then N adds).
  const panelLines = new Map<string, Set<string>>();
  const linesOf = (pageId: string, panelId: string): Set<string> | null => {
    const key = `${pageId}\u0000${panelId}`;
    let set = panelLines.get(key);
    if (!set) {
      const panel = doc.pages.find((p) => p.id === pageId)?.panels.find((p) => p.id === panelId);
      if (!panel) return null;
      set = new Set(panel.lines.map((l) => l.id));
      panelLines.set(key, set);
    }
    return set;
  };
  const out: DocOp[] = [];
  let dropped = 0;
  for (const op of ops) {
    if (op.op === 'character' && !cast.has(op.id)) {
      if (cast.size >= DOC_LIMITS.cast) { dropped += 1; continue; }
      cast.add(op.id);
    } else if (op.op === 'place' && !places.has(op.id)) {
      if (places.size >= DOC_LIMITS.places) { dropped += 1; continue; }
      places.add(op.id);
    } else if (op.op === 'character_remove') {
      cast.delete(op.id);
    } else if (op.op === 'place_remove') {
      places.delete(op.id);
    } else if (op.op === 'line') {
      const lines = linesOf(op.pageId, op.panelId);
      if (lines) {
        if (op.patch === null) {
          lines.delete(op.id);
        } else if (!lines.has(op.id)) {
          if (lines.size >= DOC_LIMITS.linesPerPanel) { dropped += 1; continue; }
          lines.add(op.id);
        }
      }
    }
    if ((op.op === 'character' || op.op === 'place') && Array.isArray(op.patch.refs) && op.patch.refs.length > refCapFor(op.op)) {
      out.push({ ...op, patch: { ...op.patch, refs: op.patch.refs.slice(0, refCapFor(op.op)) } } as DocOp);
      continue;
    }
    out.push(op);
  }
  if (dropped) logger.warn('comic_doc_limits_dropped_ops', { dropped, cast: cast.size, places: places.size });
  return out;
}

/** Debounce window for persistence after a commit. */
export const SAVE_DEBOUNCE_MS = 500;
/** A render stuck in queued/rendering longer than this (and not running here) was interrupted. */
export const INTERRUPTED_RENDER_MS = 3 * 60_000;
/** An open spend gate older than this is declined automatically. */
export const GATE_EXPIRY_MS = 24 * 60 * 60_000;
/** Idle sessions (no subscribers, turns or jobs) are dropped after this long. */
export const SESSION_IDLE_MS = 20 * 60_000;
export const INTERRUPTED_RENDER_ERROR = 'Interrupted — tap retry.';

const SWEEP_INTERVAL_MS = 60_000;
/** Composer uploads that were never sent or assigned are dropped from the inbox after this long. */
export const REF_INBOX_TTL_MS = REF_LIMITS.inboxTtlMs;
/** Re-measure the serialized doc at least every N commits (between, op sizes are added). */
const DOC_BYTES_REMEASURE_EVERY = 25;
/** Backoff for retrying a failed save when nothing else triggers one. */
const SAVE_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Listing summary mirrored onto the projects row on every save. */
export const projectSummary = (doc: ComicDoc): ProjectRowSummary => {
  const firstReady = [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .find((p) => p.render.status === 'ready' && p.render.asset?.path);
  const coverPath = doc.cover.render.asset?.path || firstReady?.render.asset?.path;
  return {
    title: doc.brief.title || 'Untitled comic',
    ...(coverPath ? { coverPath } : {}),
    ...(doc.brief.logline ? { logline: doc.brief.logline } : {})
  };
};

/** Every render state in the doc with the target that addresses it. */
export const listRenderTargets = (doc: ComicDoc): { target: RenderTarget; render: RenderState }[] => {
  const out: { target: RenderTarget; render: RenderState }[] = [];
  doc.style.options.forEach((o) => out.push({ target: { kind: 'style_option', id: o.id }, render: o.render }));
  doc.cast.forEach((c) => out.push({ target: { kind: 'sheet', id: c.id }, render: c.sheet }));
  doc.places.forEach((p) => out.push({ target: { kind: 'place', id: p.id }, render: p.sheet }));
  doc.pages.forEach((p) => out.push({ target: { kind: 'page', id: p.id }, render: p.render }));
  out.push({ target: { kind: 'cover' }, render: doc.cover.render });
  return out;
};

/**
 * Ops that repair a freshly loaded doc: renders left queued/rendering by a previous
 * process (or for longer than INTERRUPTED_RENDER_MS) become failed so the user can
 * retry, and an open gate older than a day is declined.
 */
export const recoveryOps = (doc: ComicDoc, opts: { now: number; allInFlight: boolean }): DocOp[] => {
  const ops: DocOp[] = [];
  for (const { target, render } of listRenderTargets(doc)) {
    if (render.status !== 'queued' && render.status !== 'rendering') continue;
    const age = opts.now - (render.updatedAt || 0);
    if (!opts.allInFlight && age < INTERRUPTED_RENDER_MS) continue;
    ops.push({ op: 'render', target, patch: { status: 'failed', error: INTERRUPTED_RENDER_ERROR, updatedAt: opts.now } });
  }
  if (doc.gate && doc.gate.status === 'open' && opts.now - (doc.gate.createdAt || 0) > GATE_EXPIRY_MS) {
    ops.push({ op: 'gate', gate: { ...doc.gate, status: 'declined' } });
  }
  return ops;
};

/** `ref_remove` ops for composer-inbox uploads older than REF_INBOX_TTL_MS (the storage GC removes the files). */
export const pruneRefInboxOps = (doc: ComicDoc, now: number): DocOp[] =>
  refInboxOf(doc)
    .filter((r) => r?.path && typeof r.at === 'number' && now - r.at > REF_INBOX_TTL_MS)
    .map((r): DocOp => ({ op: 'ref_remove', owner: { kind: 'inbox' }, path: r.path }));

/**
 * Archive paths a commit evicted (§5.3.1 step 5): gone from the archive AND referenced nowhere
 * else afterwards (a version restored out of the archive is not an eviction).
 */
export const evictedArchivePaths = (before: ComicDoc, after: ComicDoc): string[] => {
  const prev = archiveOf(before);
  const next = archiveOf(after);
  if (next === prev || next.length < MAX_ARCHIVE) return [];
  const kept = new Set(next.map((a) => a.path));
  const gone = prev.filter((a) => !kept.has(a.path)).map((a) => a.path);
  if (!gone.length) return [];
  const used = new Set(collectAssetPaths(after));
  return [...new Set(gone.filter((p) => !used.has(p)))];
};

/** The info notice for an archive eviction (never silent — decisions-final #8). */
export const archiveEvictionNotice = (count: number, now: number) => {
  const text = `Version archive is full (${MAX_ARCHIVE}): removed ${count} oldest unstarred ${count === 1 ? 'version' : 'versions'} that nothing uses. Star a version to keep it forever.`;
  return {
    op: 'message' as const,
    msg: { id: newId('msg'), role: 'assistant' as const, text, at: now, cards: [{ type: 'notice' as const, id: newId('card'), tone: 'info' as const, text }] }
  };
};

// ── Session ──────────────────────────────────────────────────────────────────

export interface StudioSessionOptions {
  projectId: string;
  userId: string;
  doc: ComicDoc;
  store: DocStore;
  saveDebounceMs?: number;
  now?: () => number;
}

export class StudioSession implements StudioSessionApi {
  readonly projectId: string;
  readonly userId: string;

  private current: ComicDoc;
  private readonly store: DocStore;
  private readonly listeners = new Set<StudioEventListener>();
  private controller = new AbortController();
  private readonly saveDebounceMs: number;
  private readonly now: () => number;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  /** Revision of the last doc the store accepted. */
  private savedRev: number;
  private saveFailures = 0;
  /** Set when a save failed with a terminal error (doc deleted / ownership lost); no more retries. */
  private gone = false;
  /** Serialized size estimate of the doc (exact on re-measure, op sizes added between). */
  private approxBytes = -1;
  private commitsSinceMeasure = 0;
  private warnedBytes = false;

  /** Turn mutex: the tail of the queue of exclusive work. */
  private lockTail: Promise<void> = Promise.resolve();
  private exclusiveDepth = 0;
  /** Jobs/turns in flight (eviction guard). */
  private activeWork = 0;
  private lastActiveAt: number;

  constructor(opts: StudioSessionOptions) {
    this.projectId = opts.projectId;
    this.userId = opts.userId;
    this.current = opts.doc;
    this.store = opts.store;
    this.saveDebounceMs = opts.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
    this.now = opts.now || (() => Date.now());
    this.savedRev = opts.doc.rev;
    this.lastActiveAt = this.now();
  }

  get doc(): ComicDoc {
    return this.current;
  }

  get abort(): AbortController {
    return this.controller;
  }

  /** True while a director turn (or other exclusive work) holds the turn lock. */
  get turnRunning(): boolean {
    return this.exclusiveDepth > 0;
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  /** True when every committed revision has been persisted (a gone session never saves again, so nothing waits on it). */
  get persisted(): boolean {
    return this.gone || (this.savedRev >= this.current.rev && !this.saving);
  }

  /** True while a director turn or render is in flight (shutdown drain / eviction guard). */
  get busy(): boolean {
    return this.activeWork > 0 || this.exclusiveDepth > 0;
  }

  /** True once a save failed terminally (the comic was deleted or ownership moved). */
  get isGone(): boolean {
    return this.gone;
  }

  /**
   * Apply ops atomically, bump rev, emit an `ops` event (with origin/label), schedule the save.
   * Throws StudioError LIMIT (409) only for a user/director edit that would push the doc past
   * DOC_LIMITS.docBytesMax; job commits (paid renders, spend, messages) always land.
   */
  commit(rawOps: DocOp[], opts?: { origin?: OpsOrigin; label?: string }): ComicDoc {
    if (!Array.isArray(rawOps) || !rawOps.length) return this.current;
    const ops = enforceDocLimits(this.current, rawOps);
    if (!ops.length) return this.current;
    const at = this.now();
    const before = this.current;
    const next = applyOps(before, ops, at);
    this.checkSize(next, ops, opts?.origin);
    this.current = { ...next, rev: before.rev + 1, updatedAt: at };
    this.touch();
    this.emit({
      type: 'ops',
      rev: this.current.rev,
      ops,
      ...(opts?.origin ? { origin: opts.origin } : {}),
      ...(opts?.label ? { label: opts.label } : {})
    });
    this.scheduleSave(this.saveDebounceMs);
    // Archive eviction is never silent (decisions-final #8).
    const evicted = evictedArchivePaths(before, this.current);
    if (evicted.length) {
      logger.info('comic_archive_evicted', { projectId: this.projectId, count: evicted.length });
      this.commit([archiveEvictionNotice(evicted.length, at)], { origin: 'job' });
    }
    return this.current;
  }

  /** Doc size guard (DOC_LIMITS.docBytesWarn / docBytesMax), cheap between periodic re-measures. */
  private checkSize(next: ComicDoc, ops: DocOp[], origin?: OpsOrigin): void {
    const measure = () => {
      this.approxBytes = JSON.stringify(next).length;
      this.commitsSinceMeasure = 0;
    };
    this.commitsSinceMeasure += 1;
    if (this.approxBytes < 0 || this.commitsSinceMeasure >= DOC_BYTES_REMEASURE_EVERY) measure();
    else this.approxBytes += JSON.stringify(ops).length;
    if (this.approxBytes > SHARED_DOC_LIMITS.docBytesMax && (origin === 'user' || origin === 'director')) {
      measure();
      if (this.approxBytes > SHARED_DOC_LIMITS.docBytesMax) {
        logger.warn('comic_doc_too_large', { projectId: this.projectId, bytes: this.approxBytes });
        this.approxBytes = -1; // the refused doc is not the current one: measure afresh next time
        throw new StudioError('LIMIT', 'This comic has grown too large to save more changes. Delete unused pages or versions, or shorten the pasted script, then try again.', {
          status: 409
        });
      }
    }
    if (this.approxBytes > SHARED_DOC_LIMITS.docBytesWarn && !this.warnedBytes) {
      this.warnedBytes = true;
      logger.warn('comic_doc_bytes', { projectId: this.projectId, bytes: this.approxBytes });
    }
  }

  emit(event: StudioEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        logger.warn('comic_session_listener_failed', { projectId: this.projectId, message: (err as Error)?.message });
      }
    }
  }

  subscribe(listener: StudioEventListener): () => void {
    this.listeners.add(listener);
    this.touch();
    return () => {
      this.listeners.delete(listener);
      this.touch();
    };
  }

  /** Persist now: waits for an in-flight save, then saves anything newer. Never throws. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
  }

  resetAbort(): AbortController {
    this.controller = new AbortController();
    return this.controller;
  }

  /**
   * Run `fn` while holding this session's turn lock (one director turn at a time per
   * project). Waiters queue in arrival order; a failure never poisons the queue.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.exclusiveDepth += 1;
    const done = this.retain();
    try {
      await previous;
      return await fn();
    } finally {
      this.exclusiveDepth -= 1;
      done();
      release();
    }
  }

  /** Mark work in flight (keeps the session from being evicted). Returns the release. */
  retain(): () => void {
    this.activeWork += 1;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWork = Math.max(0, this.activeWork - 1);
      this.touch();
    };
  }

  /** Whether the cache may drop this session. */
  isIdle(now = this.now()): boolean {
    return (
      this.listeners.size === 0 &&
      this.activeWork === 0 &&
      this.exclusiveDepth === 0 &&
      now - this.lastActiveAt >= SESSION_IDLE_MS
    );
  }

  /** Stop timers (eviction / tests). Pending changes should be flushed first. */
  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.listeners.clear();
  }

  /** Mark recent use (pushes back idle eviction). Callable on a cache hit so a looked-up session isn't swept. */
  touch(): void {
    this.lastActiveAt = this.now();
  }

  private scheduleSave(delayMs: number): void {
    if (this.saveTimer) return;
    const timer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, delayMs);
    timer.unref?.();
    this.saveTimer = timer;
  }

  private async persist(): Promise<void> {
    // Coalesce: wait for the save in flight, then save once more only if needed.
    while (this.saving) await this.saving;
    if (this.gone) return; // doc is gone — stop trying to save it
    if (this.savedRev >= this.current.rev) return;
    const doc = this.current;
    const run = (async () => {
      try {
        await this.store.save({ projectId: this.projectId, userId: this.userId, doc, summary: projectSummary(doc) });
        this.savedRev = Math.max(this.savedRev, doc.rev);
        this.saveFailures = 0;
      } catch (err) {
        this.saveFailures += 1;
        const code = (err as StudioError)?.code;
        logger.error('comic_session_save_failed', {
          projectId: this.projectId,
          rev: doc.rev,
          failures: this.saveFailures,
          code,
          message: (err as Error)?.message
        });
        // NOT_FOUND / FORBIDDEN are terminal: the comic was deleted or ownership moved, so
        // retrying can never succeed. Stop retrying, abort any renders, and tell the user.
        if (code === 'NOT_FOUND' || code === 'FORBIDDEN') {
          this.gone = true;
          this.controller.abort();
          this.emit({ type: 'error', code, message: "This comic no longer exists, so your latest changes couldn't be saved." });
          return;
        }
        // Retry on a backoff (a later commit or flush retries sooner).
        const delay = SAVE_RETRY_DELAYS_MS[this.saveFailures - 1];
        if (delay !== undefined) this.scheduleSave(delay);
      }
    })();
    this.saving = run;
    try {
      await run;
    } finally {
      if (this.saving === run) this.saving = null;
    }
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

const sessions = new Map<string, StudioSession>();
const loading = new Map<string, Promise<StudioSession>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

const notFound = () => new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });

const ensureSweeper = () => {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepIdleSessions();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
};

/** Flush and drop idle sessions. Exported for tests. */
export const sweepIdleSessions = async (now = Date.now()): Promise<number> => {
  let evicted = 0;
  for (const [projectId, session] of [...sessions]) {
    if (session.isGone) {
      // Terminal save failure: drop it right away so it stops reloading and leaking heap.
      sessions.delete(projectId);
      session.dispose();
      evicted += 1;
      continue;
    }
    // Old composer uploads leave the inbox on every sweep, idle or not (never during a turn).
    if (!session.turnRunning) {
      const pruned = pruneRefInboxOps(session.doc, now);
      if (pruned.length) {
        try {
          session.commit(pruned, { origin: 'job', label: 'Clear old uploads' });
          logger.info('comic_ref_inbox_pruned', { projectId, count: pruned.length });
        } catch (err) {
          logger.warn('comic_ref_inbox_prune_failed', { projectId, message: (err as Error)?.message });
        }
      }
    }
    if (!session.isIdle(now)) continue;
    await session.flush();
    // Something may have started while flushing.
    if (!session.isIdle(now) || sessions.get(projectId) !== session) continue;
    if (!session.persisted) continue; // keep unsaved work in memory; retried next sweep
    sessions.delete(projectId);
    session.dispose();
    evicted += 1;
  }
  if (!sessions.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  return evicted;
};

/**
 * Shutdown (SIGTERM/SIGINT): wait, bounded, for running turns/renders to settle — an image
 * call is paid for once started, so it is drained rather than aborted — then persist every
 * cached session. flush() never throws; the outer race keeps a hung store from blocking exit.
 */
export const drainStudioSessions = async (timeoutMs = 25_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while ([...sessions.values()].some((s) => s.busy) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await Promise.race([
    Promise.allSettled([...sessions.values()].map((s) => s.flush())),
    new Promise((r) => setTimeout(r, Math.max(1_000, deadline - Date.now())))
  ]);
};

/**
 * The session for a project, loading it (owner-scoped) on first use. Throws
 * StudioError NOT_FOUND when the project is missing or belongs to someone else.
 */
export async function getStudioSession(
  projectId: string,
  userId: string,
  store: DocStore,
  opts: { now?: () => number; saveDebounceMs?: number } = {}
): Promise<StudioSession> {
  if (!projectId || !userId) throw notFound();
  const cached = sessions.get(projectId);
  if (cached?.isGone) {
    // A terminal save failure retired this session; drop it and load fresh (which re-checks the store).
    sessions.delete(projectId);
    cached.dispose();
  } else if (cached) {
    // Refresh the idle clock on every hit so the sweeper can't evict a session a request just looked up.
    if (cached.userId === userId) {
      cached.touch();
      return cached;
    }
    // Never share a session across users. The store decides whether this user owns it.
    const doc = await store.load(projectId, userId).catch(() => null);
    if (!doc) throw notFound();
    // Ownership moved (e.g. the project was transferred): retire the old session.
    await cached.flush();
    sessions.delete(projectId);
    cached.dispose();
  }

  // Keyed by caller too: store.load is owner-scoped, so a non-owner's load always fails — and that
  // failure (NOT_FOUND, or a transient store error) must never become the owner's answer. Concurrent
  // loads by the same caller still share one promise (one session).
  const loadKey = `${projectId}\u0000${userId}`;
  const pending = loading.get(loadKey);
  if (pending) {
    const session = await pending;
    if (session.userId !== userId) throw notFound(); // defensive: cannot trigger with the per-caller key
    return session;
  }

  const load = (async () => {
    const now = opts.now || (() => Date.now());
    const doc = await store.load(projectId, userId);
    if (!doc) throw notFound();
    const session = new StudioSession({ projectId, userId, doc, store, now, saveDebounceMs: opts.saveDebounceMs });
    // Nothing can be rendering for this project in this process yet, so anything
    // queued/rendering was interrupted (restart, deploy, crash).
    const repair = recoveryOps(doc, { now: now(), allInFlight: true });
    if (repair.length) {
      session.commit(repair, { origin: 'job' });
      logger.info('comic_session_recovered', { projectId, ops: repair.length });
    }
    const pruned = pruneRefInboxOps(session.doc, now());
    if (pruned.length) {
      session.commit(pruned, { origin: 'job', label: 'Clear old uploads' });
      logger.info('comic_ref_inbox_pruned', { projectId, count: pruned.length });
    }
    sessions.set(projectId, session);
    ensureSweeper();
    return session;
  })();
  loading.set(loadKey, load);
  try {
    return await load;
  } finally {
    if (loading.get(loadKey) === load) loading.delete(loadKey);
  }
}

// ── Size-variant backfill (contract §12.4) ───────────────────────────────────

/** Images per session load that get their missing 480w/1080w variants (one at a time, in the background). */
const SMALLEST_VARIANT_W = 480;
export const VARIANT_BACKFILL_MAX = 40;
const backfilled = new WeakSet<StudioSession>();

/**
 * Images on screen first that still have no size variants: current pages, the cover, sheets, style
 * options and the style board, then refs, then older versions. Never a blocked/quarantined image,
 * never a pub/, library/ or q/ object (ensureVariants would skip those anyway), each path once.
 */
export const variantBackfillTargets = (doc: ComicDoc, max = VARIANT_BACKFILL_MAX): AssetRef[] => {
  const seen = new Set<string>();
  const out: AssetRef[] = [];
  const want = (a?: AssetRef) => {
    if (out.length >= max || !a?.path || seen.has(a.path)) return;
    seen.add(a.path);
    if (a.variants?.length || !canServeToOwner(a) || a.safety?.pending) return;
    // Already small (≤ assets.ts VARIANT_WIDTHS[0] = 480; not imported — assets.ts pulls in sharp):
    // ensureVariants would answer [] without work, so don't spend one of the 40 slots on it.
    if (typeof a.w === 'number' && a.w > 0 && a.w <= SMALLEST_VARIANT_W) return;
    if (isPublicationPath(a.path) || isLibraryPath(a.path) || isQuarantinePath(a.path) || /_w\d{2,4}\.webp$/.test(a.path)) return;
    out.push(a);
  };
  const current = (r?: RenderState) => want(r?.asset);
  [...doc.pages].sort((a, b) => a.n - b.n).forEach((p) => current(p.render));
  current(doc.cover.render);
  doc.cast.forEach((c) => current(c.sheet));
  doc.places.forEach((p) => current(p.sheet));
  doc.style.options.forEach((o) => current(o.render));
  want(doc.style.board);
  [...doc.style.refs, ...doc.cast.flatMap((c) => c.refs), ...doc.places.flatMap((p) => p.refs)].forEach(want);
  // Everything else the doc holds (history, archive, trash): mapAssetRefs walks every lane.
  mapAssetRefs(doc, (a) => {
    want(a);
    return a;
  });
  return out;
};

/**
 * On session load: create the missing size variants of up to VARIANT_BACKFILL_MAX images, ONE at a time
 * (sharp shares the 3-slot gate with uploads and renders), then record them with `asset_meta {variants}`
 * so grids and filmstrips stop loading full-size originals. Idempotent and once per session; a failure
 * only logs. `onUrls` signs the new variant paths for the open tabs. Never on a timer.
 */
export function scheduleVariantBackfill(
  session: StudioSession,
  assets: Pick<AssetStore, 'ensureVariants'>,
  opts: { max?: number; onUrls?: (paths: string[]) => Promise<unknown> } = {}
): Promise<number> | null {
  if (backfilled.has(session) || session.isGone) return null;
  backfilled.add(session);
  const targets = variantBackfillTargets(session.doc, opts.max ?? VARIANT_BACKFILL_MAX);
  if (!targets.length) return null;
  const done = session.retain();
  return (async () => {
    let made = 0;
    for (const asset of targets) {
      if (session.isGone) break;
      try {
        const variants = await assets.ensureVariants(asset);
        // The image may have been removed or replaced while we worked: only record what is still there.
        const still = collectAssetPaths(session.doc).includes(asset.path);
        if (!variants?.length || !still) continue;
        session.commit([{ op: 'asset_meta', path: asset.path, patch: { variants } }], { origin: 'job' });
        made += 1;
        if (opts.onUrls) await opts.onUrls(variants.map((v) => v.path)).catch(() => undefined);
      } catch (err) {
        logger.warn('comic_variant_backfill_failed', { projectId: session.projectId, message: (err as Error)?.message });
      }
    }
    if (made) logger.info('comic_variant_backfill', { projectId: session.projectId, count: made, checked: targets.length });
    return made;
  })().finally(done);
}

/** Cached session for a project if one exists (no load, no ownership check). */
export const peekStudioSession = (projectId: string): StudioSession | undefined => sessions.get(projectId);

/** Test hook: drop every cached session and stop the sweeper. */
export function __resetSessionsForTests(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  loading.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
