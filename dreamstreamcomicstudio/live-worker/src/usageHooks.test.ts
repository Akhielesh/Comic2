// @vitest-environment node
// Stream Studio usage metering in the rooms (ADR 0007; feature doc §3.3, Phase A3):
//   - a relay frame and a segment GET never touch storage (spy tests),
//   - relay frames and relay minutes are counted, survive in attachments, and are written at most
//     once an hour per room — in the alarm that already runs, and when the last camera leaves,
//   - parents (only) can read the nursery's month,
//   - broadcast segments ride the existing putMeta, viewer-minutes the existing stats write, and
//     a usage flush put off at the end of an event loses nothing,
//   - a call's usage counts against the CALLER's account (owner decision).
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./webpush', async (orig) => ({
  ...(await orig<typeof import('./webpush')>()),
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: async () => 'sent',
}));

import { EventRoom, eventUsage, type EventMeta } from './eventRoom';
import liveWorker, { type Env } from './index';
import { MonitorRoom, type MonEnv } from './monitorRoom';
import { type RingingRec } from './directCalls';
import { Pair, World } from './directTestKit';
import { clearMemberCache } from './supabaseAuth';
import { FLUSH_EVERY_MS, usageKey } from './usageMeter';
import { sanitizeMonth, type UsageMonth } from '../../shared/stream/usage';

const NID = '11111111-2222-4333-8444-555555555555';
const MOM = 'aaaaaaaa-0000-4000-8000-000000000001';
const GPA = 'aaaaaaaa-0000-4000-8000-000000000002';
const H = FLUSH_EVERY_MS;
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearMemberCache();
});

/** A controllable clock for Date.now(). */
function clock(start = Date.parse('2026-10-21T20:00:00Z')) {
  let t = start;
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const month = (store: Map<string, unknown>, ms = Date.now()): UsageMonth | null => sanitizeMonth(store.get(usageKey(new Date(ms).toISOString().slice(0, 7))));
const usagePuts = (log: string[]) => log.filter((k) => k.startsWith('use:')).length;

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
    return this.sent.filter((m) => m.t === t);
  }
}

/** MonitorRoom with storage that logs every write and can be watched for any access. */
function monitor(extraEnv: Record<string, unknown> = {}) {
  vi.stubGlobal('WebSocketRequestResponsePair', Pair);
  const store = new Map<string, unknown>([['nid', NID]]);
  const sockets: FakeWS[] = [];
  const access = { n: 0 };
  const writes: string[] = [];
  let alarm: number | null = null;
  const state = {
    storage: {
      get: async (k: string) => (access.n++, structuredClone(store.get(k))),
      put: async (k: string, v: unknown) => (access.n++, writes.push(k), void store.set(k, structuredClone(v))),
      delete: async (k: string) => (access.n++, writes.push(k), store.delete(k)),
      getAlarm: async () => (access.n++, alarm),
      setAlarm: async (t: number) => (access.n++, void (alarm = t)),
      sql: sqlStorage(),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => sockets.push(ws),
    setWebSocketAutoResponse: () => undefined,
  };
  const keyHolder = { fetch: async () => new Response(JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }), { status: 200 }) };
  const points: { indexes?: string[]; blobs?: string[]; doubles?: number[] }[] = [];
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_PUBLISHABLE_KEY: 'sb_test',
    MONITOR_ROOM: { idFromName: () => 'x', get: () => keyHolder },
    STREAM_USAGE: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) },
    ...extraEnv,
  } as unknown as MonEnv;
  const room = new MonitorRoom(state as never, env);
  const roles: Record<string, { user_id: string; role: string; display_name: string; label: string | null }> = {
    'tok-parent': { user_id: MOM, role: 'parent', display_name: 'Alice', label: 'Mom' },
    'tok-care': { user_id: GPA, role: 'caregiver', display_name: 'Bob', label: 'Grandpa' },
  };
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization).replace('Bearer ', '');
    const r = roles[token];
    return new Response(JSON.stringify(r ? { ok: true, ...r, nursery_name: 'Nursery', baby_name: 'Aria' } : { ok: false }), { status: 200 });
  });
  const join = async (token: string, mode: 'camera' | 'viewer' | 'line', dev: string) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const close = (ws: FakeWS) => {
    sockets.splice(sockets.indexOf(ws), 1);
    return room.webSocketClose(ws as never);
  };
  // A bare JPEG, as relayed to viewers that predate the framed format.
  const frame = () => {
    const u = new Uint8Array(2000);
    u.set([0xff, 0xd8, 0xff]);
    return u.buffer;
  };
  const sendFrame = (cam: FakeWS) => room.webSocketMessage(cam as never, frame());
  return { room, store, sockets, access, writes, points, join, say, close, sendFrame, alarm: () => alarm };
}

