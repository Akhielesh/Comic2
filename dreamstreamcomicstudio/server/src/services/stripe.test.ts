import { describe, expect, it } from 'vitest';
import { assertCreditPackId, assertPurchasableTier } from './stripe.js';

describe('stripe input assertions', () => {
  it('accepts only purchasable plan tiers', () => {
    expect(assertPurchasableTier('creator')).toBe('creator');
    expect(assertPurchasableTier('pro')).toBe('pro');
    expect(assertPurchasableTier('studio')).toBe('studio');
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
});
