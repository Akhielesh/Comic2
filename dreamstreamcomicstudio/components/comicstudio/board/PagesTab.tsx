// Pages: the plan and the pages it becomes. Plan before pixels — while the plan is a
// draft the header asks for review and shows the honest price of drawing it; every page
// card shows exactly where it stands (planned script → queued → drawing with a clock →
// developed art with balloons → out of date / failed with a calm Retry). Multi-select
// redraws a chosen few; the cover leads the grid.
//
// Wave 2 (P2-BOARD):
//   • every card has the timeline's clip menu (⋯, long-press on touch, right-click, Shift+F10):
//     versions, compare, redraw, Fit (Free), duplicate, insert, move, delete — free edits with undo;
//   • "Include the cover" on the draw-all button, quoted exactly like the server's gate;
//   • the Book section: title page, "The End", back cover, spreads and trim — free software pages;
//   • density (large / compact cards, remembered per device in `cs.pages.cols`);
//   • thumbnails use the ≤ 480w variants; art sits behind the content-check veil;
//   • art drawn at the wrong shape says so ("1:1 · book is 4:5") with a free "Fit to 4:5";
//   • prices print through formatCostForUser: governed users see a share of their usage, never dollars.

import React, { useEffect, useMemo, useState } from 'react';
import { BookImage, BookOpen, ChevronDown, ChevronUp, Crop, Image as ImageIcon, MoreHorizontal, RotateCcw, ScrollText, Sparkles } from 'lucide-react';
import { bookOf, newId, totalPanels, type BookSettings, type ComicDoc, type Page, type RenderTarget } from '../../../shared/comic/doc';
import { aspectMismatch } from '../../../shared/comic/book';
import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP } from '../../../shared/comic/models';
import { DOC_LIMITS } from '../../../shared/comic/limits';
import { coverNeedsDraw, quoteRenderPages } from '../../../shared/comic/plan';
import { canServeToOwner, effectiveRating, type ContentRating } from '../../../shared/comic/safety';
import type { StudioController } from '../types';
import { useLongPress, type LongPressHandlers } from '../mobile/touch/useLongPress';
import { useFormFactor } from '../mobile/useFormFactor';
import { SafetyVeil } from '../safety/SafetyVeil';
import { ClipMenu, clipMenuItems, type ClipAction, type ClipMenuItem } from '../timeline/ClipMenu';
import { PlateEditor, PlateView } from '../timeline/PlateView';
import { PLATE_LABEL, type PlateKind } from '../timeline/plates';
import { UndoToast, useTimelineEdit, type TimelineEdit } from '../timeline/UndoToast';
import { VersionStack } from '../timeline/VersionStack';
import { TimelineDialog } from '../timeline/ui';
import { bookClips, canAddPage, deleteOps, duplicateOps, insertOps, moveOps, redrawPrice, sortedPages, type ClipVM } from '../timeline/bookModel';
import { ComicPageView } from './ComicPageView';
import { EmptyIllustration, FrameBadge, ImageFrame, THUMB_MAX_W, VersionsButton, frameSources, variantCssWidth } from './ImageFrame';
import { PageScript } from './PageScript';
import { aspectNumber, pageAspectOf } from './balloonGeometry';
import { byokFromDoc, estimateDraw, estimateOne, hasImage, isBusy, jobModel, pageVisualStatus, pagesForIds, plural, renderModelNickname, sheetVisualStatus } from './boardModel';
import { useCostFormat, type CostFormat } from './costFormat';
import { EmptyHint, GhostButton, IconButton, InlineField, PrimaryButton, RenderOverlay, Segmented, SectionTitle, StatusChip, Surface, SwitchRow, cx, useClickGuard } from './ui';

// ── Density ──────────────────────────────────────────────────────────────────

/** '1' = large cards, '2' = compact cards (two columns on a phone). mobile.md §3.1. */
export type PagesDensity = '1' | '2';
export const DENSITY_KEY = 'cs.pages.cols';

const GRID: Record<PagesDensity, string> = {
  '1': 'grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr))]',
  // 2 × 128 + gap fits a 320 px phone's content width (288 px); 360 px phones get two roomy columns.
  '2': 'grid items-start gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,128px),1fr))]'
};

export const readDensity = (fallback: PagesDensity): PagesDensity => {
  try {
    const v = globalThis.localStorage?.getItem(DENSITY_KEY);
    return v === '1' || v === '2' ? v : fallback;
  } catch {
    return fallback;
  }
};

const storeDensity = (v: PagesDensity) => {
  try {
    globalThis.localStorage?.setItem(DENSITY_KEY, v);
  } catch {
    /* private mode: the choice holds for this visit */
  }
};

// ── Shared bits ──────────────────────────────────────────────────────────────

/** The card a press or a menu button belongs to (the clip menu anchors to the whole card). */
const cardOf = (el: EventTarget | null): Element | null => {
  const node = el as Element | null;
  return (typeof node?.closest === 'function' ? node.closest('article') : null) ?? node ?? null;
};

