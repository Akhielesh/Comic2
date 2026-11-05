// @vitest-environment node
// abuse-ops-6: Foursquare and YouTube calls go through fetchJson, so their provider budgets
// (lib/providerUsage.ts) meter and cap them; a budget hit throws before anything is sent and the
// tools fall back (OpenStreetMap / the keyless scraper). Page reads are metered per host and can
// never spend a named provider's budget.
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
  noteProviderCall,
  pageProviderFor,
  providerForUrl,
  ProviderBudgetError,
  assertProviderBudget
} from '../../lib/providerUsage.js';
import { findPlacesFoursquare } from './foursquare.js';
import { youtubeVideoSearch } from './youtubeSearch.js';

const FSQ_URL = 'https://places-api.foursquare.com/places/search?query=coffee';
const YT_URL = 'https://www.googleapis.com/youtube/v3/search?part=snippet&q=cats&key=k';

beforeEach(() => __resetProviderUsage());
afterEach(() => vi.unstubAllGlobals());

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

  it('has the documented daily budgets', () => {
    expect(getConfiguredProviderBudget('foursquare')).toEqual({ perMin: 20, perDay: 300 });
    expect(getConfiguredProviderBudget('youtube')).toEqual({ perMin: 10, perDay: 80 });
  });

  it('page reads are metered per host, never as the provider their URL names', () => {
    const tricky = 'https://attacker.test/?u=https://api.tavily.com/search';
    expect(pageProviderFor(tricky)).toBe('page:attacker.test');
    for (let i = 0; i < 60; i += 1) noteProviderCall(tricky, true, Date.now(), pageProviderFor(tricky));
    // The tavily budget is untouched; the page host's own bucket is the one that fills.
    expect(() => assertProviderBudget('https://api.tavily.com/search')).not.toThrow();
    expect(() => assertProviderBudget(tricky, Date.now(), pageProviderFor(tricky))).toThrow(ProviderBudgetError);
    expect(getProviderUsageSnapshot().some((r) => r.provider.startsWith('page:'))).toBe(false);
  });

  it('tracks a bounded number of page hosts', () => {
    for (let i = 0; i < 700; i += 1) {
      const u = `https://h${i}.test/`;
      noteProviderCall(u, true, Date.now(), pageProviderFor(u));
    }
    // The oldest host was dropped (its bucket starts fresh); the newest is still counted.
    for (let i = 0; i < 59; i += 1) noteProviderCall('https://h699.test/', true, Date.now(), pageProviderFor('https://h699.test/'));
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
    const day = Date.now() - 2 * 60_000; // outside the per-minute window
    for (let i = 0; i < 300; i += 1) noteProviderCall(FSQ_URL, true, day);
    await expect(findPlacesFoursquare({ query: 'coffee', near: 'Austin', label: 'Coffee' })).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
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
    const day = Date.now() - 2 * 60_000;
    for (let i = 0; i < 80; i += 1) noteProviderCall(YT_URL, true, day);
    await expect(youtubeVideoSearch('cats')).rejects.toBeInstanceOf(ProviderBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
