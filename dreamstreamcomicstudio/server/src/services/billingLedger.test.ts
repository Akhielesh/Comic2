import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TokenEstimateResponse } from '../../../shared/types/billing.js';
import {
  getBillingSummary,
  releaseReservation,
  reserveUsageTokens,
  settleReservation
} from './billingLedger.js';

const RUN_INTEGRATION = process.env.BILLING_INTEGRATION_TESTS === 'true';

const makeEstimate = (ct: number): TokenEstimateResponse => {
  const billableUsd = Number((ct * 0.0001).toFixed(6));
  return {
    currency: 'USD',
    ctPerUsd: 10_000,
    markup: 1.3,
    estimatedProviderCostUsd: Number((billableUsd / 1.3).toFixed(6)),
    estimatedBillableUsd: billableUsd,
    estimatedCt: ct,
    lines: [],
    modelPricing: {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputPer1kUsd: 0,
      outputPer1kUsd: 0,
      imagePerOutputUsd: 0,
      source: 'unit-test',
      confidence: 1,
      status: 'ACTIVE',
      effectiveFrom: new Date().toISOString()
    }
  };
};

describe('billingLedger', () => {
  it('fails closed when billing backend is unavailable', async () => {
    if (RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    await expect(getBillingSummary(userId)).rejects.toMatchObject({
      publicCode: 'BILLING_BACKEND_UNAVAILABLE'
    });
  });

  it('reserves then settles and releases hold correctly', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const reserveEstimate = makeEstimate(120);
    const settleEstimate = makeEstimate(80);

    const reserved = await reserveUsageTokens({
      userId,
      estimate: reserveEstimate,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_settle'
    });

    if (!('reservation' in reserved)) {
      throw new Error('Expected reservation to be allowed in unit test');
    }

    const afterReserve = await getBillingSummary(userId);
    expect(afterReserve.wallet.reservedCt).toBe(120);

    await settleReservation({
      userId,
      reservationId: reserved.reservation.reservationId,
      estimatedCt: reserveEstimate.estimatedCt,
      actual: settleEstimate,
      operation: 'unit_test_settle',
      provider: 'gemini',
      model: 'gemini-2.5-flash'
    });

    const afterSettle = await getBillingSummary(userId);
    expect(afterSettle.wallet.reservedCt).toBe(0);
    expect(afterSettle.wallet.usedMonthlyCt).toBe(80);
  });

  it('releases reservation fully on failure', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const estimate = makeEstimate(150);

    const reserved = await reserveUsageTokens({
      userId,
      estimate,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_release'
    });

    if (!('reservation' in reserved) || !reserved.reservation.reservationId) {
      throw new Error('Expected reservation to be created in unit test');
    }

    await releaseReservation({
      userId,
      reservationId: reserved.reservation.reservationId,
      estimatedCt: estimate.estimatedCt,
      operation: 'unit_test_release',
      reason: 'test_failure'
    });

    const summary = await getBillingSummary(userId);
    expect(summary.wallet.reservedCt).toBe(0);
    expect(summary.wallet.usedMonthlyCt).toBe(0);
  });

  it('enforces daily guardrail before reserve', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const tooLarge = makeEstimate(900); // Free guardrail is 800 CT/day.

    const reserved = await reserveUsageTokens({
      userId,
      estimate: tooLarge,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      operation: 'unit_test_daily_limit'
    });

    expect('details' in reserved).toBe(true);
    if ('details' in reserved) {
      expect(reserved.details.reason).toBe('DAILY_LIMIT_EXCEEDED');
      expect(reserved.details.requiredCt).toBe(900);
    }
  });

  it('returns UTC reset timestamps for daily and monthly cycles', async () => {
    if (!RUN_INTEGRATION) return;
    const userId = crypto.randomUUID();
    const summary = await getBillingSummary(userId);
    const now = Date.now();

    const dailyReset = new Date(summary.usage.dailyResetAt);
    const monthlyReset = new Date(summary.usage.monthlyResetAt);

    expect(dailyReset.getTime()).toBeGreaterThan(now);
    expect(dailyReset.getTime() - now).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

    expect(monthlyReset.getTime()).toBeGreaterThan(now);
    expect(monthlyReset.getUTCDate()).toBe(1);
    expect(monthlyReset.getUTCHours()).toBe(0);
    expect(monthlyReset.getUTCMinutes()).toBe(0);
  });
});
