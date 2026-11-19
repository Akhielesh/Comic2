// @vitest-environment node
// The shared Wikipedia / Wikidata reads (Chat's wiki_lookup and country_info; comic research later).
// Every reply comes from fixtures: no network. The checks pin the request URLs (HTTPS, the right
// host, the right API), the parsing rules (rank, end time, units, country classes) and the line
// between "the source answered: nothing found" (null / []) and "the source is unavailable" (throws).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetProviderUsage } from '../../lib/providerUsage.js';
import {
  __resetCountryCache,
  isCountryEntity,
  isWikipediaHost,
  parseWikidataCountry,
  wikidataCountry,
  WikidataUnavailableError,
  wikiLanglink,
  wikiSearch,
  wikiSummary
} from './wikipedia.js';
import {
  entitiesReply,
  FORMER_STATE,
  FRANCE,
  FRANCE_LABELS,
  GEORGIA,
  GEORGIA_DISAMBIGUATION,
  GEORGIA_LABELS,
  GERMANY,
  GERMANY_LABELS,
  LANGLINKS_REPLY,
  MISSING_REPLY,
  PARIS,
  RETIRED_API_REPLY,
  SEARCH_REPLY,
  searchReply,
  SUMMARY_REPLY
} from './__fixtures__/wikidata.js';

/** Stub fetch with a router over the parsed URL; returns the list of requested URLs. */
const stubFetch = (route: (url: URL) => unknown): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const raw = String(input);
      urls.push(raw);
      const body = route(new URL(raw));
      if (body instanceof Response) return body;
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    })
  );
  return urls;
};

const param = (url: string, name: string): string | null => new URL(url).searchParams.get(name);

