/**
 * Client mirror of the live-worker MonitorRoom protocol (keep in sync with
 * live-worker/src/monitorRoom.ts — the worker compiles separately).
 *
 * The ADR 0006 Phase 0 delta (capabilities, close codes, re-auth, key messages, sealed
 * signaling) lives in packages/monitor-core/src/wire.ts — one source for the web app, the
 * live Worker and the native apps — and is re-exported here, so monitor code imports one file.
 */

import type { BabyProfile, TrackItem, TrackKind } from './trackTypes';
import type { SoundCat } from './soundClasses';
import type { Zone } from './vision';
import { parseCaps, type Cap, type KeyTarget, type SealedRtc } from '../../packages/monitor-core/src/wire';

export type { Zone };
export {
  CAPS, CLOSE, CLOSE_ADVICE, CLOSE_REASON, closeKind, EPOCH_OVERLAP_MS, EXPIRY_GRACE_S, hasCap, isSealedRtc, parseCaps,
  parseDevHello, parseKeyInit, parseKeyRotate, parseKeyWrap, ROUTES, rtcPolicy, TOKEN_EVENT,
} from '../../packages/monitor-core/src/wire';
export type {
  Cap, CloseAdvice, CloseKind, DevHelloMsg, DevicePlatform, HelloV2Fields, KeyConflictMsg, KeyInitMsg, KeyReqMsg,
  KeyRotateMsg, KeyRotateReqMsg, KeyTarget, KeyWrapEntry, KeyWrapMsg, LiveWantMsg, MembersRequest, MembersResponse,
  ReauthMsg, ReauthOkMsg, SealedRtc, ViewMsg, WithEid,
} from '../../packages/monitor-core/src/wire';

/** What a room can do (`hello.caps`), known capabilities only — an older room lists none. */
export const helloCaps = (m: { caps?: unknown }): Cap[] => parseCaps(m.caps);

export type MonRole = 'parent' | 'caregiver' | 'viewer';
export type MonMode = 'camera' | 'viewer';
/** The baby's state as the family sees it, worst-first for the timeline. */
export type BabyState = 'calm' | 'stirring' | 'awake' | 'noisy' | 'fussing' | 'crying';
export type ModelState = 'off' | 'loading' | 'ready' | 'failed';

export interface CamStatus {
  state: BabyState;
  /** dB above the room's noise floor (0–60). */
  level: number;
  motion: number;
  light: number;
  battery: number | null;
  charging: boolean | null;
  soothing: string | null;
  /** Cry-analyser confidence 0–100. */
  cry: number;
  /** The most important sound right now. */
  sound?: SoundCat | null;
  conf?: number;
  /** What the AI hears right now: [category, 0–100]. */
  top?: [SoundCat, number][];
  /** AI sound detection status on the camera. */
  model?: ModelState;
  /** Video paused on the camera (sound monitoring continues). */
  paused?: 'privacy' | 'interrupted' | 'hidden' | null;
  /** How the camera phone keeps its screen on (none = it may lock and pause the video). */
  awake?: 'native' | 'video' | 'none';
  /** Who is talking / video-calling into the nursery right now. */
  talk?: string | null;
  call?: string | null;
  /** Sound level meter, A-weighted dB (cal = the camera's meter is calibrated). */
  spl?: { db: number; leq: number; max: number; cal: boolean } | null;
  /** Movement in the crib zone / outside it (null without a crib zone). */
  crib?: number | null;
  outside?: number | null;
  /** An adult is in the room right now. */
  visit?: boolean;
  /** Smart vision (beta) — what the camera can tell about the baby right now. */
  scene?: {
    baby: boolean;
    posture: 'lying' | 'sitting' | 'standing' | null;
    where: string | null;
    holding: string | null;
    near: string[];
    adult: boolean;
  } | null;
  /** The camera phone's video encoder right now (see CameraHub.telemetry). */
  enc?: EncStatus | null;
}

