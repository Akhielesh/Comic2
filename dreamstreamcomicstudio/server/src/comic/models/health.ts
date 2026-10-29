// Provider / model health for Comic Studio (reliability.md §2; owner M1-RELIABILITY).
//
// Three sources, one answer per route and per model:
//   - PUBLIC: OpenRouter's free, key-less endpoints listing for a model (`/api/v1/models/<id>/endpoints`),
//     fetched on demand with a 4 s timeout, cached 3 min in memory, single-flight, stale-while-error for up to
//     15 min, then `unknown`. Nothing here ever sends or logs a key: the request carries no headers at all.
//   - OBSERVED: what this container saw itself (`recordImageOutcome`): an in-memory ring per route+model shared
//     across users. Only UPSTREAM failures count (429 / 5xx / network / timeout). Key-scoped failures (a key with
//     limit 0, a rejected key, billing, a user's own integration key being throttled) are the caller's problem,
//     not the model's, and are never counted. Neither are safety blocks, cancels or our own bad requests.
//   - The pure rules in shared/comic/modelHealth.ts turn both into a state; the breaker is "≥ 3 upstream failures
//     in 5 min with no success since → down for 2 min → half-open (one call allowed, reported as degraded)".
//
// `preflightImageRun` is the money-safe check jobs.ts runs BEFORE reserving spend: no run starts on a model that is
// down on every route the user can reach. The same model on the other route is used automatically only when its
// key has the SAME payer (models.md §2.4 R3); every other way out is an OutageOption the user chooses — never a
// silent model switch. Options carry REAL registry prices and the real number of drawn pages a switch would make
// inconsistent (models.md §3.5).
//
// Sleepable: no timers survive a call (the fetch timeout is cleared in `finally`); nothing refreshes on its own.
// jobs.ts / imageClient.ts import this file directly (never a models/index.ts).

import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import {
  HEALTH_THRESHOLDS,
  assessRouteHealth,
  combineModelHealth,
  type HealthState,
  type ModelHealth,
  type OutageOption,
  type ProviderHealth,
  type RouteHealth,
  type RunPreflight
} from '../../../../shared/comic/modelHealth.js';
import {
  PLATFORM_MARKUP,
  QC_USD_PER_PAGE,
  getImageModel,
  imagePriceUsd,
  pickableImageModels,
  type ImageModelSpec,
  type ImageRoute
} from '../../../../shared/comic/models.js';
import { drawnTargets, modelFit, redrawQuote, redrawResolution, type PriceBook } from '../../../../shared/comic/modelLock.js';
import { logger } from '../../lib/logger.js';
import { prefersGeminiDirect } from '../keys.js';
import type { ResolvedKey, StudioKeys } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

export const PUBLIC_HEALTH_TIMEOUT_MS = 4_000;
export const PUBLIC_HEALTH_TTL_MS = 3 * 60_000;
/** A last good answer is served (marked stale) for this long after the public fetch starts failing. */
export const PUBLIC_HEALTH_STALE_MAX_MS = 15 * 60_000;
/** After a failed public fetch, don't hit the network again for this long (stale/unknown is served instead). */
export const PUBLIC_HEALTH_RETRY_MS = 30_000;
/** Outcomes per route+model kept in memory (older ones fall out of the breaker window anyway). */
export const OUTCOME_RING_SIZE = 50;
/** Breaker events kept for the admin "Provider status" section (since boot). */
export const BREAKER_EVENTS_KEPT = 200;
/** Routes tracked at most (route+model pairs); the registry has far fewer. */
const MAX_TRACKED_ROUTES = 64;
/** Switch options offered on an outage (the banner shows ≤ 3 buttons in all). */
export const MAX_SWITCH_OPTIONS = 2;

/** StudioError codes that mean the MODEL's serving path failed (never the user's key, content or our request). */
export const UPSTREAM_FAILURE_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'PROVIDER_ERROR', 'TIMEOUT', 'NOT_AVAILABLE']);
const UPSTREAM_CODE_RE = /^(?:429|5\d\d|408|network|upstream)$/i;
const ROUTE_LABEL: Record<ImageRoute, string> = { openrouter: 'OpenRouter', gemini: 'Gemini' };
const IMAGE_ROUTES: readonly ImageRoute[] = ['openrouter', 'gemini'];

