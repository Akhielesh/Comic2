// Chat's approximate place, and the client IP helper.
//
// Why: the browser only shares a precise location after an explicit permission grant, which rarely happens, so
// without a fallback "weather", "near me" and "local news" resolve to nowhere. The fallback is the approximate place
// Cloudflare already attaches to every request: the API Worker (api-proxy/src/geoHeader.ts) writes it into the
// X-DS-Geo header for the main host's /api/chat routes and /api/recipes/run only, after deleting any X-DS-Geo the
// request brought. This module only reads that header, with the same cleaning the Worker used to write it
// (shared/edgeGeo.ts). No IP is ever sent to a geolocation service, and nothing here is logged.
// The chat route passes the result through its own sanitizeClientContext, so a browser location and this one get
// the same caps.
import { EDGE_GEO_HEADER, decodeEdgeGeo, type EdgePlace } from '../../../shared/edgeGeo.js';

export type ClientGeo = EdgePlace;

/** The header the API Worker writes (lower case, as Node exposes it). */
export { EDGE_GEO_HEADER };

/**
 * The approximate place from the API Worker's X-DS-Geo header: city, region, country and coordinates (both or
 * neither), nothing else. Missing or malformed → null. Never throws.
 */
export const geoFromEdgeHeader = (headers: Record<string, unknown> | undefined): ClientGeo | null =>
  decodeEdgeGeo(headers?.[EDGE_GEO_HEADER]);

/** Best client IP from common proxy headers (Cloudflare → XFF → req.ip). */
export const clientIpFromReq = (req: { headers: Record<string, unknown>; ip?: string }): string | undefined => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.ip;
};
