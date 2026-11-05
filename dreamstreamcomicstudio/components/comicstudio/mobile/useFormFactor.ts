// useFormFactor() (contract §13.3; mobile.md §2.1). ONE shared store (useSyncExternalStore) so fifty
// consumers attach one set of listeners: resize/orientation (rAF-coalesced), the pointer, hover,
// reduced-motion and viewport-segment media queries, `window.viewport.segments` (Viewport Segments
// API, feature-detected), and `navigator.connection` (saveData). SSR/jsdom-safe: without a window it
// reports the desktop defaults. A <FormFactorProvider> can pin a value (tests, the QA harness).
//
// The on-screen keyboard is NOT a new form factor. index.html opts into Android's
// `interactive-widget=resizes-content`, so opening the keyboard shrinks innerHeight (a 360×740 phone
// drops to ~360 px tall, a landscape Android tablet to ~450): read naively that is "compact height"
// → the phone-landscape rail layout, which would swap the whole shell (and remount the composer the
// user is typing in) the moment a field is tapped. While a text field is focused and the width is
// unchanged, a SHORTER window keeps the keyboard-less height; the real height returns on blur/resize.

import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { DESKTOP_FORM_FACTOR, SINGLE_SEGMENT, classifyViewport, sameFormFactor, segmentsFromRects, type FormFactor, type Segments } from './formFactor';
import { isEditable } from './useKeyboardInset';

const QUERIES = {
  coarse: '(pointer: coarse)',
  anyFine: '(any-pointer: fine)',
  hover: '(hover: hover)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
  hSegments: '(horizontal-viewport-segments: 2)',
  vSegments: '(vertical-viewport-segments: 2)'
} as const;

const hasWindow = (): boolean => typeof window !== 'undefined';

const matches = (query: string, fallback: boolean): boolean => {
  try {
    return hasWindow() && typeof window.matchMedia === 'function' ? !!window.matchMedia(query)?.matches : fallback;
  } catch {
    return fallback;
  }
};

interface NetworkInfo {
  saveData?: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
  removeEventListener?: (type: string, cb: () => void) => void;
}
const connection = (): NetworkInfo | undefined => {
  try {
    return hasWindow() ? ((navigator as unknown as { connection?: NetworkInfo }).connection ?? undefined) : undefined;
  } catch {
    return undefined;
  }
};

const readSegments = (): Segments => {
  if (!hasWindow()) return SINGLE_SEGMENT;
  try {
    const api = (window as unknown as { viewport?: { segments?: ArrayLike<DOMRectReadOnly> | null } }).viewport;
    if (api && api.segments && api.segments.length === 2) return segmentsFromRects(api.segments);
  } catch {
    /* API absent or throwing: fall back to the media queries */
  }
  if (matches(QUERIES.hSegments, false)) return { count: 2, axis: 'horizontal', rects: [] };
  if (matches(QUERIES.vSegments, false)) return { count: 2, axis: 'vertical', rects: [] };
  return SINGLE_SEGMENT;
};

/**
 * Pure: the height to classify. With a text field focused at the same width, a window that got
 * SHORTER is the on-screen keyboard (Android resizes the layout viewport) — keep the previous height.
 */
export const keyboardSteadyHeight = (prev: Pick<FormFactor, 'width' | 'height'> | null | undefined, w: number, h: number, editableFocused: boolean): number =>
  prev && editableFocused && prev.width === w && h < prev.height ? prev.height : h;

const editableFocused = (): boolean => {
  try {
    return typeof document !== 'undefined' && isEditable(document.activeElement);
  } catch {
    return false;
  }
};

/**
 * A snapshot of the current window (desktop defaults outside a browser). `prev` (the last snapshot)
 * lets the keyboard rule above hold the height steady while the user types.
 */
