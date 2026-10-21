/**
 * Family video calls, FaceTime-style, between the members of a nursery.
 *
 * The nursery's room is the family's switchboard: it rings the people asked
 * for (their open app over a lightweight 'line' socket, and a Web Push when
 * the app is closed), tracks who picked up, and relays the WebRTC handshake
 * between the people in the call — nothing else. Media goes device to device
 * (DTLS-SRTP), up to four people in a mesh; nothing is recorded.
 *
 * Only signed-in members take part — never share-link guests, and never a
 * device running as the nursery camera.
 *
 * This file is the pure call book (state + rules); monitorRoom.ts owns the
 * sockets, storage and push.
 */

export interface CallPerson {
  uid: string;
  name: string;
  label: string | null;
}

export interface CallPart extends CallPerson {
  /** The socket (device) in the call. */
  sid: string;
  at: number;
  mic: boolean;
  cam: boolean;
  /** Its connection to the room dropped at — the call goes on while it reconnects. */
  gone?: number;
}

export type CallEndWhy = 'done' | 'no_answer' | 'declined' | 'cancelled';

export interface Call {
  id: string;
  from: CallPerson;
  video: boolean;
  /** Who was asked (uids), the caller excluded. */
  invited: string[];
  declined: string[];
  at: number;
  answeredAt: number | null;
  parts: CallPart[];
  /** Everyone who has been in the call (uid → name), for the history. */
  ever: Record<string, string>;
  ended: { at: number; why: CallEndWhy } | null;
}

/** One line of the family's call history. */
export interface CallRecord {
  id: string;
  from: CallPerson;
  invited: string[];
  /** Everyone who was in it (caller included), by name. */
  joined: { uid: string; name: string }[];
  video: boolean;
  at: number;
  secs: number;
  answered: boolean;
  why: CallEndWhy;
}

/** How long a call rings before it's "no answer". */
export const RING_MS = 45_000;
/** People in one call — a mesh: each phone sends its video to every other. */
export const MAX_PARTS = 4;
export const MAX_INVITED = 8;
export const LOG_CAP = 60;
/** A device whose app lost the room this long ago has left the call. */
export const LINE_GRACE_MS = 20_000;
/** Calls kept going at once in one nursery. */
const MAX_ACTIVE = 6;

export type CallError = 'busy' | 'nobody' | 'ended' | 'full' | 'not_invited' | 'too_many';

const err = (error: CallError) => ({ error });

export class CallBook {
  private calls: Call[];

  constructor(calls: Call[] = []) {
    this.calls = calls.filter((c) => !c.ended);
  }

  toJSON(): Call[] {
    return this.calls;
  }

  get(id: string): Call | null {
    return this.calls.find((c) => c.id === id) ?? null;
  }

  /** Calls someone (uid) is part of or being rung for. */
  forUser(uid: string): Call[] {
    return this.calls.filter((c) => c.from.uid === uid || c.invited.includes(uid));
  }

  /** The earliest moment something times out — a ringing call, a device that dropped (for the room's alarm). */
  nextDeadline(): number | null {
    const due: number[] = [];
    for (const c of this.calls) {
      if (c.answeredAt == null) due.push(c.at + RING_MS);
      for (const p of c.parts) if (p.gone != null) due.push(p.gone + LINE_GRACE_MS);
    }
    return due.length ? Math.min(...due) : null;
  }

  start(caller: CallPerson & { sid: string }, to: string[], video: boolean, id: string, now: number): Call | { error: CallError } {
    if (this.calls.some((c) => c.parts.some((p) => p.sid === caller.sid))) return err('busy');
    const invited = [...new Set(to.filter((u) => typeof u === 'string' && u && u !== caller.uid))].slice(0, MAX_INVITED);
    if (!invited.length) return err('nobody');
    if (this.calls.length >= MAX_ACTIVE) return err('too_many');
    const call: Call = {
      id,
      from: { uid: caller.uid, name: caller.name, label: caller.label },
      video,
      invited,
      declined: [],
      at: now,
      answeredAt: null,
      parts: [{ uid: caller.uid, name: caller.name, label: caller.label, sid: caller.sid, at: now, mic: true, cam: video }],
      ever: { [caller.uid]: caller.name },
      ended: null,
    };
    this.calls.push(call);
    return call;
  }

  /** Pick up (or move the call to another of your devices). */
  join(id: string, p: CallPerson & { sid: string }, video: boolean, now: number): Call | { error: CallError } {
    const call = this.get(id);
    if (!call || call.ended) return err('ended');
    if (call.from.uid !== p.uid && !call.invited.includes(p.uid)) return err('not_invited');
    const others = call.parts.filter((x) => x.uid !== p.uid);
    if (others.length >= MAX_PARTS) return err('full');
    // Same person on another device: this one takes over.
    call.parts = [...others, { uid: p.uid, name: p.name, label: p.label, sid: p.sid, at: now, mic: true, cam: video }];
    call.declined = call.declined.filter((u) => u !== p.uid);
    call.ever[p.uid] = p.name;
    if (p.uid !== call.from.uid && call.answeredAt == null) call.answeredAt = now;
    return call;
  }

