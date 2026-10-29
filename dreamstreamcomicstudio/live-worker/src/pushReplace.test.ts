// @vitest-environment node
// One alert per device after Stream Studio moves host (ADR 0006 WS-5; INFRA_MAP §2a): a browser
// that subscribed at dreamstreamstudio.ai/live and subscribes again at the new host sends the old
// endpoint as `sub.was`; the rooms drop it — the same account's only — when they store the new one.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushes = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('./webpush', async (orig) => ({
  ...(await orig<typeof import('./webpush')>()),
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  sendWebPush: async (sub: { endpoint: string }) => {
    pushes.sent.push(sub.endpoint);
    return 'sent';
  },
}));

import { MonitorRoom, type MonEnv } from './monitorRoom';
import { replacedEndpoint, storeReplacing } from './pushReplace';
import { Pair, World, type Member } from './directTestKit';
import { clearMemberCache } from './supabaseAuth';

const NID = '11111111-2222-4333-8444-555555555555';
const FCM = (s: string) => `https://fcm.googleapis.com/fcm/send/${s}`;
const OLD = FCM('apex-live'); // this browser at dreamstreamstudio.ai/live
const NEW = FCM('stream-host'); // the same browser at stream.dreamstreamstudio.ai
const KEYS = { p256dh: 'p', auth: 'a' };

/* ------------------------------------------------------------- the pieces */

describe('replacedEndpoint', () => {
  it('names the old endpoint only when it is a real push service and not the new one', () => {
    expect(replacedEndpoint({ endpoint: NEW, was: OLD }, NEW)).toBe(OLD);
    expect(replacedEndpoint({ endpoint: NEW }, NEW)).toBeNull();
    expect(replacedEndpoint({ endpoint: NEW, was: NEW }, NEW)).toBeNull();
    expect(replacedEndpoint({ endpoint: NEW, was: 'https://evil.example/collect' }, NEW)).toBeNull();
    expect(replacedEndpoint({ endpoint: NEW, was: 'http://fcm.googleapis.com/fcm/send/x' }, NEW)).toBeNull();
    expect(replacedEndpoint({ endpoint: NEW, was: FCM('x'.repeat(1100)) }, NEW)).toBeNull();
    expect(replacedEndpoint({ endpoint: NEW, was: 42 }, NEW)).toBeNull();
    expect(replacedEndpoint(null, NEW)).toBeNull();
  });
});

describe('storeReplacing', () => {
  const rec = (endpoint: string, uid: string, at = 0) => ({ sub: { endpoint }, uid, at });

  it('replaces the same endpoint, drops the replaced one for the same account, keeps everything else', () => {
    const all = [rec(OLD, 'u1'), rec(NEW, 'u1', 1), rec(FCM('mom'), 'u2')];
    const next = storeReplacing(all, rec(NEW, 'u1', 2), OLD, (r) => r.uid === 'u1');
    expect(next).toEqual([rec(FCM('mom'), 'u2'), rec(NEW, 'u1', 2)]);
  });

  it('never drops another account’s subscription, even when `was` names it', () => {
    const all = [rec(OLD, 'u2')];
    expect(storeReplacing(all, rec(NEW, 'u1'), OLD, (r) => r.uid === 'u1')).toEqual([rec(OLD, 'u2'), rec(NEW, 'u1')]);
  });

  it('without `was` it is the plain replace-by-endpoint it always was', () => {
    const all = [rec(OLD, 'u1'), rec(NEW, 'u1', 1)];
    expect(storeReplacing(all, rec(NEW, 'u1', 2), null, () => true)).toEqual([rec(OLD, 'u1'), rec(NEW, 'u1', 2)]);
  });
});

/* ----------------------------------------------------------- MonitorRoom */

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
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
}

