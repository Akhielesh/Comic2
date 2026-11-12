// "Hide in this view" (the Layers eye; agent-editor plan §3 C1 and C8 `H`): hides an object in the editor only, for this
// tab. It is never an edit — no op, no undo entry, nothing saved — so readers, exports and other people's editors are
// untouched, and a reload shows everything again. The canvas reads the same set (useViewHidden) to skip drawing it.

import { useSyncExternalStore } from 'react';

const hidden = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const EMPTY: ReadonlySet<string> = new Set();

const emit = () => {
  for (const l of listeners) l();
};

/** The ids hidden in this view on a page. */
export const viewHidden = (pageId: string): ReadonlySet<string> => hidden.get(pageId) ?? EMPTY;

/** Hide or show one object in this view (default: toggle). Returns whether it is now hidden. */
export function setViewHidden(pageId: string, id: string, hide?: boolean): boolean {
  const cur = new Set(viewHidden(pageId));
  const next = hide ?? !cur.has(id);
  if (next) cur.add(id);
  else cur.delete(id);
  if (cur.size) hidden.set(pageId, cur);
  else hidden.delete(pageId);
  emit();
  return next;
}

/** Show everything again on a page (or on every page). */
export function clearViewHidden(pageId?: string): void {
  if (pageId) hidden.delete(pageId);
  else hidden.clear();
  emit();
}

export const subscribeViewHidden = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The ids hidden in this view on a page (re-renders when they change). */
export const useViewHidden = (pageId: string): ReadonlySet<string> =>
  useSyncExternalStore(
    subscribeViewHidden,
    () => viewHidden(pageId),
    () => EMPTY
  );
