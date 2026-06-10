import React from 'react';
import type { MetricBoardArtifact, MetricTile } from '../../../apiTypes';
import { Surface, SurfaceTitle, Sparkline, RadialGauge, TrendPill, compactNumber, useCompact } from './kit';
import { ChartCard } from './ChartCard';

// A large KPI value: compact giant numbers (≥1M) so they don't overflow the tile,
// but keep thousands readable as grouped digits (e.g. 84,230).
const formatTileValue = (v: string | number): string => {
  if (typeof v !== 'number') return v;
  return Math.abs(v) >= 1_000_000 ? compactNumber(v) : v.toLocaleString();
};

// A board of KPI tiles — the "at a glance" data-viz surface. Each tile is a stat with
// an optional delta pill, sparkline, progress ring, or a fully embedded ChartCard.
// Two densities: compact shows the first three headline stats in one hairline-divided
// row; detailed renders the full tile grid (sparklines, rings, embedded charts).

const STATUS: Record<NonNullable<MetricTile['status']>, { bar: string; text: string }> = {
  good: { bar: '#059669', text: 'text-emerald-600' },
  warn: { bar: '#d97706', text: 'text-amber-600' },
  bad: { bar: '#dc2626', text: 'text-red-600' },
  neutral: { bar: '#64748b', text: 'text-[var(--ds-muted)]' }
};

const COLS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4'
};

const Tile: React.FC<{ tile: MetricTile }> = ({ tile }) => {
  const status = tile.status ? STATUS[tile.status] : null;
  // Trend can come from delta OR (when that's absent) deltaPercent.
  const trendVal = typeof tile.delta === 'number' ? tile.delta : tile.deltaPercent;
  const hasTrend = typeof tile.delta === 'number' || typeof tile.deltaPercent === 'number';
  const sparkColor = status?.bar ?? (typeof trendVal === 'number' ? (trendVal >= 0 ? '#059669' : '#dc2626') : '#3B82F6');

  if (tile.chart) {
    return (
      <div className="rounded-xl bg-[var(--ds-well)] p-1">
        <ChartCard data={tile.chart} />
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl bg-[var(--ds-well)] p-3">
      {status && <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: status.bar }} />}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{tile.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="text-2xl font-semibold tracking-tight tabular-nums leading-none text-[var(--ds-ink)]">{formatTileValue(tile.value)}</span>
            {tile.unit && <span className="text-xs font-medium text-[var(--ds-muted)]">{tile.unit}</span>}
          </div>
          {hasTrend && (
            <div className="mt-1">
              <TrendPill change={tile.delta} changePercent={tile.deltaPercent} size="sm" />
            </div>
          )}
        </div>
        {tile.progress && (
          <RadialGauge
            value={tile.progress.value}
            max={tile.progress.max}
            display={`${Math.round((tile.progress.value / (tile.progress.max || 1)) * 100)}%`}
            color={status?.bar ?? '#3B82F6'}
            size={56}
          />
        )}
      </div>
      {tile.spark && tile.spark.length > 1 && (
        <div className="mt-2">
          <Sparkline values={tile.spark} color={sparkColor} height={32} />
        </div>
      )}
    </div>
  );
};

export const MetricBoard: React.FC<{ data: MetricBoardArtifact }> = ({ data }) => {
  const compact = useCompact();
  if (!data.tiles?.length) return null;

  // ── Compact: one hairline-divided row of headline stats, no charts/controls. ──
  if (compact) {
    const statTiles = data.tiles.filter((t) => !t.chart);
    const glance = (statTiles.length ? statTiles : data.tiles).slice(0, 3);
    const more = data.tiles.length - glance.length;
    return (
      <Surface
        header={data.title ? <SurfaceTitle>{data.title}</SurfaceTitle> : undefined}
        footer={more > 0 ? <div className="text-[11px] text-[var(--ds-muted)]">+{more} more metrics</div> : undefined}
      >
        <div className={`flex divide-x divide-[var(--ds-hairline-soft)] px-1 pb-2.5 ${data.title ? '' : 'pt-2.5'}`}>
          {glance.map((tile, i) => (
            <div key={i} className="min-w-0 flex-1 px-2.5">
              <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{tile.label}</div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="truncate text-lg font-semibold tracking-tight tabular-nums leading-none text-[var(--ds-ink)]">
                  {formatTileValue(tile.value)}
                </span>
                {tile.unit && <span className="text-[11px] font-medium text-[var(--ds-muted)]">{tile.unit}</span>}
              </div>
              {(typeof tile.delta === 'number' || typeof tile.deltaPercent === 'number') && (
                <div className="mt-1">
                  <TrendPill change={tile.delta} changePercent={tile.deltaPercent} size="sm" />
                </div>
              )}
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  const cols = COLS[data.columns ?? Math.min(4, data.tiles.length)] ?? 'sm:grid-cols-3';
  return (
    <Surface header={data.title ? <SurfaceTitle>{data.title}</SurfaceTitle> : undefined}>
      <div className={`grid grid-cols-2 gap-2 p-3 ${data.title ? 'pt-1' : ''} ${cols}`}>
        {data.tiles.map((tile, i) => (
          <Tile key={i} tile={tile} />
        ))}
      </div>
    </Surface>
  );
};
