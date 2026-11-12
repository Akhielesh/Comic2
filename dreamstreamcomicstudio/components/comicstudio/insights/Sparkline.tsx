// Inline-SVG trend marks for Insights (models.md §4.4 T1, §4.7): a Sparkline (Easy) and StackedBars (Pro).
// No chart library and no literal hue: colours come from --ds-* tokens (currentColor + fill classes), so both
// themes and the Atlas skin restyle them; hue is never the only signal (a legend with words, an accessible list
// of every value). Static drawing: nothing animates, so reduced motion is respected by construction.

import React from 'react';
import { hueClass } from '../../chat/studioDesign';
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

/**
 * Series colours (CL-0 #9): series i takes the colour layer's hue i in its fixed order (hueClass, 0-based; a legend
 * always names them, and hues are never status). Past the fifth, every series folds into one neutral chart step, the
 * "Other" step. Before, series 2 read the info token, which is grey outside the skin since CL-0, beside a muted fifth.
 */
const OTHER_FILL = 'fill-[var(--ds-chart-3)]';
const OTHER_SWATCH = 'bg-[var(--ds-chart-3)]';
export const seriesFill = (i: number): string => hueClass('fill', i) ?? OTHER_FILL;
export const seriesSwatch = (i: number): string => hueClass('dot', i) ?? OTHER_SWATCH;

/**
 * Which colours a chart's series read. 'hue' (the default): the colour layer's categorical hues. 'ink': the five
 * monochrome chart steps, ink first, for a chart of spend or price. Light hue 1 is the spark itself, and colour must
 * never nudge spending (docs/design/design-system.md § Colour layer: spend / price charts are ink steps, never the
 * spark family).
 */
export type SeriesPalette = 'hue' | 'ink';
const INK_FILL = ['fill-[var(--ds-chart-1)]', 'fill-[var(--ds-chart-2)]', 'fill-[var(--ds-chart-3)]', 'fill-[var(--ds-chart-4)]', 'fill-[var(--ds-chart-5)]'] as const;
const INK_SWATCH = ['bg-[var(--ds-chart-1)]', 'bg-[var(--ds-chart-2)]', 'bg-[var(--ds-chart-3)]', 'bg-[var(--ds-chart-4)]', 'bg-[var(--ds-chart-5)]'] as const;
/** Past the fifth ink step, "Other" is an outline in the middle step, so it never reads as one of the five fills. */
const INK_OTHER_FILL = 'fill-none stroke-[var(--ds-chart-3)]';
const INK_OTHER_SWATCH = 'border border-[var(--ds-chart-3)]';
const inkStep = (i: number): 0 | 1 | 2 | 3 | 4 | null => (Number.isInteger(i) && i >= 0 && i < INK_FILL.length ? (i as 0 | 1 | 2 | 3 | 4) : null);
export const inkSeriesFill = (i: number): string => {
  const at = inkStep(i);
  return at === null ? INK_OTHER_FILL : INK_FILL[at];
};
export const inkSeriesSwatch = (i: number): string => {
  const at = inkStep(i);
  return at === null ? INK_OTHER_SWATCH : INK_SWATCH[at];
};

export interface StackedBarsProps {
  bars: readonly StackedBar[];
  /** Series in stacking order (bottom first), with their words. */
  series: readonly { id: string; label: string }[];
  label: string;
  /** A bar's total in words ("$0.21" / "≈2% of your usage"). */
  format(total: number): string;
  /** 'ink' for spend and price charts (never the spark family); 'hue' by default. */
  palette?: SeriesPalette;
  height?: number;
  className?: string;
}

/** Stacked bars over time with a legend; every bar is also listed for screen readers. */
export const StackedBars: React.FC<StackedBarsProps> = ({ bars, series, label, format, palette = 'hue', height = 64, className }) => {
  const max = Math.max(0, ...bars.map((b) => b.total)) || 1;
  const step = VIEW_W / Math.max(1, bars.length);
  const barW = step * 0.7;
  const used = series.filter((s) => bars.some((b) => b.segments.some((g) => g.id === s.id && g.value > 0)));
  const indexOf = (id: string) => Math.max(0, series.findIndex((s) => s.id === id));
  const ink = palette === 'ink';
  const fillOf = (id: string) => (ink ? inkSeriesFill : seriesFill)(indexOf(id));
  const swatchOf = (id: string) => (ink ? inkSeriesSwatch : seriesSwatch)(indexOf(id));
  /** The ink "Other" outline keeps one device pixel however the bar is stretched. */
  const outlineOf = (id: string) => (ink && inkStep(indexOf(id)) === null ? { vectorEffect: 'non-scaling-stroke' as const, strokeWidth: 1 } : {});
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
                return <rect key={s.id} x={i * step + (step - barW) / 2} y={top} width={barW} height={h} className={fillOf(s.id)} {...outlineOf(s.id)} />;
              })}
            </g>
          );
        })}
      </svg>
      {used.length > 0 && (
        <ul className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--ds-muted)]" aria-label="Legend">
          {used.map((s) => (
            <li key={s.id} className="inline-flex min-w-0 items-center gap-1">
              <span className={cx('h-2 w-2 shrink-0 rounded-[var(--ds-radius-sm)]', swatchOf(s.id))} aria-hidden />
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
