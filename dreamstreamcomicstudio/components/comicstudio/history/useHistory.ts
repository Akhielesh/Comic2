// Comic History — the data hooks of the History UI (versions plan §8; package H5).
//
//   useHistory(studio, {open, filter, pageId})   the moment list: loads when the panel opens (never on a timer),
//                                               pages older moments on demand, and folds in the moment the server
//                                               just saved (studio.lastHistoryVersion, the SSE `history` event)
//   useVersionBook(studio, versionId)            one moment's whole book for the read-only reader + its image URLs
//                                               (the moment's own signed map, the live doc's, then a lazy batch;
//                                               reSign() asks again, uncached, once an image's URL has expired)
//   useCompare(studio, a, b, refresh?)           a compare result (version id | 'now' | 'published' | 'alt:<id>');
//                                               a new `refresh` re-reads it (after a piece was taken back)
//   useLatestAiRow(studio, active, refresh?)     the latest AI run of the comic, whatever the list's filter shows
//                                               (the one "Undo the last AI change" reverts, §6.4)
//
// Every request is a read of the owner's own history (free). Failures become calm sentences; nothing retries by
// itself. Requests are aborted when the panel closes or the inputs change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayAssetPaths, type AssetRef } from '../../../shared/comic/doc';
import type { CompareRef, CompareResult, VersionRow } from '../../../shared/comic/history/types';
import type { StudioController } from '../types';
import { historyErrorText, useHistoryApi, type HistoryFilter, type VersionBookResponse } from './historyApi';
import { filterRows, isRemovedLineRow, mergeLiveRow } from './historyModel';

/** The studio controller as History reads it (the live `history` event rides on the full controller). */
export type HistoryStudio = StudioController & { lastHistoryVersion?: VersionRow };

type UrlFor = StudioController['urlFor'];

const pathOf = (asset?: AssetRef | string | null): string | undefined => (typeof asset === 'string' ? asset : asset?.path) || undefined;

export interface HistoryListState {
  rows: VersionRow[];
  loading: boolean;
  /** The first answer (rows or an error) arrived. */
  loaded: boolean;
  /** A calm sentence, or null. */
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  reload(): void;
  /** A signed URL for a thumb path (the list's map, else the live studio's). */
  urlFor: UrlFor;
  /** The line listed (null = "Original"): rows of other lines in it came from versions the creator removed. */
  line: string | null;
  /** "You're here" as the server read it (store.head); undefined when it did not say (historyModel hereRowId). */
  head?: string | null;
}

export function useHistory(studio: HistoryStudio, opts: { open: boolean; filter: HistoryFilter; pageId?: string | null }): HistoryListState {
  const api = useHistoryApi();
  const projectId = studio.doc?.id;
  const { open, filter } = opts;
  const pageId = filter === 'page' ? opts.pageId ?? null : null;
  const [rows, setRows] = useState<VersionRow[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [line, setLine] = useState<string | null>(null);
  const [head, setHead] = useState<string | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    api
      .list(projectId, { filter, ...(pageId ? { pageId } : {}) }, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setRows(res.rows);
        setUrls(res.urls);
        setNext(res.next);
        setLine(res.line ?? null);
        setHead(res.head);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setRows([]);
        setNext(null);
        setHead(undefined);
        setError(historyErrorText(err) || null);
      })
      .finally(() => {
        if (ctrl.signal.aborted) return;
        setLoading(false);
        setLoaded(true);
      });
    return () => ctrl.abort();
  }, [api, open, projectId, filter, pageId, reloadKey]);

  // The moment the server just saved: shown at once (it matches the filter) without another request.
  const live = studio.lastHistoryVersion;
  const liveId = live ? `${live.id}:${live.createdAt}:${live.label}` : '';
  useEffect(() => {
    if (!open || !live) return;
    // A moment saved on the line you're on is where you are now (whatever the filter shows).
    if (!isRemovedLineRow(live, line)) setHead((cur) => (cur === undefined ? cur : live.id));
    if (!filterRows([live], filter, pageId).length) return;
    setRows((cur) => mergeLiveRow(cur, live));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, liveId]);

  const loadMore = useCallback(() => {
    if (!projectId || !next || loadingMore) return;
    setLoadingMore(true);
    const signal = abortRef.current?.signal;
    api
      .list(projectId, { filter, cursor: next, ...(pageId ? { pageId } : {}) }, signal ? { signal } : undefined)
      .then((res) => {
        if (signal?.aborted) return;
        setRows((cur) => [...cur, ...res.rows.filter((r) => !cur.some((c) => c.id === r.id))]);
        setUrls((cur) => ({ ...cur, ...res.urls }));
        setNext(res.next);
      })
      .catch((err) => {
        if (!signal?.aborted) setError(historyErrorText(err) || null);
      })
      .finally(() => setLoadingMore(false));
  }, [api, projectId, next, loadingMore, filter, pageId]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const studioUrlFor = studio.urlFor;
  const urlFor = useCallback<UrlFor>((asset, o) => {
    const p = pathOf(asset);
    return (p && urls[p]) || studioUrlFor(asset, o);
  }, [urls, studioUrlFor]);

  return { rows, loading, loaded, error, hasMore: !!next, loadingMore, loadMore, reload, urlFor, line, ...(head !== undefined ? { head } : {}) };
}

