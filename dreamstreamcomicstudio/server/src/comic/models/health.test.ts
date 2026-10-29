// @vitest-environment node
// Provider / model health (reliability.md §5 server tests): the public fetch is cached, single-flight,
// stale-while-error and times out to unknown; the breaker opens on 3 upstream failures and never on key
// errors; the preflight picks the same-payer alternate, blocks when every reachable route is down (no
// image call, no reservation, one card's worth of options), never blocks on unknown, and its options carry
// real registry prices and the real redraw count.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { resolveStudioCaps } from '../../../../shared/comic/capabilities.js';
import { HEALTH_THRESHOLDS, type ProviderHealth } from '../../../../shared/comic/modelHealth.js';
import { PLATFORM_MARKUP, getImageModel, imagePriceUsd } from '../../../../shared/comic/models.js';
import { drawnTargets, redrawQuote, redrawResolution } from '../../../../shared/comic/modelLock.js';
import { fakeBilling, fakeImages } from '../orchestrator.fakes.js';
import { StudioError, type StudioKeys } from '../types.js';
import { classifyImageError } from '../imageClient.js';
import {
  HALF_OPEN_PROBE_TIMEOUT_MS,
  NOT_UPSTREAM_CODE,
  PUBLIC_HEALTH_STALE_MAX_MS,
  PUBLIC_HEALTH_TIMEOUT_MS,
  PUBLIC_HEALTH_TTL_MS,
  __setModelHealthForTests,
  acquireRouteCall,
  createModelHealth,
  isKeyScopedFailure,
  isRoutePausedError,
  openrouterEndpointsUrl,
  outcomeFromError,
  parseOpenRouterEndpoints,
  preflightImageRun,
  recordImageOutcome,
  registryPriceBook,
  routePausedError,
  routeState,
  type ModelHealthPort
} from './health.js';
import { fakeModelHealth } from './health.fakes.js';

const T0 = 1_760_000_000_000;
const NB21 = getImageModel('nano-banana-2.1')!;
const PRO = getImageModel('nano-banana-pro')!;
const OR_ID = NB21.routes.openrouter!;
const GEM_ID = NB21.routes.gemini!;

const serving: ProviderHealth[] = [{ name: 'Google AI Studio', status: 0, uptime30m: 99.5, uptime1d: 99.8 }];
const failing: ProviderHealth[] = [{ name: 'Google AI Studio', status: -1, uptime30m: 41, uptime1d: 93 }];

const endpointsBody = (providers: ProviderHealth[]) =>
  JSON.stringify({ data: { id: OR_ID, endpoints: providers.map((p) => ({ provider_name: p.name, status: p.status, uptime_last_30m: p.uptime30m, uptime_last_1d: p.uptime1d })) } });

/** A fetch that answers from a script (per URL) and records every call (url + the init it was given). */
const scriptedFetch = () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let answer: (url: string) => Promise<Response> = async () => new Response(endpointsBody(serving), { status: 200 });
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return answer(String(input));
  };
  return { calls, fetchImpl, set: (fn: typeof answer) => void (answer = fn) };
};
/** Nano Banana 2.1's only provider is failing; every other model is serving. */
const nb21Failing = async (url: string) => new Response(endpointsBody(url.includes(encodeURIComponent('gemini-nano-banana-2.1')) || url.includes('gemini-nano-banana-2.1') ? failing : serving), { status: 200 });

const PLATFORM: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false } };
const PLATFORM_BOTH: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false }, gemini: { key: 'AIza-platform', byok: false } };

