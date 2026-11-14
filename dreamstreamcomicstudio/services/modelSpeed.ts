// Per-model typical latency (median, from real chat telemetry) so the model picker can
// flag slow models — the durable fix for users unknowingly picking a 60-250s free model.
// Cached briefly, best-effort (empty map on failure → no badges, no harm).

import { get } from './apiClient';

export interface ModelSpeed {
  p50Ms: number;
  samples: number;
}

export interface ModelSpeedReport {
  models: Record<string, ModelSpeed>;
  /** Time the server assembled the observation window; null when unavailable. */
  measuredAt: number | null;
  windowDays: number;
  sampleLimit: number;
  capped: boolean;
  status: 'available' | 'empty' | 'unavailable';
  measurement: 'chat_turn_latency_without_tools';
  sourceScope: 'pooled';
}

const CACHE_TTL_MS = 120_000;
let cache: { at: number; report: ModelSpeedReport } | null = null;
let inflight: Promise<ModelSpeedReport> | null = null;
const unavailable = (): ModelSpeedReport => ({
  models: {}, measuredAt: null, windowDays: 7, sampleLimit: 8000, capped: false,
  status: 'unavailable', measurement: 'chat_turn_latency_without_tools', sourceScope: 'pooled'
});

export const fetchModelSpeedReport = async (opts?: { refresh?: boolean }): Promise<ModelSpeedReport> => {
  if (!opts?.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.report;
  if (inflight) return inflight;
  inflight = get<ModelSpeedReport>('/api/models/speed')
    .then((res) => {
      const report = { ...unavailable(), ...res, models: res?.models || {} };
      cache = { at: Date.now(), report };
      return report;
    })
    .catch(unavailable)
    .finally(() => { inflight = null; });
  return inflight;
};

export const fetchModelSpeed = async (): Promise<Record<string, ModelSpeed>> =>
  (await fetchModelSpeedReport()).models;

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