/** Public endpoints URL for an OpenRouter model id (`google/gemini-nano-banana-2.1`): segments encoded, no query. */
export const openrouterEndpointsUrl = (openrouterModelId: string): string =>
  `https://openrouter.ai/api/v1/models/${openrouterModelId
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')}/endpoints`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImageOutcome {
  route: ImageRoute;
  /** Provider model id on that route (PickedImageRoute.model). */
  model: string;
  ok: boolean;
  /** StudioError code or an HTTP status as text (failures only). */
  code?: string;
  /** The failure is about THIS key (limit 0, rejected, billing, a user's integration key throttled): never counted. */
  keyScoped?: boolean;
  /** Clock override (tests). */
  at?: number;
}

export interface BreakerEvent {
  at: number;
  route: ImageRoute;
  model: string;
  /** opened: the route went down (≥ 3 upstream failures); closed: a call succeeded after failures. */
  event: 'opened' | 'closed';
  code?: string;
  failures: number;
}

export interface PublicHealth {
  /** Absent = unknown (no data, fetch failed with nothing cached, or too stale). */
  providers?: ProviderHealth[];
  /** When the data was fetched (the stale answer keeps its original time, so the UI says "12 min ago"). */
  checkedAt: number;
  source: 'openrouter' | 'none';
  /** Served from the last good answer because the fetch is failing. */
  stale?: boolean;
}

export interface RouteState {
  state: HealthState;
  reason?: string;
  observed?: RouteHealth['observed'];
}

export interface PreflightInput {
  specs: ImageModelSpec[];
  keys: StudioKeys;
  doc: ComicDoc;
  /** What the user may pick (switch options respect modelFit; absent ⇒ DEFAULT_CAPS: the free plan's model only). */
  caps?: StudioCaps;
  /** Live PriceBook (M1-LOCK-SERVER / M1-CATALOG); absent ⇒ registry list prices. */
  prices?: PriceBook;
  now?: number;
}

export interface ModelHealthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests only (health.fakes.ts): force a route's state regardless of data. */
  routeOverride?: (route: ImageRoute, model: string) => { state: HealthState; reason?: string } | undefined;
}

/** The health port jobs.ts / imageClient.ts / the routes talk to (fakes implement it too: health.fakes.ts). */
export interface ModelHealthPort {
  recordImageOutcome(outcome: ImageOutcome): void;
  routeState(route: ImageRoute, model: string, now?: number): RouteState;
  getModelHealth(spec: ImageModelSpec, opts?: { keys?: StudioKeys; now?: number }): Promise<ModelHealth>;
  preflightImageRun(input: PreflightInput): Promise<RunPreflight>;
  fetchPublicHealth(openrouterModelId: string, now?: number): Promise<PublicHealth>;
  breakerEvents(): readonly BreakerEvent[];
  /** When this container started tracking (admin "since boot"). */
  readonly bootedAt: number;
  /** Forget everything (tests). */
  reset(): void;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const routeKey = (route: ImageRoute, model: string) => `${route}|${model}`;

/** Does a failure code count against the model (an upstream failure) rather than against the caller? */
export const isUpstreamFailureCode = (code: string | undefined): boolean => {
  if (!code) return false;
  const c = String(code).trim();
  return UPSTREAM_FAILURE_CODES.has(c.toUpperCase()) || UPSTREAM_CODE_RE.test(c);
};

/** The studio's own key/billing sentences (imageClient.classifyImageError) and the providers' usual vocabulary. */
const KEY_SCOPED_RE =
  /key (?:was |is )?(?:rejected|invalid|not valid|missing|expired)|rejected the (?:platform |your )?key|api key not valid|invalid api key|limit:\s*0\b|key limit|no (?:image-generation )?quota|no billing|enable billing|insufficient (?:credits|funds|balance)|integrations?\b|check (?:it|that key) in settings/i;
/** An upstream throttle explicitly says the key is fine — never key-scoped, whatever else the sentence says. */
const KEY_IS_FINE_RE = /your key and limits are fine/i;

/**
 * Is this image failure about the caller's KEY rather than the model (reliability.md §2: limit 0, key rejected,
 * billing, a user's own OpenRouter integration key being throttled)? Reads the sanitized facts imageClient attaches
 * (`imageFailure.isByok`) and the user-facing message; never the raw provider body.
 */
export const isKeyScopedFailure = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; userMessage?: unknown; imageFailure?: { isByok?: unknown; status?: unknown } };
  if (e.imageFailure?.isByok === true) return true;
  const status = Number(e.imageFailure?.status);
  if (status === 401 || status === 402 || status === 403) return true;
  if (e.code === 'NO_IMAGE_KEY' || e.code === 'BILLING_DENIED' || e.code === 'BUDGET_EXCEEDED') return true;
  const text = `${typeof e.userMessage === 'string' ? e.userMessage : ''} ${typeof e.message === 'string' ? e.message : ''}`;
  if (KEY_IS_FINE_RE.test(text)) return false;
  return KEY_SCOPED_RE.test(text);
};

