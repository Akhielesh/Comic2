// The Director's turn outlives one mounted studio (liveturn LT-2; NOTIFY §5.8 "detached stream holder").
//
// App renders Comic Studio only while the view is the studio (keyed by account and comic), so Settings, My comics,
// Chat or another comic unmount it. Until now the unmount aborted the Director's message stream and every action
// stream, and the thinking (the reply so far, the step list) lived only in the unmounted reducer: back in the comic,
// nothing showed until the reply landed, and nothing told anyone when it did. This module is the one page-scope owner
// of those streams (the same pattern as services/chatStreams.ts), never persisted and never sent anywhere:
//
//   - Every message and action stream a studio starts is registered here (`begin`), every event passes through here
//     (`event`) and its end too (`end`). Patch streams (silent saves) are not: they flush on unmount as before.
//   - Each comic has a small MIRROR of its live work, folded with the studio's own pure reducer (studioReducer), so the
//     mirror and the studio can never read an event differently: the doc as the server committed it, the reply so far
//     (≤ LIVE_LIMITS.draftChars per message, tail kept), the step list (≤ LIVE_LIMITS.activity, live steps kept), the
//     streams with their `replied` flags, the pending bubble, presence and signed URLs. It is dropped when the comic's
//     last stream ends and no view is opening it.
//   - Events reach the reducer of the view that owns the stream (its "sink"). When the studio unmounts it `detach`es:
//     the streams keep reading, owned by nobody, and only the mirror hears them. A studio that mounts for the same comic
//     `claim`s it and, once its doc has loaded, `subscribe`s: it gets the mirror as a snapshot to adopt
//     (studioReducer `streams_adopt`) and owns the streams from then on, so everything after reaches it exactly once.
//   - At most LIVE_LIMITS.detachedComics comics are held with nobody watching; leaving a fourth aborts the oldest
//     comic's streams (the server keeps working; LT-3 re-attaches on return). Patch streams are never held.
//   - Accounts: entries are keyed `${accountId}:${projectId}`. A claim under another account, a sign-out or another
//     account signing in on this tab (`noteStudioAccount`) aborts and drops every entry of the old account, so a
//     shared device never keeps or announces the previous person's comic.
//   - MOMENTS (the NOTIFY §7 contract; services/alerts subscribes, nothing here imports it): `subscribeStudioMoments`
//     hears `replied` once per message stream (the turn's first new assistant message: "the Director replied") and
//     `settled` once per message or action stream at its end ("the work settled": `outcome` says done / failed /
//     stopped / lost / busy, `error` carries the stream's own words and code). Each moment carries the doc at the
//     stream's start (`before`) and now (`after`), so the listener reads "needs you" (an open gate, a question, a plan
//     waiting for its OK) from `after` itself. The payload is the same whether a studio was mounted or not; a listener
//     that wants quiet while the comic is on screen decides that itself.
//
// No network, no timers: it only reacts to streams the person already started, which end at the server's `done`, so
// the backend container sleeps exactly as before.

import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioEvent } from '../../../shared/comic/events';
import type { QueuedNote } from '../messageQueue';
import type { ActivityItem } from '../types';
import {
  initialStudioState,
  studioReducer,
  type PendingUserMessage,
  type PresenceEntry,
  type StreamInfo,
  type StudioReducerAction,
  type StudioState,
  type UrlEntry
} from '../studioReducer';

export const LIVE_LIMITS = Object.freeze({
  /** Comics whose streams are held while no studio shows them; one more aborts the oldest. */
  detachedComics: 3,
  /** The reply so far kept per message (the tail; the committed reply replaces it when it lands). */
  draftChars: 8_000,
  /** Steps kept in the mirror (live steps first, then the newest finished ones). */
  activity: 12
});

/** The streams this registry holds: the Director's turns and actions. Patch streams are not live work. */
export type LiveStreamKind = 'message' | 'action';

/** Where a stream's events go while a studio shows it: that studio's guarded dispatch. */
export type StudioSink = (action: StudioReducerAction) => void;

