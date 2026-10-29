/**
 * The small slice of JOSE the live Worker needs, on WebCrypto only (no dependencies):
 * compact JWTs signed with ES256 (ours: device grants and access tokens) and verified with
 * ES256 or RS256 (Supabase's asymmetric signing keys), plus RFC 7638 JWK thumbprints.
 *
 * Deliberately strict: `alg` must be one we asked for (never `none`, never a symmetric alg
 * against an asymmetric key), signatures are the 64-byte JWS form for ES256, and nothing
 * here trusts a claim before the signature over it has been checked.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url (no padding, no other characters) → bytes; null when malformed. */
export function unb64url(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}

export type Alg = 'ES256' | 'RS256';

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

/** Split and decode a compact JWS. Null when it isn't one (three base64url JSON parts). */
export function parseJwt(token: string): JwtParts | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const hb = unb64url(h);
  const pb = unb64url(p);
  const sb = unb64url(s);
  if (!hb || !pb || !sb) return null;
  try {
    const header = JSON.parse(dec.decode(hb));
    const payload = JSON.parse(dec.decode(pb));
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return { header, payload, signingInput: enc.encode(`${h}.${p}`), signature: sb };
  } catch {
    return null;
  }
}

export interface PublicJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

/** Import a public JWK for verifying `alg`; null when the key and alg don't belong together. */
export async function importVerifyKey(jwk: PublicJwk, alg: Alg): Promise<CryptoKey | null> {
  try {
    if (alg === 'ES256') {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
      return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return null;
    return await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return null;
  }
}

export async function verifySignature(alg: Alg, key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    if (alg === 'ES256') {
      if (signature.length !== 64) return false;
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
    }
    return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data);
  } catch {
    return false;
  }
}

/** RFC 7638 thumbprint (base64url SHA-256 of the canonical members) of an EC P-256 or RSA key. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const canon =
    jwk.kty === 'EC'
      ? `{"crv":"${jwk.crv}","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
      : `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
  return b64url(await sha256(canon));
}

/** The public half of an EC JWK (drops `d` and anything else private). */
export const publicEcJwk = (jwk: JsonWebKey & { kid?: string }): PublicJwk => ({ kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y, ...(jwk.kid ? { kid: jwk.kid } : {}) });

/** P-256 public key from its 65-byte uncompressed point (0x04 ‖ X ‖ Y) as a JWK; null if not one. */
export function ecJwkFromRaw(raw: Uint8Array): PublicJwk | null {
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  return { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) };
}

/** Sign a compact ES256 JWT. */
export async function signEs256Jwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ ...header, alg: 'ES256', typ: header.typ ?? 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

/** Same-length strings compared without an early exit. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
