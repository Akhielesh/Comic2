// Keys, taps and wheel → reader commands (reader.md §2.3). Pure: one mapping for every surface, so
// keyboard parity with gestures is testable.

import { keyDelta, tapDelta } from '../reader/readerModel';
import type { ReaderLayout } from './readerLayout';

export type ReaderCommand =
  /** Next / previous page (a panel in Guided View). */
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'guided' }
  | { type: 'fullscreen' }
  | { type: 'play' }
  | { type: 'shortcuts' }
  | { type: 'escape' }
  | { type: 'hud' }
  /** Webtoon / scroll layout: scroll by a fraction of the viewport (signed). */
  | { type: 'scroll'; amount: number };

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Keyboard → command. Modifier chords (browser/OS shortcuts) are left alone. */
export const keyCommand = (e: KeyLike, ctx: { rtl: boolean; layout: ReaderLayout }): ReaderCommand | null => {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const scroll = ctx.layout === 'scroll';
  switch (e.key) {
    case 'Escape':
    case 'Esc':
      return { type: 'escape' };
    case 'Home':
      return { type: 'home' };
    case 'End':
      return { type: 'end' };
    case 'g':
    case 'G':
      return { type: 'guided' };
    case 'f':
    case 'F':
      return { type: 'fullscreen' };
    case 'p':
    case 'P':
      return { type: 'play' };
    case '?':
      return { type: 'shortcuts' };
    case ' ':
    case 'Spacebar':
      if (scroll) return { type: 'scroll', amount: e.shiftKey ? -0.85 : 0.85 };
      return { type: 'step', delta: e.shiftKey ? -1 : 1 };
    case 'PageDown':
    case 'PageUp':
      if (scroll) return { type: 'scroll', amount: e.key === 'PageDown' ? 0.85 : -0.85 };
      return { type: 'step', delta: e.key === 'PageDown' ? 1 : -1 };
    case 'ArrowDown':
    case 'ArrowUp':
      // The column scrolls a little per press (focus sits on the reader, not the scroller).
      return scroll ? { type: 'scroll', amount: e.key === 'ArrowDown' ? 0.3 : -0.3 } : null;
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (scroll) return { type: 'scroll', amount: e.key === 'ArrowRight' ? 1 : -1 };
      const d = keyDelta(e.key, ctx.rtl);
      return d ? { type: 'step', delta: d } : null;
    }
    default:
      return null;
  }
};

/** Where a tap landed across the stage (0..1 of its width): outer 30 % turn, the middle toggles the HUD. */
export const tapCommand = (fraction: number, rtl: boolean): ReaderCommand => {
  const d = tapDelta(fraction, rtl);
  return d ? { type: 'step', delta: d } : { type: 'hud' };
};

/** Within the turnable outer 40 % of a page (where a drag lifts the leaf). `fraction` is 0..1 across the page. */
export const inOuterGrabZone = (fraction: number, outerEdge: 'left' | 'right'): boolean => (outerEdge === 'right' ? fraction >= 0.6 : fraction <= 0.4);

/** Double-tap: two taps within 300 ms and 24 px. */
export const isDoubleTap = (prev: { t: number; x: number; y: number } | null, next: { t: number; x: number; y: number }): boolean =>
  !!prev && next.t - prev.t <= 300 && Math.hypot(next.x - prev.x, next.y - prev.y) <= 24;

/**
 * Wheel/trackpad accumulator: a vertical wheel steps a page when the accumulated delta reaches ±60,
 * then cools down 350 ms (one notch, one page; a trackpad fling doesn't race through the book).
 * A horizontal two-finger swipe steps the same way, mirrored for RTL.
 */
export class WheelAccumulator {
  private acc = 0;
  private accX = 0;
  private lastStep = -Infinity;
  private lastT = -Infinity;
  constructor(private threshold = 60, private cooldownMs = 350, private idleResetMs = 220) {}
  push(dx: number, dy: number, t: number, rtl: boolean): ReaderCommand | null {
    if (t - this.lastT > this.idleResetMs) {
      this.acc = 0;
      this.accX = 0;
    }
    this.lastT = t;
    if (t - this.lastStep < this.cooldownMs) return null;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    if (horizontal) this.accX += dx;
    else this.acc += dy;
    const value = horizontal ? this.accX : this.acc;
    if (Math.abs(value) < this.threshold) return null;
    this.acc = 0;
    this.accX = 0;
    this.lastStep = t;
    // Content follows the fingers: a leftward swipe (dx > 0) brings the next page in LTR.
    const forward = horizontal ? (rtl ? value < 0 : value > 0) : value > 0;
    return { type: 'step', delta: forward ? 1 : -1 };
  }
}

/** The keyboard shortcuts sheet (single source for the "?" panel and the tests). */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: '← →', action: 'Previous / next page (follows the reading direction)' },
  { keys: 'Space · Shift+Space', action: 'Next / previous page (panel in Guided View)' },
  { keys: 'Page Up · Page Down', action: 'Previous / next page' },
  { keys: 'Home · End', action: 'Cover · last page' },
  { keys: '↑ ↓', action: 'Scroll (vertical reading)' },
  { keys: 'G', action: 'Guided View (panel by panel)' },
  { keys: 'P', action: 'Play / pause Guided View' },
  { keys: 'F', action: 'Full screen' },
  { keys: 'Esc', action: 'Zoom out → leave Guided View → close the reader' },
  { keys: '?', action: 'This list' }
];

/**
 * True when a vertical wheel at `target` would scroll an element between it and the stage (overflowing,
 * overflow-y auto/scroll, not yet at its end in that direction) — e.g. a long End card. That element
 * scrolls natively; the book does not turn under it.
 */
export const scrollsInside = (target: EventTarget | null, stage: Element, dy: number): boolean => {
  let el: Element | null = target instanceof Element ? target : null;
  while (el && el !== stage) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      let oy = '';
      try {
        oy = getComputedStyle(el).overflowY;
      } catch {
        oy = '';
      }
      if ((oy === 'auto' || oy === 'scroll') && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0)) return true;
    }
    el = el.parentElement;
  }
  return false;
};
