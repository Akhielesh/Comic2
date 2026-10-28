/**
 * Apple Push Notification service, sent directly from the Worker (ADR 0006 D3).
 *
 * APNs only speaks HTTP/2. workerd itself has no HTTP/2 client, but production Worker
 * `fetch` leaves through Cloudflare's proxy, which upgrades — `probe.ts` checks that
 * from production before anything here is switched on (and FCM-for-iOS is the
 * fallback the router uses if it isn't). Dormant until `APNS_KEY_P8`, `APNS_KEY_ID`
 * and `APNS_TEAM_ID` are set and a device registers a token.
 *
 * - **Provider token:** an ES256 JWT `{alg, kid}.{iss, iat}` signed with the team's .p8
 *   key (reusing webpush.ts's signer). Apple wants it refreshed at most every 20 min and
 *   at least every 60 min. We cache it for 50 min, with `iat` aligned to a 50-minute
 *   window, so every isolate presents the same `iat` and Apple never sees churn
 *   (`TooManyProviderTokenUpdates`). An `ExpiredProviderToken` answer mints a fresh
 *   one and retries once.
 * - **Outcomes:** each documented APNs reason maps to `gone` (prune the token),
 *   `retry` (keep it; provider busy), `fatal` (our request or credentials are wrong —
 *   keep it) or `config` (the token isn't for our topic — a wrong bundle id; keep it and
 *   alert). Only an answer about the token itself prunes. See `apnsReasonOutcome`.
 * - **Privacy:** nothing here composes text. The router puts only generic words, the
 *   urgency, an opaque incident id and the sealed envelope `e` into the payload.
 */
import { signJwtES256 } from '../webpush';
import { importPkcs8 } from './keys';
import { DEFAULT_SEND_TIMEOUT_MS, errText, retryAfterSec, timeoutSignal, type SendOpts, type SendOutcome } from './types';

export type ApnsPushType = 'alert' | 'liveactivity' | 'voip' | 'widgets' | 'background';
export type ApnsEnv = 'production' | 'sandbox';

export const APNS_HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** The iOS app's bundle id (ADR 0006 owner action #8). */
export const DEFAULT_APNS_BUNDLE = 'ai.dreamstreamstudio.streamstudio';

/** Apple's payload limits: 4 KB, 5 KB for VoIP. */
export const APNS_MAX_PAYLOAD: Record<ApnsPushType, number> = { alert: 4096, liveactivity: 4096, voip: 5120, widgets: 4096, background: 4096 };

/** Provider tokens are reused for 50 minutes (Apple: refresh between 20 and 60 minutes). */
export const APNS_TOKEN_TTL_SEC = 50 * 60;

export interface ApnsConfig {
  /** The .p8 auth key (PKCS#8 PEM), from the `APNS_KEY_P8` secret. */
  keyP8: string;
  /** 10-character key id (`APNS_KEY_ID`). */
  keyId: string;
  /** 10-character team id (`APNS_TEAM_ID`). */
  teamId: string;
  /** App bundle id; the per-type topics derive from it. */
  bundle: string;
}

export interface ApnsRequest {
  /** Device (or Live Activity / push-to-start) token, hex. */
  token: string;
  type: ApnsPushType;
  /** Overrides the topic derived from the bundle (e.g. the watch app's bundle for direct-to-watch). */
  topic?: string;
  /** 10 = now; 5 = when power allows; 1 = lowest (Live Activity only). */
  priority?: 10 | 5 | 1;
  /** ≤ 64 bytes; a newer push with the same id replaces the older one on the device. */
  collapseId?: string;
  /** Unix seconds after which APNs stops trying; 0 = deliver once or drop. */
  expiration?: number;
  payload: Record<string, unknown>;
  /** Which APNs environment issued the token (debug builds: sandbox). Default production. */
  env?: ApnsEnv;
}

export interface ApnsResult {
  outcome: SendOutcome;
  /** HTTP status; 0 when no response came back. */
  status: number;
  /** APNs `reason`, or a local one (`MalformedToken`, `PayloadTooLarge`, `Network`, `NoKey`). */
  reason?: string;
  apnsId?: string;
  /** 410 only: when APNs last confirmed the token was dead (ms). A token registered after this is not gone. */
  invalidSince?: number;
  retryAfterSec?: number;
  error?: string;
}

/** The `apns-topic` each push type needs. */
export function apnsTopic(bundle: string, type: ApnsPushType): string {
  switch (type) {
    case 'voip':
      return `${bundle}.voip`;
    case 'liveactivity':
      return `${bundle}.push-type.liveactivity`;
    case 'widgets':
      return `${bundle}.push-type.widgets`;
    default:
      return bundle;
  }
}

const DEFAULT_PRIORITY: Record<ApnsPushType, 10 | 5> = { alert: 10, voip: 10, liveactivity: 5, widgets: 5, background: 5 };

