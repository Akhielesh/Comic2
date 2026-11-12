import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Controllable upstream model list — flipped per test to simulate a healthy vs empty fetch.
let raw: any[] = [];
// EGRESS-DB E4: the live list can be held (a slow upstream) or fail.
const upstream = vi.hoisted(() => ({ gate: null as Promise<void> | null, fail: false, calls: 0 }));
const store = vi.hoisted(() => ({
  persistHarvestedModels: vi.fn(async () => {}),
  loadPersistedModels: vi.fn(async (): Promise<any[]> => [])
}));
const supabase = vi.hoisted(() => ({ upserts: 0, enabled: true }));

vi.mock('../ai/gateway.js', () => ({
  getProvider: () => ({
    id: 'openrouter',
    listModels: async () => {
      upstream.calls += 1;
      if (upstream.gate) await upstream.gate;
      if (upstream.fail) throw new Error('upstream down');
      return raw;
    }
  }),
  resolveProviderContext: () => ({ apiKey: '', byok: false })
}));
vi.mock('../ai/catalogAnnotations.js', () => ({ annotateModels: (m: any[]) => m }));
vi.mock('./modelCatalogStore.js', () => store);
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: supabase.enabled }),
  getSupabaseAdmin: () => ({
    from: () => ({
      upsert: async () => {
        supabase.upserts += 1;
        return { error: null };
      }
    })
  })
}));

import { getCatalog } from './modelCatalog.js';
import { persistHarvestedModels } from './modelCatalogStore.js';

describe('catalog resilience (OpenRouter outage regression)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the last-good catalog and does NOT persist when a refresh returns empty', async () => {
    // 1. Healthy fetch populates + persists the catalog.
    raw = [{ id: 'a/one', source: 'openrouter' }, { id: 'a/two', source: 'openrouter' }];
    const good = await getCatalog(true);
    expect(good.models).toHaveLength(2);
    expect(good.degraded).toBe(false);
    expect(persistHarvestedModels).toHaveBeenCalledTimes(1);
    vi.mocked(persistHarvestedModels).mockClear();

    // 2. A transient empty result must NOT wipe the in-memory cache or the durable index.
    raw = [];
    const after = await getCatalog(true);
    expect(after.models).toHaveLength(2); // last-good retained, not []
    expect(after.degraded).toBe(true); // surfaced honestly as degraded
    expect(persistHarvestedModels).not.toHaveBeenCalled(); // never persisted the empty list
  });
});

