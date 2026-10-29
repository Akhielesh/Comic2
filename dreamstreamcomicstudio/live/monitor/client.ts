/**
 * Baby Monitor data + realtime client.
 *
 *  - Nurseries, people and roles live in Supabase behind SECURITY DEFINER
 *    RPCs (members only). Rooms that list `reauth` (ADR 0006 Phase 0) take
 *    membership changes through the Worker instead (`POST /members`): it checks
 *    the second sign-in step, then tells the room, which cuts removed people off.
 *  - The realtime socket authenticates with the member's own Supabase token
 *    in the FIRST frame (never in the URL), and re-authenticates with a fresh
 *    token on every reconnect — and, in rooms that list `reauth`, on the open
 *    socket whenever the token is refreshed (`ds:token`), so the room can close
 *    a socket whose session ended (4001) without ever dropping a live one.
 *  - A room's close says why (wire.ts `closeKind`): removed, signed out, a role
 *    refusal, the second sign-in step needed (WS-5's StepUp, then reconnect), or
 *    too many attempts (back off).
 *  - Guests (share link + passcode, no account) send the guest pass the
 *    nursery's room issued instead (see guest.ts).
 */

import { accessToken, supa } from '../account';
import { WORKER_BASE } from '../config';
import { clearGuest, loadGuest, refreshGuest } from './guest';
import { closeKind, hasCap, helloCaps, parseCaps, ROUTES, TOKEN_EVENT, type CloseKind, type MembersRequest, type MembersResponse, type MonMode, type MonRole, type MonServerMsg } from './protocol';

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

/* ----------------------------------------------------- room capabilities */

/** What each nursery's room said it can do in its latest `hello` (wire.ts `CAPS`). */
const roomCaps = new Map<string, string[]>();
const capsKey = (nid: string) => `ds-monitor-caps-${nid}`;
/**
 * The capabilities this nursery's room listed last — remembered on this device, so a screen
 * with no socket to it yet (the nursery list) still knows (none before any socket said hello).
 */
export function nurseryCaps(nid: string): readonly string[] {
  const have = roomCaps.get(nid);
  if (have) return have;
  let caps: string[] = [];
  try {
    caps = parseCaps(JSON.parse(localStorage.getItem(capsKey(nid)) || '[]'));
  } catch { /* none remembered */ }
  roomCaps.set(nid, caps);
  return caps;
}
/** A room said hello (and for tests). */
export function noteNurseryCaps(nid: string, caps: readonly string[]): void {
  roomCaps.set(nid, [...caps]);
  try {
    localStorage.setItem(capsKey(nid), JSON.stringify(caps));
  } catch { /* storage full or blocked */ }
}

/* ----------------------------------------------------------- step-up */

/**
 * The second sign-in step (ADR 0006 D6.2): resolves true once the session may act — it gave
 * the authenticator code, or needs none — and false when the person cancels.
 */
export type StepUpFn = (reason: string) => Promise<boolean>;
type StepUpSheet = { ensureStepUp?: (reason?: string) => Promise<boolean> };
/**
 * WS-5's StepUp sheet (`live/views/account/StepUp.tsx`, mounted once by the app), found when
 * the app is built: an empty match before it ships, so these screens work either way.
 */
const STEP_UP_SHEET = import.meta.glob<StepUpSheet>('../views/account/StepUp.tsx');
let stepUpFn: StepUpFn | null = null;
let stepUpPending: Promise<boolean> | null = null;

/** Use this instead of WS-5's sheet (tests; a screen with its own). Returns the undo. */
export function registerStepUp(fn: StepUpFn | null): () => void {
  stepUpFn = fn;
  return () => {
    if (stepUpFn === fn) stepUpFn = null;
  };
}

/** Ask, or null when nothing in this app can ask. */
function askStepUp(reason: string): Promise<boolean> | null {
  if (stepUpFn) return stepUpFn(reason).catch(() => false);
  const load = Object.values(STEP_UP_SHEET)[0];
  if (!load) return null;
  return load()
    .then((m) => (m.ensureStepUp ? m.ensureStepUp(reason) : false))
    .catch(() => false);
}

/**
 * The room or the Worker said the second sign-in step is needed: ask for it (one prompt for
 * every socket that hit it at once). False when nothing can ask, or the person said no.
 */
export function stepUp(reason = 'Your nursery asks for your second sign-in step'): Promise<boolean> {
  if (!stepUpPending) {
    const asked = askStepUp(reason);
    if (!asked) return Promise.resolve(false);
    stepUpPending = asked.finally(() => (stepUpPending = null));
  }
  return stepUpPending;
}

/**
 * Before an admin action (people, share links, export, devices): make sure the session may
 * do it — false only when the person cancelled. With no sheet in the app it goes ahead: the
 * server is the one that enforces `aal2`, and its refusal is shown.
 */
