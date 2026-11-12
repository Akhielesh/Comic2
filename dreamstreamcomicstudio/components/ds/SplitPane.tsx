/**
 * SplitPane — two panes side by side with a gutter you can drag or drive from the keyboard (redesign plan §4: the
 * Director pane beside a studio place). Lifted from mobile/shell/StudioLayout's SplitView (which stays as it is
 * until DS-R5 retires it) and made generic:
 *
 *   - sizes are two flex weights, remembered per pane pair on the device (storage.ts, `ds.split.<id>`), and reset to
 *     the defaults by a double click / double tap or Home / Enter on the gutter;
 *   - the gutter is a `role="separator"` with its value (the first pane's share): ← / → move it 3 %; on a coarse
 *     pointer it is a 24 px strip with a 44 × 64 grab handle, on a fine one an 8 px line;
 *   - neither pane is squeezed below `minPx` (at most 45 % of the width), and each pane can have its own range
 *     (`startMinPx`/`startMaxPx`, `endMinPx`/`endMaxPx`): the Director's 320–520 px (layout.ts
 *     `studio.director.minPx`/`maxPx`) holds while dragging, with the keys, and when the window grows (a max is
 *     also the pane's CSS max-width);
 *   - a drag measures the container once, when it starts, and the sizes are written to the device once, when it
 *     ends (and on each key move or reset), never on every pointer move;
 *   - a pane can be hidden (`show`): it stays mounted, `hidden` and `inert`, so its scroll and drafts survive.
 */
import React, { useRef, useState } from 'react';
import { isDoubleTap, type Tap } from '../comicstudio/mobile/touch/gestureMath';
import { cn } from '../../lib/utils';
import { RADIUS_PILL, SHADOW_SOFT } from './recipes';
import { readStored, scopedKey, writeStored } from './storage';

export interface SplitPaneProps {
  /** Names the remembered sizes (`ds.split.<id>`); omit to keep them for this visit only. */
  id?: string;
  start: React.ReactNode;
  end: React.ReactNode;
  /** Default flex weights [start, end]. */
  defaultSizes?: [number, number];
  /** Neither pane gets narrower than this (capped at 45 % of the width). */
  minPx?: number;
  /** The start pane's own range in px (its minimum defaults to minPx). */
  startMinPx?: number;
  startMaxPx?: number;
  /** The end pane's own range in px: the Director pane is 320–520 at 1440 (layout.ts studio.director). */
  endMinPx?: number;
  endMaxPx?: number;
  /** The gutter's accessible name ("Resize the Director"). */
  label: string;
  /** Which panes are shown; the hidden one stays mounted, hidden and inert. */
  show?: 'both' | 'start' | 'end';
  /** A coarse pointer: the 24 px gutter with a 44 × 64 grab handle. */
  coarse?: boolean;
  className?: string;
}

const validSizes = (raw: unknown): [number, number] | undefined =>
  Array.isArray(raw) && raw.length === 2 && raw.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) ? [raw[0], raw[1]] : undefined;

/**
 * The range the start pane's weight may take, for a container `width` px wide and weights summing to `sum`: both
 * minimums (each capped at 45 % of the width), then the maximums. When a maximum cannot hold beside the minimums
 * (a narrow window), the minimums win.
 */
export function splitBounds(
  width: number,
  sum: number,
  px: { minPx: number; startMinPx?: number; startMaxPx?: number; endMinPx?: number; endMaxPx?: number }
): { lo: number; hi: number } {
  if (!(width > 0) || !(sum > 0)) return { lo: sum * 0.25, hi: sum * 0.75 };
  const frac = (n: number) => (n / width) * sum;
  const cap = sum * 0.45;
  const minLo = Math.min(cap, frac(px.startMinPx ?? px.minPx));
  const minHi = sum - Math.min(cap, frac(px.endMinPx ?? px.minPx));
  const lo = px.endMaxPx !== undefined ? Math.max(minLo, sum - frac(px.endMaxPx)) : minLo;
  const hi = px.startMaxPx !== undefined ? Math.min(minHi, frac(px.startMaxPx)) : minHi;
  return lo <= hi ? { lo, hi } : { lo: minLo, hi: minHi };
}

