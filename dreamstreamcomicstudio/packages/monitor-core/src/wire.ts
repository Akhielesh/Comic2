/**
 * The ADR 0006 Phase 0 protocol delta (checklist section 1) as types, constants and small
 * validators — the one place the web app, the live Worker and the native apps agree on
 * capabilities, close codes, the re-auth / kick / act contracts, key messages, sealed
 * signaling and the push envelope. No runtime dependencies.
 *
 * Shapes reconciled with what shipped after the ADR was written (noted in its WS-2 section):
 * - Close codes: the rooms already used 4003 for "full"/"forbidden" and 4008 for a retired
 *   stale line. The reason string tells them apart; `closeKind` does it for clients.
 * - Fresh relay credentials ship as `{t:'ice', servers, iceMs}` (asked for with `{t:'ice'}`),
 *   which replaces the planned `ice_refresh`.
 * - `dev_hello` carries the `ts` its signature covers; `key_req` carries the device's
 *   `ecdhPub` (the holder needs it to wrap); the room asks for a rotation with the device
 *   list (`key_rotate` + `devs`); sealed signaling names its sender (`f`).
 */
import { CAN, type GlanceV1 } from './glance';

export type MonRole = 'parent' | 'caregiver' | 'viewer';
/** A socket's purpose, sent in its first (auth) frame. `glance` sockets receive only `{t:'glance'}`. */
export type SocketMode = 'camera' | 'viewer' | 'admin' | 'line' | 'glance';

/* ------------------------------------------------------------ capabilities */

/**
 * What a room can do, listed in `hello.caps`. A client uses a feature only when its room
 * lists it, so new clients deploy before the server and stay dormant (ground rule 2).
 * - `reauth`: takes `{t:'reauth'}`, closes expired sockets (4001) and enforces MFA (4003).
 * - `view`: takes `{t:'view'}` and sends cameras `live_want`.
 * - `eid`: inserts camera events idempotently by `eid`.
 * - `e2e1`: holds device rosters and NMK wraps; forwards sealed signaling and relay frames.
 * - `glance1`: serves `/glance`, `/act` and `mode:'glance'` sockets.
 * - `stats5`: takes minute rows in 5-minute `stats` batches.
 */
export const CAPS = ['reauth', 'view', 'eid', 'e2e1', 'glance1', 'stats5'] as const;
export type Cap = (typeof CAPS)[number];

/** The known capabilities in `v` (anything else is ignored, so older clients survive newer rooms). */
export function parseCaps(v: unknown): Cap[] {
  if (!Array.isArray(v)) return [];
  const out: Cap[] = [];
  for (const c of v) if ((CAPS as readonly unknown[]).includes(c) && !out.includes(c as Cap)) out.push(c as Cap);
  return out;
}

export const hasCap = (caps: readonly string[] | null | undefined, cap: Cap): boolean => !!caps && caps.includes(cap);

/* -------------------------------------------------------------- close codes */

/** Room close codes. The reason string (`CLOSE_REASON`) says which case a shared code is. */
export const CLOSE = {
  /** Sign-in failed or timed out, or the token expired (`exp` + 120 s). */
  AUTH: 4001,
  /** MFA needed (`mfa_required`), the room is full (`full`) or the role can't do this (`forbidden`). */
  FORBIDDEN: 4003,
  /** Removed from the nursery, or this session or device was revoked. */
  REMOVED: 4004,
  /** Another socket took this camera's place. */
  REPLACED: 4005,
  /** The call or room ended. */
  ENDED: 4006,
  /** A guest was made a member: reconnect with the account. */
  PROMOTED: 4007,
  /** Too many attempts (`rate_limited`), or a line socket retired as stale (`stale`). */
  LIMITED: 4008,
  /** The role changed: reconnect to pick it up. */
  RECHECK: 4009,
} as const;

export const CLOSE_REASON = {
  expired: 'expired',
  auth: 'auth',
  authTimeout: 'auth timeout',
  mfaRequired: 'mfa_required',
  full: 'full',
  forbidden: 'forbidden',
  removed: 'removed',
  revoked: 'revoked',
  replaced: 'replaced',
  ended: 'ended',
  promoted: 'promoted',
  rateLimited: 'rate_limited',
  stale: 'stale',
  recheck: 'recheck',
} as const;

export type CloseKind =
  | 'expired' | 'auth' | 'mfa_required' | 'full' | 'forbidden' | 'removed' | 'revoked'
  | 'replaced' | 'ended' | 'promoted' | 'rate_limited' | 'stale' | 'recheck' | 'other';

