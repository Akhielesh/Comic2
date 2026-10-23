// How the conversation shows a price to THIS user (P2-CONVERSATION; P1-LIMITS rule).
//
// Governed users — everyone on the included DreamStream usage — never see dollars: every chip,
// quote, badge and button speaks in a share of their usage ("≈2% of your usage"). Admins and
// comics that draw on the user's own API key keep real prices ("≈ $0.07"). The wording comes
// from services/costDisplay.ts formatCostForUser, so the conversation, the board and the
// header meter say the same thing.
//
// Where the context comes from (first answer wins):
//   1. the comic runs on the user's own key (studio.byok / caps.byok) → dollars;
//   2. the shared usage status (services/usageAllowance — the header meter reads it too);
//   3. the server's caps snapshot (StudioCaps.usage, percentages only);
//   4. caps.admin (admins are never governed) → dollars;
//   5. otherwise usage terms with an unknown share ("uses a little of your usage") — a governed
//      user never sees a dollar figure just because the status hasn't loaded yet.
// Nothing here polls: the status is read once on mount (coalesced, skipped when fresh) and then
// follows the shared store, which refreshes on focus and after a spend.

import { useEffect, useMemo, useState } from 'react';
import { formatUsd } from '../../../shared/comic/models';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import {
  DOLLAR_CONTEXT,
  costContextFromAllowance,
  formatCostForUser,
  standardPageProviderUsd,
  type CostDisplayContext
} from '../../../services/costDisplay';
import {
  getLastAllowanceStatus,
  refreshAllowanceStatus,
  subscribeAllowanceStatus,
  type AllowanceStatus
} from '../../../services/usageAllowance';

export type { CostDisplayContext };

/** The display context for a user (pure; see the header for the order). */
export const costContextFor = (
  status: AllowanceStatus | null | undefined,
  caps: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null | undefined,
  byok = false
): CostDisplayContext => {
  if (byok || caps?.byok) return DOLLAR_CONTEXT;
  if (status) return costContextFromAllowance(status);
  const usage = caps?.usage;
  if (usage) {
    if (!usage.governed) return DOLLAR_CONTEXT;
    const pageUsd = standardPageProviderUsd();
    const per = usage.pctPerStandardPage;
    return { governed: true, pctPerUsd: typeof per === 'number' && per > 0 && pageUsd > 0 ? per / pageUsd : null };
  }
  if (caps?.admin) return DOLLAR_CONTEXT;
  return costContextFromAllowance(null);
};

/** Price strings for one context. Client quotes include the platform markup unless BYOK. */
export interface CostFormat {
  /** True when prices read as a share of the user's usage (no dollars anywhere). */
  governed: boolean;
  /** "$0.07" · "≈2% of your usage" · "Free" (0). */
  exact(usd: number): string;
  /** A quote: "≈ $0.07" · "≈2% of your usage" · "Free" (0). */
  approx(usd: number): string;
  /** Compact badge: "≈$0.07" · "≈2% of your usage" · "Free". */
  badge(usd: number): string;
  /** For screen readers: "about $0.07" · "about 2% of your usage" · "free". */
  spoken(usd: number): string;
  /** What software saved: "Saved ≈$0.07" · "Saved ≈0.5% of your usage" · "No AI cost". */
  saved(usd: number): string;
}

const positive = (usd: number) => (Number.isFinite(usd) && usd > 0 ? usd : 0);

export const costFormat = (ctx: CostDisplayContext): CostFormat => {
  const usage = (usd: number) => formatCostForUser(usd, ctx, { includesMarkup: true });
  if (!ctx.governed) {
    return {
      governed: false,
      exact: (usd) => formatUsd(positive(usd)),
      approx: (usd) => (positive(usd) ? `≈ ${formatUsd(usd)}` : 'Free'),
      badge: (usd) => (positive(usd) ? `≈${formatUsd(usd)}` : 'Free'),
      spoken: (usd) => (positive(usd) ? `about ${formatUsd(usd)}` : 'free'),
      saved: (usd) => (positive(usd) ? `Saved ≈${formatUsd(usd)}` : 'No AI cost')
    };
  }
  return {
    governed: true,
    exact: usage,
    approx: usage,
    badge: usage,
    spoken: (usd) => {
      const s = usage(usd);
      return s === 'Free' ? 'free' : s.startsWith('≈') ? `about ${s.slice(1)}` : s.startsWith('<') ? `less than ${s.slice(1)}` : s;
    },
    saved: (usd) => {
      const s = usage(usd);
      // Only a real, readable share is worth naming; anything smaller is just "no AI cost".
      return /^≈[\d.]+% of your usage$/.test(s) ? `Saved ${s}` : 'No AI cost';
    }
  };
};

/**
 * Server-written spend text (a gate summary: "3 pages on Nano Banana 2.1 (2K) · ≈ $0.21. That
 * would bring this comic to $1.20 — over your $1.00 budget.") made safe for a governed user:
 * the quote becomes a share of their usage and the dollar budget sentence is dropped (the reason
 * line already says the budget is in the way). Text with no dollar figures is returned as is, so
 * a server that already speaks in usage terms is untouched. Only for server-generated spend
 * summaries — never for story text.
 */
export const usageSafeSpendText = (text: string, fmt: CostFormat): string => {
  if (!fmt.governed || typeof text !== 'string' || !text.includes('$')) return text;
  return text
    .replace(/\.?\s*That would bring this comic to[^.]*\$[^.]*(?:\.\d+[^.]*)*\.?\s*$/i, '.')
    .replace(/≈\s*\$\s?(\d+(?:\.\d+)?)/g, (_m, n: string) => fmt.approx(Number(n)))
    .replace(/<\s*\$\s?0\.01/g, () => fmt.approx(0.005))
    .replace(/\$\s?(\d+(?:\.\d+)?)/g, (_m, n: string) => fmt.approx(Number(n)))
    .replace(/\.\.$/, '.');
};

/** This page already asked once (a failing endpoint must not be re-asked by every new card). */
let askedForStatus = false;

/** The live display context for the studio's user (subscribes to the shared usage status). */
export const useCostContext = (studio: { byok?: boolean; caps?: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null }): CostDisplayContext => {
  const [status, setStatus] = useState<AllowanceStatus | null>(() => getLastAllowanceStatus());
  // Own-key comics and admins never need the status: their prices are real dollars.
  const skip = !!(studio.byok || studio.caps?.byok || studio.caps?.admin);
  useEffect(() => {
    const off = subscribeAllowanceStatus(setStatus);
    setStatus(getLastAllowanceStatus()); // a status published between render and subscribe
    // Read once when nobody has yet (coalesced; the header meter usually did). After that the shared
    // store keeps it current — on focus and after a spend — so nothing here polls.
    if (!skip && !askedForStatus && !getLastAllowanceStatus()) {
      askedForStatus = true;
      void refreshAllowanceStatus().catch(() => null);
    }
    return off;
  }, [skip]);
  const caps = studio.caps;
  return useMemo(
    () => costContextFor(status, caps, studio.byok),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, studio.byok, caps?.byok, caps?.admin, caps?.usage?.governed, caps?.usage?.pctPerStandardPage]
  );
};

/** Price strings for the studio's user. */
export const useCostFormat = (studio: { byok?: boolean; caps?: Pick<StudioCaps, 'byok' | 'admin' | 'usage'> | null }): CostFormat => {
  const ctx = useCostContext(studio);
  return useMemo(() => costFormat(ctx), [ctx]);
};
