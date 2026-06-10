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

/** Public share URL for an event (viewer / invite link). */
export const viewerUrl = (id: string): string => `${location.origin}${location.pathname}?e=${id}`;

/** Private host URL — keep secret, the k IS the credential. */
export const studioUrl = (id: string, key: string): string => `${location.origin}${location.pathname}?e=${id}&k=${key}`;
