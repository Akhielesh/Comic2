/**
 * Client-side mirror of the live-worker EventRoom protocol.
 * (Deliberately duplicated — the worker compiles under its own tsconfig with
 * workers-types; keep the two in sync when the protocol changes.)
 */

export type Role = 'host' | 'mod' | 'viewer' | 'pending';
export type StreamStatus = 'idle' | 'live' | 'paused' | 'ended';

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
  viewers: number;
  rsvpCount: number;
  rsvpNames: string[];
}

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
}

export interface StatsResponse {
  meta: EventMeta;
  stats: EventStats;
  log: LogEntry[];
  topChatters: { name: string; count: number }[];
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
  | { t: 'config'; slow: number; reactions: boolean }
  | { t: 'milestone'; n: number }
  | { t: 'pin'; text: string | null };

export const EMOJI_SET = ['❤️', '🔥', '👏', '😂', '🤯', '🎉'] as const;
