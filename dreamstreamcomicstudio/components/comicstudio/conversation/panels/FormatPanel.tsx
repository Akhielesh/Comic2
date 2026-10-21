// Format panel (composer chip "▭ 2:3 · 6p"): kind, page shape, page count, panel density,
// lettering and reading direction. Every change is an instant `format` patch — no LLM —
// and the director sees it on its next turn.

import React from 'react';
import { BookHeart, BookOpen, GalleryHorizontal, Minus, Plus, ScrollText, Smartphone } from 'lucide-react';
import type { AspectRatio, ComicDoc, ComicKind, Format, LetteringMode } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { formatUsd, nearestAspect, resolveImageJob, tierPagePrice } from '../../../../shared/comic/models';
import { AspectGlyph, Segmented, SectionLabel, cx } from '../ui';

export const KIND_OPTIONS: { value: ComicKind; label: string; icon: React.ReactNode }[] = [
  { value: 'comic', label: 'Comic', icon: <BookOpen className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'manga', label: 'Manga', icon: <ScrollText className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'webtoon', label: 'Webtoon', icon: <Smartphone className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'strip', label: 'Strip', icon: <GalleryHorizontal className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'storybook', label: 'Storybook', icon: <BookHeart className="h-3.5 w-3.5" aria-hidden /> }
];

/** Page shapes that make sense for each kind (first = default). */
export const ASPECTS_BY_KIND: Record<ComicKind, { value: AspectRatio; label: string }[]> = {
  comic: [
    { value: '2:3', label: 'Comic book' },
    { value: '3:4', label: 'Album' },
    { value: '4:5', label: 'Square-ish' },
    { value: '1:1', label: 'Square' }
  ],
  manga: [
    { value: '2:3', label: 'Tankōbon' },
    { value: '3:4', label: 'Magazine' }
  ],
  webtoon: [
    { value: '9:16', label: 'Phone' },
    { value: '1:4', label: 'Long scroll' }
  ],
  strip: [
    { value: '4:1', label: 'Daily strip' },
    { value: '21:9', label: 'Wide' },
    { value: '16:9', label: 'Panorama' },
    { value: '1:1', label: 'Square' }
  ],
  storybook: [
    { value: '4:3', label: 'Landscape' },
    { value: '3:2', label: 'Wide' },
    { value: '1:1', label: 'Square' },
    { value: '4:5', label: 'Portrait' }
  ]
};

export const PAGE_PRESETS = [1, 4, 6, 12, 24];
export const MIN_PAGES = 1;
export const MAX_PAGES = 40;
const PANEL_OPTIONS: (Format['panelsPerPage'])[] = ['auto', 3, 4, 5, 6];

const clampPages = (n: number) => Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.round(n)));

/** The format patch for switching kind: keep a sensible page shape and reading direction. */
export const kindPatch = (format: Format, kind: ComicKind): Partial<Format> => {
  const patch: Partial<Format> = { kind };
  const shapes = ASPECTS_BY_KIND[kind];
  if (!shapes.some((s) => s.value === format.pageAspect)) patch.pageAspect = shapes[0].value;
  if (kind === 'manga' && format.readingDirection !== 'rtl') patch.readingDirection = 'rtl';
  if (kind !== 'manga' && format.kind === 'manga' && format.readingDirection === 'rtl') patch.readingDirection = 'ltr';
  return patch;
};

export const LETTERING_OPTIONS: { value: LetteringMode; title: string; blurb: string }[] = [
  { value: 'overlay', title: 'Editable balloons', blurb: 'Clean art; we letter it with balloons you can edit and move.' },
  { value: 'in_art', title: 'Drawn by the model', blurb: 'The model letters the page itself — best on Pro.' }
];

/** Number field with a local draft so it can be cleared and retyped; commits on blur/Enter. */
const PageCountInput: React.FC<{ value: number; onCommit: (n: number) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!draft.trim() || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const next = clampPages(n);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id="comicstudio-page-count"
      type="number"
      inputMode="numeric"
      min={MIN_PAGES}
      max={MAX_PAGES}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className="w-12 bg-transparent text-center text-[14px] font-semibold tabular-nums text-[var(--ds-ink)] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
};

export interface FormatPanelProps {
  doc: ComicDoc;
  patch: (ops: DocOp[]) => Promise<void> | void;
  byok?: boolean;
}

