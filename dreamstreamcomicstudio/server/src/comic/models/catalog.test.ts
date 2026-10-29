// @vitest-environment node
// The model catalog (models.md §4.3 rows, §4.4 trends, §4.5 S1–S3/S5–S7 cadence, §4.6 missing data), driven by
// fetch fakes built from the real 17:51Z OpenRouter JSON. No network, no database, no timers left behind.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, resolveStudioCaps } from '../../../../shared/comic/capabilities.js';
import { makeLakeComic } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { logger } from '../../lib/logger.js';
import { FAKE_BASE, FIXTURE_NOW, callRow, fakeOpenRouterFetch, loadOpenRouterFixture, memoryCatalogStore, memoryImageCalls } from './__fixtures__/catalogFakes.js';
import { CACHE_SOURCE, FAIL_RETRY_MS, TTL_MS, catalogIds, createModelCatalog, type CatalogFetch, type ModelCatalogDeps, type ModelCatalogRow } from './catalog.js';
import { NOT_ENOUGH_DATA_COPY } from './observed.js';
import { createQualitySource } from './quality.js';

vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

const clock = (start = FIXTURE_NOW) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const setup = (over: Partial<ModelCatalogDeps> = {}) => {
  const c = clock();
  const fetch = fakeOpenRouterFetch();
  const store = memoryCatalogStore();
  const catalog = createModelCatalog({ fetch, store, baseUrl: FAKE_BASE, now: c.now, quality: createQualitySource({ fetch: null }), ...over });
  return { c, fetch, store, catalog };
};

const row = (rows: ModelCatalogRow[], id: string) => rows.find((r) => r.id === id)!;
const paid = resolveStudioCaps({ planId: 'creator', byok: false, isAdmin: false });

