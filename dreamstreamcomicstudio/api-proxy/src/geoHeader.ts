/**
 * Chat's approximate place, from Cloudflare's own request data.
 *
 * Cloudflare attaches an approximate city, region, country and coordinates to every request it serves
 * (`request.cf`). When the browser shares no location, Chat uses that place for "weather here", "near me" and
 * local news. The Worker writes it into ONE header for the backend, `X-DS-Geo`, and the backend reads it with
 * `geoFromEdgeHeader` (server/src/ai/clientGeo.ts) and the chat route's own client-context caps. Nothing is
 * looked up by IP anywhere.
 *
 * - Only the main host's Chat routes get it: `/api/chat` and `/api/chat/…`, and `/api/recipes/run` (a recipe run
 *   from Chat, whose weather and places tools need the place too). No other API path, and never the comics host
 *   (whose requests arrive through the comics-edge service binding with that host in the URL), the Stream Studio
 *   host or the workers.dev address.
 * - proxy.ts deletes any incoming `X-DS-Geo` on every request before calling this, so a request can never bring its
 *   own value to the backend.
 * - The value itself is built by `encodeEdgeGeo` (shared/edgeGeo.ts), the one place both sides clean a place:
 *   city and region (at most 80 characters each), country (two letters) and coordinates (both or neither, in
 *   range, rounded to 2 decimals, about a kilometre); never the postcode, time zone, network or IP; plain ASCII,
 *   at most 512 bytes.
 *
 * Pure: no I/O, never throws, nothing logged.
 */
import { MAIN_HOSTNAME } from '../../shared/streamHost';
import { EDGE_GEO_HEADER, EDGE_GEO_MAX_BYTES, encodeEdgeGeo } from '../../shared/edgeGeo';

export const GEO_HEADER = EDGE_GEO_HEADER;
export const GEO_HEADER_MAX_BYTES = EDGE_GEO_MAX_BYTES;

/**
 * Chat's routes: `/api/chat` and everything under `/api/chat/` (not `/api/chats` or `/api/chatter`), and the recipe
 * run (`/api/recipes/run`, exactly; not the other recipe routes).
 */
export const getsPlace = (pathname: string): boolean =>
  pathname === '/api/chat' || pathname.startsWith('/api/chat/') || pathname === '/api/recipes/run';

/** The `X-DS-Geo` value for this request, or null when it gets none. */
export function geoHeaderFor(req: Request, url: URL): string | null {
  if (url.host !== MAIN_HOSTNAME || !getsPlace(url.pathname)) return null;
  return encodeEdgeGeo((req as Request & { cf?: unknown }).cf);
}
