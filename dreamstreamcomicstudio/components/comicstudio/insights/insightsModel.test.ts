// Pure insights helpers (models.md §4.1–§4.6) on the f8312c86-shaped fixture: every number traces to the doc or
// the registry; a missing figure is the §4.6 copy or null — never a guess.

import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../shared/comic/doc';
import { MAX_SPEND_ENTRIES } from '../../../shared/comic/limits';
import { getImageModel } from '../../../shared/comic/models';
import { LAKE_MODEL, makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { costFormat } from '../conversation/cost';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { NOT_ENOUGH_DATA_COPY, NO_OPENROUTER_PRICE_COPY, NO_UPTIME_COPY, NOT_RANKED_COPY, PRICE_UNPUBLISHED_COPY } from './copy';
import {
  OBSERVED_MIN_N,
  OBSERVED_WINDOW,
  clockText,
  dateText,
  insightsMoney,
  observedLines,
  pageRealCost,
  preciseUsd,
  priceView,
  qualityText,
  registryPriceViews,
  sizeCosts,
  spendSeries,
  spendSummary,
  uptimeText
} from './insightsModel';

const dollars = insightsMoney(costFormat(DOLLAR_CONTEXT));
const governed = insightsMoney(costFormat({ governed: true, pctPerUsd: 20 }));

// Loaded by a computed path so the client typecheck never pulls server modules into its program.
const serverModule = async (path: string): Promise<Record<string, unknown>> => (await import(/* @vite-ignore */ path)) as Record<string, unknown>;

describe('the §4.6 copy is the server’s copy', () => {
  it('price, observed thresholds and "not enough data" match server/src/comic/models', async () => {
    const serverPricing = await serverModule('../../../server/src/comic/models/pricing');
    const serverObserved = await serverModule('../../../server/src/comic/models/observed');
    expect(PRICE_UNPUBLISHED_COPY).toBe(serverPricing.PRICE_UNPUBLISHED_COPY);
    expect(NO_OPENROUTER_PRICE_COPY).toBe(serverPricing.NO_OPENROUTER_PRICE_COPY);
    expect(OBSERVED_MIN_N).toBe(serverPricing.OBSERVED_MIN_N);
    expect(OBSERVED_WINDOW).toBe(serverPricing.OBSERVED_WINDOW);
    expect(NOT_ENOUGH_DATA_COPY).toBe(serverObserved.NOT_ENOUGH_DATA_COPY);
  });
});

describe('money for this viewer', () => {
  it('dollar viewers read precise dollars (up to 4 decimals); governed users read shares, never dollars', () => {
    expect(preciseUsd(0.7513)).toBe('$0.7513');
    expect(preciseUsd(0.06)).toBe('$0.06');
    expect(preciseUsd(0.4)).toBe('$0.40');
    expect(preciseUsd(1.3685)).toBe('$1.3685');
    expect(preciseUsd(12.4)).toBe('$12.40');
    expect(preciseUsd(0)).toBe('$0');
    expect(dollars.spent(0.7513)).toBe('$0.7513');
    expect(dollars.quote(0.0437)).toBe('≈$0.0437');
    for (const s of [governed.spent(0.7513), governed.price(0.0336), governed.quote(0.05), governed.priceShort(0.0336) ?? '']) expect(s).not.toMatch(/\$/);
    expect(governed.price(0.0336)).toMatch(/of your usage$/);
  });
});

describe('spendSummary (the one summary every Spending view reads)', () => {
  it('lists Translate and kinds this build does not know yet; splits own-key vs DreamStream; counts estimates', () => {
    const doc = makeLakeComic((d) => {
      d.spend.byKind.translate = 0.02;
      (d.spend.byKind as Record<string, number>).future_kind = 0.01;
      d.spend.entries.unshift({ id: 'est', at: 9e12, kind: 'chat', label: 'Director', usd: 0.001, byok: false, estimated: true });
    });
    const s = spendSummary(doc);
    expect(s.kinds.map((k) => k.kind)).toEqual(['page', 'cover', 'sheet', 'qc', 'chat', 'translate', 'future_kind']);
    expect(s.kinds.find((k) => k.kind === 'translate')!.label).toBe('Translations');
    expect(s.kinds.find((k) => k.kind === 'future_kind')!.label).toBe('future kind');
    expect(s.byok).toEqual({ usd: 0.7856, images: 15 });
    expect(s.estimated).toBe(1);
    expect(s.exact).toBe(true);
    expect(s.recentN).toBeUndefined();
  });

  it('a capped entry list says the splits are recent only', () => {
    const doc = makeLakeComic((d) => {
      const e = d.spend.entries[0];
      d.spend.entries = Array.from({ length: MAX_SPEND_ENTRIES }, (_, i) => ({ ...e, id: `e${i}` }));
    });
    expect(spendSummary(doc)).toMatchObject({ exact: false, recentN: MAX_SPEND_ENTRIES });
  });
});

describe('observed ("real") cost', () => {
  it('real cost per page: median of the comic’s pages at the size its next pages draw at, with n, range and list', () => {
    const real = pageRealCost(makeLakeComic())!; // Draft → 1K pages: pages 2–5 ($0.0428 / 0.0465 / 0.0474 / 0.0538)
    expect(real).toMatchObject({ modelId: LAKE_MODEL, nickname: 'Nano Banana 2.1', res: '1K', n: 4, minUsd: 0.0428, maxUsd: 0.0538, medianUsd: 0.047 });
    // No list price recorded on the entries → the registry's dated list price, labelled as such.
    const spec = getImageModel(LAKE_MODEL)!;
    expect(real.list).toEqual({ usd: spec.priceUsd['1K'], source: 'registry', factsAsOf: spec.factsAsOf });
  });

  it('n < 3 → no real-cost row (only the list price)', () => {
    const two = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.filter((e) => !(e.kind === 'page' && e.res === '1K' && ['Page 2', 'Page 3'].includes(e.label)));
    });
    expect(pageRealCost(two)).toBeNull();
    // Estimated and failed entries never count as observed.
    const noisy = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((e) => (e.kind === 'page' && e.res === '1K' ? { ...e, estimated: true } : e));
    });
    expect(pageRealCost(noisy)).toBeNull();
  });

  it('platform entries are compared with list at provider cost (the markup is taken out)', () => {
    const doc = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((e) => (e.kind === 'page' && e.res === '1K' ? { ...e, byok: false, usd: e.usd * 1.3, listUsd: 0.0336 } : e));
    });
    const real = pageRealCost(doc)!;
    expect(real.minUsd).toBeCloseTo(0.0428, 4);
    expect(real.list).toEqual({ usd: 0.0336, source: 'recorded' });
  });

  it('per size on the Models tab: observed only at n ≥ 3, list always', () => {
    const sizes = sizeCosts(makeLakeComic(), LAKE_MODEL);
    expect(sizes.map((s) => [s.res, s.images])).toEqual([['1K', 9], ['2K', 6]]);
    expect(sizes[1].observed).toMatchObject({ n: 6, minUsd: 0.0579, maxUsd: 0.06 });
    const sparse = sizeCosts(makeLakeComic((d) => { d.spend.entries = d.spend.entries.filter((e) => e.res !== '2K' || e.label === 'Page 1'); }), LAKE_MODEL);
    expect(sparse.find((s) => s.res === '2K')).toMatchObject({ images: 1, observed: null });
    expect(sparse.find((s) => s.res === '2K')!.list).toMatchObject({ source: 'registry' });
  });
});

