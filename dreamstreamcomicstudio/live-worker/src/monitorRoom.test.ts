// @vitest-environment node
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const pushes: { endpoint: string; payload: Record<string, unknown> }[] = [];
vi.mock('./webpush', () => ({
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: async (sub: { endpoint: string }, payload: Record<string, unknown>) => {
    pushes.push({ endpoint: sub.endpoint, payload });
    return 'sent';
  },
}));

import { FrameBucket, MonitorRoom, relayCodecMask, sanitizeEnc, sanitizeZones, type MonEnv } from './monitorRoom';
import { audioOnly, bareJpeg, readHead, seqDiff } from './relayWire';
import { pack, unpack } from '../../live/monitor/relayWire';

const NID = '11111111-2222-4333-8444-555555555555';
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  pushes.length = 0;
});

/** Durable Object SQL API on top of sql.js. */
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
  sent: unknown[] = [];
  /** Binary frames received (relay pictures). */
  bin: ArrayBuffer[] = [];
  closed: number | null = null;
  private att: unknown = null;
  send(s: string | ArrayBuffer) {
    if (typeof s === 'string') this.sent.push(JSON.parse(s));
    else this.bin.push(s);
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
  logs() {
    return this.msgs('log').map((m) => m.entry as { id: string; kind: string; msg: string; sev: string; conf?: number; secs?: number; db?: number });
  }
}

function setup(preset: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>([['nid', NID], ...Object.entries(preset)]);
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
  const join = async (token: string, mode: 'camera' | 'viewer' | 'line', dev: string, extra: Record<string, unknown> = {}) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev === 'crib' ? 'Crib iPhone' : 'Laptop', ...extra }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const subscribe = (ws: FakeWS, endpoint: string, prefs: Record<string, boolean> = {}) =>
    say(ws, { t: 'push_sub', sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, prefs: { loud: false, ...prefs } });
  const close = (ws: FakeWS) => {
    sockets.splice(sockets.indexOf(ws), 1);
    return room.webSocketClose(ws as never);
  };
  return { room, store, join, say, subscribe, close, alarm: () => alarm };
}

const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const row = (m: number, over: Record<string, unknown> = {}) => ({ m, laeq: 32, lmax: 40, l10: 34, l50: 31, l90: 29, lpk: 50, cal: 1, motion: 2, mmax: 5, crib: 1, outside: 0, light: 20, state: 1, sounds: {}, visit: 0, ...over });

describe('MonitorRoom sound events', () => {
  it('logs a detected cry for everyone, with confidence, and ignores a flood', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 91 });
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 95 }); // within 20 s
    const cries = viewer.logs().filter((e) => e.kind === 'cry');
    expect(cries).toHaveLength(1);
    expect(cries[0].msg).toBe('Aria is crying · Crib iPhone');
    expect(cries[0].conf).toBe(91);
    expect(cries[0].sev).toBe('urgent');
  });

  it('records how long an episode lasted, and rejects unknown categories', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'event', kind: 'sound', cat: 'fuss', phase: 'end', secs: 130 });
    await say(cam, { t: 'event', kind: 'sound', cat: 'explosion', phase: 'start' });
    const logs = viewer.logs();
    expect(logs.map((e) => e.kind)).toEqual(['fuss_end']);
    expect(logs[0].msg).toBe('Aria settled after 2 min of fussing');
    expect(logs[0].secs).toBe(130);
  });

  it('only accepts sound events from cameras', async () => {
    const { join, say } = setup();
    await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(viewer, { t: 'event', kind: 'sound', cat: 'alarm', phase: 'start' });
    expect(viewer.logs().filter((e) => e.kind === 'alarm')).toHaveLength(0);
  });

  it('keeps the log in the database and moves the old log over once', async () => {
    const { join, room } = setup({ log: [{ id: 'old1', at: Date.now() - 1000, kind: 'feed', msg: 'Fed', by: 'Mom' }] });
    const viewer = await join('tok-care', 'viewer', 'laptop');
    const hello = viewer.msgs('hello')[0] as { log: { id: string; sev: string }[] };
    expect(hello.log.map((l) => l.id)).toContain('old1');
    expect(hello.log.find((l) => l.id === 'old1')?.sev).toBe('care');
    expect(room.store.events({ limit: 10 }).some((e) => e.id === 'old1')).toBe(true);
  });
});

describe('MonitorRoom status', () => {
  it('passes the rich status to viewers, sanitized', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, {
      t: 'status',
      st: {
        state: 'awake', level: 14, motion: 5, light: 120, cry: 3, sound: 'babble', conf: 77, top: [['babble', 77], ['nope', 50], ['laugh', 240]],
        model: 'ready', paused: 'privacy', talk: 'Grandpa', call: null, spl: { db: 41.26, leq: 40.4, max: 999, cal: 1 }, crib: 12, outside: null, visit: 1,
      },
    });
    const st = viewer.msgs('status')[0].st as Record<string, unknown>;
    expect(st.state).toBe('awake');
    expect(st.sound).toBe('babble');
    expect(st.top).toEqual([['babble', 77], ['laugh', 100]]);
    expect(st.model).toBe('ready');
    expect(st.paused).toBe('privacy');
    expect(st.talk).toBe('Grandpa');
    expect(st.spl).toEqual({ db: 41.3, leq: 40.4, max: 140, cal: true });
    expect(st.crib).toBe(12);
    expect(st.visit).toBe(true);
  });
});

describe('MonitorRoom relay (low-bandwidth picture)', () => {
  // A bare JPEG, as cameras before the framed format send (still relayed as-is).
  const frame = (n = 30_000) => {
    const u = new Uint8Array(n);
    u.set([0xff, 0xd8, 0xff]);
    return u.buffer;
  };
  const sendFrame = (room: MonitorRoom, cam: FakeWS, n?: number) => room.webSocketMessage(cam as never, frame(n));

  it('a camera that reconnects is told viewers are waiting on its relay', async () => {
    const { join, say, close } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-viewer', 'viewer', 'phone');
    await say(viewer, { t: 'relay', on: true, dev: 'crib' });
    expect(cam.msgs('relay_want').at(-1)).toMatchObject({ t: 'relay_want', n: 1 });
    await close(cam);
    const again = await join('tok-parent', 'camera', 'crib');
    expect(again.msgs('relay_want').at(-1)).toMatchObject({ t: 'relay_want', n: 1 });
  });

  it('forwards a jittery 4 fps stream in full (no hard minimum gap)', async () => {
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-viewer', 'viewer', 'phone');
    await say(viewer, { t: 'relay', on: true, dev: 'crib' });
    let t = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => t);
    const gaps = [240, 260, 120, 380, 250, 200, 300, 230, 270, 250, 90, 410, 250, 250, 240, 260];
    for (let i = 0; i < 40; i++) {
      t += gaps[i % gaps.length];
      await sendFrame(room, cam);
    }
    now.mockRestore();
    expect(viewer.bin).toHaveLength(40);
  });

  it('holds a flood to about 25 fps', async () => {
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-viewer', 'viewer', 'phone');
    await say(viewer, { t: 'relay', on: true, dev: 'crib' });
    let t = 2_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => t);
    for (let i = 0; i < 120; i++) {
      t += 16; // 60 fps for ~2 s
      await sendFrame(room, cam, 8_000);
    }
    now.mockRestore();
    expect(viewer.bin.length).toBeGreaterThanOrEqual(50);
    expect(viewer.bin.length).toBeLessThanOrEqual(25 * 2 + 8 + 1);
  });

  it('sends a camera’s frames only to viewers relaying that camera, and only from cameras', async () => {
    const { room, join, say } = setup();
    const crib = await join('tok-parent', 'camera', 'crib');
    const play = await join('tok-care', 'camera', 'play');
    const a = await join('tok-viewer', 'viewer', 'a');
    const b = await join('tok-viewer', 'viewer', 'b');
    const c = await join('tok-viewer', 'viewer', 'c');
    await say(a, { t: 'relay', on: true, dev: 'crib' });
    await say(b, { t: 'relay', on: true, dev: 'play' });
    await sendFrame(room, crib);
    await sendFrame(room, play);
    await sendFrame(room, a as never); // a viewer can't inject frames
    expect([a.bin.length, b.bin.length, c.bin.length]).toEqual([1, 1, 0]);
    // Switching camera moves the subscription (and tells both cameras).
    await say(a, { t: 'relay', on: true, dev: 'play' });
    expect(crib.msgs('relay_want').at(-1)).toMatchObject({ t: 'relay_want', n: 0 });
    expect(play.msgs('relay_want').at(-1)).toMatchObject({ t: 'relay_want', n: 2 });
    expect(new FrameBucket(0).take(2 * 1024 * 1024, 0)).toBe(false); // bigger than a second's budget
  });

  it('a socket that is still closing no longer counts (presence, relay viewers)', async () => {
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-viewer', 'viewer', 'phone');
    const other = await join('tok-care', 'viewer', 'laptop');
    await say(viewer, { t: 'relay', on: true, dev: 'crib' });
    expect(other.msgs('presence').at(-1)?.viewers).toEqual(expect.arrayContaining([expect.objectContaining({ dn: 'Laptop', relay: true })]));
    // The runtime still lists the socket while its close is handled.
    await room.webSocketClose(viewer as never);
    expect(viewer.closed).toBe(1000);
    expect(cam.msgs('relay_want').at(-1)).toMatchObject({ t: 'relay_want', n: 0 });
    expect((other.msgs('presence').at(-1)?.viewers as unknown[]).length).toBe(1);
    await room.webSocketClose(cam as never);
    expect(other.msgs('presence').at(-1)?.cams).toEqual([]);
  });

  it('passes the camera’s encoder telemetry to viewers, sanitized', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'status', st: { state: 'calm', enc: { peers: 3, fps: 14.6, lim: 'cpu', impl: 'MediaCodec<script>', w: 99999, p: 1, relay: 4.25, extra: 'x' } } });
    expect(viewer.msgs('status')[0].st).toMatchObject({ enc: { peers: 3, fps: 15, lim: 'cpu', impl: 'MediaCodecscript', w: 4096, p: 1, relay: 4.3 } });
    expect(sanitizeEnc({ lim: 'bogus' })).toEqual({ peers: 0, fps: null, lim: null, impl: null, w: null, p: 0, relay: 0 });
    expect(sanitizeEnc('nope')).toBeNull();
  });
});