/** A comic locked to Nano Banana 2.1 with two drawn pages, a drawn cover and one undrawn page. */
const lockedDoc = (): ComicDoc => {
  const doc = createEmptyDoc('proj-health', 'Spice Run', T0);
  const page = (n: number, drawn: boolean): Page => ({
    id: `pg_${n}`,
    n,
    summary: `Page ${n}`,
    layout: 'Row 1: one wide panel.',
    panels: [{ id: `pn_${n}_1`, n: 1, size: 'wide', shot: 'establishing', action: 'Market', castIds: [], lines: [] }],
    render: drawn ? { status: 'ready', history: [], asset: { path: `u/x/p/pg_${n}.webp`, source: 'generated', at: T0, model: 'nano-banana-2.1' } } : emptyRender(),
    balloons: []
  });
  doc.pages = [page(1, true), page(2, true), page(3, false)];
  doc.cover = { ...doc.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/p/cover.webp', source: 'generated', at: T0, model: 'nano-banana-2.1' } } };
  doc.imageModel = { modelId: 'nano-banana-2.1', lockedAt: T0, origin: 'first_render' };
  return doc;
};

const paidCaps = resolveStudioCaps({ planId: 'pro', byok: false, isAdmin: false });

describe('fetchPublicHealth (OpenRouter public endpoints)', () => {
  it('builds the public URL with encoded segments and never sends a header or a key', async () => {
    expect(openrouterEndpointsUrl('google/gemini-nano-banana-2.1')).toBe('https://openrouter.ai/api/v1/models/google/gemini-nano-banana-2.1/endpoints');
    expect(openrouterEndpointsUrl('a b/c?d')).toBe('https://openrouter.ai/api/v1/models/a%20b/c%3Fd/endpoints');
    const f = scriptedFetch();
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    const out = await h.fetchPublicHealth(OR_ID);
    expect(out).toEqual({ providers: serving, checkedAt: T0, source: 'openrouter' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init?.headers).toBeUndefined();
    expect(JSON.stringify(f.calls[0])).not.toMatch(/sk-or|Authorization/i);
  });

  it('caches for 3 minutes and shares one in-flight request (single-flight)', async () => {
    let t = T0;
    const f = scriptedFetch();
    let release: () => void = () => undefined;
    f.set(() => new Promise<Response>((resolve) => (release = () => resolve(new Response(endpointsBody(serving), { status: 200 })))));
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => t });
    const a = h.fetchPublicHealth(OR_ID);
    const b = h.fetchPublicHealth(OR_ID);
    release();
    expect((await a).providers).toEqual(serving);
    expect((await b).providers).toEqual(serving);
    expect(f.calls).toHaveLength(1);
    t += PUBLIC_HEALTH_TTL_MS - 1;
    f.set(async () => new Response(endpointsBody(failing), { status: 200 }));
    expect((await h.fetchPublicHealth(OR_ID)).providers).toEqual(serving); // still the cached answer
    expect(f.calls).toHaveLength(1);
    t += 2;
    expect((await h.fetchPublicHealth(OR_ID)).providers).toEqual(failing); // refreshed after the TTL
    expect(f.calls).toHaveLength(2);
  });

  it('serves the last good answer (marked stale, original time) while the fetch fails, then unknown after 15 min', async () => {
    let t = T0;
    const f = scriptedFetch();
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => t });
    await h.fetchPublicHealth(OR_ID);
    f.set(async () => new Response('down', { status: 503 }));
    t = T0 + PUBLIC_HEALTH_TTL_MS + 1;
    const stale = await h.fetchPublicHealth(OR_ID);
    expect(stale).toEqual({ providers: serving, checkedAt: T0, source: 'openrouter', stale: true });
    // A failed attempt is not retried on every call (negative cache), but stale is still served.
    expect((await h.fetchPublicHealth(OR_ID)).stale).toBe(true);
    expect(f.calls).toHaveLength(2);
    t = T0 + PUBLIC_HEALTH_STALE_MAX_MS + 1;
    const unknown = await h.fetchPublicHealth(OR_ID);
    expect(unknown).toEqual({ checkedAt: t, source: 'none' });
    expect(unknown.providers).toBeUndefined();
  });

  it('times out after 4 s → unknown (the timer is cleared; nothing keeps the container awake)', async () => {
    vi.useFakeTimers();
    try {
      const f = scriptedFetch();
      f.set(
        () =>
          new Promise<Response>((_resolve, reject) => {
            const signal = f.calls[f.calls.length - 1].init?.signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
      const pending = h.fetchPublicHealth(OR_ID);
      await vi.advanceTimersByTimeAsync(PUBLIC_HEALTH_TIMEOUT_MS + 1);
      expect(await pending).toEqual({ checkedAt: T0, source: 'none' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses OpenRouter payloads tolerantly (missing fields → null; no endpoints → undefined)', () => {
    expect(parseOpenRouterEndpoints({ data: { endpoints: [{ provider_name: 'Vertex', status: 0, uptime_last_30m: 98.2, uptime_last_1d: 99 }, { name: 'X' }, 'junk'] } })).toEqual([
      { name: 'Vertex', status: 0, uptime30m: 98.2, uptime1d: 99 },
      { name: 'X', status: null, uptime30m: null, uptime1d: null }
    ]);
    expect(parseOpenRouterEndpoints({ data: {} })).toBeUndefined();
    expect(parseOpenRouterEndpoints('nope')).toBeUndefined();
  });
});

describe('breaker (observed outcomes)', () => {
  it('opens after 3 upstream failures in 5 min, half-opens after 2 min, closes on a success', () => {
    let t = T0;
    const h = createModelHealth({ now: () => t });
    const fail = (code = 'RATE_LIMIT') => h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code });
    fail();
    fail();
    expect(h.routeState('openrouter', OR_ID).state).toBe('degraded'); // one or two failures: wary, never blocked
    fail();
    const down = h.routeState('openrouter', OR_ID);
    expect(down.state).toBe('down');
    expect(down.reason).toMatch(/3 calls failed/);
    expect(down.observed).toMatchObject({ ok: 0, upstreamFailures: 3, lastCode: 'RATE_LIMIT', lastFailureAt: T0 });
    expect(h.breakerEvents()).toEqual([{ at: T0, route: 'openrouter', model: OR_ID, event: 'opened', code: 'RATE_LIMIT', failures: 3 }]);
    t = T0 + HEALTH_THRESHOLDS.breakerOpenMs + 1;
    expect(h.routeState('openrouter', OR_ID).state).toBe('degraded'); // half-open: one call may try
    h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: true });
    expect(h.routeState('openrouter', OR_ID).state).toBe('ok');
    expect(h.breakerEvents().map((e) => e.event)).toEqual(['opened', 'closed']);
    // Outcomes older than the window fall out: silence → unknown.
    t = T0 + HEALTH_THRESHOLDS.breakerWindowMs + HEALTH_THRESHOLDS.breakerOpenMs + 5;
    expect(h.routeState('openrouter', OR_ID).state).toBe('unknown');
  });

  it('never opens on key-scoped or non-upstream failures (limit 0, rejected key, billing, safety, cancel)', () => {
    const h = createModelHealth({ now: () => T0 });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', keyScoped: true });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'PROVIDER_ERROR', keyScoped: true });
    for (const code of ['SAFETY_BLOCKED', 'CONTENT_POLICY', 'NO_IMAGE', 'CANCELLED', 'BAD_REQUEST', 'BILLING_DENIED', 'BUDGET_EXCEEDED', 'NO_IMAGE_KEY']) {
      h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code });
    }
    expect(h.routeState('openrouter', OR_ID).state).toBe('unknown');
    expect(h.breakerEvents()).toEqual([]);
    // The same three failures WITHOUT the key flag do open it (the only difference is who the failure is about).
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'PROVIDER_ERROR' });
    expect(h.routeState('openrouter', OR_ID).state).toBe('down');
  });

  it('logs one structured breaker line under its own event name (route, model, code; never a key)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const h = createModelHealth({ now: () => T0 });
      for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
      const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: 'comic_model_health_breaker', breaker: 'opened', route: 'openrouter', model: OR_ID, code: 'RATE_LIMIT', failures: 3 });
      expect(JSON.stringify(lines)).not.toMatch(/sk-or|AIza|key/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('routes are independent and the breaker counts consecutive failures only (same-millisecond order kept)', () => {
    const h = createModelHealth({ now: () => T0 });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: '503' });
    expect(h.routeState('openrouter', OR_ID).state).toBe('down');
    expect(h.routeState('gemini', GEM_ID).state).toBe('unknown');
    const g = (ok: boolean) => h.recordImageOutcome({ route: 'gemini', model: GEM_ID, ok, code: ok ? undefined : 'RATE_LIMIT' });
    g(false);
    g(false);
    g(true);
    g(false);
    g(false);
    expect(h.routeState('gemini', GEM_ID).observed).toMatchObject({ ok: 1, upstreamFailures: 2 });
    expect(h.routeState('gemini', GEM_ID).state).toBe('degraded');
  });

  it('classifies key-scoped failures from the error the image client throws', () => {
    const byok429 = Object.assign(new StudioError('RATE_LIMIT', 'OpenRouter sent Nano Banana 2.1 through the Google key in your OpenRouter Integrations, and that key is rate-limited.'), {
      imageFailure: { route: 'openrouter', status: 429, isByok: true }
    });
    expect(isKeyScopedFailure(byok429)).toBe(true);
    expect(isKeyScopedFailure(new StudioError('PROVIDER_ERROR', 'Your OpenRouter key was rejected. Check it in Settings → API keys.', { status: 502 }))).toBe(true);
    expect(isKeyScopedFailure(new StudioError('PROVIDER_ERROR', 'Your Gemini key has no image-generation quota (its Google Cloud project has no billing).'))).toBe(true);
    expect(isKeyScopedFailure(new StudioError('PROVIDER_ERROR', 'OpenRouter said: key limit: 0 — add credits'))).toBe(true);
    const upstream = Object.assign(new StudioError('RATE_LIMIT', 'Nano Banana 2.1 is being throttled by its provider (Google) for everyone on OpenRouter right now — your key and limits are fine.'), {
      imageFailure: { route: 'openrouter', status: 429, providerName: 'Google' }
    });
    expect(isKeyScopedFailure(upstream)).toBe(false);
    expect(isKeyScopedFailure(new StudioError('PROVIDER_ERROR', 'The image provider had a temporary problem. Please try again.', { status: 502, retryable: true }))).toBe(false);
    expect(outcomeFromError(upstream, { route: 'openrouter', model: OR_ID }, T0)).toEqual({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', keyScoped: false, at: T0 });
    expect(outcomeFromError(byok429, { route: 'openrouter', model: OR_ID })).toMatchObject({ ok: false, code: 'RATE_LIMIT', keyScoped: true });
  });
});