/** Why an encoder is holding back: the phone's processor, the network, or nothing. */
export type EncLimit = 'cpu' | 'bandwidth' | 'other' | 'none';

export interface EncStatus {
  /** Viewers connected peer-to-peer. */
  peers: number;
  /** Frames per second actually sent (slowest viewer), null before the first reading. */
  fps: number | null;
  /** Worst limitation across the viewers. */
  lim: EncLimit | null;
  /** Encoder in use, e.g. "MediaCodec" / "VideoToolbox" (hardware) or "libvpx" / "OpenH264" (software). */
  impl: string | null;
  /** Width of the largest picture sent, px. */
  w: number | null;
  /** Rungs the camera stepped down because the phone is busy (0 = full quality). */
  p: number;
  /** Relay pictures per second (0 = off). */
  relay: number;
  /** What the relay sends: a video codec, or JPEG (absent from older cameras). */
  rc?: 'avc' | 'vp8' | 'vp9' | 'jpeg' | null;
}

export interface CamPresence {
  sid: string;
  dev: string;
  dn: string;
  by: string;
  since: number;
  status: CamStatus | null;
  statusAt: number | null;
  /**
   * The camera's device key id (ADR 0006 D6.3), once its `dev_hello` checked out (rooms that
   * list `e2e1`). Present = this camera seals: its signaling and relay picture are end to end.
   */
  devId?: string;
}

export interface ViewerPresence {
  sid: string;
  name: string;
  label: string | null;
  role: MonRole;
  dn: string;
  relay: boolean;
  /** Joined with the share link + passcode (no account). */
  guest?: boolean;
  /** This viewer's device key id, once its `dev_hello` checked out (rooms that list `e2e1`). */
  devId?: string;
}

/**
 * Parents' devices list (rooms that list `e2e1`; a WS-6 contract note in ADR 0006 for WS-9):
 *  - `{t:'q', id, q:'devices'}` → `{t:'r', id, devices: NurseryDevice[]}`;
 *  - `{t:'q', id, q:'dev_revoke', devId}` → `{t:'r', id, ok: true}` or `{ok: false, error}`: the
 *    room drops the device and its wraps from the roster, closes its sockets (4004 'revoked'),
 *    asks a key holder for the next epoch (`key_rotate` to the devices that remain), and logs a
 *    `security` event every parent sees. Parents only; the second sign-in step when it's on.
 * The security log is the existing events query: `{q:'events', kinds:['security']}`.
 */
export interface DevicesReply {
  devices: NurseryDevice[];
}
export interface DevRevokeReply {
  ok: boolean;
  error?: string;
  /**
   * The room told the cameras to end the device's live direct calls (`peer_gone` with
   * `why: 'revoked'`). Absent: a room that doesn't, so the parent is told how to end one.
   */
  ended?: boolean;
}

/** A device in the nursery's roster (`mon_devices`), as parents see it (`{t:'q', q:'devices'}`). */
export interface NurseryDevice {
  devId: string;
  name: string;
  platform: string;
  /** Whose device: a member's name, a guest's name, or "Camera". */
  who: string;
  /** This browser. */
  me?: boolean;
  added: number;
  last_seen: number | null;
  /** Holds the nursery key now (it was wrapped to it at the current epoch). */
  keyed?: boolean;
}

/** Guest access, as parents see it (never the passcode). */
export interface ShareInfo {
  on: boolean;
  /** The link's secret part (…/join/<nursery>/<code>). */
  code: string | null;
  role: 'viewer' | 'caregiver';
  created_at: number | null;
  created_by: string | null;
  expires_at: number | null;
  /** Too many wrong passcodes: nobody can join until then. */
  locked_until: number | null;
  /** When the passcode was last set — a new value confirms "Set a new passcode". */
  pass_at?: number | null;
  /** Most guests one link admits. */
  max_guests?: number;
  guests: { id: string; name: string; role: 'viewer' | 'caregiver'; created_at: number; last_seen: number; expires_at: number }[];
  /** Guests who also have a Stream Studio account — a parent can make them members. */
  requests?: ShareRequest[];
}

