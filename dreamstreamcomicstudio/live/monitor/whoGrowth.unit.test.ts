// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_MONTH,
  growthPoint,
  lmsAt,
  normalCdf,
  ordinal,
  percentile,
  percentileLabel,
  valueAtZ,
  WHO_CHART_LINES,
  WHO_LMS,
  zScore,
  type GrowthMeasure,
  type GrowthSex,
} from './whoGrowth';

const at = (month: number) => month * DAYS_PER_MONTH;

// Reference values copied from the CDC-hosted WHO CSVs (columns "2nd (2.3rd)",
// "5th", "50th", "95th", "98th (97.7th)"): [measure, sex, month, P2.3, P5, P50, P95, P97.7].
const REF: [GrowthMeasure, GrowthSex, number, number, number, number, number, number][] = [
  ['weight', 'm', 0, 2.459312, 2.603994, 3.3464, 4.214527, 4.419354],
  ['weight', 'm', 6, 6.352967, 6.611702, 7.934, 9.481939, 9.848832],
  ['weight', 'f', 6, 5.729383, 5.97888, 7.297, 8.93289, 9.33549062],
  ['weight', 'f', 24, 9.035869, 9.416516, 11.4775, 14.16181, 14.8452857],
  ['length', 'm', 12, 70.99632, 71.84023, 75.7488, 79.65737, 80.50128],
  ['length', 'f', 12, 68.8650363, 69.77953, 74.015, 78.25047, 79.1649637],
  ['head', 'm', 24, 45.52915, 46.01257, 48.2515, 50.49043, 50.9738496],
  ['head', 'f', 3, 37.05014, 37.49099, 39.5328, 41.57461, 42.0154598],
];

describe('WHO LMS tables', () => {
  it('has 25 monthly rows (0–24) for every measure and sex', () => {
    for (const m of ['weight', 'length', 'head'] as const) {
      for (const s of ['m', 'f'] as const) {
        expect(WHO_LMS[m][s].map((r) => r[0])).toEqual(Array.from({ length: 25 }, (_, i) => i));
      }
    }
  });

  it('length and head circumference are normal (L = 1)', () => {
    for (const m of ['length', 'head'] as const) for (const s of ['m', 'f'] as const) expect(WHO_LMS[m][s].every((r) => r[1] === 1)).toBe(true);
  });

  it('interpolates L, M, S linearly by age in days (30.4375 days per month)', () => {
    const mid = lmsAt('weight', 'm', DAYS_PER_MONTH / 2)!;
    expect(mid.M).toBeCloseTo((3.3464 + 4.4709) / 2, 10);
    expect(mid.L).toBeCloseTo((0.3487 + 0.2297) / 2, 10);
    expect(lmsAt('length', 'f', at(12))!.M).toBeCloseTo(74.015, 10);
    expect(lmsAt('head', 'm', at(24))!.M).toBeCloseTo(48.2515, 10);
  });

  it('is null outside 0–24 months or without a sex', () => {
    expect(lmsAt('weight', 'm', -1)).toBeNull();
    expect(lmsAt('weight', 'm', at(24) + 1)).toBeNull();
    expect(lmsAt('weight', null, 30)).toBeNull();
    expect(zScore('weight', 'f', 30, 0)).toBeNull();
    expect(zScore('weight', 'f', 30, NaN)).toBeNull();
    expect(growthPoint('length', null, 30, 55)).toBeNull();
  });
});

describe('zScore', () => {
  it('gives z = 0 at the WHO median', () => {
    for (const [m, s, month, , , p50] of REF) expect(zScore(m, s, at(month), p50)).toBeCloseTo(0, 9);
  });

  it('reproduces the published 2.3rd/97.7th (z = ∓2) and 5th/95th (z = ∓1.645) values', () => {
    for (const [m, s, month, p2, p5, , p95, p98] of REF) {
      expect(zScore(m, s, at(month), p2)).toBeCloseTo(-2, 3);
      expect(zScore(m, s, at(month), p98)).toBeCloseTo(2, 3);
      expect(zScore(m, s, at(month), p5)).toBeCloseTo(-1.6449, 3);
      expect(zScore(m, s, at(month), p95)).toBeCloseTo(1.6449, 3);
    }
  });

  it('round-trips the WHO chart lines (P3 / P97 at z ≈ ∓1.88)', () => {
    for (const [m, s, month] of REF) {
      for (const { pct, z } of WHO_CHART_LINES) {
        const v = valueAtZ(m, s, at(month), z)!;
        expect(zScore(m, s, at(month), v)).toBeCloseTo(z, 9);
        expect(percentile(z)).toBeCloseTo(pct, 3);
      }
    }
  });

  it("uses WHO's restricted linear extension beyond ±3 SD for weight", () => {
    const lms = lmsAt('weight', 'm', 0)!;
    const sd = (z: number) => lms.M * Math.pow(1 + lms.L * lms.S * z, 1 / lms.L);
    const heavy = sd(3) + 0.5 * (sd(3) - sd(2));
    const light = sd(-3) - 0.5 * (sd(-2) - sd(-3));
    expect(zScore('weight', 'm', 0, heavy)).toBeCloseTo(3.5, 9);
    expect(zScore('weight', 'm', 0, light)).toBeCloseTo(-3.5, 9);
    // The unrestricted LMS z differs — that's what the restriction is for.
    const raw = (Math.pow(heavy / lms.M, lms.L) - 1) / (lms.L * lms.S);
    expect(Math.abs(raw - 3.5)).toBeGreaterThan(0.01);
    expect(valueAtZ('weight', 'm', 0, 3.5)).toBeCloseTo(heavy, 9);
    expect(valueAtZ('weight', 'm', 0, -3.5)).toBeCloseTo(light, 9);
  });

  it('places a realistic baby: 6-month-old girl at 7.9 kg / 67 cm', () => {
    const w = growthPoint('weight', 'f', 183, 7.9)!;
    expect(w.z).toBeGreaterThan(0.4);
    expect(w.z).toBeLessThan(0.8);
    expect(w.label).toMatch(/^\d+(st|nd|rd|th) percentile$/);
    const l = growthPoint('length', 'f', 183, 67)!;
    expect(l.pct).toBeGreaterThan(60);
    expect(l.pct).toBeLessThan(80);
  });
});

describe('percentiles', () => {
  it('normalCdf matches known values to ~1e-12', () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 12);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316301, 12);
    expect(normalCdf(-1.880794)).toBeCloseTo(0.03, 6);
    expect(normalCdf(9)).toBeCloseTo(1, 12);
    expect(normalCdf(-40)).toBe(0);
  });

  it('labels percentiles with ordinals and safe extremes', () => {
    expect(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '62nd', '101st', '111th']).toEqual(
      [1, 2, 3, 4, 11, 12, 13, 21, 22, 62, 101, 111].map(ordinal),
    );
    expect(percentileLabel(62.4)).toBe('62nd percentile');
    expect(percentileLabel(0.4)).toBe('below the 1st percentile');
    expect(percentileLabel(99.6)).toBe('above the 99th percentile');
    expect(percentileLabel(1.2)).toBe('1st percentile');
    expect(growthPoint('length', 'm', at(12), 75.7488)!.label).toBe('50th percentile');
  });
});
