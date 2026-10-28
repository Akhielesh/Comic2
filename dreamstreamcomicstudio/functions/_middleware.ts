/**
 * Cloudflare Pages middleware for dreamstreamstudio.ai — host routing, the page half of the
 * AI-agent gate, and the pages' security headers (CSP, HSTS, … — see "security headers" below).
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
  MAIN_ORIGIN,
  STREAM_ALIAS_HOSTS,
  STREAM_HOST_ON,
  STREAM_ORIGIN,
  isLegacyLivePath,
  isStreamHost,
  toStreamUrl,
} from '../shared/streamHost';
import { CSP_REPORT_GROUP, CSP_REPORT_PATH, type CspReportEnv } from './csp-report';

/** The Pages asset server (`context.env.ASSETS`). */
interface AssetFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  env?: { ASSETS?: AssetFetcher } & SecurityEnv & CspReportEnv;
}

/* ===================================================================== security headers
 * ADR 0006, WS-1. Cloudflare does not promise to apply public/_headers to a Function's
 * response, and every page load runs through this middleware (public/_routes.json), so the
 * page headers are set here, on the way out — `set`, so they win over any _headers value that
 * does reach a page through next(). Static files (/assets/*, /live-sw.js, /models/*, …) get
 * their baseline from public/_headers.
 *
 * Two policies:
 *   - Stream Studio (/live, /live/, /live.html and every page on stream.dreamstreamstudio.ai):
 *     a tight CSP derived from what the live bundle actually loads — proven against the BUILT
 *     page by tests/edge/liveCsp.built.test.ts — plus HSTS, nosniff, Referrer-Policy,
 *     Permissions-Policy, COOP, X-Frame-Options and frame-ancestors 'none'.
 *   - Everything else (the comic / chat app): CSP Report-Only. Chat artifacts run in srcdoc
 *     iframes, which inherit the page's CSP, so `/` can't be enforced until the artifact
 *     runner moves to its own sandbox origin (ADR 0006 D6.5). The reports are the inventory.
 */

/**
 * THE switch for Stream Studio's CSP. false: the live policy ships as
 * Content-Security-Policy-Report-Only — violations are counted at /csp-report, nothing is
 * blocked. Flip to true after 48 h of clean reports (ADR 0006 §5 step 4). A baby monitor's
 * alerts, sound model and camera-offline detection must never be the first thing a policy
 * mistake breaks, so the reports come first. Every OTHER header here is enforced from day one.
 */
export const ENFORCE_LIVE = false;

/**
 * SHA-256 of index.html's only inline script (the splash watchdog). tests/edge/
 * securityHeaders.test.ts recomputes it from the source and from dist/index.html and prints
 * the new value when the script changes.
 */
export const INDEX_INLINE_SCRIPT_HASHES: readonly string[] = ["'sha256-6Ch9vOKOxT4wYazcRXiG7XFTwdJEdnb0F8MIhhzagLE='"];

/** The production Supabase project (public: its URL ships in every bundle). */
export const SUPABASE_ORIGIN = 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co';
/** The live Worker's workers.dev address — live/config.ts FALLBACK_PAGES_LIVE_WORKER_BASE (a test keeps them equal). */
export const LIVE_WORKER_DEV_ORIGIN = 'https://dreamstream-live.akhieleshsrirangam.workers.dev';
/** Cloudflare Turnstile: its api.js (script) and its challenge iframe (frame). */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';
/** Google Drive resumable uploads go from the browser straight to Google (live/driveUpload.ts). */
const GOOGLE_APIS = 'https://www.googleapis.com';
/** jsPDF + html2canvas (index.html, SRI-pinned). */
const CDNJS = 'https://cdnjs.cloudflare.com';
/** Embeds the comic / chat app shows (components/chat/videoEmbed.ts, Sandpack). Report-Only there. */
const MAIN_FRAME_ORIGINS = ['https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com', 'https://*.codesandbox.io'];

/** HSTS: two years, every subdomain. `preload` waits for the owner (ADR 0006 owner action #6). */
export const HSTS = 'max-age=63072000; includeSubDomains';
/**
 * Stream Studio's powers, all first-party: camera, microphone, screen share (Stream Studio),
 * wake lock (camera + bedside viewer), full screen, picture-in-picture (viewer). Location,
 * payments and hardware ports are switched off. Motion sensors and autoplay are left at their
 * defaults on purpose — the camera's tamper detection and the alarm sounds rely on them.
 */
export const LIVE_PERMISSIONS_POLICY =
  'camera=(self), microphone=(self), display-capture=(self), screen-wake-lock=(self), fullscreen=(self), picture-in-picture=(self), geolocation=(), payment=(), usb=(), serial=(), hid=()';
