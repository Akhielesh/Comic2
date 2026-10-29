// Provider / model health (reliability.md §1). Pure and dependency-free: the server combines OpenRouter's
// public endpoint data with its own observed outcomes through these two functions, and the client renders
// the result. Nothing here fetches, times or spends.
//
// Rules (reliability.md §1):
//  - Observed: a route with ≥ HEALTH_THRESHOLDS.breakerFailures upstream failures (429 / 5xx / network — never
//    key, billing or safety errors, which the server leaves out of `upstreamFailures`) inside breakerWindowMs and
//    no success since is `down` for breakerOpenMs after its last failure; then it is half-open (one call is
//    allowed), reported as `degraded`.
//  - Public: every provider with `status !== 0`, or the best uptime30m below downUptime30m → `down`;
//    below degradedUptime30m → `degraded`; no data → `unknown`. A provider with neither a status nor a
//    30-minute uptime carries no data and is never counted as serving. Unknown never blocks a run.
//  - Both: the worse state wins; `unknown` on one side defers to the other.

import type { ImageRoute } from './models.js';

export type HealthState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ProviderHealth {
  name: string;
  /** OpenRouter endpoint status: 0 = serving; anything else = the provider reports a problem. null = unknown. */
  status: number | null;
  uptime30m: number | null;
  uptime1d: number | null;
}

export interface RouteHealth {
  route: ImageRoute;
  /** Provider model id on that route. */
  model: string;
  state: HealthState;
  /** OpenRouter public endpoints data (route 'openrouter' only). */
  providers?: ProviderHealth[];
  /** Our own outcomes on this route+model inside the breaker window (key-scoped failures are never counted). */
  observed?: { ok: number; upstreamFailures: number; lastCode?: string; lastFailureAt?: number; lastSuccessAt?: number };
  /** Short, user-safe. */
  reason?: string;
  checkedAt: number;
  source: 'openrouter' | 'observed' | 'none';
}

export interface ModelHealth {
  modelId: string;
  state: HealthState;
  routes: RouteHealth[];
  checkedAt: number;
}

export const HEALTH_THRESHOLDS = {
  degradedUptime30m: 95,
  downUptime30m: 70,
  breakerFailures: 3,
  breakerWindowMs: 5 * 60_000,
  breakerOpenMs: 2 * 60_000
} as const;

export interface RunPreflight {
  ok: boolean;
  useRoute?: ImageRoute;
  blocked?: { modelId: string; state: HealthState; reason: string }[];
  options: OutageOption[];
}

export type OutageOption =
  /** Free; the client re-checks while the page is open. */
  | { kind: 'wait_and_retry'; etaHint?: string }
  /** Same model, same payer (no look change). */
  | { kind: 'other_route'; route: ImageRoute; label: string }
  | {
      kind: 'switch_model';
      modelId: string;
      nickname: string;
      usdPerImage: number;
      consistency: 'same_family' | 'different';
      redrawCount: number;
      redrawUsd: number;
    }
  /** e.g. add a Gemini key to reach the Gemini-direct route. */
  | { kind: 'add_key'; route: ImageRoute; label: string };

export const OUTAGE_OPTION_KINDS: readonly OutageOption['kind'][] = ['wait_and_retry', 'other_route', 'switch_model', 'add_key'];
const IMAGE_ROUTES: ReadonlySet<string> = new Set<ImageRoute>(['openrouter', 'gemini']);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** A well-formed OutageOption (unknown kinds and malformed fields → undefined). Pure; never throws. */
export const normalizeOutageOption = (value: unknown): OutageOption | undefined => {
  if (!isObject(value)) return undefined;
  switch (value.kind) {
    case 'wait_and_retry':
      return nonEmpty(value.etaHint) ? { kind: 'wait_and_retry', etaHint: value.etaHint } : { kind: 'wait_and_retry' };
    case 'other_route':
    case 'add_key':
      if (!IMAGE_ROUTES.has(String(value.route)) || !nonEmpty(value.label)) return undefined;
      return { kind: value.kind, route: value.route as ImageRoute, label: value.label };
    case 'switch_model': {
      if (!nonEmpty(value.modelId) || !nonEmpty(value.nickname)) return undefined;
      if (!isFiniteNumber(value.usdPerImage) || value.usdPerImage < 0) return undefined;
      if (value.consistency !== 'same_family' && value.consistency !== 'different') return undefined;
      if (!isFiniteNumber(value.redrawCount) || value.redrawCount < 0 || !isFiniteNumber(value.redrawUsd) || value.redrawUsd < 0) return undefined;
      return {
        kind: 'switch_model',
        modelId: value.modelId,
        nickname: value.nickname,
        usdPerImage: value.usdPerImage,
        consistency: value.consistency,
        redrawCount: Math.floor(value.redrawCount),
        redrawUsd: value.redrawUsd
      };
    }
    default:
      return undefined;
  }
};