export const readFormFactor = (prev?: FormFactor | null): FormFactor => {
  if (!hasWindow()) return DESKTOP_FORM_FACTOR;
  const w = window.innerWidth;
  const h = keyboardSteadyHeight(prev, w, window.innerHeight, editableFocused());
  const coarse = matches(QUERIES.coarse, false);
  const segments = readSegments();
  let lowMemory = false;
  try {
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    lowMemory = typeof mem === 'number' && mem > 0 && mem <= 4;
  } catch {
    /* unknown memory: assume enough */
  }
  return {
    width: w,
    height: h,
    ...classifyViewport({ w, h, coarse, segments }),
    coarse,
    anyFine: matches(QUERIES.anyFine, true),
    hover: matches(QUERIES.hover, true),
    segments,
    reducedMotion: matches(QUERIES.reducedMotion, false),
    saveData: connection()?.saveData === true,
    lowMemory
  };
};

// ── Shared store ─────────────────────────────────────────────────────────────

let snapshot: FormFactor | null = null;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

/** Re-read the window; keep the same object when nothing changed (stable for useSyncExternalStore). */
const refresh = (): boolean => {
  const next = readFormFactor(snapshot);
  if (snapshot && sameFormFactor(snapshot, next)) return false;
  snapshot = next;
  return true;
};

const notify = () => {
  if (refresh()) listeners.forEach((l) => l());
};

const attach = (): (() => void) => {
  if (!hasWindow()) return () => undefined;
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = -1; // pending (a synchronous rAF polyfill runs the callback before returning its id)
    const raf = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame.bind(window) : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);
    const id = raf(() => {
      frame = 0;
      notify();
    }) as number;
    if (frame === -1) frame = id;
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  // A field losing focus releases a height held for the keyboard (no resize may follow on desktop).
  window.addEventListener('focusout', schedule);
  const mqls: MediaQueryList[] = [];
  if (typeof window.matchMedia === 'function') {
    for (const q of Object.values(QUERIES)) {
      try {
        const mql = window.matchMedia(q);
        if (!mql) continue;
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', schedule);
        else if (typeof mql.addListener === 'function') mql.addListener(schedule);
        mqls.push(mql);
      } catch {
        /* unsupported query */
      }
    }
  }
  const conn = connection();
  conn?.addEventListener?.('change', schedule);
  return () => {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.removeEventListener('focusout', schedule);
    for (const mql of mqls) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', schedule);
      else if (typeof mql.removeListener === 'function') mql.removeListener(schedule);
    }
    conn?.removeEventListener?.('change', schedule);
    if (frame > 0) {
      try {
        window.cancelAnimationFrame(frame);
      } catch {
        /* timer fallback */
      }
    }
  };
};

export const subscribeFormFactor = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    refresh();
    detach = attach();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && detach) {
      detach();
      detach = null;
    }
  };
};

export const getFormFactorSnapshot = (): FormFactor => {
  // Without subscribers nothing keeps the snapshot fresh: re-read (same object when unchanged).
  if (!snapshot || !listeners.size) refresh();
  return snapshot as FormFactor;
};

const getServerSnapshot = (): FormFactor => DESKTOP_FORM_FACTOR;

/** Test hook: forget the cached snapshot (after mocking innerWidth / matchMedia). */
export const resetFormFactorStore = (): void => {
  snapshot = null;
  if (listeners.size) notify();
};

// ── Override (tests, QA harness) ─────────────────────────────────────────────

const FormFactorOverride = createContext<FormFactor | null>(null);

/** Pins the form factor for a subtree (QA harness scenes, component tests). */
export const FormFactorProvider: React.FC<{ value: FormFactor; children: React.ReactNode }> = ({ value, children }) =>
  React.createElement(FormFactorOverride.Provider, { value }, children);

/** Build a full FormFactor from a width/height (and optional pointer/segments) — handy for tests and the harness. */
export const formFactorFor = (o: { w: number; h: number; coarse?: boolean; segments?: Segments } & Partial<FormFactor>): FormFactor => {
  const { w, h, coarse = false, segments = SINGLE_SEGMENT, ...rest } = o;
  return {
    ...DESKTOP_FORM_FACTOR,
    hover: !coarse,
    anyFine: !coarse,
    ...rest,
    width: w,
    height: h,
    coarse,
    segments,
    ...classifyViewport({ w, h, coarse, segments })
  };
};

export function useFormFactor(): FormFactor {
  const pinned = useContext(FormFactorOverride);
  const live = useSyncExternalStore(subscribeFormFactor, getFormFactorSnapshot, getServerSnapshot);
  return pinned ?? live;
}

export default useFormFactor;
