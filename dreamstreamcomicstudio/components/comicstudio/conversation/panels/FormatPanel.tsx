// Format panel (composer chip "▭ 2:3 · 6p"): kind, page shape, page count, panel density,
// lettering and reading direction. Every change is an instant `format` patch — no LLM —
// and the director sees it on its next turn.
//
// Tell before staling (director.md §3.8.4): when pages are already drawn, the panel says up
// front that a new shape / lettering mode marks them out of date and what a redraw would cost;
// after such a change it says how many are now out of date and offers "Switch back" (free).
//
// Panels per page (plan §4.1, §5.1): Auto — "3–4 big panels", the beats decide within the kind's range
// (comics and manga 2–4, 5 only for a fast, nearly silent sequence; strips 3–4; webtoons 2–5; storybooks up to
// 3) — or a fixed 2, 3, 4, 5 or 6 (PANEL_LIMITS.uiChoices; the free fit check still flags a panel with too many
// words). A storybook set above 3 plans its NEW pages with at most 3 and says so (decision PD-2,
// panelCountNote); the hint under the choice states the same number (panelCountRule). The choices are a
// wrapping grid sized by the panel, never the viewport: this panel also opens inside the narrow recap card.

import React from 'react';
import { BookHeart, BookOpen, GalleryHorizontal, Info, Minus, Plus, RotateCcw, ScrollText, Smartphone } from 'lucide-react';
import { isPageStale, type AspectRatio, type ComicDoc, type ComicKind, type Format, type LetteringMode, type Page } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { estimateJobs, nearestAspect, resolveImageJob, tierPagePrice } from '../../../../shared/comic/models';
import { PANEL_LIMITS, panelCountNote, panelCountRule } from '../../../../shared/comic/panelRules';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import { ACCENT_SOFT_BG, TONE_SURFACE, TRANSITION } from '../../../chat/studioDesign';
import { useCostFormat } from '../cost';
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
/** Auto, then the fixed counts Format offers (plan §5.1 PANEL_LIMITS.uiChoices: 2–6). */
export const PANEL_OPTIONS: Format['panelsPerPage'][] = ['auto', ...PANEL_LIMITS.uiChoices];
/** What Auto plans (plan §4.1): usually 3 big panels, sometimes 2 or 4. */
export const AUTO_PANELS_LABEL = '3–4 big panels';

/**
 * The words under the panel choice: what the current setting plans, from the same rule the writer and the plan
 * check use (panelRules.panelCountRule), so the hint never contradicts the storybook note or a kind's own range.
 */