const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };
const worse = (a: HealthState, b: HealthState): HealthState => (RANK[a] >= RANK[b] ? a : b);

const describeCode = (code?: string): string => (code ? ` (${code})` : '');

/** Public endpoint data alone. */
const assessPublic = (providers: ProviderHealth[] | undefined): Pick<RouteHealth, 'state' | 'reason'> => {
  if (!providers || !providers.length) return { state: 'unknown' };
  // Evidence only: a provider with status null and no 30-minute uptime says nothing (reliability.md §1 "no data →
  // unknown"); it must never make a route 'ok'. An explicit status 0, or a numeric uptime, is evidence of serving.
  const known = providers.filter((p) => p.status !== null || isFiniteNumber(p.uptime30m));
  if (!known.length) return { state: 'unknown' };
  const serving = known.filter((p) => p.status === 0 || (p.status === null && isFiniteNumber(p.uptime30m)));
  if (!serving.length) return { state: 'down', reason: 'Every provider reports a problem' };
  const uptimes = serving.map((p) => p.uptime30m).filter((u): u is number => isFiniteNumber(u));
  if (!uptimes.length) return { state: 'ok' };
  const best = Math.max(...uptimes);
  if (best < HEALTH_THRESHOLDS.downUptime30m) return { state: 'down', reason: `Provider uptime ${Math.round(best)}% in the last 30 min` };
  if (best < HEALTH_THRESHOLDS.degradedUptime30m) return { state: 'degraded', reason: `Provider uptime ${Math.round(best)}% in the last 30 min` };
  return { state: 'ok' };
};

/** Our own outcomes alone (the breaker). */
const assessObserved = (observed: RouteHealth['observed'] | undefined, now: number): Pick<RouteHealth, 'state' | 'reason'> => {
  if (!observed) return { state: 'unknown' };
  const ok = isFiniteNumber(observed.ok) ? observed.ok : 0;
  const failures = isFiniteNumber(observed.upstreamFailures) ? observed.upstreamFailures : 0;
  if (ok === 0 && failures === 0) return { state: 'unknown' };
  const lastFailureAt = isFiniteNumber(observed.lastFailureAt) ? observed.lastFailureAt : undefined;
  const lastSuccessAt = isFiniteNumber(observed.lastSuccessAt) ? observed.lastSuccessAt : undefined;
  const successSince = lastSuccessAt !== undefined && (lastFailureAt === undefined || lastSuccessAt >= lastFailureAt);
  if (failures === 0 || successSince) return { state: 'ok' };
  if (failures >= HEALTH_THRESHOLDS.breakerFailures) {
    const since = lastFailureAt !== undefined ? now - lastFailureAt : 0;
    if (since < HEALTH_THRESHOLDS.breakerOpenMs) return { state: 'down', reason: `Our last ${failures} calls failed${describeCode(observed.lastCode)}` };
    return { state: 'degraded', reason: `Retrying after ${failures} failed calls${describeCode(observed.lastCode)}` };
  }
  return { state: 'degraded', reason: `Our last call failed${describeCode(observed.lastCode)}` };
};

/** Pure: combine public provider data and our own observations into one state per route. */
export function assessRouteHealth(input: { providers?: ProviderHealth[]; observed?: RouteHealth['observed']; now: number }): Pick<RouteHealth, 'state' | 'reason'> {
  const pub = assessPublic(input.providers);
  const obs = assessObserved(input.observed, input.now);
  if (pub.state === 'unknown') return obs;
  if (obs.state === 'unknown') return pub;
  const state = worse(pub.state, obs.state);
  const reason = state === obs.state ? obs.reason : pub.reason;
  return reason ? { state, reason } : { state };
}

/** Best reachable route wins; `unknown` never blocks; no routes → unknown. */
export function combineModelHealth(routes: RouteHealth[]): HealthState {
  if (!routes.length) return 'unknown';
  const states = routes.map((r) => r.state);
  if (states.includes('ok')) return 'ok';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('unknown')) return 'unknown';
  return 'down';
}
