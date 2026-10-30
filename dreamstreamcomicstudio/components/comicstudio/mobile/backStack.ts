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
// Layers closed from the UI together (the immersive reader and the studio's 'reader' layer behind it) leave in ONE
// traversal, so a second back() never races a first one that has not landed yet.
//
// Leaving from the UI and THEN acting (a reader's Close, Library, a legal link — mobile-reading hotfix):
// `leaveLayer` / the function `useBackLayer` returns pops the layer's entry (and every entry above it) FIRST
// and runs the action once that traversal lands, so whatever the host does next (App rewriting its
// ?view=read entry, a navigation) happens on the entry under the layer and a later Back never lands on a
// stale one. If the traversal never reports back, the action still runs after a short settle time. A navigation
// the host may ignore (`{ final: false }`) registers the layer again when the host is still open afterwards.
//
// Reloads: history.state survives a reload (pull-to-refresh, iOS evicting the tab), so the entry a layer pushed
// comes back while nothing owns it. Layer ids carry a per-page-load token, so such an entry never counts as a live
// layer, and a layer that opens again with the same key ADOPTS it (replaceState) instead of stacking a second
// one — the first Back then closes it, as before the reload, and history.length does not grow. Stale layers that
// sat above it at the reload (a reading mode, a sheet) each left an entry of their own on top of its entry: the
// layer steps back over them first and adopts its own entry there, so the first Back still lands where the layer
// was opened and never on a dead entry under it.
//
// StrictMode-safe: a dev double-mount revives the same layer instead of pushing twice.

import { useCallback, useEffect, useRef, useState } from 'react';

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
/** Layer ids whose entry a traversal of ours is popping right now (until it lands): never adopted. */
const popping = new Set<string>();
/**
 * A layer stepping back over the stale entries above the one it adopts (until that traversal lands): `slot` is where
 * its id goes in the landed entry's layers, `url` the URL the page had (a reader's ?p= lives on the top entry only).
 */
let adopting: { id: string; slot: number; url: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Layers opened while an adoption's step back is under way: their entries go on top of the adopted one once it lands. */
const afterAdopt: string[] = [];
let listening = false;
let seq = 0;
/** Unique per page load: an entry a reload brings back can never hold the id of a layer opened in this load. */
const LOAD_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

/** The key a layer id was made from ('reader:c1#<load>.3' → 'reader:c1'; an older build's 'reader:c1#3' too). */
export const layerKey = (id: string): string => {
  const at = id.lastIndexOf('#');
  return at < 0 ? id : id.slice(0, at);
};

/** Some layer of this page load still owns the id (open, closing from the UI, being left, or its entry popping). */
const owned = (id: string): boolean => stack.some((l) => l.id === id) || closing.has(id) || leaving?.id === id || popping.has(id);

/**
 * Where a layer opening with `key` takes over an entry nothing owns (one a reload brought back): the lowest slot of
 * the unowned run on top of the current entry that has the same key, else -1. The unowned layers above that slot (a
 * reading mode or a sheet that was open at the reload) go with it, so the first Back closes the layer.
 */
const staleSlot = (layers: string[], key: string): number => {
  let slot = -1;
  for (let i = layers.length - 1; i >= 0 && !owned(layers[i]); i -= 1) if (layerKey(layers[i]) === key) slot = i;
  return slot;
};

/** Pop the top `n` entries in one traversal (back() for one, as every caller always did). */
const traverseBack = (n: number) => {
  if (n === 1) window.history.back();
  else window.history.go(-n);
};

/**
 * The step back of an adoption landed (or never reported back): take the entry over. A layer whose close from the UI
 * is still pending takes it too, so that close finds its entry and pops it; one already gone pops the stale entry.
 * Layers opened meanwhile then push their entries on top of it, in order.
 */
const finishAdopt = () => {
  const a = adopting;
  if (!a) return;
  adopting = null;
  clearTimeout(a.timer);
  const queued = afterAdopt.splice(0).filter((id) => stack.some((l) => l.id === id));
  try {
    if (stack.some((l) => l.id === a.id) || closing.has(a.id)) {
      window.history.replaceState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...historyLayers().slice(0, a.slot), a.id] }, '', a.url);
      for (const id of queued) window.history.pushState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...historyLayers(), id] }, '');
    } else {
      window.history.back();
    }
  } catch {
    /* sandboxed */
  }
};

