// Pure sheet math (mobile.md §4): which presentation a sheet takes on this device, how tall each
// bottom-sheet detent is, and where a released drag snaps. No DOM — unit-tested.

import type { FormFactor } from '../formFactor';

export type SheetPresentation = 'auto' | 'popover' | 'bottom' | 'side';
export type SheetDetent = 'peek' | 'half' | 'full' | 'content' | number;
export type ResolvedPresentation = 'popover' | 'bottom' | 'side';

/** A release faster than this (px/s) moves one detent in the flick direction. */
export const FLICK_VELOCITY = 600;
/** Smallest "peek" detent in px. */
export const PEEK_MIN_PX = 160;
/** A coarse-pointer popover needs at least this much room above its anchor, else it becomes a bottom sheet. */
export const POPOVER_MIN_ROOM_PX = 280;

/**
 * `auto` resolves to:
 *  - bottom  on compact width or compact height (phones, either orientation);
 *  - side    on a split layout with a coarse pointer when the content is panel-like;
 *  - bottom  on a coarse pointer when the anchor leaves < 280 px above it (keyboard up);
 *  - popover otherwise (desktop: today's behaviour).
 * Explicit requests are honoured, except a side sheet on a compact-width phone (a bottom sheet there).
 */
export function resolvePresentation(
  ff: Pick<FormFactor, 'widthClass' | 'heightClass' | 'layout' | 'coarse'>,
  requested: SheetPresentation = 'auto',
  opts: { anchorRect?: { top: number } | null; panel?: boolean } = {}
): ResolvedPresentation {
  const phone = ff.widthClass === 'compact' || ff.heightClass === 'compact';
  if (requested === 'bottom' || requested === 'popover') return requested;
  if (requested === 'side') return ff.widthClass === 'compact' ? 'bottom' : 'side';
  if (phone) return 'bottom';
  if (ff.coarse && opts.panel && (ff.layout === 'split' || ff.layout === 'dual-screen')) return 'side';
  if (ff.coarse && opts.anchorRect && opts.anchorRect.top < POPOVER_MIN_ROOM_PX) return 'bottom';
  return 'popover';
}

/**
 * Detent heights in px (ascending, unique) for an available height `avail` and a measured content
 * height. peek ≈ 25 % (≥ 160), half 50 %, full = avail, content = fit (capped at full); numbers ≤ 1
 * are fractions of avail, larger numbers are px.
 */
export function detentHeights(detents: readonly SheetDetent[] | undefined, avail: number, contentH: number): number[] {
  const a = Math.max(0, Math.round(avail));
  const list = detents && detents.length ? detents : (['content'] as SheetDetent[]);
  const px = list.map((d) => {
    if (d === 'peek') return Math.min(a, Math.max(PEEK_MIN_PX, Math.round(a * 0.25)));
    if (d === 'half') return Math.round(a * 0.5);
    if (d === 'full') return a;
    if (d === 'content') return Math.min(a, Math.max(0, Math.round(contentH)));
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return Math.min(a, Math.round(d <= 1 ? a * d : d));
    return a;
  });
  return [...new Set(px.filter((h) => h > 0))].sort((x, y) => x - y);
}

/**
 * Where a released drag lands. `h` is the sheet height at release, `velocity` px/s (positive =
 * moving DOWN, i.e. shrinking). Returns a detent index, or -1 to dismiss.
 */
export function snapDetent(
  h: number,
  velocity: number,
  heights: readonly number[],
  opts: { dismissible?: boolean; flick?: number } = {}
): number {
  const dismissible = opts.dismissible !== false;
  const flick = opts.flick ?? FLICK_VELOCITY;
  if (!heights.length) return dismissible ? -1 : 0;
  if (velocity > flick) {
    for (let i = heights.length - 1; i >= 0; i -= 1) if (heights[i] < h - 1) return i;
    return dismissible ? -1 : 0;
  }
  if (velocity < -flick) {
    for (let i = 0; i < heights.length; i += 1) if (heights[i] > h + 1) return i;
    return heights.length - 1;
  }
  if (dismissible && h < heights[0] * 0.5) return -1;
  let best = 0;
  for (let i = 1; i < heights.length; i += 1) if (Math.abs(heights[i] - h) < Math.abs(heights[best] - h)) best = i;
  return best;
}

/** Rubber-band a value past [min, max] (resistance 0..1). */
export const rubber = (value: number, min: number, max: number, k = 0.35): number =>
  value > max ? max + (value - max) * k : value < min ? min - (min - value) * k : value;
