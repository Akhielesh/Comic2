// Platform library index for the client (assets.md §12; owner P1-LIBRARY).
//
// One fetch per page load (module-level single flight) of GET /api/comic/public/library — a
// public, cacheable endpoint (no auth, no keys, no cookies) — remembered in sessionStorage for
// five minutes so navigation is instant, and revalidated once in the background when stale.
// Never on a timer, never throws: any failure is status 'unavailable' and every consumer keeps
// rendering its procedural art (the same path as "nothing published yet").

import { useEffect, useMemo, useState } from 'react';
import {
  LIBRARY_ID_RE,
  LIBRARY_MANIFEST_VERSION,
  libraryEmptyIds,
  stylePreviewId,
  type LibraryAssetPublic,
  type LibraryIndex,
  type LibraryKind
} from '../../../shared/comic/library';
import { buildApiUrl } from '../../../services/clientConfig';

export interface ComicLibrary {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  get(id: string): LibraryAssetPublic | undefined;
  byKind(kind: LibraryKind, filter?: { theme?: 'light' | 'dark'; presetId?: string; genre?: string }): LibraryAssetPublic[];
  /** style.<presetId> */
  preview(presetId: string): LibraryAssetPublic | undefined;
  /** dark → light fallback */
  empty(variant: string, theme: 'light' | 'dark'): LibraryAssetPublic | undefined;
}

export const LIBRARY_PATH = '/api/comic/public/library';
export const LIBRARY_CACHE_KEY = 'ds.comic.library.v1';
export const LIBRARY_FRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8000;

type Status = ComicLibrary['status'];
interface Snapshot {
  status: Status;
  index?: LibraryIndex;
  byId: Map<string, LibraryAssetPublic>;
}

/** https anywhere; plain http only for a local Supabase in development. */
const HTTPS_URL = /^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)[^\s"'<>]+$/i;
const safeUrl = (u: unknown): string | undefined => (typeof u === 'string' && HTTPS_URL.test(u) && u.length < 2048 ? u : undefined);

/** Keep only well-formed assets with https URLs (the index is data, never trusted markup). */
export function sanitizeIndex(raw: unknown): LibraryIndex | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<LibraryIndex>;
  if (!Array.isArray(o.assets)) return undefined;
  const assets: LibraryAssetPublic[] = [];
  for (const a of o.assets.slice(0, 500)) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !LIBRARY_ID_RE.test(a.id)) continue;
    const url = safeUrl(a.url);
    if (!url) continue;
    const w = Number(a.w);
    const h = Number(a.h);
    assets.push({
      ...a,
      url,
      w: Number.isFinite(w) && w > 0 ? w : 0,
      h: Number.isFinite(h) && h > 0 ? h : 0,
      thumbs: { ...(safeUrl(a.thumbs?.[320]) ? { 320: safeUrl(a.thumbs?.[320]) } : {}), ...(safeUrl(a.thumbs?.[640]) ? { 640: safeUrl(a.thumbs?.[640]) } : {}) },
      alt: typeof a.alt === 'string' ? a.alt.slice(0, 200) : '',
      tags: Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === 'string').slice(0, 16) : [],
      palette: Array.isArray(a.palette) ? a.palette.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 8) : []
    });
  }
  return { manifestVersion: Number(o.manifestVersion) || LIBRARY_MANIFEST_VERSION, generatedAt: Number(o.generatedAt) || 0, assets };
}

const snapshotOf = (status: Status, index?: LibraryIndex): Snapshot => ({ status, index, byId: new Map((index?.assets || []).map((a) => [a.id, a])) });

let current: Snapshot = snapshotOf('idle');
let inflight: Promise<void> | null = null;
let revalidated = false;
const listeners = new Set<(s: Snapshot) => void>();
const publish = (s: Snapshot) => {
  current = s;
  listeners.forEach((l) => l(s));
};

const readCache = (): { at: number; index: LibraryIndex } | undefined => {
  try {
    const raw = window.sessionStorage.getItem(LIBRARY_CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at?: number; index?: unknown };
    const index = sanitizeIndex(parsed.index);
    return index && typeof parsed.at === 'number' ? { at: parsed.at, index } : undefined;
  } catch {
    return undefined;
  }
};

const writeCache = (index: LibraryIndex) => {
  try {
    window.sessionStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ at: Date.now(), index }));
  } catch {
    /* private mode / quota: the in-memory snapshot still works */
  }
};

async function fetchIndex(): Promise<LibraryIndex> {
  if (typeof fetch !== 'function') throw new Error('no fetch');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : undefined;
  try {
    const res = await fetch(buildApiUrl(LIBRARY_PATH), { credentials: 'omit', signal: ctrl?.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`library ${res.status}`);
    const index = sanitizeIndex(await res.json());
    if (!index) throw new Error('library: bad index');
    return index;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Load once per page (cached snapshot first, network revalidation when stale). Never rejects. */
export function loadComicLibrary(): Promise<void> {
  if (inflight) return inflight;
  // One network attempt per page load, success or not: after a failure every consumer keeps its
  // procedural art instead of re-asking on each mount (a reload tries again).
  if (revalidated) return Promise.resolve();
  const cached = typeof window !== 'undefined' ? readCache() : undefined;
  if (cached && current.status !== 'ready') publish(snapshotOf('ready', cached.index));
  if (cached && Date.now() - cached.at < LIBRARY_FRESH_MS) {
    revalidated = true;
    return Promise.resolve();
  }
  if (current.status === 'idle') publish(snapshotOf('loading'));
  inflight = fetchIndex()
    .then((index) => {
      writeCache(index);
      publish(snapshotOf('ready', index));
    })
    .catch(() => {
      // Keep a cached copy when we have one; otherwise fall back to procedural art.
      if (current.status !== 'ready') publish(snapshotOf('unavailable'));
    })
    .finally(() => {
      revalidated = true;
      inflight = null;
    });
  return inflight;
}

/** Test hook: forget everything (snapshot, single flight, session cache). */
export function __resetComicLibraryForTests(): void {
  current = snapshotOf('idle');
  inflight = null;
  revalidated = false;
  listeners.clear();
  try {
    window.sessionStorage.removeItem(LIBRARY_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Read-only API over one snapshot (pure; exported for tests and non-React callers). */
export function libraryApi(s: Snapshot): ComicLibrary {
  const all = s.index?.assets || [];
  return {
    status: s.status,
    get: (id) => s.byId.get(id),
    byKind: (kind, filter) =>
      all.filter(
        (a) =>
          a.kind === kind &&
          (!filter?.theme || a.theme === 'any' || a.theme === filter.theme) &&
          (!filter?.presetId || a.presetId === filter.presetId) &&
          (!filter?.genre || a.genre === filter.genre)
      ),
    preview: (presetId) => s.byId.get(stylePreviewId(presetId)),
    empty: (variant, theme) => {
      for (const id of libraryEmptyIds(variant, theme)) {
        const a = s.byId.get(id);
        if (a) return a;
      }
      return undefined;
    }
  };
}

export function useComicLibrary(): ComicLibrary {
  const [snap, setSnap] = useState<Snapshot>(current);
  useEffect(() => {
    listeners.add(setSnap);
    if (current !== snap) setSnap(current);
    void loadComicLibrary();
    return () => {
      listeners.delete(setSnap);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return useMemo(() => libraryApi(snap), [snap]);
}

export default useComicLibrary;