describe('MonitorRoom usage — the hot path never touches storage', () => {
  it('counts every relay frame in memory with no storage access at all', async () => {
    const m = monitor();
    const cam = await m.join('tok-parent', 'camera', 'crib');
    const viewer = await m.join('tok-care', 'viewer', 'phone');
    await m.say(viewer, { t: 'relay', on: true, dev: 'crib' });
    const before = m.access.n;
    for (let i = 0; i < 300; i++) await m.sendFrame(cam);
    expect(m.access.n).toBe(before); // no get, put, delete or alarm per frame
    expect(viewer.bin.length).toBeGreaterThan(0); // the picture still flows
    // Every incoming camera message is a billed request (20:1) — the throttled ones too.
    expect(m.room.usage.pendingTotals().get('monitor')?.relayFrames).toBe(300);
  });
});

describe('MonitorRoom usage — relay minutes and the hourly write', () => {
  it('keeps relay minutes on the viewer’s attachment and writes them in the existing alarm, at most once an hour', async () => {
    const c = clock();
    const m = monitor();
    const cam = await m.join('tok-parent', 'camera', 'crib');
    const viewer = await m.join('tok-care', 'viewer', 'phone');
    await m.say(viewer, { t: 'relay', on: true, dev: 'crib' });
    for (let i = 0; i < 10; i++) await m.sendFrame(cam);
    c.advance(30 * 60_000);
    await m.say(viewer, { t: 'relay', on: false });
    // 30 minutes through our server, held by the socket itself (survives hibernation).
    expect((viewer.deserializeAttachment() as { u?: { monitor?: { c: { minutes?: { server?: number } } } } }).u?.monitor?.c.minutes?.server).toBeCloseTo(30, 3);

    await m.room.alarm();
    const row = month(m.store);
    expect(row?.counters.monitor).toMatchObject({ relayFrames: 10, minutes: { server: 30 } });
    expect(row?.scope).toBe('nursery');
    expect(m.points.at(-1)).toMatchObject({ indexes: ['monitor'], blobs: ['nursery', NID, '', 'server'] });

    // More frames inside the hour: alarms keep running, no second usage row.
    for (let i = 0; i < 5; i++) await m.sendFrame(cam);
    for (let k = 0; k < 8; k++) {
      c.advance(15_000);
      await m.room.alarm();
    }
    expect(usagePuts(m.writes)).toBe(1);
    // …and an hour later the rest is written, exactly once.
    c.advance(H);
    await m.room.alarm();
    expect(usagePuts(m.writes)).toBe(2);
    expect(month(m.store)?.counters.monitor?.relayFrames).toBe(15);
  });

  it('writes the night when the last camera leaves, and parks it on a socket that stays when the hour forbids', async () => {
    const c = clock();
    const m = monitor();
    const viewer = await m.join('tok-care', 'viewer', 'phone');
    let cam = await m.join('tok-parent', 'camera', 'crib');
    for (let i = 0; i < 20; i++) await m.sendFrame(cam);
    await m.close(cam);
    expect(month(m.store)?.counters.monitor?.relayFrames).toBe(20);

    // The camera comes back and leaves again within the hour: nothing written, nothing lost.
    c.advance(10 * 60_000);
    cam = await m.join('tok-parent', 'camera', 'crib');
    for (let i = 0; i < 7; i++) await m.sendFrame(cam);
    await m.close(cam);
    expect(usagePuts(m.writes)).toBe(1);
    expect(m.room.usage.pendingTotals().size).toBe(0);
    expect((viewer.deserializeAttachment() as { u?: { monitor?: { c: { relayFrames?: number } } } }).u?.monitor?.c.relayFrames).toBe(7);
    c.advance(H);
    await m.room.alarm();
    expect(month(m.store)?.counters.monitor?.relayFrames).toBe(27);
  });

  it('sound and alerts are untouched by metering: a failing usage write never stops the alarm', async () => {
    const m = monitor();
    const cam = await m.join('tok-parent', 'camera', 'crib');
    for (let i = 0; i < 3; i++) await m.sendFrame(cam);
    const realPut = (m.room as unknown as { state: { storage: { put: (k: string, v: unknown) => Promise<void> } } }).state.storage.put;
    (m.room as unknown as { state: { storage: { put: unknown } } }).state.storage.put = async (k: string, v: unknown) => {
      if (k.startsWith('use:')) throw new Error('storage hiccup');
      return realPut(k, v);
    };
    await expect(m.room.alarm()).resolves.toBeUndefined();
    expect(m.alarm()).not.toBeNull(); // the camera's heartbeat checks are still scheduled
  });
});

