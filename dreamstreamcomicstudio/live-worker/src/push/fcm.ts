/**
 * Firebase Cloud Messaging HTTP v1 (ADR 0006 D3): Android phones and Wear OS, and iPhones
 * if the APNs probe fails (an `apns` block, incl. Live Activities via `live_activity_token`).
 * Dormant until the `FCM_SA_JSON` secret (a service account with only the FCM sender role,
 * owner action #13) is set and a device registers a token.
 *
 * - **Auth:** the service account signs an RS256 JWT, exchanged at Google's token endpoint
 *   for an OAuth access token, cached per isolate for up to 55 minutes. Concurrent senders
 *   share one exchange. A 401 from FCM drops the cached token and retries once.
 * - **Messages:** data-only and high priority for alerts — the app decrypts `e` and builds
 *   the notification itself, so Google sees no text. `collapse_key` = incident id.
 * - **Outcomes:** `UNREGISTERED` and `SENDER_ID_MISMATCH` (and an INVALID_ARGUMENT that names
 *   the token) are `gone`; quota and availability errors are `retry`; anything else about our
 *   request or credentials is `fatal` and never prunes a token. A payload bug can't wipe the
 *   registry: only an error that names the token prunes it.
 */
import { importPkcs8, signJwtRS256 } from './keys';
import { DEFAULT_SEND_TIMEOUT_MS, errText, retryAfterSec, timeoutSignal, type SendOpts, type SendOutcome } from './types';

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';
/** OAuth tokens are reused for up to 55 minutes (they live 60). */
export const FCM_TOKEN_TTL_SEC = 55 * 60;
/** FCM's data payload limit. */
export const FCM_MAX_DATA_BYTES = 4096;

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PKCS#8 PEM (RSA). */
  privateKey: string;
  keyId?: string;
  tokenUri: string;
}

/** The service account from the `FCM_SA_JSON` secret, or null while unset/unusable (dormant). */
export function fcmConfigFromEnv(env: { FCM_SA_JSON?: string }): FcmConfig | null {
  const raw = env.FCM_SA_JSON?.trim();
  if (!raw) return null;
  let sa: Record<string, unknown>;
  try {
    sa = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const projectId = typeof sa.project_id === 'string' ? sa.project_id : '';
  const clientEmail = typeof sa.client_email === 'string' ? sa.client_email : '';
  const privateKey = typeof sa.private_key === 'string' ? sa.private_key : '';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) || !/^[^@\s]+@[^@\s]+$/.test(clientEmail) || !privateKey.includes('PRIVATE KEY')) return null;
  // Only Google's own token endpoint: a secret must not be able to point the Worker anywhere else.
  const tokenUri = typeof sa.token_uri === 'string' && sa.token_uri === GOOGLE_TOKEN_URI ? sa.token_uri : GOOGLE_TOKEN_URI;
  return { projectId, clientEmail, privateKey, keyId: typeof sa.private_key_id === 'string' ? sa.private_key_id : undefined, tokenUri };
}

// ------------------------------------------------------------- OAuth token
type TokenAnswer = { token: string } | { outcome: 'retry' | 'fatal'; error: string };

const cache = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<TokenAnswer>>();
/** Only for a refused service account (fatal): don't re-ask Google on every alert for a minute. */
const refused = new Map<string, { until: number; error: string }>();

/** Tests only. */
export function resetFcmTokens(): void {
  cache.clear();
  inflight.clear();
  refused.clear();
}

