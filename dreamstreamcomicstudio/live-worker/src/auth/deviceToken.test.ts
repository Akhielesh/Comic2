// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore -- the JSON golden vector shared with Swift/Kotlin; vitest loads JSON natively.
import fixtureJson from './fixtures/ds-proof-v1.json';
import { b64url, jwkThumbprint, parseJwt, signEs256Jwt } from './jose';
import {
  ACCESS_TTL_S,
  GRANT_TTL_S,
  MemoryNonceStore,
  deviceTokensConfigured,
  effectiveScopes,
  mintDeviceAccess,
  mintDeviceGrant,
  proofPath,
  resetDeviceKeyCache,
  scopesForRole,
  signDsProof,
  verifyDeviceToken,
  verifyDsProof,
} from './deviceToken';

const fx = fixtureJson as {
  testPrivateJwk: JsonWebKey;
  publicRaw: string;
  jkt: string;
  request: { method: string; path: string; body: string };
  ts: number;
  nonce: string;
  bodyHash: string;
  message: string;
  header: string;
};

const UID = '0a0a0a0a-1111-4222-8333-444455556666';
const DEV = '7e7e7e7e-1111-4222-8333-444455556666';
const NID = '9d9d9d9d-1111-4222-8333-444455556666';
const NOW = 1_800_000_000_000;

async function serverKey(kid?: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ...(kid ? { kid } : {}) };
}

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, raw, jkt: await jwkThumbprint({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }) };
}

let env: { DEVICE_TOKEN_JWK: string };
beforeEach(async () => {
  resetDeviceKeyCache();
  env = { DEVICE_TOKEN_JWK: JSON.stringify(await serverKey('k1')) };
});

describe('scopes', () => {
  it('never above caregiver; viewers get glance, peek and listen', () => {
    expect(scopesForRole('viewer')).toEqual(['glance', 'peek', 'listen']);
    expect(scopesForRole('parent')).toEqual(scopesForRole('caregiver'));
    expect(effectiveScopes(['glance', 'ack', 'talk', 'bogus'], 'viewer')).toEqual(['glance']);
    expect(effectiveScopes(['glance', 'ack'], 'caregiver')).toEqual(['glance', 'ack']);
    expect(effectiveScopes(['glance'], null)).toEqual([]);
  });
});

