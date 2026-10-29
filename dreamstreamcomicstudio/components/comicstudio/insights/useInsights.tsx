// useInsights: the live data the Insights tabs read (models.md §4.3 catalog rows, §4.4 trends), fetched ON DEMAND.
//
// Network rules (models.md §4.5 cadence rule, AT-8; CLAUDE.md "nothing calls /api/* on a timer"):
//   - a request only when a tab that needs it is opened (the Models tab → catalog, the Trends tab → trends);
//   - one module cache shared by every card on the page: an answer younger than INSIGHTS_FRESH_MS is reused,
//     concurrent asks share one in-flight request (single-flight);
//   - NO timer, interval or timeout anywhere — a stale answer is refreshed the next time someone opens the tab;
//   - a failed refresh keeps the last answer and marks it stale ("as of {time} · couldn't refresh", §4.6); a
//     failure with nothing cached reports the error (the tab then shows the registry's dated facts);
//   - answers belong to the signed-in account ("your calls", your observed costs, this comic's fit): when the
//     account changes (sign-out, sign-in, a switch on the same tab) every held answer is dropped, and a tab that is
//     open asks again for the new account. A token refresh for the same account keeps them.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ModelCatalogRow, ModelTrends, TrendRange } from '../../../shared/comic/modelCatalog';
import { supabase } from '../../../services/supabase';
import { fetchInsightsCatalog, fetchInsightsTrends } from './insightsApi';

/** Reuse an answer this long before asking again (on the next open; never on a timer). */
export const INSIGHTS_FRESH_MS = 5 * 60_000;

export interface Loadable<T> {
  data: T | null;
  /** A request is in flight. */
  loading: boolean;
  /** The last request failed (data, if any, is the previous answer). */
  error: string | null;
  /** Showing a previous answer because the last refresh failed. */
  stale: boolean;
  /** When this page received `data` (ms). */
  fetchedAt: number | null;
  /** Ask again now (a user's "Try again"). */
  refresh(): void;
}

interface Entry {
  data: unknown;
  fetchedAt: number | null;
  error: string | null;
  stale: boolean;
  inflight: Promise<void> | null;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
/** Bumped whenever the cache is dropped: a mounted tab then asks again (its effect depends on it). */
let generation = 0;

const emit = () => {
  version += 1;
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => version;

const entryOf = (key: string): Entry => {
  let e = cache.get(key);
  if (!e) {
    e = { data: null, fetchedAt: null, error: null, stale: false, inflight: null };
    cache.set(key, e);
  }
  return e;
};

const messageOf = (err: unknown): string =>
  err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string' && (err as { message: string }).message
    ? (err as { message: string }).message
    : 'Couldn’t load this right now.';

/** Start a request for `key` unless one is in flight or a fresh answer is held (force: a user's retry). */
export const loadInsights = (key: string, fetcher: () => Promise<unknown>, force = false): Promise<void> => {
  const e = entryOf(key);
  if (e.inflight) return e.inflight;
  const fresh = e.data !== null && e.fetchedAt !== null && Date.now() - e.fetchedAt < INSIGHTS_FRESH_MS && !e.stale && !e.error;
  if (fresh && !force) return Promise.resolve();
  e.inflight = fetcher()
    .then((data) => {
      e.data = data;
      e.fetchedAt = Date.now();
      e.error = null;
      e.stale = false;
    })
    .catch((err) => {
      e.error = messageOf(err);
      e.stale = e.data !== null;
    })
    .finally(() => {
      e.inflight = null;
      emit();
    });
  emit();
  return e.inflight;
};

const dropAll = (): void => {
  cache.clear();
  generation += 1;
  emit();
};

let signedInAs: string | null | undefined;

/**
 * The account auth reports for this tab (null when signed out). A different account than the last one drops every
 * held answer — a second account signing in on the same tab never sees the first one's calls or costs.
 */
export const noteInsightsUser = (userId: string | null): void => {
  if (signedInAs !== undefined && userId !== signedInAs) dropAll();
  signedInAs = userId;
};

// Like services/productAccess.ts: follow the auth state for the page's life. INITIAL_SESSION / SIGNED_IN /
// SIGNED_OUT / USER_UPDATED with another user drop the cache; TOKEN_REFRESHED for the same user changes nothing.
try {
  supabase.auth.onAuthStateChange((_event, session) => noteInsightsUser(session?.user?.id ?? null));
} catch {
  // No auth client in this environment: nothing to scope by.
}

/** Tests: forget every answer. */
export const __resetInsightsCacheForTests = (): void => {
  dropAll();
};

const useResource = <T,>(key: string | null, fetcher: () => Promise<T>, enabled: boolean): Loadable<T> => {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const gen = generation;
  useEffect(() => {
    if (enabled && key) void loadInsights(key, fetcher);
    // The fetcher is derived from the key; asking again only when the key or `enabled` changes, or when the held
    // answers were dropped (another account signed in) while this tab is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, gen]);
  const refresh = useCallback(() => {
    if (key) void loadInsights(key, fetcher, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const e = key ? cache.get(key) : undefined;
  return {
    data: (e?.data as T | null | undefined) ?? null,
    loading: !!e?.inflight || (enabled && !!key && !e),
    error: e?.error ?? null,
    stale: !!e?.stale,
    fetchedAt: e?.fetchedAt ?? null,
    refresh
  };
};

export const catalogKey = (projectId?: string) => `catalog:${projectId ?? ''}`;
export const trendsKey = (range: TrendRange) => `trends:${range}`;

/** Catalog rows (with this comic's fit) — fetched when `enabled` turns true, then shared. */
export const useInsightsCatalog = (projectId: string | undefined, enabled = true): Loadable<ModelCatalogRow[]> =>
  useResource(catalogKey(projectId), () => fetchInsightsCatalog(projectId), enabled);

/** T2–T7 over 30 or 90 days — fetched when `enabled` turns true, then shared. */
export const useInsightsTrends = (range: TrendRange, enabled = true): Loadable<ModelTrends> =>
  useResource(trendsKey(range), () => fetchInsightsTrends(range), enabled);

/** Catalog rows already held for this comic (no request): the Pages tab prices redraws with them when present. */
export const useHeldCatalog = (projectId: string | undefined): ModelCatalogRow[] | null => {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return (cache.get(catalogKey(projectId))?.data as ModelCatalogRow[] | null | undefined) ?? null;
};
