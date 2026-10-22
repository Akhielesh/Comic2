/**
 * Cloudflare Pages middleware for dreamstreamstudio.ai — host routing and the page half of
 * the AI-agent gate.
 *
 * Hosts (one site per app, one sign-in per site — sessions live in localStorage, per host):
 *   - www.dreamstreamstudio.ai and comic2.pages.dev only redirect to the custom domain.
 *   - stream.dreamstreamstudio.ai is Stream Studio's own address: every page there is the
 *     live app (live.html, served through the ASSETS binding — a rewrite, never a redirect),
 *     /live, /live/ and /live.html there 301 to / (one address, query and #fragment kept), and
 *     www.stream redirects to it. It serves whether or not the switch below is on, so the host
 *     can be checked before the flip.
 *   - With STREAM_HOST_ON (shared/streamHost.ts), the apex's /live, /live/ and /live.html 301
 *     to the Stream Studio host. Nothing else moves: /live-api/*, /api/* (Worker routes),
 *     /assets/*, /live-sw.js and the manifest stay on the apex for installed apps, old service
 *     workers and open tabs.
 *
 * AI agents (and automated browsers) asking for a page are redirected to the check-in at
 * /api/agent-gate on the same host, which the dreamstream-api Worker answers at the edge
 * (questionnaire, synthetic sample record, logging). Everyone else — people, search engines,
 * link-preview bots, plain HTTP clients like the ops smoke scripts — gets the app as before.
 *
 * public/_routes.json keeps this function off static assets, so it only runs for page loads.
 * Detection lives in api-proxy/src/agent-gate.ts so the page and API halves never drift.
 */
import { detectAgent } from '../api-proxy/src/agent-gate';
import {
  MAIN_HOSTNAME,
  STREAM_ALIAS_HOSTS,
  STREAM_HOST_ON,
  STREAM_ORIGIN,
  isLegacyLivePath,
  isStreamHost,
  toStreamUrl,
} from '../shared/streamHost';

/** The Pages asset server (`context.env.ASSETS`). */
interface AssetFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  env?: { ASSETS?: AssetFetcher };
}

const CANONICAL_ORIGIN = 'https://dreamstreamstudio.ai';
/** Hosts that only redirect: www and the Pages production alias would each keep a separate
 *  session (localStorage is per host). Exact match, so preview and branch deploys
 *  (<hash>.comic2.pages.dev, <branch>.comic2.pages.dev) keep serving. */
const REDIRECT_HOSTS = new Set(['www.dreamstreamstudio.ai', 'comic2.pages.dev']);
const STREAM_ALIASES = new Set(STREAM_ALIAS_HOSTS);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Crawl policy files and the pretty check-in URL stay reachable for every client. */
function isOpenPath(pathname: string): boolean {
  return pathname === '/robots.txt' || pathname === '/llms.txt' || pathname.startsWith('/.well-known/');
}

/** A page of the app (not an API call, not a file like /favicon.ico or /assets/x.js). */
function isAppPage(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/live-api/') || pathname === '/live-api') return false;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !/\.[A-Za-z0-9]+$/.test(last) || /\.html?$/i.test(last);
}

const moved = (location: string, extra: Record<string, string> = {}) =>
  new Response(null, { status: 301, headers: { location, ...extra } });

/**
 * Serve live.html for a Stream Studio page. Pages' pretty URLs answer /live.html with a 308 to
 * /live, so ask for /live first. A redirect from the asset server is never passed on (that's how
 * a rewrite turns into a loop): try the other name, then fail plainly.
 */
async function serveLiveApp(request: Request, url: URL, env: PagesContext['env'], next: () => Promise<Response>): Promise<Response> {
  const assets = env?.ASSETS;
  if (!assets) return next();
  for (const path of ['/live', '/live.html']) {
    const res = await assets.fetch(new Request(new URL(path, url.origin).toString(), { method: request.method, headers: request.headers }));
    if (!REDIRECT_STATUSES.has(res.status)) return res;
  }
  return new Response('Stream Studio is unavailable right now — please try again in a minute.', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' },
  });
}

export interface MiddlewareOptions {
  /** STREAM_HOST_ON — a parameter so tests can run both sides of the switch. */
  streamHostOn: boolean;
}

export function createOnRequest({ streamHostOn }: MiddlewareOptions) {
  return async ({ request, next, env }: PagesContext): Promise<Response> => {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const isPage = request.method === 'GET' || request.method === 'HEAD';
    const movedLiveApp = streamHostOn && isPage && isLegacyLivePath(url.pathname) && url.searchParams.get('legacy') !== '1';
    // One site, one sign-in. Path and query are kept; browsers re-attach the #fragment
    // (host keys, guest keys, auth tokens) to a fragment-less Location (RFC 9110 §10.2.2).
    if (REDIRECT_HOSTS.has(host)) {
      // Stream Studio links go straight to its host (one hop, not two).
      if (movedLiveApp) return moved(toStreamUrl(`${url.pathname}${url.search}`), { 'cache-control': 'public, max-age=86400' });
      return moved(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`);
    }
    if (STREAM_ALIASES.has(host)) return moved(`${STREAM_ORIGIN}${url.pathname}${url.search}`);

    const onStreamHost = isStreamHost(host);
    if (isPage && isLegacyLivePath(url.pathname)) {
      // Stream Studio's address: /live.html?e=X → https://stream.dreamstreamstudio.ai/?e=X.
      // On the Stream Studio host this lands on / (served below, never redirected — no loop).
      // `?legacy=1` on the apex keeps the old address reachable for anything left in this
      // origin's storage (an unsaved recording, say). Cached for a day, not forever, so the
      // switch can still be turned back.
      if (onStreamHost) return moved(toStreamUrl(`${url.pathname}${url.search}`, url.origin));
      if (movedLiveApp && host === MAIN_HOSTNAME) {
        return moved(toStreamUrl(`${url.pathname}${url.search}`), { 'cache-control': 'public, max-age=86400' });
      }
    }
    if (isOpenPath(url.pathname)) return next();

    const isCheckinAlias = url.pathname === '/agents' || url.pathname === '/agents/';
    const agent = isCheckinAlias ? null : detectAgent(request, 'page');
    if (agent || isCheckinAlias) {
      const target = new URL('/api/agent-gate', url.origin);
      if (!isCheckinAlias) target.searchParams.set('from', url.pathname);
      const via = url.searchParams.get('via');
      if (via === 'webdriver') target.searchParams.set('via', via);
      return new Response(null, {
        status: 302,
        headers: {
          location: target.toString(),
          'cache-control': 'no-store',
          vary: 'user-agent',
          'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noai, noimageai',
        },
      });
    }

    // Stream Studio's host: every page is the live app (its screens are #routes).
    if (onStreamHost && isPage && isAppPage(url.pathname)) return serveLiveApp(request, url, env, next);
    return next();
  };
}

export const onRequest = createOnRequest({ streamHostOn: STREAM_HOST_ON });
