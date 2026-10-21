import React, { useMemo, useState } from 'react';
import { useMeasure } from '../../chat/artifacts/kit/Chart';
import type { CostCategoryId, CostDailyRow } from '../../../shared/types/costCentre';
import { CATEGORY_COLOR, CATEGORY_SHORT_LABEL, STACK_ORDER } from './costPalette';
import { fmtDay, fmtUsd, fmtUsdAxis } from './costFormat';

// Stacked daily cost columns (inline SVG, no chart library), following the dataviz method:
// thin columns (≤ 24px) on one baseline, a 2px surface gap between stacked segments, a 4px
// rounded data-end on top, solid hairline gridlines, one selective direct label (the peak
// day), a legend for identity, and a per-column hover/focus tooltip that lists EVERY
// category for that day (values lead, labels follow). The whole column is the hit target.
// Keyboard: focus the chart, then ←/→ step through days.

const GAP = 2;
const AXIS_BAND = 22;
const PAD_TOP = 18;
const PAD_LEFT = 44;
const PAD_RIGHT = 6;
const FALLBACK_WIDTH = 640; // pre-measure / jsdom width; replaced by the real width on layout

const total = (row: CostDailyRow) => STACK_ORDER.reduce((sum, id) => sum + (row[id] || 0), 0);

const niceMax = (max: number): { top: number; step: number } => {
  if (!(max > 0)) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step - 1e-9) * step, step };
};

/** Column path with a rounded top (data end) and a square base. */
const roundedTopPath = (x: number, y: number, w: number, h: number, r: number): string => {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
};

interface StackedDailyChartProps {
  daily: CostDailyRow[];
  /** Plot height in px (the x-axis band is added on top of this). */
  height?: number;
}

