// useKeyboardInset() (mobile.md §3.9): keeps the studio above the on-screen keyboard.
//
//   --app-h   visible height (visualViewport.height)          → the studio root sizes to it
//   --kb      keyboard overlap (innerHeight − vv.height − vv.offsetTop) → bottom sheets sit on it
//   html.kb-open  when --kb > 64 px (ignores the iOS QuickType bar alone): the bottom tab bar hides
//                 and --sa-bottom-eff collapses (the home indicator is hidden under the keyboard)
//
// Android with `interactive-widget=resizes-content` shrinks the layout viewport too, so kb ≈ 0 and
// --app-h is simply the resized height (no double offset). iOS keeps innerHeight and shrinks the
// visual viewport, so kb is the keyboard height. Safari also pans the document to reveal the
// focused field; the root already fits, so that pan is undone (the header stays put).
//
// One ref-counted store: the studio shell, the reader and App.tsx can all mount it; the last
// unmount removes the properties so the CSS fallbacks (100dvh / 0px) apply again.

import { useSyncExternalStore } from 'react';

export interface KeyboardInset {
  /** Keyboard overlap in CSS px (0 when closed, and on Android where the layout resizes). */
  kb: number;
  /** Visible app height in CSS px. */
  appH: number;
}

/** Below this overlap the keyboard counts as closed (the iOS QuickType/accessory bar alone). */
export const KB_OPEN_THRESHOLD = 64;

/** Pure: the inset from window/visualViewport metrics. Pinch-zoomed viewports report no keyboard. */
export const computeKeyboardInset = (i: { innerHeight: number; vvHeight: number; vvOffsetTop?: number; vvScale?: number }): KeyboardInset => {
  const inner = Number.isFinite(i.innerHeight) && i.innerHeight > 0 ? i.innerHeight : 0;
  const vvH = Number.isFinite(i.vvHeight) && i.vvHeight > 0 ? i.vvHeight : inner;
  // A pinch-zoomed page shrinks the visual viewport too — that is not a keyboard.
  if (typeof i.vvScale === 'number' && i.vvScale > 1.01) return { kb: 0, appH: Math.round(inner) };
  const offset = Number.isFinite(i.vvOffsetTop) ? Math.max(0, i.vvOffsetTop as number) : 0;
  return { kb: Math.max(0, Math.round(inner - vvH - offset)), appH: Math.round(vvH) };
};

const CLOSED: KeyboardInset = { kb: 0, appH: 0 };
let current: KeyboardInset = CLOSED;
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

const read = (): KeyboardInset => {
  if (typeof window === 'undefined') return CLOSED;
  const vv = window.visualViewport;
  if (!vv) return { kb: 0, appH: window.innerHeight };
  return computeKeyboardInset({ innerHeight: window.innerHeight, vvHeight: vv.height, vvOffsetTop: vv.offsetTop, vvScale: vv.scale });
};

const write = (inset: KeyboardInset) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (window.visualViewport && inset.appH > 0) root.style.setProperty('--app-h', `${inset.appH}px`);
  root.style.setProperty('--kb', `${inset.kb}px`);
  root.classList.toggle('kb-open', inset.kb > KB_OPEN_THRESHOLD);
};

const clear = () => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.removeProperty('--app-h');
  root.style.removeProperty('--kb');
  root.classList.remove('kb-open');
};

const update = () => {
  const next = read();
  write(next);
  // iOS pans the whole document to reveal the focused field; our root already fits the visible area.
  if (next.kb > 0) {
    const scroller = document.scrollingElement || document.documentElement;
    if (scroller && scroller.scrollTop > 0) {
      try {
        window.scrollTo(0, 0);
      } catch {
        /* jsdom */
      }
    }
  }
  if (next.kb !== current.kb || next.appH !== current.appH) {
    current = next;
    listeners.forEach((l) => l());
  }
};

const attach = (): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  let frame = 0;
  const timers: number[] = [];
  const schedule = () => {
    if (frame) return;
    const raf = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame.bind(window) : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 16);
    frame = raf(() => {
      frame = 0;
      update();
    }) as number;
  };
  // Rotation and focus changes can leave a stale visualViewport size for a moment: re-read after.
  const settle = () => {
    schedule();
    timers.push(window.setTimeout(update, 120), window.setTimeout(update, 400));
    if (timers.length > 12) timers.splice(0, timers.length - 12);
  };
  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', settle);
  window.addEventListener('focusin', settle);
  window.addEventListener('focusout', settle);
  update();
  return () => {
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', settle);
    window.removeEventListener('focusin', settle);
    window.removeEventListener('focusout', settle);
    if (frame) {
      try {
        window.cancelAnimationFrame(frame);
      } catch {
        /* timer fallback */
      }
    }
    timers.forEach((t) => window.clearTimeout(t));
    current = CLOSED;
    clear();
  };
};

export const subscribeKeyboardInset = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && detach) {
      detach();
      detach = null;
    }
  };
};

const getSnapshot = (): KeyboardInset => current;
const getServerSnapshot = (): KeyboardInset => CLOSED;
const noopSubscribe = () => () => undefined;

/**
 * Keeps --app-h and --kb on <html> and toggles html.kb-open while mounted (enabled). Returns the
 * current inset; components that only need CSS can ignore it.
 */
export function useKeyboardInset(enabled = true): KeyboardInset {
  return useSyncExternalStore(enabled ? subscribeKeyboardInset : noopSubscribe, getSnapshot, getServerSnapshot);
}

/** Test hook: re-read now (after stubbing visualViewport). */
export const recomputeKeyboardInset = (): void => {
  if (listeners.size) update();
};

export default useKeyboardInset;
