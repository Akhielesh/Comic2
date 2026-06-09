// Per-model typical latency (median, from real chat telemetry) so the model picker can
// flag slow models — the durable fix for users unknowingly picking a 60-250s free model.
// Fetched once per session, best-effort (empty map on failure → no badges, no harm).

import { get } from './apiClient';

export interface ModelSpeed {
  p50Ms: number;
  samples: number;
}

let cache: Record<string, ModelSpeed> | null = null;
let inflight: Promise<Record<string, ModelSpeed>> | null = null;

export const fetchModelSpeed = async (): Promise<Record<string, ModelSpeed>> => {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = get<{ models: Record<string, ModelSpeed> }>('/api/models/speed')
    .then((res) => {
      cache = res?.models || {};
      return cache;
    })
    .catch(() => ({} as Record<string, ModelSpeed>))
    .finally(() => { inflight = null; });
  return inflight;
};

export type SpeedTier = 'fast' | 'ok' | 'slow';
export const speedTier = (p50Ms: number): SpeedTier => (p50Ms < 4000 ? 'fast' : p50Ms < 15000 ? 'ok' : 'slow');
export const speedLabel = (p50Ms: number): string => (p50Ms < 1000 ? '<1s' : `~${Math.round(p50Ms / 1000)}s`);

// Static timeout-risk heuristic. Telemetry CAN'T flag a model that ALWAYS times out — it
// never produces a successful p50 sample — so a very large FREE model (the exact failure
// behind the recurring MODEL_TIMEOUT errors, e.g. a 550B :free reasoner queued for minutes)
// would otherwise show no warning at all. Parse the advertised param count from the id and
// warn when a free model is big enough to routinely blow the 60-90s budget. Pure + dep-free.
const LARGE_FREE_PARAM_THRESHOLD_B = 200;

/** Largest "<n>B" parameter count advertised in a model id (e.g. "...-550b-a55b" → 550), else 0. */
export const parseParamCountB = (modelId: string): number => {
  let max = 0;
  for (const m of String(modelId).toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
};

/**
 * True when a FREE model advertises a param count large enough that it routinely times out on
 * the free tier (queued/slow). Used by the picker to warn BEFORE selection, complementing the
 * measured SpeedBadge (which is blank for models that never complete). Paid models are exempt
 * (they route to paid infra and the user opted into the cost), as are models with no advertised
 * size (we don't guess).
 */
export const isTimeoutProneFreeModel = (modelId: string, isFree: boolean): boolean =>
  Boolean(isFree) && parseParamCountB(modelId) >= LARGE_FREE_PARAM_THRESHOLD_B;
