import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { withAlpha } from './theme';

// Interactive, dependency-free SVG chart — the line/area/candlestick primitive every
// finance/weather/data card composes. Container-responsive: a ResizeObserver measures
// the wrapper and the SVG renders at the measured pixel size, so the chart fills
// whatever space the card gives it (expanded lightbox, drag-resized frame, wide
// dashboards) instead of letterboxing a fixed 600px viewBox. Quiet calm-studio
// dressing: 1px token gridlines, 10px tabular-nums axis labels, a hairline crosshair
// with a frosted tooltip. Series draw in on mount and MORPH (eased rAF resampling)
// when the data swaps, so range-tab changes glide instead of snapping.

export interface ChartPoint {
  /** Human label for the x position (date, time, category). */
  label: string;
  value: number;
}
export interface Candle {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
export type ChartVariant = 'area' | 'line' | 'candlestick';

interface ChartProps {
  points: ChartPoint[];
  candles?: Candle[];
  variant?: ChartVariant;
  color: string;
  up?: string;
  down?: string;
  /** Minimum / fallback height (px) when the container doesn't impose one. */
  height?: number;
  /**
   * Optional width-proportional fallback height: h ≈ measured-width × aspect,
   * clamped to [height, maxHeight]. Lets wide layouts (expanded lightbox, desktop
   * columns) get a proportionally tall chart without the consumer measuring anything.
   */
  aspect?: number;
  /** Cap for the aspect-derived fallback height. */
  maxHeight?: number;
  /** Optional horizontal reference line (e.g. previous close). */
  baseline?: number;
  formatValue?: (n: number) => string;
  /** Hairline gridlines + 10px axis labels (auto-hidden when the chart is tiny). */
  showAxis?: boolean;
  className?: string;
}

/** True when the user asked the OS for reduced motion — every animation respects it. */
export const prefersReducedMotion = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

/**
 * Measure an element with a ResizeObserver (SSR/jsdom-safe; returns 0×0 until real).
 * Implemented as a CALLBACK ref so late-mounting targets (tab panes, conditional
 * sections) still get observed. The third tuple member is a plain ref to the node
 * for consumers that need getBoundingClientRect (hover math).
 */
export const useMeasure = <T extends HTMLElement>(): [
  (el: T | null) => void,
  { width: number; height: number },
  React.MutableRefObject<T | null>
] => {
  const elRef = useRef<T | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const attach = useCallback((el: T | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    elRef.current = el;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5 ? s : { width: r.width, height: r.height }));
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      roRef.current = new ResizeObserver(update);
      roRef.current.observe(el);
    }
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return [attach, size, elRef];
};

