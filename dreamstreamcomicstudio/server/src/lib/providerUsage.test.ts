import { describe, it, expect, beforeEach } from 'vitest';
import {
  providerForUrl,
  assertProviderBudget,
  noteProviderCall,
  releaseProviderReservation,
  getProviderUsageSnapshot,
  ProviderBudgetError,
  __resetProviderUsage
} from './providerUsage.js';

const T0 = Date.parse('2026-06-11T12:00:00Z');

beforeEach(() => {
  __resetProviderUsage();
  delete process.env.PROVIDER_BUDGETS;
});

describe('providerForUrl', () => {
  it('maps known hosts to provider names', () => {
    expect(providerForUrl('https://api.coingecko.com/api/v3/simple/price?x=1')).toBe('coingecko');
    expect(providerForUrl('https://api.met.no/weatherapi/locationforecast/2.0/complete')).toBe('metno');
    expect(providerForUrl('https://query1.finance.yahoo.com/v8/finance/chart/AAPL')).toBe('yahoo');
    expect(providerForUrl('http://ip-api.com/json/8.8.8.8')).toBe('ip-api');
  });
  it('maps the configured SearXNG instance', () => {
    process.env.SEARXNG_URL = 'https://searxng-production-e7df.up.railway.app';
    __resetProviderUsage();
    expect(providerForUrl('https://searxng-production-e7df.up.railway.app/search?q=x')).toBe('searxng');
    delete process.env.SEARXNG_URL;
  });
  it('falls back to the hostname for unknown providers', () => {
    expect(providerForUrl('https://example.org/api')).toBe('example.org');
  });
  it('matches the host only: a provider named in the path or query string never decides', () => {
    expect(providerForUrl('https://example.org/api.tavily.com/?q=bing.com')).toBe('example.org');
    expect(providerForUrl('https://en.wikipedia.org/w/api.php?search=api.tavily.com')).toBe('wikipedia');
    expect(providerForUrl('https://html.duckduckgo.com/html/?q=x')).toBe('duckduckgo');
    expect(providerForUrl('https://query2.finance.yahoo.com/v8/finance/chart/X')).toBe('yahoo');
    expect(providerForUrl('https://lz4.overpass-api.de/api/interpreter')).toBe('overpass');
    expect(providerForUrl('not a url')).toBe('unknown');
  });
});

describe('budget enforcement', () => {
  const url = 'http://ip-api.com/json/1.1.1.1'; // budget: 40/min, 1500/day

  it('blocks once the per-minute budget is reached', () => {
    for (let i = 0; i < 40; i++) assertProviderBudget(url, T0 + i * 100);
    expect(() => assertProviderBudget(url, T0 + 5000)).toThrow(ProviderBudgetError);
  });

  it('frees the minute window as time passes', () => {
    for (let i = 0; i < 40; i++) assertProviderBudget(url, T0);
    expect(() => assertProviderBudget(url, T0 + 61_000)).not.toThrow();
  });

  it('blocks at the daily cap and resets on a new UTC day', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ 'ip-api': { perMin: 10_000, perDay: 3 } });
    for (let i = 0; i < 3; i++) assertProviderBudget(url, T0 + i * 120_000);
    expect(() => assertProviderBudget(url, T0 + 600_000)).toThrow(ProviderBudgetError);
    // Next UTC day → fresh budget.
    expect(() => assertProviderBudget(url, T0 + 24 * 60 * 60_000)).not.toThrow();
  });

  it('honors PROVIDER_BUDGETS env overrides', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ coingecko: { perMin: 1 } });
    const cg = 'https://api.coingecko.com/api/v3/search?query=x';
    assertProviderBudget(cg, T0);
    expect(() => assertProviderBudget(cg, T0 + 1000)).toThrow(ProviderBudgetError);
  });

  it('reserves at check time: calls still in flight count, so parallel checks cannot all pass', () => {
    // 50 checks at the same instant, none of them settled yet: only the 40 the minute allows pass.
    let passed = 0;
    for (let i = 0; i < 50; i++) {
      try {
        assertProviderBudget(url, T0);
        passed += 1;
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderBudgetError);
      }
    }
    expect(passed).toBe(40);
  });

  it('recording the outcome does not count the call twice; a release gives the slot back', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ 'ip-api': { perMin: 2, perDay: 100 } });
    assertProviderBudget(url, T0);
    noteProviderCall(url, true, T0 + 10);
    assertProviderBudget(url, T0 + 20);
    noteProviderCall(url, false, T0 + 30);
    expect(getProviderUsageSnapshot(T0 + 40).find((r) => r.provider === 'ip-api')).toMatchObject({ todayCalls: 2, todayErrors: 1 });
    expect(() => assertProviderBudget(url, T0 + 50)).toThrow(ProviderBudgetError);
    releaseProviderReservation(url, T0 + 60);
    expect(() => assertProviderBudget(url, T0 + 70)).not.toThrow();
    expect(getProviderUsageSnapshot(T0 + 80).find((r) => r.provider === 'ip-api')?.todayCalls).toBe(2);
  });
});

