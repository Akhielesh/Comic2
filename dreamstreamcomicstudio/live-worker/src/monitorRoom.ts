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

import { iceFields, iceFor, revokeIce, STUN, type IceGrant, type TurnBill } from './ice';
import { audioOnly, bareJpeg, KIND_AUDIO, KIND_JPEG, KIND_VIDEO, KIND_VIDEO_AUDIO, readHead, seqDiff, type RelayHead } from './relayWire';
import { CallBook, LOG_CAP as CALL_LOG_CAP, missedBy, RING_MS, toRecord, type Call, type CallRecord, type CallStat } from './familyCalls';
import { GuestAccess, LOCK_MS, passcodeProblem, removalNotice, type GuestRole } from './monitorGuests';
import { sanitizeTrack, TrackerStore, type TrackRow } from './trackerStore';
import { clockTime, isValidTz, localIso, localParts, MonitorStore, packMinute, timelineOf, unpackMinute, type IncidentRow, type MinuteRow, type Severity, type SleepRow, type StoredEvent } from './monitorStore';
import { MONITOR_TURN_BPS, netTag, relayDataState, type FairState } from './monitorFair';
import { endSession, manualSleep, manualWake, newSleepSm, sessionKind, stepSleep, type SleepEvent, type SleepSm, type SleepStats } from './sleepTracker';
import { bearerFrom, callRpc, verifyMember, type LiveIdentity, type SupabaseEnv } from './supabaseAuth';
import { callUsage, carriersOf, clampClientReport, relayClock, UsageMeter, type SocketUsage, type UsageSink } from './usageMeter';
import { compactUsage, FAIR_USE, isEmptyUsage, monthKey, type UsageMonth } from '../../shared/stream/usage';
import { userLineName } from './directCalls';
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
  /** Workers Analytics Engine (optional): Stream Studio usage points (usageMeter.ts). */
  STREAM_USAGE?: UsageSink;
  /** Members' call lines: a family call's usage counts against the caller's account. */
  USER_LINE?: DurableObjectNamespace;
}

/** Parents' read of the nursery's month (`{t:'q', q:'usage', id}`; Phase B's Usage card). Others get `error: 'forbidden'`. */
export type NurseryUsageReply =
  | { t: 'r'; id: string; q: 'usage'; usage: UsageMonth; allowances: { relayDataGb: number; serverPictureHoursPerDay: number } }
  | { t: 'r'; id: string; q: 'usage'; error: 'forbidden' };

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
  /** Usage this socket carries (survives hibernation; usageMeter.ts) and its relay clock. */
  u?: SocketUsage;
  /** Viewer: "picture through our server" clock start (ms) — runs only while its camera's frames can flow. */
  rs?: number;
  /** Camera: the UTC day this nursery's daily activity mark was last written (so a wake doesn't repeat it). */
  am?: string;
  // ---- Kept on the socket, not in memory: the room hibernates between most messages (ADR 0006 WS-9).
  /** Camera: when it last sent anything (ms) — with its keepalive pings, the watchdog's proof of life. */
  lb?: number;
  /** Camera: reported as not responding (the alert went out; cleared — "back online" — when it speaks again). */
  sf?: boolean;
  /** Camera: paused for privacy — none of its relay messages go anywhere. */
  pv?: boolean;
  /** Camera: its minute rows not written yet, packed — the phone keeps them too, until `stats_ok`. */
  mp?: [number, ReturnType<typeof packMinute>][];
  /** Camera: the newest minute already pushed to viewers (a batch sent again isn't pushed twice). */
  bm?: number;
  /** Camera: the `live_want` it was last told. */
  lw?: boolean;
  /** Monitor sockets: the relay-data level this socket was last told (`fair`; absent = 'ok'). */
  fl?: FairState['level'];
  /** Viewer: its screen is shown (`view`). false = hidden: after the grace, sound only. Absent = an app that never says. */
  vis?: boolean;
  /** Viewer: hidden since (ms) — the picture goes HIDDEN_GRACE_MS later. */
  hz?: number;
  /** Viewer: a camera's data channel is delivering its status to it (`view`), so it needs no live status from here… */
  dc?: boolean;
  /** …from this camera (device id; absent = any camera). */
  dcd?: string;
  /** Viewer: an instant-picture subscription held back (the camera's device id) — it's on the camera's network. */
  rn?: string;
  /** Which network the socket came from: a hash of its public network (an IPv4 address, an IPv6 /64), never the address. */
  nt?: string;
  /** Camera: said goodbye (stopped on purpose) at this time — its socket closing next is expected. */
  bye?: number;
  /**
   * Closed by the room at this time (ms): signed out, counted nowhere, heard no more. The runtime
   * can keep listing a socket the room closed for minutes (a phone that's gone never answers the
   * close), so a closed socket must never still count — as a camera, a line, or a sign-in due.
   */
  cl?: number;
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
/**
 * A camera that hasn't sent anything — not a status, not a minute, not even its 25 s keepalive
 * ping (answered by the runtime, read back with getWebSocketAutoResponseTimestamp) — for this
 * long is "not responding" (phone locked, app frozen, off Wi-Fi): parents are alerted.
 * (A camera whose socket CLOSES is caught at once: webSocketClose + OFFLINE_GRACE_MS.)
 */
export const BEAT_STALE_MS = 75_000;
/**
 * The watchdog is a dead man's switch (ADR 0006 WS-9). Its alarm sits WATCH_MS after the
 * camera's last proof of life, and the camera's own messages push it later — only once it is
 * within WATCH_PUSH_MS, so a healthy camera costs a row (setAlarm) every minute or so and no
 * alarm wake at all. It used to be an alarm every 15 s, each rewriting a 7-day blob: ≈ 5,760
 * rows and 2,880 billed wakes a night. When it does go off, the alarm reads the real proof of
 * life (the camera's last message, or its last keepalive ping): stale for BEAT_STALE_MS →
 * "not responding"; otherwise it sets itself again. So a camera that dies is reported 75–105 s
 * later (it was 45–60 s); the viewers' own screens notice a frozen picture in 6 s.
 */
export const WATCH_MS = 105_000;
export const WATCH_PUSH_MS = 30_000;
/** A camera that missed a keepalive ping (every 25 s) when the watchdog looks: next look at exactly stale. */
const WATCH_SUSPECT_MS = 30_000;
/** Camera messages look at the watchdog's alarm at most this often (memory: a wake looks again). */
const WATCH_CHECK_MS = 10_000;
const OFFLINE_GRACE_MS = 20_000;
/**
 * Minute rows are written in batches (ADR 0006 WS-9): once BATCH_ROWS are waiting, or the oldest
 * has waited BATCH_WAIT_MS — and at once when a batch would change the sleep tracker (asleep,
 * woke, a report), when the camera stops or its socket closes, when it is reported not
 * responding, when an alert is raised, or when it sends a backlog. Until then they ride the
 * camera socket's attachment (which survives hibernation; every read includes them) and the
 * phone keeps them too, until the room says `stats_ok`. A batch is one row written per
 * camera-hour (monitorStore.ts), not three per minute.
 */
const BATCH_ROWS = 5;
const BATCH_WAIT_MS = 6 * 60_000;
/** Waiting minutes never make an attachment bigger than this (the runtime's limit is 2 KiB in all). */
const PENDING_MAX_CHARS = 900;
const LOG_HELLO = 150;
/**
 * What this room can do, for clients that adapt (ADR 0006 Phase 0 contract: `hello.caps`):
 * `view` — viewers say when their screen is hidden (`{t:'view', vis, dc, dev?}`), and the room
 * sends a camera `live_want` (full-rate status only while someone needs it from the room).
 */
const CAPS = ['view'] as const;
/**
 * A viewer whose screen is hidden this long gets the relay's SOUND only — no picture to a
 * screen nobody sees (feature doc §7 C5). Same value as live/monitor/viewGate.ts (a test checks).
 */
export const HIDDEN_GRACE_MS = 20_000;
/** One-off storage moves done (migrate()). */
const SCHEMA_VERSION = 2;
const MAX_SOCKETS = 14;
/** Family members' apps listening for calls (separate from the monitor's devices). */
const MAX_LINES = 24;
const CALL_PUSH_CAP = 40;
/**
 * While a call is up, a line in it that hasn't pinged or said anything for this long is dropped
 * (half-open socket). The alarm is set for the moment each line would be this stale — a fixed
 * time, so a chatty camera's re-plans can't keep moving it later (dropStaleLines).
 */
