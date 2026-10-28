/**
 * Writes the golden fixtures in packages/monitor-core/fixtures (run from the app root):
 *
 *   npx tsx packages/monitor-core/scripts/gen-fixtures.ts
 *
 * Deterministic: the test keys in fixtures/sealed/keys.json are made once and then reused,
 * every IV and ephemeral key is fixed, so a re-run rewrites the same bytes (the only
 * exception, an ECDSA signature, is kept while it still verifies). The vitest suites check
 * the fixtures against the code; XCTest and JUnit check them against CryptoKit / Tink and
 * the Codable / kotlinx decoders. Changing a fixture is changing the contract: say so in
 * ADR 0006.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b64url,
  composeGlance,
  fromB64url,
  glanceEtag,
  glanceFacts,
  hex,
  hkdf,
  importEcdhPrivate,
  importEcdhPublic,
  LABELS,
  lanName,
  packFrameHeader,
  pointFromJwk,
  replayObservations,
  sealFrame,
  sealSignal,
  signalPlaintext,
  signHello,
  helloSigInput,
  importSigPrivate,
  verifyHello,
  wrapInfo,
  wrapNmk,
  deviceId,
  type EcJwk,
  type FactsPatch,
  type FrameHeader,
  type GlanceCamInput,
  type GlanceFacts,
  type GlanceIncidentInput,
  type GlanceRoomInput,
  type GlanceRoomState,
  type GlanceViewer,
  type SleepPhase,
} from '../src/index';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const write = (rel: string, data: unknown, raw?: string) => {
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, raw ?? JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', rel);
};
const read = <T>(rel: string): T | null => {
  const p = join(ROOT, rel);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
};

const NID = '7d0c2a8e-5b1f-4c3a-9e6d-1a2b3c4d5e6f';
const MOM = 'aaaaaaaa-0000-4000-8000-000000000001';
const DAD = 'aaaaaaaa-0000-4000-8000-000000000002';
const GRANDMA = 'aaaaaaaa-0000-4000-8000-000000000003';
const MIN = 60_000;
const H = 60 * MIN;

/* ================================================================== glance */

/** 02:47 on the night of 2026-10-21 (UTC), the ADR's alert example. */
const T = Date.UTC(2026, 9, 22, 2, 47, 0);

const baseFacts = (over: Partial<GlanceFacts> = {}): GlanceFacts => ({
  nm: 'Maya’s room',
  m: 'calm',
  ms: T - 102 * MIN,
  sl: { p: 'asleep', s: T - 102 * MIN, min: 102, w: 1 },
  db: 34,
  dbt: T - 31_000,
  cam: { on: 1, bat: 72, chg: true, pz: null, ls: T - 1_000 },
  al: null,
  du: { uid: DAD, nm: 'Dad', u: T + 4 * H },
  so: null,
  tk: null,
  ...over,
});

interface ComposeCase {
  name: string;
  state: GlanceRoomState;
  viewer: GlanceViewer;
}

const crying = baseFacts({
  m: 'crying',
  ms: T - 42_000,
  sl: { p: 'awake', s: T - 40_000, min: 102, w: 2 },
  db: 68,
  al: { id: 'i9', k: 'cry', sev: 'urgent', at: T - 30_000, st: 'open', by: null },
});

const composeCases: ComposeCase[] = [
  { name: 'calm-asleep-parent', state: { nid: NID, q: 811, at: T, facts: baseFacts() }, viewer: { uid: MOM, role: 'parent' } },
  { name: 'crying-open-on-duty', state: { nid: NID, q: 812, at: T, facts: crying }, viewer: { uid: DAD, role: 'caregiver' } },
  { name: 'crying-open-push', state: { nid: NID, q: 812, at: T, facts: crying }, viewer: { uid: DAD, role: 'caregiver', forPush: true } },
  {
    name: 'acked-viewer',
    state: { nid: NID, q: 813, at: T + 20_000, facts: { ...crying, al: { ...crying.al!, st: 'acked', by: 'Dad' }, so: 'Shush', tk: 'Dad' } },
    viewer: { uid: GRANDMA, role: 'viewer' },
  },
  { name: 'guest-caregiver', state: { nid: NID, q: 812, at: T, facts: crying }, viewer: { role: 'caregiver', guest: true } },
  { name: 'watch-grant-narrows-parent', state: { nid: NID, q: 812, at: T, facts: crying }, viewer: { uid: MOM, role: 'parent', deviceCan: 1 | 4 | 16 } },
  {
    name: 'offline-battery-low',
    state: {
      nid: NID,
      q: 820,
      at: T,
      facts: baseFacts({
        m: 'offline',
        ms: T - 4 * MIN,
        db: null,
        dbt: null,
        cam: { on: 0, bat: null, chg: null, pz: null, ls: T - 4 * MIN },
        al: { id: 'i12', k: 'offline', sev: 'urgent', at: T - 2 * MIN, st: 'open', by: null },
      }),
    },
    viewer: { uid: MOM, role: 'parent' },
  },
  {
    name: 'paused-privacy-hysteresis-band',
    // 56 dB published as "normal": the band only moves once the level clears 55 by 2 dB.
    state: { nid: NID, q: 9, at: T, dbb: 1, facts: baseFacts({ m: 'awake', db: 56, cam: { on: 1, bat: 18, chg: false, pz: 'privacy', ls: T - 2_000 }, du: null, sl: null }) },
    viewer: { uid: MOM, role: 'parent' },
  },
  {
    name: 'waiting-for-camera',
    state: { nid: NID, q: 1, at: T, facts: { nm: 'Nursery', m: 'unknown', ms: T, sl: null, db: null, dbt: null, cam: { on: 0, bat: null, chg: null, pz: null, ls: 0 }, al: null, du: null, so: null, tk: null } },
    viewer: { uid: MOM, role: 'parent' },
  },
  {
    name: 'long-names-clipped-worst-case',
    state: {
      nid: NID,
      q: 9_007_199_254,
      at: T,
      facts: {
        nm: 'The Very Long Name Of A Nursery Upstairs 🌙',
        m: 'crying',
        ms: T - 1,
        sl: { p: 'settling', s: T - 1, min: 9999, w: 99 },
        db: 104,
        dbt: T,
        cam: { on: 3, bat: 100, chg: false, pz: 'interrupted', ls: T },
        al: { id: 'incident-0123456789-0123456789-01234567890', k: 'crib_out_of_zone_long', sev: 'urgent', at: T, st: 'acked', by: 'Grandma Josephine Alexandra' },
        du: { uid: MOM, nm: 'Grandma Josephine Alexandra', u: T + 24 * H },
        so: 'Ocean waves with heartbeat',
        tk: 'Grandpa Bartholomew Jones',
      },
    },
    viewer: { uid: MOM, role: 'parent' },
  },
];

