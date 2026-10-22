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
// StrictMode-safe: a dev double-mount revives the same layer instead of pushing twice.

import { useEffect, useRef } from 'react';

interface Layer {
  id: string;
  key: string;
  close: () => void;
}

export const HISTORY_LAYERS_KEY = 'csLayers';

const stack: Layer[] = [];
/** Layers closed from the UI whose history entry is still waiting for its deferred back(). */
const closing = new Map<string, { layer: Layer; timer: ReturnType<typeof setTimeout> }>();
let listening = false;
let seq = 0;

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
  if (!stack.length && !closing.size) stopListening();
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
  stopListening();
};

/**
 * While `open`, the back gesture calls `onClose` (topmost layer first). `key` names the layer
 * (e.g. 'page-editor', 'sheet:settings').
 */
export function useBackLayer(open: boolean, onClose: () => void, key: string): void {
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
}

export default useBackLayer;