// ── One moment's book ────────────────────────────────────────────────────────

export interface VersionBookState {
  book: VersionBookResponse | null;
  loading: boolean;
  error: string | null;
  urlFor: UrlFor;
  reload(): void;
  /** An image failed to load (its signed URL expired): sign the book's display images again, once each. */
  reSign(): void;
}

interface LazyUrls {
  urlFor: UrlFor;
  /**
   * The signed URLs of `paths` expired (a cached book outlives them): drop them and sign them again with the uncached
   * POST …/urls. Each path is re-signed at most once per moment, so a truly broken image never loops.
   */
  reSign(paths: readonly string[]): void;
}

/** Signs paths of a moment that neither its own map nor the live studio holds, once each, in one batch per tick. */
const useLazyUrls = (projectId: string | undefined, versionId: string | null, base: Record<string, string>, studioUrlFor: UrlFor): LazyUrls => {
  const api = useHistoryApi();
  const [extra, setExtra] = useState<Record<string, string>>({});
  // Paths whose map URL expired: the map's (and the live studio's) URL is not used for them any more.
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set());
  const asked = useRef(new Set<string>());
  const resigned = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  useEffect(() => {
    asked.current = new Set();
    resigned.current = new Set();
    queue.current = [];
    setExtra({});
    setExpired(new Set());
  }, [projectId, versionId]);
  const sign = useCallback(
    (paths: string[]) => {
      if (!paths.length || !projectId || !versionId) return;
      api
        .urls(projectId, versionId, paths)
        .then((got) => setExtra((cur) => ({ ...cur, ...got })))
        .catch(() => undefined); // an unsignable image stays a calm placeholder
    },
    [api, projectId, versionId]
  );
  const flush = useCallback(() => sign(queue.current.splice(0)), [sign]);
  const urlFor = useCallback<UrlFor>(
    (asset, o) => {
      const p = pathOf(asset);
      if (!p) return undefined;
      if (expired.has(p)) return extra[p];
      const own = base[p] || extra[p];
      if (own) return own;
      const live = studioUrlFor(asset, o);
      if (live) return live;
      if (!asked.current.has(p)) {
        asked.current.add(p);
        queue.current.push(p);
        if (queue.current.length === 1) void Promise.resolve().then(flush);
      }
      return undefined;
    },
    [base, extra, expired, studioUrlFor, flush]
  );
  const reSign = useCallback(
    (paths: readonly string[]) => {
      const fresh = [...new Set(paths)].filter((p) => p && !resigned.current.has(p));
      if (!fresh.length) return;
      for (const p of fresh) resigned.current.add(p);
      setExtra((cur) => {
        const next = { ...cur };
        for (const p of fresh) delete next[p];
        return next;
      });
      setExpired((cur) => new Set([...cur, ...fresh]));
      sign(fresh);
    },
    [sign]
  );
  return { urlFor, reSign };
};

