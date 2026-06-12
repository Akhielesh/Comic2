import { describe, it, expect } from 'vitest';
import { issToMarker, quakesToMarkers, astrosToTable, launchesToTable } from './space.js';

describe('issToMarker', () => {
  it('builds a labeled marker with telemetry in the description', () => {
    const m = issToMarker({ latitude: -23.41, longitude: 151.06, altitude: 421.3, velocity: 27571.8, visibility: 'daylight' });
    expect(m.lat).toBe(-23.41);
    expect(m.lng).toBe(151.06);
    expect(m.label).toContain('ISS');
    expect(m.description).toBe('altitude ~421 km · speed ~27,572 km/h · daylight side of Earth');
  });

  it('omits the description when only the position is known (Open Notify fallback)', () => {
    const m = issToMarker({ latitude: 10, longitude: 20 });
    expect(m.description).toBeUndefined();
  });
});

describe('quakesToMarkers', () => {
  const quake = (mag: number, place: string, lng = 142.1, lat = 38.3, depth = 29.9, time = 1781234567000) => ({
    properties: { mag, place, time, url: 'https://earthquake.usgs.gov/x' },
    geometry: { coordinates: [lng, lat, depth] }
  });

  it('maps magnitude + place to the label and depth/time to the description', () => {
    const [m] = quakesToMarkers([quake(6.2, '98 km E of Honshu, Japan')]);
    expect(m.label).toBe('M6.2 — 98 km E of Honshu, Japan');
    expect(m.lat).toBe(38.3);
    expect(m.lng).toBe(142.1);
    expect(m.description).toContain('depth 30 km');
    expect(m.description).toContain(new Date(1781234567000).toUTCString());
  });

  it('caps the markers at 10', () => {
    const many = Array.from({ length: 14 }, (_, i) => quake(5 + i / 10, `Place ${i}`));
    expect(quakesToMarkers(many)).toHaveLength(10);
  });

  it('skips features with missing coordinates or magnitude', () => {
    const bad = [{ properties: { mag: 5 } }, { geometry: { coordinates: [1, 2] }, properties: {} }];
    expect(quakesToMarkers(bad)).toHaveLength(0);
  });
});

describe('astrosToTable', () => {
  it('builds a name/craft table with a per-craft summary subtitle', () => {
    const table = astrosToTable([
      { name: 'Oleg Kononenko', craft: 'ISS' },
      { name: 'Tracy Dyson', craft: 'ISS' },
      { name: 'Li Guangsu', craft: 'Tiangong' }
    ]);
    expect(table.subtitle).toBe('3 aboard 2 spacecraft');
    expect(table.columns[1]).toMatchObject({ label: 'Spacecraft', kind: 'badge' });
    expect(table.rows).toEqual([
      ['Oleg Kononenko', 'ISS'],
      ['Tracy Dyson', 'ISS'],
      ['Li Guangsu', 'Tiangong']
    ]);
  });
});

describe('launchesToTable', () => {
  const launches = [
    {
      name: 'Starlink 6-58',
      date_utc: '2026-06-14T03:30:00.000Z',
      success: true,
      details: 'A batch of 23 Starlink v2 mini satellites to low Earth orbit.',
      links: { webcast: 'https://youtu.be/starlink' }
    },
    { name: 'Boom Test', date_utc: '2026-06-01T12:00:00.000Z', success: false },
    { name: 'TBD Mission' }
  ];

  it('renders recent launches with success/failure badges and webcast links', () => {
    const table = launchesToTable(launches, 'recent');
    expect(table.title).toBe('Recent SpaceX launches');
    expect(table.rows[0][0]).toEqual({ value: 'Starlink 6-58', href: 'https://youtu.be/starlink' });
    expect(table.rows[0][1]).toBe('2026-06-14 03:30');
    expect(table.rows[0][2]).toBe('Success');
    expect(table.rows[1][2]).toBe('Failure');
    expect(table.rows[2][1]).toBe('TBD');
    expect(table.rows[2][2]).toBe('Unknown');
  });

  it('labels upcoming launches as Upcoming regardless of the success flag', () => {
    const table = launchesToTable(launches, 'upcoming');
    expect(table.title).toBe('Upcoming SpaceX launches');
    expect(table.rows.every((r) => r[2] === 'Upcoming')).toBe(true);
  });

  it('truncates long details to keep rows scannable', () => {
    const long = [{ name: 'X', details: 'd'.repeat(200) }];
    const table = launchesToTable(long, 'upcoming');
    expect(String(table.rows[0][3])).toHaveLength(121); // 120 chars + ellipsis
  });
});
