// @vitest-environment node
// The nursery room as the family's switchboard — connecting faster and more
// reliably: fresh ICE per call, pings answered by the runtime, the joiner's
// offer relayed right behind its join, phones that lost the room kept in the
// call while the others vouch for them, dead lines dropped, and how
// connecting went kept with the call's history.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./webpush', () => ({
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: async () => 'sent',
}));

import { resetIceCache, STUN } from './ice';
import { MonitorRoom, type MonEnv } from './monitorRoom';

const NID = '11111111-2222-4333-8444-555555555555';
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

class FakeWS {
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

class Pair {
  constructor(public request: string, public response: string) {}
}

type CallMsg = { id: string; answeredAt: number | null; ended: { why: string } | null; parts: { sid: string; uid: string; mic: boolean; gone?: number; seen?: number }[] };
const lastCall = (ws: FakeWS) => ws.msgs('call').at(-1)?.call as CallMsg | undefined;

function setup(extraEnv: Record<string, string> = {}) {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  const store = new Map<string, unknown>([['nid', NID]]);
  const sockets: FakeWS[] = [];
  const pinged = new Map<FakeWS, number>();
  let alarm: number | null = null;
  const autoResponse = vi.fn();
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      delete: async (k: string) => store.delete(k),
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
      sql: sqlStorage(),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => sockets.push(ws),
    setWebSocketAutoResponse: autoResponse,
    getWebSocketAutoResponseTimestamp: (ws: FakeWS) => (pinged.has(ws) ? new Date(pinged.get(ws)!) : null),
  };
  const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }), { status: 200 }) };
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_PUBLISHABLE_KEY: 'sb_test', MONITOR_ROOM: { idFromName: () => 'x', get: () => keyHolder }, ...extraEnv } as unknown as MonEnv;
  const room = new MonitorRoom(state as never, env);
  const roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }> = {
    'tok-parent': { user_id: 'u-parent', role: 'parent', display_name: 'Alice', label: 'Mom' },
    'tok-care': { user_id: 'u-care', role: 'caregiver', display_name: 'Bob', label: 'Grandpa' },
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const r = roles[token];
    return new Response(JSON.stringify(r ? { ok: true, ...r, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  });
  const line = async (token: string, dev: string) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode: 'line', dev, dn: 'Phone' }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const close = (ws: FakeWS) => {
    sockets.splice(sockets.indexOf(ws), 1);
    return room.webSocketClose(ws as never);
  };
  /** Mom calls Grandpa and he picks up. */
  const connected = async () => {
    const mom = await line('tok-parent', 'mom');
    const gpa = await line('tok-care', 'gpa');
    await say(mom, { t: 'call_start', to: ['u-care'], video: true, ref: 'r1' });
    const id = mom.msgs('call_started')[0].id as string;
    await say(gpa, { t: 'call_join', id, video: true });
    return { mom, gpa, id };
  };
  return { room, store, line, say, close, connected, autoResponse, pinged, alarm: () => alarm };
}

