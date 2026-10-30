/**
 * dreamstream-comics — the front door of Comic Studio at https://comics.dreamstreamstudio.ai
 * (the same pattern as Atlas at atlas.*, with security headers on top).
 *
 * It serves the SAME frontend (Pages project `comic2`) and the SAME API (dreamstream-api) as the
 * apex; only the host, the <head> branding and the boot experience (services/productHost.ts +
 * components/comicshost/**) differ. Sessions stay per host: Supabase keeps its token in this
 * origin's localStorage, and nothing here ever sets a cookie for `.dreamstreamstudio.ai`.
 *
 *   GET /__edge/health        → {"status":"ok",…} on every host (CI probes workers.dev)
 *   http://…                  → 301 https://…
 *   comic.* (alias)           → 301 https://comics.*  (same path + query); unknown hosts → 302
 *   /api, /api/*              → env.API.fetch(request): the original request, untouched, so the
 *                               API Worker's agent gate, rate limits and IP forwarding still apply
 *   /live*, /models, /share/*, /studio.html → 302 to the main site (other products, own session)
 *   AI agents asking a page   → 302 /api/agent-gate (the page half of the gate; the Pages
 *                               middleware cannot see request.cf through this proxy)
 *   everything else (GET, HEAD, OPTIONS)
 *                             → the Pages origin, same path + query, X-Forwarded-Host set (the
 *                               Pages middleware serves instead of redirecting to the apex),
 *                               Location mapped back here, Comic Studio <head> on HTML except /c/*
 *   any other method          → 405, body never read (Pages has no write endpoints here; a future
 *                               Pages Function that needs POST on this host must be added here)
 * Every response gets HSTS (no includeSubDomains), nosniff, Referrer-Policy, a minimal
 * Permissions-Policy and frame-ancestors 'none' (except share pages, whose Function sets its own
 * framing — /c/<slug>/embed may be framed when the author allows embedding).
 */
import { detectAgent } from '../../api-proxy/src/agent-gate';
import { brandHtml, type RewriterCtor } from './brand';
import {
  ALIAS_HOSTS,
  HEALTH_PATH,
  applyCacheHeaders,
  applySecurityHeaders,
  isApiPath,
  isHtmlResponse,
  isMainProductPath,
  pathAndQuery,
  resolveConfig,
  rewriteLocation,
  shouldBrandHtml,
  shouldGatePage,
  type EdgeConfig
} from './policy';

/** A Workers service binding (only `fetch` is used). */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** Service binding to the dreamstream-api Worker. */
  API?: ServiceBinding;
  PUBLIC_HOST?: string;
  PAGES_ORIGIN?: string;
  MAIN_ORIGIN?: string;
}

export interface EdgeDeps {
  /** Outbound fetch to the Pages origin. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Workers HTMLRewriter (absent outside the Workers runtime → HTML passes unbranded). */
  HTMLRewriter?: RewriterCtor;
}

/** Request headers never forwarded to the Pages origin: hop-by-hop, credentials it has no use
 *  for, and anything a client could use to spoof forwarding or Cloudflare metadata. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // No body is ever forwarded to Pages (proxyToPages), so a client's length must not be either:
  // a Content-Length with no body makes the origin wait for bytes that never come.
  'content-length',
  'forwarded',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto'
]);

const SERVICE = 'dreamstream-comics';

const finish = (response: Response, pathname: string): Response => {
  // 101 (WebSocket upgrades) and other non-standard statuses cannot be re-wrapped.
  if (response.status < 200 || response.status > 599) return response;
  const out = new Response(response.body, response);
  applySecurityHeaders(out.headers, pathname);
  return out;
};

const redirect = (location: string, status: 301 | 302, pathname: string): Response => {
  const headers = new Headers({ location, 'cache-control': status === 301 ? 'public, max-age=3600' : 'no-store' });
  applySecurityHeaders(headers, pathname);
  return new Response(null, { status, headers });
};

const health = (cfg: EdgeConfig, env: Env, pathname: string): Response => {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  applySecurityHeaders(headers, pathname);
  const body = { status: 'ok', service: SERVICE, host: cfg.publicHost, api: Boolean(env.API), time: new Date().toISOString() };
  return new Response(JSON.stringify(body), { status: 200, headers });
};

/** Calm, honest failure page when the Pages origin cannot be reached (never a blank screen). */
const unavailable = (pathname: string, cfg: EdgeConfig): Response => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Comic Studio — DreamStream</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FAF9F5;color:#1a1915;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}@media (prefers-color-scheme:dark){body{background:#262624;color:#eeece8}}main{max-width:28rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1rem;opacity:.8}a{display:inline-block;min-height:44px;line-height:44px;padding:0 1.25rem;border-radius:999px;background:#D97757;color:#fff;text-decoration:none;font-weight:600}</style></head><body><main><h1>Comic Studio can’t load right now</h1><p>We couldn’t reach the Comic Studio pages. Your comics are safe — nothing was changed. Please try again in a moment.</p><a href="https://${cfg.publicHost}/">Try again</a></main></body></html>`;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '10' });
  applySecurityHeaders(headers, pathname);
  return new Response(html, { status: 502, headers });
};