describe('grants and access tokens', () => {
  it('stays dormant without DEVICE_TOKEN_JWK', async () => {
    expect(await deviceTokensConfigured({})).toBe(false);
    expect(await mintDeviceGrant({}, { uid: UID, dev: DEV, jkt: 'x'.repeat(43), nids: [NID], scp: ['glance'] }, NOW)).toBeNull();
    expect(await verifyDeviceToken({}, 'a.b.c', 'grant', NOW)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await deviceTokensConfigured({ DEVICE_TOKEN_JWK: '{"kty":"EC"}' })).toBe(false);
  });

  it('mints a 30-day grant bound to the device key, then 10-minute access tokens from it', async () => {
    const dk = await deviceKey();
    expect(await deviceTokensConfigured(env)).toBe(true);
    const g = await mintDeviceGrant(env, { uid: UID, dev: DEV, jkt: dk.jkt, nids: [NID, NID, 'not-a-nursery'], scp: ['listen', 'glance', 'talk'] }, NOW);
    expect(g).not.toBeNull();
    expect(g!.exp).toBe(NOW / 1000 + GRANT_TTL_S);
    expect(parseJwt(g!.token)!.header).toMatchObject({ alg: 'ES256', kid: 'k1', typ: 'ds-grant+jwt' });
    const vg = await verifyDeviceToken(env, g!.token, 'grant', NOW + 1000);
    expect(vg).toMatchObject({ ok: true, claims: { sub: UID, dev: DEV, cnf: { jkt: dk.jkt }, nid: [NID], scp: ['glance', 'listen', 'talk'] } });
    if (!vg.ok) throw new Error('grant');
    const a = await mintDeviceAccess(env, vg.claims, NOW + 2000);
    expect(a!.exp).toBe(Math.floor((NOW + 2000) / 1000) + ACCESS_TTL_S);
    const va = await verifyDeviceToken(env, a!.token, 'access', NOW + 3000);
    expect(va).toMatchObject({ ok: true, claims: { aud: 'ds-device', sub: UID, cnf: { jkt: dk.jkt }, scp: ['glance', 'listen', 'talk'] } });
    expect(await verifyDeviceToken(env, a!.token, 'access', NOW + 2000 + (ACCESS_TTL_S + 31) * 1000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('never accepts one kind as the other, a foreign key, or a tampered token', async () => {
    const dk = await deviceKey();
    const g = (await mintDeviceGrant(env, { uid: UID, dev: DEV, jkt: dk.jkt, nids: [NID], scp: ['glance'] }, NOW))!;
    expect(await verifyDeviceToken(env, g.token, 'access', NOW)).toEqual({ ok: false, reason: 'wrong_kind' });
    const other = { DEVICE_TOKEN_JWK: JSON.stringify(await serverKey('k1')) };
    resetDeviceKeyCache();
    expect(await verifyDeviceToken(other, g.token, 'grant', NOW)).toEqual({ ok: false, reason: 'invalid' });
    resetDeviceKeyCache();
    const [h, p, s] = g.token.split('.');
    const body = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = `${h}.${b64url(new TextEncoder().encode(JSON.stringify({ ...body, scp: ['glance', 'ack', 'talk'] })))}.${s}`;
    expect(await verifyDeviceToken(env, forged, 'grant', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyDeviceToken(env, 'nope', 'grant', NOW)).toEqual({ ok: false, reason: 'malformed' });
    // A Supabase-style token with our kid but HS256: refused.
    expect(await verifyDeviceToken(env, `${b64url(new TextEncoder().encode('{"alg":"HS256","kid":"k1"}'))}.${p}.${s}`, 'grant', NOW)).toEqual({ ok: false, reason: 'invalid' });
    // Our own key signing nonsense claims: still refused.
    const priv = JSON.parse(env.DEVICE_TOKEN_JWK);
    const sk = await crypto.subtle.importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const odd = await signEs256Jwt({ kid: 'k1', typ: 'ds-grant+jwt' }, { iss: 'dreamstream-live', aud: 'ds-device-grant', sub: 'x', iat: 1, exp: 2 }, sk);
    expect(await verifyDeviceToken(env, odd, 'grant', NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(await mintDeviceGrant(env, { uid: 'bad', dev: DEV, jkt: dk.jkt, nids: [], scp: [] }, NOW)).toBeNull();
  });

  it('rotates: the first key signs, every listed key verifies', async () => {
    const dk = await deviceKey();
    const oldKey = await serverKey('old');
    const oldEnv = { DEVICE_TOKEN_JWK: JSON.stringify(oldKey) };
    const g = (await mintDeviceGrant(oldEnv, { uid: UID, dev: DEV, jkt: dk.jkt, nids: [NID], scp: ['glance'] }, NOW))!;
    resetDeviceKeyCache();
    const rotated = { DEVICE_TOKEN_JWK: JSON.stringify({ keys: [await serverKey('new'), oldKey] }) };
    expect(await verifyDeviceToken(rotated, g.token, 'grant', NOW)).toMatchObject({ ok: true });
    const g2 = (await mintDeviceGrant(rotated, { uid: UID, dev: DEV, jkt: dk.jkt, nids: [NID], scp: ['glance'] }, NOW))!;
    expect(parseJwt(g2.token)!.header.kid).toBe('new');
  });
});

describe('DS-Proof', () => {
  const url = `https://dreamstreamstudio.ai/live-api/api/monitor/${NID}/glance?x=1`;

  it('reproduces the golden vector (what Swift and Kotlin must match)', async () => {
    const req = new Request(`https://dreamstream-live.example.workers.dev${fx.request.path}`, { method: fx.request.method, body: fx.request.body, headers: { 'ds-proof': fx.header } });
    const bodyHash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fx.request.body))));
    expect(bodyHash).toBe(fx.bodyHash);
    expect(fx.message).toBe(`ds-proof-v1\n${fx.request.method}\n${fx.request.path}\n${fx.ts}\n${fx.nonce}\n${fx.bodyHash}`);
    expect(await jwkThumbprint({ kty: 'EC', crv: 'P-256', x: fx.testPrivateJwk.x, y: fx.testPrivateJwk.y })).toBe(fx.jkt);
    expect(await verifyDsProof(req, fx.jkt, new MemoryNonceStore(), { now: fx.ts * 1000 })).toEqual({ ok: true });
    const tampered = new Request(req.url, { method: 'POST', body: fx.request.body.replace('ack', 'resolve'), headers: { 'ds-proof': fx.header } });
    expect(await verifyDsProof(tampered, fx.jkt, new MemoryNonceStore(), { now: fx.ts * 1000 })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts a fresh proof once, from the bound key, within ±60 s, over this exact request', async () => {
    const dk = await deviceKey();
    const nonces = new MemoryNonceStore();
    const ts = NOW / 1000;
    const header = await signDsProof({ privateKey: dk.priv, publicRaw: dk.raw, method: 'GET', path: proofPath(new URL(url)), ts });
    const req = () => new Request(url, { headers: { 'ds-proof': header } });
    expect(proofPath(new URL(url))).toBe(`/api/monitor/${NID}/glance?x=1`);
    expect(await verifyDsProof(req(), dk.jkt, nonces, { now: NOW + 59_000 })).toEqual({ ok: true });
    expect(await verifyDsProof(req(), dk.jkt, nonces, { now: NOW + 59_000 })).toEqual({ ok: false, reason: 'replay' });
    expect(await verifyDsProof(req(), dk.jkt, new MemoryNonceStore(), { now: NOW + 61_000 })).toEqual({ ok: false, reason: 'stale' });
    expect(await verifyDsProof(req(), dk.jkt, new MemoryNonceStore(), { now: NOW - 61_000 })).toEqual({ ok: false, reason: 'stale' });
    const other = await deviceKey();
    expect(await verifyDsProof(req(), other.jkt, new MemoryNonceStore(), { now: NOW })).toEqual({ ok: false, reason: 'key_mismatch' });
    // Same proof on another path or method: refused.
    const moved = new Request(url.replace('glance', 'act'), { method: 'GET', headers: { 'ds-proof': header } });
    expect(await verifyDsProof(moved, dk.jkt, new MemoryNonceStore(), { now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyDsProof(new Request(url), dk.jkt, nonces, { now: NOW })).toEqual({ ok: false, reason: 'missing' });
    for (const bad of ['v2.1.2.3.4', 'v1.123.short.x.y', `v1.${ts}.${'n'.repeat(20)}.AAAA.${'A'.repeat(86)}`]) {
      expect(await verifyDsProof(new Request(url, { headers: { 'ds-proof': bad } }), dk.jkt, nonces, { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('signs the body (given, or read from the request)', async () => {
    const dk = await deviceKey();
    const body = JSON.stringify({ a: 'ack', inc: 'i1', id: 'x' });
    const header = await signDsProof({ privateKey: dk.priv, publicRaw: dk.raw, method: 'POST', path: `/api/monitor/${NID}/act`, body, ts: NOW / 1000 });
    const mk = (b: string) => new Request(`https://w.example/api/monitor/${NID}/act`, { method: 'POST', body: b, headers: { 'ds-proof': header } });
    expect(await verifyDsProof(mk(body), dk.jkt, new MemoryNonceStore(), { now: NOW })).toEqual({ ok: true });
    const r = mk(body);
    expect(await verifyDsProof(r, dk.jkt, new MemoryNonceStore(), { now: NOW, body })).toEqual({ ok: true });
    expect(await r.text()).toBe(body); // the caller can still read it
    expect(await verifyDsProof(mk(body + ' '), dk.jkt, new MemoryNonceStore(), { now: NOW })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('the nonce memory forgets what has expired, and refuses to grow when flooded', () => {
    const s = new MemoryNonceStore(2);
    expect(s.checkAndSet('a', 100, 0)).toBe(false);
    expect(s.checkAndSet('a', 100, 50)).toBe(true);
    expect(s.checkAndSet('b', 100, 50)).toBe(false);
    expect(s.checkAndSet('c', 100, 60)).toBe(true); // full of live entries
    expect(s.checkAndSet('c', 300, 150)).toBe(false); // a and b have lapsed
  });
});