export function useVersionBook(studio: HistoryStudio, versionId: string | null): VersionBookState {
  const api = useHistoryApi();
  const projectId = studio.doc?.id;
  const [book, setBook] = useState<VersionBookResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!projectId || !versionId) {
      setBook(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .book(projectId, versionId, { signal: ctrl.signal })
      .then((res) => !ctrl.signal.aborted && setBook(res))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setBook(null);
        setError(historyErrorText(err, "This version can't be opened. Nothing in your comic changed.", 'moment') || null);
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [api, projectId, versionId, key]);
  const base = useMemo(() => book?.urls ?? {}, [book]);
  const lazy = useLazyUrls(projectId, versionId, base, studio.urlFor);
  const lazyReSign = lazy.reSign;
  const reSign = useCallback(() => {
    if (book) lazyReSign(displayAssetPaths(book.doc));
  }, [book, lazyReSign]);
  return { book, loading, error, urlFor: lazy.urlFor, reload: () => setKey((k) => k + 1), reSign };
}

// ── Compare ──────────────────────────────────────────────────────────────────

export interface CompareState {
  result: CompareResult | null;
  loading: boolean;
  error: string | null;
  urlFor: UrlFor;
  reload(): void;
}

export function useCompare(studio: HistoryStudio, a: CompareRef | null, b: CompareRef | null, refresh = 0): CompareState {
  const api = useHistoryApi();
  const projectId = studio.doc?.id;
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (!projectId || !a || !b) {
      setResult(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .compare(projectId, a, b, { signal: ctrl.signal })
      .then((res) => !ctrl.signal.aborted && setResult(res))
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setResult(null);
        setError(historyErrorText(err, "Couldn't compare these versions. Nothing in your comic changed.", 'moment') || null);
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [api, projectId, a, b, key, refresh]);
  const versionId = a && a !== 'now' && a !== 'published' && !a.startsWith('alt:') ? a : result?.a.row?.id ?? null;
  const base = useMemo(() => result?.urls ?? {}, [result]);
  const { urlFor } = useLazyUrls(projectId, versionId, base, studio.urlFor);
  return { result, loading, error, urlFor, reload: () => setKey((k) => k + 1) };
}

// ── The latest AI run (whatever the list's filter shows) ─────────────────────

/** How many newest "AI changes" rows to look through for the latest `ai` run (its before_ai row sits next to it). */
export const LATEST_AI_LOOKUP = 5;

export interface LatestAiState {
  /** The latest `ai` row of the comic, null when there is none (or it can't be read). */
  row: VersionRow | null;
  loading: boolean;
  /** The first answer arrived. */
  loaded: boolean;
  /** A calm sentence, or null. */
  error: string | null;
}

/**
 * The comic's latest AI run, read on its own (filter 'ai'), never from the panel's filtered or paged list: it is the
 * run history_undo_ai reverts (§6.4), so the sheet must preview that one and only that one. Read when `active` turns
 * on and whenever `refresh` changes (a new moment arrived, an action finished).
 */
export function useLatestAiRow(studio: HistoryStudio, active: boolean, refresh: unknown = 0): LatestAiState {
  const api = useHistoryApi();
  const projectId = studio.doc?.id;
  const [state, setState] = useState<LatestAiState>({ row: null, loading: false, loaded: false, error: null });
  useEffect(() => {
    if (!active || !projectId) return;
    const ctrl = new AbortController();
    setState((cur) => ({ ...cur, loading: true, error: null }));
    api
      .list(projectId, { filter: 'ai', limit: LATEST_AI_LOOKUP }, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return;
        // Never a removed version's AI run: it is not the last AI change of the book you're on.
        setState({ row: res.rows.find((r) => r.kind === 'ai' && !isRemovedLineRow(r, res.line ?? null)) ?? null, loading: false, loaded: true, error: null });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setState({ row: null, loading: false, loaded: true, error: historyErrorText(err) || null });
      });
    return () => ctrl.abort();
  }, [api, active, projectId, refresh]);
  return state;
}
