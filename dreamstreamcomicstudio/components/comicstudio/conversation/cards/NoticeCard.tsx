// "notice" card: a short, honest status line from the studio (missing key, billing,
// a finished job). Tones are tinted, never alarming unless it really is an error.
// Long URLs and tokens wrap anywhere so they never spill across the column (visualqa P1-3).
//
// Fix chips (plan §5.1, §6; K1 contract): a notice may carry `fixes` — the server's held-back notice ("Use the
// layout that fits" · "Draw page 2 anyway") and its page-check notice (qcNotice.ts: "Make Meera's line in panel 6
// a caption" · "Redraw panel 6 with Meera"). They render as chips under the text, FREE FIRST:
//   - a free chip runs its action as is (a `patch` of client-patchable ops — the server re-validates it) and says
//     "Free";
//   - a paid chip shows its quote in THIS user's terms (conversation/cost.ts → services/costDisplay
//     formatCostForUser: a share of the usage for governed users, never dollars; "on your key" for comics drawn on
//     the user's own key) and goes through the existing spend gate: the action is sent with its `quotedUsd`, the
//     tap is the confirmation, and the server re-gates it (an approval card) if the fresh price is higher.
// A chip is free only when its action spends nothing: a "free" flag on a spend action is treated as paid, and a
// paid action without a quote is sent with quotedUsd 0, so it always comes back as a priced approval.
// Extra flags on an action (`safe: true` for a safer take) pass through untouched.

import React from 'react';
import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { Card, NoticeFix } from '../../../../shared/comic/doc';
import { isSpendAction, type StudioAction } from '../../../../shared/comic/ops';
import { TONE_CHIP, TONE_SURFACE, TONE_TEXT } from '../../../chat/studioDesign';
import type { StudioCaps } from '../../../../shared/comic/capabilities';
import { useCostFormat, type CostFormat } from '../cost';
import { ChipButton, cx } from '../ui';
import { useAction } from './useAction';

type NoticeCardData = Extract<Card, { type: 'notice' }>;

const TONES: Record<NoticeCardData['tone'], { cls: string; icon: React.ReactNode; role: 'status' | 'alert' }> = {
  info: {
    cls: 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)]',
    icon: <Info className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />,
    role: 'status'
  },
  success: {
    cls: `${TONE_SURFACE.success} text-[var(--ds-ink)]`,
    icon: <CircleCheck className={cx('h-4 w-4', TONE_TEXT.success)} aria-hidden />,
    role: 'status'
  },
  warn: {
    cls: `${TONE_SURFACE.warning} text-[var(--ds-ink)]`,
    icon: <TriangleAlert className={cx('h-4 w-4', TONE_TEXT.warning)} aria-hidden />,
    role: 'status'
  },
  error: {
    cls: `${TONE_SURFACE.danger} text-[var(--ds-ink)]`,
    icon: <CircleX className={cx('h-4 w-4', TONE_TEXT.danger)} aria-hidden />,
    role: 'alert'
  }
};

/** What a notice needs from the studio to run its fix chips (the live controller, or a test fake). */
export interface NoticeCardStudio {
  act(action: StudioAction): Promise<unknown> | unknown;
  /** The comic draws on the user's own key: prices read "on your key". */
  byok?: boolean;
  caps?: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null;
}

const priceOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A chip as rendered: paid when its action spends (whatever its `free` flag says), with the quote it carries. */
export interface NoticeChip {
  fix: NoticeFix;
  paid: boolean;
  /** Paid chips: the action's quotedUsd, when it has one. */
  usd?: number;
  /** The action as it is sent (a paid one always carries a quotedUsd). */
  action: StudioAction;
}

/** The card's fixes as chips, free first (stable within each group). */
export const noticeChips = (fixes: NoticeFix[] | undefined): NoticeChip[] => {
  if (!Array.isArray(fixes)) return [];
  const chips = fixes
    .filter((f): f is NoticeFix => !!f && typeof f.label === 'string' && !!f.label.trim() && !!f.action && typeof f.action.type === 'string')
    .map((fix): NoticeChip => {
      const paid = isSpendAction(fix.action) || fix.free !== true;
      const usd = paid ? priceOf((fix.action as { quotedUsd?: unknown }).quotedUsd) : undefined;
      // A spend without a quote is sent quoted at 0, so the server answers with a priced approval, never a bill.
      const action = paid && isSpendAction(fix.action) && usd === undefined ? ({ ...fix.action, quotedUsd: 0 } as StudioAction) : fix.action;
      return { fix, paid, ...(usd !== undefined ? { usd } : {}), action };
    });
  return [...chips.filter((c) => !c.paid), ...chips.filter((c) => c.paid)];
};