/** What a room's close means, from its code and reason. */
export function closeKind(code: number, reason = ''): CloseKind {
  const r = String(reason || '').toLowerCase();
  switch (code) {
    case CLOSE.AUTH:
      return r === CLOSE_REASON.expired ? 'expired' : 'auth';
    case CLOSE.FORBIDDEN:
      return r === CLOSE_REASON.mfaRequired ? 'mfa_required' : r === CLOSE_REASON.full ? 'full' : 'forbidden';
    case CLOSE.REMOVED:
      return r === CLOSE_REASON.revoked ? 'revoked' : 'removed';
    case CLOSE.REPLACED:
      return 'replaced';
    case CLOSE.ENDED:
      return 'ended';
    case CLOSE.PROMOTED:
      return 'promoted';
    case CLOSE.LIMITED:
      return r === CLOSE_REASON.stale ? 'stale' : 'rate_limited';
    case CLOSE.RECHECK:
      return 'recheck';
    default:
      return 'other';
  }
}

/** The code and reason a room closes with for `kind`. */
export function closeFor(kind: Exclude<CloseKind, 'other'>): { code: number; reason: string } {
  const map: Record<Exclude<CloseKind, 'other'>, [number, string]> = {
    expired: [CLOSE.AUTH, CLOSE_REASON.expired],
    auth: [CLOSE.AUTH, CLOSE_REASON.auth],
    mfa_required: [CLOSE.FORBIDDEN, CLOSE_REASON.mfaRequired],
    full: [CLOSE.FORBIDDEN, CLOSE_REASON.full],
    forbidden: [CLOSE.FORBIDDEN, CLOSE_REASON.forbidden],
    removed: [CLOSE.REMOVED, CLOSE_REASON.removed],
    revoked: [CLOSE.REMOVED, CLOSE_REASON.revoked],
    replaced: [CLOSE.REPLACED, CLOSE_REASON.replaced],
    ended: [CLOSE.ENDED, CLOSE_REASON.ended],
    promoted: [CLOSE.PROMOTED, CLOSE_REASON.promoted],
    rate_limited: [CLOSE.LIMITED, CLOSE_REASON.rateLimited],
    stale: [CLOSE.LIMITED, CLOSE_REASON.stale],
    recheck: [CLOSE.RECHECK, CLOSE_REASON.recheck],
  };
  const [code, reason] = map[kind];
  return { code, reason };
}

/**
 * What a client does after a close:
 * - `refresh`: get a fresh token, then reconnect (stop after a couple of failures);
 * - `step_up`: ask for the second factor (WS-5 StepUp), then reconnect;
 * - `stop`: tell the person why and stay closed;
 * - `backoff`: reconnect later, slowly;
 * - `reconnect`: reconnect now (a guest that was promoted reconnects with the account).
 */
export type CloseAdvice = 'refresh' | 'step_up' | 'stop' | 'backoff' | 'reconnect';

export const CLOSE_ADVICE: Record<CloseKind, CloseAdvice> = {
  expired: 'refresh',
  auth: 'refresh',
  mfa_required: 'step_up',
  full: 'backoff',
  forbidden: 'stop',
  removed: 'stop',
  revoked: 'stop',
  replaced: 'stop',
  ended: 'stop',
  promoted: 'reconnect',
  rate_limited: 'backoff',
  stale: 'reconnect',
  recheck: 'reconnect',
  other: 'reconnect',
};

/* --------------------------------------------------------- socket messages */

/** The fields Phase 0 adds to the room's `hello` (the rest is protocol.ts `MonServerMsg`). */
export interface HelloV2Fields {
  caps?: string[];
  /** The access token's expiry (ms); the room closes the socket 120 s after it unless re-authed. */
  exp?: number;
  /** A fresh nonce for `dev_hello` to sign. */
  nonce?: string;
}

/** Client → room on the window event `ds:token` (detail = the new access token), when `reauth` is listed. */
export interface ReauthMsg {
  t: 'reauth';
  token: string;
}
/** Room → client: the new expiry (ms). A refused re-auth closes the socket (4001 / 4003 / 4004). */
export interface ReauthOkMsg {
  t: 'reauth_ok';
  exp: number;
}
/** The window event the web app dispatches with each new access token. */
export const TOKEN_EVENT = 'ds:token';
/** Seconds of grace after a token's `exp` before the room closes its socket. */
export const EXPIRY_GRACE_S = 120;

