// Family calls — the shapes the nursery room sends (mirror of
// live-worker/src/familyCalls.ts), and for direct calls (anyone on Stream
// Studio) the shapes a member's line sends (live-worker/src/userLine.ts). A
// direct call's own room speaks the nursery line protocol (LineMsg).

export interface CallPerson {
  uid: string;
  name: string;
  label: string | null;
}

export interface CallPart extends CallPerson {
  sid: string;
  at: number;
  mic: boolean;
  cam: boolean;
  /** Lost the room at — reconnecting. */
  gone?: number;
  /** While it was away, someone in the call still had its media at (keeps it in the call a little longer). */
  seen?: number;
}

/** How one person's connection went (sent once per call; kept in the history). */
export interface CallStat {
  /** Milliseconds from answering to connected; null if it never connected. */
  ttc: number | null;
  path: 'lan' | 'internet' | 'relay' | null;
  fail: string | null;
  /** A relay (TURN) server was on offer. */
  turn: boolean;
}

export type CallEndWhy = 'done' | 'no_answer' | 'declined' | 'cancelled';

export interface Call {
  id: string;
  from: CallPerson;
  video: boolean;
  invited: string[];
  declined: string[];
  at: number;
  answeredAt: number | null;
  parts: CallPart[];
  ever: Record<string, string>;
  ended: { at: number; why: CallEndWhy } | null;
  stats?: Record<string, CallStat & { at: number }>;
}

export interface CallRecord {
  id: string;
  from: CallPerson;
  invited: string[];
  joined: { uid: string; name: string }[];
  video: boolean;
  at: number;
  secs: number;
  answered: boolean;
  why: CallEndWhy;
  stats?: ({ uid: string } & CallStat)[];
}

export type CallError = 'busy' | 'nobody' | 'ended' | 'full' | 'not_invited' | 'too_many' | 'push' | 'unavailable' | 'restricted' | 'slow_down' | 'auth' | 'cancelled';

/** Room → a call line. */
export type LineMsg =
  | {
      t: 'hello';
      you: { sid: string; uid: string; name: string; role: string; label: string | null };
      nursery: { id: string; name: string; baby: string | null };
      ice: RTCIceServer[];
      /** Relay credentials are due for renewal in this many ms (absent: STUN only). */
      iceMs?: number;
      vapid: string | null;
      calls: Call[];
      callLog: CallRecord[];
    }
  | { t: 'call'; call: Call }
  | { t: 'call_started'; ref: string; id: string; ice?: RTCIceServer[]; iceMs?: number }
  /** To the device that just picked up: fresh relay credentials for this call. */
  | { t: 'call_joined'; id: string; ice?: RTCIceServer[]; iceMs?: number }
  /** Answering `{t:'call_ice'}` during a long call: fresh relay credentials (still the caller's). */
  | { t: 'call_ice'; id: string; ice?: RTCIceServer[]; iceMs?: number }
  | { t: 'call_err'; error: CallError; ref?: string; id?: string }
  | { t: 'call_rtc'; id: string; from: string; d: CallSignal }
  | { t: 'call_log'; rec: CallRecord }
  | { t: 'error'; code: string; msg: string }
  | { t: 'pong'; at?: number };

/**
 * The WebRTC handshake between two devices. `cid` names the connection it
 * belongs to (chosen by whoever offered it), so a fresh connection and an
 * ICE restart of the current one are never confused. `restart` asks the
 * device that offered the connection to restart it (only the offerer offers).
 * Signals from older apps carry no cid.
 */
export type CallSignal =
  | { sdp: RTCSessionDescriptionInit; cid?: string }
  | { cand: RTCIceCandidateInit; cid?: string }
  /** `renew`: their relay credentials were renewed; restart even a working connection onto them. */
  | { restart: true; renew?: true; cid?: string };

/** Most people in one call (a mesh — every phone sends to every other). */
export const MAX_IN_CALL = 4;
export const RING_SECS = 45;

