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

export type CatalogResult = {
  models: AnnotatedModel[];
  fetchedAt: number | null;
  degraded: boolean;
  message?: string;
};

const refresh = async (): Promise<AnnotatedModel[]> => {
  const provider = getProvider();
  const raw = await provider.listModels(resolveProviderContext());
  const models = annotateModels(raw);
  cache = { models, fetchedAt: Date.now() };
  // Durable index: mirror the live OpenRouter catalog into Supabase so cold starts can serve it
  // instantly (stale-while-revalidate) instead of doing a slow live fetch on the request path.
  // Fire-and-forget; never blocks or throws into the request.
  void persistHarvestedModels('openrouter', models);
  return models;
};

/** Kick a live refresh without awaiting it; swallows errors so callers stay responsive. */
const refreshInBackground = (): void => {
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  inflight.catch(() => { /* logged elsewhere; stale data already served */ });
};

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
  if (!cache && !force) {
    const persisted = await loadPersistedModels('openrouter');
    if (persisted.length) {
      cache = { models: persisted, fetchedAt: 0 }; // fetchedAt 0 = treat as stale so it revalidates
      refreshInBackground();
      return { models: persisted, fetchedAt: null, degraded: false };
    }
  }

  // 4. Nothing to serve (or a forced refresh): we must await a live fetch.
  if (!inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  try {
    const models = await inflight;
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
 * Warm the in-memory catalog at server boot so the very first request is instant. Tries the durable
 * index first (fast), then kicks a background live refresh. Safe to call unconditionally; never throws.
 */
export const prewarmCatalog = async (): Promise<void> => {
  try {
    if (!cache) {
      const persisted = await loadPersistedModels('openrouter');
      if (persisted.length) cache = { models: persisted, fetchedAt: 0 };
    }
    refreshInBackground();
  } catch {
    /* boot must never fail because the catalog couldn't warm */
  }
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
