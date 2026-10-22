import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, PRO_EDITOR_FOR_ALL, resolveStudioCaps } from './capabilities';
import { DOC_LIMITS } from './limits';

describe('resolveStudioCaps', () => {
  it.each([
    [{ planId: null, byok: false, isAdmin: false }, { plan: 'free', qualityTiers: ['draft', 'standard'], modelOverride: false, defaultMode: 'easy', admin: false }],
    [{ planId: 'free', byok: true, isAdmin: false }, { plan: 'free', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true, defaultMode: 'easy' }],
    [{ planId: 'Creator', byok: false, isAdmin: false }, { plan: 'paid', qualityTiers: ['draft', 'standard', 'pro'], modelOverride: true, defaultMode: 'pro' }],
    [{ planId: 'free', byok: false, isAdmin: true }, { plan: 'admin', admin: true, defaultMode: 'pro' }],
    [{ planId: 'mystery', byok: false, isAdmin: false, ratingCeiling: 'PG' as const }, { plan: 'free', ratingCeiling: 'PG' }]
  ])('%j', (input, expected) => {
    expect(resolveStudioCaps(input)).toMatchObject(expected);
  });

  it('the Pro editor is available to everyone while PRO_EDITOR_FOR_ALL (decisions-final #1)', () => {
    expect(PRO_EDITOR_FOR_ALL).toBe(true);
    expect(resolveStudioCaps({ byok: false, isAdmin: false }).proEditor).toBe(true);
    expect(DEFAULT_CAPS.proEditor).toBe(true);
    expect(DEFAULT_CAPS.maxPages).toBe(DOC_LIMITS.pages);
    expect(DEFAULT_CAPS.customFonts).toBe(false);
  });
});
