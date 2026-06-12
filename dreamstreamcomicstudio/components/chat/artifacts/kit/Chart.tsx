import React, { useId, useMemo, useRef, useState } from 'react';
import { withAlpha } from './theme';

// Interactive, dependency-free SVG chart with a crosshair + hover tooltip — the
// piece the basic cards were missing. Supports line / area / candlestick over the
// same data, so a single component powers the finance chart-type toggle (and is
// reusable by the future data-viz card).

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
  height?: number;
  /** Optional horizontal reference line (e.g. previous close). */
  baseline?: number;
  formatValue?: (n: number) => string;
}

const W = 600;
const PAD = 4;

export const Chart: React.FC<ChartProps> = ({
  points,
  candles,
  variant = 'area',
  color,
  up = '#059669',
  down = '#dc2626',
  height = 120,
  baseline,
  formatValue = (n) => n.toFixed(2)
}) => {
  const gradId = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const isCandle = variant === 'candlestick' && candles && candles.length > 1;
  const count = isCandle ? candles!.length : points.length;

  const geom = useMemo(() => {
    const lows = isCandle ? candles!.map((c) => c.low) : points.map((p) => p.value);
    const highs = isCandle ? candles!.map((c) => c.high) : points.map((p) => p.value);
    const all = [...lows, ...highs];
    if (typeof baseline === 'number') all.push(baseline);
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;
    const y = (v: number) => PAD + (height - PAD * 2) * (1 - (v - min) / span);
    return { min, max, span, y };
  }, [points, candles, isCandle, height, baseline]);

  const linePath = useMemo(() => {
    if (isCandle || points.length < 2) return null;
    const stepX = (W - PAD * 2) / (points.length - 1);
    const pts = points.map((p, i) => [PAD + i * stepX, geom.y(p.value)] as const);
    const line = pts.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yy.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    return { line, area };
  }, [points, geom, height, isCandle]);

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || count < 2) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (count - 1)));
  };

  // x position (in viewBox units) for a given index.
  const xAt = (i: number) =>
    isCandle ? PAD + ((W - PAD * 2) / count) * (i + 0.5) : PAD + ((W - PAD * 2) / (count - 1)) * i;

  const hoveredLabel = hover != null ? (isCandle ? candles![hover].label : points[hover]?.label) : null;
  const hoveredValue = hover != null ? (isCandle ? candles![hover].close : points[hover]?.value) : null;
  const hoverFrac = hover != null && count > 1 ? hover / (count - 1) : 0;

  if (count < 2) return null;

  return (
    <div ref={ref} className="relative" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full block" style={{ height }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={withAlpha(color, 0.28)} />
            <stop offset="100%" stopColor={withAlpha(color, 0)} />
          </linearGradient>
        </defs>

        {typeof baseline === 'number' && (
          <line x1="0" x2={W} y1={geom.y(baseline)} y2={geom.y(baseline)} stroke="var(--ds-faint)" strokeWidth="1" strokeDasharray="4 4" />
        )}

        {/* Line / area */}
        {linePath && variant === 'area' && <path d={linePath.area} fill={`url(#${gradId})`} />}
        {linePath && (
          <path
            d={linePath.line}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            className="kit-draw-line"
          />
        )}

        {/* Candlesticks */}
        {isCandle &&
          candles!.map((c, i) => {
            const x = xAt(i);
            const slot = (W - PAD * 2) / count;
            const bw = Math.max(1.5, slot * 0.6);
            const rising = c.close >= c.open;
            const col = rising ? up : down;
            const yO = geom.y(c.open);
            const yC = geom.y(c.close);
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={geom.y(c.high)} y2={geom.y(c.low)} stroke={col} strokeWidth="1" />
                <rect
                  x={x - bw / 2}
                  y={Math.min(yO, yC)}
                  width={bw}
                  height={Math.max(1, Math.abs(yC - yO))}
                  fill={col}
                />
              </g>
            );
          })}

        {/* Crosshair */}
        {hover != null && (
          <>
            <line x1={xAt(hover)} x2={xAt(hover)} y1="0" y2={height} stroke="var(--ds-ink)" strokeWidth="1" strokeOpacity="0.25" />
            {!isCandle && hoveredValue != null && (
              <circle cx={xAt(hover)} cy={geom.y(hoveredValue)} r="3.5" fill={color} stroke="#fff" strokeWidth="1.5" />
            )}
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hover != null && hoveredValue != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2 py-1 text-center shadow-[0_2px_8px_rgba(0,0,0,0.12)] backdrop-blur-sm"
          style={{ left: `${Math.min(92, Math.max(8, hoverFrac * 100))}%` }}
        >
          <div className="text-[10px] font-medium text-[var(--ds-muted)]">{hoveredLabel}</div>
          <div className="text-xs font-semibold text-[var(--ds-ink)]">{formatValue(hoveredValue)}</div>
        </div>
      )}
    </div>
  );
};
