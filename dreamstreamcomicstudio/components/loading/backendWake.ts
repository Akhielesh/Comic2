/**
 * "Is the studio server still waking up?" — derived from the boot status probe App already sends
 * (checkSystemStatus → GET /api/system/status, once per page load). No request of its own, no timer
 * that touches the network: the backend container sleeps after 15 idle minutes (CLAUDE.md "Keep it
 * sleepable"), and the first request after that waits while it starts. When that one probe has been
 * pending for WAKE_HINT_AFTER_MS, the loaders say so calmly ("Waking up the studio…"); once it answers,
 * with any result, the hint goes away. It never claims an outage: an error answer settles it too, and
 * the features that need the server keep their own error states.
 *
 *   idle      no probe was sent (a /c/<slug> share link never sends one)
 *   checking  sent, not yet slow
 *   slow      still pending after WAKE_HINT_AFTER_MS: the container is starting
 *   settled   answered (or failed)
 */
import { useSyncExternalStore } from 'react';

export type BackendWake = 'idle' | 'checking' | 'slow' | 'settled';

/** A warm container answers the status probe in well under a second; a cold start takes several. */
export const WAKE_HINT_AFTER_MS = 2500;

let state: BackendWake = 'idle';
let generation = 0;
let slowTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const set = (next: BackendWake) => {
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
};

export const getBackendWake = (): BackendWake => state;

export const subscribeBackendWake = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Follow a status probe. Returns the same promise, so the caller's own .then / .catch are unchanged.
 * A newer probe replaces an older one (only the latest can settle the state).
 */
export function trackBackendWake<T>(probe: Promise<T>, opts: { slowAfterMs?: number } = {}): Promise<T> {
  const mine = ++generation;
  if (slowTimer) clearTimeout(slowTimer);
  set('checking');
  slowTimer = setTimeout(() => {
    slowTimer = null;
    if (mine === generation && state === 'checking') set('slow');
  }, opts.slowAfterMs ?? WAKE_HINT_AFTER_MS);
  const settle = () => {
    if (mine !== generation) return;
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = null;
    set('settled');
  };
  probe.then(settle, settle);
  return probe;
}

/** The current wake state, re-rendering when it changes. */
export function useBackendWake(): BackendWake {
  return useSyncExternalStore(subscribeBackendWake, getBackendWake, getBackendWake);
}

/** Tests only: back to "no probe sent". */
export function resetBackendWakeForTests(): void {
  generation += 1;
  if (slowTimer) clearTimeout(slowTimer);
  slowTimer = null;
  state = 'idle';
  listeners.forEach((listener) => listener());
}
