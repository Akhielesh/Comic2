/** In-app navigation contract — LiveApp owns the URL, views call these. */

export interface Nav {
  dashboard(): void;
  create(): void;
  settings(): void;
  studio(id: string, key: string): void;
  viewer(id: string): void;
  event(id: string): void;
  summary(id: string, key?: string): void;
}

const enc = encodeURIComponent;

export type ParsedPrivateStudioLink = {
  id: string;
  hostKey: string;
};

const hashParams = (hash: string): URLSearchParams => {
  const queryStart = hash.indexOf('?');
  return queryStart === -1 ? new URLSearchParams() : new URLSearchParams(hash.slice(queryStart + 1));
};

/**
 * Extract the event id + private host key from a copied studio/summary URL.
 *
 * New links intentionally keep `k` in the fragment (`?e=ID#/studio?k=KEY`) so
 * the credential is not sent to Pages/Worker logs. Legacy query-string links
 * (`?e=ID&k=KEY`) remain valid for already-copied beta links.
 */
export function parsePrivateStudioLink(raw: string, base?: string): ParsedPrivateStudioLink | null {
  try {
    const fallbackBase = base ?? (typeof location === 'undefined' ? 'https://comic2.pages.dev/live.html' : location.href);
    const url = new URL(raw.trim(), fallbackBase);
    const id = url.searchParams.get('e');
    const key = url.searchParams.get('k') ?? hashParams(url.hash).get('k');
    return id && key ? { id, hostKey: key } : null;
  } catch {
    return null;
  }
}

/** Public share URL for an event (viewer / invite link). */
export const viewerUrl = (id: string): string => `${location.origin}${location.pathname}?e=${enc(id)}`;

/**
 * Private host URL — keep secret, the k IS the credential.
 *
 * Keep capability secrets in the fragment so they are not sent in the initial
 * Pages/Worker HTTP request, CDN logs, or Referer headers. LiveApp still accepts
 * the old query-string form for previously copied links.
 */
export const studioUrl = (id: string, key: string): string =>
  `${location.origin}${location.pathname}?e=${enc(id)}#/studio?k=${enc(key)}`;

/** On-air guest URL — semi-private: anyone holding it takes a guest seat. */
export const guestUrl = (id: string, guestKey: string): string =>
  `${location.origin}${location.pathname}?e=${enc(id)}#/guest?g=${enc(guestKey)}`;