/** A text field (typing, selecting, pasting): its own long-press / right-click menu must win. */
const TEXT_TARGET = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])';

/**
 * The card's long-press / right-click / Shift+F10 handlers, limited to the card's OWN DOM: React
 * bubbles events out of portals (the versions dialog opened from a card), and a press-and-hold or a
 * right-click in a text field (the cover title) must keep the platform's text menu.
 */
const cardPress = (press: LongPressHandlers): LongPressHandlers => {
  const ours = (e: React.SyntheticEvent) => {
    const t = e.target as Node | null;
    const host = e.currentTarget as Node | null;
    if (!t || !host || typeof host.contains !== 'function' || !host.contains(t)) return false;
    const el = t as Element;
    return !(typeof el.closest === 'function' && el.closest(TEXT_TARGET));
  };
  return {
    ...press,
    onPointerDown: (e) => {
      if (ours(e)) press.onPointerDown(e);
    },
    onContextMenu: (e) => {
      if (ours(e)) press.onContextMenu(e);
    },
    onKeyDown: (e) => {
      if (ours(e)) press.onKeyDown(e);
    }
  };
};

/** A price shown NEXT TO its button (so long usage wording never squeezes the label). */
const PriceNote: React.FC<{ id: string; children: React.ReactNode; className?: string }> = ({ id, children, className }) => (
  <span id={id} className={cx('min-w-0 text-[11px] leading-snug tabular-nums text-[var(--ds-muted)] [overflow-wrap:anywhere]', className)}>
    {children}
  </span>
);

/** A free re-shape of art drawn at the wrong aspect (software, never billed). */
const FitButton: React.FC<{ studio: StudioController; target: RenderTarget; want: string; disabled?: boolean; short?: boolean }> = ({ studio, target, want, disabled, short }) => {
  const { busyKey, fire } = useClickGuard(3000);
  return (
    <GhostButton
      size="xs"
      busy={busyKey === 'fit'}
      disabled={disabled}
      onClick={() => fire('fit', () => studio.act({ type: 'fit_render', target, mode: 'auto' }))}
      title={`Re-fit the art to ${want} by padding or cropping — free, done by the editor`}
      // Compact cards (two columns on a 320 px phone) get the short label; the name stays complete.
      aria-label={short ? `Fit to ${want} · Free` : undefined}
      className="max-w-full"
    >
      <Crop className="h-3 w-3 shrink-0" aria-hidden /> {short ? 'Fit' : `Fit to ${want}`} <span className="font-normal text-[var(--ds-muted)]">· Free</span>
    </GhostButton>
  );
};

// ── Page card ────────────────────────────────────────────────────────────────

