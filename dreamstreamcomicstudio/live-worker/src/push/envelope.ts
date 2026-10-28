/**
 * The end-to-end envelope for native pushes (ADR 0006 D3, security study §4.7).
 *
 * APNs and FCM payloads carry one secret field, `e`: RFC 8291 "aes128gcm" of the
 * alert's JSON to a key pair the device generated itself (`enc = {p256dh, auth}`,
 * registered with its push token). The iOS Notification Service Extension and the
 * Android `FirebaseMessagingService` decrypt it and show the real text; Apple and
 * Google see only that an alert arrived, how urgent it is and when. It is exactly
 * the encryption Web Push already uses (webpush.ts), so one implementation and one
 * set of test vectors serve every platform — `openEnvelope` below is the reference
 * decoder the Swift and Kotlin code mirror, and `fixtures/envelope-v1.json` is the
 * vector they must reproduce byte for byte.
 *
 * Two rules on top of RFC 8291:
 *  - **Padding.** The record is zero-padded to a 128-byte step, so the ciphertext
 *    length says little about which alert it is ("Maya is crying" vs "Loud noise").
 *  - **≤ 1 KB.** The whole ciphertext (header + record + tag) stays within 1024 bytes,
 *    leaving room in APNs' 4 KB and FCM's 4 KB for the visible fallback fields.
 *    Bigger inputs throw `EnvelopeError('too_large')`; the router then sends the
 *    generic alert instead, so an oversize message is never silently dropped.
 */
import { b64url, encryptPayload, unb64url, type FixedEphemeral } from '../webpush';

/** RFC 8291 receiver keys, base64url (p256dh: 65-byte uncompressed P-256 point; auth: 16 bytes). */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

/** What `e` decrypts to (mirrors `PushInner` in packages/monitor-core/src/wire.ts). */
export interface PushInner {
  /** Glance composed for push (no nursery name). */
  g?: unknown;
  title: string;
  body: string;
  /** Urgent alerts: the "I'm on it" action token. */
  act?: string;
  /** Quietly replaces the notification for the same incident ("Dad's on it"). */
  replace?: boolean;
  [extra: string]: unknown;
}

/** Ciphertext budget: 1 KB (WS-3 contract). */
export const ENVELOPE_MAX_BYTES = 1024;
/** salt 16 + record size 4 + key-id length 1 + sender public key 65. */
export const ENVELOPE_HEADER_BYTES = 86;
/** AES-GCM tag. */
export const ENVELOPE_TAG_BYTES = 16;
/** The record (plaintext + 0x02 delimiter + zero padding) grows in steps of this many bytes. */
export const ENVELOPE_PAD_STEP = 128;
/** The largest record that still fits the budget. */
export const ENVELOPE_MAX_RECORD = ENVELOPE_MAX_BYTES - ENVELOPE_HEADER_BYTES - ENVELOPE_TAG_BYTES; // 922
/** The largest plaintext that fits (the record also holds the delimiter byte). */
export const ENVELOPE_MAX_PLAINTEXT = ENVELOPE_MAX_RECORD - 1; // 921

export type EnvelopeErrorCode = 'no_key' | 'bad_key' | 'too_large' | 'bad_envelope';

export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'EnvelopeError';
  }
}

const enc = new TextEncoder();

function decodes(s: unknown, len: number, first?: number): boolean {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return false;
  try {
    const b = unb64url(s.replace(/=+$/, ''));
    return b.length === len && (first === undefined || b[0] === first);
  } catch {
    return false;
  }
}

/** True for a usable RFC 8291 key pair: a 65-byte uncompressed point and a 16-byte secret. */
export function validPushKeys(k: unknown): k is PushKeys {
  if (!k || typeof k !== 'object') return false;
  const { p256dh, auth } = k as Record<string, unknown>;
  return decodes(p256dh, 65, 0x04) && decodes(auth, 16);
}

/**
 * The canonical (unpadded) form of a valid key pair, or null. Native base64 encoders often
 * add `=` padding; Web Push and the RFC 8291 code want it without, so a registration is
 * stored this way — a padded key must never be accepted and then fail on every alert.
 */
export function normalizePushKeys(k: unknown): PushKeys | null {
  if (!validPushKeys(k)) return null;
  return { p256dh: k.p256dh.replace(/=+$/, ''), auth: k.auth.replace(/=+$/, '') };
}

/** The padded record size for a plaintext of `n` bytes, or null when it can't fit. */
export function envelopeRecordSize(n: number): number | null {
  if (n > ENVELOPE_MAX_PLAINTEXT) return null;
  return Math.min(Math.ceil((n + 1) / ENVELOPE_PAD_STEP) * ENVELOPE_PAD_STEP, ENVELOPE_MAX_RECORD);
}

/**
 * Seal `json` to one device: `{e}` = base64url(aes128gcm ciphertext), ≤ 1 KB before
 * encoding. `sub.enc` is the key pair the device registered. `fixed` pins the
 * ephemeral key and salt for test vectors only.
 */
export async function sealForDevice(sub: { enc?: PushKeys | null }, json: unknown, opts: { fixed?: FixedEphemeral } = {}): Promise<{ e: string }> {
  if (!sub.enc) throw new EnvelopeError('no_key', 'device registered no push key');
  const keys = normalizePushKeys(sub.enc);
  if (!keys) throw new EnvelopeError('bad_key', 'device push key is malformed');
  const plain = enc.encode(JSON.stringify(json));
  const padTo = envelopeRecordSize(plain.length);
  if (padTo == null) throw new EnvelopeError('too_large', `envelope plaintext ${plain.length} B > ${ENVELOPE_MAX_PLAINTEXT} B`);
  const body = await encryptPayload(keys.p256dh, keys.auth, plain, { fixed: opts.fixed, padTo });
  return { e: b64url(body) };
}

/**
 * The reference decoder (what the NSE / FirebaseMessagingService do): open `e` with
 * the device's private key (`d`, base64url) and its registered keys. Returns the JSON.
 */
export async function openEnvelope(e: string, device: { d: string; p256dh: string; auth: string }): Promise<unknown> {
  try {
    return await open(e, device);
  } catch (err) {
    // Fail closed with one error type, whatever WebCrypto threw (a mismatched key, a bad point…).
    throw err instanceof EnvelopeError ? err : new EnvelopeError('bad_envelope', 'does not open with this key');
  }
}

async function open(e: string, device: { d: string; p256dh: string; auth: string }): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = unb64url(e);
  } catch {
    throw new EnvelopeError('bad_envelope', 'not base64url');
  }
  if (body.length < ENVELOPE_HEADER_BYTES + ENVELOPE_TAG_BYTES + 1 || body.length > ENVELOPE_MAX_BYTES) throw new EnvelopeError('bad_envelope', 'wrong size');
  const salt = body.slice(0, 16);
  const idlen = body[20];
  if (idlen !== 65) throw new EnvelopeError('bad_envelope', 'unexpected key id');
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = unb64url(device.p256dh);
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d: device.d, x: b64url(uaPublic.slice(1, 33)), y: b64url(uaPublic.slice(33, 65)), ext: true };
  const uaPriv = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asPub = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = { name: 'ECDH', public: asPub } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, uaPriv, 256));
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hk(unb64url(device.auth), secret, keyInfo, 32);
  const cek = await hk(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new EnvelopeError('bad_envelope', 'missing record delimiter');
  return JSON.parse(new TextDecoder().decode(padded.slice(0, end)));
}
