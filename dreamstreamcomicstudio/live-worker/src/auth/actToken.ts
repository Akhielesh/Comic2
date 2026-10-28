/**
 * "I'm on it" straight from a notification (ADR 0006 D3): each web push for an incident carries
 * a single-use action token, so the service worker can acknowledge without opening the app
 * (and without any account token in the service worker).
 *
 *   token  a1.<uid>.<exp>.<mac>
 *          mac = base64url(HMAC-SHA256(ACT_TOKEN_KEY, "ds-act-v1|" + nid + "|" + inc + "|" + uid + "|" + exp))
 *          exp = unix seconds, 30 minutes after the push
 *   use    POST /api/monitor/<nid>/act  {a:'ack', inc, id}  with  Authorization: DS-Act <token>
 *
 * It names one person, one nursery and one incident, and only ever acknowledges (the room
 * refuses any other action with it). Spent on first use: the room remembers the mac until the
 * token would have expired anyway, so a captured request can't be replayed.
 *
 * Key: the Worker secret ACT_TOKEN_KEY (32+ random bytes, any text encoding). Without it no
 * tokens are minted and pushes simply don't offer the action.
 */

import { b64url, constantTimeEqual, utf8 } from './jose';
import type { NonceStore } from './deviceToken';

export interface ActTokenEnv {
  ACT_TOKEN_KEY?: string;
}

export const ACT_TTL_S = 30 * 60;
const MIN_KEY_CHARS = 32;
const UID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;

let keyMemo: { src: string; key: Promise<CryptoKey> } | null = null;

function keyFor(env: ActTokenEnv): Promise<CryptoKey> | null {
  const src = env.ACT_TOKEN_KEY || '';
  if (src.length < MIN_KEY_CHARS) return null;
  if (!keyMemo || keyMemo.src !== src) {
    keyMemo = { src, key: crypto.subtle.importKey('raw', utf8(src), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  return keyMemo.key;
}

async function mac(key: CryptoKey, nid: string, inc: string, uid: string, exp: number): Promise<string> {
  return b64url(await crypto.subtle.sign('HMAC', key, utf8(`ds-act-v1|${nid}|${inc}|${uid}|${exp}`)));
}

/** True when ACT_TOKEN_KEY is set (long enough to use). */
export const actTokensConfigured = (env: ActTokenEnv): boolean => keyFor(env) != null;

/** A token for this person to acknowledge this incident; null when the key isn't set or the ids are odd. */
export async function mintActToken(env: ActTokenEnv, o: { nid: string; inc: string; uid: string }, now = Date.now()): Promise<{ token: string; exp: number } | null> {
  const key = keyFor(env);
  if (!key || !ID_RE.test(o.nid) || !ID_RE.test(o.inc) || !UID_RE.test(o.uid)) return null;
  const exp = Math.floor(now / 1000) + ACT_TTL_S;
  return { token: `a1.${o.uid}.${exp}.${await mac(await key, o.nid, o.inc, o.uid, exp)}`, exp };
}

/** The token from `Authorization: DS-Act <token>`, or null. */
export function actFrom(req: Request): string | null {
  const m = (req.headers.get('authorization') || '').match(/^DS-Act\s+(a1\.[A-Za-z0-9:_-]{1,64}\.\d{9,11}\.[A-Za-z0-9_-]{43})$/);
  return m ? m[1] : null;
}

export type ActFailure = 'unavailable' | 'malformed' | 'expired' | 'invalid' | 'used';

/**
 * Check a token for this nursery and incident, and spend it. `used` is the room's memory of
 * spent tokens (the same NonceStore shape as DS-Proof nonces).
 */
export async function verifyActToken(
  env: ActTokenEnv,
  token: string,
  o: { nid: string; inc: string },
  used: NonceStore,
  now = Date.now(),
): Promise<{ ok: true; uid: string; exp: number } | { ok: false; reason: ActFailure }> {
  const key = keyFor(env);
  if (!key) return { ok: false, reason: 'unavailable' };
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 4 || parts[0] !== 'a1' || !UID_RE.test(parts[1]) || !/^\d{9,11}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3])) {
    return { ok: false, reason: 'malformed' };
  }
  if (!ID_RE.test(o.nid) || !ID_RE.test(o.inc)) return { ok: false, reason: 'invalid' };
  const [, uid, expRaw, got] = parts;
  const exp = Number(expRaw);
  if (!constantTimeEqual(await mac(await key, o.nid, o.inc, uid, exp), got)) return { ok: false, reason: 'invalid' };
  if (exp <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  if (await used.checkAndSet(`a:${got}`, exp * 1000 + 1000, now)) return { ok: false, reason: 'used' };
  return { ok: true, uid, exp };
}

/** Tests only. */
export function resetActKeyCache(): void {
  keyMemo = null;
}
