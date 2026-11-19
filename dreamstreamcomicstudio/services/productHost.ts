// Which DreamStream product a hostname belongs to, and canonical URLs per product.
// Comic Studio lives on its own subdomain (comics.dreamstreamstudio.ai, like Atlas);
// `comic.` is an alias the edge Worker redirects to the canonical host. Everything here
// is SSR-safe: with no `window` the helpers fall back to the production origins.

export const COMICS_HOST = 'comics.dreamstreamstudio.ai';
export const COMICS_ALIAS_HOSTS: readonly string[] = ['comic.dreamstreamstudio.ai'];
export const COMICS_ORIGIN = `https://${COMICS_HOST}`;
export const MAIN_ORIGIN = 'https://dreamstreamstudio.ai';

// Read through globalThis rather than the DOM `window` global: this module is also bundled into the
// api-proxy and comics-edge Workers, whose strict typecheck (workers-types, no DOM lib) has no
// `window`. Same behaviour: no window ⇒ '' (SSR, Node, Workers); otherwise its location's hostname.
type HostWindow = { location?: { hostname?: string } };
const currentHostname = (): string => {
  const win = (globalThis as { window?: HostWindow }).window;
  return typeof win === 'undefined' ? '' : String(win.location?.hostname || '');
};

const normalizeHost = (hostname: string): string => hostname.trim().toLowerCase().replace(/\.$/, '');

/** True on the Comic Studio host (or its alias). */
export const isComicsHost = (hostname: string = currentHostname()): boolean => {
  const host = normalizeHost(hostname);
  return host === COMICS_HOST || COMICS_ALIAS_HOSTS.includes(host);
};

/**
 * Design skins (docs/design/atlas-skin.md): a `data-ds-skin` value that selects one block of
 * `--ds-*` token overrides in index.css. Comic Studio renders in the Atlas language; a "fun" skin
 * comes later as a sibling over the same tokens.
 */
export type DsSkin = 'atlas';
export const DS_SKIN_ATTR = 'data-ds-skin';
/** The skin every Comic Studio surface carries on its root (studio, public reader, immersive reader). */
export const COMIC_STUDIO_SKIN: DsSkin = 'atlas';

/**
 * The skin the comics host always runs under: the Atlas skin on the comics host and its alias (home,
 * gallery, sign-in, studio, readers and the /c/<slug> share pages all live there), null elsewhere.
 */
export const comicsSkin = (hostname: string = currentHostname()): DsSkin | null =>
  isComicsHost(hostname) ? COMIC_STUDIO_SKIN : null;

/** The skins a page can ship with on <html> (index.html's static `data-ds-skin`). */
const isDsSkin = (value: string | null | undefined): value is DsSkin => value === COMIC_STUDIO_SKIN;

/**
 * The skin the whole page runs under (bridge D5, "Atlas everywhere"). index.html ships
 * `data-ds-skin="atlas"` on <html> for every host; the build kill switch VITE_DS_SKIN_EVERYWHERE=off strips
 * it (vite.config.ts). So: the comics host is always skinned; elsewhere the page keeps the skin it shipped
 * with (`shipped`, the attribute the HTML arrived with), and with the switch off the apex has none, the old
 * comics-only rule. Pure: the caller reads the attribute (this module also runs in Workers, with no DOM).
 */
export const hostSkin = (hostname: string = currentHostname(), shipped: string | null = null): DsSkin | null =>
  comicsSkin(hostname) ?? (isDsSkin(shipped) ? shipped : null);

const joinPath = (origin: string, path: string): string => {
  const p = String(path || '/');
  return `${origin}${p.startsWith('/') ? p : `/${p}`}`;
};

/** Absolute URL on the Comic Studio host. */
export const comicsUrl = (path = '/'): string => joinPath(COMICS_ORIGIN, path);

/** Absolute URL on the main DreamStream site (other products, account, legal pages). */
export const mainAppUrl = (path = '/'): string => joinPath(MAIN_ORIGIN, path);

const MAIN_HOSTS: readonly string[] = [new URL(MAIN_ORIGIN).hostname, `www.${new URL(MAIN_ORIGIN).hostname}`];

/** True on the production main site (dreamstreamstudio.ai / www) — not on localhost or previews. */
export const isMainSiteHost = (hostname: string = currentHostname()): boolean => MAIN_HOSTS.includes(normalizeHost(hostname));

/**
 * Where the main site's "Comic Studio" entries point: the comics host, but only from the production
 * main site (dev servers and preview deploys keep the in-app entry so they never jump to prod).
 * null = use the in-app entry.
 */
export const comicsEntryUrl = (hostname: string = currentHostname()): string | null =>
  isMainSiteHost(hostname) ? comicsUrl('/') : null;

/** Canonical public share link for a published comic: https://comics.dreamstreamstudio.ai/c/<slug>. */
export const comicShareUrl = (slug: string): string =>
  comicsUrl(`/c/${encodeURIComponent(String(slug || '').trim())}`);

/** The exact auth callback registered in Supabase for the Comic Studio host (no wildcard). */
export const COMICS_AUTH_CALLBACK_URL = comicsUrl('/auth/callback');

