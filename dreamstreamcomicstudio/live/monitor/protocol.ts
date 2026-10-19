/**
 * Client mirror of the live-worker MonitorRoom protocol (keep in sync with
 * live-worker/src/monitorRoom.ts — the worker compiles separately).
 */

export type MonRole = 'parent' | 'caregiver' | 'viewer';
export type MonMode = 'camera' | 'viewer';
export type BabyState = 'calm' | 'stirring' | 'crying' | 'noisy';

export interface CamStatus {
  state: BabyState;
  level: number;
  motion: number;
  light: number;
  battery: number | null;
  charging: boolean | null;
  soothing: string | null;
  cry: number;
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
  | 'cry' | 'cry_end' | 'noise' | 'motion' | 'offline' | 'online' | 'battery'
  | 'feed' | 'diaper' | 'sleep' | 'wake' | 'note' | 'ack' | 'soothe' | 'camera' | 'people';

export interface MonLog {
  id: string;
  at: number;
  kind: MonLogKind;
  msg: string;
  by?: string;
  dev?: string;
}

export interface MonSettings {
  sensitivity: 'low' | 'medium' | 'high';
  cryRepeatMin: number;
}

/** [bucketStart ms, worst state rank 1–4, crying samples] — 5-minute buckets. */
export type TimelineBucket = [number, number, number];

export interface MonRtc {
  sdp?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit | null;
  /** Viewer asks the camera to (re)start a session. */
  hello?: boolean;
  bye?: boolean;
}

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
  | { t: 'cmd'; c: 'soothe' | 'soothe_stop' | 'quality' | 'flip' | 'talk'; v: unknown; from: string; by: string }
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
  parent: { label: 'Parent', can: 'Everything: watch, talk, soothe, run cameras, manage people' },
  caregiver: { label: 'Caregiver', can: 'Watch, talk back, soothe, run a camera, log feeds & naps' },
  viewer: { label: 'Viewer', can: 'Watch and get alerts only' },
};

export const LABEL_SUGGESTIONS = ['Mom', 'Dad', 'Grandma', 'Grandpa', 'Nanny', 'Babysitter', 'Aunt', 'Uncle', 'Sibling', 'Family friend'];

export const STATE_INFO: Record<BabyState | 'offline' | 'unknown', { label: string; tone: 'ok' | 'warn' | 'live' | 'neutral'; sub: string }> = {
  calm: { label: 'Calm', tone: 'ok', sub: 'Quiet and still' },
  stirring: { label: 'Stirring', tone: 'warn', sub: 'Some movement or small sounds' },
  noisy: { label: 'Noisy room', tone: 'warn', sub: 'Loud sound that isn’t crying' },
  crying: { label: 'Crying', tone: 'live', sub: 'Cry detected' },
  offline: { label: 'Camera offline', tone: 'live', sub: 'Not receiving the camera' },
  unknown: { label: 'Waiting for camera', tone: 'neutral', sub: 'Start a camera on the phone in the nursery' },
};
