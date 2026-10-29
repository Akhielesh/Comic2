// Model health over HTTP (reliability.md §2 route, §4 admin): `/api/comic/models/status` and its admin twin.
// Both answers are validated field by field here, so a newer or broken server never reaches the UI as
// anything but well-formed ModelHealth (unknown fields dropped, malformed rows skipped). Requests go through
// services/apiClient (auth token + the user's own provider-key headers, so the server reports the routes THIS
// user can reach). Nothing here polls; callers decide when to ask (useModelStatus).

import { get } from '../../../services/apiClient';
import { toStudioApiError } from '../studioApi';
import type { ImageRoute } from '../../../shared/comic/models';
import type { HealthState, ModelHealth, ProviderHealth, RouteHealth } from '../../../shared/comic/modelHealth';

export const MODEL_STATUS_PATH = '/api/comic/models/status';
export const PROVIDER_STATUS_ADMIN_PATH = '/api/comic/models/status/admin';
/** The server answers at most this many ids per call (routes/comicModelStatus.ts MODEL_STATUS_MAX_IDS). */
export const MODEL_STATUS_MAX_IDS = 20;

const STATES: ReadonlySet<string> = new Set<HealthState>(['ok', 'degraded', 'down', 'unknown']);
const ROUTES: ReadonlySet<string> = new Set<ImageRoute>(['openrouter', 'gemini']);
const SOURCES: ReadonlySet<string> = new Set<RouteHealth['source']>(['openrouter', 'observed', 'none']);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const numOrNull = (v: unknown): number | null => num(v) ?? null;
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s || undefined;
};

const asProvider = (v: unknown): ProviderHealth | undefined => {
  if (!isObject(v)) return undefined;
  const name = text(v.name, 60);
  if (!name) return undefined;
  return { name, status: numOrNull(v.status), uptime30m: numOrNull(v.uptime30m), uptime1d: numOrNull(v.uptime1d) };
};

const asObserved = (v: unknown): RouteHealth['observed'] | undefined => {
  if (!isObject(v)) return undefined;
  const ok = num(v.ok);
  const upstreamFailures = num(v.upstreamFailures);
  if (ok === undefined || upstreamFailures === undefined) return undefined;
  const lastCode = text(v.lastCode, 40);
  const lastFailureAt = num(v.lastFailureAt);
  const lastSuccessAt = num(v.lastSuccessAt);
  return {
    ok,
    upstreamFailures,
    ...(lastCode ? { lastCode } : {}),
    ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {})
  };
};

/** A well-formed RouteHealth, or undefined. Pure. */
export const asRouteHealth = (v: unknown): RouteHealth | undefined => {
  if (!isObject(v) || !ROUTES.has(String(v.route)) || !STATES.has(String(v.state))) return undefined;
  const model = text(v.model, 120);
  const checkedAt = num(v.checkedAt);
  if (!model || checkedAt === undefined) return undefined;
  const providers = Array.isArray(v.providers) ? v.providers.map(asProvider).filter((p): p is ProviderHealth => !!p).slice(0, 20) : undefined;
  const observed = asObserved(v.observed);
  const reason = text(v.reason, 160);
  return {
    route: v.route as ImageRoute,
    model,
    state: v.state as HealthState,
    ...(providers ? { providers } : {}),
    ...(observed ? { observed } : {}),
    ...(reason ? { reason } : {}),
    checkedAt,
    source: SOURCES.has(String(v.source)) ? (v.source as RouteHealth['source']) : 'none'
  };
};

/** A well-formed ModelHealth, or undefined. Pure. */
export const asModelHealth = (v: unknown): ModelHealth | undefined => {
  if (!isObject(v) || !STATES.has(String(v.state))) return undefined;
  const modelId = text(v.modelId, 80);
  const checkedAt = num(v.checkedAt);
  if (!modelId || checkedAt === undefined) return undefined;
  const routes = Array.isArray(v.routes) ? v.routes.map(asRouteHealth).filter((r): r is RouteHealth => !!r).slice(0, 4) : [];
  return { modelId, state: v.state as HealthState, routes, checkedAt };
};

/** Health of registry models for the signed-in user (unknown ids are dropped by the server). */
export async function fetchModelStatus(ids: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<ModelHealth[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))].slice(0, MODEL_STATUS_MAX_IDS);
  if (!unique.length) return [];
  try {
    const res = await get<unknown>(`${MODEL_STATUS_PATH}?ids=${unique.map(encodeURIComponent).join(',')}`, { signal: opts.signal });
    return Array.isArray(res) ? res.map(asModelHealth).filter((m): m is ModelHealth => !!m) : [];
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

export interface BreakerEventView {
  at: number;
  route: ImageRoute;
  model: string;
  event: 'opened' | 'closed';
  code?: string;
  failures: number;
}

export interface ProviderStatusReport {
  models: ModelHealth[];
  breakerEvents: BreakerEventView[];
  bootedAt: number;
  now: number;
}

const asBreakerEvent = (v: unknown): BreakerEventView | undefined => {
  if (!isObject(v) || !ROUTES.has(String(v.route)) || (v.event !== 'opened' && v.event !== 'closed')) return undefined;
  const at = num(v.at);
  const model = text(v.model, 120);
  if (at === undefined || !model) return undefined;
  const code = text(v.code, 40);
  return { at, route: v.route as ImageRoute, model, event: v.event, ...(code ? { code } : {}), failures: num(v.failures) ?? 0 };
};

/** A well-formed admin report (malformed rows skipped). Pure. */
export const asProviderStatusReport = (v: unknown): ProviderStatusReport => {
  const o = isObject(v) ? v : {};
  return {
    models: Array.isArray(o.models) ? o.models.map(asModelHealth).filter((m): m is ModelHealth => !!m) : [],
    breakerEvents: Array.isArray(o.breakerEvents) ? o.breakerEvents.map(asBreakerEvent).filter((e): e is BreakerEventView => !!e) : [],
    bootedAt: num(o.bootedAt) ?? 0,
    now: num(o.now) ?? Date.now()
  };
};

/** Admin only (the server re-checks requireAdmin): every registry model + this container's breaker events. */
export async function fetchProviderStatusReport(opts: { signal?: AbortSignal } = {}): Promise<ProviderStatusReport> {
  try {
    return asProviderStatusReport(await get<unknown>(PROVIDER_STATUS_ADMIN_PATH, { signal: opts.signal }));
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}