/** Viewer → room, on change only. */
export interface ViewMsg {
  t: 'view';
  /** The screen is visible. */
  vis: boolean;
  /** The viewer has an open data channel to the camera. */
  dc: boolean;
  /** The camera it's looking at. */
  dev?: string;
}

/** Room → camera: someone needs its status from the room every 2 s. */
export interface LiveWantMsg {
  t: 'live_want';
  on: boolean;
}

/** Camera → room every 5 minutes (when `stats5` is listed), flushed at once on hello or reconnect. */
export interface StatsMsg<Row = Record<string, unknown>> {
  t: 'stats';
  rows: Row[];
}

/** Camera events (`event`, sound, vision) gain an id, so every path inserts once and viewers dedupe. */
export type WithEid<T> = T & { eid?: string };

export type DevicePlatform = 'web' | 'ios' | 'android' | 'watchos' | 'wearos';
export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['web', 'ios', 'android', 'watchos', 'wearos'];

/** RFC 8291 push keys, base64url. */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

/**
 * Any client → room after `hello`, when `e2e1` is listed: this device's keys. `sig` is an
 * ECDSA P-256 signature (64-byte r‖s, base64url) by `sigPub` over `helloSigInput`
 * (sealed.ts), which also covers `ecdhPub`, so the room can't swap the key that wraps the NMK.
 */
export interface DevHelloMsg {
  t: 'dev_hello';
  devId: string;
  /** Uncompressed P-256 points, base64url (65 bytes). */
  sigPub: string;
  ecdhPub: string;
  pushKey?: PushKeys;
  name: string;
  platform: DevicePlatform;
  /** The time signed (ms). */
  ts: number;
  sig: string;
}

/** A device the holder should wrap the NMK to. */
export interface KeyTarget {
  devId: string;
  ecdhPub: string;
  /** For the "new device" notice. */
  name?: string;
}
/** Room → key holder: wrap epoch `e` to this device. */
export interface KeyReqMsg extends KeyTarget {
  t: 'key_req';
  e: number;
}
/** Holder → room (to store and forward) and room → device (its own wrap). */
export interface KeyWrapMsg {
  t: 'key_wrap';
  devId: string;
  e: number;
  /** `wrapNmk` output, base64url. */
  blob: string;
}
export interface KeyWrapEntry {
  devId: string;
  blob: string;
}
/** First parent or camera device → room when no epoch exists; accepted by compare-and-set. */
export interface KeyInitMsg {
  t: 'key_init';
  e: 1;
  wraps: KeyWrapEntry[];
}
/** Room → holder: someone was removed; make epoch `e` for these devices. */
export interface KeyRotateReqMsg {
  t: 'key_rotate';
  e: number;
  devs: KeyTarget[];
}
/** Holder → room: the new epoch's wraps (compare-and-set on `e`). */
export interface KeyRotateMsg {
  t: 'key_rotate';
  e: number;
  wraps: KeyWrapEntry[];
}
/** Room → device: its `key_init` / `key_rotate` lost the compare-and-set; `e` is current. */
export interface KeyConflictMsg {
  t: 'key_conflict';
  e: number;
}
/** An old epoch still opens frames and signaling this long after a rotation. */
export const EPOCH_OVERLAP_MS = 60_000;

/** `rtc.d` between peers that both list `e2e1`: `openSignal` / `sealSignal` in sealed.ts. */
export interface SealedRtc {
  /** NMK epoch. */
  e: number;
  /** AES-GCM nonce, base64url (12 bytes). */
  iv: string;
  /** Ciphertext + tag, base64url. */
  ct: string;
  /** The sender's devId (also bound inside, as AAD). */
  f: string;
}

/** Room → glance socket (`mode:'glance'`), on each bump only. */
export interface GlanceMsg {
  t: 'glance';
  g: GlanceV1;
}

/** An ICE server as the rooms send it (no DOM `RTCIceServer` here). */
export interface WireIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
/** Room → client: fresh relay credentials (answering `{t:'ice'}`); ask again in `iceMs`. */
export interface IceMsg {
  t: 'ice';
  servers: WireIceServer[];
  iceMs?: number;
}

/* ------------------------------------------------- socket message checks */

/** devId = base64url(SHA-256(sigPub))[0:22] (sealed.ts `deviceId`). */
export const DEV_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** An uncompressed P-256 point (0x04 ‖ X ‖ Y, 65 bytes) in base64url: 87 characters starting "B". */
export const EC_POINT_RE = /^B[A-Za-z0-9_-]{86}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BLOB = 512;
const MAX_WRAPS = 64;

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const epochOk = (e: unknown): e is number => typeof e === 'number' && Number.isInteger(e) && e >= 1 && e <= 0xffffffff;
const blobOk = (b: unknown): b is string => typeof b === 'string' && b.length > 0 && b.length <= MAX_BLOB && B64URL_RE.test(b);

