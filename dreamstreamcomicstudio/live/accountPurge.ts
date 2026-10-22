/**
 * What a Stream Studio account leaves on a device, and how to wipe it.
 *
 * Signing out — here or in the main DreamStream app — must not leave the last
 * person's name, events, nursery data or alert subscription behind for the
 * next person on a shared device. Device preferences that aren't personal
 * (theme, camera lens, tours seen, guest passes for share links) stay.
 *
 * Only a dependency-free import on purpose: the main app's sign-out calls this too.
 */
import { isStreamHost } from '../shared/streamHost';

/** The account whose data is on this device. */
export const OWNER_KEY = 'ds-live-owner';

const EXACT = [
  'ds-live-prefs', // display name + settings synced to the account
  'ds-live-prefs-saved-at',
  'ds-live-my-events', // host keys of events you created
  'ds-live-my-recordings',
  'ds-call-ring',
  'ds-calls-seen',
  OWNER_KEY,
];
/** Per-nursery data: alert opt-ins, setup progress, zones, stats, the tracker's offline queue. */
const PREFIXES = ['ds-monitor-push-', 'ds-monitor-setup-', 'ds-monitor-zones-', 'ds-monitor-stats-', 'ds-monitor-silent-', 'ds-monitor-cam-', 'ds-track-queue-'];

export function purgeLiveAccountData(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (EXACT.includes(k) || PREFIXES.some((p) => k.startsWith(p)))) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
  // Baby-monitor alerts and call rings must stop reaching this device. (The alert worker's
  // scope is the app's path: '/' on Stream Studio's own host, '/live' here — live/host.ts.)
  try {
    const scope = typeof location !== 'undefined' && isStreamHost(location.hostname) ? '/' : '/live';
    void navigator.serviceWorker
      ?.getRegistration(scope)
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => sub?.unsubscribe())
      .catch(() => undefined);
  } catch { /* no service worker */ }
}

/** Remember whose data this device holds; wipe it when someone else (or no one) is signed in. */
export function claimDevice(userId: string | null): boolean {
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(OWNER_KEY);
  } catch {
    return false;
  }
  if (owner && owner !== userId) {
    purgeLiveAccountData();
    if (userId) setOwner(userId);
    return true;
  }
  if (!owner && userId) setOwner(userId);
  return false;
}

function setOwner(userId: string): void {
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch { /* storage unavailable */ }
}
