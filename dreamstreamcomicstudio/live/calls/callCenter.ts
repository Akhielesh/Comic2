/**
 * Family calls, app side. One store for the whole app:
 *
 *  - While you're signed in (and this device isn't busy being a nursery
 *    camera) it keeps a light 'line' connection to each of your nurseries'
 *    rooms, so a call rings wherever Stream Studio is open.
 *  - With "Ring this device" on, the room also sends a Web Push, so the call
 *    rings with the app closed (Android, desktop; iPhone from the Home Screen).
 *  - It runs the one active call: your camera + mic, the mesh to everyone
 *    else (callMesh.ts), mute / camera / flip, and what happened at the end.
 *  - Speed: answering joins the call and sends the offer at once while the
 *    camera opens in parallel (its tracks slot in with replaceTrack), and a
 *    connection is made ahead of time while the call rings.
 *  - Honesty: a call that can't connect says why within 15 s and offers Try
 *    again; lines ping faster while ringing or in a call and reconnect as soon
 *    as they stop hearing the room.
 *  - Direct calls (anyone on Stream Studio, found by name in Calls): one more
 *    socket to your personal line (live-worker userLine.ts), which places
 *    calls, rings you, and keeps your favourites, blocks and direct-call
 *    history. Each direct call has its own room, reached with a ticket from
 *    your line; it's just another line here, keyed `d:<call id>`, so the call
 *    itself runs exactly like a family call. Your line is never left closed:
 *    it's reopened when back online, on every refresh and when you place a
 *    call. Favourite / block / "who can call me" changes made while it's
 *    down are kept (across reloads too) and replayed after its hello; a call
 *    hung up before it got going is cancelled for real, not left ringing.
 *  - Media opened after a call ended (an Unmute whose permission prompt was
 *    still up, a camera turned on as it ended) is stopped at once.
 *
 * Views read it with useCalls(); nothing here renders.
 */

import { useSyncExternalStore } from 'react';
import { accessToken } from '../account';
import { LIVE_APP_PATH } from '../host';
import { MIC_CONSTRAINTS, preferSpeaker, type Facing } from '../monitor/camera';
import { listNurseries, onMembersChanged, openCallRoomSocket, openMonitorSocket, openUserLineSocket, type MonitorSocket } from '../monitor/client';
import { currentSubscription, localNotify, subscribe as pushSubscribe } from '../monitor/push';
import { ScreenWakeLock } from '../wakeLock';
import { CallMesh, failureText, pcConfig, type FailWhy, type PeerView } from './callMesh';
import {
  blockTarget,
  callErrorText,
  ctxText,
  RING_SECS,
  type Call,
  type CallEndWhy,
  type CallPart,
  type CallRecord,
  type CallSignal,
  type CallWho,
  type DirectCtx,
  type DirectRing,
  type LineMsg,
  type PersonRec,
  type UserLineMsg,
} from './types';

interface Line {
  nid: string;
  sock: MonitorSocket;
  connected: boolean;
  me: { sid: string; uid: string; name: string; label: string | null } | null;
  nursery: { id: string; name: string; baby: string | null } | null;
  ice: RTCIceServer[];
  /** When the line's hello brought those ICE servers. */
  iceAt: number;
  helloAt: number;
  vapid: string | null;
}

export type ActiveState = 'starting' | 'calling' | 'connecting' | 'slow' | 'connected' | 'failed' | 'ended';

interface Active {
  nid: string;
  id: string | null;
  ref: string;
  outgoing: boolean;
  /** The call was placed as a video call. */
  video: boolean;
  call: Call | null;
  local: MediaStream;
  mic: boolean;
  cam: boolean;
  facing: Facing;
  mesh: CallMesh | null;
  ended: { why: CallEndWhy | 'error'; text: string } | null;
  /** Who we asked (for "Calling Grandma…" before the room answers). */
  asked: { uid: string; name: string }[];
  /** Fresh ICE servers for this call (call_started / call_joined), else the line's. */
  ice: RTCIceServer[] | null;
  relayOnly: boolean;
  /** Our socket id in the call, and whether the room has confirmed it. */
  mySid: string | null;
  inRoom: boolean;
  /** The camera / mic are still opening (answering doesn't wait for them). */
  opening: boolean;
  /** A mic that couldn't open when answering is being opened now (from Unmute). */
  micOpening?: boolean;
  /** The last connection outcome told to the room (telemetry). */
  reported: string | null;
  rejoinAt: number;
}

export interface Ringing {
  nid: string;
  nursery: string;
  call: Call;
  /** A direct call: whether it's from your family (and as whom), or someone else on Stream Studio. */
  direct: DirectCtx | null;
}

export interface ActiveView {
  nid: string;
  nursery: string;
  id: string | null;
  outgoing: boolean;
  video: boolean;
  state: ActiveState;
  call: Call | null;
  peers: PeerView[];
  local: MediaStream;
  mic: boolean;
  cam: boolean;
  canFlip: boolean;
  /** The self view is mirrored for the front camera. */
  facing: Facing;
  ended: { why: CallEndWhy | 'error'; text: string } | null;
  asked: { uid: string; name: string }[];
  /** Answered at (local clock), for the timer. */
  since: number | null;
  /** Why it couldn't connect (state 'failed'), in words. */
  failText: string | null;
  why: FailWhy | null;
  /** This phone's encoder can't keep up — its video is being lowered. */
  busy: boolean;
  /** Relay test mode (?relay=1): media may only go through the relay. */
  relayTest: boolean;
}

export interface CallsSnapshot {
  on: boolean;
  uid: string | null;
  /** Nursery lines (family calls). */
  lines: { nid: string; name: string; baby: string | null; connected: boolean }[];
  /** Your personal line is up: direct calls can be placed and received. */
  directReady: boolean;
  ringing: Ringing[];
  active: ActiveView | null;
  /** Family and direct calls together, newest first (direct ones have nid 'direct'). */
  log: (CallRecord & { nid: string; nursery: string })[];
  ringOn: boolean;
  favs: PersonRec[];
  blocked: PersonRec[];
  /** Who can call you directly. */
  who: CallWho;
  /** Something to tell you (e.g. the person you added can't be reached), newest wins. */
  notice: { text: string; at: number } | null;
}

const RING_KEY = 'ds-call-ring';
/** Names of people you've called directly (a call nobody picked up carries no name for them). */
const NAMES_KEY = 'ds-call-names';
const NAMES_CAP = 200;
const RELAY_KEY = 'ds-calls-relay';
/** A line this quiet may be dead (a network change can leave a socket OPEN): check it before a call. */
const SILENT_MS = 30_000;
/** Relay credentials from a line's hello stay good for 3 h 35 min+ (live-worker/src/ice.ts: ≤ 4 h); refresh before then. */
const ICE_MAX_AGE_MS = 3 * 60 * 60_000;
/** While connected, tell the room every 10 s whose media still reaches us. */
const VOUCH_MS = 10_000;
/** A call hung up before it got going is cancelled for real when its start is heard of within this long. */
const CANCEL_MS = 60_000;
/** Changes to your favourites, blocks and "who can call me" your line hasn't confirmed yet (per account). */
const PENDING_KEY = 'ds-call-pending';
const PENDING_CAP = 50;

/** A change to the lists your line keeps for you. */
type ListOp = { t: 'fav' | 'block'; uid: string; name: string; on: boolean } | { t: 'prefs'; who: CallWho };
const opKey = (op: ListOp): string => (op.t === 'prefs' ? 'prefs' : `${op.t}:${op.uid}`);
function cleanOp(v: unknown): ListOp | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.t === 'prefs') return o.who === 'family' || o.who === 'everyone' ? { t: 'prefs', who: o.who } : null;
  if ((o.t === 'fav' || o.t === 'block') && typeof o.uid === 'string' && typeof o.name === 'string' && typeof o.on === 'boolean') return { t: o.t, uid: o.uid, name: o.name, on: o.on };
  return null;
}

