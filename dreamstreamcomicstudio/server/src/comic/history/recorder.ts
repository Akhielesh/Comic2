// Comic History — the recorder: automatic moments (versions plan §4.1–§4.4; package H2).
//
// One recorder per open comic (createHistoryHooks in hooks.ts builds it while COMIC_HISTORY is on). It is the
// session's HistoryHooks:
//   onCommit   SYNCHRONOUS bookkeeping (policy.ts classifyBatch: touchedKeys + opActor + §4.2), AI-run coalescing,
//              and the moments that capture the state BEFORE a commit: `before_ai` at a run's first AI commit (its
//              write starts right away and is never awaited: a paid run never waits for History), the `ai` row of a
//              run a change of yours closed, and the gap rule's `edits` row (content_at = before.updatedAt).
//   onFlush    the `ai` row of a finished run (stats.spend from the run's new spend entries, BYOK flagged), quiet
//              edits, and "Where you left off" on the final flush; awaited by flush(), so it waits only for its own
//              store calls (the same requests that already wait for the doc save) and never for a timer.
//   onLoad     "History starts here" (a pinned `start` row) for a comic with no rows; otherwise it reads the head.
//   onImported a pinned `import` row for a comic brought in from the classic editor (no session needed).
//
// Writes go through H1's HistoryStore only: chunkBook(doc) → missing(hashes) → put(only the missing chunks); a
// retryable CONFLICT (another write's GC collected an orphan between missing() and put()) is retried once with every
// chunk. A doc is never modified after it was hashed (docs are immutable; the chunk cache keys on identity).
//
// Nothing here throws into a save, a turn or a render: a failed capture is logged (comic_history_capture_failed),
// kept in a queue of ≤ HISTORY_PENDING_MAX (a pinned capture is never dropped) and retried at the NEXT commit or flush
// — never on a timer: the recorder creates no setTimeout/setInterval, so the backend stays sleepable.
//
// The `history` SSE event (a VersionRow, alternativeId null for "Original") goes through the sink to the comic's own
// open session; a budget-thinned put posts an info notice the same way (never silent).

import { AsyncLocalStorage } from 'node:async_hooks';
import { newId, type ComicDoc, type SpendEntry } from '../../../../shared/comic/doc.js';
import type { OpsOrigin, StudioEvent } from '../../../../shared/comic/events.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import type { PanelMomentAction } from '../../../../shared/comic/history/describe.js';
import { excludedOf } from '../../../../shared/comic/history/sections.js';
import { PINNED_HISTORY_KINDS, type ChangeItem, type HistoryKind, type VersionRow, type VersionSpend } from '../../../../shared/comic/history/types.js';
import { logger } from '../../lib/logger.js';
import { StudioError } from '../types.js';
import { assembleBook, chunkBook, type ChunkedBook } from './hash.js';
import type { HistoryHooks, HistoryImported, HistoryScope } from './hooks.js';
import {
  HISTORY_MOMENT_BATCHES_MAX,
  HISTORY_PENDING_MAX,
  beforeAiItems,
  budgetThinnedNotice,
  classifyBatch,
  continuesRun,
  hasBusyRenders,
  isGap,
  quietEditDue,
  rowActor,
  rowChanges,
  rowLabel,
  spendOf,
  statsOf,
  strongerActor,
  thumbsOf,
  trimChanges,
  type BatchClass,
  type MomentBatch
} from './policy.js';
import type { ChunkInput, HistoryStore, PutResult, VersionInput } from './storeTypes.js';

// ── The action behind a batch (Ship 2: panelize/flatten/rebind/apply a fix are the editor's; fix_panel names its panel)

const actionScope = new AsyncLocalStorage<PanelMomentAction>();

