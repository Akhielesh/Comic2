// Model catalog data layer (models.md §4.3 ModelCatalogRow, §4.4 trends T2–T7, §4.5 S1–S3 + S5–S7, §4.6 copy).
//
// Sources, all documented and fetched ON DEMAND — a request has to ask; nothing here schedules a timer at import
// (a test enforces it) so a sleeping container is never woken:
//   S1 GET /api/v1/images/models                 list, parameters, `created`      6 h TTL
//   S2 GET /api/v1/images/models/{id}/endpoints  per-endpoint pricing             6 h TTL, registry + watch-list ids only
//   S3 GET /api/v1/models/{id}/endpoints         providers, uptime_last_1d/30m    30 min TTL
//   S5 LMArena snapshot (quality.ts)             24 h TTL
//   S7 comic_image_calls (observed.ts)           live on open
// Each source is single-flight, cached in memory and (S1/S2) in the DB, and stale-while-error. S2 and S3 keep
// their freshness PER OpenRouter id: every id has its own fetch time, TTL and failure backoff, so one id that
// fails is retried alone (never a refetch of every id) and marks only its own row stale ("as of {time} ·
// couldn't refresh"). An id OpenRouter does not know (404) or lists no endpoints for is "no data" for that row
// (its §4.6 copy), not a failed refresh. With no cache at all a row falls back to the registry's dated price
// list ("from our price list, {factsAsOf}") and no uptime. Times shown are always real fetch times.
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
  /** This row's price or uptime refresh failed (or did not finish in time); showing cached data. */
  stale: boolean;
  /** The leaderboard refresh failed; the dated snapshot (`fetchedAt.quality`) is shown. Never folded into `stale`. */
  qualityStale?: boolean;
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