describe('MonitorRoom usage — our-server minutes only while frames can flow', () => {
  /** What the nursery's month holds plus what the viewer still carries, through our server (minutes). */
  const serverMinutes = (m: ReturnType<typeof monitor>, viewer: FakeWS) => {
    const att = viewer.deserializeAttachment() as { u?: { monitor?: { c: { minutes?: { server?: number } }; f?: { minutes?: { server?: number } } } } };
    const owed = (att.u?.monitor?.c.minutes?.server ?? 0) - (att.u?.monitor?.f?.minutes?.server ?? 0);
    return (month(m.store)?.counters.monitor?.minutes.server ?? 0) + owed + (m.room.usage.pendingTotals().get('monitor')?.minutes.server ?? 0);
  };

  it('stops a viewer’s clock while its camera is gone or paused for privacy, and restarts it when frames flow again', async () => {
    const c = clock();
    const m = monitor();
    let cam = await m.join('tok-parent', 'camera', 'crib');
    const viewer = await m.join('tok-care', 'viewer', 'bedside');
    await m.say(viewer, { t: 'relay', on: true, dev: 'crib' });
    c.advance(10 * 60_000); // 10 min of relayed picture
    await m.close(cam); // the camera phone dies at 01:00…
    c.advance(6 * 60 * 60_000); // …the bedside viewer stays subscribed all night (linkFallback.ts keeps the relay wanted)
    await m.room.alarm();
    cam = await m.join('tok-parent', 'camera', 'crib'); // back at 07:00
    c.advance(5 * 60_000); // 5 min relayed
    await m.say(cam, { t: 'status', st: { paused: 'privacy' } });
    c.advance(30 * 60_000); // paused for privacy: nothing is relayed
    await m.say(cam, { t: 'status', st: {} });
    c.advance(5 * 60_000); // 5 min relayed
    await m.say(viewer, { t: 'relay', on: false });
    expect(serverMinutes(m, viewer)).toBeCloseTo(20, 3); // not 6 h 50 min
  });

  it('a viewer that subscribes while its camera is away starts its clock only when the camera arrives', async () => {
    const c = clock();
    const m = monitor();
    const viewer = await m.join('tok-care', 'viewer', 'bedside');
    await m.say(viewer, { t: 'relay', on: true, dev: 'crib' });
    c.advance(60 * 60_000);
    const cam = await m.join('tok-parent', 'camera', 'crib');
    c.advance(15 * 60_000);
    await m.say(viewer, { t: 'relay', on: false });
    expect(serverMinutes(m, viewer)).toBeCloseTo(15, 3);
    void cam;
  });
});

describe('MonitorRoom usage — the daily activity mark (per-active-nursery-day denominator)', () => {
  it('marks the nursery active once a UTC day while a camera is on — P2P-only too — with no storage write', async () => {
    const c = clock();
    const m = monitor();
    await m.join('tok-parent', 'camera', 'crib');
    const before = m.writes.length;
    for (let k = 0; k < 10; k++) {
      await m.room.alarm();
      c.advance(15_000);
    }
    const marks = () => m.points.filter((p) => p.indexes?.[0] === 'active');
    expect(marks()).toEqual([{ indexes: ['active'], blobs: ['nursery', NID, '', ''] }]);
    expect(m.writes.slice(before).filter((k) => k.startsWith('use:'))).toEqual([]); // a P2P-only nursery owes nothing: no usage row
    // A wake (memory gone) doesn't repeat it: the camera's attachment carries the day.
    (m.room as unknown as { activeDay: string | null }).activeDay = null;
    await m.room.alarm();
    expect(marks()).toHaveLength(1);
    c.advance(24 * H); // the next UTC day: one more
    await m.room.alarm();
    expect(marks()).toHaveLength(2);
  });

  it('writes no mark without a camera (a viewer alone is not an active nursery-day)', async () => {
    clock();
    const m = monitor();
    await m.join('tok-care', 'viewer', 'bedside');
    await m.room.alarm();
    expect(m.points.filter((p) => p.indexes?.[0] === 'active')).toEqual([]);
  });
});