/** The fields of a StudioAction the history words need (a Ship 2 action, or any action's type). */
export const historyActionOf = (action: unknown): PanelMomentAction | undefined => {
  if (!action || typeof action !== 'object') return undefined;
  const a = action as Record<string, unknown>;
  if (typeof a.type !== 'string' || !a.type) return undefined;
  const out: PanelMomentAction = { type: a.type };
  if (typeof a.pageId === 'string') out.pageId = a.pageId;
  if (Array.isArray(a.pageIds)) out.pageIds = a.pageIds.filter((x): x is string => typeof x === 'string').slice(0, 200);
  if (typeof a.panelId === 'string') out.panelId = a.panelId;
  if (typeof a.mode === 'string') out.mode = a.mode;
  return out;
};

/**
 * Run `fn` with `action` as the batch's StudioAction for every commit it makes, however deep (renders it starts
 * included: AsyncLocalStorage follows the async work). The recorder passes its type to opActor (4th argument) and
 * the action to panelMomentsOfOps. jobs.ts startAction wraps each action with it (wave note); without it the recorder
 * classifies by origin alone.
 */
export const withHistoryAction = <T>(action: unknown, fn: () => T): T => {
  const a = historyActionOf(action);
  return a ? actionScope.run(a, fn) : fn();
};

/** The action of the commit being made (undefined outside withHistoryAction). */
export const currentHistoryAction = (): PanelMomentAction | undefined => actionScope.getStore();

// ── Notices ──────────────────────────────────────────────────────────────────

/** The info message a history notice is committed as (the archive-eviction notice's shape). */
export const historyNoticeMessage = (text: string, at: number): Extract<DocOp, { op: 'message' }> => ({
  op: 'message',
  msg: { id: newId('msg'), role: 'assistant', text, at, cards: [{ type: 'notice', id: newId('card'), tone: 'info', text }] }
});

// ── Types ────────────────────────────────────────────────────────────────────

export type HistoryEvent = Extract<StudioEvent, { type: 'history' }>;

/** Where the recorder tells the comic's open session about a new moment (and a budget notice). */
export interface HistoryRecorderSink {
  emit(event: HistoryEvent): void | Promise<void>;
  notice?(text: string): void | Promise<void>;
}

export interface HistoryRecorderOptions {
  /** The store, or how to get it (the process store is resolved on first use). */
  store: HistoryStore | (() => HistoryStore | Promise<HistoryStore>);
  /** The flush clock (epoch ms). A commit's own time is its doc's updatedAt (the session's clock). Default Date.now. */
  now?: () => number;
  sink?: HistoryRecorderSink;
}

export interface HistoryRecorder extends HistoryHooks {
  /** Resolves once every queued capture was tried (a failed one stays queued for the next commit or flush). */
  settled(): Promise<void>;
  /** Captures waiting to be written or retried. */
  readonly pending: number;
}

/** Changes since the last capture (who touched which section, and the edits that count as quiet editing). */
interface Accrued {
  keys: Map<string, NonNullable<BatchClass['actor']>>;
  batches: MomentBatch[];
  /** Your / the editor's commits (quiet editing). */
  edits: number;
  firstEditAt?: number;
  pages: Set<string>;
}

interface Run {
  lastAiAt: number;
  /** The book before the run's first AI commit (the `ai` row's diff base; the `before_ai` row's content). */
  beforeDoc: ComicDoc;
  /** The row holding the state before the run: the `before_ai` row, or the head when nothing changed since it. */
  parent: { id?: string };
  spend: SpendEntry[];
}

type CaptureKind = Extract<HistoryKind, 'start' | 'edits' | 'before_ai' | 'ai' | 'publish' | 'import'>;

interface Capture {
  kind: CaptureKind;
  doc: ComicDoc;
  contentAt: number;
  pinned: boolean;
  accrued: Accrued;
  /** The diff base (an `ai` row: the book before its run). Default: the head. */
  base?: ComicDoc;
  /** The label's own items (a `before_ai` row is worded by the run it precedes). */
  labelItems?: ChangeItem[];
  run?: Run;
  spend?: VersionSpend;
  final?: boolean;
  publishedRev?: number;
  legacyRef?: VersionInput['legacyRef'];
  attempts: number;
}

