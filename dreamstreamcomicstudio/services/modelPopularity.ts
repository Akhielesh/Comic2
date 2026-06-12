// "What DreamStream users run" — aggregated, anonymized model popularity rankings.
//
// Backend contract (parallel workstream; may not exist yet — degrades to `null` on
// 404/error so the panel hides itself):
//   GET /api/models/popularity?window=week|month|all
//     → { window, generatedAt, models: [{ model, provider, requests, users, sharePct }] }
// The server caches hourly; surface `generatedAt` as "updated Xm ago".

import { get } from './apiClient';

export type PopularityWindow = 'week' | 'month' | 'all';

export interface ModelPopularityRow {
  model: string;
  provider: string;
  requests: number;
  users: number;
  sharePct: number;
}

export interface ModelPopularity {
  window: string;
  generatedAt: string;
  models: ModelPopularityRow[];
}

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Popularity for a window, or null when the endpoint is missing/erroring/empty (hide the panel). */
export const fetchModelPopularity = async (
  window: PopularityWindow,
  options?: { signal?: AbortSignal }
): Promise<ModelPopularity | null> => {
  try {
    const raw = await get<{ window?: string; generatedAt?: string; models?: unknown[] }>(
      `/api/models/popularity?window=${window}`,
      options
    );
    if (!raw || !Array.isArray(raw.models)) return null;
    const models: ModelPopularityRow[] = raw.models
      .filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object')
      .filter((m) => typeof m.model === 'string' && m.model.length > 0)
      .map((m) => ({
        model: m.model as string,
        provider: typeof m.provider === 'string' ? m.provider : '',
        requests: asNumber(m.requests),
        users: asNumber(m.users),
        sharePct: Math.max(0, asNumber(m.sharePct))
      }));
    if (models.length === 0) return null;
    return {
      window: typeof raw.window === 'string' ? raw.window : window,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      models
    };
  } catch {
    return null;
  }
};
