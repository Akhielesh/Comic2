// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryNonceStore, effectiveScopes, resetDeviceKeyCache, signDsProof, verifyDeviceToken } from './auth/deviceToken';
import { resetJwksCache } from './auth/jwks';
import { b64url, jwkThumbprint, ecJwkFromRaw, signEs256Jwt } from './auth/jose';
import { anonRpc, handleDevices, keyThumbprint, scopesFromCan, type DevicesEnv } from './devices';

const SUPA = 'https://proj.supabase.co';
const ME = '0a0a0a0a-1111-4222-8333-444455556666';
const SID = '5e5e5e5e-1111-4222-8333-444455556666';
const DEV = '7e7e7e7e-1111-4222-8333-444455556666';
const N1 = '9d9d9d9d-1111-4222-8333-444455556661';
const N2 = '9d9d9d9d-1111-4222-8333-444455556662';
const N3 = '9d9d9d9d-1111-4222-8333-444455556663';
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
let supaSigner: { priv: CryptoKey; jwk: Record<string, unknown> };
let serverJwk: string;
/** The watch's hardware key (Secure Enclave / Keystore in real life). */
let watch: { priv: CryptoKey; raw: Uint8Array; sigPub: string; jkt: string };
let stranger: { priv: CryptoKey; raw: Uint8Array };

beforeEach(async () => {
  resetJwksCache();
  resetDeviceKeyCache();
  if (!supaSigner) {
    const s = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
    const j = (await crypto.subtle.exportKey('jwk', s.publicKey)) as JsonWebKey;
    supaSigner = { priv: s.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, kid: 'k1', alg: 'ES256', use: 'sig' } };
    const server = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
    serverJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', server.privateKey));
    const w = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', w.publicKey)) as ArrayBuffer);
    watch = { priv: w.privateKey, raw, sigPub: b64url(raw), jkt: await jwkThumbprint(ecJwkFromRaw(raw)!) };
    const x = (await crypto.subtle.generateKey(P256, true, ['sign', 'verify'])) as CryptoKeyPair;
    stranger = { priv: x.privateKey, raw: new Uint8Array((await crypto.subtle.exportKey('raw', x.publicKey)) as ArrayBuffer) };
  }
});

const supaToken = (over: Record<string, unknown> = {}) =>
  signEs256Jwt(
    { alg: 'ES256', kid: 'k1', typ: 'JWT' },
    { iss: `${SUPA}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: ME, session_id: SID, aal: 'aal2', iat: nowS - 10, exp: nowS + 1200, ...over },
    supaSigner.priv,
  );

/** Supabase: roles per nursery, the device registry (v2 SQL, unless `v2: false`). */
function supabase(o: { roles?: Record<string, string | null>; v2?: boolean; active?: boolean | 'down'; activeUser?: string } = {}) {
  const roles = o.roles ?? { [N1]: 'parent', [N2]: 'viewer', [N3]: null };
  const calls: { fn: string; auth: string | null; apikey: string | null; args: Record<string, unknown> }[] = [];
  let revoked = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [supaSigner.jwk] });
    const h = (init?.headers ?? {}) as Record<string, string>;
    const fn = url.match(/\/rpc\/(\w+)$/)?.[1] ?? '';
    const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ fn, auth: h.authorization ?? null, apikey: h.apikey ?? null, args });
    const v2only = ['live_device_enroll', 'live_device_active', 'live_device_revoke'];
    if (o.v2 === false && v2only.includes(fn)) return new Response('{"code":"PGRST202"}', { status: 404 });
    switch (fn) {
      case 'monitor_my_role': {
        const role = roles[String(args.p_nursery)];
        return Response.json(role ? { ok: true, user_id: ME, role, mfa: true, aal: 'aal2' } : { ok: false });
      }
      case 'monitor_list':
        return Response.json({ ok: true, nurseries: Object.entries(roles).filter(([, r]) => r).map(([id]) => ({ id })) });
      case 'live_device_enroll':
        return Response.json({ ok: true, created: true, device: { id: DEV, name: String(args.p_name) || 'Apple Watch', platform: args.p_platform, thumb: args.p_thumb } });
      case 'live_device_active':
        if (o.active === 'down') return new Response('down', { status: 503 });
        return Response.json(o.active === false || revoked ? { ok: true, active: false } : { ok: true, active: true, user_id: o.activeUser ?? ME });
      case 'live_device_revoke':
        if (args.p_device !== DEV) return Response.json({ ok: false, error: 'not_found' });
        revoked = true;
        return Response.json({ ok: true, already: false, user_id: ME, device: { id: DEV, thumb: watch.jkt } });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, rpc: (fn: string) => calls.filter((c) => c.fn === fn) };
}

/** Rooms and lines recording the internal messages they get; `missing` = before ADR 0006 WS-9/WS-10. */
function cloudflare(o: { missing?: boolean; withKey?: boolean } = {}) {
  const got: { ns: string; name: string; path: string; body: Record<string, unknown> }[] = [];
  const ns = (label: string) => ({
    idFromName: (n: string) => n,
    get: (name: string) => ({
      fetch: async (req: Request) => {
        got.push({ ns: label, name, path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> });
        return o.missing ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json({ ok: true });
      },
    }),
  });
  const env: DevicesEnv = {
    SUPABASE_URL: SUPA,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    DEVICE_TOKEN_JWK: o.withKey === false ? undefined : serverJwk,
    MONITOR_ROOM: ns('room') as unknown as DurableObjectNamespace,
    USER_LINE: ns('line') as unknown as DurableObjectNamespace,
  };
  const pending: Promise<unknown>[] = [];
  return { env, got, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending.splice(0)) };
}

const enrollBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ sigPub: watch.sigPub, platform: 'watchos', name: 'Mom’s Watch', nurseries: [{ id: N1, can: 127 }, { id: N2, can: 127 }, { id: N3, can: 1 }], ...over });

const req = async (path: string, init: { method?: string; body?: string; bearer?: string | Promise<string>; proof?: string; headers?: Record<string, string> } = {}) =>
  new Request(`https://w.example/live-api/api/devices/${path}`, {
    method: init.method ?? 'POST',
    body: init.body,
    headers: {
      ...(init.bearer ? { authorization: `Bearer ${await init.bearer}` } : {}),
      ...(init.proof ? { 'DS-Proof': init.proof } : {}),
      ...init.headers,
    },
  });

