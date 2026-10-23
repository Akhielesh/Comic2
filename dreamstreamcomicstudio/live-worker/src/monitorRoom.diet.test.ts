// @vitest-environment node
//
// MonitorRoom's cost diet and direct-first paths, piece by piece (feature doc §7 C3–C5; ADR 0006
// WS-6 / WS-9). The whole night, with the billing counted, is monitorRoom.night.test.ts.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushes: { endpoint: string; payload: Record<string, unknown> }[] = [];
vi.mock('./webpush', () => ({
  generateVapidKeys: async () => ({ publicKey: 'pub', privateKey: 'priv' }),
  isAllowedPushEndpoint: () => true,
  sendWebPush: async (sub: { endpoint: string }, payload: Record<string, unknown>) => {
    pushes.push({ endpoint: sub.endpoint, payload });
    return 'sent';
  },
}));

import { BEAT_STALE_MS, HIDDEN_GRACE_MS, relaySound, relaySoundOnly, WATCH_MS } from './monitorRoom';
import { monitorWorld, rowsWritten, WSPair, type KitWS, type MonitorWorld } from './monitorTestKit';
import { MONITOR_TURN_BPS, networkOf, relayDataState } from './monitorFair';
import { readHead } from './relayWire';
import { HIDDEN_GRACE_MS as CLIENT_GRACE } from '../../live/monitor/viewGate';
import { pack, unpack } from '../../live/monitor/relayWire';
import { emptyCounters, monthKey } from '../../shared/stream/usage';

const NID = '11111111-2222-4333-8444-555555555555';
const ROLES = {
  'tok-parent': { user_id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'parent', display_name: 'Alice', label: 'Mom' },
  'tok-care': { user_id: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'caregiver', display_name: 'Bob', label: 'Dad' },
};
const MIN = 60_000;

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
let T = Date.parse('2026-10-21T22:00:00Z');
beforeEach(() => {
  T = Date.parse('2026-10-21T22:00:00Z');
  vi.spyOn(Date, 'now').mockImplementation(() => T);
  vi.stubGlobal('WebSocketRequestResponsePair', WSPair);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pushes.length = 0;
});

function world(): MonitorWorld {
  const w = monitorWorld({ SQL, nid: NID, roles: ROLES });
  vi.stubGlobal('fetch', w.fetchStub);
  return w;
}

const row = (m: number, over: Record<string, unknown> = {}) => ({ m, laeq: 32, lmax: 40, l10: 34, l50: 31, l90: 29, lpk: 50, cal: 1, motion: 2, mmax: 5, crib: 1, outside: 0, light: 20, state: 1, sounds: {}, visit: 0, ...over });
const minute = () => Math.floor(T / MIN) * MIN;

/** Run the alarm whenever it's due between now and `ms` from now, a second at a time. */
async function wait(w: MonitorWorld, ms: number, each?: (t: number) => Promise<void> | void) {
  const end = T + ms;
  while (T < end) {
    T += 1000;
    await w.runAlarmIfDue(T);
    await each?.(T);
  }
}