/** Device and activity tokens are hex (32 bytes today; Apple says the length may grow). It goes in the URL path, so nothing else passes. */
export function isApnsToken(t: unknown): t is string {
  return typeof t === 'string' && /^[0-9a-fA-F]{64,200}$/.test(t);
}

const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'ExpiredToken']);
/** The token and our `apns-topic` don't match: what a wrong `APNS_BUNDLE` (or watch bundle) gets for every token. */
const CONFIG_REASONS = new Set(['DeviceTokenNotForTopic', 'TopicDisallowed', 'BadTopic', 'MissingTopic']);
const RETRY_REASONS = new Set(['TooManyRequests', 'TooManyProviderTokenUpdates', 'InternalServerError', 'ServiceUnavailable', 'Shutdown', 'IdleTimeout']);

/**
 * APNs status + reason → outcome (Apple, "Handling notification responses from APNs").
 *  - gone: 410 (Unregistered, ExpiredToken); 400 BadDeviceToken (invalid, or minted for the
 *    other environment — each sub carries its own `env`, so no setting of ours causes it).
 *  - config: DeviceTokenNotForTopic, TopicDisallowed, BadTopic, MissingTopic. The token
 *    may be fine; our topic is wrong, and it would be wrong for every device. Never prunes.
 *  - retry: 429, 500, 503, and anything 5xx.
 *  - fatal: every other 4xx — our payload, headers or provider token is wrong.
 */
export function apnsReasonOutcome(status: number, reason?: string): SendOutcome {
  if (status === 200) return 'ok';
  if (reason && CONFIG_REASONS.has(reason)) return 'config';
  if (status === 410) return 'gone';
  if (reason && GONE_REASONS.has(reason)) return 'gone';
  if (status === 429 || status >= 500 || (reason && RETRY_REASONS.has(reason))) return 'retry';
  return 'fatal';
}

// ------------------------------------------------------------ provider token
const tokens = new Map<string, { jwt: string; iat: number }>();

/**
 * The provider token for this key, cached per isolate. `iat` is aligned to a 50-minute
 * window so isolates agree; `fresh` (after `ExpiredProviderToken`) mints one at `now`.
 */
export async function apnsProviderToken(cfg: ApnsConfig, nowMs = Date.now(), fresh = false): Promise<string> {
  const id = `${cfg.teamId}:${cfg.keyId}`;
  const nowSec = Math.floor(nowMs / 1000);
  const hit = tokens.get(id);
  if (!fresh && hit && nowSec - hit.iat < APNS_TOKEN_TTL_SEC && nowSec >= hit.iat) return hit.jwt;
  const iat = fresh ? nowSec : nowSec - (nowSec % APNS_TOKEN_TTL_SEC);
  const key = await importPkcs8(cfg.keyP8, 'ES256');
  const jwt = await signJwtES256({ alg: 'ES256', kid: cfg.keyId }, { iss: cfg.teamId, iat }, key);
  tokens.set(id, { jwt, iat });
  return jwt;
}

/** Tests only. */
export function resetApnsTokens(): void {
  tokens.clear();
}

/** The APNs secrets, or null while they're not set (the transport stays dormant). */
export function apnsConfigFromEnv(env: { APNS_KEY_P8?: string; APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_BUNDLE?: string }): ApnsConfig | null {
  const keyP8 = env.APNS_KEY_P8?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  if (!keyP8 || !keyId || !teamId) return null;
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId) || !keyP8.includes('PRIVATE KEY')) return null;
  const bundle = env.APNS_BUNDLE?.trim() || DEFAULT_APNS_BUNDLE;
  return { keyP8, keyId, teamId, bundle };
}

// ------------------------------------------------------------------- send
const te = new TextEncoder();

/** Send one push. Never throws; see `ApnsResult`. */
export async function sendApns(req: ApnsRequest, cfg: ApnsConfig, opts: SendOpts = {}): Promise<ApnsResult> {
  if (!isApnsToken(req.token)) return { outcome: 'gone', status: 0, reason: 'MalformedToken' };
  const body = JSON.stringify(req.payload);
  if (te.encode(body).length > APNS_MAX_PAYLOAD[req.type]) return { outcome: 'fatal', status: 0, reason: 'PayloadTooLarge' };
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? Date.now();
  const url = `${APNS_HOSTS[req.env ?? 'production']}/3/device/${req.token.toLowerCase()}`;
  const headers: Record<string, string> = {
    'apns-push-type': req.type,
    'apns-topic': req.topic ?? apnsTopic(cfg.bundle, req.type),
    'apns-priority': String(req.priority ?? DEFAULT_PRIORITY[req.type]),
    'content-type': 'application/json',
  };
  if (req.expiration != null) headers['apns-expiration'] = String(Math.max(0, Math.floor(req.expiration)));
  if (req.collapseId) headers['apns-collapse-id'] = clipBytes(req.collapseId, 64);

  const post = async (fresh: boolean): Promise<ApnsResult> => {
    let jwt: string;
    try {
      jwt = await apnsProviderToken(cfg, now, fresh);
    } catch (err) {
      return { outcome: 'fatal', status: 0, reason: 'NoKey', error: errText(err) };
    }
    try {
      const res = await fetcher(url, { method: 'POST', headers: { ...headers, authorization: `bearer ${jwt}` }, body, signal: timeoutSignal(opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS) });
      return await readApns(res, now);
    } catch (err) {
      // No HTTP/2 answer at all (network, timeout, or a proxy that couldn't speak h2).
      return { outcome: 'retry', status: 0, reason: 'Network', error: errText(err) };
    }
  };

  const first = await post(false);
  if (first.status === 403 && first.reason === 'ExpiredProviderToken') return post(true);
  return first;
}

