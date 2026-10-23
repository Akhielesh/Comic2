// useUndo — the studio's one undo/redo stack (contract §6, §13.1; lettering.md §6.7).
//
// Entries are {forward, inverse, label}. The inverse comes from the single shared implementation
// (shared/comic/undo.ts inverseOps) and is computed against the doc BEFORE the change:
//   - user edits: `studio.patch(ops, {undo, coalesce, label})` (undo defaults to true);
//   - director edits: ops batches with `origin:'director'` (their client-patchable subset).
// undo() re-patches the inverse, redo() re-patches the forward ops — both as ordinary free patches.
//
// Rules:
//   - 100 entries per project; the stack is cleared on project switch (synchronously, so an Undo
//     button can never send one project's ops to another).
//   - Drags and slider scrubs with the same `coalesce` key within 600 ms merge into one entry, and
//     adjacent ops on the same target are compacted so a long scrub stays one small request.
//   - All director batches of one reply (one stream) merge into one entry: "undo" undoes the reply.
//   - Entries whose target no longer exists (or that would change nothing) are skipped — but an entry
//     waiting on an image that is still drawing is kept (the caller asks the user to try again).
//   - A rejected save drops its entry; a failed undo/redo puts the entry back (unless a newer edit
//     was recorded meanwhile — replaying it out of order would corrupt the doc, so it is dropped).
//   - A change that cannot be undone exactly (contract §6: render_use with no previous image, a
//     purged page delete) is not recorded at all — never a partial "Undid: …".
//
// The pure stack functions are exported (and unit-tested); the hook only holds them per project.

import { useCallback, useRef, useState } from 'react';
import { getRender, type ComicDoc } from '../../shared/comic/doc';
import { applyOp, CLIENT_PATCHABLE_OPS, type DocOp } from '../../shared/comic/ops';
import { describeOps, inverseOps, isUndoable } from '../../shared/comic/undo';

export const UNDO_LIMIT = 100;
export const COALESCE_WINDOW_MS = 600;

export type UndoOrigin = 'user' | 'director';

export interface UndoEntry {
  id: string;
  /** "move a balloon" (no "Undo" prefix; the UI adds it). */
  label: string;
  origin: UndoOrigin;
  /** Re-applied by redo (client-patchable ops only). */
  forward: DocOp[];
  /** Restores the doc from before `forward` (client-patchable ops only). */
  inverse: DocOp[];
  coalesce?: string;
  /** Director batches of one reply (one stream) share a group and undo together, whatever the timing. */
  group?: string;
  /** Time of the latest change merged into this entry (the coalescing window). */
  at: number;
  /** Local patch ids (user edits): a rejected save removes the entry. */
  patchIds: string[];
  /** Server revision of a director batch. */
  rev?: number;
}

export interface UndoStacks {
  readonly undo: readonly UndoEntry[];
  readonly redo: readonly UndoEntry[];
}

export const EMPTY_UNDO: UndoStacks = { undo: [], redo: [] };

// ── Op helpers ───────────────────────────────────────────────────────────────

/**
 * Ops the server accepts in a client patch. `translations` (server-only) — which inverseOps emits
 * when an edition removal is undone — becomes the equivalent per-line `translation` ops.
 */
export const sendableOps = (ops: readonly DocOp[]): DocOp[] => {
  const out: DocOp[] = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'translations') {
      for (const [lineId, t] of Object.entries(op.lines || {})) if (t) out.push({ op: 'translation', lang: op.lang, lineId, patch: t });
      continue;
    }
    if (CLIENT_PATCHABLE_OPS.has(op.op)) out.push(op);
  }
  return out;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const SHALLOW_TARGET: Partial<Record<DocOp['op'], (op: Rec) => string>> = {
  brief: () => '',
  format: () => '',
  settings: () => '',
  source: () => '',
  style: () => '',
  cover: () => '',
  book: () => '',
  reader: () => '',
  page: (o) => String(o.id),
  panel: (o) => `${o.pageId}/${o.id}`
};

/** Identity of an op for compaction: two adjacent ops with the same key can merge exactly. */
const compactKey = (op: DocOp): string | null => {
  const o = op as unknown as Rec;
  switch (op.op) {
    case 'balloons':
      return `balloons:${op.pageId}`;
    case 'pages_reorder':
    case 'plan_status':
      return op.op;
    case 'line_style':
      return op.mode === 'replace' && op.lineIds.length === 1 ? `line_style:${op.pageId}:${op.lineIds[0]}` : null;
    case 'balloon':
      return isRec(op.patch) && !('locked' in op.patch) ? `balloon:${op.pageId}:${op.lineId}` : null;
    case 'line':
      return isRec(op.patch) && !('style' in op.patch) && op.index === undefined ? `line:${op.pageId}:${op.panelId}:${op.id}` : null;
    case 'edition_balloon':
      return isRec(op.patch) ? `edition_balloon:${op.lang}:${op.lineId}` : null;
    default: {
      const target = SHALLOW_TARGET[op.op];
      return target && isRec(o.patch) ? `${op.op}:${target(o)}` : null;
    }
  }
};

