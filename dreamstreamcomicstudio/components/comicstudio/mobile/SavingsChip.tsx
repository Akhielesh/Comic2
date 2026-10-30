// "Saved by software" (decisions-final #6): a subtle trust signal that the studio did the work with its
// own tools instead of a paid redraw — "Free — done by the editor, no AI cost". Honest numbers only:
// the total is `doc.spend.savedUsd` (the server adds a SpendEntry.savedUsd for a reuse of an identical
// render, or a free step picked over a quoted paid one). Nothing saved → nothing shown.
//
//  - Tablets/desktop: a quiet chip after the spend chip; it briefly says the copy when a new saving
//    lands (aria-live), and opens a small breakdown.
//  - Phones: no header chip (the ⋯ menu and the spend sheet show the total); a new saving shows the
//    same line as a calm transient toast under the header.
//  - Money is printed for THIS user (conversation/cost.ts): governed users read a share of their usage
//    ("Saved ≈0.5% of your usage") or just the copy — never dollars, also before their status loads.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Leaf } from 'lucide-react';
import { OVERLINE, STATUS_CHIP_TONE, STATUS_EDGE, TONE_TEXT } from '../../chat/studioDesign';
import type { ComicDoc, SpendEntry } from '../../../shared/comic/doc';
import { useCostFormat, type CostFormat } from '../conversation/cost';
import { compactUsageShare } from '../../../services/costDisplay';
import type { StudioController } from '../types';
import { AdaptiveSheet } from './sheets/AdaptiveSheet';
import { isPhoneLayout } from './formFactor';
import { useFormFactor } from './useFormFactor';
import { phoneChromeVars } from './shell/phoneChrome';

export const SAVINGS_COPY = 'Free — done by the editor, no AI cost';
const FLASH_MS = 4000;

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

/** Flash true for a few seconds whenever the total grows (not on first sight). */
const useSavingsFlash = (total: number): boolean => {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = total;
    if (before === null || total <= before + 0.00005) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(t);
  }, [total]);
  return flash;
};

/** "Saved ≈0.5% of your usage" → "≈0.5%" for a narrow spot; undefined when it isn't a readable share. */
const shortShare = (cost: CostFormat, usd: number): string | undefined => (cost.governed ? compactUsageShare(cost.exact(usd)) : cost.exact(usd));

/** The breakdown shown from the chip (also used by the phone ⋯ menu's spend sheet). */
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

export const SavingsChip: React.FC<{ studio: Pick<StudioController, 'doc'> & { caps?: StudioController['caps']; byok?: boolean }; compact?: boolean }> = ({
  studio,
  compact = false
}) => {
  const ff = useFormFactor();
  const cost = useCostFormat(studio);
  const total = savedTotal(studio.doc);
  const flash = useSavingsFlash(total);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const doc = studio.doc;
  if (!doc || total <= 0) return null;

  if (isPhoneLayout(ff.layout)) {
    if (!flash || typeof document === 'undefined') return null;
    return createPortal(
      <div
        role="status"
        className={`pointer-events-none fixed left-1/2 z-[60] w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border ${STATUS_EDGE.healthy} bg-[var(--ds-surface-strong)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.12)] backdrop-blur-md studio-reveal`}
        // Portalled to <body>, outside the shell root that sets the phone chrome sizes: apply them here
        // too, so the toast sits 8 px under the header it belongs to (44 px in phone portrait).
        style={{ ...phoneChromeVars(ff.layout), top: 'calc(var(--sa-top, 0px) + var(--header-h, 48px) + 8px)' }}
        data-savings-toast
      >
        <span className="flex items-center gap-1.5">
          <Leaf className={cx('h-3.5 w-3.5 shrink-0', TONE_TEXT.success)} aria-hidden />
          <span className="truncate">{SAVINGS_COPY}</span>
        </span>
      </div>,
      document.body
    );
  }

  // Dollars for admins / own key; a share of the usage for governed users (just "Saved" while unknown).
  const amount = shortShare(cost, total);
  const spoken = cost.governed ? (/^Saved /.test(cost.saved(total)) ? cost.saved(total) : 'Saved some of your usage') : `Saved ${cost.exact(total)}`;
  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${spoken} by software — ${SAVINGS_COPY}`}
        title={SAVINGS_COPY}
        className={cx(
          'inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium tabular-nums transition-colors hover:bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11 coarse:px-3',
          STATUS_CHIP_TONE.healthy,
          flash && 'ring-2 ring-[color:color-mix(in_srgb,var(--ds-success)_25%,transparent)]'
        )}
      >
        <Leaf className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {compact ? amount ?? 'Saved' : amount ? `Saved ${amount}` : 'Saved'}
      </button>
      {/* The copy, briefly, when a new saving lands — under the chip, never widening the header. */}
      <span aria-live="polite" className="sr-only">
        {flash ? `${SAVINGS_COPY}. ${spoken} so far.` : ''}
      </span>
      {flash && !open && (
        <span
          aria-hidden
          className={`pointer-events-none absolute right-0 top-full z-30 mt-2 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border ${STATUS_EDGE.healthy} bg-[var(--ds-surface-strong)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] shadow-[0_4px_16px_rgba(0,0,0,0.12)] studio-reveal`}
        >
          {SAVINGS_COPY}
        </span>
      )}
      <AdaptiveSheet open={open} onClose={() => setOpen(false)} label="Saved by software" title="Saved by software" anchorRef={anchorRef} placement="below" align="end">
        <SavingsBreakdown doc={doc} cost={cost} />
      </AdaptiveSheet>
    </span>
  );
};

/** Header-slot adapter (registered by mobile/index.ts). */
export const SavingsChipSlot: React.FC<{ studio: StudioController; compact: boolean }> = ({ studio, compact }) => <SavingsChip studio={studio} compact={compact} />;

export default SavingsChip;