export async function ensureStepUp(reason: string): Promise<boolean> {
  if (stepUpPending) return stepUpPending;
  const asked = askStepUp(reason);
  return asked ? asked : true;
}

/* ------------------------------------------------------------ members */

/**
 * Add someone or change their role. Rooms that list `reauth`: through the Worker (`POST
 * /members`, which needs the second sign-in step once it's on and tells the room at once);
 * older rooms: the RPC, then `announceMembersChanged`.
 */
export const setMember = (id: string, userId: string, role: MonRole, label: string, op: 'add' | 'role' = 'add') =>
  hasCap(nurseryCaps(id), 'reauth')
    ? membersRoute(id, { op, user: userId, role, label: label || null })
    : rpc<{ ok: boolean; error?: string }>('monitor_set_member', { p_nursery: id, p_user: userId, p_role: role, p_label: label || null });

export const removeMember = (id: string, userId: string) =>
  hasCap(nurseryCaps(id), 'reauth')
    ? membersRoute(id, { op: 'remove', user: userId })
    : rpc<{ ok: boolean; error?: string }>('monitor_remove_member', { p_nursery: id, p_user: userId });

/** POST /api/monitor/:nid/members — once more after the second sign-in step if it asks for one. */
export async function membersRoute(nid: string, body: MembersRequest, stepped = false): Promise<{ ok: boolean; error?: string; changed?: string[] }> {
  const token = await accessToken();
  if (!token) return { ok: false, error: 'auth' };
  let res: Response;
  try {
    res = await fetch(`${WORKER_BASE}${ROUTES.members(nid)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: 'offline' };
  }
  let data: MembersResponse | null = null;
  try {
    data = (await res.json()) as MembersResponse;
  } catch { /* not JSON */ }
  if (data?.error === 'mfa_required' && !stepped) {
    if (await stepUp('Changing who has access to the nursery')) return membersRoute(nid, body, true);
    return { ok: false, error: 'mfa_required' };
  }
  if (!res.ok || !data?.ok) return { ok: false, error: data?.error ?? (res.status === 403 ? 'forbidden' : res.status === 401 ? 'auth' : 'unknown') };
  toldByWorker.set(nid, Date.now());
  return { ok: true, changed: data.changed };
}

/** Nurseries whose last membership change went through the Worker (it told the room itself), and when. */
const toldByWorker = new Map<string, number>();

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
    case 'mfa_required':
      return 'Confirm it’s you with your second sign-in step first (Settings → Security).';
    case 'auth':
      return 'Sign in again first — your session ended.';
    case 'offline':
      return 'You’re offline — try again when you’re back online.';
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

/** Closes that mean "stop trying" (wire.ts `closeKind`): full (unless persistent), a role refusal, removed, signed out, ended. */
const FINAL_KINDS = new Set<CloseKind>(['full', 'forbidden', 'removed', 'revoked', 'ended']);
/** What a closed socket says when the room didn't say it in words first. */
export const CLOSE_TEXT: Partial<Record<CloseKind, string>> = {
  removed: 'You no longer have access here.',
  revoked: 'This device was signed out of your account — sign in again to continue.',
  forbidden: 'Your role can’t do that here.',
  full: 'Too many devices are connected right now — try again in a moment.',
  ended: 'This has ended.',
  mfa_required: 'Confirm it’s you with the code from your authenticator app to reconnect.',
};
/** What the second-step sheet says when a room asked for it. */
const STEP_UP_REASON = 'Your nursery asks for your second sign-in step before it reconnects.';
/** A persistent socket that can't sign in (no token yet, or the server couldn't check it) tries again this often at most. */
export const AUTH_RETRY_MS = 30_000;
/** Told it tried too often (4008 rate_limited): wait at least this long. */
export const RATE_LIMIT_WAIT_MS = 20_000;
/** A room that lists `reauth` gets a fresh token this long before the current one expires. */
export const REAUTH_AHEAD_MS = 45_000;
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
  opts: {
    fast?: boolean;
    onFinal?: (code: number, guest: boolean, kind: CloseKind) => void;
    persistent?: boolean;
    /** Sign the open socket in again with each fresh token, in rooms that list `reauth` (members only; default on). */
    reauth?: boolean;
    /** Words for a final close the room didn't explain. */
    closeText?: Partial<Record<CloseKind, string>>;
  } = {},
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
  /** What this connection's room can do (its hello), the token it holds and when that expires. */
  let caps: string[] = [];
  let sentToken: string | null = null;
  let reauthTimer: number | undefined;
  /** Closes in a row that asked for the second sign-in step, and whether the person said no to it. */
  let mfaStreak = 0;
  let mfaDeclined = false;

  /** A fresh token to the open socket (rooms that list `reauth`; members, not guests). */
  const reauth = (token: string | null | undefined) => {
    if (!token || token === sentToken || opts.reauth === false || usedGuest || !caps.includes('reauth')) return;
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ t: 'reauth', token }));
      sentToken = token;
    } catch { /* closing */ }
  };
  /** Ahead of the token's expiry, fetch the refreshed one and hand it over — the socket never lapses. */
  const scheduleReauth = (exp: unknown) => {
    window.clearTimeout(reauthTimer);
    if (typeof exp !== 'number' || !Number.isFinite(exp) || !caps.includes('reauth') || usedGuest || opts.reauth === false) return;
    const ms = Math.max(5_000, exp - Date.now() - REAUTH_AHEAD_MS);
    reauthTimer = window.setTimeout(() => void accessToken().then(reauth), Math.min(ms, 2 ** 31 - 1));
  };
  const onToken = (e: Event) => {
    const token = (e as CustomEvent<string>).detail;
    // Waiting out a "second sign-in step needed": a fresh token may be the stepped-up one — try it now.
    if (!ws && mfaStreak > 0 && retryAt && !closedByUs && typeof token === 'string' && token) {
      retryIn(0);
      return;
    }
    reauth(token);
  };

  const clearCheck = () => {
    window.clearTimeout(checkTimer);
    checkAt = 0;
  };
  const stopTimers = () => {
    window.clearTimeout(pingTimer);
    window.clearTimeout(reauthTimer);
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
    // What the room meant (wire.ts): a 4004 'forbidden' is a role refusal, never "removed".
    const kind = closeKind(code, reason);
    // "Too many devices" passes (a device closes, a stale socket times out): a persistent line waits it out.
    const full = kind === 'full';
    if (FINAL_KINDS.has(kind) && !(opts.persistent && full)) {
      opts.onFinal?.(code, guest, kind);
      onStatus('closed', lastError || opts.closeText?.[kind] || CLOSE_TEXT[kind]);
      return;
    }
    if (kind === 'mfa_required') {
      // Never final: a baby monitor that stopped here would go quiet. It asks for the code once
      // (a call line or a guest never asks), then tries again slowly — and at once when a fresh
      // token arrives (the person gave the code in another tab, or in Settings).
      attempts += 1;
      mfaStreak += 1;
      onStatus('reconnecting', opts.closeText?.mfa_required || CLOSE_TEXT.mfa_required);
      const ask = !opts.persistent && !guest && !mfaDeclined && mfaStreak <= 2;
      if (!ask) {
        retryIn(Math.max(backoff(), AUTH_RETRY_MS));
        return;
      }
      void stepUp(STEP_UP_REASON).then((ok) => {
        if (closedByUs) return;
        if (!ok) mfaDeclined = true;
        retryIn(ok ? 0 : Math.max(backoff(), AUTH_RETRY_MS));
      });
      return;
    }
    // 4001 (auth) retries once with a freshly refreshed token, then stops (a persistent line slows down instead).
    attempts += 1;
    if (kind === 'rate_limited') {
      onStatus('reconnecting', 'Too many attempts — trying again shortly.');
      retryIn(Math.max(backoff(), RATE_LIMIT_WAIT_MS));
      return;
    }
    if (((kind === 'auth' || kind === 'expired') && attempts > 2) || full) {
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
    caps = [];
    sentToken = typeof a.frame.token === 'string' ? a.frame.token : null;
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
        const m = JSON.parse(ev.data) as M & { msg?: string; caps?: unknown; exp?: unknown };
        if (m.t === 'hello') {
          attempts = 0;
          mfaStreak = 0;
          mfaDeclined = false;
          caps = helloCaps(m);
          scheduleReauth(m.exp);
          onStatus('connected');
        }
        if (m.t === 'reauth_ok') scheduleReauth(m.exp);
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
  window.addEventListener(TOKEN_EVENT, onToken);
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
      window.removeEventListener(TOKEN_EVENT, onToken);
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
      if (m.t === 'hello') noteNurseryCaps(nid, helloCaps(m));
      onMsg(m);
    },
    onBinary,
    onStatus,
    {
      ...opts,
      // A removed or expired guest pass is gone for good on this device — a role refusal isn't.
      onFinal: (_code, guest, kind) => {
        if (guest && (kind === 'removed' || kind === 'revoked')) clearGuest(nid);
      },
      closeText: { removed: 'You were removed from this nursery.' },
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
    // A ticket, not a token: nothing to sign in again with.
    { ...opts, reauth: false },
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
  // A change that went through the Worker (`POST /members`) reached the room already (`/x/members`);
  // one made with the RPC (an older room, or caps not known yet) still needs saying.
  const told = toldByWorker.get(nid);
  toldByWorker.delete(nid);
  if (told && Date.now() - told < 60_000) return Promise.resolve();
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
