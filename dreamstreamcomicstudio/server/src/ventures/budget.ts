// Pure venture-budget evaluation (no DB, no network) — the first "brake" of Autopilot.
// Epic A0. See docs/studio/autopilot/00-MASTER-PLAN.md §8 and spec/41-billing-metering.md.
//
// The autonomous loop's DECIDE gate calls evaluateBudget() BEFORE spending; the REFLECT
// step updates the snapshot AFTER. A breach pauses the venture (pause_reason='budget') and
// emits a budget.exceeded event. A cap of null/undefined means "no limit" for that dimension.
// Mirrors the self-contained, unit-testable style of services/studioCaps.ts.

export interface VentureBudget {
  /** Max USD spend per calendar day (null/undefined = unlimited). */
  usdPerDay?: number | null;
  /** Max USD spend over the venture's lifetime. */
  usdTotal?: number | null;
  /** Max model tokens over the venture's lifetime. */
  maxTokens?: number | null;
  /** Max sandbox container-minutes over the venture's lifetime. */
  maxContainerMinutes?: number | null;
}

export interface VentureSpendSnapshot {
  usdToday: number;
  usdTotal: number;
  tokensUsed: number;
  containerMinutesUsed: number;
}

export interface ProposedSpend {
  usd?: number;
  tokens?: number;
  containerMinutes?: number;
}

export type BudgetBreachCode =
  | 'BUDGET_TOTAL_USD'
  | 'BUDGET_DAILY_USD'
  | 'BUDGET_TOKENS'
  | 'BUDGET_CONTAINER_MINUTES';

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: BudgetBreachCode;
      message: string;
      cap: number;
      projected: number;
    };

const hasCap = (cap: number | null | undefined): cap is number =>
  typeof cap === 'number' && Number.isFinite(cap) && cap >= 0;

/**
 * Decide whether the venture may incur `proposed` additional spend without breaching any
 * cap. Checks the hardest stop first (lifetime USD) then daily USD, tokens, compute minutes.
 * Uses `>=` so reaching a cap stops the venture (matches studioCaps semantics). Omit
 * `proposed` to test whether the venture is ALREADY at/over budget.
 */
export const evaluateBudget = (
  snapshot: VentureSpendSnapshot,
  budget: VentureBudget,
  proposed: ProposedSpend = {}
): BudgetDecision => {
  const addUsd = Math.max(0, proposed.usd ?? 0);
  const addTokens = Math.max(0, proposed.tokens ?? 0);
  const addMinutes = Math.max(0, proposed.containerMinutes ?? 0);

  if (hasCap(budget.usdTotal)) {
    const projected = snapshot.usdTotal + addUsd;
    if (projected >= budget.usdTotal) {
      return {
        allowed: false,
        code: 'BUDGET_TOTAL_USD',
        cap: budget.usdTotal,
        projected,
        message: `Total budget reached: $${projected.toFixed(2)} of $${budget.usdTotal.toFixed(2)}.`
      };
    }
  }
  if (hasCap(budget.usdPerDay)) {
    const projected = snapshot.usdToday + addUsd;
    if (projected >= budget.usdPerDay) {
      return {
        allowed: false,
        code: 'BUDGET_DAILY_USD',
        cap: budget.usdPerDay,
        projected,
        message: `Daily budget reached: $${projected.toFixed(2)} of $${budget.usdPerDay.toFixed(2)} today.`
      };
    }
  }
  if (hasCap(budget.maxTokens)) {
    const projected = snapshot.tokensUsed + addTokens;
    if (projected >= budget.maxTokens) {
      return {
        allowed: false,
        code: 'BUDGET_TOKENS',
        cap: budget.maxTokens,
        projected,
        message: `Token budget reached: ${projected} of ${budget.maxTokens} tokens.`
      };
    }
  }
  if (hasCap(budget.maxContainerMinutes)) {
    const projected = snapshot.containerMinutesUsed + addMinutes;
    if (projected >= budget.maxContainerMinutes) {
      return {
        allowed: false,
        code: 'BUDGET_CONTAINER_MINUTES',
        cap: budget.maxContainerMinutes,
        projected,
        message: `Compute budget reached: ${projected} of ${budget.maxContainerMinutes} container-minutes.`
      };
    }
  }
  return { allowed: true };
};

export type BudgetAlertLevel = 'ok' | 'warn' | 'exceeded';

const safeRatio = (spent: number, cap: number): number =>
  cap > 0 ? spent / cap : spent > 0 ? Number.POSITIVE_INFINITY : 1;

/**
 * Highest utilization across all capped dimensions mapped to an alert level: `warn` at
 * `warnAt` (default 80%), `exceeded` at 100%. Powers the 80%/100% spend alerts (A7).
 * Dimensions with no cap are ignored; a zero cap counts as exceeded.
 */
export const budgetAlertLevel = (
  snapshot: VentureSpendSnapshot,
  budget: VentureBudget,
  warnAt = 0.8
): BudgetAlertLevel => {
  const ratios: number[] = [];
  if (hasCap(budget.usdTotal)) ratios.push(safeRatio(snapshot.usdTotal, budget.usdTotal));
  if (hasCap(budget.usdPerDay)) ratios.push(safeRatio(snapshot.usdToday, budget.usdPerDay));
  if (hasCap(budget.maxTokens)) ratios.push(safeRatio(snapshot.tokensUsed, budget.maxTokens));
  if (hasCap(budget.maxContainerMinutes)) {
    ratios.push(safeRatio(snapshot.containerMinutesUsed, budget.maxContainerMinutes));
  }
  if (ratios.length === 0) return 'ok';
  const peak = Math.max(...ratios);
  if (peak >= 1) return 'exceeded';
  if (peak >= warnAt) return 'warn';
  return 'ok';
};