/** What imageClient throws for one provider answer: classifyImageError's StudioError plus the `imageFailure` facts
 *  runOnRoute attaches (route + HTTP status; never a body or a key). */
const thrownByImageClient = (status: number, providerMessage: string, ctx: { route: 'openrouter' | 'gemini'; byok: boolean }) =>
  Object.assign(classifyImageError(Object.assign(new Error(providerMessage), { status }), { ...ctx, model: NB21.nickname }), {
    imageFailure: { route: ctx.route, status }
  });

describe('breaker: what imageClient really throws', () => {
  const ownSide = [
    ['our own bad request (400)', 400, 'Invalid value for aspect_ratio', false],
    ['an unprocessable request (422)', 422, 'Unprocessable: image size too large', false],
    ["the platform key's limit: 0 (429, shared service at capacity)", 429, 'RESOURCE_EXHAUSTED quota free_tier_requests, limit: 0', false],
    ['a 402 capacity answer on the platform key', 402, 'Payment required: insufficient credits', false],
    ['a model id the route does not know (404)', 404, 'No endpoints found for this model', false],
    ['a rejected platform key (401)', 401, 'Unauthorized', false]
  ] as const;

  for (const [name, status, message, byok] of ownSide) {
    it(`never counts ${name}: three of them leave the route unknown with no breaker event`, () => {
      const err = thrownByImageClient(status, message, { route: 'gemini', byok });
      expect(err.retryable).toBe(false); // the classification this rule leans on
      const outcome = outcomeFromError(err, { route: 'gemini', model: GEM_ID }, T0);
      expect(outcome.code).toBe(NOT_UPSTREAM_CODE);
      const h = createModelHealth({ now: () => T0 });
      for (let i = 0; i < 3; i += 1) h.recordImageOutcome(outcome);
      expect(h.routeState('gemini', GEM_ID).state).toBe('unknown');
      expect(h.breakerEvents()).toEqual([]);
    });
  }

  it("the platform key's limit: 0 never blocks a BYOK Gemini user on the same route + model", async () => {
    const h = createModelHealth({ now: () => T0, fetch: (async () => new Response('x', { status: 500 })) as typeof fetch });
    const err = thrownByImageClient(429, 'RESOURCE_EXHAUSTED quota free_tier_requests, limit: 0', { route: 'gemini', byok: false });
    expect(err.userMessage).toMatch(/shared image service is at capacity/);
    expect(isKeyScopedFailure(err)).toBe(true);
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome(outcomeFromError(err, { route: 'gemini', model: GEM_ID }, T0));
    const byokGemini: StudioKeys = { gemini: { key: 'AIza-user', byok: true } };
    expect(await h.preflightImageRun({ specs: [NB21], keys: byokGemini, doc: lockedDoc(), caps: resolveStudioCaps({ byok: true, isAdmin: false }) })).toEqual({
      ok: true,
      options: []
    });
  });

  it('still counts real upstream failures (429 throttle, 5xx, 408 / 504 timeouts, network)', () => {
    const upstream = [
      thrownByImageClient(429, 'Provider returned error: upstream Google rate limited', { route: 'openrouter', byok: false }),
      thrownByImageClient(503, 'Service Unavailable', { route: 'openrouter', byok: false }),
      thrownByImageClient(504, 'Gateway Timeout', { route: 'openrouter', byok: false })
    ];
    for (const err of upstream) {
      expect(err.retryable).toBe(true);
      expect(outcomeFromError(err, { route: 'openrouter', model: OR_ID }).code).not.toBe(NOT_UPSTREAM_CODE);
    }
    const h = createModelHealth({ now: () => T0 });
    for (const err of upstream) h.recordImageOutcome(outcomeFromError(err, { route: 'openrouter', model: OR_ID }, T0));
    expect(h.routeState('openrouter', OR_ID).state).toBe('down');
    expect(h.breakerEvents()).toHaveLength(1);
  });

  it('NOT_AVAILABLE (a studio config error such as a missing platform key) is not a model failure', () => {
    const h = createModelHealth({ now: () => T0 });
    const config = new StudioError('NOT_AVAILABLE', "The platform image key isn't configured.", { status: 503 });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome(outcomeFromError(config, { route: 'openrouter', model: OR_ID }, T0));
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'NOT_AVAILABLE' });
    expect(h.routeState('openrouter', OR_ID).state).toBe('unknown');
  });
});

