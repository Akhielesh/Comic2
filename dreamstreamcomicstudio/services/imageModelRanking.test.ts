import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODEL_RANKING,
  preferredImageModels,
  referenceCapableImageModels,
  formatImagePrice,
} from './imageModelRanking';
import { getModelVendor } from './modelVendors';

describe('imageModelRanking', () => {
  it('ranks are unique and strictly ascending from 1', () => {
    const ranks = IMAGE_MODEL_RANKING.map((m) => m.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks[0]).toBe(1);
  });

  it('every entry has a source link and a known vendor badge', () => {
    for (const m of IMAGE_MODEL_RANKING) {
      expect(m.sourceUrl).toMatch(/^https?:\/\//);
      // vendorId must resolve (either a real vendor or the explicit "other").
      expect(typeof getModelVendor({ id: `${m.vendorId}/x` }).label).toBe('string');
    }
  });

  it('exposes preferred and reference-capable subsets', () => {
    const preferred = preferredImageModels();
    expect(preferred.length).toBeGreaterThan(0);
    expect(preferred.every((m) => m.preferred)).toBe(true);
    expect(referenceCapableImageModels().every((m) => m.referenceCapable)).toBe(true);
  });

  it('formats price (free, approx, unknown)', () => {
    expect(formatImagePrice({ ...IMAGE_MODEL_RANKING[0], approxUsdPerImage: 0 })).toBe('Free');
    expect(formatImagePrice({ ...IMAGE_MODEL_RANKING[0], approxUsdPerImage: 0.039 })).toBe('~$0.039/img');
    expect(formatImagePrice({ ...IMAGE_MODEL_RANKING[0], approxUsdPerImage: undefined })).toBe('—');
  });
});
