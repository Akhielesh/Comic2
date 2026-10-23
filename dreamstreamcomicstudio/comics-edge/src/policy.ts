/**
 * Pure policy for the Comic Studio front door: which host is canonical, which paths belong to
 * whom, how Location headers map back to the public host, and which security / cache headers
 * every response carries. No Workers globals here, so it typechecks and tests anywhere.
 */

export interface EdgeConfig {
  /** Canonical public host, lower-case (comics.dreamstreamstudio.ai). */
  publicHost: string;
  /** Pages origin the SPA is fetched from (https://comic2.pages.dev). */
  pagesOrigin: string;
  /** Main DreamStream site (https://dreamstreamstudio.ai): other products live there. */
  mainOrigin: string;
}

export const DEFAULT_CONFIG: EdgeConfig = {
  publicHost: 'comics.dreamstreamstudio.ai',
  pagesOrigin: 'https://comic2.pages.dev',
  mainOrigin: 'https://dreamstreamstudio.ai'
};

/** Hosts that permanently redirect to the public host (keep in sync with services/productHost.ts —
 *  a test asserts it). */
export const ALIAS_HOSTS: readonly string[] = ['comic.dreamstreamstudio.ai'];

const httpsOrigin = (raw: string | undefined, fallback: string): string => {
  if (!raw) return fallback;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
};

const hostName = (raw: string | undefined, fallback: string): string => {
  const host = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? host : fallback;
};

/** Worker vars → validated config (a typo falls back to production values, never to "anything"). */
export const resolveConfig = (vars: { PUBLIC_HOST?: string; PAGES_ORIGIN?: string; MAIN_ORIGIN?: string }): EdgeConfig => ({
  publicHost: hostName(vars.PUBLIC_HOST, DEFAULT_CONFIG.publicHost),
  pagesOrigin: httpsOrigin(vars.PAGES_ORIGIN, DEFAULT_CONFIG.pagesOrigin),
  mainOrigin: httpsOrigin(vars.MAIN_ORIGIN, DEFAULT_CONFIG.mainOrigin)
});

// ── Path ownership ─────────────────────────────────────────────────────────────────────

export const HEALTH_PATH = '/__edge/health';

export const isApiPath = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/');

/** Public share pages (`/c/<slug>[/embed|/tail]`): the P1-PUBLISH Pages Function owns their
 *  <head>, CSP and framing, so the edge neither rebrands nor re-frames them. */
export const isSharePath = (pathname: string): boolean => pathname === '/c' || pathname.startsWith('/c/');

/** Routes that other sites may frame: the reader embed. */
export const isEmbedPath = (pathname: string): boolean =>
  pathname === '/embed' || pathname.startsWith('/embed/') || /^\/c\/[^/]+\/embed\/?$/.test(pathname);

/** The other DreamStream products (Stream Studio, Chat's model catalog and chat shares, the retired
 *  Code Studio entry) — they live on the main site, with its own session. */
export const isMainProductPath = (pathname: string): boolean =>
  pathname === '/live' ||
  pathname === '/live.html' ||
  pathname.startsWith('/live/') ||
  pathname === '/studio.html' ||
  pathname === '/models' ||
  pathname === '/models/' ||
  pathname.startsWith('/share/');

/** Crawl-policy files and the check-in alias stay reachable for every client (as in
 *  functions/_middleware.ts, which answers `/agents` itself). */
export const isAgentOpenPath = (pathname: string): boolean =>
  pathname === '/robots.txt' ||
  pathname === '/llms.txt' ||
  pathname.startsWith('/.well-known/') ||
  pathname === '/agents' ||
  pathname === '/agents/';

/** Static files (hashed bundles, icons, manifests, model files, anything with a file extension
 *  other than .html). public/_routes.json keeps the Pages middleware off these, so the edge's
 *  page gate skips them too. SPA routes (`/`, `/auth/callback`, `/c/<slug>`) have no extension. */
