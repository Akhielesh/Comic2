// Model catalog — public surface (models.md §4.3–§4.6, §2.3; M1-CATALOG).
//
//   createPriceBook(deps)      the server PriceBook (shared/comic/modelLock.ts contract) for one user: live
//                              OpenRouter prices (bounded wait), that user's observed costs, observed QC. It
//                              never throws: with no data at all it quotes the registry's dated price list.
//   modelCatalog()             the process catalog (lazy: nothing is built, fetched or scheduled at import)
//   createSupabaseCatalogStore / createSupabaseImageCallsDb   the persistence behind it (service role)
//
// Tables (server/sql/comic_model_catalog.sql, server/sql/comic_image_calls.sql): model_catalog_cache (existing;
// sources 'openrouter_images' and 'openrouter_images_endpoints'), model_pricing_snapshots, model_uptime_daily,
// comic_image_calls and the security-definer comic_image_model_stats(p_since). Every read is bounded and every
// failure degrades to "no data" — the catalog then shows the §4.6 copy instead of a number.

import type { Resolution } from '../../../../shared/comic/doc.js';
import { logger } from '../../lib/logger.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../../services/supabase.js';
import {
  createModelCatalog,
  type CachedPayload,
  type CatalogStore,
  type ImageCallsDb,
  type ModelCatalog,
  type PriceBasis,
  type PriceSnapshotRow,
  type UptimeLogRow
} from './catalog.js';
import type { ImageCallRow, MonthlyUsageRow, PlatformStatRow } from './observed.js';
import { priceBookFromSources, type PriceBookSources, type ServerPriceBook } from './pricing.js';
import { createQualitySource } from './quality.js';

export * from './catalog.js';
export * from './observed.js';
export * from './pricing.js';
export * from './quality.js';

/** Upper bound for one database read on a request path. */
export const DB_READ_TIMEOUT_MS = 5_000;
const SNAPSHOT_READ_LIMIT = 2_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const RESOLUTIONS = new Set(['512', '1K', '2K', '4K']);
const BASES = new Set<PriceBasis>(['openrouter_endpoint', 'vendor_table', 'derived_mp', 'registry']);
const timeout = () => AbortSignal.timeout(DB_READ_TIMEOUT_MS); // per call, never at import

const storageReady = () => getSupabaseCapabilityStatus().storagePersistenceEnabled;

const snapshotFromDb = (r: Record<string, unknown>): PriceSnapshotRow | null => {
  const res = str(r.res);
  const basis = str(r.basis) as PriceBasis | null;
  const modelId = str(r.model_id);
  const fetchedAt = str(r.fetched_at);
  if (!modelId || !res || !RESOLUTIONS.has(res) || !basis || !BASES.has(basis) || !fetchedAt) return null;
  return { modelId, res: res as Resolution, usd: num(r.usd), basis, note: str(r.note), provider: str(r.provider), fetchedAt: new Date(fetchedAt).toISOString() };
};