describe('watchdog: a dead man’s switch on the camera’s own proof of life', () => {
  it('keepalive pings alone keep a quiet camera alive — no alert, and no alarm wakes while it pings', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    await w.join('tok-parent', 'viewer', 'phone');
    const before = w.counts.alarms;
    // 10 minutes with no message at all from the camera, only its 25 s pings.
    await wait(w, 10 * MIN, (t) => {
      if (Math.floor(t / 1000) % 25 === 0) w.ping(cam);
    });
    expect(w.room.store.events({ kinds: ['offline'] })).toHaveLength(0);
    // Pings wake nothing; only the switch itself went off (it looks, sees a fresh ping, sets itself again).
    expect(w.counts.alarms - before).toBeLessThanOrEqual(Math.ceil((10 * MIN) / (WATCH_MS - 25_000)));
  });

  it('a camera that goes silent (no message, no ping) is reported 75–105 s later — then back when it speaks', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    await w.deliver(mom, { t: 'push_sub', sub: { endpoint: 'https://push.test/mom', keys: { p256dh: 'p', auth: 'a' } }, prefs: {} });
    const silentFrom = T;
    let reportedAt: number | null = null;
    await wait(w, 3 * MIN, () => {
      if (reportedAt == null && w.room.store.events({ kinds: ['offline'] }).length) reportedAt = T;
    });
    expect(reportedAt).not.toBeNull();
    expect(reportedAt! - silentFrom).toBeGreaterThanOrEqual(BEAT_STALE_MS);
    expect(reportedAt! - silentFrom).toBeLessThanOrEqual(WATCH_MS);
    expect(pushes.map((p) => p.payload.title)).toContain('Baby camera not responding');
    expect(w.room.store.activeIncidents()[0]).toMatchObject({ kind: 'offline', status: 'open' });
    // It speaks again: back online, the incident closes.
    await w.deliver(cam, { t: 'beat' });
    expect(w.room.store.events({ kinds: ['online'] })[0].msg).toBe('Crib iPhone is responding again');
    expect(w.room.store.activeIncidents()).toHaveLength(0);
  });

  it('survives hibernation: the proof of life rides the camera’s socket, not the room’s memory', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    await w.deliver(cam, { t: 'beat' });
    w.hibernate();
    await wait(w, 60_000, () => void w.hibernate());
    expect(w.room.store.events({ kinds: ['offline'] })).toHaveLength(0);
    await wait(w, 60_000, () => void w.hibernate());
    expect(w.room.store.events({ kinds: ['offline'] })).toHaveLength(1);
  });

  it('a camera’s messages push the switch later only when it is close: about a row a minute, never a row a message', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const set0 = w.counts.setAlarms;
    // A status every 2 s for 10 minutes (an app from before this change).
    await wait(w, 10 * MIN, async (t) => {
      if (Math.floor(t / 1000) % 2 === 0) await w.deliver(cam, { t: 'status', st: { state: 'calm' } });
    });
    expect(w.room.store.events({ kinds: ['offline'] })).toHaveLength(0);
    expect(w.counts.setAlarms - set0).toBeLessThanOrEqual(10);
  });
});

