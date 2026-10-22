/**
 * MonitorRoom — one Durable Object per nursery (Baby Monitor).
 *
 * NEVER RECORDS. Video and audio flow peer-to-peer between the baby's camera
 * device and the family's viewing devices (WebRTC, DTLS-SRTP encrypted end to
 * end). This room:
 *   - authenticates every socket against Supabase (the member's own bearer
 *     token → monitor_my_role) before it can see or send anything,
 *   - relays WebRTC signaling between members of THIS nursery,
 *   - fans out the camera's on-device analysis (state, sound level, motion,
 *     what it hears and sees) and keeps the nursery's history in its own
 *     SQLite database (monitorStore.ts): events, per-minute measurements,
 *     sleep sessions, incidents,
 *   - runs the alert engine: incidents that need a person are pushed to the
 *     right people, repeated or escalated until someone answers "I'm on it",
 *   - tracks sleep from the camera's minutes (sleepTracker.ts) and sends the
 *     morning report,
 *   - watches camera heartbeats and raises "camera offline" alerts,
 *   - forwards the camera's relay picture to viewers whose network blocks P2P,
 *     who are still connecting (the instant picture), or who arrive when the
 *     camera's direct slots are full: real video (WebCodecs H.264 / VP8 /
 *     VP9, 10–15 fps) with its sound, or 640 px JPEGs for browsers that can't
 *     decode it. Frames and sound pass through this object's memory — NOT
 *     end-to-end encrypted (only P2P, direct or through TURN, is) — and are
 *     never stored. Routed by codec, throttled per camera (token bucket,
 *     25 messages/s), and each viewer acknowledges what it got: one that falls
 *     behind skips to the next key frame instead of drifting seconds late,
 *     and keeps its sound meanwhile (relayWire.ts),
 *   - is the family's switchboard for video calls between members
 *     (familyCalls.ts): rings their 'line' sockets and phones, relays the
 *     handshake between the people in a call.
 *
 * The singleton instance named KEY_HOLDER only stores the VAPID key pair.
 */

import { iceServers } from './ice';
import { audioOnly, bareJpeg, KIND_AUDIO, KIND_JPEG, KIND_VIDEO, KIND_VIDEO_AUDIO, readHead, seqDiff, type RelayHead } from './relayWire';
import { CallBook, LOG_CAP as CALL_LOG_CAP, missedBy, RING_MS, toRecord, type Call, type CallRecord, type CallStat } from './familyCalls';
import { GuestAccess, LOCK_MS, passcodeProblem, type GuestRole } from './monitorGuests';
import { sanitizeTrack, TrackerStore, type TrackRow } from './trackerStore';
import { clockTime, isValidTz, localIso, localParts, MonitorStore, type IncidentRow, type MinuteRow, type Severity, type SleepRow, type StoredEvent } from './monitorStore';
import { endSession, manualSleep, manualWake, newSleepSm, sessionKind, stepSleep, type SleepEvent, type SleepSm, type SleepStats } from './sleepTracker';
import { bearerFrom, callRpc, verifyMember, type LiveIdentity, type SupabaseEnv } from './supabaseAuth';
import { generateVapidKeys, isAllowedPushEndpoint, sendWebPush, type PushSubscriptionJSONLike, type VapidKeys } from './webpush';

export const KEY_HOLDER = '__vapid_keys__';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type MonRole = 'parent' | 'caregiver' | 'viewer';
/**
 * 'admin' = a parent's control connection while managing people or the share
 * link from outside the watch screen (the Invite sheet): never in presence,
 * a slim hello, no monitor broadcasts, and only the messages in ADMIN_MSGS.
 * 'line' = a member's app, open anywhere, reachable for family calls (never in presence).
 */
export type MonMode = 'camera' | 'viewer' | 'admin' | 'line';
export type BabyState = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
const BABY_STATES: BabyState[] = ['calm', 'stirring', 'awake', 'noisy', 'fussing', 'crying'];