/** A paid chip's price for this user: "≈1% of your usage" (governed) · "≈$0.05 on your key" (BYOK) · "≈$0.05". */
export const noticePrice = (cost: CostFormat, usd: number, byok: boolean): string => (!cost.governed && byok ? `${cost.badge(usd)} on your key` : cost.badge(usd));

/** A price as servers write it at the end of a label ("· ≈$0.05", "(Free)"), dropped so the badge says it once. */
const PRICE_SUFFIX = /(?:\s*\((?:free|[≈<]\s*\$[\d.,]+)\)|\s+[·•–—-]\s*(?:free|[≈<]\s*\$[\d.,]+|[≈<]\s*[\d.,]+%\s*of\s+your\s+usage))\s*$/i;
const chipText = (label: string): string => label.replace(PRICE_SUFFIX, '').trim() || label;

const NoticeFixChips: React.FC<{ chips: NoticeChip[]; studio: NoticeCardStudio; cardId: string }> = ({ chips, studio, cardId }) => {
  const byok = !!(studio.byok || studio.caps?.byok);
  const cost = useCostFormat({ byok, caps: studio.caps ?? null });
  const { run, isPending } = useAction(studio.act);
  const [done, setDone] = React.useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 pl-[1.625rem]" role="group" aria-label="Fixes">
      {chips.map((c, i) => {
        const key = `${cardId}:${i}`;
        const busy = isPending(key);
        const finished = !c.paid && done.has(key);
        const price = c.paid ? (c.usd !== undefined ? noticePrice(cost, c.usd, byok) : undefined) : 'Free';
        return (
          <ChipButton
            key={key}
            className="min-w-0 !text-[12.5px] coarse:!text-[13px]"
            disabled={busy || finished}
            aria-busy={busy || undefined}
            data-fix={c.paid ? 'paid' : 'free'}
            title={
              c.paid
                ? c.usd !== undefined
                  ? 'Estimate — tapping is your OK, and the price is re-checked before anything is drawn'
                  : 'I’ll confirm the price with you before anything is drawn'
                : c.action.type === 'patch'
                  ? 'Free — done by the editor, no AI cost'
                  : 'Free — no charge to you'
            }
            onClick={() => {
              void run(key, c.action).then((ok) => {
                if (ok && !c.paid) setDone((prev) => new Set(prev).add(key));
              });
            }}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            {finished && <CircleCheck className={cx('h-3.5 w-3.5 shrink-0', TONE_TEXT.success)} aria-hidden />}
            <span className="min-w-0 [overflow-wrap:anywhere]">{chipText(c.fix.label)}</span>
            {/* The name a screen reader hears is the visible text: "Use the layout that fits, Free". */}
            {price && <span className="sr-only">,</span>}
            {price && ' '}
            {price && (
              <span
                className={cx(
                  'min-w-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums [overflow-wrap:anywhere]',
                  c.paid ? 'bg-[var(--ds-well-strong)] text-[var(--ds-muted)]' : TONE_CHIP.success
                )}
              >
                {finished ? 'Done' : price}
              </span>
            )}
          </ChipButton>
        );
      })}
    </div>
  );
};

/**
 * `studio` is optional so the card still renders where no controller is passed (older hosts): the text shows, and
 * the fix chips — which need the controller to run — appear wherever the host passes it (CardRenderer).
 */
export const NoticeCard: React.FC<{ card: NoticeCardData; studio?: NoticeCardStudio }> = ({ card, studio }) => {
  const tone = TONES[card.tone] || TONES.info;
  const chips = studio ? noticeChips(card.fixes) : [];
  // The live region holds the words only: the chips sit beside it, so a chip turning "Done" is not re-announced.
  return (
    <div className={cx('min-w-0 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug', tone.cls)}>
      <div role={tone.role} className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{tone.icon}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{typeof card.text === 'string' ? card.text : ''}</span>
      </div>
      {studio && chips.length > 0 && <NoticeFixChips chips={chips} studio={studio} cardId={card.id} />}
    </div>
  );
};