export function parseReauth(v: unknown): ReauthMsg | null {
  const m = obj(v);
  return m && m.t === 'reauth' && typeof m.token === 'string' && m.token.length > 0 && m.token.length <= 8192 ? { t: 'reauth', token: m.token } : null;
}

export function parseView(v: unknown): ViewMsg | null {
  const m = obj(v);
  if (!m || m.t !== 'view' || typeof m.vis !== 'boolean') return null;
  return { t: 'view', vis: m.vis, dc: m.dc === true, ...(typeof m.dev === 'string' && ID_RE.test(m.dev) ? { dev: m.dev } : {}) };
}

/** The shape of a `dev_hello` (its signature is checked with sealed.ts `verifyHello`). */
export function parseDevHello(v: unknown): DevHelloMsg | null {
  const m = obj(v);
  if (!m || m.t !== 'dev_hello') return null;
  if (typeof m.devId !== 'string' || !DEV_ID_RE.test(m.devId)) return null;
  if (typeof m.sigPub !== 'string' || !EC_POINT_RE.test(m.sigPub) || typeof m.ecdhPub !== 'string' || !EC_POINT_RE.test(m.ecdhPub)) return null;
  if (typeof m.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(m.sig)) return null;
  if (typeof m.ts !== 'number' || !Number.isSafeInteger(m.ts) || m.ts <= 0) return null;
  if (!(DEVICE_PLATFORMS as readonly unknown[]).includes(m.platform)) return null;
  const name = typeof m.name === 'string' ? m.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  const pk = obj(m.pushKey);
  const pushKey = pk && blobOk(pk.p256dh) && blobOk(pk.auth) ? { p256dh: pk.p256dh as string, auth: pk.auth as string } : undefined;
  return { t: 'dev_hello', devId: m.devId, sigPub: m.sigPub, ecdhPub: m.ecdhPub, ...(pushKey ? { pushKey } : {}), name: name || 'Device', platform: m.platform as DevicePlatform, ts: m.ts, sig: m.sig };
}

export function parseKeyWrap(v: unknown): KeyWrapMsg | null {
  const m = obj(v);
  if (!m || m.t !== 'key_wrap' || typeof m.devId !== 'string' || !DEV_ID_RE.test(m.devId) || !epochOk(m.e) || !blobOk(m.blob)) return null;
  return { t: 'key_wrap', devId: m.devId, e: m.e, blob: m.blob };
}

function parseWraps(v: unknown): KeyWrapEntry[] | null {
  if (!Array.isArray(v) || !v.length || v.length > MAX_WRAPS) return null;
  const out: KeyWrapEntry[] = [];
  for (const w of v) {
    const x = obj(w);
    if (!x || typeof x.devId !== 'string' || !DEV_ID_RE.test(x.devId) || !blobOk(x.blob)) return null;
    if (out.some((o) => o.devId === x.devId)) return null;
    out.push({ devId: x.devId, blob: x.blob });
  }
  return out;
}

export function parseKeyInit(v: unknown): KeyInitMsg | null {
  const m = obj(v);
  if (!m || m.t !== 'key_init' || m.e !== 1) return null;
  const wraps = parseWraps(m.wraps);
  return wraps ? { t: 'key_init', e: 1, wraps } : null;
}

/** A holder's rotation (with `wraps`); the room's request carries `devs` instead. */
export function parseKeyRotate(v: unknown): KeyRotateMsg | null {
  const m = obj(v);
  if (!m || m.t !== 'key_rotate' || !epochOk(m.e)) return null;
  const wraps = parseWraps(m.wraps);
  return wraps ? { t: 'key_rotate', e: m.e, wraps } : null;
}

/** True when `rtc.d` is sealed (and well formed). */
export function isSealedRtc(d: unknown): d is SealedRtc {
  const m = obj(d);
  return !!m && epochOk(m.e) && typeof m.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(m.iv) && blobOk2(m.ct) && typeof m.f === 'string' && DEV_ID_RE.test(m.f);
}
/** Sealed SDP can be several KB. */
const blobOk2 = (b: unknown): boolean => typeof b === 'string' && b.length > 0 && b.length <= 64 * 1024 && B64URL_RE.test(b);

