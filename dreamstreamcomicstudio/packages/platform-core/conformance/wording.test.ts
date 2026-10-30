// @vitest-environment node
//
// Governed users never see a dollar sign (plan §5.6; W1.4): 1,000 seeded amounts — tiny, cents, dollars, huge,
// negative, zero, NaN and ±Infinity among them — through every governed wording path.
import { describe, expect, it } from 'vitest';
import { COST_MICROS_HEADER, costLabel, formatUsd, governText, microsToUsd, usageLabel, usdToMicros } from '../src/cost/index.js';
import { seededAmounts } from '../src/testing/conformance.js';

const AMOUNTS = seededAmounts(20261102, 1000);

describe('governed usage wording', () => {
  it('the seed really covers the edge cases and 1,000 amounts', () => {
    expect(AMOUNTS).toHaveLength(1000);
    expect(AMOUNTS.some((n) => Number.isNaN(n))).toBe(true);
    expect(AMOUNTS).toContain(Infinity);
    expect(AMOUNTS.some((n) => n < 0)).toBe(true);
    expect(AMOUNTS.some((n) => n > 0 && n < 0.01)).toBe(true);
    expect(AMOUNTS.some((n) => n > 1000)).toBe(true);
    expect(seededAmounts(20261102, 1000)).toEqual(AMOUNTS); // reproducible
  });

  it('never shows $ for 1,000 seeded amounts, on every governed path', () => {
    const offenders: string[] = [];
    for (const usd of AMOUNTS) {
      const texts = [
        usageLabel({ governed: true, fractionLeft: 1 - usd / 10 }),
        usageLabel({ governed: true, fractionLeft: usd, units: { count: Math.abs(usd) * 7, label: 'standard comic pages' } }),
        usageLabel({ governed: true, fractionLeft: 0.5, units: { count: 3, label: `pages ($${usd} each)` } }),
        costLabel(usd, { governed: true, pctPerUsd: 10 }),
        costLabel(usd, { governed: true, pctPerUsd: 0.37 }),
        costLabel(usd, { governed: true }),
        costLabel(usd, { governed: true, pctPerUsd: NaN }),
        governText(`This page costs $${usd}, about ≈ $${Math.abs(usd).toFixed(2)} or <$0.01, and $ alone.`, { governed: true, pctPerUsd: 10 }),
        governText(`$${Math.abs(usd).toLocaleString('en-US')}`, { governed: true, pctPerUsd: 2 }),
      ];
      for (const t of texts) if (t.indexOf('$') !== -1) offenders.push(`${usd}: ${t}`);
    }
    expect(offenders).toEqual([]);
  });

  it('words what is left as a share: "93% usage left"', () => {
    expect(usageLabel({ governed: true, fractionLeft: 0.937 })).toBe('93% usage left');
    expect(usageLabel({ governed: true, fractionLeft: 0.005 })).toBe('Less than 1% usage left');
    expect(usageLabel({ governed: true, fractionLeft: 0 })).toBe('No usage left');
    expect(usageLabel({ governed: true, fractionLeft: 2 })).toBe('100% usage left');
    expect(usageLabel({ governed: true, fractionLeft: null })).toBe('Usage left unknown');
    expect(usageLabel({ governed: true, fractionLeft: 0.38, units: { count: 55.7, label: 'standard comic pages' } })).toBe('38% usage left — about 55 standard comic pages');
  });

  it('words a price as a share of usage for governed users, dollars for everyone else', () => {
    expect(costLabel(0.05, { governed: true, pctPerUsd: 40 })).toBe('≈2% of your usage');
    expect(costLabel(0.001, { governed: true, pctPerUsd: 40 })).toBe('<0.1% of your usage');
    expect(costLabel(0.5, { governed: true, pctPerUsd: 40 })).toBe('≈20% of your usage');
    expect(costLabel(0, { governed: true, pctPerUsd: 40 })).toBe('Free');
    expect(costLabel(0.05, { governed: false })).toBe('$0.05');
    expect(formatUsd(1250.5)).toBe('$1250.50');
    expect(costLabel(0, { governed: false })).toBe('$0.00');
    expect(costLabel(0.05, { governed: true })).toBe('uses a little of your usage');
    expect(costLabel(50, { governed: true, pctPerUsd: 40 })).toBe('≈2000% of your usage');
    expect(governText('That is $0.05.', { governed: true })).toBe('That is a little of your usage.');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(governText('That is $0.05.', { governed: false })).toBe('That is $0.05.');
    expect(governText('That is $0.05.', { governed: true, pctPerUsd: 40 })).toBe('That is ≈2% of your usage.');
  });

  it('carries server-to-server costs as whole micros', () => {
    expect(COST_MICROS_HEADER).toBe('X-Platform-Cost-Micros');
    expect(usdToMicros(0.0021)).toBe(2100);
    expect(usdToMicros(-1)).toBe(0);
    expect(usdToMicros(NaN)).toBe(0);
    expect(microsToUsd(2100)).toBe(0.0021);
  });
});
