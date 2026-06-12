// Local / places search — the "find restaurants near me" experience, keyless.
//
// Pipeline: resolve an anchor (the user's location, or a named place via
// Nominatim) → query OpenStreetMap's Overpass API for nearby points of interest
// matching the requested category → compute distance from the anchor → enrich the
// top results with a photo pulled from each place's website (OpenGraph). Returns a
// PlacesResultsArtifact the client renders as a rich local card + map.
//
// Open data (OSM) gives name, distance, category, cuisine, hours, website, phone
// and map pins — but rarely ratings/photos. Photos are best-effort via the website.
// Public endpoints; not runtime-verifiable in the sandbox. Pure parsers are tested.

import type { PlaceResult, PlacesResultsArtifact } from '../../../../apiTypes.js';
import { unfurlUrl } from './unfurl.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Public Overpass instances, tried in order — the primary rate-limits busy IPs
// (429), so a mirror keeps local search alive instead of silently degrading.
const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = 'DreamStreamComicStudio/1.0 (chat places tool)';
const DEFAULT_RADIUS_M = 2500;
/** Wider radius for proper-name searches — a specific place is worth a drive. */
const NAME_RADIUS_M = 12_000;
const MAX_RESULTS = 12;
const PHOTO_ENRICH_COUNT = 5;

export interface Anchor { lat: number; lng: number; label: string }

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.asin(Math.sqrt(h)) * 100) / 100;
};

// Map a free-text query/category to OpenStreetMap tag filters (Overpass clauses).
// Returns the Overpass filter body + a human label for what we searched. `matched`
// distinguishes a recognized category from the restaurants fallback — unmatched
// queries are usually a PLACE NAME ("mezeh", "trader joe's") and get a name search.
export const osmFilters = (query: string): { clauses: string[]; label: string; matched: boolean } => {
  const q = query.toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has('coffee', 'café', 'cafe')) return { clauses: ['["amenity"="cafe"]'], label: 'coffee shops', matched: true };
  if (has('bar', 'pub', 'drink', 'cocktail')) return { clauses: ['["amenity"~"bar|pub"]'], label: 'bars & pubs', matched: true };
  if (has('fast food', 'burger', 'mcdonald', 'takeaway', 'take-out')) return { clauses: ['["amenity"="fast_food"]'], label: 'fast food', matched: true };
  if (has('hotel', 'motel', 'hostel', 'stay', 'lodging', 'accommodation')) return { clauses: ['["tourism"~"hotel|motel|hostel|guest_house"]'], label: 'places to stay', matched: true };
  if (has('pharmacy', 'drugstore', 'chemist')) return { clauses: ['["amenity"="pharmacy"]'], label: 'pharmacies', matched: true };
  if (has('hospital', 'emergency room', 'emergency')) return { clauses: ['["amenity"="hospital"]'], label: 'hospitals', matched: true };
  if (has('atm', 'cash machine')) return { clauses: ['["amenity"="atm"]'], label: 'ATMs', matched: true };
  if (has('bank')) return { clauses: ['["amenity"="bank"]'], label: 'banks', matched: true };
  if (has('gas', 'petrol', 'fuel', 'charging', 'ev charger')) return { clauses: ['["amenity"~"fuel|charging_station"]'], label: 'fuel & charging', matched: true };
  if (has('supermarket', 'grocery', 'groceries')) return { clauses: ['["shop"~"supermarket|convenience"]'], label: 'groceries', matched: true };
  if (has('gym', 'fitness', 'workout')) return { clauses: ['["leisure"="fitness_centre"]', '["amenity"="gym"]'], label: 'gyms', matched: true };
  if (has('park')) return { clauses: ['["leisure"="park"]'], label: 'parks', matched: true };
  if (has('museum', 'gallery')) return { clauses: ['["tourism"~"museum|gallery"]'], label: 'museums & galleries', matched: true };
  if (has('attraction', 'sights', 'things to do', 'tourist')) return { clauses: ['["tourism"~"attraction|viewpoint|artwork"]'], label: 'attractions', matched: true };
  if (has('restaurant', 'food', 'dinner', 'lunch', 'breakfast', 'brunch', 'eat')) return { clauses: ['["amenity"="restaurant"]'], label: 'restaurants', matched: true };
  // Default: restaurants / food.
  return { clauses: ['["amenity"="restaurant"]'], label: 'restaurants', matched: false };
};

