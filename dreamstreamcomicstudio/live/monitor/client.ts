/**
 * Baby Monitor data + realtime client.
 *
 *  - Nurseries, people and roles live in Supabase behind SECURITY DEFINER
 *    RPCs (members only).
 *  - The realtime socket authenticates with the member's own Supabase token
 *    in the FIRST frame (never in the URL), and re-authenticates with a fresh
 *    token on every reconnect.
 */

import { accessToken, supa } from '../account';
import { WORKER_BASE } from '../config';
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
  sendBinary(buf: ArrayBuffer | Blob): void;
  close(): void;
  readonly open: boolean;
}

/** Close codes that mean "stop trying": auth/forbidden/full/removed/ended. */
const FINAL = new Set([4001, 4003, 4004, 4006]);

export function openMonitorSocket(
  nid: string,
  mode: MonMode | 'admin',
  onMsg: (m: MonServerMsg) => void,
  onBinary: (data: Blob) => void,
  onStatus: (s: MonSocketStatus, detail?: string) => void,
): MonitorSocket {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let attempts = 0;
  let lastError: string | undefined;
  let ping: number | undefined;

  const connect = async () => {
    onStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    const token = await accessToken();
    if (!token) {
      onStatus('closed', 'Sign in to use the baby monitor.');
      return;
    }
    if (closedByUs) return;
    const dev = getDevice();
    ws = new WebSocket(`${WORKER_BASE.replace(/^http/, 'ws')}/api/monitor/${nid}/ws`);
    ws.binaryType = 'blob';
    ws.onopen = () => {
      // The camera phone's time zone sets the nursery's (reports, night vs nap).
      let tz: string | undefined;
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch { /* no Intl zone */ }
      ws?.send(JSON.stringify({ t: 'auth', token, mode, dev: dev.id, dn: dev.name, tz }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        onBinary(ev.data as Blob);
        return;
      }
      try {
        const m = JSON.parse(ev.data) as MonServerMsg;
        if (m.t === 'hello') {
          attempts = 0;
          onStatus('connected');
        }
        if (m.t === 'error') lastError = m.msg;
        onMsg(m);
      } catch { /* ignore */ }
    };
    ws.onclose = (ev) => {
      window.clearInterval(ping);
      if (closedByUs) return;
      if (FINAL.has(ev.code) && ev.code !== 4001) {
        onStatus('closed', lastError);
        return;
      }
      // 4001 (auth) retries once with a freshly refreshed token, then stops.
      attempts += 1;
      if (ev.code === 4001 && attempts > 2) {
        onStatus('closed', lastError || 'Your session expired — sign in again.');
        return;
      }
      onStatus('reconnecting');
      // A baby monitor never gives up on its own: back off to 15 s and keep going.
      window.setTimeout(() => void connect(), Math.min(15_000, 600 * 2 ** Math.min(attempts, 5)));
    };
    // App-level keepalive so mobile carriers don't silently drop the socket.
    ping = window.setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
    }, 25_000);
  };
  void connect();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    sendBinary(buf) {
      if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 512 * 1024) ws.send(buf);
    },
    close() {
      closedByUs = true;
      window.clearInterval(ping);
      try {
        ws?.close(1000);
      } catch { /* closed */ }
    },
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}

/**
 * One-shot "admin" connection (not shown in presence): a parent tells the
 * room the member list changed so removed people are cut off right away.
 */
export function announceMembersChanged(nid: string): Promise<void> {
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