/** The registry key of one comic of one account. Account ids are compared lowercase. */
export const studioStreamKey = (accountId: string | null | undefined, projectId: string): string =>
  `${(accountId || '').toLowerCase()}:${projectId}`;

const splitKey = (key: string): { accountId: string; projectId: string } => {
  const i = key.indexOf(':');
  return i < 0 ? { accountId: '', projectId: key } : { accountId: key.slice(0, i), projectId: key.slice(i + 1) };
};

export interface BeginInput {
  streamId: string;
  kind: LiveStreamKind;
  actionType?: string;
  ctrl: AbortController;
  /** The doc the studio had when the stream started (server-confirmed): the moments' `before`. */
  before: ComicDoc | null;
  /** The studio that started it; absent = the comic's subscribed studio, if any. */
  sink?: StudioSink;
  /** The user's message bubble this stream carries (message streams), kept until the server records it. */
  pending?: PendingUserMessage | null;
}

/** How a stream ended, as runStream saw it. */
export interface StreamEndInput {
  /** The transport's failure (the stream's own `error` event is read from the mirror). */
  error?: string;
  code?: string;
  aborted?: boolean;
  /** The connection dropped (45 s of silence or an early close): the server may still finish the work. */
  lost?: boolean;
}

export type StudioMomentPhase = 'replied' | 'settled';
/** How settled work ended. `busy`: the server's turn lock was held elsewhere (the notes went back to Up next). */
export type StudioMomentOutcome = 'done' | 'failed' | 'stopped' | 'lost' | 'busy';

export interface StudioMoment {
  accountId: string;
  projectId: string;
  streamId: string;
  streamKind: LiveStreamKind;
  actionType?: string;
  phase: StudioMomentPhase;
  /** The doc when the stream started. */
  before: ComicDoc | null;
  /** The doc now, as the server committed it (read "needs you" from here). */
  after: ComicDoc | null;
  /** `settled` only. */
  outcome?: StudioMomentOutcome;
  /** `settled` only: what went wrong, in the stream's own (already calm) words, with the server code. */
  error?: { message: string; code?: string };
  /** The server's turn id from the stream's `hello` (the same on any later attach: dedupe on it). */
  turnId?: string;
}

export type StudioMomentListener = (moment: StudioMoment) => void;

/** What a studio opening a comic adopts: the live work as the mirror holds it. */
export interface StreamsAdoptSnapshot {
  /** The streams it now owns (studioReducer StreamInfo, with `replied`). */
  streams: StreamInfo[];
  /** Their controllers (Stop's local fallback and a project switch abort through them). */
  controllers: Array<{ id: string; kind: LiveStreamKind; ctrl: AbortController }>;
  drafts: Record<string, string>;
  activity: ActivityItem[];
  presence: PresenceEntry[];
  /** The doc as the streams committed it (newer than a GET that raced the stream, or older: the reducer takes the newer). */
  doc: ComicDoc | null;
  urls: Record<string, UrlEntry>;
  pendingMessage: PendingUserMessage | null;
  /** Notes a BUSY answer put back while nobody watched (offered as held, never auto-sent). */
  notes: QueuedNote[];
  /** The adopted message stream whose reply has not landed (the composer waits for it), or null. */
  awaitingReply: string | null;
}

interface StreamRec {
  id: string;
  kind: LiveStreamKind;
  actionType?: string;
  ctrl: AbortController;
  before: ComicDoc | null;
  sink: StudioSink | null;
  turnId?: string;
  repliedSaid: boolean;
}

interface Entry {
  key: string;
  accountId: string;
  projectId: string;
  streams: Map<string, StreamRec>;
  mirror: StudioState | null;
  /** The studio showing this comic (new streams default to it), or null. */
  sink: StudioSink | null;
  /** Studios mounted for this comic (claims minus detaches). */
  views: number;
  /** Order in which it was left with nobody watching (0 = watched). */
  detachedSeq: number;
}

