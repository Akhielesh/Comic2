// @vitest-environment node
//
// A deterministic 12 h night in one nursery — a camera and two viewers, hidden most of the
// night — run second by second against the real MonitorRoom on real SQLite (sql.js), counting
// what Cloudflare bills (monitorTestKit.ts): DO requests, rows written, alarm wakes, and a
// duration proxy. It asserts ADR 0006 WS-9's per-active-nursery-day targets (feature doc §7 C4):
//   DO requests ≤ 1,000 · rows written ≤ 1,800 · DO duration ≤ 40 GB-s
// — and that nothing a family relies on was lost on the way: every minute of history, both
// cries with their alerts and escalation, the sleep report, no false "camera offline", and a
// real one when the camera phone dies.
//
// The room "hibernates" (a fresh MonitorRoom on the same storage and sockets: memory gone)
// after every 10 s without an event, as Cloudflare does with hibernatable sockets — so the
// night also proves the room keeps nothing that matters only in memory.
//
// BEFORE: the same night with the apps and room of 87082ad (status every 2 s, a 15 s alarm
// rewriting the 7-day timeline blob, a row per minute with two indexes). Measured by running
// `runNight({ clients: 'legacy' })` against 87082ad's monitorRoom.ts + monitorStore.ts (the
// harness only drives the room's public API, so it runs unchanged on both). Recorded below.
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

import { billedRequests, monitorWorld, rowsWritten, WSPair, type Counts, type KitWS, type MonitorWorld } from './monitorTestKit';
import { StatusCadence } from '../../live/monitor/statusCadence';
import { ViewGate } from '../../live/monitor/viewGate';

const NID = '11111111-2222-4333-8444-555555555555';
const ROLES = {
  'tok-parent': { user_id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'parent', display_name: 'Alice', label: 'Mom' },
  'tok-care': { user_id: 'aaaaaaaa-0000-4000-8000-000000000002', role: 'caregiver', display_name: 'Bob', label: 'Dad' },
};
/** What the sockets keep (everything else is only counted, so a night stays small). */
const KEEP = new Set(['hello', 'live_want', 'stats_ok', 'incident', 'log', 'r', 'error', 'sleep', 'fair']);

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pushes.length = 0;
});

const MIN = 60_000;
const T0 = Date.parse('2026-10-21T19:00:00Z');
const NIGHT_S = 12 * 3600;
/** Crying episodes (minutes from 19:00): 21:30 for 6 min, 04:00 for 7 min. Awake from 06:30. */
const CRIES: [number, number][] = [[150, 156], [540, 547]];
const AWAKE_FROM = 690;
/** Each viewer's screen: shown windows, in minutes (hidden otherwise: the phone locked, the tab behind). */
const MOM_SHOWN: [number, number][] = [[0, 15], [150.5, 160], [540.5, 552], [690, 720]];
const DAD_SHOWN: [number, number][] = [[0, 5]];

const inAny = (m: number, ws: [number, number][]) => ws.some(([a, b]) => m >= a && m < b);
const stateAt = (min: number) => (inAny(min, CRIES) ? 'crying' : min >= AWAKE_FROM ? 'awake' : 'calm');

/**
 * ADR 0006 WS-9 / feature doc §7 C4: per active nursery-day. The night here is 13 h of the
 * room's life (12 h of camera, then an hour for whatever it still has to do).
 */
export const TARGET = { requests: 1000, rows: 1800, gbSeconds: 40 };

/**
 * The same night at 87082ad (before this change), with the apps of that day — measured once with
 * this harness against that commit's room (see the header). Kept so the saving stays visible.
 */
export const BEFORE = { requests: 4261, rows: 11898, alarms: 2880, wakes: 25206, gbSeconds: 63, statusSent: 21588 };

export interface NightResult {
  counts: Counts;
  requests: number;
  rows: number;
  /** Alarm wakes plus delivered messages (auto-answered pings wake nothing). */
  wakes: number;
  gbSeconds: number;
  statusSent: number;
  world: MonitorWorld;
  mom: KitWS;
  dad: KitWS;
  /** Minute rows the camera still holds unacknowledged at the end (0 = the room has all of them). */
  unacked: number;
  /** Minute rows the history holds for the night (720 = none lost). */
  minutesStored: number;
  logKinds: Record<string, number>;
  /** Push titles, in order. */
  pushTitles: string[];
  /** When the room first logged the camera as offline / not responding (null: never). */
  offlineAt: number | null;
}

/** A duration proxy: each wake (an alarm or a delivered message) keeps the 128 MB object active ≈ 20 ms. */
const WAKE_MS = 20;

