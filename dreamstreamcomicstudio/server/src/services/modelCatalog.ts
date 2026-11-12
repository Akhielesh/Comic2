// Model catalog service — powers the "Model Library" browse experience.
//
// Fetches the live OpenRouter model list (via the gateway), caches it, and
// layers DreamStream's editorial annotations on top. All reads go through
// getCatalog() so the network call is cached and resilient: on failure we serve
// the last good snapshot and flag the result as degraded.

import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import { annotateModels, type AnnotatedModel } from '../ai/catalogAnnotations.js';
import { persistHarvestedModels, loadPersistedModels } from './modelCatalogStore.js';
import { productFitForModel } from '../../../shared/modelCapabilities.js';
import type { AIProviderId } from '../ai/providers/types.js';

const CATALOG_TTL_MS = (() => {
  const raw = Number(process.env.MODEL_CATALOG_TTL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60_000; // default 1h
})();

type CatalogSnapshot = {
  models: AnnotatedModel[];
  fetchedAt: number;
};

let cache: CatalogSnapshot | null = null;
let inflight: Promise<AnnotatedModel[]> | null = null;
/** The boot warm-up (prewarmCatalog), shared: a cold request during it waits for it instead of reading again. */
let bootWarm: Promise<void> | null = null;

/**
 * How long the boot warm-up waits for the live list before it reads the durable index (EGRESS-DB E4). The live
 * OpenRouter list is public and anonymous, so warming from it costs no Supabase egress; the ~0.9 MB index read
 * was paid on every container wake.
 */
export const PREWARM_LIVE_BUDGET_MS = 4_000;

/**
 * How long a cold request waits for the boot warm-up before it is served from the durable index (the live list
 * usually answers well within it). It is the warm-up's own fallback read, shared, so the index is still read at
 * most once per boot; the live list replaces it when it lands.
 */
export const COLD_REQUEST_WAIT_MS = 1_200;

/** The boot's one read of the durable index into the memory cache, shared by the warm-up and a cold request. */
let indexWarm: Promise<void> | null = null;
const warmFromIndex = (): Promise<void> => {
  if (!indexWarm) {
    indexWarm = (async () => {
      if (cache) return;
      const persisted = await loadPersistedModels('openrouter');
      if (persisted.length && !cache) cache = { models: persisted, fetchedAt: 0 };
    })().catch(() => { /* a failed read leaves the live list to answer */ });
  }
  return indexWarm;
};

export type CatalogResult = {
  models: AnnotatedModel[];
  fetchedAt: number | null;
  degraded: boolean;
  message?: string;
};

const refresh = async (): Promise<AnnotatedModel[]> => {
  const provider = getProvider();
  // OpenRouter's /models is a PUBLIC list — fetch it ANONYMOUSLY so a rate-limited,
  // throttled or invalid platform key can never starve the catalog (defense-in-depth
  // around the outage). NVIDIA's /models needs auth, so it keeps the platform key.
  const ctx = provider.id === 'openrouter' ? undefined : resolveProviderContext(undefined, provider.id);
  const raw = await provider.listModels(ctx);
  const models = annotateModels(raw);
  // RESILIENCE: OpenRouter's /models is a large public list. A zero/empty result is a
  // transient upstream blip (rate-limit, cold-start, momentary outage), NOT "the catalog
  // is empty now". Caching it would serve an empty catalog for a full TTL AND persisting
  // it would clobber the durable Supabase index — exactly the "OpenRouter models
  // disappeared" outage. Treat empty as a FAILED refresh: throw so getCatalog() keeps
  // serving the last-good in-memory/Supabase snapshot, and never overwrite either with [].
  if (models.length === 0) {
    throw new Error('Model source returned an empty list — keeping the last-good catalog.');
  }
  cache = { models, fetchedAt: Date.now() };
  // Durable index: mirror the live OpenRouter catalog into Supabase so cold starts can serve it
  // instantly (stale-while-revalidate) instead of doing a slow live fetch on the request path.
  // Fire-and-forget; never blocks or throws into the request.
  void persistHarvestedModels('openrouter', models);
  return models;
};

/** The live refresh in flight, or a new one (one at a time). */
const startRefresh = (): Promise<AnnotatedModel[]> => {
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  return inflight;
};

/** Kick a live refresh without awaiting it; swallows errors so callers stay responsive. */
const refreshInBackground = (): void => {
  startRefresh().catch(() => { /* logged elsewhere; stale data already served */ });
};

/** True when `promise` resolves within `ms`; false when it rejects or takes longer (it keeps running). */
const resolvesWithin = (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); }
    );
  });

/**
 * Returns the annotated catalog with a stale-while-revalidate strategy so the Model Library is
 * always fast and never blank:
 *   1. Fresh in-memory snapshot → serve instantly.
 *   2. Stale in-memory snapshot → serve instantly, refresh in the background.
 *   3. Cold start (no memory) → serve the durable Supabase index instantly, refresh in background.
 *   4. Nothing cached anywhere (or forced) → await a live fetch.
 * Never throws — on total failure it returns the last snapshot (or empty) flagged `degraded`.
 */
