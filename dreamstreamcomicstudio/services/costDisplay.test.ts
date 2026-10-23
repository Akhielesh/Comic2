import { describe, expect, it } from 'vitest';
import { PLATFORM_MARKUP } from '../shared/comic/models';
import { DOLLAR_CONTEXT, costContextFromAllowance, formatCostForUser, standardPageProviderUsd } from './costDisplay';
import { normalizeAllowanceStatus } from './usageAllowance';

const governedStatus = (pctPerStandardPage: number | null) =>
  normalizeAllowanceStatus({
    enabled: true,
    governed: true,
    pctUsed: 10,
    pctLeft: 90,
    friendlyUnits: { standardPages: 130, draftPages: 160, pctPerStandardPage, label: 'about 130 standard comic pages left' }
  });

describe('formatCostForUser', () => {
  it('governed users see a share of their usage, never dollars', () => {
    // On a $10 budget one Standard page (~$0.065) is ~0.65% of the usage.
    const perPage = (standardPageProviderUsd() / 10) * 100;
    const ctx = costContextFromAllowance(governedStatus(perPage));
    expect(ctx.governed).toBe(true);
    expect(formatCostForUser(0.2, ctx)).toBe('≈2% of your usage');
    expect(formatCostForUser(standardPageProviderUsd(), ctx)).toBe('≈0.7% of your usage');
    expect(formatCostForUser(1.5, ctx)).toBe('≈15% of your usage');
    expect(formatCostForUser(0.001, ctx)).toBe('<0.1% of your usage');
    expect(formatCostForUser(0, ctx)).toBe('Free');
    // a marked-up quote (estimateJobs) is converted back to real provider cost first
    expect(formatCostForUser(0.2 * PLATFORM_MARKUP, ctx, { includesMarkup: true })).toBe('≈2% of your usage');
    for (const usd of [0.001, 0.05, 0.2, 3]) expect(formatCostForUser(usd, ctx)).not.toMatch(/\$/);
  });

  it('admins and own-key calls see real prices', () => {
    expect(formatCostForUser(0.05, DOLLAR_CONTEXT)).toBe('$0.05');
    const ctx = costContextFromAllowance(governedStatus(0.65), { byok: true });
    expect(ctx).toEqual(DOLLAR_CONTEXT);
    expect(formatCostForUser(0.05, ctx)).toBe('$0.05');
    expect(costContextFromAllowance(normalizeAllowanceStatus({ enabled: true, governed: false, pctUsed: 0 }))).toEqual(DOLLAR_CONTEXT);
    expect(costContextFromAllowance(null)).toEqual(DOLLAR_CONTEXT);
  });

  it('stays honest (no invented number) when the share is unknown', () => {
    const ctx = costContextFromAllowance(governedStatus(null));
    expect(formatCostForUser(0.2, ctx)).toBe('uses a little of your usage');
  });
});
