// "Page 3 deleted · Undo" (timeline.md §4.1): an 8-second toast after every free timeline edit, with
// the exact inverse computed BEFORE the edit (shared/comic/undo.ts inverseOps). The toast pauses
// while hovered or focused, announces politely, and sits above the safe area. Deleted pages also
// stay in Media → Deleted, so nothing depends on catching the toast in time.
//
// One undo stack (P1-CLIENTSTATE/P1-TIMELINE): a timeline edit is committed through studio.patch, which
// records it on the studio's global undo stack. The toast's Undo therefore runs studio.undo() while that
// entry is still on top — never a second, stale inverse that a later Ctrl+Z would re-send (a page_restore
// for a page no longer in the trash answered 400). Only when other edits landed on top since does it
// apply its own exact inverse (unrecorded); the global entry is then a no-op that undo skips.

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Undo2, X } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import type { StudioController } from '../types';
import { undoPlan } from './bookModel';
import { cx, FOCUS_RING, useReducedMotion } from './ui';

export const UNDO_TOAST_MS = 8000;
const MAX_ENTRIES = 20;

// One toast at a time across every timeline surface (dock, media bin, version stacks): the newest
// edit's toast wins, so two surfaces never stack toasts on top of each other.
let toastSeq = 0;
let latestToast = 0;
const toastSubs = new Set<() => void>();
const publishToast = (id: number) => {
  latestToast = id;
  toastSubs.forEach((f) => f());
};
const subscribeToasts = (f: () => void) => {
  toastSubs.add(f);
  return () => toastSubs.delete(f);
};
const latestToastId = () => latestToast;

export interface UndoEntry {
  id: number;
  /** "Page 3 deleted". */
  message: string;
  /** Applied (with undo:false) when the user taps Undo and the global stack moved on. */
  inverse: DocOp[];
  /** The label the edit was recorded under on the studio's undo stack. */
  label?: string;
}

export interface TimelineEdit {
  /** Commit ops (optimistic) and offer an undo toast. Returns false when nothing was sent. */
  commit(ops: DocOp[], message: string, opts?: { label?: string }): boolean;
  /** Undo the most recent timeline edit (Ctrl/Cmd+Z inside the timeline). */
  undoLast(): boolean;
  toast: UndoEntry | null;
  dismiss(): void;
  undo(entry: UndoEntry): void;
}

/** Commit + undo bookkeeping for one timeline surface (dock, media bin, version stack). */
export function useTimelineEdit(studio: StudioController): TimelineEdit {
  const stack = useRef<UndoEntry[]>([]);
  const [toast, setToast] = useState<UndoEntry | null>(null);
  const docRef = useRef<ComicDoc | null>(studio.doc);
  docRef.current = studio.doc;
  const studioRef = useRef(studio);
  studioRef.current = studio;

  const commit = useCallback(
    (ops: DocOp[], message: string, opts: { label?: string } = {}) => {
      const before = docRef.current;
      if (!before || !ops.length) return false;
      const plan = undoPlan(before, ops);
      const label = opts.label ?? plan.label;
      void studio.patch(ops, { label });
      if (plan.inverse && plan.inverse.length) {
        toastSeq += 1;
        const entry: UndoEntry = { id: toastSeq, message, inverse: plan.inverse, ...(label ? { label } : {}) };
        stack.current = [...stack.current, entry].slice(-MAX_ENTRIES);
        setToast(entry);
        publishToast(entry.id);
      }
      return true;
    },
    [studio]
  );

  const undo = useCallback(
    (entry: UndoEntry) => {
      const isNewest = stack.current[stack.current.length - 1]?.id === entry.id;
      stack.current = stack.current.filter((e) => e.id !== entry.id);
      setToast((t) => (t?.id === entry.id ? null : t));
      const live = studioRef.current;
      // Still the top of the studio's undo stack: undo it there (one stack, redo works too).
      if (isNewest && live.canUndo && entry.label && live.undoLabel === entry.label) {
        live.undo();
        return;
      }
      void live.patch(entry.inverse, { undo: false, label: `Undo: ${entry.message}` });
    },
    []
  );

  const undoLast = useCallback(() => {
    const last = stack.current[stack.current.length - 1];
    if (!last) return false;
    undo(last);
    return true;
  }, [undo]);

  const dismiss = useCallback(() => setToast(null), []);
  return { commit, undoLast, toast, dismiss, undo };
}

export interface UndoToastProps {
  entry: UndoEntry | null;
  onUndo(entry: UndoEntry): void;
  onDismiss(): void;
  durationMs?: number;
}

export const UndoToast: React.FC<UndoToastProps> = ({ entry: own, onUndo, onDismiss, durationMs = UNDO_TOAST_MS }) => {
  const latest = useSyncExternalStore(subscribeToasts, latestToastId, latestToastId);
  // A newer edit on another timeline surface owns the single toast slot.
  const entry = own && own.id === latest ? own : null;
  const [paused, setPaused] = useState(false);
  const reduce = useReducedMotion();
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!entry || paused) return;
    const t = setTimeout(() => onDismissRef.current(), durationMs);
    return () => clearTimeout(t);
  }, [entry, paused, durationMs]);
  useEffect(() => setPaused(false), [entry?.id]);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[55] flex justify-center px-4"
      style={{ bottom: 'calc(var(--sa-bottom-eff, 0px) + 16px)' }}
      role="status"
      aria-live="polite"
    >
      {entry && (
        <div
          key={entry.id}
          className={cx(
            'pointer-events-auto flex max-w-[min(100%,420px)] items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] py-1 pl-4 pr-1 text-[13px] text-[var(--ds-ink)] shadow-[0_8px_28px_rgba(0,0,0,0.18)] backdrop-blur-xl',
            !reduce && 'animate-scale-in'
          )}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <span className="min-w-0 flex-1 truncate">{entry.message}</span>
          <button
            type="button"
            onClick={() => onUndo(entry)}
            className={cx('tap-target inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 font-semibold text-[var(--ds-accent)] hover:bg-[var(--ds-hover)]', FOCUS_RING)}
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
            Undo
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className={cx('tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]', FOCUS_RING)}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
};

export default UndoToast;