/** One image outcome from a thrown error, ready for `recordImageOutcome` (route/model from the picked route). */
export const outcomeFromError = (err: unknown, picked: { route: ImageRoute; model: string }, at?: number): ImageOutcome => {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { imageFailure?: { status?: unknown } } | null)?.imageFailure?.status;
  return {
    route: picked.route,
    model: picked.model,
    ok: false,
    code: typeof code === 'string' ? code : Number.isFinite(Number(status)) ? String(status) : 'PROVIDER_ERROR',
    keyScoped: isKeyScopedFailure(err),
    ...(at !== undefined ? { at } : {})
  };
};

/** Parse OpenRouter's endpoints payload into ProviderHealth rows (tolerant; unknown fields ignored). */
export const parseOpenRouterEndpoints = (payload: unknown): ProviderHealth[] | undefined => {
  const data = isObject(payload) && isObject(payload.data) ? payload.data : isObject(payload) ? payload : undefined;
  const list = data && Array.isArray(data.endpoints) ? data.endpoints : undefined;
  if (!list) return undefined;
  const out: ProviderHealth[] = [];
  for (const row of list) {
    if (!isObject(row)) continue;
    const name = typeof row.provider_name === 'string' && row.provider_name ? row.provider_name : typeof row.name === 'string' ? row.name : '';
    if (!name) continue;
    out.push({
      name: name.slice(0, 60),
      status: finiteOrNull(row.status),
      uptime30m: finiteOrNull(row.uptime_last_30m ?? row.uptime30m),
      uptime1d: finiteOrNull(row.uptime_last_1d ?? row.uptime_last_24h ?? row.uptime1d)
    });
  }
  return out;
};

/** Mirrors imageClient.pickImageRoute without throwing: the route a run would take, or null (no usable key). */
export const primaryRouteFor = (spec: ImageModelSpec, keys: StudioKeys): { route: ImageRoute; model: string; key: ResolvedKey } | null => {
  if (prefersGeminiDirect(keys) && keys.gemini?.key && spec.routes.gemini) return { route: 'gemini', model: spec.routes.gemini, key: keys.gemini };
  if (keys.openrouter?.key && spec.routes.openrouter) return { route: 'openrouter', model: spec.routes.openrouter, key: keys.openrouter };
  if (keys.gemini?.key && spec.routes.gemini) return { route: 'gemini', model: spec.routes.gemini, key: keys.gemini };
  return null;
};

/** Mirrors imageClient.pickAlternateRoute: the same model on the other route, only with a key of the SAME payer. */
export const alternateRouteFor = (
  spec: ImageModelSpec,
  keys: StudioKeys,
  primary: { route: ImageRoute; key: ResolvedKey }
): { route: ImageRoute; model: string; key: ResolvedKey } | null => {
  const route: ImageRoute = primary.route === 'openrouter' ? 'gemini' : 'openrouter';
  const model = spec.routes[route];
  const key = keys[route];
  if (!model || !key?.key || key.byok !== primary.key.byok) return null;
  return { route, model, key };
};

/** Whether spend runs on the user's own key (same rule as jobs.ts spendIsByok). */
const spendIsByok = (keys: StudioKeys): boolean => (keys.openrouter?.key ? Boolean(keys.openrouter.byok) : Boolean(keys.gemini?.byok));

