/**
 * Discover at the edge (redesign DS-R2; owner decision R-D3). Runs INSIDE the dreamstream-api Worker, after the
 * agent gate and before the container proxy, so browsing public comics never wakes (or reaches) the backend.
 *
 *   GET|HEAD /api/comic/public/discover?sort=&q=&rating=&lang=&kind=&length=&week=&limit=&cursor=  → DiscoverPage
 *   GET|HEAD /api/comic/public/discover/shelves?rating=&lang=&kind=&your_lang=                      → { shelves }
 *
 * READ-ONLY by construction: the only calls are the two anon listing RPCs (server/sql/comic_discovery.sql), which
 * list live PUBLIC publications whose project moderation has not forced private. Every item is rebuilt from the
 * shared allow-list (shared/comic/discovery.ts): slug, title, description, kind, page count, aspect, cover
 * {w480, w1080} as public URLs of pub/ copies, rating, languages, published dates, likes, theme colour, and
 * creator {username, avatarUrl} only when the publication shows its creator. Never the snapshot, safety data, an
 * asset key or a user id.
 *
 * Answers: 400 for any unknown, repeated or malformed parameter (before any database call); 429 from the shared
 * public comic limiter (PUBLIC_COMIC_RL); 503 + no-store when the database does not answer in time (or the SQL is
 * not applied yet: PostgREST's 404 reads as "unavailable", never as an empty Discover). A 200 is
 * `public, max-age=30, s-maxage=30` and is kept in the edge cache (Cache API) for 30 s under the canonical query,
 * so a hold or an unpublish leaves every listing within 60 s; CORS headers are added per request, never cached.
 */
import {
  DISCOVER_CACHE_SECONDS,
  DISCOVER_PATH,
  DISCOVER_SHELVES_PATH,
  discoverListRpcArgs,
  discoverPageFromRpc,
  discoverSearch,
  discoverShelvesFromRpc,
  discoverShelvesRpcArgs,
  discoverShelvesSearch,
  parseDiscoverQuery,
  parseDiscoverShelvesQuery,
  type DiscoverRpcOptions
} from '../../shared/comic/discovery';
import { rpc as supabaseRpc, supabaseOrigin } from '../../functions/_shared/supabaseRpc';
// The CORS allow-list and the limiter live in one place (DS-R2 wave note 4).
import { allow, allowedOrigin, clientIp, publicObjectUrl, type PublicComicEnv } from './publicComic';

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/** The slice of the Workers Cache API (caches.default) this route uses. */
export interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export interface PublicDiscoverDeps {
  /** The RPC client (tests pass a fake; production is functions/_shared/supabaseRpc.ts). */
  rpc?: typeof supabaseRpc;
  /** The edge cache; null turns it off. Default: caches.default where the runtime has it. */
  cache?: EdgeCache | null;
}

const RPC_TIMEOUT_MS = 4000;
const CACHEABLE = `public, max-age=${DISCOVER_CACHE_SECONDS}, s-maxage=${DISCOVER_CACHE_SECONDS}`;
const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-robots-tag': 'noindex'
};
const UNAVAILABLE_BODY = '{"error":{"message":"Discover is taking a moment to load. Try again shortly.","code":"UNAVAILABLE"}}';
const TOO_MANY_BODY = '{"error":{"message":"Too many requests. Try again in a minute.","code":"RATE_LIMIT"}}';
const NOT_FOUND_BODY = '{"error":{"message":"Not found.","code":"NOT_FOUND"}}';

const defaultCache = (): EdgeCache | null => {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return store && store.default && typeof store.default.match === 'function' ? store.default : null;
};

/** The response for this request: CORS for its own origin, no body for HEAD. */
function respond(req: Request, env: PublicComicEnv, body: string, status: number, extra: Record<string, string>): Response {
  const headers = new Headers({ ...BASE_HEADERS, ...extra });
  const origin = allowedOrigin(req, env);
  if (origin) headers.set('access-control-allow-origin', origin);
  return new Response(req.method === 'HEAD' ? null : body, { status, headers });
}

const noStore = (req: Request, env: PublicComicEnv, body: string, status: number, extra: Record<string, string> = {}) =>
  respond(req, env, body, status, { 'cache-control': 'no-store', ...extra });

