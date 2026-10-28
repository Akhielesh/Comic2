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