const entries = new Map<string, Entry>();
const momentListeners = new Set<StudioMomentListener>();
const changeListeners = new Set<() => void>();
let detachSeq = 0;
let version = 0;
let workingSnapshot: ReadonlySet<string> = new Set();
/** The account auth last reported for this tab (undefined = not heard yet). */
let signedInAs: string | null | undefined;

// ── Change notification (useSyncExternalStore) ───────────────────────────────

const refreshWorking = (): void => {
  const next = new Set<string>();
  for (const e of entries.values()) if (e.streams.size) next.add(e.key);
  const prev = workingSnapshot;
  if (next.size === prev.size && [...next].every((k) => prev.has(k))) return;
  workingSnapshot = next;
  version += 1;
  for (const fn of Array.from(changeListeners)) {
    try {
      fn();
    } catch {
      /* a listener never breaks a stream */
    }
  }
};

/** Subscribe to changes of the set of comics with live work. Returns the unsubscribe. */
export const subscribeStudioStreams = (fn: () => void): (() => void) => {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
};

/** A number that changes whenever workingKeys() does. */
export const getStudioStreamsVersion = (): number => version;

/** Keys (studioStreamKey) of the comics with a message or action stream open in this tab. The same Set until it changes. */
export const workingKeys = (): ReadonlySet<string> => workingSnapshot;

// ── Moments ──────────────────────────────────────────────────────────────────

/** Hear `replied` and `settled` for every comic of this tab, mounted or not. Returns the unsubscribe. */
export const subscribeStudioMoments = (fn: StudioMomentListener): (() => void) => {
  momentListeners.add(fn);
  return () => {
    momentListeners.delete(fn);
  };
};

const say = (moment: StudioMoment): void => {
  for (const fn of Array.from(momentListeners)) {
    try {
      fn(moment);
    } catch {
      /* a listener never breaks a stream */
    }
  }
};

const momentOf = (entry: Entry, rec: StreamRec, phase: StudioMomentPhase, extra: Partial<StudioMoment> = {}): StudioMoment => ({
  accountId: entry.accountId,
  projectId: entry.projectId,
  streamId: rec.id,
  streamKind: rec.kind,
  ...(rec.actionType ? { actionType: rec.actionType } : {}),
  phase,
  before: rec.before,
  after: entry.mirror?.base ?? null,
  ...(rec.turnId ? { turnId: rec.turnId } : {}),
  ...extra
});

const outcomeOf = (input: StreamEndInput, errored: { message: string; code?: string } | undefined): StudioMomentOutcome => {
  if (input.aborted) return 'stopped';
  const code = input.code ?? errored?.code;
  if (code === 'CANCELLED') return 'stopped';
  if (code === 'BUSY') return 'busy';
  if (input.lost || code === 'connection_lost') return 'lost';
  return input.error || errored ? 'failed' : 'done';
};

// ── The mirror ───────────────────────────────────────────────────────────────

const now = (): number => Date.now();

/** Live steps always; then the newest finished ones, up to LIVE_LIMITS.activity, in their order. */
const capActivity = (list: ActivityItem[]): ActivityItem[] => {
  if (list.length <= LIVE_LIMITS.activity) return list;
  const live = list.filter((a) => a.phase === 'start').length;
  let doneRoom = Math.max(0, LIVE_LIMITS.activity - live);
  const keep = new Set<ActivityItem>();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const a = list[i];
    if (a.phase === 'start') keep.add(a);
    else if (doneRoom > 0) {
      keep.add(a);
      doneRoom -= 1;
    }
  }
  return list.filter((a) => keep.has(a)).slice(-Math.max(LIVE_LIMITS.activity, live));
};

const capDrafts = (drafts: Record<string, string>): Record<string, string> => {
  let next: Record<string, string> | null = null;
  for (const [id, text] of Object.entries(drafts)) {
    if (text.length <= LIVE_LIMITS.draftChars) continue;
    next = next ?? { ...drafts };
    next[id] = text.slice(-LIVE_LIMITS.draftChars);
  }
  return next ?? drafts;
};