/** A guest with a Stream Studio account (uid verified by the room with Supabase). */
export interface ShareRequest {
  id: string;
  uid: string;
  /** Their account's display name. */
  account: string;
  /** The name they typed when joining. */
  name: string;
  guest_id: string;
  role: 'viewer' | 'caregiver';
  at: number;
}

export type MonLogKind =
  | SoundCat
  | 'cry_end' | 'fuss_end' | 'noise' | 'motion' | 'offline' | 'online' | 'battery' | 'privacy'
  | 'feed' | 'diaper' | 'sleep' | 'wake' | 'note' | 'ack' | 'soothe' | 'camera' | 'people' | 'call'
  | 'zone' | 'crib_out' | 'visit_start' | 'visit_end' | 'lights_on' | 'lights_off' | 'dark' | 'moved' | 'paused'
  | 'very_loud' | 'loud_db' | 'machine' | 'asleep' | 'woke' | 'resettled' | 'sleep_report' | 'duty' | 'resolved' | 'escalated';

/** urgent = someone should go now · warn = check soon · info = FYI · care = family logs. */
export type Severity = 'urgent' | 'warn' | 'info' | 'care';

export interface MonLog {
  id: string;
  at: number;
  kind: MonLogKind;
  msg: string;
  sev?: Severity;
  by?: string;
  dev?: string;
  /** Seconds, for episodes that ended (cry_end, fuss_end, visit_end). */
  secs?: number;
  /** 0–100 detection confidence for sound events. */
  conf?: number;
  /** dB(A) for noise events. */
  db?: number;
  /** The incident this line belongs to. */
  incident?: string;
  /**
   * The camera event this line came from (`<dev>:<seq>`, rooms that list `eid`): viewers
   * alert on whichever copy arrives first — this line or the camera's data channel — once.
   */
  eid?: string;
}

export interface MonSettings {
  sensitivity: 'low' | 'medium' | 'high';
  cryRepeatMin: number;
  /** Minutes of crying with no one answering before everyone is alerted. */
  cryEscalateMin?: number;
  /** "Loud" threshold for the sound meter, dB(A); null = off. */
  noiseDb?: number | null;
  /** Warn when a steady sound averages over 50 dB for an hour. */
  machineCheck?: boolean;
  sleepTracking?: boolean;
  /** Zones per camera device id. */
  zones?: Record<string, Zone[]>;
  /** For the tracker's age-based guidance. */
  baby?: BabyProfile;
  /** The nursery's time zone. */
  tz?: string;
}

export type IncidentStatus = 'open' | 'acked' | 'resolved';

/** An alert that needs a person: open → acknowledged → resolved. */
export interface Incident {
  id: string;
  at: number;
  kind: string;
  sev: Severity;
  title: string;
  dev: string | null;
  status: IncidentStatus;
  ack_by: string | null;
  ack_at: number | null;
  resolved_at: number | null;
  pushes: number;
  next_at: number | null;
}

/** Who gets routine alerts first (hazards always reach everyone). */
export interface Duty {
  uid: string;
  name: string;
  until: number;
}

export type SleepPhase = 'idle' | 'settling' | 'asleep' | 'awake';

export interface SleepSession {
  id: string;
  start: number;
  end: number | null;
  onset: number | null;
  kind: 'night' | 'nap';
  source: 'auto' | 'manual';
  asleep_min: number;
  awake_min: number;
  wakings: number;
  longest_min: number;
  cry_min: number;
  laeq: number | null;
  summary: {
    discarded?: boolean;
    l90?: number | null;
    peak?: number | null;
    light?: number | null;
    counts?: Record<string, number>;
    visits?: number;
    noisyMin?: number;
    wakeups?: { at: number; mins: number; cried: boolean }[];
  } | null;
}

