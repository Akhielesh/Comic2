// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { HOOK_TOLERANCE_S, handleOps, handleUserNotify, resetOpsState, signHookPayload, verifyHookSignature, type OpsEnv } from './ops';

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
