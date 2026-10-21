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

import { MonitorRoom, sanitizeZones, type MonEnv } from './monitorRoom';

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
