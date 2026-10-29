// Fake model-health port for tests (reliability.md §5; M1-LOCK-SERVER's 16:52 incident replay uses it).
//
// The breaker, the options builder and the preflight are the REAL implementation (createModelHealth) with the
// network replaced by a scripted OpenRouter answer per model, a settable clock and optional forced route states,
// so a test can:
//   - `setPublic('google/gemini-nano-banana-2.1', [{ name: 'Google AI Studio', status: -1, uptime30m: 40, uptime1d: 90 }])`
//     → OpenRouter says the model's only provider is failing (the 2026-10-22 16:52 outage);
//   - record three 429s with `recordImageOutcome` and watch the breaker open on its own;
//   - `forceRoute('openrouter', 'google/gemini-nano-banana-2.1', 'down')` to skip the setup entirely;
//   - read `outcomes` / `preflights` / `fetches` to assert what the wiring did (and that no key was ever sent).
// Test-only; never imported by app code.

import type { ImageRoute } from '../../../../shared/comic/models.js';
import type { HealthState, ProviderHealth } from '../../../../shared/comic/modelHealth.js';
import { createModelHealth, type ImageOutcome, type ModelHealthPort, type PreflightInput } from './health.js';

export interface FakeModelHealth extends ModelHealthPort {
  /** Every recordImageOutcome call, counted or not (key-scoped ones included, so a test can assert they were ignored). */
  outcomes: ImageOutcome[];
  preflights: PreflightInput[];
  /** Every public URL the real fetcher asked for, with the headers it sent (always none). */
  fetches: { url: string; headers: Record<string, string> }[];
  /** Script OpenRouter's endpoints answer for a model (undefined = the fetch fails → unknown, or stale if cached). */
  setPublic(openrouterModelId: string, providers: ProviderHealth[] | undefined): void;
  /** Force a route's state regardless of data (undefined clears). */
  forceRoute(route: ImageRoute, model: string, state: HealthState | undefined, reason?: string): void;
  /** Move the fake clock. */
  setNow(at: number): void;
  now(): number;
}

export function fakeModelHealth(opts: { now?: number } = {}): FakeModelHealth {
  let clock = opts.now ?? 1_760_000_000_000;
  const scripted = new Map<string, ProviderHealth[] | undefined>();
  const forced = new Map<string, { state: HealthState; reason?: string }>();
  const fetches: FakeModelHealth['fetches'] = [];
  const outcomes: ImageOutcome[] = [];
  const preflights: PreflightInput[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof (h as Headers).forEach === 'function') (h as Headers).forEach((v, k) => (headers[k] = v));
    else if (h && typeof h === 'object') Object.assign(headers, h as Record<string, string>);
    fetches.push({ url, headers });
    const m = /\/api\/v1\/models\/(.+)\/endpoints$/.exec(url);
    const id = m ? decodeURIComponent(m[1]) : '';
    const providers = scripted.get(id);
    if (!providers) return new Response('unavailable', { status: 503 });
    const endpoints = providers.map((p) => ({ name: p.name, provider_name: p.name, status: p.status, uptime_last_30m: p.uptime30m, uptime_last_1d: p.uptime1d }));
    return new Response(JSON.stringify({ data: { id, endpoints } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const real = createModelHealth({
    fetch: fetchImpl,
    now: () => clock,
    routeOverride: (route, model) => forced.get(`${route}|${model}`)
  });

  return {
    outcomes,
    preflights,
    fetches,
    bootedAt: clock,
    setPublic: (id, providers) => void scripted.set(id, providers),
    forceRoute: (route, model, state, reason) => {
      if (state) forced.set(`${route}|${model}`, { state, ...(reason ? { reason } : {}) });
      else forced.delete(`${route}|${model}`);
    },
    setNow: (at) => void (clock = at),
    now: () => clock,
    recordImageOutcome: (outcome) => {
      outcomes.push(outcome);
      real.recordImageOutcome(outcome);
    },
    routeState: (route, model, now) => real.routeState(route, model, now),
    getModelHealth: (spec, o) => real.getModelHealth(spec, o),
    preflightImageRun: (input) => {
      preflights.push(input);
      return real.preflightImageRun(input);
    },
    fetchPublicHealth: (id, now) => real.fetchPublicHealth(id, now),
    breakerEvents: () => real.breakerEvents(),
    reset: () => {
      real.reset();
      outcomes.length = 0;
      preflights.length = 0;
      fetches.length = 0;
      scripted.clear();
      forced.clear();
    }
  };
}
