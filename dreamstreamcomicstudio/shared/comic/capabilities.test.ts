import { describe, expect, expectTypeOf, it } from 'vitest';
import { ANCHOR_KINDS_OFF, anchorKindsFromFlag, type AnchorKinds } from './anchors';
import { DEFAULT_CAPS, PRO_EDITOR_FOR_ALL, resolveStudioCaps, type StudioCaps } from './capabilities';
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

// B4 amendment 2: the caps carry the server's anchor kinds (server/src/comic/access.ts fills them from
// COMIC_CONSISTENCY_ANCHORS). The shared resolver and the client default leave the field absent, which reads as off.
describe('StudioCaps.anchorKinds', () => {
  it('is an optional AnchorKinds field (an object literal with it type-checks)', () => {
    expectTypeOf<StudioCaps['anchorKinds']>().toEqualTypeOf<AnchorKinds | undefined>();
    const caps: StudioCaps = { ...DEFAULT_CAPS, anchorKinds: anchorKindsFromFlag('places') };
    expect(caps.anchorKinds).toEqual({ places: true, props: false, styleKey: false, sheetV2: false });
    const off: StudioCaps = { ...DEFAULT_CAPS, anchorKinds: ANCHOR_KINDS_OFF };
    expect(off.anchorKinds).toBe(ANCHOR_KINDS_OFF);
  });

  it('the shared default and resolver leave it absent (absent = every kind off)', () => {
    expect('anchorKinds' in DEFAULT_CAPS).toBe(false);
    expect('anchorKinds' in resolveStudioCaps({ planId: 'studio', byok: true, isAdmin: true })).toBe(false);
  });
});