describe('minute rows: batched, acknowledged only once written, never lost', () => {
  it('holds up to 4 fresh minutes on the camera’s socket (reads include them), writes the 5th as one block', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    const rows: ReturnType<typeof row>[] = [];
    const sql0 = w.counts.sqlRows;
    for (let i = 0; i < 4; i++) {
      T += MIN;
      rows.push(row(minute() - MIN, { laeq: 30 + i }));
      await w.deliver(cam, { t: 'stats', rows });
    }
    expect(cam.msgs('stats_ok')).toHaveLength(0);
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(0);
    expect(w.counts.sqlRows).toBe(sql0);
    // Live charts got each minute once, though the phone resent the earlier ones.
    expect(mom.msgs('minutes').flatMap((m) => m.rows as unknown[])).toHaveLength(4);
    // A history read sees them all the same.
    await w.deliver(mom, { t: 'q', id: 'h', q: 'history', from: rows[0].m, to: T + MIN });
    expect((mom.last('r') as { pts: unknown[] }).pts).toHaveLength(4);
    T += MIN;
    rows.push(row(minute() - MIN));
    await w.deliver(cam, { t: 'stats', rows });
    expect(cam.last('stats_ok')).toMatchObject({ upto: rows[4].m });
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(5);
    // One block written (two if the batch straddled an hour) — not 3 rows a minute.
    expect(w.counts.sqlRows - sql0).toBeLessThanOrEqual(2);
  });

  it('writes the waiting minutes when the camera stops (bye) and when its socket closes', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    T += MIN;
    await w.deliver(cam, { t: 'stats', rows: [row(minute() - MIN)] });
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(0);
    await w.deliver(cam, { t: 'bye' });
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(1);
    expect(cam.last('stats_ok')).toBeTruthy();

    const cam2 = await w.join('tok-parent', 'camera', 'crib');
    T += MIN;
    await w.deliver(cam2, { t: 'stats', rows: [row(minute() - MIN)] });
    w.hibernate(); // nothing in memory…
    await w.close(cam2); // …and the socket's waiting minute is still written
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(2);
  });

  it('writes at once when the minutes change the sleep tracker, so "fell asleep" is never late', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib', { tz: 'UTC' });
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    const asleep = () => mom.msgs('log').filter((m) => (m.entry as { kind: string }).kind === 'asleep').length;
    // Six quiet minutes arrive together (a backlog): written at once.
    const base = minute() - 6 * MIN;
    await w.deliver(cam, { t: 'stats', rows: Array.from({ length: 6 }, (_, i) => row(base + i * MIN)) });
    expect(cam.msgs('stats_ok')).toHaveLength(1);
    // Three more, one a minute: they wait (nothing to tell yet).
    const sent: ReturnType<typeof row>[] = [];
    for (let i = 6; i < 9; i++) {
      T += MIN;
      sent.push(row(base + i * MIN));
      await w.deliver(cam, { t: 'stats', rows: sent });
    }
    expect(cam.msgs('stats_ok')).toHaveLength(1);
    expect(asleep()).toBe(0);
    // The tenth quiet minute: asleep — written and told now, not at the end of a batch.
    T += MIN;
    sent.push(row(base + 9 * MIN));
    await w.deliver(cam, { t: 'stats', rows: sent });
    expect(asleep()).toBe(1);
    expect(cam.last('stats_ok')).toMatchObject({ upto: base + 9 * MIN });
  });

  it('writes the waiting minutes with an alert, so the history around it is safe', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    T += MIN;
    await w.deliver(cam, { t: 'stats', rows: [row(minute() - MIN)] });
    await w.deliver(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
    expect(w.room.store.minutes(0, T + MIN, 'crib')).toHaveLength(1);
  });

  it('the 24 h strip in hello comes from the minutes (no timeline blob is kept)', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    T += 2 * MIN;
    await w.deliver(cam, { t: 'stats', rows: [row(minute() - 2 * MIN), row(minute() - MIN, { state: 5, sounds: { cry: 40 } })] });
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    const tl = (mom.last('hello') as { tl: [number, number, number][] }).tl;
    expect(tl).toEqual([[Math.floor((minute() - 2 * MIN) / (5 * MIN)) * 5 * MIN, 5, 20]]);
    expect(w.store.has('tl')).toBe(false);
  });

  it('turns the per-minute table into hour blocks once, then drops it', async () => {
    const db = new SQL.Database();
    const sql = {
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
    sql.exec(`CREATE TABLE mon_minutes (dev TEXT NOT NULL, m INTEGER NOT NULL, laeq REAL, lmax REAL, l10 REAL, l50 REAL, l90 REAL, lpk REAL, cal INTEGER NOT NULL DEFAULT 0,
      motion REAL, mmax REAL, crib REAL, outside REAL, light REAL, state INTEGER, sounds TEXT, visit INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (dev, m))`);
    const m0 = Math.floor(T / (60 * MIN)) * 60 * MIN - 3 * 60 * MIN;
    for (let i = 0; i < 150; i++) sql.exec(`INSERT INTO mon_minutes VALUES ('crib', ?, 31, 38, 33, 30, 28, 50, 1, 2, 5, 1, 0, 20, 1, ?, 0)`, m0 + i * MIN, i === 7 ? '{"cry":12}' : '{}');
    const { MonitorStore } = await import('./monitorStore');
    const store = new MonitorStore(sql);
    store.init();
    const got = store.minutes(m0, m0 + 150 * MIN, 'crib');
    expect(got).toHaveLength(150);
    expect(got[7].sounds).toEqual({ cry: 12 });
    expect(got[0]).toMatchObject({ laeq: 31, cal: 1, state: 1, visit: 0 });
    expect(sql.exec(`SELECT name FROM sqlite_master WHERE name = 'mon_minutes'`).toArray()).toHaveLength(0);
    expect(sql.exec(`SELECT COUNT(*) AS n FROM mon_blocks`).toArray()[0].n).toBe(3);
  });
});

describe('live status only while someone needs it from the room (live_want)', () => {
  it('on while a viewer is on screen without the camera’s data channel; off once it is, or hidden', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: false }); // nobody watching yet
    expect((cam.last('hello') as { caps: string[] }).caps).toContain('view');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: true });
    await w.deliver(mom, { t: 'view', vis: true, dc: true, dev: 'crib' });
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: false });
    await w.deliver(mom, { t: 'view', vis: true, dc: false });
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: true });
    await w.deliver(mom, { t: 'view', vis: false, dc: false });
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: false });
    // Sent only on change.
    const n = cam.msgs('live_want').length;
    await w.deliver(mom, { t: 'view', vis: false, dc: true });
    expect(cam.msgs('live_want')).toHaveLength(n);
  });

  it('an app that never says `view` always counts as watching live (as before this change)', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const old = await w.join('tok-care', 'viewer', 'laptop');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    await w.deliver(mom, { t: 'view', vis: false, dc: false });
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: true });
    await w.close(old);
    expect(cam.last('live_want')).toEqual({ t: 'live_want', on: false });
  });

  it('a new viewer sees a live camera as live, even between its once-a-minute statuses', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    await w.deliver(cam, { t: 'status', st: { state: 'calm' } });
    T += 50_000;
    w.ping(cam);
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    const c = (mom.last('hello') as { cams: { statusAt: number }[] }).cams[0];
    expect(T - c.statusAt).toBeLessThan(1000);
  });
});