describe('MonitorRoom relay video (WebCodecs, sound, windows)', () => {
  type Opt = { key?: boolean; audio?: number; codec?: 'avc' | 'vp8' | 'vp9'; size?: number };
  let seq = 0;
  const video = (o: Opt = {}) =>
    pack({ kind: 'video', key: !!o.key, seq: seq++, ts: seq * 66, codec: o.codec ?? 'vp8', body: new Uint8Array(o.size ?? 3000).fill(7), audio: o.audio ? new Uint8Array(o.audio).fill(0x7f) : null });
  const jpeg = () => pack({ kind: 'jpeg', seq: seq++, ts: seq * 66, body: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3) });
  const sound = (codec: 'vp8' | null = null) => pack({ kind: 'audio', seq: seq++, ts: seq * 66, codec, audio: new Uint8Array(800).fill(0x55) });
  const kinds = (ws: { bin: ArrayBuffer[] }) =>
    ws.bin.map((b) => {
      const u = unpack(b);
      return u ? `${u.kind}${u.key && u.kind === 'video' ? '*' : ''}${u.codec ? `:${u.codec}` : ''}${u.legacy ? ':bare' : ''}` : '?';
    });
  let t = 5_000_000;
  const clock = () => vi.spyOn(Date, 'now').mockImplementation(() => t);
  const tick = (ms = 66) => {
    t += ms;
  };

  it('routes by codec: video to those who decode it, JPEG to the rest (bare for older viewers)', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const both = await join('tok-viewer', 'viewer', 'a');
    const vp8 = await join('tok-viewer', 'viewer', 'b');
    const jpegOnly = await join('tok-viewer', 'viewer', 'c');
    const legacy = await join('tok-viewer', 'viewer', 'd');
    await say(both, { t: 'relay', on: true, dev: 'crib', codecs: ['avc', 'vp8'] });
    await say(vp8, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8', 'bogus'] });
    await say(jpegOnly, { t: 'relay', on: true, dev: 'crib', codecs: [] });
    await say(legacy, { t: 'relay', on: true, dev: 'crib' });
    expect(cam.msgs('relay_want').at(-1)).toEqual({ t: 'relay_want', n: 4, avc: 1, vp8: 2, vp9: 0, jpeg: 2 });
    const send = (b: ArrayBuffer) => {
      tick();
      return room.webSocketMessage(cam as never, b);
    };
    await send(video({ key: true }));
    await send(jpeg());
    await send(video());
    expect(kinds(both)).toEqual(['video*:vp8', 'video:vp8']);
    expect(kinds(vp8)).toEqual(['video*:vp8', 'video:vp8']);
    expect(kinds(jpegOnly)).toEqual(['jpeg']);
    expect(kinds(legacy)).toEqual(['jpeg:bare']);
    // The older viewer gets the image itself, not the header.
    expect([...new Uint8Array(legacy.bin[0]).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await send(video({ key: true, codec: 'avc' }));
    expect(kinds(both).at(-1)).toBe('video*:avc');
    expect(kinds(vp8).at(-1)).toBe('video:vp8'); // can't decode H.264: nothing new
    now.mockRestore();
  });

  it('asks the camera for a key frame when someone subscribes (once a second), and new viewers start on one', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const a = await join('tok-viewer', 'viewer', 'a');
    const b = await join('tok-viewer', 'viewer', 'b');
    await say(a, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    expect(cam.msgs('relay_key')).toHaveLength(1);
    tick(200);
    await say(b, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    expect(cam.msgs('relay_key')).toHaveLength(1); // inside the second: held…
    tick(900);
    await room.webSocketMessage(cam as never, video({ audio: 400 }));
    expect(cam.msgs('relay_key')).toHaveLength(2); // …and sent with the camera's next message
    // A delta before any key frame: no picture yet, but its sound goes through.
    expect(kinds(a)).toEqual(['audio:vp8']);
    tick();
    await room.webSocketMessage(cam as never, video({ key: true }));
    tick();
    await room.webSocketMessage(cam as never, video());
    expect(kinds(a)).toEqual(['audio:vp8', 'video*:vp8', 'video:vp8']);
    now.mockRestore();
  });

  it('a viewer that stops acknowledging skips to the next key frame, keeps its sound, and asks for a key', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const slow = await join('tok-viewer', 'viewer', 'slow');
    const fast = await join('tok-viewer', 'viewer', 'fast');
    await say(slow, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    await say(fast, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    const keys0 = cam.msgs('relay_key').length;
    const send = async (o: Opt) => {
      tick(70);
      const b = video(o);
      await room.webSocketMessage(cam as never, b);
      // The fast viewer acknowledges everything; the slow one never does.
      await say(fast, { t: 'rx', s: unpack(b)!.seq });
    };
    await send({ key: true, audio: 300 });
    for (let i = 0; i < 40; i++) await send({ audio: 300 });
    const slowKinds = kinds(slow);
    const pics = slowKinds.filter((k) => k.startsWith('video')).length;
    expect(pics).toBe(31); // the key frame + 30 in flight, then it waits…
    expect(slowKinds.slice(pics).length).toBeGreaterThan(5);
    expect(slowKinds.slice(pics).every((k) => k === 'audio:vp8')).toBe(true); // …and still hears the nursery
    expect(kinds(fast).filter((k) => k.startsWith('video'))).toHaveLength(41);
    expect(cam.msgs('relay_key').length).toBeGreaterThan(keys0);
    // It catches up (acknowledges what it got): the next key frame resumes the picture.
    await say(slow, { t: 'rx', s: unpack(slow.bin.at(-1)!)!.seq });
    await send({});
    expect(kinds(slow).at(-1)).toBe('audio:vp8'); // a delta: still waiting
    await send({ key: true });
    await send({});
    expect(kinds(slow).slice(-2)).toEqual(['video*:vp8', 'video:vp8']);
    now.mockRestore();
  });

  it('a viewer whose decoder failed asks for a key frame (k), and waits for it', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    tick();
    await room.webSocketMessage(cam as never, video({ key: true }));
    const keys = cam.msgs('relay_key').length;
    tick(1500);
    await say(v, { t: 'rx', s: unpack(v.bin[0])!.seq, k: 1 });
    // Within 2 s of its subscription's key frame: the camera's next regular one will do.
    expect(cam.msgs('relay_key')).toHaveLength(keys);
    tick(600);
    await say(v, { t: 'rx', s: unpack(v.bin[0])!.seq, k: 1 });
    expect(cam.msgs('relay_key')).toHaveLength(keys + 1);
    tick();
    await room.webSocketMessage(cam as never, video());
    expect(kinds(v)).toEqual(['video*:vp8']);
    now.mockRestore();
  });

  it('a privacy pause stops every relay message — video, JPEG and sound — until it ends', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    const j = await join('tok-viewer', 'viewer', 'j');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    await say(j, { t: 'relay', on: true, dev: 'crib', codecs: [] });
    await say(cam, { t: 'event', kind: 'privacy', on: true });
    for (const b of [video({ key: true, audio: 200 }), jpeg(), sound('vp8')]) {
      tick();
      await room.webSocketMessage(cam as never, b);
    }
    expect([v.bin.length, j.bin.length]).toEqual([0, 0]);
    // The camera's status says so too (e.g. after the room restarted).
    await say(cam, { t: 'event', kind: 'privacy', on: false });
    tick(2000);
    await say(cam, { t: 'status', st: { state: 'calm', paused: 'privacy' } });
    tick();
    await room.webSocketMessage(cam as never, video({ key: true }));
    expect(v.bin.length).toBe(0);
    tick(2000);
    await say(cam, { t: 'status', st: { state: 'calm', paused: null } });
    tick();
    await room.webSocketMessage(cam as never, video({ key: true }));
    tick();
    await room.webSocketMessage(cam as never, jpeg());
    expect(kinds(v)).toEqual(['video*:vp8']);
    expect(kinds(j)).toEqual(['jpeg']);
    now.mockRestore();
  });

  it('accepts relay messages only from cameras, within the size caps, with a valid header', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    const send = (ws: unknown, b: ArrayBuffer) => {
      tick(200);
      return room.webSocketMessage(ws as never, b);
    };
    await send(v, video({ key: true })); // a viewer can't inject a picture
    await send(cam, video({ key: true, size: 129 * 1024 })); // over 128 KB of video
    await send(cam, Uint8Array.of(9, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3).buffer); // unknown kind
    await send(cam, Uint8Array.of(2, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 3).buffer); // video without a codec
    await send(cam, new ArrayBuffer(5)); // shorter than a header
    expect(v.bin).toHaveLength(0);
    await send(cam, video({ key: true, size: 100 * 1024 }));
    expect(kinds(v)).toEqual(['video*:vp8']);
    now.mockRestore();
  });

  it('a frame the token bucket drops makes every viewer resync on the next key frame', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    tick(1000);
    await room.webSocketMessage(cam as never, video({ key: true }));
    // A burst far above 25 a second: the bucket runs dry.
    for (let i = 0; i < 20; i++) {
      tick(1);
      const b = video();
      await room.webSocketMessage(cam as never, b);
      await say(v, { t: 'rx', s: unpack(b)!.seq });
    }
    const got = kinds(v).length;
    expect(got).toBeLessThan(21);
    tick(500);
    await room.webSocketMessage(cam as never, video());
    expect(kinds(v)).toHaveLength(got); // a delta after the gap is held back…
    tick(100);
    await room.webSocketMessage(cam as never, video({ key: true }));
    expect(kinds(v).at(-1)).toBe('video*:vp8'); // …until the key frame
    now.mockRestore();
  });

  it('a JPEG-only camera’s sound reaches every viewer; a video camera’s only those on its video', async () => {
    const now = clock();
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    const j = await join('tok-viewer', 'viewer', 'j');
    const legacy = await join('tok-viewer', 'viewer', 'l');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    await say(j, { t: 'relay', on: true, dev: 'crib', codecs: [] });
    await say(legacy, { t: 'relay', on: true, dev: 'crib' });
    tick();
    await room.webSocketMessage(cam as never, jpeg());
    tick();
    await room.webSocketMessage(cam as never, sound());
    expect(kinds(v)).toEqual(['jpeg', 'audio']);
    expect(kinds(j)).toEqual(['jpeg', 'audio']);
    expect(kinds(legacy)).toEqual(['jpeg:bare']); // older viewers can't play it
    tick();
    await room.webSocketMessage(cam as never, video({ key: true }));
    tick();
    await room.webSocketMessage(cam as never, sound('vp8'));
    expect(kinds(v).slice(-2)).toEqual(['video*:vp8', 'audio:vp8']);
    expect(kinds(j)).toEqual(['jpeg', 'audio']);
    now.mockRestore();
  });

  it('viewers only waiting for their direct picture are not listed as on the relay', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'], instant: true });
    expect(cam.msgs('presence').at(-1)?.viewers).toEqual([expect.objectContaining({ relay: false })]);
    expect(cam.msgs('relay_want').at(-1)).toMatchObject({ n: 1, vp8: 1 });
    // Direct failed: the same subscription, now for real.
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    expect(cam.msgs('presence').at(-1)?.viewers).toEqual([expect.objectContaining({ relay: true })]);
  });

  it('reads the header exactly as the app writes it (one wire format, two copies)', () => {
    const b = pack({ kind: 'video', key: true, seq: 0xfffffffe, ts: 99, codec: 'avc', body: Uint8Array.of(1, 2, 3), audio: Uint8Array.of(4, 5) });
    expect(readHead(b)).toEqual({ kind: 3, key: true, seq: 0xfffffffe, codec: 1, legacy: false });
    const snd = unpack(audioOnly(b)!)!;
    expect(snd).toMatchObject({ kind: 'audio', key: false, seq: 0xfffffffe, ts: 99, codec: 'avc' });
    expect([...snd.audio!]).toEqual([4, 5]);
    expect(audioOnly(pack({ kind: 'video', seq: 1, ts: 1, codec: 'vp8', body: Uint8Array.of(1) }))).toBeNull();
    expect(readHead(pack({ kind: 'jpeg', seq: 3, ts: 1, body: Uint8Array.of(1) }))).toMatchObject({ kind: 1, key: true });
    expect(readHead(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb).buffer)).toMatchObject({ kind: 1, legacy: true });
    expect(new Uint8Array(bareJpeg(pack({ kind: 'jpeg', seq: 3, ts: 1, body: Uint8Array.of(0xff, 0xd8) })))).toEqual(Uint8Array.of(0xff, 0xd8));
    expect(seqDiff(2, 0xffffffff)).toBe(3);
    expect(relayCodecMask(['vp9', 'avc', 'nope'])).toBe(5);
  });
});

