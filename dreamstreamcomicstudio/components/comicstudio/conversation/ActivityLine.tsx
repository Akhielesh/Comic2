// The live status line docked above the composer: what the studio is doing right now
// ("Drawing page 3…"), with the rest collapsed behind "+2", and Stop for running jobs.
// When renders are still landing with no stream attached (after a reload) it says so.
//
// Each line carries a tiny cost badge (events.ts `activity.cost`): "Free" when software does
// the work, "AI" for a cheap text step, "Image" for a paid drawing — and while a run is going,
// what software saved in it ("Saved ≈$0.07 — done by software, no AI cost", decisions-final
// #6; governed users read it as a share of their usage, never dollars). Honest and subtle:
// badges only appear when the server says what a step costs.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Square } from 'lucide-react';
import type { ActivityItem } from '../types';
import type { ComicStudioController } from '../useStudio';
import { activeActivities } from '../studioReducer';
import { useCostFormat } from './cost';
import { cx, plural } from './ui';

export type ActivityCost = 'free' | 'text' | 'image';

const ellipsize = (label: string) => {
  const clean = label.trim();
  if (!clean) return 'Working…';
  return /[.…!?]$/.test(clean) ? clean : `${clean}…`;
};

/** The cost class the server attached to an activity line (absent on older servers). */
export const activityCost = (a: ActivityItem | undefined): ActivityCost | undefined => {
  const c = (a as (ActivityItem & { cost?: unknown }) | undefined)?.cost;
  return c === 'free' || c === 'text' || c === 'image' ? c : undefined;
};

const COST_BADGE: Record<ActivityCost, { text: string; title: string; cls: string }> = {
  free: {
    text: 'Free',
    title: 'Free — done by the editor, no AI cost',
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  },
  text: {
    text: 'AI',
    title: 'Uses the AI writer — a fraction of a cent',
    cls: 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]'
  },
  image: {
    text: 'Image',
    title: 'Draws with the image model — priced before it starts',
    cls: 'bg-[#D97757]/10 text-[var(--ds-ink)]'
  }
};

/** A governed user's words for the AI-writer step: no money words at all (P1-LIMITS rule). */
export const GOVERNED_TEXT_COST_TITLE = 'Uses the AI writer — barely touches your usage';

export const CostBadge: React.FC<{ cost: ActivityCost; className?: string; governed?: boolean }> = ({ cost, className, governed }) => {
  const b = COST_BADGE[cost];
  const title = governed && cost === 'text' ? GOVERNED_TEXT_COST_TITLE : b.title;
  return (
    <span title={title} className={cx('inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-semibold leading-4', b.cls, className)}>
      {b.text}
      <span className="sr-only">{` — ${title}`}</span>
    </span>
  );
};

/**
 * What software saved during the current run: the doc's running savedUsd minus its value when
 * the line was last idle. Pure helper for tests; the component keeps the baseline in a ref.
 */
export const savedSince = (currentSavedUsd: number | undefined, baseline: number | undefined): number => {
  const now = typeof currentSavedUsd === 'number' && Number.isFinite(currentSavedUsd) ? currentSavedUsd : 0;
  const base = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : now;
  const d = Math.round((now - base) * 10000) / 10000;
  return d > 0 ? d : 0;
};

export const ActivityLine: React.FC<{ studio: ComicStudioController; className?: string }> = ({ studio, className }) => {
  const [open, setOpen] = useState(false);
  const active = activeActivities(studio.activity);
  const detached = !studio.busy && studio.renderingTotal > 0;
  const visible = active.length > 0 || studio.busy || detached;
  const savedUsd = studio.doc?.spend.savedUsd;
  const fmt = useCostFormat(studio);

  // Baseline of "saved by software" while idle; the delta during a run is what this run saved.
  const baseline = useRef<number | undefined>(savedUsd);
  useEffect(() => {
    if (!visible) baseline.current = savedUsd ?? 0;
  }, [visible, savedUsd]);

  if (!visible) return null;

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
  const cost = studio.cancelling ? undefined : activityCost(latest);
  const saved = savedSince(savedUsd, baseline.current);

  return (
    <div className={cx('min-w-0 px-1', className)}>
      {/* Wraps on a narrow phone: the badges and Stop drop to a second line instead of squeezing
          what the studio is doing down to "Dra…" (the label keeps at least 8rem). */}
      <div role="status" aria-live="polite" className="flex min-h-[28px] min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-[var(--ds-muted)]">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--ds-accent)] opacity-40 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--ds-accent)]" />
        </span>
        <span className="min-w-0 flex-1 basis-[8rem] truncate text-[var(--ds-ink)]" title={label}>
          {label}
        </span>
        {cost && <CostBadge cost={cost} governed={fmt.governed} />}
        {saved > 0 && (
          <span
            className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-medium leading-4 text-emerald-700 dark:text-emerald-300"
            title="Free — done by the editor, no AI cost"
          >
            {fmt.saved(saved)}
            <span className="sr-only"> — done by software, no AI cost</span>
          </span>
        )}
        {others > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={`${others} more ${others === 1 ? 'step' : 'steps'}`}
            className="inline-flex min-h-[28px] shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] coarse:min-h-[44px] coarse:min-w-[44px] coarse:justify-center"
          >
            +{others}
            <ChevronDown className={cx('h-3 w-3 transition-transform motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
          </button>
        )}
        {canStop && !studio.cancelling && (
          <button
            type="button"
            onClick={() => void studio.cancel()}
            // A real 44 px pill on touch (no ::after spill under the composer — P1-QA hit-target finding).
            className="inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] px-2.5 py-0.5 text-[11.5px] font-medium hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] coarse:min-h-[44px] coarse:px-3.5"
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
            .map((a) => {
              const c = activityCost(a);
              return (
                <li key={a.id} className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate">{ellipsize(a.label)}</span>
                  {c && <CostBadge cost={c} governed={fmt.governed} />}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
};
