import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Percent, DollarSign } from 'lucide-react';
import type { StockComparisonArtifact, StockComparisonSeries, StockRange, StockPoint } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  RangeTabs,
  resolveTheme,
  withAlpha,
  formatPrice,
  formatPercent,
  shortDate,
  useCompact,
  type PaletteName
} from './kit';

// Multi-symbol "compare trends" card. Overlays 2–6 assets on one inline-SVG chart
// (no chart libraries — house rule), with a macOS range timeline (1D…MAX), a
// %-change ⇄ absolute-price toggle, and a legend whose chips toggle each line and
// show its move over the window. % mode rebases every series to 0 at the range start
// — the only honest way to compare assets at wildly different prices (gold vs oil vs
// the S&P). Lines draw in on mount / range change; a hover crosshair reads every
// series at once. Two densities: a glance overlay (compact) and the full chart.

const RANGE_ORDER: StockRange[] = ['1D', '5D', '1M', '6M', '1Y', '5Y', 'MAX'];
// Trailing sessions each range approximates when derived from a flat `series`.
const DERIVE: Record<StockRange, number> = { '1D': 2, '5D': 5, '1M': 22, '6M': 126, '1Y': 252, '5Y': 1260, MAX: Infinity };

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Closing prices for a series in a given range — from pre-bucketed ranges if present,
 *  otherwise sliced off the flat `series`. */
export const pointsForRange = (s: StockComparisonSeries, range: StockRange): StockPoint[] => {
  const bucket = s.ranges?.[range];
  if (bucket && bucket.length >= 2) return bucket;
  const flat = s.series ?? [];
  if (flat.length < 2) return [];
  const n = DERIVE[range] === Infinity ? flat.length : Math.min(flat.length, DERIVE[range]);
  return flat.slice(-n);
};

/** Ranges that AT LEAST TWO series can draw — so a tab never shows an empty chart. */
export const sharedRanges = (series: StockComparisonSeries[]): StockRange[] =>
  RANGE_ORDER.filter((r) => series.filter((s) => pointsForRange(s, r).length >= 2).length >= 2);

/** Linear-resample an array to exactly `n` samples over its own index domain, so
 *  series of different lengths align start-to-end on a shared x-axis. */
export const resample = (arr: number[], n: number): number[] => {
  const m = arr.length;
  if (m === 0) return new Array(n).fill(NaN);
  if (m === n) return arr.slice();
  const out: number[] = new Array(n);
  for (let j = 0; j < n; j += 1) {
    const t = n <= 1 ? 0 : (j / (n - 1)) * (m - 1);
    const lo = Math.floor(t);
    const hi = Math.min(m - 1, lo + 1);
    out[j] = arr[lo] + (arr[hi] - arr[lo]) * (t - lo);
  }
  return out;
};

const intradayLabel = (value: string): string =>
  /T\d\d:/.test(value) ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : shortDate(value);

interface Prepared {
  symbols: { symbol: string; name?: string; color: string; last?: number; currency?: string; changePct: number | null }[];
  values: number[][]; // [seriesIndex][sampleIndex] — transformed (% or price)
  labels: string[]; // date labels per sample
  n: number;
  yMin: number;
  yMax: number;
}

