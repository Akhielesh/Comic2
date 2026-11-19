import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  flagEmoji,
  countryToMetrics,
  countryInfoTool,
  ipLookupTool,
  weekdayUtc,
  holidaysToTable,
  sunTimesToMetrics,
  zipPlacesToTable,
  universitiesToTable
} from './geo.js';
import { __resetProviderUsage } from '../../lib/providerUsage.js';
import { __resetCountryCache } from './wikipedia.js';
import { entitiesReply, FRANCE, FRANCE_LABELS, MISSING_REPLY, RETIRED_API_REPLY, searchReply } from './__fixtures__/wikidata.js';

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

/** No key, token or address may ever travel over plain HTTP. */
const expectNoSecretOverHttp = (urls: string[]): void => {
  for (const url of urls.filter((u) => u.startsWith('http://'))) {
    expect(url, url).not.toMatch(/access_key=|token=|key=/i);
    expect(url, url).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b|[0-9a-f]*::[0-9a-f]*/i);
  }
};

beforeEach(() => {
  __resetProviderUsage();
  __resetCountryCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('flagEmoji', () => {
  it('converts ISO alpha-2 codes to regional-indicator flags', () => {
    expect(flagEmoji('JP')).toBe('🇯🇵');
    expect(flagEmoji('us')).toBe('🇺🇸');
  });
  it('returns an empty string for invalid input', () => {
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('USA')).toBe('');
    expect(flagEmoji(undefined)).toBe('');
  });
});

describe('countryToMetrics', () => {
  const japan = {
    id: 'Q17',
    name: 'Japan',
    alpha2: 'JP',
    capitals: ['Tokyo'],
    population: 124_000_000,
    populationYear: 2024,
    areaKm2: 377_975,
    currencies: ['Japanese yen'],
    languages: ['Japanese'],
    continents: ['Asia'],
    url: 'https://www.wikidata.org/wiki/Q17'
  };

  it('puts the flag emoji in the title and core facts in tiles', () => {
    const board = countryToMetrics(japan);
    expect(board.title).toBe('🇯🇵 Japan');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Population'].value).toBe(124_000_000);
    expect(byLabel['Area']).toMatchObject({ value: 377_975, unit: 'km²' });
    expect(byLabel['Capital'].value).toBe('Tokyo');
    expect(byLabel['Continent'].value).toBe('Asia');
    expect(byLabel['Currency'].value).toBe('Japanese yen');
    expect(byLabel['Languages'].value).toBe('Japanese');
  });

  it('summarizes many languages and currencies as glanceable values', () => {
    const board = countryToMetrics({
      ...japan,
      name: 'South Africa',
      alpha2: 'ZA',
      languages: ['Afrikaans', 'English', 'Zulu', 'Xhosa'],
      currencies: ['South African rand', 'euro']
    });
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Languages']).toMatchObject({ value: 4, unit: 'incl. Afrikaans' });
    expect(byLabel['Currencies'].value).toBe('South African rand, euro');
  });

  it('survives a sparse record without throwing', () => {
    const board = countryToMetrics({ id: 'Q1', name: 'Atlantis', capitals: [], currencies: [], languages: [], continents: [], url: 'https://www.wikidata.org/wiki/Q1' });
    expect(board.title).toBe('Atlantis');
    expect(board.tiles.length).toBeGreaterThan(0);
  });
});

describe('country_info', () => {
  it('answers from Wikidata with the fact board, the flag and a source link', async () => {
    const urls = stubFetch((u) => (u.searchParams.get('ids') ? FRANCE_LABELS : entitiesReply(FRANCE)));
    const out = await countryInfoTool.execute({ country: 'France' });
    expect(urls.every((u) => u.startsWith('https://www.wikidata.org/w/api.php?'))).toBe(true);
    expect(urls.some((u) => u.includes('restcountries'))).toBe(false);
    expect(out.content).toContain('France');
    expect(out.content).toContain('Capital: Paris');
    expect(out.content).toContain('Population: 68,000,000 (2024)');
    expect(out.content).toContain('Currency: euro');
    expect(out.images).toEqual([{ url: 'https://flagcdn.com/w320/fr.png', title: 'Flag of France', source: 'flagcdn.com' }]);
    expect(out.citations).toEqual([{ url: 'https://www.wikidata.org/wiki/Q142', title: 'France — Wikidata' }]);
    expect(out.artifacts?.[0]).toMatchObject({ type: 'metric_board', data: { title: '🇫🇷 France' } });
  });

  it('says the source is offline, never "not found", when the reply is not a country answer', async () => {
    stubFetch(() => RETIRED_API_REPLY);
    const out = await countryInfoTool.execute({ country: 'France' });
    expect(out.content).toContain('The country facts source is offline right now');
    expect(out.content).not.toMatch(/not found|no country found/i);
    expect(out.artifacts).toBeUndefined();
  });

  it('says the source is offline on a network failure too', async () => {
    stubFetch(() => new Error('getaddrinfo ENOTFOUND'));
    const out = await countryInfoTool.execute({ country: 'France' });
    expect(out.content).toContain('The country facts source is offline right now');
    expect(out.content).not.toMatch(/not found/i);
  });

  it('says the source is busy, sending nothing, when the Wikidata budget is spent', async () => {
    vi.stubEnv('PROVIDER_BUDGETS', JSON.stringify({ wikidata: { perMin: 0, perDay: 0 } }));
    __resetProviderUsage();
    const urls = stubFetch(() => entitiesReply(FRANCE));
    const out = await countryInfoTool.execute({ country: 'France' });
    expect(urls).toEqual([]);
    expect(out.content).toContain('The country facts source is busy right now');
    expect(out.content).not.toMatch(/not found/i);
  });

  it('says "not found" only when the source answered and nothing matched', async () => {
    stubFetch((u) => (u.searchParams.get('list') === 'search' ? searchReply() : MISSING_REPLY));
    const out = await countryInfoTool.execute({ country: 'Atlantis' });
    expect(out.content).toBe('No country found matching "Atlantis".');
  });
});

describe('ip_lookup', () => {
  it('without IPINFO_TOKEN says it needs a data source and sends nothing', async () => {
    vi.stubEnv('IPINFO_TOKEN', '');
    const urls = stubFetch(() => ({ status: 'success', city: 'Somewhere' }));
    const out = await ipLookupTool.execute({ ip: '203.0.113.7' });
    expect(out.content).toContain('IP lookup needs a configured data source');
    expect(urls).toEqual([]);
  });

  it('with a token asks IPinfo over HTTPS only, and a failure falls back to nothing', async () => {
    vi.stubEnv('IPINFO_TOKEN', 'test-token');
    const urls = stubFetch(() => new Response('nope', { status: 503 }));
    const out = await ipLookupTool.execute({ ip: '203.0.113.7' });
    expect(out.content).toMatch(/^IP lookup failed/);
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('https://api.ipinfo.io/lite/203.0.113.7?token=')).toBe(true);
    expect(urls.some((u) => u.includes('ip-api'))).toBe(false);
    expectNoSecretOverHttp(urls);
  });

  it('with a token answers country and network from IPinfo', async () => {
    vi.stubEnv('IPINFO_TOKEN', 'test-token');
    stubFetch(() => ({ ip: '203.0.113.7', country: 'Exampleland', country_code: 'EX', continent: 'Nowhere', asn: 'AS64500', as_name: 'Example Net' }));
    const out = await ipLookupTool.execute({ ip: '203.0.113.7' });
    expect(out.content).toContain('Country: Exampleland (EX)');
    expect(out.content).toContain('Network: AS64500 — Example Net');
    expect(out.notice).toBeUndefined();
  });
});