export const PageCard: React.FC<{
  studio: StudioController;
  doc: ComicDoc;
  page: Page;
  selected: boolean;
  onToggleSelect: () => void;
  byok: boolean;
  cost?: CostFormat;
  compact?: boolean;
  rating?: ContentRating;
  /** Open the clip menu anchored at this card. */
  onMenu?: (anchor: Element | null) => void;
}> = ({ studio, doc, page, selected, onToggleSelect, byok, cost: costProp, compact = false, rating: ratingProp, onMenu }) => {
  const fallbackCost = useCostFormat(studio.caps);
  const cost = costProp ?? fallbackCost;
  const rating = ratingProp ?? effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const status = pageVisualStatus(doc, page);
  const [showScript, setShowScript] = useState(false);
  const { busyKey, fire } = useClickGuard();
  const asset = page.render.asset;
  const blocked = !!asset && !canServeToOwner(asset);
  // Grids use the ≤ 480w variant (contract §13.4); a blocked image is never even signed.
  const thumbW = variantCssWidth(THUMB_MAX_W);
  const imageUrl = blocked ? undefined : studio.urlFor(asset, { width: thumbW });
  const drawn = hasImage(page.render);
  const busy = isBusy(page.render);
  const spec = jobModel(doc, 'page');
  const price = estimateDraw(doc, pagesForIds(doc, [page.id]), byok).estimate.usd;
  const target: RenderTarget = { kind: 'page', id: page.id };
  const render = (safe = false) => fire('render', () => studio.act({ type: 'render_pages', pageIds: [page.id], force: true, ...(safe ? { safe: true } : {}) }));
  const open = () => studio.openPage(page.id);
  const scriptView = !compact && (status === 'planned' || status === 'empty' || (drawn && showScript));
  const mismatch = drawn && !blocked ? aspectMismatch(doc, asset) : null;
  const priceId = `price-${page.id}`;
  const press = cardPress(useLongPress({ onLongPress: (info) => onMenu?.(cardOf(info.target)), disabled: !onMenu }));

  const art = (
    <ComicPageView
      doc={doc}
      page={page}
      imageUrl={imageUrl}
      srcWidth={blocked ? undefined : () => imageUrl}
      alt={`Page ${page.n}`}
      overlay={
        <RenderOverlay
          status={status}
          since={page.render.updatedAt}
          render={page.render}
          label={`Page ${page.n}`}
          model={renderModelNickname(doc, busy ? undefined : page.render, 'page')}
          typicalSec={spec.latencySec}
          error={page.render.error}
          overImage={drawn && !!imageUrl}
          staleLabel="Out of date — re-render"
          compact
        />
      }
    />
  );

  return (
    <Surface
      as="article"
      aria-label={`Page ${page.n}`}
      data-testid="page-card"
      data-status={status}
      data-density={compact ? 'compact' : 'large'}
      {...press}
      className={cx('no-callout flex min-w-0 flex-col', compact ? 'p-1.5' : 'p-2.5', selected && 'ring-2 ring-[var(--ds-accent)] ring-offset-1 ring-offset-[var(--ds-canvas)]')}
    >
      <header className="mb-1.5 flex min-w-0 items-center gap-1 px-0.5">
        {/* A 44 px tap zone around a small visual box (mobile.md §3.1). */}
        <label className="-ml-1 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg hover:bg-[var(--ds-hover)] coarse:h-11 coarse:w-11">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            disabled={!page.panels.length}
            aria-label={`Select page ${page.n}`}
            className="h-3.5 w-3.5 accent-[#D97757] coarse:h-5 coarse:w-5"
          />
        </label>
        <h4 className="min-w-0 truncate text-[13px] font-semibold text-[var(--ds-ink)]" title={page.chapterTitle ? `Page ${page.n} · ${page.chapterTitle}` : undefined}>
          Page {page.n}
        </h4>
        {!compact && <StatusChip status={status} label={status === 'stale' ? 'Out of date' : undefined} className="shrink-0" />}
        <span className="ml-auto flex shrink-0 items-center">
          {drawn && !compact && (
            <IconButton size="sm" label={showScript ? 'Show the art' : 'Show the script'} onClick={() => setShowScript((v) => !v)}>
              {showScript ? <ImageIcon className="h-3.5 w-3.5" /> : <ScrollText className="h-3.5 w-3.5" />}
            </IconButton>
          )}
          {onMenu && (
            <IconButton size="sm" label={`Page ${page.n} actions`} aria-haspopup="menu" onClick={(e) => onMenu(cardOf(e.currentTarget))}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </span>
      </header>

      {scriptView ? (
        // Same footprint as the drawn page (rows stay aligned); long scripts scroll under a fade.
        <div
          className="max-h-[480px] overflow-y-auto overscroll-contain rounded-xl border border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] p-3 pb-7 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]"
          style={{ aspectRatio: String(pageAspectOf(doc, page)) }}
          tabIndex={0}
          aria-label={`Page ${page.n} script`}
        >
          <PageScript doc={doc} page={page} dense />
        </div>
      ) : (
        // A pointer shortcut into the editor; keyboard and screen-reader users have the Edit button
        // below (no nested interactive content, no name that hides the page's own text).
        <div onClick={open} className="relative block w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--ds-hairline)]" data-testid="page-art">
          {blocked ? (
            <div className="relative w-full" style={{ aspectRatio: String(pageAspectOf(doc, page)) }}>
              <div className="absolute inset-0">
                <SafetyVeil
                  asset={asset}
                  rating={rating}
                  onRedrawSafer={() => render(true)}
                  onCheckAgain={() => void studio.act({ type: 'safety_recheck', target })}
                >
                  {null}
                </SafetyVeil>
              </div>
            </div>
          ) : (
            <SafetyVeil
              asset={asset}
              rating={rating}
              onRedrawSafer={() => render(true)}
              onCheckAgain={() => void studio.act({ type: 'safety_recheck', target })}
              onChangeRating={() => studio.setTab('story')}
            >
              {art}
            </SafetyVeil>
          )}
          {mismatch && (
            <span className="pointer-events-none absolute left-1.5 top-1.5 z-[4] max-w-[calc(100%-0.75rem)]">
              <FrameBadge tone="warn" title={`This art came back ${mismatch.got}; the book's pages are ${mismatch.want}.`}>
                {mismatch.got} · book is {mismatch.want}
              </FrameBadge>
            </span>
          )}
        </div>
      )}

      {status === 'ready' && page.render.error && !compact && (
        <p className="mt-1.5 px-0.5 text-[11px] text-amber-700 dark:text-amber-300 [overflow-wrap:anywhere]">{page.render.error}</p>
      )}

      <footer className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 px-0.5">
        {!scriptView && !compact && page.summary && <p className="mb-1 line-clamp-2 w-full text-[12px] leading-snug text-[var(--ds-muted)]">{page.summary}</p>}
        {status === 'failed' ? (
          <PrimaryButton size="xs" busy={busyKey === 'render'} onClick={() => render()} aria-describedby={priceId}>
            <RotateCcw className="h-3 w-3" aria-hidden /> Retry
          </PrimaryButton>
        ) : status === 'stale' ? (
          <PrimaryButton size="xs" busy={busyKey === 'render'} onClick={() => render()} aria-describedby={priceId}>
            Re-render
          </PrimaryButton>
        ) : status === 'planned' ? (
          <GhostButton size="xs" busy={busyKey === 'render'} onClick={() => render()} aria-describedby={priceId}>
            Render
          </GhostButton>
        ) : status === 'ready' && !compact ? (
          <GhostButton size="xs" busy={busyKey === 'render'} onClick={() => render()} aria-describedby={priceId} title="Draw this page again from its script">
            Re-render
          </GhostButton>
        ) : null}
        {(status === 'failed' || status === 'stale' || status === 'planned' || (status === 'ready' && !compact)) && <PriceNote id={priceId}>{cost.quote(price)}</PriceNote>}
        {mismatch && <FitButton studio={studio} target={target} want={mismatch.want} disabled={busy} short={compact} />}
        {!compact && <VersionsButton studio={studio} target={target} label={`Page ${page.n}`} />}
        <GhostButton size="xs" onClick={open} aria-label={`${drawn ? 'Edit' : 'Open'} page ${page.n}`} className={compact ? '' : 'ml-auto'}>
          {drawn ? 'Edit' : 'Open'}
        </GhostButton>
      </footer>
    </Surface>
  );
};

// ── Cover ────────────────────────────────────────────────────────────────────

export const CoverCard: React.FC<{
  studio: StudioController;
  doc: ComicDoc;
  byok: boolean;
  cost?: CostFormat;
  rating?: ContentRating;
  compact?: boolean;
  onMenu?: (anchor: Element | null) => void;
  /** Controlled "Cover text" disclosure (the clip menu's "Cover title & tagline" opens it). */
  textOpen?: boolean;
  onTextOpenChange?: (open: boolean) => void;
}> = ({ studio, doc, byok, cost: costProp, rating: ratingProp, compact = false, onMenu, textOpen, onTextOpenChange }) => {
  const fallbackCost = useCostFormat(studio.caps);
  const cost = costProp ?? fallbackCost;
  const rating = ratingProp ?? effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const render = doc.cover.render;
  const status = render.status === 'none' ? 'planned' : sheetVisualStatus(render);
  const { busyKey, fire } = useClickGuard();
  const [ownDetails, setOwnDetails] = useState(false);
  const details = textOpen ?? ownDetails;
  const setDetails = (v: boolean) => (onTextOpenChange ? onTextOpenChange(v) : setOwnDetails(v));
  const a = render.asset;
  const src = frameSources(studio.urlFor, a, { sizes: '(max-width: 640px) 50vw, 260px' });
  const aspect = a?.w && a?.h ? a.w / a.h : aspectNumber(doc.format.pageAspect);
  const price = estimateOne(doc, 'cover', byok).usd;
  const spec = jobModel(doc, 'cover');
  const design = (safe = false) => fire('cover', () => studio.act({ type: 'render_cover', ...(safe ? { safe: true } : {}) }));
  const drawn = hasImage(render);
  const title = doc.cover.title || doc.brief.title;
  const mismatch = drawn && a && canServeToOwner(a) ? aspectMismatch(doc, a) : null;
  const priceId = 'price-cover';
  const press = cardPress(useLongPress({ onLongPress: (info) => onMenu?.(cardOf(info.target)), disabled: !onMenu }));

  return (
    <Surface
      as="article"
      aria-label="Cover"
      data-testid="cover-card"
      data-status={status}
      {...press}
      className={cx('no-callout flex min-w-0 flex-col', compact ? 'p-1.5' : 'p-2.5')}
    >
      <header className="mb-1.5 flex min-w-0 items-center gap-2 px-0.5">
        <BookImage className="h-3.5 w-3.5 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <h4 className="min-w-0 truncate text-[13px] font-semibold text-[var(--ds-ink)]">Cover</h4>
        {status !== 'planned' && !compact && <StatusChip status={status} className="shrink-0" />}
        {onMenu && (
          <IconButton size="sm" className="ml-auto" label="Cover actions" aria-haspopup="menu" onClick={(e) => onMenu(cardOf(e.currentTarget))}>
            <MoreHorizontal className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </header>
      <ImageFrame
        url={src.url}
        srcSet={src.srcSet}
        sizes={src.sizes}
        heavy={src.heavy}
        aspect={aspect}
        alt={`Cover of ${title}`}
        render={render}
        tone="paper"
        safety={{
          rating,
          onRedrawSafer: () => design(true),
          onCheckAgain: () => void studio.act({ type: 'safety_recheck', target: { kind: 'cover' } }),
          onChangeRating: () => studio.setTab('story')
        }}
        badges={
          mismatch ? (
            <FrameBadge tone="warn" title={`This art came back ${mismatch.got}; the book's pages are ${mismatch.want}.`}>
              {mismatch.got} · book is {mismatch.want}
            </FrameBadge>
          ) : undefined
        }
        placeholder={
          <div className="flex h-full flex-col items-center justify-center gap-2 border-2 border-dashed border-[var(--ds-hairline)] bg-[var(--ds-well)] p-4 text-center">
            <p className="line-clamp-3 text-[15px] font-semibold leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{title}</p>
            {doc.cover.tagline && !compact && <p className="line-clamp-2 text-[12px] text-[var(--ds-muted)]">{doc.cover.tagline}</p>}
            {!compact && <p className="mt-1 text-[11px] text-[var(--ds-muted)]">The cover is drawn with the title lettered in.</p>}
          </div>
        }
        overlay={
          <RenderOverlay
            status={status}
            since={render.updatedAt}
            render={render}
            label="Cover"
            model={renderModelNickname(doc, isBusy(render) ? undefined : render, 'cover')}
            typicalSec={spec.latencySec}
            error={render.error}
            onRetry={() => design()}
            overImage={drawn && !!src.url}
            compact
          />
        }
      />
      <footer className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 px-0.5">
        <GhostButton size="xs" busy={busyKey === 'cover'} disabled={isBusy(render)} onClick={() => design()} aria-describedby={priceId}>
          <Sparkles className={cx('h-3 w-3', !drawn && 'text-[var(--ds-accent)]')} aria-hidden /> {drawn ? 'Redesign' : 'Design cover'}
        </GhostButton>
        <PriceNote id={priceId}>{cost.quote(price)}</PriceNote>
        {mismatch && <FitButton studio={studio} target={{ kind: 'cover' }} want={mismatch.want} disabled={isBusy(render)} short={compact} />}
        {!compact && <VersionsButton studio={studio} target={{ kind: 'cover' }} label="Cover" />}
        {!compact && (
          <GhostButton size="xs" onClick={() => setDetails(!details)} aria-expanded={details}>
            Cover text {details ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </GhostButton>
        )}
      </footer>
      {details && (
        <div className="mt-2 space-y-1 rounded-xl bg-[var(--ds-well)] p-2">
          <InlineField
            label="Title on the cover"
            showLabel
            multiline
            rows={1}
            submitOnEnter
            value={doc.cover.title || ''}
            placeholder={doc.brief.title}
            maxLength={200}
            onCommit={(v) => void studio.patch([{ op: 'cover', patch: { title: v } }])}
          />
          <InlineField
            label="Tagline"
            showLabel
            multiline
            rows={1}
            submitOnEnter
            value={doc.cover.tagline || ''}
            placeholder="A short line under the title"
            maxLength={200}
            onCommit={(v) => void studio.patch([{ op: 'cover', patch: { tagline: v } }])}
          />
          <InlineField
            label="Cover direction"
            showLabel
            multiline
            value={doc.cover.direction || ''}
            placeholder="What the cover shows (default: the story’s key moment with the leads)"
            onCommit={(v) => void studio.patch([{ op: 'cover', patch: { direction: v } }])}
          />
        </div>
      )}
    </Surface>
  );
};

// ── Header ───────────────────────────────────────────────────────────────────

const PlanHeader: React.FC<{
  studio: StudioController;
  doc: ComicDoc;
  byok: boolean;
  cost: CostFormat;
  selected: Set<string>;
  clearSelection: () => void;
  density: PagesDensity;
  onDensity: (d: PagesDensity) => void;
}> = ({ studio, doc, byok, cost, selected, clearSelection, density, onDensity }) => {
  const { busyKey, fire } = useClickGuard(3000);
  const [includeCover, setIncludeCover] = useState(false);
  // Quoted exactly as the server's gate quotes render_pages (same targets, same registry estimate).
  const quote = quoteRenderPages(doc, { includeCover, byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
  const chosen = estimateDraw(doc, pagesForIds(doc, selected), byok);
  const drawing = doc.pages.filter((p) => isBusy(p.render)).length;
  const drawn = doc.pages.filter((p) => pageVisualStatus(doc, p) === 'ready').length;
  const panels = totalPanels(doc);
  const draft = doc.planStatus !== 'approved';
  const coverOffer = coverNeedsDraw(doc) && !isBusy(doc.cover.render);
  const toDraw = quote.pageIds.length;
  const what = [plural(toDraw, 'page'), quote.sheetIds.length ? plural(quote.sheetIds.length, 'character sheet') : '', quote.cover ? 'the cover' : ''].filter(Boolean).join(' + ');

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
            {draft ? 'Plan draft — review the scripts, then render' : `${drawn} of ${plural(doc.pages.length, 'page')} drawn`}
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
            {plural(doc.pages.length, 'page')} · {plural(panels, 'panel')}
            {draft ? ' · nothing is drawn until you approve' : ''}
            {drawing ? ` · drawing ${drawing} now` : ''}
            {` · ${quote.model}${byok ? ' · your key' : ''}`}
          </p>
        </div>
        <Segmented<PagesDensity>
          label="Card size"
          size="xs"
          value={density}
          onChange={onDensity}
          options={[
            { value: '1', label: 'Large', title: 'Large cards with scripts and versions' },
            { value: '2', label: 'Compact', title: 'Small cards — see more pages at once' }
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {toDraw > 0 && (
          <>
            <PrimaryButton
              size="sm"
              busy={busyKey === 'all'}
              onClick={() => fire('all', () => studio.act({ type: 'render_pages', ...(quote.cover ? { includeCover: true } : {}) }))}
              title={what}
              aria-describedby="pages-draw-all-price"
            >
              {draft ? 'Approve & render all' : `Render ${toDraw === doc.pages.length ? 'all' : `remaining ${toDraw}`}`}
            </PrimaryButton>
            <PriceNote id="pages-draw-all-price">
              {cost.quote(quote.usd)} · {what}
            </PriceNote>
          </>
        )}
        {draft && (
          <GhostButton size="sm" busy={busyKey === 'approve'} onClick={() => fire('approve', () => studio.act({ type: 'approve_plan' }))}>
            Approve plan only
          </GhostButton>
        )}
        {drawn > 0 && drawn === doc.pages.length && (
          <GhostButton size="sm" onClick={() => studio.setTab('read')}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden /> Read the comic
          </GhostButton>
        )}
      </div>
      {toDraw > 0 && coverOffer && (
        <label className="flex min-h-[36px] w-fit max-w-full cursor-pointer items-center gap-2 rounded-xl px-1 text-[12.5px] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:min-h-[44px]">
          <input type="checkbox" checked={includeCover} onChange={(e) => setIncludeCover(e.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-[#D97757] coarse:h-5 coarse:w-5" />
          <span className="min-w-0">
            Include the cover <span className="text-[var(--ds-muted)]">({cost.quote(estimateOne(doc, 'cover', byok).usd)})</span>
          </span>
        </label>
      )}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--ds-well)] px-3 py-2" role="region" aria-label="Selected pages">
          <span className="text-[12px] font-medium text-[var(--ds-ink)]">{plural(selected.size, 'page')} selected</span>
          <PrimaryButton
            size="xs"
            busy={busyKey === 'selected'}
            disabled={!chosen.pages.length}
            aria-describedby="pages-selected-price"
            onClick={() => {
              const ids = chosen.pages.map((p) => p.id);
              fire('selected', () => studio.act({ type: 'render_pages', pageIds: ids, force: true }));
              clearSelection();
            }}
          >
            Render selected
          </PrimaryButton>
          <PriceNote id="pages-selected-price">{cost.quote(chosen.estimate.usd)}</PriceNote>
          <GhostButton size="xs" onClick={clearSelection}>
            Clear
          </GhostButton>
        </div>
      )}
    </div>
  );
};

// ── Book (software pages, free) ──────────────────────────────────────────────

export const BookSection: React.FC<{ studio: StudioController; doc: ComicDoc; edit: TimelineEdit }> = ({ studio, doc, edit }) => {
  const book = bookOf(doc);
  const [plate, setPlate] = useState<PlateKind | null>(null);
  const set = (patch: Partial<BookSettings>, message: string) => edit.commit([{ op: 'book', patch }], message, { label: 'Change book pages' });
  const thumb = (kind: PlateKind) => (
    <span className="block w-9 shrink-0 overflow-hidden rounded-md border border-[var(--ds-hairline)]" aria-hidden>
      <PlateView doc={doc} kind={kind} urlFor={(p) => studio.urlFor(p, { width: 120 })} decorative />
    </span>
  );
  const editBtn = (kind: PlateKind, label: string) => (
    <GhostButton size="xs" onClick={() => setPlate(kind)} aria-label={`${label}: ${PLATE_LABEL[kind]}`}>
      {label}
    </GhostButton>
  );
  return (
    <Surface className="p-3 sm:p-4" aria-label="Book pages">
      <SectionTitle icon={<BookOpen className="h-3.5 w-3.5" />} right={<span className="text-[11px] font-medium normal-case tracking-normal text-[var(--ds-muted)]">Free — made by the editor, no AI cost</span>}>
        Book
      </SectionTitle>
      <div className="grid gap-1 md:grid-cols-2">
        <div className="flex min-w-0 items-center gap-2">
          {book.titlePage && thumb('title')}
          <SwitchRow
            className="min-w-0 flex-1"
            label="Title page"
            description="The cover title and tagline on a page of their own"
            checked={book.titlePage}
            onChange={(on) => set({ titlePage: on }, on ? 'Title page added — free, made by software' : 'Title page hidden')}
            after={book.titlePage ? editBtn('title', 'Preview') : undefined}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {book.endPage && thumb('end')}
          <SwitchRow
            className="min-w-0 flex-1"
            label="“The End” page"
            description="A closing page with your credits"
            checked={book.endPage}
            onChange={(on) => set({ endPage: on }, on ? '“The End” added — free, made by software' : '“The End” hidden')}
            after={book.endPage ? editBtn('end', 'Credits') : undefined}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {book.backCover === 'auto' && thumb('back_cover')}
          <SwitchRow
            className="min-w-0 flex-1"
            label="Back cover"
            description="Your blurb on the back (defaults to the logline)"
            checked={book.backCover === 'auto'}
            onChange={(on) => set({ backCover: on ? 'auto' : 'none' }, on ? 'Back cover added — free, made by software' : 'Back cover hidden')}
            after={book.backCover === 'auto' ? editBtn('back_cover', 'Blurb') : undefined}
          />
        </div>
        <SwitchRow
          label="Page 1 on the right"
          description="How two-page spreads pair up, like a printed book"
          checked={book.firstPageRight}
          onChange={(on) => set({ firstPageRight: on }, on ? 'Page 1 now starts on the right' : 'Page 1 now starts on the left')}
        />
        <SwitchRow
          label="Same trim for every page"
          description="Exports letterbox odd-shaped art to the book’s page size"
          checked={book.uniformTrim}
          onChange={(on) => set({ uniformTrim: on }, on ? 'Exports use one trim size' : 'Exports keep each image’s own shape')}
        />
      </div>
      <TimelineDialog open={!!plate} onClose={() => setPlate(null)} title={plate ? `${PLATE_LABEL[plate]} · free` : ''}>
        {plate && (
          <PlateEditor
            doc={doc}
            kind={plate}
            urlFor={(p) => studio.urlFor(p, { width: 360 })}
            onSave={(patch) => edit.commit([{ op: 'book', patch }], `${PLATE_LABEL[plate]} updated`, { label: 'Change book pages' })}
            onEditCover={() => setPlate(null)}
            onClose={() => setPlate(null)}
          />
        )}
      </TimelineDialog>
    </Surface>
  );
};

// ── Tab ──────────────────────────────────────────────────────────────────────

type VersionsDialog = { target: RenderTarget; title: string; compare: boolean };

export const PagesTab: React.FC<{ studio: StudioController; doc: ComicDoc }> = ({ studio, doc }) => {
  const byok = byokFromDoc(doc);
  const cost = useCostFormat(studio.caps);
  const ff = useFormFactor();
  const rating = effectiveRating(doc, studio.caps?.ratingCeiling).rating;
  const pages = useMemo(() => sortedPages(doc), [doc]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [density, setDensityState] = useState<PagesDensity>(() => readDensity(ff.widthClass === 'compact' ? '2' : '1'));
  const [menu, setMenu] = useState<{ key: string; rect: DOMRect | null } | null>(null);
  const [versions, setVersions] = useState<VersionsDialog | null>(null);
  const [coverText, setCoverText] = useState(false);
  const [notice, setNotice] = useState('');
  const edit = useTimelineEdit(studio);
  const { busyKey, fire } = useClickGuard(4000);
  const compact = density === '2';
  const setDensity = (d: PagesDensity) => {
    setDensityState(d);
    storeDensity(d);
  };

  // Drop selections for pages that left the plan.
  const ids = pages.map((p) => p.id).join('|');
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(ids.split('|'));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── Clip menu (the timeline's actions, on the cards) ───────────────────────
  const clips = useMemo(() => bookClips(doc), [doc]);
  const menuClip = menu ? clips.find((c) => c.key === menu.key) ?? null : null;
  const maxPages = Math.min(DOC_LIMITS.pages, studio.caps?.maxPages ?? DOC_LIMITS.pages);
  const openMenu = (key: string, anchor: Element | null) => setMenu({ key, rect: anchor ? anchor.getBoundingClientRect() : null });
  const pageIndex = (key: string) => pages.findIndex((p) => p.id === key);
  const menuItems = (clip: ClipVM | null): ClipMenuItem[] => {
    if (!clip) return [];
    const idx = pageIndex(clip.key);
    const redrawUsd = redrawPrice(doc, 'page', byok);
    const coverUsd = redrawPrice(doc, 'cover', byok);
    const planUsd = PLAN_USD_PER_PAGE * (byok ? 1 : PLATFORM_MARKUP);
    // The registry prices, printed for THIS user (governed users never see dollars).
    return clipMenuItems(clip, { redrawUsd, coverUsd, canMoveLeft: idx > 0, canMoveRight: idx >= 0 && idx < pages.length - 1, canAddPage: canAddPage(doc, maxPages), pageCount: pages.length }).map(
      (it) =>
        it.action === 'redraw'
          ? { ...it, meta: cost.quote(redrawUsd) }
          : it.action === 'cover_redesign'
            ? { ...it, meta: cost.quote(coverUsd) }
            : it.action === 'write'
              ? { ...it, meta: cost.quote(planUsd) }
              : it
    );
  };
  const runAction = (clip: ClipVM, action: ClipAction) => {
    const page = clip.page;
    switch (action) {
      case 'open':
        if (clip.kind === 'page') studio.openPage(clip.key);
        return;
      case 'versions':
      case 'compare':
        if (!clip.target || clip.versions === 0) return setNotice(`${clip.label} isn't drawn yet — nothing to pick from.`);
        return setVersions({ target: clip.target, title: `${clip.label} · versions`, compare: action === 'compare' });
      case 'redraw':
        if (!page) return;
        return void studio.act({ type: 'render_pages', pageIds: [page.id], ...(clip.drawn ? { force: true } : {}) });
      case 'fit':
        if (!clip.target) return;
        return void studio.act({ type: 'fit_render', target: clip.target, mode: 'auto' });
      case 'duplicate': {
        if (!page) return;
        if (clip.busy) return setNotice(`Page ${page.n} is still drawing — duplicate it when it's done.`);
        if (!canAddPage(doc, maxPages)) return setNotice(`This comic is at its ${maxPages}-page limit.`);
        edit.commit(duplicateOps(page.id, newId('pg')), `Copied page ${page.n}`, { label: 'Duplicate page' });
        return;
      }
      case 'insert': {
        if (!canAddPage(doc, maxPages)) return setNotice(`This comic is at its ${maxPages}-page limit.`);
        const after = clip.kind === 'page' ? page?.n ?? pages.length : 0;
        edit.commit(insertOps(after, newId('pg')), `Added a blank page ${after + 1}`, { label: 'Add a page' });
        return;
      }
      case 'write':
        if (!page) return;
        return void studio.send(`Write page ${page.n} for me${page.summary ? `: ${page.summary}` : ''}`);
      case 'move_left':
      case 'move_right': {
        if (!page) return;
        const from = pageIndex(page.id);
        const to = from + (action === 'move_left' ? -1 : 1);
        const ops = moveOps(doc, page.id, to);
        if (!ops.length) return;
        edit.commit(ops, `Moved page ${page.n} → ${to + 1}`, { label: 'Move page' });
        return;
      }
      case 'delete':
        if (!page) return;
        if (clip.busy) return setNotice(`Page ${page.n} is still drawing — delete it when it's done (its image is paid for).`);
        if (pages.length <= 1) return setNotice('A comic needs at least one page.');
        if (studio.focusedPageId === page.id) studio.openPage(null);
        edit.commit(deleteOps(page.id), `Page ${page.n} deleted`, { label: 'Delete page' });
        return;
      case 'cover_redesign':
        return void studio.act({ type: 'render_cover' });
      case 'cover_text':
        return setCoverText(true);
      default:
        return;
    }
  };

  if (!pages.length) {
    return (
      <div className="p-4 sm:p-5">
        <EmptyHint
          icon={<EmptyIllustration variant="pages" />}
          title="No pages planned yet"
          action={
            <PrimaryButton size="sm" busy={busyKey === 'plan'} onClick={() => fire('plan', () => studio.act({ type: 'plan_pages' }))}>
              Plan the pages
            </PrimaryButton>
          }
        >
          When the story is ready, the director writes a script for every page — panels, shots and dialogue — and they appear here for you to
          review. Planning costs a little writing ({cost.quote(PLAN_USD_PER_PAGE * Math.max(1, doc.format.pageCount || 1) * (byok ? 1 : PLATFORM_MARKUP))}); nothing is
          drawn until you approve.
        </EmptyHint>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <PlanHeader
        studio={studio}
        doc={doc}
        byok={byok}
        cost={cost}
        selected={selected}
        clearSelection={() => setSelected(new Set())}
        density={density}
        onDensity={setDensity}
      />
      {notice && (
        <p role="status" className="rounded-xl bg-[var(--ds-well)] px-3 py-2 text-[12px] text-[var(--ds-ink)]">
          {notice}
        </p>
      )}
      <div className={GRID[density]} data-pages-grid={density}>
        <CoverCard
          studio={studio}
          doc={doc}
          byok={byok}
          cost={cost}
          rating={rating}
          compact={compact}
          onMenu={(anchor) => openMenu('cover', anchor)}
          textOpen={coverText}
          onTextOpenChange={setCoverText}
        />
        {pages.map((page) => (
          <PageCard
            key={page.id}
            studio={studio}
            doc={doc}
            page={page}
            byok={byok}
            cost={cost}
            rating={rating}
            compact={compact}
            selected={selected.has(page.id)}
            onToggleSelect={() => toggle(page.id)}
            onMenu={(anchor) => openMenu(page.id, anchor)}
          />
        ))}
      </div>
      <BookSection studio={studio} doc={doc} edit={edit} />
      <ClipMenu
        open={!!menuClip}
        onClose={() => setMenu(null)}
        clip={menuClip}
        anchor={menu?.rect ?? null}
        items={menuItems(menuClip)}
        onAction={(a) => menuClip && runAction(menuClip, a)}
      />
      <TimelineDialog open={!!versions} onClose={() => setVersions(null)} title={versions?.title ?? ''} wide>
        {versions && <VersionStack studio={studio} target={versions.target} initialCompare={versions.compare} />}
      </TimelineDialog>
      <UndoToast entry={edit.toast} onUndo={edit.undo} onDismiss={edit.dismiss} />
    </div>
  );
};

