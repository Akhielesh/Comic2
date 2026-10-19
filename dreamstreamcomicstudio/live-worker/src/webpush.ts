/**
 * Web Push from a Worker with nothing but WebCrypto.
 *
 *  - VAPID (RFC 8292): an ES256 JWT signed with the server's P-256 key, sent as
 *    `Authorization: vapid t=<jwt>, k=<public key>`.
 *  - Payload encryption (RFC 8291 + RFC 8188 "aes128gcm"): ECDH with the
 *    subscription's p256dh key, HKDF with its auth secret, one AES-GCM record.
 *
 * Used by the baby monitor to wake parents' phones on a cry even when the
 * monitor tab is closed. Keys are generated once and kept in a Durable Object,
 * so there are no secrets to manage.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what browsers call applicationServerKey). */
  publicKey: string;
  privateJwk: JsonWebKey;
}

export interface PushSubscriptionJSONLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { publicKey: b64url(raw as ArrayBuffer), privateJwk: jwk };
}

/** `vapid t=…, k=…` for one push service origin. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig as ArrayBuffer)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8);
  return new Uint8Array(bits);
}

/**
 * aes128gcm-encrypt one push message. `fixed` pins the ephemeral key + salt
 * (tests use the RFC 8291 vector); production always generates fresh ones.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  fixed?: { asPrivateJwk: JsonWebKey; asPublicRaw: Uint8Array; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = unb64url(p256dh);
  const auth = unb64url(authSecret);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  let asPrivate: CryptoKey;
  let asPublic: Uint8Array;
  if (fixed) {
    asPrivate = await crypto.subtle.importKey('jwk', { ...fixed.asPrivateJwk, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asPublic = fixed.asPublicRaw;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  }

  // `public` is the standard member name; workers-types spells it `$public`.
  const ecdh = { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asPrivate, 256));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = final record, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/** Deliver one notification. 'gone' = the subscription expired; drop it. */
export async function sendWebPush(
  sub: PushSubscriptionJSONLike,
  payload: unknown,
  keys: VapidKeys,
  opts: { subject: string; ttlSec?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string },
  fetcher: typeof fetch = fetch,
): Promise<PushOutcome> {
  try {
    const body = await encryptPushPayload(enc.encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
    const headers: Record<string, string> = {
      authorization: await vapidAuthorization(sub.endpoint, keys, opts.subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttlSec ?? 600),
      urgency: opts.urgency ?? 'high',
    };
    // Topic collapses repeats of the same alert on the push service (≤32 url-safe chars).
    if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const res = await fetcher(sub.endpoint, { method: 'POST', headers, body });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Only real push services — never let a "subscription" make the worker fetch arbitrary URLs. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    return (
      h === 'fcm.googleapis.com' ||
      h === 'android.googleapis.com' ||
      h.endsWith('.push.services.mozilla.com') ||
      h === 'updates.push.services.mozilla.com' ||
      h.endsWith('.push.apple.com') ||
      h === 'web.push.apple.com' ||
      h.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}