export const StackedDailyChart: React.FC<StackedDailyChartProps> = ({ daily, height = 200 }) => {
  const [attach, size, wrapEl] = useMeasure<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const W = size.width || FALLBACK_WIDTH;
  const H = height + AXIS_BAND;
  const innerW = Math.max(1, W - PAD_LEFT - PAD_RIGHT);
  const innerH = Math.max(1, height - PAD_TOP);
  const n = daily.length;
  const slot = n > 0 ? innerW / n : innerW;
  const bw = Math.max(2, Math.min(24, slot - GAP, slot * 0.7));

  const totals = useMemo(() => daily.map(total), [daily]);
  const maxTotal = Math.max(0, ...totals);
  const { top: yMax, step } = niceMax(maxTotal);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let v = 0; v <= yMax + step * 1e-6; v += step) out.push(Number(v.toPrecision(10)));
    return out;
  }, [yMax, step]);
  const peakIndex = maxTotal > 0 ? totals.indexOf(maxTotal) : -1;
  const periodTotal = totals.reduce((s, v) => s + v, 0);

  const yAt = (v: number) => PAD_TOP + innerH * (1 - v / yMax);
  const xAt = (i: number) => PAD_LEFT + slot * i + (slot - bw) / 2;

  const xTicks = useMemo(() => {
    if (n === 0) return [] as number[];
    const count = Math.max(2, Math.min(7, Math.floor(innerW / 90)));
    const idx = new Set<number>();
    for (let k = 0; k < count; k++) idx.add(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
    return [...idx].sort((a, b) => a - b);
  }, [n, innerW]);

  const onMove = (e: React.PointerEvent) => {
    const rect = wrapEl.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const i = Math.floor((e.clientX - rect.left - PAD_LEFT) / slot);
    setHover(i >= 0 && i < n ? i : null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (n === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setHover((cur) => {
        const base = cur ?? n - 1;
        return Math.max(0, Math.min(n - 1, base + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  };

  const summary =
    n === 0
      ? 'Daily cost by category: no days in range.'
      : `Daily cost by category over ${n} days, ${fmtUsd(periodTotal)} in total` +
        (peakIndex >= 0 ? `, peak ${fmtUsd(maxTotal)} on ${fmtDay(daily[peakIndex].day)}.` : '.');

  const hovered = hover !== null ? daily[hover] : null;
  const tooltipLeft = hover !== null ? Math.min(W - 92, Math.max(92, xAt(hover) + bw / 2)) : 0;

  return (
    <div className="space-y-2">
      {/* Legend — always present (identity is never color-alone); rect swatches mirror the bars. */}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ds-muted)]" aria-label="Cost categories">
        {[...STACK_ORDER].reverse().map((id) => (
          <li key={id} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: CATEGORY_COLOR[id] }} aria-hidden />
            {CATEGORY_SHORT_LABEL[id]}
          </li>
        ))}
      </ul>

      <div
        ref={attach}
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="relative w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
        style={{ height: H }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onFocus={() => setHover((cur) => cur ?? (n > 0 ? n - 1 : null))}
        onBlur={() => setHover(null)}
      >
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 block" aria-hidden>
          {/* Recessive solid hairline grid + tabular y labels in the left gutter */}
          {ticks.map((v) => {
            const y = Math.round(yAt(v)) + 0.5;
            return (
              <g key={v}>
                <line
                  x1={PAD_LEFT}
                  x2={W - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  stroke={v === 0 ? 'var(--ds-hairline)' : 'var(--ds-hairline-soft)'}
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text x={PAD_LEFT - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--ds-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtUsdAxis(v)}
                </text>
              </g>
            );
          })}

          {/* Hover wash behind the hovered column */}
          {hover !== null && (
            <rect x={PAD_LEFT + slot * hover} y={PAD_TOP - 6} width={slot} height={innerH + 6} fill="var(--ds-hover)" rx="4" />
          )}

          {/* Stacked columns */}
          {daily.map((row, i) => {
            const x = xAt(i);
            const segments = STACK_ORDER.filter((id) => (row[id] || 0) > 0);
            let cumulative = 0;
            const topId = segments[segments.length - 1];
            return (
              <g key={row.day} opacity={hover === null || hover === i ? 1 : 0.55} style={{ transition: 'opacity 150ms ease' }}>
                {segments.map((id: CostCategoryId, k) => {
                  const value = row[id] || 0;
                  const yTop = yAt(cumulative + value);
                  const yBottom = yAt(cumulative);
                  cumulative += value;
                  const full = yBottom - yTop;
                  // 2px surface gap between touching segments (skipped when a sliver would vanish).
                  const gap = k > 0 && full > GAP + 1 ? GAP : 0;
                  const h = Math.max(1, full - gap);
                  if (id === topId) {
                    return <path key={id} d={roundedTopPath(x, yTop, bw, h, 4)} fill={CATEGORY_COLOR[id]} />;
                  }
                  return <rect key={id} x={x} y={yTop} width={bw} height={h} fill={CATEGORY_COLOR[id]} />;
                })}
              </g>
            );
          })}

          {/* One selective direct label: the peak day */}
          {peakIndex >= 0 && hover === null && (
            <text
              x={Math.min(W - PAD_RIGHT, Math.max(PAD_LEFT, xAt(peakIndex) + bw / 2))}
              y={yAt(maxTotal) - 5}
              textAnchor={peakIndex > n * 0.85 ? 'end' : peakIndex < n * 0.15 ? 'start' : 'middle'}
              fontSize="10"
              fontWeight="600"
              fill="var(--ds-ink)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtUsd(maxTotal)}
            </text>
          )}

          {/* X labels */}
          {xTicks.map((i, k) => (
            <text
              key={`${i}-${k}`}
              x={xAt(i) + bw / 2}
              y={H - 6}
              textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}
              fontSize="10"
              fill="var(--ds-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtDay(daily[i].day)}
            </text>
          ))}
        </svg>

        {/* Frosted tooltip: every category for the hovered day, values first */}
        {hovered && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-44 -translate-x-1/2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2.5 py-2 text-[11px] shadow-[0_2px_10px_rgba(0,0,0,0.10)] backdrop-blur-md"
            style={{ left: tooltipLeft }}
            role="status"
          >
            <div className="mb-1 font-medium text-[var(--ds-muted)]">{fmtDay(hovered.day)}</div>
            <ul className="space-y-0.5">
              {[...STACK_ORDER].reverse().map((id) => (
                <li key={id} className="flex items-center gap-2">
                  <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: CATEGORY_COLOR[id] }} aria-hidden />
                  <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{fmtUsd(hovered[id] || 0)}</span>
                  <span className="truncate text-[var(--ds-muted)]">{CATEGORY_SHORT_LABEL[id]}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center justify-between border-t border-[var(--ds-hairline-soft)] pt-1">
              <span className="text-[var(--ds-muted)]">Total</span>
              <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{fmtUsd(total(hovered))}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
