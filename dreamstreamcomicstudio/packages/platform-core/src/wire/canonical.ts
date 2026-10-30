/**
 * Request signing (plan §5.8):
 *
 *   signature = base64url(HMAC-SHA256(secret[kid],
 *     "v1\n" + METHOD + "\n" + PATH + "?" + CANONICAL_QUERY + "\n" + TS + "\n" + hex(sha256(body)) + "\n" +
 *     (claim ? hex(sha256(claim)) : "-") + "\n" + IDEMPOTENCY_KEY))
 *
 * - PATH is the request path in RFC 3986 normal form: percent-escapes of unreserved characters decoded, every other
 *   escape upper-cased; no dot segments and no empty segments (`//`). Anything else is refused, not repaired.
 * - CANONICAL_QUERY is the query parameters sorted by key and RFC 3986-encoded (`key=value` joined by `&`, empty
 *   when there are none). The query is read the way a server reads it (`application/x-www-form-urlencoded`: `+` is a
 *   space), so `a+b` and `a%20b` sign alike and mean alike, while `a%2Bb` (a literal plus) signs differently. A
 *   malformed escape, invalid UTF-8, an empty key or a REPEATED key is refused: with one value per key, no reordering
 *   can change what a server's `get()` returns without changing the signature. So a changed `?maxPages=` breaks it.
 * - TS is X-Platform-Timestamp as sent (decimal Unix seconds); the body hash covers the exact bytes sent (an empty
 *   body hashes the empty string); IDEMPOTENCY_KEY is empty when the request has none.
 *
 * Signatures are compared in constant time.
 */
import { base64urlEncode, constantTimeEqualText, isBytes, toHex, utf8Decode, utf8Encode } from './bytes.js';
import { hmac, isUsableSecret, sha256Hex } from './crypto.js';
import { inputFailure, internalFailure, wireFailure } from './errors.js';
import type { WireCrypto, WireFailure } from './types.js';
import { APP_ID_PATTERN, IDEMPOTENCY_KEY_PATTERN, SUB_PATTERN, WIRE_LIMITS } from './types.js';

const IDEMPOTENCY_KEY = new RegExp(IDEMPOTENCY_KEY_PATTERN);
const APP_ID = new RegExp(APP_ID_PATTERN);
const SUB = new RegExp(SUB_PATTERN);
const METHOD = /^[A-Z]{1,16}$/;
const TIMESTAMP = /^(0|[1-9][0-9]{0,11})$/;
/** A claim or token as it travels: base64url, a dot, base64url. */
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The base64url of a 32-byte MAC. */
const MAC_TEXT = /^[A-Za-z0-9_-]{43}$/;

/** True for a valid `Idempotency-Key`: 1 to 128 characters of `[A-Za-z0-9._:-]`. */
export const isIdempotencyKey = (key: unknown): key is string => typeof key === 'string' && IDEMPOTENCY_KEY.test(key);

/** True for a string shaped like a claim or poll token (it says nothing about its MAC). */
export const isTokenShaped = (token: unknown, max: number): token is string => typeof token === 'string' && token.length <= max && TOKEN.test(token);

// ── RFC 3986 ────────────────────────────────────────────────────────────────────────────────────────────────────

const HEX_UPPER = '0123456789ABCDEF';

const isUnreservedByte = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;

/** RFC 3986 percent-encoding of a string's UTF-8: every byte but the unreserved ones, upper-case hex. */
export const rfc3986Encode = (text: string): string => {
  const bytes = utf8Encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += isUnreservedByte(b) ? String.fromCharCode(b) : `%${HEX_UPPER[b >> 4]}${HEX_UPPER[b & 15]}`;
  }
  return out;
};

const hexValue = (ch: number): number =>
  ch >= 0x30 && ch <= 0x39 ? ch - 0x30 : ch >= 0x41 && ch <= 0x46 ? ch - 0x37 : ch >= 0x61 && ch <= 0x66 ? ch - 0x57 : -1;

/** A raw query or path is printable ASCII: a received URL is always percent-encoded. */
const PRINTABLE_ASCII = /^[\x21-\x7e]*$/;

