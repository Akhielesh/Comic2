// Which DreamStream product a hostname belongs to, and canonical URLs per product.
// Comic Studio lives on its own subdomain (comics.dreamstreamstudio.ai, like Atlas);
// `comic.` is an alias the edge Worker redirects to the canonical host. Everything here
// is SSR-safe: with no `window` the helpers fall back to the production origins.

export const COMICS_HOST = 'comics.dreamstreamstudio.ai';
export const COMICS_ALIAS_HOSTS: readonly string[] = ['comic.dreamstreamstudio.ai'];
export const COMICS_ORIGIN = `https://${COMICS_HOST}`;
export const MAIN_ORIGIN = 'https://dreamstreamstudio.ai';

const currentHostname = (): string =>
  typeof window === 'undefined' ? '' : String(window.location?.hostname || '');

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

/** Canonical public share link for a published comic: https://comics.dreamstreamstudio.ai/c/<slug>. */
export const comicShareUrl = (slug: string): string =>
  comicsUrl(`/c/${encodeURIComponent(String(slug || '').trim())}`);
