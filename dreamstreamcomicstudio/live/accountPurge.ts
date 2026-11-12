/**
 * What a Stream Studio account leaves on a device, and how to wipe it.
 *
 * Signing out — here or in the main DreamStream app — must not leave the last
 * person's name, events, nursery data or alert subscription behind for the
 * next person on a shared device. That includes the guest passes this device
 * got from nurseries' share links ('ds-monitor-guest-<nursery>'): each is a
 * working pass to watch that nursery under the name typed for it, so the next
 * person here could otherwise watch as them. A guest who joined while no one was
 * signed in keeps theirs across loads with no session (claimDevice(null) purges
 * nothing on a device no account owns), but not past the next purge: someone who
 * signs in here later takes the device over without one, so their sign-out (or
 * any main-app sign-out, or an account switch) removes it, as the Cookies notice
 * says. Device preferences that aren't personal
 * (theme, camera lens, tours seen, this device's name for the monitor, the
 * folder picked for saving recordings) stay.
 *
 * What stays, and the Cookies notice and the Privacy Policy say so:
 *  - recordings that reached the disk but were never saved (live/recorder.ts): they are the host's
 *    unsaved work, so they stay on the device, each tagged with the account the studio was opened
 *    for, and only that account is offered it (listUnsavedRecordings). An entry from before
 *    recordings carried an owner is settled once, the first time this code sees the device: it goes
 *    to the account that holds the device then, or, with none, stays unowned and is offered to
 *    anyone here (settleUnownedRecordings). Who made each one is also kept apart from the list
 *    (RECORDING_OWNERS_KEY), with the account that held the device when this code first ran here
 *    (LEGACY_OWNER_KEY), so a recording whose entry is lost is listed again for its own account, or
 *    for none (UNKNOWN_OWNER), never for whoever holds the device then;
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

/**
 * Who made each unsaved recording, by its disk name ({name: account or null}), written with every
 * entry (live/recorder.ts) and when an entry from before recordings carried an owner is settled. A
 * Stream Studio tab still running a version from before this key never touches it, though it drops
 * registry entries (it kept only the 10 newest), so a recording that loses its entry that way, or to
 * a registry write that failed, is listed again for the account it was made for. Never purged: the
 * recordings it describes stay too.
 */
export const RECORDING_OWNERS_KEY = 'ds-live-rec-owners';

/**
 * {owner, at}: the account whose Stream Studio data was on this device the first time this code ran
 * here, and when. Written once, before anything about the device's owner changes, and `at` never
 * changes: a recording from before then that no list names any more (an earlier version had stopped
 * listing it) goes to that account, as the entries that version still listed do. The owner is noted
 * only where an earlier version kept unsaved recordings (its registry is here; null otherwise), and
 * is cleared once every recording from before then has its own recorded owner or is on a list
 * (retireLegacyOwner), so the account's id doesn't stay on the device longer than it is needed.
 */
export const LEGACY_OWNER_KEY = 'ds-live-legacy-owner';

/**
 * The owner of an unsaved recording whose account can't be told (no record of who made it, and not
 * from before this code first ran on a device an account held then). It is offered to no one; anyone
 * here sees it counted, with its size, and can delete it (live/recorder.ts otherAccountsUnsaved).
 */
export const UNKNOWN_OWNER = '?unknown';

type OwnerRecord = string | null;
const isOwner = (v: unknown): v is OwnerRecord => v === null || typeof v === 'string';

/** RECORDING_OWNERS_KEY as stored ({} when absent), or null when it can't be read. */
export function readRecordingOwners(): Record<string, OwnerRecord> | null {
  try {
    const raw = localStorage.getItem(RECORDING_OWNERS_KEY);
    const map = raw ? (JSON.parse(raw) as unknown) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, OwnerRecord>) : null;
  } catch {
    return null;
  }
}