describe('MonitorRoom: connecting family calls', () => {
  it('keepalive pings are answered by the runtime, without waking the room', () => {
    const { autoResponse } = setup();
    expect(autoResponse).toHaveBeenCalledTimes(1);
    expect(autoResponse.mock.calls[0][0]).toMatchObject({ request: '{"t":"ping"}', response: '{"t":"pong"}' });
  });

  it('the caller and the one who picks up each get fresh ICE servers for this call', async () => {
    const { connected } = setup();
    const { mom, gpa, id } = await connected();
    expect(mom.msgs('call_started')[0]).toMatchObject({ ref: 'r1', id, ice: STUN });
    expect(gpa.msgs('call_joined')).toEqual([{ t: 'call_joined', id, ice: STUN }]);
  });

  it('commits the join before waiting on relay credentials, so the offer right behind it gets through', async () => {
    resetIceCache();
    const { line, say, store } = setup({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' });
    // Supabase answers at once; minting TURN credentials can be slow (held on demand).
    let hold = false;
    let mint: (() => void) | undefined;
    const supabase = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).includes('rtc.live.cloudflare.com')) return supabase(url, init);
      if (hold) await new Promise<void>((r) => (mint = r));
      return new Response(JSON.stringify({ iceServers: { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' } }), { status: 200 });
    });
    const mom = await line('tok-parent', 'mom');
    const gpa = await line('tok-care', 'gpa');
    await say(mom, { t: 'call_start', to: ['u-care'], video: true, ref: 'r1' });
    const id = mom.msgs('call_started')[0].id as string;
    expect(mom.msgs('call_started')[0].ice).toEqual([...STUN, { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]);

    resetIceCache();
    hold = true;
    const joined = say(gpa, { t: 'call_join', id, video: true, mic: true });
    await vi.waitFor(() => expect(mint).toBeTypeOf('function'));
    // Still waiting on the credentials — but the join is already saved and announced…
    expect((store.get('calls') as CallMsg[])[0].parts.map((p) => p.sid)).toEqual(['s-mom', 's-gpa']);
    expect(lastCall(mom)?.parts).toHaveLength(2);
    // …so the offer sent right behind it is relayed.
    await say(gpa, { t: 'call_rtc', id, to: 's-mom', d: { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' } });
    expect(mom.msgs('call_rtc')).toEqual([{ t: 'call_rtc', id, from: 's-gpa', d: { sdp: { type: 'offer', sdp: 'x' }, cid: 'k1' } }]);
    expect(gpa.msgs('call_joined')).toEqual([]);
    mint!();
    await joined;
    expect(gpa.msgs('call_joined')[0]).toMatchObject({ id, ice: [...STUN, expect.objectContaining({ username: 'u' })] });
    resetIceCache();
  });

  it('coming back on a new connection keeps your mute', async () => {
    const { connected, line, say, close } = setup();
    const { mom, gpa, id } = await connected();
    await say(gpa, { t: 'call_media', id, mic: false, cam: true });
    await close(gpa);
    const again = await line('tok-care', 'gpa-2');
    await say(again, { t: 'call_join', id, video: true, mic: false });
    expect(lastCall(mom)?.parts.find((p) => p.uid === 'u-care')).toMatchObject({ sid: 's-gpa-2', mic: false });
  });

  it('keeps a phone that lost the room in the call while the other phone still gets its media', async () => {
    const { connected, say, close, store, room } = setup();
    const { mom, gpa, id } = await connected();
    await close(gpa);
    expect(lastCall(mom)?.parts.find((p) => p.uid === 'u-care')?.gone).toEqual(expect.any(Number));
    const before = mom.sent.length;
    await say(mom, { t: 'call_up', id, uids: ['u-care'] });
    expect(mom.sent.length).toBe(before); // nothing broadcast
    // 25 s later — past the 20 s grace — but vouched for 5 s ago: still in the call.
    const calls = store.get('calls') as CallMsg[];
    const g = calls[0].parts.find((p) => p.uid === 'u-care')!;
    expect(g.seen).toEqual(expect.any(Number));
    g.gone! -= 25_000;
    g.seen! -= 5_000;
    await room.alarm();
    expect(lastCall(mom)?.ended).toBeNull();
    // Nobody has vouched for 40 s: it's over.
    g.seen! -= 35_000;
    store.set('calls', calls);
    await room.alarm();
    expect(lastCall(mom)?.ended?.why).toBe('done');
  });

  it('drops a line in a call that stopped pinging (a phone that died mid-call)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-10-22T10:00:00Z').getTime();
    vi.setSystemTime(t0);
    const { connected, room, pinged, alarm } = setup();
    const { mom, gpa } = await connected();
    // Checked while the call is up — at the moment a line would have been quiet for a minute.
    expect(alarm()).toBe(t0 + 60_000);
    vi.setSystemTime(t0 + 70_000);
    pinged.set(mom, t0 + 65_000); // Mom's app still pings; Grandpa's went silent
    await room.alarm();
    expect(gpa.closed).toBe(4008);
    expect(mom.closed).toBeNull();
    expect(lastCall(mom)?.parts.find((p) => p.uid === 'u-care')?.gone).toBe(t0 + 70_000);
    expect(alarm()).toBeLessThanOrEqual(t0 + 70_000 + 30_000);
  });

  it('keeps how connecting went with the call’s history', async () => {
    const { connected, say } = setup();
    const { mom, gpa, id } = await connected();
    await say(gpa, { t: 'call_stats', id, ttc: 812, path: 'internet', fail: null, turn: false });
    await say(mom, { t: 'call_stats', id, ttc: 2500.7, path: 'lan', fail: 'nat', turn: false });
    await say(mom, { t: 'call_leave', id });
    expect(gpa.msgs('call_log')[0].rec).toMatchObject({
      stats: [
        { uid: 'u-care', ttc: 812, path: 'internet', fail: null, turn: false },
        { uid: 'u-parent', ttc: 2501, path: 'lan', fail: 'nat', turn: false },
      ],
    });
  });
});