describe('T1 spend over time', () => {
  it('buckets by hour inside two days, groups by kind, and keeps a running total', () => {
    const s = spendSeries(makeLakeComic())!;
    expect(s.unit).toBe('hour');
    const total = s.buckets.reduce((n, b) => n + b.total, 0);
    expect(total).toBeCloseTo(0.7513 + 0.0343 + 0.0062, 4);
    expect(s.cumulative.at(-1)).toBeCloseTo(total, 4);
    const groups = new Set(s.buckets.flatMap((b) => Object.keys(b.byGroup)));
    expect([...groups].sort()).toEqual(['art', 'checks', 'director', 'pages']);
    const sum = (g: 'pages' | 'checks') => s.buckets.reduce((n, b) => n + (b.byGroup[g] ?? 0), 0);
    expect(sum('pages')).toBeCloseTo(0.5482, 4);
    expect(sum('checks')).toBeCloseTo(0.0343, 4);
    expect(spendSeries(makeLakeComic((d) => { d.spend.entries = []; }))).toBeNull();
  });

  it('weeks of spend become days; months become weeks', () => {
    const day = 86_400_000;
    const at = (i: number): SpendEntry => ({ id: `e${i}`, at: 1_700_000_000_000 + i * 10 * day, kind: 'page', label: 'Page', usd: 0.05, byok: true, estimated: false });
    expect(spendSeries(makeLakeComic((d) => { d.spend.entries = [at(0), at(1)]; }))!.unit).toBe('day');
    expect(spendSeries(makeLakeComic((d) => { d.spend.entries = [at(0), at(20)]; }))!.unit).toBe('week');
  });
});