const badRequest = (req: Request, env: PublicComicEnv, reason: string) =>
  noStore(req, env, JSON.stringify({ error: { message: reason, code: 'BAD_REQUEST' } }), 400);

/** One listing request: its canonical search (the cache key), the RPC to call and how its answer becomes the body. */
interface Route {
  kind: 'list' | 'shelves';
  search: string;
  name: 'comic_discover_list' | 'comic_discover_shelves';
  args: Record<string, unknown>;
  build: (data: unknown, opts: DiscoverRpcOptions) => unknown;
}

/** Which listing a path asks for, with its canonical search, or a 400 reason. */
function routeOf(path: string, params: URLSearchParams): Route | { error: string } | null {
  if (path === DISCOVER_PATH || path === `${DISCOVER_PATH}/`) {
    const parsed = parseDiscoverQuery(params);
    if (parsed.ok === false) return { error: parsed.reason };
    const query = parsed.value;
    return {
      kind: 'list',
      search: discoverSearch(query),
      name: 'comic_discover_list',
      args: discoverListRpcArgs(query),
      build: (data, opts) => discoverPageFromRpc(data, query.sort, opts)
    };
  }
  if (path === DISCOVER_SHELVES_PATH || path === `${DISCOVER_SHELVES_PATH}/`) {
    const parsed = parseDiscoverShelvesQuery(params);
    if (parsed.ok === false) return { error: parsed.reason };
    const query = parsed.value;
    return {
      kind: 'shelves',
      search: discoverShelvesSearch(query),
      name: 'comic_discover_shelves',
      args: discoverShelvesRpcArgs(query),
      build: discoverShelvesFromRpc
    };
  }
  return null;
}

/** Handles the Discover routes; returns null for every other path (the proxy continues). */
export async function handlePublicDiscover(req: Request, env: PublicComicEnv, ctx: Ctx, url: URL, deps: PublicDiscoverDeps = {}): Promise<Response | null> {
  if (url.pathname !== DISCOVER_PATH && !url.pathname.startsWith(`${DISCOVER_PATH}/`)) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return noStore(req, env, '{"error":{"message":"Method not allowed.","code":"METHOD"}}', 405, { allow: 'GET, HEAD' });
  }
  if (!(await allow(env.PUBLIC_COMIC_RL, `discover:${clientIp(req)}`))) return noStore(req, env, TOO_MANY_BODY, 429, { 'retry-after': '60' });
  const route = routeOf(url.pathname, url.searchParams);
  // Anything else under /discover is answered here too: an unknown path never wakes the container.
  if (!route) return noStore(req, env, NOT_FOUND_BODY, 404);
  if ('error' in route) return badRequest(req, env, route.error);

  // One cache entry per canonical query (parameter order, defaults and case folded), without any CORS header.
  const path = route.kind === 'list' ? DISCOVER_PATH : DISCOVER_SHELVES_PATH;
  const cacheKey = new Request(`${url.origin}${path}${route.search ? `?${route.search}` : ''}`, { method: 'GET' });
  const cache = deps.cache === undefined ? defaultCache() : deps.cache;
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit && hit.ok) return respond(req, env, await hit.text(), 200, { 'cache-control': CACHEABLE, vary: 'Origin', 'x-discover-cache': 'hit' });
  }

  const result = await (deps.rpc || supabaseRpc)<unknown>(env, route.name, route.args, { timeoutMs: RPC_TIMEOUT_MS });
  if (!result.ok) return noStore(req, env, UNAVAILABLE_BODY, 503, { 'retry-after': '5' });
  const body = route.build(result.data, { coverUrl: (p) => publicObjectUrl(env, p), avatarOrigin: supabaseOrigin(env) });
  if (!body) {
    console.error('public_discover_rejected', { route: route.kind, reason: 'the listing RPC answered an unexpected shape' });
    return noStore(req, env, UNAVAILABLE_BODY, 503, { 'retry-after': '5' });
  }
  const text = JSON.stringify(body);
  if (cache) {
    const stored = new Response(text, { status: 200, headers: { ...BASE_HEADERS, 'cache-control': CACHEABLE } });
    ctx.waitUntil(cache.put(cacheKey, stored).catch(() => undefined));
  }
  return respond(req, env, text, 200, { 'cache-control': CACHEABLE, vary: 'Origin', 'x-discover-cache': 'miss' });
}