export const FormatPanel: React.FC<FormatPanelProps> = ({ doc, patch, byok = false }) => {
  const format = doc.format;
  const set = (p: Partial<Format>) => void patch([{ op: 'format', patch: p }]);
  const shapes = ASPECTS_BY_KIND[format.kind] || ASPECTS_BY_KIND.comic;
  const shapeList = shapes.some((s) => s.value === format.pageAspect)
    ? shapes
    : [{ value: format.pageAspect, label: 'Current' }, ...shapes];
  const pageModel = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec;
  const drawnAspect = nearestAspect(pageModel, format.pageAspect);
  const perPage = tierPagePrice(doc.settings.quality, byok);

  return (
    <div className="space-y-5 p-4">
      <div>
        <SectionLabel>Kind</SectionLabel>
        <Segmented
          label="Comic kind"
          value={format.kind}
          onChange={(kind) => set(kindPatch(format, kind))}
          options={KIND_OPTIONS.map((k) => ({
            value: k.value,
            label: (
              <>
                {k.icon}
                <span className="hidden sm:inline">{k.label}</span>
                <span className="sm:hidden">{k.label.slice(0, 5)}</span>
              </>
            ),
            title: k.label
          }))}
        />
      </div>

      <div>
        <SectionLabel>Page shape</SectionLabel>
        <div role="radiogroup" aria-label="Page shape" className="flex flex-wrap gap-2">
          {shapeList.map((s) => {
            const on = s.value === format.pageAspect;
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({ pageAspect: s.value })}
                className={cx(
                  'flex w-[74px] flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
                  on
                    ? 'border-[#D97757]/50 bg-[#D97757]/10 text-[var(--ds-ink)]'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                <AspectGlyph aspect={s.value} size={26} className={on ? 'text-[var(--ds-accent)]' : ''} />
                <span className="text-[11px] font-semibold tabular-nums">{s.value}</span>
                <span className="w-full truncate text-[10px]">{s.label}</span>
              </button>
            );
          })}
        </div>
        {drawnAspect !== format.pageAspect && (
          <p className="mt-2 text-[11px] text-[var(--ds-muted)]">
            {pageModel.nickname} draws {format.pageAspect} pages at the closest shape it supports ({drawnAspect}).
          </p>
        )}
      </div>

      <div>
        <SectionLabel htmlFor="comicstudio-page-count">Pages</SectionLabel>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)]">
            <button
              type="button"
              aria-label="Fewer pages"
              disabled={format.pageCount <= MIN_PAGES}
              onClick={() => set({ pageCount: clampPages(format.pageCount - 1) })}
              className="rounded-l-xl p-2 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <PageCountInput value={format.pageCount} onCommit={(n) => set({ pageCount: n })} />
            <button
              type="button"
              aria-label="More pages"
              disabled={format.pageCount >= MAX_PAGES}
              onClick={() => set({ pageCount: clampPages(format.pageCount + 1) })}
              className="rounded-r-xl p-2 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Page count presets">
            {PAGE_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={format.pageCount === n}
                onClick={() => set({ pageCount: n })}
                className={cx(
                  'rounded-full border px-2.5 py-1 text-[12px] font-medium tabular-nums transition-all duration-200',
                  format.pageCount === n
                    ? 'border-[#D97757]/40 bg-[#D97757]/10 text-[var(--ds-ink)]'
                    : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--ds-muted)]">
          ≈ {formatUsd(perPage * format.pageCount)} to draw {format.pageCount === 1 ? 'it' : `all ${format.pageCount}`} on{' '}
          {pageModel.nickname} · planning is free until you approve.
        </p>
      </div>

      <div>
        <SectionLabel>Panels per page</SectionLabel>
        <Segmented
          label="Panels per page"
          value={format.panelsPerPage}
          onChange={(panelsPerPage) => set({ panelsPerPage })}
          options={PANEL_OPTIONS.map((v) => ({ value: v, label: v === 'auto' ? 'Auto' : String(v), title: v === 'auto' ? 'Vary by pacing (3–6)' : `${v} panels` }))}
        />
      </div>

      <div>
        <SectionLabel>Lettering</SectionLabel>
        <div role="radiogroup" aria-label="Lettering" className="grid gap-2 sm:grid-cols-2">
          {LETTERING_OPTIONS.map((o) => {
            const on = format.lettering === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({ lettering: o.value })}
                className={cx(
                  'rounded-xl border px-3 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
                  on ? 'border-[#D97757]/50 bg-[#D97757]/10' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
                )}
              >
                <span className="block text-[13px] font-semibold text-[var(--ds-ink)]">{o.title}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-[var(--ds-muted)]">{o.blurb}</span>
              </button>
            );
          })}
        </div>
        {format.lettering === 'in_art' && doc.settings.quality !== 'pro' && (
          <p className="mt-2 text-[11px] text-[var(--ds-muted)]">Tip: in-art lettering is most reliable on Pro quality.</p>
        )}
      </div>

      <div>
        <SectionLabel>Reading direction</SectionLabel>
        <Segmented
          label="Reading direction"
          value={format.readingDirection}
          onChange={(readingDirection) => set({ readingDirection })}
          options={[
            { value: 'ltr', label: 'Left → right' },
            { value: 'rtl', label: 'Right → left' }
          ]}
        />
      </div>
    </div>
  );
};