/** Replace-type ops: the later one fully wins. Everything else with a key is a shallow merge. */
const REPLACES = new Set<DocOp['op']>(['balloons', 'pages_reorder', 'plan_status', 'line_style']);

/**
 * Merge ADJACENT ops on the same target when applying the merged op is exactly the same as
 * applying both (replace ops: keep the later; shallow patches: union, later keys win).
 * A 300-tick slider scrub becomes one op instead of 300.
 */
export const compactOps = (ops: readonly DocOp[]): DocOp[] => {
  const out: DocOp[] = [];
  let lastKey: string | null = null;
  for (const op of ops) {
    const key = compactKey(op);
    if (key !== null && key === lastKey && out.length) {
      const prev = out[out.length - 1];
      out[out.length - 1] = REPLACES.has(op.op)
        ? op
        : ({ ...op, patch: { ...((prev as unknown as Rec).patch as Rec), ...((op as unknown as Rec).patch as Rec) } } as DocOp);
    } else {
      out.push(op);
    }
    lastKey = key;
  }
  return out;
};

/** Wire equality (R4): null ≡ unset; reference-equal subtrees short-circuit (cheap on immutable docs). */
export const sameWire = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  const arrA = Array.isArray(a);
  if (arrA !== Array.isArray(b)) return false;
  if (arrA) {
    const x = a as unknown[];
    const y = b as unknown[];
    return x.length === y.length && x.every((v, i) => sameWire(v, y[i]));
  }
  const x = a as Rec;
  const y = b as Rec;
  for (const k of Object.keys(x)) if (!sameWire(x[k], y[k])) return false;
  for (const k of Object.keys(y)) if (!(k in x) && !sameWire(undefined, y[k])) return false;
  return true;
};

/** True when applying `ops` to `doc` would change nothing (target gone, or already in that state). */
export const isNoopOn = (doc: ComicDoc, ops: readonly DocOp[]): boolean => {
  if (!ops.length) return true;
  const next = ops.reduce((d, op) => applyOp(d, op), doc);
  return next === doc || sameWire({ ...next, updatedAt: 0 }, { ...doc, updatedAt: 0 });
};

const isDrawing = (r: { status?: unknown } | undefined): boolean => !!r && (r.status === 'queued' || r.status === 'rendering');

/**
 * True when `ops` touch an image that is queued or drawing right now (applyOp leaves `render_use`,
 * `page_delete` and `page_duplicate` alone while the target is busy, and the server answers 409).
 * Such an entry is not "gone": it applies once the drawing finishes, so it must not be skipped.
 */
export const waitsOnDrawing = (doc: ComicDoc, ops: readonly DocOp[]): boolean =>
  ops.some((op) => {
    switch (op?.op) {
      case 'render_use':
        return !!op.target && typeof op.target === 'object' && isDrawing(getRender(doc, op.target));
      case 'page_delete':
      case 'page_duplicate':
        return isDrawing(doc.pages.find((p) => p.id === op.id)?.render);
      default:
        return false;
    }
  });

/** "Undo Move balloon" / "Move balloon" → "move balloon" (the UI prefixes "Undo"). */
export const normalizeUndoLabel = (label: string | undefined): string | undefined => {
  const t = (label || '').replace(/^\s*(undo|redo)\b[\s:–—-]*/i, '').trim().slice(0, 80);
  if (!t) return undefined;
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
};

let entrySeq = 0;
const nextEntryId = () => `undo_${Date.now().toString(36)}_${(entrySeq = (entrySeq + 1) % 1e6).toString(36)}`;

export interface MakeUndoEntryOptions {
  origin: UndoOrigin;
  label?: string;
  coalesce?: string;
  group?: string;
  patchId?: string;
  rev?: number;
  at: number;
}

/**
 * The undo entry for `ops` applied to `before` (null when nothing undoable changed).
 * `ops` may mix server-only ops (a director batch): they evolve the doc for the inverse but are
 * never re-sent.
 */
