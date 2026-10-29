// One in-page store for model health (reliability.md §3), shared by every banner, card and dot, so the page
// asks the server once for what several components watch. It holds the last answer per model, remembers when
// THIS page first saw each incident (the banner's "since 16:52" and its per-incident dismiss key), and folds
// concurrent requests for the same ids into one (single-flight). It never schedules anything: useModelStatus
// owns the only timer, and only while something is wrong and the tab is visible.

import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import { fetchModelStatus } from './statusApi';

/** Two components mounting together (or a visibility flip right after a tick) share one answer this fresh. */
export const STATUS_FRESH_MS = 30_000;

export interface StatusEntry {
  health: ModelHealth;
  /** When this page received it (client clock). */
  receivedAt: number;
}

type Fetcher = (ids: readonly string[]) => Promise<ModelHealth[]>;

const entries = new Map<string, StatusEntry>();
const incidentStart = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let fetcher: Fetcher = (ids) => fetchModelStatus(ids);
let lastError: string | null = null;
let version = 0;

/** degraded or down: worth a banner, a poll and a calm card. `unknown` never is (unknown never blocks a run). */
export const isTrouble = (state: HealthState | undefined): boolean => state === 'degraded' || state === 'down';

const notify = () => {
  version += 1;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener's bug never breaks the store */
    }
  }
};

export const subscribeStatus = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Changes whenever any entry changes (for useSyncExternalStore). */
export const statusVersion = (): number => version;

export const readStatus = (modelId: string): StatusEntry | undefined => entries.get(modelId);

/** When this page first saw the model's current incident (undefined while it is fine or unknown). */
export const incidentSince = (modelId: string): number | undefined => incidentStart.get(modelId);

/** The last request's failure ("couldn't check"), cleared by the next good answer. */
export const statusError = (): string | null => lastError;

/** Merge server answers into the store (also how tests seed it). */
export const putStatus = (list: readonly ModelHealth[], receivedAt: number = Date.now()): void => {
  for (const health of list) {
    entries.set(health.modelId, { health, receivedAt });
    if (isTrouble(health.state)) {
      if (!incidentStart.has(health.modelId)) incidentStart.set(health.modelId, receivedAt);
    } else {
      incidentStart.delete(health.modelId);
    }
  }
  notify();
};

/**
 * Ask the server for every id older than `maxAgeMs` (default STATUS_FRESH_MS; 0 = always). Requests for the
 * same set share one flight. Never throws: a failure is kept in `statusError()` and the old answers stay.
 */
export const loadStatus = (ids: readonly string[], opts: { maxAgeMs?: number; now?: number } = {}): Promise<void> => {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? STATUS_FRESH_MS;
  const wanted = [...new Set(ids.filter(Boolean))].sort();
  const stale = wanted.filter((id) => {
    const e = entries.get(id);
    return !e || now - e.receivedAt >= maxAge;
  });
  if (!stale.length) return Promise.resolve();
  const key = stale.join(',');
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = fetcher(stale)
    .then((list) => {
      lastError = null;
      putStatus(list, Date.now());
    })
    .catch((err: unknown) => {
      lastError = (err as Error)?.message || "Couldn't check the model status.";
      notify();
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
};

/** Tests: swap the network call (null restores the real one) and forget everything. */
export const __setStatusFetcherForTests = (fn: Fetcher | null): void => {
  fetcher = fn || ((ids) => fetchModelStatus(ids));
};

export const __resetStatusStore = (): void => {
  entries.clear();
  incidentStart.clear();
  inflight.clear();
  lastError = null;
  notify();
};
