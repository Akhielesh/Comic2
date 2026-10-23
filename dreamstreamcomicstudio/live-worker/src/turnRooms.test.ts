// @vitest-environment node
// The TURN guardrails where the rooms hand credentials out (stream-studio-costs.md §7 C6):
// every person gets their own, short-lived and tagged with whoever their relay bytes count
// against (the nursery for the monitor, the caller for calls, the event for Stream Studio);
// long sessions ask for fresh ones; removed people lose theirs at once; and who gets TURN
// at all is unchanged — members and guests with a valid pass, people in a call, the studio
// host and on-air guests, never admin sockets or broadcast viewers.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./webpush', () => ({
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: async () => 'sent',
}));

import { CallRoom } from './callRoom';
import { DOHarness, FakeWS as LineWS, Pair } from './directTestKit';
import { EventRoom } from './eventRoom';
import { GUEST_TURN_TTL_S, REFRESH_LEAD_MS, STUN, TURN_TTL_S, includesTurn, resetIceCache, turnTag, type RTCIceServerLike } from './ice';
import { MonitorRoom, type MonEnv } from './monitorRoom';

const NID = '11111111-2222-4333-8444-555555555555';
const TURN_ENV = { TURN_KEY_ID: 'key1', TURN_KEY_API_TOKEN: 'secret-token' };
const H = 3600_000;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(() => {
  resetIceCache();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIceCache();
});

/** Cloudflare's credential API (a new username per credential) behind any other fetch the room makes. */
function turnApi(other: (url: string, init: RequestInit) => Promise<Response> = async () => new Response('{}', { status: 404 })) {
  let n = 0;
  const mints: { ttl: number; customIdentifier: string; username: string }[] = [];
  const revoked: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = String(url);
    if (!u.startsWith('https://rtc.live.cloudflare.com/')) return other(u, init);
    const rev = /\/credentials\/([^/]+)\/revoke$/.exec(u);
    if (rev) {
      revoked.push(decodeURIComponent(rev[1]));
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(String(init.body)) as { ttl: number; customIdentifier: string };
    const username = `user${++n}`;
    mints.push({ ...body, username });
    return new Response(JSON.stringify({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username, credential: `cred${n}` } }), { status: 201 });
  });
  const mintOf = (servers: unknown) => mints.find((m) => m.username === userOf(servers));
  return { mints, revoked, mintOf };
}
const userOf = (servers: unknown) => (servers as RTCIceServerLike[] | undefined)?.find((s) => s.username)?.username;

/* ------------------------------------------------------------ MonitorRoom */