export function makeUndoEntry(before: ComicDoc, ops: readonly DocOp[], opts: MakeUndoEntryOptions): UndoEntry | null {
  const list = ops.filter((op) => op && typeof op === 'object' && typeof op.op === 'string');
  const forward = compactOps(list.filter((op) => CLIENT_PATCHABLE_OPS.has(op.op)));
  if (!forward.length) return null;
  // Contract §6: a change that cannot be undone EXACTLY (render_use with no previous image, a purged
  // page delete) is not undoable — never record a partial undo that would claim "Undid: …".
  let cur = before;
  for (const op of list) {
    if (CLIENT_PATCHABLE_OPS.has(op.op) && !isUndoable(cur, [op])) return null;
    cur = applyOp(cur, op);
  }
  const inverse = compactOps(sendableOps(inverseOps(before, list)));
  if (!inverse.length) return null;
  return {
    id: nextEntryId(),
    label: normalizeUndoLabel(opts.label) || describeOps(forward),
    origin: opts.origin,
    forward,
    inverse,
    ...(opts.coalesce ? { coalesce: opts.coalesce } : {}),
    ...(opts.group ? { group: opts.group } : {}),
    at: opts.at,
    patchIds: opts.patchId ? [opts.patchId] : [],
    ...(typeof opts.rev === 'number' ? { rev: opts.rev } : {})
  };
}

// ── Pure stack operations ────────────────────────────────────────────────────

const mergeLabels = (a: string, b: string): string => (a === b ? a : `${a}, ${b}`.slice(0, 80));

/**
 * Push a new entry (clears redo). It merges into the top entry instead when both carry the same
 * `coalesce` key within the window (a drag/scrub) or the same `group` (one director reply):
 * forward = top.forward ++ entry.forward, inverse = entry.inverse ++ top.inverse (undo the newest
 * first), both compacted.
 */
export function pushUndo(stacks: UndoStacks, entry: UndoEntry, opts: { limit?: number; windowMs?: number } = {}): UndoStacks {
  const limit = opts.limit ?? UNDO_LIMIT;
  const windowMs = opts.windowMs ?? COALESCE_WINDOW_MS;
  const top = stacks.undo[stacks.undo.length - 1];
  const coalesces = !!top && !!entry.coalesce && top.coalesce === entry.coalesce && entry.at - top.at <= windowMs && entry.at >= top.at;
  const sameReply = !!top && !!entry.group && top.group === entry.group;
  if (top && (coalesces || sameReply)) {
    const merged: UndoEntry = {
      ...top,
      label: sameReply ? mergeLabels(top.label, entry.label) : top.label,
      ...(entry.rev !== undefined ? { rev: entry.rev } : {}),
      forward: compactOps([...top.forward, ...entry.forward]),
      inverse: compactOps([...entry.inverse, ...top.inverse]),
      at: entry.at,
      patchIds: [...top.patchIds, ...entry.patchIds]
    };
    return { undo: [...stacks.undo.slice(0, -1), merged], redo: [] };
  }
  const undo = [...stacks.undo, entry];
  return { undo: undo.length > limit ? undo.slice(undo.length - limit) : undo, redo: [] };
}

const take = (
  from: readonly UndoEntry[],
  usable: ((e: UndoEntry) => boolean) | undefined
): { rest: UndoEntry[]; entry: UndoEntry | null; skipped: number } => {
  const rest = from.slice();
  let skipped = 0;
  while (rest.length) {
    const entry = rest.pop()!;
    if (!usable || usable(entry)) return { rest, entry, skipped };
    skipped += 1; // its page/line is gone (or it would change nothing): drop it
  }
  return { rest, entry: null, skipped };
};

/** Pop the newest usable undo entry (unusable ones are dropped) and move it to redo. */
export function takeUndo(stacks: UndoStacks, usable?: (e: UndoEntry) => boolean): { stacks: UndoStacks; entry: UndoEntry | null; skipped: number } {
  const { rest, entry, skipped } = take(stacks.undo, usable);
  return { stacks: { undo: rest, redo: entry ? [...stacks.redo, { ...entry, coalesce: undefined, group: undefined }] : stacks.redo }, entry, skipped };
}

/** Pop the newest usable redo entry and move it back to undo. */
export function takeRedo(stacks: UndoStacks, usable?: (e: UndoEntry) => boolean): { stacks: UndoStacks; entry: UndoEntry | null; skipped: number } {
  const { rest, entry, skipped } = take(stacks.redo, usable);
  return { stacks: { undo: entry ? [...stacks.undo, entry] : stacks.undo, redo: rest }, entry, skipped };
}

/**
 * Undo the move of an entry whose undo (`to: 'undo'`) or redo (`to: 'redo'`) failed to save.
 * Only while history has not moved on: once a newer edit was recorded (it clears redo / sits above
 * the entry), putting the entry back on top would replay it out of order — it is dropped instead.
 */