/** Background-alert categories a device can opt into (and their defaults). */
const PUSH_KINDS = ['cry', 'fuss', 'cough', 'alarm', 'glass', 'crash', 'zone', 'cat', 'loud', 'noise', 'camera', 'offline', 'battery', 'report', 'insight', 'guest'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
const PUSH_DEFAULTS: Record<PushKind, boolean> = {
  cry: true, fuss: false, cough: true, alarm: true, glass: true, crash: true, zone: true, cat: true,
  loud: false, noise: true, camera: true, offline: true, battery: true, report: true, insight: true, guest: true,
};

/**
 * Sound categories the camera's on-device detector reports (mirror of
 * live/monitor/soundClasses.ts). Unknown categories are ignored.
 */
export type SoundCat =
  | 'cry' | 'fuss' | 'cough' | 'sneeze' | 'snore' | 'hiccup' | 'babble' | 'laugh'
  | 'alarm' | 'glass' | 'crash' | 'loud' | 'voices' | 'music' | 'dog' | 'cat' | 'door' | 'footsteps' | 'water';
const SOUND: Record<SoundCat, { headline: string; sev: Severity; push: PushKind | null; gapMs: number; ends?: boolean; hazard?: HazardKind }> = {
  cry: { headline: '{baby} is crying', sev: 'urgent', push: 'cry', gapMs: 20_000, ends: true, hazard: 'cry' },
  fuss: { headline: '{baby} is fussing', sev: 'warn', push: 'fuss', gapMs: 60_000, ends: true },
  cough: { headline: '{baby} is coughing', sev: 'warn', push: 'cough', gapMs: 60_000 },
  sneeze: { headline: '{baby} sneezed', sev: 'info', push: null, gapMs: 2 * 60_000 },
  snore: { headline: 'Snoring or noisy breathing', sev: 'info', push: null, gapMs: 20 * 60_000 },
  hiccup: { headline: '{baby} has the hiccups', sev: 'info', push: null, gapMs: 15 * 60_000 },
  babble: { headline: '{baby} is awake and babbling', sev: 'info', push: null, gapMs: 10 * 60_000 },
  laugh: { headline: '{baby} is laughing', sev: 'info', push: null, gapMs: 10 * 60_000 },
  alarm: { headline: 'Alarm sounding in the nursery — check for smoke or CO', sev: 'urgent', push: 'alarm', gapMs: 30_000, hazard: 'alarm' },
  glass: { headline: 'Glass breaking in the nursery', sev: 'urgent', push: 'glass', gapMs: 60_000, hazard: 'glass' },
  crash: { headline: 'Loud bang or crash in the nursery', sev: 'warn', push: 'crash', gapMs: 60_000, hazard: 'crash' },
  loud: { headline: 'Loud sound in the nursery', sev: 'warn', push: 'loud', gapMs: 5 * 60_000 },
  voices: { headline: 'Someone is talking in the nursery', sev: 'info', push: null, gapMs: 15 * 60_000 },
  music: { headline: 'Music or TV playing in the nursery', sev: 'info', push: null, gapMs: 30 * 60_000 },
  dog: { headline: 'Dog barking near the nursery', sev: 'info', push: null, gapMs: 5 * 60_000 },
  cat: { headline: 'A cat is in or near the nursery', sev: 'warn', push: 'cat', gapMs: 10 * 60_000 },
  door: { headline: 'Knocking at the nursery door', sev: 'info', push: null, gapMs: 2 * 60_000 },
  footsteps: { headline: 'Footsteps in the nursery', sev: 'info', push: null, gapMs: 5 * 60_000 },
  water: { headline: 'Water running nearby', sev: 'info', push: null, gapMs: 10 * 60_000 },
};
const isSoundCat = (v: unknown): v is SoundCat => typeof v === 'string' && v in SOUND;

/** What the camera's vision reports (mirror of live/monitor/vision.ts). */
type VisionType = 'zone' | 'crib_out' | 'visit_start' | 'visit_end' | 'lights_on' | 'lights_off' | 'dark' | 'moved';
const VISION_TYPES: VisionType[] = ['zone', 'crib_out', 'visit_start', 'visit_end', 'lights_on', 'lights_off', 'dark', 'moved'];

/**
 * Alerts that need a person. `everyone`: all devices at once; otherwise the
 * person on duty first. `repeatMs`: push again until acknowledged;
 * `escalateMs`: one more push to everyone if nobody answered.
 */
export type HazardKind = 'alarm' | 'glass' | 'crash' | 'zone' | 'crib_out' | 'cry' | 'very_loud' | 'moved' | 'paused' | 'offline' | 'object';
const HAZARD: Record<HazardKind, { push: PushKind; everyone: boolean; repeatMs?: number; escalateMs?: number; maxPushes: number; staleMs: number }> = {
  alarm: { push: 'alarm', everyone: true, repeatMs: 60_000, maxPushes: 10, staleMs: 60 * 60_000 },
  glass: { push: 'glass', everyone: true, escalateMs: 3 * 60_000, maxPushes: 2, staleMs: 60 * 60_000 },
  crash: { push: 'crash', everyone: false, escalateMs: 5 * 60_000, maxPushes: 2, staleMs: 60 * 60_000 },
  zone: { push: 'zone', everyone: true, repeatMs: 2 * 60_000, maxPushes: 5, staleMs: 30 * 60_000 },
  crib_out: { push: 'zone', everyone: true, repeatMs: 2 * 60_000, maxPushes: 5, staleMs: 30 * 60_000 },
  object: { push: 'zone', everyone: true, escalateMs: 3 * 60_000, maxPushes: 2, staleMs: 30 * 60_000 },
  cry: { push: 'cry', everyone: false, maxPushes: 4, staleMs: 2 * 60 * 60_000 },
  very_loud: { push: 'noise', everyone: true, maxPushes: 1, staleMs: 30 * 60_000 },
  moved: { push: 'camera', everyone: false, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 2 * 60 * 60_000 },
  paused: { push: 'camera', everyone: true, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 6 * 60 * 60_000 },
  offline: { push: 'offline', everyone: true, escalateMs: 10 * 60_000, maxPushes: 2, staleMs: 6 * 60 * 60_000 },
};

export interface MonEnv extends SupabaseEnv {
  MONITOR_ROOM: DurableObjectNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

interface Attach {
  sid: string;
  at: number;
  authed: boolean;
  uid?: string;
  name?: string;
  role?: MonRole;
  label?: string | null;
  mode?: MonMode;
  dev?: string;
  dn?: string;
  /** Viewer: camera device id it wants relayed snapshots from. */
  relay?: string;
  /**
   * Viewer on the relay: the video codecs it decodes (bit 0 H.264, 1 VP8,
   * 2 VP9; 0 = JPEG only). Absent = a viewer from before the framed format
   * (bare JPEGs only, no acknowledgements).
   */
  rc?: number;
  /** On the relay only while its direct picture connects (not shown as "on the relay"). */
  ri?: boolean;
  /** Joined with the share link + passcode (no account): the guest's id. */
  guest?: string;
}

export interface SplStatus {
  /** Fast A-weighted level now, dB. */
  db: number;
  /** Leq over the last second, dB. */
  leq: number;
  /** Fast max over the last second, dB. */
  max: number;
  /** The phone's meter has been calibrated. */
  cal: boolean;
}

export interface CamStatus {
  state: BabyState;
  /** Sound level above the room's noise floor, dB (0–60). */
  level: number;
  /** Motion 0–100. */
  motion: number;
  /** Mean luminance 0–255 — low = dark room. */
  light: number;
  battery: number | null;
  charging: boolean | null;
  soothing: string | null;
  cry: number;
  /** Most important sound right now + what the AI hears (top 3, 0–100). */
  sound: SoundCat | null;
  conf: number;
  top: [SoundCat, number][];
  model: 'off' | 'loading' | 'ready' | 'failed';
  paused: 'privacy' | 'interrupted' | 'hidden' | null;
  /** How the camera keeps its screen on; 'none' = it may lock and pause the video. */
  awake: 'native' | 'video' | 'none' | null;
  talk: string | null;
  call: string | null;
  /** Sound level meter (A-weighted dB), null if the phone can't measure. */
  spl: SplStatus | null;
  /** Movement in the crib zone / outside it (null without a crib zone). */
  crib: number | null;
  outside: number | null;
  /** An adult is in the room right now. */
  visit: boolean;
  /** Smart vision (beta): what the camera can tell about the baby right now. */
  scene?: SceneStatus | null;
  /** The camera phone's video encoders (live/monitor/rtc.ts CameraHub.telemetry). */
  enc?: EncStatus | null;
}

export interface EncStatus {
  /** Viewers connected peer-to-peer. */
  peers: number;
  /** Frames per second sent to the slowest viewer. */
  fps: number | null;
  /** Worst limitation: the phone's processor, the network, other, none. */
  lim: 'cpu' | 'bandwidth' | 'other' | 'none' | null;
  /** Encoder implementation ("MediaCodec", "libvpx", …). */
  impl: string | null;
  /** Widest picture sent, px. */
  w: number | null;
  /** Rungs stepped down because the phone is busy. */
  p: number;
  /** Relay pictures per second (0 = off). */
  relay: number;
  /** What the relay sends: a video codec or JPEG (only when known). */
  rc?: 'avc' | 'vp8' | 'vp9' | 'jpeg';
}

export interface SceneStatus {
  baby: boolean;
  posture: 'lying' | 'sitting' | 'standing' | null;
  where: string | null;
  holding: string | null;
  near: string[];
  adult: boolean;
}

/** COCO labels the camera may report (scene.ts). Anything else is dropped. */
const SCENE_LABELS = new Set([
  'teddy bear', 'sports ball', 'book', 'bottle', 'spoon', 'toothbrush', 'frisbee', 'kite',
  'scissors', 'knife', 'fork', 'cup', 'wine glass', 'cell phone', 'remote', 'hair drier', 'potted plant', 'cat', 'dog',
]);
const SHARP = new Set(['scissors', 'knife', 'fork']);
const RISK_WHY: Record<string, string> = {
  scissors: 'sharp', knife: 'sharp', fork: 'sharp', cup: 'hot drinks can scald', 'wine glass': 'glass can break', 'cell phone': 'cords and small parts',
  remote: 'button batteries are dangerous if swallowed', 'hair drier': 'cord and heat', 'potted plant': 'soil and leaves can be swallowed', cat: 'a pet close to the baby', dog: 'a pet close to the baby',
};
const sceneLabel = (v: unknown): string | null => (typeof v === 'string' && SCENE_LABELS.has(v) ? v : null);
const a_an = (w: string) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

/** A log line as clients see it. */
export interface MonLog {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  msg: string;
  by?: string;
  dev?: string;
  secs?: number;
  conf?: number;
  db?: number;
  incident?: string;
}

/** A device that wants to ring for family calls while the app is closed. */
interface CallPushRec {
  sub: PushSubscriptionJSONLike;
  uid: string;
  at: number;
}

interface PushRec {
  sub: PushSubscriptionJSONLike;
  uid: string;
  name: string;
  /** Role when subscribed (parents-only notices, e.g. a new guest). */
  role?: MonRole;
  prefs: Record<string, boolean>;
  at: number;
}

export interface Zone {
  id: string;
  kind: 'crib' | 'danger' | 'activity';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Settings {
  sensitivity: 'low' | 'medium' | 'high';
  /** Minutes between repeated cry pushes once a cry has escalated. */
  cryRepeatMin: number;
  /** Minutes of crying with nobody answering before everyone is alerted. */
  cryEscalateMin: number;
  /** "Loud" threshold for the sound meter, dB(A); null = off. */
  noiseDb: number | null;
  /** Warn when a steady sound (white-noise machine) averages over 50 dB for an hour. */
  machineCheck: boolean;
  sleepTracking: boolean;
  /** Zones per camera device. */
  zones: Record<string, Zone[]>;
  /** The nursery's time zone (from its camera phone). */
  tz: string;
  /** The baby, for the tracker's age-based guidance (wake windows, growth percentiles). */
  baby?: { birth: string | null; sex: 'f' | 'm' | null };
}

interface Duty {
  uid: string;
  name: string;
  until: number;
}

/** A member as Supabase's monitor_people lists them. */
interface Person {
  user_id?: unknown;
  role?: unknown;
  label?: unknown;
}

const DEFAULT_SETTINGS: Settings = {
  sensitivity: 'medium', cryRepeatMin: 3, cryEscalateMin: 5, noiseDb: 70, machineCheck: true, sleepTracking: true, zones: {}, tz: 'UTC',
};
const AUTH_TIMEOUT_MS = 10_000;
const ALARM_MS = 15_000;
const BEAT_STALE_MS = 45_000;
const OFFLINE_GRACE_MS = 20_000;
const LOG_HELLO = 150;
const TL_BUCKET_MS = 5 * 60_000;
const TL_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_SOCKETS = 14;
/** Family members' apps listening for calls (separate from the monitor's devices). */
const MAX_LINES = 24;
const CALL_PUSH_CAP = 40;
/** While a call is up, the alarm checks its lines this often… */
const LINE_CHECK_MS = 30_000;
/** …and drops a line in the call that hasn't pinged or said anything for this long (half-open socket). */
const LINE_STALE_MS = 60_000;
/** All an 'admin' socket (the Invite sheet off the watch screen) may send. */
const ADMIN_MSGS = new Set(['members_changed', 'share_set', 'share_off', 'share_pass', 'share_extend', 'guest_remove', 'request_dismiss', 'ping']);
const MAX_CAMERAS = 4;
const PUSH_CAP = 40;
const FRAME_MAX = 8 * 1024;
const RTC_FRAME_MAX = 64 * 1024;
/** Relay frames per camera: sustained rate, burst, and bytes per second. */
const RELAY_FPS = 25;
const RELAY_BURST = 8;
const RELAY_BYTES_PER_S = 1536 * 1024;
/**
 * A viewer's relay window, in the camera's messages (≈15 a second; viewers
 * acknowledge every 500 ms): more than RELAY_LAG (≈2 s) forwarded but not yet
 * acknowledged and it skips video until a key frame arrives with no more than
 * RELAY_RESUME (≈1 s) in flight — sound keeps going meanwhile. Past RELAY_DEAD
 * with no acknowledgement for 3 s it gets nothing.
 *
 * The window never freezes for good: a viewer whose acknowledgements stopped
 * for RELAY_PROBE_MS while nothing reached it (after a stall it may never
 * have acknowledged the end of the burst) gets one message that stands alone
 * — a key frame, a JPEG or sound — and its answer reopens the window. Quiet
 * for RELAY_PROBE_SLOW_AFTER_MS, it's probably gone: one every
 * RELAY_PROBE_SLOW_MS, and no key-frame requests for it.
 */
const RELAY_LAG = 30;
const RELAY_RESUME = 15;
const RELAY_DEAD = 150;
const RELAY_PROBE_MS = 1000;
const RELAY_PROBE_SLOW_AFTER_MS = 10_000;
const RELAY_PROBE_SLOW_MS = 5000;
/** At most one key-frame request per camera per second (the camera also sends one every 2 s)… */
const RELAY_KEY_GAP_MS = 1000;
/** …and one per viewer every 2 s, so a viewer that keeps falling behind can't drive the camera to one a second. */
const RELAY_VIEWER_KEY_MS = 2000;
/** A camera that sent no video for this long is treated as JPEG-only. */
const RELAY_VIDEO_STALE_MS = 5000;
const PURGE_EVERY_MS = 6 * 60 * 60_000;
const MACHINE_DB = 50;
const MACHINE_GAP_MS = 12 * 60 * 60_000;
const STATE_RANK: Record<BabyState, number> = { calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 };
const PUSH_COOLDOWN_MS: Record<string, number> = {
  alarm: 60_000, glass: 2 * 60_000, zone: 2 * 60_000, fuss: 10 * 60_000, cough: 10 * 60_000, crash: 10 * 60_000, cat: 15 * 60_000,
  loud: 10 * 60_000, noise: 10 * 60_000, camera: 10 * 60_000, offline: 5 * 60_000, battery: 30 * 60_000, insight: 6 * 60 * 60_000, guest: 0,
};
const PUSH_URGENT = new Set<PushKind>(['cry', 'alarm', 'glass', 'zone', 'offline', 'noise']);
const VAPID_SUBJECT = 'https://dreamstreamstudio.ai';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const numOrNull = (v: unknown, lo: number, hi: number) => (v == null || !Number.isFinite(Number(v)) ? null : num(v, lo, hi));
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const dur = (secs: number) => (secs >= 3600 ? `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min` : secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`);
/** How a nursery reads in calls: "Aria’s family". */
const familyOf = (m: { name: string; baby: string | null }) => (m.baby ? `${m.baby}’s family` : m.name);
const hm = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`);

/** Severity of the log kinds the room writes itself. */
const KIND_SEV: Record<string, Severity> = {
  cry_end: 'info', fuss_end: 'info', noise: 'warn', motion: 'info', offline: 'warn', online: 'info', battery: 'warn', privacy: 'info', call: 'info',
  feed: 'care', diaper: 'care', sleep: 'care', wake: 'care', note: 'care', ack: 'care', soothe: 'care', camera: 'info', people: 'info',
  paused: 'warn', zone: 'urgent', crib_out: 'urgent', visit_start: 'info', visit_end: 'info', lights_on: 'info', lights_off: 'info', dark: 'warn', moved: 'warn',
  very_loud: 'warn', loud_db: 'warn', machine: 'warn', asleep: 'care', woke: 'care', resettled: 'care', sleep_report: 'care', duty: 'info', resolved: 'info',
  posture: 'info', rolled: 'info', holding: 'info', object: 'warn', soft_toy: 'warn', stood: 'warn', play: 'info',
};

export function sanitizeScene(v: unknown): SceneStatus | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return {
    baby: Boolean(r.baby),
    posture: r.posture === 'lying' || r.posture === 'sitting' || r.posture === 'standing' ? r.posture : null,
    where: r.where == null ? null : clip(r.where, 30) || null,
    holding: sceneLabel(r.holding),
    near: Array.isArray(r.near) ? [...new Set(r.near.map(sceneLabel).filter((x): x is string => !!x))].slice(0, 4) : [],
    adult: Boolean(r.adult),
  };
}

export function sanitizeEnc(v: unknown): EncStatus | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const lim = r.lim === 'cpu' || r.lim === 'bandwidth' || r.lim === 'other' || r.lim === 'none' ? r.lim : null;
  const fps = numOrNull(r.fps, 0, 60);
  const w = numOrNull(r.w, 0, 4096);
  return {
    peers: Math.round(num(r.peers, 0, 32)),
    fps: fps == null ? null : Math.round(fps),
    lim,
    impl: r.impl == null ? null : clip(r.impl, 40).replace(/[^\w .()/-]/g, '') || null,
    w: w == null ? null : Math.round(w),
    p: Math.round(num(r.p, 0, 4)),
    relay: Math.round(num(r.relay, 0, 30) * 10) / 10,
    ...(r.rc === 'avc' || r.rc === 'vp8' || r.rc === 'vp9' || r.rc === 'jpeg' ? { rc: r.rc } : {}),
  };
}

/**
 * Relay frames from one camera: a token bucket, so a jittery 2–5 fps stream
 * passes untouched (a frame 240 ms after the last isn't dropped) while a flood
 * is held to 25 fps and ~1.5 MB/s.
 */
export class FrameBucket {
  private tokens: number;
  private bytes: number;
  private at: number;

  constructor(now: number, private rate = RELAY_FPS, private burst = RELAY_BURST, private byteRate = RELAY_BYTES_PER_S) {
    this.tokens = burst;
    this.bytes = byteRate;
    this.at = now;
  }

  take(size: number, now: number): boolean {
    const dt = Math.max(0, now - this.at) / 1000;
    this.at = Math.max(this.at, now);
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    this.bytes = Math.min(this.byteRate, this.bytes + dt * this.byteRate);
    if (this.tokens < 1 || this.bytes < size) return false;
    this.tokens -= 1;
    this.bytes -= size;
    return true;
  }
}

/** What a viewer decodes, from its subscription's codec names (bit 0 H.264, 1 VP8, 2 VP9). */
export function relayCodecMask(v: unknown[]): number {
  let m = 0;
  for (const c of v.slice(0, 8)) {
    if (c === 'avc') m |= 1;
    else if (c === 'vp8') m |= 2;
    else if (c === 'vp9') m |= 4;
  }
  return m;
}

/**
 * Which bytes (if any) one viewer gets of a relay message. `rc`: what it
 * decodes (undefined = a viewer from before the framed format); `vc`: the
 * camera's current video codec (0 = it sends none). Video goes to those who
 * decode it, JPEG to the rest (bare for older viewers), sound-only messages
 * with the video (or to every framed-format viewer of a JPEG-only camera).
 */
export function relayRoute(head: RelayHead, raw: ArrayBuffer, rc: number | undefined, vc: number): ArrayBuffer | null {
  const decodes = (codec: number) => rc != null && codec > 0 && (rc & (1 << (codec - 1))) !== 0;
  if (head.kind === KIND_JPEG) {
    if (decodes(vc)) return null; // it gets the video instead
    return rc == null ? bareJpeg(raw) : raw;
  }
  if (head.kind === KIND_VIDEO || head.kind === KIND_VIDEO_AUDIO) return decodes(head.codec) ? raw : null;
  if (rc == null) return null;
  return vc === 0 || decodes(vc) ? raw : null;
}

/**
 * One viewer's relay window: the last seq forwarded (`fw`, at `fwAt`) and
 * acknowledged (`ack`, at `ackAt`), waiting for a key frame, when it last
 * asked the camera for one (`keyAt`), whether a probe went out since
 * (answering it earns a key frame at once), and how many of its messages
 * were held back since the last one it was sent.
 */
type RelayRx = { fw: number | null; ack: number | null; ackAt: number; fwAt: number; wait: boolean; keyAt: number; probed: boolean; held: number };
const freshRx = (keyAt = -Infinity): RelayRx => ({ fw: null, ack: null, ackAt: Date.now(), fwAt: Date.now(), wait: true, keyAt, probed: false, held: 0 });

/**
 * A probe for a viewer the window holds back: what of this message stands
 * alone — its sound (small, so that first), a JPEG, or a key frame whole — or null.
 */
function relayProbe(head: RelayHead, raw: ArrayBuffer, out: ArrayBuffer): ArrayBuffer | null {
  if (head.kind === KIND_VIDEO_AUDIO) return audioOnly(raw);
  return head.kind === KIND_JPEG || head.kind === KIND_AUDIO || head.key ? out : null;
}

function sendBin(ws: WebSocket, buf: ArrayBuffer): void {
  try {
    ws.send(buf);
  } catch { /* closing */ }
}

export function sanitizeZones(v: unknown): Zone[] {
  if (!Array.isArray(v)) return [];
  const out: Zone[] = [];
  for (const z of v.slice(0, 8)) {
    if (!z || typeof z !== 'object') continue;
    const r = z as Record<string, unknown>;
    const id = clip(r.id, 12).replace(/[^a-z0-9]/gi, '');
    const kind = r.kind === 'crib' ? 'crib' : r.kind === 'danger' ? 'danger' : r.kind === 'activity' ? 'activity' : null;
    if (!id || !kind) continue;
    const x = num(r.x, 0, 1);
    const y = num(r.y, 0, 1);
    const w = num(r.w, 0, 1 - x);
    const h = num(r.h, 0, 1 - y);
    if (w < 0.02 || h < 0.02) continue;
    out.push({ id, kind, name: clip(r.name, 30) || (kind === 'crib' ? 'Crib' : kind === 'activity' ? 'Play area' : 'Danger zone'), x, y, w, h });
  }
  // One crib per camera.
  let crib = false;
  return out.filter((z) => (z.kind === 'crib' ? !crib && (crib = true) : true));
}

export class MonitorRoom {
  // In-memory, best-effort (rebuilt after eviction; the alarm re-seeds grace).
  private beats = new Map<string, number>();
  private staleFlagged = new Set<string>();
  private lastStatus = new Map<string, { st: CamStatus; at: number }>();
  private relayBuckets = new Map<string, FrameBucket>();
  /** Per camera: the video codec it last sent (and when), and its key-frame requests. */
  private relayCams = new Map<string, { codec: number; at: number; keyAt: number; keyPending: boolean }>();
  /** Per viewer socket: its relay window. */
  private relayRx = new Map<string, RelayRx>();
  /** Cameras paused for privacy: nothing of theirs is relayed. */
  private relayPrivacy = new Set<string>();
  private lastStatusAt = new Map<string, number>();
  private lastSoundAt = new Map<string, number>();
  private curBucket: { t: number; s: number; cry: number } | null = null;
  private lastBucketSave = 0;
  private vapid: VapidKeys | null = null;
  /** Call lines: when each last sent anything (pings are answered by the runtime — see the constructor). */
  private lineSeen = new Map<string, number>();
  readonly store: MonitorStore;
  readonly guests: GuestAccess;
  readonly tracker: TrackerStore;
  readonly ready: Promise<void>;

  constructor(private state: DurableObjectState, private env: MonEnv) {
    this.store = new MonitorStore(state.storage.sql);
    this.guests = new GuestAccess(state.storage.sql);
    this.tracker = new TrackerStore(state.storage.sql);
    this.ready = state.blockConcurrencyWhile(() => this.migrate());
    // Keepalive pings are answered by the runtime without waking the room: a ping carries no
    // state here (camera liveness is its 2-s status, presence is the socket list, guests' last
    // seen is set at sign-in), so this only saves wake-ups — and a pong comes back even while
    // the room is busy. getWebSocketAutoResponseTimestamp then says when a socket last pinged.
    try {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch { /* older runtime: the ping handlers below answer */ }
  }

  /** Create the tables; move the pre-database log (a KV array) into them once. */
  private async migrate(): Promise<void> {
    this.store.init();
    const old = await this.state.storage.get<{ id: string; at: number; kind: string; msg: string; by?: string; dev?: string; secs?: number; conf?: number }[]>('log');
    if (old?.length) {
      for (const e of old) {
        this.store.addEvent({ id: e.id, at: e.at, kind: e.kind, sev: this.sevOf(e.kind), msg: e.msg, by: e.by ?? null, dev: e.dev ?? null, secs: e.secs ?? null, conf: e.conf ?? null });
      }
    }
    if (old) await this.state.storage.delete('log');
  }

  private sevOf(kind: string): Severity {
    return isSoundCat(kind) ? SOUND[kind].sev : KIND_SEV[kind] ?? 'info';
  }

  // ------------------------------------------------------------------ HTTP
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/vapid') return this.handleVapid();
    if (url.pathname === '/ws') return this.handleUpgrade(req, url);
    if (url.pathname === '/export') return this.handleExport(req, url);
    if (url.pathname === '/guest' && req.method === 'POST') return this.handleGuestJoin(req, url);
    return json({ error: 'not found' }, 404);
  }

  /** Key-holder instance only: get-or-create the VAPID key pair. */
  private async handleVapid(): Promise<Response> {
    let keys = await this.state.storage.get<VapidKeys>('vapid');
    if (!keys) {
      keys = await generateVapidKeys();
      await this.state.storage.put('vapid', keys);
    }
    return json(keys);
  }

  private async vapidKeys(): Promise<VapidKeys | null> {
    if (this.vapid) return this.vapid;
    try {
      const stub = this.env.MONITOR_ROOM.get(this.env.MONITOR_ROOM.idFromName(KEY_HOLDER));
      const res = await stub.fetch(new Request('https://monitor.internal/vapid'));
      if (res.ok) this.vapid = (await res.json()) as VapidKeys;
    } catch {
      /* push degrades to in-app alerts */
    }
    return this.vapid;
  }

  /** STUN + Cloudflare TURN when configured (shared with every live WebRTC path). */
  private iceServers(): Promise<unknown[]> {
    return iceServers(this.env);
  }

  /** CSV download for parents and caregivers (the member's own token decides). */
  private async handleExport(req: Request, url: URL): Promise<Response> {
    // Header only — tokens never ride in URLs (they end up in logs).
    const token = clip((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), 4096);
    const nid = await this.state.storage.get<string>('nid');
    if (!token || !nid) return json({ error: 'sign in' }, 401);
    const res = await callRpc<{ ok?: boolean; role?: MonRole }>(this.env, token, 'monitor_my_role', { p_nursery: nid });
    if (!res.ok) return json({ error: 'sign in' }, res.status === 401 ? 401 : 502);
    if (!res.data.ok || (res.data.role !== 'parent' && res.data.role !== 'caregiver')) return json({ error: 'forbidden' }, 403);
    const what = url.searchParams.get('what');
    const kind = what === 'minutes' || what === 'sleep' || what === 'track' ? what : 'events';
    // An absent parameter is "default", never 0 (Number(null) === 0).
    const param = (k: string) => url.searchParams.get(k) || undefined;
    const now = Date.now();
    const to = Math.min(now, num(param('to'), 0, now + 60_000, now));
    const from = num(param('from'), to - 90 * 24 * 60 * 60_000, to, to - 7 * 24 * 60 * 60_000);
    const settings = await this.settings();
    const meta = await this.meta();
    const csv = kind === 'track' ? this.tracker.csv(from, to + 1, (t) => localIso(t, settings.tz)) : this.store.csv(kind, from, to + 1, settings.tz);
    const slug = (meta.name || 'nursery').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'nursery';
    return new Response(`﻿${csv}\r\n`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${slug}-${kind}-${new Date(to).toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  private async handleUpgrade(req: Request, url: URL): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const nid = url.searchParams.get('nid') || '';
    if (!UUID_RE.test(nid)) return json({ error: 'bad nursery' }, 400);
    const known = await this.state.storage.get<string>('nid');
    if (!known) await this.state.storage.put('nid', nid);
    else if (known !== nid) return json({ error: 'bad nursery' }, 400);

    const pair = new WebSocketPair();
    const server = pair[1];
    if (this.sockets().length >= MAX_SOCKETS + MAX_LINES + 4) {
      server.accept();
      try {
        server.send(JSON.stringify({ t: 'error', code: 'full', msg: 'Too many devices are connected to this nursery right now.' }));
        server.close(4003, 'full');
      } catch { /* closing */ }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    this.state.acceptWebSocket(server);
    const a: Attach = { sid: crypto.randomUUID().slice(0, 10), at: Date.now(), authed: false };
    server.serializeAttachment(a);
    await this.ensureAlarm(AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ------------------------------------------------------------- sockets
  private sockets(): { ws: WebSocket; a: Attach }[] {
    const out: { ws: WebSocket; a: Attach }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a) out.push({ ws, a });
    }
    return out;
  }

  private authed(): { ws: WebSocket; a: Attach }[] {
    return this.sockets().filter((s) => s.a.authed);
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* closing */ }
  }

  /** To the nursery's monitor devices (cameras, viewers) — never to call lines or admin sockets. */
  private broadcast(obj: unknown, filter?: (a: Attach) => boolean): void {
    const payload = JSON.stringify(obj);
    for (const { ws, a } of this.authed()) {
      if (a.mode === 'line' || a.mode === 'admin' || (filter && !filter(a))) continue;
      try {
        ws.send(payload);
      } catch { /* closing */ }
    }
  }

  private presence() {
    const cams: { sid: string; dev: string; dn: string; by: string; since: number; status: CamStatus | null; statusAt: number | null }[] = [];
    const viewers: { sid: string; name: string; label: string | null; role: MonRole; dn: string; relay: boolean; guest?: boolean }[] = [];
    for (const { a } of this.authed()) {
      if (a.mode === 'camera' && a.dev) {
        const ls = this.lastStatus.get(a.dev);
        cams.push({ sid: a.sid, dev: a.dev, dn: a.dn || 'Camera', by: a.name || 'Member', since: a.at, status: ls?.st ?? null, statusAt: ls?.at ?? null });
      } else if (a.mode === 'viewer') {
        viewers.push({ sid: a.sid, name: a.name || 'Member', label: a.label ?? null, role: a.role || 'viewer', dn: a.dn || 'Device', relay: !!a.relay && !a.ri, ...(a.guest ? { guest: true } : {}) });
      }
    }
    return { cams, viewers };
  }

  private syncPresence(): void {
    this.broadcast({ t: 'presence', ...this.presence() });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;

    // Binary = a relay message (video, sound or JPEG) from an authenticated camera.
    if (typeof raw !== 'string') return this.onRelayFrame(a, raw);

    if (raw.length > RTC_FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const big = msg.t === 'rtc' || msg.t === 'call_rtc' || msg.t === 'auth' || msg.t === 'push_sub' || msg.t === 'call_push' || msg.t === 'stats' || msg.t === 'settings';
    if (!big && raw.length > FRAME_MAX) return;

    if (!a.authed) {
      if (msg.t === 'auth') await this.onAuth(ws, a, msg);
      return;
    }

    // A call line only does calls (and keepalive).
    if (a.mode === 'line') {
      this.lineSeen.set(a.sid, Date.now());
      if (msg.t === 'ping') return this.send(ws, { t: 'pong', at: Date.now() });
      return this.onCallMsg(ws, a, msg);
    }
    // An admin socket manages people and the share link, nothing else.
    if (a.mode === 'admin' && !ADMIN_MSGS.has(String(msg.t))) return;

    switch (msg.t) {
      case 'rtc':
        return this.onRtc(a, msg);
      case 'status':
        return this.onStatus(a, msg);
      case 'beat':
        if (a.mode === 'camera' && a.dev) this.markBeat(a.dev);
        return;
      case 'event':
        return this.onCamEvent(a, msg);
      case 'stats':
        return this.onStats(ws, a, msg);
      case 'log':
        return this.onLog(a, msg);
      case 'ack':
        return this.onAck(a, msg);
      case 'resolve':
        return this.onResolve(a, msg);
      case 'duty':
        return this.onDuty(a, msg);
      case 'cmd':
        return this.onCmd(a, msg);
      case 'tell':
        return this.onTell(a, msg);
      case 'relay':
        return this.onRelay(ws, a, msg);
      case 'rx':
        return this.onRelayAck(a, msg);
      case 'push_sub':
        return this.onPushSub(ws, a, msg);
      case 'push_unsub':
        return this.onPushUnsub(a, msg);
      case 'push_test':
        return this.onPushTest(ws, a);
      case 'settings':
        return this.onSettings(a, msg);
      case 'q':
        return this.onQuery(ws, msg);
      case 'track_put':
        return this.onTrackPut(ws, a, msg);
      case 'track_del':
        return this.onTrackDel(a, msg);
      case 'sleep_delete':
        return this.onSleepDelete(a, msg);
      case 'members_changed':
        return this.onMembersChanged(a, msg);
      case 'share_set':
        return this.onShareSet(ws, a, msg);
      case 'share_off':
        return this.onShareOff(a);
      case 'share_pass':
        return this.onSharePass(ws, a, msg);
      case 'share_extend':
        return this.onShareExtend(a, msg);
      case 'guest_remove':
        return this.onGuestRemove(a, msg);
      case 'request_dismiss':
        return this.onRequestDismiss(a, msg);
      case 'end_all':
        return this.onEndAll(a);
      case 'bye':
        if (a.mode === 'camera' && a.dev) {
          await this.state.storage.put(`bye:${a.dev}`, Date.now());
          await this.addLog({ kind: 'camera', msg: `${a.dn || 'Camera'} was stopped by ${a.name}`, by: a.name, dev: a.dev });
        }
        return;
      case 'ping':
        return this.send(ws, { t: 'pong', at: Date.now() });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a?.authed) return;
    if (a.mode === 'line') {
      this.lineSeen.delete(a.sid);
      return this.onLineGone(a);
    }
    // The room can still list a socket while it closes: take it out of every
    // count below (presence, relay viewers), and finish the closing handshake.
    try {
      ws.serializeAttachment({ ...a, authed: false });
      ws.close(1000, 'bye');
    } catch { /* already closed */ }
    if (a.mode === 'admin') return; // never in presence
    if (a.mode === 'camera' && a.dev) {
      const stillThere = this.authed().some((s) => s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev);
      if (!stillThere) {
        const bye = await this.state.storage.get<number>(`bye:${a.dev}`);
        if (bye && Date.now() - bye < 30_000) {
          await this.state.storage.delete(`bye:${a.dev}`);
        } else {
          // Unexpected drop: alert unless it comes back within the grace window.
          const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
          pending[a.dev] = { at: Date.now(), dn: a.dn || 'Camera' };
          await this.state.storage.put('pendingOffline', pending);
          await this.ensureAlarm(OFFLINE_GRACE_MS);
        }
        this.beats.delete(a.dev);
        this.lastStatus.delete(a.dev);
      }
      // Viewers relaying this camera no longer need to; tell the camera's peers.
      this.broadcast({ t: 'cam_gone', sid: a.sid, dev: a.dev });
    }
    if (a.mode === 'viewer') {
      this.broadcast({ t: 'peer_gone', sid: a.sid }, (x) => x.mode === 'camera');
      this.relayRx.delete(a.sid);
      if (a.relay) this.updateRelayWant(a.relay);
    }
    this.syncPresence();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch { /* closed */ }
  }

  // ---------------------------------------------------------------- auth
  private async onAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (typeof msg.guest === 'string') return this.onGuestAuth(ws, a, msg);
    const token = clip(msg.token, 4096);
    const mode: MonMode = msg.mode === 'camera' ? 'camera' : msg.mode === 'admin' ? 'admin' : msg.mode === 'line' ? 'line' : 'viewer';
    const nid = (await this.state.storage.get<string>('nid')) || '';
    if (!token || !nid) return this.reject(ws, 'auth', 'Sign in again to open this nursery.');

    const res = await callRpc<{ ok?: boolean; user_id?: string; role?: MonRole; label?: string | null; display_name?: string; nursery_name?: string; baby_name?: string | null }>(
      this.env,
      token,
      'monitor_my_role',
      { p_nursery: nid },
    );
    if (!res.ok) {
      return this.reject(ws, 'auth', res.status === 401 ? 'Your session expired — sign in again.' : 'Could not verify your account right now.');
    }
    if (!res.data.ok || !res.data.user_id || !res.data.role) {
      return this.reject(ws, 'forbidden', 'You are not a member of this nursery.');
    }
    if (mode === 'admin' && res.data.role !== 'parent') {
      return this.reject(ws, 'forbidden', 'Only parents can manage this nursery.');
    }
    if (mode === 'camera' && res.data.role === 'viewer') {
      return this.reject(ws, 'forbidden', 'Your role can watch but not run the camera. Ask a parent to make you a caregiver.');
    }
    const camCount = this.authed().filter((s) => s.a.mode === 'camera').length;
    if (mode === 'camera' && camCount >= MAX_CAMERAS) {
      return this.reject(ws, 'full', `This nursery already has ${MAX_CAMERAS} cameras running.`);
    }
    const lines = this.authed().filter((s) => s.a.mode === 'line').length;
    if (mode === 'line' ? lines >= MAX_LINES : this.authed().length - lines >= MAX_SOCKETS + 4) {
      return this.reject(ws, 'full', 'Too many devices are connected to this nursery right now.');
    }

    a.authed = true;
    a.uid = res.data.user_id;
    a.name = clip(res.data.display_name || 'Member', 40);
    a.role = res.data.role;
    a.label = res.data.label ?? null;
    const meta = { name: res.data.nursery_name || 'Nursery', baby: res.data.baby_name || null };
    await this.state.storage.put('meta', meta);
    return this.admit(ws, a, mode, msg, meta);
  }

  /** A guest's socket: the token from the share-link join, checked by this room. */
  private async onGuestAuth(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (msg.mode !== 'viewer') return this.reject(ws, 'forbidden', 'Guests can watch, but not run a camera or manage the nursery.');
    const g = await this.guests.verify(clip(msg.guest, 100), Date.now());
    if (!g) return this.reject(ws, 'removed', 'This guest pass has ended — ask a parent for the link and passcode again.');
    a.authed = true;
    a.uid = `g:${g.id}`;
    a.name = clip(g.name, 40);
    a.role = g.role;
    a.label = null;
    a.guest = g.id;
    return this.admit(ws, a, 'viewer', msg, await this.meta(), g.expires_at);
  }

  /** Common to members and guests once they're verified (`until`: when a guest's pass ends — the room is the authority). */
  private async admit(ws: WebSocket, a: Attach, mode: MonMode, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, until?: number): Promise<void> {
    const nid = (await this.state.storage.get<string>('nid')) || '';
    a.mode = mode;
    a.dev = clip(msg.dev, 40) || a.sid;
    a.dn = clip(msg.dn, 40) || (mode === 'camera' ? 'Camera' : 'Device');
    ws.serializeAttachment(a);
    if (mode === 'line') return this.admitLine(ws, a, nid, meta);
    if (mode === 'admin') {
      // Slim: who you are and the share link — no monitor data, not in presence.
      this.send(ws, { t: 'hello', you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode, dev: a.dev }, nursery: { id: nid, ...meta } });
      this.send(ws, { t: 'share', share: this.guests.info(Date.now()) });
      return;
    }

    // A device re-joining as the same camera replaces its stale socket.
    if (mode === 'camera') {
      for (const s of this.authed()) {
        if (s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev) {
          try {
            s.ws.close(4005, 'replaced');
          } catch { /* closed */ }
        }
      }
    }

    // The camera phone knows the nursery's time zone (reports, night vs nap).
    let settings = await this.settings();
    if (mode === 'camera' && isValidTz(msg.tz) && msg.tz !== settings.tz) {
      settings = { ...settings, tz: msg.tz };
      await this.state.storage.put('settings', settings);
    }

    const [tl, ice, vapid, duty, sleep] = await Promise.all([this.timeline(), this.iceServers(), this.vapidKeys(), this.duty(), this.sleepStatus()]);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode, dev: a.dev, ...(a.guest ? { guest: true, until } : {}) },
      nursery: { id: nid, ...meta },
      ...this.presence(),
      log: this.store.events({ limit: LOG_HELLO }).reverse().map(toLog),
      tl,
      settings,
      incidents: this.store.activeIncidents(),
      track: { running: this.tracker.running(), latest: this.tracker.latest() },
      duty,
      sleep,
      ice,
      vapid: vapid?.publicKey ?? null,
    });
    if (a.role === 'parent') this.send(ws, { t: 'share', share: this.guests.info(Date.now()) });

    if (mode === 'camera') {
      this.markBeat(a.dev);
      // A camera that (re)joins picks up viewers already waiting on its relay;
      // its messages start a new count, so every one of them starts on a key frame.
      this.relayCams.delete(a.dev);
      this.relayPrivacy.delete(a.dev);
      for (const s of this.authed()) if (s.a.mode === 'viewer' && s.a.relay === a.dev) this.relayRx.set(s.a.sid, freshRx());
      this.updateRelayWant(a.dev);
      const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
      const wasAlerted = await this.state.storage.get<boolean>(`alerted:${a.dev}`);
      if (pending[a.dev]) {
        delete pending[a.dev];
        await this.state.storage.put('pendingOffline', pending);
      }
      if (wasAlerted) {
        await this.state.storage.delete(`alerted:${a.dev}`);
        await this.addLog({ kind: 'online', msg: `${a.dn} is back online`, dev: a.dev });
        await this.resolveHazard('offline', a.dev, 'back online');
      } else {
        await this.addLog({ kind: 'camera', msg: `${a.dn} started watching${meta.baby ? ` ${meta.baby}` : ''} (by ${a.name})`, by: a.name, dev: a.dev });
      }
      await this.ensureAlarm(ALARM_MS);
    }
    this.syncPresence();
  }

  private reject(ws: WebSocket, code: string, msg: string): void {
    this.send(ws, { t: 'error', code, msg });
    try {
      ws.close(code === 'auth' ? 4001 : code === 'full' ? 4003 : 4004, code);
    } catch { /* closed */ }
  }

  private async meta(): Promise<{ name: string; baby: string | null }> {
    return (await this.state.storage.get<{ name: string; baby: string | null }>('meta')) ?? { name: 'Nursery', baby: null };
  }

  // -------------------------------------------------------------- relays
  private onRtc(a: Attach, msg: Record<string, unknown>): void {
    const to = clip(msg.to, 20);
    if (!to || msg.d == null || typeof msg.d !== 'object') return;
    for (const s of this.authed()) {
      if (s.a.sid !== to) continue;
      // Media only ever pairs a camera with a viewer of the same nursery.
      if (s.a.mode === a.mode) return;
      this.send(s.ws, { t: 'rtc', from: a.sid, d: msg.d, name: a.name, label: a.label ?? null, role: a.role });
      return;
    }
  }

  private markBeat(dev: string): void {
    this.beats.set(dev, Date.now());
    this.staleFlagged.delete(dev);
  }

  private onStatus(a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'camera' || !a.dev) return;
    const now = Date.now();
    this.markBeat(a.dev);
    // Privacy pause holds back every relay message from this camera (even a throttled status says so).
    if ((msg.st as Record<string, unknown> | undefined)?.paused === 'privacy') this.relayPrivacy.add(a.dev);
    else this.relayPrivacy.delete(a.dev);
    if (now - (this.lastStatusAt.get(a.dev) ?? 0) < 800) return;
    this.lastStatusAt.set(a.dev, now);
    const s = (msg.st ?? {}) as Record<string, unknown>;
    const state: BabyState = BABY_STATES.includes(s.state as BabyState) ? (s.state as BabyState) : 'calm';
    const top = Array.isArray(s.top)
      ? (s.top as unknown[])
          .filter((x): x is [SoundCat, number] => Array.isArray(x) && isSoundCat(x[0]))
          .slice(0, 3)
          .map(([c, v]) => [c, Math.round(num(v, 0, 100))] as [SoundCat, number])
      : [];
    const spl = s.spl && typeof s.spl === 'object' ? (s.spl as Record<string, unknown>) : null;
    const st: CamStatus = {
      state,
      level: Math.round(num(s.level, 0, 90)),
      motion: Math.round(num(s.motion, 0, 100)),
      light: Math.round(num(s.light, 0, 255)),
      battery: s.battery == null ? null : Math.round(num(s.battery, 0, 100)),
      charging: s.charging == null ? null : Boolean(s.charging),
      soothing: s.soothing ? clip(s.soothing, 20) : null,
      cry: Math.round(num(s.cry, 0, 100)),
      sound: isSoundCat(s.sound) ? s.sound : null,
      conf: Math.round(num(s.conf, 0, 100)),
      top,
      model: s.model === 'loading' || s.model === 'ready' || s.model === 'failed' ? s.model : 'off',
      paused: s.paused === 'privacy' || s.paused === 'interrupted' || s.paused === 'hidden' ? s.paused : null,
      awake: s.awake === 'native' || s.awake === 'video' || s.awake === 'none' ? s.awake : null,
      talk: s.talk ? clip(s.talk, 80) : null,
      call: s.call ? clip(s.call, 60) : null,
      spl: spl
        ? { db: Math.round(num(spl.db, 0, 140) * 10) / 10, leq: Math.round(num(spl.leq, 0, 140) * 10) / 10, max: Math.round(num(spl.max, 0, 140) * 10) / 10, cal: Boolean(spl.cal) }
        : null,
      crib: s.crib == null ? null : Math.round(num(s.crib, 0, 100)),
      outside: s.outside == null ? null : Math.round(num(s.outside, 0, 100)),
      visit: Boolean(s.visit),
      scene: sanitizeScene(s.scene),
      enc: sanitizeEnc(s.enc),
    };
    this.lastStatus.set(a.dev, { st, at: now });
    this.broadcast({ t: 'status', dev: a.dev, sid: a.sid, st, at: now }, (x) => x.mode === 'viewer');
    void this.trackBucket(state, now);
  }

  /** 5-minute timeline buckets keep the WORST state seen (cry beats calm). */
  private async trackBucket(state: BabyState, now: number): Promise<void> {
    const t = Math.floor(now / TL_BUCKET_MS) * TL_BUCKET_MS;
    const rank = STATE_RANK[state];
    if (!this.curBucket || this.curBucket.t !== t) {
      if (this.curBucket) await this.saveBucket(this.curBucket);
      this.curBucket = { t, s: rank, cry: 0 };
    }
    const changed = rank > this.curBucket.s;
    this.curBucket.s = Math.max(this.curBucket.s, rank);
    if (state === 'crying') this.curBucket.cry += 1;
    if (changed || now - this.lastBucketSave > 60_000) await this.saveBucket(this.curBucket);
  }

  private async saveBucket(b: { t: number; s: number; cry: number }): Promise<void> {
    this.lastBucketSave = Date.now();
    const tl = (await this.state.storage.get<[number, number, number][]>('tl')) ?? [];
    const last = tl[tl.length - 1];
    if (last && last[0] === b.t) {
      last[1] = Math.max(last[1], b.s);
      last[2] = Math.max(last[2], b.cry);
    } else {
      tl.push([b.t, b.s, b.cry]);
    }
    const cutoff = Date.now() - TL_KEEP_MS;
    while (tl.length && tl[0][0] < cutoff) tl.shift();
    await this.state.storage.put('tl', tl);
  }

  private async timeline(): Promise<[number, number, number][]> {
    const tl = (await this.state.storage.get<[number, number, number][]>('tl')) ?? [];
    const since = Date.now() - 24 * 60 * 60_000;
    return tl.filter((b) => b[0] >= since);
  }

  // ------------------------------------------------------- camera events
  private async onCamEvent(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev) return;
    const kind = String(msg.kind ?? '');
    const meta = await this.meta();
    const who = meta.baby || 'Baby';
    const where = a.dn || 'Camera';
    if (kind === 'sound') return this.onSoundEvent(a, msg, meta, who, where);
    if (kind === 'vision') return this.onVisionEvent(a, msg, meta, who, where);
    if (kind === 'scene') return this.onSceneEvent(a, msg, meta, who, where);
    if (kind === 'noise') return this.onNoiseEvent(a, msg, meta, where);
    if (kind === 'paused') {
      // The camera page went to the background or the phone locked: the video stops.
      const entry = await this.addLog({ kind: 'paused', msg: `${where}’s screen locked or the app was left — video paused`, dev: a.dev });
      return this.raiseHazard('paused', entry, { title: 'Baby camera video paused', body: `${meta.name} · ${where} locked its screen or left Stream Studio — sound may continue, but open the app on that phone`, entryId: entry.id }, a.dev);
    }
    if (kind === 'resumed') {
      const open = this.store.openIncident('paused', a.dev);
      if (open) await this.addLog({ kind: 'online', msg: `${where} is back — video resumed`, dev: a.dev });
      return this.resolveHazard('paused', a.dev, 'back');
    }
    if (kind === 'privacy') {
      if (msg.on) this.relayPrivacy.add(a.dev);
      else this.relayPrivacy.delete(a.dev);
      await this.addLog({ kind: 'privacy', msg: msg.on ? `Video paused for privacy on ${where} — sound monitoring continues` : `Video resumed on ${where}`, dev: a.dev });
      return;
    }
    if (kind === 'cry') {
      // Older camera builds (pre-AI): same as a sound event.
      return this.onSoundEvent(a, { cat: 'cry', phase: 'start' }, meta, who, where);
    } else if (kind === 'cry_end') {
      return this.onSoundEvent(a, { cat: 'cry', phase: 'end', secs: msg.secs }, meta, who, where);
    } else if (kind === 'motion') {
      await this.addLog({ kind: 'motion', msg: `${who} is moving around · ${where}`, dev: a.dev });
    } else if (kind === 'battery') {
      const pct = Math.round(num(msg.pct, 0, 100));
      const entry = await this.addLog({ kind: 'battery', msg: `${where} battery low (${pct}%) — plug it in`, dev: a.dev });
      await this.pushAlert('battery', { title: 'Baby camera battery low', body: `${where} is at ${pct}% — plug it in so monitoring doesn't stop`, entryId: entry.id }, a.dev);
    } else if (kind === 'soothe') {
      await this.addLog({ kind: 'soothe', msg: clip(msg.msg, 120) || `Soothing sounds on ${where}`, dev: a.dev });
    }
  }

  /** On-device sound detection: start/end of a category (see live/monitor/soundBrain.ts). */
  private async onSoundEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, who: string, where: string): Promise<void> {
    if (!a.dev || !isSoundCat(msg.cat)) return;
    const cat = msg.cat;
    const info = SOUND[cat];
    const conf = Math.round(num(msg.conf, 0, 100));
    if (msg.phase === 'end') {
      if (!info.ends) return;
      const secs = Math.round(num(msg.secs, 0, 7200));
      await this.addLog({ kind: cat === 'cry' ? 'cry_end' : 'fuss_end', msg: `${who} settled${secs ? ` after ${dur(secs)} of ${cat === 'cry' ? 'crying' : 'fussing'}` : ''}`, dev: a.dev, secs });
      if (cat === 'cry') await this.resolveHazard('cry', a.dev, `settled after ${dur(secs)}`);
      return;
    }
    // A misbehaving camera can't flood the log or everyone's phones.
    const key = `${a.dev}:${cat}`;
    const now = Date.now();
    if (now - (this.lastSoundAt.get(key) ?? 0) < info.gapMs) return;
    this.lastSoundAt.set(key, now);
    const title = info.headline.replace('{baby}', who);
    const extra = cat === 'alarm' && (msg.pattern === 'T3' || msg.pattern === 'T4') ? ` (${msg.pattern === 'T3' ? 'smoke-alarm' : 'CO-alarm'} beep pattern)` : '';
    const entry = await this.addLog({ kind: cat, msg: `${title}${extra} · ${where}`, dev: a.dev, conf });
    const note = { title, body: `${meta.name} · ${where} — tap to check in`, entryId: entry.id };
    if (info.hazard) await this.raiseHazard(info.hazard, entry, note, a.dev);
    else if (info.push) await this.pushAlert(info.push, note, a.dev, { audience: 'duty' });
  }

  /** Smart vision (beta): posture, rolling, what's in hand or within reach, play areas (live/monitor/scene.ts). */
  private async onSceneEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, who: string, where: string): Promise<void> {
    if (!a.dev || a.mode !== 'camera') return;
    const type = String(msg.type ?? '');
    const label = sceneLabel(msg.label);
    const zoneName = clip(msg.name, 30);
    const now = Date.now();
    const key = `${a.dev}:s:${type}:${label || zoneName || String(msg.posture ?? '')}`;
    const gap = type === 'object_near' ? 5 * 60_000 : type === 'soft_toy' ? 60 * 60_000 : 60_000;
    if (now - (this.lastSoundAt.get(key) ?? 0) < gap) return;
    this.lastSoundAt.set(key, now);
    const inWhat = (w: unknown) => (w === 'Crib' ? ' in the crib' : typeof w === 'string' && w ? ` in the ${clip(w, 30)}` : '');
    switch (type) {
      case 'posture': {
        const p = msg.posture === 'sitting' ? 'is sitting up' : msg.posture === 'standing' ? 'is standing' : msg.posture === 'lying' ? 'is lying down' : null;
        if (!p) return;
        await this.addLog({ kind: 'posture', msg: `${who} ${p}${inWhat(msg.where)} · ${where}`, dev: a.dev });
        return;
      }
      case 'stood_in_crib':
        await this.addLog({ kind: 'stood', msg: `${who} is standing in the crib — keep the mattress at its lowest setting · ${where}`, dev: a.dev });
        return;
      case 'rolled':
        await this.addLog({ kind: 'rolled', msg: `${who} rolled over — face turned away from the camera · ${where}`, dev: a.dev });
        return;
      case 'holding':
        if (!label) return;
        await this.addLog({ kind: 'holding', msg: `${who} is holding ${a_an(label)} · ${where}`, dev: a.dev });
        return;
      case 'object_near': {
        if (!label || !RISK_WHY[label]) return;
        const title = SHARP.has(label) ? `${label[0].toUpperCase()}${label.slice(1)} within ${who}’s reach` : `${label[0].toUpperCase()}${label.slice(1)} near ${who}`;
        const entry = await this.addLog({ kind: 'object', msg: `${title} (${RISK_WHY[label]}) · ${where}`, dev: a.dev, sev: SHARP.has(label) ? 'urgent' : 'warn' });
        if (SHARP.has(label)) await this.raiseHazard('object', entry, { title, body: `${meta.name} · ${where} — move it out of reach`, entryId: entry.id }, a.dev);
        return;
      }
      case 'soft_toy':
        await this.addLog({
          kind: 'soft_toy',
          msg: msg.inCrib === false
            ? `A soft toy is within ${who}’s reach while lying down — for sleep, the AAP advises a bare space: no toys, pillows or blankets · ${where}`
            : `A soft toy is in the crib with ${who} — for sleep, the AAP advises an empty crib · ${where}`,
          dev: a.dev,
        });
        return;
      case 'in_zone':
        if (!zoneName) return;
        await this.addLog({ kind: 'play', msg: `${who} is in the ${zoneName} · ${where}`, dev: a.dev });
        return;
      case 'left_zone':
        if (!zoneName) return;
        await this.addLog({ kind: 'play', msg: `${who} left the ${zoneName}${msg.secs ? ` after ${dur(Math.round(num(msg.secs, 0, 86_400)))}` : ''} · ${where}`, dev: a.dev });
        return;
    }
  }

  /** On-device vision: zones, climb-outs, visits, lights, camera moved (see live/monitor/vision.ts). */
  private async onVisionEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, who: string, where: string): Promise<void> {
    if (!a.dev) return;
    const type = VISION_TYPES.includes(msg.type as VisionType) ? (msg.type as VisionType) : null;
    if (!type) return;
    const now = Date.now();
    const key = `${a.dev}:v:${type}:${clip(msg.zone, 12)}`;
    if (now - (this.lastSoundAt.get(key) ?? 0) < (type === 'visit_end' || type === 'visit_start' ? 20_000 : 60_000)) return;
    this.lastSoundAt.set(key, now);
    const settings = await this.settings();
    const zone = (settings.zones[a.dev] ?? []).find((z) => z.id === clip(msg.zone, 12));
    const zoneName = zone?.name || clip(msg.name, 30) || 'a danger zone';
    switch (type) {
      case 'zone': {
        const title = `Movement in ${zoneName}`;
        const entry = await this.addLog({ kind: 'zone', msg: `${title} · ${where}`, dev: a.dev });
        return this.raiseHazard('zone', entry, { title, body: `${meta.name} · ${where} — check on ${who} now`, entryId: entry.id }, a.dev);
      }
      case 'crib_out': {
        const title = `Movement outside the crib — ${who} may be climbing out`;
        const entry = await this.addLog({ kind: 'crib_out', msg: `${title} · ${where}`, dev: a.dev });
        return this.raiseHazard('crib_out', entry, { title, body: `${meta.name} · ${where} — check on ${who} now`, entryId: entry.id }, a.dev);
      }
      case 'moved': {
        const title = 'Camera was moved — check it still sees the crib';
        const entry = await this.addLog({ kind: 'moved', msg: `${title} · ${where}${msg.via === 'tilt' ? ' (the phone tilted)' : ''}`, dev: a.dev });
        return this.raiseHazard('moved', entry, { title: 'Baby camera was moved', body: `${meta.name} · ${where} may have fallen or been knocked — check it can still see ${who}`, entryId: entry.id }, a.dev);
      }
      case 'dark':
        await this.addLog({ kind: 'dark', msg: `Camera can’t see — the room is completely dark or the lens is covered · ${where}`, dev: a.dev });
        return;
      case 'visit_start':
        await this.addLog({ kind: 'visit_start', msg: `Someone came into the nursery · ${where}`, dev: a.dev });
        return;
      case 'visit_end': {
        const secs = Math.round(num(msg.secs, 0, 4 * 3600));
        await this.addLog({ kind: 'visit_end', msg: `Visit ended${secs ? ` after ${dur(secs)}` : ''} · ${where}`, dev: a.dev, secs });
        return;
      }
      case 'lights_on':
      case 'lights_off':
        await this.addLog({ kind: type, msg: `Lights turned ${type === 'lights_on' ? 'on' : 'off'} · ${where}`, dev: a.dev });
        return;
    }
  }

  /** Sound-meter episodes from the camera (see NoiseGuard in live/monitor/soundLevel.ts). */
  private async onNoiseEvent(a: Attach, msg: Record<string, unknown>, meta: { name: string; baby: string | null }, where: string): Promise<void> {
    if (!a.dev) return;
    const type = msg.type === 'very_loud' ? 'very_loud' : msg.type === 'loud' ? 'loud' : null;
    if (!type) return;
    const db = Math.round(num(msg.db, 0, 140));
    const cal = Boolean(msg.cal);
    const approx = cal ? '' : '≈';
    if (msg.phase === 'end') {
      const secs = Math.round(num(msg.secs, 0, 4 * 3600));
      if (type === 'very_loud') await this.resolveHazard('very_loud', a.dev, `quiet again after ${dur(secs)}`);
      return;
    }
    const now = Date.now();
    const key = `${a.dev}:n:${type}`;
    if (now - (this.lastSoundAt.get(key) ?? 0) < (type === 'very_loud' ? 60_000 : 5 * 60_000)) return;
    this.lastSoundAt.set(key, now);
    if (type === 'very_loud') {
      const title = `Very loud noise in the nursery (${approx}${db} dB)`;
      const entry = await this.addLog({ kind: 'very_loud', msg: `${title} · ${where}`, dev: a.dev, db });
      return this.raiseHazard('very_loud', entry, { title, body: `${meta.name} · ${where} — loud enough to be harmful with exposure`, entryId: entry.id }, a.dev);
    }
    const settings = await this.settings();
    const title = `Noise above ${settings.noiseDb ?? 70} dB (${approx}${db} dB)`;
    const entry = await this.addLog({ kind: 'loud_db', msg: `${title} · ${where}`, dev: a.dev, db });
    await this.pushAlert('loud', { title, body: `${meta.name} · ${where}`, entryId: entry.id }, a.dev, { audience: 'duty' });
  }

  // --------------------------------------------------------- minute stats
  /** The camera's per-minute measurements (batched while it was offline). */
  private async onStats(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev || !Array.isArray(msg.rows)) return;
    const now = Date.now();
    const rows: MinuteRow[] = [];
    for (const r of (msg.rows as unknown[]).slice(0, 240)) {
      if (!r || typeof r !== 'object') continue;
      const x = r as Record<string, unknown>;
      const m = Math.floor(Number(x.m) / 60_000) * 60_000;
      if (!Number.isFinite(m) || m > now + 2 * 60_000 || m < now - 6 * 60 * 60_000) continue;
      const sounds: Record<string, number> = {};
      if (x.sounds && typeof x.sounds === 'object') {
        for (const [k, v] of Object.entries(x.sounds as Record<string, unknown>)) if (isSoundCat(k)) sounds[k] = Math.round(num(v, 0, 60));
      }
      rows.push({
        dev: a.dev, m,
        laeq: numOrNull(x.laeq, 0, 140), lmax: numOrNull(x.lmax, 0, 140), l10: numOrNull(x.l10, 0, 140), l50: numOrNull(x.l50, 0, 140), l90: numOrNull(x.l90, 0, 140), lpk: numOrNull(x.lpk, 0, 160),
        cal: x.cal ? 1 : 0,
        motion: numOrNull(x.motion, 0, 100), mmax: numOrNull(x.mmax, 0, 100), crib: numOrNull(x.crib, 0, 100), outside: numOrNull(x.outside, 0, 100), light: numOrNull(x.light, 0, 255),
        state: numOrNull(x.state, 1, 5), sounds, visit: x.visit ? 1 : 0,
      });
    }
    rows.sort((p, q) => p.m - q.m);
    for (const r of rows) this.store.putMinute(r);
    if (rows.length) {
      this.send(ws, { t: 'stats_ok', upto: rows[rows.length - 1].m });
      this.broadcast({ t: 'minutes', rows }, (x) => x.mode === 'viewer');
      await this.afterMinutes(a.dev, rows);
    }
  }

  /** Sleep tracking + the sound-machine check run on the nursery's main camera. */
  private async afterMinutes(dev: string, rows: MinuteRow[]): Promise<void> {
    const settings = await this.settings();
    let sleepDev = await this.state.storage.get<{ dev: string; at: number }>('sleepDev');
    const last = rows[rows.length - 1].m;
    if (!sleepDev || sleepDev.dev === dev || last - sleepDev.at > 10 * 60_000) sleepDev = { dev, at: last };
    if (sleepDev.dev !== dev) return;
    await this.state.storage.put('sleepDev', sleepDev);

    if (settings.sleepTracking) {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const events: SleepEvent[] = [];
      for (const r of rows) events.push(...stepSleep(sm, { m: r.m, state: r.state, motion: r.motion, crib: r.crib, sounds: r.sounds, visit: r.visit }, newId));
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }
    if (settings.machineCheck) await this.machineCheck(dev, last);
  }

  private async onSleepEvents(events: SleepEvent[]): Promise<void> {
    if (!events.length) return;
    const meta = await this.meta();
    const settings = await this.settings();
    const who = meta.baby || 'Baby';
    for (const e of events) {
      switch (e.type) {
        case 'started':
          this.store.putSleep({ id: e.session, start: e.at, end: null, onset: null, kind: 'night', source: e.source, asleep_min: 0, awake_min: 0, wakings: 0, longest_min: 0, cry_min: 0, laeq: null, summary: null });
          break;
        case 'asleep':
          await this.addLog({ kind: 'asleep', msg: `${who} fell asleep at ${clockTime(e.at, settings.tz)}`, at: e.at });
          break;
        case 'woke':
          await this.addLog({ kind: 'woke', msg: `${who} woke up at ${clockTime(e.at, settings.tz)}`, at: e.at });
          break;
        case 'resettled':
          await this.addLog({ kind: 'resettled', msg: `${who} went back to sleep after ${hm(e.mins)} awake`, at: e.at });
          break;
        case 'ended':
          await this.finishSleep(e.session, e.end, e.discarded, e.stats);
          break;
      }
    }
    this.broadcast({ t: 'sleep', sleep: await this.sleepStatus() });
  }

  /** Close a session: summarise it, log it, and send the morning report for nights. */
  private async finishSleep(id: string, end: number, discarded: boolean, s: SleepStats): Promise<void> {
    const row = this.store.sleep(id);
    if (!row) return;
    if (discarded) {
      this.store.putSleep({ ...row, end, summary: { discarded: true } });
      return;
    }
    const settings = await this.settings();
    const meta = await this.meta();
    const summary = this.summarise(row.start, end);
    const kind = sessionKind(localParts(row.start, settings.tz).h, s.asleepMin);
    const final: SleepRow = {
      ...row, end, onset: row.onset ?? s.onset ?? row.start, kind, source: s.source,
      asleep_min: s.asleepMin, awake_min: s.awakeMin, wakings: s.wakings.length, longest_min: s.longest, cry_min: s.cryMin,
      laeq: summary.laeq, summary: { ...summary, wakeups: s.wakings },
    };
    this.store.putSleep(final);
    const who = meta.baby || 'Baby';
    const headline = `${who} slept ${hm(s.asleepMin)}${s.wakings.length ? ` · woke ${s.wakings.length}×` : ' straight through'}`;
    const entry = await this.addLog({ kind: 'sleep_report', msg: `${kind === 'night' ? 'Night' : 'Nap'} report: ${headline}`, at: end, meta: { session: id } });
    if (kind === 'night') {
      await this.pushAlert('report', { title: `Good morning — ${headline}`, body: `${meta.name} · longest stretch ${hm(s.longest)}${summary.laeq != null ? ` · room averaged ${Math.round(summary.laeq)} dB` : ''} — tap for the full report`, entryId: entry.id });
    }
  }

  /** Room conditions and notable events in a window. */
  private summarise(from: number, to: number): { laeq: number | null; l90: number | null; peak: number | null; light: number | null; counts: Record<string, number>; visits: number; noisyMin: number } {
    const rows = this.store.minutes(from, to);
    const vals = (k: keyof MinuteRow) => rows.map((r) => r[k] as number | null).filter((v): v is number => v != null);
    const energy = (xs: number[]) => (xs.length ? 10 * Math.log10(xs.reduce((a, d) => a + 10 ** (d / 10), 0) / xs.length) : null);
    const laeq = energy(vals('laeq'));
    const l90s = vals('l90');
    const tally = this.store.tally(from, to);
    const counts: Record<string, number> = {};
    for (const k of ['cry', 'fuss', 'cough', 'sneeze', 'snore', 'hiccup', 'alarm', 'glass', 'crash', 'zone', 'crib_out', 'very_loud', 'loud_db', 'lights_on', 'cat', 'dog']) if (tally[k]?.n) counts[k] = tally[k].n;
    return {
      laeq: laeq == null ? null : Math.round(laeq * 10) / 10,
      l90: l90s.length ? Math.round((l90s.reduce((a, b) => a + b, 0) / l90s.length) * 10) / 10 : null,
      peak: vals('lmax').length ? Math.max(...vals('lmax')) : null,
      light: vals('light').length ? Math.round(vals('light').reduce((a, b) => a + b, 0) / vals('light').length) : null,
      counts,
      visits: tally.visit_start?.n ?? 0,
      noisyMin: rows.filter((r) => (r.laeq ?? 0) >= 60).length,
    };
  }

  /**
   * Infant sleep machines often run louder than the 50 dB(A) hospital-nursery
   * limit (Hugh et al., Pediatrics 2014). A steady hour above it earns a nudge.
   */
  private async machineCheck(dev: string, last: number): Promise<void> {
    const prevAt = (await this.state.storage.get<number>('machineAt')) ?? 0;
    if (last - prevAt < MACHINE_GAP_MS) return;
    const rows = this.store.minutes(last - 59 * 60_000, last + 60_000, dev).filter((r) => r.laeq != null && r.l10 != null && r.l90 != null);
    if (rows.length < 50) return;
    const leq = 10 * Math.log10(rows.reduce((a, r) => a + 10 ** (r.laeq! / 10), 0) / rows.length);
    const spread = rows.reduce((a, r) => a + (r.l10! - r.l90!), 0) / rows.length;
    if (leq < MACHINE_DB || spread > 8) return;
    await this.state.storage.put('machineAt', last);
    const cal = rows.filter((r) => r.cal).length > rows.length / 2;
    const db = Math.round(leq);
    const title = cal ? `Sound machine may be too loud (${db} dB for the last hour)` : `Sound machine may be too loud (≈${db} dB for the last hour)`;
    const body = `Steady sound in the nursery averaged ${cal ? '' : 'about '}${db} dB — above the 50 dB guideline for infant sleep. Move it farther from the crib (2 m / 6½ ft or more) or turn it down.${cal ? '' : ' Calibrate the camera’s sound meter to confirm.'}`;
    const entry = await this.addLog({ kind: 'machine', msg: `${title} — move it farther from the crib or turn it down`, dev, db, sev: cal ? 'warn' : 'info' });
    await this.pushAlert('insight', { title, body, entryId: entry.id }, dev);
  }

  private async sleepStatus(): Promise<{ phase: SleepSm['phase']; since: number | null; session: string | null; asleepMin: number; wakings: number; last: SleepRow | null }> {
    const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
    const since = sm.phase === 'awake' ? sm.awakeSince : sm.phase === 'asleep' ? sm.quietSince ?? sm.onset : sm.phase === 'settling' ? sm.start : null;
    return { phase: sm.phase, since, session: sm.session, asleepMin: sm.asleepMin, wakings: sm.wakings.length, last: this.store.lastSleep(1)[0] ?? null };
  }

  // ------------------------------------------------------------ incidents
  /** Open (or join) an incident and alert people about it. */
  private async raiseHazard(kind: HazardKind, entry: MonLog, note: { title: string; body: string; entryId: string }, dev: string): Promise<void> {
    const h = HAZARD[kind];
    const now = Date.now();
    const settings = await this.settings();
    let inc = this.store.openIncident(kind, dev);
    if (inc && inc.status === 'acked' && now - (inc.ack_at ?? 0) > 10 * 60_000) {
      // Answered a while ago and happening again: that's a new incident.
      this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now });
      this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now } });
      inc = null;
    }
    if (inc) {
      this.store.setEventIncident(entry.id, inc.id);
      return;
    }
    const escalate = kind === 'cry' ? settings.cryEscalateMin * 60_000 : h.repeatMs ?? h.escalateMs;
    const row: IncidentRow = {
      id: newId(), at: now, kind, sev: entry.sev, title: note.title, dev, status: 'open',
      ack_by: null, ack_at: null, resolved_at: null, pushes: 1, next_at: escalate != null ? now + escalate : null,
    };
    this.store.addIncident(row);
    this.store.setEventIncident(entry.id, row.id);
    this.broadcast({ t: 'incident', inc: row });
    await this.pushAlert(h.push, note, dev, { audience: h.everyone ? 'all' : 'duty', incident: row.id });
    if (row.next_at) await this.ensureAlarm(row.next_at - now);
  }

  private async resolveHazard(kind: HazardKind, dev: string, why: string): Promise<void> {
    const inc = this.store.openIncident(kind, dev);
    if (!inc) return;
    const now = Date.now();
    this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null });
    this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null }, why });
  }

  /** Re-alert incidents nobody has answered; tidy up stale ones. */
  private async escalate(now: number): Promise<void> {
    const settings = await this.settings();
    const meta = await this.meta();
    const who = meta.baby || 'Baby';
    for (const inc of this.store.dueIncidents(now)) {
      const h = HAZARD[inc.kind as HazardKind];
      if (!h) continue;
      const mins = Math.max(1, Math.round((now - inc.at) / 60_000));
      const title =
        inc.kind === 'cry' ? `${who} has been crying for ${mins} min — no one has responded`
        : inc.kind === 'alarm' ? `Alarm still sounding in ${meta.name} — no one has responded`
        : `Still no response: ${inc.title}`;
      const entry = await this.addLog({ kind: 'escalated', msg: title, dev: inc.dev ?? undefined, sev: inc.sev, incident: inc.id });
      await this.pushAlert(h.push, { title, body: `${meta.name} — tap “I’m on it” when someone is checking`, entryId: entry.id }, inc.dev ?? undefined, { audience: 'all', incident: inc.id, force: true });
      const pushes = inc.pushes + 1;
      const repeat = inc.kind === 'cry' ? settings.cryRepeatMin * 60_000 : h.repeatMs;
      const next = pushes < h.maxPushes && repeat ? now + repeat : null;
      this.store.updateIncident(inc.id, { pushes, next_at: next });
      this.broadcast({ t: 'incident', inc: { ...inc, pushes, next_at: next } });
    }
    for (const inc of this.store.activeIncidents()) {
      const h = HAZARD[inc.kind as HazardKind];
      const stale = inc.status === 'acked' ? now - (inc.ack_at ?? inc.at) > 30 * 60_000 : now - inc.at > (h?.staleMs ?? 60 * 60_000);
      if (stale) {
        this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null });
        this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null } });
      }
    }
  }

  // ---------------------------------------------------------- family acts
  private async onLog(a: Attach, msg: Record<string, unknown>): Promise<void> {
    const kinds = ['feed', 'diaper', 'sleep', 'wake', 'note'] as const;
    const kind = kinds.includes(msg.kind as (typeof kinds)[number]) ? (msg.kind as (typeof kinds)[number]) : null;
    if (!kind) return;
    const label = { feed: 'Fed', diaper: 'Diaper change', sleep: 'Down for sleep', wake: 'Woke up', note: 'Note' }[kind];
    const text = clip(msg.text, 160);
    await this.addLog({ kind, msg: text ? `${label} — ${text}` : label, by: a.label ? `${a.name} (${a.label})` : a.name });
    // "Down for sleep" / "Woke up" steer the sleep tracker.
    if (kind === 'sleep' || kind === 'wake') {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const now = Date.now();
      const events = kind === 'sleep' ? manualSleep(sm, now, newId()) : manualWake(sm, now);
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }
  }

  // ------------------------------------------------------------ tracker
  /** Add or edit a tracker entry (feeds, diapers, sleep…) — parents and caregivers, guests included. */
  private async onTrackPut(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return this.send(ws, { t: 'track_err', id: clip((msg.item as Record<string, unknown> | undefined)?.id, 40), msg: 'Viewers can see the tracker but not log — ask a parent to make you a caregiver.' });
    const now = Date.now();
    const who = { name: a.label ? `${a.name} (${a.label})` : a.name || 'Someone', uid: a.uid || a.sid };
    const r = sanitizeTrack((msg.item ?? {}) as Record<string, unknown>, who, now);
    if (!r.ok) return this.send(ws, { t: 'track_err', id: clip((msg.item as Record<string, unknown> | undefined)?.id, 40), msg: r.error });
    const before = this.tracker.get(r.row.id);
    const saved = this.tracker.put(r.row);
    if (!saved) return this.send(ws, { t: 'track_del', id: r.row.id });
    this.broadcast({ t: 'track', item: saved });
    await this.trackLog(saved, before, a);
  }

  private async onTrackDel(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const id = clip(msg.id, 40);
    if (id && this.tracker.delete(id, Date.now())) this.broadcast({ t: 'track_del', id });
  }

  /** One line in the activity log when something is logged or a timer stops — and sleep steers the sleep tracker. */
  private async trackLog(row: TrackRow, before: TrackRow | null, a: Attach): Promise<void> {
    const started = !before;
    const stopped = !!before && before.end == null && row.end != null;
    if (!started && !stopped) return;
    const d = row.data as Record<string, number | string | boolean | undefined>;
    const mins = row.end != null ? Math.max(1, Math.round((row.end - row.start) / 60_000)) : 0;
    const by = a.label ? `${a.name} (${a.label})` : a.name;
    let kind = 'note';
    let text: string | null = null;
    switch (row.kind) {
      case 'bottle':
        kind = 'feed';
        text = `Bottle · ${d.ml} ml${d.milk === 'breast' ? ' breast milk' : d.milk === 'formula' ? ' formula' : ''}`;
        break;
      case 'breast':
        if (row.end == null) return;
        kind = 'feed';
        text = `Breastfed ${mins} min${d.left || d.right ? ` (L ${Math.round(Number(d.left ?? 0) / 60)} · R ${Math.round(Number(d.right ?? 0) / 60)})` : ''}`;
        break;
      case 'solids':
        kind = 'feed';
        text = `Solids${d.foods ? ` · ${d.foods}` : ''}`;
        break;
      case 'diaper':
        kind = 'diaper';
        text = `Diaper · ${d.pee && d.poo ? 'wet + dirty' : d.poo ? 'dirty' : d.pee ? 'wet' : 'dry'}`;
        break;
      case 'sleep':
        kind = row.end == null ? 'sleep' : 'wake';
        text = row.end == null ? 'Down for sleep' : `Woke up after ${dur(mins * 60)}`;
        if (started && row.end != null) text = `Slept ${dur(mins * 60)}`;
        break;
      case 'pump':
        if (row.end == null) return;
        text = `Pumped ${Number(d.mlLeft ?? 0) + Number(d.mlRight ?? 0)} ml`;
        break;
      case 'med':
        text = `Gave ${d.name}${d.dose ? ` ${d.dose} ${d.unit ?? ''}`.trimEnd() : ''}`;
        break;
      case 'temp':
        text = `Temperature ${d.c} °C${d.method ? ` (${d.method})` : ''}`;
        break;
      case 'growth':
        text = `Measured${d.kg ? ` · ${d.kg} kg` : ''}${d.cm ? ` · ${d.cm} cm` : ''}${d.headCm ? ` · head ${d.headCm} cm` : ''}`;
        break;
      case 'activity':
        if (row.end == null) return;
        text = `${{ tummy: 'Tummy time', bath: 'Bath', play: 'Play', outdoor: 'Outside', reading: 'Reading', skin: 'Skin-to-skin' }[String(d.type)] ?? 'Activity'} · ${mins} min`;
        break;
      case 'note':
        text = d.note ? `Note — ${String(d.note).slice(0, 140)}` : null;
        break;
    }
    if (!text) return;
    await this.addLog({ kind, msg: text, by, sev: 'care' });
    // The sleep timer is the same thing as "Down for sleep" / "Woke up" for the camera's sleep tracker.
    if (row.kind === 'sleep' && row.start > Date.now() - 10 * 60_000) {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const events = row.end == null ? manualSleep(sm, Date.now(), newId()) : stopped ? manualWake(sm, Date.now()) : [];
      if (events.length) {
        await this.state.storage.put('sleepSm', sm);
        await this.onSleepEvents(events);
      }
    }
  }

  /** "I'm on it" — tells everyone someone is checking; answers the incident. */
  private async onAck(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const ref = clip(msg.id, 20);
    const now = Date.now();
    const incId = clip(msg.inc, 20) || (ref ? this.store.getEvent(ref)?.incident : null) || null;
    const inc = incId ? this.store.incident(incId) : null;
    const who = a.label || a.name || 'Someone';
    let line = `${who} is checking on it`;
    if (inc && inc.status === 'open') {
      const secs = Math.round((now - inc.at) / 1000);
      this.store.updateIncident(inc.id, { status: 'acked', ack_by: who, ack_at: now, next_at: null });
      this.broadcast({ t: 'incident', inc: { ...inc, status: 'acked', ack_by: who, ack_at: now, next_at: null } });
      line = `${who} is checking on it — responded in ${dur(secs)}`;
    }
    await this.addLog({ kind: 'ack', msg: line, by: a.name, dev: ref || undefined, incident: inc?.id });
    this.broadcast({ t: 'ack', ref, inc: inc?.id ?? null, by: a.name, label: a.label ?? null, at: now });
  }

  /** "All clear" — a parent/caregiver closes an incident. */
  private async onResolve(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const inc = this.store.incident(clip(msg.inc, 20));
    if (!inc || inc.status === 'resolved') return;
    const now = Date.now();
    this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null, ack_by: inc.ack_by ?? (a.label || a.name || null), ack_at: inc.ack_at ?? now });
    this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null } });
    await this.addLog({ kind: 'resolved', msg: `${a.label || a.name} marked “${inc.title}” all clear`, by: a.name, incident: inc.id });
  }

  private async duty(): Promise<Duty | null> {
    const d = await this.state.storage.get<Duty>('duty');
    return d && d.until > Date.now() ? d : null;
  }

  /** "On duty": routine alerts go to this person first; hazards still reach everyone. */
  private async onDuty(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer' || !a.uid) return;
    const cur = await this.duty();
    const who = a.label || a.name || 'Someone';
    if (msg.on) {
      const hours = Math.round(num(msg.hours, 1, 24, 12));
      const d: Duty = { uid: a.uid, name: who, until: Date.now() + hours * 60 * 60_000 };
      await this.state.storage.put('duty', d);
      await this.addLog({ kind: 'duty', msg: `${who} is on duty for the next ${hours} h — routine alerts go to them first`, by: a.name });
      this.broadcast({ t: 'duty', duty: d });
    } else if (cur && (cur.uid === a.uid || a.role === 'parent')) {
      await this.state.storage.delete('duty');
      await this.addLog({ kind: 'duty', msg: `${who} ended ${cur.uid === a.uid ? 'their' : `${cur.name}’s`} duty — alerts go to everyone`, by: a.name });
      this.broadcast({ t: 'duty', duty: null });
    }
  }

  /** Remote controls for a camera device: soothing sounds, quality, lens. */
  private onCmd(a: Attach, msg: Record<string, unknown>): void {
    const c = String(msg.c ?? '');
    const allowed = new Set(['soothe', 'soothe_stop', 'quality', 'flip', 'talk', 'video']);
    if (!allowed.has(c)) return;
    if (a.role === 'viewer' && c !== 'quality') return;
    const to = clip(msg.to, 20);
    for (const s of this.authed()) {
      if (s.a.sid === to && s.a.mode === 'camera') {
        const v = (msg.v ?? null) as Record<string, unknown> | null;
        this.send(s.ws, { t: 'cmd', c, v, from: a.sid, by: a.label || a.name });
        if (c === 'video' && v?.on) void this.addLog({ kind: 'call', msg: `${a.label || a.name} video-called ${s.a.dn || 'the nursery'}`, by: a.name, dev: s.a.dev });
        return;
      }
    }
  }

  /** Camera → one viewer: "your voice is too loud here" / "feedback — you're near the camera". */
  private onTell(a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'camera') return;
    const c = msg.c === 'feedback' || msg.c === 'talk_gain' ? msg.c : null;
    const to = clip(msg.to, 20);
    if (!c || !to) return;
    const v = (msg.v ?? {}) as Record<string, unknown>;
    const safe = c === 'talk_gain' ? { factor: num(v.factor, 0.3, 1, 1), db: Math.round(num(v.db, 0, 140)) } : { freq: Math.round(num(v.freq, 0, 20_000)) };
    for (const s of this.authed()) {
      if (s.a.sid === to && s.a.mode === 'viewer') return this.send(s.ws, { t: 'tell', c, v: safe, from: a.sid });
    }
  }

  /**
   * A viewer (un)subscribes to a camera's relay picture: `codecs` it can
   * decode (absent from viewers before the framed format), `instant` while its
   * direct picture is still connecting. A new or changed subscription starts
   * on a key frame.
   */
  private onRelay(ws: WebSocket, a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'viewer') return;
    const prev = a.relay;
    const prevRc = a.rc;
    const prevRi = !!a.ri;
    a.relay = msg.on ? clip(msg.dev, 40) || undefined : undefined;
    a.rc = a.relay && Array.isArray(msg.codecs) ? relayCodecMask(msg.codecs) : undefined;
    a.ri = a.relay && msg.instant ? true : undefined;
    ws.serializeAttachment(a);
    const rx = this.relayRx.get(a.sid);
    if (!a.relay) this.relayRx.delete(a.sid);
    else if (a.relay !== prev || a.rc !== prevRc || !rx) {
      this.relayRx.set(a.sid, freshRx(Date.now()));
      this.requestKey(a.relay);
    } else {
      // The same subscription again: its window starts over where the camera is
      // now (what it missed isn't still owed). A flowing picture keeps going; a
      // waiting one asks for a key frame (at most once per RELAY_VIEWER_KEY_MS).
      Object.assign(rx, { fw: null, ack: null, ackAt: Date.now(), fwAt: Date.now(), probed: false, held: 0 });
      if (rx.wait && this.getsVideo(a)) this.viewerKey(a.relay, rx);
    }
    if (prev && prev !== a.relay) this.updateRelayWant(prev);
    if (a.relay) this.updateRelayWant(a.relay);
    // Parents see who is on the relay picture (not those only waiting for their direct one).
    if (prev !== a.relay || prevRi !== !!a.ri) this.syncPresence();
  }

  /** Tell a camera how many viewers want its relay, and what they decode. */
  private updateRelayWant(dev: string): void {
    const want = { t: 'relay_want', n: 0, avc: 0, vp8: 0, vp9: 0, jpeg: 0 };
    for (const { a } of this.authed()) {
      if (a.mode !== 'viewer' || a.relay !== dev) continue;
      const m = a.rc ?? 0;
      want.n += 1;
      if (m & 1) want.avc += 1;
      if (m & 2) want.vp8 += 1;
      if (m & 4) want.vp9 += 1;
      if (!m) want.jpeg += 1;
    }
    this.broadcast(want, (x) => x.mode === 'camera' && x.dev === dev);
  }

  private relayCam(dev: string): { codec: number; at: number; keyAt: number; keyPending: boolean } {
    let c = this.relayCams.get(dev);
    if (!c) this.relayCams.set(dev, (c = { codec: 0, at: 0, keyAt: 0, keyPending: false }));
    return c;
  }

  /** Ask a camera for a key frame now (at most once a second; a request inside that second waits for its next message). */
  private requestKey(dev: string): void {
    const cam = this.relayCam(dev);
    const now = Date.now();
    if (now - cam.keyAt < RELAY_KEY_GAP_MS) {
      cam.keyPending = true;
      return;
    }
    cam.keyAt = now;
    cam.keyPending = false;
    this.broadcast({ t: 'relay_key' }, (x) => x.mode === 'camera' && x.dev === dev);
  }

  /** This viewer decodes the video its camera sends now (JPEG-only viewers never wait for a key frame). */
  private getsVideo(a: Attach): boolean {
    const codec = (a.relay && this.relayCams.get(a.relay)?.codec) || 0;
    return codec > 0 && a.rc != null && (a.rc & (1 << (codec - 1))) !== 0;
  }

  /** A key frame for this viewer: at most once per RELAY_VIEWER_KEY_MS, unless `force` (it just answered a probe). */
  private viewerKey(dev: string, rx: RelayRx, force = false): void {
    const now = Date.now();
    if (!force && now - rx.keyAt < RELAY_VIEWER_KEY_MS) return;
    rx.keyAt = now;
    this.requestKey(dev);
  }

  /** A viewer's acknowledgement: the last seq it got; `k` = its decoder needs a key frame. */
  private onRelayAck(a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'viewer' || !a.relay || a.rc == null) return;
    let rx = this.relayRx.get(a.sid);
    if (!rx) this.relayRx.set(a.sid, (rx = freshRx()));
    const s = Number(msg.s);
    if (Number.isInteger(s) && s >= 0 && s <= 0xffffffff) {
      // Only forward: an older acknowledgement still on its way changes nothing.
      if (rx.ack == null || seqDiff(s, rx.ack) > 0) rx.ack = s;
      rx.ackAt = Date.now();
      rx.fw ??= s;
      // Caught up while its picture waits (after a stall, or answering a probe):
      // a key frame now, rather than at the camera's next one (if it gets the video at all).
      if (rx.wait && !msg.k && seqDiff(rx.fw, s) <= RELAY_RESUME && this.getsVideo(a)) {
        this.viewerKey(a.relay, rx, rx.probed);
        rx.probed = false;
      }
    }
    if (msg.k) {
      rx.wait = true;
      this.viewerKey(a.relay, rx);
    }
  }

  /**
   * One relay message from a camera, to the viewers relaying it: video to
   * those who decode its codec, JPEG to the rest (bare for older viewers),
   * sound with the video. Nothing during a privacy pause.
   */
  private onRelayFrame(a: Attach, raw: ArrayBuffer): void {
    if (!a.authed || a.mode !== 'camera' || !a.dev) return;
    const head = readHead(raw);
    if (!head || this.relayPrivacy.has(a.dev)) return;
    const dev = a.dev;
    const now = Date.now();
    const isVideo = head.kind === KIND_VIDEO || head.kind === KIND_VIDEO_AUDIO;
    let bucket = this.relayBuckets.get(dev);
    if (!bucket) this.relayBuckets.set(dev, (bucket = new FrameBucket(now)));
    if (!bucket.take(raw.byteLength, now)) {
      // A video frame that never arrives breaks every decoder after it: all resync on a key frame.
      if (isVideo && !head.key) this.relayResync(dev);
      return;
    }
    const cam = this.relayCam(dev);
    if (isVideo) {
      cam.codec = head.codec;
      cam.at = now;
    }
    if (cam.keyPending && now - cam.keyAt >= RELAY_KEY_GAP_MS) this.requestKey(dev);
    const vc = now - cam.at < RELAY_VIDEO_STALE_MS ? cam.codec : 0;
    for (const s of this.authed()) {
      const v = s.a;
      if (v.mode !== 'viewer' || v.relay !== dev) continue;
      const out = relayRoute(head, raw, v.rc, vc);
      if (!out) continue;
      // Viewers from before the framed format: bare JPEGs, no window.
      if (v.rc == null) {
        sendBin(s.ws, out);
        continue;
      }
      let rx = this.relayRx.get(v.sid);
      if (!rx) this.relayRx.set(v.sid, (rx = freshRx()));
      if (rx.ack == null) rx.ack = (head.seq - 1) >>> 0;
      if (rx.fw == null) rx.fw = rx.ack;
      let lag = seqDiff(rx.fw, rx.ack);
      if (lag > RELAY_DEAD && now - rx.ackAt <= 3000) {
        // Still acknowledging but far apart: the numbers restarted — start over.
        rx.ack = (head.seq - 1) >>> 0;
        rx.fw = rx.ack;
        rx.wait = true;
        rx.held = 0;
        lag = 0;
      }
      let send: ArrayBuffer | null = out;
      if (lag > RELAY_DEAD) {
        send = null; // nothing acknowledged for 3 s: probably gone (probes only)
      } else if (isVideo) {
        if (!rx.wait && lag > RELAY_LAG) {
          rx.wait = true;
          this.viewerKey(dev, rx);
        }
        if (rx.wait) {
          if (head.key && lag <= RELAY_RESUME) {
            rx.wait = false;
            rx.probed = false;
          } else {
            // The picture waits for a key frame; the sound doesn't.
            send = head.kind === KIND_VIDEO_AUDIO && lag <= RELAY_LAG * 2 ? audioOnly(raw) : null;
          }
        }
      } else if (head.kind === KIND_JPEG && lag > RELAY_LAG) {
        send = null; // every JPEG stands alone: a viewer that's behind just skips some
      }
      if (!send) {
        // Held back — and if it has gone quiet meanwhile, find out where it really is.
        const quiet = now - rx.ackAt;
        const gap = quiet >= RELAY_PROBE_SLOW_AFTER_MS ? RELAY_PROBE_SLOW_MS : RELAY_PROBE_MS;
        send = quiet < gap || now - rx.fwAt < gap ? null : relayProbe(head, raw, out);
        if (!send) {
          rx.held += 1;
          // Only picture deltas without sound: a key frame will do (not for one that's probably gone).
          if (quiet >= gap && now - rx.fwAt >= gap && quiet < RELAY_PROBE_SLOW_AFTER_MS) this.viewerKey(dev, rx);
          continue;
        }
        rx.probed = true;
      }
      // What it was held back from isn't in flight: the window counts what it was sent,
      // so resuming on a key frame doesn't count the gap before it.
      if (rx.held && seqDiff(rx.fw, rx.ack) >= 0) rx.ack = (rx.ack + rx.held) >>> 0;
      rx.held = 0;
      sendBin(s.ws, send);
      rx.fw = head.seq;
      rx.fwAt = now;
    }
  }

  /** Every viewer of this camera waits for its next key frame. */
  private relayResync(dev: string): void {
    for (const s of this.authed()) {
      if (s.a.mode !== 'viewer' || s.a.relay !== dev || s.a.rc == null) continue;
      const rx = this.relayRx.get(s.a.sid);
      if (rx) rx.wait = true;
    }
    this.requestKey(dev);
  }

  // -------------------------------------------------------------- queries
  /** History, log pages, sleep and reports for the family's screens. */
  private async onQuery(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const id = clip(msg.id, 20);
    const q = String(msg.q ?? '');
    const now = Date.now();
    const reply = (data: Record<string, unknown>) => this.send(ws, { t: 'r', id, q, ...data });
    if (q === 'history') {
      const to = Math.min(now + 60_000, num(msg.to, 0, now + 60_000, now));
      const from = num(msg.from, to - 7 * 24 * 60 * 60_000, to, to - 6 * 60 * 60_000);
      return reply({ from, to, ...historyBuckets(this.store.minutes(from, to, msg.dev ? clip(msg.dev, 40) : undefined), from, to) });
    }
    if (q === 'events') {
      const kinds = Array.isArray(msg.kinds) ? (msg.kinds as unknown[]).map((k) => clip(k, 20)).filter(Boolean).slice(0, 30) : undefined;
      const limit = Math.round(num(msg.limit, 1, 200, 80));
      const rows = this.store.events({ before: msg.before == null ? undefined : num(msg.before, 0, now + 1), limit: limit + 1, kinds }).map(toLog);
      return reply({ rows: rows.slice(0, limit), more: rows.length > limit });
    }
    if (q === 'track') {
      // The tracker's log for a window, with the camera's automatic sleep sessions alongside.
      const to = num(msg.to, 0, now + 24 * 60 * 60_000, now + 60_000);
      const from = num(msg.from, to - 400 * 24 * 60 * 60_000, to, to - 2 * 24 * 60 * 60_000);
      const auto: TrackRow[] = this.store
        .sleepBetween(from, to)
        .filter((x) => !x.summary?.discarded && x.onset != null)
        .map((x) => ({ id: `ms-${x.id}`, kind: 'sleep', start: x.onset ?? x.start, end: x.end, by: 'Camera', by_uid: 'camera', data: { where: 'crib', wakings: x.wakings }, src: 'monitor', updated: x.end ?? now }));
      return reply({ from, to, items: this.tracker.range(from, to), auto, settings: { tz: (await this.settings()).tz, baby: (await this.settings()).baby ?? null } });
    }
    if (q === 'track_sync') {
      return reply({ items: this.tracker.changedSince(num(msg.since, 0, now, 0)), now });
    }
    if (q === 'sleep') {
      const days = Math.round(num(msg.days, 1, 60, 14));
      return reply({ sessions: this.store.sleepBetween(now - days * 24 * 60 * 60_000, now + 1).filter((s) => !s.summary?.discarded), status: await this.sleepStatus(), tz: (await this.settings()).tz });
    }
    if (q === 'report') {
      const sid = clip(msg.session, 20);
      const row = sid ? this.store.sleep(sid) : this.store.lastSleep(1, 'night')[0] ?? null;
      if (!row) return reply({ report: null });
      const end = row.end ?? now;
      const minutes = this.store.minutes(row.start, end + 60_000);
      const incidents = this.store.incidentsBetween(row.start, end).filter((i) => i.ack_at);
      return reply({
        report: {
          ...row,
          ...historyBuckets(minutes, row.start, end + 60_000, 5 * 60_000),
          events: this.store.eventsBetween(row.start, end + 60_000).filter((e) => e.sev !== 'info' || e.kind === 'visit_start').map(toLog).slice(0, 300),
          response: incidents.length ? Math.round(incidents.reduce((s, i) => s + ((i.ack_at ?? i.at) - i.at), 0) / incidents.length / 1000) : null,
        },
        tz: (await this.settings()).tz,
      });
    }
    if (q === 'weeks') {
      return reply({ days: this.weeks(now, (await this.settings()).tz, Math.round(num(msg.days, 7, 28, 14))) });
    }
    if (q === 'day') {
      // Today (in the nursery's zone) at a glance.
      const settings = await this.settings();
      const p = localParts(now, settings.tz);
      const sinceMidnight = (p.h * 60 + p.mi) * 60_000;
      const from = now - sinceMidnight;
      const t = this.store.tally(from, now + 1);
      const sessions = this.store.sleepBetween(from, now + 1).filter((s) => !s.summary?.discarded);
      const sleepMin = sessions.reduce((acc, s) => acc + s.asleep_min, 0);
      return reply({ from, tally: t, sleepMin, naps: sessions.filter((s) => s.kind === 'nap').length, summary: this.summarise(from, now + 1) });
    }
  }

  /**
   * What the monitor measured, per local day (oldest first, today last and
   * partial): sleep the camera saw, night wakings, crying, alerts and how
   * fast someone answered, and the sound level while the baby slept.
   */
  weeks(now: number, tz: string, days = 14): {
    day: number; sleepMin: number; nightMin: number; naps: number; wakings: number; longestMin: number;
    cryMin: number; cries: number; alerts: number; responseSec: number | null; sleepLaeq: number | null; loud: number;
  }[] {
    const p = localParts(now, tz);
    const today = now - (p.h * 60 + p.mi) * 60_000 - (now % 60_000);
    const sessions = this.store.sleepBetween(today - days * 86_400_000, now + 1).filter((x) => !x.summary?.discarded);
    const out = [];
    for (let k = days - 1; k >= 0; k--) {
      const from = today - k * 86_400_000;
      const to = k === 0 ? now + 1 : from + 86_400_000;
      const mine = sessions.filter((x) => x.start >= from && x.start < to);
      const nights = mine.filter((x) => x.kind === 'night');
      const t = this.store.tally(from, to);
      const inc = this.store.incidentsBetween(from, to);
      const answered = inc.filter((i) => i.ack_at != null);
      // Energy-average LAeq over the minutes the baby was asleep.
      let e = 0;
      let n = 0;
      for (const x of mine) {
        for (const m of this.store.minutes(x.onset ?? x.start, x.end ?? to)) {
          if (m.laeq == null) continue;
          e += 10 ** (m.laeq / 10);
          n++;
        }
      }
      out.push({
        day: from,
        sleepMin: mine.reduce((a, x) => a + x.asleep_min, 0),
        nightMin: nights.reduce((a, x) => a + x.asleep_min, 0),
        naps: mine.filter((x) => x.kind === 'nap').length,
        wakings: nights.reduce((a, x) => a + x.wakings, 0),
        longestMin: mine.reduce((a, x) => Math.max(a, x.longest_min), 0),
        cryMin: Math.round((t.cry_end?.secs ?? 0) / 60),
        cries: t.cry?.n ?? 0,
        alerts: inc.length,
        responseSec: answered.length ? Math.round(answered.reduce((a, i) => a + (i.ack_at! - i.at), 0) / answered.length / 1000) : null,
        sleepLaeq: n ? Math.round(10 * Math.log10(e / n) * 10) / 10 : null,
        loud: (t.very_loud?.n ?? 0) + (t.loud_db?.n ?? 0),
      });
    }
    return out;
  }

  private async onSleepDelete(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent') return;
    const row = this.store.sleep(clip(msg.session, 20));
    if (!row || row.end == null) return;
    this.store.putSleep({ ...row, summary: { ...(row.summary ?? {}), discarded: true, by: a.name } });
    await this.addLog({ kind: 'note', msg: `${a.label || a.name} removed a ${row.kind} from the sleep history`, by: a.name, sev: 'info' });
    this.broadcast({ t: 'sleep', sleep: await this.sleepStatus() });
  }

  // ---------------------------------------------------------------- push
  private async onPushSub(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const sub = msg.sub as PushSubscriptionJSONLike | undefined;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return;
    if (!isAllowedPushEndpoint(sub.endpoint) || sub.endpoint.length > 1024) {
      return this.send(ws, { t: 'notice', text: 'This browser’s push service is not supported.' });
    }
    const p = (msg.prefs ?? {}) as Record<string, unknown>;
    const rec: PushRec = {
      sub: { endpoint: sub.endpoint, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 64) } },
      uid: a.uid!,
      name: a.name || 'Member',
      role: a.role,
      prefs: Object.fromEntries(
        PUSH_KINDS.map((k) => {
          // Life-safety alerts can't be switched off.
          if (k === 'alarm') return [k, true];
          // Older apps sent "noise" for what is now "loud" (and had no "very loud").
          const legacy = p.loud === undefined;
          const v = legacy && k === 'loud' ? p.noise : legacy && k === 'noise' ? undefined : p[k];
          return [k, typeof v === 'boolean' ? v : PUSH_DEFAULTS[k]];
        }),
      ),
      at: Date.now(),
    };
    const all = ((await this.state.storage.get<PushRec[]>('push')) ?? []).filter((r) => r.sub.endpoint !== rec.sub.endpoint);
    all.push(rec);
    await this.state.storage.put('push', all.slice(-PUSH_CAP));
    this.send(ws, { t: 'push_ok', prefs: rec.prefs });
  }

  private async onPushUnsub(a: Attach, msg: Record<string, unknown>): Promise<void> {
    const endpoint = String(msg.endpoint ?? '');
    const all = (await this.state.storage.get<PushRec[]>('push')) ?? [];
    // Only the owner of a subscription may remove it.
    await this.state.storage.put('push', all.filter((r) => !(r.sub.endpoint === endpoint && r.uid === a.uid)));
  }

  private async onPushTest(ws: WebSocket, a: Attach): Promise<void> {
    const keys = await this.vapidKeys();
    const mine = ((await this.state.storage.get<PushRec[]>('push')) ?? []).filter((r) => r.uid === a.uid);
    if (!keys || mine.length === 0) return this.send(ws, { t: 'notice', text: 'Turn on alerts on this device first.' });
    const nid = await this.state.storage.get<string>('nid');
    let sent = 0;
    for (const r of mine) {
      const out = await sendWebPush(r.sub, { title: 'Test alert', body: 'Baby monitor alerts are working on this device.', kind: 'test', nid, at: Date.now() }, keys, { subject: VAPID_SUBJECT, urgency: 'normal' });
      if (out === 'sent') sent++;
    }
    this.send(ws, { t: 'notice', text: sent ? 'Test alert sent — check your notifications.' : 'The push service rejected the test. Turn alerts off and on again.' });
  }

  /**
   * Alert the people who opted in. `audience: 'duty'` reaches only the person
   * on duty (when someone is); `force` skips the per-kind cooldown (escalations).
   */
  private async pushAlert(kind: PushKind, note: { title: string; body: string; entryId: string }, dev?: string, opts: { audience?: 'all' | 'duty' | 'parents'; incident?: string; force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const key = `${kind}:${dev ?? '-'}`;
    const last = (await this.state.storage.get<Record<string, number>>('lastPush')) ?? {};
    const settings = await this.settings();
    const cooldown = kind === 'cry' ? settings.cryRepeatMin * 60_000 : kind === 'report' ? 0 : PUSH_COOLDOWN_MS[kind] ?? 10 * 60_000;
    if (!opts.force && now - (last[key] ?? 0) < cooldown) return;
    last[key] = now;
    await this.state.storage.put('lastPush', last);

    const keys = await this.vapidKeys();
    const subs = (await this.state.storage.get<PushRec[]>('push')) ?? [];
    if (!keys || subs.length === 0) return;
    const duty = opts.audience === 'duty' ? await this.duty() : null;
    const nid = await this.state.storage.get<string>('nid');
    const payload = { title: note.title, body: note.body, kind, nid, ref: note.entryId, inc: opts.incident ?? null, at: now };
    const gone = new Set<string>();
    await Promise.all(
      subs
        .filter((r) => (kind === 'alarm' ? true : r.prefs[kind] ?? PUSH_DEFAULTS[kind]))
        .filter((r) => !duty || r.uid === duty.uid)
        .filter((r) => opts.audience !== 'parents' || r.role === 'parent' || r.role === undefined)
        .map(async (r) => {
          const out = await sendWebPush(r.sub, payload, keys, {
            subject: VAPID_SUBJECT,
            urgency: PUSH_URGENT.has(kind) || kind === 'cough' || kind === 'crash' ? 'high' : 'normal',
            ttlSec: kind === 'cry' || kind === 'alarm' || kind === 'zone' ? 300 : kind === 'report' ? 6 * 3600 : 1800,
            topic: `${kind}${(nid ?? '').slice(0, 8)}`,
          });
          if (out === 'gone') gone.add(r.sub.endpoint);
        }),
    );
    if (gone.size) await this.state.storage.put('push', subs.filter((r) => !gone.has(r.sub.endpoint)));
  }

  // ------------------------------------------------------------- settings
  private async settings(): Promise<Settings> {
    const s = { ...DEFAULT_SETTINGS, ...((await this.state.storage.get<Partial<Settings>>('settings')) ?? {}) };
    return { ...s, zones: s.zones ?? {} };
  }

  /** Nursery-wide settings. Parents change everything; caregivers can place zones. */
  private async onSettings(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role === 'viewer') return;
    const cur = await this.settings();
    const parent = a.role === 'parent';
    if (parent) {
      if (msg.sensitivity === 'low' || msg.sensitivity === 'medium' || msg.sensitivity === 'high') cur.sensitivity = msg.sensitivity;
      if (msg.cryRepeatMin != null) cur.cryRepeatMin = Math.round(num(msg.cryRepeatMin, 1, 30, 3));
      if (msg.cryEscalateMin != null) cur.cryEscalateMin = Math.round(num(msg.cryEscalateMin, 1, 30, 5));
      if (msg.noiseDb === null) cur.noiseDb = null;
      else if (msg.noiseDb != null) cur.noiseDb = Math.round(num(msg.noiseDb, 45, 100, 70));
      if (typeof msg.machineCheck === 'boolean') cur.machineCheck = msg.machineCheck;
      if (typeof msg.sleepTracking === 'boolean') cur.sleepTracking = msg.sleepTracking;
      if (msg.baby && typeof msg.baby === 'object') {
        const b = msg.baby as Record<string, unknown>;
        const birth = typeof b.birth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.birth) && Date.parse(b.birth) <= Date.now() && Date.parse(b.birth) > Date.now() - 6 * 366 * 86400_000 ? b.birth : null;
        cur.baby = { birth, sex: b.sex === 'f' || b.sex === 'm' ? b.sex : null };
      }
    }
    if (msg.zones && typeof msg.zones === 'object' && typeof (msg.zones as Record<string, unknown>).dev === 'string') {
      const z = msg.zones as { dev: string; list: unknown };
      const dev = clip(z.dev, 40);
      if (dev) {
        const list = sanitizeZones(z.list);
        const next = { ...cur.zones, [dev]: list };
        // Keep zones for at most 6 cameras.
        cur.zones = Object.fromEntries(Object.entries(next).slice(-6));
        await this.addLog({ kind: 'note', msg: `${a.label || a.name} ${list.length ? `set ${list.length} zone${list.length === 1 ? '' : 's'}` : 'cleared the zones'} on a camera`, by: a.name, sev: 'info' });
      }
    }
    await this.state.storage.put('settings', cur);
    this.broadcast({ t: 'settings', settings: cur });
  }

  // ------------------------------------------------------------- guests
  /** Someone opened the share link and typed the passcode. */
  private async handleGuestJoin(req: Request, url: URL): Promise<Response> {
    const nid = await this.state.storage.get<string>('nid');
    if (!nid || url.searchParams.get('nid') !== nid) return json({ ok: false, reason: 'bad_link' }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, reason: 'bad_link' }, 400);
    }
    const now = Date.now();
    const c = await this.guests.check(
      { code: clip(body.code, 64), pass: String(body.pass ?? '').slice(0, 200), name: String(body.name ?? ''), ip: req.headers.get('cf-connecting-ip') || undefined },
      now,
    );
    // Signed in? Who they are comes from their own token, checked by Supabase —
    // never from the body. A member of this nursery needs no guest pass; anyone
    // else with an account can be made a member by a parent later.
    let account: LiveIdentity | null = null;
    const bearer = c.ok ? bearerFrom(req) : null;
    if (bearer) {
      account = await verifyMember(this.env, bearer);
      if (account) {
        const role = await callRpc<{ ok?: boolean; role?: MonRole }>(this.env, bearer, 'monitor_my_role', { p_nursery: nid });
        if (role.ok && role.data.ok && role.data.role) return json({ ok: false, reason: 'member' }, 409);
      }
    }
    // `issue` re-reads the link: a new passcode, a new link or "off" while we waited on Supabase wins.
    const r = c.ok ? await this.guests.issue(c, { name: c.name, dev: clip(body.dev, 40) }, now) : c;
    const meta = await this.meta();
    if (r.ok) {
      if (account) this.guests.addRequest({ uid: account.userId, account: account.displayName, name: r.guest.name, guest_id: r.guest.id }, now);
      const entry = await this.addLog({ kind: 'people', msg: `${r.guest.name} joined as a guest with the share link${account ? ' (has a Stream Studio account)' : ''}`, by: r.guest.name });
      await this.pushAlert(
        'guest',
        account
          ? { title: `${r.guest.name} joined ${meta.name} with the share link`, body: `They have a Stream Studio account (${account.displayName}) — make them a member in Invite → Who has access, so they can watch without the passcode.`, entryId: entry.id }
          : { title: `${r.guest.name} is now a guest of ${meta.name}`, body: 'They joined with the share link and passcode. Remove them any time in Invite → Who has access.', entryId: entry.id },
        undefined,
        { audience: 'parents', force: true },
      );
      this.sendShareInfo();
      return json({ ok: true, token: r.token, guest: { name: r.guest.name, role: r.guest.role, until: r.guest.expires_at }, nursery: meta, ...(account ? { account: true } : {}) });
    }
    if (r.disabled) {
      const entry = await this.addLog({ kind: 'people', sev: 'warn', msg: 'The share link was turned off after too many wrong passcodes — guests were signed out' });
      await this.pushAlert('guest', { title: `Share link for ${meta.name} turned off`, body: 'Someone kept entering the wrong passcode. Make a new link and passcode if you still want to share.', entryId: entry.id }, undefined, { audience: 'parents', force: true });
      this.kickGuests(null);
      this.sendShareInfo();
    } else if (r.reason === 'locked' && r.retryAt === now + LOCK_MS) {
      const entry = await this.addLog({ kind: 'people', sev: 'warn', msg: 'Wrong passcode entered 5 times — the share link is locked for 15 minutes' });
      await this.pushAlert('guest', { title: `Wrong passcodes for ${meta.name}`, body: 'The share link is locked for 15 minutes. If this wasn’t someone you invited, turn the link off.', entryId: entry.id }, undefined, { audience: 'parents', force: true });
      this.sendShareInfo();
    }
    const status = r.reason === 'bad_link' ? 404 : r.reason === 'slow_down' || r.reason === 'locked' ? 429 : r.reason === 'wrong' || r.reason === 'name' ? 401 : 410;
    return json({ ok: false, reason: r.reason, retryAt: r.retryAt ?? null, left: r.left ?? null }, status);
  }

  private async onShareSet(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const pass = String(msg.pass ?? '');
    const meta = await this.meta();
    const problem = passcodeProblem(pass, [meta.baby, meta.name]);
    if (problem) return this.send(ws, { t: 'share_err', msg: problem });
    const role: GuestRole = msg.role === 'caregiver' ? 'caregiver' : 'viewer';
    const days = msg.days === 1 || msg.days === 7 || msg.days === 30 ? msg.days : null;
    const { removed } = await this.guests.createShare({ pass, role, days, by: a.name || 'A parent' }, Date.now());
    this.kickGuests(removed);
    await this.addLog({ kind: 'people', msg: `${a.name} made a new share link (${role === 'caregiver' ? 'watch, talk & answer alerts' : 'watch & listen'}${days ? `, ${days} day${days > 1 ? 's' : ''}` : ''})`, by: a.name });
    this.sendShareInfo();
  }

  private async onShareOff(a: Attach): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const removed = this.guests.revokeShare(Date.now());
    this.kickGuests(removed);
    await this.addLog({ kind: 'people', msg: `${a.name} turned the share link off${removed.length ? ` and signed out ${removed.length} guest${removed.length > 1 ? 's' : ''}` : ''}`, by: a.name });
    this.sendShareInfo();
  }

  /** A new passcode on the same link (forgotten or passed on too widely). Guests stay unless asked. */
  private async onSharePass(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const pass = String(msg.pass ?? '');
    const meta = await this.meta();
    const problem = passcodeProblem(pass, [meta.baby, meta.name]);
    if (problem) return this.send(ws, { t: 'share_err', msg: problem });
    const r = await this.guests.setPasscode(pass, msg.signOut === true, Date.now());
    if (!r) return this.send(ws, { t: 'share_err', msg: 'There’s no link to change — make a new one.' });
    this.kickGuests(r.removed);
    const n = r.removed.length;
    await this.addLog({ kind: 'people', msg: `${a.name} set a new passcode for the share link${n ? ` and signed out ${n} guest${n > 1 ? 's' : ''}` : ' (guests stay signed in)'}`, by: a.name });
    this.sendShareInfo();
    this.sendGuestPasses();
  }

  /** Keep the link working longer — or until a parent turns it off. */
  private async onShareExtend(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    // An absent value is never "forever": only an explicit null (or 0) is.
    const days = msg.days === 1 || msg.days === 7 || msg.days === 30 ? msg.days : msg.days === null || msg.days === 0 ? null : undefined;
    if (days === undefined) return;
    const s = this.guests.extend(days, Date.now());
    if (!s) return;
    await this.addLog({ kind: 'people', msg: `${a.name} ${days == null ? 'made the share link work until it’s turned off' : `extended the share link by ${days} day${days > 1 ? 's' : ''}`}`, by: a.name });
    this.sendShareInfo();
    this.sendGuestPasses();
  }

  /** "Keep as a guest": hide the make-member suggestion for this person. */
  private async onRequestDismiss(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    if (this.guests.dismissRequest(clip(msg.id, 20), Date.now())) this.sendShareInfo();
  }

  private async onGuestRemove(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent' || a.guest) return;
    const id = clip(msg.id, 20);
    const g = this.guests.guests(Date.now()).find((x) => x.id === id);
    if (!g || !this.guests.removeGuest(id, Date.now())) return;
    this.kickGuests([id]);
    await this.addLog({ kind: 'people', msg: `${a.name} removed guest ${g.name}`, by: a.name });
    this.sendShareInfo();
  }

  /** Close removed guests' sockets and forget their phones (null = every guest). */
  private kickGuests(ids: string[] | null): void {
    const set = ids ? new Set(ids) : null;
    for (const s of this.authed()) {
      if (s.a.guest && (!set || set.has(s.a.guest))) {
        this.send(s.ws, { t: 'error', code: 'removed', msg: 'Your guest pass for this nursery has ended.' });
        try {
          s.ws.close(4004, 'removed');
        } catch { /* closed */ }
      }
    }
    this.dropGuestPushes(set);
  }

  /** Forget ended guests' phones for alerts (null = every guest). */
  private dropGuestPushes(set: Set<string> | null): void {
    if (set && set.size === 0) return;
    void (async () => {
      const subs = (await this.state.storage.get<PushRec[]>('push')) ?? [];
      const keep = subs.filter((r) => !r.uid.startsWith('g:') || (set != null && !set.has(r.uid.slice(2))));
      if (keep.length !== subs.length) await this.state.storage.put('push', keep);
    })();
  }

  private sendShareInfo(): void {
    const info = this.guests.info(Date.now());
    for (const s of this.authed()) if (s.a.role === 'parent' && !s.a.guest) this.send(s.ws, { t: 'share', share: info });
  }

  /** Each connected guest's device keeps its pass's end date: when it moves (a parent extended the link), say so. */
  private sendGuestPasses(): void {
    const until = new Map(this.guests.guests(Date.now()).map((g) => [g.id, g.expires_at]));
    for (const s of this.authed()) {
      const t = s.a.guest ? until.get(s.a.guest) : undefined;
      if (t != null) this.send(s.ws, { t: 'guest_pass', until: t });
    }
  }

  /** A parent changed the member list: drop sockets of anyone removed; everyone else's open sockets take their role now. */
  private async onMembersChanged(a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.role !== 'parent') return;
    const token = clip(msg.token, 4096);
    const nid = await this.state.storage.get<string>('nid');
    if (!token || !nid) return;
    // Whose access changed, when the app says (none named = anyone's may have).
    const who = Array.isArray(msg.uids) ? new Set(msg.uids.slice(0, 40).map((u) => clip(u, 64))) : null;
    const [res, ppl] = await Promise.all([
      callRpc<{ ok?: boolean; ids?: string[] }>(this.env, token, 'monitor_member_ids', { p_nursery: nid }),
      callRpc<{ ok?: boolean; people?: Person[] }>(this.env, token, 'monitor_people', { p_nursery: nid }),
    ]);
    const people = ppl.ok && ppl.data.ok && Array.isArray(ppl.data.people) ? ppl.data.people : null;
    if (!res.ok || !res.data.ok || !Array.isArray(res.data.ids)) return void this.recheckRoles(people, who);
    const ids = new Set(res.data.ids);
    const cut: string[] = [];
    for (const s of this.authed()) {
      // Guests aren't Supabase members; their access is the share link's.
      if (s.a.uid && !s.a.guest && !ids.has(s.a.uid)) {
        cut.push(s.a.sid);
        this.send(s.ws, { t: 'error', code: 'removed', msg: 'You were removed from this nursery.' });
        try {
          s.ws.close(4004, 'removed');
        } catch { /* closed */ }
      }
    }
    // At once, before anything else awaits: a demoted parent's next message is a non-parent's.
    const moved = this.recheckRoles(people, who, new Set(cut));
    // Removed people leave any family call at once and are never rung again.
    const book = await this.callBook();
    const changed = cut.flatMap((sid) => book.leave(sid, Date.now()));
    if (changed.length) await this.commitCalls(book, changed);
    const rings = (await this.state.storage.get<CallPushRec[]>('callPush')) ?? [];
    if (rings.some((r) => !ids.has(r.uid))) await this.state.storage.put('callPush', rings.filter((r) => ids.has(r.uid)));

    // Guests with an account a parent just made a member: their guest pass
    // ends and their app reconnects with their own account.
    const now = Date.now();
    const promoted = this.guests.resolveRequests(ids, now);
    if (promoted.length) {
      const gone = new Set(promoted.map((p) => p.guest_id));
      for (const s of this.authed()) {
        if (!s.a.guest || !gone.has(s.a.guest)) continue;
        this.send(s.ws, { t: 'promoted' });
        try {
          s.ws.close(4007, 'promoted');
        } catch { /* closed */ }
      }
      for (const id of gone) this.guests.removeGuest(id, now);
      this.dropGuestPushes(gone);
      for (const p of promoted) await this.addLog({ kind: 'people', msg: `${a.name} made ${p.name} a member — they now watch with their own account`, by: a.name });
      this.sendShareInfo();
    } else {
      await this.addLog({ kind: 'people', msg: `${a.name} updated who can access this nursery`, by: a.name });
    }
    // Only the people whose access changed need to reconnect (when the app says
    // who) — adding Grandma shouldn't restart everyone else's live picture.
    if (who) this.broadcast({ t: 'roles_changed' }, (x) => !!x.uid && (who.has(x.uid) || moved.has(x.sid)));
    else this.broadcast({ t: 'roles_changed' });
  }

  /**
   * A socket's role is read when it signs in; roles changed in Supabase take
   * effect on sockets already open here, so a demoted parent's Invite sheet,
   * watch screen, camera or call line keeps no power it no longer has. An
   * Invite sheet that's no longer a parent's, or a camera run by someone now a
   * viewer, is closed with the reason signing in again would give.
   *
   * If Supabase couldn't list the roles, the sockets concerned (the people
   * named; everyone's when nobody is) may do nothing only a parent may until
   * they sign in again: an Invite sheet signs in again at once (close 4009, it
   * reconnects), and a watch screen or camera keeps running as a caregiver at
   * most — a Supabase hiccup must never stop anyone watching the baby. (A call
   * line has nothing a role grants.) Returns the sockets whose role changed.
   */
  private recheckRoles(people: Person[] | null, who: Set<string> | null, skip?: Set<string>): Set<string> {
    const changed = new Set<string>();
    const now = people ? new Map(people.map((p) => [String(p.user_id), p])) : null;
    for (const { ws, a } of this.authed()) {
      if (!a.uid || a.guest || skip?.has(a.sid)) continue;
      if (!now) {
        if (who && !who.has(a.uid)) continue;
        if (a.mode === 'admin') {
          try {
            ws.close(4009, 'recheck');
          } catch { /* closed */ }
        } else if (a.role === 'parent' && a.mode !== 'line') {
          ws.serializeAttachment({ ...a, role: 'caregiver' });
          changed.add(a.sid);
        }
        continue;
      }
      const p = now.get(a.uid);
      const role = p?.role === 'parent' || p?.role === 'caregiver' || p?.role === 'viewer' ? p.role : null;
      if (!role) continue; // not a member any more: cut off above
      const label = typeof p?.label === 'string' ? p.label : null;
      if (role === a.role && label === (a.label ?? null)) continue;
      ws.serializeAttachment({ ...a, role, label });
      changed.add(a.sid);
      if (a.mode === 'admin' && role !== 'parent') this.reject(ws, 'forbidden', 'Only parents can manage this nursery.');
      else if (a.mode === 'camera' && role === 'viewer') this.reject(ws, 'forbidden', 'Your role can watch but not run the camera. Ask a parent to make you a caregiver.');
    }
    return changed;
  }

  /** Panic button: end every viewing session but the parent's own. */
  private async onEndAll(a: Attach): Promise<void> {
    if (a.role !== 'parent') return;
    for (const s of this.authed()) {
      if (s.a.mode === 'viewer' && s.a.sid !== a.sid) {
        this.send(s.ws, { t: 'error', code: 'ended', msg: `${a.name} ended all viewing sessions.` });
        try {
          s.ws.close(4006, 'ended');
        } catch { /* closed */ }
      }
    }
    await this.addLog({ kind: 'people', msg: `${a.name} ended all other viewing sessions`, by: a.name });
  }

  // ------------------------------------------------------------------ log
  private async addLog(e: { kind: string; msg: string; by?: string; dev?: string; secs?: number; conf?: number; db?: number; sev?: Severity; incident?: string; at?: number; meta?: Record<string, unknown> }): Promise<MonLog> {
    const row: StoredEvent = {
      id: newId().slice(0, 10),
      at: e.at ?? Date.now(),
      kind: e.kind,
      sev: e.sev ?? this.sevOf(e.kind),
      msg: clip(e.msg, 240),
      by: e.by ?? null,
      dev: e.dev ?? null,
      secs: e.secs ?? null,
      conf: e.conf ?? null,
      db: e.db ?? null,
      incident: e.incident ?? null,
      meta: e.meta ?? null,
    };
    this.store.addEvent(row);
    const entry = toLog(row);
    this.broadcast({ t: 'log', entry });
    return entry;
  }

  // ---------------------------------------------------------------- alarm
  // ---------------------------------------------------------- family calls
  private async callBook(): Promise<CallBook> {
    return new CallBook((await this.state.storage.get<Call[]>('calls')) ?? []);
  }

  /** Line sockets of everyone a call concerns (the caller and everyone asked). */
  private toCallers(call: Call, obj: unknown): void {
    const who = new Set([call.from.uid, ...call.invited]);
    const payload = JSON.stringify(obj);
    for (const { ws, a } of this.authed()) {
      if (a.mode !== 'line' || !a.uid || !who.has(a.uid)) continue;
      try {
        ws.send(payload);
      } catch { /* closing */ }
    }
  }

  /** Save the book, tell everyone concerned, and log + clear calls that ended. */
  private async commitCalls(book: CallBook, changed: Call[]): Promise<void> {
    for (const c of changed) this.toCallers(c, { t: 'call', call: c });
    const done = book.sweep();
    await this.state.storage.put('calls', book.toJSON());
    if (!done.length) return;
    const log = (await this.state.storage.get<CallRecord[]>('callLog')) ?? [];
    const meta = await this.meta();
    for (const c of done) {
      const rec = toRecord(c);
      log.push(rec);
      this.toCallers(c, { t: 'call_log', rec });
      const missed = missedBy(c);
      if (missed.length) {
        await this.callPush(missed, { title: `Missed ${c.video ? 'video' : 'audio'} call`, body: `${c.from.label || c.from.name} · ${familyOf(meta)}`, kind: 'call_missed', call: c.id }, 6 * 3600, 'normal');
      }
    }
    await this.state.storage.put('callLog', log.slice(-CALL_LOG_CAP));
  }

  /** Ringing calls past their time and devices that never came back. Returns when the next is due. */
  private async expireCalls(now: number): Promise<number | null> {
    const book = await this.callBook();
    const out = book.expire(now);
    if (out.length) await this.commitCalls(book, out);
    return book.nextDeadline();
  }

  /** A member's app, reachable for calls: a light hello (no monitor data). */
  private async admitLine(ws: WebSocket, a: Attach, nid: string, meta: { name: string; baby: string | null }): Promise<void> {
    const now = Date.now();
    await this.expireCalls(now);
    const book = await this.callBook();
    const [ice, vapid] = await Promise.all([this.iceServers(), this.vapidKeys()]);
    const mine = (r: CallRecord) => r.from.uid === a.uid || r.invited.includes(a.uid!);
    const log = ((await this.state.storage.get<CallRecord[]>('callLog')) ?? []).filter(mine).slice(-30);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode: 'line', dev: a.dev },
      nursery: { id: nid, ...meta },
      ice,
      vapid: vapid?.publicKey ?? null,
      calls: book.forUser(a.uid!),
      callLog: log,
    });
  }

  private async onLineGone(a: Attach): Promise<void> {
    const now = Date.now();
    const book = await this.callBook();
    const changed = book.drop(a.sid, now);
    if (!changed.length) return;
    await this.commitCalls(book, changed);
    await this.ensureAlarm(Math.max(1000, (book.nextDeadline() ?? now) - now + 500));
  }

  /**
   * A phone that dies mid-call can leave its socket half-open for minutes, so
   * the room would keep it "in" the call forever. A line in an answered call
   * that hasn't pinged (the runtime's auto-response time) or said anything for
   * a minute is dropped — it gets the usual grace to come back. True while any
   * call is up (the alarm keeps checking).
   */
  private async dropStaleLines(now: number): Promise<boolean> {
    const book = await this.callBook();
    const up = book.toJSON().filter((c) => !c.ended && c.answeredAt != null);
    if (!up.length) return false;
    const inCall = new Set(up.flatMap((c) => c.parts.filter((p) => p.gone == null).map((p) => p.sid)));
    for (const { ws, a } of this.authed()) {
      if (a.mode !== 'line' || !inCall.has(a.sid)) continue;
      let pinged = 0;
      try {
        pinged = this.state.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
      } catch { /* not supported */ }
      if (now - Math.max(a.at, pinged, this.lineSeen.get(a.sid) ?? 0) < LINE_STALE_MS) continue;
      try {
        ws.close(4008, 'stale');
      } catch { /* closed */ }
      this.lineSeen.delete(a.sid);
      await this.onLineGone(a);
    }
    return true;
  }

  private async onCallMsg(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (!a.uid || a.guest) return;
    const now = Date.now();
    const id = clip(msg.id, 24);
    const me = { uid: a.uid, name: a.name || 'Member', label: a.label ?? null, sid: a.sid };
    // Member ids (Supabase UUIDs). Not checked against the member list: only members' sockets and phones are here to ring.
    const uuids = (v: unknown) => (Array.isArray(v) ? v.slice(0, 16).map((u) => clip(u, 40)).filter((u) => /^[\w-]{1,40}$/.test(u)) : []);
    switch (msg.t) {
      case 'call_rtc': {
        const to = clip(msg.to, 20);
        if (msg.d == null || typeof msg.d !== 'object') return;
        if (!(await this.callBook()).canRelay(id, a.sid, to)) return;
        for (const s of this.authed()) {
          if (s.a.sid === to && s.a.mode === 'line') return this.send(s.ws, { t: 'call_rtc', id, from: a.sid, d: msg.d });
        }
        return;
      }
      case 'call_start': {
        // Fresh relay credentials for this call — fetched before the book is read, so nothing
        // can change the book between reading and saving it.
        const ice = await this.iceServers();
        await this.expireCalls(now);
        const book = await this.callBook();
        const ref = clip(msg.ref, 20);
        const call = book.start(me, uuids(msg.to), msg.video !== false, crypto.randomUUID().replace(/-/g, '').slice(0, 16), now);
        if ('error' in call) return this.send(ws, { t: 'call_err', error: call.error, ref });
        this.send(ws, { t: 'call_started', ref, id: call.id, ice });
        await this.commitCalls(book, [call]);
        const meta = await this.meta();
        await this.callPush(call.invited, { title: me.label || me.name, body: `${call.video ? 'Video' : 'Audio'} call · ${familyOf(meta)}`, kind: 'call', call: call.id }, Math.round(RING_MS / 1000), 'high');
        await this.ensureAlarm(RING_MS + 500);
        return;
      }
      case 'call_join': {
        const book = await this.callBook();
        const call = book.join(id, me, msg.video !== false, now, msg.mic !== false);
        if ('error' in call) return this.send(ws, { t: 'call_err', error: call.error, id });
        // Saved before anything else is awaited: the joiner's offer is right behind this message.
        await this.commitCalls(book, [call]);
        await this.ensureAlarm(LINE_CHECK_MS);
        return this.send(ws, { t: 'call_joined', id, ice: await this.iceServers() });
      }
      case 'call_up': {
        // "Their media still reaches me": keeps a device that lost the room in the call (not broadcast).
        const book = await this.callBook();
        if (book.vouch(id, a.sid, uuids(msg.uids), now)) await this.state.storage.put('calls', book.toJSON());
        return;
      }
      case 'call_stats': {
        const book = await this.callBook();
        const s = { ttc: msg.ttc as number | null, path: msg.path as CallStat['path'], fail: msg.fail as string | null, turn: msg.turn === true };
        if (!book.stat(id, a.uid, s, now)) return;
        await this.state.storage.put('calls', book.toJSON());
        const st = book.get(id)?.stats?.[a.uid];
        // One line per outcome for `wrangler tail` — no names, ids or addresses.
        console.log(JSON.stringify({ evt: 'call_stats', ttc: st?.ttc ?? null, path: st?.path ?? null, fail: st?.fail ?? null, turn: st?.turn ?? false }));
        return;
      }
      case 'call_decline': {
        const book = await this.callBook();
        const call = book.decline(id, a.uid, now);
        if (call) await this.commitCalls(book, [call]);
        return;
      }
      case 'call_leave': {
        const book = await this.callBook();
        const changed = book.leave(a.sid, now, id);
        if (changed.length) await this.commitCalls(book, changed);
        return;
      }
      case 'call_media': {
        const book = await this.callBook();
        const call = book.setMedia(id, a.sid, msg.mic !== false, msg.cam !== false);
        if (call) await this.commitCalls(book, [call]);
        return;
      }
      case 'call_invite': {
        const book = await this.callBook();
        const r = book.invite(id, a.sid, uuids(msg.to));
        if (!r || !r.added.length) return;
        await this.commitCalls(book, [r.call]);
        const meta = await this.meta();
        await this.callPush(r.added, { title: me.label || me.name, body: `Join the ${r.call.video ? 'video' : 'audio'} call · ${familyOf(meta)}`, kind: 'call', call: r.call.id }, Math.round(RING_MS / 1000), 'high');
        return;
      }
      case 'call_push': {
        const sub = msg.sub as PushSubscriptionJSONLike | undefined;
        if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) return;
        if (!isAllowedPushEndpoint(sub.endpoint) || sub.endpoint.length > 1024) return this.send(ws, { t: 'call_err', error: 'push' });
        const rec: CallPushRec = { sub: { endpoint: sub.endpoint, keys: { p256dh: clip(sub.keys.p256dh, 200), auth: clip(sub.keys.auth, 64) } }, uid: a.uid, at: now };
        const all = ((await this.state.storage.get<CallPushRec[]>('callPush')) ?? []).filter((r) => r.sub.endpoint !== rec.sub.endpoint);
        all.push(rec);
        await this.state.storage.put('callPush', all.slice(-CALL_PUSH_CAP));
        return;
      }
      case 'call_push_off': {
        const endpoint = String(msg.endpoint ?? '');
        const all = (await this.state.storage.get<CallPushRec[]>('callPush')) ?? [];
        // Only the owner of a subscription may remove it.
        await this.state.storage.put('callPush', all.filter((r) => !(r.sub.endpoint === endpoint && r.uid === a.uid)));
        return;
      }
    }
  }

  /** Ring (or tell of a missed call) the devices of these people that asked to be rung. */
  private async callPush(uids: string[], data: { title: string; body: string; kind: 'call' | 'call_missed'; call: string }, ttlSec: number, urgency: 'high' | 'normal'): Promise<void> {
    const keys = await this.vapidKeys();
    const all = (await this.state.storage.get<CallPushRec[]>('callPush')) ?? [];
    const who = new Set(uids);
    const recs = all.filter((r) => who.has(r.uid));
    if (!keys || !recs.length) return;
    const nid = await this.state.storage.get<string>('nid');
    const gone = new Set<string>();
    await Promise.all(
      recs.map(async (r) => {
        // Same topic: an undelivered ring is replaced by its "missed call".
        const out = await sendWebPush(r.sub, { ...data, nid, tag: `call-${data.call}`, at: Date.now() }, keys, { subject: VAPID_SUBJECT, urgency, ttlSec, topic: `call${data.call.slice(0, 12)}` });
        if (out === 'gone') gone.add(r.sub.endpoint);
      }),
    );
    if (gone.size) await this.state.storage.put('callPush', all.filter((r) => !gone.has(r.sub.endpoint)));
  }

  private async ensureAlarm(inMs: number): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + Math.max(1000, inMs);
    if (cur == null || cur > want) await this.state.storage.setAlarm(want);
  }

  async alarm(): Promise<void> {
    await this.ready;
    const now = Date.now();
    let again = false;

    // 1. Sockets that never authenticated are dropped.
    for (const { ws, a } of this.sockets()) {
      if (!a.authed) {
        if (now - a.at > AUTH_TIMEOUT_MS) {
          try {
            ws.close(4001, 'auth timeout');
          } catch { /* closed */ }
        } else again = true;
      }
    }

    // 2. Connected cameras that stopped heartbeating (phone locked, app frozen).
    const meta = await this.meta();
    for (const { a } of this.authed()) {
      if (a.mode !== 'camera' || !a.dev) continue;
      again = true;
      const beat = this.beats.get(a.dev);
      if (beat == null) {
        this.beats.set(a.dev, now); // evicted & rebuilt — start a fresh grace
        continue;
      }
      if (now - beat > BEAT_STALE_MS && !this.staleFlagged.has(a.dev)) {
        this.staleFlagged.add(a.dev);
        await this.state.storage.put(`alerted:${a.dev}`, true);
        const entry = await this.addLog({ kind: 'offline', msg: `${a.dn} stopped responding — check the camera phone`, dev: a.dev });
        await this.raiseHazard('offline', entry, { title: 'Baby camera not responding', body: `${meta.name} · ${a.dn} — the phone may be locked, asleep or off Wi-Fi`, entryId: entry.id }, a.dev);
      }
    }

    // 3. Cameras that dropped without saying goodbye.
    const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
    let changed = false;
    for (const [dev, p] of Object.entries(pending)) {
      const back = this.authed().some((s) => s.a.mode === 'camera' && s.a.dev === dev);
      if (back) {
        delete pending[dev];
        changed = true;
      } else if (now - p.at >= OFFLINE_GRACE_MS) {
        delete pending[dev];
        changed = true;
        await this.state.storage.put(`alerted:${dev}`, true);
        const entry = await this.addLog({ kind: 'offline', msg: `${p.dn} went offline`, dev });
        await this.raiseHazard('offline', entry, { title: 'Baby camera went offline', body: `${meta.name} · ${p.dn} disconnected — check its battery and Wi-Fi`, entryId: entry.id }, dev);
      } else again = true;
    }
    if (changed) await this.state.storage.put('pendingOffline', pending);

    // 4. Incidents nobody answered.
    await this.escalate(now);

    // 5. A sleep session whose camera went away for good.
    const sm = await this.state.storage.get<SleepSm>('sleepSm');
    if (sm?.session && sm.lastM != null && now - sm.lastM > 45 * 60_000) {
      const events = endSession(sm, sm.lastM + 60_000);
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }

    // 6. Retention.
    const purgedAt = (await this.state.storage.get<number>('purgedAt')) ?? 0;
    if (now - purgedAt > PURGE_EVERY_MS) {
      this.store.purge(now);
      this.guests.purge(now);
      this.tracker.purge(now);
      await this.state.storage.put('purgedAt', now);
    }

    // 7. Lines in a call that went silent; family calls nobody picked up (or that lost everyone).
    const callsUp = await this.dropStaleLines(now);
    const ringingUntil = await this.expireCalls(now);

    if (this.curBucket) await this.saveBucket(this.curBucket);
    // Next wake-up: cameras need heartbeat checks, incidents need escalation,
    // an open sleep session needs closing if its camera never comes back,
    // a ringing call needs its "no answer".
    let want: number | null = again ? now + ALARM_MS : null;
    if (ringingUntil != null) want = Math.min(want ?? Infinity, Math.max(now + 1000, ringingUntil + 500));
    if (callsUp) want = Math.min(want ?? Infinity, now + LINE_CHECK_MS);
    const nextInc = this.store.nextIncidentAt();
    if (nextInc != null) want = Math.min(want ?? Infinity, Math.max(now + 1000, nextInc));
    const open = await this.state.storage.get<SleepSm>('sleepSm');
    if (open?.session) want = Math.min(want ?? Infinity, now + 15 * 60_000);
    if (want != null) await this.state.storage.setAlarm(want);
  }
}

