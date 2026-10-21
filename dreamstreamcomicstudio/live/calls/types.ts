// Family calls — the shapes the nursery room sends (mirror of
// live-worker/src/familyCalls.ts).

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
}

export type CallError = 'busy' | 'nobody' | 'ended' | 'full' | 'not_invited' | 'too_many' | 'push';

/** Room → a call line. */
export type LineMsg =
  | {
      t: 'hello';
      you: { sid: string; uid: string; name: string; role: string; label: string | null };
      nursery: { id: string; name: string; baby: string | null };
      ice: RTCIceServer[];
      vapid: string | null;
      calls: Call[];
      callLog: CallRecord[];
    }
  | { t: 'call'; call: Call }
  | { t: 'call_started'; ref: string; id: string }
  | { t: 'call_err'; error: CallError; ref?: string; id?: string }
  | { t: 'call_rtc'; id: string; from: string; d: CallSignal }
  | { t: 'call_log'; rec: CallRecord }
  | { t: 'error'; code: string; msg: string }
  | { t: 'pong'; at: number };

export type CallSignal = { sdp: RTCSessionDescriptionInit } | { cand: RTCIceCandidateInit };

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
};
