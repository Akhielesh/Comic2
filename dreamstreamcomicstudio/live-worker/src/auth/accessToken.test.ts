// @vitest-environment node
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { b64url, jwkThumbprint, parseJwt, signEs256Jwt, unb64url } from './jose';
import { JWKS_FAIL_HOLD_MS, JWKS_MISS_REFETCH_MS, JWKS_TTL_MS, getSigningKey, resetJwksCache } from './jwks';
import { CLOSE, MemoryRoleStore, ROLE_TTL_MS, SqlRoleStore, admitMember, closeAtFor } from './roleCache';
import { EXPIRY_GRACE_MS, mfaProblem, stepUpNeeded, verifyAccessToken } from '../supabaseAuth';

const SUPA = 'https://proj.supabase.co';
const env = { SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
const UID = '0a0a0a0a-1111-4222-8333-444455556666';
const SID = '5e5e5e5e-1111-4222-8333-444455556666';
const NID = '9d9d9d9d-1111-4222-8333-444455556666';
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);

const enc = new TextEncoder();

async function ecKey(kid: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } };
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: `${SUPA}/auth/v1`,
  aud: 'authenticated',
  role: 'authenticated',
  sub: UID,
  session_id: SID,
  aal: 'aal1',
  iat: nowS - 10,
  exp: nowS + 1200,
  ...over,
});

/** A fake Supabase: JWKS and the two RPCs, counting calls. */
function fakeSupabase(o: { keys: unknown[]; live_me?: (token: string) => Response; my_role?: (token: string) => Response; jwksStatus?: number }) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization || '').replace(/^Bearer /, '');
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) {
      return o.jwksStatus ? new Response('nope', { status: o.jwksStatus }) : Response.json({ keys: o.keys });
    }
    if (url.endsWith('/rest/v1/rpc/live_me')) return o.live_me ? o.live_me(token) : new Response('{}', { status: 500 });
    if (url.endsWith('/rest/v1/rpc/monitor_my_role')) return o.my_role ? o.my_role(token) : new Response('{}', { status: 500 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, count: (part: string) => calls.filter((c) => c.includes(part)).length };
}

let k1: Awaited<ReturnType<typeof ecKey>>;
beforeEach(async () => {
  resetJwksCache();
  k1 ??= await ecKey('key-1');
});

describe('jose helpers', () => {
  it('base64url round-trips and rejects junk', () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    expect(unb64url(b64url(bytes))).toEqual(bytes);
    expect(unb64url('a+b/')).toBeNull();
    expect(unb64url('abcde')).toBeNull();
  });

  it('computes RFC 7638 thumbprints (the RFC’s own RSA example)', async () => {
    const n =
      '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
    expect(await jwkThumbprint({ kty: 'RSA', n, e: 'AQAB' })).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('only parses three-part JSON tokens', () => {
    expect(parseJwt('a.b')).toBeNull();
    expect(parseJwt('x.y.z')).toBeNull();
    expect(parseJwt(`${b64url(enc.encode('[]'))}.${b64url(enc.encode('{}'))}.`)).toBeNull();
  });
});

describe('JWKS cache', () => {
  it('fetches once per 15 minutes, and refetches early (rate limited) for an unknown kid', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk] });
    expect('key' in (await getSigningKey(env, 'key-1', 'ES256', NOW, sb.fetcher))).toBe(true);
    expect('key' in (await getSigningKey(env, 'key-1', 'ES256', NOW + 60_000, sb.fetcher))).toBe(true);
    expect(sb.count('jwks')).toBe(1);
    // A kid we don't have: one refetch, then no more for 30 s.
    expect(await getSigningKey(env, 'rotated', 'ES256', NOW + 61_000, sb.fetcher)).toEqual({ missing: true });
    expect(await getSigningKey(env, 'rotated-2', 'ES256', NOW + 62_000, sb.fetcher)).toEqual({ missing: true });
    expect(sb.count('jwks')).toBe(2);
    await getSigningKey(env, 'rotated-3', 'ES256', NOW + 61_000 + JWKS_MISS_REFETCH_MS, sb.fetcher);
    expect(sb.count('jwks')).toBe(3);
    // Each refetch restarts the 15 minutes.
    await getSigningKey(env, 'key-1', 'ES256', NOW + 61_000 + JWKS_MISS_REFETCH_MS + JWKS_TTL_MS - 1, sb.fetcher);
    expect(sb.count('jwks')).toBe(3);
    await getSigningKey(env, 'key-1', 'ES256', NOW + 61_000 + JWKS_MISS_REFETCH_MS + JWKS_TTL_MS, sb.fetcher);
    expect(sb.count('jwks')).toBe(4);
  });

  it('never matches an EC kid for RS256 (no algorithm confusion)', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk] });
    expect(await getSigningKey(env, 'key-1', 'RS256', NOW, sb.fetcher)).toEqual({ missing: true });
  });

  it('reports unavailable when the list can’t be fetched, and holds retries', async () => {
    const sb = fakeSupabase({ keys: [], jwksStatus: 503 });
    expect(await getSigningKey(env, 'key-1', 'ES256', NOW, sb.fetcher)).toEqual({ unavailable: true });
    expect(await getSigningKey(env, 'key-1', 'ES256', NOW + 1000, sb.fetcher)).toEqual({ unavailable: true });
    expect(sb.count('jwks')).toBe(1);
    await getSigningKey(env, 'key-1', 'ES256', NOW + JWKS_FAIL_HOLD_MS + 1, sb.fetcher);
    expect(sb.count('jwks')).toBe(2);
    expect(await getSigningKey({}, 'key-1', 'ES256', NOW, sb.fetcher)).toEqual({ unavailable: true });
  });
});