export const isStaticFilePath = (pathname: string): boolean => {
  if (pathname.startsWith('/assets/') || pathname.startsWith('/icons/') || pathname.startsWith('/models/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 && last.slice(dot + 1).toLowerCase() !== 'html';
};

/**
 * The page half of the AI-agent gate runs HERE for the comics host: the Pages middleware only sees
 * the edge's subrequest, whose `request.cf` (Cloudflare's verified-bot category) describes this
 * Worker, not the visitor — so the edge checks the original request itself.
 */
export const shouldGatePage = (pathname: string): boolean => !isAgentOpenPath(pathname) && !isStaticFilePath(pathname);

/** The legacy reader link `/?view=read&id=<id>`: the Pages middleware injects that comic's preview
 *  head, which generic branding must not overwrite. */
export const isLegacyReaderLink = (url: URL): boolean =>
  url.pathname === '/' && url.searchParams.get('view') === 'read' && url.searchParams.has('id');

/** HTML the edge rebrands as Comic Studio (everything but share pages and legacy reader heads). */
export const shouldBrandHtml = (url: URL): boolean => !isSharePath(url.pathname) && !isLegacyReaderLink(url);

// ── Redirect targets ───────────────────────────────────────────────────────────────────

export const pathAndQuery = (url: URL): string => `${url.pathname}${url.search}`;

/**
 * Maps a Location header from the Pages origin (or the apex, whose canonical-host redirect is the
 * only other source) back onto the public host, so a proxied redirect never leaks the Pages
 * origin or bounces the visitor to the apex. Relative and third-party Locations pass unchanged;
 * the main site's own products stay on the main site.
 */
export const rewriteLocation = (location: string, cfg: EdgeConfig): string => {
  const raw = location.trim();
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  if (!absolute) return location;
  let target: URL;
  try {
    target = new URL(raw, cfg.pagesOrigin);
  } catch {
    return location;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return location;
  const host = target.hostname.toLowerCase();
  const pagesHost = new URL(cfg.pagesOrigin).hostname;
  const mainHost = new URL(cfg.mainOrigin).hostname;
  const fromPages = host === pagesHost;
  const fromMain = host === mainHost || host === `www.${mainHost}`;
  if (!fromPages && !fromMain) return location;
  if (fromMain && isMainProductPath(target.pathname)) return location;
  return `https://${cfg.publicHost}${target.pathname}${target.search}${target.hash}`;
};

// ── Response headers ───────────────────────────────────────────────────────────────────

/** One year, and deliberately NOT includeSubDomains: other subdomains are separate products. */
export const HSTS_VALUE = 'max-age=31536000';
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';
/** Minimal: the studio composer dictates (microphone, same origin only); nothing else is used. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()';
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

const withFrameAncestorsNone = (csp: string | null): string => {
  if (!csp || !csp.trim()) return "frame-ancestors 'none'";
  if (/(^|;)\s*frame-ancestors\b/i.test(csp)) return csp;
  return `${csp.replace(/;\s*$/, '')}; frame-ancestors 'none'`;
};

/** Security headers for every response the edge answers (redirects and errors included). */
export const applySecurityHeaders = (headers: Headers, pathname: string): void => {
  headers.set('strict-transport-security', HSTS_VALUE);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', REFERRER_POLICY);
  if (!headers.has('permissions-policy')) headers.set('permissions-policy', PERMISSIONS_POLICY);
  // Share pages set their own framing (embed allowed, page same-origin) in the Pages Function.
  if (isSharePath(pathname)) return;
  if (isEmbedPath(pathname)) {
    headers.delete('x-frame-options');
    return;
  }
  headers.set('x-frame-options', 'DENY');
  headers.set('content-security-policy', withFrameAncestorsNone(headers.get('content-security-policy')));
};

export const isHtmlResponse = (headers: Headers): boolean => /\btext\/html\b/i.test(headers.get('content-type') || '');

/** Hashed build assets are cached for a year; HTML always revalidates (deploys show up at once). */
export const applyCacheHeaders = (headers: Headers, pathname: string, status: number): void => {
  if (isSharePath(pathname)) return; // the share Function picks its own caching
  if (isHtmlResponse(headers)) {
    headers.set('cache-control', 'no-cache');
    return;
  }
  if (status === 200 && pathname.startsWith('/assets/')) headers.set('cache-control', IMMUTABLE_CACHE);
};
