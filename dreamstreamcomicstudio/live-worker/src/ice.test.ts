// @vitest-environment node
// TURN guardrails (ADR 0007 D6; stream-studio-costs.md §7 C6): credentials per room + person
// + payer, ≤ 4 h (guests ≤ 2 h, never past their pass), refreshed ahead of expiry, tagged with
// a non-reversible payer identifier, revocable — and STUN only whenever TURN can't be had.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GUEST_TURN_TTL_S,
  REFRESH_LEAD_MS,
  RETRY_MS,
  REUSE_MS,
  STUN,
  TURN_TTL_S,
  dropPort53,
  iceFields,
  iceFor,
  includesTurn,
  resetIceCache,
  revokeIce,
  turnTag,
  type IceRequest,
} from './ice';

const ENV = { TURN_KEY_ID: 'key1', TURN_KEY_API_TOKEN: 'secret-token' };
const NID = '11111111-2222-4333-8444-555555555555';
const H = 3600_000;

/** Cloudflare's credential API: a new username per credential; records what was asked. */
function turnApi(opts: { fail?: (path: string) => boolean; shape?: 'object' | 'list' } = {}) {
  let n = 0;
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const path = url.split('/credentials/')[1] ?? '';
    if (opts.fail?.(path)) return new Response('nope', { status: 500 });
    if (path.endsWith('/revoke')) return new Response(null, { status: 204 });
    n += 1;
    const turn = {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: `user${n}`,
      credential: `cred${n}`,
    };
    const body = opts.shape === 'list' ? { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, turn] } : { iceServers: turn };
    return new Response(JSON.stringify(body), { status: 201 });
  });
  return { f: f as unknown as typeof fetch, spy: f, calls, mints: () => calls.filter((c) => !c.url.endsWith('/revoke')) };
}

const usernames = (servers: { username?: string }[]) => servers.map((s) => s.username).filter(Boolean);
const monitor = (who: string, extra: Partial<IceRequest> = {}): IceRequest => ({ room: `n:${NID}`, who, bill: { scope: 'nursery', id: NID }, ...extra });

