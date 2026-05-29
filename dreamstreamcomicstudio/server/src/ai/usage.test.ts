import { describe, it, expect } from 'vitest';
import { buildUsage } from './usage.js';

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