export interface SleepStatus {
  phase: SleepPhase;
  since: number | null;
  session: string | null;
  asleepMin: number;
  wakings: number;
  last: SleepSession | null;
}

/** One chart bucket of the camera's per-minute measurements. */
export interface HistoryPoint {
  t: number;
  laeq: number | null;
  lmax: number | null;
  l90: number | null;
  motion: number | null;
  crib: number | null;
  light: number | null;
  state: number | null;
  cal: number;
  visit: number;
  sounds: Record<string, number>;
}

export interface MinuteRow {
  dev: string;
  m: number;
  laeq: number | null;
  lmax: number | null;
  l90: number | null;
  motion: number | null;
  crib: number | null;
  light: number | null;
  state: number | null;
  cal: number;
  visit: number;
  sounds: Record<string, number>;
}

export interface NightReport extends SleepSession {
  res: number;
  pts: HistoryPoint[];
  events: MonLog[];
  /** Average seconds from an alert to someone answering it. */
  response: number | null;
}

/** [bucketStart ms, worst state rank 1–6, crying samples] — 5-minute buckets. */
export type TimelineBucket = [number, number, number];

export interface MonRtc {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit | null;
  /**
   * Candidates gathered within one 75 ms window, in one message (null = end of candidates).
   * Sent only to a peer that said `ib` (the room bills every message).
   */
  ices?: (RTCIceCandidateInit | null)[];
  /** With an offer or an answer: this side takes `ices` batches. */
  ib?: 1;
  /** With an offer or an answer: this side takes ICE restarts on the `mon` data channel (`{t:'sig'}`). */
  dcr?: 1;
  hello?: boolean;
  bye?: boolean;
  /**
   * The viewer's peer connection this belongs to (fresh per ViewerLink.connect).
   * A new id means a new call: the camera builds a new connection for it instead
   * of re-using the old one, and ignores late candidates / byes from older ones.
   */
  pc?: string;
  /**
   * The viewer (its device id + this tab), stable across socket reconnects: the
   * camera keys its peer by it, so commands from the viewer's new socket still
   * find the call.
   */
  vid?: string;
  /** The picture the viewer wants, with its offer (so a new call starts at the right quality). */
  q?: 'hd' | 'sd' | 'audio';
  /** With an offer: this viewer can watch the relay picture if the camera's direct slots are full. */
  ov?: 1;
  /** With a bye from the camera: its direct slots are full — watch the relay picture. */
  full?: boolean;
  /** Camera → viewer: its relay (TURN) credential was renewed — restart ICE onto it (only the viewer offers). */
  re?: 1;
  /** Camera → viewer, with its answer: send quality and screen state on the data channel (rtc.ts ViewerDcMsg). */
  dcc?: 1;
  /**
   * With an offer to a camera that seals: this viewer has no current family key (or the camera
   * said `nok`), so the call is set up as before end to end — the camera takes it, counts it and
   * says so, rather than leave the viewer without picture and sound (ADR 0006 WS-6 review).
   */
  nk?: 1;
  /**
   * Camera → viewer, plain: it couldn't open this viewer's sealed signaling, or seal its answer
   * (it has no current key) — call again with `nk`.
   */
  nok?: 1;
}

export type MonCmd = 'soothe' | 'soothe_stop' | 'quality' | 'flip' | 'talk' | 'video';

/** The nursery's relay data this month (live-worker/src/monitorFair.ts; owner decision 2026-10-22: 10 GB). */
export interface FairState {
  month: string;
  level: 'ok' | 'warn' | 'out';
  usedGb: number;
  ofGb: number;
  measured: boolean;
  resets: number;
}

