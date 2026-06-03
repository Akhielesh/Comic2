import { describe, it, expect } from 'vitest';
import { parseFoursquare, normalizeRating, fsqPhotoUrl } from './foursquare.js';

describe('normalizeRating', () => {
  it('scales a 0–10 rating down to 0–5', () => {
    expect(normalizeRating(9)).toBe(4.5);
    expect(normalizeRating(8.4)).toBe(4.2);
  });
  it('leaves a 0–5 rating as-is', () => {
    expect(normalizeRating(4.6)).toBe(4.6);
  });
  it('returns undefined for missing/invalid', () => {
    expect(normalizeRating(undefined)).toBeUndefined();
    expect(normalizeRating('x')).toBeUndefined();
  });
});

describe('fsqPhotoUrl', () => {
  it('builds a sized URL from prefix/suffix', () => {
    expect(fsqPhotoUrl({ prefix: 'https://fastly.4sqi.net/img/general/', suffix: '/abc.jpg' }))
      .toBe('https://fastly.4sqi.net/img/general/400x400/abc.jpg');
  });
  it('passes through a string and rejects junk', () => {
    expect(fsqPhotoUrl('https://x/y.jpg')).toBe('https://x/y.jpg');
    expect(fsqPhotoUrl({})).toBeUndefined();
    expect(fsqPhotoUrl(null)).toBeUndefined();
  });
});

describe('parseFoursquare', () => {
  it('parses the current API shape (top-level lat/lng, rating/price/photos)', () => {
    const json = {
      results: [
        {
          name: 'Trattoria Bella',
          latitude: 40.7128,
          longitude: -74.006,
          distance: 320,
          categories: [{ name: 'Italian Restaurant' }],
          location: { formatted_address: '12 Mulberry St, New York' },
          tel: '+1 212 555 0100',
          website: 'https://bella.example',
          hours: { display: 'Open until 11 PM' },
          rating: 9.2,
          price: 2,
          photos: [{ prefix: 'https://p/', suffix: '/1.jpg' }]
        }
      ]
    };
    const places = parseFoursquare(json);
    expect(places).toHaveLength(1);
    const p = places[0];
    expect(p.name).toBe('Trattoria Bella');
    expect(p.lat).toBe(40.7128);
    expect(p.distanceKm).toBe(0.32);
    expect(p.category).toBe('Italian Restaurant');
    expect(p.address).toContain('Mulberry');
    expect(p.rating).toBe(4.6);
    expect(p.price).toBe(2);
    expect(p.image).toBe('https://p/400x400/1.jpg');
    expect(p.mapUrl).toContain('google.com/maps');
  });

  it('parses the legacy v3 shape (geocodes.main, hours string)', () => {
    const json = {
      results: [
        {
          name: 'Old Town Cafe',
          geocodes: { main: { latitude: 51.5, longitude: -0.12 } },
          categories: [{ short_name: 'Cafe' }],
          hours: 'Mon-Fri 7-5'
        }
      ]
    };
    const places = parseFoursquare(json);
    expect(places[0].lat).toBe(51.5);
    expect(places[0].category).toBe('Cafe');
    expect(places[0].openingHours).toBe('Mon-Fri 7-5');
  });

  it('drops entries without a name or coordinates, and handles empty input', () => {
    expect(parseFoursquare({ results: [{ name: 'No Coords' }, { latitude: 1, longitude: 1 }] })).toEqual([]);
    expect(parseFoursquare({})).toEqual([]);
  });
});
