/**
 * Direct calls — ring anyone on Stream Studio from Calls, not only the people
 * in your nurseries.
 *
 * Every member has a personal line (userLine.ts, one Durable Object per
 * member — think of it as their phone number) and every call gets its own
 * short-lived room (callRoom.ts). This file is the pure part: who may be rung
 * and how, rate limits, call tickets, and the small lists a member keeps
 * (favourites, blocked, who can call them). No platform code.
 *
 * Privacy rules (none of them need SQL):
 *  - Members only, on both ends. The caller is verified on their own line
 *    (live_me); a line rings only once its owner has claimed it with a member
 *    token of the same uid, and a claim goes stale after 30 days without a
 *    fresh sign-in, so removed accounts stop ringing.
 *  - A blocked caller — or one silenced for ringing too often — gets exactly
 *    the reply anyone else would get, at the same speed, but nothing reaches
 *    the callee (the iOS approach), so a block can't be detected. Whether the
 *    callee has an app open (or "Ring this device") is never part of the
 *    reply either: a line nobody is at rings out as "no answer", like a phone
 *    that's switched off. "Only people in my nurseries" honestly answers
 *    `restricted`.
 *  - Who the caller is comes from the server (live_me, checked again for
 *    every call), never the app. Someone added to a call is rung as the call
 *    it is — the caller — and as the person who added them: a block of either
 *    (or of anyone already in the call) silences it, and it's family only
 *    when both are.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A direct call's id: 16 hex characters (also its room's name). */
export const CALL_ID_RE = /^[0-9a-f]{16}$/;

/** A member's line is the Durable Object named after them. */
export const userLineName = (uid: string): string => `u:${uid}`;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A line whose owner hasn't signed in for this long no longer rings. */
export const CLAIM_STALE_MS = 30 * DAY;
/**
 * The owner's family (people sharing a nursery) is re-read after this long when
 * their app connects; a callee's own map older than this no longer counts when
 * they're rung (the caller's freshly read side vouches instead).
 */
export const FAMILY_TTL_MS = 10 * MINUTE;
/** Placing a call re-reads the caller's family first unless it was read this recently. */
export const FAMILY_CALL_TTL_MS = MINUTE;
/** People in one direct call besides the caller (a mesh of four). */
export const MAX_DIRECT_TO = 3;

/** Caller: calls placed per 10 minutes / per day, and different people outside the family per day. */
export const START_BURST = 8;
export const START_BURST_MS = 10 * MINUTE;
export const START_DAY = 40;
export const STRANGERS_DAY = 15;
/** Callee, per caller outside the family: rings per hour, and declines in a day after which they're silenced. */
export const RINGS_PER_HOUR = 3;
export const DECLINES_TO_SILENCE = 2;
/** Callers the callee keeps a ring history for. */
const HISTORY_CAP = 200;

export const FAVS_CAP = 24;
export const BLOCKED_CAP = 200;
export const DIRECT_LOG_CAP = 60;
export const PUSH_SUBS_CAP = 10;

export type Who = 'everyone' | 'family';
export interface DirectPrefs {
  /** Who can call me: everyone on Stream Studio (default) or only people in my nurseries. */
  who: Who;
}
export const DEFAULT_PREFS: DirectPrefs = { who: 'everyone' };

export interface PersonRec {
  uid: string;
  name: string;
  at: number;
}

/** Someone in the owner's family (shares a nursery): their label there and which family. */
export interface FamilyEntry {
  label: string | null;
  /** "Aria’s family" — the nursery as calls name it. */
  where: string;
}
export interface FamilyCache {
  at: number;
  map: Record<string, FamilyEntry>;
}

/** Who added you to a call (when it isn't the caller), and whether they're in your family. */
export interface RingBy {
  uid: string;
  name: string;
  family: boolean;
}

/** How a call reads on the callee's ring screen. */
export interface RingCtx {
  /** Everyone responsible for the ring (the caller, and whoever added you) is in your family. */
  family: boolean;
  /** The caller's label in a nursery you share ("Grandma"). */
  label: string | null;
  /** Which family ("Aria’s family"). */
  where: string | null;
  /** Added to the call by someone in it (not the caller). */
  by?: RingBy | null;
}

/** A call ringing on a member's line — what a push-opened app needs to pick up. */
export interface RingingRec {
  id: string;
  from: { uid: string; name: string };
  video: boolean;
  at: number;
  /** Lets this member's devices into the call's room. */
  ticket: string;
  ctx: RingCtx;
}

export interface CallerHistory {
  rings: number[];
  declines: number[];
}

export interface StartRate {
  starts: number[];
  /** People outside the family called (uid → last time). */
  strangers: Record<string, number>;
}

export type RingDecision = 'ring' | 'silent' | 'restricted' | 'unavailable';
/** What the caller hears back. */
export type RingStatus = 'ringing' | 'restricted' | 'unavailable';

const recent = (ts: number[], now: number, ms: number) => ts.filter((t) => now - t < ms).length;

