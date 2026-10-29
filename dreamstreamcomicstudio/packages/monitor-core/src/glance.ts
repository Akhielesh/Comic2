/**
 * Glance v1 — the one small state contract for watches, complications, Live Activities,
 * push payloads and the glance socket (ADR 0006 D2). Under 512 bytes as JSON.
 *
 * Three layers, all pure:
 *   1. `glanceFacts(room, now)` turns what a room knows (cameras, sleep, incidents, duty)
 *      into `GlanceFacts`, nursery-wide and viewer-independent.
 *   2. `nextBump` (glanceBump.ts) decides when those facts are published: it keeps the
 *      published snapshot and the sequence number `q`, which bumps only on a visible change.
 *   3. `composeGlance(state, viewer)` shapes the published snapshot for one device: its `can`
 *      bitmask, whether it is the one on duty, and no nursery name in push payloads.
 *
 * Every glance is complete: an absent optional field means "none". Decoders (Swift Codable,
 * kotlinx.serialization) must accept absent and null alike and ignore unknown fields; they
 * must reject any `v` other than 1. The golden fixtures in fixtures/glance hold them to it.
 */

/** Worst-first is `MOOD_RANK`. `offline`: the camera stopped answering; `unknown`: no camera yet. */
export type Mood = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying' | 'offline' | 'unknown';
export const MOODS: readonly Mood[] = ['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying', 'offline', 'unknown'];

/** The baby states a camera reports (live/monitor/protocol.ts `BabyState`). */
export type BabyState = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
export const BABY_STATES: readonly BabyState[] = ['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying'];

/** Same ranks as protocol.ts `STATE_RANK`; offline/unknown rank as "no news". */
export const MOOD_RANK: Record<Mood, number> = { unknown: 0, offline: 0, calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 };

export type SleepPhase = 'idle' | 'settling' | 'asleep' | 'awake';
export type Severity = 'urgent' | 'warn' | 'info' | 'care';
export type AlertStatus = 'open' | 'acked' | 'resolved';
export type Pause = 'privacy' | 'interrupted' | 'hidden';
export type Role = 'parent' | 'caregiver' | 'viewer';
/** dB(A) band: quiet < 40 · normal < 55 · loud < 70 · very loud. */
export type DbBand = 0 | 1 | 2 | 3;
/** Added by the delivering client, never by the server. */
export type GlanceSource = 'cloud' | 'lan' | 'phone';

export interface GlanceSleep {
  p: SleepPhase;
  /** When this phase began (ms), or null when unknown. */
  s: number | null;
  /** Minutes asleep this session. */
  min: number;
  /** Wakings this session. */
  w: number;
}

export interface GlanceAlert {
  id: string;
  /** Kind, e.g. "cry", "offline", "zone". */
  k: string;
  sev: Severity;
  /** When it opened (ms). */
  at: number;
  st: AlertStatus;
  /** Who answered it ("Dad"), when someone did. */
  by?: string | null;
}

export interface GlanceCam {
  /** Cameras online now (0 = none). */
  on: number;
  /** Lowest battery among online cameras, %. */
  bat?: number | null;
  chg?: boolean | null;
  /** Set when every online camera's picture is paused (sound monitoring continues). */
  pz?: Pause | null;
  /** Last message from any camera (ms). */
  ls: number;
}

export interface GlanceDuty {
  nm: string;
  /** This device's person is the one on duty. */
  me: boolean;
  /** Until (ms). */
  u: number;
}

export interface GlanceV1 {
  v: 1;
  /** Nursery id. */
  n: string;
  /** Display name, ≤ 24 characters. Never in push payloads (devices cache it). */
  nm?: string;
  /** Per-nursery sequence; bumps only on a visible change (glanceBump.ts). */
  q: number;
  /** Server time when composed (ms). */
  at: number;
  m: Mood;
  /** When this mood began (ms). */
  ms: number;
  sl?: GlanceSleep;
  /** LAeq dB(A), integer. */
  db?: number | null;
  dbb?: DbBand;
  cam: GlanceCam;
  al?: GlanceAlert | null;
  du?: GlanceDuty | null;
  /** Soothing sound playing now. */
  so?: string | null;
  /** Who is talking into the nursery now. */
  tk?: string | null;
  /** What this device may do: see `CAN`. */
  can: number;
  src?: GlanceSource;
}

