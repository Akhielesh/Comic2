// Chat's approximate place, and the client IP helper.
//
// Why: the browser only shares a precise location after an explicit permission grant, which rarely happens, so
// without a fallback "weather", "near me" and "local news" resolve to nowhere. The fallback is the approximate place
// Cloudflare already attaches to every request: the API Worker (api-proxy/src/geoHeader.ts) writes it into the
// X-DS-Geo header for the main host's /api/chat routes only, after deleting any X-DS-Geo the request brought. This
// module only reads that header. No IP is ever sent to a geolocation service, and nothing here is logged.
// The chat route passes the result through its own sanitizeClientContext, so a browser location and this one get
// the same caps.

export interface ClientGeo {
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

/** The header the API Worker writes (lower case, as Node exposes it). */
export const EDGE_GEO_HEADER = 'x-ds-geo';
// The Worker sends at most 512 bytes; anything far larger did not come from it.
const MAX_HEADER_CHARS = 1_024;
const TEXT_MAX = 80;

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, TEXT_MAX)
    .join('')
    .trim();
  return clean || undefined;
};

const coordinate = (value: unknown, limit: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? Math.round(value * 100) / 100 + 0 : undefined;

/**
 * The approximate place from the API Worker's X-DS-Geo header: city, region, country and coordinates (both or
 * neither), nothing else. Missing or malformed → null. Never throws.
 */
export const geoFromEdgeHeader = (headers: Record<string, unknown> | undefined): ClientGeo | null => {
  try {
    const raw = headers?.[EDGE_GEO_HEADER];
    if (typeof raw !== 'string' || !raw || raw.length > MAX_HEADER_CHARS) return null;
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const p = parsed as Record<string, unknown>;
    const lat = coordinate(p.lat, 90);
    const lng = coordinate(p.lng, 180);
    const geo: ClientGeo = {
      city: text(p.city),
      region: text(p.region),
      country: typeof p.country === 'string' && /^[A-Za-z]{2}$/.test(p.country) ? p.country.toUpperCase() : undefined,
      ...(lat !== undefined && lng !== undefined ? { lat, lng } : {})
    };
    for (const key of Object.keys(geo) as (keyof ClientGeo)[]) if (geo[key] === undefined) delete geo[key];
    return Object.keys(geo).length ? geo : null;
  } catch {
    return null;
  }
};

/** Best client IP from common proxy headers (Cloudflare → XFF → req.ip). */
export const clientIpFromReq = (req: { headers: Record<string, unknown>; ip?: string }): string | undefined => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.ip;
};
