// Comic History — the data hooks of the History UI (versions plan §8; package H5).
//
//   useHistory(studio, {open, filter, pageId})   the moment list: loads when the panel opens (never on a timer),
//                                               pages older moments on demand, and folds in the moment the server
//                                               just saved (studio.lastHistoryVersion, the SSE `history` event)
//   useVersionBook(studio, versionId)            one moment's whole book for the read-only reader + its image URLs
//                                               (the moment's own signed map, the live doc's, then a lazy batch)
//   useCompare(studio, a, b)                     a compare result (version id | 'now' | 'published' | 'alt:<id>')
//
// Every request is a read of the owner's own history (free). Failures become calm sentences; nothing retries by
// itself. Requests are aborted when the panel closes or the inputs change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRef } from '../../../shared/comic/doc';
import type { CompareRef, CompareResult, VersionRow } from '../../../shared/comic/history/types';
import type { StudioController } from '../types';
import { historyErrorText, useHistoryApi, type HistoryFilter, type VersionBookResponse } from './historyApi';
import { filterRows, mergeLiveRow } from './historyModel';

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
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setRows([]);
        setNext(null);
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

  return { rows, loading, loaded, error, hasMore: !!next, loadingMore, loadMore, reload, urlFor };
}

// ── One moment's book ────────────────────────────────────────────────────────

export interface VersionBookState {
  book: VersionBookResponse | null;
  loading: boolean;
  error: string | null;
  urlFor: UrlFor;
  reload(): void;
}

/** Signs paths of a moment that neither its own map nor the live studio holds, once each, in one batch per tick. */
const useLazyUrls = (projectId: string | undefined, versionId: string | null, base: Record<string, string>, studioUrlFor: UrlFor): UrlFor => {
  const api = useHistoryApi();
  const [extra, setExtra] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  useEffect(() => {
    asked.current = new Set();
    queue.current = [];
    setExtra({});
  }, [projectId, versionId]);
  const flush = useCallback(() => {
    const paths = queue.current.splice(0);
    if (!paths.length || !projectId || !versionId) return;
    api
      .urls(projectId, versionId, paths)
      .then((got) => setExtra((cur) => ({ ...cur, ...got })))
      .catch(() => undefined); // an unsignable image stays a calm placeholder
  }, [api, projectId, versionId]);
  return useCallback<UrlFor>(
    (asset, o) => {
      const p = pathOf(asset);
      if (!p) return undefined;
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
    [base, extra, studioUrlFor, flush]
  );
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
        setError(historyErrorText(err, "This version can't be opened. Nothing in your comic changed.") || null);
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [api, projectId, versionId, key]);
  const base = useMemo(() => book?.urls ?? {}, [book]);
  const urlFor = useLazyUrls(projectId, versionId, base, studio.urlFor);
  return { book, loading, error, urlFor, reload: () => setKey((k) => k + 1) };
}

// ── Compare ──────────────────────────────────────────────────────────────────

export interface CompareState {
  result: CompareResult | null;
  loading: boolean;
  error: string | null;
  urlFor: UrlFor;
  reload(): void;
}

export function useCompare(studio: HistoryStudio, a: CompareRef | null, b: CompareRef | null): CompareState {
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
        setError(historyErrorText(err, "Couldn't compare these versions. Nothing in your comic changed.") || null);
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [api, projectId, a, b, key]);
  const versionId = a && a !== 'now' && a !== 'published' && !a.startsWith('alt:') ? a : result?.a.row?.id ?? null;
  const base = useMemo(() => result?.urls ?? {}, [result]);
  const urlFor = useLazyUrls(projectId, versionId, base, studio.urlFor);
  return { result, loading, error, urlFor, reload: () => setKey((k) => k + 1) };
}
