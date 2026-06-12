import { describe, it, expect } from 'vitest';
import {
  buildOsrmUrl,
  buildGoogleMapsUrl,
  buildTransitUrl,
  downsamplePath,
  parseOsrmRoutes,
  pickDefaultMode
} from './directions.js';
import type { DirectionsModeResult } from '../../../../apiTypes.js';

// Realistic FOSSGIS OSRM /route/v1 response (alternatives=true): a primary route
// with a road-name leg summary plus a slower alternative whose summary is empty
// (OSRM returns "" for short/unnamed legs). Geometry is GeoJSON [lng, lat].
const OSRM_FIXTURE = {
  code: 'Ok',
  routes: [
    {
      geometry: {
        coordinates: [
          [-77.034747, 38.887726],
          [-77.0412, 38.8841],
          [-77.0489, 38.8786],
          [-77.058688, 38.872693]
        ],
        type: 'LineString'
      },
      legs: [{ steps: [], summary: 'I-66 E, US-50', weight: 463.9, duration: 463.9, distance: 5377.4 }],
      weight_name: 'routability',
      weight: 463.9,
      duration: 463.9,
      distance: 5377.4
    },
    {
      geometry: {
        coordinates: [
          [-77.034747, 38.887726],
          [-77.0301, 38.8795],
          [-77.0455, 38.8741],
          [-77.058688, 38.872693]
        ],
        type: 'LineString'
      },
      legs: [{ steps: [], summary: '', weight: 612.2, duration: 612.2, distance: 6201.5 }],
      weight_name: 'routability',
      weight: 612.2,
      duration: 612.2,
      distance: 6201.5
    }
  ],
  waypoints: [
    { hint: 'x', distance: 4.2, name: '', location: [-77.034747, 38.887726] },
    { hint: 'y', distance: 7.8, name: 'Washington Boulevard', location: [-77.058688, 38.872693] }
  ]
};

describe('parseOsrmRoutes', () => {
  it('parses primary + alternative routes with rounded distance/duration', () => {
    const routes = parseOsrmRoutes(OSRM_FIXTURE);
    expect(routes).toHaveLength(2);
    expect(routes[0].distanceKm).toBe(5.4); // 5377.4 m → 5.4 km (1 decimal)
    expect(routes[0].durationMin).toBe(8); // 463.9 s → 8 min (rounded)
    expect(routes[1].distanceKm).toBe(6.2);
    expect(routes[1].durationMin).toBe(10);
  });

  it('converts GeoJSON [lng,lat] into [lat,lng] pairs', () => {
    const routes = parseOsrmRoutes(OSRM_FIXTURE);
    expect(routes[0].path[0]).toEqual([38.887726, -77.034747]);
    expect(routes[0].path.at(-1)).toEqual([38.872693, -77.058688]);
  });

  it('builds a "via …" summary from leg summaries, omitting empty ones', () => {
    const routes = parseOsrmRoutes(OSRM_FIXTURE);
    expect(routes[0].summary).toBe('via I-66 E, US-50');
    expect(routes[1].summary).toBeUndefined();
  });

  it('clamps a sub-minute hop to 1 min', () => {
    const tiny = {
      code: 'Ok',
      routes: [
        {
          geometry: { coordinates: [[-77.03, 38.88], [-77.031, 38.881]], type: 'LineString' },
          legs: [{ steps: [], summary: '', duration: 20, distance: 90 }],
          duration: 20,
          distance: 90
        }
      ]
    };
    const [r] = parseOsrmRoutes(tiny);
    expect(r.durationMin).toBe(1);
    expect(r.distanceKm).toBe(0.1);
  });

  it('downsamples long geometries to ≤ 240 points, keeping both endpoints', () => {
    const coords = Array.from({ length: 1258 }, (_, i) => [-77 + i * 0.0001, 38 + i * 0.0001]);
    const json = {
      code: 'Ok',
      routes: [{ geometry: { coordinates: coords, type: 'LineString' }, legs: [], duration: 3269.1, distance: 45924.4 }]
    };
    const [route] = parseOsrmRoutes(json);
    expect(route.path.length).toBeLessThanOrEqual(240);
    expect(route.path[0]).toEqual([38, -77]);
    expect(route.path.at(-1)).toEqual([coords.at(-1)![1], coords.at(-1)![0]]);
    expect(route.distanceKm).toBe(45.9);
    expect(route.durationMin).toBe(54);
  });

  it('returns [] for non-Ok codes, garbage, and routes without geometry', () => {
    expect(parseOsrmRoutes({ code: 'NoRoute', message: 'Impossible route.' })).toEqual([]);
    expect(parseOsrmRoutes(null)).toEqual([]);
    expect(parseOsrmRoutes({})).toEqual([]);
    expect(parseOsrmRoutes({ code: 'Ok', routes: [{ legs: [], duration: 1, distance: 1 }] })).toEqual([]);
  });

  it('drops routes with malformed coordinates or missing numbers', () => {
    const json = {
      code: 'Ok',
      routes: [
        { geometry: { coordinates: [['x', 'y'], [null, 1]] }, legs: [], duration: 60, distance: 100 },
        { geometry: { coordinates: [[-77, 38], [-77.1, 38.1]] }, legs: [], duration: 'NaN', distance: 100 }
      ]
    };
    expect(parseOsrmRoutes(json)).toEqual([]);
  });
});