export const getCatalog = async (force = false): Promise<CatalogResult> => {
  // A cold request during the boot warm-up waits for it briefly (its live list); past COLD_REQUEST_WAIT_MS it takes
  // the warm-up's one fallback read of the durable index (shared, never a second read) instead of waiting out the
  // whole live budget.
  if (!cache && !force && bootWarm && !(await resolvesWithin(bootWarm, COLD_REQUEST_WAIT_MS)) && !cache) await warmFromIndex();
  // Step 3 below reads the index itself only when no warm-up has run (or could read it).
  const indexTried = indexWarm !== null;
  const fresh = cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS;

  // 1. Fresh memory cache.
  if (cache && fresh && !force) {
    return { models: cache.models, fetchedAt: cache.fetchedAt, degraded: false };
  }

  // 2. Stale memory cache → serve now, revalidate in background.
  if (cache && !force) {
    refreshInBackground();
    return { models: cache.models, fetchedAt: cache.fetchedAt, degraded: false };
  }

  // 3. Cold start → hydrate from the durable index and serve immediately, revalidate in background.
  if (!cache && !force && !indexTried) {
    const persisted = await loadPersistedModels('openrouter');
    if (persisted.length) {
      cache = { models: persisted, fetchedAt: 0 }; // fetchedAt 0 = treat as stale so it revalidates
      refreshInBackground();
      return { models: persisted, fetchedAt: null, degraded: false };
    }
  }

  // 4. Nothing to serve (or a forced refresh): we must await a live fetch.
  try {
    const models = await startRefresh();
    return { models, fetchedAt: cache?.fetchedAt ?? Date.now(), degraded: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load model catalog.';
    return {
      models: cache?.models ?? [],
      fetchedAt: cache?.fetchedAt ?? null,
      degraded: true,
      message
    };
  }
};

/**
 * Warm the in-memory catalog at server boot so the very first request is instant. The live (public, anonymous)
 * list comes first; the durable index is read only when the live list fails or takes longer than
 * PREWARM_LIVE_BUDGET_MS, and then the live refresh keeps going and replaces it. One warm-up per process, shared
 * with the cold path of getCatalog. Safe to call unconditionally; never throws.
 */
export const prewarmCatalog = (): Promise<void> => {
  if (!bootWarm) {
    bootWarm = (async () => {
      try {
        if (cache) return;
        if (await resolvesWithin(startRefresh(), PREWARM_LIVE_BUDGET_MS)) return;
        if (cache) return;
        await warmFromIndex();
      } catch {
        /* boot must never fail because the catalog couldn't warm */
      }
    })();
  }
  return bootWarm;
};

/** Start a periodic in-process refresh so the catalog stays warm without depending on traffic. */
export const startCatalogRefreshLoop = (intervalMs = CATALOG_TTL_MS): NodeJS.Timeout => {
  const timer = setInterval(() => refreshInBackground(), Math.max(60_000, intervalMs));
  timer.unref?.(); // don't keep the process alive solely for this
  return timer;
};

export type CatalogFilters = {
  free?: boolean;
  /** 'image' = image output; 'text' = text output only. */
  modality?: 'image' | 'text';
  /** Only models that accept reference images (character consistency). */
  supportsRefs?: boolean;
  /** Filter by upstream source (openrouter | nvidia). */
  source?: AIProviderId;
  /** Substring search over id/name/description. */
  query?: string;
  /**
   * Restrict to models usable in a given product (chat_studio | stream_studio |
   * comic_studio): drops special-purpose kinds (safety classifiers, code-apply
   * engines, routers, media models) and models missing required capabilities.
   */
  product?: string;
};

/** Fetch + annotate models from a specific provider (used to merge BYOK sources like NVIDIA). */
export const getProviderModels = async (
  providerId: AIProviderId,
  apiKey?: string | null
): Promise<AnnotatedModel[]> => {
  try {
    const raw = await getProvider(providerId).listModels(resolveProviderContext(apiKey, providerId));
    return annotateModels(raw);
  } catch {
    return [];
  }
};

export const filterCatalog = (models: AnnotatedModel[], filters: CatalogFilters): AnnotatedModel[] => {
  const q = filters.query?.trim().toLowerCase();
  return models.filter((model) => {
    if (filters.product && !productFitForModel(model, filters.product).allowed) return false;
    if (filters.free && !model.isFree) return false;
    if (filters.modality === 'image' && !model.supportsImageOutput) return false;
    if (filters.modality === 'text' && model.supportsImageOutput) return false;
    if (filters.supportsRefs && !model.supportsImageInput) return false;
    if (filters.source && model.source !== filters.source) return false;
    if (q) {
      const haystack = `${model.id} ${model.name} ${model.description || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
};

/** Convenience used by generation defaults / Studio-mode pickers. */
export const getFreeModels = async (): Promise<AnnotatedModel[]> => {
  const { models } = await getCatalog();
  return models.filter((model) => model.isFree);
};