/** The catalog's persistence on Supabase (service role; RLS on, no client policies). Null when storage is off. */
export const createSupabaseCatalogStore = (): CatalogStore | null => {
  if (!storageReady()) return null;
  const db = () => getSupabaseAdmin();
  return {
    async loadCache(source) {
      const { data, error } = await db().from('model_catalog_cache').select('model_id, payload, last_seen_at').eq('source', source).abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (data ?? [])
        .map((r: Record<string, unknown>): CachedPayload | null => (str(r.model_id) && str(r.last_seen_at) ? { modelId: r.model_id as string, payload: r.payload, fetchedAt: r.last_seen_at as string } : null))
        .filter((r): r is CachedPayload => !!r);
    },
    async saveCache(source, rows) {
      if (!rows.length) return;
      const { error } = await db()
        .from('model_catalog_cache')
        .upsert(
          rows.map((r) => ({ source, model_id: r.modelId, payload: r.payload, supports_image_output: true, is_free: false, last_seen_at: r.fetchedAt })),
          { onConflict: 'source,model_id' }
        );
      if (error) throw new Error(error.message);
    },
    async latestPriceSnapshots() {
      // Change-only rows are few (one per price change); the newest per (model, res) wins.
      const { data, error } = await db().from('model_pricing_snapshots').select('model_id, res, usd, basis, note, provider, fetched_at').order('fetched_at', { ascending: false }).limit(SNAPSHOT_READ_LIMIT).abortSignal(timeout());
      if (error) throw new Error(error.message);
      const latest = new Map<string, PriceSnapshotRow>();
      for (const raw of data ?? []) {
        const r = snapshotFromDb(raw as Record<string, unknown>);
        if (r && !latest.has(`${r.modelId}|${r.res}`)) latest.set(`${r.modelId}|${r.res}`, r);
      }
      return [...latest.values()];
    },
    async insertPriceSnapshots(rows) {
      if (!rows.length) return;
      const { error } = await db()
        .from('model_pricing_snapshots')
        .insert(rows.map((r) => ({ model_id: r.modelId, res: r.res, usd: r.usd, basis: r.basis, note: r.note ? r.note.slice(0, 500) : null, provider: r.provider ?? null, fetched_at: r.fetchedAt })));
      if (error) throw new Error(error.message);
    },
    async priceSnapshotsSince(sinceIso) {
      const { data, error } = await db().from('model_pricing_snapshots').select('model_id, res, usd, basis, note, provider, fetched_at').gte('fetched_at', sinceIso).order('fetched_at', { ascending: true }).limit(SNAPSHOT_READ_LIMIT).abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => snapshotFromDb(r as Record<string, unknown>)).filter((r): r is PriceSnapshotRow => !!r);
    },
    async firstPriceSnapshotAt() {
      const { data, error } = await db().from('model_pricing_snapshots').select('fetched_at').order('fetched_at', { ascending: true }).limit(1).abortSignal(timeout());
      if (error) throw new Error(error.message);
      const at = str((data?.[0] as Record<string, unknown> | undefined)?.fetched_at);
      return at ? new Date(at).toISOString() : null;
    },
    async logUptime(rows) {
      if (!rows.length) return;
      const { error } = await db()
        .from('model_uptime_daily')
        .upsert(
          rows.map((r) => ({ model_id: r.modelId, provider: r.provider.slice(0, 120), day: r.day, uptime_1d: r.uptime1d, uptime_30m: r.uptime30m, fetched_at: r.fetchedAt })),
          { onConflict: 'model_id,provider,day' }
        );
      if (error) throw new Error(error.message);
    },
    async uptimeSince(sinceIso) {
      const { data, error } = await db().from('model_uptime_daily').select('model_id, provider, day, uptime_1d, uptime_30m, fetched_at').gte('day', sinceIso.slice(0, 10)).order('day', { ascending: true }).limit(SNAPSHOT_READ_LIMIT).abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (data ?? [])
        .map((r: Record<string, unknown>): UptimeLogRow | null =>
          str(r.model_id) && str(r.provider) && str(r.day) && str(r.fetched_at)
            ? { modelId: r.model_id as string, provider: r.provider as string, day: String(r.day).slice(0, 10), uptime1d: num(r.uptime_1d), uptime30m: num(r.uptime_30m), fetchedAt: new Date(r.fetched_at as string).toISOString() }
            : null
        )
        .filter((r): r is UptimeLogRow => !!r);
    }
  };
};

const OUTCOMES = new Set(['ok', 'failed', 'blocked']);

/** A comic_image_calls row from the database (snake_case) → the camelCase row observed.ts reads. */
export const imageCallFromDb = (r: Record<string, unknown>): ImageCallRow | null => {
  const modelId = str(r.model_id);
  const createdAt = str(r.created_at);
  const outcome = str(r.outcome);
  if (!modelId || !createdAt || !outcome || !OUTCOMES.has(outcome)) return null;
  return {
    modelId,
    kind: str(r.kind) ?? 'unknown',
    res: str(r.res),
    outcome: outcome as ImageCallRow['outcome'],
    httpStatus: num(r.http_status),
    errorCode: str(r.error_code),
    providerCostUsd: num(r.provider_cost_usd),
    createdAt: new Date(createdAt).toISOString()
  };
};

/** A comic_image_model_stats(p_since) row → PlatformStatRow (the function already dropped < 5-user groups). */
export const platformStatFromDb = (r: Record<string, unknown>): PlatformStatRow | null => {
  const modelId = str(r.model_id);
  if (!modelId) return null;
  return {
    modelId,
    kind: str(r.kind) ?? 'unknown',
    res: str(r.res),
    calls: num(r.calls) ?? 0,
    ok: num(r.ok) ?? 0,
    failed: num(r.failed) ?? 0,
    rateLimited: num(r.rate_limited) ?? 0,
    distinctUsers: num(r.distinct_users) ?? 0,
    medianCostUsd: num(r.median_cost_usd),
    minCostUsd: num(r.min_cost_usd),
    maxCostUsd: num(r.max_cost_usd),
    firstAt: str(r.first_at),
    lastAt: str(r.last_at)
  };
};

