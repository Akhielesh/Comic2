// Two versions of one image, side by side (≥ md) or as a swipe slider (phones), with a diff of what
// was actually recorded for each: model, size/shape, cost, QC, how it was made, the note, the date.
// Rows that differ are highlighted; nothing is guessed.

import React, { useId, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioController } from '../types';
import { ORIGIN_LABEL, versionCostLabel, type VersionItem } from './bookModel';
import { Badge, BlockedTile, cx, shortDate } from './ui';
import { useCostFormat } from '../conversation/cost';

export interface CompareViewProps {
  studio: StudioController;
  doc: ComicDoc;
  a: VersionItem;
  b: VersionItem;
  /** w/h of the frame both images are shown in. */
  ratio: number;
  onUse?(item: VersionItem): void;
  useDisabled?: boolean;
}

const sizeLabel = (v: VersionItem) => (v.asset.w && v.asset.h ? `${v.asset.w}×${v.asset.h}${v.shape ? ` (${v.shape})` : ''}` : 'Not recorded');

/** Recorded facts per version (pure; tested through CompareView). */
export const compareRows = (a: VersionItem, b: VersionItem, money?: (usd: number) => string): { label: string; a: string; b: string; differs: boolean }[] => {
  const rows: [string, (v: VersionItem) => string][] = [
    ['Model', (v) => v.modelLabel ?? 'Not recorded'],
    ['Size', sizeLabel],
    ['Cost', (v) => versionCostLabel(v, money)],
    ['QC score', (v) => (typeof v.qcScore === 'number' ? v.qcScore.toFixed(2) : 'Not checked')],
    ['Made by', (v) => (v.origin ? ORIGIN_LABEL[v.origin] : 'Not recorded')],
    ['Note', (v) => v.note ?? '—'],
    ['Made', (v) => shortDate(v.at)]
  ];
  return rows.map(([label, f]) => ({ label, a: f(a), b: f(b), differs: f(a) !== f(b) }));
};

const Pane: React.FC<{ studio: StudioController; v: VersionItem; ratio: number }> = ({ studio, v, ratio }) => {
  const url = v.blocked ? undefined : studio.urlFor(v.asset, { width: 720 });
  return (
    <figure className="min-w-0">
      <div className="relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]" style={{ aspectRatio: String(ratio) }}>
        {v.blocked ? <BlockedTile /> : url ? <img src={url} alt={`Version ${v.n}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} /> : <span className="studio-shimmer absolute inset-0" aria-hidden />}
      </div>
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px] font-semibold text-[var(--ds-ink)]">
        v{v.n}
        {v.current && <Badge tone="accent">Current</Badge>}
        {v.stale && <Badge tone="warn">Out of date</Badge>}
        {v.mismatch && <Badge tone="warn">{v.shape}</Badge>}
        {v.archived && <Badge>Archived</Badge>}
      </figcaption>
    </figure>
  );
};

export const CompareView: React.FC<CompareViewProps> = ({ studio, doc, a, b, ratio, onUse, useDisabled }) => {
  const [pos, setPos] = useState(50);
  const sliderId = useId();
  const urlA = a.blocked ? undefined : studio.urlFor(a.asset, { width: 720 });
  const urlB = b.blocked ? undefined : studio.urlFor(b.asset, { width: 720 });
  const cost = useCostFormat(studio);
  const rows = compareRows(a, b, cost.exact);
  return (
    <div className="min-w-0 space-y-3" aria-label={`Compare v${a.n} and v${b.n}`}>
      {/* Wide screens: side by side. */}
      <div className="hidden grid-cols-2 gap-3 md:grid">
        <Pane studio={studio} v={a} ratio={ratio} />
        <Pane studio={studio} v={b} ratio={ratio} />
      </div>
      {/* Phones: one frame, drag the slider to reveal the other version. */}
      <div className="md:hidden">
        <div className="relative w-full overflow-hidden rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]" style={{ aspectRatio: String(ratio) }}>
          {b.blocked ? <BlockedTile /> : urlB && <img src={urlB} alt={`Version ${b.n}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} />}
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
            <div className="absolute inset-0 bg-[var(--ds-well)]" />
            {a.blocked ? <BlockedTile /> : urlA && <img src={urlA} alt={`Version ${a.n}`} className="absolute inset-0 h-full w-full object-contain" draggable={false} />}
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--ds-accent)]" style={{ left: `${pos}%` }} aria-hidden />
          <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[10.5px] font-semibold text-white">v{a.n}</span>
          <span className="absolute right-1.5 top-1.5 rounded bg-black/55 px-1.5 text-[10.5px] font-semibold text-white">v{b.n}</span>
        </div>
        <label htmlFor={sliderId} className="sr-only">
          Reveal v{a.n} versus v{b.n}
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          className="mt-2 h-11 w-full accent-[#D97757]"
          aria-valuetext={`${pos}% v${a.n}`}
        />
      </div>
      <table className="w-full table-fixed border-collapse text-[12px]">
        <caption className="sr-only">What was recorded for each version</caption>
        <thead>
          {/* Column names that are version numbers (v3 / v5), not eyebrows: kept off OVERLINE as Atlas wave 8 kept its
              spreadsheet column letters off .atlas-overline (allowlisted in tests/config/overlineGuard.test.ts). */}
          <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--ds-muted)]">
            <th scope="col" className="w-[28%] py-1 font-semibold" />
            <th scope="col" className="py-1 font-semibold">v{a.n}</th>
            <th scope="col" className="py-1 font-semibold">v{b.n}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={cx('border-t border-[var(--ds-hairline-soft)]', r.differs && 'bg-[#D97757]/5')}>
              <th scope="row" className="py-1.5 pr-2 text-left font-medium text-[var(--ds-muted)]">
                {r.label}
              </th>
              <td className="break-words py-1.5 pr-2 tabular-nums text-[var(--ds-ink)]">{r.a}</td>
              <td className="break-words py-1.5 tabular-nums text-[var(--ds-ink)]">{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onUse && (
        <div className="flex flex-wrap gap-2">
          {[a, b]
            .filter((v) => !v.current)
            .map((v) => (
              <button
                key={v.path}
                type="button"
                disabled={useDisabled || v.blocked}
                onClick={() => onUse(v)}
                className="tap-target inline-flex h-9 items-center rounded-xl bg-[var(--ds-accent)] px-4 text-[13px] font-semibold text-white hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Use v{v.n} · Free
              </button>
            ))}
        </div>
      )}
      <p className="text-[11.5px] text-[var(--ds-muted)]">Switching versions is free and instant. Book pages are {doc.format.pageAspect}.</p>
    </div>
  );
};

export default CompareView;
