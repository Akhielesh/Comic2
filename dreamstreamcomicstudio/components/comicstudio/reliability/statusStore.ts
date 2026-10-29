// One in-page store for model health (reliability.md §3), shared by every banner, card and dot, so the page
// asks the server once for what several components watch. It holds the last answer per model, remembers the
// earliest evidence of each incident (the banner's "Seen since 16:52": the server's own failure times or the
// public data's time when they are earlier than this page's first look), and folds concurrent requests for the
// same ids into one (single-flight; a failed attempt is not repeated by another poller inside the freshness
// window). It never schedules anything: useModelStatus owns the only timer.

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
/** When this page last ASKED for each id (so a failing fetch isn't repeated by every poller at once). */
const attemptedAt = new Map<string, number>();
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

/**
 * The earliest evidence of the model's current incident (undefined while it is fine or unknown): the server's
 * observed failure time or the public data's time for a route in trouble, else when this page first saw it. It is
 * when the trouble was SEEN, not necessarily when it started (the UI says "Seen since").
 */
export const incidentSince = (modelId: string): number | undefined => incidentStart.get(modelId);

/** The earliest time in one answer that shows the trouble (never later than when this page received it). */
const evidenceAt = (health: ModelHealth, receivedAt: number): number => {
  let at = receivedAt;
  for (const route of health.routes || []) {
    if (!isTrouble(route.state)) continue;
    for (const t of [route.observed?.lastFailureAt, route.source === 'openrouter' ? route.checkedAt : undefined]) {
      if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t < at) at = t;
    }
  }
  return at;
};

/** The last request's failure ("couldn't check"), cleared by the next good answer. */
export const statusError = (): string | null => lastError;

/** Merge server answers into the store (also how tests seed it). */
export const putStatus = (list: readonly ModelHealth[], receivedAt: number = Date.now()): void => {
  for (const health of list) {
    entries.set(health.modelId, { health, receivedAt });
    if (isTrouble(health.state)) {
      const seen = evidenceAt(health, receivedAt);
      const cur = incidentStart.get(health.modelId);
      incidentStart.set(health.modelId, cur === undefined ? seen : Math.min(cur, seen));
    } else {
      incidentStart.delete(health.modelId);
    }
  }
  notify();
};

/**
 * Ask the server for every id older than `maxAgeMs` (default STATUS_FRESH_MS; 0 = always). Requests for the
 * same set share one flight, and an id this page asked for inside `maxAgeMs` is not asked for again (even when
 * that attempt failed), so several pollers make one request. Never throws: a failure is kept in `statusError()`
 * and the old answers stay.
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
  if (maxAge > 0 && stale.every((id) => now - (attemptedAt.get(id) ?? -Infinity) < maxAge)) return Promise.resolve();
  for (const id of stale) attemptedAt.set(id, now);
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
  attemptedAt.clear();
  inflight.clear();
  lastError = null;
  notify();
};
