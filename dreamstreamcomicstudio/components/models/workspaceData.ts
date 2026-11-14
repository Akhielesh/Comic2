import type { CatalogModel } from '../../services/modelCatalog';
import type { ModelUsageRow } from '../../services/modelUsageTrends';
import { getModelVendor, getVendorById } from '../../services/modelVendors';
import { productFitForModel } from '../../shared/modelCapabilities';

// An editorial scope, not an invented market-share or quality ranking. Discovery and
// prices still come from the catalog, so this list does not pin obsolete model IDs.
export const FEATURED_MAKERS = ['openai', 'anthropic', 'google', 'deepseek', 'zai', 'qwen', 'mistral', 'xai', 'moonshot', 'minimax'].map(getVendorById);

export function modelMaker(model: CatalogModel) {
  const maker = getModelVendor(model);
  return maker.id !== 'other' ? maker : getVendorById(model.source === 'gemini' ? 'google' : model.source);
}

export function focusedTextModels(models: CatalogModel[]): CatalogModel[] {
  return models.filter((model) => FEATURED_MAKERS.some((maker) => maker.id === modelMaker(model).id)
    && model.outputModalities.includes('text') && !model.supportsImageOutput && model.apiCallable !== false
    && productFitForModel(model, 'chat_studio').allowed);
}

/** Same model via two routes remains two choices; only the initial shortlist is capped. */
export function recentModelsByMaker(models: CatalogModel[], limit = 3): CatalogModel[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  return [...models].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true })).filter((model) => {
    const maker = modelMaker(model).id;
    const identity = `${maker}:${model.id.includes('/') ? model.id.slice(model.id.indexOf('/') + 1) : model.id}`;
    if (seen.has(identity)) return false;
    const count = counts.get(maker) ?? 0;
    if (count >= limit) return false;
    counts.set(maker, count + 1);
    seen.add(identity);
    return true;
  });
}

export function knownTokenPrice(model: CatalogModel, axis: 'input' | 'output'): number | null {
  if (model.pricingKnown === false) return null;
  const price = model.pricing[axis === 'input' ? 'promptPerToken' : 'completionPerToken'];
  return Number.isFinite(price) && price >= 0 && (price > 0 || model.isFree) ? price * 1_000_000 : null;
}

export const formatContext = (length?: number): string => !length ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(length);
export const formatLatency = (ms?: number | null): string => ms == null || !Number.isFinite(ms) ? '—' : `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`;
export const formatDate = (at?: number | string | null): string => {
  if (!at || !Number.isFinite(new Date(at).getTime())) return 'Not reported';
  // A publisher's calendar date is not a UTC instant to shift into yesterday in New York.
  const dateOnly = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at);
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) });
};

export const modelKey = (model: Pick<CatalogModel, 'source' | 'id'>): string => `${model.source}:${model.id}`;

/** Unknown prices must not masquerade as zero, including while an older cache is on screen. */
export function modelPrice(model: CatalogModel, axis: 'input' | 'output' | 'image'): string {
  if (model.pricingKnown === false) return 'Not reported';
  const value = axis === 'image' ? model.pricing.imagePerImage : model.pricing[axis === 'input' ? 'promptPerToken' : 'completionPerToken'];
  if (!Number.isFinite(value) || value < 0) return 'Not reported';
  if (value === 0) return model.isFree ? '$0' : 'Not reported';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: axis === 'image' ? 4 : 3 }).format(value * (axis === 'image' ? 1 : 1_000_000));
}

export function modelCapabilities(model: CatalogModel): string[] {
  const labels: string[] = [];
  if (model.outputModalities.includes('text')) labels.push('Text');
  if (model.supportsImageOutput) labels.push('Image generation');
  if (model.supportsImageInput) labels.push('Vision');
  if (model.supportedParameters.includes('tools')) labels.push('Tools');
  if (model.supportedParameters.includes('reasoning')) labels.push('Reasoning');
  return labels.length ? labels : ['Capabilities not reported'];
}

export function summarizeUsage(rows: ModelUsageRow[]) {
  const monthly = new Map<string, number>();
  const models = new Map<string, { id: string; model: string; source: string; requests: number }>();
  for (const row of rows) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) || !Number.isFinite(row.requests) || row.requests < 0) continue;
    monthly.set(row.month, (monthly.get(row.month) ?? 0) + row.requests);
    const id = `${row.source}:${row.model}`;
    const current = models.get(id) ?? { id, model: row.model || 'Unspecified model', source: row.source, requests: 0 };
    current.requests += row.requests;
    models.set(id, current);
  }
  return {
    monthly: [...monthly].sort(([a], [b]) => a.localeCompare(b)).map(([month, requests]) => ({ month, requests })),
    models: [...models.values()].sort((a, b) => b.requests - a.requests),
    total: [...monthly.values()].reduce((sum, count) => sum + count, 0)
  };
}
