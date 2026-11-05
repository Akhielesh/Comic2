// reliability.md §1 / §5 "Pure": assessRouteHealth table (public-only, observed-only, both; thresholds; key-scoped
// failures ignored; half-open after breakerOpenMs), combineModelHealth, and the outage-option validator.

import { describe, expect, it } from 'vitest';
import { HEALTH_THRESHOLDS, assessRouteHealth, combineModelHealth, normalizeOutageOption, type ProviderHealth, type RouteHealth } from './modelHealth';

const NOW = 1_761_150_000_000;
const provider = (over: Partial<ProviderHealth> = {}): ProviderHealth => ({ name: 'Google AI Studio', status: 0, uptime30m: 99.5, uptime1d: 97.7, ...over });
const route = (state: RouteHealth['state'], r: RouteHealth['route'] = 'openrouter'): RouteHealth => ({ route: r, model: 'm', state, checkedAt: NOW, source: 'observed' });

describe('assessRouteHealth', () => {
  it.each<[string, Parameters<typeof assessRouteHealth>[0], RouteHealth['state']]>([
    ['no data at all → unknown', { now: NOW }, 'unknown'],
    ['empty provider list → unknown', { providers: [], now: NOW }, 'unknown'],
    ['one serving provider with good uptime → ok', { providers: [provider()], now: NOW }, 'ok'],
    ['uptime30m null on every provider, status fine → ok (the 24 h figure is for display)', { providers: [provider({ uptime30m: null })], now: NOW }, 'ok'],
    ['a provider with no status and no uptime30m carries no data → unknown, never ok', { providers: [provider({ status: null, uptime30m: null, uptime1d: null })], now: NOW }, 'unknown'],
    ['no data on one provider, status null but uptime known on another → the uptime counts', { providers: [provider({ status: null, uptime30m: null, uptime1d: null }), provider({ name: 'Vertex', status: null, uptime30m: 99 })], now: NOW }, 'ok'],
    ['no data on one provider, the other reports a problem → down (the only evidence is bad)', { providers: [provider({ status: null, uptime30m: null, uptime1d: null }), provider({ name: 'Vertex', status: 1 })], now: NOW }, 'down'],
    ['status null with a bad uptime30m → that uptime is the evidence', { providers: [provider({ status: null, uptime30m: 50 })], now: NOW }, 'down'],
    ['every provider status ≠ 0 → down', { providers: [provider({ status: 1 }), provider({ name: 'Vertex', status: 2 })], now: NOW }, 'down'],
    ['one provider down, one serving → the serving one counts', { providers: [provider({ status: 1 }), provider({ name: 'Vertex', uptime30m: 100 })], now: NOW }, 'ok'],
    ['best uptime30m below 70 → down', { providers: [provider({ uptime30m: 60 }), provider({ name: 'Vertex', uptime30m: 69.9 })], now: NOW }, 'down'],
    ['best uptime30m 70–95 → degraded', { providers: [provider({ uptime30m: 50 }), provider({ name: 'Vertex', uptime30m: 94.9 })], now: NOW }, 'degraded'],
    ['best uptime30m exactly 95 → ok', { providers: [provider({ uptime30m: 95 })], now: NOW }, 'ok'],
    ['observed: no calls → unknown', { observed: { ok: 0, upstreamFailures: 0 }, now: NOW }, 'unknown'],
    ['observed: successes only → ok', { observed: { ok: 5, upstreamFailures: 0, lastSuccessAt: NOW - 1000 }, now: NOW }, 'ok'],
    ['observed: 3 upstream failures just now, no success since → down (breaker open)', { observed: { ok: 2, upstreamFailures: 3, lastCode: '429', lastFailureAt: NOW - 10_000, lastSuccessAt: NOW - 60_000 }, now: NOW }, 'down'],
    ['observed: 3 failures but a success after them → ok', { observed: { ok: 3, upstreamFailures: 3, lastFailureAt: NOW - 60_000, lastSuccessAt: NOW - 10_000 }, now: NOW }, 'ok'],
    ['observed: 2 failures (under the threshold), last call failed → degraded, never down', { observed: { ok: 4, upstreamFailures: 2, lastCode: '503', lastFailureAt: NOW - 1000 }, now: NOW }, 'degraded'],
    ['observed: breaker open window elapsed → half-open = degraded (one call allowed)', { observed: { ok: 0, upstreamFailures: 3, lastFailureAt: NOW - HEALTH_THRESHOLDS.breakerOpenMs }, now: NOW }, 'degraded'],
    ['observed: one ms before the open window ends → still down', { observed: { ok: 0, upstreamFailures: 3, lastFailureAt: NOW - HEALTH_THRESHOLDS.breakerOpenMs + 1 }, now: NOW }, 'down'],
    ['key-scoped failures are not upstream failures: zero counted → unknown, never down', { observed: { ok: 0, upstreamFailures: 0, lastCode: 'KEY_REJECTED', lastFailureAt: NOW - 100 }, now: NOW }, 'unknown'],
    ['both: public ok + breaker open → down (the worse wins)', { providers: [provider()], observed: { ok: 0, upstreamFailures: 4, lastFailureAt: NOW - 100 }, now: NOW }, 'down'],
    ['both: public degraded + observed ok → degraded', { providers: [provider({ uptime30m: 80 })], observed: { ok: 2, upstreamFailures: 0, lastSuccessAt: NOW }, now: NOW }, 'degraded'],
    ['both: public unknown + observed ok → ok', { providers: [], observed: { ok: 1, upstreamFailures: 0, lastSuccessAt: NOW }, now: NOW }, 'ok'],
    ['both: public down + observed unknown → down', { providers: [provider({ status: 1 })], observed: { ok: 0, upstreamFailures: 0 }, now: NOW }, 'down']
  ])('%s', (_name, input, state) => {
    expect(assessRouteHealth(input).state).toBe(state);
  });

  it('reasons are short, user-safe and name the source of the trouble', () => {
    expect(assessRouteHealth({ observed: { ok: 0, upstreamFailures: 3, lastCode: '429', lastFailureAt: NOW }, now: NOW })).toEqual({ state: 'down', reason: 'Our last 3 calls failed (429)' });
    expect(assessRouteHealth({ providers: [provider({ uptime30m: 80.4 })], now: NOW })).toEqual({ state: 'degraded', reason: 'Provider uptime 80% in the last 30 min' });
    expect(assessRouteHealth({ providers: [provider({ status: 3 })], now: NOW }).reason).toBe('Every provider reports a problem');
    expect(assessRouteHealth({ providers: [provider()], now: NOW })).toEqual({ state: 'ok' });
    // The worse side's reason is the one shown.
    const both = assessRouteHealth({ providers: [provider({ uptime30m: 80 })], observed: { ok: 0, upstreamFailures: 3, lastCode: '503', lastFailureAt: NOW }, now: NOW });
    expect(both).toEqual({ state: 'down', reason: 'Our last 3 calls failed (503)' });
  });

  it('thresholds are the reliability.md numbers', () => {
    expect(HEALTH_THRESHOLDS).toEqual({ degradedUptime30m: 95, downUptime30m: 70, breakerFailures: 3, breakerWindowMs: 300_000, breakerOpenMs: 120_000 });
  });
});

