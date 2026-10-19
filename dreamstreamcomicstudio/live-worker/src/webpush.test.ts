// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64url, encryptPushPayload, generateVapidKeys, isAllowedPushEndpoint, unb64url, vapidAuthorization } from './webpush';

// RFC 8291 Appendix A — the canonical Web Push encryption example.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const jwkFrom = (priv: string, pub: string): JsonWebKey => {
  const p = unb64url(pub);
  return { kty: 'EC', crv: 'P-256', d: priv, x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ext: true };
};

/** Independent receiver-side decrypt (what a browser does), for round trips. */
async function decrypt(body: Uint8Array, uaPrivateJwk: JsonWebKey, uaPublicRaw: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPriv = await crypto.subtle.importKey('jwk', { ...uaPrivateJwk, key_ops: ['deriveBits'] }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asPub = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPub } as unknown as SubtleCryptoDeriveKeyAlgorithm, uaPriv, 256));
  const te = new TextEncoder();
  const hk = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublicRaw, ...asPublic]);
  const ikm = await hk(auth, secret, info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.slice(0, end));
}

describe('web push encryption', () => {
  it('reproduces the RFC 8291 example byte-for-byte', async () => {
    const body = await encryptPushPayload(unb64url(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      asPrivateJwk: jwkFrom(RFC.asPrivate, RFC.asPublic),
      asPublicRaw: unb64url(RFC.asPublic),
      salt: unb64url(RFC.salt),
    });
    expect(b64url(body)).toBe(RFC.body);
  });

  it('round-trips a fresh payload a browser can decrypt', async () => {
    const msg = JSON.stringify({ title: 'Baby is crying', body: 'Nursery cam · 2:14 AM' });
    const body = await encryptPushPayload(new TextEncoder().encode(msg), RFC.uaPublic, RFC.auth);
    const out = await decrypt(body, jwkFrom(RFC.uaPrivate, RFC.uaPublic), unb64url(RFC.uaPublic), unb64url(RFC.auth));
    expect(out).toBe(msg);
  });
});

describe('VAPID', () => {
  it('signs a verifiable ES256 JWT scoped to the push service origin', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://dreamstreamstudio.ai', 1_700_000_000);
    const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://dreamstreamstudio.ai', exp: 1_700_000_000 + 12 * 3600 });
    const pub = await crypto.subtle.importKey('raw', unb64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it('only talks to real push services', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/QG')).toBe(true);
    expect(isAllowedPushEndpoint('https://evil.example.com/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest')).toBe(false);
  });
});
