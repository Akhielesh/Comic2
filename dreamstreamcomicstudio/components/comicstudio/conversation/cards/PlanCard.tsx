// "plan" card: the page plan at a glance (plan before pixels). Shows each page's headline,
// panel count and drawing status, with the one decision that matters next: approve and
// draw (with the honest estimate), draw what's left, or read the finished comic.

import React, { useState } from 'react';
import { BookOpen, Check, LayoutTemplate } from 'lucide-react';
import { isPageStale, type Card, type Character, type ComicDoc, type Page } from '../../../../shared/comic/doc';
import { estimateJobs, formatUsd, type SpendEstimate } from '../../../../shared/comic/models';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, PrimaryButton, cx, plural } from '../ui';
import { useAction } from './useAction';

type PlanCardData = Extract<Card, { type: 'plan' }>;

const COLLAPSED_ROWS = 6;
const isBusy = (p: Page) => p.render.status === 'queued' || p.render.status === 'rendering';

/** Pages a "render pages" click would draw now (mirrors the server's pageTargets). */
export const pagesToDraw = (doc: ComicDoc): Page[] =>
  doc.pages.filter((p) => p.panels.length > 0 && !isBusy(p) && (p.render.status !== 'ready' || isPageStale(doc, p)));

/** Lead/support cast on these pages without a usable sheet (drawn first, billed too). */
export const sheetsNeededFor = (doc: ComicDoc, pages: Page[]): Character[] => {
  const ids = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => panel.castIds)));
  return doc.cast.filter(
    (c) => ids.has(c.id) && c.tier !== 'extra' && c.sheet.status !== 'ready' && c.sheet.status !== 'queued' && c.sheet.status !== 'rendering'
  );
};

export const estimatePlanRender = (doc: ComicDoc, byok: boolean): { pages: Page[]; sheets: Character[]; estimate: SpendEstimate } => {
  const pages = pagesToDraw(doc);
  const sheets = sheetsNeededFor(doc, pages);
  const estimate = estimateJobs(
    [
      { kind: 'page', count: pages.length, label: 'pages' },
      { kind: 'sheet', count: sheets.length, label: 'character sheets' }
    ],
    doc.settings.quality,
    { override: doc.settings.imageModelOverride, byok }
  );
  return { pages, sheets, estimate };
};

const PageStatus: React.FC<{ doc: ComicDoc; page: Page }> = ({ doc, page }) => {
  const s = page.render.status;
  if (s === 'ready' && isPageStale(doc, page)) return <span className="text-[11px] font-medium text-amber-600 dark:text-amber-300">Out of date</span>;
  if (s === 'ready')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <Check className="h-3 w-3" aria-hidden /> Drawn
      </span>
    );
  if (s === 'queued') return <span className="text-[11px] text-[var(--ds-muted)]">Queued</span>;
  if (s === 'rendering')
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ds-ink)]">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ds-accent)]" aria-hidden /> Drawing
      </span>
    );
  if (s === 'failed') return <span className="text-[11px] font-medium text-red-600 dark:text-red-300">Failed</span>;
  return null;
};

export const PlanCard: React.FC<{ card: PlanCardData; studio: ComicStudioController }> = ({ studio }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
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
          <GhostButton size="sm" busy={isPending('plan')} onClick={() => void run('plan', { type: 'plan_pages' })}>
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
                <span className="line-clamp-2 text-[13px] leading-snug text-[var(--ds-ink)]">{p.summary || 'Untitled page'}</span>
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
          className="mt-1.5 text-[12px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)]"
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : `+ ${pages.length - COLLAPSED_ROWS} more pages`}
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {allDrawn ? (
          <PrimaryButton size="sm" onClick={() => studio.setTab('read')}>
            <BookOpen className="h-3.5 w-3.5" aria-hidden /> Read the comic
          </PrimaryButton>
        ) : toDraw.length > 0 ? (
          approved ? (
            <PrimaryButton size="sm" busy={isPending('render')} disabled={starting} onClick={() => void run('render', { type: 'render_pages' })}>
              Draw {drawLabel} (≈ {formatUsd(estimate.usd)})
            </PrimaryButton>
          ) : (
            <PrimaryButton
              size="sm"
              busy={isPending('approve')}
              disabled={starting}
              onClick={() => void run('approve', { type: 'approve_plan' }, { type: 'render_pages' })}
            >
              Approve &amp; render all (≈ {formatUsd(estimate.usd)})
            </PrimaryButton>
          )
        ) : null}
        <GhostButton size="sm" onClick={() => studio.setTab('pages')}>
          Open plan
        </GhostButton>
        {!approved && toDraw.length > 0 && (
          <GhostButton size="sm" busy={isPending('approve-only')} disabled={starting} onClick={() => void run('approve-only', { type: 'approve_plan' })}>
            Approve only
          </GhostButton>
        )}
      </div>
      <p className={cx('mt-2 text-[11.5px] text-[var(--ds-muted)]', drawing > 0 && 'text-[var(--ds-ink)]')}>
        {drawing > 0
          ? `Drawing ${plural(drawing, 'page')} — they appear on the board as they finish.`
          : allDrawn
            ? 'Every page is drawn. Ask for changes any time — only what you change is redrawn.'
            : `Nothing is drawn until you approve. ${estimate.model ? `${estimate.model}, ` : ''}${plural(estimate.imageCount, 'image')}.`}
      </p>
    </CardShell>
  );
};
