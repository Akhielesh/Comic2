/**
 * Poll tokens (plan §5.8, §9): a browser may `GET /v1/jobs/:id?t=` and `GET /v1/files/:ref?t=` with one, and nothing
 * else. A token is bound to one job of one (app, sub), lives at most an hour, and is good for GET only. The verifier
 * takes the job record's own owner (`owner`, from the JobDO) and refuses a token whose app or sub differs, so a token
 * minted under another app's key (a compromised secret, another tenant) never reaches a job it does not own.
 *
 *   token = base64url(json) + "." + base64url(HMAC-SHA256(pollKey, base64url(json)))
 *   pollKey = HMAC-SHA256(appSecret, "platform-poll-v1")
 *
 * The payload names the app and the key id that signed it, so the gateway finds the key (during a rotation overlap
 * too) before checking the MAC; nothing else in the payload is trusted until the MAC verifies. The poll key differs
 * from the claim key, so a claim is never accepted as a poll token or the other way round. For `/v1/files/:ref`, the
 * gateway checks that the file belongs to the token's job.
 */
import { check, s } from '../schema/index.js';
import { base64urlDecode, base64urlEncode, constantTimeEqualText, utf8Decode, utf8Encode } from './bytes.js';
import { deriveWireKey, hmac, isUsableSecret } from './crypto.js';
import { sealToken } from './claim.js';
import { inputFailure, internalFailure, wireFailure } from './errors.js';
import type { PollTokenPayload, WireClock, WireCrypto, WireFailure } from './types.js';
import { APP_ID_PATTERN, JOB_ID_PATTERN, KEY_ID_PATTERN, SUB_PATTERN, WIRE_LIMITS } from './types.js';

const PollTokenS = s.object({
  v: s.literal(1),
  kind: s.literal('poll'),
  app: s.text({ max: 32, pattern: APP_ID_PATTERN, singleLine: true }),
  kid: s.text({ max: 64, pattern: KEY_ID_PATTERN, singleLine: true }),
  sub: s.text({ max: 32, pattern: SUB_PATTERN, singleLine: true }),
  jobId: s.text({ max: 128, pattern: JOB_ID_PATTERN, singleLine: true }),
  exp: s.int({ min: 0, max: 9999999999 }),
});

export interface PollTokenInput {
  app: string;
  /** The key id whose secret signs the token. */
  kid: string;
  sub: string;
  jobId: string;
  /** Default `WIRE_LIMITS.pollTtlDefaultSeconds`; at most `WIRE_LIMITS.pollTtlMaxSeconds` (one hour). */
  ttlSeconds?: number;
}

export type MintPollTokenResult = { ok: true; token: string; payload: PollTokenPayload } | WireFailure;

const nowSeconds = (now: WireClock): number | null => {
  const ms = now();
  return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : null;
};

/** Mint a poll token for one job (the gateway does this when it answers 202). */
export const mintPollToken = async (
  keys: { secret: Uint8Array; crypto: WireCrypto; now: WireClock },
  input: PollTokenInput,
): Promise<MintPollTokenResult> => {
  if (!keys || !isUsableSecret(keys.secret)) return inputFailure('input', `the app secret must be at least ${WIRE_LIMITS.secretMinBytes} bytes`);
  if (typeof input !== 'object' || input === null) return inputFailure('input', 'no poll token input');
  const ttl = input.ttlSeconds === undefined ? WIRE_LIMITS.pollTtlDefaultSeconds : input.ttlSeconds;
  if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > WIRE_LIMITS.pollTtlMaxSeconds) {
    return inputFailure('exp-too-far', `a poll token lives 1 to ${WIRE_LIMITS.pollTtlMaxSeconds} seconds`);
  }
  try {
    const now = nowSeconds(keys.now);
    if (now === null) return internalFailure('the clock gave no time');
    const payload: PollTokenPayload = { v: 1, kind: 'poll', app: input.app, kid: input.kid, sub: input.sub, jobId: input.jobId, exp: now + ttl };
    const r = check(PollTokenS, payload);
    if (r.ok === false) return inputFailure('input', `the poll token is not valid: ${r.errors[0].path} ${r.errors[0].message}`);
    const key = await deriveWireKey(keys.crypto, keys.secret, 'poll');
    return { ok: true, token: await sealToken(keys.crypto, key, payload), payload };
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
};

