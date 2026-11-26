// Money safety for Comic Studio (docs/features/credit-safety.md).
//
// The balance check before spending: right before an approved paid step starts (a drawing run, the whole-book
// approval, a small paid step the person asked for directly), its quote is compared with what the payer has left.
//
//   own key (OpenRouter)  the owner's last reading of exactly this key, refreshed on the server when it is older than
//                         15 minutes (the code behind POST /api/keys/balance). Spendable = the smaller of the key's
//                         remaining limit and the account's USD credits, whichever the provider reported. A reading
//                         that would refuse the step and is more than 30 s old is read again once first (the person
//                         may have just topped up).
//   allowance (governed)  the request's caps.usage: the quote's share of the usage (the same formula the server words
//                         prices with, costText.ts) against the share left.
//
// Either way what this comic is drawing right now (its held quote, pendingUsdOf) is set aside first: the reading was
// usually taken before that run started, and the run will spend it.
//
// Unknown never blocks: no reading, a reading that is stale and could not be refreshed, a provider with no balance API
// (Gemini and every dashboard-only provider), an unknown share. Only a known shortfall stops the step, and it then
// starts NOTHING: no reservation, no job, one `credit` card with what it needs, what is left and the ways forward.
//
// The same card (reason 'stopped') ends a run that hit a key with no credit part-way (jobs.ts RenderRun).

import { newId } from '../../../shared/comic/doc.js';
import { creditProviderName, creditShareWords, type CreditCard, type CreditKey, type CreditOffer, type CreditProvider } from '../../../shared/comic/credit.js';
import { PLATFORM_MARKUP, formatUsd, type ImageRoute } from '../../../shared/comic/models.js';
import { balanceIsFresh, spendableUsd, type ProviderBalanceReport } from '../../../shared/providerBalances.js';
import { latestOwnKeyBalance } from '../services/accountProviderUsage.js';
import { costViewFor, type CostFormatter } from './costText.js';
import type { CreditPort, StudioContext, StudioKeys } from './types.js';

/** The key a paid step spends on: its route and whether that key is the person's own. */
export interface SpendPayer {
  route: ImageRoute;
  byok: boolean;
}

/**
 * What the payer has left, when it is known, after what this comic is drawing right now (`held`: that set something
 * aside).
 */
export type CreditBudget =
  | { known: false }
  | { known: true; payer: 'own_key'; provider: 'openrouter'; leftUsd: number; checkedAt: number; held?: boolean }
  | { known: true; payer: 'allowance'; leftPct: number; pctPerUsd: number | null; exhausted: boolean; held?: boolean };

export const UNKNOWN_BUDGET: CreditBudget = Object.freeze({ known: false });

/** Rounding slack: a quote that matches what is left to the cent (or a tenth of a percent) fits. */
const USD_SLACK = 0.005;
const PCT_SLACK = 0.05;

/** A reading that would refuse a step is read again first once it is older than this (a top-up may have landed). */
export const RECHECK_REFUSAL_AFTER_MS = 30_000;

