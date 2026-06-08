// Coarse, privacy-conscious IP geolocation for the chat.
//
// Why: the browser only shares precise location AFTER an explicit permission grant, which
// almost never happens — so without this the model has no idea where the user is and
// "weather", "near me", and "local news" resolve to nowhere / the whole world. This derives
// a CITY-LEVEL location from the request IP (no permission needed — "internet location
// coding"), coarsened to ~1km, cached per IP, best-effort (never throws/blocks).

export interface ClientGeo {
  city?: string;
  region?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

const cache = new Map<string, { at: number; geo: ClientGeo | null }>();
const TTL_MS = 6 * 3_600_000;
const TIMEOUT_MS = 3_000;

const round2 = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;

// Public (routable) IPs only — private/loopback/link-local/CGNAT can't be geolocated.
const isPublicIp = (ip: string): boolean => {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/i, '');
  if (v === '::1' || v === '0.0.0.0' || v.startsWith('127.') || v.startsWith('169.254.')) return false;
  if (v.startsWith('10.') || v.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return false;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v)) return false; // CGNAT
  if (/^(fc|fd|fe80)/i.test(v)) return false;
  return true;
};

/** Best client IP from common proxy headers (Cloudflare → XFF → req.ip). */
export const clientIpFromReq = (req: { headers: Record<string, unknown>; ip?: string }): string | undefined => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.ip;
};

/** Resolve a coarse city-level location for an IP. Cached; never throws. */
export const resolveClientGeo = async (ipRaw?: string): Promise<ClientGeo | null> => {
  const ip = (ipRaw || '').replace(/^::ffff:/i, '').trim();
  if (!isPublicIp(ip)) return null;
  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.geo;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // ip-api.com: free, fast (~150ms), no key, works server-side. HTTP-only on the free tier,
    // which is fine for a server→server call (no browser mixed-content). 45 req/min/server IP,
    // but caching per client-IP keeps us well under that.
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,countryCode,lat,lon`,
      { signal: controller.signal }
    );
    const d = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    const geo: ClientGeo | null =
      d && d.status === 'success'
        ? {
            city: typeof d.city === 'string' ? d.city : undefined,
            region: typeof d.regionName === 'string' ? d.regionName : undefined,
            country: typeof d.countryCode === 'string' ? d.countryCode : undefined,
            lat: round2(d.lat),
            lng: round2(d.lon)
          }
        : null;
    cache.set(ip, { at: Date.now(), geo });
    return geo;
  } catch {
    cache.set(ip, { at: Date.now(), geo: null });
    return null;
  } finally {
    clearTimeout(timer);
  }
};
