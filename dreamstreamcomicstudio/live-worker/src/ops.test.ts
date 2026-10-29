// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { HOOK_TOLERANCE_S, handleOps, handleUserKick, handleUserNotify, resetOpsState, signHookPayload, verifyHookSignature, type OpsEnv } from './ops';

const UID = '0a0a0a0a-1111-4222-8333-444455556666';
const SECRET = 'hook-secret-0123456789abcdef';
const NOW = 1_800_000_000_000;

beforeEach(() => resetOpsState());

function lines(o: { missing?: boolean } = {}) {
  const got: { name: string; path: string; body: Record<string, unknown> }[] = [];
  const env: OpsEnv = {
    SECURITY_HOOK_SECRET: SECRET,
    OPS_KEY: 'k'.repeat(32),
    USER_LINE: {
      idFromName: (n: string) => n,
      get: (name: string) => ({
        fetch: async (req: Request) => {
          got.push({ name, path: new URL(req.url).pathname, body: (await req.json()) as Record<string, unknown> });
          return o.missing ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json({ ok: true, sent: 2 });
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
  return { env, got };
}

const notify = async (payload: unknown, o: { secret?: string; at?: number; uid?: string; header?: string } = {}) => {
  const p = JSON.stringify(payload);
  const sig = o.header ?? (await signHookPayload(o.secret ?? SECRET, p, o.at ?? NOW));
  return new Request(`https://w.example/x/user/${o.uid ?? UID}/notify`, { method: 'POST', body: JSON.stringify({ p }), headers: { 'x-ds-signature': sig } });
};

describe('POST /x/user/:uid/notify (the security notice push mirror)', () => {
  it('a signed notice reaches the person’s call line — only the fields a notice may carry', async () => {
    const l = lines();
    const res = await handleUserNotify(await notify({ uid: UID, kind: 'sign_in', at: NOW - 5000, device: 'Safari on iPhone', ip: '203.0.113.0', ua: 'Mozilla/5.0 …' }), l.env, UID, { now: NOW });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, told: true }]);
    expect(l.got).toEqual([{ name: `u:${UID}`, path: '/x/notify', body: { uid: UID, kind: 'sign_in', at: NOW - 5000, device: 'Safari on iPhone' } }]);
  });

  it('dormant without the secret, and refuses forged, stale, replayed or mis-addressed notices', async () => {
    const l = lines();
    const go = async (r: Request, env: OpsEnv = l.env, uid = UID) => (await handleUserNotify(r, env, uid, { now: NOW })).status;
    expect(await go(await notify({ uid: UID, kind: 'sign_in' }), { ...l.env, SECURITY_HOOK_SECRET: undefined })).toBe(403);
    expect(await go(await notify({ uid: UID, kind: 'sign_in' }, { secret: 'another-secret-0123456789' }))).toBe(403);
    expect(await go(await notify({ uid: UID, kind: 'sign_in' }, { at: NOW - (HOOK_TOLERANCE_S + 5) * 1000 }))).toBe(403);
    expect(await go(await notify({ uid: UID, kind: 'sign_in' }, { header: 't=1,v1=00' }))).toBe(403);
    // Signed for someone else: a notice can't be redirected to another person's devices.
    const other = '0b0b0b0b-1111-4222-8333-444455556666';
    expect(await go(await notify({ uid: other, kind: 'sign_in' }, { uid: UID }), l.env, UID)).toBe(400);
    expect(await go(await notify({ uid: UID, kind: 'anything' }))).toBe(400);
    const once = await notify({ uid: UID, kind: 'device_added', name: 'Watch' });
    const again = once.clone();
    expect(await go(once)).toBe(200);
    expect(await go(again)).toBe(409);
    expect(l.got).toHaveLength(1);
  });

  it('accepts the previous secret while rotating (`old|new`)', async () => {
    const l = lines();
    l.env.SECURITY_HOOK_SECRET = `${SECRET}|new-secret-0123456789abcdef`;
    expect((await handleUserNotify(await notify({ uid: UID, kind: 'secured' }), l.env, UID, { now: NOW })).status).toBe(200);
  });

  it('a line that doesn’t take notices yet (before WS-10) is reported, not pretended', async () => {
    const l = lines({ missing: true });
    const res = await handleUserNotify(await notify({ uid: UID, kind: 'sign_in' }), l.env, UID, { now: NOW });
    expect([res.status, await res.json()]).toEqual([501, { ok: false, told: false }]);
    expect((await handleUserNotify(new Request(`https://w.example/x/user/${UID}/notify`), l.env, UID)).status).toBe(405);
  });

  it('verifyHookSignature matches the email Worker’s scheme', async () => {
    const p = '{"uid":"x"}';
    const sig = await signHookPayload(SECRET, p, NOW);
    expect(sig).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    expect((await verifyHookSignature(SECRET, sig, p, NOW)).ok).toBe(true);
    expect(await verifyHookSignature(SECRET, sig, `${p} `, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(await verifyHookSignature('short', sig, p, NOW)).toEqual({ ok: false, reason: 'no-secret' });
  });
});

describe('POST /x/user/:uid/kick (“Not you?” from the backend, signed)', () => {
  const N1 = '9d9d9d9d-1111-4222-8333-444455556661';
  const N2 = '9d9d9d9d-1111-4222-8333-444455556662';

  /** Rooms and the call line, implementing `/x/kick` as WS-9/WS-10 will. */
  function world(o: { missing?: string[] } = {}) {
    const got: { ns: string; name: string; body: Record<string, unknown> }[] = [];
    const ns = (label: string) =>
      ({
        idFromName: (n: string) => n,
        get: (name: string) => ({
          fetch: async (req: Request) => {
            got.push({ ns: label, name, body: (await req.json()) as Record<string, unknown> });
            if (o.missing?.includes(name)) return Response.json({ error: 'not found' }, { status: 404 });
            return Response.json({ closed: 1, turn: [] });
          },
        }),
      }) as unknown as DurableObjectNamespace;
    const env: OpsEnv = { SECURITY_HOOK_SECRET: SECRET, MONITOR_ROOM: ns('room'), USER_LINE: ns('line'), CALL_ROOM: ns('call') };
    const pending: Promise<unknown>[] = [];
    return { env, got, ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } };
  }

  const kick = async (payload: unknown, o: { secret?: string; at?: number; uid?: string } = {}) => {
    const p = JSON.stringify(payload);
    const sig = await signHookPayload(o.secret ?? SECRET, p, o.at ?? NOW);
    return new Request(`https://w.example/x/user/${o.uid ?? UID}/kick`, { method: 'POST', body: JSON.stringify({ p }), headers: { 'x-ds-signature': sig } });
  };
  const asSent = (over: Record<string, unknown> = {}) => ({ v: 1, kind: 'kick', uid: UID, why: 'secured', nids: [N1, N2], at: NOW - 1000, ...over });

  it('closes the account’s sockets in every nursery it names and on the call line; ok only when all confirmed', async () => {
    const w = world();
    const res = await handleUserKick(await kick(asSent()), w.env, w.ctx, UID, { now: NOW });
    expect([res.status, await res.json()]).toEqual([200, { ok: true, rooms: 2, calls: 0, closed: 3, unconfirmed: 0 }]);
    expect(w.got).toEqual([
      { ns: 'room', name: N1, body: { uid: UID, why: 'secure', at: NOW } },
      { ns: 'room', name: N2, body: { uid: UID, why: 'secure', at: NOW } },
      { ns: 'line', name: `u:${UID}`, body: { uid: UID, why: 'secure', at: NOW } },
    ]);
    const partial = world({ missing: [N2] });
    const p2 = await handleUserKick(await kick(asSent({ at: NOW - 2 })), partial.env, partial.ctx, UID, { now: NOW });
    expect(await p2.json()).toEqual({ ok: false, rooms: 2, calls: 0, closed: 2, unconfirmed: 1 });
  });

  it('dormant without the secret; forged, stale, replayed, mis-addressed or malformed kicks reach nobody', async () => {
    const w = world();
    const go = async (r: Request, env: OpsEnv = w.env, uid = UID) => (await handleUserKick(r, env, w.ctx, uid, { now: NOW })).status;
    expect(await go(await kick(asSent()), { ...w.env, SECURITY_HOOK_SECRET: undefined })).toBe(403);
    expect(await go(await kick(asSent(), { secret: 'another-secret-0123456789' }))).toBe(403);
    expect(await go(await kick(asSent(), { at: NOW - (HOOK_TOLERANCE_S + 5) * 1000 }))).toBe(403);
    // Signed for one account, posted for another: refused.
    const other = '0b0b0b0b-1111-4222-8333-444455556666';
    expect(await go(await kick(asSent({ uid: other })), w.env, UID)).toBe(400);
    expect(await go(await kick(asSent({ kind: 'sign_in' })))).toBe(400);
    expect(await go(await kick(asSent({ nids: [N1, 'not-a-nursery'] })))).toBe(400);
    expect(await go(await kick(asSent({ nids: 'all' })))).toBe(400);
    // None of those reached a room; a genuine kick works once.
    expect(w.got).toEqual([]);
    const once = await kick(asSent({ at: NOW - 3 }));
    const again = once.clone();
    expect(await go(once)).toBe(200);
    expect(await go(again)).toBe(409);
    expect(w.got.filter((g) => g.ns === 'line')).toHaveLength(1);
    expect((await handleUserKick(new Request(`https://w.example/x/user/${UID}/kick`), w.env, w.ctx, UID)).status).toBe(405);
  });
});

describe('POST /api/ops/apns-probe', () => {
  it('runs WS-3’s probe behind the ops key, and nothing else lives under /api/ops', async () => {
    const l = lines();
    const calls: string[] = [];
    const fetcher = (async (u: RequestInfo | URL) => (calls.push(String(u)), new Response('{"reason":"MissingProviderToken"}', { status: 403, headers: { 'apns-id': 'ABC' } }))) as typeof fetch;
    const post = (key?: string) => new Request('https://w.example/api/ops/apns-probe', { method: 'POST', headers: key ? { 'x-ops-key': key } : {} });
    expect((await handleOps(post(), l.env, 'apns-probe', { fetcher })).status).toBe(403);
    expect((await handleOps(post('k'.repeat(32)), { ...l.env, OPS_KEY: undefined }, 'apns-probe', { fetcher })).status).toBe(403);
    expect(calls).toEqual([]);
    const ok = await handleOps(post('k'.repeat(32)), l.env, 'apns-probe', { fetcher });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 403, apnsId: 'ABC', verdict: 'pass', decision: 'apns-direct' });
    expect((await handleOps(post('k'.repeat(32)), l.env, 'other')).status).toBe(404);
  });
});
