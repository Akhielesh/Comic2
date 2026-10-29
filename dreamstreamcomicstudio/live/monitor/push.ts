/**
 * Web Push for baby-monitor alerts: a cry or an offline camera wakes the
 * parent's phone even when Stream Studio is closed (Android/desktop; iPhone
 * once the app is added to the Home Screen — Apple's rule for web push).
 *
 * The subscription this module hands out (`subscribe`, `currentSubscription().toJSON()`) is the
 * browser's own, plus two fields the rooms read (ADR 0006 WS-5):
 *   dev — this browser's device id (devId, from WS-6's IndexedDB `ds-keys`), so the room can tie
 *         the subscription to a device it can revoke;
 *   was — on Stream Studio's own host, the endpoint of this browser's OLD subscription from
 *         dreamstreamstudio.ai/live (read through a same-site bridge page, below). The room drops
 *         that endpoint for the same account when it stores this one, so a nursery moved to the
 *         new address alerts this device once, not twice.
 * Rooms that don't know the fields ignore them (they keep only endpoint and keys).
 */

import { MAIN_ORIGIN, STREAM_ORIGIN } from '@/shared/streamHost';
import { LIVE_SW_SCOPE, ON_STREAM_HOST } from '../host';

export const SW_URL = '/live-sw.js';
export const SW_SCOPE = LIVE_SW_SCOPE; // '/' on Stream Studio's own host (live/host.ts)

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** iPhone/iPad Safari only allows web push for Home Screen apps. */
export function needsHomeScreen(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch {
    return null;
  }
}

function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ---------------------------------------------------------------- device id */

/**
 * Where WS-6 (live/monitor/keys.ts) keeps this browser's device keys: IndexedDB `ds-keys`,
 * object store `device`, record `self`, whose `devId` is b64url(SHA-256(sigPub))[0:22]
 * (ADR 0006 D6.3). Read-only here: the database is never created or upgraded from this module.
 */
export const DEV_KEYS_DB = 'ds-keys';
export const DEV_KEYS_STORE = 'device';
export const DEV_KEYS_RECORD = 'self';
const DEV_ID = /^[A-Za-z0-9_-]{22}$/;

let devIdMemo: string | null = null;