/** Registry list prices as a PriceBook (the live catalog's book is injected by the caller when it has one). */
export const registryPriceBook = (): PriceBook => ({
  unit: (modelId, res) => {
    const spec = getImageModel(modelId);
    if (!spec) return { usd: null, basis: 'unknown model' };
    return { usd: imagePriceUsd(spec, res), basis: `list price from ${spec.factsAsOf}` };
  },
  qcUsd: QC_USD_PER_PAGE
});

const etaHintFor = (route: RouteHealth | undefined, now: number): string | undefined => {
  const last = route?.observed?.lastFailureAt;
  if (route?.state !== 'down' || typeof last !== 'number') return undefined;
  const left = HEALTH_THRESHOLDS.breakerOpenMs - (now - last);
  if (left <= 0) return undefined;
  const min = Math.max(1, Math.ceil(left / 60_000));
  return `about ${min} min`;
};

// ── Factory ──────────────────────────────────────────────────────────────────

interface Sample {
  at: number;
  ok: boolean;
  code?: string;
}

interface PublicCacheEntry {
  good?: PublicHealth;
  /** Last failed attempt (negative cache). */
  failedAt?: number;
}

export function createModelHealth(deps: ModelHealthDeps = {}): ModelHealthPort {
  const now = deps.now || (() => Date.now());
  const doFetch = deps.fetch || ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const bootedAt = now();

  const rings = new Map<string, Sample[]>();
  const events: BreakerEvent[] = [];
  const publicCache = new Map<string, PublicCacheEntry>();
  const inflight = new Map<string, Promise<PublicHealth>>();

  const observedFor = (key: string, at: number): RouteHealth['observed'] | undefined => {
    const ring = rings.get(key);
    if (!ring?.length) return undefined;
    const since = at - HEALTH_THRESHOLDS.breakerWindowMs;
    const inWindow = ring.filter((s) => s.at > since);
    if (!inWindow.length) return undefined;
    let lastSuccessAt: number | undefined;
    let lastFailureAt: number | undefined;
    let lastCode: string | undefined;
    let ok = 0;
    let failures = 0; // consecutive: only the failures AFTER the last success count for the breaker
    for (const s of inWindow) {
      if (s.ok) {
        ok += 1;
        lastSuccessAt = s.at;
        failures = 0;
      } else {
        failures += 1;
        lastFailureAt = s.at;
        lastCode = s.code;
      }
    }
    // The ring's ORDER is the truth: parallel calls often finish in the same millisecond, and a failure recorded
    // after a success must still read as "failed since" (the pure rule compares times, so keep them ordered).
    if (failures > 0 && lastSuccessAt !== undefined && lastFailureAt !== undefined && lastSuccessAt >= lastFailureAt) {
      lastSuccessAt = lastFailureAt - 1;
    }
    return {
      ok,
      upstreamFailures: failures,
      ...(lastCode ? { lastCode } : {}),
      ...(lastFailureAt !== undefined ? { lastFailureAt } : {}),
      ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {})
    };
  };

  const override = (route: ImageRoute, model: string, assessed: Pick<RouteHealth, 'state' | 'reason'>): Pick<RouteHealth, 'state' | 'reason'> => {
    const forced = deps.routeOverride?.(route, model);
    return forced ? { state: forced.state, ...(forced.reason ? { reason: forced.reason } : {}) } : assessed;
  };

  const routeState = (route: ImageRoute, model: string, at: number = now()): RouteState => {
    const observed = observedFor(routeKey(route, model), at);
    const assessed = override(route, model, assessRouteHealth({ observed, now: at }));
    return { ...assessed, ...(observed ? { observed } : {}) };
  };

  const pushEvent = (event: BreakerEvent) => {
    events.push(event);
    if (events.length > BREAKER_EVENTS_KEPT) events.splice(0, events.length - BREAKER_EVENTS_KEPT);
    logger.warn('comic_model_health_breaker', { route: event.route, model: event.model, breaker: event.event, failures: event.failures, code: event.code });
  };

  const recordImageOutcome = (outcome: ImageOutcome): void => {
    if (!outcome || !IMAGE_ROUTES.includes(outcome.route) || typeof outcome.model !== 'string' || !outcome.model) return;
    const at = typeof outcome.at === 'number' && Number.isFinite(outcome.at) ? outcome.at : now();
    if (!outcome.ok) {
      if (outcome.keyScoped) return; // the caller's key, not the model
      if (!isUpstreamFailureCode(outcome.code)) return; // safety, cancel, our own bad request, …
    }
    const key = routeKey(outcome.route, outcome.model);
    if (!rings.has(key) && rings.size >= MAX_TRACKED_ROUTES) rings.delete(rings.keys().next().value as string);
    const before = routeState(outcome.route, outcome.model, at).state;
    const ring = rings.get(key) || [];
    ring.push({ at, ok: outcome.ok, ...(outcome.code ? { code: String(outcome.code).slice(0, 40) } : {}) });
    if (ring.length > OUTCOME_RING_SIZE) ring.splice(0, ring.length - OUTCOME_RING_SIZE);
    rings.set(key, ring);
    const after = routeState(outcome.route, outcome.model, at);
    if (after.state === 'down' && before !== 'down') {
      pushEvent({ at, route: outcome.route, model: outcome.model, event: 'opened', code: after.observed?.lastCode, failures: after.observed?.upstreamFailures || 0 });
    } else if (outcome.ok && after.state === 'ok' && (before === 'down' || before === 'degraded')) {
      pushEvent({ at, route: outcome.route, model: outcome.model, event: 'closed', failures: 0 });
    }
  };

  const fetchOnce = async (openrouterModelId: string, at: number): Promise<PublicHealth> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_HEALTH_TIMEOUT_MS);
    try {
      // Public and free: no Authorization, no key, no custom headers at all.
      const res = await doFetch(openrouterEndpointsUrl(openrouterModelId), { method: 'GET', signal: controller.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const providers = parseOpenRouterEndpoints(await res.json());
      if (!providers) throw new Error('unreadable payload');
      return { providers, checkedAt: at, source: 'openrouter' };
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchPublicHealth = (openrouterModelId: string, at: number = now()): Promise<PublicHealth> => {
    const id = String(openrouterModelId || '').trim();
    if (!id) return Promise.resolve({ checkedAt: at, source: 'none' });
    const entry = publicCache.get(id) || {};
    if (entry.good && at - entry.good.checkedAt < PUBLIC_HEALTH_TTL_MS) return Promise.resolve(entry.good);
    const pending = inflight.get(id);
    if (pending) return pending;
    const fallback = (): PublicHealth => {
      if (entry.good && at - entry.good.checkedAt <= PUBLIC_HEALTH_STALE_MAX_MS) return { ...entry.good, stale: true };
      return { checkedAt: at, source: 'none' };
    };
    if (entry.failedAt !== undefined && at - entry.failedAt < PUBLIC_HEALTH_RETRY_MS) return Promise.resolve(fallback());
    const run = fetchOnce(id, at)
      .then((good) => {
        publicCache.set(id, { good });
        return good;
      })
      .catch((err: unknown) => {
        publicCache.set(id, { ...entry, failedAt: at });
        logger.warn('comic_model_health_fetch_failed', { model: id, reason: String((err as Error)?.message || err).slice(0, 80) });
        return fallback();
      })
      .finally(() => {
        inflight.delete(id);
      });
    inflight.set(id, run);
    return run;
  };

  const getModelHealth = async (spec: ImageModelSpec, opts: { keys?: StudioKeys; now?: number } = {}): Promise<ModelHealth> => {
    const at = opts.now ?? now();
    const keys = opts.keys;
    const all = IMAGE_ROUTES.filter((route) => !!spec.routes[route]);
    // With keys, only the routes this caller can reach count (a model that is fine on a route the user has no key
    // for is still down FOR THEM). Without any reachable route, report every route (informational).
    const reachable = keys ? all.filter((route) => !!keys[route]?.key) : all;
    const routes: RouteHealth[] = [];
    for (const route of reachable.length ? reachable : all) {
      const model = spec.routes[route] as string;
      const observed = observedFor(routeKey(route, model), at);
      let providers: ProviderHealth[] | undefined;
      let checkedAt = at;
      if (route === 'openrouter') {
        const pub = await fetchPublicHealth(model, at);
        providers = pub.providers;
        checkedAt = pub.checkedAt;
      }
      const assessed = override(route, model, assessRouteHealth({ providers, observed, now: at }));
      const source: RouteHealth['source'] = providers?.length ? 'openrouter' : observed ? 'observed' : 'none';
      routes.push({
        route,
        model,
        state: assessed.state,
        ...(providers ? { providers } : {}),
        ...(observed ? { observed } : {}),
        ...(assessed.reason ? { reason: assessed.reason } : {}),
        checkedAt: source === 'openrouter' ? checkedAt : at,
        source
      });
    }
    return { modelId: spec.id, state: combineModelHealth(routes), routes, checkedAt: at };
  };

  const switchOptions = async (
    blockedSpec: ImageModelSpec,
    input: PreflightInput,
    at: number
  ): Promise<Extract<OutageOption, { kind: 'switch_model' }>[]> => {
    const caps = input.caps || DEFAULT_CAPS;
    const byok = spendIsByok(input.keys);
    const markup = byok ? 1 : PLATFORM_MARKUP;
    const book = input.prices || registryPriceBook();
    const fallbackBook = registryPriceBook();
    const targets = drawnTargets(input.doc);
    const redrawCount = targets.pages.length + (targets.cover ? 1 : 0);
    const candidates: { spec: ImageModelSpec; usdPerImage: number }[] = [];
    for (const cand of pickableImageModels()) {
      if (cand.id === blockedSpec.id) continue;
      if (!primaryRouteFor(cand, input.keys)) continue;
      if (modelFit(cand, input.doc, caps).some((r) => r.severity === 'block')) continue;
      const health = await getModelHealth(cand, { keys: input.keys, now: at });
      if (health.state === 'down') continue;
      const res = redrawResolution(input.doc, cand.id, 'page');
      const unit = book.unit(cand.id, res, 'page').usd ?? fallbackBook.unit(cand.id, res, 'page').usd;
      if (unit === null || !Number.isFinite(unit)) continue; // nothing real to show (models.md §4.6: never a guess)
      candidates.push({ spec: cand, usdPerImage: round4(unit * markup) });
    }
    candidates.sort((a, b) => {
      const fa = a.spec.vendor === blockedSpec.vendor ? 0 : 1;
      const fb = b.spec.vendor === blockedSpec.vendor ? 0 : 1;
      return fa - fb || a.usdPerImage - b.usdPerImage || a.spec.id.localeCompare(b.spec.id);
    });
    return candidates.slice(0, MAX_SWITCH_OPTIONS).map(({ spec, usdPerImage }) => {
      const quote = redrawQuote(input.doc, spec.id, 'pages_cover', book, byok);
      const redrawUsd = quote.usd ?? redrawQuote(input.doc, spec.id, 'pages_cover', fallbackBook, byok).usd ?? 0;
      return {
        kind: 'switch_model',
        modelId: spec.id,
        nickname: spec.nickname,
        usdPerImage,
        consistency: spec.vendor === blockedSpec.vendor ? 'same_family' : 'different',
        redrawCount,
        redrawUsd: round4(redrawUsd)
      };
    });
  };

  const optionsFor = async (spec: ImageModelSpec, health: ModelHealth, input: PreflightInput, at: number): Promise<OutageOption[]> => {
    const options: OutageOption[] = [];
    const primary = primaryRouteFor(spec, input.keys);
    const primaryRoute = primary ? health.routes.find((r) => r.route === primary.route) : undefined;
    const eta = etaHintFor(primaryRoute, at);
    options.push(eta ? { kind: 'wait_and_retry', etaHint: eta } : { kind: 'wait_and_retry' });
    if (primary) {
      const other: ImageRoute = primary.route === 'openrouter' ? 'gemini' : 'openrouter';
      const otherModel = spec.routes[other];
      const otherKey = input.keys[other];
      if (otherModel) {
        if (otherKey?.key) {
          // A key of a DIFFERENT payer (else the preflight would have used it): only the user's own key may be
          // offered, and only with their click — a platform-paid run never moves onto DreamStream's other key
          // silently, and a BYOK run never moves onto the platform's.
          const otherState = health.routes.find((r) => r.route === other)?.state ?? 'unknown';
          if (otherKey.byok && !primary.key.byok && otherState !== 'down') {
            options.push({ kind: 'other_route', route: other, label: `Use ${spec.nickname} through your ${ROUTE_LABEL[other]} key` });
          }
        } else {
          options.push({ kind: 'add_key', route: other, label: `Add a ${ROUTE_LABEL[other]} key to reach ${spec.nickname} directly` });
        }
      }
    }
    options.push(...(await switchOptions(spec, input, at)));
    return options;
  };

  const preflightImageRun = async (input: PreflightInput): Promise<RunPreflight> => {
    const at = input.now ?? now();
    const seen = new Set<string>();
    const blocked: NonNullable<RunPreflight['blocked']> = [];
    const options: OutageOption[] = [];
    let useRoute: ImageRoute | undefined;
    for (const spec of input.specs || []) {
      if (!spec || seen.has(spec.id)) continue;
      seen.add(spec.id);
      const primary = primaryRouteFor(spec, input.keys);
      if (!primary) continue; // no key at all: jobs.ts raises NO_IMAGE_KEY itself — not an outage
      const health = await getModelHealth(spec, { keys: input.keys, now: at });
      const stateOf = (route: ImageRoute): HealthState => health.routes.find((r) => r.route === route)?.state ?? 'unknown';
      if (stateOf(primary.route) !== 'down') continue; // ok, degraded and unknown never block
      const alt = alternateRouteFor(spec, input.keys, primary);
      if (alt && stateOf(alt.route) !== 'down') {
        useRoute ??= alt.route;
        continue;
      }
      const down = health.routes.find((r) => r.route === primary.route);
      blocked.push({ modelId: spec.id, state: 'down', reason: down?.reason || `${ROUTE_LABEL[primary.route]} is not serving ${spec.nickname} right now` });
      for (const option of await optionsFor(spec, health, input, at)) {
        const dup = options.some((o) => JSON.stringify(o) === JSON.stringify(option));
        if (!dup) options.push(option);
      }
    }
    return {
      ok: blocked.length === 0,
      ...(useRoute && !blocked.length ? { useRoute } : {}),
      ...(blocked.length ? { blocked } : {}),
      options: blocked.length ? options : []
    };
  };

  return {
    recordImageOutcome,
    routeState,
    getModelHealth,
    preflightImageRun,
    fetchPublicHealth,
    breakerEvents: () => events.slice(),
    bootedAt,
    reset: () => {
      rings.clear();
      events.length = 0;
      publicCache.clear();
      inflight.clear();
    }
  };
}

// ── Process-wide instance (what production wiring uses) ──────────────────────

let instance: ModelHealthPort = createModelHealth();

/** The process-wide health port (routes and the job runner share one breaker and one public cache). */
export const modelHealth = (): ModelHealthPort => instance;

/** Record one image call's outcome on a route (key-scoped and non-upstream failures are ignored). */
export const recordImageOutcome = (outcome: ImageOutcome): void => instance.recordImageOutcome(outcome);
/** The breaker's view of one route+model right now (observed data only; cheap, synchronous). */
export const routeState = (route: ImageRoute, model: string, now?: number): RouteState => instance.routeState(route, model, now);
/** Public + observed health of one registry model (routes limited to the ones `keys` can reach). */
export const getModelHealth = (spec: ImageModelSpec, opts?: { keys?: StudioKeys; now?: number }): Promise<ModelHealth> => instance.getModelHealth(spec, opts);
/** Money-safe check before any reservation: never starts a run on a model that is down everywhere the user can reach. */
export const preflightImageRun = (input: PreflightInput): Promise<RunPreflight> => instance.preflightImageRun(input);
/** OpenRouter's public endpoint data for a model (cached 3 min, single-flight, stale ≤ 15 min, then unknown). */
export const fetchPublicHealth = (openrouterModelId: string, now?: number): Promise<PublicHealth> => instance.fetchPublicHealth(openrouterModelId, now);
/** This container's breaker events since boot (admin "Provider status"). */
export const breakerEvents = (): readonly BreakerEvent[] => instance.breakerEvents();

/** Test hook: swap the process-wide port (a fresh one, or a fake) and get the previous one back. */
export const __setModelHealthForTests = (port: ModelHealthPort | null): ModelHealthPort => {
  const previous = instance;
  instance = port || createModelHealth();
  return previous;
};
