// The public share route (sharing.md §7.1): `/c/<slug>`, `/c/<slug>/<title-tail>` and `/c/<slug>/embed`.
// Pure and dependency-free so App.tsx can route on it without pulling the reader bundle.
//
// Any `/c/…` path is the public reader: a malformed or unknown slug still renders the reader's honest
// "This link isn't active" state (never the home page, never a hint that a slug exists).

import { parseReaderParams } from '../immersive/readerUrl';

export interface PublicComicRoute {
  /** The 17-character base62 slug, or '' when the path is malformed (→ "This link isn't active"). */
  slug: string;
  /** `/c/<slug>/embed`: the iframe embed (minimal chrome, "Open on DreamStream"). */
  embed: boolean;
}

export const PUBLIC_COMIC_PATH_RE = /^\/c\/([A-Za-z0-9]{17})(?:\/(embed|[a-z0-9-]{1,80}))?\/?$/;

/** Is this a public share path? (`/c` and `/c/…`) */
export const isPublicComicPath = (pathname: string | null | undefined): boolean => typeof pathname === 'string' && /^\/c(?:\/|$)/.test(pathname);

/** Parse `/c/<slug>[/embed|/<tail>]`; null for any other path. */
export const parsePublicComicPath = (pathname: string | null | undefined): PublicComicRoute | null => {
  if (!isPublicComicPath(pathname)) return null;
  const m = PUBLIC_COMIC_PATH_RE.exec(pathname as string);
  if (!m) return { slug: '', embed: false };
  return { slug: m[1], embed: m[2] === 'embed' };
};

export interface PublicReaderStart {
  /** 1-based page (0 = cover). */
  page?: number;
  guided?: boolean;
  /** 1-based panel (with guided). */
  panel?: number;
}

/** Where the reader starts, from the share link's query (`?p=`, `?guided=1`, `?panel=`). `?lang=` is read by the language hook. */
export const readerStartFromSearch = (search: string | null | undefined): PublicReaderStart => {
  const r = parseReaderParams(search || '');
  return {
    ...(r.p !== undefined ? { page: Math.min(500, r.p) } : {}),
    ...(r.guided ? { guided: true } : {}),
    ...(r.guided && r.panel !== undefined ? { panel: r.panel } : {})
  };
};
