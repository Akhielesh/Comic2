// Model catalog data layer (models.md §4.3 ModelCatalogRow, §4.4 trends T2–T7, §4.5 S1–S3 + S5–S7, §4.6 copy).
//
// Sources, all documented and fetched ON DEMAND — a request has to ask; nothing here schedules a timer at import
// (a test enforces it) so a sleeping container is never woken:
//   S1 GET /api/v1/images/models                 list, parameters, `created`      6 h TTL
//   S2 GET /api/v1/images/models/{id}/endpoints  per-endpoint pricing             6 h TTL, registry + watch-list ids only
//   S3 GET /api/v1/models/{id}/endpoints         providers, uptime_last_1d/30m    30 min TTL
//   S5 LMArena snapshot (quality.ts)             24 h TTL
//   S7 comic_image_calls (observed.ts)           live on open
// Each source is single-flight, cached in memory and (S1/S2) in the DB, and stale-while-error: a failed refresh
// serves the last good value with `stale: true` ("as of {time} · couldn't refresh"); with no cache at all the
// row falls back to the registry's dated price list ("from our price list, {factsAsOf}") and no uptime.
// Price snapshots are written only when a fetched price CHANGES (T3); the daily uptime value is logged on fetch (T6).

import type { ComicDoc, Resolution } from '../../../../shared/comic/doc.js';
import type { StudioCaps } from '../../../../shared/comic/capabilities.js';
import { IMAGE_MODELS, getImageModel, type ImageModelSpec } from '../../../../shared/comic/models.js';
import { lockedModelId, modelFit, type FitReason } from '../../../../shared/comic/modelLock.js';
import { logger } from '../../lib/logger.js';
import { mapEndpointPricing, mergeWithRegistry, registryPrices, type PriceBookSources } from './pricing.js';
import { NOT_RANKED_COPY, createQualitySource, qualityAsOf, qualityEntriesFor, rankMovesFor, type QualityBoard, type QualityEntry, type QualitySource, type RankMove } from './quality.js';
import {
  NOT_ENOUGH_DATA_COPY,
  monthlyByModel,
  observedEntriesFor,
  observedMedians,
  platformReliabilityFor,
  platformTopModels,
  qcObservedFor,
  reliabilityFor,
  type ImageCallRow,
  type MonthlyUsageRow,
  type ObservedEntry,
  type PlatformStatRow,
  type ReliabilityEntry
} from './observed.js';

// ── Row types (models.md §4.3) ────────────────────────────────────────────────

export type PriceBasis = 'openrouter_endpoint' | 'vendor_table' | 'derived_mp' | 'registry';

export interface CatalogPrice {
  usd: number | null;
  basis: PriceBasis;
  /** Where the number comes from, or the exact §4.6 copy when it is null. */
  note?: string;
}

export interface CatalogEndpoint {
  provider: string;
  uptime1d: number | null;
  uptime30m: number | null;
}

export interface ModelCatalogRow {
  id: string;
  nickname: string;
  providerModel: string;
  canonicalSlug?: string;
  openrouterCreated?: string;
  pickable: boolean;
  lifecycle: ImageModelSpec['lifecycle'];
  price: Partial<Record<Resolution, CatalogPrice>>;
  perRefUsd: number | null;
  endpoints: CatalogEndpoint[];
  quality: QualityEntry[];
  observed: ObservedEntry[];
  reliability?: ReliabilityEntry;
  /** When a projectId is passed. */
  fit?: FitReason[];
  /** When a projectId is passed: this is the comic's locked (or migrated) model. */
  current?: boolean;
  fetchedAt: { catalog?: string; uptime?: string; quality?: string };
  /** The last refresh failed; showing cached data. */
  stale: boolean;
}

// ── OpenRouter shapes (documented fields only; trimmed) ──────────────────────

export interface OrPricingLine {
  billable?: string;
  unit?: string;
  cost_usd?: number;
  variant?: string;
}

export interface OrImageEndpoint {
  provider_name?: string;
  provider_slug?: string;
  provider_tag?: string;
  supported_parameters?: Record<string, unknown>;
  pricing?: OrPricingLine[];
}

export interface OrImageModel {
  id: string;
  name?: string;
  /** Unix seconds. */
  created?: number;
  supported_parameters?: Record<string, unknown>;
}

export interface OrModelEndpoint {
  name?: string;
  provider_name?: string;
  tag?: string;
  status?: number | null;
  uptime_last_1d?: number | null;
  uptime_last_30m?: number | null;
}

// ── Dependencies ──────────────────────────────────────────────────────────────

export interface CatalogFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type CatalogFetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<CatalogFetchResponse>;

export interface CachedPayload {
  modelId: string;
  payload: unknown;
  fetchedAt: string;
}

export interface PriceSnapshotRow {
  modelId: string;
  res: Resolution;
  usd: number | null;
  basis: PriceBasis;
  note?: string | null;
  provider?: string | null;
  fetchedAt: string;
}

