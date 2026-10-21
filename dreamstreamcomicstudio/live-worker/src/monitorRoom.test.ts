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
  const join = async (token: string, mode: 'camera' | 'viewer', dev: string, extra: Record<string, unknown> = {}) => {
    const ws = new FakeWS();
    ws.serializeAttachment({ sid: `s-${dev}`, at: Date.now(), authed: false });
    state.acceptWebSocket(ws);
    await room.webSocketMessage(ws as never, JSON.stringify({ t: 'auth', token, mode, dev, dn: dev === 'crib' ? 'Crib iPhone' : 'Laptop', ...extra }));
    return ws;
  };
  const say = (ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));
  const subscribe = (ws: FakeWS, endpoint: string, prefs: Record<string, boolean> = {}) =>
    say(ws, { t: 'push_sub', sub: { endpoint, keys: { p256dh: 'p', auth: 'a' } }, prefs: { loud: false, ...prefs } });
  return { room, store, join, say, subscribe, alarm: () => alarm };
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