describe('combineModelHealth (best reachable route wins; unknown never blocks)', () => {
  it.each<[RouteHealth['state'][], RouteHealth['state']]>([
    [[], 'unknown'],
    [['down'], 'down'],
    [['down', 'down'], 'down'],
    [['down', 'unknown'], 'unknown'],
    [['down', 'degraded'], 'degraded'],
    [['down', 'ok'], 'ok'],
    [['degraded', 'unknown'], 'degraded'],
    [['ok', 'down', 'degraded', 'unknown'], 'ok']
  ])('%j → %s', (states, expected) => {
    expect(combineModelHealth(states.map((s, i) => route(s, i % 2 ? 'gemini' : 'openrouter')))).toBe(expected);
  });
});

describe('normalizeOutageOption', () => {
  it('accepts every kind with its required fields and rejects the rest', () => {
    expect(normalizeOutageOption({ kind: 'wait_and_retry' })).toEqual({ kind: 'wait_and_retry' });
    expect(normalizeOutageOption({ kind: 'wait_and_retry', etaHint: '' })).toEqual({ kind: 'wait_and_retry' });
    expect(normalizeOutageOption({ kind: 'other_route', route: 'gemini', label: 'Gemini key' })).toEqual({ kind: 'other_route', route: 'gemini', label: 'Gemini key' });
    expect(normalizeOutageOption({ kind: 'add_key', route: 'openrouter', label: 'Add key', extra: 1 })).toEqual({ kind: 'add_key', route: 'openrouter', label: 'Add key' });
    const sw = { kind: 'switch_model', modelId: 'nano-banana-pro', nickname: 'Nano Banana Pro', usdPerImage: 0.1344, consistency: 'different', redrawCount: 6.7, redrawUsd: 0.83 };
    expect(normalizeOutageOption(sw)).toEqual({ ...sw, redrawCount: 6 });
    for (const bad of [null, 'wait', { kind: 'nope' }, { kind: 'other_route', route: 'mars', label: 'x' }, { kind: 'add_key', route: 'gemini' }, { ...sw, usdPerImage: -1 }, { ...sw, consistency: 'maybe' }, { ...sw, redrawUsd: NaN }]) {
      expect(normalizeOutageOption(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