const proofFor = (path: string, body: string, o: { key?: { priv: CryptoKey; raw: Uint8Array }; nonce?: string; ts?: number } = {}) =>
  signDsProof({ privateKey: (o.key ?? watch).priv, publicRaw: (o.key ?? watch).raw, method: 'POST', path, body, ts: o.ts ?? nowS, nonce: o.nonce });

async function enrolled(sb = supabase(), cf = cloudflare()) {
  const res = await handleDevices(await req('enroll', { body: enrollBody(), bearer: supaToken() }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW });
  return { res, body: (await res.json()) as Record<string, unknown> & { grant: string }, sb, cf };
}

describe('device registry is dormant until its key is set', () => {
  it('enrol and token answer 501 not_enabled and ask nobody', async () => {
    const sb = supabase();
    const cf = cloudflare({ withKey: false });
    for (const sub of ['enroll', 'token']) {
      const res = await handleDevices(await req(sub, { body: '{}', bearer: supaToken() }), cf.env, cf.ctx, sub, { fetcher: sb.fetcher, now: NOW });
      expect([res.status, await res.json()]).toEqual([501, { ok: false, error: 'not_enabled' }]);
    }
    expect(sb.calls.filter((c) => c.fn)).toEqual([]);
  });

  it('before live_security_v2.sql the registry isn’t there: 501, not an error', async () => {
    const { res, body } = await enrolled(supabase({ v2: false }));
    expect([res.status, body]).toEqual([501, { ok: false, error: 'not_enabled' }]);
  });
});

