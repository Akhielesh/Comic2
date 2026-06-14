import { describe, it, expect } from 'vitest';
import { resample, pointsForRange, sharedRanges } from './ComparisonChart';
import type { StockComparisonSeries } from '../../../apiTypes';

// The comparison chart aligns several assets onto a shared axis and rebases to %; a bug
// in these pure helpers would silently misrepresent a financial comparison. Pin them.

const pts = (closes: number[]) => closes.map((close, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close }));

describe('comparison chart helpers', () => {
  describe('resample', () => {
    it('returns the same values when length already matches', () => {
      expect(resample([1, 2, 3], 3)).toEqual([1, 2, 3]);
    });
    it('preserves endpoints + length when up/down-sampling (linear)', () => {
      const up = resample([0, 10], 5);
      expect(up).toHaveLength(5);
      expect(up[0]).toBe(0);
      expect(up[4]).toBe(10);
      expect(up[2]).toBeCloseTo(5);
      expect(resample([0, 5, 10, 15, 20], 3)).toEqual([0, 10, 20]);
    });
    it('handles empty input without throwing', () => {
      const out = resample([], 3);
      expect(out).toHaveLength(3);
      expect(out.every((v) => Number.isNaN(v))).toBe(true);
    });
  });

  describe('pointsForRange', () => {
    const series: StockComparisonSeries = { symbol: 'X', ranges: { '1M': pts([1, 2, 3]) }, series: pts([5, 6, 7, 8, 9]) };
    it('prefers the pre-bucketed range', () => {
      expect(pointsForRange(series, '1M').map((p) => p.close)).toEqual([1, 2, 3]);
    });
    it('derives from the flat series when no bucket exists', () => {
      expect(pointsForRange(series, '5D').map((p) => p.close)).toEqual([5, 6, 7, 8, 9]);
    });
    it('returns [] when there is not enough data', () => {
      expect(pointsForRange({ symbol: 'Y', series: pts([1]) }, '1M')).toEqual([]);
    });
  });

  describe('sharedRanges', () => {
    it('only includes ranges at least two series can draw', () => {
      const a: StockComparisonSeries = { symbol: 'A', ranges: { '1M': pts([1, 2, 3]), '1Y': pts([1, 2]) } };
      const b: StockComparisonSeries = { symbol: 'B', ranges: { '1M': pts([4, 5, 6]) } };
      expect(sharedRanges([a, b])).toEqual(['1M']);
    });
  });
});