export type MonServerMsg =
  | {
      t: 'hello';
      /** Guests: `until` is when their pass ends now (the room is the authority — a parent may have extended the link). */
      you: { sid: string; uid: string; name: string; role: MonRole; label: string | null; mode: MonMode; dev: string; guest?: boolean; until?: number };
      nursery: { id: string; name: string; baby: string | null };
      cams: CamPresence[];
      viewers: ViewerPresence[];
      log: MonLog[];
      tl: TimelineBucket[];
      settings: MonSettings;
      incidents?: Incident[];
      duty?: Duty | null;
      sleep?: SleepStatus;
      track?: { running: TrackItem[]; latest: Partial<Record<TrackKind, TrackItem>> };
      ice: RTCIceServer[];
      /** Ask for fresh relay credentials (`{t:'ice'}`) in this many ms; absent: STUN only, nothing to refresh. */
      iceMs?: number;
      vapid: string | null;
      /** What this room can do (ADR 0006 Phase 0; wire.ts `CAPS`): 'view' = it takes `{t:'view'}` and sends cameras `live_want`. */
      caps?: string[];
      /** The access token's expiry (ms): the room closes the socket 120 s after it unless re-authed (`reauth`). */
      exp?: number;
      /** A fresh nonce for this socket's `dev_hello` to sign (`e2e1`). */
      nonce?: string;
      /** The nursery key's current epoch (`e2e1`; 0 = none yet — a parent or camera device starts one with `key_init`). */
      e?: number;
      /** The nursery's relay data this month (absent: a room from before fair use). */
      fair?: FairState;
      /** Viewers: the cameras on this device's network (their direct picture comes first). */
      near?: string[];
    }
  /** Camera: does anyone need its status from the room every 2 s (statusCadence.ts)? */
  | { t: 'live_want'; on: boolean }
  /** The nursery's relay data level changed: at 'out', pictures that need a relay are sound only. */
  | { t: 'fair'; relay: FairState }
  /** Viewers: which cameras are on this device's network now. */
  | { t: 'near'; near: string[] }
  /** Fresh relay credentials, answering `{t:'ice'}`. */
  | { t: 'ice'; servers: RTCIceServer[]; iceMs?: number }
  | { t: 'presence'; cams: CamPresence[]; viewers: ViewerPresence[] }
  | { t: 'share'; share: ShareInfo }
  | { t: 'track'; item: TrackItem }
  | { t: 'track_del'; id: string }
  | { t: 'track_err'; id?: string; msg: string }
  | { t: 'share_err'; msg: string }
  /** Signaling from a peer: sealed (`{e, iv, ct, f}`) between devices that hold the nursery key. */
  | { t: 'rtc'; from: string; d: MonRtc | SealedRtc; name?: string; label?: string | null; role?: MonRole }
  /** The room took this socket's fresh token (`reauth`); it now closes at `exp` + 120 s. */
  | { t: 'reauth_ok'; exp: number }
  /** Key holder: wrap epoch `e` of the nursery key to this device (sealed.ts `wrapNmk`) and answer `key_wrap`. */
  | ({ t: 'key_req'; e: number } & KeyTarget)
  /** This device's own wrap of epoch `e` (stored by the room; the server can't open it). */
  | { t: 'key_wrap'; devId: string; e: number; blob: string }
  /** Key holder: someone was removed — make epoch `e` for these devices and answer `key_rotate` with the wraps. */
  | { t: 'key_rotate'; e: number; devs: KeyTarget[] }
  /** This device's `key_init` / `key_rotate` lost the compare-and-set: `e` is current. */
  | { t: 'key_conflict'; e: number }
  /** Parents: removing a guest changed the share link (and its passcode) — shown once, to pass on to those who should keep it. */
  | { t: 'share_rotated'; link: { code: string; pass?: string | null }; removed?: string | null }
  | { t: 'status'; dev: string; sid: string; st: CamStatus; at: number }
  | { t: 'log'; entry: MonLog }
  | { t: 'ack'; ref: string; inc?: string | null; by: string; label: string | null; at: number }
  | { t: 'incident'; inc: Incident; why?: string }
  | { t: 'duty'; duty: Duty | null }
  | { t: 'sleep'; sleep: SleepStatus }
  | { t: 'minutes'; rows: MinuteRow[] }
  | { t: 'stats_ok'; upto: number }
  | { t: 'r'; id: string; q: string; [k: string]: unknown }
  | { t: 'tell'; c: 'feedback' | 'talk_gain'; v: { factor?: number; db?: number; freq?: number }; from: string }
  | { t: 'cmd'; c: MonCmd; v: unknown; from: string; by: string }
  /** Viewers on this camera's relay picture, and how many decode each codec (jpeg = none). Older rooms send only n. */
  | { t: 'relay_want'; n: number; avc?: number; vp8?: number; vp9?: number; jpeg?: number; v?: number }
  /** A relay viewer needs a key frame (it subscribed, fell behind, or its decoder failed). */
  | { t: 'relay_key' }
  | { t: 'settings'; settings: MonSettings }
  | { t: 'cam_gone'; sid: string; dev: string }
  /**
   * Camera: a viewer's socket left. `why` (WS-6 → WS-9 contract): it lost access — its device was
   * revoked or its person (or guest pass) removed. The camera then ends that viewer's direct call
   * even while it is connected (and any call sealed by `devId`); without `why` a call that is still
   * up carries on, as a home network keeps working when the internet blips.
   */
  | { t: 'peer_gone'; sid: string; why?: 'revoked' | 'removed'; devId?: string }
  | { t: 'roles_changed' }
  /** This guest was made a member: drop the guest pass, reconnect with the account. */
  | { t: 'promoted' }
  /** This guest's pass now ends at `until` (a parent extended the link). */
  | { t: 'guest_pass'; until: number }
  | { t: 'push_ok'; prefs: Record<string, boolean> }
  | { t: 'notice'; text: string }
  | { t: 'pong'; at: number }
  | { t: 'error'; code: string; msg: string };