describe('POST /api/devices/enroll', () => {
  it('grants a watch what its person may do, never above a caregiver, only in their nurseries, bound to its key', async () => {
    const { res, body, sb, cf } = await enrolled();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, devId: DEV, nid: [N1, N2], created: true, exp: (nowS + 30 * 24 * 3600) * 1000 });
    // Parent in N1 (capped to caregiver), viewer in N2, nothing in N3.
    expect(body.scp).toEqual(['glance', 'ack', 'soothe', 'listen', 'talk', 'peek', 'duty', 'log']);
    const v = await verifyDeviceToken(cf.env, body.grant, 'grant', NOW);
    expect(v.ok && v.claims).toMatchObject({ sub: ME, dev: DEV, cnf: { jkt: watch.jkt }, nid: [N1, N2] });
    // At use, each nursery narrows it to the person's role there.
    expect(effectiveScopes(body.scp as string[], 'viewer')).toEqual(['glance', 'listen', 'peek']);
    // Every nursery asked with the caller's own token; the registry got the key's thumbprint.
    expect(sb.rpc('monitor_my_role').map((c) => c.args.p_nursery).sort()).toEqual([N1, N2, N3]);
    expect(sb.rpc('live_device_enroll')[0].args).toEqual({ p_thumb: watch.jkt, p_platform: 'watchos', p_name: 'Mom’s Watch' });
    // Announced on the person's other devices (the call line's /x/notify, WS-10).
    await cf.settle();
    expect(cf.got).toEqual([{ ns: 'line', name: `u:${ME}`, path: '/x/notify', body: { uid: ME, kind: 'device_added', at: NOW, name: 'Mom’s Watch', platform: 'watchos' } }]);
  });

  it('asks for less, gets less: `can` 0 is glance only', async () => {
    const sb = supabase();
    const cf = cloudflare();
    const res = await handleDevices(await req('enroll', { body: enrollBody({ nurseries: [{ id: N1, can: 0 }] }), bearer: supaToken() }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW });
    expect(((await res.json()) as { scp: string[] }).scp).toEqual(['glance']);
  });

  it('device approval is an admin action: aal2 from anyone with a second factor', async () => {
    const sb = supabase();
    const cf = cloudflare();
    const res = await handleDevices(await req('enroll', { body: enrollBody(), bearer: supaToken({ ds_mfa: true, aal: 'aal1' }) }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW });
    expect([res.status, await res.json()]).toEqual([403, { ok: false, error: 'mfa_required' }]);
    expect(sb.rpc('live_device_enroll')).toEqual([]);
  });

  it('no nursery the person belongs to: nothing is granted', async () => {
    const sb = supabase({ roles: { [N1]: null } });
    const cf = cloudflare();
    const res = await handleDevices(await req('enroll', { body: enrollBody({ nurseries: [{ id: N1, can: 127 }] }), bearer: supaToken() }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW });
    expect([res.status, await res.json()]).toEqual([403, { ok: false, error: 'forbidden' }]);
    expect(sb.rpc('live_device_enroll')).toEqual([]);
  });

  it('refuses malformed keys, platforms and nursery lists before asking Supabase anything but who you are', async () => {
    const sb = supabase();
    const cf = cloudflare();
    for (const over of [
      { sigPub: 'not-a-key' },
      { sigPub: b64url(new Uint8Array(65)) },
      { platform: 'toaster' },
      { nurseries: [] },
      { nurseries: [{ id: 'x', can: 1 }] },
      { nurseries: [{ id: N1, can: 300 }] },
      { ecdhPub: 'nope' },
    ]) {
      const res = await handleDevices(await req('enroll', { body: enrollBody(over), bearer: supaToken() }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW });
      expect(res.status, JSON.stringify(over)).toBe(400);
    }
    expect(sb.calls.filter((c) => c.fn)).toEqual([]);
    expect((await handleDevices(await req('enroll', { body: enrollBody() }), cf.env, cf.ctx, 'enroll', { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
  });
});

describe('POST /api/devices/token', () => {
  it('trades a grant and a fresh proof by the hardware key for a 10-minute access token', async () => {
    const { body: e, sb, cf } = await enrolled();
    const body = JSON.stringify({ grant: e.grant });
    const res = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() });
    expect(res.status).toBe(200);
    const t = (await res.json()) as { access: string; exp: number; nid: string[]; scp: string[] };
    expect(t.exp).toBe((nowS + 600) * 1000);
    expect(t.nid).toEqual([N1, N2]);
    const v = await verifyDeviceToken(cf.env, t.access, 'access', NOW);
    expect(v.ok && v.claims).toMatchObject({ sub: ME, dev: DEV, cnf: { jkt: watch.jkt } });
    // Revocation is checked on every exchange — without any session (publishable key only).
    const active = sb.rpc('live_device_active');
    expect(active).toEqual([{ fn: 'live_device_active', auth: null, apikey: 'sb_publishable_test', args: { p_device: DEV, p_thumb: watch.jkt } }]);
  });

  it('a stolen grant is useless: no proof, another key’s proof, a replayed proof or a stale one get nothing', async () => {
    const { body: e, sb, cf } = await enrolled();
    const body = JSON.stringify({ grant: e.grant });
    const nonces = new MemoryNonceStore();
    const go = async (proof?: string) => {
      const res = await handleDevices(await req('token', { body, proof }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW, nonces });
      const out = (await res.json()) as { reason?: string; error?: string };
      return [res.status, out.reason ?? out.error];
    };
    expect(await go()).toEqual([401, 'missing']);
    expect(await go(await proofFor('/api/devices/token', body, { key: stranger }))).toEqual([401, 'key_mismatch']);
    expect(await go(await proofFor('/api/devices/token', body, { ts: nowS - 120 }))).toEqual([401, 'stale']);
    expect(await go(await proofFor('/api/devices/token', '{"grant":"other"}'))).toEqual([401, 'bad_signature']);
    const once = await proofFor('/api/devices/token', body, { nonce: 'n'.repeat(22) });
    expect((await go(once))[0]).toBe(200);
    expect(await go(once)).toEqual([401, 'replay']);
  });

  it('a revoked device gets no new token; Supabase unreachable mints nothing (fail closed)', async () => {
    for (const [active, status, error] of [
      [false, 401, 'revoked'],
      ['down', 503, 'unavailable'],
    ] as const) {
      const { body: e, cf } = await enrolled();
      const sb = supabase({ active });
      const body = JSON.stringify({ grant: e.grant });
      const res = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() });
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, error]);
    }
    // A device row that now belongs to someone else is not this grant's.
    const { body: e, cf } = await enrolled();
    const body = JSON.stringify({ grant: e.grant });
    const res = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: supabase({ activeUser: N1 }).fetcher, now: NOW, nonces: new MemoryNonceStore() });
    expect(res.status).toBe(401);
  });

  it('an access token is not a grant, and an expired grant says so', async () => {
    const { body: e, sb, cf } = await enrolled();
    const later = NOW + 31 * 24 * 3600_000;
    const body = JSON.stringify({ grant: e.grant });
    const res = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: later });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([401, 'grant_expired']);
    const junk = JSON.stringify({ grant: await supaToken() });
    const res2 = await handleDevices(await req('token', { body: junk, proof: await proofFor('/api/devices/token', junk) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW });
    expect([res2.status, ((await res2.json()) as { error: string }).error]).toEqual([401, 'invalid_grant']);
  });
});

