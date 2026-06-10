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
  pinned: string | null;
  viewers: number;
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

export type ServerMsg =
  | { t: 'hello'; meta: EventMeta; you: { sid: string; role: Role; name: string }; chat: ChatMsg[] }
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
  | { t: 'pin'; text: string | null };

export const EMOJI_SET = ['❤️', '🔥', '👏', '😂', '🤯', '🎉'] as const;
