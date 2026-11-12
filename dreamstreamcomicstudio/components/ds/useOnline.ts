/**
 * useOnline — is the app connected? (redesign plan §4 "Hooks and models", §8 "Offline"). Two signals, one answer:
 *
 *   - the browser's own: `navigator.onLine` and the window's `online` / `offline` events (Wi-Fi off, flight mode);
 *   - the app's: a request that never reached the server (services/apiClient.ts reports it to services/appStatus.ts
 *     with `source: 'network'`). The device can be "online" while the server is unreachable (a captive portal, a
 *     dead tunnel); then the app behaves as offline too, so the offline line, the StatusPill and the disabled
 *     "Drawing needs a connection" controls all tell the same story.
 *
 * A network failure holds the app "unreachable" for UNREACHABLE_HOLD_MS, or until the browser says it is back
 * online, or until a caller confirms the server answered (`markReachable`). The hold is one timer, armed only
 * after a failure and cleared when it fires: nothing polls and nothing here ever calls `/api` (CLAUDE.md
 * "Keep it sleepable"). Every component that asks shares one store, so the answer is the same everywhere.
 */
import { useSyncExternalStore } from 'react';
import { appStatus, type StatusSnapshot } from '../../services/appStatus';

/** How long one failed request keeps the app "unreachable" when nothing else says it is back. */
export const UNREACHABLE_HOLD_MS = 30_000;

export type OfflineReason = 'offline' | 'unreachable';

export interface Connectivity {
  online: boolean;
  /** Why the app is offline: the device ('offline') or the server ('unreachable'); null while online. */
  reason: OfflineReason | null;
}

const ONLINE: Connectivity = { online: true, reason: null };
const OFFLINE: Connectivity = { online: false, reason: 'offline' };
const UNREACHABLE: Connectivity = { online: false, reason: 'unreachable' };

const deviceOnline = (): boolean => {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
};

let device = true;
let unreachable = false;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let lastNetworkEventId = 0;
/** The head event's time when last read: a repeat failure coalesces into the same event with a newer time. */
let lastHeadTs = 0;
let current: Connectivity = ONLINE;
const listeners = new Set<() => void>();
let teardown: (() => void) | null = null;

const compute = (): Connectivity => (!device ? OFFLINE : unreachable ? UNREACHABLE : ONLINE);

const emit = () => {
  const next = compute();
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
};

const clearHold = () => {
  if (holdTimer !== undefined) clearTimeout(holdTimer);
  holdTimer = undefined;
};

const holdUnreachable = () => {
  unreachable = true;
  clearHold();
  holdTimer = setTimeout(() => {
    holdTimer = undefined;
    unreachable = false;
    emit();
  }, UNREACHABLE_HOLD_MS);
  // Node (SSR, tests): never keep the process alive for this.
  (holdTimer as { unref?: () => void }).unref?.();
};

/** The newest network failure in the status log that this store has not seen yet. */
const isNetworkFailure = (ev: StatusSnapshot['events'][number]) => ev.source === 'network' && (ev.level === 'error' || ev.level === 'warn');

const freshNetworkFailure = (snap: StatusSnapshot): boolean => {
  let fresh = false;
  const head = snap.events[0];
  // The same failure again within a few seconds is coalesced into the head event: same id, newer time.
  if (head && head.id === lastNetworkEventId && head.ts > lastHeadTs && isNetworkFailure(head)) fresh = true;
  for (const ev of snap.events) {
    if (ev.id <= lastNetworkEventId) break;
    if (isNetworkFailure(ev)) fresh = true;
  }
  if (head) {
    lastNetworkEventId = Math.max(lastNetworkEventId, head.id);
    lastHeadTs = head.ts;
  }
  return fresh;
};

function start(): () => void {
  device = deviceOnline();
  // Failures logged before anything listened belong to the past, unless they are this recent.
  const snap = appStatus.getSnapshot();
  const head = snap.events[0];
  lastNetworkEventId = head ? head.id : 0;
  lastHeadTs = head ? head.ts : 0;
  if (head && isNetworkFailure(head) && Date.now() - head.ts < UNREACHABLE_HOLD_MS) holdUnreachable();
  current = compute();

  const onOnline = () => {
    device = true;
    unreachable = false;
    clearHold();
    emit();
  };
  const onOffline = () => {
    device = false;
    emit();
  };
  const offStatus = appStatus.subscribe(() => {
    if (freshNetworkFailure(appStatus.getSnapshot())) {
      holdUnreachable();
      emit();
    }
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }
  return () => {
    offStatus();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    }
    clearHold();
    unreachable = false;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!teardown) teardown = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && teardown) {
      teardown();
      teardown = null;
    }
  };
}

const getSnapshot = (): Connectivity => (teardown ? current : compute());
const getServerSnapshot = (): Connectivity => ONLINE;

/** A request reached the server again: drop the "unreachable" hold now instead of waiting it out. */
export function markReachable(): void {
  if (!unreachable) return;
  unreachable = false;
  clearHold();
  emit();
}

/** The current connectivity, outside React (event handlers deciding whether to try). */
export function readConnectivity(): Connectivity {
  if (!teardown) device = deviceOnline();
  return getSnapshot();
}

/** Whether the app can reach the network and its server, and why not. */
export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True while the device is online and the server answers. */
export function useOnline(): boolean {
  return useConnectivity().online;
}

/** Resets the shared store (tests). */
export function __resetOnlineStore(): void {
  if (teardown) teardown();
  teardown = null;
  listeners.clear();
  clearHold();
  device = true;
  unreachable = false;
  lastNetworkEventId = 0;
  lastHeadTs = 0;
  current = ONLINE;
}
