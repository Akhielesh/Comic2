// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { b64url, unb64url } from '../webpush';
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_PLAINTEXT, EnvelopeError, envelopeRecordSize, normalizePushKeys, openEnvelope, sealForDevice, validPushKeys } from './envelope';
import fx from './fixtures/envelope-v1.json';

const device = { p256dh: fx.device.p256dh, auth: fx.device.auth };
const fixed = () => {
  const p = unb64url(fx.sender.publicKey);
  return {
    asPrivateJwk: { kty: 'EC', crv: 'P-256', d: fx.sender.d, x: b64url(p.slice(1, 33)), y: b64url(p.slice(33, 65)), ext: true } as JsonWebKey,
    asPublicRaw: p,
    salt: unb64url(fx.sender.salt),
  };
};

describe('native push envelope', () => {
  it('reproduces the golden vector byte for byte (what Swift and Kotlin must match)', async () => {
    const { e } = await sealForDevice({ enc: device }, JSON.parse(fx.plaintext), { fixed: fixed() });
    expect(e).toBe(fx.e);
    expect(unb64url(e).length).toBe(fx.cipherBytes);
  });

  it('the reference decoder opens the golden vector', async () => {
    expect(await openEnvelope(fx.e, fx.device)).toEqual(JSON.parse(fx.plaintext));
  });

  it('round-trips a fresh seal, and only the device key opens it', async () => {
    const inner = { title: 'Loud noise in the nursery', body: '78 dB for 30 s', replace: false };
    const { e } = await sealForDevice({ enc: device }, inner);
    expect(await openEnvelope(e, fx.device)).toEqual(inner);
    // Fresh ephemeral key and salt every time.
    expect((await sealForDevice({ enc: device }, inner)).e).not.toBe(e);
    // The wrong private key fails closed.
    const other = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const d = ((await crypto.subtle.exportKey('jwk', other.privateKey)) as JsonWebKey).d!;
    await expect(openEnvelope(e, { ...fx.device, d })).rejects.toThrow(EnvelopeError);
  });

  it('pads to 128-byte steps so length hides which alert it is', async () => {
    const a = await sealForDevice({ enc: device }, { title: 'Cry', body: 'x' });
    const b = await sealForDevice({ enc: device }, { title: 'Loud noise in the nursery', body: 'Nursery cam · 2:14 AM' });
    expect(unb64url(a.e).length).toBe(unb64url(b.e).length);
    expect(envelopeRecordSize(0)).toBe(128);
    expect(envelopeRecordSize(127)).toBe(128);
    expect(envelopeRecordSize(128)).toBe(256);
    expect(envelopeRecordSize(ENVELOPE_MAX_PLAINTEXT)).toBe(922);
    expect(envelopeRecordSize(ENVELOPE_MAX_PLAINTEXT + 1)).toBeNull();
  });

  it('never exceeds 1 KB of ciphertext; larger input is refused, not truncated', async () => {
    // The largest plaintext that fits: 921 bytes of JSON.
    const fits = { t: 'x'.repeat(ENVELOPE_MAX_PLAINTEXT - '{"t":""}'.length) };
    const { e } = await sealForDevice({ enc: device }, fits);
    expect(unb64url(e).length).toBe(ENVELOPE_MAX_BYTES);
    const tooBig = { t: 'x'.repeat(ENVELOPE_MAX_PLAINTEXT + 1 - '{"t":""}'.length) };
    await expect(sealForDevice({ enc: device }, tooBig)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('refuses a missing or malformed device key', async () => {
    await expect(sealForDevice({}, { title: 'x', body: 'y' })).rejects.toMatchObject({ code: 'no_key' });
    await expect(sealForDevice({ enc: { p256dh: 'nope', auth: device.auth } }, {})).rejects.toMatchObject({ code: 'bad_key' });
    expect(validPushKeys(device)).toBe(true);
    expect(validPushKeys({ p256dh: device.p256dh, auth: 'c2hvcnQ' })).toBe(false); // 5 bytes
    expect(validPushKeys({ p256dh: b64url(new Uint8Array(65)), auth: device.auth })).toBe(false); // not an uncompressed point
    expect(validPushKeys(null)).toBe(false);
  });

  it('accepts keys a native encoder padded with "=", and seals to them the same way', async () => {
    const padded = { p256dh: `${device.p256dh}=`, auth: `${device.auth}==` };
    expect(validPushKeys(padded)).toBe(true);
    expect(normalizePushKeys(padded)).toEqual(device);
    expect(normalizePushKeys({ p256dh: 'nope', auth: device.auth })).toBeNull();
    const { e } = await sealForDevice({ enc: padded }, JSON.parse(fx.plaintext), { fixed: fixed() });
    expect(e).toBe(fx.e);
  });
});