describe('hidden viewers: sound only (C5)', () => {
  let seq = 0;
  const video = (key = false) => pack({ kind: 'video', key, seq: seq++, ts: seq * 66, codec: 'vp8', body: new Uint8Array(2000).fill(7), audio: new Uint8Array(400).fill(0x7f) });
  const kinds = (ws: KitWS) => ws.bin.map((b) => unpack(b)?.kind ?? '?');

  it('a viewer hidden past the grace gets the relay’s sound, never its picture; shown again, the picture comes back on a key frame', async () => {
    expect(HIDDEN_GRACE_MS).toBe(CLIENT_GRACE);
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    await w.deliver(mom, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    const frame = async (key = false) => {
      T += 66;
      await w.deliver(cam, video(key));
      const s = unpack(mom.bin.at(-1)!);
      if (s) await w.deliver(mom, { t: 'rx', s: s.seq });
    };
    await frame(true);
    await frame();
    expect(kinds(mom)).toEqual(['video', 'video']);
    await w.deliver(mom, { t: 'view', vis: false, dc: false });
    await frame(); // inside the grace: still the picture
    expect(kinds(mom).at(-1)).toBe('video');
    T += HIDDEN_GRACE_MS;
    mom.bin.length = 0;
    for (let i = 0; i < 5; i++) await frame(i === 2);
    expect(kinds(mom)).toEqual(['audio', 'audio', 'audio', 'audio', 'audio']);
    // The camera is told nobody needs its picture (v: 0), so it stops encoding video.
    expect(cam.last('relay_want')).toMatchObject({ n: 1, v: 0 });
    const keys = cam.msgs('relay_key').length;
    await w.deliver(mom, { t: 'view', vis: true, dc: false });
    expect(cam.last('relay_want')).toMatchObject({ n: 1, v: 1 });
    mom.bin.length = 0;
    T += 1000;
    await frame(); // a delta: the picture waits for a key frame (asked for), the sound doesn't
    expect(cam.msgs('relay_key').length).toBeGreaterThan(keys);
    await frame(true);
    expect(kinds(mom)).toEqual(['audio', 'video']);
  });

  it('routing: only sound ever leaves for a sound-only viewer', () => {
    const v = video(true);
    const head = readHead(v)!;
    expect(unpack(relaySound(head, v, 2)!)?.kind).toBe('audio');
    const j = pack({ kind: 'jpeg', seq: 1, ts: 1, body: Uint8Array.of(0xff, 0xd8, 0xff, 1) });
    expect(relaySound(readHead(j)!, j, 2)).toBeNull();
    expect(relaySound(head, v, undefined)).toBeNull();
    expect(relaySoundOnly({ vis: false, hz: 0 }, HIDDEN_GRACE_MS - 1)).toBe(false);
    expect(relaySoundOnly({ vis: false, hz: 0 }, HIDDEN_GRACE_MS)).toBe(true);
    expect(relaySoundOnly({ fl: 'out' }, 0)).toBe(true);
  });
});

describe('same network as the camera: the direct picture first (C3)', () => {
  it('a viewer on the camera’s network learns it (a yes, never an address) and gets no instant picture through the server', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib', {}, { ip: '203.0.113.7' });
    const mom = await w.join('tok-parent', 'viewer', 'phone', {}, { ip: '203.0.113.7' });
    const away = await w.join('tok-care', 'viewer', 'laptop', {}, { ip: '198.51.100.9' });
    expect((mom.last('hello') as { near: string[] }).near).toEqual(['crib']);
    expect((away.last('hello') as { near: string[] }).near).toEqual([]);
    expect(JSON.stringify(mom.sent)).not.toContain('203.0.113');
    await w.deliver(mom, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'], instant: true });
    await w.deliver(away, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'], instant: true });
    expect(cam.last('relay_want')).toMatchObject({ n: 1 });
    await w.deliver(cam, pack({ kind: 'video', key: true, seq: 1, ts: 1, codec: 'vp8', body: new Uint8Array(100) }));
    expect(mom.bin).toHaveLength(0); // 0 instant-relay frames to a same-network viewer
    expect(away.bin).toHaveLength(1);
    // Its direct picture really failed: it asks again (not instant) and gets the relay.
    await w.deliver(mom, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    expect(cam.last('relay_want')).toMatchObject({ n: 2 });
  });

  it('networks: an IPv4 address, or an IPv6 /64 (a phone on mobile data has its own)', () => {
    expect(networkOf('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkOf('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkOf('2001:db8:aa:1::5')).toBe(networkOf('2001:0db8:00aa:0001:ffff:1:2:3'));
    expect(networkOf('2001:db8:aa:1::5')).not.toBe(networkOf('2001:db8:aa:2::5'));
    expect(networkOf('nonsense')).toBeNull();
    expect(networkOf('')).toBeNull();
    expect(networkOf('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('relay data used up: sound only + the direct picture (fair use)', () => {
  const out = () => ({ month: monthKey(T), scope: 'nursery', counters: { monitor: { ...emptyCounters(), turnBytes: 10.5e9 } }, updatedAt: T - 2 * 60 * MIN });

  it('at 100% every monitor socket is told; relay viewers get sound only, nothing else is cut', async () => {
    const w = world();
    w.store.set(`use:${monthKey(T)}`, out());
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    expect((cam.last('hello') as { fair: { level: string } }).fair).toMatchObject({ level: 'out', ofGb: 10, usedGb: 10.5 });
    expect((mom.last('hello') as { fair: { level: string } }).fair.level).toBe('out');
    await w.deliver(mom, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    expect(cam.last('relay_want')).toMatchObject({ n: 1, v: 0 });
    await w.deliver(cam, pack({ kind: 'video', key: true, seq: 1, ts: 1, codec: 'vp8', body: new Uint8Array(100), audio: new Uint8Array(80) }));
    expect(mom.bin.map((b) => unpack(b)?.kind)).toEqual(['audio']);
    // Alerts are untouched.
    await w.deliver(cam, { t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
    expect(mom.msgs('log').some((m) => (m.entry as { kind: string }).kind === 'cry')).toBe(true);
  });

  it('crossing the allowance mid-month tells everyone once; a viewer can’t claim more than a monitor can receive', async () => {
    const w = world();
    w.store.set(`use:${monthKey(T)}`, { ...out(), counters: { monitor: { ...emptyCounters(), turnBytes: 9.98e9 } } });
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const mom = await w.join('tok-parent', 'viewer', 'phone');
    expect((mom.last('hello') as { fair: { level: string } }).fair.level).toBe('warn');
    // One report of 50 GB from a socket that's 1 minute old: clamped to ≈ 2 Mbps × 2 min.
    T += MIN;
    await w.deliver(mom, { t: 'use', turnBytes: 50e9 });
    const fair = mom.last('fair') as { relay: { level: string; usedGb: number } };
    expect(fair.relay.level).toBe('out');
    expect(fair.relay.usedGb).toBeLessThanOrEqual(9.98 + ((120 * MONITOR_TURN_BPS) / 8) / 1e9 + 0.05);
    expect(cam.msgs('fair')).toHaveLength(1);
    await w.deliver(mom, { t: 'use', turnBytes: 50e9 });
    expect(mom.msgs('fair')).toHaveLength(1);
  });

  it('levels: ok under 80%, warn from 80%, out at 100%; a new month starts over', () => {
    const now = T;
    const at = (gb: number) => relayDataState({ month: monthKey(now), scope: 'nursery', counters: { monitor: { ...emptyCounters(), turnBytes: gb * 1e9 } }, updatedAt: 0 }, now).level;
    expect([at(1), at(8), at(10)]).toEqual(['ok', 'warn', 'out']);
    expect(relayDataState({ month: '2026-09', scope: 'nursery', counters: { monitor: { ...emptyCounters(), turnBytes: 20e9 } }, updatedAt: 0 }, now).level).toBe('ok');
  });
});

describe('fewer writes for the same things', () => {
  it('a reconnect doesn’t rewrite the nursery’s name; a privacy pause rides the camera’s socket across hibernation', async () => {
    const w = world();
    const cam = await w.join('tok-parent', 'camera', 'crib');
    const puts = w.counts.kvPuts;
    await w.join('tok-parent', 'viewer', 'phone');
    expect(w.counts.kvPuts).toBe(puts);
    const mom = w.sockets.at(-1)!;
    await w.deliver(mom, { t: 'relay', on: true, dev: 'crib', codecs: ['vp8'] });
    await w.deliver(cam, { t: 'event', kind: 'privacy', on: true });
    w.hibernate();
    await w.deliver(cam, pack({ kind: 'video', key: true, seq: 1, ts: 1, codec: 'vp8', body: new Uint8Array(100) }));
    expect(mom.bin).toHaveLength(0);
    expect(rowsWritten(w.counts)).toBeLessThan(40);
  });
});