export interface UptimeLogRow {
  modelId: string;
  provider: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  uptime1d: number | null;
  uptime30m: number | null;
  fetchedAt: string;
}

/** Persistence for the caches and the trend history (Supabase in index.ts; memory in fakes.ts). Every method may throw; callers degrade. */
export interface CatalogStore {
  loadCache(source: string): Promise<CachedPayload[]>;
  saveCache(source: string, rows: CachedPayload[]): Promise<void>;
  /** The latest snapshot per (modelId, res). */
  latestPriceSnapshots(): Promise<PriceSnapshotRow[]>;
  insertPriceSnapshots(rows: PriceSnapshotRow[]): Promise<void>;
  priceSnapshotsSince(sinceIso: string): Promise<PriceSnapshotRow[]>;
  firstPriceSnapshotAt(): Promise<string | null>;
  logUptime(rows: UptimeLogRow[]): Promise<void>;
  uptimeSince(sinceIso: string): Promise<UptimeLogRow[]>;
}

/** Our per-call facts (S7). */
export interface ImageCallsDb {
  callsForUser(userId: string, opts: { sinceIso: string; limit: number }): Promise<ImageCallRow[]>;
  /** `comic_image_model_stats(p_since)`: groups with ≥ 5 distinct users only. */
  platformStats(sinceIso: string): Promise<PlatformStatRow[]>;
  monthlyUsage(product: string, sinceMonth: string): Promise<MonthlyUsageRow[]>;
}

