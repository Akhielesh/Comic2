/**
 * SplitPane — two panes side by side with a gutter you can drag or drive from the keyboard (redesign plan §4: the
 * Director pane beside a studio place). Lifted from mobile/shell/StudioLayout's SplitView (which stays as it is
 * until DS-R5 retires it) and made generic:
 *
 *   - sizes are two flex weights, remembered per pane pair on the device (storage.ts, `ds.split.<id>`), and reset to
 *     the defaults by a double click / double tap or Home / Enter on the gutter;
 *   - the gutter is a `role="separator"` with its value (the first pane's share): ← / → move it 3 %; on a coarse
 *     pointer it is a 24 px strip with a 44 × 64 grab handle, on a fine one an 8 px line;
 *   - neither pane is squeezed below `minPx` (at most 45 % of the width);
 *   - a pane can be hidden (`show`): it stays mounted, `hidden` and `inert`, so its scroll and drafts survive.
 */
import React, { useEffect, useRef, useState } from 'react';
import { applyGutterDelta } from '../studio/kit/ResizableSplit';
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

export function SplitPane({ id, start, end, defaultSizes = [40, 60], minPx = 320, label, show = 'both', coarse = false, className }: SplitPaneProps) {
  const container = useRef<HTMLDivElement>(null);
  const key = id ? scopedKey('split', id) : null;
  const [sizes, setSizes] = useState<[number, number]>(() => (key ? readStored(key, defaultSizes, { parse: validSizes }) : defaultSizes));
  const lastTap = useRef<Tap | null>(null);

  useEffect(() => {
    if (key) writeStored(key, sizes);
  }, [key, sizes]);

  const minFrac = (sum: number) => {
    const width = container.current?.getBoundingClientRect().width || 0;
    return width > 0 ? Math.min(sum * 0.45, (minPx / width) * sum) : sum * 0.25;
  };
  const reset = () => setSizes([defaultSizes[0], defaultSizes[1]]);
  const apply = (from: [number, number], delta: number, sum: number) => {
    const next = applyGutterDelta(from, 0, delta, minFrac(sum));
    return [next[0], next[1]] as [number, number];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const from = sizes;
    const sum = from[0] + from[1];
    const startX = e.clientX;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      setSizes(apply(from, ((ev.clientX - startX) / rect.width) * sum, sum));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
      setSizes((s) => apply(s, (e.key === 'ArrowLeft' ? -1 : 1) * sum * 0.03, sum));
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
        style={both ? { flexGrow: sizes[0], flexShrink: 1, flexBasis: 0 } : { flex: '1 1 0%' }}
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
        style={both ? { flexGrow: sizes[1], flexShrink: 1, flexBasis: 0 } : { flex: '1 1 0%' }}
      >
        {end}
      </div>
    </div>
  );
}
