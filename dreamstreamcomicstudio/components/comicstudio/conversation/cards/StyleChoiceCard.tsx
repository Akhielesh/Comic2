// "style_choice" card: the candidate style boards, live. Boards develop in as they
// finish; tap one to lock it as the comic's style (pick_style). "More options" draws a
// fresh set (a gated spend like any other). Failed boards read calm (when + why, details on
// tap) and, when several failed, one "Retry N failed" redraws just those directions.

import React from 'react';
import { Lock, Palette, RefreshCw, RotateCcw } from 'lucide-react';
import type { Card, ComicDoc, StyleOption } from '../../../../shared/comic/doc';
import { formatUsd } from '../../../../shared/comic/models';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton, plural } from '../ui';
import { STYLE_DIRECTION_COUNT, quoteStyleOptions } from '../panels/StylePanel';
import { RenderThumb } from './renderTile';
import { failureSummary, retryAllFailed } from './RendersCard';
import { useAction } from './useAction';

type StyleChoiceData = Extract<Card, { type: 'style_choice' }>;

const isBusy = (o: StyleOption) => o.render.status === 'queued' || o.render.status === 'rendering';

/** The option the locked style came from (board path match, else name+spec match). */
export const lockedOptionId = (doc: ComicDoc): string | null => {
  if (doc.style.status !== 'locked') return null;
  const board = doc.style.board?.path;
  const byBoard = board ? doc.style.options.find((o) => o.render.asset?.path === board) : undefined;
  if (byBoard) return byBoard.id;
  const byText = doc.style.options.find((o) => o.name === doc.style.name && o.spec === doc.style.spec);
  return byText?.id || null;
};

export const StyleChoiceCard: React.FC<{ card: StyleChoiceData; studio: ComicStudioController }> = ({ studio }) => {
  const doc = studio.doc;
  const { run, isPending } = useAction(studio.act);
  if (!doc) return null;
  const options = doc.style.options;
  const locked = lockedOptionId(doc);
  const drawing = options.filter(isBusy).length;
  const picking = options.some((o) => isPending(`pick:${o.id}`));
  const moreUsd = quoteStyleOptions(doc, STYLE_DIRECTION_COUNT, studio.byok);
  const failed = options
    .filter((o) => o.render.status === 'failed')
    .map((o) => ({ target: { kind: 'style_option' as const, id: o.id }, render: o.render }));
  const retry = failed.length > 1 ? retryAllFailed(doc, failed, studio.byok) : null;

  const status = locked
    ? `Locked: ${doc.style.name || 'style'}`
    : drawing
      ? `Drawing ${drawing} of ${options.length}…`
      : options.some((o) => o.render.status === 'ready')
        ? 'Tap one to lock it'
        : '';

  return (
    <CardShell title="Pick a style" icon={<Palette className="h-4 w-4" />} right={status} aria-label="Style options">
      {options.length === 0 ? (
        <p className="text-[13px] text-[var(--ds-muted)]">These style options were replaced. Draw a fresh set to compare looks.</p>
      ) : (
        // Three looks sit side by side even on a phone — comparing them is the whole point.
        <div className={options.length <= 3 ? 'grid grid-cols-3 gap-2 sm:gap-2.5' : 'grid grid-cols-2 gap-2.5 sm:grid-cols-3'}>
          {options.map((o) => {
            const ready = o.render.status === 'ready' && !!o.render.asset;
            const selected = locked === o.id;
            const url = studio.urlFor(o.render.asset);
            const thumb = (
              <RenderThumb
                render={o.render}
                label={o.name}
                aspect="4 / 5"
                url={url}
                selected={selected}
                onRetry={() =>
                  void run(`retry:${o.id}`, {
                    type: 'render_style_options',
                    directions: [{ name: o.name, spec: o.spec }],
                    quotedUsd: quoteStyleOptions(doc, 1, studio.byok, true)
                  })
                }
                // The server draws one batch of options at a time: retries wait for the current one.
                retryBusy={isPending(`retry:${o.id}`) || isPending('retry-all')}
                retryDisabled={drawing > 0}
                // Three 4:5 tiles side by side on a phone are ~64 px wide: icon + Retry only in the
                // frame; when and why sit in the caption under it.
                compact
                badge={
                  selected ? (
                    <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[var(--ds-accent)] text-white shadow" aria-hidden>
                      <Lock className="h-3 w-3" />
                    </span>
                  ) : undefined
                }
              />
            );
            if (!ready || selected) return <div key={o.id}>{thumb}</div>;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => void run(`pick:${o.id}`, { type: 'pick_style', optionId: o.id })}
                disabled={picking}
                aria-busy={isPending(`pick:${o.id}`) || undefined}
                aria-label={`Use the ${o.name} style`}
                title={o.spec}
                className="block rounded-xl text-left transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/50 disabled:opacity-60"
              >
                {thumb}
              </button>
            );
          })}
        </div>
      )}
      {failed.length > 0 && drawing === 0 && (
        <p className="mt-2.5 text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{failureSummary(failed)}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {retry && retry.actions.length > 0 && (
          <GhostButton
            size="sm"
            className="tap-target"
            busy={isPending('retry-all')}
            disabled={drawing > 0}
            title={drawing > 0 ? 'Waiting for the options that are drawing now' : undefined}
            onClick={() => void run('retry-all', ...retry.actions)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry {plural(retry.count, 'failed style', 'failed styles')}
            <span className="text-[var(--ds-muted)]">≈ {formatUsd(retry.usd)}</span>
          </GhostButton>
        )}
        <GhostButton
          size="sm"
          className="tap-target"
          busy={isPending('more')}
          disabled={drawing > 0}
          onClick={() => void run('more', { type: 'render_style_options', quotedUsd: moreUsd })}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          More options <span className="text-[var(--ds-muted)]">≈ {formatUsd(moreUsd)}</span>
        </GhostButton>
        {locked && (
          <span className="text-[11.5px] text-[var(--ds-muted)]">Every page will be drawn in this style.</span>
        )}
      </div>
    </CardShell>
  );
};
