// @vitest-environment node
// abuse-ops-6: Foursquare and YouTube calls go through fetchJson, so their provider budgets
// (lib/providerUsage.ts) meter and cap them; a budget hit throws before anything is sent and the
// tools fall back (OpenStreetMap / the keyless scraper). The provider is decided by the URL's host
// alone (user text in a query string never moves a call into another budget), the check reserves
// the call so concurrent requests cannot overshoot, and page reads are metered per host and can
// never spend a named provider's budget. The clock is pinned to midday UTC so filling "today"
// never spills into yesterday.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // config.ts reads these at import time.
  process.env.YOUTUBE_API_KEY = 'yt-test-key';
  process.env.FOURSQUARE_API_KEY = 'fsq-test-key';
});

import {
  __resetProviderUsage,
  getConfiguredProviderBudget,
  getProviderUsageSnapshot,
  pageProviderFor,
  providerForUrl,
  ProviderBudgetError,
  assertProviderBudget
} from '../../lib/providerUsage.js';
import { findPlacesFoursquare } from './foursquare.js';
import { youtubeVideoSearch } from './youtubeSearch.js';

const FSQ_URL = 'https://places-api.foursquare.com/places/search?query=coffee';
const YT_URL = 'https://www.googleapis.com/youtube/v3/search?part=snippet&q=cats&key=k';

