// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64url, encryptPayload, encryptPushPayload, generateVapidKeys, isAllowedPushEndpoint, sendWebPush, signJwtES256, unb64url, vapidAuthorization } from './webpush';

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

  it('encryptPayload (the export the native envelope uses) is the same RFC 8291 bytes', async () => {
    const fixed = { asPrivateJwk: jwkFrom(RFC.asPrivate, RFC.asPublic), asPublicRaw: unb64url(RFC.asPublic), salt: unb64url(RFC.salt) };
    const body = await encryptPayload(RFC.uaPublic, RFC.auth, unb64url(RFC.plaintext), { fixed });
    expect(b64url(body)).toBe(RFC.body);
  });

  it('pads to a fixed record size when asked, and a standard receiver strips it', async () => {
    const msg = JSON.stringify({ title: 'Cry', body: 'x' });
    const body = await encryptPayload(RFC.uaPublic, RFC.auth, new TextEncoder().encode(msg), { padTo: 256 });
    // salt 16 + rs 4 + idlen 1 + key 65 = 86 header bytes; then 256 padded bytes + 16 tag.
    expect(body.length).toBe(86 + 256 + 16);
    const out = await decrypt(body, jwkFrom(RFC.uaPrivate, RFC.uaPublic), unb64url(RFC.uaPublic), unb64url(RFC.auth));
    expect(out).toBe(msg);
    // A message longer than padTo is simply not padded.
    const long = 'y'.repeat(300);
    const unpadded = await encryptPayload(RFC.uaPublic, RFC.auth, new TextEncoder().encode(long), { padTo: 256 });
    expect(unpadded.length).toBe(86 + 301 + 16);
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

  it('signJwtES256 signs with an imported CryptoKey too (the APNs .p8 path), header and claims in order', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwt = await signJwtES256({ alg: 'ES256', kid: 'ABC123DEFG' }, { iss: 'TEAM123456', iat: 1_700_000_000 }, kp.privateKey);
    const [h, c, sig] = jwt.split('.');
    expect(new TextDecoder().decode(unb64url(h))).toBe('{"alg":"ES256","kid":"ABC123DEFG"}');
    expect(new TextDecoder().decode(unb64url(c))).toBe('{"iss":"TEAM123456","iat":1700000000}');
    expect(unb64url(sig).length).toBe(64); // raw r‖s, as JWS wants
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, unb64url(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it('keeps the VAPID JWT header exactly as before ({typ, alg})', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization('https://web.push.apple.com/QG', keys, 'https://dreamstreamstudio.ai', 1_700_000_000);
    const h = header.slice('vapid t='.length).split('.')[0];
    expect(new TextDecoder().decode(unb64url(h))).toBe('{"typ":"JWT","alg":"ES256"}');
    const c = header.slice('vapid t='.length).split('.')[1];
    expect(new TextDecoder().decode(unb64url(c))).toBe('{"aud":"https://web.push.apple.com","exp":1700043200,"sub":"https://dreamstreamstudio.ai"}');
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

describe('sendWebPush (unchanged behaviour)', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

  it('posts one aes128gcm record with VAPID, ttl, urgency and a cleaned topic', async () => {
    const keys = await generateVapidKeys();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const out = await sendWebPush(sub, { title: 'Baby is crying', kind: 'cry' }, keys, { subject: 'https://dreamstreamstudio.ai', ttlSec: 300, urgency: 'high', topic: 'cry:abc/def-12345678901234567890123456789' }, fetcher);
    expect(out).toBe('sent');
    expect(calls).toHaveLength(1);
    const h = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(sub.endpoint);
    expect(h['content-encoding']).toBe('aes128gcm');
    expect(h.ttl).toBe('300');
    expect(h.urgency).toBe('high');
    expect(h.topic).toBe('cryabcdef-1234567890123456789012');
    expect(h.authorization.startsWith('vapid t=')).toBe(true);
    const plain = await decrypt(calls[0].init.body as Uint8Array, jwkFrom(RFC.uaPrivate, RFC.uaPublic), unb64url(RFC.uaPublic), unb64url(RFC.auth));
    expect(JSON.parse(plain)).toEqual({ title: 'Baby is crying', kind: 'cry' });
  });

  it('maps 404/410 to gone, other failures (and throws) to failed', async () => {
    const keys = await generateVapidKeys();
    const by = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await sendWebPush(sub, {}, keys, { subject: 's' }, by(410))).toBe('gone');
    expect(await sendWebPush(sub, {}, keys, { subject: 's' }, by(404))).toBe('gone');
    expect(await sendWebPush(sub, {}, keys, { subject: 's' }, by(429))).toBe('failed');
    expect(await sendWebPush(sub, {}, keys, { subject: 's' }, by(500))).toBe('failed');
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await sendWebPush(sub, {}, keys, { subject: 's' }, boom)).toBe('failed');
  });
});