describe('catalog rows from the 17:51Z data (models.md §4.3)', () => {
  it('Nano Banana 2.1: 1K $0.0336 and 2K $0.0504 via the token table, 1 endpoint at 97.72%, dated slug, sources and times', async () => {
    const { catalog } = setup();
    const nb = row(await catalog.rows(), 'nano-banana-2.1');
    expect(nb.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    expect(nb.price['2K']).toMatchObject({ usd: 0.0504, basis: 'vendor_table' });
    expect(nb.endpoints).toHaveLength(1);
    expect(nb.endpoints[0].provider).toBe('Google AI Studio');
    expect(nb.endpoints[0].uptime1d).toBeCloseTo(97.72, 2);
    expect(nb.endpoints[0].uptime30m).toBeNull(); // §4.6: the row shows only the 24 h figure
    expect(nb.canonicalSlug).toBe('google/gemini-nano-banana-2.1-20261006');
    expect(nb.openrouterCreated).toMatch(/^2026-10-06/);
    expect(nb.providerModel).toBe('google/gemini-nano-banana-2.1');
    expect(nb.quality.find((q) => q.board === 'lmarena_edit')).toMatchObject({ rank: 5, score: 1426.2, asOf: '2026-10-20' });
    expect(nb.quality.every((q) => q.source && q.asOf)).toBe(true);
    expect(nb.fetchedAt.catalog).toBe('2026-10-22T17:51:00.000Z');
    expect(nb.fetchedAt.uptime).toBe('2026-10-22T17:51:00.000Z');
    expect(nb.fetchedAt.quality).toBeTruthy();
    expect(nb.stale).toBe(false);
    expect(nb.fit).toBeUndefined(); // no projectId
  });

  it('Seedream 5 Pro 2K is null with the raw "high_resolution" variant; GPT Image 2.5 (per token, no table) falls back to the dated registry price', async () => {
    const { catalog } = setup();
    const rows = await catalog.rows();
    const seed = row(rows, 'seedream-5-pro');
    expect(seed.price['1K']).toMatchObject({ usd: 0.045, basis: 'openrouter_endpoint' });
    expect(seed.price['2K']!.usd).toBeNull();
    expect(seed.price['2K']!.note).toContain('high_resolution');
    expect(seed.perRefUsd).toBe(0.003);
    const gpt = row(rows, 'gpt-image-2.5');
    expect(gpt.price['1K']).toMatchObject({ usd: 0.2107, basis: 'registry' });
    expect(gpt.price['1K']!.note).toContain('from our price list, 2026-10-22');
  });

  it('acceptance: the lake comic (f8312c86 shape) lists Nano Banana 2.1 Current, Nano Banana Pro pickable at a higher price, GPT 2.5 blocked on 4:5 — blocks last', async () => {
    const { catalog } = setup();
    const rows = await catalog.rows({ doc: makeLakeComic(), caps: paid });
    const nb = row(rows, 'nano-banana-2.1');
    const pro = row(rows, 'nano-banana-pro');
    const gpt = row(rows, 'gpt-image-2.5');
    expect(nb.current).toBe(true);
    expect(nb.fit!.filter((f) => f.severity === 'block')).toEqual([]);
    expect(pro.current).toBe(false);
    expect(pro.fit!.filter((f) => f.severity === 'block')).toEqual([]);
    expect(pro.price['1K']!.usd!).toBeGreaterThan(nb.price['1K']!.usd!);
    expect(gpt.fit).toContainEqual({ code: 'aspect', severity: 'block', text: "Can't draw 4:5 pages" });
    const firstBlocked = rows.findIndex((r) => r.fit!.some((f) => f.severity === 'block'));
    expect(rows.slice(firstBlocked).every((r) => r.fit!.some((f) => f.severity === 'block'))).toBe(true);
    expect(rows.indexOf(nb)).toBeLessThan(firstBlocked);
    // A free plan without a key: Pro is blocked on access with the exact copy.
    const free = await catalog.rows({ doc: makeLakeComic(), caps: DEFAULT_CAPS });
    expect(row(free, 'nano-banana-pro').fit).toContainEqual({ code: 'access', severity: 'block', text: 'Needs a paid plan or your own key' });
  });

  it('fetches only registry + watch-list ids, each once, from the documented paths', async () => {
    const { catalog, fetch } = setup();
    await catalog.rows();
    const ids = catalogIds();
    expect(fetch.calls).toContain(`${FAKE_BASE}/images/models`);
    for (const id of ids) {
      expect(fetch.calls.filter((u) => u === `${FAKE_BASE}/images/models/${id}/endpoints`)).toHaveLength(1);
      expect(fetch.calls.filter((u) => u === `${FAKE_BASE}/models/${id}/endpoints`)).toHaveLength(1);
    }
    expect(fetch.calls).toHaveLength(1 + 2 * ids.length);
    expect(fetch.calls.some((u) => u.includes('krea'))).toBe(false); // not tracked
  });
});

describe('cadence (models.md §4.5): TTLs, single-flight, stale-while-error', () => {
  it('a second call within the TTL makes no fetch; uptime refreshes after 30 min, prices after 6 h', async () => {
    const { catalog, fetch, c } = setup();
    await catalog.rows();
    const first = fetch.calls.length;
    await catalog.rows();
    await catalog.model('nano-banana-2.1');
    expect(fetch.calls.length).toBe(first);
    c.advance(TTL_MS.uptime + 1);
    await catalog.rows();
    const afterUptime = fetch.calls.slice(first);
    expect(afterUptime.length).toBe(catalogIds().length);
    expect(afterUptime.every((u) => /\/models\/.+\/endpoints$/.test(u) && !u.includes('/images/'))).toBe(true);
    c.advance(TTL_MS.endpoints);
    const before = fetch.calls.length;
    await catalog.rows();
    expect(fetch.calls.slice(before).filter((u) => u.includes('/images/')).length).toBe(1 + catalogIds().length);
  });

  it('single-flight: concurrent requests share one refresh', async () => {
    const { catalog, fetch } = setup();
    await Promise.all([catalog.rows(), catalog.rows(), catalog.priceSources('user-a'), catalog.model('nano-banana-pro')]);
    expect(fetch.calls.filter((u) => u === `${FAKE_BASE}/images/models`)).toHaveLength(1);
    expect(fetch.calls.filter((u) => u.endsWith('/images/models/google/gemini-nano-banana-2.1/endpoints'))).toHaveLength(1);
  });

  it('a failed refresh serves the cache with stale: true (never a guessed number)', async () => {
    const { catalog, fetch, c } = setup();
    await catalog.rows();
    c.advance(TTL_MS.endpoints + 1);
    fetch.failing.all = true;
    const rows = await catalog.rows();
    const nb = row(rows, 'nano-banana-2.1');
    expect(nb.stale).toBe(true);
    expect(nb.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    expect(nb.fetchedAt.catalog).toBe('2026-10-22T17:51:00.000Z'); // "as of {time} · couldn't refresh"
    expect(nb.endpoints).toHaveLength(1);
    // A failure is not retried in a hot loop: the next request within a minute fetches nothing.
    const n = fetch.calls.length;
    await catalog.rows();
    expect(fetch.calls.length).toBe(n);
  });

  it('no cache and a failed fetch: registry facts "from our price list, {factsAsOf}", no uptime, stale', async () => {
    const fetch = fakeOpenRouterFetch();
    fetch.failing.all = true;
    const { catalog } = setup({ fetch });
    const nb = row(await catalog.rows(), 'nano-banana-2.1');
    expect(nb.price['1K']).toEqual({ usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22' });
    expect(nb.endpoints).toEqual([]);
    expect(nb.fetchedAt.catalog).toBeUndefined();
    expect(nb.fetchedAt.uptime).toBeUndefined();
    expect(nb.stale).toBe(true);
  });

  it('one id failing marks only its own row stale; after the retry wait only that id is fetched again', async () => {
    const fetch = fakeOpenRouterFetch();
    fetch.failing.match = ['/images/models/google/gemini-3-pro-image/endpoints'];
    const { catalog, c } = setup({ fetch });
    const rows = await catalog.rows();
    expect(row(rows, 'nano-banana-2.1').price['1K']!.basis).toBe('vendor_table');
    expect(row(rows, 'nano-banana-pro').price['1K']!.basis).toBe('registry');
    expect(row(rows, 'nano-banana-pro').stale).toBe(true);
    expect(rows.filter((r) => r.stale).map((r) => r.id)).toEqual(['nano-banana-pro']);
    // Within the retry wait nothing is fetched; after it, only the failed id (never every id again).
    c.advance(FAIL_RETRY_MS - 1_000);
    let before = fetch.calls.length;
    await catalog.rows();
    expect(fetch.calls.length).toBe(before);
    c.advance(2_000);
    before = fetch.calls.length;
    fetch.failing.match = [];
    const healed = await catalog.rows();
    expect(fetch.calls.slice(before)).toEqual([`${FAKE_BASE}/images/models/google/gemini-3-pro-image/endpoints`]);
    expect(row(healed, 'nano-banana-pro')).toMatchObject({ stale: false, price: { '1K': { usd: 0.1344, basis: 'vendor_table' } } });
    expect(row(healed, 'nano-banana-pro').fetchedAt.catalog).toBe(new Date(c.now()).toISOString());
    expect(row(healed, 'nano-banana-2.1').fetchedAt.catalog).toBe('2026-10-22T17:51:00.000Z'); // each id keeps its own time
  });

  it('an id that keeps failing backs off (60 s, 120 s, …) instead of costing a request a minute', async () => {
    const fetch = fakeOpenRouterFetch();
    fetch.failing.match = ['/images/models/google/gemini-3-pro-image/endpoints'];
    const { catalog, c } = setup({ fetch });
    await catalog.rows();
    const tries = () => fetch.calls.filter((u) => u.endsWith('/images/models/google/gemini-3-pro-image/endpoints')).length;
    expect(tries()).toBe(1);
    c.advance(FAIL_RETRY_MS + 1);
    await catalog.rows();
    expect(tries()).toBe(2);
    c.advance(FAIL_RETRY_MS + 1); // the second failure waits 2 × FAIL_RETRY_MS
    await catalog.rows();
    expect(tries()).toBe(2);
    c.advance(FAIL_RETRY_MS);
    await catalog.rows();
    expect(tries()).toBe(3);
  });

  it('an id OpenRouter does not know (404) is "no data" for its row only: nothing else is stale and nothing is refetched within the TTL', async () => {
    const fixture = loadOpenRouterFixture();
    delete fixture.imageEndpoints['meta/muse-image']; // a watch-list slug OpenRouter retired
    delete fixture.modelEndpoints['meta/muse-image'];
    delete fixture.imageEndpoints['google/gemini-3.1-flash-lite-image']; // a registry model whose images endpoint 404s
    const fetch = fakeOpenRouterFetch(fixture);
    const { catalog, c } = setup({ fetch });
    const rows = await catalog.rows();
    expect(rows.filter((r) => r.stale)).toEqual([]);
    const lite = row(rows, 'nano-banana-lite');
    expect(lite.price['1K']).toMatchObject({ basis: 'registry', note: expect.stringContaining('from our price list') });
    expect(lite.fetchedAt.catalog).toBeUndefined(); // a registry price never carries a fetch time
    expect(lite.endpoints.length).toBeGreaterThan(0); // its uptime endpoint still answered
    for (let i = 0; i < 3; i += 1) {
      c.advance(61_000);
      const before = fetch.calls.length;
      const again = await catalog.rows();
      expect(fetch.calls.length - before).toBe(0);
      expect(again.filter((r) => r.stale)).toEqual([]);
    }
  });

  it('a failing leaderboard refresh never marks prices stale (it has its own flag)', async () => {
    const failing: CatalogFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const { catalog } = setup({ quality: createQualitySource({ fetch: failing, now: () => FIXTURE_NOW }) });
    await catalog.rows();
    await new Promise((r) => setTimeout(r, 10)); // the background pull settles (failed)
    const rows = await catalog.rows();
    expect(rows.filter((r) => r.stale)).toEqual([]);
    expect(rows.every((r) => r.qualityStale === true)).toBe(true);
    expect(row(rows, 'nano-banana-2.1').quality.length).toBeGreaterThan(0); // the dated snapshot is still shown
  });

  it('an incomplete persisted cache and OpenRouter down: persisted rows keep their real time, never 1970', async () => {
    const store = memoryCatalogStore();
    const warm = createModelCatalog({ fetch: fakeOpenRouterFetch(), store, baseUrl: FAKE_BASE, now: () => FIXTURE_NOW, quality: createQualitySource({ fetch: null }) });
    await warm.rows();
    // An older deploy persisted fewer ids: drop two from the cache.
    store.cache.set(CACHE_SOURCE.endpoints, store.cache.get(CACHE_SOURCE.endpoints)!.filter((r) => r.modelId !== 'meta/muse-image' && r.modelId !== 'google/gemini-3-pro-image'));
    const down = fakeOpenRouterFetch();
    down.failing.all = true;
    for (const later of [10 * 60_000, TTL_MS.endpoints + 60_000]) {
      const cold = createModelCatalog({ fetch: down, store, baseUrl: FAKE_BASE, now: () => FIXTURE_NOW + later, quality: createQualitySource({ fetch: null }) });
      const rows = await cold.rows();
      expect(JSON.stringify(rows)).not.toContain('1970-');
      const nb = row(rows, 'nano-banana-2.1');
      expect(nb.fetchedAt.catalog).toBe('2026-10-22T17:51:00.000Z');
      expect(nb.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
      expect(nb.price['1K']!.note).not.toContain('1970');
      expect(nb.endpoints).toEqual([]); // uptime is memory-only and its fetch failed: "No uptime data right now"
      expect(nb.stale).toBe(true);
      const pro = row(rows, 'nano-banana-pro'); // not persisted and the fetch failed: the dated registry list
      expect(pro).toMatchObject({ stale: true, price: { '1K': { basis: 'registry' } } });
      expect(pro.fetchedAt.catalog).toBeUndefined();
    }
  });

  it('a slow source never holds a request past its budget: the answer comes from what is held, marked stale', async () => {
    const never: CatalogFetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const { catalog } = setup({ fetch: never, waits: { rowsMs: 20, priceMs: 20, fetchMs: 200 } });
    const t0 = Date.now();
    const rows = await catalog.rows();
    expect(Date.now() - t0).toBeLessThan(150);
    expect(row(rows, 'nano-banana-2.1')).toMatchObject({ stale: true, endpoints: [] });
    expect(row(rows, 'nano-banana-2.1').price['1K']!.basis).toBe('registry');
    const src = await catalog.priceSources('user-a');
    expect(src.rows.find((r) => r.id === 'nano-banana-2.1')!.stale).toBe(true);
  });

  it('a new process starts from the persisted cache (no fetch while it is fresh)', async () => {
    const { store, c } = setup();
    const warm = createModelCatalog({ fetch: fakeOpenRouterFetch(), store, baseUrl: FAKE_BASE, now: c.now, quality: createQualitySource({ fetch: null }) });
    await warm.rows();
    expect(store.cache.get(CACHE_SOURCE.endpoints)!.length).toBe(catalogIds().length);
    const fetch = fakeOpenRouterFetch();
    const cold = createModelCatalog({ fetch, store, baseUrl: FAKE_BASE, now: c.now, quality: createQualitySource({ fetch: null }) });
    const src = await cold.priceSources();
    expect(src.rows.find((r) => r.id === 'nano-banana-2.1')!.price['1K']).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    expect(fetch.calls.filter((u) => u.includes('/images/'))).toEqual([]);
  });
});

describe('price snapshots are written only when a price changes (T3)', () => {
  it('first fetch records every tracked price; an unchanged refresh writes nothing; a change writes one row', async () => {
    const fixture = loadOpenRouterFixture();
    const fetch = fakeOpenRouterFetch(fixture);
    const { catalog, store, c } = setup({ fetch });
    await catalog.rows();
    const initial = store.snapshots.length;
    expect(initial).toBeGreaterThan(0);
    expect(store.snapshots.find((s) => s.modelId === 'google/gemini-nano-banana-2.1' && s.res === '1K')).toMatchObject({ usd: 0.0336, basis: 'vendor_table' });
    c.advance(TTL_MS.endpoints + 1);
    await catalog.rows();
    expect(store.snapshots.length).toBe(initial);
    fixture.imageEndpoints['bytedance-seed/seedream-5-0-pro'].endpoints[0].pricing![0].cost_usd = 0.04;
    c.advance(TTL_MS.endpoints + 1);
    await catalog.rows();
    const added = store.snapshots.slice(initial);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ modelId: 'bytedance-seed/seedream-5-0-pro', res: '1K', usd: 0.04 });
    // A restarted process compares against the stored latest rows, not an empty memory.
    const again = createModelCatalog({ fetch, store, baseUrl: FAKE_BASE, now: () => c.now() + TTL_MS.endpoints + 1, quality: createQualitySource({ fetch: null }) });
    store.cache.clear();
    await again.rows();
    expect(store.snapshots.length).toBe(initial + 1);
    const detail = await again.model('seedream-5-pro');
    expect(detail!.priceHistory.filter((p) => p.res === '1K').map((p) => p.usd)).toEqual([0.045, 0.04]);
  });
});

describe('our own facts in the rows and trends (S7, AT-9)', () => {
  const NOW = FIXTURE_NOW;
  const mine = [0.0428, 0.0465, 0.0474, 0.0538].map((cost, i) => callRow({ at: NOW - (i + 1) * 60_000, providerCostUsd: cost }));
  const rateLimited = callRow({ at: NOW - 30_000, outcome: 'failed', httpStatus: 429, errorCode: 'RATE_LIMIT', providerCostUsd: 0 });

  it("rows carry the user's observed cost (n ≥ 3) and 24 h reliability; the price book uses them", async () => {
    const calls = memoryImageCalls([...mine, rateLimited]);
    const { catalog } = setup({ calls });
    const nb = row(await catalog.rows({ userId: 'user-a' }), 'nano-banana-2.1');
    expect(nb.observed).toEqual([expect.objectContaining({ kind: 'page', res: '1K', n: 4, medianUsd: 0.047, scope: 'you' })]);
    expect(nb.reliability).toEqual({ windowH: 24, calls: 5, failed: 1, rateLimited: 1, scope: 'you' });
    const other = row(await catalog.rows({ userId: 'someone-else' }), 'nano-banana-2.1');
    expect(other.observed).toEqual([]);
    expect(other.reliability).toBeUndefined();
    const src = await catalog.priceSources('user-a');
    expect(src.observed).toContainEqual(expect.objectContaining({ modelId: 'nano-banana-2.1', kind: 'page', res: '1K', n: 4 }));
  });

  it('the platform aggregate is hidden below 5 distinct users and shown from 5', async () => {
    const spread = (users: number) => Array.from({ length: users * 3 }, (_, i) => callRow({ at: NOW - (i + 1) * 60_000, userId: `u${i % users}`, kind: 'cover', res: '2K', providerCostUsd: 0.054 }));
    const four = setup({ calls: memoryImageCalls(spread(4)) }).catalog;
    const t4 = await four.trends('30d', { userId: 'viewer' });
    expect(t4.t7).toMatchObject({ available: false, copy: NOT_ENOUGH_DATA_COPY });
    expect(row(await four.rows({ userId: 'viewer' }), 'nano-banana-2.1').observed).toEqual([]);
    const five = setup({ calls: memoryImageCalls(spread(5)) }).catalog;
    const t5 = await five.trends('30d', { userId: 'viewer' });
    expect(t5.t7).toMatchObject({ available: true, models: [{ modelId: 'nano-banana-2.1', calls: 15, users: 5 }] });
    expect(row(await five.rows({ userId: 'viewer' }), 'nano-banana-2.1').observed).toEqual([expect.objectContaining({ kind: 'cover', res: '2K', scope: 'platform', n: 15 })]);
  });

  it('trends T2–T7 come only from data we hold, each with its source', async () => {
    const calls = memoryImageCalls([...mine, rateLimited], [{ month: '2026-10', product: 'comic_studio', source: 'openrouter', model: 'google/gemini-nano-banana-2.1', requests: 12 }]);
    const { catalog } = setup({ calls });
    const t = await catalog.trends('30d', { userId: 'user-a' });
    expect(t.range).toBe('30d');
    expect(t.t2.yours).toEqual([{ month: '2026-10', modelId: 'nano-banana-2.1', images: 4 }]);
    expect(t.t2.platform).toHaveLength(1);
    expect(t.t2.source.yours).toContain('comic_image_calls');
    expect(t.t3.trackingSince).toBe('2026-10-22T17:51:00.000Z');
    expect(t.t3.note).toBe('Tracking since 2026-10-22T17:51:00.000Z');
    // T4: real moves from the committed LMArena full-split history (one point per publish date), nothing invented.
    expect(t.t4.moves).toContainEqual({
      modelId: 'nano-banana-pro',
      board: 'lmarena_edit',
      from: { asOf: '2026-09-22', rank: 9, score: 1390.1, name: 'gemini-3-pro-image-2k (nano-banana-pro)' },
      to: { asOf: '2026-10-20', rank: 13, score: 1390.2, name: 'Gemini 3 Pro Image (nano-banana-pro, 2K)' },
      delta: -4
    });
    expect(t.t4.moves.every((m) => m.from.asOf >= '2026-09-22' && m.to.asOf > m.from.asOf && m.delta === (m.from.rank as number) - (m.to.rank as number))).toBe(true);
    expect(t.t4.trackingSince).toBe('2026-07-28');
    // T5: created in the last 30 days (Nano Banana 2.1 launched 2026-10-06).
    expect(t.t5.models.map((m) => m.id)).toContain('google/gemini-nano-banana-2.1');
    expect(t.t5.models.every((m) => Date.parse(m.created) >= FIXTURE_NOW - 30 * 86_400_000)).toBe(true);
    // T6: ours and OpenRouter's, separately labelled.
    expect(t.t6.ours).toContainEqual({ modelId: 'nano-banana-2.1', window: '24h', calls: 5, failed: 1, rateLimited: 1, scope: 'you' });
    expect(t.t6.openrouter.find((o) => o.modelId === 'nano-banana-2.1')!.uptime1d).toBeCloseTo(97.72, 2);
    expect(t.t6.source.openrouter).toContain('uptime_last_1d');
    expect(t.t7.available).toBe(false);
    const t90 = await catalog.trends('90d', { userId: 'user-a' });
    expect(t90.t5.models.length).toBeGreaterThanOrEqual(t.t5.models.length);
    // 90 days reaches back to the first point we hold: Nano Banana Pro on edit #5 (2026-07-28) → #13.
    expect(t90.t4.moves.find((m) => m.modelId === 'nano-banana-pro' && m.board === 'lmarena_edit')).toMatchObject({ from: { asOf: '2026-07-28', rank: 5 }, to: { rank: 13 }, delta: -8 });
  });

  it('a failing calls database degrades to "no data", never an error', async () => {
    const broken = { callsForUser: async () => Promise.reject(new Error('db down')), platformStats: async () => Promise.reject(new Error('db down')), monthlyUsage: async () => Promise.reject(new Error('db down')) };
    const { catalog } = setup({ calls: broken });
    const nb = row(await catalog.rows({ userId: 'user-a' }), 'nano-banana-2.1');
    expect(nb.observed).toEqual([]);
    expect((await catalog.trends('30d', { userId: 'user-a' })).t7.available).toBe(false);
  });
});

describe('model detail', () => {
  it('resolves registry and provider ids, adds the registry facts and history; unknown ids are null', async () => {
    const { catalog } = setup();
    const d = (await catalog.model('google/gemini-3-pro-image', { doc: makeLakeComic(), caps: paid }))!;
    expect(d.id).toBe('nano-banana-pro');
    expect(d.facts).toMatchObject({ factsAsOf: '2026-10-22', priceBasis: 'per_token_table', refs: { characters: 5 } });
    expect(d.fit).toBeDefined();
    expect(d.qualityHistory.some((p) => p.board === 'lmarena_edit' && p.rank === 13)).toBe(true);
    expect(d.priceHistory.length).toBeGreaterThan(0);
    expect(await catalog.model('nope')).toBeNull();
    const legacy = (await catalog.model('nano-banana-legacy'))!;
    expect(legacy.facts.replacement).toBe('nano-banana-2.1');
  });

  it('a model on no public board says so instead of a number', async () => {
    const { catalog } = setup({ quality: createQualitySource({ fetch: null, snapshot: { generatedAt: '2026-10-22', aliases: {}, boards: {}, history: {} } }) });
    const d = (await catalog.model('nano-banana-2.1'))!;
    expect(d.quality).toEqual([]);
    expect(d.qualityNote).toBe('Not ranked on public leaderboards yet');
  });
});
