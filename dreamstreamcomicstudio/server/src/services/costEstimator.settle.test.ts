// @vitest-environment node
// Gate S9: a chat turn's usage now sums EVERY provider call it made. A paid tool round, a paid
// retry or the per-request web plugin can sit in front of a `:free` final answer, so a reported
// cost above $0 must settle even when the final served model is `:free` (it used to be zeroed).
// A genuinely free turn reports $0 (or nothing) and still settles at $0.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./pricingCatalog.js', () => ({
  CT_USD: 0.0001,
  DEFAULT_MARKUP: 1.3,
  resolveModelPricing: async (provider: string, model: string) => ({
    provider,
    model,
    inputPer1kUsd: /:free$/.test(model) ? 0 : 0.001,
    outputPer1kUsd: /:free$/.test(model) ? 0 : 0.002,
    imagePerOutputUsd: 0,
    source: 'test',
    confidence: 1,
    status: 'ACTIVE',
    effectiveFrom: '2026-01-01T00:00:00.000Z'
  })
}));

const { buildSettleEstimateFromUsage } = await import('./costEstimator.js');

const seed = (model: string) => ({ provider: 'openrouter' as const, model, operation: 'chat.completion' });

describe('buildSettleEstimateFromUsage', () => {
  it('settles a reported positive cost even when the served model is :free', async () => {
    const r = await buildSettleEstimateFromUsage(seed('x/y:free'), { promptTokens: 1_000, candidatesTokens: 100, providerCostUsd: 0.2 });
    expect(r.estimatedProviderCostUsd).toBe(0.2);
    expect(r.estimatedBillableUsd).toBeCloseTo(0.26, 6);
  });

  it('a :free turn that reported $0 (or nothing) settles at $0', async () => {
    expect((await buildSettleEstimateFromUsage(seed('x/y:free'), { promptTokens: 1_000, candidatesTokens: 100, providerCostUsd: 0 })).estimatedProviderCostUsd).toBe(0);
    expect((await buildSettleEstimateFromUsage(seed('x/y:free'), { promptTokens: 1_000, candidatesTokens: 100 })).estimatedProviderCostUsd).toBe(0);
  });

  it('review: a partially reported cost is a floor — paid rounds before a :free final answer never settle at $0', async () => {
    // Some calls reported $0.9, the last one reported nothing (a stream cut before its usage chunk).
    const free = await buildSettleEstimateFromUsage(seed('x/y:free'), { promptTokens: 200_000, candidatesTokens: 500, partialProviderCostUsd: 0.9 });
    expect(free.estimatedProviderCostUsd).toBe(0.9);
    expect(free.estimatedBillableUsd).toBeCloseTo(1.17, 6);
    // On a paid final model the token estimate stands when it is higher than the reported part.
    const paid = await buildSettleEstimateFromUsage(seed('acme/paid'), { promptTokens: 200_000, candidatesTokens: 1_000, partialProviderCostUsd: 0.05 });
    expect(paid.estimatedProviderCostUsd).toBeCloseTo(0.202, 6);
  });

  it('a paid model still settles on the reported cost, else on the summed tokens', async () => {
    expect((await buildSettleEstimateFromUsage(seed('acme/paid'), { promptTokens: 10, candidatesTokens: 10, providerCostUsd: 1.85 })).estimatedProviderCostUsd).toBe(1.85);
    // 200,000 prompt + 1,000 completion tokens at $0.001 / $0.002 per 1k.
    const tokens = await buildSettleEstimateFromUsage(seed('acme/paid'), { promptTokens: 200_000, candidatesTokens: 1_000 });
    expect(tokens.estimatedProviderCostUsd).toBeCloseTo(0.202, 6);
  });
});