/** Remember who made the recording on disk as `name`; a record already there is kept (it was first). */
export function noteRecordingOwner(name: string, owner: OwnerRecord): void {
  const map = readRecordingOwners();
  if (!map || Object.prototype.hasOwnProperty.call(map, name)) return;
  try {
    localStorage.setItem(RECORDING_OWNERS_KEY, JSON.stringify({ ...map, [name]: owner }));
  } catch { /* storage unavailable */ }
}

/** Forget the owners of recordings whose disk copies are gone. */
export function forgetRecordingOwners(names: Iterable<string>): void {
  const map = readRecordingOwners();
  if (!map) return;
  let changed = false;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      delete map[name];
      changed = true;
    }
  }
  if (!changed) return;
  try {
    localStorage.setItem(RECORDING_OWNERS_KEY, JSON.stringify(map));
  } catch { /* storage unavailable */ }
}

/** LEGACY_OWNER_KEY, or null when it was never written or can't be read. */
export function legacyRecordingsOwner(): { owner: OwnerRecord; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_OWNER_KEY) || 'null') as { owner?: unknown; at?: unknown } | null;
    return v && isOwner(v.owner) && typeof v.at === 'number' ? { owner: v.owner, at: v.at } : null;
  } catch {
    return null;
  }
}

/** Every recording from before LEGACY_OWNER_KEY's time has its own owner now: forget that account. */
export function retireLegacyOwner(): void {
  const legacy = legacyRecordingsOwner();
  if (!legacy || legacy.owner === null) return;
  try {
    localStorage.setItem(LEGACY_OWNER_KEY, JSON.stringify({ owner: null, at: legacy.at }));
  } catch { /* storage unavailable */ }
}

/**
 * Who a recording on disk that no list names belongs to: the account recorded for it; else, for
 * one from before this code first ran here (its disk name says when it started), the account that
 * held the device then; else no one can tell (UNKNOWN_OWNER, which includes an earlier version's
 * recording on a device no account held then: it was never offered after that version dropped it).
 */
export function recoveredRecordingOwner(name: string, startedAt: number | null): OwnerRecord {
  const owners = readRecordingOwners();
  if (owners && Object.prototype.hasOwnProperty.call(owners, name) && isOwner(owners[name])) return owners[name];
  const legacy = legacyRecordingsOwner();
  if (legacy && legacy.owner && startedAt != null && startedAt < legacy.at) return legacy.owner;
  return UNKNOWN_OWNER;
}

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
 * them first. The first time it runs on a device it also notes whose data the device held then
 * (LEGACY_OWNER_KEY), and every entry's owner is recorded apart from the list (RECORDING_OWNERS_KEY),
 * so an entry dropped later keeps its owner. It runs from the main app's sign-out and account switch
 * too, and from Stream Studio's start-up sweep (recorder.ts sweepOrphanRecordings).
 */
export function settleUnownedRecordings(): void {
  try {
    const owner = deviceOwner();
    const stored = localStorage.getItem(UNSAVED_RECORDINGS_KEY);
    if (localStorage.getItem(LEGACY_OWNER_KEY) == null) {
      localStorage.setItem(LEGACY_OWNER_KEY, JSON.stringify({ owner: stored == null ? null : owner, at: Date.now() }));
    }
    const list = JSON.parse(stored || '[]') as unknown;
    if (!Array.isArray(list)) return;
    const untagged = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as Record<string, unknown>).owner === undefined;
    const settled = list.some(untagged) ? list.map((r) => (untagged(r) ? { ...r, owner } : r)) : list;
    const owners = readRecordingOwners();
    if (owners) {
      let added = false;
      for (const r of settled as Array<Record<string, unknown> | null>) {
        if (!r || typeof r.name !== 'string' || !isOwner(r.owner) || Object.prototype.hasOwnProperty.call(owners, r.name)) continue;
        owners[r.name] = r.owner;
        added = true;
      }
      if (added) localStorage.setItem(RECORDING_OWNERS_KEY, JSON.stringify(owners));
    }
    if (settled !== list) localStorage.setItem(UNSAVED_RECORDINGS_KEY, JSON.stringify(settled));
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