/** "Aria’s family" — how a nursery reads in calls. */
export const familyName = (n: { name: string; baby: string | null } | null | undefined) => (n?.baby ? `${n.baby}’s family` : n?.name ?? 'Family');
const newRef = () => Math.random().toString(36).slice(2, 10);

/** Relay test mode: `?relay=1` on the page (kept for this tab) or the `ds-calls-relay` setting. */
export function relayOnly(): boolean {
  try {
    const q = location.hash.indexOf('?');
    const on = new URLSearchParams(location.search).get('relay') === '1' || (q >= 0 && new URLSearchParams(location.hash.slice(q + 1)).get('relay') === '1');
    if (on) sessionStorage.setItem(RELAY_KEY, '1');
    return on || sessionStorage.getItem(RELAY_KEY) === '1' || localStorage.getItem(RELAY_KEY) === '1';
  } catch {
    return false;
  }
}

/** Where a call stands, from what the room said and how each connection is doing. */
export function deriveActiveState(a: { ended: unknown; id: string | null; call: Call | null; outgoing: boolean }, peers: Pick<PeerView, 'state'>[]): ActiveState {
  if (a.ended) return 'ended';
  if (!a.id || !a.call) return a.outgoing ? 'calling' : 'starting';
  if (peers.some((p) => p.state === 'connected')) return 'connected';
  if (a.outgoing && a.call.answeredAt == null) return 'calling';
  if (peers.length && peers.every((p) => p.state === 'failed')) return 'failed';
  if (peers.some((p) => p.state === 'slow' || p.state === 'failed')) return 'slow';
  return 'connecting';
}

/** Why the call as a whole couldn't connect, in words (null unless every connection failed). */
export function callFailText(peers: Pick<PeerView, 'state' | 'why' | 'label' | 'name'>[]): string | null {
  const failed = peers.filter((p) => p.state === 'failed');
  if (!peers.length || failed.length !== peers.length) return null;
  const first = failed[0];
  return failureText(first.why, first.label || first.name);
}

/** Where the service worker leaves its one-time proof that "Answer" was tapped on a call notification (public/live-sw.js). */
export const ANSWER_CACHE = 'ds-sw-state';
export const ANSWER_KEY = '/__ds/answer/';
/** A proof is good this long after the tap (opening the app on a phone can take a while). */
export const ANSWER_PROOF_MS = 90_000;
const PROOF_RE = /^[0-9a-f]{32}$/;

/**
 * `#/call/<nursery>/<call>?answer=<proof>` (a family call) or
 * `#/call/d/<call>?answer=<proof>` (a direct call, whose line here is
 * `d:<call>`) — opened by "Answer" on a call notification (public/live-sw.js).
 * Only a proof counts: anyone can link to `?answer=1`, and that must never
 * pick up a call — it just opens the app, where the call rings as usual.
 */
export function answerFromHash(hash: string): { nid: string; id: string; proof: string } | null {
  const m = /^#\/?call\/([0-9a-f-]{36}|d)\/([0-9a-f]{8,24})\?(.*)$/.exec(hash);
  const proof = m ? new URLSearchParams(m[3]).get('answer') ?? '' : '';
  if (!m || !PROOF_RE.test(proof)) return null;
  return { nid: m[1] === 'd' ? `d:${m[2]}` : m[1], id: m[2], proof };
}

/**
 * Use up the proof the service worker left when "Answer" was tapped on this
 * call's notification. True only once, only for that call, and only shortly
 * after the tap — a link someone sent, a reload or a guessed address answers
 * nothing.
 */
export async function takeAnswerProof(x: { nid: string; id: string; proof: string }): Promise<boolean> {
  try {
    if (typeof caches === 'undefined' || !PROOF_RE.test(x.proof)) return false;
    const cache = await caches.open(ANSWER_CACHE);
    const key = `${ANSWER_KEY}${x.proof}`;
    const hit = await cache.match(key);
    if (!hit) return false;
    await cache.delete(key);
    const d = (await hit.json()) as { call?: unknown; where?: unknown; at?: unknown };
    const age = Date.now() - Number(d.at);
    return d.call === x.id && d.where === (x.nid.startsWith('d:') ? 'd' : x.nid) && age > -5000 && age < ANSWER_PROOF_MS;
  } catch {
    return false;
  }
}

/** Recents: family and direct calls together, newest first, each call once (a later report of a call wins). */
export function recentsOf<T extends { id: string; at: number }>(lists: Iterable<T>[], limit = 60): T[] {
  const by = new Map<string, T>();
  for (const list of lists) for (const r of list) by.set(r.id, r);
  return [...by.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** A direct call's line here. */
export const isDirect = (nid: string): boolean => nid.startsWith('d:');
const DIRECT_PLACE = 'Stream Studio';

/** A direct call ringing for you, as a call — shown at once; its room fills in the rest. */
export function ringAsCall(r: DirectRing, me: string): Call {
  return {
    id: r.id,
    from: { uid: r.from.uid, name: r.from.name, label: r.ctx.label },
    video: r.video,
    invited: [me],
    declined: [],
    at: r.at,
    answeredAt: null,
    parts: [],
    ever: { [r.from.uid]: r.from.name },
    ended: null,
  };
}

/** The call as the room will have it once our join lands — so answering needn't wait for the echo. */
export function withMe(call: Call, me: { uid: string; sid: string; name: string; label: string | null }, video: boolean, mic = true): Call {
  const part: CallPart = { uid: me.uid, name: me.name, label: me.label, sid: me.sid, at: Number.MAX_SAFE_INTEGER, mic, cam: video };
  return { ...call, parts: [...call.parts.filter((p) => p.uid !== me.uid), part] };
}

type AudioSessionNav = Navigator & { audioSession?: { type: string } };
/** Hand the phone's audio routing back after the call (preferSpeaker took it for the call). */
function releaseAudioSession(): void {
  try {
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = 'auto';
  } catch { /* unsupported */ }
}

const netInfo = (): EventTarget | null => (typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: EventTarget }).connection ?? null : null);

function endText(why: CallEndWhy, outgoing: boolean, who: string): string {
  switch (why) {
    case 'no_answer':
      return outgoing ? `${who} didn’t answer` : 'Missed call';
    case 'declined':
      return outgoing ? `${who} can’t talk right now` : 'Declined';
    case 'cancelled':
      return outgoing ? 'Call cancelled' : `${who} hung up`;
    default:
      return 'Call ended';
  }
}

// Calls want clean speech: unlike the nursery mic, noise suppression and auto-gain are on.
const callAudio = (): MediaTrackConstraints => ({ ...MIC_CONSTRAINTS, noiseSuppression: true, autoGainControl: true });

async function openLocal(video: boolean, facing: Facing): Promise<MediaStream> {
  const audio = callAudio();
  if (!video) return navigator.mediaDevices.getUserMedia({ audio, video: false });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
    return navigator.mediaDevices.getUserMedia({ audio, video: true });
  }
}

