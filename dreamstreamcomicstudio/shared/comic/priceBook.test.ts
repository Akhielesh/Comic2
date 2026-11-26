// The one price book (docs/features/pricing.md): never under the list price or the constants, the wire sheet carries
// numbers and bases only, and a malformed sheet never reaches a quote. Synthetic prices only.
import { describe, expect, it } from 'vitest';
import { PLAN_USD_PER_PAGE, QC_USD_PER_PAGE, STYLE_DIRECTIONS_USD, estimateJobs } from './models';
import {
  FLOOR_TEXT_RATES,
  planUsd,
  priceBookFromSources,
  priceSheetOf,
  recheckQuoteUsd,
  sanitizePriceSheet,
  sanitizeTextRates,
  styleDirectionsQuoteUsd,
  textRatesOf
} from './priceBook';

describe('never under the list or the constants', () => {
  it('QC: an observed median only ever raises the figure', () => {
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0012, n: 12 } }).qcUsd).toBe(QC_USD_PER_PAGE);
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0012, n: 12 } }).qcObserved).toBeNull();
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0049, n: 12 } }).qcUsd).toBe(0.0049);
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0049, n: 4 } }).qcUsd).toBe(QC_USD_PER_PAGE);
  });

  it('text rates below a constant read the constant; a missing or broken value is the constant', () => {
    expect(sanitizeTextRates({ planPerPageUsd: 0.001, styleDirectionsUsd: -1, translateFactor: 0.2 })).toEqual(FLOOR_TEXT_RATES);
    expect(sanitizeTextRates(null)).toEqual(FLOOR_TEXT_RATES);
    expect(sanitizeTextRates({ planPerPageUsd: 0.018, styleDirectionsUsd: 0.02, translateFactor: 1.25 })).toMatchObject({ planPerPageUsd: 0.018, styleDirectionsUsd: 0.02, translateFactor: 1.25 });
    expect(textRatesOf(undefined)).toEqual(FLOOR_TEXT_RATES);
  });

  it('the text quotes: planning, style directions and the re-check, markup unless own key', () => {
    expect(planUsd(6, true)).toBe(Math.round(6 * PLAN_USD_PER_PAGE * 10000) / 10000);
    expect(planUsd(0, true)).toBe(PLAN_USD_PER_PAGE);
    expect(styleDirectionsQuoteUsd(false)).toBe(Math.round(STYLE_DIRECTIONS_USD * 1.3 * 10000) / 10000);
    expect(recheckQuoteUsd(true)).toBe(QC_USD_PER_PAGE);
    expect(recheckQuoteUsd(true, { qcUsd: 0.0001 })).toBe(QC_USD_PER_PAGE);
    expect(recheckQuoteUsd(true, { qcUsd: 0.006 })).toBe(0.006);
  });

  it('without a book estimateJobs is exactly the registry quote it always was', () => {
    const jobs = [{ kind: 'page' as const, count: 3 }, { kind: 'cover' as const, count: 1 }];
    const registry = estimateJobs(jobs, 'standard', { byok: false });
    expect(estimateJobs(jobs, 'standard', { byok: false, prices: priceBookFromSources({ rows: [] }) })).toEqual(registry);
  });
});

describe('the price sheet on the wire', () => {
  const sources = {
    rows: [{ id: 'nano-banana-2.1', price: { '1K': { usd: 0.0336, basis: 'openrouter_endpoint' as const, note: 'A $0.03 · B $0.04' } }, perRefUsd: 0.0005, fetchedAt: { catalog: '2026-11-20T10:00:00Z' } }],
    observed: [{ modelId: 'nano-banana-2.1', kind: 'page', res: '1K' as const, n: 5, medianUsd: 0.05, minUsd: 0.04, maxUsd: 0.06, scope: 'you' as const }],
    qc: { medianUsd: 0.0041, n: 6 },
    text: { planPerPageUsd: 0.015, styleDirectionsUsd: 0.015, translateFactor: 1 }
  };

  it('carries prices and bases, never a note', () => {
    const sheet = priceSheetOf(sources, 1);
    expect(sheet.sources.rows[0].price['1K']).toEqual({ usd: 0.0336, basis: 'openrouter_endpoint' });
    expect(JSON.stringify(sheet)).not.toContain('$');
  });

  it('round-trips into the same book', () => {
    const wire = sanitizePriceSheet(JSON.parse(JSON.stringify(priceSheetOf(sources, 1))))!;
    const a = priceBookFromSources(wire.sources);
    const b = priceBookFromSources(sources);
    for (const kind of ['page', 'sheet', 'cover'] as const) expect(a.unit('nano-banana-2.1', '1K', kind)).toEqual(b.unit('nano-banana-2.1', '1K', kind));
    expect(a.qcUsd).toBe(b.qcUsd);
    expect(a.text).toEqual(b.text);
  });

  it('drops what is malformed: a wrong version, bad rows, bad medians, unknown resolutions', () => {
    expect(sanitizePriceSheet(null)).toBeNull();
    expect(sanitizePriceSheet({ v: 2, at: 1, sources: {} })).toBeNull();
    const wire = sanitizePriceSheet({
      v: 1,
      at: 1,
      sources: {
        rows: [{ id: '' }, { id: 'x', price: { '8K': { usd: 1 }, '1K': { usd: -3, basis: 'nope' } } }],
        observed: [{ modelId: 'x', kind: 'page', res: '1K', n: 'many', medianUsd: 1 }, { modelId: 'x', kind: 'page', res: '1K', n: 5, medianUsd: 0.07 }],
        text: { planPerPageUsd: 'lots' }
      }
    })!;
    expect(wire.sources.rows).toEqual([{ id: 'x', price: { '1K': { usd: null, basis: 'registry' } }, perRefUsd: null }]);
    expect(wire.sources.observed).toHaveLength(1);
    expect(wire.sources.text).toEqual(FLOOR_TEXT_RATES);
  });
});