/** The `can` bitmask. */
export const CAN = { ack: 1, soothe: 2, listen: 4, talk: 8, peek: 16, duty: 32, log: 64 } as const;
export type CanName = keyof typeof CAN;
export const CAN_ALL = 127;

/**
 * Per role, as MonitorRoom enforces it today: viewers watch and listen (onAck, onCmd, onDuty
 * and logging refuse them); caregivers and parents can do everything a watch offers.
 */
export const ROLE_CAN: Record<Role, number> = {
  parent: CAN_ALL,
  caregiver: CAN_ALL,
  viewer: CAN.listen | CAN.peek,
};

/**
 * Share-link guests (least privilege, ADR D6.2): a viewer guest watches and listens; a
 * caregiver guest may also answer, soothe and talk, but not take duty (routing is for
 * members) or log (history and the tracker are opt-in per guest). Guests get no watch grant.
 */
export const GUEST_CAN: Record<Exclude<Role, 'parent'>, number> = {
  viewer: CAN.listen | CAN.peek,
  caregiver: CAN.ack | CAN.soothe | CAN.listen | CAN.talk | CAN.peek,
};

/** A device grant (watch) never exceeds a caregiver, whatever the person's own role. */
export const DEVICE_MAX_CAN = ROLE_CAN.caregiver;

export interface GlanceViewer {
  /** The account the device belongs to (for `du.me`). */
  uid?: string | null;
  role: Role;
  /** Joined with the share link. */
  guest?: boolean;
  /** The device grant's capability mask (watches); absent for a signed-in app or browser. */
  deviceCan?: number | null;
  /** Composing for a push payload: the nursery name is left out. */
  forPush?: boolean;
}

/** What one device may do: its role, narrowed for guests and by its device grant. */
export function glanceCan(viewer: Pick<GlanceViewer, 'role' | 'guest' | 'deviceCan'>): number {
  const role: Role = viewer.role === 'parent' || viewer.role === 'caregiver' ? viewer.role : 'viewer';
  let can = viewer.guest ? GUEST_CAN[role === 'parent' ? 'caregiver' : role] : ROLE_CAN[role];
  if (viewer.deviceCan != null) can &= viewer.deviceCan & DEVICE_MAX_CAN;
  return can & CAN_ALL;
}

export const hasCan = (can: number, what: CanName): boolean => (can & CAN[what]) !== 0;

/* ------------------------------------------------------------------ facts */

/** The nursery-wide facts a glance shows, before they're shaped for one viewer. */
export interface GlanceFacts {
  /** Nursery display name (clipped when composed). */
  nm: string;
  m: Mood;
  ms: number;
  sl: GlanceSleep | null;
  /** LAeq dB(A); null without a sound meter. */
  db: number | null;
  /**
   * When the room got that level (ms; null with `db`). It is how `nextBump` tells a new
   * measurement from a re-check on the same facts: a dB band moves only on measurements.
   * Never in a glance.
   */
  dbt: number | null;
  cam: { on: number; bat: number | null; chg: boolean | null; pz: Pause | null; ls: number };
  al: GlanceAlert | null;
  /** The uid stays here (for `me`); it never reaches a glance. */
  du: { uid: string; nm: string; u: number } | null;
  so: string | null;
  tk: string | null;
}

