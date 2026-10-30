// Comic History — the recorder's rules (versions plan §4.2–§4.4; package H2). PURE: no clock (every time is passed
// in), no store, no I/O, no timers. recorder.ts holds the state and does the writes; this file decides.
//
//   classifyBatch   who made a commit (§4.2) and what it touched: touchedKeys/opActor from shared/comic/history/
//                   touched.ts (K2a's ops included, never re-classified), plus the §4.2 rules that a paid AI action
//                   ("Plan the pages") is the AI's whoever clicked it, and a fitted (derived) image and a balloon
//                   re-fit are the editor's free work whoever asked.
//   the clocks      gap (30 min), AI-run coalescing (10 min), quiet editing (10 min / 25 commits / 3 pages).
//   the row         changes (≤ 60, semantic: diffBooks hides QC, variants and safety), panel moments, thumbs (≤ 8),
//                   stats with the run's spend (BYOK flagged), and the plain-words label (describeChanges).
//
// Every threshold is one named constant (HISTORY_LIMITS or below), so a change is a one-line edit.

import type { ComicDoc, RenderState, SpendEntry } from '../../../../shared/comic/doc.js';
import { HISTORY_LIMITS } from '../../../../shared/comic/limits.js';
import type { PublicationMirror } from '../../../../shared/comic/publication.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import type { OpsOrigin } from '../../../../shared/comic/events.js';
import { diffBooks } from '../../../../shared/comic/history/diff.js';
import {
  changeItemsFromDiff,
  describeChanges,
  panelMomentsOfOps,
  withPanelMoments,
  type PanelChangeItem,
  type PanelMomentAction
} from '../../../../shared/comic/history/describe.js';
import { SECTION_KEYS, parseSectionKey } from '../../../../shared/comic/history/sections.js';
import { AI_ACTIONS, CAPTURE_NEUTRAL_OPS, EDITOR_ACTIONS, opActor, touchedKeys } from '../../../../shared/comic/history/touched.js';
import type { ChangeItem, HistoryActor, HistoryKind, VersionSpend, VersionStats, VersionThumb } from '../../../../shared/comic/history/types.js';

const MINUTE = 60_000;

/** The recorder's clocks and caps (versions plan §3.3 HISTORY_LIMITS, §4.1). */
export const HISTORY_POLICY = {
  /** The first commit this long after the line's last change captures the state before it (§4.3 #3). */
  gapMs: HISTORY_LIMITS.gapMinutes * MINUTE,
  /** Consecutive AI commits at most this far apart, with no commit of yours between, are one run (§4.3 #1). */
  aiRunGapMs: HISTORY_LIMITS.aiRunGapMinutes * MINUTE,
  /** Quiet editing (§4.3 #4): an `edits` row at a flush once your unrecorded edits are this old, … */
  quietEditMs: HISTORY_LIMITS.quietEditMinutes * MINUTE,
  /** … this many commits, … */
  quietEditCommits: HISTORY_LIMITS.quietEditCommits,
  /** … or touch this many pages. */
  quietEditPages: HISTORY_LIMITS.quietEditPages,
  changesPerRow: HISTORY_LIMITS.changesPerRow,
  thumbsPerRow: HISTORY_LIMITS.thumbsPerRow
} as const;

/** Failed captures kept for a retry at the next commit or flush (§4.1). A pinned capture is never dropped. */
export const HISTORY_PENDING_MAX = 5;
/** Ops of one AI run (or one stretch of edits) kept for the panel moments of its row (memory bound). */
export const HISTORY_MOMENT_BATCHES_MAX = 200;

// ── Classification (§4.2) ────────────────────────────────────────────────────

/**
 * The writer's batch by its commit label, for a commit made without its action (jobs.ts startAction passes the action
 * through withHistoryAction, so "Plan the pages" is named by touched.ts AI_ACTIONS; this covers anything outside it):
 * one of these labels with a `pages` or `character` op is the AI's. The labels are set by the server only (a client
 * 'patch' commits without a label).
 */
export const AI_WRITER_LABELS: ReadonlySet<string> = new Set(['Plan pages', 'Revise pages', 'Add cast']);
const AI_WRITER_OPS: ReadonlySet<string> = new Set(['pages', 'character']);