/** The comic / chat app: only what it never uses is switched off (it uses mic, location, embeds). */
export const MAIN_PERMISSIONS_POLICY = 'payment=(), usb=(), serial=(), hid=()';

export interface SecurityEnv {
  /** The build's Supabase URL, when the Pages project exposes it to Functions too. */
  VITE_SUPABASE_URL?: string;
  /** An explicit live Worker base (live/config.ts), when one was set for the build. */
  VITE_LIVE_WORKER_URL?: string;
}

/** An https origin from an env value, or null — a malformed value never reaches a header. */
function httpsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** https://host → wss://host (http → ws for local `wrangler pages dev`). */
const socketOrigin = (origin: string) => origin.replace(/^http(s?):/, 'ws$1:');
const uniq = (values: readonly (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];

type Directive = readonly [name: string, sources: readonly string[]];
const serialize = (directives: readonly Directive[]) =>
  directives.map(([name, sources]) => (sources.length ? `${name} ${sources.join(' ')}` : name)).join('; ');
const reporting: readonly Directive[] = [['report-uri', [CSP_REPORT_PATH]], ['report-to', [CSP_REPORT_GROUP]]];

export interface PolicyInput {
  /** The page's own origin (https://dreamstreamstudio.ai, https://stream.…, a preview host). */
  origin: string;
  env?: SecurityEnv;
}

/**
 * Everything a page talks to over fetch / WebSocket: its own host (wss:// spelled out — older
 * Safari doesn't let 'self' cover WebSockets), our two hosts (the Stream Studio host reaches
 * the apex and the other way round), Supabase (REST, auth, realtime) and the live Worker's
 * workers.dev address. Env values from the build are added, never substituted.
 */
function connectSources({ origin, env }: PolicyInput): string[] {
  const own = (() => {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  })();
  const supabase = uniq([SUPABASE_ORIGIN, httpsOrigin(env?.VITE_SUPABASE_URL)]);
  const live = uniq([LIVE_WORKER_DEV_ORIGIN, httpsOrigin(env?.VITE_LIVE_WORKER_URL)]);
  return uniq([
    "'self'",
    own && socketOrigin(own),
    ...[MAIN_ORIGIN, STREAM_ORIGIN].flatMap((o) => [o, socketOrigin(o)]),
    ...supabase.flatMap((o) => [o, socketOrigin(o)]),
    ...live.flatMap((o) => [o, socketOrigin(o)]),
    GOOGLE_APIS,
  ]);
}

/**
 * Stream Studio's policy. Each source is there because the live bundle uses it:
 *   script-src 'wasm-unsafe-eval' — MediaPipe (main thread) compiles WebAssembly;
 *   script-src blob: — the sound engine's and the relay player's AudioWorklets load from blob:
 *     URLs (addModule is governed by script-src), and the alarm path depends on them;
 *   worker-src 'self' blob: — the YAMNet worker, /live-sw.js, the recorder and ticker workers;
 *   img-src / media-src blob: — relay snapshots, MediaSource playback, recordings;
 *   style-src 'unsafe-inline' — style attributes (live.html's body margin) and runtime-injected
 *     styles; a far weaker vector than scripts, and Google Fonts' CSS needs no more than this.
 * No 'unsafe-inline' or 'unsafe-eval' for scripts, no third-party scripts but Turnstile.
 */
export function liveCsp(input: PolicyInput & { enforce?: boolean }): string {
  return serialize([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'", 'blob:', TURNSTILE_ORIGIN]],
    ['worker-src', ["'self'", 'blob:']],
    ['connect-src', connectSources(input)],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['media-src', ["'self'", 'blob:']],
    ['style-src', ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS]],
    ['font-src', ["'self'", 'data:', GOOGLE_FONTS_FILES]],
    ['frame-src', [TURNSTILE_ORIGIN]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    // Ignored (with a console warning) in a Report-Only policy, so only sent when enforcing.
    ...(input.enforce ? ([['upgrade-insecure-requests', []]] as Directive[]) : []),
    ...reporting,
  ]);
}

/**
 * Trusted Types, report-only on Stream Studio (ADR 0006 / security study §4.6): which DOM
 * sinks would need a policy. Never enforced — MediaPipe's script loader assigns script.src.
 */
export const LIVE_TRUSTED_TYPES_REPORT_ONLY = serialize([['require-trusted-types-for', ["'script'"]], ...reporting]);

/** The comic / chat app: Report-Only, an inventory of what enforcing would block. */
export function mainCsp(input: PolicyInput): string {
  return serialize([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...INDEX_INLINE_SCRIPT_HASHES, "'wasm-unsafe-eval'", CDNJS, TURNSTILE_ORIGIN]],
    ['worker-src', ["'self'", 'blob:']],
    ['connect-src', connectSources(input)],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['media-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['style-src', ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS]],
    ['font-src', ["'self'", 'data:', GOOGLE_FONTS_FILES]],
    ['frame-src', ["'self'", TURNSTILE_ORIGIN, ...MAIN_FRAME_ORIGINS]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
    ...reporting,
  ]);
}

export type PageKind = 'live' | 'main';

/** Stream Studio is every page on its own host, and /live, /live/, /live.html on the apex. */
export const pageKindFor = (url: URL): PageKind =>
  isStreamHost(url.hostname) || isLegacyLivePath(url.pathname) ? 'live' : 'main';

/** Headers for an HTML page of `kind`. */
export function documentSecurityHeaders(kind: PageKind, input: PolicyInput & { enforceLive?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseSecurityHeaders(input.origin),
    'Reporting-Endpoints': `${CSP_REPORT_GROUP}="${new URL(CSP_REPORT_PATH, input.origin).toString()}"`,
  };
  if (kind === 'live') {
    const enforce = input.enforceLive ?? ENFORCE_LIVE;
    const policy = liveCsp({ ...input, enforce });
    if (enforce) {
      headers['Content-Security-Policy'] = policy;
      headers['Content-Security-Policy-Report-Only'] = LIVE_TRUSTED_TYPES_REPORT_ONLY;
    } else {
      // Two report-only policies in one header, comma-separated (CSP3 §3.1).
      headers['Content-Security-Policy-Report-Only'] = `${policy}, ${LIVE_TRUSTED_TYPES_REPORT_ONLY}`;
    }
    headers['Referrer-Policy'] = 'strict-origin';
    headers['Permissions-Policy'] = LIVE_PERMISSIONS_POLICY;
    // Keeps the Drive consent popup's opener (it stays in our browsing-context group) while
    // cutting off any page that opened Stream Studio.
    headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
    // frame-ancestors 'none' for browsers that predate it — and it holds during Report-Only.
    headers['X-Frame-Options'] = 'DENY';
  } else {
    headers['Content-Security-Policy-Report-Only'] = mainCsp(input);
    headers['Permissions-Policy'] = MAIN_PERMISSIONS_POLICY;
  }
  return headers;
}

/** What every response the middleware passes on carries (pages, robots.txt, security.txt, 204s). */
export function baseSecurityHeaders(origin: string): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  if (origin.startsWith('https:')) headers['Strict-Transport-Security'] = HSTS;
  return headers;
}