function room() {
  const store = new Map<string, unknown>([['nid', NID]]);
  const sockets: FakeWS[] = [];
  let alarm: number | null = null;
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
  };
  const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }), { status: 200 }) };
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_test',
    MONITOR_ROOM: { idFromName: () => 'x', get: () => keyHolder },
  } as unknown as MonEnv;
  const r = new MonitorRoom(state as never, env);
  const roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }> = {
    'tok-mom': { user_id: 'u-mom', role: 'parent', display_name: 'Alice', label: 'Mom' },
    'tok-gpa': { user_id: 'u-gpa', role: 'caregiver', display_name: 'Bob', label: 'Grandpa' },
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const who = roles[token];
    return new Response(JSON.stringify(who ? { ok: true, ...who, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  });
  const join = async (token: string, mode: 'camera' | 'viewer' | 'line', dev: string) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await r.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => r.webSocketMessage(ws as never, JSON.stringify(msg));
  const endpoints = (key: 'push' | 'callPush') => ((store.get(key) as { sub: { endpoint: string }; uid: string }[] | undefined) ?? []).map((x) => `${x.uid} ${x.sub.endpoint}`);
  return { join, say, endpoints };
}

describe('MonitorRoom: alerts turned on again at the new host', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pushes.sent = [];
  });

  it('the old /live subscription goes when the new one arrives — then one alert, not two', async () => {
    const { join, say, endpoints } = room();
    const cam = await join('tok-mom', 'camera', 'crib');
    const oldTab = await join('tok-mom', 'viewer', 'apex');
    await say(oldTab, { t: 'push_sub', sub: { endpoint: OLD, keys: KEYS }, prefs: {} });
    const gpa = await join('tok-gpa', 'viewer', 'laptop');
    await say(gpa, { t: 'push_sub', sub: { endpoint: FCM('grandpa'), keys: KEYS }, prefs: {} });
    expect(endpoints('push')).toEqual([`u-mom ${OLD}`, `u-gpa ${FCM('grandpa')}`]);

    const newTab = await join('tok-mom', 'viewer', 'stream');
    await say(newTab, { t: 'push_sub', sub: { endpoint: NEW, keys: KEYS, dev: 'AbCdEfGhIjKlMnOpQrStUv', was: OLD }, prefs: {} });
    expect(endpoints('push')).toEqual([`u-gpa ${FCM('grandpa')}`, `u-mom ${NEW}`]);
    expect(newTab.sent.some((m) => m.t === 'push_ok')).toBe(true);

    await say(cam, { t: 'event', kind: 'sound', cat: 'alarm', phase: 'start', conf: 88, pattern: 'T3' });
    expect(pushes.sent.sort()).toEqual([FCM('grandpa'), NEW].sort());
  });

  it('`was` can’t remove someone else’s subscription', async () => {
    const { join, say, endpoints } = room();
    const gpa = await join('tok-gpa', 'viewer', 'laptop');
    await say(gpa, { t: 'push_sub', sub: { endpoint: FCM('grandpa'), keys: KEYS }, prefs: {} });
    const mom = await join('tok-mom', 'viewer', 'stream');
    await say(mom, { t: 'push_sub', sub: { endpoint: NEW, keys: KEYS, was: FCM('grandpa') }, prefs: {} });
    expect(endpoints('push')).toEqual([`u-gpa ${FCM('grandpa')}`, `u-mom ${NEW}`]);
  });

  it('call ringing through the nursery line is de-duplicated the same way', async () => {
    const { join, say, endpoints } = room();
    const oldLine = await join('tok-mom', 'line', 'apex');
    await say(oldLine, { t: 'call_push', sub: { endpoint: OLD, keys: KEYS } });
    const gpaLine = await join('tok-gpa', 'line', 'laptop');
    await say(gpaLine, { t: 'call_push', sub: { endpoint: FCM('grandpa'), keys: KEYS } });
    const newLine = await join('tok-mom', 'line', 'stream');
    await say(newLine, { t: 'call_push', sub: { endpoint: NEW, keys: KEYS, was: OLD } });
    expect(endpoints('callPush')).toEqual([`u-gpa ${FCM('grandpa')}`, `u-mom ${NEW}`]);
    // …and not someone else's.
    await say(newLine, { t: 'call_push', sub: { endpoint: FCM('mom-2'), keys: KEYS, was: FCM('grandpa') } });
    expect(endpoints('callPush')).toContain(`u-gpa ${FCM('grandpa')}`);
  });
});

/* -------------------------------------------------------------- UserLine */

describe('UserLine: direct-call ringing moves with the host too', () => {
  let w: World;
  let sam: Member;
  beforeEach(() => {
    vi.stubGlobal('WebSocketRequestResponsePair', Pair);
    w = new World();
    vi.stubGlobal('fetch', w.fetch);
    sam = w.add({ uid: '00000000-0000-4000-8000-000000000002', name: 'Sam', token: 'tok-sam' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearMemberCache();
  });

  it('the old /live ring subscription is dropped when the new host’s arrives', async () => {
    const apex = await w.app(sam, 'apex');
    await w.say(sam, apex, { t: 'call_push', sub: { endpoint: OLD, keys: KEYS } });
    await w.say(sam, apex, { t: 'call_push', sub: { endpoint: FCM('laptop'), keys: KEYS } });
    const stream = await w.app(sam, 'stream');
    await w.say(sam, stream, { t: 'call_push', sub: { endpoint: NEW, keys: KEYS, was: OLD } });
    const kept = (w.lineOf(sam.uid).h.store.get('push') as { sub: { endpoint: string } }[]).map((r) => r.sub.endpoint);
    expect(kept).toEqual([FCM('laptop'), NEW]);
  });
});