/** The production port: the owner's own key through latestOwnKeyBalance (bounded; null when unknown). */
export const defaultCreditPort: CreditPort = {
  ownKeyBalance: ({ ownerId, provider, key, maxAgeMs }) => latestOwnKeyBalance({ ownerId, provider, key }, maxAgeMs === undefined ? {} : { maxAgeMs })
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

/** An own-key reading as a budget: unknown unless it is fresh and reports a spendable amount. */
const ownKeyBudget = (report: ProviderBalanceReport | null, now: number, heldUsd: number): CreditBudget => {
  if (!report || !balanceIsFresh(report, now)) return UNKNOWN_BUDGET;
  const left = spendableUsd(report);
  if (left === null) return UNKNOWN_BUDGET;
  return {
    known: true,
    payer: 'own_key',
    provider: 'openrouter',
    leftUsd: Math.max(0, left - heldUsd),
    checkedAt: report.checkedAt,
    ...(heldUsd > 0 ? { held: true } : {})
  };
};

/**
 * What the payer of a paid step has left. Own keys: OpenRouter only (Gemini and the dashboard-only providers report no
 * balance), through ctx.credit; when `needUsd` would not fit a reading older than RECHECK_REFUSAL_AFTER_MS, the
 * provider is read again once and the newer reading decides. Platform keys: the governed usage in ctx.caps (admins,
 * exempt accounts and an unread status are not governed here: unknown). `heldUsd` (what this comic is drawing right
 * now) is set aside from either. Never throws.
 */
export async function creditBudgetFor(
  ctx: Pick<StudioContext, 'userId' | 'caps' | 'credit' | 'keys'>,
  payer: SpendPayer,
  opts: { needUsd?: number; heldUsd?: number; now?: () => number } = {}
): Promise<CreditBudget> {
  const now = opts.now ?? Date.now;
  const held = Number.isFinite(opts.heldUsd) && (opts.heldUsd as number) > 0 ? (opts.heldUsd as number) : 0;
  try {
    if (payer.byok) {
      const key = ctx.keys[payer.route];
      const credit = ctx.credit;
      if (payer.route !== 'openrouter' || !credit || !key?.byok || !key.key) return UNKNOWN_BUDGET;
      const read = (maxAgeMs?: number) =>
        credit.ownKeyBalance({ ownerId: ctx.userId, provider: 'openrouter', key: key.key, ...(maxAgeMs === undefined ? {} : { maxAgeMs }) });
      const budget = ownKeyBudget(await read(), now(), held);
      const need = opts.needUsd ?? 0;
      if (!budget.known || budget.payer !== 'own_key' || fitsBudget(budget, need) || now() - budget.checkedAt <= RECHECK_REFUSAL_AFTER_MS) return budget;
      // About to refuse on a reading taken a while ago (often right after a run stopped, before a top-up): read again.
      const again = ownKeyBudget(await read(RECHECK_REFUSAL_AFTER_MS), now(), held);
      return again.known ? again : budget;
    }
    const caps = ctx.caps;
    const usage = caps?.usage;
    if (!caps || caps.admin || !usage?.governed) return UNKNOWN_BUDGET;
    const view = costViewFor(caps);
    if (!view.governed) return UNKNOWN_BUDGET;
    if (!usage.exhausted && view.pctPerUsd === null) return UNKNOWN_BUDGET;
    const heldPct = held > 0 && view.pctPerUsd !== null ? (held / PLATFORM_MARKUP) * view.pctPerUsd : 0;
    const leftPct = usage.exhausted ? 0 : Math.max(0, usage.pctLeft - heldPct);
    return { known: true, payer: 'allowance', leftPct, pctPerUsd: view.pctPerUsd, exhausted: usage.exhausted, ...(heldPct > 0 ? { held: true } : {}) };
  } catch {
    return UNKNOWN_BUDGET;
  }
}

/** The text-route payer (text routes are OpenRouter-first, imageless spends such as translate and the page re-check). */
export const textPayerOf = (keys: StudioKeys): SpendPayer | null =>
  keys.openrouter?.key ? { route: 'openrouter', byok: !!keys.openrouter.byok } : keys.gemini?.key ? { route: 'gemini', byok: !!keys.gemini.byok } : null;

const providerName = (p: CreditProvider | ImageRoute | undefined): string => creditProviderName(p);

/** The "Not enough credit" card for a known shortfall. `fits` is the smaller run that fits, when there is one. */
export function shortCreditCard(budget: Extract<CreditBudget, { known: true }>, step: { what: string; usd: number }, fits?: CreditOffer & { pages: number }): CreditCard {
  const base = { type: 'credit' as const, id: newId('card'), reason: 'short' as const, what: step.what, ...(budget.held ? { held: true } : {}), ...(fits ? { fits } : {}) };
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
  const after = budget.held ? ' after what’s drawing now' : '';
  const left =
    budget.payer === 'own_key'
      ? `your ${providerName(budget.provider)} key has ${formatUsd(budget.leftUsd)} left${after}`
      : budget.exhausted
        ? 'none of your usage is left'
        : `${creditShareWords(budget.leftPct)} of your usage is left${after}`;
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

/** One key a run saw refused, as the run tracks it. */
export interface RefusedKey {
  route: ImageRoute;
  noQuota: boolean;
}

/**
 * The card a run posts when it stopped on a key with no credit (or reached none). `refused` is every own key the run saw
 * refused, in order (the last one is the card's provider).
 */
export function stoppedCreditCard(input: { byok: boolean; refused: readonly RefusedKey[]; drawn: number; notStarted: number; rest?: CreditOffer }): CreditCard {
  const last = input.refused[input.refused.length - 1];
  const keys: CreditKey[] = input.byok && input.refused.length > 1 ? input.refused.map((k) => ({ provider: k.route, ...(k.noQuota ? { noQuota: true } : {}) })) : [];
  return {
    type: 'credit',
    id: newId('card'),
    reason: 'stopped',
    payer: input.byok ? 'own_key' : 'allowance',
    ...(input.byok && last ? { provider: last.route } : {}),
    ...(input.byok && last?.noQuota ? { noQuota: true } : {}),
    ...(keys.length > 1 ? { keys } : {}),
    drawn: input.drawn,
    notStarted: input.notStarted,
    ...(input.rest ? { rest: input.rest } : {})
  };
}

/** "your OpenRouter key ran out of credit (or reached its spending limit)" · "your OpenRouter and Gemini keys …" */
const refusedWords = (refused: readonly RefusedKey[]): string => {
  const keys = refused.length ? refused : [{ route: 'openrouter' as const, noQuota: false }];
  if (keys.length > 1 && keys.every((k) => k.noQuota === keys[0].noQuota)) {
    const names = keys.map((k) => providerName(k.route)).join(' and ');
    return keys[0].noQuota ? `your ${names} keys have no image quota` : `your ${names} keys ran out of credit (or reached their spending limits)`;
  }
  return keys
    .map((k) => (k.noQuota ? `your ${providerName(k.route)} key has no image quota` : `your ${providerName(k.route)} key ran out of credit (or reached its spending limit)`))
    .join(', and ');
};

/** The reason a stopped run gives in its completion ("Stopped before pages 2 and 3: …"). */
export const stoppedReason = (input: { byok: boolean; refused: readonly RefusedKey[] }): string =>
  input.byok ? `${refusedWords(input.refused)}. Nothing more was charged.` : 'the drawing service ran out of capacity. Nothing more was used from your usage.';

/**
 * "Your OpenRouter key ran out of credit, so the rest of this run carried on with your Gemini key …"; a Gemini key with
 * no image quota (a Google project without billing) is named for what it is: a top-up would not fix it.
 */
export const continuedText = (from: ImageRoute, to: ImageRoute, byok: boolean, model: string, noQuota = false): string => {
  if (!byok) return `The drawing service ran out of capacity on one connection, so I carried on through another with ${model}, the same model, so every page still matches.`;
  const carried = `so the rest of this run carried on with your ${providerName(to)} key on ${model}, the same model, so every page still matches.`;
  return noQuota
    ? `Your ${providerName(from)} key has no image quota (its Google project has no billing), ${carried} Turn on billing for that project when you can.`
    : `Your ${providerName(from)} key ran out of credit, ${carried} Top up ${providerName(from)} when you can.`;
};
