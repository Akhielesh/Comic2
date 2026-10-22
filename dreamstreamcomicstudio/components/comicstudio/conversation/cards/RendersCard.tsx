// "renders" card: the images one job is drawing, live — queued, drawing (shimmer), ready
// (develops in; tap a page to open it), out of date, or failed with Retry (re-runs the
// matching spend with force).

import React from 'react';
import { ImageIcon, RotateCcw } from 'lucide-react';
import { getRender, renderTargetKey, type Card, type RenderTarget } from '../../../../shared/comic/doc';
import type { SpendAction } from '../../../../shared/comic/ops';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton } from '../ui';
import { RenderThumb, describeTarget } from './renderTile';
import { useAction } from './useAction';

type RendersCardData = Extract<Card, { type: 'renders' }>;

const isBusyStatus = (s?: string) => s === 'queued' || s === 'rendering';

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
  const failedPages = failed.filter((i) => i.target.kind === 'page');
  const onlySheets = live.length > 0 && live.every((i) => i.target.kind === 'sheet' || i.target.kind === 'place');

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
          <div className="h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500" style={{ width: `${live.length ? Math.max(4, (ready / live.length) * 100) : 0}%` }} />
        </div>
      )}
      {live.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-muted)]">These images were removed from the comic.</p>
      ) : (
        <div className={onlySheets ? 'grid grid-cols-2 gap-2.5' : 'grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2.5'}>
          {live.map(({ target, render, meta }) => {
            const key = renderTargetKey(target);
            const retry: SpendAction | undefined = meta!.retry;
            return (
              <RenderThumb
                key={key}
                render={render}
                label={meta!.label}
                aspect={meta!.aspect}
                stale={meta!.stale}
                url={studio.urlFor(render?.asset)}
                onOpen={open(target)}
                onRetry={retry ? () => void run(`retry:${key}`, retry) : undefined}
                retryBusy={isPending(`retry:${key}`)}
              />
            );
          })}
        </div>
      )}
      {failedPages.length > 1 && (
        <div className="mt-3">
          <GhostButton
            size="sm"
            busy={isPending('retry-all')}
            onClick={() => void run('retry-all', { type: 'render_pages', pageIds: failedPages.map((i) => (i.target as { id: string }).id), force: true })}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry {failedPages.length} failed pages
          </GhostButton>
        </div>
      )}
    </CardShell>
  );
};
