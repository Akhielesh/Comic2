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