/** An OAuth access token for FCM, cached per isolate; `fresh` skips the cache (after a 401). */
export async function fcmAccessToken(cfg: FcmConfig, opts: SendOpts & { fresh?: boolean } = {}): Promise<TokenAnswer> {
  const now = opts.now ?? Date.now();
  const id = cfg.clientEmail;
  const hit = cache.get(id);
  if (!opts.fresh && hit && now < hit.exp) return { token: hit.token };
  const no = refused.get(id);
  if (!opts.fresh && no && now < no.until) return { outcome: 'fatal', error: no.error };
  const running = inflight.get(id);
  if (running) return running;
  const p = exchange(cfg, now, opts).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function exchange(cfg: FcmConfig, now: number, opts: SendOpts): Promise<TokenAnswer> {
  const fetcher = opts.fetcher ?? fetch;
  let assertion: string;
  try {
    const key = await importPkcs8(cfg.privateKey, 'RS256');
    const iat = Math.floor(now / 1000);
    const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
    if (cfg.keyId) header.kid = cfg.keyId;
    assertion = await signJwtRS256(header, { iss: cfg.clientEmail, scope: FCM_SCOPE, aud: cfg.tokenUri, iat, exp: iat + 3600 }, key);
  } catch (err) {
    return refuse(cfg, now, `service account key: ${errText(err)}`);
  }
  let res: Response;
  try {
    res = await fetcher(cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
      signal: timeoutSignal(opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'retry', error: `token endpoint: ${errText(err)}` };
  }
  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.ok && typeof j.access_token === 'string' && j.access_token) {
    const life = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600;
    // Up to 55 minutes, and always 5 minutes short of Google's own expiry.
    const exp = now + Math.max(60, Math.min(FCM_TOKEN_TTL_SEC, life - 300)) * 1000;
    cache.set(cfg.clientEmail, { token: j.access_token, exp });
    refused.delete(cfg.clientEmail);
    return { token: j.access_token };
  }
  const why = `token endpoint ${res.status}${typeof j.error === 'string' ? ` ${j.error}` : ''}`;
  if (res.status === 429 || res.status >= 500) return { outcome: 'retry', error: why };
  return refuse(cfg, now, why);
}

function refuse(cfg: FcmConfig, now: number, error: string): TokenAnswer {
  refused.set(cfg.clientEmail, { until: now + 60_000, error });
  return { outcome: 'fatal', error };
}

// -------------------------------------------------------------------- send
export interface FcmRequest {
  /** The device's FCM registration token. */
  token: string;
  /** Data message (all values strings): the envelope `{e, s, i, q}`. */
  data?: Record<string, string>;
  /** Android delivery priority. `high` wakes the device from Doze (alerts only). */
  androidPriority?: 'high' | 'normal';
  /** Seconds FCM keeps trying (Android). */
  ttl?: number;
  /** Android collapse key (incident id): a newer message replaces an undelivered older one. */
  collapseKey?: string;
  /** iOS through FCM (the APNs-probe fallback): APNs headers and payload, and a Live Activity token. */
  apns?: { headers?: Record<string, string>; payload?: Record<string, unknown>; liveActivityToken?: string };
}

export interface FcmResult {
  outcome: SendOutcome;
  /** HTTP status; 0 when no response came back. */
  status: number;
  /** FCM `errorCode` (UNREGISTERED, …), the RPC `status` (UNAUTHENTICATED, …), or a local reason. */
  errorCode?: string;
  /** `projects/<id>/messages/<id>` on success. */
  name?: string;
  retryAfterSec?: number;
  error?: string;
}

/** Registration tokens are long URL-safe strings (with `:`). */
export function isFcmToken(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_:\-]{20,4096}$/.test(t);
}

const RESERVED_DATA = /^(from|notification|message_type|google\..*|gcm\..*)$/;

interface FcmErrorBody {
  error?: { code?: number; status?: string; message?: string; details?: { '@type'?: string; errorCode?: string; fieldViolations?: { field?: string }[] }[] };
}

