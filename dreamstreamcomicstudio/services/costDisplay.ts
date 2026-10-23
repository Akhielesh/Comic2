// How a price is shown to THIS user (P1-LIMITS).
//
// Governed users (everyone on the included DreamStream usage) never see dollars for it: a
// quote reads as a share of their usage — "≈2% of your usage". Admins and calls on the user's
// own API key (they pay the provider) see the real price — "$0.05".
//
// The share is computed from public registry prices (shared/comic/models.ts) and the server's
// `friendlyUnits.pctPerStandardPage` (how much of the usage one Standard comic page takes), so
// the client never needs — or learns from this module — the dollar size of anyone's usage.

import { PLAN_USD_PER_PAGE, PLATFORM_MARKUP, formatUsd, tierPagePrice } from '../shared/comic/models';
import { showsUsageMeter, type AllowanceStatus } from './usageAllowance';

export interface CostDisplayContext {
  /** Show prices as a share of the user's usage instead of dollars. */
  governed: boolean;
  /** Percent of the user's usage one provider-cost dollar takes (null when unknown). */
  pctPerUsd?: number | null;
}

/** Admin / own-key context: real prices. */
export const DOLLAR_CONTEXT: CostDisplayContext = { governed: false };

/** Provider cost of one Standard comic page — the same formula the server uses for friendly units. */
export const standardPageProviderUsd = (): number => tierPagePrice('standard', true) + PLAN_USD_PER_PAGE;

/**
 * Build the display context from the usage status. `byok` (the call runs on the user's own key)
 * always shows real prices: it doesn't touch their usage. Dollars otherwise need a POSITIVE
 * answer that no limit applies (`governed: false` — admins, exempt accounts, metering off): a
 * status that hasn't loaded yet or couldn't be read never shows a governed user a dollar
 * figure — the quote stays in usage terms until the share is known.
 */
export const costContextFromAllowance = (
  status: AllowanceStatus | null | undefined,
  opts: { byok?: boolean } = {}
): CostDisplayContext => {
  if (opts.byok || status?.governed === false) return DOLLAR_CONTEXT;
  const perPage = showsUsageMeter(status) ? status.friendlyUnits?.pctPerStandardPage : null;
  const pageUsd = standardPageProviderUsd();
  return {
    governed: true,
    pctPerUsd: typeof perPage === 'number' && perPage > 0 && pageUsd > 0 ? perPage / pageUsd : null
  };
};

const trimZero = (s: string) => s.replace(/\.0$/, '');

/**
 * "≈2% of your usage" for governed users; "$0.05" for admins / own key.
 * `includesMarkup`: the quote was priced with the 1.3x platform markup (e.g. estimateJobs);
 * usage counts real provider cost, so the markup is taken back out first.
 */
export const formatCostForUser = (usd: number, ctx: CostDisplayContext, opts: { includesMarkup?: boolean } = {}): string => {
  const amount = Number.isFinite(usd) && usd > 0 ? usd : 0;
  if (!ctx.governed) return formatUsd(amount);
  if (amount === 0) return 'Free';
  const providerUsd = opts.includesMarkup ? amount / PLATFORM_MARKUP : amount;
  const perUsd = ctx.pctPerUsd;
  if (!(typeof perUsd === 'number' && perUsd > 0)) return 'uses a little of your usage';
  const pct = providerUsd * perUsd;
  if (pct < 0.1) return '<0.1% of your usage';
  if (pct < 10) return `≈${trimZero(pct.toFixed(1))}% of your usage`;
  return `≈${Math.round(pct)}% of your usage`;
};

/**
 * The share alone, for a narrow spot (a header pill, a table cell, a thumbnail label):
 * "≈2% of your usage" → "≈2%", "<0.1% of your usage" → "<0.1%", "Free" → "Free". Anything else (dollars,
 * or "uses a little of your usage" while the share is unknown) → undefined: the caller then shows no
 * figure in that spot — never a dollar amount for a governed user.
 */
export const compactUsageShare = (formatted: string): string | undefined => {
  if (formatted === 'Free') return formatted;
  const m = /^(≈[\d.]+%|<0\.1%) of your usage$/.exec(formatted);
  return m ? m[1] : undefined;
};