export const CALL_ERROR_TEXT: Record<CallError, string> = {
  busy: 'You’re already in a call on this device.',
  nobody: 'Pick someone to call.',
  ended: 'That call has ended.',
  full: 'That call is full — four people at most.',
  not_invited: 'That call wasn’t for you.',
  too_many: 'Too many calls are going on in this nursery right now — try again in a moment.',
  push: 'This browser’s notification service isn’t supported for ringing.',
  unavailable: 'They can’t be reached on Stream Studio right now. Try again later.',
  restricted: 'They only take calls from people in their nurseries.',
  slow_down: 'You’ve placed a lot of calls just now — wait a few minutes and try again.',
  auth: 'Couldn’t confirm your account just now — try again in a moment.',
  cancelled: 'Call cancelled',
};

/** The call errors that name the person (“Sam can’t be reached right now”). */
export function callErrorText(error: CallError, who?: string | null): string {
  if (who && error === 'unavailable') return `${who} can’t be reached on Stream Studio right now. Try again later.`;
  if (who && error === 'restricted') return `${who} only takes calls from people in their nurseries.`;
  return CALL_ERROR_TEXT[error] ?? 'The call couldn’t connect.';
}

/* ------------------------------------------------------- direct calls */

/** How a direct call reads on the ring screen: from your family, or someone else on Stream Studio. */
export interface DirectCtx {
  /** Everyone behind the ring (the caller, and whoever added you) is in your family. */
  family: boolean;
  /** Their label in a nursery you share ("Grandma"). */
  label: string | null;
  /** Which family ("Aria’s family"). */
  where: string | null;
  /** Someone in the call (not the caller) added you — and whether they're in your family. */
  by?: { uid: string; name: string; family: boolean } | null;
}

export const NOT_FAMILY = 'Stream Studio member · not in your family';
export const ctxText = (c: DirectCtx | null | undefined): string =>
  c?.family ? c.where || 'Your family' : c?.by && !c.by.family ? `Added by ${c.by.name} · not in your family` : NOT_FAMILY;

/** Who “Decline & block” blocks (the line decides the same way): a stranger who added you, otherwise the caller. */
export function blockTarget(from: { uid: string; name: string }, ctx: DirectCtx | null | undefined): { uid: string; name: string } {
  const by = ctx?.by;
  return by && !by.family ? { uid: by.uid, name: by.name } : { uid: from.uid, name: from.name };
}

/** A direct call ringing for you: the ticket lets this device into the call's room. */
export interface DirectRing {
  id: string;
  from: { uid: string; name: string };
  video: boolean;
  at: number;
  ticket: string;
  ctx: DirectCtx;
}

export interface PersonRec {
  uid: string;
  name: string;
  at: number;
}

/** Who can call you directly. */
export type CallWho = 'everyone' | 'family';

/** Your line → your app. */
export type UserLineMsg =
  | {
      t: 'hello';
      you: { sid: string; uid: string; name: string };
      vapid: string | null;
      ringing: DirectRing[];
      log: CallRecord[];
      favs: PersonRec[];
      blocked: PersonRec[];
      prefs: { who: CallWho };
    }
  | { t: 'dcall_ring'; ring: DirectRing }
  /** Picked up on another of your devices, declined, or over: stop ringing. */
  | { t: 'dcall_update'; id: string; stop?: boolean }
  | { t: 'dcall_started'; ref: string; id: string; ticket: string; status: 'ringing' }
  | { t: 'dcall_invited'; id: string; status: 'ringing' | 'unavailable' | 'restricted' | 'slow_down' }
  | { t: 'dcall_state'; favs: PersonRec[]; blocked: PersonRec[]; prefs: { who: CallWho } }
  | { t: 'call_err'; error: CallError; ref?: string; id?: string }
  | { t: 'call_log'; rec: CallRecord }
  | { t: 'error'; code: string; msg: string }
  | { t: 'pong'; at?: number };
