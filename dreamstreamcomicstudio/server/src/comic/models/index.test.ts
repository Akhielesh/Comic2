// @vitest-environment node
// The public surface of the model catalog: nothing runs at import (AT-8: no timer may wake the container),
// createPriceBook(deps) implements the shared PriceBook contract and never throws, and the database rows map
// defensively. Nothing here touches the network or a database.
import { describe, expect, it, vi } from 'vitest';

describe('no timers, fetches or catalog work at import (models.md §4.5 cadence rule, AT-8)', () => {
  it('importing the catalog modules and the route schedules nothing and fetches nothing', async () => {
    // Modules this package does not own load first (their own import-time behaviour is not under test here).
    await import('../../lib/logger.js');
    await import('../../services/supabase.js');
    await import('../session.js');
    await import('../access.js');
    await import('../store.js');
    await import('../jobs.js');
    await import('../keys.js');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await import('./quality.js');
      await import('./observed.js');
      await import('./pricing.js');
      await import('./catalog.js');
      await import('./index.js');
      await import('../../routes/comicModels.js');
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setImmediateSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      setImmediateSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('the sources contain no interval scheduling at all', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['catalog.ts', 'quality.ts', 'observed.ts', 'pricing.ts', 'index.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/setInterval\s*\(/);
    }
  });
});

describe('createPriceBook (shared PriceBook contract, models.md §2.3)', () => {
  it('builds from the live catalog for one user: live list price, their observed cost, observed QC', async () => {
    const { createPriceBook } = await import('./index.js');
    const { createModelCatalog } = await import('./catalog.js');
    const { createQualitySource } = await import('./quality.js');
    const { FAKE_BASE, FIXTURE_NOW, callRow, fakeOpenRouterFetch, memoryImageCalls } = await import('./__fixtures__/catalogFakes.js');
    const rows = [
      ...[0.0428, 0.0465, 0.0474, 0.0538].map((c, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 60_000, providerCostUsd: c })),
      ...Array.from({ length: 7 }, (_, i) => callRow({ at: FIXTURE_NOW - (i + 1) * 60_000, modelId: 'gemini-3.8-flash', kind: 'qc', res: null, providerCostUsd: 0.0049 }))
    ];
    const catalog = createModelCatalog({ fetch: fakeOpenRouterFetch(), baseUrl: FAKE_BASE, now: () => FIXTURE_NOW, calls: memoryImageCalls(rows), quality: createQualitySource({ fetch: null }) });
    const book = await createPriceBook({ userId: 'user-a', catalog });
    expect(book.unit('nano-banana-2.1', '1K', 'page')).toEqual({ usd: 0.047, basis: 'your last 4 pages: $0.0428–$0.0538; list $0.0336' });
    expect(book.unit('nano-banana-2.1', '2K', 'page').usd).toBe(0.0504);
    expect(book.qcUsd).toBe(0.0049);
    // Another user sees only the list price (their own calls only; the platform needs ≥ 5 users).
    const other = await createPriceBook({ userId: 'user-b', catalog });
    expect(other.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.0336);
  });

  it('works with the shared redrawQuote and never throws: a failing catalog falls back to the dated registry list', async () => {
    const { createPriceBook, registryPriceBook } = await import('./index.js');
    const { redrawQuote } = await import('../../../../shared/comic/modelLock.js');
    const { makeLakeComic } = await import('../../../../shared/comic/__fixtures__/lakeComic.js');
    const { logger } = await import('../../lib/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const broken = { priceSources: async () => Promise.reject(new Error('boom')) } as unknown as import('./catalog.js').ModelCatalog;
    const book = await createPriceBook({ userId: 'u', catalog: broken });
    expect(book.unit('nano-banana-pro', '1K', 'page')).toEqual({ usd: 0.1344, basis: 'price list from 2026-10-22' });
    expect(warn).toHaveBeenCalledWith('comic_price_book_fallback', expect.anything());
    const q = redrawQuote(makeLakeComic(), 'nano-banana-pro', 'pages_cover', book, true);
    expect(q.usd).toEqual(redrawQuote(makeLakeComic(), 'nano-banana-pro', 'pages_cover', registryPriceBook(), true).usd);
    expect((await createPriceBook({ sources: { rows: [] } })).unit('nano-banana-2.1', '1K', 'page').basis).toBe('price list from 2026-10-22');
    warn.mockRestore();
  });
});

describe('database rows', () => {
  it('map numerics that arrive as strings, and drop malformed rows', async () => {
    const { imageCallFromDb, platformStatFromDb } = await import('./index.js');
    expect(imageCallFromDb({ model_id: 'nano-banana-2.1', kind: 'page', res: '1K', outcome: 'ok', http_status: null, error_code: null, provider_cost_usd: '0.0428', created_at: '2026-10-22T18:00:00+00:00' })).toEqual({
      modelId: 'nano-banana-2.1',
      kind: 'page',
      res: '1K',
      outcome: 'ok',
      httpStatus: null,
      errorCode: null,
      providerCostUsd: 0.0428,
      createdAt: '2026-10-22T18:00:00.000Z'
    });
    expect(imageCallFromDb({ model_id: 'x', outcome: 'weird', created_at: '2026-10-22T18:00:00Z' })).toBeNull();
    expect(
      platformStatFromDb({ model_id: 'nano-banana-2.1', kind: 'page', res: '1K', calls: '12', ok: 10, failed: 2, rate_limited: 1, distinct_users: 6, priced_calls: '9', cost_n: 9, median_cost_usd: '0.047', min_cost_usd: null, max_cost_usd: 0.06, cost_from: '2026-10-22T17:00:00Z', cost_to: null, first_at: null, last_at: null })
    ).toMatchObject({ calls: 12, distinctUsers: 6, pricedCalls: 9, costN: 9, medianCostUsd: 0.047, minCostUsd: null, costFrom: '2026-10-22T17:00:00Z', costTo: null });
  });

  it('without a service-role key there is no store and no calls database (nothing is attempted)', async () => {
    const { createSupabaseCatalogStore, createSupabaseImageCallsDb } = await import('./index.js');
    const { getSupabaseCapabilityStatus } = await import('../../services/supabase.js');
    if (getSupabaseCapabilityStatus().storagePersistenceEnabled) return; // a developer machine with real keys
    expect(createSupabaseCatalogStore()).toBeNull();
    expect(createSupabaseImageCallsDb()).toBeNull();
  });
});
