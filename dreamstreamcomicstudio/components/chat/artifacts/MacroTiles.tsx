import React from 'react';
import { CalendarClock } from 'lucide-react';
import type { MacroTilesArtifact, MacroTile } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Sparkline, TrendPill, Badge, relativeTime, useCompact, useLiveData, BULL, BEAR, NEUTRAL } from './kit';

// Macro indicator tiles — an Apple-Weather-style wall of key economic readings
// (CPI, unemployment, fed funds, …), calm-studio edition.
//  • detailed — a responsive 2-col (sm:3) grid of well tiles: uppercase label, big
//    tabular value + unit, delta pill, mini sparkline tinted by the delta sign, and
//    a "releases in Nd" countdown (red-tinted when ≤2d). Tiles with the soonest
//    upcoming release sort first; undated tiles keep their order at the back.
//  • compact — the top three tiles (soonest release first) as glance rows.
// Header right shows "Live · FRED" when server-filled, else a "model data" caption,
// plus an honest "Updated Xm ago" from the live-refresh context.

const DAY_MS = 86_400_000;

/** Whole days until an ISO date (ceil), or undefined when absent/unparseable. */
const daysUntil = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return undefined;
  return Math.ceil((t - Date.now()) / DAY_MS);
};

const tileValue = (tile: MacroTile): string => {
  if (typeof tile.value === 'number') {
    return Number.isFinite(tile.value) ? tile.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—';
  }
  return tile.value ?? '—';
};

/** Sparkline tint follows the delta sign; flat/unknown stays neutral. */
const sparkColor = (tile: MacroTile): string => {
  const basis = tile.delta ?? tile.deltaPercent ?? 0;
  return basis > 0 ? BULL : basis < 0 ? BEAR : NEUTRAL;
};

/** "releases in 6d" countdown line, red-tinted when the print is ≤2 days out. */
const ReleaseCountdown: React.FC<{ days: number }> = ({ days }) => {
  const urgent = days <= 2;
  return (
    <span
      className={`mt-1 flex items-center gap-1 text-[10px] font-medium ${urgent ? '' : 'text-[var(--ds-muted)]'}`}
      style={urgent ? { color: BEAR } : undefined}
    >
      <CalendarClock className="h-3 w-3 shrink-0" />
      {days <= 0 ? 'releases today' : `releases in ${days}d`}
    </span>
  );
};

const Tile: React.FC<{ tile: MacroTile; due?: number }> = ({ tile, due }) => {
  const hasDelta = typeof tile.delta === 'number' || typeof tile.deltaPercent === 'number';
  return (
    <div className="min-w-0 rounded-xl bg-[var(--ds-well)] p-2.5">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{tile.label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="truncate text-xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">{tileValue(tile)}</span>
        {tile.unit && <span className="shrink-0 text-[11px] font-medium text-[var(--ds-muted)]">{tile.unit}</span>}
      </div>
      {hasDelta && (
        <div className="mt-1">
          <TrendPill change={tile.delta} changePercent={tile.deltaPercent} size="sm" />
        </div>
      )}
      {tile.spark && tile.spark.length > 1 && (
        <div className="mt-1.5">
          <Sparkline values={tile.spark} color={sparkColor(tile)} height={28} />
        </div>
      )}
      {typeof due === 'number' && <ReleaseCountdown days={due} />}
    </div>
  );
};

export const MacroTiles: React.FC<{ data: MacroTilesArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const tiles = data.tiles ?? [];
  if (!tiles.length) return null;

  // Soonest upcoming release first; undated tiles keep their original order last.
  const sorted = tiles
    .map((tile, i) => ({ tile, i, due: daysUntil(tile.nextRelease) }))
    .sort((a, b) => (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER) || a.i - b.i);

  const updated = relativeTime(live.asOf ?? data.asOf);
  const header = <SurfaceTitle>{data.title ?? 'Macro snapshot'}</SurfaceTitle>;
  const headerRight = (
    <div className="flex flex-col items-end gap-0.5">
      {data.live ? <Badge color={BULL}>Live · FRED</Badge> : <SurfaceSubtitle>model data</SurfaceSubtitle>}
      {updated && <SurfaceSubtitle>Updated {updated}</SurfaceSubtitle>}
    </div>
  );

  // ── Compact: the top three tiles as glance rows (label · value · pill). ───────
  if (compact) {
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {sorted.slice(0, 3).map(({ tile, i }) => (
            <div key={`${tile.label}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">{tile.label}</span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--ds-ink)]">
                {tileValue(tile)}
                {tile.unit && <span className="ml-0.5 font-medium text-[var(--ds-muted)]">{tile.unit}</span>}
              </span>
              {(typeof tile.delta === 'number' || typeof tile.deltaPercent === 'number') && (
                <TrendPill change={tile.delta} changePercent={tile.deltaPercent} size="sm" />
              )}
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full tile wall. ────────────────────────────────────────────
  return (
    <Surface header={header} right={headerRight}>
      <div className="grid grid-cols-2 gap-2 px-3 pb-3 pt-1 sm:grid-cols-3">
        {sorted.map(({ tile, i, due }) => (
          <Tile key={`${tile.label}-${i}`} tile={tile} due={due} />
        ))}
      </div>
    </Surface>
  );
};
