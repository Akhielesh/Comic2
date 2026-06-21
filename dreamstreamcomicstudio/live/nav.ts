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
