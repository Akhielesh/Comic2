/**
 * Crypto plumbing for the wire: a `WireCrypto` built from WebCrypto, the per-purpose key derivation, and the
 * pseudonymous subject. Every key the wire uses is derived from an app secret with a fixed label, so the
 * request-signing key never signs a host-supplied string:
 *
 *   claim key = HMAC-SHA256(appSecret, "platform-claim-v1")      (plan §5.8)
 *   poll key  = HMAC-SHA256(appSecret, "platform-poll-v1")       (plan §5.8)
 *   sub key   = HMAC-SHA256(subSecret, "platform-sub-v1")        sub = hex(HMAC-SHA256(sub key, userId))[0..32]
 *
 * Request signatures use the app secret itself, over a canonical string that always starts `v1\n`, which no label
 * above does.
 */
import { base64urlDecode, toArrayBuffer, toHex, utf8Encode } from './bytes.js';
import type { WireCrypto } from './types.js';
import { WIRE_LIMITS } from './types.js';

/** The derivation labels. A change is a contract change (fixtures/wire pins every one). */
export const WIRE_KEY_LABELS = {
  claim: 'platform-claim-v1',
  poll: 'platform-poll-v1',
  sub: 'platform-sub-v1',
} as const;

/**
 * The slice of WebCrypto's `SubtleCrypto` the wire uses. The platform's own `crypto.subtle` (browsers, Workers,
 * Node's `globalThis.crypto.subtle`) satisfies it.
 */
export interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: ArrayBuffer,
    algorithm: { name: 'HMAC'; hash: { name: 'SHA-256' } },
    extractable: boolean,
    keyUsages: 'sign'[],
  ): PromiseLike<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: ArrayBuffer): PromiseLike<ArrayBuffer>;
  digest(algorithm: 'SHA-256', data: ArrayBuffer): PromiseLike<ArrayBuffer>;
}

/**
 * A `WireCrypto` over WebCrypto. Pass `getRandomValues` (e.g. `(a) => crypto.getRandomValues(a)`) to let
 * `mintUserClaim` / `mintServiceClaim` make their own `jti`.
 */
export const wireCryptoFromSubtle = (subtle: SubtleCryptoLike, getRandomValues?: (array: Uint8Array) => Uint8Array): WireCrypto => {
  const out: WireCrypto = {
    sha256: async (data) => new Uint8Array(await subtle.digest('SHA-256', toArrayBuffer(data))),
    hmacSha256: async (key, data) => {
      const k = await subtle.importKey('raw', toArrayBuffer(key), { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']);
      return new Uint8Array(await subtle.sign('HMAC', k, toArrayBuffer(data)));
    },
  };
  if (getRandomValues) out.randomBytes = (length) => getRandomValues(new Uint8Array(length));
  return out;
};

/** SHA-256 as lower-case hex. */
export const sha256Hex = async (crypto: WireCrypto, data: Uint8Array): Promise<string> => toHex(await crypto.sha256(data));

/** HMAC-SHA256 checked to be 32 bytes (a broken adapter must not yield a short, guessable MAC). */
export const hmac = async (crypto: WireCrypto, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  const mac = await crypto.hmacSha256(key, data);
  if (!(mac instanceof Uint8Array) || mac.length !== 32) throw new Error('WireCrypto.hmacSha256 must return 32 bytes');
  return mac;
};

/** `HMAC-SHA256(secret, label)`: the key for one purpose. */
export const deriveWireKey = (crypto: WireCrypto, secret: Uint8Array, label: keyof typeof WIRE_KEY_LABELS): Promise<Uint8Array> =>
  hmac(crypto, secret, utf8Encode(WIRE_KEY_LABELS[label]));

/** A secret is usable when it is a byte string of at least `WIRE_LIMITS.secretMinBytes` bytes. */
export const isUsableSecret = (secret: unknown): secret is Uint8Array =>
  secret instanceof Uint8Array && secret.length >= WIRE_LIMITS.secretMinBytes;

/**
 * An app secret from its configured text form (base64url, unpadded, as `wrangler secret` or an env var holds it), or
 * null when it is not canonical base64url of at least `WIRE_LIMITS.secretMinBytes` bytes.
 */
export const decodeSecret = (text: string): Uint8Array | null => {
  const bytes = typeof text === 'string' ? base64urlDecode(text.trim()) : null;
  return bytes && bytes.length >= WIRE_LIMITS.secretMinBytes ? bytes : null;
};

/**
 * The pseudonymous subject a user claim carries: `hex(HMAC(subKey, userId))[0..32]`. The platform never sees the
 * host's user id. Derive it from a secret that does NOT rotate with the request-signing key: a new sub would orphan
 * the user's jobs, files and quotas. Null on a bad secret, an empty / over-long user id or a failing crypto; it
 * never throws.
 */
export const pseudonymousSub = async (crypto: WireCrypto, subSecret: Uint8Array, userId: string): Promise<string | null> => {
  if (!isUsableSecret(subSecret) || typeof userId !== 'string' || !userId.length || userId.length > 256) return null;
  try {
    const key = await deriveWireKey(crypto, subSecret, 'sub');
    return toHex(await hmac(crypto, key, utf8Encode(userId))).slice(0, 32);
  } catch {
    return null;
  }
};