describe('POST /api/devices/push', () => {
  const apns = { kind: 'apns', token: 'a'.repeat(64), enc: { p256dh: '', auth: '' }, plat: 'watchos' };

  async function accessToken() {
    const { body: e, sb, cf } = await enrolled();
    const body = JSON.stringify({ grant: e.grant });
    const res = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() });
    return { access: ((await res.json()) as { access: string }).access, sb, cf };
  }

  it('a watch registers where it gets pushes in each of its nurseries (with its own proof)', async () => {
    const { access, sb, cf } = await accessToken();
    const keys = await import('./push/testKit').then((m) => m.testDeviceKeys());
    const body = JSON.stringify({ ...apns, enc: { p256dh: keys.p256dh, auth: keys.auth } });
    cf.got.length = 0;
    const res = await handleDevices(await req('push', { body, bearer: access, proof: await proofFor('/api/devices/push', body) }), cf.env, cf.ctx, 'push', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, rooms: 2, stored: 2 }]);
    expect(cf.got.map((g) => [g.name, g.path])).toEqual([
      [N1, '/x/push-reg'],
      [N2, '/x/push-reg'],
    ]);
    expect(cf.got[0].body).toMatchObject({ uid: ME, dev: DEV, via: 'device', sub: { kind: 'apns', uid: ME, dev: DEV, token: 'a'.repeat(64), plat: 'watchos', enc: { p256dh: keys.p256dh, auth: keys.auth } } });
  });

  it('without a proof, or with junk, nothing is stored', async () => {
    const { access, sb, cf } = await accessToken();
    cf.got.length = 0;
    const body = JSON.stringify({ kind: 'apns', token: 'a'.repeat(64) });
    expect((await handleDevices(await req('push', { body, bearer: access }), cf.env, cf.ctx, 'push', { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
    const bad = JSON.stringify({ kind: 'apns', token: 'not-hex' });
    expect((await handleDevices(await req('push', { body: bad, bearer: access, proof: await proofFor('/api/devices/push', bad) }), cf.env, cf.ctx, 'push', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() })).status).toBe(400);
    expect(cf.got).toEqual([]);
  });

  it('a signed-in phone registers for its nurseries with its account token', async () => {
    const sb = supabase();
    const cf = cloudflare();
    const body = JSON.stringify({ kind: 'fcm', token: 'f'.repeat(160), dev: 'd'.repeat(22), nids: [N2] });
    const res = await handleDevices(await req('push', { body, bearer: supaToken() }), cf.env, cf.ctx, 'push', { fetcher: sb.fetcher, now: NOW });
    expect(await res.json()).toEqual({ ok: true, rooms: 1, stored: 1 });
    expect(cf.got[0]).toMatchObject({ name: N2, path: '/x/push-reg', body: { uid: ME, dev: 'd'.repeat(22), via: 'account', sub: { kind: 'fcm' } } });
  });

  it('rooms that don’t take native push yet: 501 not_enabled', async () => {
    const sb = supabase();
    const cf = cloudflare({ missing: true });
    const body = JSON.stringify({ kind: 'fcm', token: 'f'.repeat(160) });
    const res = await handleDevices(await req('push', { body, bearer: supaToken() }), cf.env, cf.ctx, 'push', { fetcher: sb.fetcher, now: NOW });
    expect([res.status, await res.json()]).toEqual([501, { ok: false, error: 'not_enabled', rooms: 2, stored: 0 }]);
  });
});

describe('DELETE /api/devices/:id', () => {
  it('revokes in Supabase, then every nursery hears it at once; the device’s next token exchange is refused', async () => {
    const { body: e, sb, cf } = await enrolled();
    cf.got.length = 0;
    const res = await handleDevices(await req(DEV, { method: 'DELETE', bearer: supaToken() }), cf.env, cf.ctx, DEV, { fetcher: sb.fetcher, now: NOW });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, already: false, rooms: 2, told: 2 }]);
    expect(cf.got.map((g) => [g.name, g.path, g.body])).toEqual([
      [N1, '/x/device-revoked', { uid: ME, dev: DEV, thumb: watch.jkt }],
      [N2, '/x/device-revoked', { uid: ME, dev: DEV, thumb: watch.jkt }],
    ]);
    const body = JSON.stringify({ grant: e.grant });
    const t = await handleDevices(await req('token', { body, proof: await proofFor('/api/devices/token', body) }), cf.env, cf.ctx, 'token', { fetcher: sb.fetcher, now: NOW, nonces: new MemoryNonceStore() });
    expect([t.status, ((await t.json()) as { error: string }).error]).toEqual([401, 'revoked']);
  });

  it('needs aal2 from anyone with a second factor; someone else’s device is not found', async () => {
    const sb = supabase();
    const cf = cloudflare();
    const mfa = await handleDevices(await req(DEV, { method: 'DELETE', bearer: supaToken({ ds_mfa: true, aal: 'aal1' }) }), cf.env, cf.ctx, DEV, { fetcher: sb.fetcher, now: NOW });
    expect(mfa.status).toBe(403);
    const other = '1f1f1f1f-1111-4222-8333-444455556666';
    const nf = await handleDevices(await req(other, { method: 'DELETE', bearer: supaToken() }), cf.env, cf.ctx, other, { fetcher: sb.fetcher, now: NOW });
    expect([nf.status, await nf.json()]).toEqual([404, { ok: false, error: 'not_found' }]);
    expect(cf.got).toEqual([]);
  });
});

