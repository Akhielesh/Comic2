/**
 * Client mirror of the live-worker MonitorRoom protocol (keep in sync with
 * live-worker/src/monitorRoom.ts — the worker compiles separately).
 */

import type { SoundCat } from './soundClasses';

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
  paused?: 'privacy' | 'interrupted' | null;
  /** Who is talking / video-calling into the nursery right now. */
  talk?: string | null;
  call?: string | null;
}

export interface CamPresence {
  sid: string;
  dev: string;
  dn: string;
  by: string;
  since: number;
  status: CamStatus | null;
  statusAt: number | null;
}

export interface ViewerPresence {
  sid: string;
  name: string;
  label: string | null;
  role: MonRole;
  dn: string;
  relay: boolean;
}

export type MonLogKind =
  | SoundCat
  | 'cry_end' | 'fuss_end' | 'noise' | 'motion' | 'offline' | 'online' | 'battery' | 'privacy'
  | 'feed' | 'diaper' | 'sleep' | 'wake' | 'note' | 'ack' | 'soothe' | 'camera' | 'people' | 'call';

export interface MonLog {
  id: string;
  at: number;
  kind: MonLogKind;
  msg: string;
  by?: string;
  dev?: string;
  /** Seconds, for episodes that ended (cry_end, fuss_end). */
  secs?: number;
  /** 0–100 detection confidence for sound events. */
  conf?: number;
}

export interface MonSettings {
  sensitivity: 'low' | 'medium' | 'high';
  cryRepeatMin: number;
}

/** [bucketStart ms, worst state rank 1–6, crying samples] — 5-minute buckets. */
export type TimelineBucket = [number, number, number];

export interface MonRtc {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit | null;
  hello?: boolean;
  bye?: boolean;
}

export type MonCmd = 'soothe' | 'soothe_stop' | 'quality' | 'flip' | 'talk' | 'video';

export type MonServerMsg =
  | {
      t: 'hello';
      you: { sid: string; uid: string; name: string; role: MonRole; label: string | null; mode: MonMode; dev: string };
      nursery: { id: string; name: string; baby: string | null };
      cams: CamPresence[];
      viewers: ViewerPresence[];
      log: MonLog[];
      tl: TimelineBucket[];
      settings: MonSettings;
      ice: RTCIceServer[];
      vapid: string | null;
    }
  | { t: 'presence'; cams: CamPresence[]; viewers: ViewerPresence[] }
  | { t: 'rtc'; from: string; d: MonRtc; name?: string; label?: string | null; role?: MonRole }
  | { t: 'status'; dev: string; sid: string; st: CamStatus; at: number }
  | { t: 'log'; entry: MonLog }
  | { t: 'ack'; ref: string; by: string; label: string | null; at: number }
  | { t: 'cmd'; c: MonCmd; v: unknown; from: string; by: string }
  | { t: 'relay_want'; n: number }
  | { t: 'settings'; settings: MonSettings }
  | { t: 'cam_gone'; sid: string; dev: string }
  | { t: 'peer_gone'; sid: string }
  | { t: 'roles_changed' }
  | { t: 'push_ok'; prefs: Record<string, boolean> }
  | { t: 'notice'; text: string }
  | { t: 'pong'; at: number }
  | { t: 'error'; code: string; msg: string };

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
