import { get } from './apiClient';
import type { CostClass } from '../shared/pricing';

export type Band = 'free' | 'low' | 'medium' | 'high';
export type DreamStreamRole = 'text-brain' | 'dialogue' | 'panel-art' | 'cover' | 'qc';

export type ModelSource = 'openrouter' | 'nvidia';

export interface CatalogModel {
  id: string;
  name: string;
  /** Upstream source this model came from (drives the Library "source" filter). */
  source: ModelSource;
  description?: string;
  contextLength?: number;
  /** Unix seconds the model was published upstream (for "newest" sorting). */
  createdAt?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: {
    promptPerToken: number;
    completionPerToken: number;
    imagePerImage: number;
    requestFlat: number;
  };
  /** True only when costClass === 'free_verified' (id ends ':free' or all 4 axes are 0). */
  isFree: boolean;
  /** Multi-dimensional cost class — see shared/pricing.ts. */
  costClass: CostClass;
  supportsImageOutput: boolean;
  supportsImageInput: boolean;
  supportsJsonOutput: boolean;
  roles: DreamStreamRole[];
  costBand: Band;
  drawbacks: string[];
  possibilities: string[];
  editorialNote?: string;
  /** Hosted-API callability: false = listed but download-only / not callable via the
   *  hosted API (e.g. NVIDIA NIMs you must self-host). undefined = not yet probed. */
  apiCallable?: boolean;
}

export interface CatalogResponse {
  models: CatalogModel[];
  count: number;
  total: number;
  sources?: { openrouter: number; nvidia: number };
  fetchedAt: number | null;
  degraded: boolean;
  message?: string;
}

export interface CatalogQuery {
  free?: boolean;
  modality?: 'image' | 'text';
  refs?: boolean;
  source?: ModelSource;
  q?: string;
  /** Capability-gated list for a studio: drops safety classifiers, code-apply
   *  engines, routers and media models that can never work as that product's
   *  chat model (server enforces the same rule at request time). */
  product?: 'chat_studio' | 'stream_studio' | 'comic_studio';
}

// Last-good catalog kept in localStorage so the Library paints instantly on revisit/refresh and
// survives a backend hiccup (e.g. a cold start that times out) instead of showing a blank spinner.
const CATALOG_CACHE_KEY = 'dreamstream_model_catalog_v1';
const CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000; // a day; it's only a fast-paint fallback

export const loadCachedCatalog = (): CatalogResponse | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; data: CatalogResponse };
    if (!parsed?.data?.models?.length) return null;
    if (Date.now() - parsed.at > CATALOG_CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
};

const saveCachedCatalog = (data: CatalogResponse) => {
  if (typeof window === 'undefined' || !data?.models?.length) return;
  try {
    window.localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* ignore quota errors */
  }
};

/**
 * Fetch the catalog with a hard timeout and one retry, so the UI never hangs forever on a stalled
 * request (the HTTP/2 reset we saw on cold starts). On success the result is cached locally.
 */
export const fetchModelCatalog = async (query: CatalogQuery = {}, opts?: { timeoutMs?: number; retries?: number }): Promise<CatalogResponse> => {
  const params = new URLSearchParams();
  if (query.free) params.set('free', 'true');
  if (query.modality) params.set('modality', query.modality);
  if (query.refs) params.set('refs', 'true');
  if (query.source) params.set('source', query.source);
  if (query.q) params.set('q', query.q);
  if (query.product) params.set('product', query.product);
  const qs = params.toString();
  const path = `/api/models/catalog${qs ? `?${qs}` : ''}`;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const retries = opts?.retries ?? 1;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const data = await get<CatalogResponse>(path, { signal: controller.signal });
      saveCachedCatalog(data);
      return data;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to load the model catalog.');
};

/** Live verification: what we SHOW reconciled against each source's real API data. */
export interface ModelVerification {
  verifiedAt: number;
  catalog: { fetchedAt: number | null; degraded: boolean; message?: string; total: number; freeCount: number };
  sources: {
    openrouter: {
      connected: boolean;
      modelCount: number;
      liveKey: null | {
        label?: string;
        usage?: number;
        limit?: number | null;
        limit_remaining?: number | null;
        is_free_tier?: boolean;
        usage_monthly?: number;
        byok_usage_monthly?: number;
        /** Per-key rate limit, when the source reports one. */
        rate_limit?: { requests?: number; interval?: string } | null;
      };
      /** Account-level credits (distinct from the per-key limit above). */
      credits?: { total: number; usage: number; remaining: number } | null;
    };
    nvidia: { connected: boolean; modelCount: number; note?: string };
  };
}

export const fetchModelVerification = (): Promise<ModelVerification> =>
  get<ModelVerification>('/api/models/verify');

/** Human-readable cost label, product-friendly (per image / per 1M output tokens). */
export const costLabel = (model: CatalogModel): string => {
  if (model.isFree || model.costBand === 'free') return 'Free';
  if (model.supportsImageOutput) {
    return `$${model.pricing.imagePerImage.toFixed(3)}/img`;
  }
  const perMillion = model.pricing.completionPerToken * 1_000_000;
  return `$${perMillion.toFixed(2)}/M out`;
};

/** Friendly, display-ready source labels — used everywhere a source is shown. */
export const SOURCE_LABEL: Record<ModelSource, string> = {
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA'
};

/** Map a source id (or any provider string) to its display label. Empty for null. */
export const sourceLabel = (source?: ModelSource | string | null): string => {
  if (!source) return '';
  return SOURCE_LABEL[source as ModelSource] || String(source);
};

export const providerOrigin = (model: CatalogModel): string => {
  // Prefer the authoritative source from the server; fall back to the id prefix.
  if (model.source) return model.source;
  const slash = model.id.indexOf('/');
  return slash > 0 ? model.id.slice(0, slash) : 'openrouter';
};
