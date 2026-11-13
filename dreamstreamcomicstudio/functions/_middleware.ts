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
 * It also sends the hosts that only redirect (www and the Pages production alias) to the
 * custom domain first, so there is one site and one sign-in. Requests the Comic Studio front
 * door (comics-edge Worker, comics.dreamstreamstudio.ai) proxies to the Pages origin carry
 * X-Forwarded-Host: comics.dreamstreamstudio.ai and are served, not redirected.
 *
 * Legacy reader links (`/?view=read&id=<uuid>`) of PUBLIC published comics get the comic's
 * preview head with canonical /c/<slug> (the anon RPC only answers for public publications,
 * so an id can never reveal an unlisted slug). Everything else passes through untouched.
 *
 * The private voice model's engine, `/ort/<version>/<file>` (services/dictation/ortRuntime.ts), is served through
 * here too: every client gets the file (no agent gate), with its content type and immutable caching, to our own
 * origin only, and a missing one is a plain 404, never the SPA's index.html with a 200 (which poisoned the model
 * cache in F11). Only the pinned version's folder is ever asked of the asset server, and what it answers is checked
 * by its first bytes, not by its label.
 *
 * The chat's Python runtime, `/pyodide/<version>/<file>` (Pyodide; services/pyodideRuntime.ts), is served the same
 * way, by the same code: only the pinned version's files, checked by their first bytes, a 404 for anything else.
 *
 * public/_routes.json keeps this function off every other static asset, so it runs for page loads, the voice
 * engine and the Python runtime. Detection lives in api-proxy/src/agent-gate.ts so the page and API halves never drift.
 */
import { detectAgent } from '../api-proxy/src/agent-gate';
import { injectHead, PROXIED_HOSTS, publicOrigin, renderShareHead, validateShareCardRpc } from './_shared/shareHead';
import { rpc, type SupabaseEnv } from './_shared/supabaseRpc';
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
import {
  ORT_CACHE_CONTROL,
  ORT_RESOURCE_POLICY,
  ORT_RUNTIME_PIN,
  ORT_SNIFF_BYTES,
  isOrtRuntimePath,
  looksLikeOrtRuntimeFile,
  ortContentType,
  parseOrtRuntimePath,
} from '../services/dictation/ortRuntime';
import {
  PYODIDE_FIRST_BYTES,
  PYODIDE_RUNTIME_CACHE_CONTROL,
  PYODIDE_RUNTIME_RESOURCE_POLICY,
  isPyodideRuntimePath,
  looksLikePyodideRuntimeFile,
  pyodideContentType,
  pyodideRuntimeFileAt,
} from '../services/pyodideRuntime';

/** The Pages asset server (`context.env.ASSETS`). */
interface AssetFetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  env?: SupabaseEnv & { ASSETS?: AssetFetcher } & SecurityEnv & CspReportEnv;
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
/** jsPDF + html2canvas: services/legacyPdfLoader.ts injects them on demand (SRI-pinned, PF-1); keep cdnjs while the classic wizard exports PDFs. */
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
/**
 * A shared comic (/c/<slug>, /c/<slug>/embed) is read-only for anyone with the link: it never needs
 * the camera, the microphone, speech recognition, location or screen capture, so all are off. The
 * share Function sets its own block too, but every header except CSP is ours on the way out, so the
 * block has to live here or MAIN_PERMISSIONS_POLICY replaces it.
 */
export const SHARE_PERMISSIONS_POLICY =
  'camera=(), microphone=(), on-device-speech-recognition=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=()';

/** The share reader's paths: /c and everything under it. */
export const isSharePath = (pathname: string): boolean => pathname === '/c' || pathname.startsWith('/c/');

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
 * The Stream Studio alerts bridge (ADR 0006 WS-5; docs/infrastructure/INFRA_MAP.md §2a):
 * public/stream-alerts-bridge.html on the apex, the ONE apex page Stream Studio's own host may
 * frame. Hidden in a frame there, it ends this browser's old dreamstreamstudio.ai/live alert
 * subscription once the new host covers it, and on sign-out (live/monitor/push.ts), so no alert
 * arrives twice. It gets its own enforced policy: its one same-origin script, nothing else, and
 * frame-ancestors = Stream Studio's host only (the main app's Report-Only `frame-ancestors 'self'`
 * would report every load, and block it the day that policy is enforced). It's outside /live on
 * purpose: the apex's /live redirect and frame block never touch it.
 */
export const ALERTS_BRIDGE_PATH = '/stream-alerts-bridge';
/** Exact path: a CSP source with a path that doesn't end in "/" matches only that path. */
const ALERTS_BRIDGE_URL = `${MAIN_ORIGIN}${ALERTS_BRIDGE_PATH}`;

