import { describe, it, expect, beforeEach } from 'vitest';
import {
  providerForUrl,
  assertProviderBudget,
  noteProviderCall,
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
});

describe('budget enforcement', () => {
  const url = 'http://ip-api.com/json/1.1.1.1'; // budget: 40/min, 1500/day

  it('blocks once the per-minute budget is reached', () => {
    for (let i = 0; i < 40; i++) noteProviderCall(url, true, T0 + i * 100);
    expect(() => assertProviderBudget(url, T0 + 5000)).toThrow(ProviderBudgetError);
  });

  it('frees the minute window as time passes', () => {
    for (let i = 0; i < 40; i++) noteProviderCall(url, true, T0);
    expect(() => assertProviderBudget(url, T0 + 61_000)).not.toThrow();
  });

  it('blocks at the daily cap and resets on a new UTC day', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ 'ip-api': { perMin: 10_000, perDay: 3 } });
    for (let i = 0; i < 3; i++) noteProviderCall(url, true, T0 + i * 120_000);
    expect(() => assertProviderBudget(url, T0 + 600_000)).toThrow(ProviderBudgetError);
    // Next UTC day → fresh budget.
    expect(() => assertProviderBudget(url, T0 + 24 * 60 * 60_000)).not.toThrow();
  });

  it('honors PROVIDER_BUDGETS env overrides', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ coingecko: { perMin: 1 } });
    const cg = 'https://api.coingecko.com/api/v3/search?query=x';
    noteProviderCall(cg, true, T0);
    expect(() => assertProviderBudget(cg, T0 + 1000)).toThrow(ProviderBudgetError);
  });
});

describe('usage snapshot & health', () => {
  it('reports counts, errors and health flags', () => {
    const cg = 'https://api.coingecko.com/api/v3/search?query=x';
    for (let i = 0; i < 6; i++) noteProviderCall(cg, i % 2 === 0, T0 + i * 5_000);
    const rows = getProviderUsageSnapshot(T0 + 40_000);
    const row = rows.find((r) => r.provider === 'coingecko')!;
    expect(row.todayCalls).toBe(6);
    expect(row.todayErrors).toBe(3);
    expect(row.health).toBe('failing'); // 50% error ratio with ≥5 calls
  });

  it('flags near-cap usage', () => {
    process.env.PROVIDER_BUDGETS = JSON.stringify({ frankfurter: { perMin: 10_000, perDay: 10 } });
    const fx = 'https://api.frankfurter.app/latest?from=USD&to=EUR';
    for (let i = 0; i < 9; i++) noteProviderCall(fx, true, T0 + i * 120_000);
    const row = getProviderUsageSnapshot(T0 + 20 * 60_000).find((r) => r.provider === 'frankfurter')!;
    expect(row.dayUsedPct).toBe(90);
    expect(row.health).toBe('near-cap');
  });
});