// ---------------------------------------------------------- name-aware search ----
//
// "mezeh" should find Mezeh Mediterranean Grill — not every restaurant within
// 2.5 km. A query that doesn't hit a category keyword is treated as a proper-name
// (or cuisine) search: a case-insensitive OSM name/brand/cuisine match in a wider
// radius, ranked exact → prefix → contains, topped up with category results only
// when the name search runs thin.

/** True when the query looks like a specific place name rather than a category. */
export const isNameQuery = (query: string): boolean => {
  const q = query.trim().toLowerCase();
  return !!q && !osmFilters(q).matched;
};

/** The term to name-match on: the query minus generic filler words. */
export const nameSearchTerm = (query: string): string =>
  query
    .toLowerCase()
    .replace(/\b(restaurants?|food|places?|near\s+me|nearby|around|best|good|the)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query.trim();

const escapeOverpassRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');

/** Overpass clauses matching a place by name, brand or cuisine (case-insensitive).
 *  A bare `["name"~…,i]` regex forces a scan of EVERY element in the radius
 *  (40s+ over a metro area); pairing it with an indexed POI tag (amenity/shop/…)
 *  keeps the same matches at interactive speed (~6s measured). */
export const nameClauses = (term: string): string[] => {
  const re = escapeOverpassRegex(term);
  const nameMatch = `["name"~"${re}",i]`;
  return [
    `["amenity"]${nameMatch}`,
    `["shop"]${nameMatch}`,
    `["tourism"]${nameMatch}`,
    `["leisure"]${nameMatch}`,
    `["brand"~"${re}",i]`,
    `["cuisine"~"${re.replace(/ /g, '_')}",i]`
  ];
};

/** Stable re-rank: exact name match → starts-with → contains → rest. */
export const rankByNameMatch = <T extends { name: string }>(items: T[], term: string): T[] => {
  const q = term.trim().toLowerCase();
  if (!q) return items;
  const score = (name: string): number => {
    const n = name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
  };
  return [...items].sort((a, b) => score(a.name) - score(b.name));
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  ms: number,
  signal?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

export const geocodeAnchor = async (place: string, signal?: AbortSignal): Promise<Anchor | null> => {
  const res = await fetchWithTimeout(
    `${NOMINATIM}?q=${encodeURIComponent(place)}&format=json&limit=1`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    10_000,
    signal
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as any[];
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit) return null;
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = typeof hit.display_name === 'string' ? hit.display_name.split(',').slice(0, 2).join(',') : place;
  return { lat, lng, label };
};

const buildOverpassQuery = (clauses: string[], anchor: Anchor, radius: number): string => {
  const parts = clauses
    .map((c) => `nwr${c}(around:${radius},${anchor.lat},${anchor.lng});`)
    .join('');
  return `[out:json][timeout:25];(${parts});out center ${MAX_RESULTS * 3};`;
};

/** One union query covering both the name search (wide) and the category fill
 *  (close) — a single Overpass round-trip instead of two (the public API
 *  rate-limits aggressively, so every request counts). */
export const buildCombinedOverpassQuery = (
  nameSearchClauses: string[],
  categoryClauses: string[],
  anchor: Anchor,
  nameRadius: number,
  categoryRadius: number
): string => {
  const name = nameSearchClauses.map((c) => `nwr${c}(around:${nameRadius},${anchor.lat},${anchor.lng});`).join('');
  const cat = categoryClauses.map((c) => `nwr${c}(around:${categoryRadius},${anchor.lat},${anchor.lng});`).join('');
  return `[out:json][timeout:25];(${name}${cat});out center ${MAX_RESULTS * 6};`;
};

const addressOf = (tags: Record<string, string>): string | undefined => {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:city'],
    tags['addr:postcode']
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
};

// Parse an Overpass JSON response into ranked PlaceResults (pure + testable).
// `limit` matters for the combined name+category query: capping at MAX_RESULTS
// before partitioning would let close-by category fill crowd out the actual
// name matches a few km away (the whole point of the name search).
export const parseOverpass = (json: any, anchor: Anchor, limit = MAX_RESULTS): PlaceResult[] => {
  const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
  const out: PlaceResult[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags: Record<string, string> = el?.tags || {};
    const name = tags.name;
    if (!name) continue;
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const category = tags.amenity || tags.tourism || tags.shop || tags.leisure || undefined;
    out.push({
      name,
      category,
      cuisine: tags.cuisine ? tags.cuisine.replace(/_/g, ' ').replace(/;/g, ', ') : undefined,
      lat,
      lng,
      distanceKm: haversineKm(anchor, { lat, lng }),
      address: addressOf(tags),
      openingHours: tags.opening_hours,
      website: tags.website || tags['contact:website'] || undefined,
      phone: tags.phone || tags['contact:phone'] || undefined,
      mapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`
    });
  }
  out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return out.slice(0, limit);
};

// Best-effort: pull an OpenGraph image from the top results' websites so the card
// can show real photos even without a paid places provider.
const enrichPhotos = async (places: PlaceResult[]): Promise<void> => {
  const targets = places.filter((p) => p.website).slice(0, PHOTO_ENRICH_COUNT);
  await Promise.all(
    targets.map(async (p) => {
      try {
        const meta = await unfurlUrl(p.website!);
        if (meta.image) p.image = meta.image;
      } catch {
        /* photo is optional */
      }
    })
  );
};

export interface FindPlacesArgs {
  query: string;
  /** A named place to search around; falls back to the user's location. */
  near?: string;
  /** User location from context, used for "near me" + distances. */
  userLocation?: { lat: number; lng: number };
}

export const findPlaces = async (
  args: FindPlacesArgs,
  signal?: AbortSignal
): Promise<PlacesResultsArtifact> => {
  let anchor: Anchor | null = null;
  if (args.near && args.near.trim()) {
    anchor = await geocodeAnchor(args.near.trim(), signal);
  }
  if (!anchor && args.userLocation) {
    anchor = { lat: args.userLocation.lat, lng: args.userLocation.lng, label: 'your location' };
  }
  if (!anchor) {
    throw new Error('I need a location — tell me a place (e.g. "near the Eiffel Tower") or enable location.');
  }

  const rawQuery = (args.query || '').trim();
  const { clauses, label } = osmFilters(rawQuery);
  const nameSearch = isNameQuery(rawQuery);
  const term = nameSearchTerm(rawQuery);

  const runOverpass = async (queryStr: string): Promise<PlaceResult[]> => {
    const body = `data=${encodeURIComponent(queryStr)}`;
    let lastErr: Error | null = null;
    for (const endpoint of OVERPASS_MIRRORS) {
      try {
        const res = await fetchWithTimeout(
          endpoint,
          {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body
          },
          12_000, // keep headroom for the mirror within the tool's overall budget
          signal
        );
        if (!res.ok) {
          lastErr = new Error(`Places lookup failed (Overpass ${res.status}).`);
          continue; // 429/5xx → try the mirror
        }
        return parseOverpass(await res.json(), anchor!, MAX_RESULTS * 6);
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error('Places lookup failed.');
  };

  // One round-trip: name queries ("mezeh") union a wide name/brand/cuisine match
  // with the close-by category fill; pure category queries skip the name part.
  const overpassQuery = nameSearch
    ? buildCombinedOverpassQuery(nameClauses(term), clauses, anchor, NAME_RADIUS_M, DEFAULT_RADIUS_M)
    : buildOverpassQuery(clauses, anchor, DEFAULT_RADIUS_M);
  const all = await runOverpass(overpassQuery);

  // Partition: when the name search hits, show ONLY the real matches (ranked
  // exact → prefix → contains) — a brand search must not be padded with random
  // nearby restaurants. Category results appear only when nothing matched the
  // name, and the card title is honest either way.
  let results = all;
  let usedLabel = label;
  if (nameSearch) {
    const t = term.toLowerCase();
    const matches = (p: PlaceResult) =>
      p.name.toLowerCase().includes(t) || (p.cuisine ?? '').toLowerCase().includes(t);
    const named = rankByNameMatch(all.filter(matches), term);
    if (named.length) {
      results = named;
      usedLabel = rawQuery;
    }
  }
  results = results.slice(0, MAX_RESULTS);
  await enrichPhotos(results);

  return {
    query: usedLabel,
    near: anchor.label,
    anchor: { lat: anchor.lat, lng: anchor.lng },
    results
  };
};