/** The bridge page by either name (Pages answers the .html with a 308 to the pretty one). */
export const isAlertsBridgePath = (pathname: string): boolean => {
  const p = pathname.replace(/\/+$/, '');
  return p === ALERTS_BRIDGE_PATH || p === `${ALERTS_BRIDGE_PATH}.html`;
};

export const ALERTS_BRIDGE_CSP = serialize([
  ['default-src', ["'none'"]],
  ['script-src', ["'self'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
  ['frame-ancestors', [STREAM_ORIGIN]],
  ...reporting,
]);

/** The bridge's response: its own enforced policy instead of the main app's inventory policy. */
function alertsBridgeHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete('content-security-policy-report-only');
  headers.delete('x-frame-options');
  headers.set('content-security-policy', ALERTS_BRIDGE_CSP);
  headers.set('x-robots-tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
 *   frame-src — Turnstile's challenge, and the apex's alerts bridge page (exact path, below).
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
    ['frame-src', [TURNSTILE_ORIGIN, ALERTS_BRIDGE_URL]],
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
    ['connect-src', [...connectSources(input), 'https://thumb.wikimedia.org', 'https://upload.wikimedia.org']],
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
export function documentSecurityHeaders(kind: PageKind, input: PolicyInput & { enforceLive?: boolean; pathname?: string }): Record<string, string> {
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
    headers['Permissions-Policy'] = input.pathname !== undefined && isSharePath(input.pathname) ? SHARE_PERMISSIONS_POLICY : MAIN_PERMISSIONS_POLICY;
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
    ? documentSecurityHeaders(pageKindFor(url), { origin: url.origin, env: opts.env, enforceLive: opts.enforceLive, pathname: url.pathname })
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_ALIASES = new Set(STREAM_ALIAS_HOSTS);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Crawl policy files and the pretty check-in URL stay reachable for every client. */
function isOpenPath(pathname: string): boolean {
  return pathname === '/robots.txt' || pathname === '/llms.txt' || pathname.startsWith('/.well-known/');
}

/** `/?view=read&id=<uuid>` of a PUBLIC publication → the same preview head as /c/<slug>. */
async function legacyReaderHead(request: Request, url: URL, env: SupabaseEnv | undefined, next: () => Promise<Response>): Promise<Response> {
  const id = url.searchParams.get('id') || '';
  const [res, card] = await Promise.all([next(), UUID_RE.test(id) ? rpc<unknown>(env, 'comic_share_card_by_project', { p_project: id.toLowerCase() }) : Promise.resolve(null)]);
  const rpcCard = card && card.ok ? validateShareCardRpc(card.data) : null;
  if (!rpcCard || rpcCard.visibility !== 'public') return res;
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || !type.includes('text/html')) return res;
  const html = injectHead(await res.text(), renderShareHead(rpcCard, { origin: publicOrigin(request, url) }));
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
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
 * Sign-in links land on the live app and on the main app's /auth/callback, and a framed "Finish
 * signing in?" step could hide a disguised Continue button (clickjacking): those pages are never
 * served to a frame. (public/_headers says the same for /auth/callback* and /live* on the apex,
 * but _headers need not apply to a response that passed through this Function — _routes.json
 * routes every page here — so the Function sets them itself.)
 */
const FRAME_BLOCK: Record<string, string> = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

/** A page sign-in links land on, on the main host: /auth/callback (trailing slashes too) or the live app's old addresses. */
function isSignInLandingPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === '/auth/callback' || isLegacyLivePath(pathname);
}

/**
 * `res` never shown in a frame: X-Frame-Options DENY, and frame-ancestors 'none' in its enforced
 * CSP — added to a policy that's already there (never replacing it), or as the whole policy.
 */
function blockFraming(res: Response): Response {
  const csp = res.headers.get('content-security-policy');
  if (!csp) return withHeaders(res, FRAME_BLOCK);
  const policy = /(^|;)\s*frame-ancestors\s/i.test(csp) ? csp : `${csp.replace(/;\s*$/, '')}; frame-ancestors 'none'`;
  return withHeaders(res, { 'x-frame-options': 'DENY', 'content-security-policy': policy });
}

/** `res` with `extra` headers set; everything else about it is kept. */
function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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

/** The answer for anything under /ort/ or /pyodide/ that is not one of the pinned runtime files: plain text, never kept. */
const runtimeNotFound = (): Response =>
  new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

/** The statuses the asset server answers a real file with (a full body, a range, a revalidation). */
const RUNTIME_FILE_STATUSES = new Set([200, 206, 304]);

/** True when the response's body starts at the file's first byte, as plain bytes: a whole body, or a range from 0. */
function carriesFileStart(res: Response): boolean {
  if (!res.body) return false; // HEAD, 304
  const encoding = (res.headers.get('content-encoding') || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') return false; // compressed bytes say nothing about the file's own
  if (res.status === 200) return true;
  return res.status === 206 && /^bytes\s+0-/i.test(res.headers.get('content-range') || '');
}

/** One pinned runtime file, as the Function serves it (the voice engine's and the Python runtime's alike). */
interface CheckedRuntimeFile {
  /**
   * Do these leading bytes belong to the file? `null`: more bytes are needed; `final` says there are no more, and
   * the answer is then yes or no (looksLikeOrtRuntimeFile, looksLikePyodideRuntimeFile).
   */
  looksLike: (head: Uint8Array, final: boolean) => boolean | null;
  /** How many leading bytes `looksLike` needs at most. */
  sniffBytes: number;
  contentType: string;
  cacheControl: string;
  resourcePolicy: string;
}

/**
 * Is this body the runtime file, judged by its first bytes (`file.looksLike`)? The bytes are read from a clone,
 * which is then cancelled, so `res.body` stays whole and keeps streaming natively (no copy of a 24 MB file
 * through this Function). The cancel is not awaited: a clone is one branch of a tee, and by the Streams standard a
 * branch's cancel only settles once the other branch (the body being served) is cancelled too.
 */
async function startsLikeRuntimeFile(file: Pick<CheckedRuntimeFile, 'looksLike' | 'sniffBytes'>, res: Response): Promise<boolean> {
  const reader = res.clone().body?.getReader();
  if (!reader) return false;
  let head = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value?.length) {
        const joined = new Uint8Array(Math.min(head.length + value.length, file.sniffBytes));
        joined.set(head);
        joined.set(value.subarray(0, joined.length - head.length), head.length);
        head = joined;
      }
      const verdict = file.looksLike(head, done);
      if (verdict !== null) return verdict;
    }
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * The asset server's answer for a pinned runtime path, passed on only when it IS the file, with the runtime's
 * headers set here. The one place both runtime folders are served from (serveOrtRuntime, servePyodideRuntime):
 *
 *  - Pages answers a missing file with the SPA's index.html and a 200, which the browser would keep as the runtime
 *    for a year (the F11 failure). So the answer must be a file status, must not be labelled HTML, and, whenever it
 *    carries the start of the file, must start like the file. The label alone is not trusted (a _headers rule can
 *    rewrite it). Anything else is a 404.
 *  - The file goes out to our own origin only: the asset server's `Access-Control-Allow-Origin: *` (it adds one to
 *    every asset) is dropped, since CORP does not stop a CORS request from another site.
 */
async function serveCheckedRuntimeFile(next: () => Promise<Response>, file: CheckedRuntimeFile): Promise<Response> {
  const res = await next();
  const type = res.headers.get('content-type') || '';
  const isFile = RUNTIME_FILE_STATUSES.has(res.status) && !/^\s*text\/html\b/i.test(type) && (!carriesFileStart(res) || (await startsLikeRuntimeFile(file, res)));
  if (!isFile) {
    void res.body?.cancel().catch(() => undefined);
    return runtimeNotFound();
  }
  const headers = new Headers(res.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('access-control-')) headers.delete(name);
  if (res.status !== 304) headers.set('content-type', file.contentType);
  headers.set('cache-control', file.cacheControl);
  headers.set('cross-origin-resource-policy', file.resourcePolicy);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * `/ort/<version>/<file>`, the voice engine: the asset server's file, with the runtime's headers set here, on a file
 * this function has checked. (public/_headers must set none of them for /ort: Pages applies that file to whatever
 * its asset server answers, the SPA fallback included, before `next()` returns.)
 *
 *  - Only the four files of the pinned version (ORT_RUNTIME_PIN) are asked of the asset server. Any other path
 *    under /ort/ is a 404 without asking it: another version (an old tab after a deploy that moved the engine), a
 *    file this build does not ship.
 *  - Pages answers a missing file with the SPA's index.html and a 200, which the browser would keep as the engine
 *    for a year (the F11 failure). So the answer must be a file status, must not be labelled HTML, and, whenever it
 *    carries the start of the file, must start like the file: the WebAssembly magic number, or a module that does
 *    not begin with `<`. The label alone is not trusted (a _headers rule can rewrite it). Anything else is a 404.
 *  - The file goes out to our own origin only: the asset server's `Access-Control-Allow-Origin: *` (it adds one to
 *    every asset) is dropped, since CORP does not stop a CORS request from another site.
 * The checking and the headers are serveCheckedRuntimeFile's, shared with the Python runtime below.
 */
export async function serveOrtRuntime(url: URL, next: () => Promise<Response>): Promise<Response> {
  const hit = parseOrtRuntimePath(url.pathname);
  if (!hit || hit.version !== ORT_RUNTIME_PIN.version) return runtimeNotFound();
  return serveCheckedRuntimeFile(next, {
    looksLike: (head, final) => looksLikeOrtRuntimeFile(hit.file, head, final),
    sniffBytes: ORT_SNIFF_BYTES,
    contentType: ortContentType(hit.file),
    cacheControl: ORT_CACHE_CONTROL,
    resourcePolicy: ORT_RESOURCE_POLICY,
  });
}

/**
 * `/pyodide/<version>/<file>`, the chat's Python runtime (Pyodide; services/pyodideRuntime.ts): served exactly as
 * the voice engine is, by the same code. The owner's rule is that no unpinned third-party script runs in our origin;
 * the playground used to import this runtime from a CDN inside a same-origin worker.
 *
 *  - Only the files of the pinned version (PYODIDE_RUNTIME_PIN) are asked of the asset server. Any other path under
 *    /pyodide/ is a 404 without asking it: another version, a file this build does not ship (one of Pyodide's
 *    optional packages, say), the folder itself.
 *  - What the asset server answers must start with the pinned file's own first bytes (stricter than "not a page":
 *    each file's opening bytes are recorded next to its SHA-256, which the build checks in full).
 *  - Its content type, immutable caching and Cross-Origin-Resource-Policy are set here, and no CORS grant is passed
 *    on. public/_headers must set none of them for /pyodide, and public/_routes.json must not exclude the folder
 *    (tests/edge/pyodideRuntime.test.ts).
 */
export async function servePyodideRuntime(url: URL, next: () => Promise<Response>): Promise<Response> {
  const file = pyodideRuntimeFileAt(url.pathname);
  if (!file) return runtimeNotFound();
  return serveCheckedRuntimeFile(next, {
    looksLike: (head, final) => looksLikePyodideRuntimeFile(file, head, final),
    sniffBytes: PYODIDE_FIRST_BYTES,
    contentType: pyodideContentType(file),
    cacheControl: PYODIDE_RUNTIME_CACHE_CONTROL,
    resourcePolicy: PYODIDE_RUNTIME_RESOURCE_POLICY,
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
    // The Comic Studio front door proxies to the Pages origin (a redirect host): serve it.
    const forwardedHost = (request.headers.get('x-forwarded-host') || '').trim().toLowerCase();
    if (REDIRECT_HOSTS.has(host) && !PROXIED_HOSTS.has(forwardedHost)) {
      // Stream Studio links go straight to its host (one hop, not two).
      if (movedLiveApp) return moved(toStreamUrl(`${url.pathname}${url.search}`), { 'cache-control': 'public, max-age=86400' });
      return moved(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`);
    }
    if (STREAM_ALIASES.has(host)) return moved(`${STREAM_ORIGIN}${url.pathname}${url.search}`);

    // The voice engine is a file for every client, automated browsers included (never the agent gate), and a
    // missing one is a 404, never the SPA's page.
    if (isOrtRuntimePath(url.pathname)) return secured(serveOrtRuntime(url, next));
    // The chat's Python runtime, the same way: a pinned file for every client, or a 404.
    if (isPyodideRuntimePath(url.pathname)) return secured(servePyodideRuntime(url, next));

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
    // Pages sign-in links land on are never shown in a frame: the security headers first, then the
    // frame block merged into whatever policy they set (so an enforced CSP is never replaced).
    if (onStreamHost && isPage && isAppPage(url.pathname)) return blockFraming(await secured(serveLiveApp(request, url, env, next)));
    // A legacy share link (/?view=read&id=…) gets its preview head; it is a main-app page like any other.
    if (isPage && url.pathname === '/' && url.searchParams.get('view') === 'read' && url.searchParams.has('id')) {
      return secured(legacyReaderHead(request, url, env, next));
    }
    if (isPage && isSignInLandingPath(url.pathname)) return blockFraming(await secured(next()));
    if (isPage && isAlertsBridgePath(url.pathname)) return alertsBridgeHeaders(await secured(next()));
    return secured(next());
  };
}

export const onRequest = createOnRequest({ streamHostOn: STREAM_HOST_ON });
