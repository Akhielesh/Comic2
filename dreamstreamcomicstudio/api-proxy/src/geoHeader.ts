/**
 * Chat's approximate place, from Cloudflare's own request data.
 *
 * Cloudflare attaches an approximate city, region, country and coordinates to every request it serves
 * (`request.cf`). When the browser shares no location, Chat uses that place for "weather here", "near me" and
 * local news. The Worker writes it into ONE header for the backend, `X-DS-Geo`, and the backend reads it with
 * `geoFromEdgeHeader` (server/src/ai/clientGeo.ts) and the chat route's own client-context caps. Nothing is
 * looked up by IP anywhere.
 *
 * - Only the main host's Chat routes get it (`/api/chat` and `/api/chat/…`): no other API path, and never the comics
 *   host (whose requests arrive through the comics-edge service binding with that host in the URL), the Stream Studio
 *   host or the workers.dev address.
 * - proxy.ts deletes any incoming `X-DS-Geo` on every request before calling this, so a request can never bring its
 *   own value to the backend.
 * - Only city and region (≤ 80 characters each), country (two letters) and coordinates (both or neither, in range,
 *   rounded to 2 decimals, about a kilometre). Never the postcode, time zone, network or IP.
 * - The value is `encodeURIComponent(JSON.stringify(place))`: plain ASCII, at most 512 bytes. When long names would
 *   exceed that, the region is left out first, then the city.
 *
 * Pure: no I/O, never throws, nothing logged.
 */
import { MAIN_HOSTNAME } from '../../shared/streamHost';

export const GEO_HEADER = 'x-ds-geo';
export const GEO_HEADER_MAX_BYTES = 512;
const TEXT_MAX = 80;

interface EdgePlace {
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

/** `/api/chat` and everything under `/api/chat/`; not `/api/chats` or `/api/chatter`. */
export const isChatPath = (pathname: string): boolean => pathname === '/api/chat' || pathname.startsWith('/api/chat/');

// Lone UTF-16 surrogates would make encodeURIComponent throw; control characters have no place in a header value.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(LONE_SURROGATE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  // Cut on code points, so a character outside the BMP is never split in half.
  const capped = Array.from(clean).slice(0, TEXT_MAX).join('').trim();
  return capped || undefined;
};

// Two letters only: Cloudflare's "XX" (unknown) and "T1" (Tor) are not places.
const countryCode = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return undefined;
  const code = value.toUpperCase();
  return code === 'XX' ? undefined : code;
};

const coordinate = (value: unknown, limit: number): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || Math.abs(n) > limit) return undefined;
  return Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
};

const encoded = (place: EdgePlace): string | null => {
  if (!place.city && !place.region && !place.country && place.lat === undefined) return null;
  try {
    return encodeURIComponent(JSON.stringify(place));
  } catch {
    return null;
  }
};

/** The `X-DS-Geo` value for this request, or null when it gets none. */
export function geoHeaderFor(req: Request, url: URL): string | null {
  if (url.host !== MAIN_HOSTNAME || !isChatPath(url.pathname)) return null;
  const cf: unknown = (req as Request & { cf?: unknown }).cf;
  if (!cf || typeof cf !== 'object' || Array.isArray(cf)) return null;
  const data = cf as Record<string, unknown>;
  const lat = coordinate(data.latitude, 90);
  const lng = coordinate(data.longitude, 180);
  const coords = lat !== undefined && lng !== undefined ? { lat, lng } : {};
  const city = text(data.city);
  const region = text(data.region);
  const country = countryCode(data.country);
  const tries: EdgePlace[] = [
    { city, region, country, ...coords },
    { city, country, ...coords },
    { country, ...coords }
  ];
  for (const place of tries) {
    const value = encoded(place);
    if (value && value.length <= GEO_HEADER_MAX_BYTES) return value;
  }
  return null;
}