interface Head {
  id: string;
  root: string;
  line: string | null;
  /** The head's book, when known in memory (this session wrote it, or it equals the loaded doc). */
  doc?: ComicDoc | null;
}

const newAccrued = (): Accrued => ({ keys: new Map(), batches: [], edits: 0, pages: new Set() });

/** A classic import being written, per comic: the first load of that comic waits for it (one row, not two). */
const importsInFlight = new Map<string, Promise<void>>();

const PINNED = new Set<HistoryKind>(PINNED_HISTORY_KINDS);
const SPEND_KEPT_MAX = 500;

const isConflict = (err: unknown): boolean => err instanceof StudioError && err.code === 'CONFLICT' && err.retryable === true;
/** A refusal that will never succeed for this capture (it is dropped, not retried). */
const isPermanent = (err: unknown): boolean =>
  err instanceof StudioError && !err.retryable && (err.code === 'BAD_REQUEST' || err.code === 'LIMIT' || err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN');
const toChunk = ({ hash, kind, content, paths }: ChunkInput): ChunkInput => ({ hash, kind, content, paths });

class Recorder implements HistoryRecorder {
  private readonly scope: HistoryScope;
  private readonly now: () => number;
  private readonly sink?: HistoryRecorderSink;
  private readonly storeOf: () => HistoryStore | Promise<HistoryStore>;

  /** undefined: not read yet; null: the comic has no rows. */
  private head: Head | null | undefined = undefined;
  private headStale = false;
  /** A doc that may equal the head (the loaded doc; the doc a restore produced). */
  private candidate?: ComicDoc;
  private recordingNow = false;
  /** The tables are not applied (NOT_AVAILABLE): this session records nothing more. */
  private off = false;

  private queue: Capture[] = [];
  private draining: Promise<void> | null = null;

  private accrued = newAccrued();
  /** A change since the last capture of the latest state ("Where you left off" is due). */
  private dirty = false;
  private run: Run | null = null;
  /** Spend entries since the last flush with no AI run (a run adopts them: the writer is paid before its plan lands). */
  private spendSince: SpendEntry[] = [];
  /** When the line last changed (gap rule); unknown until the load or the first commit. */
  private lastChangeAt?: number;
  /** When the content last changed (content_at of flush-time rows). */
  private lastContentAt?: number;

  constructor(scope: HistoryScope, opts: HistoryRecorderOptions) {
    this.scope = { projectId: scope.projectId, userId: scope.userId };
    this.now = opts.now ?? (() => Date.now());
    this.sink = opts.sink;
    const store = opts.store;
    this.storeOf = typeof store === 'function' ? store : () => store;
  }

  get recording(): boolean {
    return this.recordingNow;
  }

  get pending(): number {
    return this.queue.length;
  }

  settled(): Promise<void> {
    return this.kick();
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  onCommit(before: ComicDoc, next: ComicDoc, ops: DocOp[], origin: OpsOrigin | undefined, _label: string | undefined): void {
    if (this.off) return;
    try {
      const at = Number.isFinite(next?.updatedAt) ? next.updatedAt : this.now();
      const action = currentHistoryAction();
      const b = classifyBatch(ops, origin, before, next, action?.type);
      if (b.spend.length) this.addSpend(b.spend);
      if (b.restore) this.restored(before, next, at);
      else {
        if (b.actor) this.content(before, next, ops, b, action, at);
        const rev = b.publication?.publishedRev;
        if (b.publication && typeof rev === 'number' && rev !== before.publication?.publishedRev) {
          this.capture('publish', next, { contentAt: this.lastContentAt ?? next.updatedAt, publishedRev: rev });
        }
      }
    } catch (err) {
      this.log('onCommit', err);
    }
    // A capture that failed earlier is retried now (never on a timer).
    if (this.queue.length) void this.kick();
  }

  async onFlush(doc: ComicDoc, opts: { final: boolean }): Promise<void> {
    if (this.off) return;
    try {
      const final = opts?.final === true;
      const contentAt = this.lastContentAt ?? doc.updatedAt;
      if (this.run) {
        // The stream waits for its renders before it flushes; a render still drawing keeps the run open.
        if (final || !hasBusyRenders(doc)) this.closeRun(doc, contentAt);
      } else {
        if (final) {
          if (this.dirty) this.capture('edits', doc, { contentAt, final: true });
        } else if (quietEditDue({ firstAt: this.accrued.firstEditAt, commits: this.accrued.edits, pages: this.accrued.pages.size }, this.now())) {
          this.capture('edits', doc, { contentAt });
        }
        // Spend of a request that changed nothing by AI belongs to no run.
        this.spendSince = [];
      }
    } catch (err) {
      this.log('onFlush', err);
    }
    await this.kick();
  }

  async onLoad(doc: ComicDoc): Promise<void> {
    if (this.off) return;
    // The loaded doc is where this session starts: anything noted before it (recovery commits) is part of it.
    this.accrued = newAccrued();
    this.dirty = false;
    this.run = null;
    this.spendSince = [];
    this.lastChangeAt = doc.updatedAt;
    this.lastContentAt = doc.updatedAt;
    this.head = undefined;
    this.candidate = doc;
    this.capture('start', doc, { contentAt: doc.updatedAt });
    await this.kick();
  }

  async onImported(info: HistoryImported): Promise<void> {
    if (this.off || !info?.doc) return;
    this.capture('import', info.doc, {
      contentAt: Number.isFinite(info.doc.updatedAt) ? info.doc.updatedAt : this.now(),
      legacyRef: { projectId: info.fromProjectId, ...(info.fromVersionId ? { snapshotId: info.fromVersionId } : {}) }
    });
    const done = this.kick();
    importsInFlight.set(this.scope.projectId, done);
    try {
      await done;
    } finally {
      if (importsInFlight.get(this.scope.projectId) === done) importsInFlight.delete(this.scope.projectId);
    }
  }

  // ── Bookkeeping (synchronous) ──────────────────────────────────────────────

  private addSpend(entries: SpendEntry[]): void {
    const into = this.run ? this.run.spend : this.spendSince;
    into.push(...entries);
    if (into.length > SPEND_KEPT_MAX) into.splice(0, into.length - SPEND_KEPT_MAX);
  }

  /** A content commit: the captures of `before` it calls for, then its own bookkeeping. */
  private content(before: ComicDoc, next: ComicDoc, ops: DocOp[], b: BatchClass, action: PanelMomentAction | undefined, at: number): void {
    const gap = isGap(this.lastChangeAt, at);
    if (b.ai) {
      if (this.run && continuesRun(this.run.lastAiAt, at)) this.run.lastAiAt = at;
      else {
        // A run that went quiet ends where it stood; the new one starts from there (its before_ai dedupes onto it).
        if (this.run) this.closeRun(before, before.updatedAt);
        this.startRun(before, next, ops, action, at);
      }
    } else if (b.you && this.run) {
      // A change of yours closes the AI run: its result is the book just before your change.
      this.closeRun(before, before.updatedAt);
    } else if (gap && !this.run) {
      // Back after a gap: keep the book as it was, at the time it was last changed.
      this.capture('edits', before, { contentAt: before.updatedAt });
    }
    // This commit's own changes (after the captures of `before` took the earlier ones).
    const acc = this.accrued;
    for (const [key, actor] of b.keys) acc.keys.set(key, strongerActor(acc.keys.get(key), actor)!);
    acc.batches.push({ ops, by: b.actor!, ...(action ? { action } : {}) });
    if (acc.batches.length > HISTORY_MOMENT_BATCHES_MAX) acc.batches.splice(0, acc.batches.length - HISTORY_MOMENT_BATCHES_MAX);
    if (b.edit && !b.ai) {
      acc.edits += 1;
      acc.firstEditAt ??= at;
      for (const id of b.pageIds) acc.pages.add(id);
    }
    if (b.you && !this.run) this.spendSince = [];
    this.dirty = true;
    this.lastChangeAt = at;
    this.lastContentAt = at;
  }

  private startRun(before: ComicDoc, next: ComicDoc, ops: DocOp[], action: PanelMomentAction | undefined, at: number): void {
    const run: Run = { lastAiAt: at, beforeDoc: before, parent: {}, spend: this.spendSince };
    this.spendSince = [];
    this.run = run;
    // Written right away and never awaited: a crash mid-run still leaves it, and the paid run never waits for it.
    this.capture('before_ai', before, { contentAt: before.updatedAt, run, labelItems: beforeAiItems(before, next, ops, action) });
  }

  private closeRun(doc: ComicDoc, contentAt: number): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    this.capture('ai', doc, { contentAt, run, base: run.beforeDoc, spend: spendOf(run.spend) });
  }

  /** A history restore or line switch (H3/H7 write their own rows): start over from the restored book. */
  private restored(before: ComicDoc, next: ComicDoc, at: number): void {
    if (this.run) this.closeRun(before, before.updatedAt);
    this.accrued = newAccrued();
    this.dirty = false;
    this.spendSince = [];
    this.headStale = true;
    this.candidate = next;
    this.lastChangeAt = at;
    this.lastContentAt = at;
  }

  private capture(kind: CaptureKind, doc: ComicDoc, extra: Partial<Omit<Capture, 'kind' | 'doc' | 'accrued' | 'attempts' | 'pinned'>>): void {
    const accrued = kind === 'start' || kind === 'import' ? newAccrued() : this.accrued;
    if (kind !== 'start' && kind !== 'import') {
      this.accrued = newAccrued();
      this.dirty = false;
    }
    this.enqueue({ kind, doc, pinned: PINNED.has(kind), accrued, attempts: 0, contentAt: extra.contentAt ?? doc.updatedAt, ...extra });
  }

  private enqueue(c: Capture): void {
    this.queue.push(c);
    while (this.queue.length > HISTORY_PENDING_MAX) {
      const from = this.draining ? 1 : 0; // the capture being written stays
      const i = this.queue.findIndex((x, k) => k >= from && !x.pinned);
      if (i < 0) break; // pinned captures are never dropped
      const [dropped] = this.queue.splice(i, 1);
      logger.warn('comic_history_capture_dropped', { projectId: this.scope.projectId, kind: dropped.kind, pending: this.queue.length });
    }
  }

  // ── Writing (asynchronous, one at a time, in order) ────────────────────────

  private kick(): Promise<void> {
    if (this.draining) return this.draining;
    if (!this.queue.length || this.off) return Promise.resolve();
    const drain = (async () => {
      try {
        while (this.queue.length && !this.off) {
          const c = this.queue[0];
          try {
            await this.write(c);
          } catch (err) {
            c.attempts += 1;
            if (err instanceof StudioError && err.code === 'NOT_AVAILABLE') {
              // The history tables are not there: record nothing more in this session (and say so once).
              this.off = true;
              this.queue = [];
              this.log('write', err, c);
              return;
            }
            if (isPermanent(err)) {
              if (err instanceof StudioError && err.code === 'NOT_FOUND') this.headStale = true; // a removed line, a moved comic
              this.log('write', err, c);
            } else {
              if (c.attempts === 1 || c.attempts % 10 === 0) this.log('write', err, c);
              return; // stays first in line: the next commit or flush retries it
            }
          }
          if (this.queue[0] === c) this.queue.shift();
        }
      } finally {
        this.draining = null;
      }
    })();
    this.draining = drain;
    return drain;
  }

  private store(): Promise<HistoryStore> {
    return Promise.resolve(this.storeOf());
  }

  /** The line's head (read once; again after a restore or a refusal that says the line moved). */
  private async ensureHead(): Promise<Head | null> {
    if (this.head !== undefined && !this.headStale) return this.head;
    const store = await this.store();
    const row = await store.head(this.scope);
    this.headStale = false;
    if (!row) {
      this.head = null;
      return null;
    }
    this.recordingNow = true;
    const root = typeof row.rootHash === 'string' ? row.rootHash : '';
    const candidate = this.candidate;
    this.head = { id: row.id, root, line: row.alternativeId ?? null, doc: candidate && root && chunkBook(candidate).rootHash === root ? candidate : undefined };
    return this.head;
  }

  /** The head's book for a diff: in memory, or reassembled from the store once (null when it can't be opened). */
  private async headDoc(live: ComicDoc): Promise<ComicDoc | null> {
    const head = this.head;
    if (!head) return null;
    if (head.doc !== undefined) return head.doc;
    try {
      const stored = await (await this.store()).get(this.scope, head.id);
      head.doc = stored ? assembleBook(stored.manifest, stored.bodies, excludedOf(live)) : null;
    } catch {
      head.doc = null;
    }
    return head.doc;
  }

  /** missing → put (only the missing chunks); a retryable CONFLICT is retried once with every chunk. */
  private async put(book: ChunkedBook, input: VersionInput): Promise<PutResult> {
    const store = await this.store();
    const missing = new Set(await store.missing(this.scope, book.hashes));
    try {
      return await store.put(this.scope, input, book.chunks.filter((c) => missing.has(c.hash)).map(toChunk));
    } catch (err) {
      if (!isConflict(err)) throw err;
      return store.put(this.scope, input, book.chunks.map(toChunk));
    }
  }

  private async write(c: Capture): Promise<void> {
    if (c.kind === 'start') {
      const importing = importsInFlight.get(this.scope.projectId);
      if (importing) await importing.catch(() => undefined);
    }
    const head = await this.ensureHead();
    const book = chunkBook(c.doc);
    if (c.kind === 'start' && head) {
      // History already started: the loaded book differs from its head when it changed while nothing recorded.
      if (head.root !== book.rootHash) this.dirty = true;
      return;
    }
    // Same book as the head: nothing new (a publish or import still goes to the store, which pins the head).
    if (head && head.root === book.rootHash && c.kind !== 'publish' && c.kind !== 'import') {
      if (c.run && c.kind === 'before_ai') c.run.parent.id = head.id;
      if (head.doc === undefined || head.doc === null) head.doc = c.doc;
      return;
    }
    const by = c.kind === 'ai' ? 'ai' : 'you';
    const firstRow = c.kind === 'start' || c.kind === 'import';
    const base = firstRow ? null : (c.base ?? (head ? await this.headDoc(c.doc) : null));
    const changes = firstRow ? [] : trimChanges(rowChanges(base, c.doc, by, c.accrued.keys, c.accrued.batches));
    // Nothing the creator made changed (a QC report, size variants, a safety verdict, a render's status): no moment.
    if (!firstRow && c.kind !== 'publish' && base && !changes.length) {
      if (c.run && c.kind === 'before_ai' && head) c.run.parent.id = head.id;
      return;
    }
    const focus = [...new Set([...changes, ...(c.labelItems || [])].flatMap((i) => i.pageIds || []))];
    const line = head ? head.line : null;
    const parentId = c.kind === 'ai' ? c.run?.parent.id : undefined;
    const input: VersionInput = {
      kind: c.kind,
      actor: rowActor(c.kind, changes),
      label: rowLabel(c.kind, c.labelItems ?? changes, { final: c.final }),
      rev: Number.isFinite(c.doc.rev) ? c.doc.rev : 0,
      contentAt: c.contentAt,
      manifest: book.manifest,
      rootHash: book.rootHash,
      chunks: book.hashes,
      changes,
      thumbs: thumbsOf(c.doc, focus),
      stats: statsOf(c.doc, c.spend),
      alternativeId: line,
      ...(c.pinned ? { pinned: true } : {}),
      ...(parentId ? { parentId } : {}),
      ...(c.doc.imageModel?.modelId ? { modelId: c.doc.imageModel.modelId } : {}),
      ...(typeof c.publishedRev === 'number' ? { publishedRev: c.publishedRev } : {}),
      ...(c.legacyRef ? { legacyRef: c.legacyRef } : {})
    };
    const res = await this.put(book, input);
    this.head = { id: res.id, root: book.rootHash, line, doc: c.doc };
    this.recordingNow = true;
    if (c.run && c.kind === 'before_ai') c.run.parent.id = res.id;
    if (!res.deduped) await this.announce(this.rowOf(res.id, input));
    else if (c.kind === 'publish' || c.kind === 'import') {
      // The store pinned and marked the unchanged head instead of writing a row: show the head as it is now.
      const now = await (await this.store()).head(this.scope).catch(() => null);
      if (now) {
        const { rootHash: _r, manifest: _m, ...row } = now;
        await this.announce(row);
      }
    }
    if (res.budgetThinned > 0) await this.notify(budgetThinnedNotice(res.budgetThinned));
  }

  /** The wire row of a write (what GET …/history lists; alternativeId null for "Original"). */
  private rowOf(id: string, v: VersionInput): VersionRow {
    return {
      id,
      kind: v.kind,
      actor: v.actor,
      label: v.label,
      pinned: v.pinned === true || PINNED.has(v.kind),
      rev: v.rev,
      contentAt: v.contentAt,
      createdAt: this.now(),
      alternativeId: v.alternativeId ?? null,
      codec: 'v5',
      changes: v.changes ?? [],
      thumbs: v.thumbs ?? [],
      stats: statsWithDefaults(v.stats),
      ...(v.parentId ? { parentId: v.parentId } : {}),
      ...(v.modelId ? { modelId: v.modelId } : {}),
      ...(typeof v.publishedRev === 'number' ? { publishedRev: v.publishedRev } : {}),
      ...(v.legacyRef?.projectId || v.legacyRef?.snapshotId
        ? { legacy: { ...(v.legacyRef.snapshotId ? { snapshotId: v.legacyRef.snapshotId } : {}), ...(v.legacyRef.projectId ? { projectId: v.legacyRef.projectId } : {}) } }
        : {})
    };
  }

  private async announce(version: VersionRow): Promise<void> {
    try {
      await this.sink?.emit({ type: 'history', version });
    } catch (err) {
      this.log('emit', err);
    }
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.sink?.notice?.(text);
    } catch (err) {
      this.log('notice', err);
    }
  }

  private log(hook: string, err: unknown, c?: Capture): void {
    logger.warn('comic_history_capture_failed', {
      projectId: this.scope.projectId,
      hook,
      ...(c ? { kind: c.kind, attempts: c.attempts, pending: this.queue.length } : {}),
      code: err instanceof StudioError ? err.code : undefined,
      message: (err as Error)?.message
    });
  }
}

const statsWithDefaults = (s: VersionInput['stats']): VersionRow['stats'] => ({
  pages: s?.pages ?? 0,
  drawn: s?.drawn ?? 0,
  lines: s?.lines ?? 0,
  langs: s?.langs ?? [],
  models: s?.models ?? [],
  ...(s?.spend ? { spend: s.spend } : {})
});

/** The recorder of one comic (versions plan §4): the HistoryHooks a session runs while COMIC_HISTORY is on. */
export function createHistoryRecorder(scope: HistoryScope, opts: HistoryRecorderOptions): HistoryRecorder {
  return new Recorder(scope, opts);
}
