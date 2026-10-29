// @vitest-environment node
// Price mapping (models.md §4.3 rules over the real 17:51Z OpenRouter shapes) and the server PriceBook (§2.3).
import { describe, expect, it } from 'vitest';
import { redrawQuote } from '../../../../shared/comic/modelLock.js';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel } from '../../../../shared/comic/models.js';
import { makeLakeComic } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { loadOpenRouterFixture } from './__fixtures__/catalogFakes.js';
import {
  NO_OPENROUTER_PRICE_COPY,
  PER_TOKEN_NOTE,
  PRICE_UNPUBLISHED_COPY,
  mapEndpointPricing,
  mergeWithRegistry,
  priceBookFromSources,
  registryPrices,
  variantToResolution,
  type ObservedMedian,
  type PriceBookRow
} from './pricing.js';

const fx = loadOpenRouterFixture();
const eps = (id: string) => fx.imageEndpoints[id].endpoints;
const at = fx.fetchedAt;

describe('mapEndpointPricing (models.md §4.3 mapping rules, 17:51Z data)', () => {
  it('Nano Banana 2.1: 1K 0.0336 and 2K 0.0504 from the Google token table, basis vendor_table, one provider', () => {
    const spec = getImageModel('nano-banana-2.1')!;
    const r = mapEndpointPricing({ modelId: 'google/gemini-nano-banana-2.1', endpoints: eps('google/gemini-nano-banana-2.1'), spec, fetchedAt: at });
    expect(r.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    expect(r.price['2K']).toMatchObject({ usd: 0.0504, basis: 'vendor_table' });
    expect(r.price['1K']!.note).toContain('1120 tokens × $30/M');
    // 4K: the two Google pages disagree; we take the higher table and say so (§1.6 #2, §4.6).
    expect(r.price['4K']!.usd).toBeGreaterThanOrEqual(0.113);
    expect(r.price['4K']!.note).toContain('Google lists 4K as $0.076 in one place and $0.113 in another');
    expect(r.providers).toEqual(['Google AI Studio']);
  });

  it('Krea K3 Edit: an empty pricing array is null with "OpenRouter doesn\'t list a price"', () => {
    const r = mapEndpointPricing({ modelId: 'krea/k3-edit', endpoints: eps('krea/k3-edit'), fetchedAt: at });
    expect(Object.keys(r.price).sort()).toEqual(['1K', '2K']);
    for (const p of Object.values(r.price)) expect(p).toEqual({ usd: null, basis: 'openrouter_endpoint', note: NO_OPENROUTER_PRICE_COPY });
    expect(NO_OPENROUTER_PRICE_COPY).toBe("OpenRouter doesn't list a price for this model");
  });

  it('Seedream 5 Pro: base $0.045 is 1K; the "high_resolution" variant is not guessed into 2K (null + the raw variant)', () => {
    const spec = getImageModel('seedream-5-pro')!;
    const r = mapEndpointPricing({ modelId: 'bytedance-seed/seedream-5-0-pro', endpoints: eps('bytedance-seed/seedream-5-0-pro'), spec, fetchedAt: at });
    expect(r.price['1K']).toMatchObject({ usd: 0.045, basis: 'openrouter_endpoint' });
    expect(r.price['2K']!.usd).toBeNull();
    expect(r.price['2K']!.note).toContain('high_resolution');
    expect(r.perRefUsd).toBe(0.003); // the endpoint's input_image line
    // The registry has no 2K number either, so the merged price stays null with the live note.
    const merged = mergeWithRegistry(r.price, spec);
    expect(merged['2K']!.usd).toBeNull();
    expect(merged['2K']!.note).toContain('high_resolution');
  });

  it('Riverflow V2.5 Fast: a base price with resolution variants is the lowest tier (base = 1K, "2k" = 2K)', () => {
    const r = mapEndpointPricing({ modelId: 'sourceful/riverflow-v2.5-fast', endpoints: eps('sourceful/riverflow-v2.5-fast'), fetchedAt: at });
    expect(r.price['1K']).toMatchObject({ usd: 0.019, basis: 'openrouter_endpoint' });
    expect(r.price['2K']).toMatchObject({ usd: 0.021, basis: 'openrouter_endpoint' });
  });

  it('unit: token without a published table is null with "billed per token; tokens per image not published"', () => {
    const r = mapEndpointPricing({ modelId: 'microsoft/mai-image-2.6-flash', endpoints: [{ provider_name: 'Azure', pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.000019 }] }] });
    expect(r.price['1K']).toEqual({ usd: null, basis: 'openrouter_endpoint', note: PER_TOKEN_NOTE });
  });

  it('unit: megapixel is multiplied by the requested size (basis derived_mp)', () => {
    const r = mapEndpointPricing({ modelId: 'x/mp', endpoints: [{ provider_name: 'P', supported_parameters: { resolution: { values: ['1K', '2K'] } }, pricing: [{ billable: 'output_image', unit: 'megapixel', cost_usd: 0.01 }] }] });
    expect(r.price['1K']).toMatchObject({ usd: 0.010486, basis: 'derived_mp' });
    expect(r.price['2K']).toMatchObject({ usd: 0.041943, basis: 'derived_mp' });
  });

  it('two endpoints at different prices: quote the lower and name both (never smoothed over)', () => {
    const r = mapEndpointPricing({
      modelId: 'google/gemini-3.1-flash-image',
      endpoints: [
        { provider_name: 'Google AI Studio', supported_parameters: { resolution: { values: ['1K'] } }, pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00006 }] },
        { provider_name: 'Google Vertex (US)', supported_parameters: { resolution: { values: ['1K'] } }, pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.000066 }] }
      ]
    });
    expect(r.price['1K']!.usd).toBe(0.0672);
    expect(r.price['1K']!.note).toContain('endpoints differ');
    expect(r.price['1K']!.note).toContain('Google Vertex (US)');
  });

  it('maps OpenRouter resolution spellings and nothing else', () => {
    expect(['1k', '1K', '2k', '4K', '512', 'high_resolution', 'low_1k', 7].map(variantToResolution)).toEqual(['1K', '1K', '2K', '4K', '512', undefined, undefined, undefined]);
  });

  it('registry fallback is labelled with its date; an unpriced resolution carries the §4.6 copy', () => {
    const nb = registryPrices(getImageModel('nano-banana-2.1')!);
    expect(nb['1K']).toEqual({ usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22' });
    const seed = registryPrices(getImageModel('seedream-5-pro')!);
    expect(seed['2K']).toEqual({ usd: null, basis: 'registry', note: PRICE_UNPUBLISHED_COPY });
  });
});

