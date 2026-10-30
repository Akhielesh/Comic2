// CONSISTENCY_LIMITS carries the per-page anchor counts B4 asked for (amendment 1): placeAnchors and propAnchors, the
// plan's §4.2 numbers ("≤ 2 place sheets → ≤ 2 prop sheets"). anchors.ts ANCHOR_CAPS reads them, so the number lives in
// one place: changing the limit changes the cap, proven below with a mocked limits module.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANCHOR_CAPS } from './anchors';
import { CONSISTENCY_LIMITS } from './limits';

afterEach(() => {
  vi.doUnmock('./limits.js');
  vi.resetModules();
});

describe('CONSISTENCY_LIMITS anchor counts', () => {
  it('carries placeAnchors and propAnchors, 2 each (pro plan §4.2)', () => {
    expect(CONSISTENCY_LIMITS.placeAnchors).toBe(2);
    expect(CONSISTENCY_LIMITS.propAnchors).toBe(2);
  });

  it('ANCHOR_CAPS takes its per-page place and prop caps from them', () => {
    expect(ANCHOR_CAPS.placesPerPage).toBe(CONSISTENCY_LIMITS.placeAnchors);
    expect(ANCHOR_CAPS.propsPerPage).toBe(CONSISTENCY_LIMITS.propAnchors);
  });

  it('a different limit gives a different cap (anchors.ts reads the limit, it does not repeat the number)', async () => {
    vi.resetModules();
    vi.doMock('./limits.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('./limits')>();
      return { ...real, CONSISTENCY_LIMITS: { ...real.CONSISTENCY_LIMITS, placeAnchors: 1, propAnchors: 3 } };
    });
    const fresh = await import('./anchors');
    expect(fresh.ANCHOR_CAPS.placesPerPage).toBe(1);
    expect(fresh.ANCHOR_CAPS.propsPerPage).toBe(3);
  });
});