export interface ModelCatalogDeps {
  fetch?: CatalogFetch;
  store?: CatalogStore | null;
  calls?: ImageCallsDb | null;
  quality?: QualitySource;
  now?: () => number;
  baseUrl?: string;
  /** OpenRouter ids to fetch endpoints for (default: registry OpenRouter routes + WATCH_LIST_IDS). */
  ids?: string[];
  /** Overrides for ROWS_WAIT_MS / PRICE_WAIT_MS / FETCH_TIMEOUT_MS (tests). */
  waits?: { rowsMs?: number; priceMs?: number; fetchMs?: number };
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
export const TTL_MS = { list: 6 * 3_600_000, endpoints: 6 * 3_600_000, uptime: 30 * 60_000 } as const;
/** After a failed refresh with no cache, wait this long before trying the source again (never a hot loop). */
export const FAIL_RETRY_MS = 60_000;
export const FETCH_TIMEOUT_MS = 6_000;
/** The longest a catalog / trends request waits on OpenRouter before answering with what it holds (marked stale). */
export const ROWS_WAIT_MS = 8_000;
/** The longest a quote waits on a price refresh before using the cached or registry price. */
export const PRICE_WAIT_MS = 2_500;
/** Observed kinds a catalog row carries (models.md §4.3 `observed[].kind`). */
export const ROW_OBSERVED_KINDS: ReadonlySet<string> = new Set(['page', 'sheet', 'cover']);
export const CACHE_SOURCE = { list: 'openrouter_images', endpoints: 'openrouter_images_endpoints' } as const;
/** Models we watch but do not offer (models.md §2.2 watch list): endpoints are fetched so a price change shows up. */
export const WATCH_LIST_IDS = ['microsoft/mai-image-2.6-flash', 'meta/muse-image', 'bytedance-seed/seedream-5-0-flash'];
export const TREND_RANGES = ['30d', '90d'] as const;
export type TrendRange = (typeof TREND_RANGES)[number];
export const USAGE_PRODUCT = 'comic_studio';
const CALLS_LOOKBACK_DAYS = 90;
const CALLS_LIMIT = 2000;
const CONCURRENCY = 4;
const OR_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

const DAY_MS = 86_400_000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (ms: number) => new Date(ms).toISOString();

/** Registry OpenRouter ids + the watch list (deduped). */
export const catalogIds = (): string[] => {
  const ids = new Set<string>();
  for (const m of IMAGE_MODELS) if (m.routes.openrouter) ids.add(m.routes.openrouter);
  for (const id of WATCH_LIST_IDS) ids.add(id);
  return [...ids];
};

// ── Cached source (memory + optional persistent bootstrap; single-flight; stale-while-error) ──

interface SourceState<T> {
  value?: T;
  fetchedAt?: number;
  stale: boolean;
  failedAt?: number;
}

interface SourceOpts<T> {
  ttlMs: number;
  now: () => number;
  /** Fetch a fresh value; `partial` marks a value that is missing some parts (served, but stale). */
  load: (previous: T | undefined) => Promise<{ value: T; partial?: boolean }>;
  /** Persisted value to start from (undefined/null = nothing persisted). */
  bootstrap?: () => Promise<{ value: T; fetchedAt: number } | null>;
  name: string;
}

const cachedSource = <T>(opts: SourceOpts<T>) => {
  const st: SourceState<T> = { stale: false };
  let booted = false;
  let inflight: Promise<SourceState<T>> | null = null;

  const refresh = async (): Promise<SourceState<T>> => {
    try {
      const out = await opts.load(st.value);
      st.value = out.value;
      st.fetchedAt = opts.now();
      st.stale = Boolean(out.partial);
      st.failedAt = out.partial ? opts.now() : undefined;
    } catch (err) {
      st.stale = true;
      st.failedAt = opts.now();
      logger.warn('comic_model_catalog_refresh_failed', { source: opts.name, message: (err as Error)?.message, cached: st.value !== undefined });
    }
    return st;
  };

  return {
    peek: () => st,
    /**
     * The value to serve. Fresh within the TTL → no fetch. Otherwise ONE refresh runs (single-flight); with
     * `maxWaitMs` the caller waits at most that long and then gets what is held, marked stale, while the
     * refresh finishes for the next request (a per-request timer, cleared on settle — never one at import).
     */
    get: async (call: { maxWaitMs?: number } = {}): Promise<SourceState<T>> => {
      if (!booted) {
        booted = true;
        if (opts.bootstrap) {
          try {
            const b = await opts.bootstrap();
            if (b) {
              st.value = b.value;
              st.fetchedAt = b.fetchedAt;
            }
          } catch (err) {
            logger.warn('comic_model_catalog_bootstrap_failed', { source: opts.name, message: (err as Error)?.message });
          }
        }
      }
      const now = opts.now();
      if (st.value !== undefined && st.fetchedAt !== undefined && now - st.fetchedAt < opts.ttlMs && !st.stale) return st;
      if (st.failedAt !== undefined && now - st.failedAt < FAIL_RETRY_MS) return st; // recent failure: serve what we have
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      const maxWaitMs = call.maxWaitMs;
      if (!maxWaitMs || maxWaitMs <= 0) return inflight;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<SourceState<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ...st, stale: true }), maxWaitMs);
      });
      try {
        return await Promise.race([inflight, late]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const fetchJson = async (fetchImpl: CatalogFetch, url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> => {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined; // per request, never at import
  try {
    const res = await fetchImpl(url, { signal: controller?.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const mapConcurrent = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/** The dated canonical slug OpenRouter prints in an endpoint name ("Google AI Studio | google/gemini-nano-banana-2.1-20261006"). */
export const canonicalSlugFrom = (endpoints: OrModelEndpoint[] | undefined, id: string): string | undefined => {
  for (const ep of endpoints ?? []) {
    const name = typeof ep.name === 'string' ? ep.name : '';
    const slug = name.split('|').pop()?.trim();
    if (slug && slug.startsWith(id) && /-\d{8}$/.test(slug)) return slug;
  }
  return undefined;
};

// ── Trends (models.md §4.4) ───────────────────────────────────────────────────

export interface ModelTrends {
  range: TrendRange;
  from: string;
  to: string;
  /** T2 — your image use by model per month (comic_image_calls, yours) + the platform monthly counters. */
  t2: {
    yours: { month: string; modelId: string; images: number }[];
    platform: MonthlyUsageRow[];
    source: { yours: string; platform: string };
  };
  /** T3 — price changes we recorded (change-only snapshots). */
  t3: {
    trackingSince: string | null;
    changes: { modelId: string; res: Resolution; usd: number | null; basis: PriceBasis; at: string; note?: string | null }[];
    note: string;
  };
  /** T4 — leaderboard movement from the history we hold. */
  t4: { moves: (RankMove & { modelId: string })[]; trackingSince: string | null; asOf?: string; source: string };
  /** T5 — new on OpenRouter inside the range. */
  t5: { sinceDays: number; models: { id: string; name: string; created: string }[]; fetchedAt?: string; stale: boolean };
  /** T6 — reliability: ours (24 h and 7 d) and OpenRouter's uptime, each labelled with its source. */
  t6: {
    ours: { modelId: string; window: '24h' | '7d'; calls: number; failed: number; rateLimited: number; scope: 'you' | 'platform' }[];
    openrouter: { modelId: string; provider: string; day: string; uptime1d: number | null; uptime30m: number | null; fetchedAt: string }[];
    source: { ours: string; openrouter: string };
  };
  /** T7 — most used by DreamStream creators, hidden below 5 distinct users. */
  t7: { available: boolean; copy?: string; models?: { modelId: string; calls: number; users: number }[]; sinceDays: number };
}

// ── The catalog ───────────────────────────────────────────────────────────────

/** GET /api/comic/models/:id — the row plus the registry facts and the history we hold (models.md §4.1 L3). */
export interface ModelCatalogDetail extends ModelCatalogRow {
  facts: {
    factsAsOf: string;
    priceBasis: ImageModelSpec['priceBasis'];
    refs: ImageModelSpec['refs'];
    aspects: ImageModelSpec['aspects'];
    resolutions: ImageModelSpec['resolutions'];
    fixedQuality?: ImageModelSpec['fixedQuality'];
    gradeSources?: ImageModelSpec['gradeSources'];
    replacement?: string;
  };
  /** Change-only price snapshots for this model in the last 90 days (T3). */
  priceHistory: { res: Resolution; usd: number | null; basis: PriceBasis; at: string; note?: string }[];
  /** Dated leaderboard points we hold (T4); nothing interpolated. */
  qualityHistory: { board: QualityBoard; asOf: string; rank?: number; score: number }[];
  /** NOT_RANKED_COPY when no public board lists the model. */
  qualityNote?: string;
}

export interface ModelCatalog {
  rows(opts?: { userId?: string; doc?: ComicDoc; caps?: StudioCaps }): Promise<ModelCatalogRow[]>;
  model(id: string, opts?: { userId?: string; doc?: ComicDoc; caps?: StudioCaps }): Promise<ModelCatalogDetail | null>;
  trends(range: TrendRange, opts?: { userId?: string }): Promise<ModelTrends>;
  /** What a PriceBook needs for this user: live prices (bounded wait) + observed medians + observed QC. */
  priceSources(userId?: string, opts?: { maxWaitMs?: number }): Promise<PriceBookSources>;
}

type ListValue = { byId: Map<string, OrImageModel> };
type EndpointsValue = Map<string, OrImageEndpoint[]>;
type UptimeValue = Map<string, OrModelEndpoint[]>;

/** Blocks last, then quality (best edit rank), then 1K price, then resilience (models.md §2.4 R2). */
export const sortCatalogRows = (rows: ModelCatalogRow[]): ModelCatalogRow[] => {
  const blocked = (r: ModelCatalogRow) => (r.fit?.some((f) => f.severity === 'block') ? 1 : 0);
  const rank = (r: ModelCatalogRow) => {
    const pick = r.quality.find((q) => q.board === 'lmarena_edit') ?? r.quality.find((q) => q.board === 'aa_edit') ?? r.quality.find((q) => typeof q.rank === 'number');
    return typeof pick?.rank === 'number' ? pick.rank : Number.POSITIVE_INFINITY;
  };
  const price = (r: ModelCatalogRow) => {
    const p = r.price['1K']?.usd;
    return typeof p === 'number' ? p : Number.POSITIVE_INFINITY;
  };
  const resilience = (r: ModelCatalogRow) => r.endpoints.length * 1000 + Math.max(0, ...r.endpoints.map((e) => e.uptime1d ?? 0));
  return [...rows].sort((a, b) => blocked(a) - blocked(b) || rank(a) - rank(b) || price(a) - price(b) || resilience(b) - resilience(a) || a.nickname.localeCompare(b.nickname));
};

export const createModelCatalog = (deps: ModelCatalogDeps = {}): ModelCatalog => {
  const now = deps.now ?? (() => Date.now());
  const base = (deps.baseUrl ?? OPENROUTER_PUBLIC_BASE).replace(/\/$/, '');
  const fetchImpl: CatalogFetch | undefined = deps.fetch ?? (globalThis.fetch as unknown as CatalogFetch | undefined);
  const store = deps.store ?? null;
  const calls = deps.calls ?? null;
  const quality = deps.quality ?? createQualitySource({ fetch: deps.fetch ?? null, now });
  const ids = (deps.ids ?? catalogIds()).filter((id) => OR_ID.test(id));
  const registryByOrId = new Map<string, ImageModelSpec>(IMAGE_MODELS.filter((m) => m.routes.openrouter).map((m) => [m.routes.openrouter as string, m]));

  const rowsWaitMs = deps.waits?.rowsMs ?? ROWS_WAIT_MS;
  const priceWaitMs = deps.waits?.priceMs ?? PRICE_WAIT_MS;
  const fetchMs = deps.waits?.fetchMs ?? FETCH_TIMEOUT_MS;
  const needFetch = (): CatalogFetch => {
    if (!fetchImpl) throw new Error('fetch is not available');
    return fetchImpl;
  };

  // S1 — image model list.
  const list = cachedSource<ListValue>({
    name: 'openrouter_images',
    ttlMs: TTL_MS.list,
    now,
    bootstrap: async () => {
      if (!store) return null;
      const rows = await store.loadCache(CACHE_SOURCE.list);
      if (!rows.length) return null;
      const byId = new Map<string, OrImageModel>();
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const m = r.payload as OrImageModel;
        if (m && typeof m.id === 'string') byId.set(m.id, m);
        oldest = Math.min(oldest, Date.parse(r.fetchedAt) || 0);
      }
      return byId.size ? { value: { byId }, fetchedAt: Number.isFinite(oldest) ? oldest : 0 } : null;
    },
    load: async () => {
      const body = (await fetchJson(needFetch(), `${base}/images/models`, fetchMs)) as { data?: OrImageModel[] };
      const models = Array.isArray(body?.data) ? body.data.filter((m) => m && typeof m.id === 'string') : [];
      if (!models.length) throw new Error('empty image model list');
      const byId = new Map(models.map((m) => [m.id, { id: m.id, name: m.name, created: m.created, supported_parameters: m.supported_parameters }] as const));
      const at = iso(now());
      if (store) await store.saveCache(CACHE_SOURCE.list, [...byId.values()].map((m) => ({ modelId: m.id, payload: m, fetchedAt: at }))).catch((err) => logger.warn('comic_model_catalog_cache_write_failed', { source: CACHE_SOURCE.list, message: (err as Error)?.message }));
      return { value: { byId } };
    }
  });

  // Change-only price snapshots (T3). The memory map mirrors the latest DB row per (model, res).
  let lastPrices: Map<string, { usd: number | null; basis: PriceBasis }> | null = null;
  const snapshotPriceChanges = async (endpointsById: EndpointsValue, fetchedAt: string): Promise<PriceSnapshotRow[]> => {
    if (!lastPrices) {
      lastPrices = new Map();
      if (store) {
        try {
          for (const r of await store.latestPriceSnapshots()) lastPrices.set(`${r.modelId}|${r.res}`, { usd: r.usd, basis: r.basis });
        } catch (err) {
          logger.warn('comic_model_catalog_snapshot_read_failed', { message: (err as Error)?.message });
        }
      }
    }
    const rows: PriceSnapshotRow[] = [];
    for (const [modelId, endpoints] of endpointsById) {
      const live = mapEndpointPricing({ modelId, endpoints, spec: registryByOrId.get(modelId), fetchedAt });
      for (const [res, p] of Object.entries(live.price) as [Resolution, CatalogPrice][]) {
        const key = `${modelId}|${res}`;
        const prev = lastPrices.get(key);
        if (prev && prev.usd === p.usd && prev.basis === p.basis) continue;
        rows.push({ modelId, res, usd: p.usd, basis: p.basis, note: p.note ?? null, provider: live.providers[0] ?? null, fetchedAt });
        lastPrices.set(key, { usd: p.usd, basis: p.basis });
      }
    }
    if (rows.length && store) await store.insertPriceSnapshots(rows).catch((err) => logger.warn('comic_model_catalog_snapshot_write_failed', { message: (err as Error)?.message }));
    return rows;
  };

  // S2 — per-endpoint pricing for the ids we track.
  const endpoints = cachedSource<EndpointsValue>({
    name: 'openrouter_images_endpoints',
    ttlMs: TTL_MS.endpoints,
    now,
    bootstrap: async () => {
      if (!store) return null;
      const rows = await store.loadCache(CACHE_SOURCE.endpoints);
      if (!rows.length) return null;
      const value: EndpointsValue = new Map();
      let oldest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const eps = (r.payload as { endpoints?: OrImageEndpoint[] })?.endpoints;
        if (Array.isArray(eps)) value.set(r.modelId, eps);
        oldest = Math.min(oldest, Date.parse(r.fetchedAt) || 0);
      }
      const complete = ids.every((id) => value.has(id));
      return value.size ? { value, fetchedAt: complete && Number.isFinite(oldest) ? oldest : 0 } : null;
    },
    load: async (previous) => {
      const f = needFetch();
      const value: EndpointsValue = new Map(previous ?? []);
      const failed: string[] = [];
      const at = iso(now());
      const fresh: CachedPayload[] = [];
      await mapConcurrent(ids, CONCURRENCY, async (id) => {
        try {
          const body = (await fetchJson(f, `${base}/images/models/${id}/endpoints`, fetchMs)) as { endpoints?: OrImageEndpoint[]; data?: { endpoints?: OrImageEndpoint[] } };
          // Documented as { id, endpoints }; accept the { data: { endpoints } } envelope of /models/{id}/endpoints too.
          const raw = Array.isArray(body?.endpoints) ? body.endpoints : body?.data?.endpoints;
          if (!Array.isArray(raw)) throw new Error('endpoint list missing');
          const eps = raw.filter((e) => e && typeof e === 'object');
          value.set(id, eps);
          fresh.push({ modelId: id, payload: { id, endpoints: eps }, fetchedAt: at });
        } catch (err) {
          failed.push(id);
          logger.warn('comic_model_catalog_endpoint_fetch_failed', { modelId: id, message: (err as Error)?.message });
        }
      });
      if (failed.length === ids.length) throw new Error('every endpoint fetch failed');
      if (store && fresh.length) await store.saveCache(CACHE_SOURCE.endpoints, fresh).catch((err) => logger.warn('comic_model_catalog_cache_write_failed', { source: CACHE_SOURCE.endpoints, message: (err as Error)?.message }));
      await snapshotPriceChanges(new Map(fresh.map((r) => [r.modelId, (r.payload as { endpoints: OrImageEndpoint[] }).endpoints])), at);
      return { value, partial: failed.length > 0 };
    }
  });

  // S3 — providers and uptime (memory only; the daily value is logged for T6).
  const uptime = cachedSource<UptimeValue>({
    name: 'openrouter_model_endpoints',
    ttlMs: TTL_MS.uptime,
    now,
    load: async (previous) => {
      const f = needFetch();
      const value: UptimeValue = new Map(previous ?? []);
      const failed: string[] = [];
      const at = iso(now());
      const log: UptimeLogRow[] = [];
      await mapConcurrent(ids, CONCURRENCY, async (id) => {
        try {
          const body = (await fetchJson(f, `${base}/models/${id}/endpoints`, fetchMs)) as { data?: { endpoints?: OrModelEndpoint[] } };
          if (!Array.isArray(body?.data?.endpoints)) throw new Error('endpoint list missing');
          const eps = body.data.endpoints.filter((e) => e && typeof e === 'object');
          value.set(id, eps.map((e) => ({ name: e.name, provider_name: e.provider_name, tag: e.tag, status: e.status, uptime_last_1d: e.uptime_last_1d, uptime_last_30m: e.uptime_last_30m })));
          for (const e of eps) log.push({ modelId: id, provider: String(e.tag || e.provider_name || 'unknown'), day: at.slice(0, 10), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m), fetchedAt: at });
        } catch (err) {
          failed.push(id);
          logger.warn('comic_model_catalog_uptime_fetch_failed', { modelId: id, message: (err as Error)?.message });
        }
      });
      if (failed.length === ids.length) throw new Error('every uptime fetch failed');
      if (store && log.length) await store.logUptime(log).catch((err) => logger.warn('comic_model_catalog_uptime_log_failed', { message: (err as Error)?.message }));
      return { value, partial: failed.length > 0 };
    }
  });

  // S7 — our own calls for this user (owner-scoped) and the platform aggregate (≥ 5 users).
  const loadCalls = async (userId: string | undefined, sinceMs: number, opts: { last24h: boolean }) => {
    const empty = { yours: [] as ImageCallRow[], platform: [] as PlatformStatRow[], platform24h: [] as PlatformStatRow[] };
    if (!calls) return empty;
    const sinceIso = iso(sinceMs);
    const [yours, platform, platform24h] = await Promise.all([
      userId ? calls.callsForUser(userId, { sinceIso, limit: CALLS_LIMIT }).catch((err) => (logger.warn('comic_image_calls_read_failed', { message: (err as Error)?.message }), [] as ImageCallRow[])) : Promise.resolve([] as ImageCallRow[]),
      calls.platformStats(sinceIso).catch((err) => (logger.warn('comic_image_calls_stats_failed', { message: (err as Error)?.message }), [] as PlatformStatRow[])),
      opts.last24h ? calls.platformStats(iso(now() - DAY_MS)).catch(() => [] as PlatformStatRow[]) : Promise.resolve([] as PlatformStatRow[])
    ]);
    return { yours, platform, platform24h };
  };

  interface Loaded {
    list: SourceState<ListValue>;
    eps: SourceState<EndpointsValue>;
    up: SourceState<UptimeValue>;
    q: Awaited<ReturnType<QualitySource['get']>>;
    yours: ImageCallRow[];
    platform: PlatformStatRow[];
    platform24h: PlatformStatRow[];
  }

  const loadAll = async (userId?: string): Promise<Loaded> => {
    const wait = { maxWaitMs: rowsWaitMs };
    const [l, e, u, q, c] = await Promise.all([list.get(wait), endpoints.get(wait), uptime.get(wait), quality.get(), loadCalls(userId, now() - CALLS_LOOKBACK_DAYS * DAY_MS, { last24h: true })]);
    return { list: l, eps: e, up: u, q, ...c };
  };

  /** Live prices merged with the registry (or the registry's dated list when nothing was fetched). */
  const pricesFor = (spec: ImageModelSpec, eps: SourceState<EndpointsValue>) => {
    const orId = spec.routes.openrouter;
    const fetched = orId ? eps.value?.get(orId) : undefined;
    const at = eps.fetchedAt !== undefined ? iso(eps.fetchedAt) : undefined;
    const live = fetched ? mapEndpointPricing({ modelId: orId as string, endpoints: fetched, spec, fetchedAt: at }) : null;
    return {
      price: live ? mergeWithRegistry(live.price, spec) : registryPrices(spec),
      perRefUsd: live ? live.perRefUsd : typeof spec.perRefUsd === 'number' ? spec.perRefUsd : null,
      at: live ? at : undefined
    };
  };

  const buildRow = (spec: ImageModelSpec, data: Loaded, ctx: { doc?: ComicDoc; caps?: StudioCaps }): ModelCatalogRow => {
    const orId = spec.routes.openrouter;
    const listed = orId ? data.list.value?.byId.get(orId) : undefined;
    const { price, perRefUsd, at: epsAt } = pricesFor(spec, data.eps);
    const up = orId ? data.up.value?.get(orId) : undefined;
    const current = ctx.doc ? lockedModelId(ctx.doc) === spec.id : undefined;
    const reliability = reliabilityFor(data.yours, { modelId: spec.id, now: now() }) ?? platformReliabilityFor(data.platform24h, spec.id) ?? undefined;
    const canonicalSlug = canonicalSlugFrom(up, orId ?? '');
    const catalogAt = epsAt ?? (listed && data.list.fetchedAt !== undefined ? iso(data.list.fetchedAt) : undefined);
    const qualityAt = data.q.fetchedAt ?? qualityAsOf(data.q.snapshot);
    return {
      id: spec.id,
      nickname: spec.nickname,
      providerModel: orId ?? spec.routes.gemini ?? spec.id,
      ...(canonicalSlug ? { canonicalSlug } : {}),
      ...(typeof listed?.created === 'number' ? { openrouterCreated: iso(listed.created * 1000) } : {}),
      pickable: spec.pickable,
      lifecycle: spec.lifecycle,
      price,
      perRefUsd,
      endpoints: (up ?? []).map((e) => ({ provider: String(e.provider_name || e.tag || 'unknown'), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m) })),
      quality: qualityEntriesFor(orId, data.q.snapshot),
      observed: observedEntriesFor(data.yours, data.platform, spec.id).filter((o) => ROW_OBSERVED_KINDS.has(o.kind)),
      ...(reliability ? { reliability } : {}),
      ...(ctx.doc && ctx.caps ? { fit: modelFit(spec, ctx.doc, ctx.caps) } : {}),
      ...(current !== undefined ? { current } : {}),
      fetchedAt: {
        ...(catalogAt ? { catalog: catalogAt } : {}),
        ...(up && data.up.fetchedAt !== undefined ? { uptime: iso(data.up.fetchedAt) } : {}),
        ...(qualityAt ? { quality: qualityAt } : {})
      },
      stale: Boolean(data.list.stale || data.eps.stale || data.up.stale || data.q.stale)
    };
  };

  const rows: ModelCatalog['rows'] = async (opts = {}) => {
    const data = await loadAll(opts.userId);
    return sortCatalogRows(IMAGE_MODELS.map((spec) => buildRow(spec, data, opts)));
  };

  const model: ModelCatalog['model'] = async (id, opts = {}) => {
    const spec = getImageModel(id);
    if (!spec) return null;
    const data = await loadAll(opts.userId);
    const row = buildRow(spec, data, opts);
    const since = iso(now() - CALLS_LOOKBACK_DAYS * DAY_MS);
    const orId = spec.routes.openrouter;
    const snapshots = store && orId ? await store.priceSnapshotsSince(since).catch(() => [] as PriceSnapshotRow[]) : [];
    const history = orId ? (data.q.snapshot.history[orId] ?? {}) : {};
    return {
      ...row,
      facts: {
        factsAsOf: spec.factsAsOf,
        priceBasis: spec.priceBasis,
        refs: spec.refs,
        aspects: spec.aspects,
        resolutions: spec.resolutions,
        ...(spec.fixedQuality ? { fixedQuality: spec.fixedQuality } : {}),
        ...(spec.gradeSources ? { gradeSources: spec.gradeSources } : {}),
        ...(spec.replacement ? { replacement: spec.replacement } : {})
      },
      priceHistory: snapshots
        .filter((r) => r.modelId === orId)
        .map((r) => ({ res: r.res, usd: r.usd, basis: r.basis, at: r.fetchedAt, ...(r.note ? { note: r.note } : {}) }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      qualityHistory: Object.entries(history).flatMap(([board, points]) => (points ?? []).map((p) => ({ board: board as QualityBoard, ...p }))),
      ...(row.quality.length ? {} : { qualityNote: NOT_RANKED_COPY })
    };
  };

  const priceSources: ModelCatalog['priceSources'] = async (userId, opts = {}) => {
    const sinceMs = now() - CALLS_LOOKBACK_DAYS * DAY_MS;
    const [eps, c] = await Promise.all([endpoints.get({ maxWaitMs: opts.maxWaitMs ?? priceWaitMs }), loadCalls(userId, sinceMs, { last24h: false })]);
    return {
      rows: IMAGE_MODELS.map((spec) => {
        const p = pricesFor(spec, eps);
        return { id: spec.id, price: p.price, perRefUsd: p.perRefUsd, fetchedAt: p.at ? { catalog: p.at } : {}, stale: Boolean(eps.stale) };
      }),
      observed: observedMedians(c.yours, c.platform),
      qc: qcObservedFor(c.yours)
    };
  };

  const trends: ModelCatalog['trends'] = async (range, opts = {}) => {
    const days = range === '90d' ? 90 : 30;
    const to = now();
    const from = to - days * DAY_MS;
    const sinceIso = iso(from);
    const data = await loadAll(opts.userId);
    const yoursInRange = data.yours.filter((r) => Date.parse(r.createdAt) >= from);
    const sinceMonth = sinceIso.slice(0, 7);
    const [platformMonthly, snapshots, trackingSince, uptimeLog] = await Promise.all([
      calls ? calls.monthlyUsage(USAGE_PRODUCT, sinceMonth).catch(() => [] as MonthlyUsageRow[]) : Promise.resolve([] as MonthlyUsageRow[]),
      store ? store.priceSnapshotsSince(sinceIso).catch(() => [] as PriceSnapshotRow[]) : Promise.resolve([] as PriceSnapshotRow[]),
      store ? store.firstPriceSnapshotAt().catch(() => null) : Promise.resolve(null),
      store ? store.uptimeSince(sinceIso).catch(() => [] as UptimeLogRow[]) : Promise.resolve([] as UptimeLogRow[])
    ]);

    const t4moves: ModelTrends['t4']['moves'] = [];
    let t4since: string | null = null;
    for (const spec of IMAGE_MODELS) {
      const { moves, trackingSince: ts } = rankMovesFor(spec.routes.openrouter, sinceIso.slice(0, 10), data.q.snapshot);
      for (const m of moves) t4moves.push({ modelId: spec.id, ...m });
      if (ts && (!t4since || ts < t4since)) t4since = ts;
    }

    const newModels = [...(data.list.value?.byId.values() ?? [])]
      .filter((m) => typeof m.created === 'number' && m.created * 1000 >= from)
      .map((m) => ({ id: m.id, name: m.name ?? m.id, created: iso((m.created as number) * 1000) }))
      .sort((a, b) => b.created.localeCompare(a.created));

    const ours: ModelTrends['t6']['ours'] = [];
    for (const spec of IMAGE_MODELS) {
      for (const [window, hours] of [['24h', 24], ['7d', 168]] as const) {
        const mine = reliabilityFor(data.yours, { modelId: spec.id, now: to, windowH: hours });
        if (mine) ours.push({ modelId: spec.id, window, calls: mine.calls, failed: mine.failed, rateLimited: mine.rateLimited, scope: 'you' });
      }
      const platform24 = platformReliabilityFor(data.platform24h, spec.id);
      if (platform24) ours.push({ modelId: spec.id, window: '24h', calls: platform24.calls, failed: platform24.failed, rateLimited: platform24.rateLimited, scope: 'platform' });
    }
    const openrouter: ModelTrends['t6']['openrouter'] = uptimeLog.map((u) => ({ modelId: registryByOrId.get(u.modelId)?.id ?? u.modelId, provider: u.provider, day: u.day, uptime1d: u.uptime1d, uptime30m: u.uptime30m, fetchedAt: u.fetchedAt }));
    if (data.up.value && data.up.fetchedAt !== undefined) {
      const at = iso(data.up.fetchedAt);
      for (const [orId, eps] of data.up.value) {
        const modelId = registryByOrId.get(orId)?.id ?? orId;
        for (const e of eps) {
          const provider = String(e.tag || e.provider_name || 'unknown');
          if (!openrouter.some((o) => o.modelId === modelId && o.provider === provider && o.day === at.slice(0, 10))) openrouter.push({ modelId, provider, day: at.slice(0, 10), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m), fetchedAt: at });
        }
      }
    }

    const top = platformTopModels(data.platform);
    return {
      range,
      from: sinceIso,
      to: iso(to),
      t2: {
        yours: monthlyByModel(yoursInRange),
        platform: platformMonthly.filter((r) => r.product === USAGE_PRODUCT),
        source: { yours: 'comic_image_calls (your calls)', platform: `model_usage_monthly (product ${USAGE_PRODUCT}, platform-wide counts)` }
      },
      t3: {
        trackingSince,
        changes: snapshots.map((s) => ({ modelId: registryByOrId.get(s.modelId)?.id ?? s.modelId, res: s.res, usd: s.usd, basis: s.basis, at: s.fetchedAt, note: s.note ?? null })).sort((a, b) => a.at.localeCompare(b.at)),
        note: trackingSince ? `Tracking since ${trackingSince}` : 'No price snapshots yet'
      },
      t4: { moves: t4moves, trackingSince: t4since, ...(qualityAsOf(data.q.snapshot) ? { asOf: qualityAsOf(data.q.snapshot) } : {}), source: 'LMArena leaderboard-dataset history we hold (Hugging Face, CC BY 4.0)' },
      t5: { sinceDays: days, models: newModels, ...(data.list.fetchedAt !== undefined ? { fetchedAt: iso(data.list.fetchedAt) } : {}), stale: Boolean(data.list.stale) },
      t6: { ours, openrouter, source: { ours: 'comic_image_calls (24 h / 7 d success and 429 rate)', openrouter: 'OpenRouter uptime_last_1d, captured on each fetch' } },
      t7: top ? { available: true, models: top, sinceDays: CALLS_LOOKBACK_DAYS } : { available: false, copy: NOT_ENOUGH_DATA_COPY, sinceDays: CALLS_LOOKBACK_DAYS }
    };
  };

  return { rows, model, trends, priceSources };
};