export function SplitPane({ id, start, end, defaultSizes = [40, 60], minPx = 320, startMinPx, startMaxPx, endMinPx, endMaxPx, label, show = 'both', coarse = false, className }: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const key = id ? scopedKey('split', id) : null;
  const [sizes, setSizes] = useState<[number, number]>(() => (key ? readStored(key, defaultSizes, { parse: validSizes }) : defaultSizes));
  const lastTap = useRef<Tap | null>(null);
  const px = { minPx, startMinPx, startMaxPx, endMinPx, endMaxPx };

  const persist = (next: [number, number]) => {
    if (key) writeStored(key, next);
  };
  const measure = () => container.current?.getBoundingClientRect().width || 0;
  /** The start pane takes `from[0] + delta` weight, held inside its bounds. */
  const apply = (from: [number, number], delta: number, bounds: { lo: number; hi: number }): [number, number] => {
    const sum = from[0] + from[1];
    const a = Math.min(bounds.hi, Math.max(bounds.lo, from[0] + delta));
    return [a, sum - a];
  };
  const reset = () => {
    const next: [number, number] = [defaultSizes[0], defaultSizes[1]];
    setSizes(next);
    persist(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    // Measured once per drag: a pointer move only does arithmetic and one state update.
    const width = measure();
    if (width <= 0) return;
    const from = sizes;
    const sum = from[0] + from[1];
    const bounds = splitBounds(width, sum, px);
    const startX = e.clientX;
    let moved = false;
    let latest = from;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      latest = apply(from, ((ev.clientX - startX) / width) * sum, bounds);
      setSizes(latest);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Written once, when the drag ends.
      if (latest !== from) persist(latest);
      if (!moved && ev.type === 'pointerup') {
        const tap = { t: Date.now(), x: ev.clientX, y: ev.clientY };
        if (isDoubleTap(lastTap.current, tap)) {
          lastTap.current = null;
          reset();
        } else lastTap.current = tap;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sum = sizes[0] + sizes[1];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = apply(sizes, (e.key === 'ArrowLeft' ? -1 : 1) * sum * 0.03, splitBounds(measure(), sum, px));
      setSizes(next);
      persist(next);
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      reset();
    }
  };

  const share = Math.round((sizes[0] / (sizes[0] + sizes[1])) * 100);
  const both = show === 'both';
  const hideStart = show === 'end';
  const hideEnd = show === 'start';
  const separator = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': label,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': share,
    tabIndex: 0,
    onKeyDown
  };

  return (
    <div ref={container} data-slot="split-pane" className={cn('flex h-full min-h-0 w-full min-w-0', className)}>
      <div
        hidden={hideStart}
        inert={hideStart || undefined}
        data-pane="start"
        className={cn(hideStart ? 'hidden' : 'flex', 'min-h-0 min-w-0')}
        style={both ? { flexGrow: sizes[0], flexShrink: 1, flexBasis: 0, maxWidth: startMaxPx } : { flex: '1 1 0%' }}
      >
        {start}
      </div>
      {both &&
        (coarse ? (
          <div data-split-gutter="" onPointerDown={onPointerDown} onDoubleClick={reset} className="relative flex w-6 shrink-0 cursor-col-resize touch-none justify-center">
            <span aria-hidden="true" className="w-px bg-[var(--ds-hairline)]" />
            <div
              {...separator}
              title="Drag to resize · double-tap to reset"
              data-split-handle=""
              className={`group absolute left-1/2 top-1/2 grid h-16 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center ${RADIUS_PILL} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]`}
            >
              <span aria-hidden="true" className={`h-10 w-1.5 ${RADIUS_PILL} border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] ${SHADOW_SOFT} group-active:bg-[var(--ds-hover)]`} />
            </div>
          </div>
        ) : (
          <div
            {...separator}
            title="Drag to resize · double-click to reset"
            onPointerDown={onPointerDown}
            onDoubleClick={reset}
            data-split-gutter=""
            data-hit-exempt="gutter: 8 px on fine pointers by design"
            className="group relative flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center focus-visible:outline-none"
          >
            <span aria-hidden="true" className="w-px bg-[var(--ds-hairline)] transition-colors duration-[var(--ds-motion-medium)] group-hover:bg-[var(--ds-muted)] group-focus-visible:bg-[var(--ds-ring)]" />
          </div>
        ))}
      <div
        hidden={hideEnd}
        inert={hideEnd || undefined}
        data-pane="end"
        className={cn(hideEnd ? 'hidden' : 'flex', 'min-h-0 min-w-0')}
        style={both ? { flexGrow: sizes[1], flexShrink: 1, flexBasis: 0, maxWidth: endMaxPx } : { flex: '1 1 0%' }}
      >
        {end}
      </div>
    </div>
  );
}