/** One camera as a room or an app knows it (structurally compatible with protocol.ts shapes). */
export interface GlanceCamInput {
  /** Connected and heard from recently — the caller's liveness rule decides. */
  online: boolean;
  /** Last message from it (ms). */
  at: number;
  /** When its current `st.state` began (ms); `at` when unknown. */
  since?: number | null;
  /** Its latest status (protocol.ts `CamStatus`, only the fields a glance needs). */
  st: {
    state: BabyState;
    battery?: number | null;
    charging?: boolean | null;
    soothing?: string | null;
    paused?: Pause | null;
    talk?: string | null;
    call?: string | null;
    spl?: { leq: number } | null;
  } | null;
  /**
   * Its latest minute row (protocol.ts `MinuteRow.laeq`) and when the room got it (ms). While
   * fresh (`MINUTE_FRESH_MS`) it is the level a glance shows, rather than the status's
   * 1-second Leq: it is what a parent means by "how loud is the room", a cough is averaged
   * into its minute, and it arrives every minute, so a band change is confirmed by measurements.
   */
  minute?: { laeq: number | null; at: number } | null;
}

/** An incident (protocol.ts `Incident`, only the fields a glance needs). */
export interface GlanceIncidentInput {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  status: AlertStatus;
  ack_by?: string | null;
  ack_at?: number | null;
  resolved_at?: number | null;
}

export interface GlanceRoomInput {
  name: string;
  cams: GlanceCamInput[];
  sleep?: { phase: SleepPhase; since: number | null; asleepMin: number; wakings: number } | null;
  incidents?: readonly GlanceIncidentInput[];
  duty?: { uid: string; name: string; until: number } | null;
}

/** A camera's minute row is its current level for this long (rows come every minute; one may be late). */
export const MINUTE_FRESH_MS = 3 * 60_000;

/** A resolved alert stays on the glance this long ("Resolved · 02:47"), then drops off. */
export const RESOLVED_SHOWN_MS = 30 * 60_000;

const SEV_RANK: Record<Severity, number> = { urgent: 3, warn: 2, info: 1, care: 0 };

/**
 * The alert a glance shows: the one that most needs a person — unanswered before answered,
 * then the most severe, then the newest. With none active, the last one resolved in the
 * past 30 minutes.
 */
export function pickAlert(incidents: readonly GlanceIncidentInput[] | undefined, now: number): GlanceAlert | null {
  if (!incidents?.length) return null;
  const active = incidents.filter((i) => i.status === 'open' || i.status === 'acked');
  if (active.length) {
    const best = active.reduce((a, b) => (alertOrder(b, a) < 0 ? b : a));
    return toAlert(best);
  }
  let last: GlanceIncidentInput | null = null;
  for (const i of incidents) {
    if (i.status !== 'resolved') continue;
    const at = i.resolved_at ?? i.at;
    if (now - at > RESOLVED_SHOWN_MS) continue;
    if (!last || at > (last.resolved_at ?? last.at)) last = i;
  }
  return last ? toAlert(last) : null;
}