/**
 * Should this line ring?
 *
 *  - unavailable: never claimed, or the claim went stale (the same for every caller).
 *  - restricted: the owner takes calls only from their family.
 *  - silent: blocked, or a caller outside the family ringing too often (3 an
 *    hour) or declined twice today — answered exactly like `ring`, but
 *    nothing reaches the owner.
 *  - ring: rings every open app and phone that asked to be rung — and an app
 *    opened while it rings. With none of those it simply rings out ("no
 *    answer"): whether the owner has Stream Studio open is nobody's business,
 *    and telling only unblocked callers would give a block away.
 *
 * The checks that can tell callers apart (block, history) come last, after
 * every check whose answer the caller can see, so a blocked caller always
 * gets the reply an unblocked one would.
 */
export function ringDecision(i: {
  claimed: boolean;
  verifiedAt: number;
  now: number;
  blocked: boolean;
  prefs: DirectPrefs;
  family: boolean;
  history: CallerHistory | null | undefined;
}): RingDecision {
  if (!i.claimed || i.now - i.verifiedAt > CLAIM_STALE_MS) return 'unavailable';
  if (!i.family && i.prefs.who === 'family') return 'restricted';
  if (i.blocked) return 'silent';
  if (!i.family && i.history) {
    if (recent(i.history.rings, i.now, HOUR) >= RINGS_PER_HOUR) return 'silent';
    if (recent(i.history.declines, i.now, DAY) >= DECLINES_TO_SILENCE) return 'silent';
  }
  return 'ring';
}

/** The decision as the caller hears it (silent sounds exactly like ringing). */
export const statusOf = (d: RingDecision): RingStatus => (d === 'ring' || d === 'silent' ? 'ringing' : d);

/** Several people asked: ringing if anyone rings; restricted only if everyone is family-only. */
export function overallStatus(all: RingStatus[]): RingStatus {
  if (all.includes('ringing')) return 'ringing';
  return all.length && all.every((s) => s === 'restricted') ? 'restricted' : 'unavailable';
}

/**
 * The caller's limits: 8 calls per 10 minutes, 40 a day, and 15 different
 * people outside the family a day. Returns the updated record when allowed.
 */
export function allowStart(rate: StartRate | null | undefined, now: number, strangers: string[]): { ok: boolean; rate: StartRate } {
  const starts = (rate?.starts ?? []).filter((t) => now - t < DAY);
  const known: Record<string, number> = {};
  for (const [u, t] of Object.entries(rate?.strangers ?? {})) if (now - t < DAY) known[u] = t;
  const kept = { starts, strangers: known };
  if (recent(starts, now, START_BURST_MS) >= START_BURST || starts.length >= START_DAY) return { ok: false, rate: kept };
  const next = { ...known };
  for (const u of strangers) next[u] = now;
  if (Object.keys(next).length > STRANGERS_DAY) return { ok: false, rate: kept };
  return { ok: true, rate: { starts: [...starts, now], strangers: next } };
}

/** Remember a ring (or decline) from a caller; old entries and long-gone callers fall away. */
export function noteCaller(h: Record<string, CallerHistory>, uid: string, what: 'ring' | 'decline', now: number): Record<string, CallerHistory> {
  const out: Record<string, CallerHistory> = {};
  for (const [u, x] of Object.entries(h)) {
    const rings = x.rings.filter((t) => now - t < HOUR);
    const declines = x.declines.filter((t) => now - t < DAY);
    if (rings.length || declines.length) out[u] = { rings, declines };
  }
  const cur = out[uid] ?? { rings: [], declines: [] };
  if (what === 'ring') cur.rings = [...cur.rings, now].slice(-RINGS_PER_HOUR * 2);
  else cur.declines = [...cur.declines, now].slice(-DECLINES_TO_SILENCE * 2);
  delete out[uid];
  out[uid] = cur;
  const keys = Object.keys(out);
  for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_CAP))) delete out[k];
  return out;
}

/* ------------------------------------------------------------ tickets */

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A call ticket: 24 random bytes. The call's room keeps only its hash. */
export const mintTicket = (): string => b64url(crypto.getRandomValues(new Uint8Array(24)));

export async function hashTicket(ticket: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))));
}

export const newCallId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/* --------------------------------------------------------- sanitisers */

const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);

export function cleanPerson(v: unknown): { uid: string; name: string } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const uid = clip(o.uid, 40);
  if (!UUID_RE.test(uid)) return null;
  return { uid, name: clip(o.name, 40) || 'Member' };
}

export const cleanUids = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? [...new Set(v.map((u) => clip(u, 40)).filter((u) => UUID_RE.test(u)))].slice(0, max) : [];

export function cleanPrefs(v: unknown): DirectPrefs {
  const who = v && typeof v === 'object' ? (v as Record<string, unknown>).who : null;
  return { who: who === 'family' ? 'family' : 'everyone' };
}

/** Add (on) or remove someone from a favourites / blocked list; the oldest fall off past the cap. */
export function setPerson(list: PersonRec[], p: { uid: string; name: string }, on: boolean, cap: number, now: number): PersonRec[] {
  const rest = list.filter((x) => x.uid !== p.uid);
  return on ? [...rest, { uid: p.uid, name: p.name, at: now }].slice(-cap) : rest;
}

