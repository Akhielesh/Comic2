/**
 * Baby Monitor data + realtime client.
 *
 *  - Nurseries, people and roles live in Supabase behind SECURITY DEFINER
 *    RPCs (members only).
 *  - The realtime socket authenticates with the member's own Supabase token
 *    in the FIRST frame (never in the URL), and re-authenticates with a fresh
 *    token on every reconnect.
 *  - Guests (share link + passcode, no account) send the guest pass the
 *    nursery's room issued instead (see guest.ts).
 */

import { accessToken, supa } from '../account';
import { WORKER_BASE } from '../config';
import { clearGuest, loadGuest, refreshGuest } from './guest';
import type { MonMode, MonRole, MonServerMsg } from './protocol';

export interface Nursery {
  id: string;
  name: string;
  baby_name: string | null;
  owner_id: string;
  owner_name: string | null;
  my_role: MonRole;
  my_label: string | null;
  member_count: number;
  created_at: string;
}

export interface NurseryPerson {
  user_id: string;
  display_name: string;
  role: MonRole;
  label: string | null;
  is_owner: boolean;
  is_me: boolean;
}

async function rpc<T extends { ok?: boolean; error?: string }>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const sb = await supa();
  if (!sb) return { ok: false, error: 'offline' } as T;
  const { data, error } = await sb.rpc(fn, args);
  if (error) return { ok: false, error: /could not find the function/i.test(error.message) ? 'setup' : error.message } as T;
  return data as T;
}

export const listNurseries = () => rpc<{ ok: boolean; error?: string; nurseries?: Nursery[] }>('monitor_list');
export const createNursery = (name: string, baby: string, label: string) =>
  rpc<{ ok: boolean; error?: string; nursery?: Nursery }>('monitor_create', { p_name: name, p_baby_name: baby || null, p_label: label || null });
export const updateNursery = (id: string, name: string, baby: string) =>
  rpc<{ ok: boolean; error?: string; nursery?: Nursery }>('monitor_update', { p_nursery: id, p_name: name, p_baby_name: baby || null });
export const deleteNursery = (id: string) => rpc<{ ok: boolean; error?: string }>('monitor_delete', { p_nursery: id });
export const listPeople = (id: string) => rpc<{ ok: boolean; error?: string; people?: NurseryPerson[] }>('monitor_people', { p_nursery: id });
export const setMember = (id: string, userId: string, role: MonRole, label: string) =>
  rpc<{ ok: boolean; error?: string }>('monitor_set_member', { p_nursery: id, p_user: userId, p_role: role, p_label: label || null });
export const removeMember = (id: string, userId: string) => rpc<{ ok: boolean; error?: string }>('monitor_remove_member', { p_nursery: id, p_user: userId });

export function monitorError(code?: string): string {
  switch (code) {
    case 'setup':
      return 'The baby monitor is being set up on the server — try again in a few minutes.';
    case 'not_member':
      return 'Unlock Stream Studio with your welcome code first.';
    case 'forbidden':
      return 'Only a parent of this nursery can do that.';
    case 'limit_reached':
      return 'Limit reached (5 nurseries per account, 20 people per nursery).';
    case 'owner_is_parent':
      return 'The nursery owner is always a parent.';
    case 'name_required':
      return 'Give it a name first.';
    default:
      return 'Something went wrong — try again.';
  }
}

/* ------------------------------------------------------- this device */

const DEVICE_KEY = 'ds-monitor-device';

export interface DeviceIdentity {
  id: string;
  name: string;
}

export function guessDeviceName(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/CrOS/i.test(ua)) return 'Chromebook';
  if (/Linux/i.test(ua)) return 'Linux computer';
  return 'This device';
}

export function getDevice(): DeviceIdentity {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as DeviceIdentity;
      if (d.id && d.name) return d;
    }
  } catch { /* storage unavailable */ }
  const d = { id: crypto.randomUUID().slice(0, 12), name: guessDeviceName() };
  saveDevice(d);
  return d;
}

export function saveDevice(d: DeviceIdentity): void {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify({ id: d.id, name: d.name.trim().slice(0, 40) || guessDeviceName() }));
  } catch { /* storage unavailable */ }
}

/* ------------------------------------------------------------- socket */

