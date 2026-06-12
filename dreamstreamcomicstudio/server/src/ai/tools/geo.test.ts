import { describe, it, expect } from 'vitest';
import {
  flagEmoji,
  countryToMetrics,
  weekdayUtc,
  holidaysToTable,
  sunTimesToMetrics,
  zipPlacesToTable,
  universitiesToTable
} from './geo.js';

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
    name: { common: 'Japan', official: 'Japan' },
    capital: ['Tokyo'],
    population: 125_700_000,
    region: 'Asia',
    subregion: 'Eastern Asia',
    languages: { jpn: 'Japanese' },
    currencies: { JPY: { name: 'Japanese yen', symbol: '¥' } },
    area: 377_930,
    timezones: ['UTC+09:00'],
    cca2: 'JP'
  };

  it('puts the flag emoji in the title and core facts in tiles', () => {
    const board = countryToMetrics(japan);
    expect(board.title).toBe('🇯🇵 Japan');
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Population'].value).toBe(125_700_000);
    expect(byLabel['Area']).toMatchObject({ value: 377_930, unit: 'km²' });
    expect(byLabel['Capital'].value).toBe('Tokyo');
    expect(byLabel['Region'].value).toBe('Eastern Asia');
    expect(byLabel['Currency']).toMatchObject({ value: 'JPY', unit: '¥' });
    expect(byLabel['Languages'].value).toBe('Japanese');
    expect(byLabel['Timezone'].value).toBe('UTC+09:00');
  });

  it('summarizes many languages/timezones as glanceable counts', () => {
    const board = countryToMetrics({
      name: { common: 'South Africa' },
      languages: { afr: 'Afrikaans', eng: 'English', zul: 'Zulu', xho: 'Xhosa' },
      timezones: ['UTC+02:00', 'UTC+03:00'],
      cca2: 'ZA'
    });
    const byLabel = Object.fromEntries(board.tiles.map((t) => [t.label, t]));
    expect(byLabel['Languages']).toMatchObject({ value: 4, unit: 'incl. Afrikaans' });
    expect(byLabel['Timezones']).toMatchObject({ value: 2, unit: 'zones' });
  });

  it('survives a sparse record without throwing', () => {
    const board = countryToMetrics({ name: { common: 'Atlantis' } });
    expect(board.title).toBe('Atlantis');
    expect(board.tiles.length).toBeGreaterThan(0);
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
