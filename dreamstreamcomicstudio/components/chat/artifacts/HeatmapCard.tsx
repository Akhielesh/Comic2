import React from 'react';
import type { HeatmapArtifact, HeatmapCell, HeatmapGroup } from '../../../apiTypes';
import { Surface } from './kit';

// A market HEATMAP — a colored grid of tiles tinted green→red by their value (a
// change %, by default). Optional per-tile `weight` (e.g. market cap) sizes the
// tiles, giving a treemap-like "market map". Dependency-free; pure CSS grid.

// Map a value (default scale ±4%) onto a green↔red tile background + readable text.
const tone = (value: number | undefined): { bg: string; fg: string } => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { bg: '#e2e8f0', fg: '#475569' };
  const clamped = Math.max(-1, Math.min(1, value / 4));
  const intensity = Math.min(1, Math.abs(clamped));
  // Light (low) → saturated (high) green or red.
  const up = clamped >= 0;
  const base = up ? [5, 150, 105] : [220, 38, 38]; // emerald-600 / red-600
  const mix = 0.18 + intensity * 0.72;
  const [r, g, b] = base.map((c) => Math.round(255 + (c - 255) * mix));
  return { bg: `rgb(${r}, ${g}, ${b})`, fg: intensity > 0.45 ? '#ffffff' : '#0f172a' };
};

const Tile: React.FC<{ cell: HeatmapCell; unit: string; grow: number }> = ({ cell, unit, grow }) => {
  const { bg, fg } = tone(cell.value);
  const body = (
    <div
      className="flex min-h-[3.5rem] flex-col justify-between rounded-md border border-black/10 p-2 transition-transform hover:-translate-y-0.5"
      style={{ backgroundColor: bg, color: fg, flexGrow: grow, flexBasis: `${70 + grow * 18}px` }}
    >
      <div className="truncate text-[11px] font-extrabold leading-none">{cell.label}</div>
      <div className="mt-1 leading-none">
        {typeof cell.value === 'number' && Number.isFinite(cell.value) && (
          <div className="text-sm font-display leading-none">{`${cell.value >= 0 ? '+' : ''}${cell.value.toFixed(2)}${unit}`}</div>
        )}
        {cell.sub && <div className="mt-0.5 text-[10px] font-semibold opacity-80">{cell.sub}</div>}
      </div>
    </div>
  );
  return cell.href ? <a href={cell.href} target="_blank" rel="noopener noreferrer" className="contents">{body}</a> : body;
};

const Group: React.FC<{ group: HeatmapGroup; unit: string; growOf: (w?: number) => number }> = ({ group, unit, growOf }) => (
  <div>
    {group.name && <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{group.name}</div>}
    <div className="flex flex-wrap gap-1.5">
      {group.cells.map((cell, i) => <Tile key={i} cell={cell} unit={unit} grow={growOf(cell.weight)} />)}
    </div>
  </div>
);

export const HeatmapCard: React.FC<{ data: HeatmapArtifact }> = ({ data }) => {
  const unit = data.unit ?? '%';
  const groups: HeatmapGroup[] = data.groups?.length
    ? data.groups
    : data.cells?.length
      ? [{ cells: data.cells }]
      : [];
  if (!groups.length) return null;

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
      header={data.title ? (
        <div>
          <div className="text-sm font-extrabold">{data.title}</div>
          {data.subtitle && <div className="text-[11px] font-semibold text-slate-500">{data.subtitle}</div>}
        </div>
      ) : undefined}
      footer={data.caption ? <div className="text-[10px] font-medium text-slate-400">{data.caption}</div> : undefined}
    >
      <div className="space-y-3 p-3 pt-1">
        {groups.map((g, i) => <Group key={i} group={g} unit={unit} growOf={growOf} />)}
      </div>
    </Surface>
  );
};