/**
 * A minimal stand-in for imageClient's runOnRoute as M1-LOCK-SERVER wires it (waveNotes item 1): ask
 * acquireRouteCall before EVERY attempt (each transient retry too), record every answer, and throw the paused-route
 * error without calling the provider when the route says no.
 */
const drawOnce = async (
  h: ModelHealthPort,
  provider: () => Promise<'ok' | 429>,
  calls: { n: number },
  at: () => number,
  /** imageClient's ≥ 4 s RATE_LIMIT backoff before its one transient retry. */
  backoff: () => Promise<void> = async () => undefined
) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await backoff();
    const permit = h.acquireRouteCall('openrouter', OR_ID, at());
    if (!permit.allowed) throw routePausedError({ route: 'openrouter', model: OR_ID, nickname: NB21.nickname });
    calls.n += 1;
    const answer = await provider();
    if (answer === 'ok') {
      h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: true, at: at() });
      return 'drawn';
    }
    h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', at: at() });
  }
  throw new StudioError('RATE_LIMIT', 'busy', { status: 429, retryable: true });
};

describe('acquireRouteCall (half-open: one call is allowed)', () => {
  it('16:52 shape: three parallel style jobs make zero calls once the breaker opens, then one probe at a time', async () => {
    let t = T0;
    const h = createModelHealth({ now: () => t });
    const calls = { n: 0 };
    let answer: 'ok' | 429 = 429;
    const provider = async () => answer;
    // Three parallel jobs; every call answers 429. The first attempts open the breaker; the retries (after the
    // backoff) never call.
    let endBackoff: () => void = () => undefined;
    const backoffOver = new Promise<void>((resolve) => (endBackoff = resolve));
    const jobs = [0, 1, 2].map(() => drawOnce(h, provider, calls, () => t, () => backoffOver));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.n).toBe(3);
    expect(h.routeState('openrouter', OR_ID).state).toBe('down');
    endBackoff();
    const first = await Promise.allSettled(jobs);
    expect(calls.n).toBe(3); // 12 calls in the incident; 3 here, and nothing after the breaker opened
    for (const r of first) {
      expect(r.status).toBe('rejected');
      const err = (r as PromiseRejectedResult).reason;
      expect(isRoutePausedError(err)).toBe(true);
      expect(err).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, spentUsd: 0, imageFailure: { route: 'openrouter' } });
    }
    // Still down: nobody may call.
    t = T0 + HEALTH_THRESHOLDS.breakerOpenMs - 1;
    expect(h.acquireRouteCall('openrouter', OR_ID)).toEqual({ allowed: false, state: 'down' });
    // Half-open: exactly one caller gets the probe; the others wait.
    t = T0 + HEALTH_THRESHOLDS.breakerOpenMs + 1;
    expect([h.acquireRouteCall('openrouter', OR_ID), h.acquireRouteCall('openrouter', OR_ID), h.acquireRouteCall('openrouter', OR_ID)]).toEqual([
      { allowed: true, state: 'degraded' },
      { allowed: false, state: 'degraded' },
      { allowed: false, state: 'degraded' }
    ]);
    // The probe fails → down again for another breakerOpenMs, and nobody calls.
    h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
    expect(h.acquireRouteCall('openrouter', OR_ID)).toEqual({ allowed: false, state: 'down' });
    // Half-open again; the probe is never answered → after the probe timeout another caller may try.
    const lastFail = t;
    t = lastFail + HEALTH_THRESHOLDS.breakerOpenMs + 1;
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(true);
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(false);
    t += HALF_OPEN_PROBE_TIMEOUT_MS;
    const probeAt = t;
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(true);
    // That probe succeeds → closed: everyone may call again.
    answer = 'ok';
    h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: true, at: probeAt });
    expect(h.routeState('openrouter', OR_ID).state).toBe('ok');
    expect([h.acquireRouteCall('openrouter', OR_ID), h.acquireRouteCall('openrouter', OR_ID)].every((p) => p.allowed)).toBe(true);
    const before = calls.n;
    expect(await drawOnce(h, provider, calls, () => t)).toBe('drawn');
    expect(calls.n).toBe(before + 1);
  });

  it('a key-scoped answer to the probe releases it too (the call came back), without counting', () => {
    let t = T0;
    const h = createModelHealth({ now: () => t });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
    t = T0 + HEALTH_THRESHOLDS.breakerOpenMs + 1;
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(true);
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(false);
    h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', keyScoped: true });
    expect(h.routeState('openrouter', OR_ID).state).toBe('degraded'); // not counted
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(true); // the next probe
  });

  it('a fresh, ok or merely wary route lets every call through; routes are independent', () => {
    const h = createModelHealth({ now: () => T0 });
    expect(h.acquireRouteCall('gemini', GEM_ID)).toEqual({ allowed: true, state: 'unknown' });
    h.recordImageOutcome({ route: 'gemini', model: GEM_ID, ok: false, code: 'RATE_LIMIT' });
    expect([h.acquireRouteCall('gemini', GEM_ID), h.acquireRouteCall('gemini', GEM_ID)]).toEqual([
      { allowed: true, state: 'degraded' },
      { allowed: true, state: 'degraded' }
    ]);
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: '503' });
    expect(h.acquireRouteCall('openrouter', OR_ID).allowed).toBe(false);
    expect(h.acquireRouteCall('gemini', GEM_ID).allowed).toBe(true);
  });

  it('the paused-route error reads as a calm provider pause and is never counted if recorded by mistake', () => {
    const err = routePausedError({ route: 'gemini', model: GEM_ID, nickname: NB21.nickname, reason: 'Our last 3 calls failed (RATE_LIMIT).' });
    expect(err.userMessage).toBe(
      `The image provider is busy with ${NB21.nickname} on Gemini right now (Our last 3 calls failed (RATE_LIMIT)), so this image wasn't sent and nothing was charged for it.`
    );
    expect(isKeyScopedFailure(err)).toBe(false);
    expect(outcomeFromError(err, { route: 'gemini', model: GEM_ID }).code).toBe(NOT_UPSTREAM_CODE);
    expect(isRoutePausedError(new StudioError('PROVIDER_ERROR', 'x'))).toBe(false);
  });
});

