// How the board prints money (P1-LIMITS rule: governed users never see dollars).
//
// Every price and spend figure on the board goes through services/costDisplay.ts formatCostForUser:
//   • governed users (the included DreamStream usage) read a share of their usage — "≈2% of your usage";
//   • admins, exempt accounts and calls on the user's own key read real dollars — "≈ $0.07".
// The context is decided by the server's word only: `caps.byok` / `caps.admin`, the shared allowance
// status (services/usageAllowance, published by the header's usage meter — this module never fetches,
// never polls) and the optional `caps.usage` snapshot. Until one of them says "no limit applies", a
// quote stays in usage terms: an unknown status never shows a governed user a dollar figure.

import { useEffect, useMemo, useState } from 'react';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import { DOLLAR_CONTEXT, costContextFromAllowance, formatCostForUser, standardPageProviderUsd, type CostDisplayContext } from '../../../services/costDisplay';
import { costFormat } from '../conversation/cost';
import { getLastAllowanceStatus, subscribeAllowanceStatus, type AllowanceStatus } from '../../../services/usageAllowance';
import { formatSpend } from './boardModel';

type CapsLike = Partial<Pick<StudioCaps, 'byok' | 'admin' | 'usage'>> | null | undefined;

/** The display context for this user (pure). */
export const boardCostContext = (caps: CapsLike, status: AllowanceStatus | null | undefined): CostDisplayContext => {
  // Their own key (they pay the provider) or an admin (no limit): real prices.
  if (caps?.byok || caps?.admin) return DOLLAR_CONTEXT;
  if (status) return costContextFromAllowance(status);
  const usage = caps?.usage;
  if (usage) {
    if (!usage.governed) return DOLLAR_CONTEXT;
    const pageUsd = standardPageProviderUsd();
    const per = usage.pctPerStandardPage;
    return { governed: true, pctPerUsd: typeof per === 'number' && per > 0 && pageUsd > 0 ? per / pageUsd : null };
  }
  return costContextFromAllowance(null);
};

export interface CostFormat {
  /** Show usage shares instead of dollars. */
  governed: boolean;
  /**
   * A price BEFORE spending (registry quote, markup included unless BYOK):
   * "≈ $0.07" for dollars, "≈2% of your usage" / "<0.1% of your usage" for governed users.
   */
  quote(usd: number): string;
  /** Money already spent (charged amounts): "$0.42" / "≈4% of your usage". Own-key entries stay in dollars. */
  spent(usd: number, opts?: { byok?: boolean }): string;
}

/**
 * A board price is the studio's one quote format (conversation/cost.ts `costFormat(ctx).approx`): the Draw button
 * here, the chip and the Approve card print the same figure the same way ("≈ $0.07", "≈2% of your usage", "Free").
 * Money already spent keeps the board's per-call precision ("$0.004").
 */
export const costFormatFor = (ctx: CostDisplayContext): CostFormat => {
  const one = costFormat(ctx);
  return {
    governed: ctx.governed,
    quote: (usd) => one.approx(usd),
    spent: (usd, opts) => (!ctx.governed || opts?.byok ? formatSpend(usd) : formatCostForUser(usd, ctx, { includesMarkup: true }))
  };
};

/** The board's cost formatter, kept current with the shared usage status (subscribe only; no requests). */
export const useCostFormat = (caps: CapsLike): CostFormat => {
  const [status, setStatus] = useState<AllowanceStatus | null>(() => getLastAllowanceStatus());
  useEffect(() => {
    const unsubscribe = subscribeAllowanceStatus(setStatus);
    setStatus(getLastAllowanceStatus());
    return unsubscribe;
  }, []);
  const byok = !!caps?.byok;
  const admin = !!caps?.admin;
  const usage = caps?.usage;
  const usageKey = usage ? `${usage.governed}|${usage.pctPerStandardPage ?? ''}` : '';
  return useMemo(
    () => costFormatFor(boardCostContext({ byok, admin, usage }, status)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byok, admin, usageKey, status]
  );
};