/**
 * Percent-decode one query component as a server reads it (`+` is a space), or null on a malformed escape or
 * invalid UTF-8.
 */
const decodeQueryComponent = (raw: string): string | null => {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 0x25) {
      const hi = i + 2 < raw.length ? hexValue(raw.charCodeAt(i + 1)) : -1;
      const lo = i + 2 < raw.length ? hexValue(raw.charCodeAt(i + 2)) : -1;
      if (hi < 0 || lo < 0) return null;
      bytes.push(hi * 16 + lo);
      i += 2;
    } else bytes.push(c === 0x2b ? 0x20 : c);
  }
  return utf8Decode(new Uint8Array(bytes));
};

/**
 * The canonical query: parameters sorted by key, RFC 3986-encoded, joined by `&`. Accepts the raw query with or
 * without its leading `?`. Null when it cannot be signed: non-ASCII or a `#`, a malformed escape, invalid UTF-8, an
 * empty or repeated key, more than `WIRE_LIMITS.queryParamsMax` parameters or more than `WIRE_LIMITS.queryMax`
 * characters. Empty pairs (`a=1&&b=2`) are skipped, as a server skips them; `?a` and `?a=` both mean `a` is empty.
 */
export const canonicalQuery = (raw: string): string | null => {
  if (typeof raw !== 'string') return null;
  const q = raw.charAt(0) === '?' ? raw.slice(1) : raw;
  if (q.length > WIRE_LIMITS.queryMax || !PRINTABLE_ASCII.test(q) || q.indexOf('#') !== -1) return null;
  if (!q.length) return '';
  const pairs: { key: string; value: string }[] = [];
  const parts = q.split('&');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.length) continue;
    const eq = part.indexOf('=');
    const key = decodeQueryComponent(eq === -1 ? part : part.slice(0, eq));
    const value = decodeQueryComponent(eq === -1 ? '' : part.slice(eq + 1));
    if (key === null || value === null || !key.length) return null;
    pairs.push({ key: rfc3986Encode(key), value: rfc3986Encode(value) });
  }
  if (pairs.length > WIRE_LIMITS.queryParamsMax) return null;
  // Encoded keys are ASCII, so comparing code units is byte order in every language.
  pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 1; i < pairs.length; i++) if (pairs[i].key === pairs[i - 1].key) return null;
  return pairs.map((p) => `${p.key}=${p.value}`).join('&');
};

/** The query string the client sends for these parameters: exactly the canonical form. */
export const encodeQuery = (params: { readonly [key: string]: string | number | boolean | undefined }): string | null => {
  const parts: string[] = [];
  const keys = Object.keys(params);
  for (let i = 0; i < keys.length; i++) {
    const v = params[keys[i]];
    if (v !== undefined) parts.push(`${rfc3986Encode(keys[i])}=${rfc3986Encode(String(v))}`);
  }
  return canonicalQuery(parts.join('&'));
};

/** RFC 3986 `pchar` minus `%` (escapes are handled on their own): unreserved, sub-delims, `:` and `@`. */
const PCHAR = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/;

/**
 * The canonical path, or null. It must start with `/` and hold only RFC 3986 path characters; percent-escapes of
 * unreserved characters are decoded and the rest upper-cased (RFC 3986 §6.2.2, so a proxy that normalises escapes
 * cannot break a signature); `.`/`..` segments (raw or escaped) and empty segments are refused. `/` alone is fine.
 */
export const canonicalPath = (raw: string): string | null => {
  if (typeof raw !== 'string' || raw.charAt(0) !== '/' || raw.length > WIRE_LIMITS.pathMax || !PRINTABLE_ASCII.test(raw)) return null;
  if (raw === '/') return '/';
  const segments = raw.slice(1).split('/');
  const out: string[] = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    let norm = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charAt(i);
      if (ch === '%') {
        const hi = i + 2 < seg.length ? hexValue(seg.charCodeAt(i + 1)) : -1;
        const lo = i + 2 < seg.length ? hexValue(seg.charCodeAt(i + 2)) : -1;
        if (hi < 0 || lo < 0) return null;
        const b = hi * 16 + lo;
        norm += isUnreservedByte(b) ? String.fromCharCode(b) : `%${HEX_UPPER[hi]}${HEX_UPPER[lo]}`;
        i += 2;
      } else if (PCHAR.test(ch)) norm += ch;
      else return null;
    }
    if (!norm.length || norm === '.' || norm === '..') return null;
    out.push(norm);
  }
  return `/${out.join('/')}`;
};