const fold = (mirror: StudioState, action: StudioReducerAction): StudioState => {
  let next: StudioState;
  try {
    next = studioReducer(mirror, action);
  } catch {
    return mirror; // the view folds the same event with the same reducer; the mirror never stops the stream
  }
  const activity = capActivity(next.activity);
  const drafts = capDrafts(next.drafts);
  return activity === next.activity && drafts === next.drafts ? next : { ...next, activity, drafts };
};

const freshMirror = (before: ComicDoc | null): StudioState => ({
  ...initialStudioState(),
  loading: false,
  base: before,
  doc: before,
  behindRev: before?.rev ?? 0
});

/** The doc the mirror folds onto follows the newest server-confirmed copy a studio had (fills a gap, never regresses). */
const withNewerBase = (mirror: StudioState, base: ComicDoc | null | undefined): StudioState =>
  base && (!mirror.base || (mirror.base.id === base.id && base.rev > mirror.base.rev))
    ? fold(mirror, { type: 'refresh_success', doc: base, now: now() })
    : mirror;

const ensure = (key: string): Entry => {
  let entry = entries.get(key);
  if (!entry) {
    const { accountId, projectId } = splitKey(key);
    entry = { key, accountId, projectId, streams: new Map(), mirror: null, sink: null, views: 0, detachedSeq: 0 };
    entries.set(key, entry);
  }
  return entry;
};

/** Forget an entry with no work: kept only while a studio holds the comic (and, while it loads, its last mirror). */
const settleEntry = (entry: Entry): void => {
  if (entry.streams.size) return;
  entry.detachedSeq = 0;
  if (entry.views <= 0) {
    entries.delete(entry.key);
    return;
  }
  // A studio shows it: the studio has all of it, the mirror goes. A studio still loading keeps the mirror's doc for
  // its adopt (its GET may have been answered before the last commit landed).
  if (entry.sink) entry.mirror = null;
};

/** Abort every stream of an entry and drop it. A studio still showing it is told each stream ended. */
const abortEntry = (entry: Entry): void => {
  entries.delete(entry.key);
  for (const rec of entry.streams.values()) {
    try {
      rec.sink?.({ type: 'stream_end', streamId: rec.id, aborted: true, now: now() });
    } catch {
      /* the view is gone */
    }
    try {
      rec.ctrl.abort();
    } catch {
      /* already aborted */
    }
  }
  entry.streams.clear();
  entry.mirror = null;
};

const enforceDetachedCap = (): void => {
  const held = [...entries.values()].filter((e) => e.views <= 0 && e.streams.size > 0).sort((a, b) => a.detachedSeq - b.detachedSeq);
  while (held.length > LIVE_LIMITS.detachedComics) abortEntry(held.shift()!);
};

// ── Streams ──────────────────────────────────────────────────────────────────

/** A studio started a message or action stream for this comic. */
export const begin = (key: string, input: BeginInput): void => {
  if (!input || !input.streamId || (input.kind !== 'message' && input.kind !== 'action')) return;
  const entry = ensure(key);
  const rec: StreamRec = {
    id: input.streamId,
    kind: input.kind,
    ...(input.actionType ? { actionType: input.actionType } : {}),
    ctrl: input.ctrl,
    before: input.before ?? null,
    sink: input.sink ?? entry.sink,
    repliedSaid: false
  };
  entry.streams.set(rec.id, rec);
  let mirror = entry.mirror ? withNewerBase(entry.mirror, input.before) : freshMirror(input.before ?? null);
  mirror = fold(mirror, { type: 'stream_start', streamId: rec.id, kind: rec.kind, ...(rec.actionType ? { actionType: rec.actionType } : {}), now: now() });
  if (rec.kind === 'message' && input.pending && input.pending.streamId === rec.id) mirror = fold(mirror, { type: 'message_pending', message: input.pending });
  entry.mirror = mirror;
  refreshWorking();
};

