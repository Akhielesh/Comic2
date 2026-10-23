import { describe, it, expect } from 'vitest';
import { buildUsage, createUsageMeter, spentUsageOf, withSpentUsage } from './usage.js';

describe('buildUsage', () => {
  // Regression: the OpenRouter text pipeline must bill on the provider's real reported
  // cost, not a char-based token estimate. The shim feeds costUsd in via usageMetadata.
  it('passes through real provider cost from usageMetadata.costUsd', () => {
    const u = buildUsage('prompt', 'response', {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
      costUsd: 0.002
    });
    expect(u.providerCostUsd).toBe(0.002);
    expect(u.promptTokens).toBe(10);
    expect(u.candidatesTokens).toBe(5);
    expect(u.totalTokens).toBe(15);
  });

  it('omits providerCostUsd for Gemini-style metadata that has no cost', () => {
    const u = buildUsage('p', 'r', { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 });
    expect(u.providerCostUsd).toBeUndefined();
    expect(u.totalTokens).toBe(5);
  });

  it('falls back to a token estimate (no providerCostUsd) when no metadata is supplied', () => {
    const u = buildUsage('a few words here', 'short reply');
    expect(u.providerCostUsd).toBeUndefined();
    expect(u.estimatedTokens).toBeGreaterThan(0);
  });
});

// ── Usage meter (gate S9) ───────────────────────────────────────────────────────────────────────

describe('createUsageMeter', () => {
  it('sums every provider call: tokens and real cost', () => {
    const m = createUsageMeter();
    m.addCall({ promptTokens: 100_000, completionTokens: 10, costUsd: 0.9 }, 400_000, 40);
    m.addCall({ promptTokens: 100_500, completionTokens: 400, costUsd: 0.95 }, 402_000, 1_600);
    const u = m.usage('hi');
    expect(m.calls).toBe(2);
    expect(u.promptTokens).toBe(200_500);
    expect(u.candidatesTokens).toBe(410);
    expect(u.totalTokens).toBe(200_910);
    expect(u.providerCostUsd).toBeCloseTo(1.85, 9);
    expect(u.estimatedTokens).toBeUndefined();
  });

  it('adds a meta-tool’s nested usage (tokens + cost)', () => {
    const m = createUsageMeter();
    m.addCall({ promptTokens: 10, completionTokens: 5, costUsd: 0.01 }, 40, 20);
    m.addNested({ promptTokens: 1_000, candidatesTokens: 200, totalTokens: 1_200, providerCostUsd: 0.5 });
    m.addNested({}); // a tool that made no model call adds nothing
    m.addNested(undefined);
    const u = m.usage('x');
    expect(m.calls).toBe(2);
    expect(u.providerCostUsd).toBeCloseTo(0.51, 9);
    expect(u.promptTokens).toBe(1_010);
    expect(u.candidatesTokens).toBe(205);
  });

  it('a call without reported tokens is estimated from what was SENT (chars/4), not the last message', () => {
    const m = createUsageMeter();
    m.addCall({}, 40_000, 800);
    const u = m.usage('a short question');
    expect(u.promptTokens).toBe(10_000);
    expect(u.candidatesTokens).toBe(200);
  });

  it('drops the cost when any call reported none (a partial sum would under-count)', () => {
    const m = createUsageMeter();
    m.addCall({ promptTokens: 10, completionTokens: 10, costUsd: 0.2 }, 0, 0);
    m.addCall({ promptTokens: 10, completionTokens: 10 }, 0, 0);
    const u = m.usage('x');
    expect(u.providerCostUsd).toBeUndefined();
    expect(u.totalTokens).toBe(40);
  });

  it('a genuinely free turn reports a real $0', () => {
    const m = createUsageMeter();
    m.addCall({ promptTokens: 10, completionTokens: 10, costUsd: 0 }, 0, 0);
    expect(m.usage('x').providerCostUsd).toBe(0);
  });
});

describe('withSpentUsage / spentUsageOf', () => {
  it('carries what a failed run spent on its error (non-enumerable)', () => {
    const err = withSpentUsage(new Error('round 2 failed'), { providerCostUsd: 0.9, totalTokens: 100 });
    expect(spentUsageOf(err)?.providerCostUsd).toBe(0.9);
    expect(Object.keys(err as object)).not.toContain('spentUsage');
    expect(JSON.stringify(err)).not.toContain('0.9');
  });

  it('only reports something worth settling', () => {
    expect(spentUsageOf(new Error('x'))).toBeUndefined();
    expect(spentUsageOf(undefined)).toBeUndefined();
    expect(spentUsageOf(withSpentUsage(new Error('x'), { providerCostUsd: 0, totalTokens: 50 }))).toBeUndefined();
    expect(spentUsageOf(withSpentUsage(new Error('x'), { totalTokens: 50 }))?.totalTokens).toBe(50);
    expect(spentUsageOf(withSpentUsage(new Error('x'), { totalTokens: 0 }))).toBeUndefined();
  });

  it('wraps a non-object throw', () => {
    const err = withSpentUsage('boom', { providerCostUsd: 0.1 });
    expect(err).toBeInstanceOf(Error);
    expect(spentUsageOf(err)?.providerCostUsd).toBe(0.1);
  });
});