describe('usage snapshot & health', () => {
  it('reports counts, errors and health flags', () => {
    const cg = 'https://api.coingecko.com/api/v3/search?query=x';
    for (let i = 0; i < 6; i++) {
      assertProviderBudget(cg, T0 + i * 5_000);
      noteProviderCall(cg, i % 2 === 0, T0 + i * 5_000);
    }
    const rows = getProviderUsageSnapshot(T0 + 40_000);
    const row = rows.find((r) => r.provider === 'coingecko')!;
    expect(row.todayCalls).toBe(6);
    expect(row.todayErrors).toBe(3);
    expect(row.health).toBe('failing'); // 50% error ratio with ≥5 calls
  });

  it('flags near-cap usage', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ frankfurter: { perMin: 10_000, perDay: 10 } });
    const fx = 'https://api.frankfurter.app/latest?from=USD&to=EUR';
    for (let i = 0; i < 9; i++) assertProviderBudget(fx, T0 + i * 120_000);
    const row = getProviderUsageSnapshot(T0 + 20 * 60_000).find((r) => r.provider === 'frankfurter')!;
    expect(row.dayUsedPct).toBe(90);
    expect(row.health).toBe('near-cap');
  });
});

describe('account-wise cloud deltas', () => {
  it('attributes deltas to the ALS account and accumulates per day', async () => {
    const { runWithAccount } = await import('./accountContext.js');
    const url = 'https://api.frankfurter.app/latest?from=USD&to=EUR';
    const call = (ok: boolean, at: number) => {
      assertProviderBudget(url, at);
      noteProviderCall(url, ok, at);
    };
    runWithAccount('user-123', () => {
      call(true, T0);
      call(false, T0 + 1000);
    });
    call(true, T0 + 2000); // no account context → 'anon'
    const { __pendingUsageDeltas } = await import('./providerUsage.js');
    const deltas = __pendingUsageDeltas();
    const user = deltas.find((d) => d.account_id === 'user-123')!;
    const anon = deltas.find((d) => d.account_id === 'anon')!;
    expect(user).toMatchObject({ provider: 'frankfurter', day: '2026-06-11', calls: 2, errors: 1, blocked: 0 });
    expect(anon).toMatchObject({ calls: 1, errors: 0 });
  });

  it('counts budget blocks per account and survives a failed flush', async () => {
    const { runWithAccount } = await import('./accountContext.js');
    const { setUsageCloudSink, flushUsageDeltas, __pendingUsageDeltas } = await import('./providerUsage.js');
    process.env.PROVIDER_BUDGETS = JSON.stringify({ frankfurter: { perMin: 1, perDay: 1000 } });
    const url = 'https://api.frankfurter.app/latest?from=USD&to=EUR';
    runWithAccount('user-9', () => {
      assertProviderBudget(url, T0);
      expect(() => assertProviderBudget(url, T0 + 100)).toThrow(ProviderBudgetError);
    });
    expect(__pendingUsageDeltas().find((d) => d.account_id === 'user-9')?.blocked).toBe(1);
    // Failing sink → deltas restored for retry.
    setUsageCloudSink(async () => { throw new Error('db down'); });
    await flushUsageDeltas();
    expect(__pendingUsageDeltas().length).toBeGreaterThan(0);
    // Healthy sink → drained.
    const rows: unknown[] = [];
    setUsageCloudSink(async (r) => { rows.push(...r); });
    await flushUsageDeltas();
    expect(rows.length).toBeGreaterThan(0);
    expect(__pendingUsageDeltas()).toHaveLength(0);
  });
});