/**
 * A relay viewer stalls — a mobile-network blip, an app switch, a main-thread
 * pause — while its socket stays open, then gets everything held meanwhile in
 * one burst. Deterministic, against the real room: a camera at 15 fps (a key
 * frame every 2 s and whenever the room asks), `owd` ms each way, both
 * directions held during the stall. The viewer acknowledges like
 * RelayDecoder: at most every 500 ms, on a message ('old' viewers — what's
 * deployed — only then; 'new' ones also acknowledge the last message of a
 * burst, ≤ 500 ms later). Before the fix the window froze for good after a
 * 5–9 s stall: nothing more ever reached the viewer, and the camera was asked
 * for a key frame every second for as long as it stayed.
 */
describe('MonitorRoom relay: a viewer that stalls never freezes for good', () => {
  // A failed expectation must not leave Date.now frozen for the tests after it.
  afterEach(() => vi.restoreAllMocks());
  type Kind = 'sound' | 'video' | 'jpeg';
  const STALL_AT = 4000;
  const AFTER = 9000;

  async function stall(o: { kind: Kind; stallMs: number; owd: number; client: 'old' | 'new' }) {
    const t0 = 9_000_000;
    let t = t0;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    try {
      const { room, join, say } = setup();
      const cam = await join('tok-parent', 'camera', 'crib');
      const v = await join('tok-viewer', 'viewer', 'v');
      // kind 3 (video + sound), kind 2 (video, no sound) — or a JPEG-only viewer of a video camera.
      await say(v, { t: 'relay', on: true, dev: 'crib', codecs: o.kind === 'jpeg' ? [] : ['vp8'] });
      const from = t0 + STALL_AT;
      const to = from + o.stallMs;
      const end = to + AFTER;
      const hold = (at: number) => (at >= from && at < to ? to : at);
      const down: { sent: number; at: number; buf: ArrayBuffer }[] = [];
      const up: { at: number; msg: Record<string, unknown> }[] = [];
      const got: { at: number; sent: number; kind: string }[] = [];
      let seen = 0;
      let arrived = 0;
      // The viewer's acknowledgements.
      let last: number | null = null;
      let acked: number | null = null;
      let ackAt = -Infinity;
      const ack = () => {
        up.push({ at: hold(t + o.owd), msg: { t: 'rx', s: last } });
        ackAt = t;
        acked = last;
      };
      // The camera.
      let seq = 0;
      let keyAt = -Infinity;
      let asked = cam.msgs('relay_key').length;
      let nextFrame = t0;
      let nextJpeg = t0;
      let keysAfter = 0;
      for (; t <= end; t += 5) {
        if (t >= nextFrame) {
          nextFrame += 66;
          const n = cam.msgs('relay_key').length;
          if (t >= to) keysAfter += n - asked;
          const key = n > asked || t - keyAt >= 2000;
          asked = n;
          if (key) keyAt = t;
          const audio = o.kind === 'sound' ? new Uint8Array(500).fill(0x55) : null;
          await room.webSocketMessage(cam as never, pack({ kind: 'video', key, seq: seq++, ts: t - t0, codec: 'vp8', body: new Uint8Array(key ? 6000 : 1500).fill(1), audio }));
        }
        if (o.kind === 'jpeg' && t >= nextJpeg) {
          nextJpeg += 250; // 4 a second, alongside the video
          await room.webSocketMessage(cam as never, pack({ kind: 'jpeg', seq: seq++, ts: t - t0, body: Uint8Array.of(0xff, 0xd8, 0xff, 1, 2, 3) }));
        }
        for (; seen < v.bin.length; seen++) down.push({ sent: t, at: Math.max(hold(t + o.owd), down.at(-1)?.at ?? 0), buf: v.bin[seen] });
        while (arrived < down.length && down[arrived].at <= t) {
          const m = down[arrived++];
          const u = unpack(m.buf)!;
          got.push({ at: t, sent: m.sent, kind: u.kind });
          last = u.seq;
          if (t - ackAt >= 500) ack();
        }
        // The trailing acknowledgement (new viewers): the last message of a burst too.
        if (o.client === 'new' && last != null && last !== acked && t - ackAt >= 500) ack();
        while (up.length && up[0].at <= t) await say(v, up.shift()!.msg);
      }
      const pics = got.filter((g) => g.kind === (o.kind === 'jpeg' ? 'jpeg' : 'video') && g.sent >= to);
      // Sound comes on its own while the picture waits, or inside the video messages.
      const sound = got.filter((g) => (g.kind === 'audio' || (o.kind === 'sound' && g.kind === 'video')) && g.sent >= to);
      // Pictures per second over the last six seconds, one count per second.
      const perSecond = Array.from({ length: 6 }, (_, i) => pics.filter((g) => g.at >= end - 6000 + i * 1000 && g.at < end - 5000 + i * 1000).length);
      return { firstPicture: pics.length ? pics[0].at - to : Infinity, firstSound: sound.length ? sound[0].at - to : Infinity, perSecond, keysAfter };
    } finally {
      spy.mockRestore();
    }
  }

  for (const kind of ['sound', 'video', 'jpeg'] as const) {
    it(`${kind === 'sound' ? 'video + sound' : kind === 'video' ? 'video without sound' : 'JPEG-only viewer'}: after a 5–9 s stall the picture is back within ~2 s, and stays`, async () => {
      for (const stallMs of [5000, 7000, 9000]) {
        for (const owd of [40, 100, 200]) {
          for (const client of ['old', 'new'] as const) {
            const r = await stall({ kind, stallMs, owd, client });
            const at = `${client} viewer, ${stallMs} ms stall, ${owd} ms each way: ${JSON.stringify(r)}`;
            expect(r.firstPicture, at).toBeLessThanOrEqual(2000);
            if (kind === 'sound') expect(r.firstSound, at).toBeLessThanOrEqual(1600);
            // Flowing again, not one lucky frame: every second, at the full rate.
            expect(Math.min(...r.perSecond), at).toBeGreaterThanOrEqual(kind === 'jpeg' ? 3 : 12);
            // And it doesn't drive the camera to a key frame every second.
            expect(r.keysAfter, at).toBeLessThanOrEqual(2);
          }
        }
      }
    });
  }

  it('a stall the viewer never comes back from costs one small message a second, then one every 5 s — and no key frames', async () => {
    let t = 9_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    let seq = 0;
    const sizes: { at: number; bytes: number }[] = [];
    let seen = 0;
    const start = t;
    let keys0 = 0;
    for (let i = 0; i < 30 * 15; i++, t += 66) {
      if (i === 15) keys0 = cam.msgs('relay_key').length;
      await room.webSocketMessage(cam as never, pack({ kind: 'video', key: i % 30 === 0, seq: seq++, ts: i * 66, codec: 'vp8', body: new Uint8Array(1500).fill(1), audio: new Uint8Array(400).fill(0x55) }));
      for (; seen < v.bin.length; seen++) sizes.push({ at: t - start, bytes: v.bin[seen].byteLength });
    }
    spy.mockRestore();
    // The window (a key frame and 30 more), then sound up to 60 — then probes only.
    const later = sizes.filter((s) => s.at > 6000);
    const mid = later.filter((s) => s.at <= 13_000);
    const late = later.filter((s) => s.at > 15_000);
    // About one a second while it might be back (each one a chance to answer)…
    expect(mid.length).toBeGreaterThanOrEqual(3);
    expect(mid.length).toBeLessThanOrEqual(8);
    // …then one every 5 s.
    expect(late.length).toBeGreaterThanOrEqual(2);
    expect(late.length).toBeLessThanOrEqual(4);
    expect(later.every((s) => s.bytes < 1000)).toBe(true); // sound only, never a whole frame
    expect(cam.msgs('relay_key').length - keys0).toBeLessThanOrEqual(1);
  });

  it('re-sending the same subscription starts its window over (a stuck viewer is unstuck by asking again)', async () => {
    let t = 9_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    const sub = { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] };
    await say(v, sub);
    let seq = 0;
    const send = async (key = false) => {
      t += 66;
      await room.webSocketMessage(cam as never, pack({ kind: 'video', key, seq: seq++, ts: t, codec: 'vp8', body: new Uint8Array(800).fill(1) }));
    };
    await send(true);
    for (let i = 0; i < 40; i++) await send(); // never acknowledged: it waits
    const n = v.bin.length;
    await send(true);
    expect(v.bin.length).toBe(n); // too far behind for this key frame
    await say(v, sub);
    await send(true);
    await send();
    expect(v.bin.length).toBe(n + 2);
    expect(unpack(v.bin.at(-2)!)).toMatchObject({ kind: 'video', key: true });
    spy.mockRestore();
  });

  it('a viewer that keeps asking can’t drive the camera to a key frame every second', async () => {
    let t = 9_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const v = await join('tok-viewer', 'viewer', 'v');
    await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    const k0 = cam.msgs('relay_key').length;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      await say(v, { t: 'rx', s: i, k: 1 });
      await say(v, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    }
    expect(cam.msgs('relay_key').length - k0).toBeLessThanOrEqual(10); // one per 2 s at most
    spy.mockRestore();
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
    const calls = bob.logs().filter((e) => e.kind === 'call');
    expect(calls[0].msg).toBe('Grandpa video-called Crib iPhone');
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
    expect(prefs).toMatchObject({ cry: true, loud: true, cough: false, alarm: true, offline: true, fuss: false, noise: true, report: true });
    expect(v.msgs('push_ok')).toHaveLength(1);
  });

  it('never lets smoke/CO alarms be switched off', async () => {
    const { join, subscribe, store } = setup();
    const v = await join('tok-care', 'viewer', 'laptop');
    await subscribe(v, 'https://push.test/1', { alarm: false });
    expect((store.get('push') as { prefs: Record<string, boolean> }[])[0].prefs.alarm).toBe(true);
  });
});