function mediaText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow the camera and microphone for this site to make calls (the lock icon in the address bar).';
  if (name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  if (name === 'NotReadableError') return 'Another app is using the camera or microphone.';
  return 'Couldn’t start the camera or microphone.';
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

class CallCenter {
  /** Nursery lines, and direct calls' rooms (keyed `d:<call id>`). */
  private lines = new Map<string, Line>();
  /** Your personal line (direct calls). */
  private ul: Line | null = null;
  private ulUid: string | null = null;
  /** Direct calls ringing for you, by call id (with their tickets). */
  private direct = new Map<string, DirectRing>();
  private favs: PersonRec[] = [];
  private blocked: PersonRec[] = [];
  private who: CallWho = 'everyone';
  private notice: { text: string; at: number } | null = null;
  private nurseryKey = '';
  private names: Record<string, string> | null = null;
  private calls = new Map<string, { nid: string; call: Call; seenAt: number }>();
  private log = new Map<string, CallRecord & { nid: string; nursery: string }>();
  private declined = new Set<string>();
  private active: Active | null = null;
  private since: number | null = null;
  private listeners = new Set<() => void>();
  private snap: CallsSnapshot | null = null;
  private on = false;
  private suspended = false;
  private uid: string | null = null;
  private wake = new ScreenWakeLock();
  private refreshTimer: number | undefined;
  private ringTimer: number | undefined;
  private upTimer: number | undefined;
  private netTimer: number | undefined;
  private notified = new Set<string>();
  /** Connections made while a call rings (by call id), network candidates already gathered. */
  private warm = new Map<string, RTCPeerConnection>();
  /** Calls hung up before they got going, by ref: cancelled for real as soon as their start is heard of. */
  private cancels = new Map<string, { nid: string; at: number }>();
  /** List changes your line hasn't confirmed yet: kept on top of what it says, replayed after its hello. */
  private pending = new Map<string, ListOp>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  snapshot = (): CallsSnapshot => {
    this.snap ??= this.build();
    return this.snap;
  };

  private emit(): void {
    this.snap = null;
    this.syncFast();
    for (const fn of this.listeners) fn();
  }

  /** Lines ping faster (and come back sooner) while they ring or carry the call. */
  private syncFast(): void {
    const a = this.active && !this.active.ended ? this.active : null;
    const ringing = new Set<string>();
    for (const { nid, call } of this.calls.values()) if (this.isRingingForMe(call)) ringing.add(nid);
    // (A line's socket reports 'connecting' before openMonitorSocket has returned it.)
    for (const l of this.lines.values()) l.sock?.setFast(a?.nid === l.nid || ringing.has(l.nid));
    // Your own line carries the decline, and the start of a call you place.
    this.ul?.sock?.setFast(this.direct.size > 0 || a?.nid === 'me' || (!!a && isDirect(a.nid)));
  }

  /* ---------------------------------------------------------- lines */

  /** Signed in: open a line to each nursery, and your own line (direct calls). */
  start(uid?: string): void {
    if (uid && uid !== this.ulUid) {
      this.ulUid = uid;
      this.loadPending(uid);
    }
    if (this.on) {
      this.openMe(); // the account's id arrived after the lines opened
      return;
    }
    this.on = true;
    this.tellWorker();
    this.openMe();
    void this.refresh();
    this.refreshTimer = window.setInterval(() => void this.refresh(), 10 * 60_000);
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('online', this.onOnline);
    // Ringing calls time out on screen even if the room's "no answer" is late.
    this.ringTimer = window.setInterval(() => {
      this.prewarm();
      this.emit();
    }, 5000);
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    window.clearInterval(this.refreshTimer);
    window.clearInterval(this.ringTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    window.removeEventListener('online', this.onOnline);
    this.hangup();
    for (const l of this.lines.values()) l.sock.close();
    this.lines.clear();
    this.ul?.sock.close();
    this.ul = null;
    this.ulUid = null;
    this.pending.clear(); // (kept in storage for this account's next sign-in)
    this.cancels.clear();
    this.direct.clear();
    this.favs = [];
    this.blocked = [];
    this.who = 'everyone';
    this.nurseryKey = '';
    this.calls.clear();
    this.log.clear();
    this.uid = null;
    this.prewarm();
    this.emit();
  }

  /** This device is running as a nursery camera: it must never ring. */
  setSuspended(s: boolean): void {
    if (s === this.suspended) return;
    this.suspended = s;
    this.tellWorker();
    if (s && !this.active) {
      for (const l of this.lines.values()) l.sock.close();
      this.lines.clear();
      this.ul?.sock.close();
      this.ul = null;
      this.direct.clear();
      this.calls.clear();
      this.prewarm();
      this.emit();
    } else if (!s) {
      this.openMe();
      void this.refresh();
    }
  }

  /**
   * Tell the service worker whether this device is running as a nursery
   * camera: if so it shows call pushes silently (the baby's phone must never
   * ring), even from a subscription made before it became the camera.
   */
  private tellWorker(): void {
    try {
      navigator.serviceWorker?.controller?.postMessage({ t: 'ds-camera', on: this.suspended && this.on });
    } catch { /* no service worker */ }
  }

  private onVis = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  /** Back online: a personal line that gave up opens again (nursery lines come back on their own). */
  private onOnline = () => {
    if (this.on && !this.suspended) this.openMe();
  };

  /** Pick up nurseries created or joined since the last look — and reopen your own line if it gave up. */
  async refresh(): Promise<void> {
    if (!this.on || this.suspended) return;
    this.openMe();
    const r = await listNurseries();
    if (!this.on || this.suspended || !r.ok || !r.nurseries) return;
    const want = new Set(r.nurseries.map((n) => n.id));
    for (const [nid, l] of this.lines) {
      if (isDirect(nid)) continue; // a direct call's room, not a nursery
      if (!want.has(nid)) {
        l.sock.close();
        this.lines.delete(nid);
      }
    }
    for (const n of r.nurseries) if (!this.lines.has(n.id)) this.openLine(n.id, n.name, n.baby_name);
    // Your family changed (a nursery joined or left): your line re-reads who counts as family.
    const key = [...want].sort().join(',');
    if (key !== this.nurseryKey) {
      const first = !this.nurseryKey;
      this.nurseryKey = key;
      if (!first) void this.familyChanged(true);
    }
    this.emit();
  }

  /**
   * Your line re-reads your family. `changed`: you just added or removed
   * someone — re-read even if it was read moments ago, so someone removed
   * stops ringing you as family straight away.
   */
  async familyChanged(changed = false): Promise<void> {
    const token = await accessToken();
    if (token) this.ul?.sock.send({ t: 'family_refresh', token, ...(changed ? { changed: true } : {}) });
  }

  /* ------------------------------------------------- your own line */

  private openMe(): void {
    const uid = this.ulUid;
    if (!uid || this.ul || !this.on || this.suspended) return;
    const line: Line = { nid: 'me', sock: null as unknown as MonitorSocket, connected: false, me: null, nursery: null, ice: [], iceAt: 0, helloAt: 0, vapid: null };
    this.ul = line;
    line.sock = openUserLineSocket<UserLineMsg>(
      uid,
      (m) => this.onMeMsg(line, m),
      (st) => {
        line.connected = st === 'connected';
        if (st === 'closed' && this.ul === line) this.ul = null;
        this.emit();
      },
    );
  }

  /** A direct call's history line as Recents shows it. */
  private directRec(r: CallRecord): CallRecord & { nid: string; nursery: string } {
    return { ...r, nid: 'direct', nursery: DIRECT_PLACE };
  }

  private onMeMsg(line: Line, m: UserLineMsg): void {
    if (this.ul !== line) return;
    switch (m.t) {
      case 'hello': {
        const now = Date.now();
        line.me = { sid: m.you.sid, uid: m.you.uid, name: m.you.name, label: null };
        line.vapid = m.vapid;
        line.iceAt = now;
        line.helloAt = now;
        this.uid = m.you.uid;
        this.favs = m.favs ?? [];
        this.blocked = m.blocked ?? [];
        this.who = m.prefs?.who === 'family' ? 'family' : 'everyone';
        // Changes made while the line was down go through now (and stay on screen meanwhile).
        this.settleLists(line, true);
        // Calls hung up before they got going: make sure the line has cancelled them.
        for (const [ref, c] of this.cancels) if (this.cancelled(ref) && (c.nid === 'me' || isDirect(c.nid))) line.sock.send({ t: 'dcall_cancel', ref });
        for (const r of m.log ?? []) this.log.set(r.id, this.directRec(r));
        // What rings right now (also for an app a notification just opened).
        const live = new Set((m.ringing ?? []).map((r) => r.id));
        for (const id of [...this.direct.keys()]) if (!live.has(id)) this.stopDirect(id);
        for (const r of m.ringing ?? []) this.onRing(r);
        if (this.ringOn) void this.sendRing(line);
        // A call we were placing whose start got lost with the old connection: place it again (the line knows it by its ref).
        const a = this.active;
        if (a && !a.ended && a.nid === 'me' && !a.id) void this.sendStart(line, a);
        this.prewarm();
        this.emit();
        return;
      }
      case 'dcall_ring':
        this.onRing(m.ring);
        this.prewarm();
        this.emit();
        return;
      case 'dcall_update':
        if (m.stop) this.stopDirect(m.id);
        this.prewarm();
        this.emit();
        return;
      case 'dcall_started': {
        const a = this.active;
        if (a && !a.ended && a.nid === 'me' && a.ref === m.ref && !a.id) {
          a.id = m.id;
          a.nid = `d:${m.id}`;
          this.openRoom(m.id, m.ticket, DIRECT_PLACE);
        } else if (this.cancelled(m.ref)) {
          // Hung up before it got going: it's cancelled now, not left ringing on their phones.
          line.sock.send({ t: 'dcall_cancel', ref: m.ref, id: m.id });
        }
        this.emit();
        return;
      }
      case 'dcall_invited':
        if (m.status !== 'ringing') this.say(m.status === 'slow_down' ? callErrorText('slow_down') : 'They can’t be reached right now — they weren’t added.');
        return;
      case 'dcall_state':
        this.favs = m.favs ?? [];
        this.blocked = m.blocked ?? [];
        this.who = m.prefs?.who === 'family' ? 'family' : 'everyone';
        this.settleLists(line, false);
        this.emit();
        return;
      case 'call_err': {
        const a = this.active;
        if (a && !a.ended && a.nid === 'me' && m.ref && a.ref === m.ref) this.finish({ why: 'error', text: callErrorText(m.error, a.asked.length === 1 ? a.asked[0].name : null) });
        this.emit();
        return;
      }
      case 'call_log':
        this.log.set(m.rec.id, this.directRec(m.rec));
        this.emit();
        return;
    }
  }

  private say(text: string): void {
    this.notice = { text, at: Date.now() };
    this.emit();
  }

  private async sendStart(line: Line, a: Active): Promise<void> {
    const token = await accessToken();
    if (this.active !== a || a.ended || a.id) return;
    line.sock.send({ t: 'dcall_start', to: a.asked.map((p) => p.uid), video: a.video, ref: a.ref, token });
  }

  /** A direct call rings: show it at once, and connect to its room while it rings (so Accept is instant). */
  private onRing(r: DirectRing): void {
    if (this.suspended || !this.uid || this.declined.has(r.id)) return;
    this.direct.set(r.id, r);
    this.remember([r.from]);
    if (!this.calls.has(r.id)) this.put(`d:${r.id}`, ringAsCall(r, this.uid));
    const line = this.openRoom(r.id, r.ticket, ctxText(r.ctx));
    // The tab is in the background (and push is off): a local notification.
    const c = this.calls.get(r.id)?.call;
    if (c) this.maybeNotify(line, c);
  }

  /** A direct call's room: one more line, keyed `d:<id>`. */
  private openRoom(id: string, ticket: string, place: string): Line {
    const nid = `d:${id}`;
    const have = this.lines.get(nid);
    if (have) return have;
    const line: Line = { nid, sock: null as unknown as MonitorSocket, connected: false, me: null, nursery: { id: nid, name: place, baby: null }, ice: [], iceAt: 0, helloAt: 0, vapid: null };
    this.lines.set(nid, line);
    line.sock = openCallRoomSocket<LineMsg>(
      id,
      ticket,
      (m) => this.onLineMsg(line, m),
      (st) => {
        line.connected = st === 'connected';
        if (st === 'closed' && this.lines.get(nid) === line) {
          // The room said the call is over (or it wasn't ours): stop showing it.
          this.lines.delete(nid);
          this.direct.delete(id);
          for (const c of [...this.calls.values()]) if (c.nid === nid) this.calls.delete(c.call.id);
          const a = this.active;
          if (a && a.nid === nid && !a.ended) this.finish({ why: 'done', text: 'Call ended' });
          this.prewarm();
        }
        this.emit();
      },
      { fast: true },
    );
    return line;
  }

  /** A direct call stopped ringing here (picked up elsewhere, declined, over). */
  private stopDirect(id: string): void {
    this.direct.delete(id);
    const a = this.active;
    if (a && a.id === id && !a.ended) return;
    this.closeRoom(id);
  }

  private closeRoom(id: string): void {
    const nid = `d:${id}`;
    const l = this.lines.get(nid);
    if (l) {
      this.lines.delete(nid);
      l.sock.close();
    }
    for (const c of [...this.calls.values()]) if (c.nid === nid) this.calls.delete(c.call.id);
  }

  /** Rooms of direct calls that neither ring here nor carry the call on this device are closed. */
  private pruneRooms(): void {
    const a = this.active && !this.active.ended ? this.active : null;
    for (const nid of [...this.lines.keys()]) {
      if (!isDirect(nid) || a?.nid === nid) continue;
      const id = nid.slice(2);
      if (!this.direct.has(id) || this.declined.has(id)) this.closeRoom(id);
    }
  }

  /** Who someone is, by name, if you've called them, starred them or been rung by them here. */
  nameOf(uid: string): string | null {
    return this.favs.find((f) => f.uid === uid)?.name ?? this.loadNames()[uid] ?? null;
  }

  private loadNames(): Record<string, string> {
    if (this.names) return this.names;
    try {
      this.names = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}') as Record<string, string>;
    } catch {
      this.names = {};
    }
    return this.names;
  }

  private remember(people: { uid: string; name: string }[]): void {
    const names = { ...this.loadNames() };
    for (const p of people) {
      delete names[p.uid];
      names[p.uid] = p.name.slice(0, 40);
    }
    const keys = Object.keys(names);
    for (const k of keys.slice(0, Math.max(0, keys.length - NAMES_CAP))) delete names[k];
    this.names = names;
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch { /* storage unavailable */ }
  }

  /* --------------------------------------- favourites, blocks, who */

  /**
   * Star / unstar someone (synced to your other devices). True when it went
   * to your line now; false when the line isn't connected — the change is
   * kept (across reloads too) and goes through after the line's next hello.
   */
  setFav(p: { uid: string; name: string }, on: boolean): boolean {
    return this.queue({ t: 'fav', uid: p.uid, name: p.name, on });
  }

  /** Block / unblock someone: their direct calls never reach you (they can't tell). Same delivery as setFav. */
  setBlocked(p: { uid: string; name: string }, on: boolean): boolean {
    return this.queue({ t: 'block', uid: p.uid, name: p.name, on });
  }

  /** Who can call you directly: everyone on Stream Studio, or only people in your nurseries. Same delivery as setFav. */
  setWho(who: CallWho): boolean {
    return this.queue({ t: 'prefs', who });
  }

  /**
   * A change to your lists: shown at once and kept until your line confirms
   * it (a hello or update that already has it). Sent now when the line is up
   * (unless something else already carries it, like a decline with block);
   * otherwise — or if it got lost on a dying connection — the line's next
   * hello replays it, so a hello never quietly undoes it.
   */
  private queue(op: ListOp, send = true): boolean {
    this.pending.delete(opKey(op));
    this.pending.set(opKey(op), op);
    while (this.pending.size > PENDING_CAP) this.pending.delete(this.pending.keys().next().value as string);
    this.savePending();
    this.applyOp(op);
    const up = !!this.ul?.connected;
    if (up && send) this.ul!.sock.send(op);
    this.emit();
    return up;
  }

  private applyOp(op: ListOp): void {
    if (op.t === 'prefs') {
      this.who = op.who;
      return;
    }
    const list = op.t === 'fav' ? this.favs : this.blocked;
    const rest = list.filter((x) => x.uid !== op.uid);
    const next = op.on ? [...rest, { uid: op.uid, name: op.name, at: Date.now() }] : rest;
    if (op.t === 'fav') this.favs = next;
    else this.blocked = next;
  }

  /** The line's lists already have this change. */
  private reflected(op: ListOp): boolean {
    if (op.t === 'prefs') return this.who === op.who;
    return (op.t === 'fav' ? this.favs : this.blocked).some((x) => x.uid === op.uid) === op.on;
  }

  /** The line's lists just arrived: confirmed changes are done; the rest stay on top (and after a hello, go again). */
  private settleLists(line: Line, replay: boolean): void {
    for (const [k, op] of [...this.pending]) {
      if (this.reflected(op)) {
        this.pending.delete(k);
        continue;
      }
      this.applyOp(op);
      if (replay) line.sock.send(op);
    }
    this.savePending();
  }

  private savePending(): void {
    const uid = this.ulUid;
    if (!uid) return;
    try {
      if (this.pending.size) localStorage.setItem(`${PENDING_KEY}:${uid}`, JSON.stringify([...this.pending.values()]));
      else localStorage.removeItem(`${PENDING_KEY}:${uid}`);
    } catch { /* storage unavailable */ }
  }

  private loadPending(uid: string): void {
    this.pending.clear();
    try {
      const raw = JSON.parse(localStorage.getItem(`${PENDING_KEY}:${uid}`) || '[]') as unknown;
      for (const v of Array.isArray(raw) ? raw.slice(-PENDING_CAP) : []) {
        const op = cleanOp(v);
        if (op) this.pending.set(opKey(op), op);
      }
    } catch { /* storage unavailable */ }
  }

  private openLine(nid: string, name: string, baby: string | null): void {
    const line: Line = { nid, sock: null as unknown as MonitorSocket, connected: false, me: null, nursery: { id: nid, name, baby }, ice: [], iceAt: 0, helloAt: 0, vapid: null };
    this.lines.set(nid, line);
    line.sock = openMonitorSocket(
      nid,
      'line',
      (m) => this.onLineMsg(line, m as unknown as LineMsg),
      () => undefined,
      (s) => {
        line.connected = s === 'connected';
        if (s === 'closed' && this.lines.get(nid) === line) this.lines.delete(nid);
        this.emit();
      },
    );
  }

  private onLineMsg(line: Line, m: LineMsg): void {
    switch (m.t) {
      case 'hello': {
        const now = Date.now();
        line.me = { sid: m.you.sid, uid: m.you.uid, name: m.you.name, label: m.you.label };
        // A direct call's room keeps the label we gave it (from your family, or someone else on Stream Studio).
        if (!isDirect(line.nid)) line.nursery = m.nursery;
        line.ice = m.ice ?? [];
        line.iceAt = now;
        line.helloAt = now;
        line.vapid = m.vapid;
        this.uid = m.you.uid;
        for (const c of [...this.calls.values()]) if (c.nid === line.nid) this.calls.delete(c.call.id);
        for (const c of m.calls) this.put(line.nid, c);
        for (const r of m.callLog) this.log.set(r.id, { ...r, nid: line.nid, nursery: familyName(m.nursery) });
        if (this.ringOn && !isDirect(line.nid)) void this.sendRing(line);
        // A direct call that's no longer on in its room stops ringing here.
        if (isDirect(line.nid) && !m.calls.some((c) => c.id === line.nid.slice(2))) this.stopDirect(line.nid.slice(2));
        this.rejoin(line);
        this.prewarm();
        this.emit();
        return;
      }
      case 'call_started': {
        const a = this.active;
        if (a && a.ref === m.ref && a.nid === line.nid && !a.ended) {
          a.id = m.id;
          a.mySid = line.me?.sid ?? null;
          if (m.ice?.length) a.ice = m.ice;
          const c = this.calls.get(m.id)?.call;
          if (c) this.onActiveCall(line, c);
          this.prewarm();
        } else if (this.cancelled(m.ref, line.nid)) {
          // Hung up before the room answered: leave it now, so it doesn't ring on with nobody calling.
          line.sock.send({ t: 'call_leave', id: m.id });
        }
        this.emit();
        return;
      }
      case 'call_joined':
      case 'call_ice': {
        // Fresh relay credentials for this call: on picking up, and when a long call's are due.
        const a = this.active;
        if (a && a.id === m.id && a.nid === line.nid && m.ice?.length) {
          a.ice = m.ice;
          a.mesh?.setIce(m.ice, m.iceMs);
        }
        return;
      }
      case 'call':
        this.put(line.nid, m.call);
        if (this.active && this.active.nid === line.nid && this.active.id === m.call.id) this.onActiveCall(line, m.call);
        else if (isDirect(line.nid) && m.call.ended) this.stopDirect(m.call.id);
        this.maybeNotify(line, m.call);
        this.prewarm();
        this.emit();
        return;
      case 'call_err': {
        const a = this.active;
        if (a && a.nid === line.nid && ((m.ref && a.ref === m.ref) || (m.id && a.id === m.id))) this.finish({ why: 'error', text: callErrorText(m.error) });
        this.emit();
        return;
      }
      case 'call_rtc': {
        const a = this.active;
        if (a && a.nid === line.nid && a.id === m.id && a.call && a.mesh) void a.mesh.onSignal(m.from, m.d, a.call);
        return;
      }
      case 'call_log':
        this.log.set(m.rec.id, isDirect(line.nid) ? this.directRec(m.rec) : { ...m.rec, nid: line.nid, nursery: familyName(line.nursery) });
        this.emit();
        return;
    }
  }

  /**
   * The line came back (a new socket) while a call is on: point the call at
   * the new connection — or notice that it ended, or moved to another of our
   * devices, while we were away. A call we placed whose start got lost with
   * the old connection is placed again (or adopted, if the room has it).
   */
  private rejoin(line: Line): void {
    const a = this.active;
    const me = line.me;
    if (!a || a.ended || a.nid !== line.nid || !me) return;
    if (a.id) {
      const c = this.calls.get(a.id)?.call;
      if (!c) {
        this.finish({ why: 'done', text: 'Call ended' });
        return;
      }
      if (c.parts.some((p) => p.uid === me.uid && p.sid !== a.mySid && p.sid !== me.sid && p.gone == null)) {
        this.finish({ why: 'done', text: 'Continued on another device' });
        return;
      }
      a.call = c;
      a.inRoom = false;
      a.mySid = me.sid;
      line.sock.send({ t: 'call_join', id: a.id, video: a.cam, mic: a.mic });
      a.mesh?.kick();
      return;
    }
    if (!a.outgoing) return;
    const asked = new Set(a.asked.map((p) => p.uid));
    const placed = [...this.calls.values()]
      .map((x) => x.call)
      .find((c) => c.from.uid === me.uid && c.answeredAt == null && !c.ended && c.invited.length === asked.size && c.invited.every((u) => asked.has(u)));
    if (placed) {
      a.id = placed.id;
      a.mySid = me.sid;
      line.sock.send({ t: 'call_join', id: placed.id, video: a.cam, mic: a.mic });
    } else {
      line.sock.send({ t: 'call_start', to: [...asked], video: a.video, ref: a.ref });
    }
  }

  private put(nid: string, call: Call): void {
    if (call.ended) {
      this.calls.delete(call.id);
      return;
    }
    const prev = this.calls.get(call.id);
    this.calls.set(call.id, { nid, call, seenAt: prev?.seenAt ?? Date.now() });
  }

  /** Ringing while the tab is in the background and push is off: a local notification. */
  private maybeNotify(line: Line, call: Call): void {
    if (typeof document === 'undefined' || !document.hidden || this.notified.has(call.id)) return;
    if (!this.isRingingForMe(call)) return;
    this.notified.add(call.id);
    // This app's own address (no reload of an open app): /live#… here, /#… on Stream Studio's own host.
    const url = isDirect(line.nid) ? `${LIVE_APP_PATH}#/call/d/${call.id}` : `${LIVE_APP_PATH}#/call/${line.nid}/${call.id}`;
    void localNotify(`📹 ${call.from.label || call.from.name}`, `${call.video ? 'Video' : 'Audio'} call · ${familyName(line.nursery)}`, `call-${call.id}`, url);
  }

  private isRingingForMe(call: Call): boolean {
    const uid = this.uid;
    return !!uid && !call.ended && call.invited.includes(uid) && !call.parts.some((p) => p.uid === uid) && !call.declined.includes(uid) && !this.declined.has(call.id);
  }

  /**
   * While a call rings for us, make its connection ahead of time: network
   * candidates (STUN — and a relay, when there is one) are gathered before
   * Accept is tapped. Likewise for the call we placed, while it rings. Silent
   * (no permission involved) and closed as soon as the ring is over.
   */
  private prewarm(): void {
    const want = new Map<string, RTCIceServer[]>();
    const now = Date.now();
    const a = this.active && !this.active.ended ? this.active : null;
    for (const { nid, call, seenAt } of this.calls.values()) {
      if (want.size >= 2) break;
      if (a?.id === call.id || !this.isRingingForMe(call) || (call.answeredAt == null && now - seenAt > RING_SECS * 1000)) continue;
      const line = this.lines.get(nid);
      if (line?.ice.length) want.set(call.id, line.ice);
    }
    // Our own call while it rings: ready for whoever picks up first.
    if (a?.id && a.outgoing && a.call?.answeredAt == null) want.set(a.id, a.ice ?? this.lines.get(a.nid)?.ice ?? []);
    for (const [id, pc] of this.warm) {
      if (want.has(id)) continue;
      pc.close();
      this.warm.delete(id);
    }
    if (typeof RTCPeerConnection !== 'function') return;
    const relay = relayOnly();
    for (const [id, ice] of want) {
      if (this.warm.has(id) || !ice.length) continue;
      try {
        this.warm.set(id, new RTCPeerConnection(pcConfig(ice, relay)));
      } catch { /* the call connects without the head start */ }
    }
  }

  private takeWarm(id: string): RTCPeerConnection | null {
    const pc = this.warm.get(id);
    if (!pc) return null;
    this.warm.delete(id);
    return pc.signalingState === 'closed' ? null : pc;
  }

  /* ------------------------------------------------------- ringing */

  get ringOn(): boolean {
    try {
      return localStorage.getItem(RING_KEY) === '1';
    } catch {
      return false;
    }
  }

  private async sendRing(line: Line): Promise<void> {
    const sub = await currentSubscription();
    if (sub) line.sock.send({ t: 'call_push', sub: sub.toJSON() });
  }

  /** Lines that ring this device by push: your own line and each nursery's (never a direct call's room). */
  private ringLines(): Line[] {
    return [...(this.ul ? [this.ul] : []), ...[...this.lines.values()].filter((l) => !isDirect(l.nid))];
  }

  /** Ring this device with the app closed (from a tap — it asks for notification permission). */
  async enableRinging(): Promise<{ ok: true } | { error: string }> {
    // Your own line has the key even with no nursery (it's the same key pair as the monitor's).
    const vapid = this.ul?.vapid ?? this.ringLines().find((l) => l.vapid)?.vapid;
    if (!vapid) return { error: 'Not connected yet — try again in a moment.' };
    const r = await pushSubscribe(vapid);
    if ('error' in r) return { error: r.error };
    try {
      localStorage.setItem(RING_KEY, '1');
    } catch { /* storage unavailable */ }
    for (const l of this.ringLines()) l.sock.send({ t: 'call_push', sub: r });
    this.emit();
    return { ok: true };
  }

  async disableRinging(): Promise<void> {
    try {
      localStorage.removeItem(RING_KEY);
    } catch { /* storage unavailable */ }
    const sub = await currentSubscription();
    if (sub) for (const l of this.ringLines()) l.sock.send({ t: 'call_push_off', endpoint: sub.endpoint });
    this.emit();
  }

  /* ------------------------------------------------------- the call */

  /**
   * Make sure the line really reaches the room before a call goes through it:
   * a socket that's been quiet may be dead (it can sit OPEN for minutes after
   * a network change), and relay credentials from a very old hello may be
   * near expiry. Checks with a ping and reconnects if nothing answers.
   */
  private async fresh(line: Line): Promise<boolean> {
    const now = Date.now();
    const stale = now - line.iceAt > ICE_MAX_AGE_MS;
    if (line.connected && now - line.sock.lastHeard < SILENT_MS && !stale) return true;
    if (stale) line.sock.reconnect();
    else line.sock.probe(3000);
    const until = now + 10_000;
    while (Date.now() < until) {
      if (line.connected && (line.helloAt >= now || (!stale && line.sock.lastHeard >= now))) return true;
      await sleep(100);
    }
    return false;
  }

  /** Call people in a nursery (from a tap). */
  async call(nid: string, people: { uid: string; name: string }[], video: boolean): Promise<string | null> {
    if (this.active && !this.active.ended) return 'You’re already in a call.';
    const line = this.lines.get(nid);
    if (!line?.connected) return 'Not connected to this nursery yet — check your internet and try again.';
    const [reachable, local] = await Promise.all([this.fresh(line), openLocal(video, 'user').catch((e: unknown) => e)]);
    if (!(local instanceof MediaStream)) return mediaText(local);
    if (!reachable || (this.active && !this.active.ended)) {
      for (const t of local.getTracks()) t.stop();
      return reachable ? 'You’re already in a call.' : 'Not connected to this nursery right now — check your internet and try again.';
    }
    this.begin({ nid, id: null, ref: newRef(), outgoing: true, video, call: null, local, mic: true, cam: video, facing: 'user', mesh: null, ended: null, asked: people, ice: null, relayOnly: relayOnly(), mySid: null, inRoom: false, opening: false, reported: null, rejoinAt: 0 });
    line.sock.send({ t: 'call_start', to: people.map((p) => p.uid), video, ref: this.active!.ref });
    this.emit();
    return null;
  }

  /**
   * Call anyone on Stream Studio (from a tap) — up to three people, found by
   * name. Your line places it (and rings them through theirs); the camera
   * opens meanwhile. If they can't be reached, or only take calls from their
   * family, it says so at once.
   */
  async callUser(people: { uid: string; name: string }[], video: boolean): Promise<string | null> {
    if (this.active && !this.active.ended) return 'You’re already in a call.';
    // A line that gave up gets another go right now (fresh() below waits for it).
    if (!this.ul) this.openMe();
    const line = this.ul;
    if (!line) return 'Calls aren’t connected yet — check your internet and try again.';
    if (!people.length) return callErrorText('nobody');
    const [reachable, local] = await Promise.all([this.fresh(line), openLocal(video, 'user').catch((e: unknown) => e)]);
    if (!(local instanceof MediaStream)) return mediaText(local);
    if (!reachable || (this.active && !this.active.ended) || this.ul !== line) {
      for (const t of local.getTracks()) t.stop();
      return reachable && this.ul === line ? 'You’re already in a call.' : 'Not connected right now — check your internet and try again.';
    }
    this.remember(people);
    const a: Active = { nid: 'me', id: null, ref: newRef(), outgoing: true, video, call: null, local, mic: true, cam: video, facing: 'user', mesh: null, ended: null, asked: people.slice(0, 3), ice: null, relayOnly: relayOnly(), mySid: null, inRoom: false, opening: false, reported: null, rejoinAt: 0 };
    this.begin(a);
    this.emit();
    await this.sendStart(line, a);
    return null;
  }

  /**
   * Pick up (from a tap). Joins at once and builds the connections right
   * behind the join (the room handles one socket's messages in order); the
   * camera and mic open in parallel and slot in when they're ready. If they
   * can't open, you stay in the call to see and hear the others, shown as
   * muted with the camera off. Audio-only answers keep your camera off.
   */
  async accept(nid: string, id: string, video: boolean): Promise<string | null> {
    const line = this.lines.get(nid);
    // (A direct call's room may still be connecting — fresh() below waits for it.)
    if (!line || (!line.connected && !isDirect(nid)) || !this.calls.has(id)) return 'That call has ended.';
    if (this.active && !this.active.ended) this.hangup();
    if (!(await this.fresh(line))) return 'Not connected right now — check your internet and try again.';
    const ring = this.calls.get(id);
    const me = line.me;
    if (!ring || !me) return 'That call has ended.';
    if (this.active && !this.active.ended) this.hangup();
    const a: Active = {
      nid, id, ref: newRef(), outgoing: false, video: ring.call.video, call: ring.call, local: new MediaStream(), mic: true, cam: video, facing: 'user', mesh: null,
      ended: null, asked: [], ice: null, relayOnly: relayOnly(), mySid: me.sid, inRoom: false, opening: true, reported: null, rejoinAt: 0,
    };
    this.begin(a);
    line.sock.send({ t: 'call_join', id, video, mic: true });
    this.onActiveCall(line, withMe(ring.call, me, video), true);
    this.emit();
    try {
      const s = await openLocal(video, 'user');
      a.opening = false;
      if (this.active !== a || a.ended) {
        for (const t of s.getTracks()) t.stop();
        return null;
      }
      for (const t of s.getAudioTracks()) t.enabled = a.mic;
      for (const t of s.getVideoTracks()) t.enabled = a.cam;
      a.local = new MediaStream(s.getTracks());
      a.mesh?.refreshLocal();
      this.emit();
      return null;
    } catch (e) {
      a.opening = false;
      if (this.active === a && !a.ended) {
        a.mic = false;
        a.cam = false;
        this.sendMedia();
      }
      return mediaText(e);
    }
  }

  /**
   * Say no. A direct call is declined through your line (which also stops your
   * other devices ringing — and works from an app a notification opened);
   * `block` also blocks whoever rang (a stranger who added you, else the
   * caller), who can't tell. Returns who was blocked and whether it reached
   * your line now — if not, the block is kept and goes through as soon as the
   * line is back (until then their calls can still ring your other devices).
   */
  decline(nid: string, id: string, block = false): { who: { uid: string; name: string }; now: boolean } | null {
    this.declined.add(id);
    let out: { who: { uid: string; name: string }; now: boolean } | null = null;
    if (isDirect(nid)) {
      this.lines.get(nid)?.sock.send({ t: 'call_decline', id });
      const ring = this.direct.get(id);
      const from = ring?.from ?? this.calls.get(id)?.call.from;
      const now = !!this.ul?.connected;
      this.ul?.sock.send({ t: 'dcall_decline', id, block });
      if (block && from) {
        const who = blockTarget(from, ring?.ctx);
        // The decline carries the block when the line is up; kept until the line confirms it either way.
        this.queue({ t: 'block', uid: who.uid, name: who.name, on: true }, false);
        out = { who, now };
      }
      this.stopDirect(id);
    } else this.lines.get(nid)?.sock.send({ t: 'call_decline', id });
    this.prewarm();
    this.emit();
    return out;
  }

  hangup(): void {
    const a = this.active;
    if (!a) return;
    if (!a.ended) {
      if (a.id) this.lines.get(a.nid)?.sock.send({ t: 'call_leave', id: a.id });
      // Hung up before the call got going: cancel it for real, not leave them ringing.
      if (a.outgoing && !a.inRoom) this.cancelStart(a);
      this.finish({ why: 'done', text: 'Call ended' });
    }
    this.active = null;
    this.pruneRooms();
    this.emit();
  }

  /**
   * A call we placed was hung up before our app was in its room: remember it
   * (by ref) so that when its start is heard of, it's cancelled there and
   * then. A direct call is also cancelled through your line right away — the
   * line knows it by its ref even before we have its id.
   */
  private cancelStart(a: Active): void {
    const now = Date.now();
    for (const [ref, c] of this.cancels) if (now - c.at > CANCEL_MS) this.cancels.delete(ref);
    this.cancels.set(a.ref, { nid: a.nid, at: now });
    if (a.nid === 'me' || isDirect(a.nid)) this.ul?.sock.send({ t: 'dcall_cancel', ref: a.ref, ...(a.id ? { id: a.id } : {}) });
  }

  /** A call (by ref) hung up before it got going, on this line (nursery) or any. */
  private cancelled(ref: string, nid?: string): boolean {
    const c = this.cancels.get(ref);
    return !!ref && !!c && Date.now() - c.at < CANCEL_MS && (nid == null || c.nid === nid);
  }

  /** Close the "call ended" screen. */
  dismiss(): void {
    if (this.active?.ended) {
      this.active = null;
      this.pruneRooms();
      this.emit();
    }
  }

  /**
   * "Try again" on a call that couldn't connect: check the line, then start
   * every connection that isn't up over, with this phone offering. Audio
   * only also turns the camera off (less to send on a struggling network).
   */
  retry(audioOnly = false): void {
    const a = this.active;
    if (!a || a.ended) return;
    if (audioOnly && a.cam) {
      a.cam = false;
      for (const t of a.local.getVideoTracks()) t.enabled = false;
      this.sendMedia();
    }
    const line = this.lines.get(a.nid);
    if (line && Date.now() - line.sock.lastHeard > 12_000) line.sock.probe(3000);
    a.mesh?.retry();
    this.emit();
  }

  /** This call is over (or another took its place) while something was opening: whatever opened is let go at once. */
  private gone(a: Active, s: MediaStream): boolean {
    if (this.active === a && !a.ended) return false;
    for (const t of s.getTracks()) t.stop();
    return true;
  }

  /** Mute / unmute. A mic that couldn't open when answering is opened now (from the tap). */
  async toggleMic(): Promise<string | null> {
    const a = this.active;
    if (!a || a.ended) return null;
    if (!a.mic && !a.opening && !a.local.getAudioTracks().length) {
      if (a.micOpening) return null; // already asking (a second tap while the prompt is up)
      a.micOpening = true;
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: callAudio() });
      } catch (e) {
        return mediaText(e);
      } finally {
        a.micOpening = false;
      }
      // The call ended while the permission prompt was up: the mic must not stay on.
      if (this.gone(a, s)) return null;
      a.local = new MediaStream([...a.local.getTracks(), ...s.getAudioTracks()]);
      a.mesh?.refreshLocal();
    }
    a.mic = !a.mic;
    for (const t of a.local.getAudioTracks()) t.enabled = a.mic;
    this.sendMedia(a);
    return null;
  }

  async toggleCam(): Promise<string | null> {
    const a = this.active;
    if (!a || a.ended || a.opening) return null; // the camera is still starting (a second or so after answering)
    const v = a.local.getVideoTracks()[0];
    if (v) {
      a.cam = !a.cam;
      v.enabled = a.cam;
    } else {
      // An audio call turning its camera on: open it now, no renegotiation needed.
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: a.facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (this.gone(a, s)) return null;
        if (a.local.getVideoTracks().length) {
          for (const t of s.getTracks()) t.stop(); // a second tap got there first
        } else {
          a.local.addTrack(s.getVideoTracks()[0]);
          a.local = new MediaStream(a.local.getTracks());
        }
        a.cam = true;
        a.mesh?.refreshLocal();
      } catch (e) {
        return mediaText(e);
      }
    }
    this.sendMedia(a);
    return null;
  }

  /** Front ⇄ back camera. */
  async flip(): Promise<void> {
    const a = this.active;
    const old = a?.local.getVideoTracks()[0];
    if (!a || !old || a.ended) return;
    const facing: Facing = a.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      // Over meanwhile — or the camera changed under us (another flip): keep what's there.
      if (this.gone(a, s)) return;
      if (a.local.getVideoTracks()[0] !== old) {
        for (const t of s.getTracks()) t.stop();
        return;
      }
      const fresh = s.getVideoTracks()[0];
      fresh.enabled = a.cam;
      old.stop();
      a.local = new MediaStream([...a.local.getAudioTracks(), fresh]);
      a.facing = facing;
      a.mesh?.refreshLocal();
      this.emit();
    } catch { /* only one camera */ }
  }

  /** Ring more people into this call. */
  invite(uids: string[]): void {
    const a = this.active;
    const id = a?.id;
    if (!a || !id || !uids.length) return;
    // A direct call: your line rings them (with the same limits as placing a call).
    if (isDirect(a.nid)) {
      const line = this.ul;
      void accessToken().then((token) => line?.sock.send({ t: 'dcall_invite', id, to: uids, token }));
    } else this.lines.get(a.nid)?.sock.send({ t: 'call_invite', id, to: uids });
  }

  private begin(a: Active): void {
    this.active = a;
    this.since = null;
    void this.wake.enable();
    // iPhone: call audio out of the loudspeaker, not the quiet earpiece.
    preferSpeaker();
    window.addEventListener('online', this.onNet);
    netInfo()?.addEventListener('change', this.onNet);
    window.clearInterval(this.upTimer);
    this.upTimer = window.setInterval(() => this.vouch(), VOUCH_MS);
  }

  /** The network changed under the call: check the line now, and get stuck connections moving on the new network. */
  private onNet = () => {
    const a = this.active;
    if (!a || a.ended) return;
    this.lines.get(a.nid)?.sock.probe(4000);
    window.clearTimeout(this.netTimer);
    // Give the new network a moment to settle before gathering on it.
    this.netTimer = window.setTimeout(() => {
      if (this.active === a && !a.ended) a.mesh?.kick();
    }, 1500);
  };

  /**
   * Someone's app lost the room but their media still reaches us: tell the
   * room, so it doesn't drop them from the call (sent at once, then every 10 s
   * while they're away — nothing at all while everyone is in the room).
   */
  private vouch(): void {
    const a = this.active;
    if (!a?.id || a.ended || !a.mesh) return;
    const uids = a.mesh.views.filter((p) => p.away && p.state === 'connected').map((p) => p.uid);
    if (uids.length) this.lines.get(a.nid)?.sock.send({ t: 'call_up', id: a.id, uids });
  }

  /** Tell the room this call's mic / camera state (never for a call that's over or no longer the one on). */
  private sendMedia(a: Active | null = this.active): void {
    if (a && a === this.active && !a.ended && a.id) this.lines.get(a.nid)?.sock.send({ t: 'call_media', id: a.id, mic: a.mic, cam: a.cam });
    this.emit();
  }

  private onActiveCall(line: Line, call: Call, ahead = false): void {
    const a = this.active;
    const me = line.me;
    if (!a || a.ended || !me) return;
    if (call.ended) {
      a.call = call;
      const who = a.asked[0]?.name ?? call.from.label ?? call.from.name;
      this.finish({ why: call.ended.why, text: endText(call.ended.why, a.outgoing, a.asked.length > 1 ? 'No one' : who) });
      return;
    }
    const mine = call.parts.find((p) => p.sid === me.sid);
    if (!mine) {
      // Not in it from this connection (yet). Once the room had us in, that means another
      // of our devices took the call over — or the room let us go, and we join again.
      if (!a.inRoom) return;
      if (call.parts.some((p) => p.uid === me.uid && p.gone == null)) {
        this.finish({ why: 'done', text: 'Continued on another device' });
      } else if (a.id && Date.now() - a.rejoinAt > 5000) {
        a.rejoinAt = Date.now();
        line.sock.send({ t: 'call_join', id: a.id, video: a.cam, mic: a.mic });
      }
      return;
    }
    if (!ahead) {
      a.inRoom = true;
      a.mySid = mine.sid;
    }
    a.call = call;
    if (!a.mesh) {
      const id = call.id;
      a.mesh = new CallMesh({
        me: me.uid,
        ice: a.ice ?? line.ice,
        relayOnly: a.relayOnly,
        local: () => ({ audio: a.local.getAudioTracks()[0] ?? null, video: a.local.getVideoTracks()[0] ?? null }),
        signal: (to: string, d: CallSignal) => line.sock.send({ t: 'call_rtc', id, to, d }),
        onChange: () => this.onMesh(a),
        warm: () => this.takeWarm(id),
        refreshIce: () => line.sock.send({ t: 'call_ice', id }),
      });
    }
    const awayBefore = new Set(a.mesh.views.filter((p) => p.away).map((p) => p.uid));
    a.mesh.sync(call, me.sid);
    if (a.mesh.views.some((p) => p.away && !awayBefore.has(p.uid))) this.vouch();
  }

  private onMesh(a: Active): void {
    if (this.active !== a || !a.mesh) return;
    if (this.since == null && a.mesh.connectedCount > 0) this.since = Date.now();
    this.report(a);
    this.emit();
  }

  /** How connecting went, once per outcome — kept with the call's history (no names, no addresses). */
  private report(a: Active): void {
    const o = a.mesh?.outcome;
    if (!o || !a.id) return;
    const key = `${o.ttc}|${o.path}|${o.fail}`;
    if (key === a.reported) return;
    a.reported = key;
    this.lines.get(a.nid)?.sock.send({ t: 'call_stats', id: a.id, ttc: o.ttc, path: o.path, fail: o.fail, turn: o.turn });
  }

  private finish(ended: { why: CallEndWhy | 'error'; text: string }): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = ended;
    a.mesh?.close();
    a.mesh = null;
    for (const t of a.local.getTracks()) t.stop();
    void this.wake.disable();
    window.clearInterval(this.upTimer);
    window.clearTimeout(this.netTimer);
    window.removeEventListener('online', this.onNet);
    netInfo()?.removeEventListener('change', this.onNet);
    releaseAudioSession();
    this.prewarm();
    if (isDirect(a.nid)) this.direct.delete(a.nid.slice(2));
    this.pruneRooms();
    this.emit();
  }

  /* ------------------------------------------------------- snapshot */

  private build(): CallsSnapshot {
    const now = Date.now();
    const a = this.active;
    const nurseryName = (nid: string) => (nid === 'me' ? DIRECT_PLACE : familyName(this.lines.get(nid)?.nursery));
    const ringing: Ringing[] = [];
    for (const { nid, call, seenAt } of this.calls.values()) {
      if (!this.isRingingForMe(call) || (a && !a.ended && a.id === call.id)) continue;
      // A group call keeps "ringing" you while it's on; a 1:1 stops when the room's timer would.
      if (call.answeredAt == null && now - seenAt > (RING_SECS + 8) * 1000) continue;
      const d = isDirect(nid) ? this.direct.get(call.id) : undefined;
      // A direct call rings only while your line says so.
      if (isDirect(nid) && !d) continue;
      ringing.push({ nid, nursery: nurseryName(nid), call, direct: d?.ctx ?? null });
    }
    let active: ActiveView | null = null;
    if (a) {
      const peers = a.mesh?.views ?? [];
      const state = deriveActiveState(a, peers);
      const failed = peers.find((p) => p.state === 'failed');
      active = {
        nid: a.nid,
        nursery: nurseryName(a.nid),
        id: a.id,
        outgoing: a.outgoing,
        video: a.video,
        state,
        call: a.call,
        peers,
        local: a.local,
        mic: a.mic,
        cam: a.cam,
        canFlip: a.local.getVideoTracks().length > 0,
        facing: a.facing,
        ended: a.ended,
        asked: a.asked,
        since: this.since,
        failText: state === 'failed' ? callFailText(peers) : null,
        why: state === 'failed' ? failed?.why ?? null : null,
        busy: !!a.mesh?.busy,
        relayTest: a.relayOnly,
      };
    }
    return {
      on: this.on && !this.suspended,
      uid: this.uid,
      lines: [...this.lines.values()].filter((l) => !isDirect(l.nid)).map((l) => ({ nid: l.nid, name: l.nursery?.name ?? 'Nursery', baby: l.nursery?.baby ?? null, connected: l.connected })),
      directReady: !!this.ul?.connected,
      ringing,
      active,
      log: recentsOf([this.log.values()]),
      ringOn: this.ringOn,
      favs: this.favs,
      blocked: this.blocked,
      who: this.who,
      notice: this.notice,
    };
  }
}

export const callCenter = new CallCenter();
// Someone added to or removed from a nursery on this device: your line re-reads your family now.
onMembersChanged(() => void callCenter.familyChanged(true));

export function useCalls(): CallsSnapshot {
  return useSyncExternalStore(callCenter.subscribe, callCenter.snapshot, callCenter.snapshot);
}

if (import.meta.env?.DEV) (globalThis as unknown as { __dsCalls?: CallCenter }).__dsCalls = callCenter;
