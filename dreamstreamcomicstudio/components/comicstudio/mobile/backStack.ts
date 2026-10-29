// The back gesture closes the topmost layer first (mobile.md §3.10).
//
// Opening a layer (page editor, a modal sheet, the settings sheet) pushes ONE history entry tagged
// with the layer id. Android's system back, the browser back button and iOS's edge swipe then pop
// that entry, and the popstate handler closes every open layer whose id is no longer in the
// restored state — topmost first — instead of dropping the user out of the studio.
// Closing a layer from the UI goes `history.back()` only when its entry is on top, so the history
// never fills with dead entries; a layer opened right as another closes (menu → sheet) REUSES the
// closing layer's entry (replaceState) instead of stacking a new one. The URL never changes.
//
// Leaving from the UI and THEN acting (a reader's Close, Library, a legal link — mobile-reading hotfix):
// `leaveLayer` / the function `useBackLayer` returns pops the layer's entry (and every entry above it) FIRST
// and runs the action once that traversal lands, so whatever the host does next (App rewriting its
// ?view=read entry, a navigation) happens on the entry under the layer and a later Back never lands on a
// stale one. If the traversal never reports back, the action still runs after a short settle time.
//
// StrictMode-safe: a dev double-mount revives the same layer instead of pushing twice.

import { useCallback, useEffect, useRef } from 'react';

interface Layer {
  id: string;
  key: string;
  close: () => void;
}

export const HISTORY_LAYERS_KEY = 'csLayers';

const stack: Layer[] = [];
/** Layers closed from the UI whose history entry is still waiting for its deferred back(). */
const closing = new Map<string, { layer: Layer; timer: ReturnType<typeof setTimeout> }>();
/** The layer being left with leaveLayer (its traversal is under way) and the action that runs when it lands. */
let leaving: { id: string; action: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
let listening = false;
let seq = 0;
/** How long a leave waits for its traversal to report back (popstate) before it closes anyway. */
export const LEAVE_SETTLE_MS = 800;

const canUseHistory = (): boolean => typeof window !== 'undefined' && !!window.history && typeof window.history.pushState === 'function';

const historyState = (): Record<string, unknown> => {
  try {
    const s = window.history.state;
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Layer ids recorded in the current history entry. */
export const historyLayers = (): string[] => {
  const v = historyState()[HISTORY_LAYERS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

const onPopState = () => {
  const live = new Set(historyLayers());
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const layer = stack[i];
    if (live.has(layer.id)) continue;
    stack.splice(i, 1);
    try {
      layer.close();
    } catch (err) {
      console.error('[comicstudio] closing a layer on back failed', err);
    }
  }
  // A leave landed on an entry that still holds its layer (an entry someone else pushed sat above it, e.g. the
  // immersive reader's): keep unwinding, one step at a time, until the layer's own entry is gone.
  if (leaving && live.has(leaving.id)) {
    try {
      window.history.back();
    } catch {
      /* sandboxed: the settle timer finishes the leave */
    }
    return;
  }
  if (!stack.length && !closing.size && !leaving) stopListening();
};

const startListening = () => {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('popstate', onPopState);
  listening = true;
};

const stopListening = () => {
  if (!listening || typeof window === 'undefined') return;
  window.removeEventListener('popstate', onPopState);
  listening = false;
};

/** Register an open layer; returns its id. */
export const pushLayer = (key: string, close: () => void): string => {
  seq += 1;
  const id = `${key}#${seq}`;
  stack.push({ id, key, close });
  if (canUseHistory()) {
    const layers = historyLayers();
    const top = layers[layers.length - 1];
    const reusing = top !== undefined && closing.has(top);
    try {
      if (reusing) {
        // The layer on top is closing (menu → sheet): take over its entry instead of stacking.
        clearTimeout(closing.get(top)!.timer);
        closing.delete(top);
        window.history.replaceState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...layers.slice(0, -1), id] }, '');
      } else {
        window.history.pushState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...layers, id] }, '');
      }
    } catch {
      /* sandboxed iframe: layers still work, the back gesture just leaves */
    }
    startListening();
  }
  return id;
};

const finishClose = (id: string) => {
  closing.delete(id);
  if (canUseHistory()) {
    const layers = historyLayers();
    if (layers[layers.length - 1] === id) {
      try {
        window.history.back();
      } catch {
        /* sandboxed */
      }
    }
  }
  if (!stack.length && !closing.size && typeof window !== 'undefined') window.setTimeout(() => !stack.length && !closing.size && stopListening(), 500);
};