function genCompose() {
  const cases = composeCases.map((c) => {
    const g = composeGlance(c.state, c.viewer);
    const json = JSON.stringify(g);
    return { ...c, glance: g, json, bytes: Buffer.byteLength(json), etag: glanceEtag(g) };
  });
  write('glance/compose.json', {
    about: 'composeGlance(state, viewer) → glance. Decoders must parse `json` into `glance`; `bytes` ≤ 512.',
    cases,
  });
}

interface FactsCase {
  name: string;
  now: number;
  room: GlanceRoomInput;
}
const st = (state: 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying', over: Record<string, unknown> = {}) => ({ state, battery: 80, charging: true, soothing: null, paused: null, talk: null, call: null, spl: { leq: 40 }, ...over });
const factsCases: FactsCase[] = [
  {
    name: 'two-cameras-worst-mood-lowest-battery',
    now: T,
    room: {
      name: 'Twins',
      cams: [
        { online: true, at: T - 2_000, since: T - 30 * MIN, st: st('calm', { battery: 90, spl: { leq: 35.4 } }) },
        { online: true, at: T - 1_000, since: T - 20_000, st: st('fussing', { battery: 31, charging: false, spl: { leq: 61.6 } }) },
      ],
      sleep: { phase: 'asleep', since: T - 3 * H, asleepMin: 180.4, wakings: 1 },
      duty: { uid: MOM, name: 'Mom', until: T + H },
    },
  },
  {
    name: 'one-of-two-paused-is-not-paused',
    now: T,
    room: { name: 'Nursery', cams: [{ online: true, at: T, since: T - MIN, st: st('calm', { paused: 'privacy' }) }, { online: true, at: T, since: T - MIN, st: st('calm') }] },
  },
  {
    name: 'all-paused-and-soothing',
    now: T,
    room: { name: 'Nursery', cams: [{ online: true, at: T, since: T - MIN, st: st('calm', { paused: 'interrupted', soothing: ' Rain ', talk: 'Mom' }) }] },
  },
  {
    name: 'cameras-gone-is-offline-expired-duty',
    now: T,
    room: { name: 'Nursery', cams: [{ online: false, at: T - 5 * MIN, since: null, st: null }], duty: { uid: DAD, name: 'Dad', until: T - 1 } },
  },
  { name: 'no-camera-is-unknown', now: T, room: { name: 'Nursery', cams: [] } },
  {
    name: 'two-cameras-mood-began-when-the-last-reached-it',
    now: T,
    room: { name: 'Twins', cams: [{ online: true, at: T - 2_000, since: T - H, st: st('calm') }, { online: true, at: T - 1_000, since: T - 1_000, st: st('calm') }] },
  },
  {
    name: 'minute-laeq-is-the-level',
    // A door shut this second (71 dB); the minute averaged it in.
    now: T,
    room: { name: 'Nursery', cams: [{ online: true, at: T - 1_000, since: T - H, st: st('calm', { spl: { leq: 71 } }), minute: { laeq: 43.6, at: T - 25_000 } }] },
  },
  {
    name: 'stale-minute-row-gives-way-to-status-leq',
    now: T,
    room: { name: 'Nursery', cams: [{ online: true, at: T - 1_000, since: T - H, st: st('calm', { spl: { leq: 47.2 } }), minute: { laeq: 43.6, at: T - 4 * MIN } }] },
  },
  {
    name: 'alert-order-unanswered-first',
    now: T,
    room: {
      name: 'Nursery',
      cams: [{ online: true, at: T, since: T - MIN, st: st('crying') }],
      incidents: [
        { id: 'a', at: T - 5 * MIN, kind: 'cry', sev: 'urgent', status: 'acked', ack_by: 'Dad' },
        { id: 'b', at: T - 4 * MIN, kind: 'moved', sev: 'warn', status: 'open' },
        { id: 'c', at: T - 3 * MIN, kind: 'loud', sev: 'info', status: 'open' },
        { id: 'd', at: T - 1 * MIN, kind: 'zone', sev: 'urgent', status: 'resolved', resolved_at: T },
      ],
    },
  },
  {
    name: 'resolved-shown-for-30-minutes',
    now: T,
    room: {
      name: 'Nursery',
      cams: [{ online: true, at: T, since: T - MIN, st: st('calm') }],
      incidents: [
        { id: 'old', at: T - 2 * H, kind: 'cry', sev: 'urgent', status: 'resolved', ack_by: 'Mom', resolved_at: T - 31 * MIN },
        { id: 'recent', at: T - H, kind: 'cry', sev: 'urgent', status: 'resolved', ack_by: 'Dad', resolved_at: T - 29 * MIN },
      ],
    },
  },
  {
    name: 'resolved-ages-out',
    now: T,
    room: {
      name: 'Nursery',
      cams: [{ online: true, at: T, since: T - MIN, st: st('calm') }],
      incidents: [{ id: 'old', at: T - 2 * H, kind: 'cry', sev: 'urgent', status: 'resolved', ack_by: 'Mom', resolved_at: T - 31 * MIN }],
    },
  },
];

function genFacts() {
  write('glance/facts.json', {
    about: 'glanceFacts(room, now) → facts: what a room or an app knows, as the nursery-wide glance facts.',
    cases: factsCases.map((c) => ({ ...c, facts: glanceFacts(c.room, c.now) })),
  });
}

function genDecode() {
  const valid = [
    { name: 'minimal', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"unknown","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'nulls-mean-none', json: `{"v":1,"n":"${NID}","q":2,"at":2,"m":"calm","ms":1,"sl":null,"db":null,"cam":{"on":1,"bat":null,"chg":null,"pz":null,"ls":2},"al":null,"du":null,"so":null,"tk":null,"can":20}` },
    { name: 'unknown-fields-ignored', json: `{"v":1,"n":"${NID}","q":3,"at":3,"m":"noisy","ms":2,"cam":{"on":1,"ls":3,"future":true},"can":127,"x":{"y":1},"src":"lan"}` },
    { name: 'full', json: composeCases[1] ? JSON.stringify(composeGlance(composeCases[1].state, composeCases[1].viewer)) : '' },
  ];
  const invalid = [
    { name: 'version-2', json: `{"v":2,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'no-cam', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"can":0}` },
    { name: 'unknown-mood', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"hungry","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'can-out-of-range', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":128}` },
    { name: 'band-out-of-range', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"db":40,"dbb":4,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'fractional-q', json: `{"v":1,"n":"${NID}","q":1.5,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'negative-q', json: `{"v":1,"n":"${NID}","q":-1,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'alert-without-id', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"crying","ms":1,"cam":{"on":1,"ls":1},"al":{"k":"cry","sev":"urgent","at":1,"st":"open"},"can":0}` },
    { name: 'bad-alert-status', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"crying","ms":1,"cam":{"on":1,"ls":1},"al":{"id":"i","k":"cry","sev":"urgent","at":1,"st":"snoozed"},"can":0}` },
    { name: 'name-too-long', json: `{"v":1,"n":"${NID}","nm":"${'x'.repeat(65)}","q":1,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":0}` },
    { name: 'battery-over-100', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"cam":{"on":1,"bat":101,"ls":1},"can":0}` },
    { name: 'server-never-sends-unknown-src', json: `{"v":1,"n":"${NID}","q":1,"at":1,"m":"calm","ms":1,"cam":{"on":0,"ls":0},"can":0,"src":"mesh"}` },
    { name: 'not-an-object', json: '[1]' },
  ];
  write('glance/decode.json', {
    about: 'Every Glance v1 decoder must accept each `valid` json (absent and null optionals mean none; unknown fields ignored) and reject each `invalid` one.',
    valid,
    invalid,
  });
}

/* ------------------------------------------------------------ the night */

/**
 * A full night in one nursery, 19:00 → 07:00, as the room hears it (WS-9 room/glanceState.ts):
 * each camera's status at once when its state changes and otherwise every 2 minutes (the
 * statusCadence keepalive, with the parent watching over the data channel), its minute row
 * every minute, and the room's own sleep phases, alerts and duty. Every input is one
 * observation: the change it makes to `glanceFacts(room, now)`.
 *
 * What a real night has: a white-noise machine, two crying wakes answered by different parents
 * (talk, soothing), a fuss that settles by itself, brief stirs, a dog outside, a duty hand-over,
 * a Wi-Fi blip, morning, the cameras stopped. From 22:00 a second camera: Dad's old Android
 * phone on the dresser, beside the crib camera (an iPhone in Safari, which gives no battery
 * reading); it joins at 17 %, drops under 10 % and is plugged in after midnight. Two cameras
 * bring the cases that once cost a bump per gap: a restless half hour (22:30) that the crib
 * camera hears as stirring 20 s, settled 5 s, while the dresser stays calm; and the 04:00 cry
 * in bursts while the dresser sees her stirring.
 */
function genNight() {
  const t0 = Date.UTC(2026, 9, 21, 19, 0, 0);
  const at = (hh: number, mm: number, ss = 0) => {
    const day = hh < 12 ? 24 : 0;
    return ((hh + day - 19) * 3600 + mm * 60 + ss) * 1000;
  };
  const END = at(7, 0);
  type St = NonNullable<GlanceCamInput['st']>;
  /** A camera as the room knows it, plus when it last sent a status and whether it is out of reach. */
  type Cam = GlanceCamInput & { last: number; away?: boolean };
  type Mood = St['state'];

  // Minute LAeq at the crib: white noise from 19:05 (≈ 52 dB), the cries, the dog, the morning.
  const noise = (min: number): number => {
    const t = min * MIN;
    if (t < at(19, 5)) return 38;
    const cry = (s: number, lv: number[]) => (t >= s && t < s + lv.length * MIN ? lv[Math.floor((t - s) / MIN)] : null);
    const c1 = cry(at(21, 30), [68, 71, 69, 72, 67, 61, 55]);
    if (c1 != null) return c1;
    const c2 = cry(at(4, 0), [70, 73, 71, 66, 62, 58, 54, 53]);
    if (c2 != null) return c2;
    const c3 = cry(at(5, 20), [57, 58, 55]);
    if (c3 != null) return c3;
    if (t >= at(3, 16) && t < at(3, 17)) return 58; // the dog, one minute
    if (t >= at(6, 46)) return 42; // white noise off
    if (t >= at(6, 30)) return 54; // babbling
    return 52 + ((min * 7919) % 5) - 2; // 50–54
  };
  // The 1-second Leq a status carries: the minute's level, give or take a cough.
  const second = (t: number): number => noise(Math.floor(t / MIN)) + (((t / 1000) * 7919) % 9) - 4;
  // The dresser phone: 17 % at 22:00, −4 %/h; plugged in at 00:56, +15 %/h.
  const dresserBattery = (t: number): number => {
    const plugged = at(0, 56);
    if (t < plugged) return Math.round(17 - (4 * (t - at(22, 0))) / H);
    return Math.min(100, Math.round(17 - (4 * (plugged - at(22, 0))) / H + (15 * (t - plugged)) / H));
  };

  const fresh = (): St => ({ state: 'calm', battery: null, charging: null, soothing: null, paused: null, talk: null, call: null, spl: null });
  const crib: Cam = { online: true, at: t0, since: t0, st: { ...fresh(), spl: { leq: 38 } }, minute: null, last: 0 };
  // Until its first status the room knows only that its socket is there.
  const dresser: Cam = { online: true, at: t0 + at(22, 0), since: null, st: null, minute: null, last: at(22, 0) };
  const sleepPhases: [number, SleepPhase, number][] = [
    [at(19, 5), 'settling', 0], [at(19, 22), 'asleep', 0],
    [at(21, 30, 40), 'awake', 1], [at(21, 38), 'settling', 1], [at(21, 52), 'asleep', 1],
    [at(4, 0, 40), 'awake', 2], [at(4, 25), 'settling', 2], [at(4, 38), 'asleep', 2],
    [at(5, 21), 'awake', 3], [at(5, 24), 'settling', 3], [at(5, 36), 'asleep', 3],
    [at(6, 30, 30), 'awake', 4],
  ];
  const sleepAt = (t: number): NonNullable<GlanceRoomInput['sleep']> => {
    let phase: SleepPhase = 'idle';
    let since = t0;
    let wakings = 0;
    let asleepSince: number | null = null;
    let asleepMs = 0;
    for (const [ts, ph, wk] of sleepPhases) {
      if (ts > t) break;
      if (asleepSince != null) asleepMs += ts - asleepSince;
      asleepSince = ph === 'asleep' ? ts : null;
      phase = ph;
      since = t0 + ts;
      wakings = wk;
    }
    if (asleepSince != null) asleepMs += t - asleepSince;
    return { phase, since, asleepMin: Math.floor(asleepMs / MIN), wakings };
  };
  const incidents: GlanceIncidentInput[] = [];
  const room: GlanceRoomInput = { name: 'Maya’s room', cams: [crib], sleep: sleepAt(0), incidents, duty: { uid: MOM, name: 'Mom', until: t0 + at(1, 0) } };

  const initial = glanceFacts(room, t0);
  let facts = initial;
  const obs: [number, FactsPatch][] = [];
  /** One input heard at `t`: what it changed in the facts. */
  const observe = (t: number) => {
    const next = glanceFacts(room, t0 + t);
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(next) as (keyof GlanceFacts)[]) {
      if (k === 'cam') {
        const cam: Record<string, unknown> = {};
        for (const c of Object.keys(next.cam) as (keyof GlanceFacts['cam'])[]) if (next.cam[c] !== facts.cam[c]) cam[c] = next.cam[c];
        if (Object.keys(cam).length) patch.cam = cam;
      } else if (JSON.stringify(next[k]) !== JSON.stringify(facts[k])) patch[k] = next[k];
    }
    obs.push([t, patch as FactsPatch]);
    facts = next;
  };
  /** A camera's status reaches the room (a change, or its keepalive). */
  const status = (t: number, c: Cam, change: Partial<St> = {}) => {
    const st: St = { ...(c.st ?? fresh()), ...change, spl: { leq: second(t) - (c === dresser ? 3 : 0) } };
    if (!c.st || st.state !== c.st.state) c.since = t0 + t;
    if (c === dresser) {
      st.battery = dresserBattery(t);
      st.charging = t >= at(0, 56);
    }
    c.st = st;
    c.at = t0 + t;
    c.last = t;
    observe(t);
  };
  const room$ = (t: number, f: () => void) => {
    f();
    observe(t);
  };

  // What happens, in order: [time, what].
  const script: [number, () => void][] = [];
  const mood = (c: Cam, t: number, state: Mood) => script.push([t, () => status(t, c, { state })]);
  // The crib camera's moods.
  for (const [t, m] of [
    [at(21, 30), 'crying'], [at(21, 35, 40), 'fussing'], [at(21, 36, 30), 'stirring'], [at(21, 37, 10), 'calm'],
    [at(23, 10), 'stirring'], [at(23, 10, 10), 'calm'], // a 10 s stir: never shown
    [at(23, 40), 'stirring'], [at(23, 40, 40), 'calm'],
    [at(0, 55), 'stirring'], [at(0, 55, 50), 'calm'], // Mom plugs the dresser phone in
    [at(3, 15), 'noisy'], [at(3, 15, 25), 'calm'], // a dog outside
    [at(4, 5), 'fussing'], [at(4, 7, 30), 'calm'],
    [at(5, 20), 'fussing'], [at(5, 23), 'stirring'], [at(5, 23, 40), 'calm'],
    [at(6, 30), 'awake'],
  ] as [number, Mood][]) mood(crib, t, m);
  // Restless half an hour: the crib camera hears her stir 20 s, settle 5 s; the dresser doesn't.
  for (let t = at(22, 30); t < at(23, 0); t += 25_000) {
    mood(crib, t, 'stirring');
    mood(crib, t + 20_000, 'calm');
  }
  // The 04:00 cry, in bursts with a breath between; the dresser sees her stirring.
  for (let t = at(4, 0); t < at(4, 5); t += 25_000) {
    mood(crib, t, 'crying');
    if (t + 20_000 < at(4, 5)) mood(crib, t + 20_000, 'calm');
  }
  mood(dresser, at(4, 0, 10), 'stirring');
  mood(dresser, at(4, 7, 40), 'calm');
  mood(dresser, at(6, 30, 20), 'awake');
  // Talk and soothing come with the crib camera's status.
  script.push([at(21, 31, 30), () => status(at(21, 31, 30), crib, { talk: 'Mom' })]);
  script.push([at(21, 32, 10), () => status(at(21, 32, 10), crib, { talk: null })]);
  script.push([at(21, 32, 15), () => status(at(21, 32, 15), crib, { soothing: 'Shush' })]);
  script.push([at(21, 47, 15), () => status(at(21, 47, 15), crib, { soothing: null })]);
  // The dresser camera joins: its socket first, its first status two seconds later.
  script.push([at(22, 0), () => room$(at(22, 0), () => room.cams.push(dresser))]);
  script.push([at(22, 0, 2), () => status(at(22, 0, 2), dresser)]);
  // Mom plugs it in (charging is news to the room within 10 s).
  script.push([at(0, 56), () => status(at(0, 56), dresser)]);
  // Sleep phases and the alerts, from the room itself. Its sleep tracker runs on the crib
  // camera's minute rows, so a phase on the minute comes with that row; one between rows
  // (woken by a cry) comes on its own.
  for (const [t] of sleepPhases) if (t % MIN) script.push([t, () => room$(t, () => (room.sleep = sleepAt(t)))]);
  const alert = (t: number, i: GlanceIncidentInput) =>
    script.push([t, () => room$(t, () => {
      const k = incidents.findIndex((x) => x.id === i.id);
      if (k >= 0) incidents[k] = i;
      else incidents.push(i);
    })]);
  const cry1 = { id: 'inc-2130', kind: 'cry', sev: 'urgent' as const, at: t0 + at(21, 30, 20) };
  const off = { id: 'inc-0211', kind: 'offline', sev: 'urgent' as const, at: t0 + at(2, 11, 35) };
  const cry2 = { id: 'inc-0400', kind: 'cry', sev: 'urgent' as const, at: t0 + at(4, 0, 20) };
  alert(at(21, 30, 20), { ...cry1, status: 'open' });
  alert(at(21, 31, 5), { ...cry1, status: 'acked', ack_by: 'Mom', ack_at: t0 + at(21, 31, 5) });
  alert(at(21, 38), { ...cry1, status: 'resolved', ack_by: 'Mom', resolved_at: t0 + at(21, 38) });
  alert(at(4, 0, 20), { ...cry2, status: 'open' });
  alert(at(4, 1, 30), { ...cry2, status: 'acked', ack_by: 'Dad', ack_at: t0 + at(4, 1, 30) });
  alert(at(4, 9), { ...cry2, status: 'resolved', ack_by: 'Dad', resolved_at: t0 + at(4, 9) });
  script.push([at(1, 0), () => room$(at(1, 0), () => (room.duty = { uid: DAD, name: 'Dad', until: t0 + at(7, 0) }))]);
  // Wi-Fi blip: from 02:10 nothing arrives; at 02:11:35 the room calls both cameras offline (and
  // opens an alert); at 02:12:20 they are back.
  script.push([at(2, 10), () => {
    crib.away = true;
    dresser.away = true;
  }]);
  script.push([at(2, 11, 35), () => room$(at(2, 11, 35), () => {
    crib.online = false;
    dresser.online = false;
    incidents.push({ ...off, status: 'open' });
  })]);
  script.push([at(2, 12, 20), () => {
    for (const c of [crib, dresser]) {
      c.online = true;
      c.away = false;
      c.since = t0 + at(2, 12, 20); // a new socket: the room dates its state from now
    }
    incidents[incidents.findIndex((x) => x.id === off.id)] = { ...off, status: 'resolved', resolved_at: t0 + at(2, 12, 20) };
    status(at(2, 12, 20), crib);
  }]);
  script.push([at(2, 12, 21), () => status(at(2, 12, 21), dresser)]);
  // Morning: both cameras stopped, the night over.
  script.push([END, () => room$(END, () => {
    room.cams = [];
    room.sleep = null;
  })]);
  script.sort((a, b) => a[0] - b[0]); // stable: same-second events stay in the order written

  let next = 0;
  for (let t = 0; t <= END; t += 1_000) {
    while (next < script.length && script[next][0] === t) script[next++][1]();
    // Minute rows: the crib camera on the minute, the dresser on the half minute.
    for (const c of room.cams as Cam[]) {
      if (!c.online || c.away || !c.st) continue;
      const off30 = c === dresser ? 30_000 : 0;
      if (t % MIN !== off30) continue;
      c.minute = { laeq: noise(Math.floor(t / MIN)) - (c === dresser ? 3 : 0), at: t0 + t };
      if (c === crib) room.sleep = sleepAt(t); // the room's sleep tracker runs on the crib's rows
      observe(t);
    }
    // Keepalives (and the dresser's battery news: a 5 % step goes within 10 s).
    for (const c of room.cams as Cam[]) {
      if (!c.online || c.away || !c.st || c.last === t) continue;
      const stepped = c === dresser && Math.floor(dresserBattery(t) / 5) !== Math.floor((c.st.battery ?? 0) / 5) && t - c.last >= 10_000;
      if (t - c.last >= 120_000 || stepped) status(t, c);
    }
  }
  if (next !== script.length) throw new Error('night: script events left over');

  const endMs = at(7, 30);
  const { bumps } = replayObservations(t0, initial, obs, endMs);
  write(
    'glance/night-2026-10-21.json',
    null,
    [
      '{',
      `  "about": "A recorded-style night, 19:00 → 07:00, one nursery with a second camera from 22:00, as the room hears it: statuses on change and every 2 minutes, minute rows every minute. Replay with replayObservations(t0, initial, observations, endMs). Every port of nextBump must give exactly these bumps; ADR 0006 caps a night at 60.",`,
      `  "t0": ${t0},`,
      `  "endMs": ${endMs},`,
      `  "initial": ${JSON.stringify(initial)},`,
      `  "observations": [`,
      obs.map((o) => `    ${JSON.stringify(o)}`).join(',\n'),
      `  ],`,
      `  "expect": {`,
      `    "maxBumps": 60,`,
      `    "bumps": [`,
      bumps.map((b) => `      ${JSON.stringify([b.t - t0, b.q, b.reasons])}`).join(',\n'),
      `    ]`,
      `  }`,
      '}',
      '',
    ].join('\n'),
  );
  console.log(`night: ${obs.length} observations, ${bumps.length} bumps`);
}

/* ================================================================= sealed */

interface DeviceFixture {
  sig: EcJwk;
  ecdh: EcJwk;
  sigPub: string;
  ecdhPub: string;
  devId: string;
}
interface KeysFixture {
  about: string;
  nid: string;
  nmk: Record<string, string>;
  devices: Record<'camera' | 'viewer' | 'watch', DeviceFixture>;
  ephemeral: EcJwk[];
}

async function genJwk(alg: 'ECDH' | 'ECDSA'): Promise<EcJwk> {
  const pair = (await crypto.subtle.generateKey({ name: alg, namedCurve: 'P-256' }, true, alg === 'ECDH' ? ['deriveBits'] : ['sign', 'verify'])) as CryptoKeyPair;
  const j = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d! };
}

async function keys(): Promise<KeysFixture> {
  const have = read<KeysFixture>('sealed/keys.json');
  if (have) return have;
  const device = async (): Promise<DeviceFixture> => {
    const sig = await genJwk('ECDSA');
    const ecdh = await genJwk('ECDH');
    const sigPub = b64url(pointFromJwk(sig));
    return { sig, ecdh, sigPub, ecdhPub: b64url(pointFromJwk(ecdh)), devId: await deviceId(sigPub) };
  };
  const k: KeysFixture = {
    about: 'TEST KEYS ONLY — published on purpose so every platform can reproduce the vectors. Never use them for anything else.',
    nid: NID,
    nmk: { '1': b64url(crypto.getRandomValues(new Uint8Array(32))), '2': b64url(crypto.getRandomValues(new Uint8Array(32))) },
    devices: { camera: await device(), viewer: await device(), watch: await device() },
    ephemeral: [await genJwk('ECDH'), await genJwk('ECDH')],
  };
  write('sealed/keys.json', k);
  return k;
}

const fixedIv = (n: number) => Uint8Array.from({ length: 12 }, (_, i) => (n * 16 + i) & 255);

/** 19:00 UTC on 2026-10-21: the camera starts. */
const S0 = Date.UTC(2026, 9, 21, 19, 0, 0);

async function genSealed() {
  const k = await keys();
  const nmk = (e: number) => fromB64url(k.nmk[String(e)])!;
  const { camera, viewer, watch } = k.devices;

  // devId
  write('sealed/devid.json', {
    about: 'devId = base64url(SHA-256(sigPub as the 65-byte uncompressed point))[0:22].',
    cases: Object.entries(k.devices).map(([name, d]) => ({ name, sigPub: d.sigPub, devId: d.devId })),
  });

  // Wraps, with the intermediate values a port needs to find its bug.
  const wrapCases = [];
  for (const [i, [name, to, e]] of ([['camera-wraps-epoch-1-to-viewer', viewer, 1], ['viewer-wraps-epoch-2-to-watch', watch, 2]] as const).entries()) {
    const eph = k.ephemeral[i];
    const ctx = { nid: k.nid, e, devId: to.devId };
    const iv = fixedIv(i + 1);
    const ephPriv = await importEcdhPrivate(eph);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: (await importEcdhPublic(to.ecdhPub)) as CryptoKey }, ephPriv as CryptoKey, 256));
    const key = await hkdf(shared, wrapInfo(k.nid, e, to.devId), 32);
    const blob = await wrapNmk(nmk(e), to.ecdhPub, ctx, { ephemeral: eph, iv });
    wrapCases.push({
      name,
      ctx,
      nmk: k.nmk[String(e)],
      recipient: name.endsWith('viewer') ? 'viewer' : 'watch',
      recipientEcdhPub: to.ecdhPub,
      ephemeral: eph,
      iv: b64url(iv),
      info: wrapInfo(k.nid, e, to.devId),
      sharedSecretHex: hex(shared),
      keyHex: hex(key),
      blob,
    });
  }
  const good = wrapCases[0];
  const flip = (s: string, at: number) => {
    const b = fromB64url(s)!;
    b[at] ^= 1;
    return b64url(b);
  };
  write('sealed/wrap.json', {
    about: 'wrapNmk / unwrapNmk. blob = 0x01 ‖ ephPub(65) ‖ iv(12) ‖ AES-256-GCM(key, iv, NMK, aad = 0x01 ‖ ephPub); key = HKDF-SHA256(ECDH x, salt = empty, info, 32). Re-wrapping with `ephemeral` and `iv` must give `blob` exactly; unwrapping with the recipient key must give `nmk`; every `reject` case must fail.',
    cases: wrapCases,
    reject: [
      { name: 'flipped-ciphertext', blob: flip(good.blob, 100), ctx: good.ctx, recipient: 'viewer' },
      { name: 'flipped-ephemeral-key', blob: flip(good.blob, 40), ctx: good.ctx, recipient: 'viewer' },
      { name: 'other-device-id-in-context', blob: good.blob, ctx: { ...good.ctx, devId: watch.devId }, recipient: 'viewer' },
      { name: 'other-epoch-in-context', blob: good.blob, ctx: { ...good.ctx, e: 2 }, recipient: 'viewer' },
      { name: 'wrong-recipient-key', blob: good.blob, ctx: good.ctx, recipient: 'watch' },
      { name: 'unknown-version', blob: b64url(Uint8Array.of(2, ...fromB64url(good.blob)!.subarray(1))), ctx: good.ctx, recipient: 'viewer' },
      { name: 'truncated', blob: good.blob.slice(0, 100), ctx: good.ctx, recipient: 'viewer' },
    ],
  });

  // Frames.
  const fctx = { nid: k.nid, camDev: camera.devId };
  const okm = await hkdf(nmk(1), LABELS.frame + camera.devId, 36);
  const parts: { name: string; hdr: FrameHeader; body: Uint8Array }[] = [
    { name: 'jpeg-key-frame', hdr: { e: 1, cam: 0, seq: S0 * 1000, ts: S0, flags: 1 }, body: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]) },
    { name: 'sound-chunk', hdr: { e: 1, cam: 1, seq: S0 * 1000 + 1, ts: S0 + 40, flags: 0 }, body: Uint8Array.from({ length: 40 }, (_, i) => (i * 13) & 255) },
    { name: 'empty-body', hdr: { e: 1, cam: 0, seq: S0 * 1000 + 2, ts: S0 + 80, flags: 0 }, body: new Uint8Array(0) },
  ];
  const frameCases = [];
  for (const p of parts) {
    const head = packFrameHeader(p.hdr);
    const sealed = await sealFrame(nmk(1), fctx, p.hdr, p.body);
    frameCases.push({ name: p.name, ctx: fctx, nmkEpoch: 1, hdr: p.hdr, headerHex: hex(head), nonceHex: hex(new Uint8Array([...okm.subarray(32, 36), ...head.subarray(7, 15)])), body: b64url(p.body), sealed: b64url(sealed) });
  }
  const f0 = frameCases[0];
  write('sealed/frame.json', {
    about: 'sealFrame / openFrame. header (22, big-endian) = ver u8 | e u32 | cam u16 | seq u64 | ts u48 | flags u8; sealed = header ‖ AES-256-GCM(frameKey, salt ‖ seq, body, aad = header ‖ UTF-8(nid)); frameKey ‖ salt = HKDF-SHA256(NMK_e, salt = empty, info = "frame|" + camDev, 36).',
    frameKeyHex: hex(okm.subarray(0, 32)),
    saltHex: hex(okm.subarray(32, 36)),
    cases: frameCases,
    reject: [
      { name: 'other-nursery', sealed: f0.sealed, ctx: { ...fctx, nid: '00000000-0000-4000-8000-000000000000' }, reason: 'auth' },
      { name: 'other-camera', sealed: f0.sealed, ctx: { ...fctx, camDev: viewer.devId }, reason: 'auth' },
      { name: 'header-seq-edited', sealed: flip(f0.sealed, 14), ctx: fctx, reason: 'auth' },
      { name: 'header-flags-edited', sealed: flip(f0.sealed, 21), ctx: fctx, reason: 'auth' },
      { name: 'ciphertext-flipped', sealed: flip(f0.sealed, 25), ctx: fctx, reason: 'auth' },
      { name: 'unknown-version', sealed: flip(f0.sealed, 0), ctx: fctx, reason: 'format' },
      { name: 'truncated', sealed: f0.sealed.slice(0, 40), ctx: fctx, reason: 'format' },
    ],
  });

  // Signaling.
  const sigKey = await hkdf(nmk(1), LABELS.sig, 32);
  const sigs = [
    { name: 'viewer-offer-to-camera', from: viewer.devId, to: camera.devId, ts: S0 + 60_000, d: { sdp: { type: 'offer', sdp: 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 AB:CD:EF\r\n' }, pc: 'p1', vid: 'v1', q: 'hd' } },
    { name: 'camera-candidates-to-viewer', from: camera.devId, to: viewer.devId, ts: S0 + 60_300, d: { ice: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }, pc: 'p1' } },
  ];
  const signalCases = [];
  for (const [i, s] of sigs.entries()) {
    const iv = fixedIv(10 + i);
    const sealed = await sealSignal(nmk(1), { nid: k.nid, e: 1, fromDev: s.from, toDev: s.to }, s.d, { iv, now: s.ts });
    signalCases.push({ name: s.name, nid: k.nid, e: 1, fromDev: s.from, toDev: s.to, ts: s.ts, d: s.d, plaintext: new TextDecoder().decode(signalPlaintext(s.d, s.from, s.to, s.ts)), aad: `${k.nid}|${s.from}|${s.to}`, sealed });
  }
  const s0 = signalCases[0];
  write('sealed/signal.json', {
    about: 'sealSignal / openSignal. key = HKDF-SHA256(NMK_e, salt = empty, info = "sig", 32); ct = AES-256-GCM(key, iv, UTF-8(plaintext), aad = UTF-8(aad)). Ports encrypt `plaintext` byte for byte (their JSON key order may differ) and must get `sealed.ct`; on open they compare from/to/ts after parsing.',
    keyHex: hex(sigKey),
    cases: signalCases,
    reject: [
      { name: 'addressed-to-someone-else', sealed: s0.sealed, toDev: watch.devId, reason: 'auth' },
      { name: 'sender-relabelled', sealed: { ...s0.sealed, f: watch.devId }, toDev: s0.toDev, reason: 'auth' },
      { name: 'ciphertext-flipped', sealed: { ...s0.sealed, ct: flip(s0.sealed.ct, 3) }, toDev: s0.toDev, reason: 'auth' },
      { name: 'epoch-relabelled', sealed: { ...s0.sealed, e: 2 }, toDev: s0.toDev, reason: 'auth' },
    ],
  });

  // dev_hello (an ECDSA signature is randomised: verify-only, kept while it verifies).
  const nonce = 'n0nce-from-hello';
  const ts = S0 + 500;
  const prev = read<{ cases: { sig: string }[] }>('sealed/hello.json');
  let sig = prev?.cases?.[0]?.sig ?? '';
  const msg = { devId: viewer.devId, sigPub: viewer.sigPub, ecdhPub: viewer.ecdhPub, ts, sig };
  if (!sig || !(await verifyHello(msg, k.nid, nonce))) {
    sig = await signHello(await importSigPrivate(viewer.sig), k.nid, nonce, ts, viewer.ecdhPub);
    msg.sig = sig;
  }
  write('sealed/hello.json', {
    about: 'dev_hello: ECDSA P-256/SHA-256 (r ‖ s, 64 bytes) by sigPub over UTF-8(input). Verify only (signatures are randomised). Each `reject` must fail.',
    cases: [{ name: 'viewer-hello', nid: k.nid, nonce, input: new TextDecoder().decode(helloSigInput(k.nid, nonce, ts, viewer.ecdhPub)), ...msg }],
    reject: [
      { name: 'swapped-ecdh-key', nid: k.nid, nonce, ...msg, ecdhPub: watch.ecdhPub },
      { name: 'other-nonce', nid: k.nid, nonce: 'n0nce-replayed', ...msg },
      { name: 'devid-not-the-key-hash', nid: k.nid, nonce, ...msg, devId: camera.devId },
    ],
  });

  write('sealed/lan.json', {
    about: 'lanName = hex(HMAC-SHA256(NMK_e, "lan")[0:8]) — the mDNS instance name (Phase 4).',
    cases: [{ nmk: k.nmk['1'], name: await lanName(nmk(1)) }, { nmk: k.nmk['2'], name: await lanName(nmk(2)) }],
  });
}

genCompose();
genFacts();
genDecode();
genNight();
await genSealed();