  /** Say no. When everyone asked has said no, the call ends. */
  decline(id: string, uid: string, now: number): Call | null {
    const call = this.get(id);
    if (!call || call.ended || !call.invited.includes(uid) || call.parts.some((p) => p.uid === uid)) return null;
    if (!call.declined.includes(uid)) call.declined.push(uid);
    if (call.answeredAt == null && call.invited.every((u) => call.declined.includes(u))) this.end(call, 'declined', now);
    return call;
  }

  /** Ring more people into a call you're in. */
  invite(id: string, bySid: string, uids: string[]): { call: Call; added: string[] } | null {
    const call = this.get(id);
    if (!call || call.ended || !call.parts.some((p) => p.sid === bySid)) return null;
    const added = [...new Set(uids)].filter((u) => u && u !== call.from.uid && !call.parts.some((p) => p.uid === u)).slice(0, MAX_INVITED);
    for (const u of added) {
      if (!call.invited.includes(u)) call.invited.push(u);
      call.declined = call.declined.filter((x) => x !== u);
    }
    if (call.invited.length > MAX_INVITED * 2) call.invited = call.invited.slice(-MAX_INVITED * 2);
    return { call, added };
  }

  setMedia(id: string, sid: string, mic: boolean, cam: boolean): Call | null {
    const call = this.get(id);
    const p = call?.parts.find((x) => x.sid === sid);
    if (!call || !p) return null;
    p.mic = mic;
    p.cam = cam;
    return call;
  }

  /** A device hung up: every call it was in that changed. */
  leave(sid: string, now: number, onlyId?: string): Call[] {
    const changed: Call[] = [];
    for (const call of this.calls) {
      if (onlyId && call.id !== onlyId) continue;
      if (this.remove(call, (p) => p.sid === sid, now)) changed.push(call);
    }
    return changed;
  }

  /**
   * A device's app lost the room (network blip, phone switching Wi-Fi). The
   * media is peer-to-peer and carries on; the device has LINE_GRACE_MS to come
   * back (join again from its new connection) before it counts as gone.
   */
  drop(sid: string, now: number): Call[] {
    const changed: Call[] = [];
    for (const call of this.calls) {
      const p = call.parts.find((x) => x.sid === sid);
      if (!p || p.gone != null) continue;
      p.gone = now;
      changed.push(call);
    }
    return changed;
  }

  /** Ringing calls nobody answered in time, and devices that never came back. */
  expire(now: number): Call[] {
    const out = new Set<Call>();
    for (const call of this.calls) {
      if (call.ended) continue;
      if (this.remove(call, (p) => p.gone != null && now - p.gone >= LINE_GRACE_MS, now)) out.add(call);
      if (!call.ended && call.answeredAt == null && now - call.at >= RING_MS) {
        this.end(call, 'no_answer', now);
        out.add(call);
      }
    }
    return [...out];
  }

  private remove(call: Call, which: (p: CallPart) => boolean, now: number): boolean {
    const before = call.parts.length;
    call.parts = call.parts.filter((p) => !which(p));
    if (call.parts.length === before) return false;
    if (call.answeredAt == null) {
      // The caller gave up (or lost the room for good) before anyone picked up.
      if (!call.parts.some((p) => p.uid === call.from.uid)) this.end(call, 'cancelled', now);
    } else if (call.parts.length <= 1) this.end(call, 'done', now);
    return true;
  }

  /** Drop finished calls from the book (after they've been announced and logged). */
  sweep(): Call[] {
    const done = this.calls.filter((c) => c.ended);
    this.calls = this.calls.filter((c) => !c.ended);
    return done;
  }

  /** Signaling may only flow between two devices in the same call. */
  canRelay(id: string, fromSid: string, toSid: string): boolean {
    const call = this.get(id);
    return !!call && !call.ended && fromSid !== toSid && call.parts.some((p) => p.sid === fromSid) && call.parts.some((p) => p.sid === toSid && p.gone == null);
  }

  private end(call: Call, why: CallEndWhy, now: number): void {
    if (!call.ended) call.ended = { at: now, why };
  }
}

/** Who should hear about a missed call: asked, never picked up, didn't say no. */
export function missedBy(call: Call): string[] {
  if (call.answeredAt != null || !call.ended || call.ended.why === 'declined') return [];
  return call.invited.filter((u) => !call.declined.includes(u));
}

export function toRecord(call: Call): CallRecord {
  const end = call.ended?.at ?? call.at;
  return {
    id: call.id,
    from: call.from,
    invited: call.invited,
    joined: Object.entries(call.ever).map(([uid, name]) => ({ uid, name })),
    video: call.video,
    at: call.at,
    secs: call.answeredAt != null ? Math.max(0, Math.round((end - call.answeredAt) / 1000)) : 0,
    answered: call.answeredAt != null,
    why: call.ended?.why ?? 'done',
  };
}