describe('getModelHealth', () => {
  it('combines public data with observations and limits routes to the keys the caller holds', async () => {
    const f = scriptedFetch();
    f.set(async () => new Response(endpointsBody(failing), { status: 200 }));
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    const platformOnly = await h.getModelHealth(NB21, { keys: PLATFORM });
    expect(platformOnly.routes.map((r) => r.route)).toEqual(['openrouter']);
    expect(platformOnly.state).toBe('down');
    expect(platformOnly.routes[0]).toMatchObject({ route: 'openrouter', model: OR_ID, state: 'down', source: 'openrouter', providers: failing, checkedAt: T0 });
    const both = await h.getModelHealth(NB21, { keys: PLATFORM_BOTH });
    expect(both.routes.map((r) => `${r.route}:${r.state}:${r.source}`)).toEqual(['openrouter:down:openrouter', 'gemini:unknown:none']);
    expect(both.state).toBe('unknown'); // best reachable route wins; unknown never blocks
    const all = await h.getModelHealth(NB21); // no keys: every route, informational
    expect(all.routes).toHaveLength(2);
    expect(f.calls).toHaveLength(1); // one public fetch for all three reads (cached)
  });

  it('agrees with the preflight when the two keys have different payers (own Gemini key + platform OpenRouter key)', async () => {
    const f = scriptedFetch(); // OpenRouter itself is serving fine…
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    // …but the user's own Gemini key routes Google models to Gemini direct (keys.ts prefersGeminiDirect), and that
    // route is failing. The platform OpenRouter key has another payer, so a run never silently moves there.
    const mixed: StudioKeys = { gemini: { key: 'AIza-user', byok: true }, openrouter: { key: 'sk-or-platform', byok: false } };
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'gemini', model: GEM_ID, ok: false, code: 'RATE_LIMIT', at: T0 - 10_000 });
    const pre = await h.preflightImageRun({ specs: [NB21], keys: mixed, doc: lockedDoc(), caps: resolveStudioCaps({ byok: true, isAdmin: false }) });
    expect(pre.ok).toBe(false);
    const health = await h.getModelHealth(NB21, { keys: mixed });
    expect(health.routes.map((r) => `${r.route}:${r.state}`)).toEqual(['gemini:down']);
    expect(health.state).toBe('down');
    // Same payer on both routes: the alternate is a real way round, so both routes count and the best one wins.
    const sameUser: StudioKeys = { gemini: { key: 'AIza-user', byok: true }, openrouter: { key: 'sk-or-user', byok: true } };
    const both = await h.getModelHealth(NB21, { keys: sameUser });
    expect(both.routes.map((r) => `${r.route}:${r.state}`)).toEqual(['openrouter:ok', 'gemini:down']);
    expect(both.state).toBe('ok');
    expect((await h.preflightImageRun({ specs: [NB21], keys: sameUser, doc: lockedDoc(), caps: paidCaps })).ok).toBe(true);
  });

  it('names the source that decided the state, with that source’s own time', async () => {
    const f = scriptedFetch(); // OpenRouter says the provider is serving fine…
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', at: T0 - 60_000 });
    const [route] = (await h.getModelHealth(NB21, { keys: PLATFORM })).routes;
    // …but our own calls are failing: the state is down and the source says so ("our recent calls, 1 min ago").
    expect(route).toMatchObject({ state: 'down', source: 'observed', checkedAt: T0 - 60_000, providers: serving });
    const quiet = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    expect((await quiet.getModelHealth(NB21, { keys: PLATFORM })).routes[0]).toMatchObject({ state: 'ok', source: 'openrouter', checkedAt: T0 });
  });
});

