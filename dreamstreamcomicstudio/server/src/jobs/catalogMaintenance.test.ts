// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ enabled: true, models: vi.fn(), persist: vi.fn(), callability: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: deps.enabled }) }));
vi.mock('../services/modelCatalog.js', () => ({ getProviderModels: deps.models }));
vi.mock('../services/modelCatalogStore.js', () => ({ persistHarvestedModels: deps.persist, persistCallability: deps.callability }));
import { refreshModelCatalog } from './refreshModelCatalog.js';
import { probeNvidiaAvailability } from './probeNvidiaAvailability.js';
import { PROVIDERS_ORDERED } from '../../../shared/providers.js';

beforeEach(() => {
  vi.resetAllMocks(); deps.enabled = true;
  for (const provider of PROVIDERS_ORDERED) vi.stubEnv(provider.keyEnv, '');
  deps.models.mockImplementation(async (source: string) => [{ id: `${source}/current`, catalogOrigin: 'live' }]);
  deps.persist.mockResolvedValue(undefined); deps.callability.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('scheduled catalog jobs', () => {
  it('refreshes both public sources anonymously and awaits strict durable writes', async () => {
    const results = await refreshModelCatalog();
    expect(results.filter((result) => result.status === 'refreshed').map((result) => result.source)).toEqual(['openrouter', 'nvidia']);
    expect(deps.models.mock.calls).toEqual([['openrouter', null], ['nvidia', null]]);
    expect(deps.persist).toHaveBeenCalledWith('nvidia', [{ id: 'nvidia/current', catalogOrigin: 'live' }], { strict: true, force: true });
    expect(results.filter((result) => result.status === 'unconfigured')).toHaveLength(PROVIDERS_ORDERED.length - 2);
  });
  it('never reports a cached or curated fallback as a refresh', async () => {
    deps.models.mockResolvedValue([{ id: 'old', catalogOrigin: 'cached' }]);
    const results = await refreshModelCatalog();
    expect(results.filter((result) => result.status === 'unavailable')).toHaveLength(2);
    expect(deps.persist).not.toHaveBeenCalled();
  });
  it('surfaces storage failures instead of reporting freshness', async () => {
    deps.persist.mockRejectedValue(new Error('CATALOG_PERSIST_FAILED'));
    await expect(refreshModelCatalog()).rejects.toThrow('CATALOG_PERSIST_FAILED');
    deps.enabled = false;
    await expect(refreshModelCatalog()).rejects.toThrow('CATALOG_STORAGE_UNAVAILABLE');
  });
  it('does not call a provider or claim a successful probe when the account key is missing', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(probeNvidiaAvailability()).rejects.toThrow('NVIDIA_API_KEY_MISSING');
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.callability).not.toHaveBeenCalled();
  });
  it('rejects failed/empty listings and does not turn validation errors into callable claims', async () => {
    vi.stubEnv('NVIDIA_API_KEY', 'test-only-key');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(probeNvidiaAvailability()).rejects.toThrow('NVIDIA_LIST_UNAVAILABLE');
    fetcher.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(probeNvidiaAvailability()).rejects.toThrow('NVIDIA_LIST_EMPTY');
    fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'test/model' }] })).mockResolvedValueOnce(new Response('{}', { status: 422 }));
    await expect(probeNvidiaAvailability()).rejects.toThrow('NVIDIA_PROBE_UNAVAILABLE');
    expect(deps.callability).toHaveBeenLastCalledWith('nvidia', [], { strict: true });
  });
});