/** AI agents asking for a page go to the check-in (same answer as functions/_middleware.ts). */
const agentGate = (url: URL, cfg: EdgeConfig): Response => {
  const target = new URL('/api/agent-gate', `https://${cfg.publicHost}`);
  target.searchParams.set('from', url.pathname);
  if (url.searchParams.get('via') === 'webdriver') target.searchParams.set('via', 'webdriver');
  const headers = new Headers({
    location: target.toString(),
    'cache-control': 'no-store',
    vary: 'user-agent',
    'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noai, noimageai'
  });
  applySecurityHeaders(headers, url.pathname);
  return new Response(null, { status: 302, headers });
};

const apiUnavailable = (pathname: string): Response => {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' });
  applySecurityHeaders(headers, pathname);
  return new Response(JSON.stringify({ error: { message: 'The DreamStream API is unreachable from the Comic Studio edge. Please retry in a moment.' } }), {
    status: 502,
    headers
  });
};

const forwardHeaders = (request: Request, cfg: EdgeConfig): Headers => {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(name) || name.startsWith('cf-')) return;
    headers.set(name, value);
  });
  headers.set('x-forwarded-host', cfg.publicHost);
  headers.set('x-forwarded-proto', 'https');
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  return headers;
};

/** Methods the Pages origin answers on this host. Nothing there accepts a body (/c and /og are
 *  GET/HEAD-only Functions; the SPA posts only to /api, which never reaches this path). */
const PAGE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PAGE_ALLOW = 'GET, HEAD, OPTIONS';

/** Any other method → 405 WITHOUT reading the body (an unsized upload is never buffered). */
const methodNotAllowed = (pathname: string): Response => {
  const headers = new Headers({ allow: PAGE_ALLOW, 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
  applySecurityHeaders(headers, pathname);
  return new Response('Method not allowed', { status: 405, headers });
};

const proxyToPages = async (request: Request, url: URL, cfg: EdgeConfig, deps: EdgeDeps): Promise<Response> => {
  const method = request.method.toUpperCase();
  if (!PAGE_METHODS.has(method)) return methodNotAllowed(url.pathname);
  let upstream: Response;
  try {
    // Never a body: page requests carry none, and a body sent anyway is not read or forwarded.
    upstream = await deps.fetch(`${cfg.pagesOrigin}${pathAndQuery(url)}`, {
      method,
      headers: forwardHeaders(request, cfg),
      redirect: 'manual'
    });
  } catch {
    return unavailable(url.pathname, cfg);
  }

  // A missing hashed chunk must fail as a real 404, not as the SPA's index.html with status 200
  // (which the browser would refuse as a script and the edge would otherwise cache for a year).
  if (url.pathname.startsWith('/assets/') && upstream.status === 200 && isHtmlResponse(upstream.headers)) {
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    applySecurityHeaders(headers, url.pathname);
    return new Response('Not found', { status: 404, headers });
  }

  let response = new Response(upstream.body, upstream);
  const location = response.headers.get('location');
  if (location) response.headers.set('location', rewriteLocation(location, cfg));
  applyCacheHeaders(response.headers, url.pathname, response.status);

  const brand =
    deps.HTMLRewriter &&
    method === 'GET' &&
    response.status === 200 &&
    response.body &&
    isHtmlResponse(response.headers) &&
    shouldBrandHtml(url);
  if (brand && deps.HTMLRewriter) {
    // The branded bytes differ from the Pages origin's, so its validators no longer describe them.
    response.headers.delete('etag');
    response.headers.delete('last-modified');
    response = brandHtml(response, cfg, deps.HTMLRewriter);
  }
  return finish(response, url.pathname);
};

/** The edge handler, with its outbound dependencies injected (tests pass fakes). */
export const createEdge = (deps: EdgeDeps) => ({
  async fetch(request: Request, env: Env): Promise<Response> {
    const cfg = resolveConfig(env);
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    if (url.pathname === HEALTH_PATH) return health(cfg, env, url.pathname);

    if (url.protocol === 'http:') {
      const target = host === cfg.publicHost || ALIAS_HOSTS.includes(host) ? cfg.publicHost : host;
      return redirect(`https://${target}${pathAndQuery(url)}`, 301, url.pathname);
    }
    if (host !== cfg.publicHost) {
      const status = ALIAS_HOSTS.includes(host) ? 301 : 302;
      return redirect(`https://${cfg.publicHost}${pathAndQuery(url)}`, status, url.pathname);
    }

    if (isApiPath(url.pathname)) {
      if (!env.API) return apiUnavailable(url.pathname);
      try {
        return finish(await env.API.fetch(request), url.pathname);
      } catch {
        return apiUnavailable(url.pathname);
      }
    }

    if (isMainProductPath(url.pathname)) return redirect(`${cfg.mainOrigin}${pathAndQuery(url)}`, 302, url.pathname);

    // The Pages middleware cannot see the visitor's verified-bot category through this proxy
    // (its request.cf describes the edge's subrequest), so the page gate runs here first.
    if (shouldGatePage(url.pathname) && detectAgent(request, 'page')) return agentGate(url, cfg);

    return proxyToPages(request, url, cfg, deps);
  }
});

const runtimeRewriter = (): RewriterCtor | undefined =>
  (globalThis as unknown as { HTMLRewriter?: RewriterCtor }).HTMLRewriter;

let edge: ReturnType<typeof createEdge> | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    edge ??= createEdge({ fetch: (url, init) => fetch(url, init), HTMLRewriter: runtimeRewriter() });
    return edge.fetch(request, env);
  }
};