/** Index-resample a series to a new length (linear), so morphs work across ranges. */
const resampleSeries = (from: number[], n: number): number[] => {
  if (n <= 0) return [];
  if (from.length === 0) return new Array(n).fill(0);
  if (from.length === n) return from.slice();
  if (from.length === 1 || n === 1) return new Array(n).fill(from[0]);
  return Array.from({ length: n }, (_, i) => {
    const pos = (i / (n - 1)) * (from.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(from.length - 1, lo + 1);
    const f = pos - lo;
    return from[lo] + (from[hi] - from[lo]) * f;
  });
};

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Eased rAF morph between successive series values. On a data swap (range tab, unit
 * toggle, live refresh) the old shape is resampled to the new length and glides into
 * the new one (~380ms ease-out) instead of snapping. Honors prefers-reduced-motion.
 */
export const useSeriesMorph = (values: number[], duration = 380): number[] => {
  const [display, setDisplay] = useState(values);
  const displayRef = useRef(values);
  const rafRef = useRef(0);
  const firstRef = useRef(true);
  // Key on content, not identity — consumers often rebuild arrays per render.
  const key = useMemo(() => values.map((v) => (Number.isFinite(v) ? v.toFixed(5) : 'x')).join('|'), [values]);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useLayoutEffect(() => {
    const to = valuesRef.current;
    if (firstRef.current || prefersReducedMotion() || to.length < 2 || typeof requestAnimationFrame !== 'function') {
      firstRef.current = false;
      displayRef.current = to;
      setDisplay(to);
      return;
    }
    // Paint the resampled OLD shape first (before the browser paints the new data),
    // then glide into the new one — no one-frame snap.
    const from = resampleSeries(displayRef.current, to.length);
    displayRef.current = from;
    setDisplay(from);
    const started = performance.now();
    cancelAnimationFrame(rafRef.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const e = easeOutCubic(t);
      const cur = to.map((v, i) => from[i] + (v - from[i]) * e);
      displayRef.current = cur;
      setDisplay(cur);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [key, duration]);

  return display.length === values.length ? display : values;
};

/** Round "nice" tick values (1/2/5×10ᵏ steps) inside [min, max]. */
const niceTicks = (min: number, max: number, target = 4): number[] => {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const step0 = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
};

const DRAW_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'; // ease-out cubic

export const Chart: React.FC<ChartProps> = ({
  points,
  candles,
  variant = 'area',
  color,
  up = '#059669',
  down = '#dc2626',
  height = 120,
  aspect,
  maxHeight = 460,
  baseline,
  formatValue = (n) => n.toFixed(2),
  showAxis = true,
  className = ''
}) => {
  const gradId = useId().replace(/:/g, '');
  const [attachWrap, size, wrapEl] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const candleGroupRef = useRef<SVGGElement>(null);
  const drawnRef = useRef(false);

  const isCandle = variant === 'candlestick' && !!candles && candles.length > 1;
  const count = isCandle ? candles!.length : points.length;

  // ---- responsive box ------------------------------------------------------
  // The wrapper is h-full so a definite-height parent (flex-1 region, resized
  // frame, expanded lightbox) fills it; otherwise the min-height fallback applies —
  // either the `height` prop or a width-proportional height when `aspect` is set.
  const minH = aspect && size.width > 0 ? Math.max(height, Math.min(Math.round(size.width * aspect), maxHeight)) : height;
  const W = size.width;
  const H = Math.max(size.height, minH);

  const showLabels = showAxis && W >= 200 && H >= 80;
  const padX = 6;
  const padTop = 8;
  const padBottom = showLabels ? 18 : 8;
  const innerW = Math.max(1, W - padX * 2);
  const innerH = Math.max(1, H - padTop - padBottom);

  // ---- data → geometry -----------------------------------------------------
  const targetValues = useMemo(() => points.map((p) => p.value), [points]);
  const displayValues = useSeriesMorph(targetValues);

  const domain = useMemo(() => {
    const lows = isCandle ? candles!.map((c) => c.low) : targetValues;
    const highs = isCandle ? candles!.map((c) => c.high) : targetValues;
    if (lows.length === 0) return { min: 0, max: 1, span: 1 };
    let min = Math.min(...lows);
    let max = Math.max(...highs);
    if (typeof baseline === 'number') {
      min = Math.min(min, baseline);
      max = Math.max(max, baseline);
    }
    const rawSpan = max - min || Math.abs(max) || 1;
    min -= rawSpan * 0.04;
    max += rawSpan * 0.06;
    return { min, max, span: max - min };
  }, [targetValues, candles, isCandle, baseline]);

  const y = (v: number) => padTop + innerH * (1 - (v - domain.min) / domain.span);
  const xAt = (i: number) => (isCandle ? padX + innerW * ((i + 0.5) / count) : padX + innerW * (count > 1 ? i / (count - 1) : 0.5));

  const linePath = useMemo(() => {
    if (isCandle || displayValues.length < 2 || W <= 0) return null;
    const n = displayValues.length;
    const pts = displayValues.map((v, i) => [padX + innerW * (i / (n - 1)), y(v)] as const);
    const line = pts.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
    const base = (padTop + innerH).toFixed(1);
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${base} L${pts[0][0].toFixed(1)},${base} Z`;
    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayValues, isCandle, W, innerW, innerH, padTop, domain.min, domain.span]);

  // ---- axis ticks ----------------------------------------------------------
  const yTicks = useMemo(
    () => (showLabels ? niceTicks(domain.min, domain.max, Math.max(2, Math.min(5, Math.floor(H / 72) + 1))) : []),
    [showLabels, domain.min, domain.max, H]
  );
  const xTickIdx = useMemo(() => {
    if (!showLabels || count < 2) return [] as number[];
    const slots = Math.max(2, Math.min(6, Math.floor(W / 110) + 1));
    const idx = new Set<number>();
    for (let k = 0; k < slots; k++) idx.add(Math.round((k * (count - 1)) / (slots - 1)));
    return [...idx].sort((a, b) => a - b);
  }, [showLabels, count, W]);

  const labelAt = (i: number): string => (isCandle ? candles![i]?.label : points[i]?.label) ?? '';

  // ---- entrance: line draws in, area fill fades in (once, on first layout) --
  useEffect(() => {
    if (drawnRef.current || W <= 0 || count < 2) return;
    drawnRef.current = true;
    if (prefersReducedMotion()) return;
    const line = lineRef.current;
    if (line && typeof line.animate === 'function' && typeof line.getTotalLength === 'function') {
      try {
        const len = line.getTotalLength();
        if (Number.isFinite(len) && len > 0) {
          line.style.strokeDasharray = `${len}`;
          const anim = line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, easing: DRAW_EASE });
          anim.onfinish = () => {
            line.style.strokeDasharray = 'none';
            line.style.strokeDashoffset = '0';
          };
        }
      } catch {
        /* non-browser environment — skip the flourish */
      }
    }
    const area = areaRef.current;
    if (area && typeof area.animate === 'function') {
      area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 140, easing: 'ease-out', fill: 'backwards' });
    }
  }, [W, count]);

  // Re-fade the area fill when the variant toggles back to 'area'.
  const variantRef = useRef(variant);
  useEffect(() => {
    if (variantRef.current === variant) return;
    variantRef.current = variant;
    if (prefersReducedMotion()) return;
    if (variant === 'area' && areaRef.current && typeof areaRef.current.animate === 'function') {
      areaRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    }
  }, [variant]);

  // ---- candles grow from the midline with a slight stagger ------------------
  const candleKey = useMemo(() => (isCandle ? candles!.map((c) => `${c.open}:${c.close}`).join('|') : ''), [candles, isCandle]);
  useEffect(() => {
    if (!isCandle || W <= 0 || prefersReducedMotion()) return;
    const g = candleGroupRef.current;
    if (!g) return;
    const nodes = Array.from(g.querySelectorAll<SVGGElement>('[data-candle]'));
    nodes.forEach((node, i) => {
      if (typeof node.animate !== 'function') return;
      node.style.transformBox = 'fill-box';
      node.style.transformOrigin = 'center';
      node.animate(
        [
          { opacity: 0, transform: 'scaleY(0.25)' },
          { opacity: 1, transform: 'scaleY(1)' }
        ],
        { duration: 380, delay: Math.min(i * 6, 240), easing: DRAW_EASE, fill: 'backwards' }
      );
    });
  }, [candleKey, isCandle, W]);

  // ---- hover ----------------------------------------------------------------
  const onMove = (e: React.PointerEvent) => {
    const rect = wrapEl.current?.getBoundingClientRect();
    if (!rect || count < 2) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - padX) / innerW));
    setHover(isCandle ? Math.min(count - 1, Math.floor(frac * count)) : Math.round(frac * (count - 1)));
  };

  const hoveredLabel = hover != null ? labelAt(hover) : null;
  const hoveredValue = hover != null ? (isCandle ? candles![hover]?.close : points[hover]?.value) : null;

  if (count < 2) return null;

  return (
    <div
      ref={attachWrap}
      className={`relative h-full w-full ${className}`}
      style={{ minHeight: minH }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      {W > 10 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 block" aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={withAlpha(color, 0.26)} />
              <stop offset="100%" stopColor={withAlpha(color, 0)} />
            </linearGradient>
          </defs>

          {/* Crisp 1px hairline gridlines + right-inset axis labels */}
          {yTicks.map((v) => {
            const yy = Math.round(y(v)) + 0.5;
            if (yy < padTop - 1 || yy > padTop + innerH + 1) return null;
            return (
              <g key={v}>
                <line x1={padX} x2={W - padX} y1={yy} y2={yy} stroke="var(--ds-hairline-soft)" strokeWidth="1" shapeRendering="crispEdges" />
                <text
                  x={W - padX - 2}
                  y={yy - 3}
                  textAnchor="end"
                  fontSize="10"
                  fill="var(--ds-muted)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatValue(v)}
                </text>
              </g>
            );
          })}

          {/* X labels along the bottom band */}
          {xTickIdx.map((i, k) => (
            <text
              key={`${i}-${k}`}
              x={xAt(i)}
              y={H - 5}
              textAnchor={k === 0 ? 'start' : k === xTickIdx.length - 1 ? 'end' : 'middle'}
              fontSize="10"
              fill="var(--ds-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {labelAt(i)}
            </text>
          ))}

          {typeof baseline === 'number' && (
            <line
              x1={padX}
              x2={W - padX}
              y1={y(baseline)}
              y2={y(baseline)}
              stroke="var(--ds-faint)"
              strokeWidth="1"
              strokeDasharray="4 4"
            />
          )}

          {/* Line / area */}
          {linePath && variant === 'area' && <path ref={areaRef} d={linePath.area} fill={`url(#${gradId})`} />}
          {linePath && (
            <path
              ref={lineRef}
              d={linePath.line}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ transition: 'stroke 300ms ease' }}
            />
          )}

          {/* Candlesticks */}
          {isCandle && (
            <g ref={candleGroupRef}>
              {candles!.map((c, i) => {
                const x = xAt(i);
                const slot = innerW / count;
                const bw = Math.max(1.5, Math.min(14, slot * 0.6));
                const rising = c.close >= c.open;
                const col = rising ? up : down;
                const yO = y(c.open);
                const yC = y(c.close);
                return (
                  <g key={i} data-candle>
                    <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" />
                    <rect x={x - bw / 2} y={Math.min(yO, yC)} width={bw} height={Math.max(1, Math.abs(yC - yO))} fill={col} rx={bw > 4 ? 1 : 0} />
                  </g>
                );
              })}
            </g>
          )}

          {/* Crosshair: vertical hairline + halo dot on the series */}
          {hover != null && (
            <>
              <line
                x1={xAt(hover)}
                x2={xAt(hover)}
                y1={padTop}
                y2={padTop + innerH}
                stroke="var(--ds-faint)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              {!isCandle && hoveredValue != null && (
                <>
                  <circle cx={xAt(hover)} cy={y(hoveredValue)} r="8" fill={withAlpha(color, 0.16)} />
                  <circle cx={xAt(hover)} cy={y(hoveredValue)} r="3.5" fill={color} stroke="var(--ds-canvas)" strokeWidth="1.5" />
                </>
              )}
            </>
          )}
        </svg>
      )}

      {/* Frosted glass tooltip */}
      {hover != null && hoveredValue != null && W > 10 && (
        <div
          className="pointer-events-none absolute top-1.5 z-10 -translate-x-1/2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-1 text-center shadow-[0_2px_10px_rgba(0,0,0,0.10)] backdrop-blur-md"
          style={{ left: Math.min(W - 48, Math.max(48, xAt(hover))) }}
        >
          <div className="text-[10px] font-medium tabular-nums text-[var(--ds-muted)]">{hoveredLabel}</div>
          <div className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">{formatValue(hoveredValue)}</div>
        </div>
      )}
    </div>
  );
};