describe('MonitorRoom incidents', () => {
  it('repeats a smoke-alarm alert until someone answers, then records who and how fast', async () => {
    const { join, say, subscribe, room } = setup();
    const cam = await join('tok-parent', 'camera', 'crib', { tz: 'America/New_York' });
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    await subscribe(mom, 'https://push.test/mom');
    await subscribe(bob, 'https://push.test/bob');
    await say(cam, { t: 'event', kind: 'sound', cat: 'alarm', phase: 'start', conf: 88, pattern: 'T3' });
    const inc = bob.msgs('incident')[0].inc as { id: string; status: string; next_at: number };
    expect(inc.status).toBe('open');
    expect(bob.logs().find((l) => l.kind === 'alarm')?.msg).toContain('smoke-alarm beep pattern');
    expect(pushes.map((p) => p.endpoint).sort()).toEqual(['https://push.test/bob', 'https://push.test/mom']);

    // Nobody answered within a minute: everyone is alerted again.
    pushes.length = 0;
    room.store.updateIncident(inc.id, { next_at: Date.now() - 1 });
    await room.alarm();
    expect(pushes).toHaveLength(2);
    expect(String(pushes[0].payload.title)).toMatch(/still sounding/);
    expect(bob.logs().some((l) => l.kind === 'escalated')).toBe(true);

    // Grandpa answers: it stops repeating and the log says how fast.
    await say(bob, { t: 'ack', inc: inc.id });
    const acked = room.store.incident(inc.id)!;
    expect(acked.status).toBe('acked');
    expect(acked.ack_by).toBe('Grandpa');
    expect(acked.next_at).toBeNull();
    expect(mom.logs().find((l) => l.kind === 'ack')?.msg).toMatch(/^Grandpa is checking on it — responded in \d+s$/);
  });

  it('escalates a long cry to everyone and resolves it when the baby settles', async () => {
    const { join, say, subscribe, room } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    await subscribe(mom, 'https://push.test/mom');
    await subscribe(bob, 'https://push.test/bob');
    // Grandpa is on duty tonight: the first cry alert goes to him only.
    await say(bob, { t: 'duty', on: true, hours: 10 });
    expect(mom.msgs('duty')[0].duty).toMatchObject({ uid: 'u-care', name: 'Grandpa' });
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
    expect(pushes.map((p) => p.endpoint)).toEqual(['https://push.test/bob']);
    const inc = room.store.activeIncidents()[0];
    expect(inc.kind).toBe('cry');
    expect(inc.next_at! - inc.at).toBe(5 * 60_000);

    pushes.length = 0;
    room.store.updateIncident(inc.id, { next_at: Date.now() - 1 });
    await room.alarm();
    expect(pushes.map((p) => p.endpoint).sort()).toEqual(['https://push.test/bob', 'https://push.test/mom']);
    expect(String(pushes[0].payload.title)).toMatch(/^Aria has been crying for \d+ min — no one has responded$/);

    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'end', secs: 420 });
    expect(room.store.incident(inc.id)?.status).toBe('resolved');
    expect(mom.logs().find((l) => l.kind === 'cry_end')?.msg).toBe('Aria settled after 7 min of crying');
  });

  it('turns a danger-zone movement into an urgent incident using the zone’s name', async () => {
    const { join, say, room } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'settings', zones: { dev: 'crib', list: [{ id: 'win', kind: 'danger', name: 'the window', x: 0.8, y: 0, w: 0.2, h: 0.4 }] } });
    await say(cam, { t: 'event', kind: 'vision', type: 'zone', zone: 'win' });
    expect(mom.logs().find((l) => l.kind === 'zone')).toMatchObject({ msg: 'Movement in the window · Crib iPhone', sev: 'urgent' });
    expect(room.store.activeIncidents()[0]).toMatchObject({ kind: 'zone', status: 'open' });
  });
});