export const panelChoiceHint = (format: Pick<Format, 'kind' | 'panelsPerPage'>): string => {
  const rule = panelCountRule(format);
  if (rule.exact !== undefined) {
    const n = rule.exact;
    // A storybook set above its limit plans its new pages with the limit (PD-2): say that number, as the note does.
    const count = `${n} panel${n === 1 ? '' : 's'} on every new page${rule.clampedFrom !== undefined ? ' (the storybook limit)' : ''}`;
    return `${count}. Fewer, bigger panels leave more room for detail and words; a panel with too many words is flagged before anything is drawn.`;
  }
  if (format.kind === 'storybook') {
    return `Auto: usually ${rule.typical} large panels a page (at most ${rule.max}), so every picture has room.`;
  }
  const range = rule.min === rule.max ? `${rule.max}` : `${rule.min}–${rule.max}`;
  const fast = rule.fast ? `; ${rule.fast.panels} only for a fast, nearly silent moment` : '';
  return `Auto: usually ${rule.typical} big panels a page (${range}${fast}), so the art and the words both fit.`;
};

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
const PageCountInput: React.FC<{ id: string; value: number; onCommit: (n: number) => void }> = ({ id, value, onCommit }) => {
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
      id={id}
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

/**
 * Panels per page: Auto ("3–4 big panels") and 2–6 as a radio group of tiles that WRAPS with its container
 * (Auto spans two columns), arrow keys move and choose like a native radio group, 44 px targets on touch.
 * A stored count outside the offered ones (an old doc's 9, say) stays visible as its own "current" tile.
 */
const PanelCountChoice: React.FC<{ value: Format['panelsPerPage']; onChange(v: Format['panelsPerPage']): void }> = ({ value, onChange }) => {
  const options: Format['panelsPerPage'][] = PANEL_OPTIONS.includes(value) ? PANEL_OPTIONS : [...PANEL_OPTIONS, value];
  const checked = options.findIndex((o) => o === value);
  const focusIndex = checked >= 0 ? checked : 0;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (focusIndex + step + options.length) % options.length;
    onChange(options[next]);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Panels per page" onKeyDown={onKeyDown} className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1">
      {options.map((v, i) => {
        const on = v === value;
        const auto = v === 'auto';
        const extra = !auto && !PANEL_OPTIONS.includes(v);
        return (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === focusIndex ? 0 : -1}
            // The name starts with the visible words: "Auto · 3–4 big panels", "2 panels" (WCAG 2.5.3).
            aria-label={auto ? `Auto · ${AUTO_PANELS_LABEL}` : `${v} panels${extra ? ' (current)' : ''}`}
            title={auto ? `Auto · ${AUTO_PANELS_LABEL} — the story's beats decide` : `${v} panels on every page${extra ? ' (current setting)' : ''}`}
            onClick={() => onChange(v)}
            className={cx(
              `flex min-w-0 flex-col items-center justify-center rounded-xl border px-1.5 py-1.5 text-center ${TRANSITION} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-[44px]`,
              auto && 'col-span-2',
              on
                ? `border-[var(--ds-accent)] ${ACCENT_SOFT_BG} text-[var(--ds-ink)]`
                : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
            )}
          >
            {auto ? (
              <>
                <span className="w-full truncate text-[12px] font-semibold">Auto</span>
                <span className="w-full truncate text-[10px] leading-tight">{AUTO_PANELS_LABEL}</span>
              </>
            ) : (
              <span className="text-[13px] font-semibold tabular-nums">{v}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export interface FormatPanelProps {
  doc: ComicDoc;
  patch: (ops: DocOp[]) => Promise<void> | void;
  byok?: boolean;
  /** The user's caps (usage-terms prices for governed users; admins and own keys see dollars). */
  caps?: StudioCaps;
}

export const FormatPanel: React.FC<FormatPanelProps> = ({ doc, patch, byok = false, caps }) => {
  const format = doc.format;
  const cost = useCostFormat({ byok, caps });
  // Unique per instance: the panel can be open in the composer and inside a recap card at once.
  const pageCountId = `comicstudio-page-count-${React.useId().replace(/[^\w-]/g, '')}`;
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
        <div role="status" className={cx('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 text-[12px] leading-snug text-[var(--ds-ink)]', TONE_SURFACE.warning)}>
          <p className="min-w-0 flex-1 basis-[12rem] [overflow-wrap:anywhere]">
            {staleNow === 1 ? '1 drawn page is' : `${staleNow} drawn pages are`} now out of date — redraw {cost.approx(redrawQuoteUsd(doc, staleNow, byok))} when you’re
            ready, or switch back to keep {staleNow === 1 ? 'it' : 'them'} as {staleNow === 1 ? 'it is' : 'they are'}.
          </p>
          <button
            type="button"
            onClick={() => {
              const before = undoStale;
              setUndoStale(null);
              void patch([{ op: 'format', patch: before }]);
            }}
            className="tap-target inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden /> Switch back
          </button>
        </div>
      ) : drawn.length > 0 ? (
        <p className="flex items-start gap-2 rounded-xl bg-[var(--ds-well)] px-3 py-2 text-[11.5px] leading-snug text-[var(--ds-muted)]">
          <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {pagesWord(drawn.length)} {drawn.length === 1 ? 'is' : 'are'} already drawn. A new page shape or lettering mode marks{' '}
            {drawn.length === 1 ? 'it' : 'them'} out of date (redraw {cost.approx(redrawQuoteUsd(doc, drawn.length, byok))}) — nothing is redrawn until you ask.
          </span>
        </p>
      ) : null}

      <div>
        <SectionLabel>Kind</SectionLabel>
        {/* A wrapping tile grid, not a 5-way segmented bar: this panel also opens inside the
            recap card (≈210 px wide on a phone), where five fixed segments made "Storybook"
            and "Webtoon" run into each other. Tiles size to the container, never the viewport. */}
        <div role="radiogroup" aria-label="Comic kind" className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-1">
          {KIND_OPTIONS.map((k) => {
            const on = format.kind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={k.label}
                onClick={() => set(kindPatch(format, k.value))}
                className={cx(
                  'flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-1.5 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:min-h-[44px]',
                  on
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]'
                    : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                <span className={on ? 'text-[var(--ds-accent)]' : ''}>{k.icon}</span>
                <span className="w-full truncate text-[11.5px] font-medium">{k.label}</span>
              </button>
            );
          })}
        </div>
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
                  'flex min-w-0 flex-col items-center gap-1.5 rounded-xl border px-1.5 py-2.5 text-center transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
                  on
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]'
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
        <SectionLabel htmlFor={pageCountId}>Pages</SectionLabel>
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
            <PageCountInput id={pageCountId} value={format.pageCount} onCommit={(n) => set({ pageCount: n })} />
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
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] text-[var(--ds-ink)]'
                    : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--ds-muted)]">
          {cost.approx(perPage * format.pageCount)} to draw {format.pageCount === 1 ? 'it' : `all ${format.pageCount}`} on{' '}
          {pageModel.nickname} · planning is free until you approve.
        </p>
      </div>

      <div>
        <SectionLabel>Panels per page</SectionLabel>
        <PanelCountChoice value={format.panelsPerPage} onChange={(panelsPerPage) => set({ panelsPerPage })} />
        <p className="mt-2 text-[11px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{panelChoiceHint(format)}</p>
        {panelCountNote(format) && (
          <p
            role="note"
            className={cx('mt-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11.5px] leading-snug text-[var(--ds-ink)]', TONE_SURFACE.info)}
          >
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 [overflow-wrap:anywhere]">{panelCountNote(format)}</span>
          </p>
        )}
      </div>

      <div>
        <SectionLabel>Lettering</SectionLabel>
        {/* Columns follow the PANEL's width (it also opens inside the narrow recap card), not the
            viewport: two side by side only when each gets ≥ 11rem — "Editable balloons" never spills. */}
        <div role="radiogroup" aria-label="Lettering" className="grid grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))] gap-2">
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
                  'min-w-0 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
                  on ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]' : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)]'
                )}
              >
                <span className="block text-[13px] font-semibold text-[var(--ds-ink)] [overflow-wrap:anywhere]">{o.title}</span>
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