beforeEach(() => {
  __resetProviderUsage();
  __resetCountryCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('isWikipediaHost', () => {
  it('accepts the wikis of the language registry and refuses look-alikes', () => {
    for (const host of ['en.wikipedia.org', 'te.wikipedia.org', 'hi.wikipedia.org', 'zh.wikipedia.org', 'ar.wikipedia.org']) {
      expect(isWikipediaHost(host), host).toBe(true);
    }
    for (const host of ['wikipedia.org', 'en.wikipedia.org.evil.test', 'evil.test', 'en.wikipedia.org:8080', 'EN.wikipedia.org', 'en.wikipedia.org/x', 'en wikipedia.org']) {
      expect(isWikipediaHost(host), host).toBe(false);
    }
  });

  it('refuses the portal, the API portal and codes outside the registry', () => {
    for (const host of ['www.wikipedia.org', 'api.wikipedia.org', 'xyz.wikipedia.org', 'qq.wikipedia.org', 'zh-yue.wikipedia.org', 'zh-hans.wikipedia.org']) {
      expect(isWikipediaHost(host), host).toBe(false);
    }
  });
});

describe('wikiSearch', () => {
  it('searches the given wiki over HTTPS and keeps only hits with a key and a title', async () => {
    const urls = stubFetch(() => SEARCH_REPLY);
    const hits = await wikiSearch('en.wikipedia.org', 'harbor lights', 2);
    expect(urls).toEqual(['https://en.wikipedia.org/w/rest.php/v1/search/page?q=harbor%20lights&limit=2']);
    expect(hits).toEqual([
      {
        key: 'Harbor_Lights_(folk_tale)',
        title: 'Harbor Lights (folk tale)',
        description: 'Coastal folk tale',
        excerpt: 'A <span class="searchmatch">harbor</span> tale about lantern keepers'
      },
      { key: 'Lantern_keeper', title: 'Lantern keeper' }
    ]);
  });

  it('refuses a host that is not a Wikipedia wiki before anything is sent', async () => {
    const urls = stubFetch(() => SEARCH_REPLY);
    await expect(wikiSearch('en.wikipedia.org.evil.test', 'x', 1)).rejects.toThrow();
    await expect(wikiSearch('evil.test/w', 'x', 1)).rejects.toThrow();
    expect(urls).toEqual([]);
  });

  it('a reply without a result list is "unavailable", not "no results"', async () => {
    stubFetch(() => ({ unexpected: true }));
    await expect(wikiSearch('en.wikipedia.org', 'x', 1)).rejects.toThrow();
    stubFetch(() => ({ pages: [] }));
    await expect(wikiSearch('en.wikipedia.org', 'x', 1)).resolves.toEqual([]);
  });
});

describe('wikiSummary', () => {
  it('reads the REST summary of a page key on the same wiki', async () => {
    const urls = stubFetch(() => SUMMARY_REPLY);
    const s = await wikiSummary('en.wikipedia.org', 'Harbor_Lights_(folk_tale)');
    expect(urls).toEqual(['https://en.wikipedia.org/api/rest_v1/page/summary/Harbor_Lights_(folk_tale)']);
    expect(s).toEqual({
      title: 'Harbor Lights (folk tale)',
      description: 'Coastal folk tale',
      extract: SUMMARY_REPLY.extract,
      url: 'https://en.wikipedia.org/wiki/Harbor_Lights_(folk_tale)',
      thumbnail: SUMMARY_REPLY.thumbnail.source
    });
  });

  it('never hands back a page link on another host or over plain HTTP, nor a thumbnail off Wikimedia', async () => {
    stubFetch(() => ({
      ...SUMMARY_REPLY,
      content_urls: { desktop: { page: 'http://en.wikipedia.org/wiki/Harbor' } },
      thumbnail: { source: 'https://images.evil.test/x.jpg' }
    }));
    const s = await wikiSummary('en.wikipedia.org', 'Harbor Lights');
    expect(s.url).toBe('https://en.wikipedia.org/wiki/Harbor%20Lights');
    expect(s.thumbnail).toBeUndefined();
  });
});

describe('wikiLanglink', () => {
  it('finds the same article on another language wiki', async () => {
    const urls = stubFetch(() => LANGLINKS_REPLY);
    const link = await wikiLanglink('en.wikipedia.org', 'Harbor Lights (folk tale)', 'te');
    expect(urls).toHaveLength(1);
    const url = urls[0];
    expect(url.startsWith('https://en.wikipedia.org/w/api.php?')).toBe(true);
    expect(param(url, 'action')).toBe('query');
    expect(param(url, 'prop')).toBe('langlinks');
    expect(param(url, 'titles')).toBe('Harbor Lights (folk tale)');
    expect(param(url, 'lllang')).toBe('te');
    expect(param(url, 'redirects')).toBe('1');
    expect(param(url, 'formatversion')).toBe('2');
    expect(link).toEqual({
      lang: 'te',
      host: 'te.wikipedia.org',
      title: 'హార్బర్ లైట్స్ కథ',
      key: 'హార్బర్_లైట్స్_కథ',
      url: `https://te.wikipedia.org/wiki/${encodeURIComponent('హార్బర్_లైట్స్_కథ')}`
    });
  });

  it('answers undefined when the article has no page in that language, and asks nothing for the same language', async () => {
    const urls = stubFetch(() => ({ query: { pages: [{ title: 'Harbor Lights (folk tale)' }] } }));
    await expect(wikiLanglink('en.wikipedia.org', 'Harbor Lights (folk tale)', 'te')).resolves.toBeUndefined();
    expect(urls).toHaveLength(1);
    const same = await wikiLanglink('en.wikipedia.org', 'Harbor Lights (folk tale)', 'en');
    expect(same?.host).toBe('en.wikipedia.org');
    expect(urls).toHaveLength(1);
  });

  it('refuses a language code that is not one before anything is sent', async () => {
    const urls = stubFetch(() => LANGLINKS_REPLY);
    await expect(wikiLanglink('en.wikipedia.org', 'X', 'te.evil.test/')).rejects.toThrow();
    await expect(wikiLanglink('en.wikipedia.org', 'X', 'www')).rejects.toThrow();
    await expect(wikiLanglink('en.wikipedia.org', 'X', 'xyz')).rejects.toThrow();
    expect(urls).toEqual([]);
  });
});

describe('isCountryEntity', () => {
  it('needs a current country or sovereign-state class', () => {
    expect(isCountryEntity(FRANCE)).toBe(true);
    expect(isCountryEntity(GERMANY)).toBe(true);
    expect(isCountryEntity(PARIS)).toBe(false);
    expect(isCountryEntity(GEORGIA_DISAMBIGUATION)).toBe(false);
    expect(isCountryEntity(FORMER_STATE)).toBe(false);
    expect(isCountryEntity({ claims: { P31: [{ ...FRANCE.claims.P31[0], rank: 'deprecated' }] } })).toBe(false);
    expect(isCountryEntity(undefined)).toBe(false);
  });
});

describe('parseWikidataCountry', () => {
  const labels = Object.fromEntries(Object.values(FRANCE_LABELS.entities).map((e) => [e.id, e.labels.en.value]));

  it('reads capital, population, currency, languages, area, continent and the ISO code', () => {
    expect(parseWikidataCountry(FRANCE, labels)).toEqual({
      id: 'Q142',
      name: 'France',
      alpha2: 'FR',
      capitals: ['Paris'],
      population: 68_000_000,
      populationYear: 2024,
      areaKm2: 643_801,
      currencies: ['euro'],
      languages: ['French'],
      continents: ['Europe'],
      url: 'https://www.wikidata.org/wiki/Q142'
    });
  });

  it('takes the preferred population; without one, the latest by point in time', () => {
    const facts = parseWikidataCountry(GERMANY, {});
    expect(facts?.population).toBe(84_000_000);
    expect(facts?.populationYear).toBe(2024);
  });

  it('drops values whose label is unknown instead of showing raw ids, and refuses a non-country', () => {
    const facts = parseWikidataCountry(FRANCE, {});
    expect(facts?.capitals).toEqual([]);
    expect(JSON.stringify(facts)).not.toMatch(/"Q90"|"Q4916"/);
    expect(parseWikidataCountry(PARIS, labels)).toBeNull();
  });
});

describe('wikidataCountry', () => {
  const API = 'https://www.wikidata.org/w/api.php?';

  it('looks a name up by its English Wikipedia title, then labels the values in one call', async () => {
    const urls = stubFetch((u) => (u.searchParams.get('ids') ? FRANCE_LABELS : entitiesReply(FRANCE)));
    const facts = await wikidataCountry('France');
    expect(facts?.name).toBe('France');
    expect(facts?.capitals).toEqual(['Paris']);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url.startsWith(API)).toBe(true);
    expect(param(urls[0], 'action')).toBe('wbgetentities');
    expect(param(urls[0], 'sites')).toBe('enwiki');
    expect(param(urls[0], 'titles')).toBe('France');
    expect(param(urls[1], 'props')).toBe('labels');
    expect(param(urls[1], 'ids')?.split('|').sort()).toEqual(['Q150', 'Q46', 'Q4916', 'Q90']);
  });

  it('looks a 2-letter code up by ISO alpha-2 (P297) and a 3-letter code by alpha-3 (P298)', async () => {
    const route = (u: URL) =>
      u.searchParams.get('list') === 'search'
        ? searchReply('Q183')
        : u.searchParams.get('props') === 'labels'
          ? GERMANY_LABELS
          : entitiesReply(GERMANY);
    let urls = stubFetch(route);
    expect((await wikidataCountry('de'))?.name).toBe('Germany');
    // One hit, already limited to countries: the entities call then reads one item, not three.
    expect(param(urls[0], 'srsearch')).toBe('haswbstatement:P297=DE haswbstatement:P31=Q6256|P31=Q3624078');
    expect(param(urls[0], 'srlimit')).toBe('1');
    expect(param(urls[1], 'ids')).toBe('Q183');
    urls = stubFetch(route);
    expect((await wikidataCountry('DEU'))?.name).toBe('Germany');
    expect(param(urls[0], 'srsearch')).toBe('haswbstatement:P298=DEU haswbstatement:P31=Q6256|P31=Q3624078');
    expect(param(urls[0], 'srlimit')).toBe('1');
  });

  it('a code with no ISO match falls back to the title (UK → United Kingdom by redirect)', async () => {
    const uk = { ...GERMANY, id: 'Q145', labels: { en: { language: 'en', value: 'United Kingdom' } } };
    const urls = stubFetch((u) =>
      u.searchParams.get('list') === 'search' ? searchReply() : u.searchParams.get('props') === 'labels' ? GERMANY_LABELS : entitiesReply(uk)
    );
    expect((await wikidataCountry('UK'))?.name).toBe('United Kingdom');
    expect(param(urls[1], 'titles')).toBe('UK');
  });

  it('a title that is not a country tries a country search; its words never carry search operators', async () => {
    const urls = stubFetch((u) => {
      if (u.searchParams.get('list') === 'search') return searchReply('Q230');
      if (u.searchParams.get('props') === 'labels') return GEORGIA_LABELS;
      return u.searchParams.get('ids') === 'Q230' ? entitiesReply(GEORGIA) : entitiesReply(GEORGIA_DISAMBIGUATION);
    });
    const facts = await wikidataCountry('Georgia insource:/x/');
    expect(facts?.name).toBe('Georgia');
    expect(facts?.capitals).toEqual(['Tbilisi']);
    const search = urls.find((x) => param(x, 'list') === 'search')!;
    const words = param(search, 'srsearch')!;
    expect(words.endsWith(' haswbstatement:P31=Q6256|P31=Q3624078')).toBe(true);
    expect(words.replace(' haswbstatement:P31=Q6256|P31=Q3624078', '')).not.toMatch(/[:/]/);
  });

  it('looks a name up as one title: a "|" never asks for several pages', async () => {
    const urls = stubFetch((u) => (u.searchParams.get('ids') ? FRANCE_LABELS : entitiesReply(FRANCE)));
    await wikidataCountry('France|Q2');
    expect(param(urls[0], 'titles')).toBe('France Q2');
  });

  it('answers null when the source answered and nothing is a country', async () => {
    stubFetch((u) => (u.searchParams.get('list') === 'search' ? searchReply() : MISSING_REPLY));
    await expect(wikidataCountry('Atlantis')).resolves.toBeNull();
    stubFetch((u) => (u.searchParams.get('list') === 'search' ? searchReply() : entitiesReply(PARIS)));
    await expect(wikidataCountry('Paris')).resolves.toBeNull();
    await expect(wikidataCountry('   ')).resolves.toBeNull();
  });

  it('throws "unavailable" on a reply that is not a Wikidata answer, an API error or a network failure', async () => {
    stubFetch(() => RETIRED_API_REPLY);
    await expect(wikidataCountry('France')).rejects.toBeInstanceOf(WikidataUnavailableError);
    stubFetch(() => ({ error: { code: 'maxlag', info: 'Waiting for a database server' } }));
    await expect(wikidataCountry('France')).rejects.toBeInstanceOf(WikidataUnavailableError);
    stubFetch(() => new Error('network down'));
    await expect(wikidataCountry('France')).rejects.toThrow();
    stubFetch((u) => (u.searchParams.get('ids') ? RETIRED_API_REPLY : entitiesReply(FRANCE)));
    await expect(wikidataCountry('France')).rejects.toBeInstanceOf(WikidataUnavailableError);
  });

  it('remembers a country for a day: the same look-up again sends nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const urls = stubFetch((u) => (u.searchParams.get('ids') ? FRANCE_LABELS : entitiesReply(FRANCE)));
      expect((await wikidataCountry('France'))?.name).toBe('France');
      expect(urls).toHaveLength(2);
      expect((await wikidataCountry('  France ', {}))?.capitals).toEqual(['Paris']);
      expect(urls).toHaveLength(2);
      vi.setSystemTime(Date.now() + 23 * 3_600_000);
      await wikidataCountry('France');
      expect(urls).toHaveLength(2);
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      await wikidataCountry('France');
      expect(urls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers "no such country" for minutes only, and never remembers a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let urls = stubFetch((u) => (u.searchParams.get('list') === 'search' ? searchReply() : MISSING_REPLY));
      await expect(wikidataCountry('Atlantis')).resolves.toBeNull();
      const sent = urls.length;
      await expect(wikidataCountry('Atlantis')).resolves.toBeNull();
      expect(urls).toHaveLength(sent);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await wikidataCountry('Atlantis');
      expect(urls).toHaveLength(2 * sent);

      stubFetch(() => new Error('network down'));
      await expect(wikidataCountry('Germany')).rejects.toThrow();
      urls = stubFetch((u) => (u.searchParams.get('props') === 'labels' ? GERMANY_LABELS : entitiesReply(GERMANY)));
      expect((await wikidataCountry('Germany'))?.name).toBe('Germany');
      expect(urls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each Wikidata call a 4 s deadline, not the 10 s default', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: unknown, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            })
        )
      );
      const outcome = expect(wikidataCountry('France')).rejects.toThrow(/timed out after 4s/);
      await vi.advanceTimersByTimeAsync(4_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });
});