const prepare = (
  series: StockComparisonSeries[],
  range: StockRange,
  mode: 'percent' | 'price',
  colors: string[],
  visible: boolean[]
): Prepared => {
  const raw = series.map((s) => pointsForRange(s, range));
  const n = Math.min(120, Math.max(2, ...raw.map((p) => p.length)));
  // Reference series for x labels = the one with the most points in this range.
  let refIdx = 0;
  raw.forEach((p, i) => {
    if (p.length > raw[refIdx].length) refIdx = i;
  });
  const refPts = raw[refIdx] ?? [];
  const labels = Array.from({ length: n }, (_, j) => {
    const src = refPts.length ? refPts[Math.round((j / Math.max(1, n - 1)) * (refPts.length - 1))] : undefined;
    return src ? intradayLabel(src.date) : '';
  });

  const values: number[][] = raw.map((pts) => {
    if (pts.length < 2) return new Array(n).fill(NaN);
    const closes = pts.map((p) => p.close);
    const sampled = resample(closes, n);
    if (mode === 'percent') {
      const base = sampled.find((v) => Number.isFinite(v) && v !== 0) ?? sampled[0];
      return sampled.map((v) => (Number.isFinite(v) && base ? (v / base - 1) * 100 : NaN));
    }
    return sampled;
  });

  let yMin = Infinity;
  let yMax = -Infinity;
  values.forEach((vals, i) => {
    if (!visible[i]) return;
    vals.forEach((v) => {
      if (!Number.isFinite(v)) return;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    });
  });
  if (mode === 'percent') {
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin === yMax) {
    yMin = Number.isFinite(yMin) ? yMin - 1 : -1;
    yMax = Number.isFinite(yMax) ? yMax + 1 : 1;
  }
  const pad = (yMax - yMin) * 0.08;

  const symbols = series.map((s, i) => {
    const vals = values[i];
    const finite = vals.filter((v) => Number.isFinite(v));
    const changePct =
      mode === 'percent'
        ? finite.length
          ? finite[finite.length - 1]
          : null
        : finite.length >= 2 && finite[0]
          ? (finite[finite.length - 1] / finite[0] - 1) * 100
          : null;
    return {
      symbol: s.symbol,
      name: s.name,
      color: s.color ?? colors[i % colors.length],
      last: s.last,
      currency: s.currency,
      changePct
    };
  });

  return { symbols, values, labels, n, yMin: yMin - pad, yMax: yMax + pad };
};

/** Width of the chart wrapper, tracked so the SVG renders at real pixel size and the
 *  hover crosshair maps pointer-x → sample index accurately. */
const useMeasuredWidth = (fallback: number): [React.RefObject<HTMLDivElement>, number] => {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(el.clientWidth || fallback);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, w];
};

const buildPath = (vals: number[], n: number, w: number, h: number, padX: number, padTop: number, padBottom: number, yMin: number, yMax: number): string => {
  const innerW = Math.max(1, w - padX * 2);
  const innerH = Math.max(1, h - padTop - padBottom);
  const span = yMax - yMin || 1;
  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => padTop + innerH - ((v - yMin) / span) * innerH;
  let d = '';
  let started = false;
  for (let i = 0; i < vals.length; i += 1) {
    const v = vals[i];
    if (!Number.isFinite(v)) {
      started = false;
      continue;
    }
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    started = true;
  }
  return d.trim();
};