/** The writer's batch, named by its commit label (the fallback while the action is unknown). */
export const isAiWriterBatch = (ops: readonly DocOp[], label: string | undefined): boolean =>
  typeof label === 'string' && AI_WRITER_LABELS.has(label) && ops.some((op) => !!op && AI_WRITER_OPS.has(op.op));

/** How much an actor says about a change: a key touched by the AI and re-fitted by the editor reads as the AI's. */
const ACTOR_RANK: Record<HistoryActor, number> = { ai: 4, you: 3, editor: 2, system: 1 };
export const strongerActor = (a: HistoryActor | null | undefined, b: HistoryActor | null | undefined): HistoryActor | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return ACTOR_RANK[b] > ACTOR_RANK[a] ? b : a;
};

const isDerivedRender = (op: DocOp): boolean =>
  op?.op === 'render' && (op as { patch?: { origin?: unknown } }).patch?.origin === 'derived';

/** A consented image-model switch in these ops (the lock a first drawing sets, or a migration, is no switch). */
export const hasModelSwitch = (ops: readonly DocOp[]): boolean =>
  ops.some((op) => op?.op === 'image_model' && (op as { lock?: { origin?: string } }).lock?.origin === 'user_change');

/** What one commit means for history. */
export interface BatchClass {
  /** The batch's most significant actor; null when it touched no book section (messages, spend, gate, memory,
   *  safety, QC/variant metadata, publication, settings): such a commit never captures anything by itself. */
  actor: HistoryActor | null;
  ai: boolean;
  /** A change of yours (an op classified `you`): it closes an open AI run. */
  you: boolean;
  /** Your or the editor's edits (quiet-edit counting). */
  edit: boolean;
  /** Section key → its most significant actor in this batch. */
  keys: Map<string, HistoryActor>;
  /** Pages whose text, art or translations this batch touched. */
  pageIds: string[];
  /** New spend entries (the AI run's stats.spend). */
  spend: SpendEntry[];
  /** The batch carries a `publication` op (null value: unpublished). */
  publication?: PublicationMirror | null;
  /** A history restore or line switch (H3/H7 write their own rows). */
  restore: boolean;
  /** An image-model switch (worded first in its run's labels). */
  model: boolean;
}

/** The page a section key belongs to ('page:', 'art:', 'edp:', 'trash:'), or undefined. */
export const pageIdOfKey = (key: string): string | undefined => {
  const parsed = parseSectionKey(key);
  if (!parsed) return undefined;
  if (parsed.kind === 'page' || parsed.kind === 'art') return parsed.id;
  if (parsed.kind === 'edp' || parsed.kind === 'trash') return parsed.pageId;
  return undefined;
};

/**
 * One op's actor (§4.2): opActor (the action, the derived-image editor rule, the origin). Two batch-level rules remain
 * for a commit made without its action: the writer's labelled batch is the AI's, and a fitted image's batch (its
 * remapped balloons included) is the editor's.
 */
export const actorOf = (
  op: DocOp,
  origin: OpsOrigin | undefined,
  doc: ComicDoc | undefined,
  action?: string,
  fittedBatch = false,
  aiBatch = false
): HistoryActor | null => {
  const base = opActor(op, origin, doc, action);
  if (base === null) return null;
  if (aiBatch) return 'ai';
  if (fittedBatch) return 'editor';
  return base;
};

/**
 * Classify one commit (pure; `before` and `next` resolve keys that depend on where things live). `label` is the
 * commit's undo label (the writer's batch is named by it while the action is unknown).
 */
export const classifyBatch = (
  ops: readonly DocOp[],
  origin: OpsOrigin | undefined,
  before: ComicDoc,
  next: ComicDoc,
  action?: string,
  label?: string
): BatchClass => {
  const out: BatchClass = { actor: null, ai: false, you: false, edit: false, keys: new Map(), pageIds: [], spend: [], restore: false, model: false };
  // fit_render commits its derived image with the remapped balloons: the whole batch is the editor's.
  const fitted = ops.some(isDerivedRender);
  // planPages commits the writer's pages (and the cast it adds) with the click's origin: the whole batch is the AI's.
  const writer = isAiWriterBatch(ops, label);
  const pages = new Set<string>();
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'spend' && op.entry && typeof op.entry === 'object') out.spend.push(op.entry);
    if (op.op === 'publication') out.publication = (op as { value?: PublicationMirror | null }).value ?? null;
    if (op.op === 'history_restore') out.restore = true;
    if (op.op === 'image_model' && hasModelSwitch([op])) out.model = true;
    if (CAPTURE_NEUTRAL_OPS.has(op.op)) continue;
    const actor = actorOf(op, origin, next, action, fitted, writer);
    if (!actor) continue;
    out.actor = strongerActor(out.actor, actor);
    if (actor === 'ai') out.ai = true;
    if (actor === 'you') out.you = true;
    if (actor === 'you' || actor === 'editor') out.edit = true;
    for (const key of new Set([...touchedKeys(op, before), ...touchedKeys(op, next)])) {
      out.keys.set(key, strongerActor(out.keys.get(key), actor)!);
      const pageId = pageIdOfKey(key);
      if (pageId) pages.add(pageId);
    }
  }
  out.pageIds = [...pages].sort();
  return out;
};