async function readApns(res: Response, now: number): Promise<ApnsResult> {
  const apnsId = res.headers.get('apns-id') ?? undefined;
  let reason: string | undefined;
  let invalidSince: number | undefined;
  if (res.status !== 200) {
    try {
      const j = (await res.json()) as { reason?: unknown; timestamp?: unknown };
      if (typeof j.reason === 'string') reason = j.reason.slice(0, 64);
      if (typeof j.timestamp === 'number' && Number.isFinite(j.timestamp)) invalidSince = j.timestamp;
    } catch {
      /* no JSON body */
    }
  }
  const out: ApnsResult = { outcome: apnsReasonOutcome(res.status, reason), status: res.status };
  if (reason) out.reason = reason;
  if (apnsId) out.apnsId = apnsId;
  if (invalidSince != null) out.invalidSince = invalidSince;
  const ra = retryAfterSec(res.headers, now);
  if (ra != null) out.retryAfterSec = ra;
  return out;
}

function clipBytes(s: string, max: number): string {
  let out = s;
  while (te.encode(out).length > max) out = out.slice(0, -1);
  return out;
}

// --------------------------------------------------------------- payloads
export type Interruption = 'passive' | 'active' | 'time-sensitive' | 'critical';

/** The visible fields of an alert push. Only generic words: the real text is in `e`. */
export interface ApnsAlertFields {
  title: string;
  body: string;
  interruption: Interruption;
  /** Notification category (`DS_URGENT`, `DS_URGENT_VIEW`, `DS_WARN`); actions come from it. */
  category?: string;
  /** Opaque grouping id (never a name). */
  thread?: string;
  /** Play a sound (the NSE may change which). Critical alerts always sound. */
  sound?: boolean;
  /** The sealed envelope and its visible companions (see envelope.ts / wire.ts PushEnvelope). */
  e?: string;
  s?: 'u' | 'w' | 'i';
  i?: string;
  q?: string;
}

/** `{aps, e, s, i, q}` for an alert. `mutable-content` lets the Notification Service Extension decrypt `e`. */
export function apnsAlertPayload(f: ApnsAlertFields): Record<string, unknown> {
  const aps: Record<string, unknown> = { alert: { title: f.title, body: f.body }, 'interruption-level': f.interruption };
  if (f.e) aps['mutable-content'] = 1;
  if (f.category) aps.category = f.category;
  if (f.thread) aps['thread-id'] = f.thread;
  if (f.interruption === 'critical') aps.sound = { critical: 1, name: 'default', volume: 1 };
  else if (f.sound) aps.sound = 'default';
  const out: Record<string, unknown> = { aps };
  if (f.e) out.e = f.e;
  if (f.s) out.s = f.s;
  if (f.i) out.i = f.i;
  if (f.q) out.q = f.q;
  return out;
}

export interface ApnsLiveActivityFields {
  event: 'start' | 'update' | 'end';
  /** Seconds; the device ignores an update older than the one it has. */
  timestamp: number;
  contentState: Record<string, unknown>;
  staleDate?: number;
  dismissalDate?: number;
  relevanceScore?: number;
  /** Push-to-start only. */
  attributesType?: string;
  attributes?: Record<string, unknown>;
  /** Push-to-start needs one (iOS 17.2+); an update may carry one to light the screen. */
  alert?: { title: string; body: string };
}

/** `{aps: {timestamp, event, content-state, …}}` for an ActivityKit push. */
export function apnsLiveActivityPayload(f: ApnsLiveActivityFields): Record<string, unknown> {
  const aps: Record<string, unknown> = { timestamp: Math.floor(f.timestamp), event: f.event, 'content-state': f.contentState };
  if (f.staleDate != null) aps['stale-date'] = Math.floor(f.staleDate);
  if (f.dismissalDate != null) aps['dismissal-date'] = Math.floor(f.dismissalDate);
  if (f.relevanceScore != null) aps['relevance-score'] = f.relevanceScore;
  if (f.event === 'start') {
    aps['attributes-type'] = f.attributesType ?? 'NurseryAttributes';
    aps.attributes = f.attributes ?? {};
  }
  if (f.alert) aps.alert = { title: f.alert.title, body: f.alert.body };
  return { aps };
}