/** An HTML page (or a 304 for one: no content type, page-shaped path). */
function isDocument(res: Response, pathname: string): boolean {
  const type = res.headers.get('content-type');
  if (type) return /^text\/html\b/i.test(type.trim());
  return isAppPage(pathname);
}

/**
 * Put the security headers on a response on its way out. A Content-Security-Policy a route
 * set for itself is kept (it knows its page better); every other header is ours.
 */
export function withSecurityHeaders(res: Response, url: URL, opts: { env?: SecurityEnv; enforceLive?: boolean } = {}): Response {
  const headers = isDocument(res, url.pathname)
    ? documentSecurityHeaders(pageKindFor(url), { origin: url.origin, env: opts.env, enforceLive: opts.enforceLive })
    : baseSecurityHeaders(url.origin);
  let out: Response;
  try {
    out = new Response(res.body, res);
  } catch {
    return res; // an exotic response we can't rebuild: pass it on untouched rather than fail the page
  }
  for (const [name, value] of Object.entries(headers)) {
    if (/^content-security-policy/i.test(name) && out.headers.has(name)) continue;
    out.headers.set(name, value);
  }
  return out;
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
  /** ENFORCE_LIVE — likewise, so tests can check the enforced policy before the flip. */
  enforceLive?: boolean;
}

export function createOnRequest({ streamHostOn, enforceLive = ENFORCE_LIVE }: MiddlewareOptions) {
  return async ({ request, next, env }: PagesContext): Promise<Response> => {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // Everything this middleware passes ON gets the security headers. The responses it makes
    // itself (host redirects, the agent check-in) are left exactly as they were.
    const secured = async (pending: Promise<Response> | Response) =>
      withSecurityHeaders(await pending, url, { env, enforceLive });
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
    // CSP reports come from every browser, automated ones included: never send them to the gate.
    if (url.pathname === CSP_REPORT_PATH) return secured(next());
    if (isOpenPath(url.pathname)) return secured(next());

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
    if (onStreamHost && isPage && isAppPage(url.pathname)) return secured(serveLiveApp(request, url, env, next));
    return secured(next());
  };
}

export const onRequest = createOnRequest({ streamHostOn: STREAM_HOST_ON });
