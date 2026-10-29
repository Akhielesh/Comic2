// useModelStatus (reliability.md §3): what the banner, the outage card and the health dots read.
//
// Network rules (the container must stay sleepable; CLAUDE.md "nothing calls /api/* on a timer"):
//   - one request when a component starts watching (shared by every component through statusStore);
//   - NO timer while every watched model is ok or unknown — never polls when all is well;
//   - while a watched model is degraded or down AND the tab is visible: one re-check every 60 s, stopping
//     when the tab is hidden, when everything is fine again, or 30 min after the trouble started
//     (`expired`; a manual `refresh()` starts a new 30-min window);
//   - when a hidden tab becomes visible during trouble: one immediate re-check, then every 60 s again.
//
// useAutoRetry is the "wait and retry automatically" runner: an armed intent (retryIntents.ts) re-sends its
// blocked action ONCE, and only while this page is open and visible, as soon as a status received after the
// click says the model is no longer down (exactly when the server's preflight lets the run through).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import type { StudioController } from '../types';
import { claimRetry, retriesVersion, settleRetry, subscribeRetries, waitingRetries } from './retryIntents';
import { STATUS_FRESH_MS, incidentSince, isTrouble, loadStatus, readStatus, statusError, statusVersion, subscribeStatus } from './statusStore';

export const STATUS_POLL_MS = 60_000;
export const STATUS_POLL_MAX_MS = 30 * 60_000;

const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** The model answers again as far as a run is concerned (ok, recovering or no data — never `down`). */
export const isBack = (state: HealthState | undefined): boolean => !!state && state !== 'down';

/** A StudioActOutcome that says the action did not go through (void = an older controller: assume it did). */
const refused = (result: unknown): boolean => !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Tracks document visibility (true outside a browser). */
export const usePageVisible = (): boolean => {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const on = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
};

export interface ModelStatusView {
  /** Latest answer per watched id (undefined until the first answer, or for an id the server doesn't know). */
  byId: Record<string, ModelHealth | undefined>;
  /** When this page received each answer. */
  receivedAt: Record<string, number | undefined>;
  /** When this page first saw each id's current incident. */
  since: Record<string, number | undefined>;
  /** The watched model in the worst state (down before degraded), when any is in trouble. */
  worst?: ModelHealth;
  /** No answer yet for at least one watched id. */
  loading: boolean;
  /** The last request failed (old answers stay). */
  error: string | null;
  /** A re-check timer is armed right now. */
  watching: boolean;
  /** Trouble lasted 30 min, so re-checks stopped until `refresh()`. */
  expired: boolean;
  /** Check now (and start a new 30-min window). */
  refresh(): void;
}

const sortedIds = (modelIds: readonly (string | null | undefined)[]): string[] =>
  [...new Set(modelIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].sort();

export interface ModelStatusOptions {
  /** false: no request at all (default true). */
  enabled?: boolean;
  /** false: read once, never re-check on a timer (side data such as switch candidates). Default true. */
  poll?: boolean;
}

export function useModelStatus(modelIds: readonly (string | null | undefined)[], opts: ModelStatusOptions = {}): ModelStatusView {
  const key = sortedIds(modelIds).join(',');
  const ids = useMemo(() => (key ? key.split(',') : []), [key]);
  useSyncExternalStore(subscribeStatus, statusVersion, statusVersion);
  const visible = usePageVisible();
  const enabled = opts.enabled !== false && ids.length > 0;

  const trouble = enabled && opts.poll !== false && ids.some((id) => isTrouble(readStatus(id)?.health.state));
  const [watchStart, setWatchStart] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const wasHidden = useRef(!visible);

  // The first read: one request (shared), nothing more while everything is fine.
  useEffect(() => {
    if (enabled) void loadStatus(ids);
  }, [enabled, ids]);

  // The 30-min window starts with the trouble and ends with it.
  useEffect(() => {
    if (!trouble) {
      setWatchStart(null);
      setExpired(false);
      return;
    }
    setWatchStart((cur) => cur ?? Date.now());
  }, [trouble]);

  useEffect(() => {
    if (!visible) wasHidden.current = true;
  }, [visible]);

  // The only timer: during trouble, while visible, inside the window.
  useEffect(() => {
    if (!trouble || expired || !visible || watchStart === null) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overdue = () => Date.now() - watchStart >= STATUS_POLL_MAX_MS;
    const schedule = () => {
      if (cancelled) return;
      if (overdue()) {
        setExpired(true);
        return;
      }
      timer = setTimeout(() => {
        if (cancelled || !isVisible()) return;
        if (overdue()) {
          setExpired(true);
          return;
        }
        void loadStatus(ids, { maxAgeMs: STATUS_FRESH_MS }).finally(schedule);
      }, STATUS_POLL_MS);
    };
    if (wasHidden.current) {
      // Back from a hidden tab: look once now, then keep the 60 s rhythm.
      wasHidden.current = false;
      if (!overdue()) void loadStatus(ids, { maxAgeMs: STATUS_FRESH_MS });
    }
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [trouble, expired, visible, watchStart, ids]);

  const byId: Record<string, ModelHealth | undefined> = {};
  const receivedAt: Record<string, number | undefined> = {};
  const since: Record<string, number | undefined> = {};
  let worst: ModelHealth | undefined;
  let loading = false;
  for (const id of ids) {
    const entry = readStatus(id);
    byId[id] = entry?.health;
    receivedAt[id] = entry?.receivedAt;
    since[id] = incidentSince(id);
    if (!entry) loading = true;
    const h = entry?.health;
    if (h && isTrouble(h.state) && (!worst || RANK[h.state] > RANK[worst.state])) worst = h;
  }

  return {
    byId,
    receivedAt,
    since,
    ...(worst ? { worst } : {}),
    loading: enabled && loading,
    error: statusError(),
    watching: trouble && !expired && visible,
    expired,
    refresh: () => {
      setExpired(false);
      setWatchStart(trouble ? Date.now() : null);
      if (enabled) void loadStatus(ids, { maxAgeMs: 0 });
    }
  };
}

/**
 * Runs armed "wait and retry" intents: each re-sends its blocked action once, only while this page is visible,
 * when a status received AFTER the click says its model is no longer down. Mount once per studio (the banner
 * slot does; outage cards call it too — `claimRetry` makes a double mount harmless).
 */
export function useAutoRetry(studio: Pick<StudioController, 'act'>): void {
  useSyncExternalStore(subscribeRetries, retriesVersion, retriesVersion);
  const statusTick = useSyncExternalStore(subscribeStatus, statusVersion, statusVersion);
  const retryTick = retriesVersion();
  const waiting = waitingRetries();
  // Keep checking the models someone is waiting for (the hook polls only while they are in trouble).
  useModelStatus(waiting.map((i) => i.modelId));
  const visible = usePageVisible();
  const actRef = useRef(studio.act);
  actRef.current = studio.act;

  useEffect(() => {
    if (!visible || !isVisible()) return;
    for (const intent of waitingRetries()) {
      const entry = readStatus(intent.modelId);
      if (!entry || entry.receivedAt <= intent.armedAt || !isBack(entry.health.state)) continue;
      const claimed = claimRetry(intent.cardId);
      if (!claimed) continue;
      Promise.resolve()
        .then(() => actRef.current(claimed.action))
        .then(
          (result) => settleRetry(claimed.cardId, !refused(result)),
          () => settleRetry(claimed.cardId, false)
        );
    }
  }, [statusTick, retryTick, visible]);
}
