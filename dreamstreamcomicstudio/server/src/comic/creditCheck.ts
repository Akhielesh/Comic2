// Money safety for Comic Studio (docs/features/credit-safety.md).
//
// The balance check before spending: right before an approved paid step starts (a drawing run, the whole-book
// approval, a small paid step the person asked for directly), its quote is compared with what the payer has left.
//
//   own key (OpenRouter)  the owner's last reading of exactly this key, refreshed on the server when it is older than
//                         15 minutes (the code behind POST /api/keys/balance). Spendable = the smaller of the key's
//                         remaining limit and the account's USD credits, whichever the provider reported.
//   allowance (governed)  the request's caps.usage: the quote's share of the usage (the same formula the server words
//                         prices with, costText.ts) against the share left.
//
// Unknown never blocks: no reading, a reading that is stale and could not be refreshed, a provider with no balance API
// (Gemini and every dashboard-only provider), an unknown share. Only a known shortfall stops the step, and it then
// starts NOTHING: no reservation, no job, one `credit` card with what it needs, what is left and the ways forward.
//
// The same card (reason 'stopped') ends a run that hit a key with no credit part-way (jobs.ts RenderRun).

import { newId } from '../../../shared/comic/doc.js';
import type { CreditCard, CreditOffer, CreditProvider } from '../../../shared/comic/credit.js';
import { PLATFORM_MARKUP, formatUsd, type ImageRoute } from '../../../shared/comic/models.js';
import { balanceIsFresh, spendableUsd } from '../../../shared/providerBalances.js';
import { latestOwnKeyBalance } from '../services/accountProviderUsage.js';
import { costViewFor, type CostFormatter } from './costText.js';
import type { CreditPort, StudioContext, StudioKeys } from './types.js';

/** The key a paid step spends on: its route and whether that key is the person's own. */
export interface SpendPayer {
  route: ImageRoute;
  byok: boolean;
}

/** What the payer has left, when it is known. */
export type CreditBudget =
  | { known: false }
  | { known: true; payer: 'own_key'; provider: 'openrouter'; leftUsd: number; checkedAt: number }
  | { known: true; payer: 'allowance'; leftPct: number; pctPerUsd: number | null; exhausted: boolean };

export const UNKNOWN_BUDGET: CreditBudget = Object.freeze({ known: false });

/** Rounding slack: a quote that matches what is left to the cent (or a tenth of a percent) fits. */
const USD_SLACK = 0.005;
const PCT_SLACK = 0.05;

/** The production port: the owner's own key through latestOwnKeyBalance (bounded; null when unknown). */
export const defaultCreditPort: CreditPort = {
  ownKeyBalance: ({ ownerId, provider, key }) => latestOwnKeyBalance({ ownerId, provider, key })
};

/** The quote's share of the governed usage, 0..100+ (null when the share of one dollar is unknown). */
export const needPctOf = (budget: CreditBudget, chargedUsd: number): number | null => {
  if (!budget.known || budget.payer !== 'allowance' || budget.pctPerUsd === null) return null;
  return (Math.max(0, chargedUsd) / PLATFORM_MARKUP) * budget.pctPerUsd;
};

/** Whether a quote fits what is left. Unknown always fits (never block on unknown). */
export function fitsBudget(budget: CreditBudget, chargedUsd: number): boolean {
  if (!budget.known) return true;
  if (!(chargedUsd > 0)) return true;
  if (budget.payer === 'own_key') return chargedUsd <= budget.leftUsd + USD_SLACK;
  if (budget.exhausted) return false;
  const need = needPctOf(budget, chargedUsd);
  return need === null || need <= budget.leftPct + PCT_SLACK;
}

/**
 * What the payer of a paid step has left. Own keys: OpenRouter only (Gemini and the dashboard-only providers report no
 * balance), through ctx.credit. Platform keys: the governed usage in ctx.caps (admins, exempt accounts and an unread
 * status are not governed here: unknown). Never throws.
 */
export async function creditBudgetFor(ctx: Pick<StudioContext, 'userId' | 'caps' | 'credit' | 'keys'>, payer: SpendPayer, now: () => number = Date.now): Promise<CreditBudget> {
  try {
    if (payer.byok) {
      const key = ctx.keys[payer.route];
      if (payer.route !== 'openrouter' || !ctx.credit || !key?.byok || !key.key) return UNKNOWN_BUDGET;
      const report = await ctx.credit.ownKeyBalance({ ownerId: ctx.userId, provider: 'openrouter', key: key.key });
      if (!report || !balanceIsFresh(report, now())) return UNKNOWN_BUDGET;
      const left = spendableUsd(report);
      return left === null ? UNKNOWN_BUDGET : { known: true, payer: 'own_key', provider: 'openrouter', leftUsd: left, checkedAt: report.checkedAt };
    }
    const caps = ctx.caps;
    const usage = caps?.usage;
    if (!caps || caps.admin || !usage?.governed) return UNKNOWN_BUDGET;
    const view = costViewFor(caps);
    if (!view.governed) return UNKNOWN_BUDGET;
    if (!usage.exhausted && view.pctPerUsd === null) return UNKNOWN_BUDGET;
    return { known: true, payer: 'allowance', leftPct: usage.exhausted ? 0 : usage.pctLeft, pctPerUsd: view.pctPerUsd, exhausted: usage.exhausted };
  } catch {
    return UNKNOWN_BUDGET;
  }
}

