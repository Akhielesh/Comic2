/**
 * Client-side mirror of the live-worker EventRoom protocol.
 * (Deliberately duplicated — the worker compiles under its own tsconfig with
 * workers-types; keep the two in sync when the protocol changes.)
 */

export type Role = 'host' | 'mod' | 'guest' | 'viewer' | 'pending';
export type StreamStatus = 'idle' | 'live' | 'paused' | 'ended';
/** How an event started: a private meeting (nothing broadcast until the host goes live)
 *  or a broadcast. Rooms created before meetings report none → broadcast. */
export type EventKind = 'meeting' | 'broadcast';

/** On-air guest seats per event (mirrors the worker's mesh cap). */
export const MAX_GUESTS = 4;

/** WebRTC signaling envelope relayed through the room (host ⇄ guest). */
export interface RtcSignal {
  sdp?: { type: 'offer' | 'answer'; sdp?: string };
  ice?: RTCIceCandidateInit | null;
  /** MediaStream.id → what that stream is, so tiles label correctly. */
  meta?: Record<string, 'cam' | 'screen'>;
  /** Ready for (re)negotiation. From a guest: the host (re)creates its peer. From the
   *  host: the guest rebuilds its peer and answers with its own `ready` (lost handshakes,
   *  studio reloads and a camera that came up late all heal this way). */
  ready?: boolean;
  /** Sender is leaving — tear the peer down. */
  bye?: boolean;
}

export interface EventMeta {
  id: string;
  title: string;
  host: string;
  desc: string;
  cover: number;
  access: 'open' | 'approval';
  quality: string;
  mime: string;
  segMs: number;
  status: StreamStatus;
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  firstSeq: number;
  latestSeq: number;
  lastIngestAt: number | null;
  pinned: string | null;
  slowSec: number;
  reactionsOn: boolean;
  /** The host's six one-tap reactions (absent on older rooms → the defaults). */
  quick?: string[];
  /** Hard concurrent-viewer cap, host-set (≤200 platform ceiling). */
  maxViewers: number;
  /** Meeting or broadcast (absent on older rooms → broadcast). */
  kind?: EventKind;
  viewers: number;
  rsvpCount: number;
  rsvpNames: string[];
}

/** Server-side recording copy, kept 7 days for the host. */
export interface RecordingEntry {
  key: string;
  file: string;
  bytes: number;
  mime: string;
  durMs: number;
  at: number;
}

/** Replay stays watchable this long after a stream ends (mirrors the worker). */
export const REPLAY_WINDOW_MS = 24 * 60 * 60_000;
/** Server recordings are kept this long, then auto-purge (mirrors the worker). */
export const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Platform ceiling on the host-set viewer cap (mirrors the worker). */
export const HARD_VIEWER_CAP = 200;

export interface ChatMsg {
  id: string;
  sid: string;
  name: string;
  role: Role;
  text: string;
  at: number;
}

export interface LobbyEntry {
  sid: string;
  name: string;
}

export interface PersonEntry {
  sid: string;
  name: string;
  role: Role;
}

export type LogKind = 'live' | 'scene' | 'join' | 'mod' | 'warn' | 'err' | 'rec' | 'sys';

export interface LogEntry {
  at: number;
  kind: LogKind;
  tag: string;
  msg: string;
}

export interface EventStats {
  peakViewers: number;
  peakAt: number | null;
  chatTotal: number;
  emojiTotal: number;
  uniqueViewers: number;
  curve: { at: number; n: number }[];
  chatCurve: { at: number; n: number }[];
  /** Host-reported network telemetry (upload bps, encoded bps, failures). */
  healthCurve: { at: number; up: number; enc: number; fail: number }[];
}

export interface StatsResponse {
  meta: EventMeta;
  stats: EventStats;
  log: LogEntry[];
  topChatters: { name: string; count: number }[];
  recordings: RecordingEntry[];
}

export type ServerMsg =
  | { t: 'hello'; meta: EventMeta; you: { sid: string; role: Role; name: string }; chat: ChatMsg[]; log?: LogEntry[] }
  | { t: 'pending' }
  | { t: 'admitted'; token: string }
  | { t: 'denied' }
  | { t: 'kicked' }
  | { t: 'role'; role: Role }
  | { t: 'chat'; m: ChatMsg }
  | { t: 'delete'; id: string }
  | { t: 'emoji'; e: string; name: string }
  | { t: 'viewers'; n: number }
  | { t: 'state'; status: StreamStatus; startedAt: number | null; endedAt: number | null }
  | { t: 'segment'; seq: number; ms: number; at: number }
  | { t: 'lobby'; pending: LobbyEntry[] }
  | { t: 'people'; list: PersonEntry[] }
  | { t: 'log'; entry: LogEntry }
  | { t: 'config'; slow: number; reactions: boolean; maxViewers: number; quick?: string[] }
  | { t: 'milestone'; n: number }
  | { t: 'full'; max: number }
  | { t: 'notice'; text: string }
  | { t: 'pin'; text: string | null }
  | { t: 'guest'; sid: string; name: string; on: boolean }
  | { t: 'guestkey'; key: string }
  /** `iceMs`: ask again (`{t:'ice'}`) in this many ms, before the relay credentials lapse; absent: STUN only. */
  | { t: 'ice'; servers: RTCIceServer[]; iceMs?: number }
  | { t: 'rtc'; from: string; d: RtcSignal };

export const EMOJI_SET = ['❤️', '🔥', '👏', '😂', '🤯', '🎉'] as const;
