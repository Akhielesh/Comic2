// Foursquare Places provider — the rich, keyed upgrade for local search (ratings,
// price, photos, categories). Enabled when FOURSQUARE_API_KEY is set; otherwise the
// caller falls back to keyless OpenStreetMap.
//
// The parser is tolerant of both the current Foursquare Places API and the legacy
// v3 shape (top-level latitude/longitude OR geocodes.main; hours.display OR a
// string; photos as prefix/suffix), so it keeps working across the API's versions.
// The endpoint can't be runtime-verified in the sandbox; the parser is unit-tested.

import type { PlaceResult, PlacesResultsArtifact } from '../../../../apiTypes.js';
import { FOURSQUARE_API_KEY, FOURSQUARE_API_VERSION } from '../../config.js';

const SEARCH_URL = 'https://places-api.foursquare.com/places/search';
const DEFAULT_RADIUS_M = 2500;
const LIMIT = 12;

export const foursquareEnabled = (): boolean => Boolean(FOURSQUARE_API_KEY);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Foursquare v3 ratings are 0–10; normalize to a 0–5 scale, one decimal.
export const normalizeRating = (raw: unknown): number | undefined => {
  const r = num(raw);
  if (r === undefined) return undefined;
  const five = r > 5 ? r / 2 : r; // already 0–5 in some responses
  return Math.round(five * 10) / 10;
};

// Build a usable photo URL from a Foursquare photo object (prefix + size + suffix).
export const fsqPhotoUrl = (photo: any): string | undefined => {
  if (!photo) return undefined;
  if (typeof photo === 'string') return photo;
  if (typeof photo.prefix === 'string' && typeof photo.suffix === 'string') {
    return `${photo.prefix}400x400${photo.suffix}`;
  }
  return undefined;
};

const coordsOf = (p: any): { lat?: number; lng?: number } => {
  const lat = num(p?.latitude) ?? num(p?.geocodes?.main?.latitude);
  const lng = num(p?.longitude) ?? num(p?.geocodes?.main?.longitude);
  return { lat, lng };
};

const hoursOf = (p: any): string | undefined => {
  const h = p?.hours;
  if (!h) return undefined;
  if (typeof h === 'string') return h;
  if (typeof h.display === 'string') return h.display;
  if (typeof h.open_now === 'boolean') return h.open_now ? 'Open now' : 'Closed';
  return undefined;
};

/** Parse a Foursquare search response into PlaceResults (pure + testable). */
export const parseFoursquare = (json: any): PlaceResult[] => {
  const results: any[] = Array.isArray(json?.results) ? json.results : [];
  const out: PlaceResult[] = [];
  for (const p of results) {
    const name = p?.name;
    const { lat, lng } = coordsOf(p);
    if (!name || lat === undefined || lng === undefined) continue;
    const category =
      (Array.isArray(p?.categories) && p.categories[0]?.name) ||
      (Array.isArray(p?.categories) && p.categories[0]?.short_name) ||
      undefined;
    const distM = num(p?.distance);
    const photo = Array.isArray(p?.photos) ? fsqPhotoUrl(p.photos[0]) : undefined;
    out.push({
      name,
      category: typeof category === 'string' ? category : undefined,
      lat,
      lng,
      distanceKm: distM !== undefined ? Math.round((distM / 1000) * 100) / 100 : undefined,
      address: p?.location?.formatted_address || p?.location?.address || undefined,
      openingHours: hoursOf(p),
      website: typeof p?.website === 'string' ? p.website : undefined,
      phone: typeof p?.tel === 'string' ? p.tel : undefined,
      image: photo,
      rating: normalizeRating(p?.rating),
      price: num(p?.price),
      mapUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    });
  }
  // Foursquare already ranks by relevance/distance; keep its order but cap.
  return out.slice(0, LIMIT);
};

export interface FsqArgs {
  query: string;
  near?: string;
  userLocation?: { lat: number; lng: number };
  label: string; // human label for the category (from osmFilters)
}

export const findPlacesFoursquare = async (
  args: FsqArgs,
  signal?: AbortSignal
): Promise<PlacesResultsArtifact> => {
  const params = new URLSearchParams({
    query: args.query,
    radius: String(DEFAULT_RADIUS_M),
    limit: String(LIMIT),
    fields: 'fsq_place_id,name,latitude,longitude,geocodes,location,categories,distance,tel,website,hours,rating,price,photos'
  });
  let near = 'your area';
  if (args.near && args.near.trim()) {
    params.set('near', args.near.trim());
    near = args.near.trim();
  } else if (args.userLocation) {
    params.set('ll', `${args.userLocation.lat},${args.userLocation.lng}`);
    near = 'your location';
  } else {
    throw new Error('I need a location — name a place or enable location.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${FOURSQUARE_API_KEY}`,
        'X-Places-Api-Version': FOURSQUARE_API_VERSION,
        Accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Foursquare returned ${res.status}`);
    const json = await res.json();
    const results = parseFoursquare(json);
    // Derive a friendlier anchor for the map from the first result if we used "near me".
    const anchor = args.userLocation
      ? { lat: args.userLocation.lat, lng: args.userLocation.lng }
      : results[0]
        ? { lat: results[0].lat, lng: results[0].lng }
        : undefined;
    return { query: args.label, near, anchor, results };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};