// ── Clocks (§4.3) ────────────────────────────────────────────────────────────

/** Rule 3: this commit comes at least gapMinutes after the line's last change. */
export const isGap = (lastChangeAt: number | undefined, at: number): boolean =>
  typeof lastChangeAt === 'number' && Number.isFinite(lastChangeAt) && at - lastChangeAt >= HISTORY_POLICY.gapMs;

/** Rule 1 coalescing: an AI commit at `at` continues a run whose last AI commit was at `lastAiAt`. */
export const continuesRun = (lastAiAt: number, at: number): boolean => at - lastAiAt <= HISTORY_POLICY.aiRunGapMs;

/** Rule 4: your unrecorded edits are due for an `edits` row at this flush. */
export const quietEditDue = (edits: { firstAt?: number; commits: number; pages: number }, at: number): boolean =>
  edits.commits > 0 &&
  ((typeof edits.firstAt === 'number' && at - edits.firstAt >= HISTORY_POLICY.quietEditMs) ||
    edits.commits >= HISTORY_POLICY.quietEditCommits ||
    edits.pages >= HISTORY_POLICY.quietEditPages);

// ── Renders still drawing ────────────────────────────────────────────────────

const isBusy = (r: RenderState | undefined): boolean => r?.status === 'queued' || r?.status === 'rendering';

/** Pages and characters whose drawing is queued or in progress (what an AI run is about to change). */
export const busyTargets = (doc: ComicDoc): { pageIds: string[]; castIds: string[]; other: boolean } => ({
  pageIds: doc.pages.filter((p) => isBusy(p.render)).map((p) => p.id),
  castIds: doc.cast.filter((c) => isBusy(c.sheet)).map((c) => c.id),
  other: isBusy(doc.cover?.render) || doc.places.some((p) => isBusy(p.sheet)) || (doc.style?.options || []).some((o) => isBusy(o.render))
});
export const hasBusyRenders = (doc: ComicDoc): boolean => {
  const b = busyTargets(doc);
  return b.pageIds.length > 0 || b.castIds.length > 0 || b.other;
};

// ── Spend (stats.spend) ──────────────────────────────────────────────────────

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * The run's spend, summed from its new spend entries. `byok` when every paid entry was on the user's own key (it
 * never counts toward usage). A run that mixes both records only what counted toward usage, with byok false.
 */
export const spendOf = (entries: readonly SpendEntry[]): VersionSpend | undefined => {
  const paid = entries.filter((e) => e && typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd > 0);
  if (!paid.length) return undefined;
  const byok = paid.every((e) => e.byok === true);
  const counted = byok ? paid : paid.filter((e) => e.byok !== true);
  return { usd: round4(counted.reduce((n, e) => n + e.usd, 0)), byok, estimated: counted.some((e) => e.estimated === true) };
};

// ── The row ──────────────────────────────────────────────────────────────────

/** The models the book's drawings were made with (stats.models). */
const drawnModels = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  for (const r of [...doc.pages.map((p) => p.render), doc.cover?.render]) {
    const model = r?.asset ? r.asset.model || r.model : undefined;
    if (typeof model === 'string' && model) out.add(model);
  }
  return [...out].sort();
};

export const statsOf = (doc: ComicDoc, spend?: VersionSpend): VersionStats => {
  const out: VersionStats = {
    pages: doc.pages.length,
    drawn: doc.pages.filter((p) => !!p.render?.asset?.path).length,
    lines: doc.pages.reduce((n, p) => n + p.panels.reduce((m, x) => m + (x.lines?.length || 0), 0), 0),
    langs: Object.keys(doc.i18n?.editions || {}).sort(),
    models: drawnModels(doc)
  };
  if (spend) out.spend = spend;
  return out;
};