/** Negative when `a` should be shown before `b`. */
function alertOrder(a: GlanceIncidentInput, b: GlanceIncidentInput): number {
  const open = (i: GlanceIncidentInput) => (i.status === 'open' ? 1 : 0);
  return open(b) - open(a) || SEV_RANK[b.sev] - SEV_RANK[a.sev] || b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function toAlert(i: GlanceIncidentInput): GlanceAlert {
  return { id: i.id, k: i.kind, sev: i.sev, at: i.at, st: i.status, by: i.status === 'open' ? null : i.ack_by ?? null };
}

const PAUSES: readonly Pause[] = ['privacy', 'interrupted', 'hidden'];

/**
 * The facts from what a room (or an app) knows. With several cameras: the worst mood wins
 * (its camera also gives the dB: its minute LAeq while fresh, else its status's 1-second
 * Leq, with when the room got it), and it began when the last camera to reach it did — a twin
 * settling an hour after her sister is when the nursery settled; the lowest battery is shown;
 * the picture counts as paused only when every online camera is paused. No camera at all is
 * `unknown`; cameras that have all stopped answering are `offline`.
 *
 * `ms` is the best a snapshot can say. Which camera held the mood before is history, which
 * `nextBump` keeps: it dates a mood it saw begin, and keeps a shown mood's start.
 */
export function glanceFacts(room: GlanceRoomInput, now: number): GlanceFacts {
  const online = room.cams.filter((c) => c.online);
  const ls = room.cams.reduce((t, c) => Math.max(t, c.at || 0), 0);
  let m: Mood;
  let ms: number;
  let db: number | null = null;
  let dbt: number | null = null;
  let primary: GlanceCamInput | null = null;
  if (!room.cams.length) {
    m = 'unknown';
    ms = now;
  } else if (!online.length) {
    m = 'offline';
    ms = ls || now;
  } else {
    for (const c of online) {
      if (!primary || rankOf(c) > rankOf(primary)) primary = c;
    }
    const st = primary!.st;
    // A state this contract doesn't know (a newer camera) reads as "waiting", never as a bad glance.
    m = st && (BABY_STATES as readonly string[]).includes(st.state) ? st.state : 'unknown';
    const top = rankOf(primary!);
    ms = Math.min(now, Math.max(...online.filter((c) => rankOf(c) === top).map((c) => c.since ?? c.at)));
    const row = primary!.minute;
    if (row && typeof row.laeq === 'number' && Number.isFinite(row.laeq) && now - row.at <= MINUTE_FRESH_MS) {
      db = Math.round(row.laeq);
      dbt = Math.min(now, row.at);
    } else if (st?.spl && Number.isFinite(st.spl.leq)) {
      db = Math.round(st.spl.leq);
      dbt = Math.min(now, primary!.at);
    }
  }
  let bat: number | null = null;
  let chg: boolean | null = null;
  for (const c of online) {
    const b = c.st?.battery;
    if (typeof b === 'number' && Number.isFinite(b) && (bat == null || b < bat)) {
      bat = Math.max(0, Math.min(100, Math.round(b)));
      chg = c.st?.charging ?? null;
    }
  }
  const paused = online.map((c) => c.st?.paused ?? null);
  const pz = paused.length && paused.every((p) => p && PAUSES.includes(p)) ? paused[0] : null;
  const so = firstText(online.map((c) => c.st?.soothing));
  const tk = firstText(online.map((c) => c.st?.talk ?? c.st?.call));
  const duty = room.duty && room.duty.until > now ? room.duty : null;
  const sl = room.sleep
    ? {
        p: room.sleep.phase,
        s: room.sleep.since ?? null,
        min: Math.max(0, Math.round(room.sleep.asleepMin || 0)),
        w: Math.max(0, Math.round(room.sleep.wakings || 0)),
      }
    : null;
  return {
    nm: room.name,
    m,
    ms,
    sl,
    db,
    dbt,
    cam: { on: online.length, bat, chg, pz, ls },
    al: pickAlert(room.incidents, now),
    du: duty ? { uid: duty.uid, nm: duty.name, u: duty.until } : null,
    so,
    tk,
  };
}

const rankOf = (c: GlanceCamInput): number => (c.st ? MOOD_RANK[c.st.state] ?? 0 : -1);

function firstText(xs: (string | null | undefined)[]): string | null {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
}

/* ---------------------------------------------------------------- compose */

/** The published state of one nursery: what `nextBump` keeps (glanceBump.ts `BumpState`). */
export interface GlanceRoomState {
  nid: string;
  q: number;
  /** Compose time (ms). */
  at: number;
  facts: GlanceFacts;
  /** The dB band as published (with hysteresis); derived from `facts.db` when absent. */
  dbb?: DbBand | null;
}

/**
 * Field limits (characters). Ids are the room's own (12 characters today, never more than
 * 20) and are never shortened with an ellipsis: an id that doesn't round-trip can't be acted on.
 */
export const GLANCE_LIMITS = { nm: 24, name: 20, kind: 16, id: 20, sound: 20 } as const;
/** A glance is never larger than this as UTF-8 JSON: long names are shortened to fit (`composeGlance`). */
export const GLANCE_MAX_BYTES = 512;

/** quiet < 40 · normal < 55 · loud < 70 · very loud. */
export const DB_BANDS = [40, 55, 70] as const;

/** The dB band, without hysteresis (glanceBump.ts adds 2 dB of it around each edge). */
export function dbBand(db: number | null | undefined): DbBand | null {
  if (db == null || !Number.isFinite(db)) return null;
  return db < DB_BANDS[0] ? 0 : db < DB_BANDS[1] ? 1 : db < DB_BANDS[2] ? 2 : 3;
}

/** Shape the published facts for one device. Pure: same input, same glance. */
export function composeGlance(state: GlanceRoomState, viewer: GlanceViewer): GlanceV1 {
  const f = state.facts;
  const db = f.db != null && Number.isFinite(f.db) ? Math.round(f.db) : null;
  const dbb = db == null ? null : state.dbb !== undefined ? state.dbb : dbBand(db);
  const cam: GlanceCam = {
    on: Math.max(0, Math.round(f.cam.on)),
    ...(f.cam.bat != null ? { bat: Math.round(f.cam.bat) } : {}),
    ...(f.cam.chg != null ? { chg: f.cam.chg } : {}),
    ...(f.cam.pz ? { pz: f.cam.pz } : {}),
    ls: Math.round(f.cam.ls),
  };
  const al: GlanceAlert | null = f.al
    ? {
        id: String(f.al.id).slice(0, GLANCE_LIMITS.id),
        k: clipText(f.al.k, GLANCE_LIMITS.kind),
        sev: f.al.sev,
        at: Math.round(f.al.at),
        st: f.al.st,
        ...(f.al.by ? { by: clipText(f.al.by, GLANCE_LIMITS.name) } : {}),
      }
    : null;
  // One literal, so every glance serialises in the same key order (v, n, nm, q, at, m, …, can).
  return fitGlance({
    v: 1,
    n: state.nid,
    ...(viewer.forPush ? {} : { nm: clipText(f.nm, GLANCE_LIMITS.nm) || 'Nursery' }),
    q: state.q,
    at: Math.round(state.at),
    m: f.m,
    ms: Math.round(f.ms),
    ...(f.sl ? { sl: { p: f.sl.p, s: f.sl.s == null ? null : Math.round(f.sl.s), min: Math.round(f.sl.min), w: Math.round(f.sl.w) } } : {}),
    ...(db != null ? { db } : {}),
    ...(dbb != null ? { dbb } : {}),
    cam,
    ...(al ? { al } : {}),
    ...(f.du ? { du: { nm: clipText(f.du.nm, GLANCE_LIMITS.name) || 'Someone', me: !!viewer.uid && viewer.uid === f.du.uid, u: Math.round(f.du.u) } } : {}),
    ...(f.so ? { so: clipText(f.so, GLANCE_LIMITS.sound) } : {}),
    ...(f.tk ? { tk: clipText(f.tk, GLANCE_LIMITS.name) } : {}),
    can: glanceCan(viewer),
  });
}

/** The free-text fields, in the order they give way (on a tie) when a glance is over budget. */
const FIT_ORDER = ['tk', 'so', 'by', 'du', 'nm'] as const;
type FitField = (typeof FIT_ORDER)[number];

/**
 * Keep a glance within `GLANCE_MAX_BYTES`: shorten the longest free-text field (who is
 * talking, the sound, who answered, who is on duty, the nursery name) a character at a
 * time, never below 4 characters, then drop talk / sound / answered-by if it still doesn't
 * fit. Ids, kinds, numbers and states are never touched. Only very long names (or emoji)
 * ever get here.
 */
function fitGlance(g: GlanceV1): GlanceV1 {
  if (glanceBytes(g) <= GLANCE_MAX_BYTES) return g;
  const out: GlanceV1 = { ...g, cam: { ...g.cam }, ...(g.al ? { al: { ...g.al } } : {}), ...(g.du ? { du: { ...g.du } } : {}) };
  const get = (k: FitField): string | null | undefined => (k === 'by' ? out.al?.by : k === 'du' ? out.du?.nm : out[k]);
  const set = (k: FitField, v: string): void => {
    if (k === 'by') out.al!.by = v;
    else if (k === 'du') out.du!.nm = v;
    else out[k] = v;
  };
  const size = (v: string | null | undefined): number => (v ? utf8Length(v) : 0);
  for (let guard = 0; guard < 200 && glanceBytes(out) > GLANCE_MAX_BYTES; guard++) {
    let pick: FitField | null = null;
    for (const k of FIT_ORDER) {
      const v = get(k);
      if (v && Array.from(v).length > 4 && (!pick || size(v) > size(get(pick)))) pick = k;
    }
    if (!pick) break;
    const cps = Array.from(get(pick)!);
    const base = cps[cps.length - 1] === '…' ? cps.slice(0, -1) : cps;
    set(pick, base.slice(0, base.length - 1).join('').trimEnd() + '…');
  }
  if (glanceBytes(out) > GLANCE_MAX_BYTES) delete out.tk;
  if (glanceBytes(out) > GLANCE_MAX_BYTES) delete out.so;
  if (glanceBytes(out) > GLANCE_MAX_BYTES && out.al) delete out.al.by;
  return out;
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * The Live Activity fallback when its content state can't be encrypted (ADR D3): a coarse
 * enum only — mood, since, sleep phase and alert status; no names, no ids.
 */
export function coarseGlance(g: GlanceV1): { m: Mood; ms: number; sl?: { p: SleepPhase }; al?: { st: AlertStatus } } {
  return { m: g.m, ms: g.ms, ...(g.sl ? { sl: { p: g.sl.p } } : {}), ...(g.al ? { al: { st: g.al.st } } : {}) };
}

/** The glance a client shows, marked with how it arrived (never set by the server). */
export const withSource = (g: GlanceV1, src: GlanceSource): GlanceV1 => ({ ...g, src });

/**
 * The HTTP validator for GET /glance. `q` alone is not enough: the same `q` composes
 * differently for a device whose role changed or that just went on duty, so those parts of
 * the per-device glance are in it too.
 */
export function glanceEtag(g: Pick<GlanceV1, 'q' | 'can' | 'du'>): string {
  return `"${g.q}.${g.can}${g.du?.me ? '.d' : ''}"`;
}

/** True when an `If-None-Match` header already names this glance (304 Not Modified). */
export function glanceNotModified(ifNoneMatch: string | null | undefined, g: Pick<GlanceV1, 'q' | 'can' | 'du'>): boolean {
  if (!ifNoneMatch) return false;
  const tag = glanceEtag(g);
  return ifNoneMatch.split(',').some((t) => {
    const s = t.trim();
    return s === '*' || s === tag || s === `W/${tag}`;
  });
}

/** UTF-8 size of a glance as JSON. */
export function glanceBytes(g: GlanceV1): number {
  return utf8Length(JSON.stringify(g));
}

/** Tidy (control characters out, single spaces) and clip to `max` characters (code points), ending in "…" when cut. */
export function clipText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const cps = Array.from(t);
  return cps.length <= max ? t : cps.slice(0, max - 1).join('').trimEnd() + '…';
}

/* ----------------------------------------------------------------- decode */

const SLEEP_PHASES: readonly SleepPhase[] = ['idle', 'settling', 'asleep', 'awake'];
const SEVERITIES: readonly Severity[] = ['urgent', 'warn', 'info', 'care'];
const STATUSES: readonly AlertStatus[] = ['open', 'acked', 'resolved'];
const SOURCES: readonly GlanceSource[] = ['cloud', 'lan', 'phone'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optStr = (v: unknown, max: number): boolean => v == null || (typeof v === 'string' && Array.from(v).length <= max);
/**
 * Decoders accept text up to this many characters — more than the composer ever sends
 * (`GLANCE_LIMITS`), so a later, roomier composer doesn't break watches already shipped.
 */
export const DECODE_TEXT_MAX = 64;

/**
 * A glance from the wire (socket, HTTP, LAN, a decrypted push), or null when it isn't a
 * valid Glance v1. Unknown fields are ignored; absent and null optionals mean "none".
 */
export function parseGlance(v: unknown): GlanceV1 | null {
  if (!isObj(v) || v.v !== 1) return null;
  if (typeof v.n !== 'string' || !v.n || v.n.length > 64) return null;
  if (!optStr(v.nm, DECODE_TEXT_MAX)) return null;
  if (!isInt(v.q) || v.q < 0 || !isInt(v.at) || !isInt(v.ms)) return null;
  if (typeof v.m !== 'string' || !(MOODS as readonly string[]).includes(v.m)) return null;
  if (!isInt(v.can) || v.can < 0 || v.can > CAN_ALL) return null;
  const cam = v.cam;
  if (!isObj(cam) || !isInt(cam.on) || cam.on < 0 || !isInt(cam.ls)) return null;
  if (cam.bat != null && (!isNum(cam.bat) || cam.bat < 0 || cam.bat > 100)) return null;
  if (cam.chg != null && typeof cam.chg !== 'boolean') return null;
  if (cam.pz != null && !(PAUSES as readonly unknown[]).includes(cam.pz)) return null;
  const out: GlanceV1 = {
    v: 1,
    n: v.n,
    ...(typeof v.nm === 'string' ? { nm: v.nm } : {}),
    q: v.q,
    at: v.at,
    m: v.m as Mood,
    ms: v.ms,
    cam: {
      on: cam.on,
      ls: cam.ls,
      ...(cam.bat != null ? { bat: cam.bat as number } : {}),
      ...(cam.chg != null ? { chg: cam.chg as boolean } : {}),
      ...(cam.pz != null ? { pz: cam.pz as Pause } : {}),
    },
    can: v.can,
  };
  if (v.sl != null) {
    const sl = v.sl;
    if (!isObj(sl) || !(SLEEP_PHASES as readonly unknown[]).includes(sl.p)) return null;
    if (!(sl.s === null || isInt(sl.s)) || !isInt(sl.min) || !isInt(sl.w)) return null;
    out.sl = { p: sl.p as SleepPhase, s: sl.s as number | null, min: sl.min, w: sl.w };
  }
  if (v.db != null) {
    if (!isInt(v.db)) return null;
    out.db = v.db;
  }
  if (v.dbb != null) {
    if (v.dbb !== 0 && v.dbb !== 1 && v.dbb !== 2 && v.dbb !== 3) return null;
    out.dbb = v.dbb;
  }
  if (v.al != null) {
    const al = v.al;
    if (!isObj(al) || typeof al.id !== 'string' || !al.id || typeof al.k !== 'string') return null;
    if (!(SEVERITIES as readonly unknown[]).includes(al.sev) || !(STATUSES as readonly unknown[]).includes(al.st) || !isInt(al.at)) return null;
    if (!optStr(al.by, DECODE_TEXT_MAX) || al.id.length > DECODE_TEXT_MAX || al.k.length > DECODE_TEXT_MAX) return null;
    out.al = { id: al.id, k: al.k, sev: al.sev as Severity, at: al.at, st: al.st as AlertStatus, ...(typeof al.by === 'string' ? { by: al.by } : {}) };
  }
  if (v.du != null) {
    const du = v.du;
    if (!isObj(du) || typeof du.nm !== 'string' || !optStr(du.nm, DECODE_TEXT_MAX) || typeof du.me !== 'boolean' || !isInt(du.u)) return null;
    out.du = { nm: du.nm, me: du.me, u: du.u };
  }
  if (!optStr(v.so, DECODE_TEXT_MAX) || !optStr(v.tk, DECODE_TEXT_MAX)) return null;
  if (typeof v.so === 'string') out.so = v.so;
  if (typeof v.tk === 'string') out.tk = v.tk;
  if (v.src != null) {
    if (!(SOURCES as readonly unknown[]).includes(v.src)) return null;
    out.src = v.src as GlanceSource;
  }
  return out;
}
