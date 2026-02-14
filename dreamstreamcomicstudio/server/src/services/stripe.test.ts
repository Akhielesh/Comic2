import { describe, expect, it } from 'vitest';
import { assertBillingInterval, assertCreditPackId, assertPurchasableTier } from './stripe.js';

describe('stripe input assertions', () => {
  it('accepts only purchasable plan tiers', () => {
    expect(assertPurchasableTier('creator')).toBe('creator');
    expect(assertPurchasableTier('studio')).toBe('studio');
    expect(() => assertPurchasableTier('pro')).toThrow();
    expect(() => assertPurchasableTier('admin')).toThrow();
    expect(() => assertPurchasableTier('free')).toThrow();
  });

  it('accepts only configured credit pack ids', () => {
    expect(assertCreditPackId('pack_10')).toBe('pack_10');
    expect(assertCreditPackId('pack_25')).toBe('pack_25');
    expect(assertCreditPackId('pack_100')).toBe('pack_100');
    expect(() => assertCreditPackId('100')).toThrow();
    expect(() => assertCreditPackId('pack_custom')).toThrow();
  });

  it('accepts only supported billing intervals', () => {
    expect(assertBillingInterval('month')).toBe('month');
    expect(assertBillingInterval('year')).toBe('year');
    expect(() => assertBillingInterval('weekly')).toThrow();
    expect(() => assertBillingInterval('')).toThrow();
  });
});