export interface VerifyPollTokenOptions {
  /** The app allowlist and key ring: the secret for (app, kid), or nothing when either is unknown. */
  keys: (app: string, kid: string) => Uint8Array | null | undefined;
  crypto: WireCrypto;
  now: WireClock;
  /** The job the request path names (for `/v1/files/:ref`, the job that owns the file). */
  jobId: string;
  /** That job's owner, from the job record (never from the token): the app and the sub that created it. */
  owner: { app: string; sub: string };
  /** The request's method: only GET is allowed. */
  method: string;
}

export type VerifyPollTokenResult = { ok: true; payload: PollTokenPayload } | WireFailure;

/**
 * Verify a poll token: GET only, shape and size, key lookup, MAC (constant time), payload schema, time window
 * (`exp` after now and at most an hour ahead), then the job and its owner (app and sub), in that order.
 */
export const verifyPollToken = async (token: string, opts: VerifyPollTokenOptions): Promise<VerifyPollTokenResult> => {
  if (!opts || typeof opts.keys !== 'function') return inputFailure('input', 'verifyPollToken needs a key ring');
  const owner = opts.owner;
  if (!owner || typeof owner !== 'object' || typeof owner.app !== 'string' || typeof owner.sub !== 'string') {
    return inputFailure('input', "verifyPollToken needs the job record's owner (app and sub)");
  }
  if (opts.method !== 'GET') return wireFailure('method', 'a poll token allows GET only');
  if (typeof token !== 'string' || token.length > WIRE_LIMITS.pollTokenMax) return wireFailure('malformed', 'the poll token is missing or too long');
  const dot = token.indexOf('.');
  const body = dot === -1 ? '' : token.slice(0, dot);
  const mac = dot === -1 ? '' : token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return wireFailure('malformed', 'not a poll token');

  // The payload names its key; nothing in it is trusted until the MAC under that key verifies.
  const bytes = base64urlDecode(body);
  const json = bytes ? utf8Decode(bytes) : null;
  let parsed: unknown;
  try {
    parsed = json === null ? undefined : JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  const r = parsed === undefined ? null : check(PollTokenS, parsed);
  if (r === null || r.ok === false) return wireFailure('malformed', 'the poll token payload is not valid');
  const payload = r.value as PollTokenPayload;

  let secret: Uint8Array | null | undefined;
  try {
    secret = opts.keys(payload.app, payload.kid);
  } catch {
    secret = null;
  }
  if (!isUsableSecret(secret)) return wireFailure('unknown-key', 'no key for the poll token');
  let expected: string;
  try {
    const key = await deriveWireKey(opts.crypto, secret, 'poll');
    expected = base64urlEncode(await hmac(opts.crypto, key, utf8Encode(body)));
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
  if (!constantTimeEqualText(expected, mac)) return wireFailure('bad-signature', 'the poll token does not verify');

  let now: number | null;
  try {
    now = nowSeconds(opts.now);
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'the clock failed');
  }
  if (now === null) return internalFailure('the clock gave no time');
  if (payload.exp <= now) return wireFailure('expired', 'the poll token has expired');
  if (payload.exp > now + WIRE_LIMITS.pollTtlMaxSeconds) return wireFailure('exp-too-far', 'the poll token lives longer than an hour');
  if (payload.jobId !== opts.jobId) return wireFailure('wrong-job', 'the poll token is for another job');
  if (payload.app !== owner.app || payload.sub !== owner.sub) return wireFailure('wrong-job', "the poll token is not the job owner's");
  return { ok: true, payload };
};
