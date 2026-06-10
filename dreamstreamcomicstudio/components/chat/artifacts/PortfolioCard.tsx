import React from 'react';
import type { PortfolioArtifact, PortfolioPosition } from '../../../apiTypes';
import { Surface, SurfaceTitle, Sparkline, TrendPill, formatPrice, formatPercent, formatSigned, relativeTime, useCompact, useLiveData, BULL, BEAR, NEUTRAL, PALETTES } from './kit';

// Portfolio hero — live-priced holdings with a weight donut and a P&L header.
//  • compact — total value + day pill + the top three positions as one-line rows.
//  • detailed — the full picture: an SVG allocation donut (slices cycle the brand
//    series, center counts holdings) beside its legend, then a divided holdings
//    table (symbol/name · sparkline · value+weight · day %) sorted by value, and a
//    "Priced live" footer stamped from the live-data context.

const dayColor = (changePercent?: number): string =>
  typeof changePercent === 'number' && changePercent > 0 ? BULL : typeof changePercent === 'number' && changePercent < 0 ? BEAR : NEUTRAL;

const valueOf = (p: PortfolioPosition): number | undefined =>
  typeof p.value === 'number' ? p.value : typeof p.shares === 'number' ? p.shares * p.price : undefined;

/** Hand-rolled SVG donut: stroke-dasharray arc per slice, holdings count in the hub. */
const Donut: React.FC<{ slices: { color: string; frac: number }[]; count: number; size?: number }> = ({ slices, count, size = 110 }) => {
  const c = size / 2;
  const r = size / 2 - 11;
  const C = 2 * Math.PI * r;
  let start = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--ds-hairline-soft)" strokeWidth="14" />
      <g transform={`rotate(-90 ${c} ${c})`}>
        {slices.map((s, i) => {
          const offset = start;
          start += s.frac;
          return (
            <circle
              key={i}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, s.frac * C - 1)} ${C}`}
              strokeDashoffset={-offset * C}
            />
          );
        })}
      </g>
      <text x={c} y={c - 1} textAnchor="middle" fontSize={size * 0.2} fontWeight="600" fill="var(--ds-ink)" style={{ letterSpacing: '-0.02em' }}>
        {count}
      </text>
      <text x={c} y={c + size * 0.13} textAnchor="middle" fontSize={size * 0.075} fontWeight="600" fill="var(--ds-muted)">
        {count === 1 ? 'holding' : 'holdings'}
      </text>
    </svg>
  );
};

export const PortfolioCard: React.FC<{ data: PortfolioArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const currency = data.currency ?? 'USD';
  const positions = data.positions ?? [];
  if (!positions.length) return null;

  const totals = data.totals ?? {};
  const sorted = [...positions].sort((a, b) => (valueOf(b) ?? 0) - (valueOf(a) ?? 0));
  const summed = sorted.reduce((sum, p) => sum + (valueOf(p) ?? 0), 0);
  const totalValue = totals.value ?? (summed > 0 ? summed : undefined);
  const weightOf = (p: PortfolioPosition): number | undefined => {
    if (typeof p.weightPct === 'number') return p.weightPct;
    const v = valueOf(p);
    return typeof v === 'number' && typeof totalValue === 'number' && totalValue > 0 ? (v / totalValue) * 100 : undefined;
  };

  const header = <SurfaceTitle>{data.title ?? 'Portfolio'}</SurfaceTitle>;
  const hasDay = typeof totals.dayPnl === 'number' || typeof totals.dayPnlPercent === 'number';
  const headerRight = (
    <div className="flex flex-col items-end gap-1">
      <span className="text-xl font-semibold leading-none tracking-tight tabular-nums text-[var(--ds-ink)]">
        {formatPrice(totalValue, currency)}
      </span>
      {hasDay && <TrendPill change={totals.dayPnl} changePercent={totals.dayPnlPercent} size="sm" />}
      {!compact && typeof totals.totalPnl === 'number' && (
        <span className="text-[10px] font-medium tabular-nums" style={{ color: totals.totalPnl > 0 ? BULL : totals.totalPnl < 0 ? BEAR : NEUTRAL }}>
          Total P&L {formatSigned(totals.totalPnl)}
          {typeof totals.totalPnlPercent === 'number' && ` (${formatPercent(totals.totalPnlPercent)})`}
        </span>
      )}
    </div>
  );

  // ── Compact: total + day pill + top three positions. ─────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {sorted.slice(0, 3).map((p, i) => (
            <div key={`${p.symbol}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">{p.symbol}</span>
              <span className="w-14 shrink-0 text-right text-[11px] font-semibold tabular-nums" style={{ color: dayColor(p.changePercent) }}>
                {formatPercent(p.changePercent)}
              </span>
              <span className="w-20 shrink-0 text-right text-xs tabular-nums text-[var(--ds-ink)]">{formatPrice(valueOf(p), currency)}</span>
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: donut + legend + holdings table. ───────────────────────────────
  const series = PALETTES.brand.series;
  const weighted = sorted
    .map((p) => ({ symbol: p.symbol, weight: weightOf(p) ?? 0 }))
    .filter((s) => s.weight > 0)
    .map((s, i) => ({ ...s, color: series[i % series.length] }));
  const weightSum = weighted.reduce((sum, s) => sum + s.weight, 0);
  const slices = weighted.map((s) => ({ color: s.color, frac: weightSum > 0 ? s.weight / weightSum : 0 }));
  const legend = weighted.slice(0, 6);
  const legendOverflow = weighted.length - legend.length;

  const asOf = relativeTime(live.asOf ?? data.asOf);
  const footer = asOf ? <div className="text-[10px] text-[var(--ds-muted)]">Priced live · updated {asOf}</div> : undefined;

  return (
    <Surface header={header} right={headerRight} footer={footer}>
      {slices.length > 0 && (
        <div className="flex flex-col items-center gap-3 px-3 pb-3 sm:flex-row">
          <Donut slices={slices} count={positions.length} />
          <div className="min-w-0 flex-1 space-y-1 self-stretch sm:self-center">
            {legend.map((s, i) => (
              <div key={`${s.symbol}-${i}`} className="flex items-center gap-2 text-[11px]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--ds-ink)]">{s.symbol}</span>
                <span className="shrink-0 tabular-nums text-[var(--ds-muted)]">{s.weight.toFixed(1)}%</span>
              </div>
            ))}
            {legendOverflow > 0 && <div className="text-[10px] text-[var(--ds-muted)]">+{legendOverflow} more</div>}
          </div>
        </div>
      )}

      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {sorted.map((p, i) => {
          const weight = weightOf(p);
          return (
            <li key={`${p.symbol}-${i}`} className="flex items-center gap-2 px-3 py-2 transition-colors duration-200 hover:bg-[var(--ds-well)]">
              <div className="min-w-0 flex-1">
                <span className="block text-xs font-semibold leading-tight text-[var(--ds-ink)]">{p.symbol}</span>
                {p.name && <span className="block truncate text-[10px] text-[var(--ds-muted)]">{p.name}</span>}
              </div>
              {p.spark && p.spark.length > 1 && (
                <div className="w-16 shrink-0">
                  <Sparkline values={p.spark} color={dayColor(p.changePercent)} width={64} height={24} fill={false} />
                </div>
              )}
              <div className="w-24 shrink-0 text-right">
                <div className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">{formatPrice(valueOf(p), currency)}</div>
                {typeof weight === 'number' && <div className="text-[10px] tabular-nums text-[var(--ds-muted)]">{weight.toFixed(1)}%</div>}
              </div>
              <span className="w-14 shrink-0 text-right text-[11px] font-semibold tabular-nums" style={{ color: dayColor(p.changePercent) }}>
                {formatPercent(p.changePercent)}
              </span>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
};