/** Persistence for the caches and the trend history (Supabase in index.ts; memory in __fixtures__/catalogFakes.ts). Every method may throw; callers degrade. */
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
/**
 * After a failed refresh, wait this long before trying again (never a hot loop). Per id it doubles with each
 * consecutive failure, capped at the source's TTL, so an id that keeps failing costs at most one request per TTL.
 */
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
/** A persisted fetch time, or undefined when it is missing or unparseable — never 0 (a displayed 1970 is a fabricated time). */
const fetchTime = (raw: unknown): number | undefined => {
  const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

/** Registry OpenRouter ids + the watch list (deduped). */
export const catalogIds = (): string[] => {
  const ids = new Set<string>();
  for (const m of IMAGE_MODELS) if (m.routes.openrouter) ids.add(m.routes.openrouter);
  for (const id of WATCH_LIST_IDS) ids.add(id);
  return [...ids];
};

// ── Cached source (memory + optional persistent bootstrap; single-flight; stale-while-error) ──
// S1 is one URL, so it is cached as one value. S2/S3 use keyedSource below (per OpenRouter id).

interface SourceState<T> {
  value?: T;
  fetchedAt?: number;
  stale: boolean;
  failedAt?: number;
}

interface SourceOpts<T> {
  ttlMs: number;
  now: () => number;
  /** Fetch a fresh value. */
  load: (previous: T | undefined) => Promise<{ value: T }>;
  /** Persisted value to start from (null = nothing persisted). `fetchedAt` is a real fetch time, never 0. */
  bootstrap?: () => Promise<{ value: T; fetchedAt: number } | null>;
  name: string;
}

/** A per-request bounded wait: the caller gets `late()` when `work` has not settled within `maxWaitMs`. */
const within = async <R>(work: Promise<R>, maxWaitMs: number | undefined, late: () => R): Promise<R> => {
  if (!maxWaitMs || maxWaitMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<R>((resolve) => {
    timer = setTimeout(() => resolve(late()), maxWaitMs); // a per-request timer, cleared on settle — never one at import
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const cachedSource = <T>(opts: SourceOpts<T>) => {
  const st: SourceState<T> = { stale: false };
  let booted: Promise<void> | null = null;
  let inflight: Promise<SourceState<T>> | null = null;

  const boot = () =>
    (booted ??= (async () => {
      if (!opts.bootstrap) return;
      try {
        const b = await opts.bootstrap();
        if (b && b.fetchedAt > 0 && st.value === undefined) {
          st.value = b.value;
          st.fetchedAt = b.fetchedAt;
        }
      } catch (err) {
        logger.warn('comic_model_catalog_bootstrap_failed', { source: opts.name, message: (err as Error)?.message });
      }
    })());

  const refresh = async (): Promise<SourceState<T>> => {
    try {
      const out = await opts.load(st.value);
      st.value = out.value;
      st.fetchedAt = opts.now();
      st.stale = false;
      st.failedAt = undefined;
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
     * refresh finishes for the next request.
     */
    get: async (call: { maxWaitMs?: number } = {}): Promise<SourceState<T>> => {
      await boot();
      const now = opts.now();
      if (st.value !== undefined && st.fetchedAt !== undefined && now - st.fetchedAt < opts.ttlMs && !st.stale) return st;
      if (st.failedAt !== undefined && now - st.failedAt < FAIL_RETRY_MS) return st; // recent failure: serve what we have
      if (!inflight) inflight = refresh().finally(() => (inflight = null));
      return within(inflight, call.maxWaitMs, () => ({ ...st, stale: true }));
    }
  };
};

/** What one id of a keyed source holds. */
export interface KeyedEntry<T> {
  value?: T;
  /** When this id's value was fetched (ms). Never 0. */
  fetchedAt?: number;
  /** This id's last refresh failed, or a refresh it needed did not finish within the caller's wait. */
  stale: boolean;
  /** OpenRouter answered 404 or listed no endpoints: no data for this id (a successful answer, kept for the TTL). */
  missing: boolean;
}

export interface KeyedView<T> {
  get(id: string): KeyedEntry<T> | undefined;
  entries(): [string, KeyedEntry<T>][];
}

interface KeyedState<T> {
  value?: T;
  fetchedAt?: number;
  missing: boolean;
  failedAt?: number;
  failures: number;
}

interface KeyedOpts<T> {
  name: string;
  ids: string[];
  ttlMs: number;
  now: () => number;
  /** One id's fresh value; throw on failure. `missing` = OpenRouter has no data for this id. */
  fetchOne: (id: string) => Promise<{ value: T; missing?: boolean }>;
  /** Persisted values, each with its own real fetch time. */
  bootstrap?: () => Promise<Map<string, { value: T; fetchedAt: number; missing?: boolean }>>;
  /** Called once per batch with the ids that answered (missing ones included) at the batch's fetch time. */
  afterBatch?: (fresh: Map<string, { value: T; missing: boolean }>, fetchedAtIso: string) => Promise<void>;
}

/**
 * A source with per-id freshness: every id has its own fetch time, TTL and failure backoff. A request
 * refreshes only the ids that are due (past the TTL, never fetched, or failed and past their backoff), in one
 * single-flight batch; ids that answered keep their TTL, and an id that fails marks only itself stale.
 */
const keyedSource = <T>(opts: KeyedOpts<T>) => {
  const states = new Map<string, KeyedState<T>>(opts.ids.map((id) => [id, { missing: false, failures: 0 }]));
  let booted: Promise<void> | null = null;
  interface Batch {
    ids: string[];
    /** Ids this batch has answered (successfully) so far. */
    answered: Set<string>;
    done: Promise<void>;
  }
  let inflight: Batch | null = null;

  const lastAttemptFailed = (st: KeyedState<T>) => st.failedAt !== undefined && (st.fetchedAt === undefined || st.failedAt >= st.fetchedAt);
  const backoffMs = (failures: number) => Math.min(FAIL_RETRY_MS * 2 ** Math.max(0, failures - 1), opts.ttlMs);
  const isDue = (st: KeyedState<T>, now: number) => {
    if (lastAttemptFailed(st)) return now - (st.failedAt as number) >= backoffMs(st.failures);
    return st.fetchedAt === undefined || now - st.fetchedAt >= opts.ttlMs;
  };

  const boot = () =>
    (booted ??= (async () => {
      if (!opts.bootstrap) return;
      try {
        const persisted = await opts.bootstrap();
        for (const [id, p] of persisted) {
          const st = states.get(id);
          if (!st || st.fetchedAt !== undefined || !(p.fetchedAt > 0)) continue;
          st.value = p.value;
          st.fetchedAt = p.fetchedAt;
          st.missing = Boolean(p.missing);
        }
      } catch (err) {
        logger.warn('comic_model_catalog_bootstrap_failed', { source: opts.name, message: (err as Error)?.message });
      }
    })());

  const runBatch = async (batch: Batch): Promise<void> => {
    const at = opts.now();
    const fresh = new Map<string, { value: T; missing: boolean }>();
    await mapConcurrent(batch.ids, CONCURRENCY, async (id) => {
      const st = states.get(id) as KeyedState<T>;
      try {
        const out = await opts.fetchOne(id);
        st.value = out.value;
        st.fetchedAt = at;
        st.missing = Boolean(out.missing);
        st.failedAt = undefined;
        st.failures = 0;
        fresh.set(id, { value: out.value, missing: st.missing });
        batch.answered.add(id);
      } catch (err) {
        st.failedAt = opts.now();
        st.failures += 1;
        logger.warn('comic_model_catalog_fetch_failed', { source: opts.name, modelId: id, failures: st.failures, message: (err as Error)?.message, cached: st.value !== undefined });
      }
    });
    if (fresh.size && opts.afterBatch) {
      await opts.afterBatch(fresh, iso(at)).catch((err) => logger.warn('comic_model_catalog_after_batch_failed', { source: opts.name, message: (err as Error)?.message }));
    }
  };

  const view = (late: ReadonlySet<string>): KeyedView<T> => {
    const entry = (id: string): KeyedEntry<T> | undefined => {
      const st = states.get(id);
      if (!st) return undefined;
      return { value: st.value, fetchedAt: st.fetchedAt, missing: st.missing, stale: lastAttemptFailed(st) || late.has(id) };
    };
    return { get: entry, entries: () => opts.ids.map((id) => [id, entry(id) as KeyedEntry<T>]) };
  };

  return {
    /**
     * The view to serve. Only due ids are fetched (single-flight: a request that finds a batch running joins
     * it). With `maxWaitMs` the caller waits at most that long; ids the batch has not answered by then are
     * served from what is held and marked stale, while the batch finishes for the next request.
     */
    get: async (call: { maxWaitMs?: number } = {}): Promise<KeyedView<T>> => {
      await boot();
      if (!inflight) {
        const now = opts.now();
        const due = opts.ids.filter((id) => isDue(states.get(id) as KeyedState<T>, now));
        if (!due.length) return view(new Set());
        const batch: Batch = { ids: due, answered: new Set(), done: Promise.resolve() };
        batch.done = runBatch(batch).finally(() => {
          if (inflight === batch) inflight = null;
        });
        inflight = batch;
      }
      const running = inflight;
      return within(
        running.done.then(() => view(new Set())),
        call.maxWaitMs,
        () => view(new Set(running.ids.filter((id) => !running.answered.has(id))))
      );
    }
  };
};

// ── Fetch helpers ─────────────────────────────────────────────────────────────

/** A non-2xx answer (the status decides "no data" (404/410) vs a failed refresh). */
export class CatalogHttpError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(`${status} ${url}`);
  }
}

const fetchJson = async (fetchImpl: CatalogFetch, url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> => {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined; // per request, never at import
  try {
    const res = await fetchImpl(url, { signal: controller?.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new CatalogHttpError(res.status, url);
    return await res.json();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const isNoData = (err: unknown) => err instanceof CatalogHttpError && (err.status === 404 || err.status === 410);

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

/**
 * How an uptime endpoint is named: its provider name, plus its tag when another endpoint of the same model has
 * the same name (OpenRouter calls both Vertex endpoints of Nano Banana 2 "Google").
 */
export const endpointLabel = (e: OrModelEndpoint, all: OrModelEndpoint[]): string => {
  const name = String(e.provider_name || e.tag || 'unknown');
  const shared = all.filter((o) => String(o.provider_name || o.tag || 'unknown') === name).length > 1;
  return shared && e.tag && e.tag !== name ? `${name} (${e.tag})` : name;
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
    /** "Tracking since {first fetch}"; null before the first fetch (§4.4: no line before that date). */
    note: string | null;
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
      let oldest: number | undefined;
      for (const r of rows) {
        const m = r.payload as OrImageModel;
        const at = fetchTime(r.fetchedAt);
        if (!m || typeof m.id !== 'string' || at === undefined) continue; // a row without a real fetch time is not served
        byId.set(m.id, m);
        oldest = oldest === undefined ? at : Math.min(oldest, at);
      }
      return byId.size && oldest !== undefined ? { value: { byId }, fetchedAt: oldest } : null;
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

  // S2 — per-endpoint pricing for the ids we track, each id with its own fetch time, TTL and backoff.
  const endpoints = keyedSource<OrImageEndpoint[]>({
    name: 'openrouter_images_endpoints',
    ids,
    ttlMs: TTL_MS.endpoints,
    now,
    bootstrap: async () => {
      const out = new Map<string, { value: OrImageEndpoint[]; fetchedAt: number; missing?: boolean }>();
      if (!store) return out;
      for (const r of await store.loadCache(CACHE_SOURCE.endpoints)) {
        const payload = r.payload as { endpoints?: OrImageEndpoint[]; missing?: boolean } | null;
        const at = fetchTime(r.fetchedAt);
        if (!payload || !Array.isArray(payload.endpoints) || at === undefined) continue;
        out.set(r.modelId, { value: payload.endpoints, fetchedAt: at, missing: Boolean(payload.missing) || payload.endpoints.length === 0 });
      }
      return out;
    },
    fetchOne: async (id) => {
      let body: { endpoints?: OrImageEndpoint[]; data?: { endpoints?: OrImageEndpoint[] } };
      try {
        body = (await fetchJson(needFetch(), `${base}/images/models/${id}/endpoints`, fetchMs)) as typeof body;
      } catch (err) {
        if (isNoData(err)) return { value: [], missing: true }; // OpenRouter does not know this id (any more)
        throw err;
      }
      // Documented as { id, endpoints }; accept the { data: { endpoints } } envelope of /models/{id}/endpoints too.
      const raw = Array.isArray(body?.endpoints) ? body.endpoints : body?.data?.endpoints;
      if (!Array.isArray(raw)) logger.warn('comic_model_catalog_endpoint_list_missing', { modelId: id });
      const eps = Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
      return { value: eps, missing: eps.length === 0 };
    },
    afterBatch: async (fresh, at) => {
      if (store) {
        const rows = [...fresh].map(([id, f]) => ({ modelId: id, payload: { id, endpoints: f.value, ...(f.missing ? { missing: true } : {}) }, fetchedAt: at }));
        await store.saveCache(CACHE_SOURCE.endpoints, rows).catch((err) => logger.warn('comic_model_catalog_cache_write_failed', { source: CACHE_SOURCE.endpoints, message: (err as Error)?.message }));
      }
      await snapshotPriceChanges(new Map([...fresh].filter(([, f]) => !f.missing).map(([id, f]) => [id, f.value])), at);
    }
  });

  // S3 — providers and uptime (memory only; the daily value is logged for T6), each id with its own 30 min TTL.
  const uptime = keyedSource<OrModelEndpoint[]>({
    name: 'openrouter_model_endpoints',
    ids,
    ttlMs: TTL_MS.uptime,
    now,
    fetchOne: async (id) => {
      let body: { data?: { endpoints?: OrModelEndpoint[] } };
      try {
        body = (await fetchJson(needFetch(), `${base}/models/${id}/endpoints`, fetchMs)) as typeof body;
      } catch (err) {
        if (isNoData(err)) return { value: [], missing: true };
        throw err;
      }
      const raw = body?.data?.endpoints;
      if (!Array.isArray(raw)) logger.warn('comic_model_catalog_uptime_list_missing', { modelId: id });
      const eps = (Array.isArray(raw) ? raw : []).filter((e) => e && typeof e === 'object');
      const value = eps.map((e) => ({ name: e.name, provider_name: e.provider_name, tag: e.tag, status: e.status, uptime_last_1d: e.uptime_last_1d, uptime_last_30m: e.uptime_last_30m }));
      return { value, missing: value.length === 0 };
    },
    afterBatch: async (fresh, at) => {
      if (!store) return;
      const log: UptimeLogRow[] = [];
      for (const [id, f] of fresh) for (const e of f.value) log.push({ modelId: id, provider: endpointLabel(e, f.value), day: at.slice(0, 10), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m), fetchedAt: at });
      if (log.length) await store.logUptime(log);
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
    eps: KeyedView<OrImageEndpoint[]>;
    up: KeyedView<OrModelEndpoint[]>;
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

  /**
   * Live prices merged with the registry, or the registry's dated list when this id has no live endpoints (never
   * fetched, failed with no cache, or OpenRouter has no data for it). `at` is this id's own fetch time, set only
   * when a live endpoint answered — a registry price never carries a fetch time.
   */
  const pricesFor = (spec: ImageModelSpec, eps: KeyedView<OrImageEndpoint[]>) => {
    const orId = spec.routes.openrouter;
    const entry = orId ? eps.get(orId) : undefined;
    const fetched = entry?.value?.length ? entry.value : undefined;
    const at = fetched && entry?.fetchedAt !== undefined ? iso(entry.fetchedAt) : undefined;
    const live = fetched ? mapEndpointPricing({ modelId: orId as string, endpoints: fetched, spec, fetchedAt: at }) : null;
    return {
      price: live ? mergeWithRegistry(live.price, spec) : registryPrices(spec),
      perRefUsd: live ? live.perRefUsd : typeof spec.perRefUsd === 'number' ? spec.perRefUsd : null,
      at: live ? at : undefined,
      stale: Boolean(entry?.stale)
    };
  };

  const buildRow = (spec: ImageModelSpec, data: Loaded, ctx: { doc?: ComicDoc; caps?: StudioCaps }): ModelCatalogRow => {
    const orId = spec.routes.openrouter;
    const listed = orId ? data.list.value?.byId.get(orId) : undefined;
    const { price, perRefUsd, at: epsAt, stale: priceStale } = pricesFor(spec, data.eps);
    const upEntry = orId ? data.up.get(orId) : undefined;
    const up = upEntry?.value?.length ? upEntry.value : undefined;
    const current = ctx.doc ? lockedModelId(ctx.doc) === spec.id : undefined;
    const reliability = reliabilityFor(data.yours, { modelId: spec.id, now: now() }) ?? platformReliabilityFor(data.platform24h, spec.id) ?? undefined;
    const canonicalSlug = canonicalSlugFrom(up, orId ?? '');
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
      endpoints: (up ?? []).map((e, _i, all) => ({ provider: endpointLabel(e, all), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m) })),
      quality: qualityEntriesFor(orId, data.q.snapshot),
      observed: observedEntriesFor(data.yours, data.platform, spec.id).filter((o) => ROW_OBSERVED_KINDS.has(o.kind)),
      ...(reliability ? { reliability } : {}),
      ...(ctx.doc && ctx.caps ? { fit: modelFit(spec, ctx.doc, ctx.caps) } : {}),
      ...(current !== undefined ? { current } : {}),
      fetchedAt: {
        ...(epsAt ? { catalog: epsAt } : {}),
        ...(up && upEntry?.fetchedAt !== undefined ? { uptime: iso(upEntry.fetchedAt) } : {}),
        ...(qualityAt ? { quality: qualityAt } : {})
      },
      // This row's own price and uptime sources only; the leaderboard has its own flag.
      stale: Boolean(priceStale || upEntry?.stale),
      qualityStale: Boolean(data.q.stale)
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
        return { id: spec.id, price: p.price, perRefUsd: p.perRefUsd, fetchedAt: p.at ? { catalog: p.at } : {}, stale: p.stale };
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
    for (const [orId, entry] of data.up.entries()) {
      if (!entry.value?.length || entry.fetchedAt === undefined) continue;
      const at = iso(entry.fetchedAt);
      const modelId = registryByOrId.get(orId)?.id ?? orId;
      for (const e of entry.value) {
        const provider = endpointLabel(e, entry.value);
        if (!openrouter.some((o) => o.modelId === modelId && o.provider === provider && o.day === at.slice(0, 10))) openrouter.push({ modelId, provider, day: at.slice(0, 10), uptime1d: num(e.uptime_last_1d), uptime30m: num(e.uptime_last_30m), fetchedAt: at });
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
        note: trackingSince ? `Tracking since ${trackingSince}` : null
      },
      t4: { moves: t4moves, trackingSince: t4since, ...(qualityAsOf(data.q.snapshot) ? { asOf: qualityAsOf(data.q.snapshot) } : {}), source: 'LMArena leaderboard-dataset history we hold (Hugging Face, CC BY 4.0)' },
      t5: { sinceDays: days, models: newModels, ...(data.list.fetchedAt !== undefined ? { fetchedAt: iso(data.list.fetchedAt) } : {}), stale: Boolean(data.list.stale) },
      t6: { ours, openrouter, source: { ours: 'comic_image_calls (24 h / 7 d success and 429 rate)', openrouter: 'OpenRouter uptime_last_1d, captured on each fetch' } },
      t7: top ? { available: true, models: top, sinceDays: CALLS_LOOKBACK_DAYS } : { available: false, copy: NOT_ENOUGH_DATA_COPY, sinceDays: CALLS_LOOKBACK_DAYS }
    };
  };

  return { rows, model, trends, priceSources };
};