describe('MonitorRoom zones', () => {
  it('keeps zones inside the picture, one crib per camera', () => {
    const z = sanitizeZones([
      { id: 'c1', kind: 'crib', name: 'Crib', x: 0.2, y: 0.2, w: 0.9, h: 0.5 },
      { id: 'c2', kind: 'crib', name: 'Second crib', x: 0, y: 0, w: 0.3, h: 0.3 },
      { id: 'd!@1', kind: 'danger', name: '', x: -1, y: 0.5, w: 0.3, h: 0.01 },
      { id: 'd2', kind: 'danger', name: 'Stairs', x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
      { id: 'x', kind: 'weird', x: 0, y: 0, w: 1, h: 1 },
    ]);
    expect(z.map((x) => x.id)).toEqual(['c1', 'd2']);
    expect(z[0].w).toBeCloseTo(0.8);
  });
});

describe('MonitorRoom history and sleep', () => {
  it('stores the camera’s minutes and serves them as chart buckets', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const viewer = await join('tok-care', 'viewer', 'laptop');
    const m0 = minuteNow() - 30 * 60_000;
    await say(cam, { t: 'stats', rows: [row(m0, { laeq: 30 }), row(m0 + 60_000, { laeq: 60, lmax: 72, sounds: { cry: 30, bogus: 9 } })] });
    expect(cam.msgs('stats_ok')[0].upto).toBe(m0 + 60_000);
    await say(viewer, { t: 'q', id: 'h1', q: 'history', from: m0 - 60_000, to: m0 + 2 * 60_000 });
    const r = viewer.msgs('r').find((x) => x.id === 'h1') as { res: number; pts: { t: number; laeq: number; lmax: number; sounds: Record<string, number> }[] };
    expect(r.res).toBe(60_000);
    expect(r.pts.map((p) => p.laeq)).toEqual([30, 60]);
    expect(r.pts[1].sounds).toEqual({ cry: 30 });
  });

  it('tracks a nap from the camera’s minutes and files a report', async () => {
    const { join, say, room } = setup();
    const cam = await join('tok-parent', 'camera', 'crib', { tz: 'UTC' });
    const mom = await join('tok-parent', 'viewer', 'phone');
    const m0 = minuteNow() - 90 * 60_000;
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => row(m0 + i * 60_000)),
      ...Array.from({ length: 35 }, (_, i) => row(m0 + (40 + i) * 60_000, { state: 2, motion: 40, crib: 40, sounds: { babble: 20 } })),
    ];
    await say(cam, { t: 'stats', rows });
    const kinds = mom.logs().map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(['asleep', 'woke', 'sleep_report']));
    const report = mom.logs().find((l) => l.kind === 'sleep_report')!;
    expect(report.msg).toMatch(/report: Aria slept 40 min straight through$/);
    const sessions = room.store.sleepBetween(m0 - 1, minuteNow() + 1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ asleep_min: 40, wakings: 0, longest_min: 40, onset: m0 });
    await say(mom, { t: 'q', id: 's1', q: 'sleep', days: 2 });
    expect((mom.msgs('r').find((x) => x.id === 's1') as { sessions: unknown[] }).sessions).toHaveLength(1);
    await say(mom, { t: 'q', id: 'rep', q: 'report', session: sessions[0].id });
    const rep = (mom.msgs('r').find((x) => x.id === 'rep') as { report: { asleep_min: number; pts: unknown[] } }).report;
    expect(rep.asleep_min).toBe(40);
    expect(rep.pts.length).toBeGreaterThan(5);
  });

  it('warns once when a steady sound machine runs above 50 dB for an hour', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    const m0 = minuteNow() - 61 * 60_000;
    const rows = Array.from({ length: 61 }, (_, i) => row(m0 + i * 60_000, { laeq: 56, l10: 57, l90: 54 }));
    await say(cam, { t: 'stats', rows: rows.slice(0, 40) });
    await say(cam, { t: 'stats', rows: rows.slice(40) });
    const warn = mom.logs().filter((l) => l.kind === 'machine');
    expect(warn).toHaveLength(1);
    expect(warn[0].msg).toMatch(/^Sound machine may be too loud \(56 dB for the last hour\)/);
    expect(warn[0].sev).toBe('warn');
  });

  it('a parent’s "Down for sleep" and "Woke up" taps drive the sleep tracker', async () => {
    const { join, say, room } = setup();
    await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'log', kind: 'sleep' });
    expect((mom.msgs('sleep').pop()!.sleep as { phase: string }).phase).toBe('settling');
    await say(mom, { t: 'log', kind: 'wake' });
    expect((mom.msgs('sleep').pop()!.sleep as { phase: string }).phase).toBe('idle');
    // Too short to be real sleep: kept out of the history.
    expect(room.store.lastSleep(5)[0]?.summary).toMatchObject({ discarded: true });
  });
});

describe('MonitorRoom export', () => {
  it('lets parents and caregivers download CSV, not viewers', async () => {
    const { join, say, room } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    await say(cam, { t: 'event', kind: 'sound', cat: 'cough', phase: 'start', conf: 70 });
    // A display name is user-controlled: a spreadsheet formula must not survive export.
    room.store.addEvent({ id: 'f1', at: Date.now() - 5, kind: 'note', sev: 'care', msg: 'Note', by: '=HYPERLINK("http://evil")' });
    const get = (tok: string) => room.fetch(new Request('https://monitor.internal/export?what=events', { headers: { authorization: `Bearer ${tok}` } }));
    const ok = await get('tok-care');
    expect(ok.headers.get('content-type')).toMatch(/text\/csv/);
    expect(ok.headers.get('content-disposition')).toMatch(/^attachment; filename="nursery-events-\d{4}-\d{2}-\d{2}\.csv"$/);
    const csv = await ok.text();
    expect(csv).toContain('"Aria is coughing · Crib iPhone"');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toContain(`"=HYPERLINK`);
    expect((await get('tok-viewer')).status).toBe(403);
    expect((await room.fetch(new Request('https://monitor.internal/export'))).status).toBe(401);
  });
});

