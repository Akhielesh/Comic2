import { describe, it, expect } from 'vitest';
import {
  evaluateBudget,
  budgetAlertLevel,
  type BudgetDecision,
  type VentureBudget,
  type VentureSpendSnapshot
} from './budget.js';

const zero: VentureSpendSnapshot = { usdToday: 0, usdTotal: 0, tokensUsed: 0, containerMinutesUsed: 0 };
const budget: VentureBudget = { usdPerDay: 5, usdTotal: 50, maxTokens: 1_000_000, maxContainerMinutes: 120 };

// Type-guard helper: asserts a breach and narrows to the failed variant for property access.
type BudgetBreach = Extract<BudgetDecision, { allowed: false }>;
const breach = (d: BudgetDecision): BudgetBreach => {
  if (d.allowed) throw new Error('expected a budget breach but it was allowed');
  return d as BudgetBreach;
};

describe('evaluateBudget', () => {
  it('allows spend well under every cap', () => {
    const d = evaluateBudget({ usdToday: 1, usdTotal: 10, tokensUsed: 1000, containerMinutesUsed: 5 }, budget, { usd: 0.5 });
    expect(d.allowed).toBe(true);
  });

  it('allows when there are no caps at all', () => {
    expect(evaluateBudget(zero, {}, { usd: 9999 }).allowed).toBe(true);
  });

  it('blocks at the lifetime USD cap and reports it first', () => {
    const d = breach(evaluateBudget({ ...zero, usdTotal: 49.5 }, budget, { usd: 1 }));
    expect(d.code).toBe('BUDGET_TOTAL_USD');
    expect(d.projected).toBeCloseTo(50.5);
    expect(d.cap).toBe(50);
  });

  it('blocks at the daily USD cap', () => {
    const d = breach(evaluateBudget({ ...zero, usdToday: 4.9 }, budget, { usd: 0.2 }));
    expect(d.code).toBe('BUDGET_DAILY_USD');
  });

  it('blocks at the token cap', () => {
    const d = breach(evaluateBudget({ ...zero, tokensUsed: 999_999 }, budget, { tokens: 5 }));
    expect(d.code).toBe('BUDGET_TOKENS');
  });

  it('blocks at the container-minute cap', () => {
    const d = breach(evaluateBudget({ ...zero, containerMinutesUsed: 119 }, budget, { containerMinutes: 2 }));
    expect(d.code).toBe('BUDGET_CONTAINER_MINUTES');
  });

  it('treats reaching a cap exactly as a breach (>=)', () => {
    expect(evaluateBudget({ ...zero, usdToday: 5 }, budget).allowed).toBe(false);
  });

  it('a zero cap blocks any spend', () => {
    const d = breach(evaluateBudget(zero, { usdTotal: 0 }, { usd: 0.01 }));
    expect(d.code).toBe('BUDGET_TOTAL_USD');
  });

  it('ignores negative proposed values (clamped to 0)', () => {
    expect(evaluateBudget({ ...zero, usdToday: 1 }, budget, { usd: -100 }).allowed).toBe(true);
  });
});

describe('budgetAlertLevel', () => {
  it('is ok when there are no caps', () => {
    expect(budgetAlertLevel({ ...zero, usdTotal: 9999 }, {})).toBe('ok');
  });
  it('is ok under the warn threshold', () => {
    expect(budgetAlertLevel({ ...zero, usdToday: 1 }, budget)).toBe('ok');
  });
  it('warns at >= 80% of the tightest cap', () => {
    expect(budgetAlertLevel({ ...zero, usdToday: 4 }, budget)).toBe('warn');
  });
  it('is exceeded at >= 100%', () => {
    expect(budgetAlertLevel({ ...zero, usdToday: 5 }, budget)).toBe('exceeded');
  });
  it('treats a zero cap as exceeded', () => {
    expect(budgetAlertLevel(zero, { usdTotal: 0 })).toBe('exceeded');
  });
});