export interface NightOptions {
  /**
   * 'current': the apps of this change (status on change + 60 s keepalive unless the room asks
   * for live status; viewers say when their screen is hidden). 'legacy': the apps of 87082ad
   * (status every 2 s, no `view`) — the "before" night, and an old app against the new room.
   */
  clients?: 'current' | 'legacy';
  /** The camera phone dies here (a half-open socket: no close, no pings, no messages). */
  cameraDiesAtMin?: number;
  /** Mom answers the alerts when she looks (default). false: nobody answers the second cry. */
  ackSecondCry?: boolean;
}

export async function runNight(opts: NightOptions = {}): Promise<NightResult> {
  const legacy = opts.clients === 'legacy';
  let T = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => T);
  vi.stubGlobal('WebSocketRequestResponsePair', WSPair);
  const w = monitorWorld({ SQL, nid: NID, roles: ROLES, keep: (t) => KEEP.has(t) });
  vi.stubGlobal('fetch', w.fetchStub);

  // Steady state, not a fresh nursery: the night 31 days ago is still in the history (its minutes
  // age out tonight), and so are the events and alerts of 90 days ago — the retention purge that
  // runs tonight deletes them, and deletes are billed as rows written too.
  await w.room.ready;
  const old = T0 - 31 * 24 * 60 * MIN - 12 * 60 * MIN;
  for (let i = 0; i < 720; i++) {
    w.room.store.putMinute({ dev: 'crib', m: old + i * MIN, laeq: 31, lmax: 38, l10: 33, l50: 30, l90: 28, lpk: 50, cal: 1, motion: 2, mmax: 5, crib: 1, outside: 0, light: 20, state: 1, sounds: {}, visit: 0 });
  }
  const older = T0 - 90 * 24 * 60 * MIN - 12 * 60 * MIN;
  for (let i = 0; i < 30; i++) w.room.store.addEvent({ id: `old${i}`, at: older + i * 20 * MIN, kind: 'cry', sev: 'urgent', msg: 'Aria is crying · Crib iPhone' });
  w.room.store.addIncident({ id: 'oldinc', at: older, kind: 'cry', sev: 'urgent', title: 'Aria is crying', dev: 'crib', status: 'resolved', ack_by: 'Mom', ack_at: older + MIN, resolved_at: older + 5 * MIN, pushes: 1, next_at: null });
  w.store.set('purgedAt', T0 - 60 * MIN);
  for (const k of Object.keys(w.counts) as (keyof Counts)[]) w.counts[k] = 0;

  let lastEvent = T;
  let asleep = false;
  const touch = () => {
    lastEvent = T;
    asleep = false;
  };

  // ---- the camera phone
  const cadence = new StatusCadence();
  let cam: KitWS | null = null;
  let camSeen = { live: 0, ok: 0, hello: 0 };
  let unacked: Record<string, unknown>[] = [];
  let worst = 1;
  let cryAcc = 0;
  let statusSent = 0;
  const camRead = () => {
    if (!cam) return;
    const hellos = cam.msgs('hello');
    if (hellos.length > camSeen.hello) cadence.reset();
    for (const m of cam.msgs('live_want').slice(camSeen.live)) cadence.setLive(!!m.on);
    for (const m of cam.msgs('stats_ok').slice(camSeen.ok)) unacked = unacked.filter((r) => Number(r.m) > Number(m.upto));
    camSeen = { live: cam.msgs('live_want').length, ok: cam.msgs('stats_ok').length, hello: hellos.length };
  };
  const camSay = async (msg: unknown) => {
    if (!cam) return;
    touch();
    await w.deliver(cam, msg);
    camRead();
  };
  /** The phone closes each minute's row and sends every row the room hasn't acknowledged yet. */
  const addMinuteRow = async (m: number, send: boolean) => {
    unacked = [...unacked.filter((r) => r.m !== m), {
      m, laeq: 31, lmax: 38, l10: 33, l50: 30, l90: 28, lpk: 50, cal: 1, motion: worst === 1 ? 2 : 40, mmax: 5, crib: worst === 1 ? 1 : 35, outside: 0, light: 20,
      state: worst, sounds: cryAcc ? { cry: cryAcc } : worst === 2 ? { babble: 20 } : {}, visit: 0,
    }].slice(-240);
    worst = 1;
    cryAcc = 0;
    if (send) await camSay({ t: 'stats', rows: unacked });
  };
  const camJoin = async () => {
    cam = await w.join('tok-parent', 'camera', 'crib', { tz: 'UTC' });
    camSeen = { live: 0, ok: 0, hello: 0 };
    touch();
    camRead();
    if (unacked.length) await camSay({ t: 'stats', rows: unacked });
  };

  // ---- the viewers
  type V = { ws: KitWS | null; dev: string; token: string; shown: [number, number][]; gate: ViewGate; dcAt: number; seen: number; open: Set<string> };
  const viewers: V[] = [
    { ws: null, dev: 'mom-phone', token: 'tok-parent', shown: MOM_SHOWN, gate: new ViewGate(), dcAt: 0, seen: 0, open: new Set() },
    { ws: null, dev: 'dad-laptop', token: 'tok-care', shown: DAD_SHOWN, gate: new ViewGate(), dcAt: 0, seen: 0, open: new Set() },
  ];
  const vSay = async (v: V, msg: unknown) => {
    if (!v.ws) return;
    touch();
    await w.deliver(v.ws, msg);
  };
  const vJoin = async (v: V) => {
    v.ws = await w.join(v.token, 'viewer', v.dev);
    touch();
    v.gate.reset();
    v.gate.dcClosed();
    v.dcAt = T + 3000; // the direct picture (and its data channel) is up 3 s later, on the home Wi-Fi
    await vSay(v, { t: 'push_sub', sub: { endpoint: `https://push.test/${v.dev}`, keys: { p256dh: 'p', auth: 'a' } }, prefs: { loud: false } });
  };
  const vTick = async (v: V, min: number) => {
    if (!v.ws) return;
    const shown = inAny(min, v.shown);
    // The data channel delivers the camera's status every 2 s once the call is up.
    if (T >= v.dcAt && cam && !dead && T % 2000 === 0) v.gate.dcMessage(T);
    if (!legacy) {
      v.gate.setShown(shown);
      const due = v.gate.due(T);
      if (due) await vSay(v, { t: 'view', ...due });
    }
    // Mom, looking at her phone, answers an open alert ("I'm on it").
    for (const m of v.ws.msgs('incident').slice(v.seen)) {
      const inc = m.inc as { id: string; status: string };
      if (inc.status === 'open') v.open.add(inc.id);
      else v.open.delete(inc.id);
    }
    v.seen = v.ws.msgs('incident').length;
    if (shown && v.dev === 'mom-phone' && (opts.ackSecondCry !== false || min < CRIES[1][0])) {
      for (const id of [...v.open]) {
        v.open.delete(id);
        await vSay(v, { t: 'ack', inc: id });
      }
    }
  };

  let dead = false;
  const sockOffset = new Map<KitWS, number>();

  await camJoin();
  T += 10_000;
  await vJoin(viewers[0]);
  T += 10_000;
  await vJoin(viewers[1]);

  // The night's reconnects: the camera's socket drops once (Wi-Fi blip), each viewer's once.
  const reconnect = new Map<number, () => Promise<void>>([
    [240 * 60, async () => { if (cam && !dead) await w.close(cam); cam = null; }],
    [240 * 60 + 3, async () => { if (!dead) await camJoin(); }],
    [300 * 60, async () => { await w.close(viewers[0].ws!); viewers[0].ws = null; }],
    [300 * 60 + 5, () => vJoin(viewers[0])],
    [420 * 60, async () => { await w.close(viewers[1].ws!); viewers[1].ws = null; }],
    [420 * 60 + 8, () => vJoin(viewers[1])],
  ]);

  for (let s = 20; s < NIGHT_S; s++) {
    T = T0 + s * 1000;
    const min = s / 60;
    if (await w.runAlarmIfDue(T)) touch();
    const step = reconnect.get(s);
    if (step) await step();
    if (opts.cameraDiesAtMin != null && min >= opts.cameraDiesAtMin && !dead) dead = true;
    const camAlive = !!cam && !dead;
    const state = stateAt(min);
    if (camAlive) {
      // Sound events, as the camera's detector reports them.
      for (const [a, b] of CRIES) {
        if (s === a * 60) await camSay({ t: 'event', kind: 'sound', cat: 'cry', phase: 'start', conf: 90 });
        if (s === b * 60) await camSay({ t: 'event', kind: 'sound', cat: 'cry', phase: 'end', conf: 90, secs: (b - a) * 60 });
      }
      if (s === AWAKE_FROM * 60 + 30) await camSay({ t: 'event', kind: 'sound', cat: 'babble', phase: 'start', conf: 70 });
      worst = Math.max(worst, state === 'crying' ? 5 : state === 'awake' ? 2 : 1);
      if (state === 'crying') cryAcc += 1;
      // The status ticker (every 2 s). The legacy app sends every tick; the current one only
      // when it's news, every 60 s, or every tick while the room asks for live status.
      if (s % 2 === 0) {
        const st = {
          state, level: Math.round(10 + 5 * Math.sin(s / 7)), motion: state === 'calm' ? 2 : 40, light: 20, battery: 100, charging: true, soothing: null,
          cry: state === 'crying' ? 90 : 3, sound: state === 'crying' ? 'cry' : state === 'awake' ? 'babble' : null, conf: 80, top: [], model: 'ready', paused: null,
          awake: 'native', talk: null, call: null, spl: { db: 32, leq: 31, max: 40, cal: true }, crib: state === 'calm' ? 1 : 30, outside: 0, visit: false, scene: null,
          enc: { peers: 2, fps: 24, lim: 'none', impl: 'MediaCodec', w: 1280, p: 0, relay: 0 },
        };
        if (legacy || cadence.due(st, T)) {
          statusSent += 1;
          await camSay({ t: 'status', st });
        }
      }
    }
    // A minute row as each minute ends — the phone measures whether or not the room hears it,
    // and keeps every row until the room acknowledges it.
    if (s % 60 === 1 && !dead) await addMinuteRow(T - 61_000 - ((T - 61_000) % MIN), camAlive);
    for (const v of viewers) await vTick(v, min);
    // Phase B's path report from each viewer, every 15 minutes (cumulative; display only).
    if (!legacy && s % 900 === 450) for (const v of viewers) await vSay(v, { t: 'use', minutes: { lan: (s - 20) / 60 } });
    // Keepalive pings (every 25 s): answered by the runtime, no wake — counted as billed anyway.
    for (const ws of [...w.sockets]) {
      if (dead && ws === cam) continue;
      if (!sockOffset.has(ws)) sockOffset.set(ws, (sockOffset.size * 7) % 25);
      if ((s - sockOffset.get(ws)!) % 25 === 0) w.ping(ws);
    }
    if (!asleep && T - lastEvent >= 10_000) {
      w.hibernate();
      asleep = true;
    }
  }

  // Morning: the parent stops the camera (its last minute, a bye, the socket closes).
  T = T0 + NIGHT_S * 1000;
  if (cam && !dead) {
    await addMinuteRow(T - MIN, true);
    await camSay({ t: 'bye' });
    await w.close(cam);
  }
  // An hour of quiet: whatever the room still has to do (an open sleep session, a camera that
  // never came back), the alarm does it.
  for (let s = 0; s < 3600; s++) {
    T += 1000;
    if (await w.runAlarmIfDue(T)) touch();
    if (!asleep && T - lastEvent >= 10_000) {
      w.hibernate();
      asleep = true;
    }
  }
  const counts = { ...w.counts };
  const wakes = counts.alarms + counts.delivered;
  return {
    counts,
    requests: billedRequests(counts),
    rows: rowsWritten(counts),
    wakes,
    gbSeconds: ((wakes * WAKE_MS) / 1000) * 0.125,
    statusSent,
    world: w,
    mom: viewers[0].ws!,
    dad: viewers[1].ws!,
    unacked: unacked.length,
    minutesStored: w.room.store.minutes(T0 - MIN, T0 + NIGHT_S * 1000 + MIN, 'crib').length,
    logKinds: w.room.store.events({ since: T0, limit: 500 }).reduce<Record<string, number>>((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {}),
    pushTitles: pushes.map((p) => String(p.payload.title)),
    offlineAt: w.room.store.events({ since: T0, limit: 500, kinds: ['offline'] }).at(-1)?.at ?? null,
  };
}