/** A layer closed from the UI: drop it now, and its history entry on the next tick (when on top). */
export const popLayer = (id: string, deferMs = 0): void => {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return; // already closed by the back gesture
  const [layer] = stack.splice(i, 1);
  if (deferMs <= 0 && typeof window === 'undefined') return;
  closing.set(id, { layer, timer: setTimeout(() => finishClose(id), Math.max(0, deferMs)) });
};

/** Close stack layers from index `i` up, topmost first (each runs its close: a leaving layer runs its action). */
const closeFrom = (i: number) => {
  if (i < 0) return;
  const gone = stack.splice(i);
  for (let k = gone.length - 1; k >= 0; k -= 1) {
    try {
      gone[k].close();
    } catch (err) {
      console.error('[comicstudio] closing a layer failed', err);
    }
  }
};

/**
 * Leave a layer from the UI and THEN run `action` (instead of the layer's back-gesture close): its history
 * entry — and every entry above it — is popped first, in one traversal, and `action` runs once that lands.
 * A layer already closed (Back, an earlier leave) or without an entry of its own runs `action` at once.
 * Leaving the same layer again while its traversal is under way only swaps the action (never a second
 * traversal, so it never goes further back than the layer's own entry).
 */
export const leaveLayer = (id: string, action: () => void, settleMs = LEAVE_SETTLE_MS): void => {
  if (leaving?.id === id) {
    leaving.action = action;
    return;
  }
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) {
    action();
    return;
  }
  const layers = canUseHistory() ? historyLayers() : [];
  const at = layers.lastIndexOf(id);
  const leave = { id, action, timer: setTimeout(() => finishLeave(), Math.max(0, settleMs)) };
  // The traversal never reported back: close the layer (and those above it) now — its close runs the action. A
  // layer that vanished meanwhile (its host unmounted) still gets its action: the user asked to leave.
  const finishLeave = () => {
    if (leaving !== leave) return;
    const idx = stack.findIndex((l) => l.id === id);
    if (idx >= 0) {
      closeFrom(idx);
      return;
    }
    leaving = null;
    leave.action();
  };
  stack[i].close = () => {
    if (leaving !== leave) return;
    clearTimeout(leave.timer);
    leaving = null;
    leave.action();
  };
  leaving = leave;
  if (at < 0) {
    // No entry of its own (sandboxed, or the host replaced it): close it and everything above it now.
    closeFrom(i);
    return;
  }
  // Entries above it whose layers are already closing (an Exit tapped just before Close) go with this traversal.
  for (const above of layers.slice(at)) {
    const pending = closing.get(above);
    if (!pending) continue;
    clearTimeout(pending.timer);
    closing.delete(above);
  }
  startListening();
  try {
    window.history.go(-(layers.length - at));
  } catch {
    clearTimeout(leave.timer);
    closeFrom(stack.findIndex((l) => l.id === id));
  }
};

/** Undo a pending close (StrictMode re-run). True when the layer was revived. */
const revive = (id: string, close: () => void): boolean => {
  const pending = closing.get(id);
  if (!pending) return stack.some((l) => l.id === id);
  clearTimeout(pending.timer);
  closing.delete(id);
  stack.push({ ...pending.layer, close });
  return true;
};

const rebind = (id: string, close: () => void) => {
  const layer = stack.find((l) => l.id === id);
  if (layer) layer.close = close;
};

/** Open layers, bottom first (diagnostics and tests). */
export const openLayers = (): string[] => stack.map((l) => l.key);

/** Test hook. */
export const resetBackStack = (): void => {
  stack.splice(0, stack.length);
  closing.forEach((c) => clearTimeout(c.timer));
  closing.clear();
  if (leaving) clearTimeout(leaving.timer);
  leaving = null;
  stopListening();
};

/**
 * While `open`, the back gesture calls `onClose` (topmost layer first). `key` names the layer
 * (e.g. 'page-editor', 'sheet:settings'). Returns `leave(action)`: leave the layer from the UI and run
 * `action` once its history entry is gone (see leaveLayer); without an open layer `action` runs at once.
 */
export function useBackLayer(open: boolean, onClose: () => void, key: string): (action: () => void) => void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const close = () => closeRef.current();
    let id = idRef.current;
    if (id && revive(id, close)) rebind(id, close);
    else id = pushLayer(key, close);
    idRef.current = id;
    const mine = id;
    return () => {
      // Deferred one tick: a StrictMode re-run revives it; a real close or unmount lets it finish.
      popLayer(mine);
    };
  }, [open, key]);

  useEffect(() => {
    if (!open) idRef.current = null;
  }, [open]);

  return useCallback((action: () => void) => {
    const id = idRef.current;
    if (!id) action();
    else leaveLayer(id, action);
  }, []);
}

export default useBackLayer;