beforeEach(() => {
  resetIceCache();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('iceFor: without TURN', () => {
  it('is STUN only, never calls out, and has nothing to refresh', async () => {
    const api = turnApi();
    const g = await iceFor({}, monitor('u-mom'), 0, api.f);
    expect(g).toEqual({ servers: STUN, iceMs: null });
    expect(api.spy).not.toHaveBeenCalled();
    expect(iceFields(g)).toEqual({ ice: STUN }); // rooms send exactly what they sent before
  });
});

describe('iceFor: per room, person and payer', () => {
  it('mints a ≤ 4 h credential tagged with the payer, drops port 53, and says when to ask again', async () => {
    const api = turnApi();
    const g = await iceFor(ENV, monitor('u-mom'), 0, api.f);
    expect(includesTurn(g.servers)).toBe(true);
    expect(g.servers.slice(0, STUN.length)).toEqual(STUN);
    expect(JSON.stringify(g.servers)).not.toContain(':53');
    const [mint] = api.mints();
    expect(mint.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate');
    expect(mint.body!.ttl).toBe(TURN_TTL_S);
    expect(TURN_TTL_S).toBeLessThanOrEqual(4 * 3600);
    expect(mint.body!.customIdentifier).toBe(await turnTag(ENV, { scope: 'nursery', id: NID }));
    // Ask again 20 minutes before the credential lapses.
    expect(g.iceMs).toBe(TURN_TTL_S * 1000 - REFRESH_LEAD_MS);
    expect(iceFields(g)).toEqual({ ice: g.servers, iceMs: g.iceMs });
  });

  it('never shares a credential across rooms, people or payers', async () => {
    const api = turnApi();
    const a = await iceFor(ENV, monitor('u-mom'), 0, api.f);
    const b = await iceFor(ENV, monitor('u-dad'), 0, api.f);
    const c = await iceFor(ENV, { room: 'n:22222222-2222-4333-8444-555555555555', who: 'u-mom', bill: { scope: 'nursery', id: '22222222-2222-4333-8444-555555555555' } }, 0, api.f);
    const d = await iceFor(ENV, monitor('u-mom', { bill: { scope: 'account', id: 'u-mom' } }), 0, api.f);
    const e = await iceFor(ENV, { room: 'e:ev1', who: 'host', bill: { scope: 'event', id: 'ev1' } }, 0, api.f);
    const names = [a, b, c, d, e].map((g) => usernames(g.servers)[0]);
    expect(new Set(names).size).toBe(5);
    expect(api.mints()).toHaveLength(5);
  });

  it('reuses one person’s credential for a few minutes only (a reconnect storm is one API call)', async () => {
    const api = turnApi();
    const first = await iceFor(ENV, monitor('u-mom'), 0, api.f);
    for (let t = 1000; t < REUSE_MS; t += 30_000) await iceFor(ENV, monitor('u-mom'), t, api.f);
    const again = await iceFor(ENV, monitor('u-mom'), REUSE_MS - 1, api.f);
    expect(api.mints()).toHaveLength(1);
    expect(usernames(again.servers)).toEqual(usernames(first.servers));
    // The same credential, so the client's refresh time counts down rather than restarting.
    expect(again.iceMs).toBe(first.iceMs! - (REUSE_MS - 1));
    const fresh = await iceFor(ENV, monitor('u-mom'), REUSE_MS, api.f);
    expect(api.mints()).toHaveLength(2);
    expect(usernames(fresh.servers)).not.toEqual(usernames(first.servers));
  });

  it('guests get ≤ 2 h, never past their pass, and nothing once it has ended', async () => {
    const api = turnApi();
    await iceFor(ENV, monitor('g:jo', { guest: true }), 0, api.f);
    expect(api.mints()[0].body!.ttl).toBe(GUEST_TURN_TTL_S);
    expect(GUEST_TURN_TTL_S).toBeLessThanOrEqual(2 * 3600);
    const g = await iceFor(ENV, monitor('g:sam', { guest: true, until: 30 * 60_000 }), 0, api.f);
    expect(api.mints()[1].body!.ttl).toBe(30 * 60);
    // A short credential is refreshed a quarter of its life early (not 20 minutes into a 30-minute one).
    expect(g.iceMs).toBe(30 * 60_000 - 7.5 * 60_000);
    const over = await iceFor(ENV, monitor('g:ann', { guest: true, until: 1000 }), 1000, api.f);
    expect(over).toEqual({ servers: STUN, iceMs: null });
    expect(api.mints()).toHaveLength(2);
  });

  it('also reads the ready-made list shape, and falls back to it when `generate` fails', async () => {
    const list = turnApi({ shape: 'list' });
    expect(includesTurn((await iceFor(ENV, monitor('u-mom'), 0, list.f)).servers)).toBe(true);
    resetIceCache();
    const api = turnApi({ fail: (p) => p === 'generate' });
    const g = await iceFor(ENV, monitor('u-mom'), 0, api.f);
    expect(includesTurn(g.servers)).toBe(true);
    expect(api.calls.map((c) => c.url.split('/credentials/')[1])).toEqual(['generate', 'generate-ice-servers']);
    // The fallback still carries the payer's tag and the short lifetime.
    expect(api.calls[1].body).toEqual(api.calls[0].body);
  });
});

describe('iceFor: when the TURN API fails', () => {
  it('serves STUN only, asks the client back in a couple of minutes, and holds mints for 30 s', async () => {
    const api = turnApi({ fail: () => true });
    expect(await iceFor(ENV, monitor('u-mom'), 0, api.f)).toEqual({ servers: STUN, iceMs: RETRY_MS });
    expect(api.spy).toHaveBeenCalledTimes(2); // both endpoints, once
    await iceFor(ENV, monitor('u-dad'), 10_000, api.f);
    await iceFor(ENV, monitor('u-mom'), 29_000, api.f);
    expect(api.spy).toHaveBeenCalledTimes(2);
    await iceFor(ENV, monitor('u-mom'), 31_000, api.f);
    expect(api.spy).toHaveBeenCalledTimes(4);
  });

  it('a network error is a failure like any other', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await iceFor(ENV, monitor('u-mom'), 0, f as unknown as typeof fetch)).toEqual({ servers: STUN, iceMs: RETRY_MS });
  });
});

describe('turnTag (Cloudflare customIdentifier)', () => {
  it('is a stable, non-reversible tag per payer', async () => {
    const t = await turnTag(ENV, { scope: 'nursery', id: NID });
    expect(t).toMatch(/^n-[0-9a-f]{32}$/);
    expect(t).not.toContain(NID.slice(0, 8));
    expect(await turnTag(ENV, { scope: 'nursery', id: NID })).toBe(t);
    expect(await turnTag(ENV, { scope: 'account', id: NID })).toMatch(/^a-/);
    expect(await turnTag(ENV, { scope: 'account', id: NID })).not.toBe(`a-${t.slice(2)}`);
    expect(await turnTag(ENV, { scope: 'event', id: 'ev1' })).toMatch(/^e-[0-9a-f]{32}$/);
    // Keyed by a Worker secret: someone without it can't recompute (or reverse) it.
    expect(await turnTag({ ...ENV, TURN_TAG_SALT: 'other' }, { scope: 'nursery', id: NID })).not.toBe(t);
  });

  it('every credential that counts against one nursery carries the same tag (attribution)', async () => {
    const api = turnApi();
    await iceFor(ENV, monitor('u-mom'), 0, api.f);
    await iceFor(ENV, monitor('g:jo', { guest: true }), 0, api.f);
    await iceFor(ENV, monitor('u-dad', { bill: { scope: 'account', id: 'u-caller' } }), 0, api.f);
    const tags = api.mints().map((m) => m.body!.customIdentifier);
    expect(tags[0]).toBe(tags[1]);
    expect(tags[2]).toBe(await turnTag(ENV, { scope: 'account', id: 'u-caller' }));
    expect(tags.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
  });
});

describe('revokeIce', () => {
  it('revokes only the people asked for, in that room, and they get a fresh credential next time', async () => {
    const api = turnApi();
    const jo = await iceFor(ENV, monitor('g:jo', { guest: true }), 0, api.f);
    await iceFor(ENV, monitor('g:sam', { guest: true }), 0, api.f);
    await iceFor(ENV, monitor('u-mom'), 0, api.f);
    await iceFor(ENV, { room: 'n:other', who: 'g:jo', bill: { scope: 'nursery', id: 'other' } }, 0, api.f);

    expect(await revokeIce(ENV, `n:${NID}`, (w) => w === 'g:jo', 1000, api.f)).toBe(1);
    const revoked = api.calls.filter((c) => c.url.endsWith('/revoke')).map((c) => c.url);
    expect(revoked).toEqual([`https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/${usernames(jo.servers)[0]}/revoke`]);

    // Within the reuse window, a revoked credential is never handed out again.
    const again = await iceFor(ENV, monitor('g:jo', { guest: true }), 2000, api.f);
    expect(usernames(again.servers)).not.toEqual(usernames(jo.servers));

    // Everyone in the room (an ended call): Sam, Mom and Jo's new one — not the other nursery's.
    expect(await revokeIce(ENV, `n:${NID}`, undefined, 3000, api.f)).toBe(3);
    expect(await revokeIce(ENV, 'n:nobody', undefined, 3000, api.f)).toBe(0);
  });

  it('skips credentials that already lapsed, and does nothing without TURN', async () => {
    const api = turnApi();
    await iceFor(ENV, monitor('u-mom'), 0, api.f);
    expect(await revokeIce(ENV, `n:${NID}`, undefined, TURN_TTL_S * 1000 + 1, api.f)).toBe(0);
    expect(await revokeIce({}, `n:${NID}`, undefined, 0, api.f)).toBe(0);
  });
});

describe('dropPort53', () => {
  it('drops servers left with no URLs', () => {
    expect(dropPort53([{ urls: 'turn:x:53' }, { urls: ['stun:y:3478'] }])).toEqual([{ urls: ['stun:y:3478'] }]);
  });
});

it('keeps the 4 h ceiling well clear of the refresh lead (a client always has time to renew)', () => {
  expect(TURN_TTL_S * 1000 - REUSE_MS - REFRESH_LEAD_MS).toBeGreaterThan(3 * H);
});
