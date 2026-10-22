// Format panel (composer chip "▭ 2:3 · 6p"): kind, page shape, page count, panel density,
// lettering and reading direction. Every change is an instant `format` patch — no LLM —
// and the director sees it on its next turn.
//
// Tell before staling (director.md §3.8.4): when pages are already drawn, the panel says up
// front that a new shape / lettering mode marks them out of date and what a redraw would cost;
// after such a change it says how many are now out of date and offers "Switch back" (free).

import React from 'react';
import { BookHeart, BookOpen, GalleryHorizontal, Info, Minus, Plus, RotateCcw, ScrollText, Smartphone } from 'lucide-react';
import { isPageStale, type AspectRatio, type ComicDoc, type ComicKind, type Format, type LetteringMode, type Page } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { estimateJobs, formatUsd, nearestAspect, resolveImageJob, tierPagePrice } from '../../../../shared/comic/models';
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

/** Format fields that are part of every page's spec hash: changing one marks drawn pages out of date. */
export const STALING_FORMAT_KEYS = ['pageAspect', 'colorMode', 'lettering'] as const;
type StalingKey = (typeof STALING_FORMAT_KEYS)[number];

/** True when applying `patch` would change a field drawn pages depend on. */
export const isStalingChange = (format: Format, patch: Partial<Format>): boolean =>
  STALING_FORMAT_KEYS.some((k) => patch[k] !== undefined && patch[k] !== format[k]);

/** Drawn pages whose art still matches their spec (what a staling change would put out of date). */
export const drawnCurrentPages = (doc: ComicDoc): Page[] =>
  doc.pages.filter((p) => p.render.status === 'ready' && !!p.render.asset && !isPageStale(doc, p));

/** Honest registry quote for redrawing `count` pages on the comic's tier/model. */
export const redrawQuoteUsd = (doc: ComicDoc, count: number, byok: boolean): number =>
  count > 0 ? estimateJobs([{ kind: 'page', count }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok }).usd : 0;

const pagesWord = (n: number) => (n === 1 ? '1 page' : `${n} pages`);

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
  // The values a staling change replaced, so "Switch back" can restore them for free.
  const [undoStale, setUndoStale] = React.useState<Partial<Pick<Format, StalingKey>> | null>(null);
  const drawn = drawnCurrentPages(doc);
  const staleNow = doc.pages.filter((p) => isPageStale(doc, p)).length;
  const set = (p: Partial<Format>) => {
    if (isStalingChange(format, p) && drawn.length) {
      const before: Partial<Pick<Format, StalingKey>> = {};
      for (const k of STALING_FORMAT_KEYS) if (p[k] !== undefined && p[k] !== format[k]) (before as Record<string, unknown>)[k] = format[k];
      setUndoStale((prev) => ({ ...before, ...(prev || {}) }));
    }
    void patch([{ op: 'format', patch: p }]);
  };
  const shapes = ASPECTS_BY_KIND[format.kind] || ASPECTS_BY_KIND.comic;
  const shapeList = shapes.some((s) => s.value === format.pageAspect)
    ? shapes
    : [{ value: format.pageAspect, label: 'Current' }, ...shapes];
  const pageModel = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec;
  const drawnAspect = nearestAspect(pageModel, format.pageAspect);
  const perPage = tierPagePrice(doc.settings.quality, byok);

  return (
    <div className="space-y-5 p-4">
      {undoStale && staleNow > 0 ? (
        <div role="status" className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2.5 text-[12px] leading-snug text-[var(--ds-ink)]">
          <p className="min-w-0 flex-1 basis-[12rem] [overflow-wrap:anywhere]">
            {staleNow === 1 ? '1 drawn page is' : `${staleNow} drawn pages are`} now out of date — redraw ≈ {formatUsd(redrawQuoteUsd(doc, staleNow, byok))} when you’re
            ready, or switch back to keep {staleNow === 1 ? 'it' : 'them'} as {staleNow === 1 ? 'it is' : 'they are'}.
          </p>
          <button
            type="button"
            onClick={() => {
              const before = undoStale;
              setUndoStale(null);
              void patch([{ op: 'format', patch: before }]);
            }}
            className="tap-target inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
          >
            <RotateCcw className="h-3 w-3" aria-hidden /> Switch back
          </button>
        </div>
      ) : drawn.length > 0 ? (
        <p className="flex items-start gap-2 rounded-xl bg-[var(--ds-well)] px-3 py-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {pagesWord(drawn.length)} {drawn.length === 1 ? 'is' : 'are'} already drawn. A new page shape or lettering mode marks{' '}
            {drawn.length === 1 ? 'it' : 'them'} out of date (redraw ≈ {formatUsd(redrawQuoteUsd(doc, drawn.length, byok))}) — nothing is redrawn until you ask.
          </span>
        </p>
      ) : null}

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
                {/* Phones: the full word at a smaller size beats an icon + "Webto". */}
                <span className="hidden sm:inline-flex">{k.icon}</span>
                <span className="text-[11px] sm:text-[12px]">{k.label}</span>
              </>
            ),
            title: k.label
          }))}
        />
      </div>

      <div>
        <SectionLabel>Page shape</SectionLabel>
        <div role="radiogroup" aria-label="Page shape" className="grid grid-cols-4 gap-2">
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
                  'flex min-w-0 flex-col items-center gap-1.5 rounded-xl border px-1.5 py-2.5 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
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
              className="tap-target rounded-l-xl p-2 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <PageCountInput value={format.pageCount} onCommit={(n) => set({ pageCount: n })} />
            <button
              type="button"
              aria-label="More pages"
              disabled={format.pageCount >= MAX_PAGES}
              onClick={() => set({ pageCount: clampPages(format.pageCount + 1) })}
              className="tap-target rounded-r-xl p-2 text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40"
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
                  'tap-target rounded-full border px-2.5 py-1 text-[12px] font-medium tabular-nums transition-all duration-200 coarse:min-h-[36px] coarse:min-w-[36px]',
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
