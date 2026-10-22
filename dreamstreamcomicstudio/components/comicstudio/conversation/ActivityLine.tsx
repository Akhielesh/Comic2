// The live status line docked above the composer: what the studio is doing right now
// ("Drawing page 3…"), with the rest collapsed behind "+2", and Stop for running jobs.
// When renders are still landing with no stream attached (after a reload) it says so.

import React, { useState } from 'react';
import { ChevronDown, Square } from 'lucide-react';
import type { ComicStudioController } from '../useStudio';
import { activeActivities } from '../studioReducer';
import { cx, plural } from './ui';

const ellipsize = (label: string) => {
  const clean = label.trim();
  if (!clean) return 'Working…';
  return /[.…!?]$/.test(clean) ? clean : `${clean}…`;
};

export const ActivityLine: React.FC<{ studio: ComicStudioController; className?: string }> = ({ studio, className }) => {
  const [open, setOpen] = useState(false);
  const active = activeActivities(studio.activity);
  const detached = !studio.busy && studio.renderingTotal > 0;
  if (!active.length && !studio.busy && !detached) return null;

  const latest = active[active.length - 1];
  const label = studio.cancelling
    ? 'Stopping — anything already drawing will finish and be kept…'
    : latest
      ? ellipsize(latest.label)
      : detached
        ? `${plural(studio.renderingTotal, 'image')} still drawing…`
        : studio.messageBusy
          ? 'Thinking…'
          : 'Working…';
  const others = active.length - 1;
  const canStop = (studio.busy && !studio.messageBusy) || detached;

  return (
    <div className={cx('px-1', className)}>
      <div role="status" aria-live="polite" className="flex min-h-[28px] items-center gap-2 text-[12.5px] text-[var(--ds-muted)]">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--ds-accent)] opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ds-accent)]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--ds-ink)]">{label}</span>
        {others > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
          >
            +{others}
            <ChevronDown className={cx('h-3 w-3 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        )}
        {canStop && !studio.cancelling && (
          <button
            type="button"
            onClick={() => void studio.cancel()}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] px-2 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
            title="Stop queued work (images already drawing finish and are kept)"
          >
            <Square className="h-2.5 w-2.5 fill-current" aria-hidden /> Stop
          </button>
        )}
      </div>
      {open && others > 0 && (
        <ul className="mb-1 ml-4 space-y-0.5 border-l border-[var(--ds-hairline)] pl-3 text-[12px] text-[var(--ds-muted)]">
          {active
            .slice(0, -1)
            .reverse()
            .map((a) => (
              <li key={a.id} className="truncate">
                {ellipsize(a.label)}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
};