describe('device routes', () => {
  it('the device-code flow is Phase 3; unknown paths and wrong methods are refused', async () => {
    const cf = cloudflare();
    for (const sub of ['code', 'approve']) expect((await handleDevices(await req(sub, { body: '{}' }), cf.env, cf.ctx, sub)).status).toBe(501);
    expect((await handleDevices(await req('nope', { body: '{}' }), cf.env, cf.ctx, 'nope')).status).toBe(404);
    expect((await handleDevices(await req('enroll', { method: 'GET' }), cf.env, cf.ctx, 'enroll')).status).toBe(405);
    expect((await handleDevices(await req(DEV, { method: 'POST', body: '{}' }), cf.env, cf.ctx, DEV)).status).toBe(405);
  });

  it('helpers: scopes from can bits, key thumbprints, the session-less RPC', async () => {
    expect(scopesFromCan(0)).toEqual(['glance']);
    expect(scopesFromCan(1 | 16)).toEqual(['glance', 'ack', 'peek']);
    expect(await keyThumbprint(watch.sigPub)).toBe(watch.jkt);
    expect(await keyThumbprint(b64url(new Uint8Array(33)))).toBeNull();
    const seen: Record<string, string>[] = [];
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => (seen.push(init?.headers as Record<string, string>), Response.json({ ok: true }))) as typeof fetch;
    await anonRpc({ SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' }, 'f', {}, f);
    await anonRpc({ SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'eyJlegacy.anon.key' }, 'f', {}, f);
    expect(seen[0].authorization).toBeUndefined(); // a publishable key is never a bearer
    expect(seen[1].authorization).toBe('Bearer eyJlegacy.anon.key'); // a legacy anon JWT is
  });
});
