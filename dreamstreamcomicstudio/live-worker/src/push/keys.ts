/**
 * Provider credentials for the native push transports: PEM → CryptoKey, and the RS256
 * signer FCM's service-account JWT needs (the ES256 one lives in ../webpush.ts and also
 * signs the APNs provider token). Keys come from Worker secrets (`APNS_KEY_P8`, the
 * `private_key` in `FCM_SA_JSON`) and are imported once per isolate.
 */
import { b64url } from '../webpush';

const enc = new TextEncoder();

/**
 * The DER bytes inside a PEM block. Tolerates the ways a PEM survives being pasted into
 * a secret: literal `\n` escapes (as in a service-account JSON), CRLF, stray spaces.
 */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/[\s\r\n]+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error('not a PEM block');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type KeyAlg = 'ES256' | 'RS256';

const imported = new Map<string, Promise<CryptoKey>>();

/** Import a PKCS#8 private key (an APNs .p8 is P-256; a Google service account is RSA), cached per isolate. */
export function importPkcs8(pem: string, alg: KeyAlg): Promise<CryptoKey> {
  const id = `${alg}\n${pem}`;
  let p = imported.get(id);
  if (!p) {
    const algo = alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    p = crypto.subtle.importKey('pkcs8', pemToDer(pem), algo, false, ['sign']);
    // A bad key must not stay cached as a rejected promise forever (a fixed secret should work at once).
    p.catch(() => imported.delete(id));
    imported.set(id, p);
  }
  return p;
}

/** A compact RS256 JWT (Google service-account assertion). */
export async function signJwtRS256(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
  const unsigned = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, enc.encode(unsigned));
  return `${unsigned}.${b64url(sig as ArrayBuffer)}`;
}

/** Tests only. */
export function resetImportedKeys(): void {
  imported.clear();
}
