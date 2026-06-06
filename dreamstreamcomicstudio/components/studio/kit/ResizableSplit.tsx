// ResizableSplit (Sprint 1, S1.1): a flex N-pane splitter with draggable gutters and sizes
// persisted to localStorage. Sizes are flex-grow weights (relative), so the layout is fluid
// and survives window resizes. Pane order = children order; one gutter between each pair.

import React, { useEffect, useRef, useState } from 'react';
import { useStudioTheme } from './themeStore';

export interface ResizableSplitProps {
  direction: 'horizontal' | 'vertical';
  /** localStorage key for persisted weights. */
  storageKey: string;
  /** Initial weights (length must match children; defaults to equal). */
  initial?: number[];
  /** Minimum pane size in px. */
  minPx?: number;
  className?: string;
  children: React.ReactNode;
}

/** Clamp a gutter drag so neither adjacent pane drops below `minFrac`. Pure (unit-tested). */
export const applyGutterDelta = (sizes: number[], i: number, dFrac: number, minFrac: number): number[] => {
  if (i < 0 || i >= sizes.length - 1) return sizes;
  const a = sizes[i];
  const b = sizes[i + 1];
  // Keep both ≥ minFrac.
  const lo = minFrac - a;        // most we can subtract from a
  const hi = b - minFrac;        // most we can add to a (taken from b)
  const d = Math.max(lo, Math.min(dFrac, hi));
  const next = sizes.slice();
  next[i] = a + d;
  next[i + 1] = b - d;
  return next;
};

const readWeights = (key: string, n: number, initial?: number[]): number[] => {
  const fallback = initial && initial.length === n ? initial.slice() : Array(n).fill(1);
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === n && parsed.every((x) => typeof x === 'number' && x > 0)) {
      return parsed as number[];
    }
  } catch { /* ignore */ }
  return fallback;
};

export const ResizableSplit: React.FC<ResizableSplitProps> = ({
  direction, storageKey, initial, minPx = 160, className, children,
}) => {
  const t = useStudioTheme();
  const horizontal = direction === 'horizontal';
  const items = React.Children.toArray(children);
  const n = items.length;
  const containerRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<number[]>(() => readWeights(storageKey, n, initial));

  // Keep the weight count in sync if children count changes.
  useEffect(() => {
    setSizes((prev) => (prev.length === n ? prev : readWeights(storageKey, n, initial)));
  }, [n, storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(storageKey, JSON.stringify(sizes)); } catch { /* ignore */ }
  }, [storageKey, sizes]);

  const onGutterDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;
    const startPos = horizontal ? e.clientX : e.clientY;
    const startSizes = sizes.slice();
    const sum = startSizes.reduce((a, b) => a + b, 0);
    const minFrac = (minPx / total) * sum;

    const onMove = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const dFrac = ((pos - startPos) / total) * sum;
      setSizes(applyGutterDelta(startSizes, i, dFrac, minFrac));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div ref={containerRef} className={`flex ${horizontal ? 'flex-row' : 'flex-col'} h-full w-full min-h-0 min-w-0 ${className ?? ''}`}>
      {items.map((child, i) => (
        <React.Fragment key={i}>
          <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flexGrow: sizes[i] ?? 1, flexShrink: 1, flexBasis: 0 }}>
            {child}
          </div>
          {i < n - 1 && (
            <div
              role="separator"
              aria-orientation={horizontal ? 'vertical' : 'horizontal'}
              onPointerDown={onGutterDown(i)}
              title="Drag to resize"
              className={`group relative shrink-0 touch-none ${t.panelAlt} ${horizontal ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'} flex items-center justify-center`}
            >
              <span className={`${horizontal ? 'h-8 w-0.5' : 'w-8 h-0.5'} rounded-full ${t.accent} bg-current opacity-20 transition-opacity group-hover:opacity-70`} />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
