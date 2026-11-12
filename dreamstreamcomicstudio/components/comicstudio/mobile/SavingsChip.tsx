// "Saved by software" (decisions-final #6): a subtle trust signal that the studio did the work with its
// own tools instead of a paid redraw — "Free — done by the editor, no AI cost". Honest numbers only:
// the total is `doc.spend.savedUsd` (the server adds a SpendEntry.savedUsd for a reuse of an identical
// render, or a free step picked over a quoted paid one). Nothing saved → nothing shown.
//
// Declutter (DC-1, F3): the header never says "Saved" for anything but the save state, because next to a
// title "Saved" reads as "your work is saved". So the header slot draws no chip at any width:
//  - the total and its breakdown live in the Spending sheet (ComicStudio's spend chip / ⋯ Spending row) at
//    every width (`SavingsBreakdown`);
//  - a new saving shows the copy as a calm app toast, on every form factor — the one moment the signal matters.
//    First sight never flashes. It is an ordinary toast in the ONE toast slot (components/ds/Toast, DS-1c): it
//    never stacks with the timeline's Undo toast or an app toast (the newer one takes the slot), and the host's
//    always-mounted polite status region announces it, so it has no live region of its own.
//  - Money is printed for THIS user (conversation/cost.ts): governed users read a share of their usage
//    ("Saved ≈0.5% of your usage") or just the copy — never dollars, also before their status loads. The toast
//    carries the copy only.

import React, { useEffect, useRef } from 'react';
import { Leaf } from 'lucide-react';
import { OVERLINE, TONE_TEXT } from '../../chat/studioDesign';
import { toast } from '../../ds/Toast';
import type { ComicDoc, SpendEntry } from '../../../shared/comic/doc';
import { useCostFormat, type CostFormat } from '../conversation/cost';
import { compactUsageShare } from '../../../services/costDisplay';
import type { StudioController } from '../types';

export const SAVINGS_COPY = 'Free — done by the editor, no AI cost';
/** How long the savings toast stays untouched. */
export const SAVINGS_TOAST_MS = 4000;

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Total saved by software on this comic (the running total, else the sum of the entries). */
export const savedTotal = (doc: ComicDoc | null | undefined): number => {
  if (!doc) return 0;
  const total = doc.spend?.savedUsd;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) return total;
  return (doc.spend?.entries || []).reduce((n, e) => n + (typeof e.savedUsd === 'number' && Number.isFinite(e.savedUsd) && e.savedUsd > 0 ? e.savedUsd : 0), 0);
};

/** The most recent savings (entries are most-recent-first). */
export const savedEntries = (doc: ComicDoc | null | undefined, limit = 6): SpendEntry[] =>
  (doc?.spend?.entries || []).filter((e) => typeof e.savedUsd === 'number' && e.savedUsd > 0).slice(0, limit);

/** A calm app toast whenever the total grows (never on first sight, never for an empty doc). */
const useSavingsToast = (ready: boolean, total: number): void => {
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const before = prev.current;
    prev.current = total;
    if (before === null || total <= before + 0.00005) return;
    toast({ title: SAVINGS_COPY, tone: 'healthy', duration: SAVINGS_TOAST_MS });
  }, [ready, total]);
};

/** "Saved ≈0.5% of your usage" → "≈0.5%" for a narrow spot; undefined when it isn't a readable share. */
const shortShare = (cost: CostFormat, usd: number): string | undefined => (cost.governed ? compactUsageShare(cost.exact(usd)) : cost.exact(usd));

/** The breakdown in the Spending sheet (ComicStudio), at every width. */
export const SavingsBreakdown: React.FC<{ doc: ComicDoc; cost?: CostFormat }> = ({ doc, cost: costProp }) => {
  const fallback = useCostFormat({ caps: null });
  const cost = costProp ?? fallback;
  const total = savedTotal(doc);
  const list = savedEntries(doc);
  const headline = cost.governed ? cost.saved(total) : cost.exact(total);
  return (
    <div className="w-[min(20rem,calc(100vw-2rem))] p-4">
      <div className={cx('flex items-center gap-1.5', OVERLINE)}>
        <Leaf className={cx('h-3.5 w-3.5', TONE_TEXT.success)} aria-hidden /> Saved by software
      </div>
      <div className={cx('mt-1 font-semibold tracking-tight tabular-nums text-[var(--ds-ink)]', cost.governed ? 'text-[18px]' : 'text-[22px]')}>{headline}</div>
      <p className="mt-1 text-[12.5px] leading-snug text-[var(--ds-muted)]">
        {SAVINGS_COPY}. The studio’s own tools made these changes instead of paid redraws.
      </p>
      {list.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-[var(--ds-hairline-soft)] pt-3">
          {list.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-[var(--ds-ink)]" title={e.label}>
                {e.label}
              </span>
              {(() => {
                const v = shortShare(cost, e.savedUsd || 0);
                return v ? <span className={cx('shrink-0 tabular-nums', TONE_TEXT.success)}>−{v}</span> : null;
              })()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * The header slot's content: no chip (F3) and nothing in the header. A new saving shows the copy as an app toast in
 * the one slot (`toast`, DS-1c). `compact` is kept for the slot contract and changes nothing.
 */
export const SavingsChip: React.FC<{ studio: Pick<StudioController, 'doc'> & { caps?: StudioController['caps']; byok?: boolean }; compact?: boolean }> = ({ studio }) => {
  useSavingsToast(!!studio.doc, savedTotal(studio.doc));
  return null;
};

/** Header-slot adapter (registered by mobile/index.ts). */
export const SavingsChipSlot: React.FC<{ studio: StudioController; compact: boolean }> = ({ studio, compact }) => <SavingsChip studio={studio} compact={compact} />;

export default SavingsChip;