describe('MonitorRoom guests (share link + passcode)', () => {
  const joinHttp = (room: MonitorRoom, body: Record<string, unknown>, ip = '9.9.9.9') =>
    room.fetch(new Request(`https://monitor.internal/guest?nid=${NID}`, { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': ip } }));

  it('only parents can make a link; weak passcodes are refused; parents see the link', async () => {
    const { join, say } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    expect(mom.msgs('share')[0].share).toMatchObject({ on: false });
    expect(bob.msgs('share')).toHaveLength(0);
    await say(bob, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    await say(mom, { t: 'share_set', pass: 'aria2024', role: 'viewer' });
    expect(mom.msgs('share_err')[0].msg).toMatch(/baby/);
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'caregiver', days: 7 });
    const info = mom.msgs('share').at(-1)!.share as { on: boolean; code: string; role: string; expires_at: number };
    expect(info).toMatchObject({ on: true, role: 'caregiver' });
    expect(info.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(info.expires_at).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
    expect(bob.msgs('share')).toHaveLength(0);
    expect(JSON.stringify(mom.sent)).not.toContain('blue-otter-42');
  });

  it('a guest joins with the link + passcode, watches with their role, and parents are told', async () => {
    const { room, join, say, subscribe } = setup();
    const guestSocket = (token: string, mode: 'camera' | 'viewer' = 'viewer', dev = 'gran-ipad') => join('', mode, dev, { guest: token });
    const mom = await join('tok-parent', 'viewer', 'phone');
    await subscribe(mom, 'https://push.test/mom');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;

    const wrong = await joinHttp(room, { code, pass: 'nope-nope-1', name: 'Jo' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ ok: false, reason: 'wrong', left: 4 });
    const badLink = await joinHttp(room, { code: 'x'.repeat(22), pass: 'blue-otter-42', name: 'Jo' });
    expect(badLink.status).toBe(404);
    expect(await badLink.text()).not.toContain('Aria');

    const ok = await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Grandma Jo', dev: 'gran-ipad' });
    const body = (await ok.json()) as { ok: boolean; token: string; guest: { name: string; role: string }; nursery: { baby: string } };
    expect(body).toMatchObject({ ok: true, guest: { name: 'Grandma Jo', role: 'viewer' }, nursery: { baby: 'Aria' } });
    expect(pushes.some((p) => p.endpoint === 'https://push.test/mom' && String(p.payload.title).includes('Grandma Jo'))).toBe(true);
    expect((mom.msgs('share').at(-1)!.share as { guests: { name: string }[] }).guests.map((g) => g.name)).toEqual(['Grandma Jo']);

    const g = await guestSocket(body.token);
    const hello = g.msgs('hello')[0] as { you: { role: string; guest: boolean; name: string } };
    expect(hello.you).toMatchObject({ role: 'viewer', guest: true, name: 'Grandma Jo' });
    expect(g.msgs('share')).toHaveLength(0);
    // Viewers can't run commands, and guests can't manage sharing.
    await say(g, { t: 'share_off' });
    expect((mom.msgs('share').at(-1)!.share as { on: boolean }).on).toBe(true);
    // Guests can't be a camera.
    const cam = await guestSocket(body.token, 'camera', 'gran-cam');
    expect(cam.closed).toBe(4004);
  });

  it('member re-checks never kick guests; removing a guest or turning the link off does', async () => {
    const { room, join, say } = setup();
    const guestSocket = (token: string, mode: 'camera' | 'viewer' = 'viewer', dev = 'gran-ipad') => join('', mode, dev, { guest: token });
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    const a = (await (await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Jo' })).json()) as { token: string };
    const b = (await (await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Sam' })).json()) as { token: string };
    const jo = await guestSocket(a.token, 'viewer', 'jo');
    const sam = await guestSocket(b.token, 'viewer', 'sam');

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, ids: ['u-parent'] }), { status: 200 }));
    await say(mom, { t: 'members_changed', token: 'tok-parent' });
    expect(jo.closed).toBeNull();

    const joId = (mom.msgs('share').at(-1)!.share as { guests: { id: string; name: string }[] }).guests.find((x) => x.name === 'Jo')!.id;
    await say(mom, { t: 'guest_remove', id: joId });
    expect(jo.closed).toBe(4004);
    expect(sam.closed).toBeNull();
    expect((await guestSocket(a.token, 'viewer', 'jo2')).closed).toBe(4004);

    await say(mom, { t: 'share_off' });
    expect(sam.closed).toBe(4004);
    const late = await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Late' });
    expect(late.status).toBe(410);
  });

  it('locks after 5 wrong passcodes and tells the parents', async () => {
    const { room, join, say, subscribe } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    await subscribe(mom, 'https://push.test/mom');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) last = await joinHttp(room, { code, pass: `guess-${i}-zz`, name: 'X' }, `10.0.0.${i}`);
    expect(last!.status).toBe(429);
    expect(mom.logs().some((e) => /locked for 15 minutes/.test(e.msg))).toBe(true);
    expect(pushes.some((p) => /Wrong passcodes/.test(String(p.payload.title)))).toBe(true);
    const right = await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Jo' }, '10.0.1.1');
    expect(right.status).toBe(429);
  });

  it('only parents set a new passcode or extend the link; the link and its guests stay', async () => {
    const { room, join, say } = setup();
    const guestSocket = (token: string) => join('', 'viewer', 'gran-ipad', { guest: token });
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer', days: 1 });
    const first = mom.msgs('share').at(-1)!.share as { code: string; pass_at: number; expires_at: number; max_guests: number };
    expect(first.max_guests).toBe(10);
    const jo = (await (await joinHttp(room, { code: first.code, pass: 'blue-otter-42', name: 'Jo' })).json()) as { token: string };
    const g = await guestSocket(jo.token);

    // Not from a caregiver, not from a guest.
    const before = mom.msgs('share').length;
    await say(bob, { t: 'share_pass', pass: 'cedar-heron-otter-17' });
    await say(bob, { t: 'share_extend', days: 30 });
    await say(g, { t: 'share_pass', pass: 'cedar-heron-otter-17' });
    await say(g, { t: 'share_extend', days: 30 });
    expect(mom.msgs('share')).toHaveLength(before);

    // A weak one is refused with the reason.
    await say(mom, { t: 'share_pass', pass: 'aria2024' });
    expect(mom.msgs('share_err').at(-1)!.msg).toMatch(/baby/);

    await new Promise((r) => setTimeout(r, 2));
    await say(mom, { t: 'share_pass', pass: 'cedar-heron-otter-17' });
    const after = mom.msgs('share').at(-1)!.share as { code: string; pass_at: number; guests: unknown[] };
    expect(after.code).toBe(first.code);
    expect(after.pass_at).toBeGreaterThan(first.pass_at);
    expect(after.guests).toHaveLength(1);
    expect(g.closed).toBeNull();
    expect(mom.logs().at(-1)!.msg).toMatch(/new passcode .*guests stay signed in/);
    expect(bob.msgs('share')).toHaveLength(0);
    expect(JSON.stringify(mom.sent)).not.toContain('cedar-heron-otter-17');
    expect((await joinHttp(room, { code: first.code, pass: 'blue-otter-42', name: 'Sam' }, '8.8.8.1')).status).toBe(401);
    expect((await joinHttp(room, { code: first.code, pass: 'cedar-heron-otter-17', name: 'Sam' }, '8.8.8.2')).status).toBe(200);

    // An absent "days" is never "forever".
    await say(mom, { t: 'share_extend' });
    expect((mom.msgs('share').at(-1)!.share as { expires_at: number }).expires_at).toBe(first.expires_at);
    await say(mom, { t: 'share_extend', days: 7 });
    expect((mom.msgs('share').at(-1)!.share as { expires_at: number }).expires_at).toBe(first.expires_at + 7 * 24 * 3600_000);
    expect(mom.logs().at(-1)!.msg).toMatch(/extended the share link by 7 days/);

    // Signing everyone out with it.
    await say(mom, { t: 'share_pass', pass: 'maple-river-lotus-55', signOut: true });
    expect(g.closed).toBe(4004);
    expect((mom.msgs('share').at(-1)!.share as { guests: unknown[] }).guests).toHaveLength(0);
  });

  it('push and log copy point to Invite', async () => {
    const { room, join, say, subscribe } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    await subscribe(mom, 'https://push.test/mom');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Jo' });
    expect(pushes.some((p) => /Invite → Who has access/.test(String(p.payload.body)))).toBe(true);
  });
});

describe('MonitorRoom admin socket (the Invite sheet off the watch screen)', () => {
  it('gets a slim hello and the share link, never presence or camera status, and can only manage people and sharing', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const admin = await join('tok-parent', 'admin' as never, 'hub');
    const hello = admin.msgs('hello')[0];
    expect(Object.keys(hello).sort()).toEqual(['nursery', 't', 'you']);
    expect(hello.you).toMatchObject({ role: 'parent', mode: 'admin' });
    expect(hello.nursery).toMatchObject({ name: 'Nursery', baby: 'Aria' });
    expect(admin.msgs('share')).toHaveLength(1);

    const viewer = await join('tok-care', 'viewer', 'laptop');
    await say(cam, { t: 'status', st: { state: 'calm', level: 3, motion: 1, light: 40, battery: 80, charging: true, soothing: null, cry: 0 } });
    expect(viewer.msgs('status').length).toBeGreaterThan(0);
    expect(admin.msgs('presence')).toHaveLength(0);
    expect(admin.msgs('status')).toHaveLength(0);
    // Not in presence.
    const pres = viewer.msgs('presence').at(-1) as { viewers: { name: string }[] };
    expect(pres.viewers.map((v) => v.name)).toEqual(['Bob']);

    // Manages the link…
    await say(admin, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    expect((admin.msgs('share').at(-1)!.share as { on: boolean }).on).toBe(true);
    // …but nothing else (no logging into the nursery, no camera commands).
    const logs = viewer.logs().length;
    await say(admin, { t: 'log', kind: 'note', msg: 'hi' });
    await say(admin, { t: 'cmd', to: 's-crib', c: 'soothe', v: { kind: 'shush' } });
    expect(viewer.logs()).toHaveLength(logs);
    expect(cam.msgs('cmd')).toHaveLength(0);
    // The same command from a parent's watch screen does reach the camera.
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'cmd', to: 's-crib', c: 'soothe', v: { kind: 'shush' } });
    expect(cam.msgs('cmd')).toHaveLength(1);
  });

  it('is for parents only', async () => {
    const { join } = setup();
    const ws = await join('tok-care', 'admin' as never, 'hub');
    expect(ws.closed).toBe(4004);
  });
});