describe('MonitorRoom usage — read paths', () => {
  it('parents can read this month’s usage; caregivers and viewers can’t', async () => {
    const m = monitor();
    const cam = await m.join('tok-parent', 'camera', 'crib');
    const mom = await m.join('tok-parent', 'viewer', 'mom');
    const gpa = await m.join('tok-care', 'viewer', 'gpa');
    for (let i = 0; i < 4; i++) await m.sendFrame(cam);
    const writes = m.writes.length;
    await m.say(mom, { t: 'q', q: 'usage', id: 'q1' });
    await m.say(gpa, { t: 'q', q: 'usage', id: 'q2' });
    expect(mom.msgs('r')[0]).toMatchObject({ id: 'q1', q: 'usage', usage: { scope: 'nursery', counters: { monitor: { relayFrames: 4 } } }, allowances: { relayDataGb: 10, serverPictureHoursPerDay: 16 } });
    expect(gpa.msgs('r')[0]).toEqual({ t: 'r', id: 'q2', q: 'usage', error: 'forbidden' });
    expect(m.writes.length).toBe(writes); // a read is never a write
  });

  it('takes a viewer’s path report (Phase B) as display data: clamped, deduplicated, never our-server minutes', async () => {
    const c = clock();
    const m = monitor();
    const viewer = await m.join('tok-care', 'viewer', 'phone');
    c.advance(10 * 60_000);
    await m.say(viewer, { t: 'use', minutes: { lan: 9, server: 500, turn: 9999 }, turnBytes: 1e12 });
    await m.say(viewer, { t: 'use', minutes: { lan: 9 } }); // a resend
    const u = (viewer.deserializeAttachment() as { u?: { monitor?: { c: { minutes?: Record<string, number>; turnBytes?: number } } } }).u!.monitor!.c;
    expect(u.minutes).toEqual({ lan: 9, turn: 11 }); // capped at the socket's age (+1 min); no server minutes
    expect(u.turnBytes).toBeLessThanOrEqual((600 + 60) * 12.5e6);
  });
});

describe('MonitorRoom usage — family calls count against the caller', () => {
  it('a finished call sends one point (caller’s account) and its usage to the caller’s line', async () => {
    const c = clock();
    const lineCalls: { path: string; body: Record<string, unknown> }[] = [];
    const m = monitor({
      USER_LINE: {
        idFromName: (n: string) => n,
        get: () => ({ fetch: async (r: Request) => (lineCalls.push({ path: new URL(r.url).pathname, body: (await r.json()) as Record<string, unknown> }), new Response('{"ok":true}')) }),
      },
    });
    const mom = await m.join('tok-parent', 'line', 'mom');
    const gpa = await m.join('tok-care', 'line', 'gpa');
    await m.say(mom, { t: 'call_start', to: [GPA], video: true, ref: 'r1' });
    const id = mom.msgs('call_started')[0].id as string;
    await m.say(gpa, { t: 'call_join', id, video: true });
    await m.say(mom, { t: 'call_stats', id, ttc: 900, path: 'relay', fail: null, turn: true });
    await m.say(gpa, { t: 'call_stats', id, ttc: 800, path: 'internet', fail: null, turn: true });
    c.advance(10 * 60_000);
    await m.say(mom, { t: 'call_leave', id });
    await m.say(gpa, { t: 'call_leave', id });
    await vi.waitFor(() => expect(lineCalls).toHaveLength(1));
    // Mom placed the call: she pays, whoever relayed.
    expect(m.points.at(-1)).toMatchObject({ indexes: ['call'], blobs: ['account', MOM, MOM, expect.any(String)] });
    expect(lineCalls[0]).toMatchObject({ path: '/x/use', body: { kind: 'call', id, use: { minutes: { turn: 10, direct: 10 } } } });
  });
});

// ─────────────────────────────────────────────────────────────── EventRoom