export function returnEntry(stacks: UndoStacks, entry: UndoEntry, to: 'undo' | 'redo'): UndoStacks {
  const undo = stacks.undo.filter((e) => e.id !== entry.id);
  const redo = stacks.redo.filter((e) => e.id !== entry.id);
  if (to === 'undo') {
    // A failed undo: the entry sits in redo until a new edit clears it.
    return redo.length !== stacks.redo.length ? { undo: [...undo, entry], redo } : stacks;
  }
  // A failed redo: the entry is back on top of undo unless something newer was pushed above it.
  const top = stacks.undo[stacks.undo.length - 1];
  if (top?.id === entry.id) return { undo, redo: [...redo, entry] };
  return undo.length !== stacks.undo.length ? { undo, redo } : stacks;
}

/** Remove one entry from both stacks (its undo/redo can never be saved). */
export function discardEntry(stacks: UndoStacks, entryId: string): UndoStacks {
  const undo = stacks.undo.filter((e) => e.id !== entryId);
  const redo = stacks.redo.filter((e) => e.id !== entryId);
  return undo.length === stacks.undo.length && redo.length === stacks.redo.length ? stacks : { undo, redo };
}

/** Drop entries whose every save was rejected (the edit never happened). */
export function forgetPatches(stacks: UndoStacks, failedPatchIds: readonly string[]): UndoStacks {
  if (!failedPatchIds.length) return stacks;
  const failed = new Set(failedPatchIds);
  const keep = (e: UndoEntry) => !e.patchIds.length || e.patchIds.some((id) => !failed.has(id));
  const undo = stacks.undo.filter(keep);
  const redo = stacks.redo.filter(keep);
  return undo.length === stacks.undo.length && redo.length === stacks.redo.length ? stacks : { undo, redo };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UndoController {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** Current stacks (read synchronously; render state updates after every change). */
  stacks(): UndoStacks;
  record(entry: UndoEntry | null): void;
  takeUndo(usable?: (e: UndoEntry) => boolean): UndoEntry | null;
  takeRedo(usable?: (e: UndoEntry) => boolean): UndoEntry | null;
  putBack(entry: UndoEntry, to: 'undo' | 'redo'): void;
  discard(entryId: string): void;
  forget(failedPatchIds: readonly string[]): void;
  clear(): void;
}

/** One stack per project: switching projects clears it before the next render reads it. */
export function useUndo(projectId: string): UndoController {
  const ref = useRef<{ projectId: string; stacks: UndoStacks }>({ projectId, stacks: EMPTY_UNDO });
  if (ref.current.projectId !== projectId) ref.current = { projectId, stacks: EMPTY_UNDO };
  const [, setVersion] = useState(0);

  const commit = useCallback(
    (next: UndoStacks) => {
      if (next === ref.current.stacks) return;
      ref.current = { ...ref.current, stacks: next };
      setVersion((v) => v + 1);
    },
    []
  );

  const stacks = useCallback(() => ref.current.stacks, []);
  const record = useCallback((entry: UndoEntry | null) => {
    if (entry) commit(pushUndo(ref.current.stacks, entry));
  }, [commit]);
  const takeU = useCallback(
    (usable?: (e: UndoEntry) => boolean) => {
      const r = takeUndo(ref.current.stacks, usable);
      commit(r.stacks);
      return r.entry;
    },
    [commit]
  );
  const takeR = useCallback(
    (usable?: (e: UndoEntry) => boolean) => {
      const r = takeRedo(ref.current.stacks, usable);
      commit(r.stacks);
      return r.entry;
    },
    [commit]
  );
  const putBack = useCallback((entry: UndoEntry, to: 'undo' | 'redo') => commit(returnEntry(ref.current.stacks, entry, to)), [commit]);
  const discard = useCallback((entryId: string) => commit(discardEntry(ref.current.stacks, entryId)), [commit]);
  const forget = useCallback((ids: readonly string[]) => commit(forgetPatches(ref.current.stacks, ids)), [commit]);
  const clear = useCallback(() => commit(EMPTY_UNDO), [commit]);

  const { undo, redo } = ref.current.stacks;
  const topUndo = undo[undo.length - 1];
  const topRedo = redo[redo.length - 1];
  return {
    canUndo: !!topUndo,
    canRedo: !!topRedo,
    ...(topUndo ? { undoLabel: topUndo.label } : {}),
    ...(topRedo ? { redoLabel: topRedo.label } : {}),
    stacks,
    record,
    takeUndo: takeU,
    takeRedo: takeR,
    putBack,
    discard,
    forget,
    clear
  };
}