/**
 * Sticky E2E (ADR D6.3): once this device holds an NMK for the nursery it refuses unsealed
 * signaling from it, so stripping capabilities can't downgrade a call. `open` = decrypt it,
 * `plain` = use as is (no key yet), `refuse` = drop it.
 */
export function rtcPolicy(holdsNmk: boolean, d: unknown): 'open' | 'plain' | 'refuse' {
  if (isSealedRtc(d)) return 'open';
  return holdsNmk ? 'refuse' : 'plain';
}

/* -------------------------------------------------------------------- HTTP */

/** Routes on the live Worker (the web app reaches them under `/live-api`). */
export const ROUTES = {
  glance: (nid: string) => `/api/monitor/${encodeURIComponent(nid)}/glance`,
  act: (nid: string) => `/api/monitor/${encodeURIComponent(nid)}/act`,
  members: (nid: string) => `/api/monitor/${encodeURIComponent(nid)}/members`,
  peek: (nid: string) => `/api/monitor/${encodeURIComponent(nid)}/peek`,
  kick: '/api/me/kick',
  devicesEnroll: '/api/devices/enroll',
  devicesToken: '/api/devices/token',
  devicesPush: '/api/devices/push',
  device: (id: string) => `/api/devices/${encodeURIComponent(id)}`,
  apnsProbe: '/api/ops/apns-probe',
} as const;

/** Authorization schemes and headers. */
export const AUTH = {
  bearer: 'Bearer',
  /** A single-use service-worker action token (`Authorization: DS-Act <token>`). */
  act: 'DS-Act',
  /** Stream Studio event keys out of URLs (WS-11). */
  event: 'DS-Event',
  /** A device's proof of possession: ES256 over `method\npath\nts\nsha256(body)`. */
  proofHeader: 'DS-Proof',
  opsHeader: 'x-ops-key',
} as const;

export const ACT_ACTIONS = ['ack', 'resolve', 'soothe', 'soothe_stop', 'duty_on', 'duty_off'] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];

/** The `can` bit an action needs — the same rule the glance shows, so a button never lies. */
export const ACT_NEEDS: Record<ActAction, number> = {
  ack: CAN.ack,
  resolve: CAN.ack,
  soothe: CAN.soothe,
  soothe_stop: CAN.soothe,
  duty_on: CAN.duty,
  duty_off: CAN.duty,
};

export const actAllowed = (can: number, a: ActAction): boolean => (can & ACT_NEEDS[a]) !== 0;

/**
 * POST /api/monitor/:nid/act. `id` is a client UUID: the same id twice acts once (the
 * second answer is the first). `v`: soothe → `{sound?, min?}`; duty_on → hours (1–24).
 */
export interface ActRequest {
  a: ActAction;
  inc?: string;
  v?: unknown;
  id: string;
}
export type ActError = 'bad_request' | 'unauthorized' | 'forbidden' | 'mfa_required' | 'not_found' | 'unavailable';
export interface ActResponse {
  ok: boolean;
  /** The glance after the action (the caller's own view). */
  g?: GlanceV1;
  /** This `id` was seen before; the action wasn't repeated. */
  dup?: boolean;
  error?: ActError;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A valid act request, or null. Bounded: `v` is at most 200 characters of JSON. */
export function parseActRequest(body: unknown): ActRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!(ACT_ACTIONS as readonly unknown[]).includes(b.a) || !isUuid(b.id)) return null;
  if (b.inc != null && (typeof b.inc !== 'string' || !ID_RE.test(b.inc))) return null;
  // "I'm on it" without an incident answers the glance's current alert; "all clear" must name one.
  if (b.a === 'resolve' && b.inc == null) return null;
  const out: ActRequest = { a: b.a as ActAction, id: (b.id as string).toLowerCase() };
  if (typeof b.inc === 'string') out.inc = b.inc;
  if (b.v !== undefined) {
    let size: number;
    try {
      size = JSON.stringify(b.v)?.length ?? 0;
    } catch {
      return null;
    }
    if (size > 200) return null;
    if (b.a === 'duty_on' && b.v !== null && (typeof b.v !== 'number' || !Number.isFinite(b.v) || b.v < 1 || b.v > 24)) return null;
    out.v = b.v;
  }
  return out;
}

/** POST /api/monitor/:nid/members (requires `aal2`): Worker → RPC → room `/x/members`. */
export interface MembersRequest {
  op: 'add' | 'remove' | 'role';
  /** The member's user id. */
  user: string;
  role?: MonRole;
  label?: string | null;
}
export interface MembersResponse {
  ok: boolean;
  /** User ids whose membership changed (the room kicks, prunes push and rotates the NMK for these). */
  changed?: string[];
  error?: string;
}

