// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ rows: [] as any[], ranges: [] as [number, number][], error: null as unknown, writes: 0 }));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({ from: () => {
    let from = 0, to = 499;
    const query: any = {
      select: () => query, order: () => query, eq: () => query,
      upsert: async () => { fixture.writes++; return { error: fixture.error }; },
      update: () => { fixture.writes++; return query; },
      range: (a: number, b: number) => { from = a; to = b; fixture.ranges.push([a, b]); return query; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: fixture.rows.slice(from, to + 1), error: fixture.error }).then(resolve)
    };
    return query;
  } })
}));
import { loadPersistedModels, loadCallabilityMap, persistHarvestedModels, persistCallability, resetPersistMemo, CALLABILITY_TTL_MS } from './modelCatalogStore.js';
beforeEach(() => { fixture.rows = []; fixture.ranges = []; fixture.error = null; fixture.writes = 0; resetPersistMemo(); });
describe('durable catalog snapshots', () => {
  it('loads beyond the API page limit without retiring models discovered through another key', async () => {
    fixture.rows = Array.from({ length: 1101 }, (_, i) => ({ source: 'openrouter', payload: { id: `model-${i}` }, last_seen_at: '2026-11-13T12:00:00Z', api_callable: true, api_callable_checked_at: new Date().toISOString() }));
    fixture.rows.push({ source: 'openrouter', payload: { id: 'earlier-key-model' }, last_seen_at: '2026-11-12T12:00:00Z', api_callable: true, api_callable_checked_at: new Date().toISOString() });
    const models = await loadPersistedModels('openrouter');
    expect(models).toHaveLength(1102);
    expect(models.find((m) => m.id === 'earlier-key-model')?.catalogCheckedAt).toBe(Date.parse('2026-11-12T12:00:00Z'));
    expect(models.every((m) => m.catalogOrigin === 'cached' && m.apiCallable === true)).toBe(true);
    expect(fixture.ranges).toEqual([[0, 499], [500, 999], [1000, 1499]]);
  });
  it('preserves per-row observation times across sources and tolerates legacy rows', async () => {
    fixture.rows = [
      { source: 'openrouter', payload: { id: 'or-current' }, last_seen_at: '2026-11-13T12:00:00Z' },
      { source: 'nvidia', payload: { id: 'nv-current' }, last_seen_at: '2026-11-12T12:00:00Z' },
      { source: 'nvidia', payload: { id: 'nv-old' }, last_seen_at: '2026-11-10T12:00:00Z' },
      { source: 'nvidia', payload: { id: 'nv-legacy' }, last_seen_at: 'invalid' }
    ];
    const models = await loadPersistedModels();
    expect(models.map((m) => m.id)).toEqual(['or-current', 'nv-current', 'nv-old', 'nv-legacy']);
    expect(models[2].catalogCheckedAt).toBe(Date.parse('2026-11-10T12:00:00Z'));
    expect(models[3].catalogCheckedAt).toBeUndefined();
  });
  it('strict maintenance persists an unchanged observation and surfaces database write errors', async () => {
    const models = [{ id: 'current' }] as any;
    await persistHarvestedModels('nvidia', models);
    await persistHarvestedModels('nvidia', models);
    expect(fixture.writes).toBe(1);
    await persistHarvestedModels('nvidia', models, { strict: true, force: true });
    expect(fixture.writes).toBe(2);
    fixture.error = { message: 'private database detail' };
    await expect(persistHarvestedModels('nvidia', models, { strict: true, force: true })).rejects.toThrow('CATALOG_PERSIST_FAILED');
    await expect(persistCallability('nvidia', [{ modelId: 'current', callable: true }], { strict: true })).rejects.toThrow('CATALOG_PERSIST_FAILED');
  });
  it('keeps discovery freshness independent of old, missing, or future probe evidence', async () => {
    const now = Date.now();
    fixture.rows = [null, new Date(now - CALLABILITY_TTL_MS - 1).toISOString(), new Date(now + 60_000).toISOString(), new Date(now - 60_000).toISOString()]
      .map((probeAt, index) => ({ source: 'nvidia', model_id: `nv-${index}`, payload: { id: `nv-${index}`, apiCallable: true, apiCallableCheckedAt: now },
        last_seen_at: new Date(now).toISOString(), api_callable: false, api_callable_checked_at: probeAt }));
    const models = await loadPersistedModels('nvidia');
    expect(models.slice(0, 3).every((model) => model.apiCallable === undefined && model.apiCallableCheckedAt === undefined)).toBe(true);
    expect(models[3].apiCallable).toBe(false);
    expect(models[0].catalogCheckedAt).toBe(now);
    expect([...await loadCallabilityMap('nvidia')]).toEqual([['nv-3', false]]);
  });
  it('strict probes require the matching cache row to have actually been updated', async () => {
    await expect(persistCallability('nvidia', [{ modelId: 'new-model', callable: true }], { strict: true })).rejects.toThrow('CATALOG_PERSIST_FAILED');
    fixture.rows = [{ model_id: 'different-model' }];
    await expect(persistCallability('nvidia', [{ modelId: 'new-model', callable: true }], { strict: true })).rejects.toThrow('CATALOG_PERSIST_FAILED');
    fixture.rows = [{ model_id: 'new-model' }];
    await expect(persistCallability('nvidia', [{ modelId: 'new-model', callable: true }], { strict: true })).resolves.toBeUndefined();
  });
});