// EGRESS-DB E4: the boot warm-up reads the live (public, anonymous) list first; the ~0.9 MB Supabase index is read
// only when the live list fails or is slow, once, and a request during the warm-up never reads it again.
describe('boot warm-up', () => {
  const LIVE = [{ id: 'live/one', source: 'openrouter' }, { id: 'live/two', source: 'openrouter' }];
  const PERSISTED = [{ id: 'persisted/one', source: 'openrouter' }];
  /** A fresh module: no cache, no warm-up yet (as on a container boot). */
  const boot = async () => {
    vi.resetModules();
    return import('./modelCatalog.js');
  };
  const reads = () => store.loadPersistedModels.mock.calls.length;

  beforeEach(() => {
    vi.clearAllMocks();
    raw = LIVE;
    upstream.gate = null;
    upstream.fail = false;
    upstream.calls = 0;
    store.loadPersistedModels.mockResolvedValue(PERSISTED);
  });
  afterEach(() => vi.useRealTimers());

  it('makes no store read when the live refresh succeeds', async () => {
    const catalog = await boot();
    await catalog.prewarmCatalog();
    expect(reads()).toBe(0);
    const result = await catalog.getCatalog();
    expect(result.models.map((m) => m.id)).toEqual(['live/one', 'live/two']);
    expect(result.degraded).toBe(false);
    expect(reads()).toBe(0);
    expect(upstream.calls).toBe(1);
  });

  it('makes exactly one store read when the live refresh fails, and serves it', async () => {
    upstream.fail = true;
    const catalog = await boot();
    await catalog.prewarmCatalog();
    expect(reads()).toBe(1);
    expect(store.loadPersistedModels).toHaveBeenCalledWith('openrouter');
    const result = await catalog.getCatalog();
    expect(result.models.map((m) => m.id)).toEqual(['persisted/one']);
    expect(reads()).toBe(1);
  });

  it('a request during the warm-up waits for it and makes no second read', async () => {
    let release!: () => void;
    upstream.gate = new Promise<void>((resolve) => { release = resolve; });
    const catalog = await boot();
    const warming = catalog.prewarmCatalog();
    const request = catalog.getCatalog();
    await Promise.resolve();
    expect(reads()).toBe(0);
    release();
    const [result] = await Promise.all([request, warming]);
    expect(result.models.map((m) => m.id)).toEqual(['live/one', 'live/two']);
    expect(reads()).toBe(0);
    expect(upstream.calls).toBe(1);
  });

  it('a slow live list falls back to one read after the budget, then the live list replaces it', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    upstream.gate = new Promise<void>((resolve) => { release = resolve; });
    const catalog = await boot();
    const warming = catalog.prewarmCatalog();
    const request = catalog.getCatalog();
    await vi.advanceTimersByTimeAsync(catalog.PREWARM_LIVE_BUDGET_MS - 1);
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await warming;
    expect(reads()).toBe(1);
    expect((await request).models.map((m) => m.id)).toEqual(['persisted/one']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await catalog.getCatalog()).models.map((m) => m.id)).toEqual(['live/one', 'live/two']);
    expect(reads()).toBe(1);
    expect(upstream.calls).toBe(1);
  });

  it('prewarm is one shared warm-up per process', async () => {
    const catalog = await boot();
    await Promise.all([catalog.prewarmCatalog(), catalog.prewarmCatalog()]);
    await catalog.prewarmCatalog();
    expect(upstream.calls).toBe(1);
  });
});

// EGRESS-DB E4: an unchanged list is not upserted again within 6 hours (the real store, a fake Supabase client).
describe('persistHarvestedModels skips an unchanged list', () => {
  const model = (id: string, prompt = 0.000001) => ({
    id,
    source: 'openrouter',
    contextLength: 8192,
    inputModalities: ['text'],
    outputModalities: ['text'],
    pricing: { promptPerToken: prompt, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
    name: id
  });

  beforeEach(() => {
    supabase.upserts = 0;
    supabase.enabled = true;
  });
  afterEach(() => vi.useRealTimers());

  it('upserts once for an identical list (in any order), again when it changes or after 6 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    const real = await vi.importActual<typeof import('./modelCatalogStore.js')>('./modelCatalogStore.js');
    real.resetPersistMemo();
    const list = [model('a/one'), model('a/two')] as any[];
    await real.persistHarvestedModels('openrouter', list);
    await real.persistHarvestedModels('openrouter', [...list].reverse());
    await real.persistHarvestedModels('openrouter', list.map((m) => ({ ...m, description: 'only the blurb changed' })));
    expect(supabase.upserts).toBe(1);
    // Another source has its own memo.
    await real.persistHarvestedModels('nvidia', list);
    expect(supabase.upserts).toBe(2);
    // A price change is persisted at once.
    await real.persistHarvestedModels('openrouter', [model('a/one', 0.000002), model('a/two')] as any[]);
    expect(supabase.upserts).toBe(3);
    // The same list again, 6 hours later, refreshes last_seen_at.
    vi.setSystemTime(new Date('2026-11-12T06:00:00Z'));
    await real.persistHarvestedModels('openrouter', [model('a/one', 0.000002), model('a/two')] as any[]);
    expect(supabase.upserts).toBe(4);
    expect(real.catalogContentHash(list)).toBe(real.catalogContentHash([...list].reverse()));
  });
});