function toLog(e: StoredEvent): MonLog {
  const out: MonLog = { id: e.id, at: e.at, kind: e.kind, sev: e.sev, msg: e.msg };
  if (e.by) out.by = e.by;
  if (e.dev) out.dev = e.dev;
  if (e.secs != null) out.secs = e.secs;
  if (e.conf != null) out.conf = e.conf;
  if (e.db != null) out.db = e.db;
  if (e.incident) out.incident = e.incident;
  return out;
}

/** Aggregate minutes into chart buckets (energy-average for dB, max for peaks). */
export function historyBuckets(rows: MinuteRow[], from: number, to: number, bucketMs?: number): {
  res: number;
  pts: { t: number; laeq: number | null; lmax: number | null; l90: number | null; motion: number | null; crib: number | null; light: number | null; state: number | null; cal: number; visit: number; sounds: Record<string, number> }[];
} {
  const span = to - from;
  const res = bucketMs ?? (span <= 3 * 60 * 60_000 ? 60_000 : span <= 12 * 60 * 60_000 ? 5 * 60_000 : span <= 3 * 24 * 60 * 60_000 ? 15 * 60_000 : 60 * 60_000);
  const by = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    const t = Math.floor(r.m / res) * res;
    const list = by.get(t);
    if (list) list.push(r);
    else by.set(t, [r]);
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const pts = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, rs]) => {
    const laeqs = rs.map((r) => r.laeq).filter((v): v is number => v != null);
    const lmaxs = rs.map((r) => r.lmax).filter((v): v is number => v != null);
    const sounds: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.sounds)) sounds[k] = (sounds[k] ?? 0) + v;
    return {
      t,
      laeq: laeqs.length ? Math.round(10 * Math.log10(laeqs.reduce((a, d) => a + 10 ** (d / 10), 0) / laeqs.length) * 10) / 10 : null,
      lmax: lmaxs.length ? Math.max(...lmaxs) : null,
      l90: avg(rs.map((r) => r.l90).filter((v): v is number => v != null)),
      motion: avg(rs.map((r) => r.motion).filter((v): v is number => v != null)),
      crib: avg(rs.map((r) => r.crib).filter((v): v is number => v != null)),
      light: avg(rs.map((r) => r.light).filter((v): v is number => v != null)),
      state: rs.reduce<number | null>((a, r) => (r.state == null ? a : Math.max(a ?? 0, r.state)), null),
      cal: rs.some((r) => r.cal) ? 1 : 0,
      visit: rs.some((r) => r.visit) ? 1 : 0,
      sounds,
    };
  });
  return { res, pts };
}