const summary = (r: NightResult) => ({
  requests: Math.round(r.requests), rows: r.rows, alarms: r.counts.alarms, wakes: r.wakes, gbSeconds: Math.round(r.gbSeconds * 10) / 10,
  statusSent: r.statusSent, minutes: r.minutesStored, unacked: r.unacked, logs: r.logKinds, pushes: r.pushTitles.length, counts: r.counts,
});

describe('MonitorRoom: a 12 h night costs what ADR 0006 WS-9 budgets', () => {
  it('meets the per-active-nursery-day targets with the current apps — and loses nothing a family relies on', async () => {
    const r = await runNight();
    // ADR 0006 WS-9 (feature doc §7 C4): DO requests ≤ 1,000 · rows written ≤ 1,800 · ≤ 40 GB-s.
    expect(r.requests).toBeLessThanOrEqual(TARGET.requests);
    expect(r.rows).toBeLessThanOrEqual(TARGET.rows);
    expect(r.gbSeconds).toBeLessThanOrEqual(TARGET.gbSeconds);
    // Against the same night before this change (87082ad: 4,261 requests, 11,898 rows, 2,880 alarms).
    expect(r.requests).toBeLessThan(BEFORE.requests / 4);
    expect(r.rows).toBeLessThan(BEFORE.rows / 8);
    expect(r.counts.alarms).toBeLessThan(BEFORE.alarms / 10);
    // ADR 0006 WS-9 "done when": ≤ 60 alarms an hour (13 h of the room's life here).
    expect(r.counts.alarms / 13).toBeLessThanOrEqual(60);
    expect(r.wakes).toBeLessThan(BEFORE.wakes / 10);
    // The camera told the room its status about once a minute (it was every 2 s), and it never
    // rewrote a timeline blob: KV puts are the sleep tracker, once per minute batch.
    expect(r.statusSent).toBeLessThan(BEFORE.statusSent / 25);
    expect(r.counts.kvPuts).toBeLessThan(200);
    // The room hibernated hundreds of times and lost nothing: every minute of history, every
    // alert, the sleep report — and never cried wolf about the camera.
    expect(r.counts.hibernations).toBeGreaterThan(500);
    expect(r.minutesStored).toBe(720);
    expect(r.unacked).toBe(0);
    expect(r.logKinds).toEqual({ camera: 3, cry: 2, cry_end: 2, ack: 2, asleep: 1, woke: 3, resettled: 2, babble: 1, sleep_report: 1 });
    expect(r.offlineAt).toBeNull();
    expect(r.pushTitles.filter((t) => t === 'Aria is crying')).toHaveLength(4); // two cries × two phones
    expect(r.pushTitles.filter((t) => t.startsWith('Good morning — Aria slept'))).toHaveLength(2);
    // The history serves the night as the family's charts and the 24 h strip read it.
    const tl = (r.mom.last('hello') as { tl: [number, number, number][] }).tl;
    expect(tl.some(([, s]) => s === 5)).toBe(true);
  }, 120_000);

  it('an alert nobody answers still escalates on time, with the room asleep in between', async () => {
    const r = await runNight({ ackSecondCry: false });
    expect(r.pushTitles.filter((t) => /^Aria has been crying for \d+ min — no one has responded$/.test(t)).length).toBeGreaterThanOrEqual(2);
    expect(r.logKinds.escalated).toBeGreaterThanOrEqual(1);
    expect(r.requests).toBeLessThanOrEqual(TARGET.requests);
    expect(r.rows).toBeLessThanOrEqual(TARGET.rows);
  }, 120_000);

  it('a camera phone that dies mid-night is reported not responding within 105 s, and its last minutes are kept', async () => {
    const r = await runNight({ cameraDiesAtMin: 600 });
    const died = T0 + 600 * MIN;
    expect(r.offlineAt).not.toBeNull();
    // 75 s of silence counts (its last keepalive ping may be up to 25 s before it died) — never later than 105 s.
    expect(r.offlineAt! - died).toBeGreaterThanOrEqual(75_000 - 25_000);
    expect(r.offlineAt! - died).toBeLessThanOrEqual(105_000);
    expect(r.pushTitles).toContain('Baby camera not responding');
    // Every minute the phone sent before it died is in the history (the waiting ones were written with the alert).
    expect(r.minutesStored).toBe(599);
  }, 120_000);

  it('an app from before this change (status every 2 s, no `view`) still works against the new room', async () => {
    const r = await runNight({ clients: 'legacy' });
    expect(r.minutesStored).toBe(720);
    expect(r.unacked).toBe(0);
    expect(r.logKinds).toEqual({ camera: 3, cry: 2, cry_end: 2, ack: 2, asleep: 1, woke: 3, resettled: 2, babble: 1, sleep_report: 1 });
    expect(r.offlineAt).toBeNull();
    // The room's own diet holds (rows); its requests wait for the camera app's update (status every 2 s).
    expect(r.rows).toBeLessThanOrEqual(TARGET.rows);
    expect(r.requests).toBeLessThan(BEFORE.requests / 2);
  }, 120_000);

  it('measures the night (NIGHT_OUT=<file> NIGHT_CLIENTS=legacy|current writes the numbers)', async () => {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    if (!env.NIGHT_OUT) return;
    const r = await runNight({ clients: env.NIGHT_CLIENTS === 'legacy' ? 'legacy' : 'current' });
    const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { writeFileSync(p: string, d: string): void };
    fs.writeFileSync(env.NIGHT_OUT, JSON.stringify(summary(r), null, 1));
  }, 120_000);
});
