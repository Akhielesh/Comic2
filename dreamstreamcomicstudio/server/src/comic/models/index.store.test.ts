// @vitest-environment node
// The Supabase persistence behind the catalog writes only its own comic_-prefixed tables and the shared cache.
// public.model_pricing_snapshots is token billing's live price table (token_billing_foundation.sql): a catalog
// row there would be read as a live billing price, and the catalog's SQL must never alter or revoke on it.
// The Supabase client is a recording fake; nothing touches a database.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const touched: { table: string; op: string }[] = [];

const chain = (table: string) => {
  const result = { data: [] as unknown[], error: null };
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'abortSignal']) q[m] = () => q;
  for (const op of ['insert', 'upsert', 'update', 'delete']) {
    q[op] = () => {
      touched.push({ table, op });
      return q;
    };
  }
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
};

vi.mock('../../services/supabase.js', () => ({
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      touched.push({ table, op: 'from' });
      return chain(table);
    },
    rpc: () => chain('rpc')
  })
}));

describe('catalog persistence never touches the billing table', () => {
  it('every store method reads and writes only model_catalog_cache and the comic_ catalog tables', async () => {
    const { CATALOG_TABLES, createSupabaseCatalogStore } = await import('./index.js');
    expect(Object.values(CATALOG_TABLES)).not.toContain('model_pricing_snapshots');
    const store = createSupabaseCatalogStore()!;
    expect(store).not.toBeNull();
    const at = '2026-10-22T17:51:00.000Z';
    await store.loadCache('openrouter_images_endpoints');
    await store.saveCache('openrouter_images_endpoints', [{ modelId: 'google/gemini-nano-banana-2.1', payload: { endpoints: [] }, fetchedAt: at }]);
    await store.latestPriceSnapshots();
    await store.insertPriceSnapshots([{ modelId: 'google/gemini-nano-banana-2.1', res: '1K', usd: 0.0336, basis: 'vendor_table', fetchedAt: at }]);
    await store.priceSnapshotsSince(at);
    await store.firstPriceSnapshotAt();
    await store.logUptime([{ modelId: 'google/gemini-nano-banana-2.1', provider: 'Google AI Studio', day: '2026-10-22', uptime1d: 97.7, uptime30m: null, fetchedAt: at }]);
    await store.uptimeSince(at);
    const tables = new Set(touched.map((t) => t.table));
    expect([...tables].sort()).toEqual(['comic_model_price_changes', 'comic_model_uptime_daily', 'model_catalog_cache']);
    expect(touched.filter((t) => t.op === 'insert').map((t) => t.table)).toEqual(['comic_model_price_changes']);
  });

  it('the catalog SQL creates its comic_ tables and has no statement on model_pricing_snapshots', () => {
    const sql = readFileSync(new URL('../../../sql/comic_model_catalog.sql', import.meta.url), 'utf8');
    const statements = sql.replace(/--[^\n]*/g, '');
    expect(statements).not.toMatch(/model_pricing_snapshots/);
    expect(statements).toMatch(/create table if not exists public\.comic_model_price_changes\s*\(/);
    expect(statements).toMatch(/create table if not exists public\.comic_model_uptime_daily\s*\(/);
  });
});