const LINE_STALE_MS = 60_000;
/** An answered ("I'm on it") incident still counts this long after the answer. */
const ACKED_STALE_MS = 30 * 60_000;
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
/** A sleep session whose camera stopped sending minutes this long ago is closed where the data stopped. */
const SLEEP_GONE_MS = 45 * 60_000;
const MACHINE_DB = 50;
const MACHINE_GAP_MS = 12 * 60 * 60_000;
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
 * What a viewer that gets SOUND ONLY (its screen hidden past the grace, or the nursery's relay
 * data used up) gets of a relay message: the sound out of a video + sound message, a sound-only
 * message as it is — never a picture. Viewers from before the framed format (bare JPEGs, no
 * sound path) never say they're hidden, so they never get here.
 */
export function relaySound(head: RelayHead, raw: ArrayBuffer, rc: number | undefined): ArrayBuffer | null {
  if (rc == null) return null;
  if (head.kind === KIND_VIDEO_AUDIO) return audioOnly(raw);
  return head.kind === KIND_AUDIO ? raw : null;
}

/** This viewer's relay is sound only now: hidden for the grace, or the nursery's relay data is used up. */
export function relaySoundOnly(a: { vis?: boolean; hz?: number; fl?: string }, now: number): boolean {
  return (a.vis === false && a.hz != null && now - a.hz >= HIDDEN_GRACE_MS) || a.fl === 'out';
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
  // Memory is best-effort: the room hibernates between most messages and wakes with none of it.
  // What matters lives in storage (history, incidents, sleep, settings) or on the sockets'
  // attachments (a camera's proof of life, privacy pause, unwritten minutes; a viewer's screen
  // state) — never only here. What's here is a cache or a pace limiter that a wake rebuilds.
  /** The camera's last status, for presence (a new viewer makes the camera send a fresh one at once). */
  private lastStatus = new Map<string, { st: CamStatus; at: number }>();
  private relayBuckets = new Map<string, FrameBucket>();
  /** Per camera: the video codec it last sent (and when), and its key-frame requests. */
  private relayCams = new Map<string, { codec: number; at: number; keyAt: number; keyPending: boolean }>();
  /** Per viewer socket: its relay window. */
  private relayRx = new Map<string, RelayRx>();
  /** The UTC day the activity mark was written (memory; the camera's attachment `am` is the durable copy). */
  private activeDay: string | null = null;
  private lastStatusAt = new Map<string, number>();
  private lastSoundAt = new Map<string, number>();
  /** When a camera message last looked at the watchdog's alarm (pace only). */
  private watchCheckedAt = 0;
  /** The nursery's relay data this month (cache; every socket's attachment `fl` holds what it was told). */
  private fair: FairState | null = null;
  /** Per camera: the relay_want it was last sent (outgoing messages are free; this only skips repeats). */
  private relayWantSent = new Map<string, string>();
  /** Per camera: when relay frames last re-checked who gets the picture (a hidden viewer's grace ends without a message). */
  private relayWantAt = new Map<string, number>();
  /** The attachment each socket's running handler holds (see sockets()). */
  private live = new Map<WebSocket, Attach>();
  private vapid: VapidKeys | null = null;
  /** Call lines: when each last sent anything (pings are answered by the runtime — see the constructor). */
  private lineSeen = new Map<string, number>();
  readonly store: MonitorStore;
  readonly guests: GuestAccess;
  readonly tracker: TrackerStore;
  readonly ready: Promise<void>;
  /** Stream Studio usage (relay frames and minutes): memory + attachments, ≤ 1 row an hour. */
  readonly usage: UsageMeter;

  constructor(private state: DurableObjectState, private env: MonEnv) {
    this.store = new MonitorStore(state.storage.sql);
    this.guests = new GuestAccess(state.storage.sql);
    this.tracker = new TrackerStore(state.storage.sql);
    this.usage = new UsageMeter({ storage: state.storage, sink: env.STREAM_USAGE, scope: 'nursery' });
    this.ready = state.blockConcurrencyWhile(() => this.migrate());
    // Keepalive pings are answered by the runtime without waking the room: a ping carries no
    // state here (presence is the socket list, guests' last seen is set at sign-in), so this
    // saves wake-ups — and a pong comes back even while the room is busy.
    // getWebSocketAutoResponseTimestamp then says when a socket last pinged: for a camera, that
    // is half of the watchdog's proof of life (the other half: its last message, `lb`).
    try {
      state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch { /* older runtime: the ping handlers below answer */ }
  }

  /**
   * Create the tables (and turn the per-minute table into hour blocks, once — monitorStore.ts).
   * One-off moves run once per nursery, behind a schema number, not on every wake: the
   * pre-database log (a KV array) into the tables, and the old 7-day timeline blob deleted
   * (the timeline is computed from the minutes now).
   */
  private async migrate(): Promise<void> {
    this.store.init();
    if (((await this.state.storage.get<number>('schema')) ?? 0) >= SCHEMA_VERSION) return;
    const old = await this.state.storage.get<{ id: string; at: number; kind: string; msg: string; by?: string; dev?: string; secs?: number; conf?: number }[]>('log');
    if (old?.length) {
      for (const e of old) {
        this.store.addEvent({ id: e.id, at: e.at, kind: e.kind, sev: this.sevOf(e.kind), msg: e.msg, by: e.by ?? null, dev: e.dev ?? null, secs: e.secs ?? null, conf: e.conf ?? null });
      }
    }
    if (old) await this.state.storage.delete('log');
    if ((await this.state.storage.get('tl')) !== undefined) await this.state.storage.delete('tl');
    await this.state.storage.put('schema', SCHEMA_VERSION);
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

  /**
   * STUN + a Cloudflare TURN credential of this nursery's own for this socket's person
   * (./ice): members ≤ 4 h, guests ≤ 2 h and never past their pass — none once it's over.
   * Monitor relay bytes count against the nursery; a call's against its caller (`bill`).
   */
  private async ice(a: Attach, bill?: TurnBill): Promise<IceGrant> {
    const nid = (await this.state.storage.get<string>('nid')) || '';
    let until: number | undefined;
    if (a.guest) {
      const pass = this.guests.guests(Date.now()).find((g) => g.id === a.guest);
      if (!pass) return { servers: STUN, iceMs: null };
      until = pass.expires_at;
    }
    return iceFor(this.env, { room: `n:${nid}`, who: a.uid || a.sid, bill: bill ?? { scope: 'nursery', id: nid }, guest: !!a.guest, until });
  }

  /** Revoke the relay credentials of the people `match` picks (a removed guest or member): best effort. */
  private revokeTurn(match: (who: string) => boolean): void {
    void (async () => {
      const nid = (await this.state.storage.get<string>('nid')) || '';
      await revokeIce(this.env, `n:${nid}`, match).catch(() => 0);
    })();
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
    // The minutes still waiting on a camera's socket go into the file too (written now).
    if (kind === 'minutes') for (const s of this.authed()) if (s.a.mode === 'camera' && s.a.dev && s.a.mp?.length) await this.commitMinutes(s.ws, s.a, now);
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
    // Same network as the camera? (monitorFair.ts) A hash in this socket's attachment, gone with
    // the socket — the address itself is never kept, logged, stored or sent. Worked out before
    // the socket is accepted: its first message (the sign-in) must find the attachment there.
    const nt = await netTag(nid, req.headers.get('cf-connecting-ip')).catch(() => null);
    this.state.acceptWebSocket(server);
    const a: Attach = { sid: crypto.randomUUID().slice(0, 10), at: Date.now(), authed: false };
    if (nt) a.nt = nt;
    server.serializeAttachment(a);
    // A socket that never signs in is dropped by the next alarm (within the watchdog's, when one is set).
    await this.ensureAlarm(AUTH_TIMEOUT_MS, WATCH_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ------------------------------------------------------------- sockets
  /**
   * Every socket with its attachment. A socket whose message (or close) is being handled right now
   * comes with the very object its handler holds (`live`), so a helper that updates attachments
   * never saves a stale copy of it — and the handler's own save never undoes the helper's.
   */
  private sockets(): { ws: WebSocket; a: Attach }[] {
    const out: { ws: WebSocket; a: Attach }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const a = this.live.get(ws) ?? (ws.deserializeAttachment() as Attach | null);
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
    for (const { ws, a } of this.authed()) {
      if (a.mode === 'camera' && a.dev) {
        const ls = this.lastStatus.get(a.dev);
        // The camera sends its status when something material changes, so its last status still
        // holds while it's alive: say when it was last confirmed (a message or a keepalive), so a
        // viewer arriving between changes doesn't see a live camera as gone quiet.
        const at = ls ? (a.sf ? ls.at : Math.max(ls.at, this.seenAt(ws, a))) : null;
        cams.push({ sid: a.sid, dev: a.dev, dn: a.dn || 'Camera', by: a.name || 'Member', since: a.at, status: ls?.st ?? null, statusAt: at });
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
    // Binary = a relay message (video, sound or JPEG) from an authenticated camera: the hot path.
    if (typeof raw !== 'string') {
      const a = ws.deserializeAttachment() as Attach | null;
      return a ? this.onRelayFrame(a, raw) : undefined;
    }
    const a = ws.deserializeAttachment() as Attach | null;
    if (!a) return;
    this.live.set(ws, a);
    try {
      await this.onText(ws, a, raw);
    } finally {
      if (this.live.get(ws) === a) this.live.delete(ws);
    }
  }

  private async onText(ws: WebSocket, a: Attach, raw: string): Promise<void> {
    if (raw.length > RTC_FRAME_MAX) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const big = msg.t === 'rtc' || msg.t === 'call_rtc' || msg.t === 'auth' || msg.t === 'push_sub' || msg.t === 'call_push' || msg.t === 'stats' || msg.t === 'settings';
    if (!big && raw.length > FRAME_MAX) return;
    // A socket the room closed (replaced, timed out, refused) is heard no more — not even a new sign-in.
    if (a.cl) return;

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
    // Anything from a camera proves it's alive (kept on its socket: a wake can't forget it),
    // and keeps the watchdog's alarm from going off for nothing.
    if (a.mode === 'camera' && a.dev) await this.cameraSpoke(ws, a, Date.now());

    switch (msg.t) {
      case 'rtc':
        return this.onRtc(a, msg);
      case 'status':
        return this.onStatus(ws, a, msg);
      case 'beat':
        return; // proof of life only (cameraSpoke)
      case 'view':
        return this.onView(ws, a, msg);
      case 'event':
        return this.onCamEvent(ws, a, msg);
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
        return msg.q === 'usage' ? this.onUsageQuery(ws, a, msg) : this.onQuery(ws, msg);
      case 'use': {
        if (a.mode !== 'viewer') return;
        const now = Date.now();
        const use = clampClientReport(msg, now - a.at);
        // A monitor viewer can't receive more through TURN than its picture and sound: one viewer
        // can't use up the whole nursery's relay data by saying so (monitorFair.ts).
        use.turnBytes = Math.min(use.turnBytes ?? 0, ((Math.max(0, now - a.at) / 1000 + 60) * MONITOR_TURN_BPS) / 8);
        this.usage.report(a, 'monitor', use);
        ws.serializeAttachment(a);
        // Relay data may have crossed the nursery's allowance (or a new month began).
        return this.checkFair(now);
      }
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
          // Stopped on purpose: its socket closing next is no "went offline" (kept on the socket, not written).
          a.bye = Date.now();
          ws.serializeAttachment(a);
          // Monitoring is over: the night's last minutes are written now, not left waiting for a batch.
          await this.commitMinutes(ws, a, Date.now());
          await this.addLog({ kind: 'camera', msg: `${a.dn || 'Camera'} was stopped by ${a.name}`, by: a.name, dev: a.dev });
        }
        return;
      case 'ping':
        return this.send(ws, { t: 'pong', at: Date.now() });
      case 'ice': {
        // Relay credentials are due (the hello said when): fresh ones for this camera or viewer.
        const g = await this.ice(a);
        return this.send(ws, { t: 'ice', servers: g.servers, ...(g.iceMs != null ? { iceMs: g.iceMs } : {}) });
      }
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
    // Finish the closing handshake.
    return this.retire(ws, a, 1000, 'bye');
  }

  /**
   * The room is done with this socket: out of every count at once (signed out, `cl`) — presence,
   * relay viewers, the camera cap, the watchdog — its goodbye handled (a camera's waiting minutes
   * written, the usage it carried handed on, "went offline" unless the device is still here),
   * then closed. The runtime can keep listing a socket the room closed for minutes when its phone
   * is gone (it never answers the close): such a leftover must never raise a false "not
   * responding", hide a real one, or take a camera's place.
   */
  private async retire(ws: WebSocket, a: Attach, code: number, reason: string): Promise<void> {
    const closing: Attach = { ...a, authed: false, cl: Date.now() };
    try {
      ws.serializeAttachment(closing);
      ws.close(code, reason);
    } catch { /* already closed */ }
    if (!a.authed) return;
    if (a.mode === 'line') {
      this.lineSeen.delete(a.sid);
      return this.onLineGone(a);
    }
    if (a.mode === 'admin') return; // never in presence
    this.live.set(ws, closing);
    try {
      await this.onClosed(ws, a);
    } finally {
      if (this.live.get(ws) === closing) this.live.delete(ws);
    }
  }

  private async onClosed(ws: WebSocket, a: Attach): Promise<void> {
    const now = Date.now();
    // A camera's waiting minutes are written now: the phone may never come back to send them again.
    if (a.mode === 'camera' && a.mp?.length) await this.commitMinutes(ws, a, now, undefined, true);
    // What this socket carried (relay minutes, stashed frames) goes back to memory; written below or parked.
    relayClock(this.usage, a, 'monitor', false, now);
    this.usage.release(a);
    if (a.mode === 'camera' && a.dev) {
      const stillThere = this.authed().some((s) => s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev);
      if (!stillThere) {
        // Stopped on purpose (bye), or already reported not responding: nothing more to say.
        const expected = (a.bye != null && now - a.bye < 30_000) || !!a.sf;
        if (!expected) {
          // Unexpected drop: alert unless it comes back within the grace window.
          const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
          pending[a.dev] = { at: now, dn: a.dn || 'Camera' };
          await this.state.storage.put('pendingOffline', pending);
          await this.ensureAlarm(OFFLINE_GRACE_MS);
        }
        this.lastStatus.delete(a.dev);
        this.relayWantSent.delete(a.dev);
        // Viewers stay subscribed while the camera is away (linkFallback.ts), but nothing flows: stop their clocks.
        this.syncRelayClocks(a.dev, now, ws);
      }
      // Viewers relaying this camera no longer need to; tell the camera's peers.
      this.broadcast({ t: 'cam_gone', sid: a.sid, dev: a.dev });
      this.sendNear();
    }
    if (a.mode === 'viewer') {
      this.broadcast({ t: 'peer_gone', sid: a.sid }, (x) => x.mode === 'camera');
      this.relayRx.delete(a.sid);
      if (a.relay) this.updateRelayWant(a.relay);
    }
    // A viewer that needed live status may have been the last one.
    this.updateLiveWant();
    this.syncPresence();
    // The last camera left: write the night's usage now if the hour allows, else keep it on a socket that stays.
    if (a.mode === 'camera' && !this.authed().some((s) => s.ws !== ws && s.a.mode === 'camera')) await this.meterTick(now, ws);
    else this.parkUsage(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ready;
    const a = ws.deserializeAttachment() as Attach | null;
    // Closed here, so retired here: a camera whose socket errored is handled like one that
    // dropped (back within the grace, or "went offline"), not left counting as connected.
    if (a && !a.cl) return this.retire(ws, a, 1011, 'error');
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
    // Written only when it changed (every connect used to write it: a row each time).
    const known = await this.state.storage.get<{ name: string; baby: string | null }>('meta');
    if (known?.name !== meta.name || known?.baby !== meta.baby) await this.state.storage.put('meta', meta);
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

    // A device re-joining as the same camera replaces its stale socket — retired now, not when the
    // runtime finally drops it: a phone that changed networks leaves its old connection half-open
    // for minutes, and that leftover must not go "not responding" (a false alarm that would hide
    // a real one), count against the camera cap, or show twice in presence. Its waiting minutes
    // are written; the device is still here, so it is no "went offline".
    if (mode === 'camera') {
      for (const s of this.authed()) {
        if (s.ws !== ws && s.a.mode === 'camera' && s.a.dev === a.dev) await this.retire(s.ws, s.a, 4005, 'replaced');
      }
    }

    // The camera phone knows the nursery's time zone (reports, night vs nap).
    let settings = await this.settings();
    if (mode === 'camera' && isValidTz(msg.tz) && msg.tz !== settings.tz) {
      settings = { ...settings, tz: msg.tz };
      await this.state.storage.put('settings', settings);
    }

    const now = Date.now();
    const [ice, vapid, duty, sleep, fair] = await Promise.all([this.ice(a), this.vapidKeys(), this.duty(), this.sleepStatus(), this.fairNow(now)]);
    a.fl = fair.level;
    if (mode === 'camera') a.lb = now; // its first proof of life
    ws.serializeAttachment(a);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode, dev: a.dev, ...(a.guest ? { guest: true, until } : {}) },
      nursery: { id: nid, ...meta },
      ...this.presence(),
      log: this.store.events({ limit: LOG_HELLO }).reverse().map(toLog),
      tl: this.timeline(now),
      settings,
      incidents: this.store.activeIncidents(),
      track: { running: this.tracker.running(), latest: this.tracker.latest() },
      duty,
      sleep,
      ...iceFields(ice),
      vapid: vapid?.publicKey ?? null,
      caps: CAPS,
      // The nursery's relay data this month (its level decides where the picture may go).
      fair,
      // Cameras on this viewer's network: their direct picture over the home Wi-Fi comes first.
      ...(mode === 'viewer' ? { near: this.nearCams(a) } : {}),
    });
    if (a.role === 'parent') this.send(ws, { t: 'share', share: this.guests.info(now) });

    if (mode === 'camera') {
      // A camera that (re)joins picks up viewers already waiting on its relay;
      // its messages start a new count, so every one of them starts on a key frame.
      this.relayCams.delete(a.dev);
      this.relayWantSent.delete(a.dev);
      for (const s of this.authed()) if (s.a.mode === 'viewer' && s.a.relay === a.dev) this.relayRx.set(s.a.sid, freshRx());
      this.syncRelayClocks(a.dev, now); // viewers still subscribed get frames again
      this.updateRelayWant(a.dev);
      // Viewers on this camera's network learn it (a yes/no, never an address).
      this.sendNear();
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
      // The watchdog: a dead man's switch its messages and keepalives keep pushing back.
      await this.ensureAlarm(WATCH_MS);
      await this.markActive(now);
      // Its hello put it back to full rate, whatever a retired socket's goodbye told it before: say it again.
      delete a.lw;
    }
    // Whether each camera must send its status at full rate (a camera starts at full rate and is told at once).
    this.updateLiveWant();
    this.syncPresence();
  }

  /** Cameras on this socket's network (devices): compared by hash, in memory, never stored. */
  private nearCams(a: Attach): string[] {
    if (!a.nt) return [];
    return this.authed().flatMap(({ a: c }) => (c.mode === 'camera' && c.dev && c.nt === a.nt ? [c.dev] : []));
  }

  /** Tell every viewer which cameras are on its network (a camera came or went). Outgoing messages are free. */
  private sendNear(): void {
    for (const { ws, a } of this.authed()) if (a.mode === 'viewer' && a.nt) this.send(ws, { t: 'near', near: this.nearCams(a) });
  }

  private reject(ws: WebSocket, code: string, msg: string): void {
    this.send(ws, { t: 'error', code, msg });
    // A sign-in refused: closed, and never again a sign-in due (an alarm) while the runtime lists it.
    // (A signed-in socket refused a new role closes the usual way: its goodbye comes with the close.)
    const a = this.live.get(ws) ?? (ws.deserializeAttachment() as Attach | null);
    if (a && !a.authed && !a.cl) {
      a.cl = Date.now();
      try {
        ws.serializeAttachment(a);
      } catch { /* closed */ }
    }
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

  // -------------------------------------------------------- camera liveness
  /** A camera's last proof of life: its last message, or its last keepalive ping (answered by the runtime). */
  private seenAt(ws: WebSocket, a: Attach): number {
    let pinged = 0;
    try {
      pinged = this.state.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
    } catch { /* not supported: messages only */ }
    return Math.max(a.lb ?? a.at, pinged);
  }

  /**
   * Anything a camera sends proves it's alive. Kept on its socket (`lb`), so neither a wake nor
   * hibernation forgets it; a camera reported "not responding" that speaks again is back online.
   */
  private async cameraSpoke(ws: WebSocket, a: Attach, now: number): Promise<void> {
    const wasStale = !!a.sf;
    a.lb = now;
    delete a.sf;
    ws.serializeAttachment(a);
    if (wasStale && a.dev) await this.cameraBack(a.dev, a.dn);
    await this.keepWatch(now);
  }

  /** A camera reported not responding is alive after all: its alert ends ("responding again"). */
  private async cameraBack(dev: string, dn: string | undefined): Promise<void> {
    await this.state.storage.delete(`alerted:${dev}`);
    await this.addLog({ kind: 'online', msg: `${dn || 'Camera'} is responding again`, dev });
    await this.resolveHazard('offline', dev, 'responding again');
  }

  /**
   * The watchdog's alarm is close (or not set): plan the next one from the proof of life just
   * received. At most one look every WATCH_CHECK_MS; nothing written unless the alarm moves.
   */
  private async keepWatch(now: number): Promise<void> {
    if (now - this.watchCheckedAt < WATCH_CHECK_MS) return;
    this.watchCheckedAt = now;
    const cur = await this.state.storage.getAlarm();
    // Far enough away, or due now (it runs and plans the next itself).
    if (cur != null && (cur - now > WATCH_PUSH_MS || cur <= now)) return;
    await this.planAlarm(now, cur);
  }

  /**
   * When the room next needs to wake, from what is really pending: sign-ins that may time out, the
   * cameras' watchdog, cameras that dropped without a goodbye, incidents to escalate or that go
   * stale, a sleep session whose camera went away, family calls ringing or up. Null = nothing (it
   * sleeps). Every time here is a fixed moment, never "so long from now": a camera's messages
   * re-plan the alarm every 10 s or so, and a relative time would be moved later each time and
   * never come.
   */
  private async nextAlarmAt(now: number): Promise<number | null> {
    let at = Infinity;
    const want = (t: number | null | undefined) => {
      if (t != null && Number.isFinite(t)) at = Math.min(at, Math.max(now + 1000, t));
    };
    for (const { ws, a } of this.sockets()) {
      // A sign-in still due (a socket the room already closed is due nothing).
      if (!a.authed) {
        if (!a.cl) want(a.at + AUTH_TIMEOUT_MS);
      } else if (a.mode === 'camera' && a.dev && !a.sf) {
        const seen = this.seenAt(ws, a);
        // Missed a keepalive already: look again exactly when it would count as not responding.
        want(seen + (now - seen >= WATCH_SUSPECT_MS ? BEAT_STALE_MS : WATCH_MS));
      }
    }
    const pending = (await this.state.storage.get<Record<string, { at: number; dn: string }>>('pendingOffline')) ?? {};
    for (const p of Object.values(pending)) want(p.at + OFFLINE_GRACE_MS);
    want(this.store.nextIncidentAt());
    // An incident nobody resolved is tidied when it goes stale (escalate()), so a stuck one can't
    // linger on everyone's screen or soak up the next real alert of its kind.
    for (const inc of this.store.activeIncidents()) want(incidentStaleAt(inc) + 1);
    const sm = await this.state.storage.get<SleepSm>('sleepSm');
    if (sm?.session && sm.lastM != null) want(sm.lastM + SLEEP_GONE_MS + 60_000);
    const book = await this.callBook();
    want(book.nextDeadline() == null ? null : book.nextDeadline()! + 500);
    // Each line in a call that's up: looked at when it would count as gone silent (dropStaleLines).
    const inCall = callingSids(book);
    if (inCall.size) {
      for (const { ws, a } of this.authed()) if (a.mode === 'line' && inCall.has(a.sid)) want(this.lineSeenAt(ws, a) + LINE_STALE_MS);
    }
    return at === Infinity ? null : at;
  }

  /** Set the alarm to the next thing due (`cur`: what it is now, when the caller already read it). */
  private async planAlarm(now: number, cur?: number | null): Promise<void> {
    const next = await this.nextAlarmAt(now);
    const was = cur === undefined ? await this.state.storage.getAlarm() : cur;
    if (next == null) {
      if (was != null) await this.state.storage.deleteAlarm?.();
      return;
    }
    if (was !== next) await this.state.storage.setAlarm(next);
  }

  // ----------------------------------------------------------- status
  /**
   * The camera's status. Current camera apps send it when something material changes, plus a
   * keepalive every 2 minutes — and every 2 s while the room asks (`live_want`: someone is watching
   * without the camera's own data channel). Older apps send it every 2 s; both work.
   */
  private onStatus(ws: WebSocket, a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'camera' || !a.dev) return;
    const now = Date.now();
    // Privacy pause holds back every relay message from this camera (even a throttled status says so).
    const priv = (msg.st as Record<string, unknown> | undefined)?.paused === 'privacy';
    if (priv !== !!a.pv) {
      if (priv) a.pv = true;
      else delete a.pv;
      ws.serializeAttachment(a);
      // Nothing is relayed while paused: its viewers' "through our server" clocks stop, and restart on resume.
      this.syncRelayClocks(a.dev, now);
    }
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
    // Nothing is written: the history is the camera's minute rows, the timeline is built from them.
    this.broadcast({ t: 'status', dev: a.dev, sid: a.sid, st, at: now }, (x) => x.mode === 'viewer');
  }

  /**
   * A viewer's screen (`{t:'view', vis, dc, dev?}`, sent on change): shown or hidden, and
   * whether a camera's data channel is delivering its status (`dev`: which camera; absent: any).
   * Hidden past HIDDEN_GRACE_MS, its relay is sound only; shown again, its picture starts over
   * on a key frame. It decides whether the camera must send live status (`live_want`).
   */
  private onView(ws: WebSocket, a: Attach, msg: Record<string, unknown>): void {
    if (a.mode !== 'viewer') return;
    const now = Date.now();
    const vis = msg.vis !== false;
    const wasVis = a.vis !== false;
    const wasSound = relaySoundOnly(a, now);
    a.vis = vis;
    if (vis) delete a.hz;
    else if (wasVis || a.hz == null) a.hz = now;
    if (msg.dc === true) a.dc = true;
    else delete a.dc;
    const dcd = msg.dc === true ? clip(msg.dev, 40) : '';
    if (dcd) a.dcd = dcd;
    else delete a.dcd;
    ws.serializeAttachment(a);
    if (a.relay) {
      // Its "through our server" picture clock runs only while it can see the picture.
      relayClock(this.usage, a, 'monitor', this.clockOn(a, now), now);
      ws.serializeAttachment(a);
      if (wasSound && !relaySoundOnly(a, now)) {
        // The picture is back: it starts on a key frame.
        const rx = this.relayRx.get(a.sid);
        if (rx) rx.wait = true;
        this.requestKey(a.relay);
      }
      this.updateRelayWant(a.relay);
    }
    this.updateLiveWant();
  }

  /** Does this viewer need the camera's status from the room every 2 s? Only on screen, and without the camera's data channel. */
  private wantsLive(v: Attach, camDev: string): boolean {
    if (v.mode !== 'viewer' || v.vis === false) return false;
    return !(v.dc && (!v.dcd || v.dcd === camDev));
  }

  /**
   * Tell each camera whether anyone needs its status at full rate from the room (`live_want`).
   * Off, the camera sends only what changes (and a keepalive every 2 minutes): its viewers on screen hear
   * the rest every 2 s over the data channel, and hidden ones see nothing anyway. A viewer app
   * that never says `view` always counts (vis absent ≠ false) — as before this change.
   */
  private updateLiveWant(): void {
    const socks = this.authed();
    for (const { ws, a } of socks) {
      if (a.mode !== 'camera' || !a.dev) continue;
      const on = socks.some((s) => this.wantsLive(s.a, a.dev!));
      if (a.lw === on) continue;
      a.lw = on;
      ws.serializeAttachment(a);
      this.send(ws, { t: 'live_want', on });
    }
  }

  /**
   * The 24 h timeline strip: 5-minute buckets of the worst state, built from the camera's minute
   * rows (stored, plus the ones still waiting to be written) — it used to be a blob of its own,
   * rewritten every 15 s.
   */
  private timeline(now: number): [number, number, number][] {
    return timelineOf(this.minutesWithPending(now - 24 * 60 * 60_000, now + 60_000));
  }

  // ------------------------------------------------------- camera events
  private async onCamEvent(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
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
      if (msg.on) a.pv = true;
      else delete a.pv;
      ws.serializeAttachment(a);
      this.syncRelayClocks(a.dev, Date.now());
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
  /** A camera's minute rows, checked (6 h back at most, 240 at a time), oldest first. */
  private sanitizeRows(dev: string, raw: unknown[], now: number): MinuteRow[] {
    const rows: MinuteRow[] = [];
    for (const r of raw.slice(0, 240)) {
      if (!r || typeof r !== 'object') continue;
      const x = r as Record<string, unknown>;
      const m = Math.floor(Number(x.m) / 60_000) * 60_000;
      if (!Number.isFinite(m) || m > now + 2 * 60_000 || m < now - 6 * 60 * 60_000) continue;
      const sounds: Record<string, number> = {};
      if (x.sounds && typeof x.sounds === 'object') {
        for (const [k, v] of Object.entries(x.sounds as Record<string, unknown>)) if (isSoundCat(k)) sounds[k] = Math.round(num(v, 0, 60));
      }
      rows.push({
        dev, m,
        laeq: numOrNull(x.laeq, 0, 140), lmax: numOrNull(x.lmax, 0, 140), l10: numOrNull(x.l10, 0, 140), l50: numOrNull(x.l50, 0, 140), l90: numOrNull(x.l90, 0, 140), lpk: numOrNull(x.lpk, 0, 160),
        cal: x.cal ? 1 : 0,
        motion: numOrNull(x.motion, 0, 100), mmax: numOrNull(x.mmax, 0, 100), crib: numOrNull(x.crib, 0, 100), outside: numOrNull(x.outside, 0, 100), light: numOrNull(x.light, 0, 255),
        state: numOrNull(x.state, 1, 5), sounds, visit: x.visit ? 1 : 0,
      });
    }
    return rows.sort((p, q) => p.m - q.m);
  }

  /** The minute rows a camera's socket holds, not written yet. */
  private pendingOf(a: Attach): MinuteRow[] {
    if (!a.dev || !a.mp) return [];
    return a.mp.map(([m, p]) => unpackMinute(a.dev!, m, p)).filter((r): r is MinuteRow => !!r);
  }

  /** Minutes as every reader should see them: what is stored, plus what the cameras' sockets still hold. */
  minutesWithPending(from: number, to: number, dev?: string): MinuteRow[] {
    const extra = this.authed().flatMap(({ a }) => (a.mode === 'camera' && (!dev || a.dev === dev) ? this.pendingOf(a) : [])).filter((r) => r.m >= from && r.m < to);
    const rows = this.store.minutes(from, to, dev);
    if (!extra.length) return rows;
    const key = (r: MinuteRow) => `${r.dev}\u0000${r.m}`;
    const seen = new Set(extra.map(key));
    return [...rows.filter((r) => !seen.has(key(r))), ...extra].sort((p, q) => p.m - q.m || (p.dev < q.dev ? -1 : p.dev > q.dev ? 1 : 0));
  }

  /**
   * The camera's per-minute measurements. Every minute the phone sends the rows the room hasn't
   * acknowledged; the room shows the new ones on the family's live charts at once, and WRITES them
   * in batches (BATCH_ROWS / BATCH_WAIT_MS — at once when the sleep tracker would change), acking
   * with `stats_ok` only what is written. Until then they ride this socket's attachment.
   */
  private async onStats(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    if (a.mode !== 'camera' || !a.dev || !Array.isArray(msg.rows)) return;
    const now = Date.now();
    const rows = this.sanitizeRows(a.dev, msg.rows as unknown[], now);
    if (!rows.length) return;
    // Live charts: only the minutes viewers weren't sent yet (the phone resends unacknowledged ones).
    const fresh = rows.filter((r) => r.m > (a.bm ?? -Infinity));
    if (fresh.length) {
      this.broadcast({ t: 'minutes', rows: fresh }, (x) => x.mode === 'viewer');
      a.bm = fresh[fresh.length - 1].m;
    }
    const byM = new Map(this.pendingOf(a).map((r) => [r.m, r]));
    for (const r of rows) byM.set(r.m, r);
    const list = [...byM.values()].sort((p, q) => p.m - q.m);
    const packed = list.map((r): [number, ReturnType<typeof packMinute>] => [r.m, packMinute(r)]);
    const commit =
      list.length >= BATCH_ROWS ||
      now - list[0].m >= BATCH_WAIT_MS ||
      JSON.stringify(packed).length > PENDING_MAX_CHARS ||
      (await this.sleepWouldChange(a.dev, list));
    if (commit) return this.commitMinutes(ws, a, now, list);
    a.mp = packed;
    ws.serializeAttachment(a);
  }

  /** Would these minutes move the sleep tracker (fell asleep, woke, a report)? A dry run on a copy. */
  private async sleepWouldChange(dev: string, rows: MinuteRow[]): Promise<boolean> {
    const settings = await this.settings();
    if (!settings.sleepTracking || !rows.length || !(await this.sleepMain(dev, rows[rows.length - 1].m, false))) return false;
    const sm = structuredClone((await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm());
    for (const r of rows) if (stepSleep(sm, sleepMinute(r), () => 'dry').length) return true;
    return false;
  }

  /**
   * Write a camera's waiting minutes (one row per camera-hour), acknowledge them, and run what
   * follows from them: sleep tracking, the sound-machine check, housekeeping. `closing`: its
   * socket is going — no acknowledgement, nothing saved on it.
   */
  private async commitMinutes(ws: WebSocket, a: Attach, now: number, rows?: MinuteRow[], closing = false): Promise<void> {
    if (!a.dev) return;
    const list = rows ?? this.pendingOf(a);
    if (a.mp) {
      delete a.mp;
      if (!closing) ws.serializeAttachment(a);
    }
    if (!list.length) return;
    this.store.putMinutes(list);
    if (!closing) this.send(ws, { t: 'stats_ok', upto: list[list.length - 1].m });
    await this.afterMinutes(a.dev, list);
    await this.housekeeping(now);
  }

  /** Write this camera's waiting minutes now (an alert, a camera not responding): the history around it is safe. */
  private async flushCamera(dev: string): Promise<void> {
    for (const { ws, a } of this.authed()) {
      if (a.mode === 'camera' && a.dev === dev && a.mp?.length) await this.commitMinutes(ws, a, Date.now());
    }
  }

  /**
   * Upkeep that used to ride the 15 s alarm, now on the writes that happen anyway: the 6-hourly
   * retention purge, the day's activity mark, the hourly usage write, the relay-data month.
   */
  private async housekeeping(now: number): Promise<void> {
    const purgedAt = (await this.state.storage.get<number>('purgedAt')) ?? 0;
    if (now - purgedAt > PURGE_EVERY_MS) {
      this.store.purge(now);
      this.guests.purge(now);
      this.tracker.purge(now);
      await this.usage.prune(now);
      await this.state.storage.put('purgedAt', now);
    }
    await this.markActive(now);
    await this.meterTick(now);
    const stale = this.fair ? this.fair.month !== monthKey(now) : this.authed().some((s) => s.a.fl && s.a.fl !== 'ok');
    if (stale) await this.checkFair(now);
  }

  /**
   * Which camera's minutes drive the sleep tracker: the one already doing it, until it has been
   * quiet for 10 minutes — then whoever reports. `take`: write the change (it's only a change).
   */
  private async sleepMain(dev: string, last: number, take: boolean): Promise<boolean> {
    const cur = await this.state.storage.get<{ dev: string; at: number }>('sleepDev');
    if (cur?.dev === dev) return true;
    if (cur) {
      const pend = this.authed().flatMap(({ a }) => (a.mode === 'camera' && a.dev === cur.dev ? this.pendingOf(a).map((r) => r.m) : []));
      const mainLast = Math.max(cur.at, this.store.lastMinute(cur.dev) ?? 0, ...pend);
      if (last - mainLast <= 10 * 60_000) return false;
    }
    if (take) await this.state.storage.put('sleepDev', { dev, at: last });
    return true;
  }

  /** Sleep tracking + the sound-machine check run on the nursery's main camera. */
  private async afterMinutes(dev: string, rows: MinuteRow[]): Promise<void> {
    const settings = await this.settings();
    const last = rows[rows.length - 1].m;
    if (!(await this.sleepMain(dev, last, true))) return;
    if (settings.sleepTracking) {
      const sm = (await this.state.storage.get<SleepSm>('sleepSm')) ?? newSleepSm();
      const events: SleepEvent[] = [];
      for (const r of rows) events.push(...stepSleep(sm, sleepMinute(r), newId));
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
    const rows = this.minutesWithPending(from, to);
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
    // Answered a while ago and happening again — or so old it no longer counts (the tidy-up may not
    // have run yet): that's a new incident, and people are alerted. A stuck one never swallows it.
    if (inc && ((inc.status === 'acked' && now - (inc.ack_at ?? 0) > 10 * 60_000) || now > incidentStaleAt(inc))) {
      this.store.updateIncident(inc.id, { status: 'resolved', resolved_at: now, next_at: null });
      this.broadcast({ t: 'incident', inc: { ...inc, status: 'resolved', resolved_at: now, next_at: null } });
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
    // The history around an alert is written now, not left waiting for a batch.
    await this.flushCamera(dev);
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
      // Due at a fixed time of its own (nextAlarmAt), not only when something else wakes the room.
      if (now > incidentStaleAt(inc)) {
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
    const now = Date.now();
    const prev = a.relay;
    const prevRc = a.rc;
    const prevRi = !!a.ri;
    const dev = msg.on ? clip(msg.dev, 40) || undefined : undefined;
    // Feature doc §7 C3, LAN first: a viewer on the camera's own network gets no instant picture
    // through our server — its direct picture over the home Wi-Fi is a moment away. Held back
    // (`rn`), not refused: if the direct picture really fails it asks again (no longer instant).
    const near = !!dev && !!msg.instant && this.nearCams(a).includes(dev);
    if (near) a.rn = dev;
    else delete a.rn;
    a.relay = near ? undefined : dev;
    a.rc = a.relay && Array.isArray(msg.codecs) ? relayCodecMask(msg.codecs) : undefined;
    a.ri = a.relay && msg.instant ? true : undefined;
    // The clock runs only while frames can flow (its camera is here and not paused for privacy) and it can see them.
    relayClock(this.usage, a, 'monitor', this.clockOn(a, now), now);
    ws.serializeAttachment(a);
    const rx = this.relayRx.get(a.sid);
    if (!a.relay) this.relayRx.delete(a.sid);
    else if (a.relay !== prev || a.rc !== prevRc || !rx) {
      this.relayRx.set(a.sid, freshRx(now));
      this.requestKey(a.relay);
    } else {
      // The same subscription again: its window starts over where the camera is
      // now (what it missed isn't still owed). A flowing picture keeps going; a
      // waiting one asks for a key frame (at most once per RELAY_VIEWER_KEY_MS).
      Object.assign(rx, { fw: null, ack: null, ackAt: now, fwAt: now, probed: false, held: 0 });
      if (rx.wait && this.getsVideo(a)) this.viewerKey(a.relay, rx);
    }
    if (prev && prev !== a.relay) this.updateRelayWant(prev);
    if (a.relay) this.updateRelayWant(a.relay);
    // Parents see who is on the relay picture (not those only waiting for their direct one).
    if (prev !== a.relay || prevRi !== !!a.ri) this.syncPresence();
  }

  /**
   * Tell a camera how many viewers want its relay and what they decode — `v`: how many of them get
   * the PICTURE (on screen, relay data left); the rest get its sound only, so a camera whose relay
   * viewers are all hidden encodes no video at all (relay.ts). The codec counts are picture viewers
   * only; `n` stays everyone, for camera apps from before `v` (they keep sending pictures the room
   * then drops, and their sound still reaches everyone). Sent only when it changed.
   */
  private updateRelayWant(dev: string, force = false): void {
    const now = Date.now();
    const want = { t: 'relay_want', n: 0, avc: 0, vp8: 0, vp9: 0, jpeg: 0, v: 0 };
    for (const { a } of this.authed()) {
      if (a.mode !== 'viewer' || a.relay !== dev) continue;
      want.n += 1;
      if (relaySoundOnly(a, now)) continue;
      const m = a.rc ?? 0;
      want.v += 1;
      if (m & 1) want.avc += 1;
      if (m & 2) want.vp8 += 1;
      if (m & 4) want.vp9 += 1;
      if (!m) want.jpeg += 1;
    }
    const key = JSON.stringify(want);
    if (!force && this.relayWantSent.get(dev) === key) return;
    this.relayWantSent.set(dev, key);
    this.broadcast(want, (x) => x.mode === 'camera' && x.dev === dev);
  }

  /** Can this camera's relay frames reach viewers now: connected, and not paused for privacy? */
  private relayFlowing(dev: string, except?: WebSocket): boolean {
    return this.authed().some((s) => s.ws !== except && s.a.mode === 'camera' && s.a.dev === dev && !s.a.pv);
  }

  /** Should this viewer's "picture through our server" clock run: subscribed, frames flowing, a picture it can see? */
  private clockOn(a: Attach, now: number, except?: WebSocket): boolean {
    return !!a.relay && a.vis !== false && a.fl !== 'out' && this.relayFlowing(a.relay, except) && !relaySoundOnly(a, now);
  }

  /**
   * Run each subscribed viewer's "through our server" clock only while its camera's frames can flow
   * (a viewer stays subscribed while the camera is away or paused) and it gets the picture.
   * Attachments only — no storage.
   */
  private syncRelayClocks(dev: string, now: number, except?: WebSocket): void {
    for (const { ws, a } of this.authed()) {
      if (ws === except || a.mode !== 'viewer' || a.relay !== dev) continue;
      const on = this.clockOn(a, now, except);
      if (on === (a.rs != null)) continue;
      relayClock(this.usage, a, 'monitor', on, now);
      ws.serializeAttachment(a);
    }
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
    // Every camera message is a billed DO request (20:1): counted in memory only — no await, no storage.
    this.usage.bump('monitor', 'relayFrames');
    const head = readHead(raw);
    if (!head || a.pv) return;
    const dev = a.dev;
    const now = Date.now();
    // A hidden viewer's grace ends without a message: about once a second, re-tell the camera who
    // gets the picture (only sent when it changed), so it stops encoding video nobody sees.
    if (now - (this.relayWantAt.get(dev) ?? 0) >= 1000) {
      this.relayWantAt.set(dev, now);
      this.updateRelayWant(dev);
    }
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
      // Its screen hidden past the grace, or the nursery's relay data used up: the sound, never the picture.
      const soundOnly = relaySoundOnly(v, now);
      const out = soundOnly ? relaySound(head, raw, v.rc) : relayRoute(head, raw, v.rc, vc);
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
      } else if (soundOnly) {
        // When its picture comes back, it starts on a key frame.
        rx.wait = true;
        if (lag > RELAY_LAG * 2) send = null;
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
      return reply({ from, to, ...historyBuckets(this.minutesWithPending(from, to, msg.dev ? clip(msg.dev, 40) : undefined), from, to) });
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
      const minutes = this.minutesWithPending(row.start, end + 60_000);
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
    // Ends this guest's pass only: the link keeps working for everyone else who has it.
    const r = this.guests.removeGuest(id, Date.now());
    if (!r) return;
    this.kickGuests([id]);
    await this.addLog({ kind: 'people', msg: removalNotice(a.name, r), by: a.name });
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
    // Their relay credentials stop working now, not when they'd lapse.
    if (!set || set.size) this.revokeTurn((who) => who.startsWith('g:') && (!set || set.has(who.slice(2))));
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
    // Anyone no longer a member loses this nursery's relay credentials now (connected or not).
    this.revokeTurn((w) => !w.startsWith('g:') && !ids.has(w));
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
      this.revokeTurn((w) => w.startsWith('g:') && gone.has(w.slice(2)));
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
      this.callUsageOut(rec);
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
    // A line rings for calls, which count against whoever places them: this person, when it's them.
    const [ice, vapid] = await Promise.all([this.ice(a, { scope: 'account', id: a.uid! }), this.vapidKeys()]);
    const mine = (r: CallRecord) => r.from.uid === a.uid || r.invited.includes(a.uid!);
    const log = ((await this.state.storage.get<CallRecord[]>('callLog')) ?? []).filter(mine).slice(-30);
    this.send(ws, {
      t: 'hello',
      you: { sid: a.sid, uid: a.uid, name: a.name, role: a.role, label: a.label, mode: 'line', dev: a.dev },
      nursery: { id: nid, ...meta },
      ...iceFields(ice),
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
   * a minute is dropped — it gets the usual grace to come back. The alarm is
   * set for when each line would be that stale (nextAlarmAt). True while any
   * call is up.
   */
  private async dropStaleLines(now: number): Promise<boolean> {
    const inCall = callingSids(await this.callBook());
    if (!inCall.size) return false;
    for (const { ws, a } of this.authed()) {
      if (a.mode !== 'line' || !inCall.has(a.sid)) continue;
      if (now - this.lineSeenAt(ws, a) < LINE_STALE_MS) continue;
      // Retired, not just closed: a half-open leftover never counts as a line again.
      await this.retire(ws, a, 4008, 'stale');
    }
    return true;
  }

  /** A call line's last sign of life: its last message (memory), its last keepalive ping, or when it connected. */
  private lineSeenAt(ws: WebSocket, a: Attach): number {
    let pinged = 0;
    try {
      pinged = this.state.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
    } catch { /* not supported */ }
    return Math.max(a.at, pinged, this.lineSeen.get(a.sid) ?? 0);
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
        const ice = await this.ice(a, { scope: 'account', id: a.uid });
        await this.expireCalls(now);
        const book = await this.callBook();
        const ref = clip(msg.ref, 20);
        const call = book.start(me, uuids(msg.to), msg.video !== false, crypto.randomUUID().replace(/-/g, '').slice(0, 16), now);
        if ('error' in call) return this.send(ws, { t: 'call_err', error: call.error, ref });
        this.send(ws, { t: 'call_started', ref, id: call.id, ...iceFields(ice) });
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
        // The call is up: its lines are watched from now on (each at the moment it would go stale).
        await this.planAlarm(now);
        return this.send(ws, { t: 'call_joined', id, ...iceFields(await this.ice(a, { scope: 'account', id: call.from.uid })) });
      }
      case 'call_ice': {
        // A long call's relay credentials are due: fresh ones, still counted against its caller.
        const call = (await this.callBook()).get(id);
        if (!call || call.ended || !call.parts.some((p) => p.sid === a.sid && p.gone == null)) return;
        return this.send(ws, { t: 'call_ice', id, ...iceFields(await this.ice(a, { scope: 'account', id: call.from.uid })) });
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

  /**
   * Make sure the alarm goes off within `inMs` (only ever moves it earlier). `slackMs`: it may go
   * off that much later — when an alarm is due then anyway, nothing is written.
   */
  private async ensureAlarm(inMs: number, slackMs = 0): Promise<void> {
    const cur = await this.state.storage.getAlarm();
    const want = Date.now() + Math.max(1000, inMs);
    if (cur == null || cur > want + slackMs) await this.state.storage.setAlarm(want);
  }

  // ---------------------------------------------------------------- usage
  /** Sockets carrying usage, relay clocks brought up to now (saved only when the flush writes). */
  private usageCarriers(now: number, except?: WebSocket) {
    const socks = this.authed().filter((s) => s.ws !== except);
    return carriersOf(this.usage, socks.map((s) => ({ a: s.a, save: (a: Attach) => s.ws.serializeAttachment(a) })), 'monitor', now);
  }

  /** Write the nursery's usage if an hour has passed (rides the existing alarm; ≤ 1 row an hour). */
  private async meterTick(now: number, except?: WebSocket): Promise<void> {
    if (this.usage.due(now) && (this.usage.pendingTotals().size || this.authed().some((s) => s.ws !== except && (s.a.u || s.a.rs != null)))) {
      await this.usage.flush(now, { scopeId: await this.state.storage.get<string>('nid'), carriers: this.usageCarriers(now, except) });
    }
    this.parkUsage(except);
  }

  /**
   * Once per UTC day while a camera is connected: the nursery's activity mark (one Analytics Engine
   * point, no storage) — the denominator of Admin → Costs' per-active-nursery-day figures. The day
   * rides a camera's attachment, so neither a wake nor hibernation repeats it.
   */
  private async markActive(now: number): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.activeDay === day) return;
    const cams = () => this.authed().filter((s) => s.a.mode === 'camera');
    if (!cams().length) return;
    if (!cams().some((s) => s.a.am === day)) {
      const nid = await this.state.storage.get<string>('nid');
      const cam = cams()[0];
      if (!nid || !cam) return;
      this.usage.mark('nursery', nid);
      cam.a.am = day;
      cam.ws.serializeAttachment(cam.a);
    }
    this.activeDay = day;
  }

  /** What memory still holds rides a connected socket's attachment, so hibernation can't lose it. */
  private parkUsage(except?: WebSocket): void {
    if (!this.usage.pendingTotals().size) return;
    // A camera or monitor viewer (their close hands it back); never a call line or an admin socket.
    const host = this.authed().find((s) => s.ws !== except && s.a.mode === 'camera') ?? this.authed().find((s) => s.ws !== except && s.a.mode === 'viewer');
    if (host && this.usage.stash(host.a)) host.ws.serializeAttachment(host.a);
  }

  /** The nursery's relay data this month (monitorFair.ts): cached for the month, else read (never written). */
  private async fairNow(now: number): Promise<FairState> {
    if (this.fair && this.fair.month === monthKey(now)) return this.fair;
    try {
      this.fair = relayDataState(await this.usage.month(now, this.usageCarriers(now)), now);
    } catch {
      this.fair = relayDataState(null, now); // fail open: never take a picture away on a metering error
    }
    return this.fair;
  }

  /**
   * Re-read the nursery's relay data (a viewer reported, or a month began) and tell every monitor
   * socket whose level changed (`{t:'fair', relay}`): at 'out', relay viewers get the relay's
   * sound only and cameras send no video through a TURN relay; the direct and Home Wi-Fi picture,
   * all sound and every alert carry on. Back to 'ok' (a new month), the picture comes back.
   */
  private async checkFair(now: number): Promise<void> {
    this.fair = null;
    const f = await this.fairNow(now);
    const devs = new Set<string>();
    for (const { ws, a } of this.authed()) {
      if (a.mode !== 'camera' && a.mode !== 'viewer') continue;
      if ((a.fl ?? 'ok') === f.level) continue;
      const wasOut = a.fl === 'out';
      a.fl = f.level;
      if (a.mode === 'viewer' && a.relay) {
        relayClock(this.usage, a, 'monitor', this.clockOn(a, now), now);
        if (wasOut && f.level !== 'out') {
          const rx = this.relayRx.get(a.sid);
          if (rx) rx.wait = true;
          this.requestKey(a.relay);
        }
        devs.add(a.relay);
      }
      ws.serializeAttachment(a);
      this.send(ws, { t: 'fair', relay: f });
    }
    for (const dev of devs) this.updateRelayWant(dev);
  }

  /** Parents only: this month's usage of the nursery (Phase B's Usage card). A read — never a write. */
  private async onUsageQuery(ws: WebSocket, a: Attach, msg: Record<string, unknown>): Promise<void> {
    const id = clip(msg.id, 20);
    if (a.role !== 'parent' || a.guest) return this.send(ws, { t: 'r', id, q: 'usage', error: 'forbidden' } satisfies NurseryUsageReply);
    const now = Date.now();
    const usage = await this.usage.month(now, this.usageCarriers(now));
    this.send(ws, {
      t: 'r', id, q: 'usage', usage,
      allowances: { relayDataGb: FAIR_USE.relayDataGbPerNurseryMonth, serverPictureHoursPerDay: FAIR_USE.serverPictureHoursPerNurseryDay },
    } satisfies NurseryUsageReply);
  }

  /** A family call ended: its usage counts against the caller's account (a point now; their line's month row). */
  private callUsageOut(rec: CallRecord): void {
    const use = callUsage(rec);
    if (isEmptyUsage(use) || !UUID_RE.test(rec.from.uid)) return;
    this.usage.point('call', 'account', rec.from.uid, rec.from.uid, use);
    const lines = this.env.USER_LINE;
    if (!lines) return;
    const p = lines
      .get(lines.idFromName(userLineName(rec.from.uid)))
      .fetch(new Request('https://line.internal/x/use', { method: 'POST', body: JSON.stringify({ kind: 'call', id: rec.id, use: compactUsage(use) }), headers: { 'content-type': 'application/json' } }))
      .catch(() => undefined);
    try {
      (this.state as DurableObjectState & { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.(p);
    } catch { /* not supported */ }
  }

  async alarm(): Promise<void> {
    await this.ready;
    const now = Date.now();

    // 1. Sockets that never authenticated are dropped (once: a closed one the runtime still lists is left be).
    for (const { ws, a } of this.sockets()) {
      if (!a.authed && !a.cl && now - a.at > AUTH_TIMEOUT_MS) await this.retire(ws, a, 4001, 'auth timeout');
    }

    // 2. The watchdog: connected cameras with no proof of life — no message, no keepalive ping —
    //    for BEAT_STALE_MS (phone locked, app frozen, off Wi-Fi with the socket half-open).
    //    Proof of life is the device's: a quiet socket of a camera that is alive on another one
    //    (it reconnected; the old connection never closed) is a leftover — retired, never an alarm.
    const meta = await this.meta();
    const cams = this.authed().filter((s) => s.a.mode === 'camera' && !!s.a.dev);
    const alive = new Set(cams.filter((s) => now - this.seenAt(s.ws, s.a) < BEAT_STALE_MS).map((s) => s.a.dev));
    for (const { ws, a } of cams) {
      if (!a.dev || now - this.seenAt(ws, a) < BEAT_STALE_MS) continue;
      if (alive.has(a.dev)) {
        await this.retire(ws, a, 4005, 'replaced');
        if (a.sf) await this.cameraBack(a.dev, a.dn);
        continue;
      }
      if (a.sf) continue;
      a.sf = true;
      ws.serializeAttachment(a);
      await this.state.storage.put(`alerted:${a.dev}`, true);
      const entry = await this.addLog({ kind: 'offline', msg: `${a.dn} stopped responding — check the camera phone`, dev: a.dev });
      await this.raiseHazard('offline', entry, { title: 'Baby camera not responding', body: `${meta.name} · ${a.dn} — the phone may be locked, asleep or off Wi-Fi`, entryId: entry.id }, a.dev);
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
      }
    }
    if (changed) await this.state.storage.put('pendingOffline', pending);

    // 4. Incidents nobody answered.
    await this.escalate(now);

    // 5. A sleep session whose camera went away for good.
    const sm = await this.state.storage.get<SleepSm>('sleepSm');
    if (sm?.session && sm.lastM != null && now - sm.lastM > SLEEP_GONE_MS) {
      const events = endSession(sm, sm.lastM + 60_000);
      await this.state.storage.put('sleepSm', sm);
      await this.onSleepEvents(events);
    }

    // 6. Lines in a call that went silent; family calls nobody picked up (or that lost everyone).
    await this.dropStaleLines(now);
    await this.expireCalls(now);

    // 7. Relay clocks follow their cameras (self-heals one a wake left wrong); retention, the day's
    //    mark and the hourly usage write when they're due.
    for (const dev of new Set(this.authed().flatMap((x) => (x.a.mode === 'viewer' && x.a.relay ? [x.a.relay] : [])))) this.syncRelayClocks(dev, now);
    await this.housekeeping(now);

    // Next wake-up: whatever is due first — or none at all.
    await this.planAlarm(now);
  }
}

/** A minute row as the sleep tracker reads it. */
const sleepMinute = (r: MinuteRow) => ({ m: r.m, state: r.state, motion: r.motion, crib: r.crib, sounds: r.sounds, visit: r.visit });

/**
 * When an incident stops being current — escalate() resolves it then, and a new alert of its kind
 * on that camera opens a new incident (and alerts people) rather than joining it: answered ones
 * ACKED_STALE_MS after the answer, the others their kind's staleMs after they began.
 */
function incidentStaleAt(inc: IncidentRow): number {
  if (inc.status === 'acked') return (inc.ack_at ?? inc.at) + ACKED_STALE_MS;
  return inc.at + (HAZARD[inc.kind as HazardKind]?.staleMs ?? 60 * 60_000);
}

/** The sockets (call lines) still in a call that's up — answered, not ended, not dropped from it. */
function callingSids(book: CallBook): Set<string> {
  const out = new Set<string>();
  for (const c of book.toJSON()) {
    if (c.ended || c.answeredAt == null) continue;
    for (const p of c.parts) if (p.gone == null) out.add(p.sid);
  }
  return out;
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
