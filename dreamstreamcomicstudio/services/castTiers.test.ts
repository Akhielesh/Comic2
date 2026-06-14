import { describe, it, expect } from 'vitest';
import { castTierLabel, resolveCastTier, summarizeCastTiers, tierWantsReferenceSheet } from './castTiers';

describe('castTiers', () => {
  it('honors an explicit tier over the heuristic', () => {
    expect(resolveCastTier({ castTier: 'extra' }, 0)).toBe('extra');
    expect(resolveCastTier({ castTier: 'lead' }, 9)).toBe('lead');
  });

  it('falls back to billing-order heuristic: lead, support, then extra', () => {
    expect(resolveCastTier({}, 0)).toBe('lead');
    expect(resolveCastTier({}, 1)).toBe('support');
    expect(resolveCastTier({}, 3)).toBe('support');
    expect(resolveCastTier({}, 4)).toBe('extra');
  });

  it('only leads/support want a reference sheet', () => {
    expect(tierWantsReferenceSheet('lead')).toBe(true);
    expect(tierWantsReferenceSheet('support')).toBe(true);
    expect(tierWantsReferenceSheet('extra')).toBe(false);
  });

  it('summarizes counts across the cast', () => {
    const counts = summarizeCastTiers([{}, {}, {}, {}, {}]);
    expect(counts).toEqual({ lead: 1, support: 3, extra: 1 });
  });

  it('labels tiers', () => {
    expect(castTierLabel('lead')).toBe('Lead');
    expect(castTierLabel('support')).toBe('Support');
    expect(castTierLabel('extra')).toBe('Extra');
  });
});
