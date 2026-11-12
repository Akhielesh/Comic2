/**
 * What a Stream Studio account leaves on a device, and how to wipe it.
 *
 * Signing out — here or in the main DreamStream app — must not leave the last
 * person's name, events, nursery data or alert subscription behind for the
 * next person on a shared device. That includes the guest passes this device
 * got from nurseries' share links ('ds-monitor-guest-<nursery>'): each is a
 * working pass to watch that nursery under the name typed for it, so the next
 * person here could otherwise watch as them. A guest who never signs in keeps
 * theirs (nothing to sign out of). Device preferences that aren't personal
 * (theme, camera lens, tours seen, this device's name for the monitor, the
 * folder picked for saving recordings) stay.
 *
 * What stays, and the Cookies notice and the Privacy Policy say so:
 *  - recordings that reached the disk but were never saved (live/recorder.ts): they are the host's
 *    unsaved work, so they stay on the device, each tagged with the account the studio was opened
 *    for, and only that account is offered it (listUnsavedRecordings). An entry from before
 *    recordings carried an owner is settled once, the first time this code sees the device: it goes
 *    to the account that holds the device then, or, with none, stays unowned and is offered to
 *    anyone here (settleUnownedRecordings);
 *  - the baby monitor's encryption keys in IndexedDB ('ds-keys': this browser's device keys and its
 *    copies of nursery keys, live/monitor/keys.ts) and the cameras it has seen encrypt
 *    ('ds-e2e-cams-<nursery>'), so this device keeps refusing a camera's unencrypted pictures;
 *  - changes to favourites and blocks the call line hasn't confirmed yet ('ds-call-pending:<account>',
 *    sent only when that account's line connects again), so a block made offline isn't lost.
 *
 * Only a dependency-free import on purpose: the main app's sign-out calls this too.
 */
import { isStreamHost } from '../shared/streamHost';

/** The account whose data is on this device. */
export const OWNER_KEY = 'ds-live-owner';

/** The unsaved-recordings registry (live/recorder.ts keeps it; listed here so a purge can tag it). */
export const UNSAVED_RECORDINGS_KEY = 'ds-live-unsaved-recordings';

const EXACT = [
  'ds-live-prefs', // display name + settings synced to the account
  'ds-live-prefs-saved-at',
  'ds-live-my-events', // host keys of events you created
  'ds-live-my-recordings',
  'ds-call-ring',
  'ds-calls-seen',
  'ds-live-welcome-ticket', // a one-time welcome ticket: redeemed by whoever signs in next
  'ds-live-unconfirmed-revokes', // device sign-outs still to confirm with the nurseries
  'ds-call-names', // names of people you called or who rang you
  'ds-calls-ok', // people you confirmed calling outside your nurseries
  'ds-live-viewer-name', // the name typed to join someone else's event
  OWNER_KEY,
];
/**
 * Per-nursery data: alert opt-ins, setup progress, zones, stats, the tracker's offline queue, guest
 * passes from share links — and this device's usage (live/usage/): a nursery's relay data a parent
 * read, last nights, the month's ledger, hosted meetings, notices shown.
 */
const PREFIXES = ['ds-monitor-push-', 'ds-monitor-setup-', 'ds-monitor-zones-', 'ds-monitor-stats-', 'ds-monitor-silent-', 'ds-monitor-cam-', 'ds-monitor-caps-', 'ds-monitor-guest-', 'ds-track-queue-', 'ds-usage-'];

/**
 * Unsaved recordings left from before recordings carried an owner, settled once, before anything
 * about the device's owner changes: they go to the account that holds the device now (the one most
 * likely to have made them), so whoever signs in next isn't offered them; with no owner (the last
 * account signed out under the code before this), to no account (null: offered to anyone who opens
 * Stream Studio here, as every entry was until then). Never to whoever happens to sign in or list
 * them first.
 */
function settleUnownedRecordings(): void {
  try {
    const list = JSON.parse(localStorage.getItem(UNSAVED_RECORDINGS_KEY) || '[]') as unknown;
    if (!Array.isArray(list)) return;
    const untagged = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as Record<string, unknown>).owner === undefined;
    if (!list.some(untagged)) return;
    const owner = deviceOwner();
    localStorage.setItem(UNSAVED_RECORDINGS_KEY, JSON.stringify(list.map((r) => (untagged(r) ? { ...r, owner } : r))));
  } catch { /* storage unavailable or unreadable */ }
}

export function purgeLiveAccountData(): void {
  settleUnownedRecordings();
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

/** The account whose Stream Studio data is on this device now (null: no one is signed in here). */
export function deviceOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

/** Remember whose data this device holds; wipe it when someone else (or no one) is signed in. */
export function claimDevice(userId: string | null): boolean {
  settleUnownedRecordings();
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

/**
 * The main app switched this device to `userId` (another account was signed in here): Stream
 * Studio's data stays only when `userId` already owns it. Data with NO owner goes too — on a
 * switch it can't be told apart from the previous account's — where claimDevice would hand it
 * over. Returns true when something was purged.
 */
export function takeOverDevice(userId: string): boolean {
  settleUnownedRecordings();
  let owner: string | null = null;
  try {
    owner = localStorage.getItem(OWNER_KEY);
  } catch {
    return false;
  }
  if (owner === userId) return false;
  purgeLiveAccountData();
  setOwner(userId);
  return true;
}

function setOwner(userId: string): void {
  try {
    localStorage.setItem(OWNER_KEY, userId);
  } catch { /* storage unavailable */ }
}
