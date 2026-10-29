// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { resetJwksCache } from './auth/jwks';
import { signEs256Jwt } from './auth/jose';
import type { KickEnv } from './kick';
import { handleMembers } from './members';

const SUPA = 'https://proj.supabase.co';
const PARENT = '0a0a0a0a-1111-4222-8333-444455556666';
const GRANDMA = '0c0c0c0c-1111-4222-8333-444455556666';
const DAD = '0d0d0d0d-1111-4222-8333-444455556666';
const NID = '9d9d9d9d-1111-4222-8333-444455556661';
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

const token = (over: Record<string, unknown> = {}) =>
  signEs256Jwt(
    { alg: 'ES256', kid: 'k1', typ: 'JWT' },
    { iss: `${SUPA}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: PARENT, session_id: DAD, aal: 'aal1', iat: nowS - 10, exp: nowS + 1200, ...over },
    signer.priv,
  );

/** Supabase as the nursery sees it: who is a member with what role and label; parents decide. */
function supabase(o: { v2?: boolean; down?: boolean } = {}) {
  const members = new Map<string, { role: string; label: string | null }>([
    [PARENT, { role: 'parent', label: 'Mom' }],
    [GRANDMA, { role: 'viewer', label: 'Grandma' }],
  ]);
  const calls: { fn: string; token: string; args: Record<string, unknown> }[] = [];
  const v2 = o.v2 !== false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [signer.jwk] });
    const fn = url.match(/\/rpc\/(\w+)$/)?.[1] ?? '';
    const tok = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
    const args = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ fn, token: tok, args });
    if (o.down) return new Response('down', { status: 503 });
    // The caller is whoever the token names (Supabase would check its signature).
    const caller = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub as string;
    const isParent = members.get(caller)?.role === 'parent';
    if (fn === 'monitor_people') return Response.json({ ok: true, people: [...members].map(([user_id, m]) => ({ user_id, ...m })) });
    if (fn === 'monitor_remove_member') {
      const user = String(args.p_user);
      if (user !== caller && !isParent) return Response.json({ ok: false, error: 'forbidden' });
      const had = members.delete(user);
      return Response.json(v2 ? { ok: true, removed: had ? [user] : [], changed: had ? [user] : [], left: had && user === caller } : { ok: true });
    }
    if (fn === 'monitor_set_member') {
      if (!isParent) return Response.json({ ok: false, error: 'forbidden' });
      const user = String(args.p_user);
      const prev = members.get(user)?.role ?? null;
      members.set(user, { role: String(args.p_role), label: (args.p_label as string | null) ?? null });
      return Response.json(v2 ? { ok: true, changed: [user], role: args.p_role, previous_role: prev, added: prev == null } : { ok: true });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, members, rpc: (fn: string) => calls.filter((c) => c.fn === fn) };
}

/**
 * The nursery's room, implementing `/x/members` the way ADR 0006 WS-9 will: removed people's
 * sockets close and their push targets go; every parent hears about it. A fake push endpoint
 * records what each person would receive afterwards.
 */
function nursery(o: { room?: 'ok' | 'missing'; failFirst?: number } = {}) {
  let failures = o.failFirst ?? 0;
  const sockets = new Map<string, string[]>([
    [PARENT, ['monitor']],
    [GRANDMA, ['monitor', 'line']],
  ]);
  const push = new Set([PARENT, GRANDMA]);
  const delivered: { to: string; text: string }[] = [];
  const told: Record<string, unknown>[] = [];
  const alertEveryone = (text: string) => {
    for (const uid of push) delivered.push({ to: uid, text });
  };
  const room = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      // Cold, overloaded or reset by a deploy: no answer the Worker can count.
      if (failures > 0) {
        failures -= 1;
        throw new Error('Durable Object reset because its code was updated.');
      }
      if (o.room === 'missing' || url.pathname !== '/x/members') return Response.json({ error: 'not found' }, { status: 404 });
      const body = (await req.json()) as { ids: string[]; removed: string[]; by: string; op: string };
      told.push({ ...body, nid: url.searchParams.get('nid') });
      let closed = 0;
      for (const uid of body.removed) {
        closed += sockets.get(uid)?.length ?? 0;
        sockets.delete(uid);
        push.delete(uid);
      }
      for (const [uid] of sockets) if (uid === PARENT) delivered.push({ to: uid, text: 'member changed' });
      return Response.json({ closed, turn: body.removed.map((u) => `turn-${u.slice(0, 4)}`) });
    },
  };
  const env: KickEnv = {
    SUPABASE_URL: SUPA,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    MONITOR_ROOM: { idFromName: (n: string) => n, get: () => room } as unknown as DurableObjectNamespace,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return { env, ctx, sockets, push, delivered, told, alertEveryone, settle };
}

const post = async (body: unknown, tok: string | Promise<string> | null = token()) =>
  new Request(`https://w.example/api/monitor/${NID}/members`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: tok ? { authorization: `Bearer ${await tok}`, 'content-type': 'application/json' } : {},
  });