/** This browser's devId, or null before WS-6 has made its keys (or where IndexedDB is off). */
export async function readDevId(idb: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): Promise<string | null> {
  if (devIdMemo) return devIdMemo;
  if (!idb) return null;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = idb.open(DEV_KEYS_DB);
    } catch {
      resolve(null);
      return;
    }
    // No database yet: abort the creation, so the keys module still gets to make it its way.
    req.onupgradeneeded = () => {
      try {
        req.transaction?.abort();
      } catch { /* already aborting */ }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  if (!db) return null;
  try {
    const stores = Array.from(db.objectStoreNames);
    // The agreed store first; any store with a `self` record carrying a devId is accepted too.
    const order = [DEV_KEYS_STORE, ...stores.filter((s) => s !== DEV_KEYS_STORE)].filter((s) => stores.includes(s));
    for (const name of order) {
      const rec = await new Promise<unknown>((resolve) => {
        try {
          const req = db.transaction(name, 'readonly').objectStore(name).get(DEV_KEYS_RECORD);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      const id = (rec as { devId?: unknown } | null)?.devId;
      if (typeof id === 'string' && DEV_ID.test(id)) {
        devIdMemo = id;
        return id;
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------- the old /live subscription */

/**
 * Before Stream Studio had its own host, alerts were turned on at dreamstreamstudio.ai/live: that
 * browser subscription belongs to the apex origin, and the rooms keep sending to it. Turning
 * alerts on again at https://stream.dreamstreamstudio.ai creates a second subscription, so every
 * alert would arrive twice — and signing out on the new host wouldn't stop the old one.
 *
 * The bridge: a tiny page on the apex (public/stream-alerts-bridge.html, outside /live so the
 * apex's /live redirect and frame block don't touch it), loaded in a hidden frame. Same site, so
 * browsers that key storage by top-level site treat it as first-party: it sees the apex's service
 * worker and storage. The middleware lets only this host frame it, and this host's CSP lets it
 * frame only that page (functions/_middleware.ts). It answers only this host (it checks the
 * message's origin) and only two questions:
 *   state  → { endpoint, nids, ring, owner } — the old subscription, the nurseries it alerts for
 *            (the apex's `ds-monitor-push-<nid>` flags), call ringing, whose data it is;
 *   retire → unsubscribes it, clears those flags (scope 'account' also wipes the account's other
 *            Stream Studio data there, as signing out would have) — never another account's.
 * Where the frame can't see the apex's storage (a privacy mode or extension that isolates frames;
 * an iPhone Home Screen app, which has storage of its own) or doesn't answer, `state` comes back
 * empty and nothing changes: no worse than before — and once the old subscription is unsubscribed
 * by any route, its next push answers 410 and every room drops it.
 */
export const BRIDGE_PATH = '/stream-alerts-bridge'; // public/stream-alerts-bridge.html (Pages serves it without .html)
export const BRIDGE_TAG = 'ds-alerts-bridge';

export interface LegacyAlertState {
  endpoint: string | null;
  nids: string[];
  ring: boolean;
  owner: string | null;
}

export interface BridgeRetireResult {
  ok: boolean;
  /** The subscription that was ended, if there was one. */
  endpoint?: string | null;
  error?: string;
}

export type BridgeAsk = (op: 'state' | 'retire', args?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

/** One question to the bridge in a hidden frame; null when it doesn't answer in time. */
export function frameBridge(origin: string = MAIN_ORIGIN, timeoutMs = 4000): BridgeAsk {
  return (op, args = {}) =>
    new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve(null);
        return;
      }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const frame = document.createElement('iframe');
      let settled = false;
      const finish = (reply: Record<string, unknown> | null) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        window.clearTimeout(timer);
        frame.remove();
        resolve(reply);
      };
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== origin || e.source !== frame.contentWindow) return;
        const d = e.data as Record<string, unknown> | null;
        if (!d || d.ds !== BRIDGE_TAG || d.id !== id) return;
        finish(d);
      };
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      window.addEventListener('message', onMessage);
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.title = 'Stream Studio alerts';
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      frame.addEventListener('load', () => frame.contentWindow?.postMessage({ ds: BRIDGE_TAG, v: 1, id, op, ...args }, origin));
      frame.src = `${origin}${BRIDGE_PATH}`;
      document.body.appendChild(frame);
    });
}

const UUID = /^[0-9a-f-]{36}$/;
const HOST_FLAG = /^ds-monitor-push-([0-9a-f-]{36})$/;
const RING_KEY = 'ds-call-ring';

function parseState(d: Record<string, unknown> | null): LegacyAlertState | null {
  if (!d || d.ok !== true) return null;
  const endpoint = typeof d.endpoint === 'string' && /^https:\/\//.test(d.endpoint) ? d.endpoint : null;
  const nids = Array.isArray(d.nids) ? d.nids.filter((n): n is string => typeof n === 'string' && UUID.test(n)) : [];
  return { endpoint, nids, ring: d.ring === true, owner: typeof d.owner === 'string' && d.owner ? d.owner : null };
}

/** What this host has taken over: the nurseries whose alerts are on here, ringing, a live subscription. */
export interface HostAlertState {
  uid: string | null;
  nids: string[];
  ring: boolean;
  subscribed: boolean;
}

/**
 * May the old subscription go? Only once this host has its own subscription and covers everything
 * the old one did — every nursery it alerted for and call ringing — for the same account. Until
 * then it keeps alerting for the nurseries not moved yet (the rooms already dropped it for the
 * ones that moved, through `was`), so no nursery ever goes quiet on this device.
 */
export function legacyCovered(legacy: LegacyAlertState, host: HostAlertState): boolean {
  if (!legacy.endpoint || !host.subscribed) return false;
  if (legacy.owner && host.uid && legacy.owner !== host.uid) return false;
  if (legacy.ring && !host.ring) return false;
  return legacy.nids.every((n) => host.nids.includes(n));
}

/** This host's own alert opt-ins (live/views/MonitorViewer.tsx `ds-monitor-push-<nid>`, callCenter's ring). */
export function hostAlertFlags(storage: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): { nids: string[]; ring: boolean } {
  const nids: string[] = [];
  let ring = false;
  try {
    if (storage) {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const m = k ? HOST_FLAG.exec(k) : null;
        if (m && storage.getItem(k!) === '1') nids.push(m[1]);
      }
      ring = storage.getItem(RING_KEY) === '1';
    }
  } catch { /* storage unavailable */ }
  return { nids, ring };
}

export interface LegacyAlerts {
  /** The old subscription's endpoint (memoised for the page; null off the stream host or when none). */
  endpoint(): Promise<string | null>;
  state(): Promise<LegacyAlertState | null>;
  /** Retire it once this host covers it (after alerts are turned on here, and at start-up). */
  reconcile(host: HostAlertState): Promise<'retired' | 'kept' | 'none'>;
  /** Signing out here: the old subscription (and, scope 'account', the account's data there) goes too. */
  retire(scope: 'alerts' | 'account', uid: string | null, reason: 'covered' | 'signout'): Promise<BridgeRetireResult>;
}

export function createLegacyAlerts(opts: { onStreamHost: boolean; ask: BridgeAsk }): LegacyAlerts {
  let memo: Promise<LegacyAlertState | null> | null = null;
  const state = () => {
    if (!opts.onStreamHost) return Promise.resolve(null);
    memo ??= opts.ask('state').then(parseState).catch(() => null);
    return memo;
  };
  const retire = async (scope: 'alerts' | 'account', uid: string | null, reason: 'covered' | 'signout'): Promise<BridgeRetireResult> => {
    if (!opts.onStreamHost) return { ok: true, endpoint: null };
    const d = await opts.ask('retire', { scope, uid, reason }).catch(() => null);
    memo = null; // whatever happened, ask afresh next time
    if (!d) return { ok: false, error: 'no_answer' };
    return { ok: d.ok === true, endpoint: typeof d.endpoint === 'string' ? d.endpoint : null, ...(typeof d.error === 'string' ? { error: d.error } : {}) };
  };
  return {
    state,
    endpoint: async () => (await state())?.endpoint ?? null,
    async reconcile(host) {
      const legacy = await state();
      if (!legacy?.endpoint) return 'none';
      if (!legacyCovered(legacy, host)) return 'kept';
      const r = await retire('alerts', host.uid, 'covered');
      return r.ok ? 'retired' : 'kept';
    },
    retire,
  };
}

const legacy = createLegacyAlerts({ onStreamHost: ON_STREAM_HOST, ask: frameBridge() });

/** The bridge only answers Stream Studio's own host (public/stream-alerts-bridge.js checks it too). */
export const BRIDGE_PARENT_ORIGIN = STREAM_ORIGIN;

/** The account signed in here (for the bridge's owner check), read without loading the account module. */
async function signedInUid(): Promise<string | null> {
  try {
    const { getAccount } = await import('../account');
    return getAccount().userId ?? null;
  } catch {
    return null;
  }
}

/**
 * A device hint, not account data: "the old address had nothing left to end, as of <ms>". While
 * it's recent, start-up doesn't load the bridge again (two requests saved on every app open once
 * a browser has moved over). Turning alerts on here and signing out always ask.
 */
export const LEGACY_CLEAR_KEY = 'ds-alerts-legacy-clear';
export const LEGACY_RECHECK_MS = 7 * 24 * 3600_000;

export function legacyRecentlyClear(now = Date.now(), storage: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): boolean {
  try {
    const at = Number(storage?.getItem(LEGACY_CLEAR_KEY) ?? 0);
    return at > 0 && at <= now && now - at < LEGACY_RECHECK_MS;
  } catch {
    return false;
  }
}

function markLegacyClear(): void {
  try {
    localStorage.setItem(LEGACY_CLEAR_KEY, String(Date.now()));
  } catch { /* storage unavailable: ask again next time */ }
}

/**
 * After alerts or ringing were turned on here, and once at start-up: if this host now covers the
 * old /live subscription, end it. Never throws; does nothing off Stream Studio's own host.
 * `startup`: skipped while the old address was recently found to have nothing left.
 */
export async function reconcileLegacyAlerts(uid?: string | null, opts: { startup?: boolean } = {}): Promise<'retired' | 'kept' | 'none'> {
  if (!ON_STREAM_HOST || !pushSupported()) return 'none';
  if (opts.startup && legacyRecentlyClear()) return 'none';
  try {
    const flags = hostAlertFlags();
    const subscribed = !!(await rawSubscription());
    const result = await legacy.reconcile({ uid: uid ?? (await signedInUid()), nids: flags.nids, ring: flags.ring, subscribed });
    // Ended now, or the bridge answered and there was nothing to end (no answer proves nothing).
    if (result === 'retired' || (result === 'none' && (await legacy.state()) !== null)) markLegacyClear();
    return result;
  } catch {
    return 'none';
  }
}

/**
 * Signing out here (this device, or everywhere): the old /live subscription goes as well, with
 * the account's data on the old address — unless that data is another account's (`uid` is the
 * account signing out, read before the sign-out; the bridge refuses without it). Never throws.
 */
export async function retireLegacyAlerts(reason: 'signout' | 'covered', uid: string | null): Promise<BridgeRetireResult> {
  if (!ON_STREAM_HOST) return { ok: true, endpoint: null };
  try {
    return await legacy.retire(reason === 'signout' ? 'account' : 'alerts', uid, reason);
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/* ------------------------------------------------------------- subscriptions */

export type LivePushJSON = PushSubscriptionJSON & { dev?: string; was?: string };

/** The browser's subscription, with `toJSON()` carrying `dev` and `was` for the rooms. */
export interface LivePushSubscription {
  readonly endpoint: string;
  toJSON(): LivePushJSON;
  unsubscribe(): Promise<boolean>;
}

/** `dev` and `was` for a subscription about to be sent to a room. */
export async function subscriptionExtras(endpoint: string, deps: { devId?: () => Promise<string | null>; legacyEndpoint?: () => Promise<string | null> } = {}): Promise<{ dev?: string; was?: string }> {
  const [dev, was] = await Promise.all([
    (deps.devId ?? (() => readDevId()))().catch(() => null),
    (deps.legacyEndpoint ?? (() => legacy.endpoint()))().catch(() => null),
  ]);
  return { ...(dev ? { dev } : {}), ...(was && was !== endpoint ? { was } : {}) };
}

export function withExtras(sub: PushSubscription, extra: { dev?: string; was?: string }): LivePushSubscription {
  return {
    endpoint: sub.endpoint,
    toJSON: () => ({ ...sub.toJSON(), ...extra }),
    unsubscribe: () => sub.unsubscribe(),
  };
}

async function rawSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function currentSubscription(): Promise<LivePushSubscription | null> {
  const sub = await rawSubscription();
  return sub ? withExtras(sub, await subscriptionExtras(sub.endpoint)) : null;
}

/** Ask permission (must be called from a tap) and subscribe this device. */
export async function subscribe(vapidPublicKey: string): Promise<LivePushJSON | { error: string }> {
  if (!pushSupported()) return { error: 'This browser can’t receive alerts in the background.' };
  if (needsHomeScreen()) return { error: 'On iPhone, add Stream Studio to your Home Screen first (Share → Add to Home Screen), then turn alerts on from there.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { error: 'Notifications are blocked — allow them for this site in your browser settings.' };
  const reg = await registerSw();
  if (!reg) return { error: 'Could not start the alert service worker.' };
  await navigator.serviceWorker.ready;
  let sub: PushSubscription | null;
  try {
    sub = await reg.pushManager.getSubscription();
    const want = keyBytes(vapidPublicKey);
    // A subscription bound to an old server key can't receive our pushes.
    const have = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && have && (have.length !== want.length || have.some((b, i) => b !== want[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  } catch {
    return { error: 'The browser refused the alert subscription.' };
  }
  const json = withExtras(sub, await subscriptionExtras(sub.endpoint)).toJSON();
  // The caller registers this with its room and saves its opt-in right after we return; then see
  // whether the old /live subscription is fully covered and can go.
  if (ON_STREAM_HOST) window.setTimeout(() => void reconcileLegacyAlerts(), 1500);
  return json;
}

/**
 * Signed out on this device (or another account took it over): close the alerts and call rings
 * on screen, and tell the service worker so "I'm on it" on any alert that arrived before now can't
 * act for the person who just signed out (public/live-sw.js `ds-signed-out`). Never throws.
 */
export async function closeAlertNotifications(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    if (!reg) return;
    (reg.active ?? reg.waiting ?? reg.installing)?.postMessage({ t: 'ds-signed-out' });
    for (const n of await reg.getNotifications()) n.close();
  } catch { /* no service worker, or nothing shown */ }
}

/** Local-only notification (page open, e.g. tab in background). */
export async function localNotify(title: string, body: string, tag: string, url: string): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    if (reg) await reg.showNotification(title, { body, tag, data: { url }, icon: '/stream-studio.svg', badge: '/stream-studio.svg' } as NotificationOptions);
    else new Notification(title, { body, tag });
  } catch { /* ignore */ }
}