/** A call's history line, newest last, at most `cap` (a call logged twice is replaced). */
export function appendLog<T extends { id: string }>(log: T[], rec: T, cap = DIRECT_LOG_CAP): T[] {
  return [...log.filter((r) => r.id !== rec.id), rec].slice(-cap);
}

/* ----------------------------------------------------------- family */

/** "Aria’s family" — how a nursery reads in calls. */
export const familyName = (n: { name?: string | null; baby_name?: string | null }) => (n.baby_name ? `${n.baby_name}’s family` : clip(n.name, 60) || 'Family');

/** Everyone sharing one of the owner's nurseries, from monitor_list + monitor_people. */
export function familyFrom(
  nurseries: { id: string; name?: string | null; baby_name?: string | null }[],
  people: Record<string, { user_id: string; label?: string | null; is_me?: boolean }[]>,
): Record<string, FamilyEntry> {
  const map: Record<string, FamilyEntry> = {};
  for (const n of nurseries) {
    for (const p of people[n.id] ?? []) {
      if (p.is_me || !UUID_RE.test(String(p.user_id)) || map[p.user_id]) continue;
      map[p.user_id] = { label: p.label ? clip(p.label, 40) : null, where: familyName(n) };
    }
  }
  return map;
}

/** How the ring reads: the callee's own family map wins; the caller's side vouches when it's stale. */
export function ringCtx(mine: FamilyEntry | undefined, fromCaller: { family: boolean; where: string | null }): RingCtx {
  if (mine) return { family: true, label: mine.label, where: mine.where };
  if (fromCaller.family) return { family: true, label: null, where: fromCaller.where };
  return { family: false, label: null, where: null };
}

/**
 * Who a ring is from, as the callee's line judges it.
 *
 *  - `from` is the caller; `by` whoever added the callee to the call (absent
 *    when the caller rang); `others` who's already in it. A block of any of
 *    them silences the ring, and the rate limits count against whoever rang
 *    (`ringer`).
 *  - `mine` / `mineAt` is the callee's own family map and when it was read;
 *    `vouch` / `vouchAt` what the ringing person's line said about sharing a
 *    nursery with the callee, and when *its* map was read (it's re-read for
 *    every call). The newer of the two decides for the person who rang — so
 *    someone just removed from a nursery stops counting as family even while
 *    the callee's older map still lists them — and nothing past
 *    FAMILY_TTL_MS counts at all. A vouch speaks only for the person who
 *    rang, never for someone else in the call.
 *  - It's family only when everyone responsible for the ring (the caller, and
 *    whoever added you) is.
 */
export function judgeRing(i: {
  from: { uid: string; name: string };
  by: { uid: string; name: string } | null;
  others: string[];
  mine: Record<string, FamilyEntry>;
  mineAt: number;
  now: number;
  vouch: boolean;
  /** When the ringing side's map was read (absent from an older room: then its word simply counts). */
  vouchAt?: number | null;
  where: string | null;
  blocked: PersonRec[];
}): { family: boolean; blocked: boolean; ringer: { uid: string; name: string }; ctx: RingCtx } {
  const { from, by, mine } = i;
  const fresh = (at: number) => at > 0 && i.now - at < FAMILY_TTL_MS;
  const own = (uid: string) => fresh(i.mineAt) && !!mine[uid];
  const ringer = by ?? from;
  const ringerFam =
    i.vouchAt == null ? own(ringer.uid) || i.vouch
    : fresh(i.vouchAt) && i.vouchAt >= i.mineAt ? i.vouch
    : own(ringer.uid);
  const fromFam = by ? own(from.uid) : ringerFam;
  const byFam = by ? ringerFam : true;
  const family = fromFam && byFam;
  const who = new Set([from.uid, ...(by ? [by.uid] : []), ...i.others]);
  const blocked = i.blocked.some((b) => who.has(b.uid));
  const entry = mine[from.uid];
  const base: RingCtx = family
    ? { family: true, label: entry?.label ?? null, where: entry?.where ?? (!by ? i.where : null) }
    : { family: false, label: fromFam ? entry?.label ?? null : null, where: null };
  const ctx: RingCtx = by ? { ...base, by: { uid: by.uid, name: by.name, family: byFam } } : base;
  return { family, blocked, ringer, ctx };
}

/** Who "Decline & block" blocks: whoever added you, if they're not your family; otherwise the caller. */
export function blockTarget(from: { uid: string; name: string }, ctx: Pick<RingCtx, 'by'> | null | undefined): { uid: string; name: string } {
  const by = ctx?.by;
  return by && !by.family ? { uid: by.uid, name: by.name } : { uid: from.uid, name: from.name };
}

export const NOT_FAMILY = 'Stream Studio member · not in your family';
export const ctxText = (c: RingCtx): string => (c.family ? c.where || 'Your family' : c.by && !c.by.family ? `Added by ${c.by.name} · not in your family` : NOT_FAMILY);
