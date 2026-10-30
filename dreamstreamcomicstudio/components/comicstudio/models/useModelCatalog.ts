// useModelCatalog / useModelDetail: what the picker, its rows and the detail sheet read (models.md §4.3, §4.5).
//
// Network rules (the container must stay sleepable; CLAUDE.md "nothing calls /api/* on a timer"; AT-8):
//   - one request when the picker (or a detail view) OPENS and the cached answer is older than
//     CATALOG_FRESH_MS — never on an interval, never while closed, never because time passed;
//   - requests are shared (single-flight per project / model) and the answer is cached in memory for the page;
//   - a failed request keeps the last good answer (shown with its time); with none, the picker falls back to the
//     registry's dated facts (modelsApi.registryCatalogRows) and says so.
// No timer exists in this module (a test advances fake timers by an hour and sees no request).

import { useEffect, useSyncExternalStore } from 'react';
import type { ModelCatalogDetail, ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { fetchModelCatalog, fetchModelDetail } from './modelsApi';

/** An answer younger than this is reused when the picker opens again. */
export const CATALOG_FRESH_MS = 5 * 60_000;

interface CatalogEntry {
  rows: ModelCatalogRow[];
  at: number;
}
interface DetailEntry {
  detail: ModelCatalogDetail;
  at: number;
}

const catalog = new Map<string, CatalogEntry>();
const details = new Map<string, DetailEntry>();
const errors = new Map<string, string>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

const bump = () => {
  version += 1;
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getVersion = () => version;

type CatalogFetcher = (projectId?: string) => Promise<ModelCatalogRow[]>;
type DetailFetcher = (id: string, projectId?: string) => Promise<ModelCatalogDetail>;
let catalogFetcher: CatalogFetcher = (projectId) => fetchModelCatalog(projectId);
let detailFetcher: DetailFetcher = (id, projectId) => fetchModelDetail(id, projectId);

const catalogKey = (projectId?: string) => `catalog:${projectId || ''}`;
const detailKey = (id: string, projectId?: string) => `detail:${id}:${projectId || ''}`;

const messageOf = (err: unknown) =>
  err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
    ? ((err as { message: string }).message || "Couldn't load live model data right now.")
    : "Couldn't load live model data right now.";

/** Load the catalog unless a fresh answer is cached (single-flight). Never throws. */
export const loadModelCatalog = (projectId?: string, opts: { maxAgeMs?: number } = {}): Promise<void> => {
  const key = catalogKey(projectId);
  const have = catalog.get(key);
  const maxAge = opts.maxAgeMs ?? CATALOG_FRESH_MS;
  if (have && Date.now() - have.at < maxAge) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const p = catalogFetcher(projectId)
    .then((rows) => {
      if (rows.length) {
        catalog.set(key, { rows, at: Date.now() });
        errors.delete(key);
      } else {
        errors.set(key, 'The model catalog came back empty.');
      }
    })
    .catch((err) => {
      errors.set(key, messageOf(err));
    })
    .finally(() => {
      inflight.delete(key);
      bump();
    });
  inflight.set(key, p);
  bump();
  return p;
};

/** Load one model's detail unless a fresh answer is cached (single-flight). Never throws. */
export const loadModelDetail = (id: string, projectId?: string, opts: { maxAgeMs?: number } = {}): Promise<void> => {
  const key = detailKey(id, projectId);
  const have = details.get(key);
  if (have && Date.now() - have.at < (opts.maxAgeMs ?? CATALOG_FRESH_MS)) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const p = detailFetcher(id, projectId)
    .then((detail) => {
      details.set(key, { detail, at: Date.now() });
      errors.delete(key);
    })
    .catch((err) => {
      errors.set(key, messageOf(err));
    })
    .finally(() => {
      inflight.delete(key);
      bump();
    });
  inflight.set(key, p);
  bump();
  return p;
};

export interface ModelCatalogView {
  /** The live rows (null until the first answer, or when none could be loaded). */
  rows: ModelCatalogRow[] | null;
  /** When this page received them. */
  loadedAt?: number;
  /** A request is running and there is nothing cached yet. */
  loading: boolean;
  /** The last request failed (a cached answer, if any, stays). */
  error: string | null;
  /** Ask again now (a user's "Try again"). */
  refresh(): void;
}

export function useModelCatalog(projectId: string | undefined, opts: { enabled?: boolean } = {}): ModelCatalogView {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const enabled = opts.enabled !== false;
  useEffect(() => {
    if (enabled) void loadModelCatalog(projectId);
  }, [enabled, projectId]);
  const key = catalogKey(projectId);
  const entry = catalog.get(key);
  return {
    rows: entry?.rows ?? null,
    ...(entry ? { loadedAt: entry.at } : {}),
    loading: enabled && !entry && inflight.has(key),
    error: errors.get(key) ?? null,
    refresh: () => void loadModelCatalog(projectId, { maxAgeMs: 0 })
  };
}

export interface ModelDetailView {
  detail: ModelCatalogDetail | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

export function useModelDetail(id: string | null | undefined, projectId: string | undefined, opts: { enabled?: boolean } = {}): ModelDetailView {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const enabled = opts.enabled !== false && !!id;
  useEffect(() => {
    if (enabled && id) void loadModelDetail(id, projectId);
  }, [enabled, id, projectId]);
  const key = id ? detailKey(id, projectId) : '';
  const entry = id ? details.get(key) : undefined;
  return {
    detail: entry?.detail ?? null,
    loading: enabled && !entry && inflight.has(key),
    error: id ? errors.get(key) ?? null : null,
    refresh: () => {
      if (id) void loadModelDetail(id, projectId, { maxAgeMs: 0 });
    }
  };
}

/** Put known rows in the cache (the QA harness's offline scenes; never used to invent data in the product). */
export const seedModelCatalog = (projectId: string | undefined, rows: ModelCatalogRow[], at = Date.now()): void => {
  catalog.set(catalogKey(projectId), { rows, at });
  errors.delete(catalogKey(projectId));
  bump();
};

/** Tests: forget everything and (optionally) swap the fetchers. */
export const __resetModelCatalogForTests = (fetchers: { catalog?: CatalogFetcher; detail?: DetailFetcher } = {}): void => {
  catalog.clear();
  details.clear();
  errors.clear();
  inflight.clear();
  catalogFetcher = fetchers.catalog ?? ((projectId) => fetchModelCatalog(projectId));
  detailFetcher = fetchers.detail ?? ((id, projectId) => fetchModelDetail(id, projectId));
  bump();
};
