import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable upstream model list — flipped per test to simulate a healthy vs empty fetch.
let raw: any[] = [];

vi.mock('../ai/gateway.js', () => ({
  getProvider: () => ({ listModels: async () => raw }),
  resolveProviderContext: () => ({ apiKey: '', byok: false })
}));
vi.mock('../ai/catalogAnnotations.js', () => ({ annotateModels: (m: any[]) => m }));
vi.mock('./modelCatalogStore.js', () => ({
  persistHarvestedModels: vi.fn(async () => {}),
  loadPersistedModels: vi.fn(async () => [])
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