function sqlStorage() {
  const db = new SQL.Database();
  return {
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
}

class MonWS {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  private att: unknown = null;
  send(s: string | ArrayBuffer) {
    if (typeof s === 'string') this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
  close(code: number) {
    this.closed = code;
  }
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

function monitor() {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  const store = new Map<string, unknown>([['nid', NID]]);
  const sockets: MonWS[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      delete: async (k: string) => store.delete(k),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      sql: sqlStorage(),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: MonWS) => sockets.push(ws),
    setWebSocketAutoResponse: () => undefined,
    getWebSocketAutoResponseTimestamp: () => null,
  };
  const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }), { status: 200 }) };
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_PUBLISHABLE_KEY: 'sb_test', MONITOR_ROOM: { idFromName: () => 'x', get: () => keyHolder }, ...TURN_ENV } as unknown as MonEnv;
  const room = new MonitorRoom(state as never, env);
  const roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }> = {
    'tok-parent': { user_id: 'u-parent', role: 'parent', display_name: 'Alice', label: 'Mom' },
    'tok-care': { user_id: 'u-care', role: 'caregiver', display_name: 'Bob', label: 'Grandpa' },
  };
  let members = ['u-parent', 'u-care'];
  const api = turnApi(async (url, init) => {
    if (url.endsWith('/monitor_member_ids')) return new Response(JSON.stringify({ ok: true, ids: members }), { status: 200 });
    if (url.endsWith('/monitor_people')) return new Response(JSON.stringify({ ok: true, people: members.map((u) => ({ user_id: u, role: u === 'u-parent' ? 'parent' : 'caregiver', label: null })) }), { status: 200 });
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const r = roles[token];
    return new Response(JSON.stringify(r ? { ok: true, ...r, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  });
  const join = async (token: string, mode: 'camera' | 'viewer' | 'line' | 'admin', dev: string, extra: Record<string, unknown> = {}) => {
    const ws = new MonWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev, ...extra }));
    return ws;
  };
  const say = (ws: MonWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  /** Mom makes a share link; a guest joins with it and opens the monitor. */
  const guest = async (mom: MonWS, name: string) => {
    if (!mom.msgs('share').some((m) => (m.share as { on: boolean }).on)) await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    const res = await room.fetch(new Request(`https://monitor.internal/guest?nid=${NID}`, { method: 'POST', body: JSON.stringify({ code, pass: 'blue-otter-42', name }), headers: { 'cf-connecting-ip': '9.9.9.9' } }));
    const { token } = (await res.json()) as { token: string };
    const ws = await join('', 'viewer', `${name}-ipad`, { guest: token });
    const id = (mom.msgs('share').at(-1)!.share as { guests: { id: string; name: string }[] }).guests.find((g) => g.name === name)!.id;
    return { ws, id };
  };
  return { room, join, say, guest, api, setMembers: (ids: string[]) => (members = ids) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('MonitorRoom: relay credentials', () => {
  it('each camera, viewer and guest gets one of its own, ≤ 4 h (guests ≤ 2 h), counted against the nursery', async () => {
    const { join, guest, api } = monitor();
    const mom = await join('tok-parent', 'viewer', 'mom-phone');
    const cam = await join('tok-care', 'camera', 'crib');
    const { ws: jo } = await guest(mom, 'Jo');
    const hellos = [mom, cam, jo].map((ws) => ws.msgs('hello')[0] as { ice: RTCIceServerLike[]; iceMs?: number });
    for (const h of hellos) {
      expect(includesTurn(h.ice)).toBe(true);
      expect(h.ice.slice(0, STUN.length)).toEqual(STUN);
      expect(h.iceMs).toBeGreaterThan(0);
    }
    expect(new Set(hellos.map((h) => userOf(h.ice))).size).toBe(3);
    const nursery = await turnTag(TURN_ENV, { scope: 'nursery', id: NID });
    expect(api.mints.map((m) => m.customIdentifier)).toEqual([nursery, nursery, nursery]);
    expect(api.mintOf(hellos[0].ice)!.ttl).toBe(TURN_TTL_S);
    expect(api.mintOf(hellos[1].ice)!.ttl).toBe(TURN_TTL_S);
    expect(api.mintOf(hellos[2].ice)!.ttl).toBeLessThanOrEqual(GUEST_TURN_TTL_S);
    // The client is told to ask again before the credential lapses.
    expect(hellos[0].iceMs).toBeLessThanOrEqual(TURN_TTL_S * 1000 - REFRESH_LEAD_MS);
  });

  it('the Invite sheet (admin socket) never gets TURN, and can’t ask for it', async () => {
    const { join, say, api } = monitor();
    const admin = await join('tok-parent', 'admin', 'sheet');
    expect(admin.msgs('hello')[0]).not.toHaveProperty('ice');
    await say(admin, { t: 'ice' });
    expect(admin.msgs('ice')).toHaveLength(0);
    expect(api.mints).toHaveLength(0);
  });

  it('an overnight viewer asks for fresh credentials before they lapse — the same ones only within a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-22T21:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { join, say } = monitor();
    const viewer = await join('tok-parent', 'viewer', 'bedside');
    const first = viewer.msgs('hello')[0] as { ice: RTCIceServerLike[]; iceMs: number };
    vi.setSystemTime(t0 + 60_000);
    await say(viewer, { t: 'ice' });
    expect(userOf(viewer.msgs('ice')[0].servers)).toBe(userOf(first.ice)); // a reconnect storm is one credential
    vi.setSystemTime(t0 + first.iceMs);
    await say(viewer, { t: 'ice' });
    const renewed = viewer.msgs('ice')[1] as { servers: RTCIceServerLike[]; iceMs: number };
    expect(userOf(renewed.servers)).not.toBe(userOf(first.ice));
    expect(renewed.iceMs).toBe(TURN_TTL_S * 1000 - REFRESH_LEAD_MS);
    // Through a 12-hour night, the viewer is never without a valid credential.
    expect(first.iceMs + renewed.iceMs).toBeGreaterThan(6 * H);
  });

  it('a removed guest loses their credential at once; turning the link off revokes the rest', async () => {
    const { join, say, guest, api } = monitor();
    const mom = await join('tok-parent', 'viewer', 'mom-phone');
    const jo = await guest(mom, 'Jo');
    const sam = await guest(mom, 'Sam');
    const joUser = userOf(jo.ws.msgs('hello')[0].ice);
    const samUser = userOf(sam.ws.msgs('hello')[0].ice);
    await say(mom, { t: 'guest_remove', id: jo.id });
    await flush();
    expect(api.revoked).toEqual([joUser]);
    await say(mom, { t: 'share_off' });
    await flush();
    expect(api.revoked).toEqual([joUser, samUser]);
    // Mom's own credential is untouched.
    expect(api.revoked).not.toContain(userOf(mom.msgs('hello')[0].ice));
  });

  it('a guest whose pass has ended gets STUN only when it asks again', async () => {
    const { join, say, guest, api } = monitor();
    const mom = await join('tok-parent', 'viewer', 'mom-phone');
    const jo = await guest(mom, 'Jo');
    const before = api.mints.length;
    // The pass ends (removed in the room's own records) while the socket is still open.
    await say(mom, { t: 'guest_remove', id: jo.id });
    await say(jo.ws, { t: 'ice' });
    expect(jo.ws.msgs('ice')).toEqual([{ t: 'ice', servers: STUN }]);
    expect(api.mints.length).toBe(before);
  });

  it('a member taken off the nursery loses this nursery’s credentials', async () => {
    const { join, say, api, setMembers } = monitor();
    const mom = await join('tok-parent', 'viewer', 'mom-phone');
    const gpa = await join('tok-care', 'camera', 'crib');
    setMembers(['u-parent']);
    await say(mom, { t: 'members_changed', token: 'tok-parent' });
    await flush();
    expect(gpa.closed).toBe(4004);
    expect(api.revoked).toEqual([userOf(gpa.msgs('hello')[0].ice)]);
  });

  it('family calls count against the caller — for the one who picks up too — and long calls get fresh credentials', async () => {
    const { join, say, api } = monitor();
    const mom = await join('tok-parent', 'line', 'mom');
    const gpa = await join('tok-care', 'line', 'gpa');
    const outsider = await join('tok-care', 'line', 'gpa-laptop');
    const momTag = await turnTag(TURN_ENV, { scope: 'account', id: 'u-parent' });
    const gpaTag = await turnTag(TURN_ENV, { scope: 'account', id: 'u-care' });
    // A line's own hello: counted against its owner (they'd be the caller).
    expect(api.mintOf(mom.msgs('hello')[0].ice)!.customIdentifier).toBe(momTag);
    expect(api.mintOf(gpa.msgs('hello')[0].ice)!.customIdentifier).toBe(gpaTag);

    await say(mom, { t: 'call_start', to: ['u-care'], video: true, ref: 'r1' });
    const started = mom.msgs('call_started')[0] as { id: string; ice: RTCIceServerLike[]; iceMs: number };
    expect(api.mintOf(started.ice)!.customIdentifier).toBe(momTag);
    expect(started.iceMs).toBeGreaterThan(0);
    await say(gpa, { t: 'call_join', id: started.id, video: true });
    const joined = gpa.msgs('call_joined')[0] as { ice: RTCIceServerLike[] };
    expect(api.mintOf(joined.ice)!.customIdentifier).toBe(momTag);
    expect(userOf(joined.ice)).not.toBe(userOf(started.ice));

    await say(gpa, { t: 'call_ice', id: started.id });
    expect(gpa.msgs('call_ice')[0]).toMatchObject({ id: started.id, ice: expect.any(Array), iceMs: expect.any(Number) });
    expect(api.mintOf(gpa.msgs('call_ice')[0].ice)!.customIdentifier).toBe(momTag);
    // Not in the call: nothing.
    await say(outsider, { t: 'call_ice', id: started.id });
    expect(outsider.msgs('call_ice')).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- CallRoom */

const CALL_ID = '0123456789abcdef';
const ALICE = { uid: '00000000-0000-4000-8000-00000000a11c', name: 'Alice' };
const SAM = { uid: '00000000-0000-4000-8000-000000000005', name: 'Sam' };

function directCall() {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  const api = turnApi();
  const h = new DOHarness();
  const tickets = new Map<string, string>();
  const USER_LINE = {
    idFromName: (n: string) => n,
    get: (n: string) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as Record<string, unknown>;
        if (new URL(req.url).pathname === '/x/ring') tickets.set(n.replace(/^u:/, ''), body.ticket as string);
        return new Response(JSON.stringify({ status: 'ringing', name: 'Sam' }), { status: 200 });
      },
    }),
  };
  const room = new CallRoom(h.state as never, { USER_LINE, ...TURN_ENV } as never);
  const enter = async (ticket: string, dev: string) => {
    const ws = h.accept(`s-${dev}`);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', ticket, dev }));
    return ws;
  };
  const say = (ws: LineWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const answered = async () => {
    const res = await room.fetch(new Request('https://call.internal/x/init', { method: 'POST', body: JSON.stringify({ id: CALL_ID, from: ALICE, video: true, to: [{ uid: SAM.uid, family: false, where: null }] }) }));
    const { ticket } = (await res.json()) as { ticket: string };
    const alice = await enter(ticket, 'alice');
    await say(alice, { t: 'call_join', id: CALL_ID, video: true, mic: true });
    const sam = await enter(tickets.get(SAM.uid)!, 'sam');
    await say(sam, { t: 'call_join', id: CALL_ID, video: true, mic: true });
    return { alice, sam };
  };
  return { api, say, enter, answered };
}

describe('CallRoom: relay credentials', () => {
  it('per person, counted against the caller, refreshed on request, and revoked when the call ends', async () => {
    const { api, say, answered } = directCall();
    const { alice, sam } = await answered();
    const caller = await turnTag(TURN_ENV, { scope: 'account', id: ALICE.uid });
    const lists = [alice.last('hello')!.ice, sam.last('hello')!.ice, alice.last('call_joined')!.ice, sam.last('call_joined')!.ice];
    expect(lists.every((l) => includesTurn(l as RTCIceServerLike[]))).toBe(true);
    expect(new Set(api.mints.map((m) => m.customIdentifier))).toEqual(new Set([caller]));
    // Alice's and Sam's are never the same credential.
    expect(userOf(alice.last('call_joined')!.ice)).not.toBe(userOf(sam.last('call_joined')!.ice));
    expect(api.mints.every((m) => m.ttl <= 4 * 3600)).toBe(true);

    await say(sam, { t: 'call_ice', id: CALL_ID });
    expect(sam.last('call_ice')).toMatchObject({ id: CALL_ID, ice: expect.any(Array), iceMs: expect.any(Number) });

    await say(alice, { t: 'call_leave', id: CALL_ID });
    expect(new Set(api.revoked)).toEqual(new Set(api.mints.map((m) => m.username)));
  });
});

/* -------------------------------------------------------------- EventRoom */

class EvWS {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  private att: unknown;
  constructor(att: unknown) {
    this.att = structuredClone(att);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  serializeAttachment(a: unknown) {
    this.att = structuredClone(a);
  }
  deserializeAttachment() {
    return this.att;
  }
  close(code: number) {
    this.closed = code;
  }
  msgs(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

function studio() {
  const api = turnApi();
  const store = new Map<string, unknown>();
  const sockets: EvWS[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') store.set(k, structuredClone(v));
        else for (const [kk, vv] of Object.entries(k)) store.set(kk, structuredClone(vv));
      },
      delete: async (k: string) => store.delete(k),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: EvWS) => void sockets.push(ws),
  };
  const room = new EventRoom(state as never, { ALLOWED_ORIGINS: '*', ...TURN_ENV } as never);
  const join = (role: string, sid = role) => {
    const ws = new EvWS({ sid, name: sid, role });
    sockets.push(ws);
    return ws;
  };
  const say = (ws: EvWS, msg: Record<string, unknown>) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const init = () => room.fetch(new Request('https://room.internal/init', { method: 'POST', body: JSON.stringify({ id: 'ev1', title: 'T', kind: 'meeting' }) }));
  return { api, join, say, init };
}

describe('EventRoom: relay credentials', () => {
  it('the host and each on-air guest get their own (guests ≤ 2 h), counted against the event; viewers and mods none', async () => {
    const { api, join, say, init } = studio();
    await init();
    const host = join('host');
    const ann = join('guest', 'ann');
    const ben = join('guest', 'ben');
    const viewer = join('viewer');
    const mod = join('mod');
    for (const ws of [host, ann, ben, viewer, mod]) await say(ws, { t: 'ice' });
    expect(viewer.msgs('ice')).toHaveLength(0);
    expect(mod.msgs('ice')).toHaveLength(0);
    const users = [host, ann, ben].map((ws) => userOf(ws.msgs('ice')[0].servers));
    expect(new Set(users).size).toBe(3);
    const ev = await turnTag(TURN_ENV, { scope: 'event', id: 'ev1' });
    expect(api.mints.map((m) => m.customIdentifier)).toEqual([ev, ev, ev]);
    expect(api.mints.map((m) => m.ttl)).toEqual([TURN_TTL_S, GUEST_TURN_TTL_S, GUEST_TURN_TTL_S]);
    expect(host.msgs('ice')[0].iceMs).toBeGreaterThan(0);
  });

  it('kicking an on-air guest revokes only their credential', async () => {
    const { api, join, say, init } = studio();
    await init();
    const host = join('host');
    const ann = join('guest', 'ann');
    const ben = join('guest', 'ben');
    for (const ws of [host, ann, ben]) await say(ws, { t: 'ice' });
    await say(host, { t: 'kick', sid: 'ann' });
    expect(ann.closed).toBe(4002);
    expect(api.revoked).toEqual([userOf(ann.msgs('ice')[0].servers)]);
  });
});