describe('preflightImageRun', () => {
  it('picks the same-payer alternate route when the primary is down (same model, no look change)', async () => {
    const f = scriptedFetch();
    f.set(async () => new Response(endpointsBody(failing), { status: 200 }));
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    const out = await h.preflightImageRun({ specs: [NB21], keys: PLATFORM_BOTH, doc: lockedDoc(), caps: paidCaps });
    expect(out).toEqual({ ok: true, useRoute: 'gemini', options: [] });
    // A different payer on the other route is never used silently.
    const mixed: StudioKeys = { openrouter: { key: 'sk-or-platform', byok: false }, gemini: { key: 'AIza-user', byok: true } };
    const noAlt = await h.preflightImageRun({ specs: [NB21], keys: { ...mixed, gemini: undefined } as StudioKeys, doc: lockedDoc(), caps: paidCaps });
    expect(noAlt.ok).toBe(false);
  });

  it('blocks when every reachable route is down: no image call, no reservation, one set of options with real prices and redraw counts', async () => {
    const f = scriptedFetch();
    f.set(async () => new Response(endpointsBody(failing), { status: 200 }));
    let t = T0;
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => t });
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'gemini', model: GEM_ID, ok: false, code: 'RATE_LIMIT', at: T0 - 20_000 });
    const images = fakeImages();
    const billing = fakeBilling();
    const doc = lockedDoc();
    const out = await h.preflightImageRun({ specs: [NB21, NB21], keys: PLATFORM_BOTH, doc, caps: paidCaps });
    expect(out.ok).toBe(false);
    expect(out.useRoute).toBeUndefined();
    expect(out.blocked).toEqual([{ modelId: 'nano-banana-2.1', state: 'down', reason: expect.stringMatching(/provider|uptime/i) }]);
    expect(images.calls).toHaveLength(0);
    expect(billing.reserves).toHaveLength(0);
    // Options: wait first (free), then the switch with the REAL registry price and the real redraw count.
    expect(out.options[0]).toEqual({ kind: 'wait_and_retry' });
    const sw = out.options.find((o) => o.kind === 'switch_model');
    expect(sw).toBeDefined();
    if (sw?.kind !== 'switch_model') throw new Error('no switch option');
    const res = redrawResolution(doc, PRO.id, 'page');
    expect(sw.modelId).toBe(PRO.id);
    expect(sw.nickname).toBe(PRO.nickname);
    expect(sw.consistency).toBe('same_family');
    expect(sw.usdPerImage).toBeCloseTo(imagePriceUsd(PRO, res) * PLATFORM_MARKUP, 4);
    const targets = drawnTargets(doc);
    expect(sw.redrawCount).toBe(targets.pages.length + 1); // 2 drawn pages + cover; the undrawn page is not counted
    expect(sw.redrawCount).toBe(3);
    expect(sw.redrawUsd).toBeCloseTo(redrawQuote(doc, PRO.id, 'pages_cover', registryPriceBook(), false).usd!, 4);
    expect(sw.redrawUsd).toBeGreaterThan(0);
    // The blocked model is never offered as its own alternative; nothing is duplicated for the repeated spec.
    expect(out.options.filter((o) => o.kind === 'switch_model' && o.modelId === NB21.id)).toHaveLength(0);
    expect(out.options.filter((o) => o.kind === 'wait_and_retry')).toHaveLength(1);
    // The breaker-driven wait carries an ETA; the public-only route does not.
    t = T0;
    const geminiOnly = await h.preflightImageRun({ specs: [NB21], keys: { gemini: { key: 'AIza-platform', byok: false } }, doc, caps: paidCaps });
    expect(geminiOnly.options[0]).toEqual({ kind: 'wait_and_retry', etaHint: expect.stringMatching(/^about \d+ min$/) });
  });

  it('offers "add a key" for the other route when the user holds no key for it (never a silent payer change)', async () => {
    const f = scriptedFetch();
    f.set(async () => new Response(endpointsBody(failing), { status: 200 }));
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    const out = await h.preflightImageRun({ specs: [NB21], keys: PLATFORM, doc: lockedDoc(), caps: paidCaps });
    expect(out.ok).toBe(false);
    expect(out.options).toContainEqual({ kind: 'add_key', route: 'gemini', label: `Add a Gemini key to reach ${NB21.nickname} directly` });
    expect(out.options.some((o) => o.kind === 'other_route')).toBe(false);
    // A key of ANOTHER payer on the other route is never offered as a way round (not even as a button).
    const mixedKeys: StudioKeys = { openrouter: { key: 'sk-or-user', byok: true }, gemini: { key: 'AIza-platform', byok: false } };
    const mixed = await h.preflightImageRun({ specs: [NB21], keys: mixedKeys, doc: lockedDoc(), caps: paidCaps });
    expect(mixed.ok).toBe(false);
    expect(mixed.useRoute).toBeUndefined();
    expect(mixed.options.some((o) => o.kind === 'other_route' || o.kind === 'add_key')).toBe(false);
    // The article reads right for either route.
    const orOnly = await h.preflightImageRun({ specs: [NB21], keys: { gemini: { key: 'AIza-user', byok: true } }, doc: lockedDoc(), caps: paidCaps });
    expect(orOnly.ok).toBe(true); // Gemini direct has no public data and nothing observed: unknown never blocks
    // When the other route is failing for everyone too (shared observations), adding a key would not help.
    for (let i = 0; i < 3; i += 1) h.recordImageOutcome({ route: 'gemini', model: GEM_ID, ok: false, code: 'PROVIDER_ERROR' });
    const both = await h.preflightImageRun({ specs: [NB21], keys: PLATFORM, doc: lockedDoc(), caps: paidCaps });
    expect(both.ok).toBe(false);
    expect(both.options.some((o) => o.kind === 'add_key')).toBe(false);
    expect(both.options[0]).toEqual({ kind: 'wait_and_retry' });
  });

  it('BYOK prices carry no markup; free-plan caps get no switch option; unknown never blocks', async () => {
    const f = scriptedFetch();
    f.set(nb21Failing);
    const h = createModelHealth({ fetch: f.fetchImpl, now: () => T0 });
    const doc = lockedDoc();
    const byok = await h.preflightImageRun({ specs: [NB21], keys: { openrouter: { key: 'sk-or-user', byok: true } }, doc, caps: resolveStudioCaps({ byok: true, isAdmin: false }) });
    const sw = byok.options.find((o) => o.kind === 'switch_model');
    if (sw?.kind !== 'switch_model') throw new Error('no switch option');
    expect(sw.usdPerImage).toBeCloseTo(imagePriceUsd(PRO, redrawResolution(doc, PRO.id, 'page')), 4);
    expect(sw.redrawUsd).toBeCloseTo(redrawQuote(doc, PRO.id, 'pages_cover', registryPriceBook(), true).usd!, 4);
    const free = await h.preflightImageRun({ specs: [NB21], keys: PLATFORM, doc });
    expect(free.ok).toBe(false);
    expect(free.options.some((o) => o.kind === 'switch_model')).toBe(false);
    expect(free.options[0]).toEqual({ kind: 'wait_and_retry' });
    // Unknown: the public fetch fails and nothing was observed → the run goes ahead (never blocked on no data).
    const g = scriptedFetch();
    g.set(async () => new Response('x', { status: 500 }));
    const quiet = createModelHealth({ fetch: g.fetchImpl, now: () => T0 });
    expect(await quiet.preflightImageRun({ specs: [NB21], keys: PLATFORM, doc, caps: paidCaps })).toEqual({ ok: true, options: [] });
    // Degraded never blocks either.
    const d = scriptedFetch();
    d.set(async () => new Response(endpointsBody([{ name: 'Google AI Studio', status: 0, uptime30m: 85, uptime1d: 99 }]), { status: 200 }));
    const slow = createModelHealth({ fetch: d.fetchImpl, now: () => T0 });
    expect((await slow.preflightImageRun({ specs: [NB21], keys: PLATFORM, doc, caps: paidCaps })).ok).toBe(true);
    // No key at all is not an outage (jobs.ts says "add a key" itself).
    expect(await quiet.preflightImageRun({ specs: [NB21], keys: {}, doc, caps: paidCaps })).toEqual({ ok: true, options: [] });
  });
});

