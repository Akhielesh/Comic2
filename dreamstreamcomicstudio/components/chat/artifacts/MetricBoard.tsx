import React from 'react';
import type { MetricBoardArtifact, MetricTile } from '../../../apiTypes';
import { Surface, Sparkline, RadialGauge, TrendPill } from './kit';
import { ChartCard } from './ChartCard';

// A board of KPI tiles — the "at a glance" data-viz surface. Each tile is a stat with
// an optional delta pill, sparkline, progress ring, or a fully embedded ChartCard.
// Composes the kit so it stays on-style and dependency-free.

const STATUS: Record<NonNullable<MetricTile['status']>, { bar: string; text: string }> = {
  good: { bar: '#059669', text: 'text-emerald-600' },
  warn: { bar: '#d97706', text: 'text-amber-600' },
  bad: { bar: '#dc2626', text: 'text-red-600' },
  neutral: { bar: '#64748b', text: 'text-slate-500' }
};

const COLS: Record<number, string> = {
  1: 'sm:grid-cols-1',
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4'
};

const Tile: React.FC<{ tile: MetricTile }> = ({ tile }) => {
  const status = tile.status ? STATUS[tile.status] : null;
  const sparkColor = status?.bar ?? (typeof tile.delta === 'number' ? (tile.delta >= 0 ? '#059669' : '#dc2626') : '#3B82F6');

  if (tile.chart) {
    return (
      <div className="rounded-lg border-2 border-black/10 bg-white p-1">
        <ChartCard data={tile.chart} />
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border-2 border-black/10 bg-white p-3">
      {status && <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: status.bar }} />}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-500">{tile.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="font-display text-2xl leading-none">{typeof tile.value === 'number' ? tile.value.toLocaleString() : tile.value}</span>
            {tile.unit && <span className="text-xs font-bold text-slate-400">{tile.unit}</span>}
          </div>
          {typeof tile.delta === 'number' && (
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

export const MetricBoard: React.FC<{ data: MetricBoardArtifact; embedded?: boolean }> = ({ data, embedded }) => {
  if (!data.tiles?.length) return null;
  const cols = COLS[data.columns ?? Math.min(4, data.tiles.length)] ?? 'sm:grid-cols-3';
  return (
    <Surface embedded={embedded} header={data.title ? <div className="text-sm font-extrabold">{data.title}</div> : undefined}>
      <div className={`grid grid-cols-2 gap-2 p-3 ${cols}`}>
        {data.tiles.map((tile, i) => (
          <Tile key={i} tile={tile} />
        ))}
      </div>
    </Surface>
  );
};
