import { get } from './apiClient';

export type Band = 'free' | 'low' | 'medium' | 'high';
export type DreamStreamRole = 'text-brain' | 'dialogue' | 'panel-art' | 'cover' | 'qc';

export interface CatalogModel {
  id: string;
  name: string;
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
  isFree: boolean;
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
  fetchedAt: number | null;
  degraded: boolean;
  message?: string;
}

export interface CatalogQuery {
  free?: boolean;
  modality?: 'image' | 'text';
  refs?: boolean;
  q?: string;
}

export const fetchModelCatalog = (query: CatalogQuery = {}): Promise<CatalogResponse> => {
  const params = new URLSearchParams();
  if (query.free) params.set('free', 'true');
  if (query.modality) params.set('modality', query.modality);
  if (query.refs) params.set('refs', 'true');
  if (query.q) params.set('q', query.q);
  const qs = params.toString();
  return get<CatalogResponse>(`/api/models/catalog${qs ? `?${qs}` : ''}`);
};

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
  const slash = model.id.indexOf('/');
  return slash > 0 ? model.id.slice(0, slash) : 'openrouter';
};