describe('downsamplePath', () => {
  const path = (n: number): Array<[number, number]> => Array.from({ length: n }, (_, i) => [i, i + 1000] as [number, number]);

  it('leaves short paths untouched', () => {
    const p = path(240);
    expect(downsamplePath(p)).toBe(p);
    expect(downsamplePath(path(2))).toHaveLength(2);
  });

  it('strides long paths down to ≤ max, preserving order and both ends', () => {
    for (const n of [241, 480, 1000, 9999]) {
      const out = downsamplePath(path(n));
      expect(out.length).toBeLessThanOrEqual(240);
      expect(out[0]).toEqual([0, 1000]);
      expect(out.at(-1)).toEqual([n - 1, n - 1 + 1000]);
      for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
    }
  });

  it('respects a custom max', () => {
    const out = downsamplePath(path(100), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.at(-1)).toEqual([99, 1099]);
  });
});

describe('pickDefaultMode', () => {
  const mode = (m: 'drive' | 'walk' | 'bike', mins: number[]): DirectionsModeResult => ({
    mode: m,
    routes: mins.map((durationMin) => ({ durationMin, distanceKm: 1, path: [[0, 0], [1, 1]] as Array<[number, number]> }))
  });

  it('prefers walking when the best walk route is ≤ 25 min', () => {
    expect(pickDefaultMode([mode('drive', [8]), mode('walk', [30, 25])])).toBe('walk');
    expect(pickDefaultMode([mode('walk', [12])])).toBe('walk');
  });

  it('falls back to driving for long walks', () => {
    expect(pickDefaultMode([mode('drive', [18]), mode('bike', [40]), mode('walk', [26])])).toBe('drive');
    expect(pickDefaultMode([mode('drive', [18])])).toBe('drive');
  });

  it('uses the first available mode when driving is missing', () => {
    expect(pickDefaultMode([mode('bike', [35]), mode('walk', [90])])).toBe('bike');
  });

  it('returns undefined when nothing routed', () => {
    expect(pickDefaultMode([])).toBeUndefined();
    expect(pickDefaultMode([{ mode: 'drive', routes: [] }])).toBeUndefined();
  });
});

describe('URL builders', () => {
  it('buildOsrmUrl targets the right FOSSGIS profile with lng,lat ordering', () => {
    const url = buildOsrmUrl('walk', { lat: 38.8895, lng: -77.0353 }, { lat: 38.8719, lng: -77.0563 });
    expect(url).toContain('routing.openstreetmap.de/routed-foot/route/v1/driving/');
    expect(url).toContain('-77.0353,38.8895;-77.0563,38.8719');
    expect(url).toContain('alternatives=true');
    expect(url).toContain('overview=full');
    expect(url).toContain('geometries=geojson');
    expect(buildOsrmUrl('drive', { lat: 1, lng: 2 }, { lat: 3, lng: 4 })).toContain('/routed-car/');
    expect(buildOsrmUrl('bike', { lat: 1, lng: 2 }, { lat: 3, lng: 4 })).toContain('/routed-bike/');
  });

  it('buildGoogleMapsUrl encodes origin and destination', () => {
    const url = buildGoogleMapsUrl('Lincoln Memorial', 'Reagan Airport, DC');
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=Lincoln%20Memorial&destination=Reagan%20Airport%2C%20DC'
    );
  });

  it('buildTransitUrl adds the transit travel mode', () => {
    const url = buildTransitUrl('A', 'B');
    expect(url).toContain('origin=A');
    expect(url).toContain('destination=B');
    expect(url.endsWith('&travelmode=transit')).toBe(true);
  });
});