const liveRows = (): PriceBookRow[] => {
  const ids = ['nano-banana-2.1', 'nano-banana-pro', 'seedream-5-pro'];
  return ids.map((id) => {
    const spec = getImageModel(id)!;
    const live = mapEndpointPricing({ modelId: spec.routes.openrouter!, endpoints: eps(spec.routes.openrouter!), spec, fetchedAt: at });
    return { id, price: mergeWithRegistry(live.price, spec), perRefUsd: live.perRefUsd, fetchedAt: { catalog: at } };
  });
};

const obs = (o: Partial<ObservedMedian>): ObservedMedian => ({ modelId: 'nano-banana-2.1', kind: 'page', res: '1K', n: 4, medianUsd: 0.047, minUsd: 0.0428, maxUsd: 0.0538, scope: 'you', ...o });

describe('PriceBook (models.md §2.3)', () => {
  it('list = the live OpenRouter price, labelled with its source', () => {
    const book = priceBookFromSources({ rows: liveRows() });
    const u = book.unit('nano-banana-2.1', '1K', 'page');
    expect(u.usd).toBe(0.0336);
    expect(u.basis).toContain('vendor token table via OpenRouter');
    expect(book.qcUsd).toBe(QC_USD_PER_PAGE);
  });

  it('no live row → the registry price labelled "price list from {factsAsOf}"', () => {
    const book = priceBookFromSources({ rows: [] });
    expect(book.unit('nano-banana-pro', '2K', 'page')).toEqual({ usd: 0.1344, basis: 'price list from 2026-10-22' });
  });

  it('observed median wins when it is higher and n ≥ 3 — and the basis says so', () => {
    const book = priceBookFromSources({ rows: liveRows(), observed: [obs({})] });
    const u = book.unit('nano-banana-2.1', '1K', 'page');
    expect(u.usd).toBe(0.047);
    expect(u.basis).toBe('your last 4 pages: $0.0428–$0.0538; list $0.0336');
  });

  it('observed with n < 3 is ignored (only the list price)', () => {
    const book = priceBookFromSources({ rows: liveRows(), observed: [obs({ n: 2 })] });
    expect(book.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.0336);
  });

  it('never under-quotes: an observed median below list keeps the list price', () => {
    const book = priceBookFromSources({ rows: liveRows(), observed: [obs({ medianUsd: 0.02, minUsd: 0.019, maxUsd: 0.021 })] });
    const u = book.unit('nano-banana-2.1', '1K', 'page');
    expect(u.usd).toBe(0.0336);
    expect(u.basis).toContain('your last 4 pages');
  });

  it('reference cost is added to the LIST basis only (the observed total already includes it)', () => {
    const book = priceBookFromSources({ rows: liveRows() });
    expect(book.unit('nano-banana-pro', '1K', 'page', 4).usd).toBe(0.1388); // 0.1344 + 4 × 0.0011
    expect(book.unit('nano-banana-pro', '1K', 'page', 4).basis).toContain('for 4 references');
    const withObs = priceBookFromSources({ rows: liveRows(), observed: [obs({ modelId: 'nano-banana-pro', medianUsd: 0.139, minUsd: 0.134, maxUsd: 0.141 })] });
    expect(withObs.unit('nano-banana-pro', '1K', 'page', 4).usd).toBe(0.139); // max(0.1388, 0.139), refs not added again
    // An unpublished per-reference price is never counted as 0 silently.
    expect(book.unit('nano-banana-2.1', '1K', 'page', 3).basis).toContain('reference cost unpublished');
  });

  it('platform aggregate is the fallback when the user has no own observation', () => {
    const book = priceBookFromSources({ rows: liveRows(), observed: [obs({ scope: 'platform', n: 30, medianUsd: 0.05, minUsd: 0.04, maxUsd: 0.06 })] });
    expect(book.unit('nano-banana-2.1', '1K', 'page').basis).toContain("DreamStream creators' last 30 pages");
    const both = priceBookFromSources({ rows: liveRows(), observed: [obs({ scope: 'platform', n: 30, medianUsd: 0.05 }), obs({})] });
    expect(both.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.047); // the user's own first
  });

  it('no basis at all → usd null (the UI shows no number)', () => {
    const book = priceBookFromSources({ rows: liveRows() });
    expect(book.unit('seedream-5-pro', '2K', 'page').usd).toBeNull();
    expect(book.unit('no-such-model', '1K', 'page').usd).toBeNull();
  });

  it('QC uses the observed median only when n ≥ 5', () => {
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0049, n: 4 } }).qcUsd).toBe(QC_USD_PER_PAGE);
    expect(priceBookFromSources({ rows: [], qc: { medianUsd: 0.0049, n: 7 } }).qcUsd).toBe(0.0049);
  });

  it('jobQuote: (unit + QC for pages) × PLATFORM_MARKUP unless BYOK', () => {
    const book = priceBookFromSources({ rows: liveRows(), qc: { medianUsd: 0.0049, n: 7 } });
    const page = book.jobQuote('nano-banana-2.1', '1K', 'page');
    expect(page.usd).toBe(Math.round((0.0336 + 0.0049) * PLATFORM_MARKUP * 10000) / 10000);
    expect(page.basis).toContain('QC $0.0049 (your last 7 checks)');
    expect(book.jobQuote('nano-banana-2.1', '1K', 'page', { byok: true }).usd).toBe(0.0385);
    expect(book.jobQuote('nano-banana-2.1', '1K', 'sheet', { byok: true })).toMatchObject({ usd: 0.0336, qcUsd: 0 });
    expect(book.jobQuote('seedream-5-pro', '2K', 'page').usd).toBeNull();
  });

  it('plugs into the shared redrawQuote (lake comic, BYOK): Pro redraw of pages + cover at list', () => {
    const doc = makeLakeComic();
    const book = priceBookFromSources({ rows: [] });
    const q = redrawQuote(doc, 'nano-banana-pro', 'pages_cover', book, true);
    expect(q.basis).toEqual(['price list from 2026-10-22']);
    expect(q.usd).not.toBeNull();
    // 5 pages × (0.1344 + QC) + 1 cover × 0.1344 at the draft tier's 1K.
    expect(q.usd).toBeCloseTo(5 * (0.1344 + QC_USD_PER_PAGE) + 0.1344, 4);
  });
});