/** A request target (`/v1/extract?maxPages=24`) as its path and raw query; null when it has a fragment. */
export const splitTarget = (target: string): { path: string; query: string } | null => {
  if (typeof target !== 'string' || target.indexOf('#') !== -1) return null;
  const q = target.indexOf('?');
  return q === -1 ? { path: target, query: '' } : { path: target.slice(0, q), query: target.slice(q + 1) };
};

// ── The canonical string ────────────────────────────────────────────────────────────────────────────────────────

/** The already-canonical, already-hashed fields of the signed string (what the golden vectors pin). */
export interface CanonicalFields {
  method: string;
  /** Canonical path. */
  path: string;
  /** Canonical query, without `?`. */
  query: string;
  /** X-Platform-Timestamp as sent. */
  timestamp: string;
  bodySha256Hex: string;
  /** hex(sha256(claim)), or null without a claim. */
  claimSha256Hex: string | null;
  /** '' without one. */
  idempotencyKey: string;
}

/** The exact string that is signed. */
export const formatCanonicalRequest = (f: CanonicalFields): string =>
  `v1\n${f.method}\n${f.path}?${f.query}\n${f.timestamp}\n${f.bodySha256Hex}\n${f.claimSha256Hex === null ? '-' : f.claimSha256Hex}\n${f.idempotencyKey}`;

/** What a signer (or a verifier rebuilding the string) supplies. */
export interface RequestToSign {
  method: string;
  /** The path and, after `?`, the query, as sent (or as received). */
  target: string;
  /** Unix seconds, or the X-Platform-Timestamp text as received. */
  timestamp: number | string;
  /** The body bytes, or `bodySha256Hex` when they were hashed while streaming. Absent: an empty body. */
  body?: Uint8Array | null;
  bodySha256Hex?: string;
  claim?: string | null;
  idempotencyKey?: string | null;
}

export type CanonicalResult = { ok: true; canonical: string; fields: CanonicalFields } | WireFailure;

const HEX64 = /^[0-9a-f]{64}$/;

