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
 *
 * Views read it with useCalls(); nothing here renders.
 */

import { useSyncExternalStore } from 'react';
import { MIC_CONSTRAINTS, preferSpeaker, type Facing } from '../monitor/camera';
import { listNurseries, openMonitorSocket, type MonitorSocket } from '../monitor/client';
import { currentSubscription, localNotify, subscribe as pushSubscribe } from '../monitor/push';
import { ScreenWakeLock } from '../wakeLock';
import { CallMesh, failureText, pcConfig, type FailWhy, type PeerView } from './callMesh';
import { CALL_ERROR_TEXT, RING_SECS, type Call, type CallEndWhy, type CallPart, type CallRecord, type CallSignal, type LineMsg } from './types';

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
  /** The last connection outcome told to the room (telemetry). */
  reported: string | null;
  rejoinAt: number;
}

export interface Ringing {
  nid: string;
  nursery: string;
  call: Call;
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
  lines: { nid: string; name: string; baby: string | null; connected: boolean }[];
  ringing: Ringing[];
  active: ActiveView | null;
  log: (CallRecord & { nid: string; nursery: string })[];
  ringOn: boolean;
}

const RING_KEY = 'ds-call-ring';
const RELAY_KEY = 'ds-calls-relay';
/** A line this quiet may be dead (a network change can leave a socket OPEN): check it before a call. */
const SILENT_MS = 30_000;
/** Relay credentials from a line's hello stay good for 23 h+; refresh before then. */
const ICE_MAX_AGE_MS = 20 * 60 * 60_000;
/** While connected, tell the room every 10 s whose media still reaches us. */
const VOUCH_MS = 10_000;

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