/** comic_image_calls reads (service role, always filtered to the asking user) + the platform aggregate RPC. */
export const createSupabaseImageCallsDb = (): ImageCallsDb | null => {
  if (!storageReady()) return null;
  const db = () => getSupabaseAdmin();
  return {
    async callsForUser(userId, opts) {
      const { data, error } = await db()
        .from('comic_image_calls')
        .select('model_id, kind, res, outcome, http_status, error_code, provider_cost_usd, created_at')
        .eq('user_id', userId)
        .gte('created_at', opts.sinceIso)
        .order('created_at', { ascending: false })
        .limit(opts.limit)
        .abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => imageCallFromDb(r as Record<string, unknown>)).filter((r): r is ImageCallRow => !!r);
    },
    async platformStats(sinceIso) {
      const { data, error } = await db().rpc('comic_image_model_stats', { p_since: sinceIso }).abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data : []).map((r) => platformStatFromDb(r as Record<string, unknown>)).filter((r): r is PlatformStatRow => !!r);
    },
    async monthlyUsage(product, sinceMonth) {
      const { data, error } = await db().from('model_usage_monthly').select('month, product, source, model, requests').eq('product', product).gte('month', sinceMonth).limit(SNAPSHOT_READ_LIMIT).abortSignal(timeout());
      if (error) throw new Error(error.message);
      return (data ?? [])
        .map((r: Record<string, unknown>): MonthlyUsageRow | null =>
          str(r.month) && str(r.model) ? { month: r.month as string, product: String(r.product), source: String(r.source ?? ''), model: r.model as string, requests: num(r.requests) ?? 0 } : null
        )
        .filter((r): r is MonthlyUsageRow => !!r);
    }
  };
};

// ── The process catalog (lazy) ───────────────────────────────────────────────

let processCatalog: ModelCatalog | null = null;

/** The one catalog per process. Built on first use — importing this module builds, fetches and schedules nothing. */
export const modelCatalog = (): ModelCatalog => {
  if (!processCatalog) {
    const fetchImpl = typeof globalThis.fetch === 'function' ? (globalThis.fetch.bind(globalThis) as unknown as import('./catalog.js').CatalogFetch) : undefined;
    processCatalog = createModelCatalog({
      fetch: fetchImpl,
      store: createSupabaseCatalogStore(),
      calls: createSupabaseImageCallsDb(),
      quality: createQualitySource({ fetch: fetchImpl ?? null })
    });
  }
  return processCatalog;
};

/** Tests and the lead's wiring may swap the process catalog (null = rebuild lazily on next use). */
export const setModelCatalog = (catalog: ModelCatalog | null): void => {
  processCatalog = catalog;
};

// ── PriceBook ────────────────────────────────────────────────────────────────

export interface PriceBookDeps {
  /** The user whose observed costs count (their own calls; the platform aggregate only at ≥ 5 users). */
  userId?: string;
  /** Default: the process catalog. */
  catalog?: ModelCatalog;
  /** Pre-loaded sources (tests, or a caller that already holds them): no I/O at all. */
  sources?: PriceBookSources;
  /** How long to wait for a price refresh before quoting from cache / the registry (default PRICE_WAIT_MS). */
  maxWaitMs?: number;
}

/** A PriceBook from the registry's dated price list only (no I/O): quotes say "price list from {factsAsOf}". */
export const registryPriceBook = (): ServerPriceBook => priceBookFromSources({ rows: [] });

/**
 * The server PriceBook for one user (models.md §2.3), implementing shared/comic/modelLock.ts `PriceBook`
 * (`unit`, `qcUsd`) plus `quote` (the full basis) and `jobQuote` (QC + markup unless BYOK). Async because
 * it loads that user's observed costs; never throws — on any failure it falls back to the registry book.
 */
export const createPriceBook = async (deps: PriceBookDeps = {}): Promise<ServerPriceBook> => {
  if (deps.sources) return priceBookFromSources(deps.sources);
  try {
    const sources = await (deps.catalog ?? modelCatalog()).priceSources(deps.userId, deps.maxWaitMs !== undefined ? { maxWaitMs: deps.maxWaitMs } : {});
    return priceBookFromSources(sources);
  } catch (err) {
    logger.warn('comic_price_book_fallback', { message: (err as Error)?.message });
    return registryPriceBook();
  }
};
