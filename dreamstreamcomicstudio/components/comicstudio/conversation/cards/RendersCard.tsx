// "renders" card: the images one job is drawing, live — queued, drawing (shimmer), ready
// (develops in; tap a page to open it), out of date, or failed with Retry (re-runs the
// matching spend with force).
//
// Failures read calm (reliability.md §3): each failed tile says when and why, and one
// "Retry N failed" button covers EVERY failed kind in the card — pages, sheets, places, style
// options and the cover (the 2026-10-22 outage left three failed style tests with no way to
// retry them together). The button carries its honest quote (quotedUsd), so a stale card
// re-quotes instead of overspending.

import React from 'react';
import { ImageIcon, RotateCcw } from 'lucide-react';
import { getRender, renderTargetKey, type Card, type ComicDoc, type RenderState, type RenderTarget } from '../../../../shared/comic/doc';
import type { SpendAction } from '../../../../shared/comic/ops';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import { quoteRenderPages } from '../../../../shared/comic/plan';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, plural } from '../ui';
import { failureFacts, failureReason, formatFailedAt } from './failure';
import { RenderThumb, describeTarget } from './renderTile';
import { useAction } from './useAction';

type RendersCardData = Extract<Card, { type: 'renders' }>;

const isBusyStatus = (s?: string) => s === 'queued' || s === 'rendering';

export interface FailedItem {
  target: RenderTarget;
  render?: RenderState;
}

/**
 * The spend actions that redraw every failed target in one go (sequential), with a quote.
 * Pages use the server gate's own targeting (shared/comic/plan.ts) so missing sheets are
 * included honestly; the rest use the registry estimate.
 */
export const retryAllFailed = (
  doc: ComicDoc,
  failed: FailedItem[],
  byok: boolean
): { actions: SpendAction[]; usd: number; count: number } => {
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const actions: SpendAction[] = [];
  let usd = 0;

  const pageIds = failed.filter((f) => f.target.kind === 'page').map((f) => (f.target as { id: string }).id);
  if (pageIds.length) {
    const q = quoteRenderPages(doc, { pageIds, force: true, byok, tier, modelOverride: override });
    actions.push({ type: 'render_pages', pageIds, force: true, quotedUsd: q.usd });
    usd += q.usd;
  }

  const sheetIds = failed.filter((f) => f.target.kind === 'sheet' || f.target.kind === 'place').map((f) => (f.target as { id: string }).id);
  if (sheetIds.length) {
    // One render_sheets covers characters and places (the server splits them); price each kind.
    const places = failed.filter((f) => f.target.kind === 'place').length;
    const chars = sheetIds.length - places;
    const est = estimateJobs(
      [...(chars ? [{ kind: 'sheet' as const, count: chars }] : []), ...(places ? [{ kind: 'place' as const, count: places }] : [])],
      tier,
      { override, byok }
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
    const est = estimateJobs([{ kind: 'style_option', count: directions.length }], tier, { override, byok });
    actions.push({ type: 'render_style_options', directions, quotedUsd: est.usd });
    usd += est.usd;
  }

  if (failed.some((f) => f.target.kind === 'cover')) {
    const est = estimateJobs([{ kind: 'cover', count: 1 }], tier, { override, byok });
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

export const RendersCard: React.FC<{ card: RendersCardData; studio: ComicStudioController }> = ({ card, studio }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
  if (!doc) return null;
  const targets: RenderTarget[] = Array.isArray(card.targets) ? card.targets : [];

  const items = targets.map((target) => ({ target, render: getRender(doc, target), meta: describeTarget(doc, target) }));
  const live = items.filter((i) => i.meta);
  const ready = live.filter((i) => i.render?.status === 'ready').length;
  const busy = live.filter((i) => isBusyStatus(i.render?.status)).length;
  const failed = live.filter((i) => i.render?.status === 'failed');
  const onlySheets = live.length > 0 && live.every((i) => i.target.kind === 'sheet' || i.target.kind === 'place');
  const retry = failed.length > 1 ? retryAllFailed(doc, failed, studio.byok) : null;

  const open = (target: RenderTarget) => {
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

  const summary = busy
    ? `${ready} of ${live.length} ready`
    : failed.length
      ? `${ready} ready · ${failed.length} failed`
      : `${ready} of ${live.length} ready`;

  return (
    <CardShell title={card.label || 'Drawing'} icon={<ImageIcon className="h-4 w-4" />} right={live.length ? summary : undefined} aria-label={card.label || 'Renders'}>
      {busy > 0 && (
        <div className="mb-3 h-1 w-full overflow-hidden rounded-full bg-[var(--ds-well-strong)]" role="progressbar" aria-valuemin={0} aria-valuemax={live.length} aria-valuenow={ready}>
          <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${live.length ? Math.max(4, (ready / live.length) * 100) : 0}%` }} />
        </div>
      )}
      {live.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-muted)]">These images were removed from the comic.</p>
      ) : (
        <div className={onlySheets ? 'grid grid-cols-2 gap-2.5' : 'grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2.5'}>
          {live.map(({ target, render, meta }) => {
            const key = renderTargetKey(target);
            // A failed tile's Retry carries a quote made at click time (a stale card re-quotes on the
            // server instead of overspending); the plain redraw action is the fallback.
            const retryActions = (): SpendAction[] => {
              const quoted = retryAllFailed(doc, [{ target, render }], studio.byok).actions;
              return quoted.length ? quoted : meta!.retry ? [meta!.retry] : [];
            };
            return (
              <RenderThumb
                key={key}
                render={render}
                label={meta!.label}
                aspect={meta!.aspect}
                stale={meta!.stale}
                url={studio.urlFor(render?.asset)}
                onOpen={open(target)}
                onRetry={meta!.retry ? () => void run(`retry:${key}`, ...retryActions()) : undefined}
                retryBusy={isPending(`retry:${key}`) || isPending('retry-all')}
              />
            );
          })}
        </div>
      )}
      {failed.length > 0 && busy === 0 && (
        <p className="mt-2.5 text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{failureSummary(failed)}</p>
      )}
      {retry && retry.actions.length > 0 && (
        <div className="mt-2.5">
          <GhostButton size="sm" className="tap-target" busy={isPending('retry-all')} onClick={() => void run('retry-all', ...retry.actions)}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry {plural(retry.count, 'failed image')}
            <span className="text-[var(--ds-muted)]">≈ {formatUsd(retry.usd)}</span>
          </GhostButton>
        </div>
      )}
    </CardShell>
  );
};