function event() {
  const store = new Map<string, unknown>();
  const sockets: FakeWS[] = [];
  const writes: string[] = [];
  const state = {
    storage: {
      get: async (k: string) => structuredClone(store.get(k)),
      put: async (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') {
          writes.push(k);
          store.set(k, structuredClone(v));
        } else for (const [kk, vv] of Object.entries(k)) (writes.push(kk), store.set(kk, structuredClone(vv)));
      },
      delete: async (k: string) => store.delete(k),
      setAlarm: async () => undefined,
      getAlarm: async () => null,
    },
    getWebSockets: () => sockets,
    acceptWebSocket: (ws: FakeWS) => void sockets.push(ws),
  };
  const points: { indexes?: string[]; blobs?: string[] }[] = [];
  const room = new EventRoom(state as never, {
    ALLOWED_ORIGINS: '*',
    LIVE_BUCKET: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined },
    STREAM_USAGE: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) },
  } as never);
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    room.fetch(new Request(`https://room.internal${path}`, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers }));
  return { room, store, sockets, writes, points, call };
}

async function liveEvent() {
  const e = event();
  const res = await e.call('/init', { id: 'ev1', title: 'Show', ownerId: 'owner-uid' });
  const { hostKey } = (await res.json()) as { hostKey: string };
  const host = new FakeWS();
  host.serializeAttachment({ sid: 'h', name: 'host', role: 'host' });
  e.sockets.push(host);
  await e.room.webSocketMessage(host as never, JSON.stringify({ t: 'state', status: 'live' }));
  const ingest = (seq: number, bytes: number) => e.call('/ingest', { seq, ms: 6000, at: Date.now(), mime: 'video/webm', bytes }, { 'x-host-key': hostKey });
  return { ...e, hostKey, host, ingest };
}

describe('EventRoom usage — segments ride the existing putMeta', () => {
  it('adds segment bytes to the private meta totals with no extra write, and never shows them publicly', async () => {
    clock();
    const e = await liveEvent();
    await e.ingest(1, 1_000_000); // (logs "first segment received", as before)
    const writes = e.writes.length;
    await e.ingest(2, 2_000_000);
    expect(e.writes.slice(writes)).toEqual(['meta']); // one row per segment, as before — usage rides it
    expect((e.store.get('meta') as EventMeta).use).toMatchObject({ segBytes: 3_000_000, segCount: 2 });
    const pub = (await (await e.call('/meta')).json()) as Record<string, unknown>;
    expect(pub).not.toHaveProperty('use');
    expect(pub.latestSeq).toBe(2);
  });

  it('writes the event’s usage hourly from the alarm, and an end inside the hour loses nothing', async () => {
    const c = clock();
    const e = await liveEvent();
    // A fresh room: its first alarm (30 s in) writes what the segments and viewers added so far.
    await e.ingest(1, 500_000);
    const viewer = new FakeWS();
    viewer.serializeAttachment({ sid: 'v', name: 'v', role: 'viewer' });
    e.sockets.push(viewer);
    c.advance(30_000);
    await e.room.alarm();
    let row = month(e.store);
    expect(row?.scope).toBe('event');
    expect(row?.counters.broadcast).toMatchObject({ segBytes: 500_000, segCount: 1, viewerMinutes: 0.5 });
    expect(e.points.at(-1)).toMatchObject({ indexes: ['broadcast'], blobs: ['event', 'ev1', 'owner-uid', ''] });

    // More segments, then the host ends 10 minutes later — inside the hour: put off, not lost.
    await e.ingest(2, 700_000);
    c.advance(10 * 60_000);
    await e.room.webSocketMessage(e.host as never, JSON.stringify({ t: 'state', status: 'ended' }));
    expect(month(e.store)?.counters.broadcast?.segBytes).toBe(500_000);
    // The replay janitor (24 h later) counts the rest, exactly once.
    c.advance(24 * H);
    await e.room.alarm();
    row = month(e.store);
    expect(row?.counters.broadcast).toMatchObject({ segBytes: 1_200_000, segCount: 2 });
    c.advance(6 * 24 * H);
    await e.room.alarm();
    expect(month(e.store)?.counters.broadcast?.segBytes).toBe(1_200_000);
  });

  it('a meeting that never went live writes no usage row at all', async () => {
    clock();
    const e = event();
    await e.call('/init', { id: 'ev2', title: 'Chat', kind: 'meeting', ownerId: 'owner-uid' });
    const host = new FakeWS();
    host.serializeAttachment({ sid: 'h', name: 'host', role: 'host' });
    e.sockets.push(host);
    await e.room.webSocketMessage(host as never, JSON.stringify({ t: 'state', status: 'ended' }));
    expect(e.writes.some((k) => k.startsWith('use:'))).toBe(false);
    expect(e.points).toEqual([]);
  });

  it('counts a 7-day cloud copy once, at the size R2 stored', () => {
    const rec = { key: 'k', file: 'f', bytes: 2.9e9, mime: 'video/webm', durMs: 1, at: 1000 };
    const first = eventUsage({}, {}, [rec])(null);
    expect(first.delta.cloud_copy).toMatchObject({ cloudCopyBytes: 2.9e9 });
    expect(eventUsage({}, {}, [rec])(first.src).delta.cloud_copy).toEqual({});
  });

  it('prefers the size R2 reports for a registered recording', async () => {
    clock();
    const e = await liveEvent();
    await e.call('/rec/register', { key: 'events/ev1/rec/1-a.webm', file: 'a.webm', bytes: 10, stored: 2_000_000, mime: 'video/webm', durMs: 1 }, { 'x-host-key': e.hostKey });
    expect((e.store.get('recordings') as { bytes: number }[])[0].bytes).toBe(2_000_000);
  });
});

