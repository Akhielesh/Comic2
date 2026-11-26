// "renders" card: one run of images (pages, the cover, sheets, style options) as ONE compact progress card
// (quick2 Q-PROG). Before, a run of eight pages put eight loading tiles in the chat, each with its own shimmer, pill,
// clock and model line: a wall of spinners as tall as a phone. Now, while the run draws:
//
//   Drawing pages · 3 of 8 · pages 4 and 5 · 12s                    Details
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  (thin, determinate)
//   [p1][p2][p3][ 4 ][ 5 ][ 6 ][ 7 ][ 8 ]   one strip of small thumbnails that fill in as pages land
//   Page 5 didn't draw · rate limited                       Retry ≈ $0.06
//
// "Details" (collapsed by default) lists every target with its state and time; one run of one page reads "Drawing
// page 3 · 12s" with just that page (no "1 of 1", no bar). Once nothing is queued or drawing, the card is one line:
// "8 pages drawn · View" (no picture, no spinner, no clock), plus the failure line when something didn't draw. Only a
// picture this run drew and the owner can see counts as drawn: "7 of 8 pages drawn · 1 withheld", "5 of 8 pages drawn ·
// 3 show earlier pictures" (a stopped redraw), "3 pages not drawn" (stopped before anything landed; no View).
//
// Everything is read from the stored doc (renderProgress.ts), so a remount — the studio reloading the doc — shows the
// same card; the Details choice is kept per card for the session. No shimmer anywhere (reduced motion or not): the
// placeholders are still, and the one live pulse rides the shared tile clock (renderTile.tsx), so a run and a style
// board drawing beside it still show one pulse between them. That clock never fetches, keeps ticking while any target
// still draws normally, and stops when nothing does. Each render reads the time once, so the headline, the stuck line
// and Details never disagree with the clock that decides whether to keep ticking.
//
// Failures read calm (reliability.md §3): one quiet line names what didn't draw and the main reason; the provider's
// words are under Details. Its Retry covers EVERY failed kind in the card — pages, sheets, places, style options and the
// cover (the 2026-10-22 outage left three failed style tests with no way to retry them together) — and carries its
// honest quote (quotedUsd), so a stale card re-quotes instead of overspending. It works while the rest of the run still
// draws: the server queues the retry behind the comic's image slots. Thumbnails load the ≤ 480w variant (lazy), never
// the original (perf F2).

import React, { useId, useState } from 'react';
import { Check, ChevronDown, CircleAlert, EyeOff, ImageIcon, ImageOff, RotateCcw } from 'lucide-react';
import type { Card, ComicDoc, RenderState, RenderTarget } from '../../../../shared/comic/doc';
import type { SpendAction } from '../../../../shared/comic/ops';
import { estimateDocJobs, quoteRenderPages } from '../../../../shared/comic/plan';
import { canServeToOwner } from '../../../../shared/comic/safety';
import { cn } from '../../../../lib/utils';
import { FOCUS_RING, HAIRLINE, INK, MUTED, RADIUS_CONTROL, RADIUS_PANEL, SHADOW_SOFT, TONE_TEXT } from '../../../chat/studioDesign';
import { Button } from '../../../ds/Button';
import { Collapse } from '../../../ds/Collapse';
import { LiveDot } from '../../../ds/LiveDot';
import { Progress } from '../../../ds/Progress';
import { ImageDevelop } from '../../../studio/kit/streamMotion';
import { studioRefresh } from '../../board/ui';
import type { ComicStudioController } from '../../useStudio';
import { useCostFormat } from '../cost';
import type { PriceBook } from '../../../../shared/comic/modelLock';
import { useStudioPrices } from '../../usage/useStudioPrices';
import { failureCaption, failureFacts, failureReason, formatFailedAt } from './failure';
import {
  capitalize,
  doneLine,
  failedNames,
  failedReason,
  headlineText,
  itemName,
  runHeadline,
  runProgress,
  stateWord,
  type ProgressItem,
  type RunProgress
} from './renderProgress';
import { isFreshRender, tileProgress, tileSources, unsignableOf, useTileClockLead, type TileSources } from './renderTile';
import { useAction, useStudioSequenceGuard } from './useAction';

