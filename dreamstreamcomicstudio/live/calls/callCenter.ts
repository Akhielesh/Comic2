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
 *
 * Views read it with useCalls(); nothing here renders.
 */

import { useSyncExternalStore } from 'react';
import { MIC_CONSTRAINTS, type Facing } from '../monitor/camera';
import { listNurseries, openMonitorSocket, type MonitorSocket } from '../monitor/client';
import { currentSubscription, localNotify, subscribe as pushSubscribe } from '../monitor/push';
import { ScreenWakeLock } from '../wakeLock';
import { CallMesh, type PeerView } from './callMesh';
import { CALL_ERROR_TEXT, RING_SECS, type Call, type CallEndWhy, type CallRecord, type CallSignal, type LineMsg } from './types';

interface Line {
  nid: string;
  sock: MonitorSocket;
  connected: boolean;
  me: { sid: string; uid: string; name: string; label: string | null } | null;
  nursery: { id: string; name: string; baby: string | null } | null;
  ice: RTCIceServer[];
  vapid: string | null;
}

export type ActiveState = 'starting' | 'calling' | 'connecting' | 'connected' | 'ended';

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

/** "Aria’s family" — how a nursery reads in calls. */
export const familyName = (n: { name: string; baby: string | null } | null | undefined) => (n?.baby ? `${n.baby}’s family` : n?.name ?? 'Family');
const newRef = () => Math.random().toString(36).slice(2, 10);

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

async function openLocal(video: boolean, facing: Facing): Promise<MediaStream> {
  // Calls want clean speech: unlike the nursery mic, noise suppression and auto-gain are on.
  const audio: MediaTrackConstraints = { ...MIC_CONSTRAINTS, noiseSuppression: true, autoGainControl: true };
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
  private notified = new Set<string>();

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
    for (const fn of this.listeners) fn();
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
    this.ringTimer = window.setInterval(() => this.emit(), 5000);
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
    const line: Line = { nid, sock: null as unknown as MonitorSocket, connected: false, me: null, nursery: { id: nid, name, baby }, ice: [], vapid: null };
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
        line.me = { sid: m.you.sid, uid: m.you.uid, name: m.you.name, label: m.you.label };
        line.nursery = m.nursery;
        line.ice = m.ice ?? [];
        line.vapid = m.vapid;
        this.uid = m.you.uid;
        for (const c of [...this.calls.values()]) if (c.nid === line.nid) this.calls.delete(c.call.id);
        for (const c of m.calls) this.put(line.nid, c);
        for (const r of m.callLog) this.log.set(r.id, { ...r, nid: line.nid, nursery: familyName(m.nursery) });
        if (this.ringOn) void this.sendRing(line);
        // Back after a blip mid-call: point the call at this connection.
        const a = this.active;
        if (a && a.nid === line.nid && a.id && !a.ended) {
          const c = this.calls.get(a.id)?.call;
          if (c) {
            a.call = c;
            line.sock.send({ t: 'call_join', id: a.id, video: a.cam });
          }
        }
        this.emit();
        return;
      }
      case 'call_started': {
        const a = this.active;
        if (a && a.ref === m.ref && a.nid === line.nid) {
          a.id = m.id;
          const c = this.calls.get(m.id)?.call;
          if (c) this.onActiveCall(line, c);
        }
        this.emit();
        return;
      }
      case 'call':
        this.put(line.nid, m.call);
        if (this.active && this.active.nid === line.nid && this.active.id === m.call.id) this.onActiveCall(line, m.call);
        this.maybeNotify(line, m.call);
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

  /** Call people in a nursery (from a tap). */
  async call(nid: string, people: { uid: string; name: string }[], video: boolean): Promise<string | null> {
    if (this.active && !this.active.ended) return 'You’re already in a call.';
    const line = this.lines.get(nid);
    if (!line?.connected) return 'Not connected to this nursery yet — check your internet and try again.';
    let local: MediaStream;
    try {
      local = await openLocal(video, 'user');
    } catch (e) {
      return mediaText(e);
    }
    this.begin({ nid, id: null, ref: newRef(), outgoing: true, video, call: null, local, mic: true, cam: video, facing: 'user', mesh: null, ended: null, asked: people });
    line.sock.send({ t: 'call_start', to: people.map((p) => p.uid), video, ref: this.active!.ref });
    this.emit();
    return null;
  }

  /** Pick up (from a tap). Audio-only answers keep your camera off. */
  async accept(nid: string, id: string, video: boolean): Promise<string | null> {
    const line = this.lines.get(nid);
    const ring = this.calls.get(id);
    if (!line?.connected || !ring) return 'That call has ended.';
    if (this.active && !this.active.ended) this.hangup();
    let local: MediaStream;
    try {
      local = await openLocal(video, 'user');
    } catch (e) {
      return mediaText(e);
    }
    this.begin({ nid, id, ref: newRef(), outgoing: false, video: ring.call.video, call: ring.call, local, mic: true, cam: video, facing: 'user', mesh: null, ended: null, asked: [] });
    line.sock.send({ t: 'call_join', id, video });
    this.emit();
    return null;
  }

  decline(nid: string, id: string): void {
    this.declined.add(id);
    this.lines.get(nid)?.sock.send({ t: 'call_decline', id });
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

  toggleMic(): void {
    const a = this.active;
    if (!a) return;
    a.mic = !a.mic;
    for (const t of a.local.getAudioTracks()) t.enabled = a.mic;
    this.sendMedia();
  }

  async toggleCam(): Promise<string | null> {
    const a = this.active;
    if (!a) return null;
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
  }

  private sendMedia(): void {
    const a = this.active;
    if (a?.id) this.lines.get(a.nid)?.sock.send({ t: 'call_media', id: a.id, mic: a.mic, cam: a.cam });
    this.emit();
  }

  private onActiveCall(line: Line, call: Call): void {
    const a = this.active;
    if (!a || a.ended || !line.me) return;
    a.call = call;
    const mine = call.parts.find((p) => p.sid === line.me!.sid);
    if (!a.mesh && mine) {
      a.mesh = new CallMesh(
        line.me.uid,
        line.ice,
        () => ({ audio: a.local.getAudioTracks()[0] ?? null, video: a.local.getVideoTracks()[0] ?? null }),
        (to: string, d: CallSignal) => line.sock.send({ t: 'call_rtc', id: call.id, to, d }),
        () => {
          if (this.since == null && a.mesh && a.mesh.connectedCount > 0) this.since = Date.now();
          this.emit();
        },
      );
    }
    if (!mine && !call.ended && a.mesh) {
      // This device was moved out of the call (answered on another device).
      this.finish({ why: 'done', text: 'Continued on another device' });
      return;
    }
    a.mesh?.sync(call, line.me.sid);
    if (call.ended) {
      const who = a.asked[0]?.name ?? call.from.label ?? call.from.name;
      this.finish({ why: call.ended.why, text: endText(call.ended.why, a.outgoing, a.asked.length > 1 ? 'No one' : who) });
    }
  }

  private finish(ended: { why: CallEndWhy | 'error'; text: string }): void {
    const a = this.active;
    if (!a || a.ended) return;
    a.ended = ended;
    a.mesh?.close();
    a.mesh = null;
    for (const t of a.local.getTracks()) t.stop();
    void this.wake.disable();
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
      const state: ActiveState = a.ended
        ? 'ended'
        : !a.id || !a.call
          ? a.outgoing ? 'calling' : 'starting'
          : peers.some((p) => p.state === 'connected')
            ? 'connected'
            : a.call.answeredAt != null || !a.outgoing ? 'connecting' : 'calling';
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
