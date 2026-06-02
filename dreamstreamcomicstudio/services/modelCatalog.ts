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
}

export const fetchModelCatalog = (query: CatalogQuery = {}): Promise<CatalogResponse> => {
  const params = new URLSearchParams();
  if (query.free) params.set('free', 'true');
  if (query.modality) params.set('modality', query.modality);
  if (query.refs) params.set('refs', 'true');
  if (query.source) params.set('source', query.source);
  if (query.q) params.set('q', query.q);
  const qs = params.toString();
  return get<CatalogResponse>(`/api/models/catalog${qs ? `?${qs}` : ''}`);
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
      };
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

export const providerOrigin = (model: CatalogModel): string => {
  // Prefer the authoritative source from the server; fall back to the id prefix.
  if (model.source) return model.source;
  const slash = model.id.indexOf('/');
  return slash > 0 ? model.id.slice(0, slash) : 'openrouter';
};