/** One event of a registered stream: folded into the mirror, then handed to the studio that owns the stream. */
export const event = (key: string, streamId: string, e: StudioEvent): void => {
  const entry = entries.get(key);
  const rec = entry?.streams.get(streamId);
  if (!entry || !rec || !e || typeof e !== 'object') return;
  if (e.type === 'hello' && typeof e.turnId === 'string' && e.turnId) rec.turnId = e.turnId.slice(0, 120);
  const at = now();
  if (entry.mirror) entry.mirror = fold(entry.mirror, { type: 'stream_event', streamId, event: e, now: at });
  try {
    rec.sink?.({ type: 'stream_event', streamId, event: e, now: at });
  } catch {
    /* a view bug never stops the stream */
  }
  // "The Director replied": the reducer marks every message stream still waiting once a new reply lands.
  const streams = entry.mirror?.streams;
  if (!streams) return;
  for (const r of entry.streams.values()) {
    if (r.kind !== 'message' || r.repliedSaid || !streams[r.id]?.replied) continue;
    r.repliedSaid = true;
    say(momentOf(entry, r, 'replied'));
  }
};

/** A registered stream ended (its `finally`): the studio that owns it hears `stream_end`, listeners hear `settled`. */
export const end = (key: string, streamId: string, input: StreamEndInput = {}): void => {
  const entry = entries.get(key);
  const rec = entry?.streams.get(streamId);
  if (!entry || !rec) return;
  const info = entry.mirror?.streams[streamId];
  const errored = info?.errored ? { message: info.errored, ...(info.erroredCode ? { code: info.erroredCode } : {}) } : undefined;
  const action: Extract<StudioReducerAction, { type: 'stream_end' }> = {
    type: 'stream_end',
    streamId,
    ...(input.error ? { error: input.error } : {}),
    ...(input.code ? { code: input.code } : {}),
    aborted: !!input.aborted,
    now: now()
  };
  if (entry.mirror) entry.mirror = fold(entry.mirror, action);
  entry.streams.delete(streamId);
  try {
    rec.sink?.(action);
  } catch {
    /* the view is gone */
  }
  const error = input.error ? { message: input.error, ...(input.code ? { code: input.code } : {}) } : errored;
  say(momentOf(entry, rec, 'settled', { outcome: outcomeOf(input, errored), ...(error && !input.aborted ? { error } : {}) }));
  settleEntry(entry);
  refreshWorking();
};

// ── Studios mounting and leaving ─────────────────────────────────────────────

/**
 * A studio mounted for this comic. Every entry of another account is aborted and dropped first (a shared device), and
 * the comic counts as watched (never aborted for the detached cap) until the studio detaches.
 */
export const claim = (key: string): void => {
  const { accountId } = splitKey(key);
  let dropped = false;
  for (const e of [...entries.values()]) {
    if (e.accountId === accountId) continue;
    abortEntry(e);
    dropped = true;
  }
  const entry = ensure(key);
  entry.views += 1;
  entry.detachedSeq = 0;
  if (dropped) refreshWorking();
};

/**
 * The studio's doc has loaded: it owns this comic's unowned streams from now on, and gets what they did meanwhile to
 * adopt (null when there was nothing). Call it and dispatch the snapshot in the same tick, so no event falls between.
 */
