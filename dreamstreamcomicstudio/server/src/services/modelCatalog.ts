// Model catalog service — powers the "Model Library" browse experience.
//
// Fetches the live OpenRouter model list (via the gateway), caches it, and
// layers DreamStream's editorial annotations on top. All reads go through
// getCatalog() so the network call is cached and resilient: on failure we serve
// the last good snapshot and flag the result as degraded.

import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import { annotateModels, type AnnotatedModel } from '../ai/catalogAnnotations.js';

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
  return models;
};

/**
 * Returns the annotated catalog. Uses cache within the TTL; refreshes otherwise.
 * Never throws — on failure it returns the last good snapshot (or empty) with
 * `degraded: true` so the Library page degrades gracefully.
 */
export const getCatalog = async (force = false): Promise<CatalogResult> => {
  const fresh = cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS;
  if (cache && fresh && !force) {
    return { models: cache.models, fetchedAt: cache.fetchedAt, degraded: false };
  }

  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
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

export type CatalogFilters = {
  free?: boolean;
  /** 'image' = image output; 'text' = text output only. */
  modality?: 'image' | 'text';
  /** Only models that accept reference images (character consistency). */
  supportsRefs?: boolean;
  /** Substring search over id/name/description. */
  query?: string;
};

export const filterCatalog = (models: AnnotatedModel[], filters: CatalogFilters): AnnotatedModel[] => {
  const q = filters.query?.trim().toLowerCase();
  return models.filter((model) => {
    if (filters.free && !model.isFree) return false;
    if (filters.modality === 'image' && !model.supportsImageOutput) return false;
    if (filters.modality === 'text' && model.supportsImageOutput) return false;
    if (filters.supportsRefs && !model.supportsImageInput) return false;
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