describe('verifyAccessToken', () => {
  const sign = (c: Record<string, unknown>, key = k1) => signEs256Jwt({ kid: key.jwk.kid }, c, key.priv);

  it('verifies an ES256 token locally — no RPC — and reads uid, session, exp, aal and the ds_mfa claim', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk] });
    const r = await verifyAccessToken(await sign(claims({ ds_mfa: true, aal: 'aal2' })), env, { now: NOW, fetcher: sb.fetcher });
    expect(r).toEqual({ ok: true, id: { uid: UID, sid: SID, exp: nowS + 1200, aal: 'aal2', mfa: true, via: 'jwks' } });
    expect(sb.count('/rpc/')).toBe(0);
    // Without the hook the MFA state is unknown, not "off".
    const r2 = await verifyAccessToken(await sign(claims()), env, { now: NOW, fetcher: sb.fetcher });
    expect(r2.ok && r2.id.mfa).toBeNull();
  });

  it('refuses tampering, other issuers and audiences, anon keys, `none`, and expired tokens', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk] });
    const v = (t: string) => verifyAccessToken(t, env, { now: NOW, fetcher: sb.fetcher });
    const good = await sign(claims());
    const [h, , s] = good.split('.');
    const forged = `${h}.${b64url(enc.encode(JSON.stringify(claims({ sub: '0b0b0b0b-1111-4222-8333-444455556666' }))))}.${s}`;
    expect(await v(forged)).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(await sign(claims({ iss: 'https://evil.supabase.co/auth/v1' })))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(await sign(claims({ aud: 'other' })))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(await sign(claims({ role: 'anon' })))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(await sign(claims({ iat: nowS + 3600 })))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(await sign(claims({ exp: nowS - 60 })))).toEqual({ ok: false, reason: 'expired', uid: UID });
    const none = `${b64url(enc.encode('{"alg":"none","kid":"key-1"}'))}.${b64url(enc.encode(JSON.stringify(claims())))}.`;
    expect(await v(none)).toMatchObject({ ok: false });
    const noneSig = `${b64url(enc.encode('{"alg":"none"}'))}.${b64url(enc.encode(JSON.stringify(claims())))}.${b64url(new Uint8Array(64))}`;
    expect(await v(noneSig)).toEqual({ ok: false, reason: 'invalid' });
    expect(await v('not-a-token')).toEqual({ ok: false, reason: 'malformed' });
    expect(await v(await sign(claims({ sub: 'not-a-uuid' })))).toEqual({ ok: false, reason: 'malformed' });
    // Signed by a key Supabase doesn't list.
    const stranger = await ecKey('key-1');
    expect(await v(await sign(claims(), stranger))).toEqual({ ok: false, reason: 'invalid' });
    expect(sb.count('/rpc/')).toBe(0);
  });

  it('verifies RS256 keys too', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const sb = fakeSupabase({ keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'rsa-1', alg: 'RS256' }] });
    const h = b64url(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'rsa-1', typ: 'JWT' })));
    const p = b64url(enc.encode(JSON.stringify(claims())));
    const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`)));
    expect(await verifyAccessToken(`${h}.${p}.${sig}`, env, { now: NOW, fetcher: sb.fetcher })).toMatchObject({ ok: true, id: { uid: UID, via: 'jwks' } });
  });

  it('asks Supabase for legacy HS256 tokens, and maps its answers', async () => {
    const hs = `${b64url(enc.encode('{"alg":"HS256","typ":"JWT"}'))}.${b64url(enc.encode(JSON.stringify(claims())))}.${b64url(new Uint8Array(32))}`;
    const ans = (body: unknown, status = 200) => fakeSupabase({ keys: [], live_me: () => new Response(JSON.stringify(body), { status }) });
    const v = async (sb: ReturnType<typeof fakeSupabase>) => verifyAccessToken(hs, env, { now: NOW, fetcher: sb.fetcher });
    expect(await v(ans({ signed_in: true, member: true, user_id: UID, mfa: false }))).toEqual({ ok: true, id: { uid: UID, sid: SID, exp: nowS + 1200, aal: 'aal1', mfa: false, via: 'rpc' } });
    expect(await v(ans({ signed_in: false, member: false, error: 'session_revoked' }))).toEqual({ ok: false, reason: 'revoked', uid: UID });
    expect(await v(ans({ signed_in: true, member: false, user_id: UID, error: 'mfa_required' }))).toEqual({ ok: false, reason: 'mfa_required', uid: UID });
    expect(await v(ans({ signed_in: true, user_id: '0b0b0b0b-1111-4222-8333-444455556666' }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(ans({ message: 'JWT expired' }, 401))).toEqual({ ok: false, reason: 'invalid' });
    expect(await v(ans({}, 503))).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('falls back to Supabase when the key list is unreachable', async () => {
    const sb = fakeSupabase({ keys: [], jwksStatus: 500, live_me: () => Response.json({ signed_in: true, member: true, user_id: UID, mfa: true }) });
    const r = await verifyAccessToken(await sign(claims({ aal: 'aal2' })), env, { now: NOW, fetcher: sb.fetcher });
    expect(r).toMatchObject({ ok: true, id: { via: 'rpc', mfa: true, aal: 'aal2' } });
  });

  it('says who must finish two-step sign-in', () => {
    expect(mfaProblem({ mfa: true, aal: 'aal1' })).toBe(true);
    expect(mfaProblem({ mfa: true, aal: 'aal2' })).toBe(false);
    expect(mfaProblem({ mfa: false, aal: 'aal1' })).toBe(false);
    expect(mfaProblem({ mfa: null, aal: 'aal1' })).toBe(false);
    expect(stepUpNeeded({ mfa: true, aal: 'aal1' })).toBe(true);
  });
});

describe('admitMember (role cache + aal2)', () => {
  const sign = (c: Record<string, unknown>) => signEs256Jwt({ kid: 'key-1' }, claims(c), k1.priv);
  const role = (body: Record<string, unknown>, status = 200) => () => new Response(JSON.stringify(body), { status });
  const parent = { ok: true, user_id: UID, role: 'parent', label: 'Mom', display_name: 'Ada', mfa: false };

  it('asks Supabase on first sight, then answers from the cache for 6 hours', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk], my_role: role(parent) });
    const store = new MemoryRoleStore();
    const token = await sign({});
    const a = await admitMember({ token, nid: NID, env, store, now: NOW, fetcher: sb.fetcher });
    expect(a).toMatchObject({ ok: true, role: 'parent', label: 'Mom', name: 'Ada', checked: 'rpc', closeAt: (nowS + 1200) * 1000 + EXPIRY_GRACE_MS });
    expect(await admitMember({ token, nid: NID, env, store, now: NOW + 60_000, fetcher: sb.fetcher })).toMatchObject({ ok: true, checked: 'cache' });
    expect(sb.count('monitor_my_role')).toBe(1);
    const later = await sign({ iat: nowS + ROLE_TTL_MS / 1000, exp: nowS + ROLE_TTL_MS / 1000 + 1200 });
    expect(await admitMember({ token: later, nid: NID, env, store, now: NOW + ROLE_TTL_MS + 1, fetcher: sb.fetcher })).toMatchObject({ ok: true, checked: 'rpc' });
    expect(sb.count('monitor_my_role')).toBe(2);
    expect(closeAtFor(100)).toBe(100_000 + 120_000);
  });

  it('refuses aal1 for anyone with a second factor — from the claim, or from Supabase when the hook is off', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk], my_role: role({ ...parent, mfa: true }) });
    const store = new MemoryRoleStore();
    expect(await admitMember({ token: await sign({ ds_mfa: true }), nid: NID, env, store, now: NOW, fetcher: sb.fetcher })).toEqual({ ok: false, code: CLOSE.MFA_REQUIRED, reason: 'mfa_required' });
    expect(sb.count('monitor_my_role')).toBe(0);
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: sb.fetcher })).toMatchObject({ ok: false, code: 4003 });
    // …and again afterwards: a cached factor against an aal1 token is re-asked, never refused from memory alone.
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW + 1000, fetcher: sb.fetcher })).toMatchObject({ ok: false, code: 4003 });
    expect(sb.count('monitor_my_role')).toBe(2);
    expect(await admitMember({ token: await sign({ aal: 'aal2' }), nid: NID, env, store, now: NOW + 2000, fetcher: sb.fetcher })).toMatchObject({ ok: true, mfa: true, id: { mfa: true } });
    const told = fakeSupabase({ keys: [k1.jwk], my_role: role({ ok: false, error: 'mfa_required' }) });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store: new MemoryRoleStore(), now: NOW, fetcher: told.fetcher })).toMatchObject({ ok: false, code: 4003 });
  });

  it('a cached "has a second factor" never locks anyone out: the fresh claim wins, and a disagreement asks Supabase', async () => {
    // Ada turned two-step sign-in off an hour ago; the room still remembers her with it on.
    const remembered = { uid: UID, role: 'parent' as const, label: 'Mom', name: 'Ada', mfa: true, at: NOW - 3600_000 };
    const nowOff = fakeSupabase({ keys: [k1.jwk], my_role: role(parent) });
    let store = new MemoryRoleStore();
    store.put(remembered);
    // Her new aal1 token says ds_mfa: false (signed by Supabase just now): she's in, and Supabase confirms it once.
    expect(await admitMember({ token: await sign({ ds_mfa: false }), nid: NID, env, store, now: NOW, fetcher: nowOff.fetcher })).toMatchObject({
      ok: true,
      role: 'parent',
      mfa: false,
      id: { mfa: false },
      checked: 'rpc',
    });
    expect(nowOff.count('monitor_my_role')).toBe(1);
    expect(store.get(UID)).toMatchObject({ mfa: false, at: NOW });
    // …and from then on the cache agrees: no more round trips.
    expect(await admitMember({ token: await sign({ ds_mfa: false }), nid: NID, env, store, now: NOW + 60_000, fetcher: nowOff.fetcher })).toMatchObject({ ok: true, checked: 'cache' });
    expect(nowOff.count('monitor_my_role')).toBe(1);

    // Hook off (no ds_mfa claim): the stale cache doesn't refuse either — Supabase is asked.
    store = new MemoryRoleStore();
    store.put(remembered);
    const hookOff = fakeSupabase({ keys: [k1.jwk], my_role: role(parent) });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: hookOff.fetcher })).toMatchObject({ ok: true, mfa: false, checked: 'rpc' });
    expect(hookOff.count('monitor_my_role')).toBe(1);

    // Still on (Supabase says so): 4003 — Supabase's answer, not the cache's.
    store = new MemoryRoleStore();
    store.put(remembered);
    const stillOn = fakeSupabase({ keys: [k1.jwk], my_role: role({ ok: false, error: 'mfa_required' }) });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: stillOn.fetcher })).toEqual({ ok: false, code: CLOSE.MFA_REQUIRED, reason: 'mfa_required' });
    expect(stillOn.count('monitor_my_role')).toBe(1);
    // The cache entry survives (she's still a parent), so an aal2 token is let straight in.
    expect(await admitMember({ token: await sign({ aal: 'aal2', ds_mfa: true }), nid: NID, env, store, now: NOW + 1000, fetcher: stillOn.fetcher })).toMatchObject({ ok: true, checked: 'cache', mfa: true });

    // Supabase down: the token's own claim decides; with no claim, "try again" — never 4003 from memory, never in unchecked.
    const down = fakeSupabase({ keys: [k1.jwk], my_role: role({}, 503) });
    store = new MemoryRoleStore();
    store.put(remembered);
    expect(await admitMember({ token: await sign({ ds_mfa: false }), nid: NID, env, store, now: NOW, fetcher: down.fetcher })).toMatchObject({ ok: true, checked: 'stale', mfa: false });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: down.fetcher })).toEqual({ ok: false, code: CLOSE.TRY_AGAIN, reason: 'unavailable' });
    // An aal2 token never needed the answer.
    expect(await admitMember({ token: await sign({ aal: 'aal2' }), nid: NID, env, store, now: NOW, fetcher: down.fetcher })).toMatchObject({ ok: true, checked: 'cache' });
    expect(down.count('monitor_my_role')).toBe(2);
  });

  it('closes removed members and revoked sessions with 4004, expired tokens with 4001, and forgets the removed', async () => {
    const store = new MemoryRoleStore();
    store.put({ uid: UID, role: 'viewer', label: null, name: 'Ada', mfa: false, at: NOW - ROLE_TTL_MS - 1 });
    const gone = fakeSupabase({ keys: [k1.jwk], my_role: role({ ok: false }) });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: gone.fetcher })).toEqual({ ok: false, code: CLOSE.REMOVED, reason: 'removed' });
    expect(store.get(UID)).toBeNull();
    const revoked = fakeSupabase({ keys: [k1.jwk], my_role: role({ ok: false, error: 'session_revoked' }) });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: revoked.fetcher })).toEqual({ ok: false, code: 4004, reason: 'revoked' });
    expect(await admitMember({ token: await sign({ exp: nowS - 100 }), nid: NID, env, store, now: NOW, fetcher: revoked.fetcher })).toEqual({ ok: false, code: 4001, reason: 'expired' });
    expect(await admitMember({ token: 'garbage', nid: NID, env, store, now: NOW, fetcher: revoked.fetcher })).toEqual({ ok: false, code: 4001, reason: 'invalid' });
  });

  it('a reauth must be the same person; a recheck asks again even with a fresh cache', async () => {
    const sb = fakeSupabase({ keys: [k1.jwk], my_role: role(parent) });
    const store = new MemoryRoleStore();
    await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: sb.fetcher });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: sb.fetcher, expectUid: '0b0b0b0b-1111-4222-8333-444455556666' })).toEqual({ ok: false, code: 4004, reason: 'mismatch' });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: sb.fetcher, expectUid: UID.toUpperCase() })).toMatchObject({ ok: true, checked: 'cache' });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: sb.fetcher, recheck: true })).toMatchObject({ ok: true, checked: 'rpc' });
  });

  it('keeps known members connected through a Supabase outage; strangers wait', async () => {
    const down = fakeSupabase({ keys: [k1.jwk], my_role: role({}, 503) });
    const store = new MemoryRoleStore();
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: down.fetcher })).toEqual({ ok: false, code: CLOSE.TRY_AGAIN, reason: 'unavailable' });
    store.put({ uid: UID, role: 'caregiver', label: null, name: 'Ada', mfa: false, at: NOW - ROLE_TTL_MS - 1 });
    expect(await admitMember({ token: await sign({}), nid: NID, env, store, now: NOW, fetcher: down.fetcher })).toMatchObject({ ok: true, role: 'caregiver', checked: 'stale' });
  });

  it('persists the cache in the room’s SQLite', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const sql = {
      exec(q: string, ...b: unknown[]) {
        const st = db.prepare(q);
        try {
          st.bind(b.map((v) => (v === undefined ? null : v)) as never);
          const rows: Record<string, unknown>[] = [];
          while (st.step()) rows.push(st.getAsObject());
          return { toArray: () => rows };
        } finally {
          st.free();
        }
      },
    };
    const store = new SqlRoleStore(sql);
    new SqlRoleStore(sql); // opening again is harmless
    store.put({ uid: UID, role: 'parent', label: 'Mom', name: 'Ada', mfa: true, at: 5 });
    store.put({ uid: UID, role: 'viewer', label: null, name: 'Ada L', mfa: false, at: 6 });
    store.put({ uid: 'u2', role: 'caregiver', label: null, name: 'Bo', mfa: false, at: 7 });
    expect(store.get(UID)).toEqual({ uid: UID, role: 'viewer', label: null, name: 'Ada L', mfa: false, at: 6 });
    store.drop([UID]);
    expect(store.get(UID)).toBeNull();
    expect(store.get('u2')?.role).toBe('caregiver');
    store.drop();
    expect(store.get('u2')).toBeNull();
  });
});
