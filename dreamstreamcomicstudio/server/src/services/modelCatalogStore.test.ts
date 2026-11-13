// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ rows: [] as any[], ranges: [] as [number, number][] }));
vi.mock('./supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({ from: () => {
    let from = 0, to = 499;
    const query: any = {
      select: () => query, order: () => query, eq: () => query,
      range: (a: number, b: number) => { from = a; to = b; fixture.ranges.push([a, b]); return query; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: fixture.rows.slice(from, to + 1), error: null }).then(resolve)
    };
    return query;
  } })
}));
import { loadPersistedModels } from './modelCatalogStore.js';
beforeEach(() => { fixture.rows = []; fixture.ranges = []; });
describe('durable catalog snapshots', () => {
  it('loads beyond the API page limit without retiring models discovered through another key', async () => {
    fixture.rows = Array.from({ length: 1101 }, (_, i) => ({ source: 'openrouter', payload: { id: `model-${i}` }, last_seen_at: '2026-11-13T12:00:00Z', api_callable: true }));
    fixture.rows.push({ source: 'openrouter', payload: { id: 'earlier-key-model' }, last_seen_at: '2026-11-12T12:00:00Z', api_callable: true });
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
});