/** FCM v1 error → outcome (Firebase "FCM error codes"). `auth` = our OAuth token was refused. */
export function fcmErrorOutcome(status: number, body: unknown): { outcome: SendOutcome | 'auth'; errorCode?: string } {
  const err = (body as FcmErrorBody | null)?.error;
  const details = Array.isArray(err?.details) ? err!.details : [];
  const fcmCode = details.find((d) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('google.firebase.fcm.v1.FcmError'))?.errorCode;
  const namesToken =
    details.some((d) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('google.rpc.BadRequest') && (d.fieldViolations ?? []).some((v) => v?.field === 'message.token')) ||
    /registration token is not a valid FCM registration token/i.test(err?.message ?? '');
  const code = fcmCode ?? err?.status;
  switch (fcmCode) {
    case 'UNREGISTERED':
    case 'SENDER_ID_MISMATCH':
      return { outcome: 'gone', errorCode: fcmCode };
    case 'INVALID_ARGUMENT':
      return { outcome: namesToken ? 'gone' : 'fatal', errorCode: fcmCode };
    case 'QUOTA_EXCEEDED':
    case 'UNAVAILABLE':
    case 'INTERNAL':
      return { outcome: 'retry', errorCode: fcmCode };
    case 'THIRD_PARTY_AUTH_ERROR':
      return { outcome: 'fatal', errorCode: fcmCode };
  }
  if (status === 401) return { outcome: 'auth', errorCode: code ?? 'UNAUTHENTICATED' };
  if (status === 400 && namesToken) return { outcome: 'gone', errorCode: code ?? 'INVALID_ARGUMENT' };
  if (status === 429 || status >= 500) return { outcome: 'retry', errorCode: code };
  return { outcome: 'fatal', errorCode: code };
}

const te = new TextEncoder();

/** Send one message. Never throws; see `FcmResult`. */
export async function sendFcm(req: FcmRequest, cfg: FcmConfig, opts: SendOpts = {}): Promise<FcmResult> {
  if (!isFcmToken(req.token)) return { outcome: 'gone', status: 0, errorCode: 'MalformedToken' };
  const data = req.data ?? {};
  for (const [k, v] of Object.entries(data)) {
    if (RESERVED_DATA.test(k) || typeof v !== 'string') return { outcome: 'fatal', status: 0, errorCode: 'BadData', error: `data key ${k}` };
  }
  if (te.encode(JSON.stringify(data)).length > FCM_MAX_DATA_BYTES) return { outcome: 'fatal', status: 0, errorCode: 'PayloadTooLarge' };

  const message: Record<string, unknown> = { token: req.token };
  if (Object.keys(data).length) message.data = data;
  if (req.androidPriority || req.ttl != null || req.collapseKey) {
    const android: Record<string, unknown> = {};
    if (req.androidPriority) android.priority = req.androidPriority === 'high' ? 'HIGH' : 'NORMAL';
    if (req.ttl != null) android.ttl = `${Math.max(0, Math.floor(req.ttl))}s`;
    if (req.collapseKey) android.collapse_key = req.collapseKey.slice(0, 64);
    message.android = android;
  }
  if (req.apns) {
    const apns: Record<string, unknown> = {};
    if (req.apns.headers) apns.headers = req.apns.headers;
    if (req.apns.payload) apns.payload = req.apns.payload;
    if (req.apns.liveActivityToken) apns.live_activity_token = req.apns.liveActivityToken;
    message.apns = apns;
  }
  const body = JSON.stringify({ message });
  const url = `${FCM_ENDPOINT}/${cfg.projectId}/messages:send`;
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? Date.now();

  const post = async (fresh: boolean): Promise<FcmResult & { auth?: boolean }> => {
    const tok = await fcmAccessToken(cfg, { ...opts, fresh });
    if (!('token' in tok)) return { outcome: tok.outcome, status: 0, errorCode: 'OAuth', error: tok.error };
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
        body,
        signal: timeoutSignal(opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      return { outcome: 'retry', status: 0, errorCode: 'Network', error: errText(err) };
    }
    let j: unknown = null;
    try {
      j = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.ok) {
      const name = (j as { name?: unknown } | null)?.name;
      return { outcome: 'ok', status: res.status, ...(typeof name === 'string' ? { name } : {}) };
    }
    const m = fcmErrorOutcome(res.status, j);
    const out: FcmResult & { auth?: boolean } = { outcome: m.outcome === 'auth' ? 'fatal' : m.outcome, status: res.status };
    if (m.errorCode) out.errorCode = m.errorCode;
    const ra = retryAfterSec(res.headers, now);
    if (ra != null) out.retryAfterSec = ra;
    if (m.outcome === 'auth') out.auth = true;
    return out;
  };

  const first = await post(false);
  if (first.auth) {
    // Our cached OAuth token was refused (revoked, or the clock moved): mint a fresh one, once.
    const second = await post(true);
    delete second.auth;
    return second;
  }
  delete first.auth;
  return first;
}