describe('MonitorRoom: guests who have an account (share link → member)', () => {
  const T = { sam: 'tok-sam-0123456789abcdefghij', care: 'tok-care-0123456789abcdefghij', nobody: 'tok-nobody-0123456789abcdefgh' };
  const joinHttp = (room: MonitorRoom, body: Record<string, unknown>, token?: string, ip = '7.7.7.7') =>
    room.fetch(
      new Request(`https://monitor.internal/guest?nid=${NID}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }),
    );
  /** Supabase by function: live_me (who), monitor_my_role (member?), monitor_member_ids. */
  const supabase = (members: Set<string>) =>
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
      const fn = String(url).split('/rpc/')[1];
      const people: Record<string, { uid: string; name: string; role?: string; label?: string | null }> = {
        'tok-parent': { uid: 'u-parent', name: 'Alice', role: 'parent', label: 'Mom' },
        [T.sam]: { uid: 'u-sam', name: 'Sam Smith' },
        [T.care]: { uid: 'u-care', name: 'Bob', role: 'caregiver', label: 'Grandpa' },
      };
      const p = people[token];
      const body = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
      if (fn === 'live_me') return p ? body({ member: true, user_id: p.uid, profile: { display_name: p.name } }) : body({ member: false });
      if (fn === 'monitor_member_ids') return body({ ok: true, ids: [...members] });
      if (fn === 'monitor_my_role') {
        return p && members.has(p.uid)
          ? body({ ok: true, user_id: p.uid, role: p.role ?? 'viewer', display_name: p.name, label: p.label ?? null, nursery_name: 'Nursery', baby_name: 'Aria' })
          : body({ ok: false });
      }
      return body({ ok: false }, 404);
    });

  it('a member who opens the link is sent to watch instead of becoming a guest', async () => {
    const { room, join, say } = setup();
    const members = new Set(['u-parent', 'u-care']);
    supabase(members);
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    const r = await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Bob' }, T.care);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, reason: 'member' });
    expect((mom.msgs('share').at(-1)!.share as { guests: unknown[] }).guests).toHaveLength(0);
    // The passcode still has to be right first.
    expect((await joinHttp(room, { code, pass: 'wrong-guess-zz', name: 'Bob' }, T.care)).status).toBe(401);
  });

  it('lists a guest with an account for parents (uid from Supabase, never the body); "Make member" promotes them', async () => {
    const { room, join, say } = setup();
    const members = new Set(['u-parent', 'u-care']);
    supabase(members);
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join(T.care, 'viewer', 'laptop');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'caregiver' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;

    // No token: an ordinary guest, whatever the body claims.
    const anon = (await (await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Jo', uid: 'u-evil' })).json()) as { ok: boolean; account?: boolean };
    expect(anon).toMatchObject({ ok: true });
    expect(anon.account).toBeUndefined();
    // A token Supabase doesn't recognise: also just a guest.
    expect((await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Kim' }, T.nobody)).status).toBe(200);
    expect((mom.msgs('share').at(-1)!.share as { requests: unknown[] }).requests).toEqual([]);

    const res = (await (await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Uncle Sam', uid: 'u-evil' }, T.sam)).json()) as { ok: boolean; token: string; account?: boolean };
    expect(res).toMatchObject({ ok: true, account: true });
    const share = mom.msgs('share').at(-1)!.share as { requests: { id: string; uid: string; account: string; name: string; role: string }[] };
    expect(share.requests).toEqual([expect.objectContaining({ uid: 'u-sam', account: 'Sam Smith', name: 'Uncle Sam', role: 'caregiver' })]);
    expect(bob.msgs('share')).toHaveLength(0);
    expect(mom.logs().at(-1)!.msg).toMatch(/has a Stream Studio account/);

    const sam = await join('', 'viewer', 'sam-phone', { guest: res.token });
    expect((sam.msgs('hello')[0].you as { guest: boolean }).guest).toBe(true);

    // The parent adds Sam in Supabase (the app's setMember), then tells the room — naming who changed.
    members.add('u-sam');
    const rolesBefore = bob.msgs('roles_changed').length;
    await say(mom, { t: 'members_changed', token: 'tok-parent', uids: ['u-sam'] });
    expect(sam.msgs('promoted')).toHaveLength(1);
    expect(sam.closed).toBe(4007);
    const after = mom.msgs('share').at(-1)!.share as { guests: { name: string }[]; requests: unknown[] };
    expect(after.requests).toEqual([]);
    expect(after.guests.map((x) => x.name).sort()).toEqual(['Jo', 'Kim']);
    expect(mom.logs().some((e) => /made Uncle Sam a member/.test(e.msg))).toBe(true);
    // Bob's access didn't change: his live picture isn't restarted.
    expect(bob.msgs('roles_changed')).toHaveLength(rolesBefore);
    // The old guest pass is gone for good.
    expect((await join('', 'viewer', 'sam-phone2', { guest: res.token })).closed).toBe(4004);
  });

  it('a parent can keep them a guest instead', async () => {
    const { room, join, say } = setup();
    supabase(new Set(['u-parent']));
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'share_set', pass: 'blue-otter-42', role: 'viewer' });
    const code = (mom.msgs('share').at(-1)!.share as { code: string }).code;
    await joinHttp(room, { code, pass: 'blue-otter-42', name: 'Sam' }, T.sam);
    const req = (mom.msgs('share').at(-1)!.share as { requests: { id: string }[] }).requests[0];
    await say(mom, { t: 'request_dismiss', id: req.id });
    const after = mom.msgs('share').at(-1)!.share as { requests: unknown[]; guests: unknown[] };
    expect(after.requests).toEqual([]);
    expect(after.guests).toHaveLength(1);
  });
});

describe('MonitorRoom tracker', () => {
  const T = () => Date.now();
  it('a caregiver logs a bottle; everyone gets it live, with a line in the activity log', async () => {
    const { join, say } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    await say(bob, { t: 'track_put', item: { id: 'bottle001', kind: 'bottle', start: T() - 60_000, data: { ml: 120, milk: 'formula', junk: 1 } } });
    const got = mom.msgs('track')[0].item as { id: string; by: string; data: Record<string, unknown> };
    expect(got).toMatchObject({ id: 'bottle001', by: 'Bob (Grandpa)', data: { ml: 120, milk: 'formula' } });
    expect(got.data.junk).toBeUndefined();
    expect(mom.logs().some((e) => e.msg === 'Bottle · 120 ml formula' && e.sev === 'care')).toBe(true);
  });

  it('viewers can read but not log; bad entries are explained', async () => {
    const { join, say } = setup();
    const cara = await join('tok-viewer', 'viewer', 'tablet');
    await say(cara, { t: 'track_put', item: { id: 'diaper01', kind: 'diaper', start: T(), data: { pee: true } } });
    expect(cara.msgs('track')).toHaveLength(0);
    expect(String(cara.msgs('track_err')[0].msg)).toMatch(/Viewers/);
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(mom, { t: 'track_put', item: { id: 'bottle02', kind: 'bottle', start: T(), data: {} } });
    expect(String(mom.msgs('track_err')[0].msg)).toMatch(/how much/);
  });

  it('a sleep timer started by Mom is stopped by Grandpa, and both show in hello and queries', async () => {
    const { join, say } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    const start = T() - 45 * 60_000;
    await say(mom, { t: 'track_put', item: { id: 'nap00001', kind: 'sleep', start, end: null, data: { where: 'crib' } } });
    const late = await join('tok-care', 'viewer', 'tablet2');
    expect((late.msgs('hello')[0] as { track: { running: { id: string }[] } }).track.running.map((r) => r.id)).toEqual(['nap00001']);
    await say(bob, { t: 'track_put', item: { id: 'nap00001', kind: 'sleep', start, end: T(), data: { where: 'crib' } } });
    const last = mom.msgs('track').at(-1)!.item as { end: number | null; by: string };
    expect(last.end).not.toBeNull();
    expect(last.by).toBe('Alice (Mom)');
    expect(mom.logs().map((e) => e.msg)).toEqual(expect.arrayContaining(['Down for sleep', 'Woke up after 45 min']));
    await say(mom, { t: 'q', id: 'q1', q: 'track', from: T() - 86400_000, to: T() + 1000 });
    const r = mom.msgs('r').find((m) => m.id === 'q1') as { items: { id: string }[]; auto: unknown[] };
    expect(r.items.map((i) => i.id)).toEqual(['nap00001']);
    expect(Array.isArray(r.auto)).toBe(true);
  });

  it('deletes reach everyone and sync to phones that were offline', async () => {
    const { join, say } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    const before = T();
    await say(mom, { t: 'track_put', item: { id: 'note0001', kind: 'note', start: T(), data: { note: 'spit up' } } });
    await say(mom, { t: 'track_del', id: 'note0001' });
    expect(mom.msgs('track_del')[0]).toMatchObject({ id: 'note0001' });
    await say(mom, { t: 'q', id: 'q2', q: 'track_sync', since: before - 1 });
    const r = mom.msgs('r').find((m) => m.id === 'q2') as { items: { id: string; deleted?: boolean }[] };
    expect(r.items).toEqual([expect.objectContaining({ id: 'note0001', deleted: true })]);
  });

  it('parents set the baby’s birth date and sex for age-based guidance', async () => {
    const { join, say } = setup();
    const mom = await join('tok-parent', 'viewer', 'phone');
    const bob = await join('tok-care', 'viewer', 'laptop');
    await say(bob, { t: 'settings', baby: { birth: '2026-07-01', sex: 'f' } });
    expect(bob.msgs('settings').at(-1)?.settings).not.toHaveProperty('baby.birth', '2026-07-01');
    await say(mom, { t: 'settings', baby: { birth: '2026-07-01', sex: 'f' } });
    expect((mom.msgs('settings').at(-1)!.settings as { baby: unknown }).baby).toEqual({ birth: '2026-07-01', sex: 'f' });
    await say(mom, { t: 'settings', baby: { birth: '2999-01-01', sex: 'x' } });
    expect((mom.msgs('settings').at(-1)!.settings as { baby: unknown }).baby).toEqual({ birth: null, sex: null });
  });
});

describe('MonitorRoom weekly analytics', () => {
  it('rolls up sleep, wakings, crying, response times and sleep-time noise per day', async () => {
    const { room, join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    const now = Date.now();
    const start = now - 3 * 3600_000;
    room.store.putSleep({ id: 's1', start, end: start + 2 * 3600_000, onset: start, kind: 'night', source: 'auto', asleep_min: 110, awake_min: 10, wakings: 2, longest_min: 70, cry_min: 3, laeq: 38, summary: null });
    for (let m = 0; m < 3; m++) room.store.putMinute({ dev: 'crib', m: start + m * 60_000, laeq: 40, lmax: 50, l10: 42, l50: 39, l90: 35, lpk: 60, cal: 1, motion: 1, mmax: 2, crib: 1, outside: 0, light: 5, state: 1, sounds: {}, visit: 0 });
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
    const inc = room.store.activeIncidents();
    expect(inc.length).toBeGreaterThan(0);
    await say(mom, { t: 'ack', inc: inc[0].id });
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'end', secs: 150 });
    const days = room.weeks(Date.now(), 'UTC', 14);
    expect(days).toHaveLength(14);
    const today = days.at(-1)!;
    // The session may start yesterday (UTC) when the suite runs just after midnight.
    const withSleep = days.find((d) => d.sleepMin > 0)!;
    expect(withSleep).toMatchObject({ sleepMin: 110, nightMin: 110, wakings: 2, longestMin: 70, sleepLaeq: 40 });
    expect(today).toMatchObject({ cries: 1, cryMin: 3, alerts: 1 });
    expect(today.responseSec).not.toBeNull();
  });
});

describe('MonitorRoom smart vision', () => {
  it('logs posture, holding and play areas; a sharp object in reach opens an incident', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(cam, { t: 'event', kind: 'scene', type: 'posture', posture: 'sitting', where: 'Crib' });
    await say(cam, { t: 'event', kind: 'scene', type: 'holding', label: 'teddy bear' });
    await say(cam, { t: 'event', kind: 'scene', type: 'in_zone', name: 'Play gym' });
    await say(cam, { t: 'event', kind: 'scene', type: 'holding', label: '<script>' });
    await say(cam, { t: 'event', kind: 'scene', type: 'object_near', label: 'scissors' });
    const msgs = mom.logs().map((e) => e.msg);
    expect(msgs).toEqual(expect.arrayContaining([
      'Aria is sitting up in the crib · Crib iPhone',
      'Aria is holding a teddy bear · Crib iPhone',
      'Aria is in the Play gym · Crib iPhone',
      'Scissors within Aria’s reach (sharp) · Crib iPhone',
    ]));
    expect(msgs.some((m) => m.includes('script'))).toBe(false);
    expect(mom.msgs('incident').some((m) => (m.inc as { kind: string }).kind === 'object')).toBe(true);
    // Safe sleep: in the crib, or beside a baby lying anywhere.
    await say(cam, { t: 'event', kind: 'scene', type: 'soft_toy', inCrib: true });
    expect(mom.logs().some((e) => e.msg.startsWith('A soft toy is in the crib with Aria'))).toBe(true);
    // Viewers can't fake scene events.
    await say(mom, { t: 'event', kind: 'scene', type: 'rolled' });
    expect(mom.logs().some((e) => /rolled/.test(e.msg))).toBe(false);
  });

  it('words a soft toy outside the crib for wherever the baby lies', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(cam, { t: 'event', kind: 'scene', type: 'soft_toy', inCrib: false });
    expect(mom.logs().map((e) => e.msg)).toContainEqual(expect.stringMatching(/^A soft toy is within Aria’s reach while lying down — .*no toys, pillows or blankets/));
  });

  it('passes the scene in the status, sanitized', async () => {
    const { join, say } = setup();
    const cam = await join('tok-parent', 'camera', 'crib');
    const mom = await join('tok-parent', 'viewer', 'phone');
    await say(cam, { t: 'status', st: { state: 'calm', level: 0, motion: 0, light: 50, scene: { baby: true, posture: 'sitting', where: 'Play gym', holding: 'teddy bear', near: ['cup', 'nuclear', 'cup'], adult: false } } });
    expect(mom.msgs('status')[0].st).toMatchObject({ scene: { baby: true, posture: 'sitting', where: 'Play gym', holding: 'teddy bear', near: ['cup'], adult: false } });
  });

  it('keeps activity zones', () => {
    expect(sanitizeZones([{ id: 'g1', kind: 'activity', name: 'Play gym', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }])).toEqual([{ id: 'g1', kind: 'activity', name: 'Play gym', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }]);
  });
});

describe('MonitorRoom family calls', () => {
  type CallMsg = { id: string; parts: { sid: string; uid: string; gone?: number }[]; answeredAt: number | null; ended: { why: string } | null; invited: string[] };
  const lastCall = (ws: FakeWS) => ws.msgs('call').at(-1)?.call as CallMsg | undefined;

  it('a call line gets a light hello and stays out of the monitor’s presence and broadcasts', async () => {
    const { join, say } = setup();
    const line = await join('tok-care', 'line', 'gpa-phone');
    const hello = line.msgs('hello')[0];
    expect(hello).toMatchObject({ you: { uid: 'u-care', mode: 'line' }, nursery: { id: NID }, calls: [], callLog: [] });
    expect(hello.log).toBeUndefined();
    const mom = await join('tok-parent', 'viewer', 'phone');
    expect(mom.msgs('presence').at(-1)).toMatchObject({ viewers: [{ name: 'Alice' }] });
    const cam = await join('tok-parent', 'camera', 'crib');
    await say(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
    expect(line.sent.filter((m) => (m as { t: string }).t !== 'hello')).toEqual([]);
    // A monitor socket can't place calls.
    await say(mom, { t: 'call_start', to: ['22222222-2222-4222-8222-222222222222'] });
    expect(mom.msgs('call_started')).toEqual([]);
  });

  it('rings, connects, relays the handshake only inside the call, and logs it', async () => {
    const { join, say, subscribe, store } = setup();
    const momLine = await join('tok-parent', 'line', 'mom-phone');
    const gpaLine = await join('tok-care', 'line', 'gpa-phone');
    const caraLine = await join('tok-viewer', 'line', 'cara-phone');
    // Grandpa asked to be rung when the app is closed; Mom's monitor alerts are a separate list.
    await say(gpaLine, { t: 'call_push', sub: { endpoint: 'https://push.test/gpa', keys: { p256dh: 'p', auth: 'a' } } });
    const momMonitor = await join('tok-parent', 'viewer', 'mom-laptop');
    await subscribe(momMonitor, 'https://push.test/mom-alerts');
    pushes.length = 0;

    await say(momLine, { t: 'call_start', to: ['u-care'], video: true, ref: 'r1' });
    const id = momLine.msgs('call_started')[0].id as string;
    expect(momLine.msgs('call_started')[0].ref).toBe('r1');
    expect(lastCall(gpaLine)).toMatchObject({ id, invited: ['u-care'], answeredAt: null, parts: [{ sid: 's-mom-phone', uid: 'u-parent' }] });
    expect(caraLine.msgs('call')).toEqual([]); // not asked, not told
    expect(momMonitor.msgs('call')).toEqual([]); // the monitor screen never rings
    expect(pushes).toEqual([{ endpoint: 'https://push.test/gpa', payload: expect.objectContaining({ kind: 'call', title: 'Mom', body: 'Video call · Aria’s family', call: id, tag: `call-${id}` }) }]);

    // Grandpa picks up.
    await say(gpaLine, { t: 'call_join', id, video: true });
    expect(lastCall(momLine)?.parts.map((p) => p.sid)).toEqual(['s-mom-phone', 's-gpa-phone']);
    expect(lastCall(momLine)?.answeredAt).toEqual(expect.any(Number));

    // The handshake flows between the two of them — never to someone outside the call.
    await say(gpaLine, { t: 'call_rtc', id, to: 's-mom-phone', d: { sdp: { type: 'offer', sdp: 'x' } } });
    expect(momLine.msgs('call_rtc')).toEqual([{ t: 'call_rtc', id, from: 's-gpa-phone', d: { sdp: { type: 'offer', sdp: 'x' } } }]);
    await say(caraLine, { t: 'call_rtc', id, to: 's-mom-phone', d: { sdp: 'evil' } });
    await say(gpaLine, { t: 'call_rtc', id, to: 's-cara-phone', d: { sdp: 'leak' } });
    expect(momLine.msgs('call_rtc')).toHaveLength(1);
    expect(caraLine.msgs('call_rtc')).toEqual([]);

    // Mic / camera state reaches the other side.
    await say(gpaLine, { t: 'call_media', id, mic: false, cam: true });
    expect(lastCall(momLine)?.parts.find((p) => p.uid === 'u-care')).toMatchObject({ mic: false, cam: true });

    // Mom hangs up: over for both, and in both histories.
    await say(momLine, { t: 'call_leave', id });
    expect(lastCall(gpaLine)?.ended?.why).toBe('done');
    expect(gpaLine.msgs('call_log')[0].rec).toMatchObject({ id, answered: true, from: { uid: 'u-parent' }, joined: [{ name: 'Alice' }, { name: 'Bob' }] });
    expect(store.get('calls')).toEqual([]);
    expect((store.get('callLog') as unknown[]).length).toBe(1);
    // Cara's next hello doesn't show a call she wasn't part of; Grandpa's does.
    expect((await join('tok-viewer', 'line', 'cara-2')).msgs('hello')[0].callLog).toEqual([]);
    expect((await join('tok-care', 'line', 'gpa-2')).msgs('hello')[0].callLog).toHaveLength(1);
  });

  it('no answer after 45 s: the caller hears it and the person called gets a missed-call notice', async () => {
    const { join, say, store, room, alarm } = setup();
    const momLine = await join('tok-parent', 'line', 'mom-phone');
    const gpaLine = await join('tok-care', 'line', 'gpa-phone');
    await say(gpaLine, { t: 'call_push', sub: { endpoint: 'https://push.test/gpa', keys: { p256dh: 'p', auth: 'a' } } });
    await say(momLine, { t: 'call_start', to: ['u-care'], video: false });
    expect(alarm()).toEqual(expect.any(Number));
    pushes.length = 0;
    const calls = store.get('calls') as { at: number }[];
    calls[0].at -= 46_000;
    await room.alarm();
    expect(lastCall(momLine)?.ended?.why).toBe('no_answer');
    expect(pushes).toEqual([{ endpoint: 'https://push.test/gpa', payload: expect.objectContaining({ kind: 'call_missed', title: 'Missed audio call', body: 'Mom · Aria’s family' }) }]);
  });

  it('declining ends a one-to-one call with no missed-call notice', async () => {
    const { join, say } = setup();
    const momLine = await join('tok-parent', 'line', 'mom-phone');
    const gpaLine = await join('tok-care', 'line', 'gpa-phone');
    await say(gpaLine, { t: 'call_push', sub: { endpoint: 'https://push.test/gpa', keys: { p256dh: 'p', auth: 'a' } } });
    await say(momLine, { t: 'call_start', to: ['u-care'] });
    const id = momLine.msgs('call_started')[0].id as string;
    pushes.length = 0;
    await say(gpaLine, { t: 'call_decline', id });
    expect(lastCall(momLine)?.ended?.why).toBe('declined');
    expect(pushes).toEqual([]);
  });

  it('a dropped line keeps the call going while it reconnects', async () => {
    const { join, say, close, store, room } = setup();
    const momLine = await join('tok-parent', 'line', 'mom-phone');
    const gpaLine = await join('tok-care', 'line', 'gpa-phone');
    await say(momLine, { t: 'call_start', to: ['u-care'] });
    const id = momLine.msgs('call_started')[0].id as string;
    await say(gpaLine, { t: 'call_join', id });
    await close(gpaLine);
    expect(lastCall(momLine)?.ended).toBeNull();
    expect(lastCall(momLine)?.parts.find((p) => p.uid === 'u-care')?.gone).toEqual(expect.any(Number));
    // Back on a new connection: the room points the call at it.
    const again = await join('tok-care', 'line', 'gpa-phone-2');
    expect((again.msgs('hello')[0].calls as CallMsg[])[0].id).toBe(id);
    await say(again, { t: 'call_join', id });
    expect(lastCall(momLine)?.parts.map((p) => [p.sid, p.gone])).toEqual([['s-mom-phone', undefined], ['s-gpa-phone-2', undefined]]);
    // Gone for good: after the grace period the call is over.
    await close(again);
    const calls = store.get('calls') as { parts: { gone?: number }[] }[];
    for (const p of calls[0].parts) if (p.gone) p.gone -= 21_000;
    await room.alarm();
    expect(lastCall(momLine)?.ended?.why).toBe('done');
  });
});
