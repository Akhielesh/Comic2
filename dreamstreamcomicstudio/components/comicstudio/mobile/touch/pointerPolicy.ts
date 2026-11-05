// Pointer policy (mobile.md §5.3, §5.7): one place for every touch/pen/mouse threshold, so balloons,
// mark-up, the filmstrip and the canvas agree on what a tap, a drag and a long-press are.

/** Movement before a press becomes a drag: fingers wobble, pens are precise, mice in between. */
export const dragSlopPx = (pointerType: string): number => (pointerType === 'touch' ? 10 : pointerType === 'pen' ? 2 : 3);

export const longPressMs = 450;
export const longPressTolerancePx = 10;
/** Touch "lift": hold this long on an unselected balloon before it follows the finger. */
export const liftDelayMs = 220;
export const doubleTapMs = 300;
export const doubleTapPx = 24;
/** Touches this soon after a pen lifts are treated as the palm resting on the screen. */
export const palmWindowMs = 300;

export const exceedsSlop = (dx: number, dy: number, pointerType: string): boolean => Math.hypot(dx, dy) > dragSlopPx(pointerType);

/**
 * Palm rejection: while a pen is down — or within 300 ms of it lifting — a single TOUCH pointer is
 * the hand resting on the glass, not an intent. Two-finger touch gestures still pinch.
 */
export const isPalmTouch = (pointerType: string, penDown: boolean, lastPenUpAt: number, now: number): boolean =>
  pointerType === 'touch' && (penDown || now - lastPenUpAt < palmWindowMs);

/** Keep the pointer stream when the finger slides off the element (sheets, iframes). */
export const capturePointer = (el: Element | null | undefined, pointerId: number): void => {
  try {
    el?.setPointerCapture?.(pointerId);
  } catch {
    /* pointer already gone (or jsdom) */
  }
};

export const releasePointer = (el: Element | null | undefined, pointerId: number): void => {
  try {
    if (el?.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
  } catch {
    /* already released */
  }
};

const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export const HAPTICS_KEY = 'cs.haptics';

/** The user's Haptics setting (default on). */
export const hapticsEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(HAPTICS_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * A short haptic tick (long-press fired, lift, snap). Android Chrome only — iOS has no web vibration
 * API, so this is a silent no-op there. Never under reduced motion or with Haptics off.
 */
export const haptic = (ms = 8): void => {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  if (prefersReducedMotion() || !hapticsEnabled()) return;
  try {
    navigator.vibrate(ms);
  } catch {
    /* blocked by the browser (no user activation yet) */
  }
};

/** Elements whose own gestures win over the canvas (text editing, controls). */
export const OWN_GESTURE_SELECTOR = 'input,textarea,select,button,a[href],[contenteditable="true"],[data-no-canvas-gesture]';

export const ownsGesture = (target: EventTarget | null): boolean => {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && !!el.closest(OWN_GESTURE_SELECTOR);
};
