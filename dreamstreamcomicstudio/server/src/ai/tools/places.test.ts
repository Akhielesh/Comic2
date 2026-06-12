import { describe, it, expect } from 'vitest';
import { isNameQuery, nameClauses, nameSearchTerm, osmFilters, parseOverpass, rankByNameMatch, type Anchor } from './places.js';

describe('osmFilters', () => {
  it('routes common queries to the right OSM tags', () => {
    expect(osmFilters('coffee shops').clauses[0]).toContain('cafe');
    expect(osmFilters('best italian restaurant').clauses[0]).toContain('restaurant');
    expect(osmFilters('a hotel for tonight').clauses[0]).toContain('hotel');
    expect(osmFilters('nearest pharmacy').clauses[0]).toContain('pharmacy');
    expect(osmFilters('cocktail bar').clauses[0]).toContain('bar');
  });
  it('defaults to restaurants', () => {
    const f = osmFilters('somewhere to go');
    expect(f.clauses[0]).toContain('restaurant');
    expect(f.label).toBe('restaurants');
    expect(f.matched).toBe(false);
  });
});

describe('name-aware search', () => {
  it('treats unmatched queries as name searches, categories not', () => {
    expect(isNameQuery('mezeh')).toBe(true);
    expect(isNameQuery("trader joe's")).toBe(true);
    expect(isNameQuery('coffee shops')).toBe(false);
    expect(isNameQuery('best italian restaurant')).toBe(false);
    expect(isNameQuery('')).toBe(false);
  });

  it('strips filler words from the name term', () => {
    expect(nameSearchTerm('mezeh near me')).toBe('mezeh');
    expect(nameSearchTerm('best mezeh restaurant nearby')).toBe('mezeh');
    expect(nameSearchTerm('mezeh')).toBe('mezeh');
  });

  it('builds case-insensitive name/brand/cuisine clauses with escaped regex', () => {
    const clauses = nameClauses("trader joe's");
    expect(clauses[0]).toBe(`["amenity"]["name"~"trader joe's",i]`);
    expect(clauses.some((c) => c.includes('brand'))).toBe(true);
    expect(clauses.some((c) => c.includes('cuisine'))).toBe(true);
    expect(nameClauses('a.b(c)')[0]).toContain('a\\.b\\(c\\)');
  });

  it('ranks exact → prefix → contains → rest, stably', () => {
    const items = [
      { name: 'Bellissimo' },
      { name: 'Mezeh Mediterranean Grill' },
      { name: 'Cafe Mezeh Annex' },
      { name: 'mezeh' }
    ];
    const ranked = rankByNameMatch(items, 'mezeh').map((i) => i.name);
    expect(ranked).toEqual(['mezeh', 'Mezeh Mediterranean Grill', 'Cafe Mezeh Annex', 'Bellissimo']);
  });
});

describe('parseOverpass', () => {
  const anchor: Anchor = { lat: 38.8895, lng: -77.0353, label: 'Washington, DC' };
  const json = {
    elements: [
      {
        type: 'node',
        lat: 38.8895,
        lon: -77.0353,
        tags: { name: 'Zero Distance Diner', amenity: 'restaurant', cuisine: 'american', opening_hours: 'Mo-Su 08:00-22:00', website: 'https://zdd.example', 'addr:street': '1 Mall Rd', 'addr:city': 'DC' }
      },
      {
        type: 'way',
        center: { lat: 38.8995, lon: -77.0353 },
        tags: { name: 'Uphill Pizza', amenity: 'restaurant', cuisine: 'italian;pizza' }
      },
      { type: 'node', lat: 1, lon: 1, tags: {} }, // no name → dropped
      { type: 'node', tags: { name: 'No Coords' } } // no coords → dropped
    ]
  };

  it('extracts named places with coords, distance, and tags', () => {
    const places = parseOverpass(json, anchor);
    expect(places).toHaveLength(2);
    expect(places[0].name).toBe('Zero Distance Diner');
    expect(places[0].distanceKm).toBe(0);
    expect(places[0].cuisine).toBe('american');
    expect(places[0].address).toContain('1 Mall Rd');
    expect(places[0].website).toBe('https://zdd.example');
    expect(places[0].mapUrl).toContain('openstreetmap.org');
  });

  it('sorts by distance ascending', () => {
    const places = parseOverpass(json, anchor);
    expect(places[0].name).toBe('Zero Distance Diner');
    expect(places[1].name).toBe('Uphill Pizza');
    expect(places[1].distanceKm! > 0).toBe(true);
    expect(places[1].cuisine).toBe('italian, pizza');
  });

  it('deduplicates by name and handles empty input', () => {
    const dup = { elements: [json.elements[0], json.elements[0]] };
    expect(parseOverpass(dup, anchor)).toHaveLength(1);
    expect(parseOverpass({}, anchor)).toEqual([]);
  });
});