describe('weekdayUtc / holidaysToTable', () => {
  it('computes the UTC weekday for an ISO date', () => {
    expect(weekdayUtc('2026-07-04')).toBe('Saturday');
    expect(weekdayUtc('2026-12-25')).toBe('Friday');
    expect(weekdayUtc('garbage')).toBe('—');
  });

  it('builds a date/holiday/weekday table with the local name as a sub-line', () => {
    const table = holidaysToTable('DE', 2026, [
      { date: '2026-10-03', localName: 'Tag der Deutschen Einheit', name: 'German Unity Day' },
      { date: '2026-12-25', localName: 'Weihnachten', name: 'Christmas Day' }
    ]);
    expect(table.title).toBe('Public holidays — DE 2026');
    expect(table.columns.map((c) => c.label)).toEqual(['Date', 'Holiday', 'Weekday']);
    expect(table.rows[0]).toEqual([
      '2026-10-03',
      { value: 'German Unity Day', sub: 'Tag der Deutschen Einheit' },
      'Saturday'
    ]);
    // Identical local name → no sub-line.
    const same = holidaysToTable('US', 2026, [{ date: '2026-07-04', localName: 'Independence Day', name: 'Independence Day' }]);
    expect((same.rows[0][1] as { sub?: string }).sub).toBeUndefined();
  });
});

describe('sunTimesToMetrics', () => {
  it('formats UTC clock times and a human day length', () => {
    const board = sunTimesToMetrics('Reykjavik, Iceland', {
      sunrise: '2026-06-12T02:58:11+00:00',
      sunset: '2026-06-13T00:01:34+00:00',
      solar_noon: '2026-06-12T13:29:52+00:00',
      day_length: '75803'
    });
    expect(board.title).toBe('Sun times — Reykjavik, Iceland');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Sunrise']).toMatchObject({ value: '02:58', unit: 'UTC' });
    expect(byLabel['Sunset'].value).toBe('00:01');
    expect(byLabel['Solar noon'].value).toBe('13:29');
    expect(byLabel['Day length'].value).toBe('21h 3m');
  });

  it('degrades to em dashes on missing fields', () => {
    const board = sunTimesToMetrics('Nowhere', {});
    for (const tile of board.tiles) expect(tile.value).toBe('—');
  });
});

describe('zipPlacesToTable', () => {
  it('maps Zippopotam places to rows with numeric coordinates', () => {
    const table = zipPlacesToTable('90210', 'United States', [
      { 'place name': 'Beverly Hills', state: 'California', latitude: '34.0901', longitude: '-118.4065' }
    ]);
    expect(table.title).toBe('90210 — United States');
    expect(table.rows[0]).toEqual(['Beverly Hills', 'California', 34.0901, -118.4065]);
  });

  it('nulls out unparseable coordinates', () => {
    const table = zipPlacesToTable('XX', 'Nowhere', [{ 'place name': 'X', state: '', latitude: 'n/a', longitude: '' }]);
    expect(table.rows[0]).toEqual(['X', '—', null, null]);
  });
});

describe('universitiesToTable', () => {
  it('links each university to its website and reports the shown/total counts', () => {
    const table = universitiesToTable(
      [
        { name: 'MIT', country: 'United States', web_pages: ['http://web.mit.edu/'] },
        { name: 'Mystery College', country: 'United States' }
      ],
      { name: 'tech', country: 'United States', total: 42 }
    );
    expect(table.subtitle).toBe('matching "tech" in United States');
    expect(table.rows[0][0]).toEqual({ value: 'MIT', href: 'http://web.mit.edu/' });
    expect((table.rows[1][0] as { href?: string }).href).toBeUndefined();
    expect(table.caption).toBe('Showing 2 of 42 matches · Source: Hipolabs');
  });
});
