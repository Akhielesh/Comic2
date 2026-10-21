// "style_choice" card: the candidate style boards, live. Boards develop in as they
// finish; tap one to lock it as the comic's style (pick_style). "More options" draws a
// fresh set (a gated spend like any other).

import React from 'react';
import { Lock, Palette, RefreshCw } from 'lucide-react';
import type { Card, ComicDoc, StyleOption } from '../../../../shared/comic/doc';
import { estimateJobs, formatUsd } from '../../../../shared/comic/models';
import type { ComicStudioController } from '../../useStudio';
import { CardShell, GhostButton } from '../ui';
import { RenderThumb } from './renderTile';
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
  const more = estimateJobs([{ kind: 'style_option', count: 3, label: 'style options' }], doc.settings.quality, { byok: studio.byok });

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
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
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
                onRetry={() => void run(`retry:${o.id}`, { type: 'render_style_options', directions: [{ name: o.name, spec: o.spec }] })}
                retryBusy={isPending(`retry:${o.id}`)}
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
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <GhostButton
          size="sm"
          busy={isPending('more')}
          disabled={drawing > 0}
          onClick={() => void run('more', { type: 'render_style_options' })}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          More options <span className="text-[var(--ds-muted)]">≈ {formatUsd(more.usd)}</span>
        </GhostButton>
        {locked && (
          <span className="text-[11.5px] text-[var(--ds-muted)]">Every page will be drawn in this style.</span>
        )}
      </div>
    </CardShell>
  );
};