/** The text-route payer (text routes are OpenRouter-first, imageless spends such as translate and the page re-check). */
export const textPayerOf = (keys: StudioKeys): SpendPayer | null =>
  keys.openrouter?.key ? { route: 'openrouter', byok: !!keys.openrouter.byok } : keys.gemini?.key ? { route: 'gemini', byok: !!keys.gemini.byok } : null;

/** "5%", "0.4%", "almost none" — the share of the usage left, in words (never a dollar figure). */
export const pctLeftWords = (pct: number): string => {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  if (p <= 0) return 'none';
  if (p < 0.1) return 'almost none';
  return p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`;
};

/** The provider's name in a sentence. */
export const providerName = (p: CreditProvider | ImageRoute | undefined): string => (p === 'gemini' ? 'Gemini' : 'OpenRouter');

/** The "Not enough credit" card for a known shortfall. `fits` is the smaller run that fits, when there is one. */
export function shortCreditCard(budget: Extract<CreditBudget, { known: true }>, step: { what: string; usd: number }, fits?: CreditOffer & { pages: number }): CreditCard {
  const base = { type: 'credit' as const, id: newId('card'), reason: 'short' as const, what: step.what, ...(fits ? { fits } : {}) };
  if (budget.payer === 'own_key') {
    return { ...base, payer: 'own_key', provider: budget.provider, needUsd: Math.round(step.usd * 1e4) / 1e4, leftUsd: Math.round(budget.leftUsd * 1e4) / 1e4, checkedAt: budget.checkedAt };
  }
  const need = needPctOf(budget, step.usd);
  return { ...base, payer: 'allowance', needPct: need === null ? null : Math.round(need * 10) / 10, leftPct: Math.round(budget.leftPct * 10) / 10 };
}

/**
 * The message beside the card and the outcome the director reads, in the viewer's terms (a governed user's text never
 * holds a dollar amount: the cost formatter words the quote and the left part is a percentage).
 */
export function shortCreditText(budget: Extract<CreditBudget, { known: true }>, step: { what: string; usd: number }, cost: CostFormatter, fits?: { pages: number; usd: number }): { text: string; outcome: string } {
  const left =
    budget.payer === 'own_key'
      ? `your ${providerName(budget.provider)} key has ${formatUsd(budget.leftUsd)} left`
      : budget.exhausted
        ? 'none of your usage is left'
        : `${pctLeftWords(budget.leftPct)} of your usage is left`;
  const fitsLine = fits ? ` ${fits.pages === 1 ? 'The first page fits' : `The first ${fits.pages} pages fit`} (${cost.approx(fits.usd)}).` : '';
  const text = `Not enough credit, so I haven't started ${step.what}: it needs ${cost.approx(step.usd)} and ${left}. Nothing was charged.${fitsLine}`;
  const ways = [budget.payer === 'own_key' ? 'top up' : 'use their own key', budget.payer === 'own_key' ? 'switch key in Settings' : '', fits ? `draw what fits (${fits.pages} ${fits.pages === 1 ? 'page' : 'pages'})` : '']
    .filter(Boolean)
    .join(', ');
  return {
    text,
    outcome: `Not started: not enough credit. ${step.what} needs ${cost.approx(step.usd)} and ${left}. Nothing was drawn and nothing was charged; the card offers: ${ways}. Do not say the drawing is under way.`
  };
}

/** The card a run posts when it stopped on a key with no credit (or reached none). */
export function stoppedCreditCard(input: { byok: boolean; route: ImageRoute; noQuota: boolean; drawn: number; notStarted: number; rest?: CreditOffer }): CreditCard {
  return {
    type: 'credit',
    id: newId('card'),
    reason: 'stopped',
    payer: input.byok ? 'own_key' : 'allowance',
    ...(input.byok ? { provider: input.route } : {}),
    ...(input.noQuota ? { noQuota: true } : {}),
    drawn: input.drawn,
    notStarted: input.notStarted,
    ...(input.rest ? { rest: input.rest } : {})
  };
}

/** The reason a stopped run gives in its completion ("Stopped before pages 2 and 3: …"). */
export const stoppedReason = (input: { byok: boolean; route: ImageRoute; noQuota: boolean }): string =>
  input.byok
    ? input.noQuota
      ? `your ${providerName(input.route)} key has no image quota. Nothing more was charged.`
      : `your ${providerName(input.route)} key ran out of credit (or reached its spending limit). Nothing more was charged.`
    : "the drawing service ran out of capacity. Nothing more was used from your usage.";

/** "Your OpenRouter key ran out of credit, so the rest of this run carried on with your Gemini key …" */
export const continuedText = (from: ImageRoute, to: ImageRoute, byok: boolean, model: string): string =>
  byok
    ? `Your ${providerName(from)} key ran out of credit, so the rest of this run carried on with your ${providerName(to)} key on ${model}, the same model, so every page still matches. Top up ${providerName(from)} when you can.`
    : `The drawing service ran out of capacity on one connection, so I carried on through another with ${model}, the same model, so every page still matches.`;
