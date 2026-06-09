import { describe, it, expect } from 'vitest';
import { computeContextUsage, contextWindowFor, estimateTokens, formatTokens } from './contextUsage';

describe('contextUsage.estimateTokens', () => {
  it('approximates ~4 chars/token and handles empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});

describe('contextUsage.contextWindowFor', () => {
  it('maps known model families to windows', () => {
    expect(contextWindowFor('anthropic/claude-3.5-sonnet')).toBe(200_000);
    expect(contextWindowFor('google/gemini-2.0-flash')).toBe(1_000_000);
    expect(contextWindowFor('openai/gpt-4o')).toBe(128_000);
  });
  it('is conservative for unknown / auto', () => {
    expect(contextWindowFor(null)).toBe(128_000);
    expect(contextWindowFor('mystery/model')).toBe(128_000);
  });
});

describe('contextUsage.computeContextUsage', () => {
  it('sums files + conversation + overhead and clamps the percentage', () => {
    const files = [{ content: 'x'.repeat(4000) }]; // ~1000 tokens
    const messages = [{ text: 'y'.repeat(400) }]; // ~100 tokens
    const u = computeContextUsage(files, messages, 'openai/gpt-4o', 1500);
    expect(u.tokens).toBe(1000 + 100 + 1500);
    expect(u.window).toBe(128_000);
    expect(u.pct).toBeCloseTo(2600 / 128_000, 5);
    expect(u.level).toBe('ok');
  });

  it('flags high usage near the ceiling', () => {
    const files = [{ content: 'x'.repeat(4 * 120_000) }]; // ~120k tokens
    const u = computeContextUsage(files, [], 'openai/gpt-4o');
    expect(u.pct).toBeGreaterThan(0.85);
    expect(u.level).toBe('high');
  });
});

describe('contextUsage.formatTokens', () => {
  it('formats compactly', () => {
    expect(formatTokens(900)).toBe('900');
    expect(formatTokens(2600)).toBe('2.6k');
    expect(formatTokens(128_000)).toBe('128k');
    expect(formatTokens(1_000_000)).toBe('1.0M');
  });
});