const ROLES: readonly MonRole[] = ['parent', 'caregiver', 'viewer'];

export function parseMembersRequest(body: unknown): MembersRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.op !== 'add' && b.op !== 'remove' && b.op !== 'role') return null;
  if (!isUuid(b.user)) return null;
  if (b.role != null && !(ROLES as readonly unknown[]).includes(b.role)) return null;
  if ((b.op === 'add' || b.op === 'role') && b.role == null) return null;
  if (b.label != null && (typeof b.label !== 'string' || b.label.length > 40)) return null;
  return {
    op: b.op,
    user: (b.user as string).toLowerCase(),
    ...(b.role != null ? { role: b.role as MonRole } : {}),
    ...(b.label !== undefined ? { label: (b.label as string | null) ?? null } : {}),
  };
}

/** POST /api/me/kick: closes every socket of the caller's, everywhere, before a global sign-out. */
export interface KickResponse {
  ok: boolean;
  /** Nurseries told. */
  rooms: number;
  /** Sockets closed across them. */
  closed: number;
}

/** Worker → room `/x/kick` (internal). */
export interface XKickBody {
  uid: string;
  why: 'signout' | 'secure' | 'removed';
}
/** Room → Worker: what it closed, and the TURN usernames to revoke. */
export interface XKickResult {
  closed: number;
  turn: string[];
}
/** Worker → room `/x/members` (internal): re-check these members now. */
export interface XMembersBody {
  ids: string[];
  /** Who made the change (for the parents' notice). */
  by?: string;
}

/** POST /api/devices/enroll (a signed-in phone, for itself or its watch). */
export interface EnrollRequest {
  sigPub: string;
  ecdhPub?: string;
  platform: DevicePlatform;
  name: string;
  nurseries: { id: string; can: number }[];
  /** App Attest / Play Integrity token: a risk signal, not authentication. */
  attest?: string;
}
export interface EnrollResponse {
  grant: string;
  devId: string;
}
/** POST /api/devices/token: a grant plus a signature by the device key → a 10-minute access token. */
export interface TokenRequest {
  grant: string;
  ts: number;
  sig: string;
}
export interface TokenResponse {
  access: string;
  /** Expiry (ms). */
  exp: number;
  nid: string[];
}

export type PushKind = 'webpush' | 'apns' | 'apns-la' | 'apns-voip' | 'fcm';
export const PUSH_KINDS: readonly PushKind[] = ['webpush', 'apns', 'apns-la', 'apns-voip', 'fcm'];

/** POST /api/devices/push: where this device receives pushes, and its RFC 8291 keys. */
export interface DevicePushRequest {
  kind: PushKind;
  token: string;
  enc: PushKeys;
}

/** POST /api/ops/apns-probe (admin). Pass = an APNs error body with an `apns-id`. */
export interface ApnsProbeResult {
  status: number;
  apnsId: string | null;
  body: string;
}

/* ------------------------------------------------------------------- push */

/** What a web push payload adds for the "I'm on it" action and the acknowledgement replacement. */
export interface WebPushActFields {
  /** A single-use action token (`Authorization: DS-Act <act>`). */
  act?: string;
  /** The incident; also the notification tag that the acknowledgement replacement reuses. */
  inc?: string;
  /** The glance sequence at send time. */
  q?: number;
}

/**
 * The data of a native push (APNs payload field / FCM data message): only `e` is secret.
 * `s` (u urgent · w warn · i info), `i` (incident id) and `q` let the OS group, collapse
 * and order notifications without decrypting; none of them names anyone.
 */
export interface PushEnvelope {
  /** RFC 8291 aes128gcm of `PushInner` JSON to this device's keys, base64url. */
  e: string;
  s?: 'u' | 'w' | 'i';
  i?: string;
  q?: string;
}

/** What `PushEnvelope.e` decrypts to. */
export interface PushInner {
  /** Composed with `forPush` (no nursery name). */
  g: GlanceV1;
  title: string;
  body: string;
  /** Present on urgent alerts: the "I'm on it" token. */
  act?: string;
  /** This replaces the notification for the same incident quietly ("Dad's on it"). */
  replace?: boolean;
}

/** Visible fallback text when a device can't decrypt (ADR D3). */
export const PUSH_FALLBACK = { title: 'DreamStream', body: 'Nursery alert' } as const;