describe('catalog words (§4.6 — exact copy, no invented number)', () => {
  it('a null price is the exact copy; a registry price says its date; dollar viewers see the disagree note', () => {
    const unpublished = priceView({ usd: null, basis: 'vendor_table', note: PRICE_UNPUBLISHED_COPY }, dollars)!;
    expect(unpublished).toEqual({ text: PRICE_UNPUBLISHED_COPY, unavailable: true });
    expect(priceView({ usd: null, basis: 'openrouter_endpoint', note: NO_OPENROUTER_PRICE_COPY }, dollars)!.text).toBe(NO_OPENROUTER_PRICE_COPY);
    expect(priceView({ usd: null, basis: 'openrouter_endpoint', note: 'high_resolution' }, dollars)!.text).toBe('No price for this size yet (high_resolution)');
    expect(priceView({ usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22' }, governed)!.source).toBe('from our price list, 2026-10-22');
    const disagree = { usd: 0.113, basis: 'vendor_table' as const, note: 'Google lists 4K as $0.076 in one place and $0.113 in another; we quote $0.113' };
    expect(priceView(disagree, dollars)!.source).toContain('Google lists 4K as $0.076 in one place and $0.113 in another; we quote $0.113');
    // Governed users never read a note that can name dollars.
    expect(priceView(disagree, governed)!.source).toBe('vendor token table');
    expect(priceView(disagree, governed)!.text).not.toMatch(/\$/);
    expect(priceView(undefined, dollars)).toBeUndefined();
  });

  it('registry facts when nothing could be fetched carry "from our price list, {factsAsOf}"', () => {
    const spec = getImageModel(LAKE_MODEL)!;
    const views = registryPriceViews(LAKE_MODEL, dollars);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(v.view.source).toBe(`from our price list, ${spec.factsAsOf}`);
  });

  it('uptime: the 24 h figure alone when the 30-minute one is null; the copy when there is none', () => {
    expect(uptimeText([{ provider: 'Google AI Studio', uptime1d: 97.72, uptime30m: null }])).toEqual(['Google AI Studio · 97.72% up (24 h)']);
    expect(uptimeText([{ provider: 'Vertex', uptime1d: 99.1, uptime30m: 100 }])).toEqual(['Vertex · 99.1% up (24 h) · 100% (30 min)']);
    expect(uptimeText([])).toEqual([NO_UPTIME_COPY]);
    expect(uptimeText([{ provider: 'X', uptime1d: null, uptime30m: null }])).toEqual([NO_UPTIME_COPY]);
  });

  it('quality: ranks with dates, or "not ranked"', () => {
    expect(qualityText([])).toEqual([NOT_RANKED_COPY]);
    expect(qualityText([{ board: 'lmarena_edit', rank: 3, of: 60, score: 1215.4, asOf: '2026-10-20', source: 'LMArena' }])).toEqual(['LMArena edit #3 of 60 · score 1215 (Oct 20, 2026)']);
  });

  it('observed lines need n ≥ 3 and always show n and the range', () => {
    const base = { kind: 'page' as const, res: '1K' as const, medianUsd: 0.047, minUsd: 0.0428, maxUsd: 0.0538, from: '', to: '', scope: 'you' as const };
    expect(observedLines([{ ...base, n: 2 }], dollars)).toEqual([]);
    expect(observedLines([{ ...base, n: 4 }], dollars)).toEqual(['Real cost, pages at 1K: $0.047 median (n = 4, $0.0428–$0.0538) · your calls']);
  });

  it('times and dates are the real ones', () => {
    const now = new Date(2026, 9, 29, 15, 0).getTime();
    expect(clockText(new Date(2026, 9, 29, 14, 5).getTime(), now)).toBe('14:05');
    expect(clockText(new Date(2026, 9, 22, 9, 30).getTime(), now)).toBe('Oct 22, 09:30');
    expect(clockText(new Date(2025, 0, 2).getTime(), now)).toBe('Jan 2, 2025');
    expect(clockText(undefined, now)).toBe('');
    expect(dateText('2026-10-07')).toBe('Oct 7, 2026');
    expect(dateText('2026-10')).toBe('Oct 2026');
  });
});