/** ≤ thumbsPerRow thumbnails: the pages this row changed first (book order), then the cover, then the rest. */
export const thumbsOf = (doc: ComicDoc, focusPageIds: readonly string[] = []): VersionThumb[] => {
  const out: VersionThumb[] = [];
  const add = (key: string, path: string | undefined) => {
    if (typeof path === 'string' && path && out.length < HISTORY_POLICY.thumbsPerRow && !out.some((t) => t.key === key)) out.push({ key, path });
  };
  const focus = new Set(focusPageIds);
  for (const p of doc.pages) if (focus.has(p.id)) add(SECTION_KEYS.page(p.id), p.render?.asset?.path);
  add('cover', doc.cover?.render?.asset?.path);
  for (const p of doc.pages) add(SECTION_KEYS.page(p.id), p.render?.asset?.path);
  return out;
};

/** The ops of one commit, with who made them and the action behind them (panel moments). */
export interface MomentBatch {
  ops: readonly DocOp[];
  by: HistoryActor;
  action?: PanelMomentAction;
}

/**
 * The action names a batch's moment only when the batch is the action's own work: a panel fix's drawing is the AI's, a
 * panelize the editor's. What a job writes around it (a render status or QC report, 'system'; the editor's balloon
 * placement after a check) is worded by its own ops (§4.2), so a check landing after the run never reads "redrew panel 2".
 */
const momentAction = (b: MomentBatch): PanelMomentAction | undefined => {
  const type = b.action?.type;
  if (!type) return undefined;
  if (AI_ACTIONS.has(type)) return b.by === 'ai' ? b.action : undefined;
  if (EDITOR_ACTIONS.has(type)) return b.by === 'editor' ? b.action : undefined;
  return b.action;
};

/** The panel moments of a stretch of batches, one per (moment, page), panel numbers merged. 'system' batches (QC
 *  reports, render statuses) are no change and name none. */
export const momentsOf = (batches: readonly MomentBatch[], doc: ComicDoc): PanelChangeItem[] => {
  const merged = new Map<string, PanelChangeItem>();
  for (const b of batches) {
    if (b.by === 'system') continue;
    for (const m of panelMomentsOfOps(b.ops, b.by, doc, momentAction(b))) {
      const key = `${m.moment}|${(m.pageIds || []).join(',')}`;
      const prev = merged.get(key);
      if (!prev) merged.set(key, m);
      else {
        const panelNs = [...new Set([...(prev.panelNs || []), ...(m.panelNs || [])])].sort((a, b) => a - b);
        merged.set(key, { ...prev, by: strongerActor(prev.by, m.by)!, ...(panelNs.length ? { panelNs } : {}) });
      }
    }
  }
  return [...merged.values()];
};

/**
 * diffBooks for a row: `model` stays only for a real switch (both sides drawn, with different models). A book's FIRST
 * drawings, or images that never recorded their model, are not "switched the image model".
 */
export const rowDiff = (base: ComicDoc, doc: ComicDoc): ReturnType<typeof diffBooks> => {
  const diff = diffBooks(base, doc);
  if (diff.model && !(diff.model.a && diff.model.b)) {
    const { model: _m, ...rest } = diff;
    return rest;
  }
  return diff;
};

/** The actor recorded for a change item's section (an edition item matches its per-page keys too). */
const keyActorOf = (item: ChangeItem, keys: ReadonlyMap<string, HistoryActor>): HistoryActor | undefined => {
  if (!item.key) return undefined;
  const exact = keys.get(item.key);
  if (exact) return exact;
  const parsed = parseSectionKey(item.key);
  if (parsed?.kind === 'ed') {
    let best: HistoryActor | null = null;
    for (const [k, a] of keys) if (k.startsWith(`edp:${parsed.lang}:`)) best = strongerActor(best, a);
    return best ?? undefined;
  }
  return undefined;
};

/**
 * A row's changes (≤ changesPerRow, semantic): diffBooks(base → doc) as ChangeItems, each attributed to the actor
 * the recorder saw on its section (system work reads as the row's own actor), with the panel moments of the ops
 * first (withPanelMoments). No base (the first row of a comic, or a head that can't be opened): moments only.
 */