export type MonSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface MonitorSocket {
  send(msg: Record<string, unknown>): void;
  /**
   * Send a binary frame unless more than `maxBuffered` bytes are still
   * waiting to go out (a stale frame is worse than a skipped one).
   * Returns whether it was sent.
   */
  sendBinary(data: ArrayBuffer | Blob, maxBuffered?: number): boolean;
  /** Bytes queued on the socket but not yet sent (0 when closed). */
  bufferedAmount(): number;
  close(): void;
  readonly open: boolean;
  /** When anything last arrived from the room (ms epoch; 0 = never). */
  readonly lastHeard: number;
  /** Ringing / in a call: ping every 10 s and come back within 2 s of a drop. */
  setFast(on: boolean): void;
  /** Check the connection now: if nothing answers within `ms`, reconnect. */
  probe(ms?: number): void;
  /** Drop this connection and open a fresh one right away. */
  reconnect(): void;
}

/** Close codes that mean "stop trying": auth/forbidden/full/removed/ended. */
const FINAL = new Set([4001, 4003, 4004, 4006]);
/** A persistent socket that can't sign in (no token yet, or the server couldn't check it) tries again this often at most. */
export const AUTH_RETRY_MS = 30_000;
export const PING_MS = 25_000;
export const FAST_PING_MS = 10_000;
/** A ping that gets no answer (no message at all) this long means the socket is dead. */
export const PONG_WAIT_MS = 10_000;
const PING = '{"t":"ping"}';

/** The first frame (a member token, a guest pass or a call ticket) — or why there can't be one. */
export type AuthFrame = { frame: Record<string, unknown>; guest?: boolean } | { error: string };

/**
 * A realtime socket to one of the live Worker's rooms (a nursery, a member's
 * call line, a direct call): authenticates in the first frame, keeps itself
 * alive (ping + watchdog, faster while ringing or in a call), and reconnects —
 * re-authenticating with a fresh frame every time — until it's told to stop.
 *
 * `persistent` (your own call line): only a real "forbidden" stops it. "Too
 * many devices", a sign-in that can't be checked right now, and no token yet
 * (a phone waking up offline with an expired session) all back off and try
 * again — a line that quietly gave up would leave the device unreachable.
 */