/** One line each, for choosing a role when inviting (least access first). */
export const ROLE_INVITE: Record<MonRole, string> = {
  viewer: 'Watch, listen and get alerts',
  caregiver: 'Also talk, soothe, run a camera and log feeds',
  parent: 'Everything, including inviting people and settings',
};

export const ROLE_INFO: Record<MonRole, { label: string; can: string }> = {
  parent: { label: 'Parent', can: 'Everything: watch, talk, video call, soothe, run cameras, manage people' },
  caregiver: { label: 'Caregiver', can: 'Watch, talk, video call, soothe, run a camera, log feeds & naps' },
  viewer: { label: 'Viewer', can: 'Watch, listen and get alerts' },
};

export const LABEL_SUGGESTIONS = ['Mom', 'Dad', 'Grandma', 'Grandpa', 'Nanny', 'Babysitter', 'Aunt', 'Uncle', 'Sibling', 'Family friend'];

export const STATE_RANK: Record<BabyState, number> = { calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 };

export const STATE_INFO: Record<BabyState | 'offline' | 'unknown', { label: string; tone: 'ok' | 'warn' | 'live' | 'neutral' | 'info'; sub: string }> = {
  calm: { label: 'Calm', tone: 'ok', sub: 'Quiet and still' },
  stirring: { label: 'Stirring', tone: 'warn', sub: 'Some movement or small sounds' },
  awake: { label: 'Awake & happy', tone: 'info', sub: 'Babbling or laughing' },
  noisy: { label: 'Noisy room', tone: 'warn', sub: 'A sound that isn’t the baby' },
  fussing: { label: 'Fussing', tone: 'warn', sub: 'Whimpering or unsettled' },
  crying: { label: 'Crying', tone: 'live', sub: 'Cry detected' },
  offline: { label: 'Camera offline', tone: 'live', sub: 'Not receiving the camera' },
  unknown: { label: 'Waiting for camera', tone: 'neutral', sub: 'Start a camera on the phone in the nursery' },
};
