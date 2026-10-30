// "plan" card: the page plan at a glance (plan before pixels).
//
// decisions-final #3 / contract §4.7: the plan card renders through the page BREAKDOWN card
// (cover + every page's panel wireframe, panel counts, cost) and the one-tap "Approve & render
// all" stays — the filmstrip sits ABOVE that button, so the user sees exactly what they
// approve. The breakdown lives in its own feature (P1-BOOKMODEL) and is reached through the
// card registry; when that feature isn't available this card falls back to the compact page
// list below with the same kept button and the same honest quote (shared/comic/plan.ts —
// the server gate's own targeting).

import React, { useState } from 'react';
import { BookOpen, Check, LayoutTemplate } from 'lucide-react';
import { isPageStale, type Card, type Character, type ComicDoc, type Msg, type Page } from '../../../../shared/comic/doc';
import { getImageModel, type SpendEstimate } from '../../../../shared/comic/models';
import { missingSheetsFor, pageTargets, quoteRenderPages } from '../../../../shared/comic/plan';
import { registeredCard } from '../../features';
import type { CardProps } from '../../extensions';
import type { ComicStudioController } from '../../useStudio';
import { useCostFormat } from '../cost';
import { TONE_TEXT } from '../../../chat/studioDesign';
import { CardShell, GhostButton, PrimaryButton, cx, plural } from '../ui';
import { useAction, useStudioSequenceGuard } from './useAction';

type PlanCardData = Extract<Card, { type: 'plan' }>;

const COLLAPSED_ROWS = 6;
const isBusy = (p: Page) => p.render.status === 'queued' || p.render.status === 'rendering';

/** Pages a "render pages" click would draw now (the server's pageTargets). */
export const pagesToDraw = (doc: ComicDoc): Page[] => pageTargets(doc);

/** Lead/support cast on these pages without a usable sheet (drawn first, billed too). */
export const sheetsNeededFor = (doc: ComicDoc, pages: Page[]): Character[] => missingSheetsFor(doc, pages);

/** The honest quote for "draw everything that needs drawing" (same as the server gate). */
export const estimatePlanRender = (doc: ComicDoc, byok: boolean): { pages: Page[]; sheets: Character[]; estimate: SpendEstimate } => {
  const q = quoteRenderPages(doc, { byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
  const pages = q.pageIds.map((id) => doc.pages.find((p) => p.id === id)).filter((p): p is Page => !!p);
  const sheets = q.sheetIds.map((id) => doc.cast.find((c) => c.id === id)).filter((c): c is Character => !!c);
  return { pages, sheets, estimate: { usd: q.usd, imageCount: q.imageCount, model: q.model, lines: q.lines } };
};

const PageStatus: React.FC<{ doc: ComicDoc; page: Page }> = ({ doc, page }) => {
  const s = page.render.status;
  if (s === 'ready' && isPageStale(doc, page)) return <span className={cx('text-[11px] font-medium', TONE_TEXT.warning)}>Out of date</span>;
  if (s === 'ready')
    return (
      <span className={cx('inline-flex items-center gap-1 text-[11px] font-medium', TONE_TEXT.success)}>
        <Check className="h-3 w-3" aria-hidden /> Drawn
      </span>
    );
  if (s === 'queued') return <span className="text-[11px] text-[var(--ds-muted)]">Queued</span>;
  if (s === 'rendering')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ds-ink)]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ds-accent)] motion-reduce:animate-none" aria-hidden /> Drawing
      </span>
    );
  if (s === 'failed') return <span className={cx('text-[11px] font-medium', TONE_TEXT.warning)}>Didn’t finish</span>;
  return null;
};

type EmbeddedCard = React.ComponentType<CardProps<Card> & { compact?: boolean }>;

export const PlanCard: React.FC<{ card: PlanCardData; studio: ComicStudioController; message?: Msg }> = ({ card, studio, message }) => {
  // The registered breakdown component renders the legacy `plan` payload itself (filmstrip,
  // details, then the kept approve-all button under it).
  const Breakdown = registeredCard('breakdown')?.Component as EmbeddedCard | undefined;
  if (Breakdown && studio.doc) {
    const msg: Msg = message || { id: `plan_${card.id}`, role: 'assistant', text: '', at: 0, cards: [card] };
    return <Breakdown card={card} message={msg} studio={studio} />;
  }
  return <PlanList card={card} studio={studio} />;
};