const NOW = new Date('2026-11-05T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  __resetProviderUsage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Spend `calls` of a provider's daily budget earlier today, spaced so no rolling minute ever holds
 * `perMin` of them (each check reserves its call, so the per-minute cap applies while filling).
 */
const spendToday = (url: string, calls: number, perMin: number): void => {
  const gap = Math.ceil(60_000 / (perMin - 1));
  const start = NOW - 30 * 60_000;
  for (let i = 0; i < calls; i += 1) assertProviderBudget(url, start + i * gap);
  expect(start + calls * gap).toBeLessThan(NOW - 60_000); // the current minute is empty: only the day cap can refuse
};

describe('provider mapping and budgets', () => {
  it('maps Foursquare and YouTube to their own providers (YouTube never spends the search budget)', () => {
    expect(providerForUrl(FSQ_URL)).toBe('foursquare');
    expect(providerForUrl(YT_URL)).toBe('youtube');
    expect(providerForUrl('https://www.googleapis.com/customsearch/v1?q=x')).toBe('google-cse');
  });

  it('a URL that merely mentions a provider host is not that provider', () => {
    expect(providerForUrl('https://evil.test/x.foursquare.com/')).not.toBe('foursquare');
    expect(providerForUrl('https://evil.test/www.googleapis.com/youtube/v3')).not.toBe('youtube');
  });

  it('user text in the query string never moves a call into another provider', () => {
    // find_places / video_search run anonymously through /api/chat/tool-refresh with caller-chosen text.
    expect(providerForUrl('https://places-api.foursquare.com/places/search?query=pizza+bing.com&near=Austin')).toBe('foursquare');
    expect(providerForUrl('https://places-api.foursquare.com/places/search?query=pizza&near=wikipedia.org')).toBe('foursquare');
    expect(providerForUrl('https://www.googleapis.com/youtube/v3/search?part=snippet&q=cats%20api.tavily.com')).toBe('youtube');
    expect(providerForUrl('https://www.googleapis.com/youtube/v3/search?part=snippet&q=google.serper.dev')).toBe('youtube');
    expect(providerForUrl('https://r.jina.ai/https://attacker.test/?x=wikipedia.org')).toBe('jina-reader');
  });

  it('has the documented daily budgets', () => {
    expect(getConfiguredProviderBudget('foursquare')).toEqual({ perMin: 20, perDay: 300 });
    expect(getConfiguredProviderBudget('youtube')).toEqual({ perMin: 10, perDay: 80 });
  });

  it('page reads are metered per host, never as the provider their URL names', () => {
    const tricky = 'https://attacker.test/?u=https://api.tavily.com/search';
    expect(pageProviderFor(tricky)).toBe('page:attacker.test');
    for (let i = 0; i < 60; i += 1) assertProviderBudget(tricky, Date.now(), pageProviderFor(tricky));
    // The tavily budget is untouched; the page host's own bucket is the one that fills.
    expect(() => assertProviderBudget('https://api.tavily.com/search')).not.toThrow();
    expect(() => assertProviderBudget(tricky, Date.now(), pageProviderFor(tricky))).toThrow(ProviderBudgetError);
    expect(getProviderUsageSnapshot().some((r) => r.provider.startsWith('page:'))).toBe(false);
  });

  it('tracks a bounded number of page hosts', () => {
    for (let i = 0; i < 700; i += 1) {
      const u = `https://h${i}.test/`;
      assertProviderBudget(u, Date.now(), pageProviderFor(u));
    }
    // The oldest host was dropped (its bucket starts fresh); the newest is still counted.
    for (let i = 0; i < 59; i += 1) assertProviderBudget('https://h699.test/', Date.now(), pageProviderFor('https://h699.test/'));
    expect(() => assertProviderBudget('https://h699.test/', Date.now(), 'page:h699.test')).toThrow(ProviderBudgetError);
    expect(() => assertProviderBudget('https://h0.test/', Date.now(), 'page:h0.test')).not.toThrow();
  });
});

describe('Foursquare goes through the budget', () => {
  const okJson = () =>
    vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ name: 'Cafe', latitude: 1, longitude: 2, distance: 100 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

  it('counts each search', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    const out = await findPlacesFoursquare({ query: 'coffee', near: 'Austin', label: 'Coffee' });
    expect(out.results[0].name).toBe('Cafe');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer fsq-test-key' }) });
    expect(getProviderUsageSnapshot().find((r) => r.provider === 'foursquare')?.todayCalls).toBe(1);
  });

  it('a spent daily budget refuses before anything is sent', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    spendToday(FSQ_URL, 300, 20);
    await expect(findPlacesFoursquare({ query: 'coffee', near: 'Austin', label: 'Coffee' })).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tool-refresh-shaped search naming other providers is still refused by the Foursquare budget', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    spendToday(FSQ_URL, 300, 20);
    await expect(
      findPlacesFoursquare({ query: 'pizza bing.com', near: 'wikipedia.org', label: 'Pizza' })
    ).rejects.toMatchObject({ name: 'ProviderBudgetError', provider: 'foursquare', window: 'day' });
    expect(fetchMock).not.toHaveBeenCalled();
    // …and it spent nothing from the budgets its text names.
    expect(getProviderUsageSnapshot().map((r) => r.provider)).toEqual(['foursquare']);
  });

  it('30 concurrent searches: at most the 20 the minute allows ever reach the network', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Never answers on its own (a slow upstream); the test's abort settles it.
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const stop = new AbortController();
    const runs = Array.from({ length: 30 }, (_, i) =>
      findPlacesFoursquare({ query: `coffee ${i}`, near: 'Austin', label: 'Coffee' }, stop.signal)
    );
    const outcomes = runs.map(() => 'pending');
    runs.forEach((run, i) =>
      run.then(
        () => (outcomes[i] = 'ok'),
        (err) => (outcomes[i] = err instanceof ProviderBudgetError ? 'budget' : 'error')
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20);
    expect(outcomes.filter((o) => o === 'budget')).toHaveLength(10);
    expect(outcomes.filter((o) => o === 'pending')).toHaveLength(20);
    stop.abort();
    await Promise.allSettled(runs);
  });
});

describe('YouTube goes through the budget', () => {
  const okJson = () =>
    vi.fn(async () =>
      new Response(JSON.stringify({ items: [{ id: { videoId: 'abc' }, snippet: { title: 'Cats', channelTitle: 'Ch' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

  it('counts each search', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    const out = await youtubeVideoSearch('cats');
    expect(out[0].url).toBe('https://www.youtube.com/watch?v=abc');
    expect(getProviderUsageSnapshot().find((r) => r.provider === 'youtube')?.todayCalls).toBe(1);
  });

  it('a spent daily budget refuses before anything is sent', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    spendToday(YT_URL, 80, 10);
    await expect(youtubeVideoSearch('cats')).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a search whose text names a search provider spends the YouTube budget, not that one', async () => {
    const fetchMock = okJson();
    vi.stubGlobal('fetch', fetchMock);
    await youtubeVideoSearch('api.tavily.com tutorial');
    await youtubeVideoSearch('google.serper.dev');
    const rows = getProviderUsageSnapshot();
    expect(rows.map((r) => r.provider)).toEqual(['youtube']);
    expect(rows[0].todayCalls).toBe(2);
  });
});