const onPopState = () => {
  popping.clear();
  if (adopting) finishAdopt();
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
  // A leave landed on an entry that still holds its layer (an entry some other script pushed with a copy of the
  // state sat above it): keep unwinding, one step at a time, until the layer's own entry is gone.
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
  const id = `${key}#${LOAD_TOKEN}.${seq}`;
  if (canUseHistory() && adopting) {
    // An adoption is stepping back over stale entries: this layer's entry goes on top of the adopted one once it lands.
    afterAdopt.push(id);
    startListening();
  } else if (canUseHistory()) {
    const layers = historyLayers();
    const top = layers[layers.length - 1];
    const reusing = top !== undefined && closing.has(top);
    const adopt = reusing ? -1 : staleSlot(layers, key);
    try {
      if (reusing) {
        // The layer on top is closing (menu → sheet): take over its entry instead of stacking.
        clearTimeout(closing.get(top)!.timer);
        closing.delete(top);
        window.history.replaceState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...layers.slice(0, -1), id] }, '');
      } else if (adopt >= 0 && adopt === layers.length - 1) {
        // The entry this layer left behind before a reload: take it over instead of stacking a dead one under it.
        window.history.replaceState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...layers.slice(0, adopt), id] }, '');
      } else if (adopt >= 0) {
        // Stale layers above it (a reading mode open at the reload) each pushed an entry on top of this layer's own:
        // step back over them and take its own entry over once that lands (finishAdopt).
        adopting = { id, slot: adopt, url: window.location.href, timer: setTimeout(() => finishAdopt(), LEAVE_SETTLE_MS) };
        traverseBack(layers.length - 1 - adopt);
      } else {
        window.history.pushState({ ...historyState(), [HISTORY_LAYERS_KEY]: [...layers, id] }, '');
      }
    } catch {
      /* sandboxed iframe: layers still work, the back gesture just leaves */
    }
    startListening();
  }
  stack.push({ id, key, close });
  return id;
};

const finishClose = (id: string) => {
  closing.delete(id);
  if (canUseHistory()) {
    const layers = historyLayers();
    const at = layers.lastIndexOf(id);
    // Its entry goes when it is on top, or when every layer above it is closing too. Closing layers right under it
    // (closed in the same tick: the immersive reader and the studio's 'reader' layer behind it) go in the same
    // traversal, never in a second back() that could fire before the first one lands.
    if (at >= 0 && layers.slice(at + 1).every((l) => closing.has(l))) {
      let from = at;
      while (from > 0 && closing.has(layers[from - 1])) from -= 1;
      for (const l of layers.slice(from)) {
        const pending = closing.get(l);
        if (pending) clearTimeout(pending.timer);
        closing.delete(l);
        popping.add(l);
      }
      try {
        traverseBack(layers.length - from);
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
    if (pending) {
      clearTimeout(pending.timer);
      closing.delete(above);
    }
    if (above !== id) popping.add(above);
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
  if (adopting) clearTimeout(adopting.timer);
  adopting = null;
  afterAdopt.splice(0);
  popping.clear();
  stopListening();
};

export interface LeaveOptions {
  /**
   * false for a navigation the host may ignore (a reader's Library, header and legal links): when the host is still
   * mounted and open once `action` has run, its layer registers again with a fresh entry, so Back and Close keep
   * working. Default true (a close: the host goes away).
   */
  final?: boolean;
}

/**
 * While `open`, the back gesture calls `onClose` (topmost layer first). `key` names the layer
 * (e.g. 'page-editor', 'sheet:settings'). Returns `leave(action, opts)`: leave the layer from the UI and run
 * `action` once its history entry is gone (see leaveLayer); without an open layer `action` runs at once.
 */
export function useBackLayer(open: boolean, onClose: () => void, key: string): (action: () => void, opts?: LeaveOptions) => void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const idRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const mountedRef = useRef(false);
  /** Bumped to register the layer again after a non-final leave the host ignored. */
  const [armed, setArmed] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
  }, [open, key, armed]);

  useEffect(() => {
    if (!open) idRef.current = null;
  }, [open]);

  return useCallback((action: () => void, opts?: LeaveOptions) => {
    const id = idRef.current;
    if (!id) {
      action();
      return;
    }
    if (opts?.final !== false) {
      leaveLayer(id, action);
      return;
    }
    leaveLayer(id, () => {
      action();
      // Still here and still open (the app ignored the navigation, or the view it opened keeps this host): register
      // the layer again. When the action unmounts the host, React drops this update with it.
      if (mountedRef.current && openRef.current && idRef.current === id) {
        idRef.current = null;
        setArmed((n) => n + 1);
      }
    });
  }, []);
}

export default useBackLayer;
