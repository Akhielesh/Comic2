/**
 * Test helpers for the push transports (imported by *.test.ts only): a fetch that
 * records requests and answers from fixtures, and throwaway provider keys generated
 * per run — no real credential is ever in the repo.
 */
import { b64url } from '../webpush';

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A Response built from a recorded/documented fixture. */
export function fixtureResponse(r: FixtureResponse): Response {
  // 204/304 etc. can't carry a body.
  const body = r.status === 204 || r.status === 304 || !r.body ? null : r.body;
  return new Response(body, { status: r.status, headers: r.headers ?? {} });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A fetch that records every request and answers with `answer(call, n)` — a fixture,
 * a Response, or a thrown error (network failure).
 */
export function recordingFetch(answer: (call: RecordedCall, n: number) => FixtureResponse | Response | Promise<FixtureResponse | Response>) {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = { url: req.url, method: req.method, headers, body: req.body ? await req.text() : '' };
    calls.push(call);
    const out = await answer(call, calls.length - 1);
    return out instanceof Response ? out : fixtureResponse(out);
  }) as typeof fetch;
  return { fetcher, calls };
}

function pem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

/** A throwaway APNs-style .p8 (P-256 PKCS#8 PEM) and its public key for verifying JWTs. */
export async function testP8(): Promise<{ p8: string; publicKey: CryptoKey }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { p8: pem('PRIVATE KEY', (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer), publicKey: kp.publicKey };
}

/** A throwaway Google service-account JSON (RSA 2048) and its public key. */
export async function testServiceAccount(project = 'dreamstream-test'): Promise<{ json: string; publicKey: CryptoKey; email: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const email = `fcm-sender@${project}.iam.gserviceaccount.com`;
  const sa = {
    type: 'service_account',
    project_id: project,
    private_key_id: 'test0key0id',
    private_key: pem('PRIVATE KEY', (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer),
    client_email: email,
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  return { json: JSON.stringify(sa), publicKey: kp.publicKey, email };
}

/** Decode a compact JWT's header and claims (no verification). */
export function jwtParts(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; signed: string; sig: string } {
  const [h, c, sig] = jwt.split('.');
  const dec = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0))));
  return { header: dec(h), claims: dec(c), signed: `${h}.${c}`, sig };
}

/** Hex string → bytes. */
export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A fresh RFC 8291 receiver (what a device generates for its push key). */
export async function testDeviceKeys(): Promise<{ p256dh: string; auth: string; d: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))), d: jwk.d! };
}