type RendersCardData = Extract<Card, { type: 'renders' }>;

export interface FailedItem {
  target: RenderTarget;
  render?: RenderState;
}

/**
 * The spend actions that redraw every failed target in one go (sequential), with a quote.
 * Pages use the server gate's own targeting (shared/comic/plan.ts) so missing sheets are
 * included honestly; the rest use the registry estimate. Every quote prices the comic's locked model.
 */
export const retryAllFailed = (
  doc: ComicDoc,
  failed: FailedItem[],
  byok: boolean,
  /** The person's PriceBook (the studio's price sheet): the retry names the price its run is drawn at. */
  prices?: PriceBook
): { actions: SpendAction[]; usd: number; count: number } => {
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const priced = prices ? { prices } : {};
  const actions: SpendAction[] = [];
  let usd = 0;

  const pageIds = failed.filter((f) => f.target.kind === 'page').map((f) => (f.target as { id: string }).id);
  // Sheets the page retry draws first anyway (missing sheets of those pages, billed in its quote).
  const drawnByPages = new Set<string>();
  if (pageIds.length) {
    const q = quoteRenderPages(doc, { pageIds, force: true, byok, tier, modelOverride: override, ...priced });
    actions.push({ type: 'render_pages', pageIds, force: true, quotedUsd: q.usd });
    usd += q.usd;
    for (const id of q.sheetIds) drawnByPages.add(id);
  }

  // A failed sheet the page retry already redraws must not be force-drawn (and billed) a second time.
  const sheetItems = failed.filter((f) => (f.target.kind === 'sheet' || f.target.kind === 'place') && !drawnByPages.has((f.target as { id: string }).id));
  const sheetIds = sheetItems.map((f) => (f.target as { id: string }).id);
  if (sheetIds.length) {
    // One render_sheets covers characters and places (the server splits them); price each kind.
    const places = sheetItems.filter((f) => f.target.kind === 'place').length;
    const chars = sheetIds.length - places;
    const est = estimateDocJobs(
      doc,
      [...(chars ? [{ kind: 'sheet' as const, count: chars }] : []), ...(places ? [{ kind: 'place' as const, count: places }] : [])],
      { byok, tier, modelOverride: override, ...priced }
    );
    actions.push({ type: 'render_sheets', characterIds: sheetIds, force: true, quotedUsd: est.usd });
    usd += est.usd;
  }

  const directions = failed
    .filter((f) => f.target.kind === 'style_option')
    .map((f) => doc.style.options.find((o) => o.id === (f.target as { id: string }).id))
    .filter((o): o is NonNullable<typeof o> => !!o)
    .map((o) => ({ name: o.name, spec: o.spec }));
  if (directions.length) {
    const est = estimateDocJobs(doc, [{ kind: 'style_option', count: directions.length }], { byok, tier, modelOverride: override, ...priced });
    actions.push({ type: 'render_style_options', directions, quotedUsd: est.usd });
    usd += est.usd;
  }

  if (failed.some((f) => f.target.kind === 'cover')) {
    const est = estimateDocJobs(doc, [{ kind: 'cover', count: 1 }], { byok, tier, modelOverride: override, ...priced });
    actions.push({ type: 'render_cover', quotedUsd: est.usd });
    usd += est.usd;
  }

  return { actions, usd: Math.round(usd * 10000) / 10000, count: failed.length };
};