describe('process-wide port + fake', () => {
  let previous: ReturnType<typeof __setModelHealthForTests>;
  beforeEach(() => {
    previous = __setModelHealthForTests(null);
  });
  afterEach(() => {
    __setModelHealthForTests(previous);
  });

  it('the module-level functions share one breaker', () => {
    for (let i = 0; i < 3; i += 1) recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
    expect(routeState('openrouter', OR_ID).state).toBe('down');
  });

  it('fakeModelHealth replays the 16:52 shape: a single failing provider blocks the run with wait / add-key / switch options and records every call', async () => {
    const fake = fakeModelHealth({ now: T0 });
    __setModelHealthForTests(fake);
    fake.setPublic(OR_ID, failing);
    const out = await preflightImageRun({ specs: [NB21], keys: PLATFORM, doc: lockedDoc(), caps: paidCaps });
    expect(out.ok).toBe(false);
    expect(out.options.map((o) => o.kind)).toEqual(['wait_and_retry', 'add_key', 'switch_model']);
    expect(fake.preflights).toHaveLength(1);
    // The blocked model's public data, then the switch candidate's (a down model is never offered).
    expect(fake.fetches.map((f) => f.url)).toEqual([openrouterEndpointsUrl(OR_ID), openrouterEndpointsUrl(PRO.routes.openrouter!)]);
    expect(fake.fetches.every((f) => Object.keys(f.headers).length === 0)).toBe(true);
    // Forced states skip the setup; the clock moves with setNow.
    fake.reset();
    fake.forceRoute('openrouter', OR_ID, 'down', 'forced');
    expect(fake.routeState('openrouter', OR_ID)).toMatchObject({ state: 'down', reason: 'forced' });
    expect((await fake.getModelHealth(NB21, { keys: PLATFORM })).state).toBe('down');
    fake.forceRoute('openrouter', OR_ID, undefined);
    expect(fake.routeState('openrouter', OR_ID).state).toBe('unknown');
    fake.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT', keyScoped: true });
    expect(fake.outcomes).toHaveLength(1);
    expect(fake.routeState('openrouter', OR_ID).state).toBe('unknown');
    // The module-level acquireRouteCall goes through the fake and is recorded (forced down → refused).
    fake.forceRoute('openrouter', OR_ID, 'down');
    expect(acquireRouteCall('openrouter', OR_ID)).toEqual({ allowed: false, state: 'down' });
    fake.forceRoute('openrouter', OR_ID, undefined);
    for (let i = 0; i < 3; i += 1) fake.recordImageOutcome({ route: 'openrouter', model: OR_ID, ok: false, code: 'RATE_LIMIT' });
    fake.setNow(T0 + HEALTH_THRESHOLDS.breakerOpenMs + 1);
    expect([acquireRouteCall('openrouter', OR_ID).allowed, acquireRouteCall('openrouter', OR_ID).allowed]).toEqual([true, false]);
    expect(fake.acquires.map((a) => a.allowed)).toEqual([false, true, false]);
  });
});