/** Fallback page list (no breakdown feature): headline, panels and status per page. */
export const PlanList: React.FC<{ card: PlanCardData; studio: ComicStudioController }> = ({ studio }) => {
  const doc = studio.doc;
  // "Approve & render all" stops after the approval if it didn't go through (or a gate opened).
  const guard = useStudioSequenceGuard(studio);
  const { run, isPending } = useAction(studio.act, { guard });
  const cost = useCostFormat(studio);
  const [expanded, setExpanded] = useState(false);
  if (!doc) return null;

  const pages = [...doc.pages].sort((a, b) => a.n - b.n);
  const panelTotal = pages.reduce((n, p) => n + p.panels.length, 0);
  const { pages: toDraw, sheets, estimate } = estimatePlanRender(doc, studio.byok);
  const drawing = pages.filter(isBusy).length;
  const allDrawn = pages.length > 0 && pages.every((p) => p.render.status === 'ready' && !isPageStale(doc, p));
  const approved = doc.planStatus === 'approved';
  const rows = expanded ? pages : pages.slice(0, COLLAPSED_ROWS);

  if (!pages.length) {
    return (
      <CardShell title="Page plan" icon={<LayoutTemplate className="h-4 w-4" />} aria-label="Page plan">
        <p className="text-[13px] text-[var(--ds-muted)]">The page plan was cleared. Ask me to plan the pages again when you're ready.</p>
        <div className="mt-3">
          <GhostButton size="sm" className="tap-target" busy={isPending('plan')} onClick={() => void run('plan', { type: 'plan_pages' })}>
            Plan the pages
          </GhostButton>
        </div>
      </CardShell>
    );
  }

  const starting = isPending('approve') || isPending('approve-only') || isPending('render');
  const drawLabel = `${plural(toDraw.length, 'page')}${sheets.length ? ` + ${plural(sheets.length, 'sheet')}` : ''}`;

  return (
    <CardShell
      title="Page plan"
      icon={<LayoutTemplate className="h-4 w-4" />}
      right={`${plural(pages.length, 'page')} · ${plural(panelTotal, 'panel')}${approved ? ' · approved' : ''}`}
      aria-label="Page plan"
      className="min-w-0 max-w-full"
    >
      <ol className="divide-y divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)]">
        {rows.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => studio.openPage(p.id)}
              className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-[var(--ds-hover)] focus-visible:bg-[var(--ds-hover)] focus-visible:outline-none"
            >
              <span className="mt-0.5 w-6 shrink-0 text-[12px] font-semibold tabular-nums text-[var(--ds-muted)]">{p.n}</span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[13px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{p.summary || 'Untitled page'}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--ds-muted)]">
                  {plural(p.panels.length, 'panel')}
                  {p.panels.some((panel) => panel.size === 'splash') && <span>· splash</span>}
                </span>
              </span>
              <span className="mt-0.5 shrink-0">
                <PageStatus doc={doc} page={p} />
              </span>
            </button>
          </li>
        ))}
      </ol>
      {pages.length > COLLAPSED_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="tap-target mt-1.5 text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]"
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : `+ ${pages.length - COLLAPSED_ROWS} more pages`}
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {allDrawn ? (
          <PrimaryButton size="sm" className="tap-target" onClick={() => studio.runClientAction({ type: 'open_reader' })}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden /> Read the comic
          </PrimaryButton>
        ) : toDraw.length > 0 ? (
          approved ? (
            <PrimaryButton
              size="sm"
              className="tap-target !h-auto min-h-8 max-w-full py-1 text-center coarse:min-h-11"
              busy={isPending('render')}
              disabled={starting}
              onClick={() => void run('render', { type: 'render_pages', quotedUsd: estimate.usd })}
            >
              Draw {drawLabel} ({cost.approx(estimate.usd)})
            </PrimaryButton>
          ) : (
            <PrimaryButton
              size="sm"
              className="tap-target !h-auto min-h-8 max-w-full py-1 text-center coarse:min-h-11"
              busy={isPending('approve')}
              disabled={starting}
              onClick={() => void run('approve', { type: 'approve_plan' }, { type: 'render_pages', quotedUsd: estimate.usd })}
            >
              Approve &amp; render all ({cost.approx(estimate.usd)})
            </PrimaryButton>
          )
        ) : null}
        <GhostButton size="sm" className="tap-target" onClick={() => studio.setTab('pages')}>
          Open plan
        </GhostButton>
        {!approved && toDraw.length > 0 && (
          <GhostButton size="sm" className="tap-target" busy={isPending('approve-only')} disabled={starting} onClick={() => void run('approve-only', { type: 'approve_plan' })}>
            Approve only
          </GhostButton>
        )}
      </div>
      <p className={cx('mt-2 text-[11.5px] [overflow-wrap:anywhere]', drawing > 0 ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]')}>
        {drawing > 0
          ? `Drawing ${plural(drawing, 'page')} — they appear on the board as they finish.`
          : allDrawn
            ? 'Every page is drawn. Ask for changes any time — only what you change is redrawn.'
            : `Nothing is drawn until you approve. ${estimate.model ? `${getImageModel(estimate.model)?.nickname || estimate.model}, ` : ''}${plural(estimate.imageCount, 'image')}.`}
      </p>
    </CardShell>
  );
};