// ─────────────────────────────────────────────────────── direct calls + lines

describe('Direct calls — usage counts against the caller’s account', () => {
  let w: World;
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const points: { indexes?: string[]; blobs?: string[] }[] = [];
  beforeEach(() => {
    vi.stubGlobal('WebSocketRequestResponsePair', Pair);
    points.length = 0;
    w = new World({ STREAM_USAGE: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) } });
    vi.stubGlobal('fetch', w.fetch);
  });

  it('the caller’s line gets the call’s minutes by path; the callee’s gets none', async () => {
    const c = clock();
    const alice = w.add({ uid: U(1), name: 'Alice', token: 'tok-alice' });
    const sam = w.add({ uid: U(2), name: 'Sam', token: 'tok-sam' });
    const alicePhone = await w.app(alice, 'alice-phone');
    const samPhone = await w.app(sam, 'sam-phone');
    await w.say(alice, alicePhone, { t: 'dcall_start', to: [sam.uid], video: true, ref: 'r1', token: alice.token });
    const started = alicePhone.msgs('dcall_started').at(-1)!;
    const id = started.id as string;
    const aliceIn = await w.enter(id, started.ticket as string, 'alice-phone');
    await w.in(id, aliceIn, { t: 'call_join', id, video: true, mic: true });
    const samIn = await w.enter(id, (samPhone.msgs('dcall_ring').at(-1)!.ring as RingingRec).ticket, 'sam-phone');
    await w.in(id, samIn, { t: 'call_join', id, video: true, mic: true });
    await w.in(id, aliceIn, { t: 'call_stats', id, ttc: 500, path: 'relay', fail: null, turn: true });
    await w.in(id, samIn, { t: 'call_stats', id, ttc: 500, path: 'lan', fail: null, turn: true });
    c.advance(6 * 60_000);
    await w.in(id, aliceIn, { t: 'call_leave', id });
    await w.settle();

    const aliceMonth = month(w.lineOf(alice.uid).h.store);
    expect(aliceMonth?.scope).toBe('account');
    expect(aliceMonth?.counters.call?.minutes).toMatchObject({ turn: 6, lan: 6 });
    expect(month(w.lineOf(sam.uid).h.store)).toBeNull();
    expect(points.find((p) => p.indexes?.[0] === 'call')).toMatchObject({ blobs: ['account', alice.uid, alice.uid, expect.any(String)] });
    // Written once — by the room that measured it. The caller's line keeps the month row only (no second point).
    expect(points.filter((p) => p.indexes?.[0] === 'call')).toHaveLength(1);

    // The member reads their own month (Phase B's Usage card) over the socket they already have.
    await w.say(alice, alicePhone, { t: 'usage_get' });
    expect(alicePhone.msgs('usage').at(-1)).toMatchObject({ t: 'usage', usage: { scope: 'account', counters: { call: { minutes: { turn: 6 } } } }, allowances: { relayDataGb: 10, cloudCopyGb: 10 } });
  });

  it('a family call’s usage reaches the caller’s line; a second one inside the hour rides an open app, then is written', async () => {
    const c = clock();
    const alice = w.add({ uid: U(1), name: 'Alice', token: 'tok-alice' });
    const phone = await w.app(alice, 'alice-phone');
    const line = w.lineOf(alice.uid);
    const use = (minutes: number) => line.obj.fetch(new Request('https://line.internal/x/use', { method: 'POST', body: JSON.stringify({ kind: 'call', id: 'x', use: { minutes: { turn: minutes } } }) }));
    await use(5);
    expect(month(line.h.store)?.counters.call?.minutes.turn).toBe(5);
    c.advance(5 * 60_000);
    await use(3);
    expect(month(line.h.store)?.counters.call?.minutes.turn).toBe(5); // inside the hour
    expect((phone.deserializeAttachment() as { u?: { call?: { c: { minutes?: { turn?: number } } } } }).u?.call?.c.minutes?.turn).toBe(3);
    c.advance(H);
    await use(1);
    expect(month(line.h.store)?.counters.call?.minutes.turn).toBe(9);
    // Inside the next hour 2 more minutes ride the phone; it closes (twice — the second finds nothing):
    // they go back to memory exactly once and are written with the next call.
    c.advance(5 * 60_000);
    await use(2);
    line.h.drop(phone);
    await line.obj.webSocketClose(phone as never);
    await line.obj.webSocketClose(phone as never);
    c.advance(H);
    await use(0.5);
    expect(month(line.h.store)?.counters.call?.minutes.turn).toBe(11.5);
    const bogus = await line.obj.fetch(new Request('https://line.internal/x/use', { method: 'POST', body: JSON.stringify({ kind: 'bogus' }) }));
    expect(await bogus.json()).toEqual({ ok: false });
    // The MonitorRoom wrote each family call's point; the line's hourly writes add none (no double count).
    expect(points).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────── the Worker

describe('Worker — what it hands the rooms', () => {
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

  it('passes the segment’s byte length to /ingest', async () => {
    const bodies: Record<string, unknown>[] = [];
    const env = {
      ALLOWED_ORIGINS: '*',
      EVENT_ROOM: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (req: Request) => {
            const path = new URL(req.url).pathname;
            if (path === '/ingest') bodies.push((await req.json()) as Record<string, unknown>);
            return path === '/auth' ? new Response(null, { status: 204 }) : new Response('{"ok":true}');
          },
        }),
      },
      LIVE_BUCKET: { put: async () => undefined, delete: async () => undefined },
    } as unknown as Env;
    const res = await liveWorker.fetch(
      new Request('https://w.example/api/events/abc123/segments?seq=3&ms=6000', { method: 'POST', headers: { 'x-host-key': 'k', 'content-type': 'video/webm' }, body: new Uint8Array(1234) }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(bodies[0]).toMatchObject({ seq: 3, bytes: 1234 });
  });

  it('a segment GET never reaches a room (so never its storage)', async () => {
    const roomCalls: string[] = [];
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    const env = {
      ALLOWED_ORIGINS: '*',
      EVENT_ROOM: { idFromName: (id: string) => id, get: () => ({ fetch: async (r: Request) => (roomCalls.push(r.url), new Response('{}')) }) },
      LIVE_BUCKET: { get: async () => ({ body: new Uint8Array(3), httpMetadata: { contentType: 'video/webm' } }) },
    } as unknown as Env;
    const res = await liveWorker.fetch(new Request('https://w.example/api/events/abc123/segments/3'), env, ctx);
    expect(res.status).toBe(200);
    expect(roomCalls).toEqual([]);
  });

  it('registers a finished recording with the size R2 stored', async () => {
    const bodies: Record<string, unknown>[] = [];
    const env = {
      ALLOWED_ORIGINS: '*',
      EVENT_ROOM: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: async (req: Request) => {
            const path = new URL(req.url).pathname;
            if (path === '/rec/register') bodies.push((await req.json()) as Record<string, unknown>);
            return path === '/auth' ? new Response(null, { status: 204 }) : new Response('{"ok":true}');
          },
        }),
      },
      LIVE_BUCKET: { resumeMultipartUpload: () => ({ complete: async () => ({ size: 4321 }) }) },
    } as unknown as Env;
    const res = await liveWorker.fetch(
      new Request('https://w.example/api/events/abc123/recordings?op=complete', {
        method: 'POST',
        headers: { 'x-host-key': 'k' },
        body: JSON.stringify({ key: 'events/abc123/rec/1-a.webm', uploadId: 'u', parts: [{ partNumber: 1, etag: 'e' }], bytes: 99 }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(bodies[0]).toMatchObject({ bytes: 99, stored: 4321 });
  });
});