/** One calm sentence about the failures: when the latest happened and the main reason. */
export const failureSummary = (failed: FailedItem[], now: number = Date.now()): string => {
  if (!failed.length) return '';
  const facts = failed.map((f) => failureFacts(f.render));
  const latest = facts.reduce<number | undefined>((t, f) => (typeof f.at === 'number' && (t === undefined || f.at > t) ? f.at : t), undefined);
  const reasons = new Map<string, number>();
  for (const f of facts) {
    const r = failureReason(f.error);
    reasons.set(r, (reasons.get(r) || 0) + 1);
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const when = formatFailedAt(latest, now);
  const what = failed.length === 1 ? '1 image didn’t finish' : `${failed.length} images didn’t finish`;
  const detail = [when, top].filter(Boolean).join(' · ');
  return `${what}${detail ? ` (${detail})` : ''}. Retry when you’re ready — only ${failed.length === 1 ? 'that one is' : 'these are'} redrawn.`;
};

// ── The card ──────────────────────────────────────────────────────────────────

/** Details stays as the creator left it across a remount (the studio reloading the doc): per card, this session. */
const detailsOpen = new Map<string, boolean>();
const DETAILS_KEPT = 200;
/** Forget every card's Details choice (tests start each case from a fresh session). */
export const resetRendersDetails = (): void => detailsOpen.clear();
const rememberDetails = (cardId: string, open: boolean) => {
  detailsOpen.delete(cardId);
  detailsOpen.set(cardId, open);
  if (detailsOpen.size > DETAILS_KEPT) {
    const oldest = detailsOpen.keys().next().value;
    if (typeof oldest === 'string') detailsOpen.delete(oldest);
  }
};

/** Where one target's picture opens (the chat's controller reveals the board on phones). */
const openerFor = (studio: ComicStudioController, target: RenderTarget): (() => void) | undefined => {
  switch (target.kind) {
    case 'page':
      return () => studio.openPage(target.id);
    case 'sheet':
    case 'place':
      return () => studio.setTab('cast');
    case 'style_option':
      return () => studio.setTab('style');
    case 'cover':
      return () => studio.setTab('read');
    default:
      return undefined;
  }
};

/** "View" for the whole run: the one target, or the board tab that shows the run's pictures. */
const viewFor = (studio: ComicStudioController, p: RunProgress): { run: () => void; label: string } | null => {
  if (p.total === 1) {
    const open = openerFor(studio, p.items[0].target);
    return open ? { run: open, label: `View ${itemName(p.items[0])}` } : null;
  }
  switch (p.kind) {
    case 'sheets':
    case 'places':
    case 'cast':
      return { run: () => studio.setTab('cast'), label: 'View the cast' };
    case 'styles':
      return { run: () => studio.setTab('style'), label: 'View the style options' };
    default:
      return { run: () => studio.setTab('pages'), label: 'View the pages' };
  }
};

/** A thumbnail's `sizes`: it is 56 px tall in the chat, so the ≤ 480w variant is always enough. */
const THUMB_SIZES = '64px';
const THUMB = cn('relative h-14 min-w-11 shrink-0 overflow-hidden bg-[var(--ds-well)]', RADIUS_CONTROL, HAIRLINE);

/** One target in the strip: its picture once drawn (tap to open), else a still placeholder with its page number. */
const ProgressThumb: React.FC<{ item: ProgressItem; src: TileSources; onOpen?: () => void }> = ({ item, src, onOpen }) => {
  const render = item.render;
  const name = capitalize(itemName(item));
  const blocked = !!render?.asset?.path && !canServeToOwner(render.asset);
  // A picture is on the page: drawn by this run, an earlier one, or one the content check withheld.
  const drawn = (item.state === 'drawn' || item.state === 'kept' || item.state === 'withheld') && !!render?.asset?.path;
  const style = { aspectRatio: item.meta.aspect };
  let body: React.ReactNode;
  if (drawn && !blocked && src.url) {
    // Keyed by the stored file, like the board's frames: a redraw landing here develops in; a re-signed URL does not.
    body = (
      <ImageDevelop key={render?.asset?.path} active={isFreshRender(render)} className="h-full w-full" rounded="rounded-none">
        <img
          src={src.url}
          srcSet={src.srcSet}
          sizes={src.srcSet ? THUMB_SIZES : undefined}
          alt={name}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
          {...(src.heavy ? { 'data-heavy-img': '' } : {})}
        />
      </ImageDevelop>
    );
  } else if (drawn && blocked) {
    body = <EyeOff className={cn('size-3.5', MUTED)} aria-hidden />;
  } else if (drawn && src.unavailable) {
    body = <ImageOff className={cn('size-3.5', MUTED)} aria-hidden />;
  } else if (drawn) {
    // Its small file is still being signed: a quiet, still box (never a shimmer).
    body = null;
  } else if (item.state === 'failed') {
    body = <CircleAlert className={cn('size-3.5', MUTED)} aria-hidden />;
  } else {
    body =
      typeof item.n === 'number' ? (
        <span className="text-[11px] font-semibold tabular-nums">{item.n}</span>
      ) : (
        <ImageIcon className="size-3.5" aria-hidden />
      );
  }
  const frame = cn(
    THUMB,
    'grid place-items-center',
    item.state === 'drawing' ? 'border-[var(--ds-ink)] text-[var(--ds-ink)]' : MUTED,
    (item.state === 'queued' || item.state === 'idle') && 'border-dashed'
  );
  if (drawn && !blocked && onOpen) {
    return (
      <button
        type="button"
        data-progress-thumb=""
        data-state="drawn"
        onClick={onOpen}
        aria-label={`Open ${itemName(item)}${src.unavailable ? ' (preview unavailable here)' : ''}`}
        className={cn(frame, 'p-0', FOCUS_RING)}
        style={style}
      >
        {body}
      </button>
    );
  }
  const word = drawn && !blocked && src.unavailable ? 'preview unavailable here' : stateWord(item.state).toLowerCase();
  return (
    <div role="img" aria-label={`${name}: ${word}`} data-progress-thumb="" data-state={item.state} className={frame} style={style}>
      {body}
    </div>
  );
};

/** What one target says in Details: its state, its time while drawing, and a failure's when, why and provider words. */
const DetailRow: React.FC<{ item: ProgressItem; now: number; withModel: boolean }> = ({ item, now, withModel }) => {
  const name = capitalize(itemName(item));
  const time = item.state === 'drawing' ? tileProgress('rendering', item.render?.updatedAt, now, item.meta.typicalSec) : null;
  const timeWords = time ? [time.elapsed, time.hint].filter(Boolean).join(' · ') : '';
  const facts = item.state === 'failed' ? failureFacts(item.render) : null;
  return (
    <li className="min-w-0 [overflow-wrap:anywhere]">
      <span className={cn('font-medium', INK)}>{name}</span>
      <span> · {stateWord(item.state)}</span>
      {(item.state === 'drawn' || item.state === 'kept') && item.meta.stale && <span> · out of date</span>}
      {timeWords && <span className="tabular-nums"> · {timeWords}</span>}
      {withModel && item.meta.model && <span> · {item.meta.model}</span>}
      {facts && <span> · {failureCaption(facts.error, facts.at, now)}</span>}
      {facts && (facts.error || facts.facts) && (
        <span className="block">
          {facts.error}
          {facts.facts ? ` — ${facts.facts}` : ''}
          {facts.attempts && facts.attempts > 1 ? ` (${facts.attempts} tries)` : ''}
        </span>
      )}
    </li>
  );
};

interface FailureLineProps {
  p: RunProgress;
  doc: ComicDoc;
  byok: boolean;
  onRetry: (actions: SpendAction[]) => void;
  retrying: boolean;
  approx: (usd: number) => string;
  /** The finished card's "Details" toggle (the provider's words for what failed); the run in flight has its own. */
  details?: React.ReactNode;
  prices?: PriceBook;
}

/** "Page 5 didn’t draw · rate limited      Retry ≈ $0.06": one quiet line for every failure in the run. */
const FailureLine: React.FC<FailureLineProps> = ({ p, doc, byok, onRetry, retrying, approx, details, prices }) => {
  const retry = retryAllFailed(
    doc,
    p.failed.map((f): FailedItem => ({ target: f.target, render: f.render })),
    byok,
    prices
  );
  const reason = failedReason(p.failed);
  const label = p.failed.length === 1 ? `Retry ${itemName(p.failed[0])}` : `Retry ${p.failed.length} failed ${p.kind === 'pages' ? 'pages' : 'images'}`;
  return (
    <div data-renders-failed="" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-snug">
      <CircleAlert className={cn('size-3.5 shrink-0', MUTED)} aria-hidden />
      <span className={cn('min-w-0 flex-[1_1_10rem] [overflow-wrap:anywhere]', INK)}>
        {failedNames(p.failed)} didn’t draw
        {reason && <span className={MUTED}> · {reason}</span>}
      </span>
      {retry.actions.length > 0 && (
        // Never wider than the line: a long label truncates inside Retry and the price wraps under it.
        <span className="inline-flex max-w-full shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {/* Usable mid-run: the server draws the retry once one of the comic's image slots is free. */}
          <Button variant="outline" size="sm" loading={retrying} aria-label={label} onClick={() => onRetry(retry.actions)}>
            <RotateCcw aria-hidden />
            Retry
          </Button>
          <span className={cn('tabular-nums', MUTED)}>{approx(retry.usd)}</span>
        </span>
      )}
      {details}
    </div>
  );
};

export const RendersCard: React.FC<{ card: RendersCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const doc = studio.doc;
  // Retry runs one spend per failed kind; it stops at the first one that didn't go through.
  const guard = useStudioSequenceGuard(studio);
  const { run, isPending } = useAction(studio.act, { guard });
  const cost = useCostFormat(studio);
  const prices = useStudioPrices(studio);
  const [open, setOpen] = useState(() => detailsOpen.get(card.id) === true);
  const detailsId = useId();
  const p = doc ? runProgress(doc, card.targets, typeof card.since === 'number' ? card.since : undefined) : null;
  // One time per render, read everywhere below: the headline, the stuck line and Details agree with the check that keeps
  // the clock going. The shared tile clock only schedules re-renders; it runs while ANY drawing target still ticks
  // (a stuck lead never freezes the others' times) and stops when none does.
  const at = Date.now();
  const ticking = !!p && p.drawing.some((i) => tileProgress('rendering', i.render?.updatedAt, at, i.meta.typicalSec).ticking);
  const clock = useTileClockLead(ticking);
  if (!doc || !p) return null;

  if (p.total === 0) {
    return <p className={cn('m-0 text-[13px]', MUTED)}>These images were removed from the comic.</p>;
  }

  const toggle = () => {
    setOpen((v) => {
      rememberDetails(card.id, !v);
      return !v;
    });
  };
  const detailsButton = (
    <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={detailsId} onClick={toggle} className="-my-1 shrink-0 px-2">
      Details
      <ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
    </Button>
  );
  const pages = p.kind === 'pages';
  const detailsList = (items: ProgressItem[], now: number) => (
    <Collapse open={open} id={detailsId}>
      <ul
        aria-label={pages ? 'Each page' : 'Each image'}
        className={cn('m-0 max-h-64 space-y-1 overflow-y-auto border-s border-[var(--ds-hairline)] ps-3 text-[12px] leading-5', MUTED)}
      >
        {items.map((item) => (
          <DetailRow key={item.key} item={item} now={now} withModel={item === p.drawing[0]} />
        ))}
      </ul>
    </Collapse>
  );

  const isUnsignable = unsignableOf(studio);
  const sourcesOf = (item: ProgressItem) => tileSources(studio.urlFor, item.render?.asset, THUMB_SIZES, isUnsignable);
  // The finished card's Details: every target that wasn't drawn as asked (failed, withheld, earlier picture, not drawn).
  // Not for a run that was stopped before anything started (the line names them all), nor one target without a failure.
  const missed = p.busy ? [] : p.items.filter((i) => i.state !== 'drawn');
  const missedDetails = missed.length > 0 && p.idle < p.total && (p.total > 1 || p.failed.length > 0);
  const retryLine = p.failed.length > 0 && (
    <FailureLine
      p={p}
      doc={doc}
      byok={studio.byok}
      onRetry={(actions) => void run('retry-all', ...actions)}
      retrying={isPending('retry-all')}
      approx={cost.approx}
      prices={prices}
      details={!p.busy && missedDetails ? detailsButton : undefined}
    />
  );

  // ── Finished: one line, nothing moving ──
  if (!p.busy) {
    const done = doneLine(p);
    // View only when the run left a picture to look at.
    const view = p.drawn + p.kept + p.withheld > 0 ? viewFor(studio, p) : null;
    const all = p.drawn === p.total;
    return (
      <div data-renders-card="" className="min-w-0 space-y-1" aria-label={card.label || 'Drawing'} role="group">
        {done && (
          <div data-renders-done="" className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 coarse:min-h-11">
            <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
              {all ? <Check className={cn('size-3.5', TONE_TEXT.success)} strokeWidth={2.5} /> : <ImageIcon className={cn('size-3.5', MUTED)} />}
            </span>
            <span className={cn('min-w-0 flex-[1_1_10rem] text-[13px] leading-snug [overflow-wrap:anywhere]', INK)}>
              {done.line}
              {done.rest && <span className={MUTED}> · {done.rest}</span>}
            </span>
            {view && (
              <Button variant="ghost" size="sm" aria-label={view.label} onClick={view.run} className="-my-1">
                View
              </Button>
            )}
            {/* With a failure, Details sits in its line instead. */}
            {missedDetails && !retryLine && detailsButton}
          </div>
        )}
        {retryLine}
        {missedDetails && detailsList(missed, at)}
      </div>
    );
  }

  // ── In flight: one compact card ──
  const h = runHeadline(p, at);
  const many = p.total > 1;
  const recheck = h.stuck ? studioRefresh() : undefined;
  const headline = (
    <div className="flex min-w-0 items-center gap-2">
      {/* One live pulse per view: this card's dot pings only while it leads the shared clock (something still draws
          normally); otherwise it is still. */}
      {clock.lead ? (
        <LiveDot className="size-1.5 shrink-0 text-[var(--ds-accent)]" />
      ) : (
        <span aria-hidden data-still-dot="" className="size-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" />
      )}
      <p data-progress-headline="" title={headlineText(h)} className="m-0 min-w-0 flex-1 text-[13px] leading-5 [overflow-wrap:anywhere]">
        <span className={cn('font-semibold', INK)}>{h.what}</span>
        {h.count && <span className={cn('tabular-nums', MUTED)}> · {h.count}</span>}
        {h.now && <span className={MUTED}> · {h.now}</span>}
        {h.time && <span className={cn('tabular-nums', MUTED)}> · {h.time}</span>}
      </p>
      {many && detailsButton}
    </div>
  );

  return (
    <section
      aria-label={card.label || 'Drawing'}
      data-renders-progress=""
      className={cn('min-w-0 space-y-2.5 bg-[var(--ds-surface)] px-3 py-2.5', RADIUS_PANEL, HAIRLINE, SHADOW_SOFT)}
    >
      {many ? (
        <>
          {headline}
          <Progress size="sm" value={p.drawn} max={p.total} label={h.what} valueText={`${p.drawn} of ${p.total} drawn`} />
          {/* One row that scrolls sideways, never a grid that wraps; the padding keeps focus rings inside the scroll box. */}
          <ul
            role="list"
            aria-label={pages ? 'Pages in this run' : 'Images in this run'}
            className="-m-1 flex flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:thin]"
          >
            {p.items.map((item) => (
              <li key={item.key} className="shrink-0">
                <ProgressThumb item={item} src={sourcesOf(item)} onOpen={openerFor(studio, item.target)} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        // One page: no "1 of 1" and no bar — just the page beside what it is doing.
        <div className="flex min-w-0 items-center gap-3">
          <ProgressThumb item={p.items[0]} src={sourcesOf(p.items[0])} onOpen={openerFor(studio, p.items[0].target)} />
          <div className="min-w-0 flex-1">{headline}</div>
        </div>
      )}
      {retryLine}
      {h.stuck && (
        <div data-renders-stuck="" className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-snug', MUTED)}>
          <span className="min-w-0 flex-[1_1_10rem] [overflow-wrap:anywhere]">{capitalize(itemName(h.stuck))} is taking much longer than usual</span>
          {recheck && (
            <Button variant="ghost" size="sm" onClick={recheck} className="-my-1">
              Check again
            </Button>
          )}
        </div>
      )}
      {many && detailsList(p.items, at)}
    </section>
  );
};