/** Validate and canonicalise a request, hashing its body and claim. Refusals are `invalid` (the signer's input). */
export const canonicalRequest = async (crypto: WireCrypto, req: RequestToSign): Promise<CanonicalResult> => {
  if (typeof req !== 'object' || req === null) return inputFailure('input', 'no request to sign');
  if (typeof req.method !== 'string' || !METHOD.test(req.method)) return inputFailure('input', 'method must be an upper-case HTTP method');
  const split = splitTarget(req.target);
  if (!split) return inputFailure('path', 'the request target is not a path with an optional query');
  const path = canonicalPath(split.path);
  if (path === null) return inputFailure('path', `the path is not in canonical form: ${split.path.slice(0, 100)}`);
  const query = canonicalQuery(split.query);
  if (query === null) return inputFailure('query', 'the query cannot be signed (bad escape, invalid UTF-8, empty or repeated key, or too long)');
  const ts = typeof req.timestamp === 'number' ? (Number.isSafeInteger(req.timestamp) && req.timestamp >= 0 ? String(req.timestamp) : '') : req.timestamp;
  if (typeof ts !== 'string' || !TIMESTAMP.test(ts)) return inputFailure('input', 'timestamp must be decimal Unix seconds');
  const claim = req.claim === undefined || req.claim === null ? null : req.claim;
  if (claim !== null && !isTokenShaped(claim, WIRE_LIMITS.claimTokenMax)) return inputFailure('malformed', 'the claim is not a claim token');
  const key = req.idempotencyKey === undefined || req.idempotencyKey === null ? '' : req.idempotencyKey;
  if (key !== '' && !isIdempotencyKey(key)) return inputFailure('idempotency-key', 'Idempotency-Key must be 1 to 128 characters of [A-Za-z0-9._:-]');
  let bodyHex: string;
  try {
    if (req.bodySha256Hex !== undefined) {
      if (req.body !== undefined && req.body !== null) return inputFailure('input', 'give the body or its hash, not both');
      if (typeof req.bodySha256Hex !== 'string' || !HEX64.test(req.bodySha256Hex)) return inputFailure('input', 'bodySha256Hex must be 64 lower-case hex characters');
      bodyHex = req.bodySha256Hex;
    } else {
      const body = req.body === undefined || req.body === null ? new Uint8Array(0) : req.body;
      if (!isBytes(body)) return inputFailure('input', 'the body must be bytes');
      bodyHex = await sha256Hex(crypto, body);
    }
    const fields: CanonicalFields = {
      method: req.method,
      path,
      query,
      timestamp: ts,
      bodySha256Hex: bodyHex,
      claimSha256Hex: claim === null ? null : await sha256Hex(crypto, utf8Encode(claim)),
      idempotencyKey: key,
    };
    return { ok: true, canonical: formatCanonicalRequest(fields), fields };
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
};

export type SignResult = { ok: true; signature: string; canonical: string; fields: CanonicalFields } | WireFailure;

/** Sign a request with the app secret for its key id. */
export const signRequest = async (crypto: WireCrypto, secret: Uint8Array, req: RequestToSign): Promise<SignResult> => {
  if (!isUsableSecret(secret)) return inputFailure('input', `the signing secret must be at least ${WIRE_LIMITS.secretMinBytes} bytes`);
  const c = await canonicalRequest(crypto, req);
  if (c.ok === false) return c;
  try {
    const mac = await hmac(crypto, secret, utf8Encode(c.canonical));
    return { ok: true, signature: base64urlEncode(mac), canonical: c.canonical, fields: c.fields };
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
};

export type VerifySignatureResult = { ok: true; canonical: string; fields: CanonicalFields } | WireFailure;

/**
 * Check `signature` (X-Platform-Signature as received) against the request as received. A request that cannot be
 * canonicalised is `invalid`; a signature that does not match is `unauthorized` (`bad-signature`). Compared in
 * constant time.
 */
export const verifySignature = async (
  crypto: WireCrypto,
  secret: Uint8Array,
  req: RequestToSign,
  signature: string,
): Promise<VerifySignatureResult> => {
  if (!isUsableSecret(secret)) return wireFailure('unknown-key', 'the key ring holds no usable secret for this key id');
  if (typeof signature !== 'string' || !MAC_TEXT.test(signature)) return wireFailure('malformed', 'X-Platform-Signature is not a base64url HMAC-SHA256');
  const c = await canonicalRequest(crypto, req);
  if (c.ok === false) return c;
  try {
    const expected = base64urlEncode(await hmac(crypto, secret, utf8Encode(c.canonical)));
    if (!constantTimeEqualText(expected, signature)) return wireFailure('bad-signature', 'the request signature does not verify');
    return { ok: true, canonical: c.canonical, fields: c.fields };
  } catch (e) {
    return internalFailure(e instanceof Error ? e.message : 'crypto failed');
  }
};

/**
 * The job record id for an idempotent POST (plan §2): `hex(sha256("platform-job-v1\n" + app + "\n" + (sub or "svc")
 * + "\n" + key))`. Scoped per caller, so two users who send the same key get two jobs, and a replay by the same
 * caller finds the first one. None of the fields can hold a line break, so the joined string is unambiguous.
 */
export const idempotencyScope = async (crypto: WireCrypto, scope: { app: string; sub: string | null; key: string }): Promise<string | null> => {
  if (!isIdempotencyKey(scope.key) || typeof scope.app !== 'string' || !APP_ID.test(scope.app)) return null;
  const owner = scope.sub === null ? 'svc' : scope.sub;
  if (typeof owner !== 'string' || (owner !== 'svc' && !SUB.test(owner))) return null;
  try {
    return toHex(await crypto.sha256(utf8Encode(`platform-job-v1\n${scope.app}\n${owner}\n${scope.key}`)));
  } catch {
    return null;
  }
};