/**
 * Where Supabase sends people back after an email link or OAuth.
 * - On the comics host: always its own exact callback, never the apex value from
 *   VITE_AUTH_REDIRECT_URL — sessions are per host, so a sign-in started on comics.* must finish
 *   there (and the comics origin is the one registered in Supabase).
 * - Elsewhere: the explicit env value when set, else `${origin}/auth/callback`.
 * Pure (inputs passed in) so it is testable and SSR-safe.
 */
export const resolveAuthRedirectUrl = ({
  explicit,
  hostname,
  origin
}: {
  explicit?: string | null;
  hostname?: string | null;
  origin?: string | null;
}): string => {
  if (isComicsHost(String(hostname || ''))) return COMICS_AUTH_CALLBACK_URL;
  const configured = String(explicit || '').trim();
  if (configured) return configured;
  return origin ? `${origin}/auth/callback` : '/auth/callback';
};

/* ------------------------------------------------------------------ main front page → comics
 * For now the bare front page of the main site sends visitors to Comic Studio; the rest of the platform
 * keeps working at its own addresses. The Pages middleware (functions/_middleware.ts) applies the rule at
 * the edge; App.tsx only keeps the member hint cookie in step with the session. Docs:
 * docs/infrastructure/main-front-page.md.
 */

/** THE switch. false: the main site's front page is served as before (one change and a deploy; the redirect is never cached). */
export const MAIN_FRONT_PAGE_TO_COMICS = true;

/** Query keys that carry no intent (campaign and click tracking). Only these ride along to the comics host. */
export const FRONT_PAGE_TRACKING_KEYS: ReadonlySet<string> = new Set(['ref', 'fbclid', 'gclid', 'li_fat_id', 'msclkid']);
/** True for a query key that carries no intent (utm_*, or one of FRONT_PAGE_TRACKING_KEYS). */
export const isTrackingKey = (key: string): boolean => /^utm_[a-z0-9_]+$/i.test(key) || FRONT_PAGE_TRACKING_KEYS.has(key);

/**
 * The member hint: a non-secret cookie the main site sets while someone is signed in there. It grants
 * nothing (sessions live in browser storage, which the edge cannot see); it only tells the edge to serve the
 * main front page to that browser instead of sending it to Comic Studio.
 */
export const MEMBER_HINT_COOKIE = 'ds_member';
const MEMBER_HINT_MAX_AGE = 60 * 60 * 24 * 365;

/** The escape hatch: the main front page with ?home=1 is always served (a member with no hint yet signs in there). */
export const FRONT_PAGE_STAY_PARAM = 'home';

/**
 * The main site's own front page, whatever the switch: `https://dreamstreamstudio.ai/?home=1` (plus an optional
 * fragment such as `#home-faq`). Links that mean "the DreamStream home page" use this, never the bare '/', which
 * sends a browser without the member hint to Comic Studio.
 */
export const mainFrontPageUrl = (hash = ''): string => mainAppUrl(`/?${FRONT_PAGE_STAY_PARAM}=1${hash}`);

/** True when a Cookie header carries the member hint (ds_member=1). */
export const hasMemberHint = (cookieHeader: string | null | undefined): boolean =>
  String(cookieHeader || '')
    .split(';')
    .some((part) => part.trim() === `${MEMBER_HINT_COOKIE}=1`);

/**
 * Where a main-site front-page request goes instead, or null to serve it unchanged. Pure. Redirect only when
 * ALL hold: the switch is on; GET or HEAD; host exactly dreamstreamstudio.ai or www.; path exactly "/"; the query
 * is empty or tracking keys only (carried over verbatim); no member hint cookie. Anything else (an auth callback's
 * ?code= / ?token_hash= / ?error=, ?view=, ?invite=, ?home=1, any other path or host) is served as before.
 */
export const frontPageToComicsUrl = (
  request: { url: string; method: string; cookie?: string | null },
  on: boolean = MAIN_FRONT_PAGE_TO_COMICS
): string | null => {
  if (!on) return null;
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!MAIN_HOSTS.includes(normalizeHost(url.hostname))) return null;
  if (url.pathname !== '/') return null;
  for (const key of url.searchParams.keys()) if (!isTrackingKey(key)) return null;
  if (hasMemberHint(request.cookie)) return null;
  return `${COMICS_ORIGIN}/${url.search}`;
};

/**
 * The Set-Cookie value that keeps the member hint in step with the session on the main site: set while signed
 * in, removed when signed out. null off the main site (localhost, previews, the comics host), where it is never written.
 */
export const memberHintCookie = (signedIn: boolean, hostname: string = currentHostname()): string | null => {
  if (!isMainSiteHost(hostname)) return null;
  const attrs = 'Path=/; Secure; SameSite=Lax';
  return signedIn ? `${MEMBER_HINT_COOKIE}=1; ${attrs}; Max-Age=${MEMBER_HINT_MAX_AGE}` : `${MEMBER_HINT_COOKIE}=; ${attrs}; Max-Age=0`;
};

/** Browser side: write the member hint for the current session state. No-op without a document or off the main site. */
export const syncMemberHint = (signedIn: boolean): void => {
  const doc = (globalThis as { document?: { cookie: string } }).document;
  if (!doc) return;
  const value = memberHintCookie(signedIn);
  if (!value) return;
  // Leave an absent hint absent: a signed-out visitor never gets a removal cookie written.
  if (!signedIn && !hasMemberHint(doc.cookie)) return;
  try {
    doc.cookie = value;
  } catch {
    // Cookies blocked: the member lands on Comic Studio and can use /?home=1.
  }
};