describe('POST /api/monitor/:nid/members', () => {
  it('a parent removes Grandma: Supabase with the parent’s own token, then the room closes her sockets and stops her pushes', async () => {
    const sb = supabase();
    const n = nursery();
    const tok = await token();
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }, tok), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: [GRANDMA], removed: [GRANDMA], told: true });
    expect(sb.rpc('monitor_remove_member')).toEqual([{ fn: 'monitor_remove_member', token: tok, args: { p_nursery: NID, p_user: GRANDMA } }]);
    expect(n.told).toEqual([{ ids: [GRANDMA], removed: [GRANDMA], by: PARENT, op: 'remove', role: null, at: NOW, nid: NID }]);
    // Her monitor and line sockets are gone…
    expect(n.sockets.has(GRANDMA)).toBe(false);
    // …a later alert reaches only the people still in the nursery (the fake push endpoint)…
    n.alertEveryone('Crying');
    expect(n.delivered.filter((d) => d.to === GRANDMA)).toEqual([]);
    expect(n.delivered.filter((d) => d.to === PARENT).map((d) => d.text)).toEqual(['member changed', 'Crying']);
  });

  it('works before live_security_v2.sql: the person in the request is the one who changed', async () => {
    const sb = supabase({ v2: false });
    const n = nursery();
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(await res.json()).toEqual({ ok: true, changed: [GRANDMA], removed: [GRANDMA], told: true });
    expect(n.sockets.has(GRANDMA)).toBe(false);
  });

  it('adding and changing roles tell the room who to re-check, with the parents’ notice facts', async () => {
    const sb = supabase();
    const n = nursery();
    const add = await handleMembers(await post({ op: 'add', user: DAD, role: 'parent', label: 'Dad' }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(await add.json()).toEqual({ ok: true, changed: [DAD], removed: [], told: true });
    expect(n.told[0]).toEqual({ ids: [DAD], removed: [], by: PARENT, op: 'add', role: 'parent', added: true, at: NOW, nid: NID });
    expect(sb.members.get(DAD)).toEqual({ role: 'parent', label: 'Dad' });
  });

  it('a role change without a label keeps the person’s label (the RPC alone would clear it)', async () => {
    const sb = supabase();
    const n = nursery();
    await handleMembers(await post({ op: 'role', user: GRANDMA, role: 'caregiver' }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(sb.members.get(GRANDMA)).toEqual({ role: 'caregiver', label: 'Grandma' });
    expect(n.told[0]).toMatchObject({ ids: [GRANDMA], op: 'role', role: 'caregiver', previous: 'viewer' });
  });

  it('admin actions need the second sign-in step from anyone who has one — before Supabase is asked', async () => {
    const sb = supabase();
    const n = nursery();
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }, token({ ds_mfa: true, aal: 'aal1' })), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'mfa_required' });
    expect(sb.calls.filter((c) => c.fn)).toEqual([]);
    expect(n.told).toEqual([]);
    const stepped = await handleMembers(await post({ op: 'remove', user: GRANDMA }, token({ ds_mfa: true, aal: 'aal2' })), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(((await stepped.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('Supabase decides who may: a viewer can’t remove anyone, and the room hears nothing', async () => {
    const sb = supabase();
    const n = nursery();
    const res = await handleMembers(await post({ op: 'remove', user: PARENT }, token({ sub: GRANDMA })), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' });
    expect(n.told).toEqual([]);
    expect(n.sockets.has(PARENT)).toBe(true);
  });

  it('anyone may leave: their own sockets close', async () => {
    const sb = supabase();
    const n = nursery();
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }, token({ sub: GRANDMA })), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect(await res.json()).toEqual({ ok: true, changed: [GRANDMA], removed: [GRANDMA], told: true });
    expect(n.told[0]).toMatchObject({ by: GRANDMA, left: true });
  });

  it('refuses junk before asking anyone', async () => {
    const sb = supabase();
    const n = nursery();
    for (const body of ['nope', { op: 'remove' }, { op: 'add', user: GRANDMA }, { op: 'drop', user: GRANDMA }, { op: 'role', user: GRANDMA, role: 'owner' }]) {
      const res = await handleMembers(await post(body), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await handleMembers(await post('x'.repeat(3000)), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW })).status).toBe(413);
    expect((await handleMembers(await post({ op: 'remove', user: GRANDMA }, null), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW })).status).toBe(401);
    expect((await handleMembers(new Request(`https://w.example/api/monitor/${NID}/members`), n.env, n.ctx, NID)).status).toBe(405);
    expect(sb.calls.filter((c) => c.fn)).toEqual([]);
    expect(n.told).toEqual([]);
  });

  it('a room that doesn’t know /x/members yet: the change still stands, the answer says the room wasn’t told, and it isn’t asked again', async () => {
    const sb = supabase();
    const n = nursery({ room: 'missing' });
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW, retryDelaysMs: [1] });
    expect([res.status, await res.json()]).toEqual([202, { ok: false, error: 'unconfirmed', committed: true, changed: [GRANDMA], removed: [GRANDMA], told: false }]);
    await n.settle();
    expect(sb.rpc('monitor_people')).toEqual([]); // a 404 is an answer: no background retry
  });

  it('a removal the room didn’t confirm is not “ok”: the change stands, the answer says so, and the Worker keeps telling the room until it hears', async () => {
    const sb = supabase();
    const n = nursery({ failFirst: 3 }); // both tries inside the request fail, and the first background one
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW, retryDelaysMs: [1, 1, 1] });
    expect([res.status, await res.json()]).toEqual([202, { ok: false, error: 'unconfirmed', committed: true, changed: [GRANDMA], removed: [GRANDMA], told: false }]);
    expect(sb.members.has(GRANDMA)).toBe(false); // committed in Supabase
    expect(n.sockets.has(GRANDMA)).toBe(true); // …but her monitor is still open
    await n.settle();
    // The room heard it a moment later: her sockets closed, her pushes gone.
    expect(n.sockets.has(GRANDMA)).toBe(false);
    expect(n.push.has(GRANDMA)).toBe(false);
    expect(n.told).toHaveLength(1);
  });

  it('asking again after the room didn’t hear tells it again — though Supabase has nothing left to remove', async () => {
    const sb = supabase();
    sb.members.delete(GRANDMA); // removed by the first try; the room never heard
    const n = nursery();
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, changed: [], removed: [GRANDMA], told: true }]);
    expect(n.told).toEqual([{ ids: [GRANDMA], removed: [GRANDMA], by: PARENT, op: 'remove', role: null, at: NOW, nid: NID }]);
    expect(n.sockets.has(GRANDMA)).toBe(false);
  });

  it('a background retry never cuts off someone added back in the meantime (nor tells the parents they left)', async () => {
    const sb0 = supabase();
    const n0 = nursery({ failFirst: 2 });
    expect((await handleMembers(await post({ op: 'remove', user: GRANDMA }, token({ sub: GRANDMA })), n0.env, n0.ctx, NID, { fetcher: sb0.fetcher, now: NOW, retryDelaysMs: [1] })).status).toBe(202);
    sb0.members.set(GRANDMA, { role: 'viewer', label: 'Grandma' });
    await n0.settle();
    expect(n0.told).toEqual([{ ids: [GRANDMA], removed: [], by: GRANDMA, op: 'remove', role: null, at: NOW, nid: NID }]);
  });

  it('a background retry never cuts off someone added back in the meantime', async () => {
    const sb = supabase();
    const n = nursery({ failFirst: 2 });
    const res = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW, retryDelaysMs: [1] });
    expect(res.status).toBe(202);
    sb.members.set(GRANDMA, { role: 'viewer', label: 'Grandma' }); // a parent added her back
    await n.settle();
    expect(n.told).toEqual([{ ids: [GRANDMA], removed: [], by: PARENT, op: 'remove', role: null, at: NOW, nid: NID }]);
    expect(n.sockets.has(GRANDMA)).toBe(true);
    expect(n.push.has(GRANDMA)).toBe(true);
  });

  it('an added member the room hasn’t heard about yet is still added (nothing to take away): ok, told false', async () => {
    const sb = supabase();
    const n = nursery({ failFirst: 2 });
    const res = await handleMembers(await post({ op: 'add', user: DAD, role: 'parent', label: 'Dad' }), n.env, n.ctx, NID, { fetcher: sb.fetcher, now: NOW, retryDelaysMs: [1] });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, changed: [DAD], removed: [], told: false }]);
    await n.settle();
    expect(n.told).toHaveLength(1);
    // A downgrade takes access away: it must be confirmed like a removal.
    const n2 = nursery({ failFirst: 2 });
    const down = await handleMembers(await post({ op: 'role', user: DAD, role: 'viewer' }), n2.env, n2.ctx, NID, { fetcher: sb.fetcher, now: NOW, retryDelaysMs: [] });
    expect([down.status, ((await down.json()) as { error: string }).error]).toEqual([202, 'unconfirmed']);
  });

  it('Supabase down or not set up: an honest error, nothing told', async () => {
    const n = nursery();
    const down = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: supabase({ down: true }).fetcher, now: NOW });
    expect([down.status, await down.json()]).toEqual([503, { ok: false, error: 'unavailable' }]);
    const missing = (async (input: RequestInfo | URL) =>
      String(input).endsWith('/jwks.json') ? Response.json({ keys: [signer.jwk] }) : new Response('{"code":"PGRST202"}', { status: 404 })) as typeof fetch;
    const setup = await handleMembers(await post({ op: 'remove', user: GRANDMA }), n.env, n.ctx, NID, { fetcher: missing, now: NOW });
    expect([setup.status, await setup.json()]).toEqual([503, { ok: false, error: 'setup' }]);
    expect(n.told).toEqual([]);
  });
});
