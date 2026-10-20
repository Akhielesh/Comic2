// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorRoom, type MonEnv } from './monitorRoom';

const NID = '11111111-2222-4333-8444-555555555555';

class FakeWS {
  sent: unknown[] = [];
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
    return this.sent.filter((m) => (m as { t: string }).t === t) as Record<string, unknown>[];
  }
}

function setup() {
  const store = new Map<string, unknown>([['nid', NID]]);
  const sockets: FakeWS[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string, v: unknown) => void store.set(k, structuredClone(v)),
      delete: async (k: string) => store.delete(k),
      getAlarm: async () => null,
      setAlarm: async () => undefined,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => sockets.push(ws),
  };
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_test',
    MONITOR_ROOM: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('no', { status: 500 }) }) },
  } as unknown as MonEnv;
  const room = new MonitorRoom(state as never, env);
  // Supabase: the bearer token decides who you are.
  const roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }> = {
    'tok-parent': { user_id: 'u-parent', role: 'parent', display_name: 'Alice', label: 'Mom' },
    'tok-care': { user_id: 'u-care', role: 'caregiver', display_name: 'Bob', label: 'Grandpa' },
    'tok-viewer': { user_id: 'u-view', role: 'viewer', display_name: 'Cara', label: null },
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const r = roles[token];
    return new Response(JSON.stringify(r ? { ok: true, ...r, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  });
  const join = async (token: string, mode: 'camera' | 'viewer', dev: string) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev === 'crib' ? 'Crib iPhone' : 'Laptop' }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  return { room, store, join, say };
}

afterEach(() => vi.unstubAllGlobals());

describe('MonitorRoom sound events', () => {
  it('logs a detected cry for everyone, with confidence, and ignores a flood', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 91 });
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 95 }); // within 20 s
    const logs = viewer.msgs('log').map((m) => m.entry as { kind: string; msg: string; conf?: number });
    const cries = logs.filter((e) => e.kind === 'cry');
    expect(cries).toHaveLength(1);
    expect(cries[0].msg).toBe('Aria is crying · Crib iPhone');
    expect(cries[0].conf).toBe(91);
  });

  it('records how long an episode lasted, and rejects unknown categories', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'event', kind: 'sound', cat: 'fuss', phase: 'end', secs: 130 });
    await say(cam, { t: 'event', kind: 'sound', cat: 'explosion', phase: 'start' });
    const logs = viewer.msgs('log').map((m) => m.entry as { kind: string; msg: string; secs?: number });
    expect(logs.map((e) => e.kind)).toEqual(['fuss_end']);
    expect(logs[0].msg).toBe('Aria settled after 2 min of fussing');
    expect(logs[0].secs).toBe(130);
  });

  it('only accepts sound events from cameras', async () => {
    const { join, say } = setup();
    await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(viewer, { t: 'event', kind: 'sound', cat: 'alarm', phase: 'start' });
    expect(viewer.msgs('log').filter((m) => (m.entry as { kind: string }).kind === 'alarm')).toHaveLength(0);
  });
});

describe('MonitorRoom status', () => {
  it('passes the rich status to viewers, sanitized', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, {
      t: 'status',
      st: { state: 'awake', level: 14, motion: 5, light: 120, cry: 3, sound: 'babble', conf: 77, top: [['babble', 77], ['nope', 50], ['laugh', 240]], model: 'ready', paused: 'privacy', talk: 'Grandpa', call: null },
    });
    const st = viewer.msgs('status')[0].st as Record<string, unknown>;
    expect(st.state).toBe('awake');
    expect(st.sound).toBe('babble');
    expect(st.top).toEqual([['babble', 77], ['laugh', 100]]);
    expect(st.model).toBe('ready');
    expect(st.paused).toBe('privacy');
    expect(st.talk).toBe('Grandpa');
  });
});

describe('MonitorRoom calls', () => {
  it('forwards a caregiver’s video call to the camera and logs it; viewers can’t call', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const bob = await join('tok-care', 'viewer', 'laptop');
    const cara = await join('tok-viewer', 'viewer', 'tablet');
    await say(bob, { t: 'cmd', to: 's-crib', c: 'video', v: { on: true } });
    await say(cara, { t: 'cmd', to: 's-crib', c: 'video', v: { on: true } });
    await new Promise((r) => setTimeout(r, 0));
    const cmds = cam.msgs('cmd');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ c: 'video', v: { on: true }, by: 'Grandpa' });
    const calls = bob.msgs('log').filter((m) => (m.entry as { kind: string }).kind === 'call');
    expect((calls[0].entry as { msg: string }).msg).toBe('Grandpa video-called Crib iPhone');
  });
});

describe('MonitorRoom push preferences', () => {
  it('stores per-category prefs, migrating the old "noise" switch to "loud"', async () => {
    const { join, say, store } = setup();
    const v = await join('tok-care', 'viewer', 'laptop');
    await say(v, {
      t: 'push_sub',
      sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } },
      prefs: { cry: true, noise: true, cough: false },
    });
    const prefs = (store.get('push') as { prefs: Record<string, boolean> }[])[0].prefs;
    expect(prefs).toMatchObject({ cry: true, loud: true, cough: false, alarm: true, offline: true, fuss: false });
    expect(v.msgs('push_ok')).toHaveLength(1);
  });
});