const ModeToggle: React.FC<{ mode: 'percent' | 'price'; onChange: (m: 'percent' | 'price') => void }> = ({ mode, onChange }) => (
  <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5">
    {([['percent', Percent], ['price', DollarSign]] as const).map(([id, Icon]) => (
      <button
        key={id}
        onClick={() => onChange(id)}
        aria-pressed={mode === id}
        title={id === 'percent' ? '% change (rebased to window start)' : 'Absolute price'}
        className={`rounded-md p-1 transition-all duration-200 ${
          mode === id
            ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
            : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    ))}
  </div>
);

export const ComparisonChart: React.FC<{ data: StockComparisonArtifact }> = ({ data }) => {
  const compact = useCompact();
  const series = useMemo(() => (data.series ?? []).slice(0, 6).filter((s) => s && s.symbol), [data.series]);
  const palette = resolveTheme({ palette: data.palette as PaletteName }).series;

  const available = useMemo(() => {
    const fromData = (data.ranges ?? []).filter((r) => RANGE_ORDER.includes(r));
    const shared = sharedRanges(series);
    const list = fromData.length ? fromData.filter((r) => shared.includes(r)) : shared;
    return list.length ? list : shared;
  }, [data.ranges, series]);

  const defaultRange: StockRange =
    (data.defaultRange && available.includes(data.defaultRange) && data.defaultRange) ||
    (available.includes('1Y') ? '1Y' : available.includes('1M') ? '1M' : available[available.length - 1]) ||
    'MAX';
  const [range, setRange] = useState<StockRange>(defaultRange);
  const activeRange = available.includes(range) ? range : defaultRange;
  const [mode, setMode] = useState<'percent' | 'price'>(data.mode === 'price' ? 'price' : 'percent');
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const visible = series.map((_, i) => !hidden.has(i));
  const toggle = (i: number) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else if (next.size < series.length - 1) next.add(i); // keep ≥1 visible
      return next;
    });

  const prepared = useMemo(() => prepare(series, activeRange, mode, palette, visible), [series, activeRange, mode, palette, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const detailedH = 196;
  const compactH = 60;
  const padX = 8;
  const padTop = 8;
  const padBottom = compact ? 8 : 18;
  const [wrapRef, width] = useMeasuredWidth(560);
  const h = compact ? compactH : detailedH;

  const [hover, setHover] = useState<number | null>(null);
  const pathRefs = useRef<(SVGPathElement | null)[]>([]);

  // Line draw-in on mount / range / mode / visibility change (never on hover).
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let drawn = 0;
    pathRefs.current.forEach((p) => {
      if (!p) return;
      const len = p.getTotalLength?.();
      if (!len || !Number.isFinite(len)) return;
      p.animate(
        [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: 620, delay: Math.min(drawn, 5) * 70, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'backwards' }
      );
      drawn += 1;
    });
  }, [activeRange, mode, hidden, width, compact]); // eslint-disable-line react-hooks/exhaustive-deps

  const innerW = Math.max(1, width - padX * 2);
  const innerH = Math.max(1, h - padTop - padBottom);
  const span = prepared.yMax - prepared.yMin || 1;
  const xAt = (i: number) => padX + (prepared.n <= 1 ? 0 : (i / (prepared.n - 1)) * innerW);
  const yAt = (v: number) => padTop + innerH - ((v - prepared.yMin) / span) * innerH;
  const zeroY = mode === 'percent' ? yAt(0) : null;

  const fmtVal = (v: number, currency?: string) => (mode === 'percent' ? formatPercent(v) : formatPrice(v, currency ?? 'USD'));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((rel - padX) / innerW) * (prepared.n - 1));
    setHover(Math.max(0, Math.min(prepared.n - 1, i)));
  };

  const empty = prepared.n < 2 || prepared.symbols.every((_, i) => !visible[i]);

  // ── Legend (shared by both densities) ──
  const legend = (
    <div className="flex flex-wrap items-center gap-1.5">
      {prepared.symbols.map((s, i) => {
        const on = visible[i];
        const pos = (s.changePct ?? 0) >= 0;
        return (
          <button
            key={s.symbol + i}
            onClick={() => toggle(i)}
            aria-pressed={on}
            title={on ? `Hide ${s.symbol}` : `Show ${s.symbol}`}
            className={`group/leg inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-all duration-200 ${
              on ? 'border-[var(--ds-hairline)] bg-[var(--ds-well)]' : 'border-[var(--ds-hairline-soft)] bg-transparent opacity-50'
            }`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: on ? s.color : 'var(--ds-faint)' }} />
            <span className="text-[var(--ds-ink)]">{s.symbol}</span>
            {s.changePct != null && (
              <span className="tabular-nums" style={{ color: on ? (pos ? '#059669' : '#dc2626') : 'var(--ds-muted)' }}>
                {formatPercent(s.changePct)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  const chart = (
    <div ref={wrapRef} className="relative w-full" style={{ height: h }} onPointerLeave={() => setHover(null)}>
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${Math.max(width, 1)} ${h}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        className="block touch-pan-y"
      >
        {/* Zero baseline for % mode */}
        {zeroY != null && (
          <line x1={padX} x2={width - padX} y1={zeroY} y2={zeroY} stroke="var(--ds-hairline)" strokeWidth={1} strokeDasharray="3 3" />
        )}
        {/* Hover crosshair */}
        {hover != null && !empty && (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={padTop} y2={h - padBottom} stroke="var(--ds-hairline)" strokeWidth={1} />
        )}
        {/* Series lines */}
        {prepared.values.map((vals, i) => {
          if (!visible[i]) {
            pathRefs.current[i] = null;
            return null;
          }
          const d = buildPath(vals, prepared.n, width, h, padX, padTop, padBottom, prepared.yMin, prepared.yMax);
          if (!d) return null;
          return (
            <path
              key={prepared.symbols[i].symbol + i}
              ref={(el) => {
                pathRefs.current[i] = el;
              }}
              d={d}
              fill="none"
              stroke={prepared.symbols[i].color}
              strokeWidth={compact ? 1.5 : 2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ strokeDasharray: 'none' }}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {/* Hover dots */}
        {hover != null &&
          !empty &&
          prepared.values.map((vals, i) => {
            if (!visible[i]) return null;
            const v = vals[hover];
            if (!Number.isFinite(v)) return null;
            return (
              <circle key={`dot-${i}`} cx={xAt(hover)} cy={yAt(v)} r={3} fill={prepared.symbols[i].color} stroke="var(--ds-surface)" strokeWidth={1.5} />
            );
          })}
      </svg>

      {/* Hover readout */}
      {hover != null && !empty && !compact && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-1 text-[11px] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)] backdrop-blur-md"
          style={{ left: Math.min(Math.max(xAt(hover) - 56, 2), Math.max(2, width - 116)) }}
        >
          <div className="mb-0.5 text-[10px] font-medium text-[var(--ds-muted)]">{prepared.labels[hover]}</div>
          {prepared.symbols.map((s, i) => {
            if (!visible[i]) return null;
            const v = prepared.values[i][hover];
            if (!Number.isFinite(v)) return null;
            const pos = v >= 0;
            return (
              <div key={`r-${i}`} className="flex items-center justify-between gap-3 leading-tight">
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="text-[var(--ds-ink)]">{s.symbol}</span>
                </span>
                <span className="tabular-nums font-semibold" style={{ color: mode === 'percent' ? (pos ? '#059669' : '#dc2626') : 'var(--ds-ink)' }}>
                  {fmtVal(v, s.currency)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Axis date labels (detailed) */}
      {!compact && !empty && prepared.labels.length > 1 && (
        <div className="pointer-events-none absolute inset-x-2 bottom-0 flex justify-between text-[9px] tabular-nums text-[var(--ds-muted)]">
          <span>{prepared.labels[0]}</span>
          <span>{prepared.labels[Math.floor((prepared.n - 1) / 2)]}</span>
          <span>{prepared.labels[prepared.n - 1]}</span>
        </div>
      )}

      {empty && (
        <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--ds-muted)]">No comparable history available.</div>
      )}
    </div>
  );

  const subtitle = data.subtitle || `${series.map((s) => s.symbol).join(' · ')}${mode === 'percent' ? '  ·  % change' : ''}`;

  // ── Compact: glance overlay + a tight legend of moves over the window. ──
  if (compact) {
    return (
      <Surface
        accent={palette[0]}
        header={
          <>
            <SurfaceTitle>{data.title || 'Comparison'}</SurfaceTitle>
            <SurfaceSubtitle>{subtitle}</SurfaceSubtitle>
          </>
        }
      >
        <div className="px-3 pb-2.5">{chart}</div>
        <div className="px-3 pb-3">{legend}</div>
      </Surface>
    );
  }

  return (
    <Surface
      accent={palette[0]}
      className="flex min-h-[calc(100%-1rem)] flex-col"
      header={
        <>
          <SurfaceTitle>{data.title || `Comparison · ${series.map((s) => s.symbol).join(' vs ')}`}</SurfaceTitle>
          <SurfaceSubtitle>
            {mode === 'percent' ? '% change rebased to window start' : 'Absolute price'}
            {data.asOf ? ` · ${shortDate(data.asOf)}` : ''}
          </SurfaceSubtitle>
        </>
      }
      right={<ModeToggle mode={mode} onChange={setMode} />}
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        {available.length > 1 ? (
          <RangeTabs<StockRange> options={available} value={activeRange} accent={palette[0]} onChange={setRange} />
        ) : (
          <span />
        )}
      </div>
      <div className="grow px-2">{chart}</div>
      <div className="px-3 pb-3 pt-1">{legend}</div>
    </Surface>
  );
};