export function openLiveSocket<M extends { t: string }>(
  path: string,
  auth: () => Promise<AuthFrame>,
  onMsg: (m: M) => void,
  onBinary: (data: Blob) => void,
  onStatus: (s: MonSocketStatus, detail?: string) => void,
  opts: { fast?: boolean; onFinal?: (code: number, guest: boolean) => void; persistent?: boolean } = {},
): MonitorSocket {
  let ws: WebSocket | null = null;
  let usedGuest = false;
  let closedByUs = false;
  let attempts = 0;
  let lastError: string | undefined;
  let fast = !!opts.fast;
  let heard = 0;
  /** Messages received so far (the watchdog compares counts, not clocks). */
  let heardN = 0;
  let gen = 0;
  let pingTimer: number | undefined;
  let retryTimer: number | undefined;
  let retryAt = 0;
  // The pending "did anything come back?" check.
  let checkTimer: number | undefined;
  let checkAt = 0;
  let checkN = 0;

  const clearCheck = () => {
    window.clearTimeout(checkTimer);
    checkAt = 0;
  };
  const stopTimers = () => {
    window.clearTimeout(pingTimer);
    clearCheck();
  };

  /**
   * App-level keepalive, so mobile carriers don't silently drop the socket —
   * and a watchdog: after a network change a socket can sit OPEN for minutes
   * while nothing gets through. A ping that hears nothing back in time means
   * the connection is dead: drop it and reconnect.
   */
  const probe = (wait = PONG_WAIT_MS) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    try {
      ws.send(PING);
    } catch { /* closing */ }
    if (checkAt && checkAt <= now + wait) return; // an earlier check is already due
    if (!checkAt) checkN = heardN;
    checkAt = now + wait;
    window.clearTimeout(checkTimer);
    checkTimer = window.setTimeout(() => {
      checkAt = 0;
      if (heardN === checkN) drop();
    }, wait);
  };
  const schedulePing = () => {
    window.clearTimeout(pingTimer);
    pingTimer = window.setTimeout(() => {
      probe();
      schedulePing();
    }, fast ? FAST_PING_MS : PING_MS);
  };

  const backoff = () => Math.min(fast ? 2000 : 15_000, 600 * 2 ** Math.min(attempts, 5));
  const retryIn = (ms: number) => {
    window.clearTimeout(retryTimer);
    retryAt = Date.now() + ms;
    retryTimer = window.setTimeout(() => {
      retryAt = 0;
      void connect();
    }, ms);
  };

  /** The connection is gone (closed, or found dead): say so and try again — unless it's final. */
  const lost = (code: number, guest: boolean, reason = '') => {
    stopTimers();
    if (closedByUs) return;
    // "Too many devices" passes (a device closes, a stale socket times out): a persistent line waits it out.
    const full = code === 4003 && reason === 'full';
    if (FINAL.has(code) && code !== 4001 && !(opts.persistent && full)) {
      opts.onFinal?.(code, guest);
      onStatus('closed', lastError);
      return;
    }
    // 4001 (auth) retries once with a freshly refreshed token, then stops (a persistent line slows down instead).
    attempts += 1;
    if ((code === 4001 && attempts > 2) || full) {
      if (!opts.persistent) {
        onStatus('closed', lastError || 'Your session expired — sign in again.');
        return;
      }
      onStatus('reconnecting', lastError);
      retryIn(Math.max(backoff(), full ? 5000 : AUTH_RETRY_MS));
      return;
    }
    onStatus('reconnecting');
    // A baby monitor never gives up on its own: back off to 15 s (2 s while ringing / in a call) and keep going.
    retryIn(backoff());
  };

  /** Abandon the current socket without waiting for a close handshake that may never come. */
  const drop = (now = false) => {
    const old = ws;
    if (!old) return;
    ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close(4000, 'stale');
    } catch { /* closed */ }
    if (now) {
      stopTimers();
      if (!closedByUs) {
        onStatus('reconnecting');
        retryIn(0);
      }
    } else lost(1006, usedGuest);
  };

  const connect = async () => {
    const my = ++gen;
    onStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    const a = await auth();
    if (my !== gen || closedByUs) return;
    if ('error' in a) {
      if (!opts.persistent) {
        onStatus('closed', a.error);
        return;
      }
      // No token right now (offline, or the session is refreshing): try again shortly, and as soon as we're back online.
      attempts += 1;
      onStatus('reconnecting', a.error);
      retryIn(Math.min(AUTH_RETRY_MS, Math.max(backoff(), 5000)));
      return;
    }
    usedGuest = !!a.guest;
    const sock = new WebSocket(`${WORKER_BASE.replace(/^http/, 'ws')}${path}`);
    ws = sock;
    sock.binaryType = 'blob';
    sock.onopen = () => {
      sock.send(JSON.stringify(a.frame));
      schedulePing();
    };
    sock.onmessage = (ev) => {
      heard = Date.now();
      heardN += 1;
      if (checkAt) clearCheck();
      if (typeof ev.data !== 'string') {
        onBinary(ev.data as Blob);
        return;
      }
      try {
        const m = JSON.parse(ev.data) as M & { msg?: string };
        if (m.t === 'hello') {
          attempts = 0;
          onStatus('connected');
        }
        if (m.t === 'error') lastError = m.msg;
        onMsg(m);
      } catch { /* ignore */ }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      lost(ev.code, usedGuest, ev.reason);
    };
  };

  // Back to the app (phone unlocked, tab shown) or back online: check the connection now.
  const onVisible = () => {
    if (document.visibilityState === 'visible') probe(5000);
  };
  const onOnline = () => {
    if (ws) probe(4000);
    else if (retryAt && !closedByUs) retryIn(0);
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  void connect();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    sendBinary(data, maxBuffered = 512 * 1024) {
      if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount >= maxBuffered) return false;
      ws.send(data);
      return true;
    },
    bufferedAmount() {
      return ws?.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    },
    close() {
      closedByUs = true;
      gen += 1;
      stopTimers();
      window.clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      try {
        ws?.close(1000);
      } catch { /* closed */ }
    },
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
    get lastHeard() {
      return heard;
    },
    setFast(on) {
      if (on === fast) return;
      fast = on;
      if (ws?.readyState === WebSocket.OPEN) {
        if (on) probe();
        schedulePing();
      } else if (on && retryAt && retryAt - Date.now() > 2000) retryIn(2000);
    },
    probe(ms = PONG_WAIT_MS) {
      probe(ms);
    },
    reconnect() {
      if (closedByUs) return;
      if (ws) drop(true);
      else retryIn(0);
    },
  };
}