export const subscribe = (key: string, sink: StudioSink): StreamsAdoptSnapshot | null => {
  const entry = ensure(key);
  entry.sink = sink;
  const mirror = entry.mirror;
  const taken: StreamRec[] = [];
  for (const rec of entry.streams.values()) {
    if (rec.sink) continue;
    rec.sink = sink;
    taken.push(rec);
  }
  if (!mirror) return null;
  const ids = new Set(taken.map((r) => r.id));
  const streams = taken.map((r) => mirror.streams[r.id]).filter((s): s is StreamInfo => !!s);
  const pending = mirror.pendingMessage;
  const snapshot: StreamsAdoptSnapshot = {
    streams,
    controllers: taken.map((r) => ({ id: r.id, kind: r.kind, ctrl: r.ctrl })),
    drafts: { ...mirror.drafts },
    activity: mirror.activity.slice(),
    presence: (mirror.presence ?? []).filter((p) => p.streamIds.some((id) => ids.has(id))),
    doc: mirror.base,
    urls: mirror.urls,
    pendingMessage: pending && (!pending.streamId || ids.has(pending.streamId) || pending.status === 'failed') ? pending : null,
    notes: mirror.queue?.notes ? mirror.queue.notes.slice() : [],
    awaitingReply: streams.find((s) => s.kind === 'message' && !s.replied)?.id ?? null
  };
  // Handed over once: the mirror keeps folding for the moments, but its notes and bubble now live in the studio.
  if (snapshot.notes.length || snapshot.pendingMessage) entry.mirror = { ...mirror, queue: undefined, pendingMessage: null };
  settleEntry(entry);
  return snapshot;
};

/**
 * The studio showing this comic unmounted (or switched comic). Its streams keep running, owned by nobody; when more
 * than LIVE_LIMITS.detachedComics comics are left like that, the oldest one's streams are aborted.
 */
export const detach = (key: string, sink?: StudioSink): void => {
  const entry = entries.get(key);
  if (!entry) return;
  entry.views = Math.max(0, entry.views - 1);
  if (!sink || entry.sink === sink) entry.sink = null;
  for (const rec of entry.streams.values()) if (!sink || rec.sink === sink) rec.sink = null;
  if (!entry.streams.size) {
    settleEntry(entry);
    return;
  }
  if (entry.views <= 0) {
    entry.detachedSeq = ++detachSeq;
    enforceDetachedCap();
    refreshWorking();
  }
};

/** Keep the mirror's doc no older than the studio's own server-confirmed copy (a refetch filled a gap). */
export const syncMirror = (key: string, base: ComicDoc | null | undefined): void => {
  const entry = entries.get(key);
  if (!entry?.mirror || !entry.streams.size || !base) return;
  entry.mirror = withNewerBase(entry.mirror, base);
};

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Abort every stream of every comic (sign-out). */
export const abortAllStudioStreams = (): void => {
  if (!entries.size) return;
  for (const e of [...entries.values()]) abortEntry(e);
  refreshWorking();
};

/**
 * The account this tab acts as now (from the auth state; null when signed out). A change aborts and drops every entry
 * of any other account; signing out drops them all. The same account again (a token refresh) changes nothing.
 */
export const noteStudioAccount = (accountId: string | null | undefined): void => {
  const id = accountId ? accountId.toLowerCase() : null;
  if (signedInAs !== undefined && id !== signedInAs) {
    let dropped = false;
    for (const e of [...entries.values()]) {
      if (id !== null && e.accountId === id) continue;
      abortEntry(e);
      dropped = true;
    }
    if (dropped) refreshWorking();
  }
  signedInAs = id;
};

// ── Tests ────────────────────────────────────────────────────────────────────

/** Test-only: how much is held. */
export const __studioStreamsStatsForTests = (): { entries: number; streams: number; mirrors: number; detached: number } => {
  let streams = 0;
  let mirrors = 0;
  let detached = 0;
  for (const e of entries.values()) {
    streams += e.streams.size;
    if (e.mirror) mirrors += 1;
    if (e.views <= 0 && e.streams.size) detached += 1;
  }
  return { entries: entries.size, streams, mirrors, detached };
};

/** Test-only: forget everything (module state outlives a test's renders; tests/setup.ts calls it after each test). */
export const __resetStudioStreamsForTests = (): void => {
  entries.clear();
  momentListeners.clear();
  changeListeners.clear();
  detachSeq = 0;
  version = 0;
  workingSnapshot = new Set();
  signedInAs = undefined;
};

if (import.meta.env.MODE === 'test') {
  (globalThis as { __resetStudioStreamsForTests?: () => void }).__resetStudioStreamsForTests = __resetStudioStreamsForTests;
}
