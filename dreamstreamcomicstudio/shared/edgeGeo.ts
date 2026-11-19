// Chat's approximate place, as the API Worker writes it and the backend reads it: ONE encode/decode pair, so the
// two sides clean a place the same way.
//
// The API Worker (api-proxy/src/geoHeader.ts) builds the X-DS-Geo value from Cloudflare's own request data
// (request.cf) with encodeEdgeGeo; the backend (server/src/ai/clientGeo.ts) reads it back with decodeEdgeGeo and then
// passes it through the chat route's client-context caps. Both run the same cleaning:
// - only city, region, country and coordinates; never the postcode, time zone, network or an IP;
// - city and region: lone UTF-16 surrogates removed, control characters turned into spaces, spaces collapsed, at most
//   80 UTF-16 units and never a character cut in half (so the chat route's own 80-unit cap never splits one either);
// - country: exactly two letters, upper-cased; Cloudflare's "XX" (unknown) is not a place;
// - coordinates: both or neither, in range, rounded to 2 decimals (about a kilometre);
// - the value is encodeURIComponent(JSON.stringify(place)): plain ASCII, at most 512 bytes; when long names would
//   exceed that, the region is left out first, then the city.
//
// Dependency-free on purpose: the Worker and the Node backend both import it. Pure: no I/O, never throws.

/** The header the API Worker writes (lower case, as Node exposes it). */
export const EDGE_GEO_HEADER = 'x-ds-geo';
/** The most the Worker ever writes. */
export const EDGE_GEO_MAX_BYTES = 512;
/** City and region, in UTF-16 units (the chat route's client-context cap). */
export const EDGE_GEO_TEXT_MAX = 80;
// The reader refuses anything far larger than the Worker writes.
const DECODE_MAX_CHARS = 1_024;

export interface EdgePlace {
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

// Lone UTF-16 surrogates would make encodeURIComponent throw; control characters have no place in a header value.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(LONE_SURROGATE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  // Whole characters only, up to 80 UTF-16 units: a character outside the BMP is never split in half.
  let capped = '';
  for (const ch of clean) {
    if (capped.length + ch.length > EDGE_GEO_TEXT_MAX) break;
    capped += ch;
  }
  return capped.trim() || undefined;
};

// Two letters only: Cloudflare's "XX" (unknown) and "T1" (Tor) are not places.
const countryCode = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return undefined;
  const code = value.toUpperCase();
  return code === 'XX' ? undefined : code;
};

// Cloudflare sends coordinates as strings; the header carries numbers. Both are read the same way.
const coordinate = (value: unknown, limit: number): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || Math.abs(n) > limit) return undefined;
  return Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
};

const cleanPlace = (raw: Record<string, unknown>, latKey: string, lngKey: string): EdgePlace => {
  const lat = coordinate(raw[latKey], 90);
  const lng = coordinate(raw[lngKey], 180);
  const place: EdgePlace = {
    city: text(raw.city),
    region: text(raw.region),
    country: countryCode(raw.country),
    ...(lat !== undefined && lng !== undefined ? { lat, lng } : {})
  };
  for (const key of Object.keys(place) as (keyof EdgePlace)[]) if (place[key] === undefined) delete place[key];
  return place;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const encoded = (place: EdgePlace): string | null => {
  if (!Object.keys(place).length) return null;
  try {
    return encodeURIComponent(JSON.stringify(place));
  } catch {
    return null;
  }
};

/** The X-DS-Geo value for Cloudflare's request data (`request.cf`), or null when nothing in it is a place. */
export function encodeEdgeGeo(cf: unknown): string | null {
  if (!isRecord(cf)) return null;
  const { city, region, country, lat, lng } = cleanPlace(cf, 'latitude', 'longitude');
  const coords = lat !== undefined && lng !== undefined ? { lat, lng } : {};
  const tries: EdgePlace[] = [
    { city, region, country, ...coords },
    { city, country, ...coords },
    { country, ...coords }
  ];
  for (const place of tries) {
    for (const key of Object.keys(place) as (keyof EdgePlace)[]) if (place[key] === undefined) delete place[key];
    const value = encoded(place);
    if (value && value.length <= EDGE_GEO_MAX_BYTES) return value;
  }
  return null;
}

/** The place an X-DS-Geo value holds, cleaned the same way the Worker cleans it. Missing or malformed → null. */
export function decodeEdgeGeo(raw: unknown): EdgePlace | null {
  try {
    if (typeof raw !== 'string' || !raw || raw.length > DECODE_MAX_CHARS) return null;
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!isRecord(parsed)) return null;
    const place = cleanPlace(parsed, 'lat', 'lng');
    return Object.keys(place).length ? place : null;
  } catch {
    return null;
  }
}