export const rowChanges = (
  base: ComicDoc | null | undefined,
  doc: ComicDoc,
  by: HistoryActor,
  keys: ReadonlyMap<string, HistoryActor> = new Map(),
  batches: readonly MomentBatch[] = []
): ChangeItem[] => {
  const items = base ? changeItemsFromDiff(rowDiff(base, doc), by, doc) : [];
  const attributed = items.map((i) => {
    const a = keyActorOf(i, keys);
    return a && a !== 'system' && a !== i.by ? { ...i, by: a } : i;
  });
  // The lock is not a book section: a switch in these commits is named from its op (the redraw shows in the art).
  if (base && !attributed.some((i) => i.what === 'model') && batches.some((b) => hasModelSwitch(b.ops))) attributed.push({ what: 'model', by: 'ai' });
  return withPanelMoments(attributed, momentsOf(batches, doc)).slice(0, HISTORY_POLICY.changesPerRow);
};

/**
 * The words of a `before_ai` row, known at the run's FIRST AI commit (the row is written right then, before the run
 * goes on): what that commit changed, every drawing still queued for the run (render_pages queues them all first),
 * the image-model switch, and the panel moments of the commit. Translation counts are dropped (the run's size is not
 * known yet), so the words never claim a wrong number.
 */
export const beforeAiItems = (before: ComicDoc, next: ComicDoc, ops: readonly DocOp[], action?: PanelMomentAction): ChangeItem[] => {
  const items: ChangeItem[] = changeItemsFromDiff(rowDiff(before, next), 'ai', next).map((i) => {
    if (i.what !== 'translation') return i;
    const { count: _c, lineIds: _l, ...rest } = i;
    return rest;
  });
  if (hasModelSwitch(ops) && !items.some((i) => i.what === 'model')) items.push({ what: 'model', by: 'ai' });
  const busy = busyTargets(next);
  for (const id of busy.pageIds) {
    if (items.some((i) => i.what === 'art' && i.pageIds?.includes(id))) continue;
    const n = next.pages.find((p) => p.id === id)?.n;
    items.push({ what: 'art', by: 'ai', key: SECTION_KEYS.art(id), pageIds: [id], ...(n ? { pageNs: [n] } : {}) });
  }
  for (const id of busy.castIds) {
    if (items.some((i) => i.what === 'character' && i.id === id)) continue;
    const c = next.cast.find((x) => x.id === id);
    items.push({ what: 'character', by: 'ai', key: SECTION_KEYS.char(id), id, ...(c?.name ? { name: c.name } : {}) });
  }
  return withPanelMoments(items, panelMomentsOfOps(ops, 'ai', next, action)).slice(0, HISTORY_POLICY.changesPerRow);
};

/** The row's actor (who the moment is about): an `edits` row of only the editor's work is the editor's. */
export const rowActor = (kind: HistoryKind, changes: readonly ChangeItem[]): HistoryActor => {
  switch (kind) {
    case 'ai':
      return 'ai';
    case 'start':
    case 'import':
    case 'before_ai':
      return 'system';
    case 'edits':
      return changes.length > 0 && changes.every((c) => c.by === 'editor') ? 'editor' : 'you';
    default:
      return 'you';
  }
};

/** The row label (plain words, ≤ 160; describe.ts owns the vocabulary). */
export const rowLabel = (kind: HistoryKind, changes: readonly ChangeItem[], opts: { final?: boolean } = {}): string =>
  describeChanges(changes, kind, opts.final ? { final: true } : {});

/** The info notice when the put thinned rows to stay within the comic's byte budget (never silent; §4.4). */
export const budgetThinnedNotice = (count: number): string =>
  `History made room for new moments: it let ${count} older automatic ${count === 1 ? 'moment' : 'moments'} go to stay within this comic's space. Named versions are kept forever.`;

/** comic_versions.changes byte cap (the column's check). */
export const HISTORY_CHANGES_MAX_BYTES = 16_384;

/** ≤ changesPerRow items whose JSON fits the column (the store trims the same way; the live event shows what is kept). */
export const trimChanges = (changes: readonly ChangeItem[]): ChangeItem[] => {
  const out = changes.slice(0, HISTORY_POLICY.changesPerRow);
  while (out.length && Buffer.byteLength(JSON.stringify(out), 'utf8') > HISTORY_CHANGES_MAX_BYTES) out.pop();
  return out;
};
