import React from 'react';
import type { HeatmapArtifact, HeatmapCell, HeatmapGroup } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// A market HEATMAP — a colored grid of tiles tinted green→red by their value (a
// change %, by default). Optional per-tile `weight` (e.g. market cap) sizes the
// tiles, giving a treemap-like "market map". Dependency-free; pure CSS grid.
//
// Two densities: compact distills the map into a top-gainers / top-losers strip;
// detailed renders the full weighted tile grid.

// Map a value (default scale ±4%) onto a green↔red tile background + readable text.
const tone = (value: number | undefined): { bg: string; fg: string } => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { bg: '#e9e7e2', fg: '#3c3a33' };
  const clamped = Math.max(-1, Math.min(1, value / 4));
  const intensity = Math.min(1, Math.abs(clamped));
  // Light (low) → saturated (high) green or red.
  const up = clamped >= 0;
  const base = up ? [5, 150, 105] : [220, 38, 38]; // emerald-600 / red-600
  const mix = 0.18 + intensity * 0.72;
  const [r, g, b] = base.map((c) => Math.round(255 + (c - 255) * mix));
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: intensity > 0.45 ? '#ffffff' : '#1a1915' };
};

const flatten = (data: HeatmapArtifact): HeatmapCell[] =>
  data.groups?.length ? data.groups.flatMap((g) => g.cells) : data.cells ?? [];

const Tile: React.FC<{ cell: HeatmapCell; unit: string; grow: number }> = ({ cell, unit, grow }) => {
  const { bg, fg } = tone(cell.value);
  const body = (
    <div
      className="flex min-h-[3.5rem] flex-col justify-between rounded-lg border border-black/5 p-2 transition-opacity duration-200 hover:opacity-90"
      style={{ backgroundColor: bg, color: fg, flexGrow: grow, flexBasis: `${70 + grow * 18}px` }}
    >
      <div className="truncate text-[11px] font-semibold leading-none">{cell.label}</div>
      <div className="mt-1 leading-none">
        {typeof cell.value === 'number' && Number.isFinite(cell.value) && (
          <div className="text-sm font-semibold tabular-nums leading-none">{`${cell.value >= 0 ? '+' : ''}${cell.value.toFixed(2)}${unit}`}</div>
        )}
        {cell.sub && <div className="mt-0.5 text-[10px] font-medium opacity-80">{cell.sub}</div>}
      </div>
    </div>
  );
  return cell.href ? <a href={cell.href} target="_blank" rel="noopener noreferrer" className="contents">{body}</a> : body;
};

const Group: React.FC<{ group: HeatmapGroup; unit: string; growOf: (w?: number) => number }> = ({ group, unit, growOf }) => (
  <div>
    {group.name && <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{group.name}</div>}
    <div className="flex flex-wrap gap-1.5">
      {group.cells.map((cell, i) => <Tile key={i} cell={cell} unit={unit} grow={growOf(cell.weight)} />)}
    </div>
  </div>
);

// One row of the compact movers strip: label left, tinted signed value right.
const MoverRow: React.FC<{ cell: HeatmapCell; unit: string }> = ({ cell, unit }) => {
  const v = cell.value;
  const color = typeof v === 'number' ? (v > 0 ? '#059669' : v < 0 ? '#dc2626' : '#6e6a60') : '#6e6a60';
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="min-w-0 truncate font-medium text-[#1a1915]">{cell.label}</span>
      <span className="shrink-0 font-semibold tabular-nums" style={{ color }}>
        {typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}${unit}` : '—'}
      </span>
    </div>
  );
};

export const HeatmapCard: React.FC<{ data: HeatmapArtifact }> = ({ data }) => {
  const compact = useCompact();
  const unit = data.unit ?? '%';
  const groups: HeatmapGroup[] = data.groups?.length
    ? data.groups
    : data.cells?.length
      ? [{ cells: data.cells }]
      : [];
  if (!groups.length) return null;

  const header = (data.title || data.subtitle) ? (
    <>
      {data.title && <SurfaceTitle>{data.title}</SurfaceTitle>}
      {data.subtitle && <SurfaceSubtitle>{data.subtitle}</SurfaceSubtitle>}
    </>
  ) : undefined;

  // ── Compact: a top-gainers / top-losers strip instead of the full map. ──
  if (compact) {
    const valued = flatten(data)
      .filter((c) => typeof c.value === 'number' && Number.isFinite(c.value))
      .sort((a, b) => (b.value as number) - (a.value as number));
    const gainers = valued.slice(0, 3);
    // Bottom movers, never overlapping the top slice (small maps render one column).
    const losers = valued.slice(Math.max(gainers.length, valued.length - 3)).reverse();
    return (
      <Surface accent="#0ea5e9" header={header}>
        {valued.length ? (
          <div className={`grid ${losers.length ? 'grid-cols-2' : 'grid-cols-1'} divide-x divide-black/5 pb-2.5 ${header ? '' : 'pt-2.5'}`}>
            <div className="min-w-0 space-y-1 px-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Top</div>
              {gainers.map((c, i) => <MoverRow key={i} cell={c} unit={unit} />)}
            </div>
            {losers.length > 0 && (
              <div className="min-w-0 space-y-1 px-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Bottom</div>
                {losers.map((c, i) => <MoverRow key={i} cell={c} unit={unit} />)}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
            {flatten(data).slice(0, 6).map((c, i) => (
              <span key={i} className="rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-[#3c3a33]">{c.label}</span>
            ))}
          </div>
        )}
      </Surface>
    );
  }

  // Tile size ∝ weight, but NORMALIZED across all tiles. Raw weights like market caps
  // (1e12…) would otherwise every clamp to the max and render uniform tiles; map the
  // observed [min,max] onto a 1–6 grow range so sizes are actually proportional. Small
  // pre-scaled weights (already 1–6) pass through unchanged.
  const weights = groups
    .flatMap((g) => g.cells)
    .map((c) => (typeof c.weight === 'number' && c.weight > 0 ? c.weight : null))
    .filter((w): w is number => w !== null);
  const maxW = weights.length ? Math.max(...weights) : 0;
  const minW = weights.length ? Math.min(...weights) : 0;
  const growOf = (w?: number): number => {
    if (typeof w !== 'number' || w <= 0) return 1;
    if (maxW <= 6 && minW >= 1) return Math.max(1, Math.min(6, w)); // already small ints
    if (maxW === minW) return 3;
    return 1 + (5 * (w - minW)) / (maxW - minW);
  };

  return (
    <Surface
      accent="#0ea5e9"
      header={header}
      footer={data.caption ? <div className="text-[10px] text-[#6e6a60]">{data.caption}</div> : undefined}
    >
      <div className="space-y-3 p-3 pt-1">
        {groups.map((g, i) => <Group key={i} group={g} unit={unit} growOf={growOf} />)}
      </div>
    </Surface>
  );
};