/** `#/call/<nursery>/<call>?answer=1` — opened by "Answer" on a call notification (public/live-sw.js). */
export function answerFromHash(hash: string): { nid: string; id: string } | null {
  const m = /^#\/?call\/([0-9a-f-]{36})\/([0-9a-f]{8,24})\?(.*)$/.exec(hash);
  if (!m || new URLSearchParams(m[3]).get('answer') !== '1') return null;
  return { nid: m[1], id: m[2] };
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
  private lines = new Map<string, Line>();
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
  }

  /* ---------------------------------------------------------- lines */

  /** Signed in: open a line to each nursery. */
  start(): void {
    if (this.on) return;
    this.on = true;
    void this.refresh();
    this.refreshTimer = window.setInterval(() => void this.refresh(), 10 * 60_000);
    document.addEventListener('visibilitychange', this.onVis);
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
    this.hangup();
    for (const l of this.lines.values()) l.sock.close();
    this.lines.clear();
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
    if (s && !this.active) {
      for (const l of this.lines.values()) l.sock.close();
      this.lines.clear();
      this.calls.clear();
      this.prewarm();
      this.emit();
    } else if (!s) void this.refresh();
  }

  private onVis = () => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  /** Pick up nurseries created or joined since the last look. */
  async refresh(): Promise<void> {
    if (!this.on || this.suspended) return;
    const r = await listNurseries();
    if (!this.on || this.suspended || !r.ok || !r.nurseries) return;
    const want = new Set(r.nurseries.map((n) => n.id));
    for (const [nid, l] of this.lines) {
      if (!want.has(nid)) {
        l.sock.close();
        this.lines.delete(nid);
      }
    }
    for (const n of r.nurseries) if (!this.lines.has(n.id)) this.openLine(n.id, n.name, n.baby_name);
    this.emit();
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
        line.nursery = m.nursery;
        line.ice = m.ice ?? [];
        line.iceAt = now;
        line.helloAt = now;
        line.vapid = m.vapid;
        this.uid = m.you.uid;
        for (const c of [...this.calls.values()]) if (c.nid === line.nid) this.calls.delete(c.call.id);
        for (const c of m.calls) this.put(line.nid, c);
        for (const r of m.callLog) this.log.set(r.id, { ...r, nid: line.nid, nursery: familyName(m.nursery) });
        if (this.ringOn) void this.sendRing(line);
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
        }
        this.emit();
        return;
      }
      case 'call_joined': {
        const a = this.active;
        if (a && a.id === m.id && a.nid === line.nid && m.ice?.length) {
          a.ice = m.ice;
          a.mesh?.setIce(m.ice);
        }
        return;
      }
      case 'call':
        this.put(line.nid, m.call);
        if (this.active && this.active.nid === line.nid && this.active.id === m.call.id) this.onActiveCall(line, m.call);
        this.maybeNotify(line, m.call);
        this.prewarm();
        this.emit();
        return;
      case 'call_err': {
        const a = this.active;
        if (a && a.nid === line.nid && ((m.ref && a.ref === m.ref) || (m.id && a.id === m.id))) this.finish({ why: 'error', text: CALL_ERROR_TEXT[m.error] ?? 'The call couldn’t connect.' });
        this.emit();
        return;
      }
      case 'call_rtc': {
        const a = this.active;
        if (a && a.nid === line.nid && a.id === m.id && a.call && a.mesh) void a.mesh.onSignal(m.from, m.d, a.call);
        return;
      }
      case 'call_log':
        this.log.set(m.rec.id, { ...m.rec, nid: line.nid, nursery: familyName(line.nursery) });
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
    void localNotify(`📹 ${call.from.label || call.from.name}`, `${call.video ? 'Video' : 'Audio'} call · ${familyName(line.nursery)}`, `call-${call.id}`, `/live#/call/${line.nid}/${call.id}`);
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

  /** Ring this device with the app closed (from a tap — it asks for notification permission). */
  async enableRinging(): Promise<{ ok: true } | { error: string }> {
    const vapid = [...this.lines.values()].find((l) => l.vapid)?.vapid;
    if (!vapid) return { error: 'Not connected yet — try again in a moment.' };
    const r = await pushSubscribe(vapid);
    if ('error' in r) return { error: r.error };
    try {
      localStorage.setItem(RING_KEY, '1');
    } catch { /* storage unavailable */ }
    for (const l of this.lines.values()) l.sock.send({ t: 'call_push', sub: r });
    this.emit();
    return { ok: true };
  }

  async disableRinging(): Promise<void> {
    try {
      localStorage.removeItem(RING_KEY);
    } catch { /* storage unavailable */ }
    const sub = await currentSubscription();
    if (sub) for (const l of this.lines.values()) l.sock.send({ t: 'call_push_off', endpoint: sub.endpoint });
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
   * Pick up (from a tap). Joins at once and builds the connections right
   * behind the join (the room handles one socket's messages in order); the
   * camera and mic open in parallel and slot in when they're ready. If they
   * can't open, you stay in the call to see and hear the others, shown as
   * muted with the camera off. Audio-only answers keep your camera off.
   */
  async accept(nid: string, id: string, video: boolean): Promise<string | null> {
    const line = this.lines.get(nid);
    if (!line?.connected || !this.calls.has(id)) return 'That call has ended.';
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

  decline(nid: string, id: string): void {
    this.declined.add(id);
    this.lines.get(nid)?.sock.send({ t: 'call_decline', id });
    this.prewarm();
    this.emit();
  }

  hangup(): void {
    const a = this.active;
    if (!a) return;
    if (!a.ended) {
      if (a.id) this.lines.get(a.nid)?.sock.send({ t: 'call_leave', id: a.id });
      this.finish({ why: 'done', text: 'Call ended' });
    }
    this.active = null;
    this.emit();
  }

  /** Close the "call ended" screen. */
  dismiss(): void {
    if (this.active?.ended) {
      this.active = null;
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

  /** Mute / unmute. A mic that couldn't open when answering is opened now (from the tap). */
  async toggleMic(): Promise<string | null> {
    const a = this.active;
    if (!a) return null;
    if (!a.mic && !a.opening && !a.local.getAudioTracks().length) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: callAudio() });
        a.local = new MediaStream([...a.local.getTracks(), ...s.getAudioTracks()]);
        a.mesh?.refreshLocal();
      } catch (e) {
        return mediaText(e);
      }
    }
    a.mic = !a.mic;
    for (const t of a.local.getAudioTracks()) t.enabled = a.mic;
    this.sendMedia();
    return null;
  }

  async toggleCam(): Promise<string | null> {
    const a = this.active;
    if (!a || a.opening) return null; // the camera is still starting (a second or so after answering)
    const v = a.local.getVideoTracks()[0];
    if (v) {
      a.cam = !a.cam;
      v.enabled = a.cam;
    } else {
      // An audio call turning its camera on: open it now, no renegotiation needed.
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: a.facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        a.local.addTrack(s.getVideoTracks()[0]);
        a.local = new MediaStream(a.local.getTracks());
        a.cam = true;
        a.mesh?.refreshLocal();
      } catch (e) {
        return mediaText(e);
      }
    }
    this.sendMedia();
    return null;
  }

  /** Front ⇄ back camera. */
  async flip(): Promise<void> {
    const a = this.active;
    const old = a?.local.getVideoTracks()[0];
    if (!a || !old) return;
    const facing: Facing = a.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } });
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
    if (a?.id && uids.length) this.lines.get(a.nid)?.sock.send({ t: 'call_invite', id: a.id, to: uids });
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

  private sendMedia(): void {
    const a = this.active;
    if (a?.id) this.lines.get(a.nid)?.sock.send({ t: 'call_media', id: a.id, mic: a.mic, cam: a.cam });
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
    this.emit();
  }

  /* ------------------------------------------------------- snapshot */

  private build(): CallsSnapshot {
    const now = Date.now();
    const a = this.active;
    const nurseryName = (nid: string) => familyName(this.lines.get(nid)?.nursery);
    const ringing: Ringing[] = [];
    for (const { nid, call, seenAt } of this.calls.values()) {
      if (!this.isRingingForMe(call) || (a && !a.ended && a.id === call.id)) continue;
      // A group call keeps "ringing" you while it's on; a 1:1 stops when the room's timer would.
      if (call.answeredAt == null && now - seenAt > (RING_SECS + 8) * 1000) continue;
      ringing.push({ nid, nursery: nurseryName(nid), call });
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
      lines: [...this.lines.values()].map((l) => ({ nid: l.nid, name: l.nursery?.name ?? 'Nursery', baby: l.nursery?.baby ?? null, connected: l.connected })),
      ringing,
      active,
      log: [...this.log.values()].sort((x, y) => y.at - x.at).slice(0, 40),
      ringOn: this.ringOn,
    };
  }
}

export const callCenter = new CallCenter();

export function useCalls(): CallsSnapshot {
  return useSyncExternalStore(callCenter.subscribe, callCenter.snapshot, callCenter.snapshot);
}

if (import.meta.env?.DEV) (globalThis as unknown as { __dsCalls?: CallCenter }).__dsCalls = callCenter;
