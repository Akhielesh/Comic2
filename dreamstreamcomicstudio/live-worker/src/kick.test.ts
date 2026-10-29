// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJwksCache } from './auth/jwks';
import { b64url, signEs256Jwt } from './auth/jose';
import { KICK_BUDGET_MS, MAX_ROOMS, ROOM_TIMEOUT_MS, callsNamed, handleKick, kickResult, myNurseries, revokeTurnUsernames, tellRoom, verifyCaller, type KickEnv } from './kick';

const SUPA = 'https://proj.supabase.co';
const ME = '0a0a0a0a-1111-4222-8333-444455556666';
const OTHER = '0b0b0b0b-1111-4222-8333-444455556666';
const SID = '5e5e5e5e-1111-4222-8333-444455556666';
const N1 = '9d9d9d9d-1111-4222-8333-444455556661';
const N2 = '9d9d9d9d-1111-4222-8333-444455556662';
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);

let signer: { priv: CryptoKey; jwk: Record<string, unknown> };
beforeEach(async () => {
  resetJwksCache();
  if (!signer) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    signer = { priv: pair.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: 'k1', alg: 'ES256', use: 'sig' } };
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A Supabase access token as the project would sign it (ES256, listed in its JWKS). */
const token = (over: Record<string, unknown> = {}) =>
  signEs256Jwt(
    { alg: 'ES256', kid: 'k1', typ: 'JWT' },
    { iss: `${SUPA}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: ME, session_id: SID, aal: 'aal1', iat: nowS - 10, exp: nowS + 1200, ...over },
    signer.priv,
  );
/** A legacy HS256 token: only Supabase itself can verify it (the RPC path). */
const legacyToken = (sub = ME) =>
  `${b64url(new TextEncoder().encode('{"alg":"HS256","typ":"JWT"}'))}.${b64url(new TextEncoder().encode(JSON.stringify({ sub, exp: nowS + 600 })))}.${b64url(new Uint8Array(32))}`;

type Rpc = (token: string, args: Record<string, unknown>) => Response | unknown;

/** Supabase (JWKS + RPCs) and Cloudflare's TURN API, recording every call. */
function cloud(rpcs: Record<string, Rpc>) {
  const calls: { url: string; token: string; args: Record<string, unknown> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const token = String((init?.headers as Record<string, string> | undefined)?.authorization || '').replace(/^Bearer /, '');
    const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, token, args });
    if (url.endsWith('/auth/v1/.well-known/jwks.json')) return Response.json({ keys: [signer.jwk] });
    const fn = url.match(/\/rest\/v1\/rpc\/(\w+)$/)?.[1];
    if (fn) {
      const h = rpcs[fn];
      if (!h) return new Response('{"code":"PGRST202"}', { status: 404 });
      const out = h(token, args);
      return out instanceof Response ? out : Response.json(out);
    }
    if (url.startsWith('https://rtc.live.cloudflare.com/')) return new Response(null, { status: 200 });
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetcher, calls, rpc: (fn: string) => calls.filter((c) => c.url.endsWith(`/rpc/${fn}`)), revoked: () => calls.filter((c) => c.url.endsWith('/revoke')).map((c) => decodeURIComponent(c.url.split('/credentials/')[1].replace('/revoke', ''))) };
}

/**
 * Rooms, call lines and direct calls that keep the sockets people hold, and implement the internal
 * `/x/kick` contract (wire.ts XKickBody → XKickResult) the way ADR 0006 WS-9/WS-10 will. A line
 * also names the direct calls its person is in (`calls`), which the Worker then kicks too.
 */
type Mode = 'ok' | 'missing' | 'hang' | 'error' | 'throw-once' | 'slow';
function world(o: { sockets?: Record<string, string[]>; rooms?: Record<string, Mode>; calls?: string[]; slowMs?: number } = {}) {
  const open = new Map<string, string[]>(Object.entries(o.sockets ?? {}));
  const seen: { ns: string; name: string; path: string; body: Record<string, unknown> }[] = [];
  const thrown = new Set<string>();
  const ns = (label: string) => ({
    idFromName: (n: string) => n,
    get: (name: string) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const mode = o.rooms?.[name] ?? 'ok';
        // A Durable Object reset by a deploy throws before it reads anything.
        if (mode === 'throw-once' && !thrown.has(name)) {
          thrown.add(name);
          throw new Error('Durable Object reset because its code was updated.');
        }
        const body = (await req.json()) as Record<string, unknown>;
        seen.push({ ns: label, name, path: url.pathname, body });
        if (mode === 'missing') return Response.json({ error: 'not found' }, { status: 404 });
        if (mode === 'error') return Response.json({ error: 'boom' }, { status: 500 });
        if (mode === 'hang') return new Promise<Response>(() => undefined);
        if (mode === 'slow') await new Promise((r) => setTimeout(r, o.slowMs ?? 0));
        if (url.pathname !== '/x/kick') return Response.json({ error: 'not found' }, { status: 404 });
        const who = open.get(name) ?? [];
        const mine = who.filter((u) => u === body.uid);
        open.set(name, who.filter((u) => u !== body.uid));
        const calls = label === 'line' && o.calls ? { calls: o.calls } : {};
        return Response.json({ closed: mine.length, turn: mine.length ? [`turn-${name.slice(-4)}`] : [], ...calls });
      },
    }),
  });
  const env: KickEnv = {
    SUPABASE_URL: SUPA,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    TURN_KEY_ID: 'turnkey',
    TURN_KEY_API_TOKEN: 'turn-token',
    MONITOR_ROOM: ns('room') as unknown as DurableObjectNamespace,
    USER_LINE: ns('line') as unknown as DurableObjectNamespace,
    CALL_ROOM: ns('call') as unknown as DurableObjectNamespace,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  return { env, ctx, open, seen, settle: () => Promise.all(pending.splice(0)) };
}

const kickReq = async (tok?: string | Promise<string>, body = '{}') =>
  new Request('https://w.example/api/me/kick', { method: 'POST', body, headers: tok ? { authorization: `Bearer ${await tok}` } : {} });

const memberOf = (...nids: string[]) => ({ monitor_list: () => ({ ok: true, nurseries: nids.map((id) => ({ id, name: 'Nursery' })) }) });

describe('POST /api/me/kick', () => {
  it('closes the caller’s sockets in every nursery and their call line — nobody else’s — and revokes their relay', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const sb = cloud(memberOf(N1, N2));
    const w = world({ sockets: { [N1]: [ME, ME, OTHER], [N2]: [ME, OTHER], [`u:${ME}`]: [ME] } });
    const mine = await token();
    const res = await handleKick(await kickReq(mine), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rooms: 2, calls: 0, closed: 4, unconfirmed: 0 });
    expect(w.open.get(N1)).toEqual([OTHER]);
    expect(w.open.get(N2)).toEqual([OTHER]);
    expect(w.open.get(`u:${ME}`)).toEqual([]);
    // The rooms got the frozen internal contract.
    expect(w.seen.map((s) => [s.ns, s.name, s.path])).toEqual([
      ['room', N1, '/x/kick'],
      ['room', N2, '/x/kick'],
      ['line', `u:${ME}`, '/x/kick'],
    ]);
    // `at`: the room closes what was admitted before it, never a sign-in after the kick.
    expect(w.seen[0].body).toEqual({ uid: ME, why: 'signout', at: NOW });
    // monitor_list was asked with the caller's own token.
    expect(sb.rpc('monitor_list')[0].token).toBe(mine);
    // TURN revocation happens after answering (waitUntil), for what the rooms handed back.
    await w.settle();
    expect(sb.revoked().sort()).toEqual(['turn-6661', 'turn-6662', `turn-${ME.slice(-4)}`].sort());
  });

  it('answers within 5 s even when a room never does — and then says it isn’t confirmed', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sb = cloud(memberOf(N1, N2));
    const w = world({ sockets: { [N1]: [ME] }, rooms: { [N2]: 'hang' } });
    let done = false;
    const p = handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW }).then((r) => ((done = true), r));
    // setImmediate is Node's (these tests run in Node), and it isn't faked here.
    const nextTurn = (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate;
    const ticks = async (n = 50) => {
      for (let i = 0; i < n; i++) await new Promise<void>((r) => nextTurn(r));
    };
    // Every room and the line have been asked (their timers are running).
    // (Signature checks run off the event loop: give them real time.)
    for (let i = 0; i < 20_000 && w.seen.length < 3 && !done; i++) await ticks(1);
    expect(done).toBe(false);
    expect(w.seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(ROOM_TIMEOUT_MS - 1);
    await ticks();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await ticks();
    expect(done).toBe(true);
    expect(ROOM_TIMEOUT_MS).toBeLessThan(5_000);
    expect(await (await p).json()).toMatchObject({ ok: false, rooms: 2, calls: 0, closed: 1, unconfirmed: 1 });
  });

  it('a room or line that doesn’t know /x/kick yet (before WS-9/WS-10) is unconfirmed, never pretended', async () => {
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [N1]: [ME] }, rooms: { [`u:${ME}`]: 'missing' } });
    const body = await (await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).json();
    expect(body).toEqual({ ok: false, rooms: 1, calls: 0, closed: 1, unconfirmed: 1 });
  });

  it('someone in no nursery still has their call line closed', async () => {
    const sb = cloud({ monitor_list: () => ({ ok: false, error: 'not_member' }) });
    const w = world({ sockets: { [`u:${ME}`]: [ME] } });
    const body = await (await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).json();
    expect(body).toEqual({ ok: true, rooms: 0, calls: 0, closed: 1, unconfirmed: 0 });
  });

  it('refuses without a valid token, and touches no room', async () => {
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [N1]: [ME] } });
    expect((await handleKick(await kickReq(), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
    expect((await handleKick(await kickReq('not.a.token-at-all-really'), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
    expect((await handleKick(await kickReq(token({ exp: nowS - 600 })), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
    expect((await handleKick(new Request('https://w.example/api/me/kick'), w.env, w.ctx)).status).toBe(405);
    expect(w.seen).toEqual([]);
  });

  it('a password alone can’t switch a family’s monitors off: a second factor needs aal2', async () => {
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [N1]: [ME] } });
    const res = await handleKick(await kickReq(token({ ds_mfa: true, aal: 'aal1' })), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'mfa_required' });
    expect(w.seen).toEqual([]);
    const ok = await handleKick(await kickReq(token({ ds_mfa: true, aal: 'aal2' })), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('“Not you?”: a session already ended still closes the call line, and says the rooms couldn’t be listed', async () => {
    // A legacy token: Supabase verifies it and reports the session gone.
    const sb = cloud({ live_me: () => ({ signed_in: false, member: false, error: 'session_revoked' }), monitor_list: () => ({ ok: false, error: 'session_revoked' }) });
    const w = world({ sockets: { [N1]: [ME], [`u:${ME}`]: [ME] } });
    const res = await handleKick(await kickReq(legacyToken(), '{"why":"secure"}'), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(await res.json()).toEqual({ ok: false, rooms: 0, calls: 0, closed: 1, unconfirmed: 0, error: 'session_revoked' });
    expect(w.seen).toEqual([{ ns: 'line', name: `u:${ME}`, path: '/x/kick', body: { uid: ME, why: 'secure', at: NOW } }]);
    // The nurseries are the backend's signed kick's to reach (ops.ts /x/user/:uid/kick).
    expect(sb.rpc('monitor_list')).toEqual([]); // not even asked: it can't answer a revoked session
  });

  it('Supabase down: the call line is still closed, and the answer is honest', async () => {
    const sb = cloud({ monitor_list: () => new Response('down', { status: 503 }) });
    const w = world({ sockets: { [`u:${ME}`]: [ME] } });
    const body = await (await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).json();
    expect(body).toEqual({ ok: false, rooms: 0, calls: 0, closed: 1, unconfirmed: 0, error: 'unavailable' });
  });

  it('reaches every direct call the line names: their call sockets close too, and each call must confirm', async () => {
    const C1 = '0123456789abcdef';
    const C2 = 'fedcba9876543210';
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [N1]: [ME], [`u:${ME}`]: [ME], [C1]: [ME, OTHER], [C2]: [OTHER, ME] }, calls: [C1, C2, C1, 'not-a-call'] });
    const res = await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(await res.json()).toEqual({ ok: true, rooms: 1, calls: 2, closed: 4, unconfirmed: 0 });
    expect(w.open.get(C1)).toEqual([OTHER]);
    expect(w.open.get(C2)).toEqual([OTHER]);
    expect(w.seen.filter((s) => s.ns === 'call').map((s) => [s.name, s.path, s.body])).toEqual([
      [C1, '/x/kick', { uid: ME, why: 'signout', at: NOW }],
      [C2, '/x/kick', { uid: ME, why: 'signout', at: NOW }],
    ]);
    await w.settle();
    expect(sb.revoked()).toContain('turn-cdef');
    // A call that doesn't know /x/kick yet (before WS-10) isn't pretended.
    const w2 = world({ sockets: { [`u:${ME}`]: [ME], [C1]: [ME] }, calls: [C1], rooms: { [C1]: 'missing' } });
    const partial = await handleKick(await kickReq(token()), w2.env, w2.ctx, { fetcher: cloud(memberOf()).fetcher, now: NOW });
    expect(await partial.json()).toEqual({ ok: false, rooms: 0, calls: 1, closed: 1, unconfirmed: 1 });
  });

  it('the calls get what’s left of the budget: the whole kick answers inside 5 s even when the line is slow', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const C1 = '0123456789abcdef';
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [`u:${ME}`]: [ME], [C1]: [ME] }, calls: [C1], rooms: { [`u:${ME}`]: 'slow', [C1]: 'hang' }, slowMs: 3_900 });
    let done = false;
    const p = handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW }).then((r) => ((done = true), r));
    const nextTurn = (globalThis as unknown as { setImmediate: (f: () => void) => void }).setImmediate;
    const ticks = async (n = 50) => {
      for (let i = 0; i < n; i++) await new Promise<void>((r) => nextTurn(r));
    };
    for (let i = 0; i < 20_000 && w.seen.length < 2 && !done; i++) await ticks(1);
    await vi.advanceTimersByTimeAsync(3_900);
    await ticks();
    expect(w.seen.map((s) => s.ns)).toContain('call');
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(KICK_BUDGET_MS - 3_900 + 1);
    await ticks();
    expect(done).toBe(true);
    expect(KICK_BUDGET_MS).toBeLessThan(5_000);
    expect(await (await p).json()).toEqual({ ok: false, rooms: 1, calls: 1, closed: 1, unconfirmed: 1 });
  });

  it('a room reset by a deploy mid-kick is asked again at once, and confirms', async () => {
    const sb = cloud(memberOf(N1));
    const w = world({ sockets: { [N1]: [ME] }, rooms: { [N1]: 'throw-once' } });
    const body = await (await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).json();
    expect(body).toEqual({ ok: true, rooms: 1, calls: 0, closed: 1, unconfirmed: 0 });
    expect(w.open.get(N1)).toEqual([]);
  });

  it('a room that refuses (4xx) isn’t asked twice; one that errors (5xx) is, and stays unconfirmed', async () => {
    const w = world({ rooms: { [N1]: 'missing', [N2]: 'error' } });
    expect(await tellRoom(w.env, N1, '/x/kick', { uid: ME })).toMatchObject({ ok: false, status: 404 });
    expect(await tellRoom(w.env, N2, '/x/kick', { uid: ME })).toMatchObject({ ok: false, status: 500 });
    expect(w.seen.map((s) => s.name)).toEqual([N1, N2, N2]);
  });

  it('more nurseries than one kick may wake: the rest are counted unconfirmed, never dropped silently', async () => {
    const many = Array.from({ length: MAX_ROOMS + 3 }, (_, i) => `9d9d9d9d-1111-4222-8333-${String(i).padStart(12, '0')}`);
    const sb = cloud(memberOf(...many));
    const w = world();
    const body = await (await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW })).json();
    expect(body).toEqual({ ok: false, rooms: MAX_ROOMS + 3, calls: 0, closed: 0, unconfirmed: 3 });
    expect(w.seen.filter((s) => s.ns === 'room')).toHaveLength(MAX_ROOMS);
  });

  it('is braked per account (each kick wakes every room)', async () => {
    const sb = cloud(memberOf(N1));
    const w = world();
    const keys: string[] = [];
    w.env.RL_WS = { limit: async ({ key }) => (keys.push(key), { success: false }) };
    const res = await handleKick(await kickReq(token()), w.env, w.ctx, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(429);
    expect(keys).toEqual([`edge:kick:${ME}`]);
    expect(w.seen).toEqual([]);
  });
});

describe('kick helpers', () => {
  it('verifyCaller maps every failure to the answer the app understands', async () => {
    const env = { SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'k' };
    const down = cloud({ live_me: () => new Response('x', { status: 502 }) });
    const r = await verifyCaller(new Request('https://w/', { headers: { authorization: `Bearer ${legacyToken()}` } }), env, { fetcher: down.fetcher, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.res.status, await r.res.json()]).toEqual([503, { ok: false, error: 'unavailable' }]);
    const revoked = cloud({ live_me: () => ({ error: 'session_revoked' }) });
    const r2 = await verifyCaller(new Request('https://w/', { headers: { authorization: `Bearer ${legacyToken()}` } }), env, { fetcher: revoked.fetcher, now: NOW });
    expect(r2.ok ? 'ok' : r2.res.status).toBe(401); // revoked sessions only where allowed (kick)
  });

  it('myNurseries keeps only nursery ids, once each', async () => {
    const sb = cloud({ monitor_list: () => ({ ok: true, nurseries: [{ id: N1 }, { id: N1.toUpperCase() }, { id: 'nope' }, {}, { id: N2 }] }) });
    expect(await myNurseries({ SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'k' }, 'tok', sb.fetcher)).toEqual({ ok: true, nids: [N1, N2] });
    const missing = cloud({});
    expect(await myNurseries({ SUPABASE_URL: SUPA, SUPABASE_PUBLISHABLE_KEY: 'k' }, 'tok', missing.fetcher)).toMatchObject({ ok: false, error: 'setup' });
  });

  it('callsNamed keeps only call ids, once each, and counts any past the cap', () => {
    const ids = Array.from({ length: 25 }, (_, i) => i.toString(16).padStart(16, '0'));
    expect(callsNamed({ ok: true, status: 200, data: { calls: ['0123456789abcdef', '0123456789abcdef', 'x', 7] } })).toEqual({ ids: ['0123456789abcdef'], over: 0 });
    expect(callsNamed({ ok: true, status: 200, data: { calls: ids } })).toEqual({ ids: ids.slice(0, 20), over: 5 });
    expect(callsNamed({ ok: false, status: 404, data: { calls: ids } })).toEqual({ ids: [], over: 0 });
  });

  it('kickResult trusts only well-formed answers', () => {
    expect(kickResult({ ok: true, status: 200, data: { closed: 2, turn: ['a:b', 'bad name', 7] } })).toEqual({ closed: 2, turn: ['a:b'] });
    expect(kickResult({ ok: true, status: 200, data: { closed: -1 } })).toEqual({ closed: 0, turn: [] });
    expect(kickResult({ ok: false, status: 404, data: { closed: 9, turn: ['x'] } })).toEqual({ closed: 0, turn: [] });
  });

  it('revokes TURN usernames once each, and does nothing without TURN configured', async () => {
    const sb = cloud({});
    expect(await revokeTurnUsernames({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' }, ['u1', 'u1', 'u2', 'bad name'], sb.fetcher)).toBe(2);
    expect(sb.revoked()).toEqual(['u1', 'u2']);
    expect(sb.calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/k/credentials/u1/revoke');
    expect(await revokeTurnUsernames({}, ['u1'], sb.fetcher)).toBe(0);
  });
});
