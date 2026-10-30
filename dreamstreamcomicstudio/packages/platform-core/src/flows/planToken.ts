/**
 * Plan tokens (plan §5.7): a person's approval of a flow plan, signed by the host and good for ONE run.
 *
 * Payload `{v, sub, iat, exp, reservationId, planHash}`: who approved (the pseudonymous `sub`), until when
 * (`exp ≤ iat + 15 min`), which ledger reservation pays for it, and the canonical hash of the exact plan. The token
 * is `base64url(payload) "." base64url(HMAC-SHA256(k, "platform-plan-v1." + payload))`, where `k` is derived from the
 * host's injected key, so a plan token can never be confused with any other signed value the host makes.
 *
 * Single use is not in the token: at resume the host claims the reservation (`MeterPort.claim`), and a second resume
 * finds it used (409). An expired token is refused with 403; a tampered or foreign one with 401.
 */
import { base64urlDecode, base64urlEncode, canonicalJson, hmacSha256, inputHash, isInputHash, timingSafeEqual, utf8Bytes, utf8Decode } from '../audit/inputHash.js';

/** The longest an approval lasts. */
export const PLAN_TOKEN_TTL_MAX_S = 15 * 60;
/** A host key shorter than this is refused (it would make the HMAC guessable). */
export const PLAN_TOKEN_KEY_MIN_BYTES = 32;
/** How far a token's `iat` may sit in the future (clock skew between host instances). */
export const PLAN_TOKEN_SKEW_S = 60;

const DOMAIN = 'platform-plan-v1';
const SUBJECT = /^[A-Za-z0-9._:-]{1,128}$/;

export interface PlanTokenPayload {
  v: 1;
  sub: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
  reservationId: string;
  planHash: string;
}

export class PlanTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanTokenError';
  }
}

/** The canonical hash of a plan (`sha256:<hex>` of its canonical JSON). */
export const planHash = (plan: unknown): string => inputHash(plan);

const keyBytes = (key: string | Uint8Array): Uint8Array => {
  const bytes = typeof key === 'string' ? utf8Bytes(key) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length < PLAN_TOKEN_KEY_MIN_BYTES) {
    throw new PlanTokenError(`the plan-token key must be at least ${PLAN_TOKEN_KEY_MIN_BYTES} bytes`);
  }
  return hmacSha256(bytes, DOMAIN);
};

const sign = (key: string | Uint8Array, body: string): string => base64urlEncode(hmacSha256(keyBytes(key), `${DOMAIN}.${body}`));

/**
 * Mint a token for an approved plan. Throws `PlanTokenError` on a short key, a bad `sub` / reservation id / plan
 * hash, or a lifetime outside 1 s – 15 min.
 */
export const mintPlanToken = (
  input: { sub: string; reservationId: string; planHash: string; nowMs: number; ttlSeconds?: number },
  key: string | Uint8Array,
): string => {
  const ttl = input.ttlSeconds === undefined ? PLAN_TOKEN_TTL_MAX_S : input.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > PLAN_TOKEN_TTL_MAX_S) throw new PlanTokenError(`a plan token lasts 1 to ${PLAN_TOKEN_TTL_MAX_S} seconds`);
  if (typeof input.sub !== 'string' || !SUBJECT.test(input.sub)) throw new PlanTokenError('a plan token needs the user subject');
  if (typeof input.reservationId !== 'string' || !SUBJECT.test(input.reservationId)) throw new PlanTokenError('a plan token needs its ledger reservation');
  if (!isInputHash(input.planHash)) throw new PlanTokenError('a plan token needs the plan hash');
  if (typeof input.nowMs !== 'number' || !isFinite(input.nowMs) || input.nowMs < 0) throw new PlanTokenError('a plan token needs the time');
  const iat = Math.floor(input.nowMs / 1000);
  const payload: PlanTokenPayload = { v: 1, sub: input.sub, iat, exp: iat + ttl, reservationId: input.reservationId, planHash: input.planHash };
  const body = base64urlEncode(canonicalJson(payload));
  return `${body}.${sign(key, body)}`;
};

export type PlanTokenRefusal = 'malformed' | 'signature' | 'expired' | 'not-yet-valid' | 'lifetime' | 'subject' | 'plan';

export type PlanTokenCheck =
  | { ok: true; payload: PlanTokenPayload }
  | { ok: false; code: 'unauthorized'; status: 401; reason: 'malformed' | 'signature' }
  | { ok: false; code: 'forbidden'; status: 403; reason: Exclude<PlanTokenRefusal, 'malformed' | 'signature'> };

const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Verify `token` for this user and this exact plan at `nowMs`. Never throws on a bad token (a short key still
 * throws: that is the host's misconfiguration). Order: shape, signature (constant-time), payload, lifetime, expiry,
 * subject, plan hash.
 */
export const verifyPlanToken = (token: unknown, key: string | Uint8Array, expect: { nowMs: number; sub: string; planHash: string }): PlanTokenCheck => {
  const k = keyBytes(key);
  const unauthorized = (reason: 'malformed' | 'signature'): PlanTokenCheck => ({ ok: false, code: 'unauthorized', status: 401, reason });
  const forbidden = (reason: Exclude<PlanTokenRefusal, 'malformed' | 'signature'>): PlanTokenCheck => ({ ok: false, code: 'forbidden', status: 403, reason });
  if (typeof token !== 'string' || token.length > 2048) return unauthorized('malformed');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return unauthorized('malformed');
  const sig = base64urlDecode(parts[1]);
  const raw = base64urlDecode(parts[0]);
  if (!sig || !raw) return unauthorized('malformed');
  if (!timingSafeEqual(parts[1], base64urlEncode(hmacSha256(k, `${DOMAIN}.${parts[0]}`)))) return unauthorized('signature');
  const text = utf8Decode(raw);
  let payload: unknown;
  try {
    payload = text === null ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  const p = payload as PlanTokenPayload | null;
  if (
    !p ||
    typeof p !== 'object' ||
    p.v !== 1 ||
    typeof p.sub !== 'string' ||
    !isSeconds(p.iat) ||
    !isSeconds(p.exp) ||
    typeof p.reservationId !== 'string' ||
    !SUBJECT.test(p.reservationId) ||
    !isInputHash(p.planHash)
  ) {
    return unauthorized('malformed');
  }
  const now = Math.floor(expect.nowMs / 1000);
  if (p.exp <= p.iat || p.exp - p.iat > PLAN_TOKEN_TTL_MAX_S) return forbidden('lifetime');
  if (now >= p.exp) return forbidden('expired');
  if (p.iat > now + PLAN_TOKEN_SKEW_S) return forbidden('not-yet-valid');
  if (!timingSafeEqual(p.sub, String(expect.sub))) return forbidden('subject');
  if (!timingSafeEqual(p.planHash, String(expect.planHash))) return forbidden('plan');
  return { ok: true, payload: { v: 1, sub: p.sub, iat: p.iat, exp: p.exp, reservationId: p.reservationId, planHash: p.planHash } };
};
