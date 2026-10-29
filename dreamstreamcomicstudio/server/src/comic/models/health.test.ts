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
import {
  PUBLIC_HEALTH_STALE_MAX_MS,
  PUBLIC_HEALTH_TIMEOUT_MS,
  PUBLIC_HEALTH_TTL_MS,
  __setModelHealthForTests,
  createModelHealth,
  isKeyScopedFailure,
  openrouterEndpointsUrl,
  outcomeFromError,
  parseOpenRouterEndpoints,
  preflightImageRun,
  recordImageOutcome,
  registryPriceBook,
  routeState
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
  });
});
