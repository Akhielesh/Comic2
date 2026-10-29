// The buttons for OutageOptions (reliability.md §3), shared by the banner (≤ 3, compact) and the outage card.
//
//   wait_and_retry → arms a one-shot retry of the blocked action (retryIntents.ts); free.
//   other_route    → the SAME model on the user's other same-payer route: the blocked action is re-sent now (the
//                    server's breaker-aware route choice takes the route that answers; no look change).
//   switch_model   → opens the model picker on that model (the models.md §3.6 C confirm "consistency can be
//                    affected" lives there). NEVER switches by itself.
//   add_key        → Settings → API keys in a new tab (a waiting retry on this page survives).

import React from 'react';
import { ArrowRightLeft, Clock3, ExternalLink, KeyRound, RotateCcw } from 'lucide-react';
import type { OutageOption } from '../../../shared/comic/modelHealth';
import type { StudioAction } from '../../../shared/comic/ops';
import type { CostFormat } from '../conversation/cost';
import { cx } from '../conversation/ui';
import { API_KEYS_HREF } from './copy';

export interface OptionHandlers {
  /** The action the preflight refused (wait / other route re-send it). */
  blockedAction?: StudioAction;
  onWait?(): void;
  onRetryNow?(): void;
  onSwitch?(option: Extract<OutageOption, { kind: 'switch_model' }>): void;
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';
const BTN = `inline-flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-left text-[12.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-[var(--ds-motion-fast)] ${FOCUS}`;

/** The visible label and price parts of one option. */
export const optionText = (option: OutageOption, cost: CostFormat): { label: string; price?: string; detail?: string } => {
  switch (option.kind) {
    case 'wait_and_retry':
      return { label: 'Wait and retry automatically', price: 'Free', ...(option.etaHint ? { detail: `usually ${option.etaHint}` } : {}) };
    case 'other_route':
      return { label: option.label, price: 'Same model' };
    case 'add_key':
      return { label: option.label };
    case 'switch_model': {
      const per = cost.governed ? cost.approx(option.usdPerImage) : `${cost.approx(option.usdPerImage)} per image`;
      const redraw =
        option.redrawCount > 0
          ? `redraw ${option.redrawCount} drawn ${option.redrawCount === 1 ? 'image' : 'images'} ${cost.approx(option.redrawUsd)} to keep the book consistent`
          : 'nothing drawn yet to redraw';
      const family = option.consistency === 'same_family' ? 'same family' : 'a different look';
      return { label: `Try ${option.nickname} instead`, price: per, detail: `${family} · ${redraw}` };
    }
    default:
      return { label: 'Option' };
  }
};

const ICON: Record<OutageOption['kind'], React.ReactNode> = {
  wait_and_retry: <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  other_route: <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  switch_model: <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  add_key: <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
};

export const OptionButton: React.FC<{
  option: OutageOption;
  cost: CostFormat;
  handlers: OptionHandlers;
  /** Banner: one line, no detail. */
  compact?: boolean;
  disabled?: boolean;
}> = ({ option, cost, handlers, compact, disabled }) => {
  const t = optionText(option, cost);
  const body = (
    <>
      {ICON[option.kind]}
      <span className="min-w-0">
        <span className="[overflow-wrap:anywhere]">{t.label}</span>
        {t.price && <span className="ml-1 whitespace-nowrap tabular-nums text-[var(--ds-muted)]">· {t.price}</span>}
        {!compact && t.detail && <span className="block text-[11.5px] font-normal leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]">{t.detail}</span>}
      </span>
    </>
  );
  if (option.kind === 'add_key') {
    return (
      <a href={API_KEYS_HREF} target="_blank" rel="noopener noreferrer" className={BTN} data-option="add_key">
        {body}
        <ExternalLink className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" aria-hidden />
        <span className="sr-only"> (opens Settings in a new tab)</span>
      </a>
    );
  }
  const onClick =
    option.kind === 'wait_and_retry'
      ? handlers.onWait
      : option.kind === 'other_route'
        ? handlers.onRetryNow
        : option.kind === 'switch_model'
          ? () => handlers.onSwitch?.(option)
          : undefined;
  const needsAction = option.kind === 'wait_and_retry' || option.kind === 'other_route';
  return (
    <button
      type="button"
      className={cx(BTN)}
      data-option={option.kind}
      disabled={disabled || !onClick || (needsAction && !handlers.blockedAction)}
      onClick={onClick}
      title={compact && t.detail ? `${t.label} · ${t.detail}` : undefined}
    >
      {body}
    </button>
  );
};
