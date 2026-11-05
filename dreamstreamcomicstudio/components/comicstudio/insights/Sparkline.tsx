// Inline-SVG trend marks for Insights (models.md §4.4 T1, §4.7): a Sparkline (Easy) and StackedBars (Pro).
// No chart library and no literal hue: colours come from --ds-* tokens (currentColor + fill classes), so both
// themes and the Atlas skin restyle them; hue is never the only signal (a legend with words, an accessible list
// of every value). Static drawing: nothing animates, so reduced motion is respected by construction.

import React from 'react';
import { cx } from '../conversation/ui';

const VIEW_W = 100;

export interface SparklineProps {
  values: readonly number[];
  /** What the line shows, for screen readers ("Spent on this comic over time"). */
  label: string;
  height?: number;
  className?: string;
}

/** A running line with a soft area under it; one value draws a dot. */
export const Sparkline: React.FC<SparklineProps> = ({ values, label, height = 40, className }) => {
  const vs = values.filter((v) => Number.isFinite(v));
  const max = vs.length ? Math.max(...vs) : 0;
  const min = vs.length ? Math.min(0, ...vs) : 0;
  const span = max - min || 1;
  const pad = 2;
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const x = (i: number) => (vs.length > 1 ? (i / (vs.length - 1)) * VIEW_W : VIEW_W / 2);
  const pts = vs.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cx('block w-full text-[var(--ds-accent)]', className)}
      style={{ height }}
      data-points={vs.length}
    >
      {vs.length > 1 && (
        <>
          <path d={`M0,${height} L${pts.join(' L')} L${VIEW_W},${height} Z`} className="fill-[var(--ds-accent-soft)]" />
          <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {vs.length === 1 && <circle cx={x(0)} cy={y(vs[0])} r={2} className="fill-current" />}
    </svg>
  );
};

export interface StackedBar {
  key: string;
  /** "Oct 22, 14:00" */
  label: string;
  segments: { id: string; value: number }[];
  total: number;
}

/** Fill per series id (tokens only). */
const FILLS = ['fill-[var(--ds-accent)]', 'fill-[var(--ds-info)]', 'fill-[var(--ds-success)]', 'fill-[var(--ds-warning)]', 'fill-[var(--ds-muted)]', 'fill-[var(--ds-hairline)]'];
const SWATCH = ['bg-[var(--ds-accent)]', 'bg-[var(--ds-info)]', 'bg-[var(--ds-success)]', 'bg-[var(--ds-warning)]', 'bg-[var(--ds-muted)]', 'bg-[var(--ds-hairline)]'];

export interface StackedBarsProps {
  bars: readonly StackedBar[];
  /** Series in stacking order (bottom first), with their words. */
  series: readonly { id: string; label: string }[];
  label: string;
  /** A bar's total in words ("$0.21" / "≈2% of your usage"). */
  format(total: number): string;
  height?: number;
  className?: string;
}

/** Stacked bars over time with a legend; every bar is also listed for screen readers. */
export const StackedBars: React.FC<StackedBarsProps> = ({ bars, series, label, format, height = 64, className }) => {
  const max = Math.max(0, ...bars.map((b) => b.total)) || 1;
  const step = VIEW_W / Math.max(1, bars.length);
  const barW = step * 0.7;
  const used = series.filter((s) => bars.some((b) => b.segments.some((g) => g.id === s.id && g.value > 0)));
  const fillOf = (id: string) => FILLS[Math.max(0, series.findIndex((s) => s.id === id)) % FILLS.length];
  return (
    <div className={cx('relative min-w-0', className)}>
      <svg viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} className="block w-full" style={{ height }}>
        {bars.map((b, i) => {
          let top = height;
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${format(b.total)}`}</title>
              {series.map((s) => {
                const v = b.segments.find((g) => g.id === s.id)?.value ?? 0;
                if (!(v > 0)) return null;
                const h = (v / max) * (height - 2);
                top -= h;
                return <rect key={s.id} x={i * step + (step - barW) / 2} y={top} width={barW} height={h} className={fillOf(s.id)} />;
              })}
            </g>
          );
        })}
      </svg>
      {used.length > 0 && (
        <ul className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--ds-muted)]" aria-label="Legend">
          {used.map((s) => (
            <li key={s.id} className="inline-flex min-w-0 items-center gap-1">
              <span className={cx('h-2 w-2 shrink-0 rounded-[var(--ds-radius-sm)]', SWATCH[Math.max(0, series.findIndex((x) => x.id === s.id)) % SWATCH.length])} aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">{s.label}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="sr-only" aria-label={`${label}, by period`}>
        {bars.map((b) => (
          <li key={b.key}>{`${b.label}: ${format(b.total)}`}</li>
        ))}
      </ul>
    </div>
  );
};

export default Sparkline;