/** A nursery's room: the member's own token (or a guest pass, on the watch screen) in the first frame. */
export function openMonitorSocket(
  nid: string,
  mode: MonMode | 'admin' | 'line',
  onMsg: (m: MonServerMsg) => void,
  onBinary: (data: Blob) => void,
  onStatus: (s: MonSocketStatus, detail?: string) => void,
  opts: { fast?: boolean } = {},
): MonitorSocket {
  return openLiveSocket<MonServerMsg>(
    `/api/monitor/${nid}/ws`,
    async () => {
      const dev = getDevice();
      // A guest pass for this nursery wins on the watch screen; members otherwise.
      const guest = mode === 'viewer' ? loadGuest(nid) : null;
      if (guest) return { frame: { t: 'auth', guest: guest.token, mode, dev: dev.id, dn: dev.name }, guest: true };
      const token = await accessToken();
      if (!token) return { error: 'Sign in to use the baby monitor.' };
      // The camera phone's time zone sets the nursery's (reports, night vs nap).
      let tz: string | undefined;
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch { /* no Intl zone */ }
      return { frame: { t: 'auth', token, mode, dev: dev.id, dn: dev.name, tz } };
    },
    (m) => {
      // The room is the authority on when a guest pass ends: keep this device's copy in step.
      if (m.t === 'hello' && m.you.guest) refreshGuest(nid, m.you.until);
      else if (m.t === 'guest_pass') refreshGuest(nid, m.until);
      onMsg(m);
    },
    onBinary,
    onStatus,
    {
      ...opts,
      // A removed or expired guest pass is gone for good on this device.
      onFinal: (code, guest) => {
        if (guest && code === 4004) clearGuest(nid);
      },
    },
  );
}

/**
 * A member's personal line for direct calls (live-worker userLine.ts): their own
 * token in the first frame. Persistent: it keeps trying through "too many
 * devices", no token yet and sign-in hiccups — only a real "forbidden" stops it.
 */
export function openUserLineSocket<M extends { t: string }>(uid: string, onMsg: (m: M) => void, onStatus: (s: MonSocketStatus, detail?: string) => void, opts: { fast?: boolean } = {}): MonitorSocket {
  return openLiveSocket<M>(
    `/api/calls/u/${uid}/ws`,
    async () => {
      const token = await accessToken();
      if (!token) return { error: 'Sign in to make calls.' };
      const dev = getDevice();
      return { frame: { t: 'auth', token, dev: dev.id, dn: dev.name } };
    },
    onMsg,
    () => undefined,
    onStatus,
    { ...opts, persistent: true },
  );
}

/** A direct call's own room (live-worker callRoom.ts): the ticket your line handed you in the first frame. */
export function openCallRoomSocket<M extends { t: string }>(id: string, ticket: string, onMsg: (m: M) => void, onStatus: (s: MonSocketStatus, detail?: string) => void, opts: { fast?: boolean } = {}): MonitorSocket {
  return openLiveSocket<M>(
    `/api/calls/c/${id}/ws`,
    async () => {
      const dev = getDevice();
      return { frame: { t: 'auth', ticket, dev: dev.id, dn: dev.name } };
    },
    onMsg,
    () => undefined,
    onStatus,
    opts,
  );
}

const membersFns = new Set<(nid: string) => void>();

/** This device just changed who's in a nursery (calls re-read who counts as family) — `noteMembersChanged` tells them. */
export function onMembersChanged(fn: (nid: string) => void): () => void {
  membersFns.add(fn);
  return () => void membersFns.delete(fn);
}

/**
 * One-shot "admin" connection (not shown in presence): a parent tells the
 * room the member list changed so removed people are cut off right away.
 */
export function noteMembersChanged(nid: string): void {
  for (const fn of membersFns) fn(nid);
}

export function announceMembersChanged(nid: string): Promise<void> {
  noteMembersChanged(nid);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sock.close();
      resolve();
    };
    const sock = openMonitorSocket(
      nid,
      'admin',
      (m) => {
        if (m.t === 'hello') {
          void accessToken().then((token) => {
            if (token) sock.send({ t: 'members_changed', token });
            window.setTimeout(finish, 1500);
          });
        } else if (m.t === 'error') finish();
      },
      () => undefined,
      (s) => s === 'closed' && finish(),
    );
    window.setTimeout(finish, 10_000);
  });
}
