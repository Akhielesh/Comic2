import { describe, it, expect } from 'vitest';
import { categorizeModels, clampProjectLimit, resolveBuildTier, pickForTier } from './modelBudget';

describe('categorizeModels', () => {
  it('splits free vs paid by isFree', () => {
    const { free, paid } = categorizeModels([
      { id: 'a:free', isFree: true },
      { id: 'b', isFree: false },
      { id: 'c' }, // undefined → paid
    ]);
    expect(free.map((m) => m.id)).toEqual(['a:free']);
    expect(paid.map((m) => m.id)).toEqual(['b', 'c']);
  });
});

describe('clampProjectLimit', () => {
  it('caps the request to the key remaining', () => {
    expect(clampProjectLimit(100, 20)).toEqual({ limitUsd: 20, clamped: true });
  });
  it('allows a request under the key remaining', () => {
    expect(clampProjectLimit(5, 20)).toEqual({ limitUsd: 5, clamped: false });
  });
  it('falls back to the key remaining when no project cap is set', () => {
    expect(clampProjectLimit(null, 20)).toEqual({ limitUsd: 20, clamped: false });
  });
  it('does not clamp when the key remaining is unknown', () => {
    expect(clampProjectLimit(50, null)).toEqual({ limitUsd: 50, clamped: false });
  });
  it('treats a negative request as 0', () => {
    expect(clampProjectLimit(-10, 20)).toEqual({ limitUsd: 0, clamped: false });
  });
});

describe('resolveBuildTier', () => {
  it('forces free on a free-tier key regardless of project budget', () => {
    expect(resolveBuildTier({ projectLimitUsd: 100, spentUsd: 0, keyIsFreeTier: true })).toBe('free');
  });
  it('allows quality when budget remains', () => {
    expect(resolveBuildTier({ projectLimitUsd: 10, spentUsd: 3, keyIsFreeTier: false })).toBe('quality');
  });
  it('forces free when the project budget is exhausted', () => {
    expect(resolveBuildTier({ projectLimitUsd: 5, spentUsd: 5, keyIsFreeTier: false })).toBe('free');
    expect(resolveBuildTier({ projectLimitUsd: 5, spentUsd: 9, keyIsFreeTier: false })).toBe('free');
  });
  it('allows quality when there is no project cap and the key has credit', () => {
    expect(resolveBuildTier({ projectLimitUsd: null, spentUsd: 0, keyIsFreeTier: false })).toBe('quality');
  });
});

describe('pickForTier', () => {
  const models = [
    { id: 'free-weak:free', isFree: true },
    { id: 'paid-strong', isFree: false },
  ];
  const rank = (m: { id: string }) => (m.id.includes('strong') ? 10 : 1);
  it('picks a free model for the free tier', () => {
    expect(pickForTier(models, 'free', rank)).toBe('free-weak:free');
  });
  it('picks the best paid model for the quality tier', () => {
    expect(pickForTier(models, 'quality', rank)).toBe('paid-strong');
  });
  it('falls back to free when the quality tier has no paid models', () => {
    expect(pickForTier([{ id: 'x:free', isFree: true }], 'quality')).toBe('x:free');
  });
  it('returns null with no models', () => {
    expect(pickForTier([], 'free')).toBeNull();
  });
});
