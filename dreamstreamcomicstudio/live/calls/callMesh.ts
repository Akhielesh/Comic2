/**
 * The media side of a family call: one RTCPeerConnection to each other person
 * (a mesh, up to four people), DTLS-SRTP encrypted device to device.
 *
 * Who offers: of any two people, the one who joined the call later — so
 * there's normally no offer glare. Every connection carries an audio and a
 * video transceiver from the start; mute, camera off, flip and turning the
 * camera on mid-call are replaceTrack / enabled flips — no renegotiation.
 *
 * Peers are keyed by person (uid), not by socket: when someone's app
 * reconnects to the room it gets a new socket id, but the media between the
 * phones carries on untouched.
 *
 * Getting connected — and saying so honestly when it can't:
 *  - Each connection has an id (`cid`, chosen by whoever offered it) carried
 *    on every signal: an offer with a new cid is a new connection, one with
 *    the current cid is an ICE restart of it. Signals from one person are
 *    handled strictly one after another.
 *  - A watchdog marks a connection "slow" after 8 s and "failed" after 15 s
 *    (20 s with a relay on offer), with the reason read from the network
 *    candidates each side found (classifyFailure).
 *  - A connection that drops is restarted after 3 s (the offerer restarts;
 *    the other side asks it to), and an unanswered offer is resent every 2 s
 *    (at most 5 in a minute) — the other phone may have been between
 *    connections to the room. Failed connections are rebuilt when either
 *    phone's network changes or comes back to the room, or on "Try again".
 *
 * Relays cost per GB (Cloudflare TURN bills what it sends to the relaying phone), so:
 *  - a connection whose chosen path goes through a relay sends less video (1:1 <= 700 kbps,
 *    groups <= 450 kbps a copy: <= 0.4 GB per relayed call-hour); the path is re-read from
 *    the stats this file already polls, and the cap lifts if the path goes direct;
 *  - relay credentials are short-lived: the room is asked for fresh ones before they lapse
 *    (`refreshIce`), and a relayed connection restarts ICE onto them (the answering side
 *    asks the offerer, `renew`), so a long call never drops when one expires.
 */

import { netPath, pathFromReport, type NetPath } from '../monitor/rtc';
import { applyIce, IceClock, keepRelay, turnKey, turnRenewed } from '../rtcIce';
import type { Call, CallPart, CallSignal } from './types';

export type PeerState = 'connecting' | 'slow' | 'connected' | 'reconnecting' | 'failed';
export type Quality = 'good' | 'fair' | 'poor';
/** Why a connection couldn't be made (or was lost). */
export type FailWhy = 'local_blocked' | 'remote_blocked' | 'nat' | 'relay_failed' | 'no_relay' | 'lost' | 'unknown';

export interface PeerView {
  uid: string;
  name: string;
  label: string | null;
  stream: MediaStream | null;
  state: PeerState;
  why: FailWhy | null;
  mic: boolean;
  cam: boolean;
  /** Their app lost the room (the media may still be fine). */
  away: boolean;
  quality: Quality | null;
  path: NetPath | null;
}

/** How the first connection of this call went (for the call's history). */
export interface MeshStats {
  ttc: number | null;
  path: NetPath | null;
  fail: FailWhy | null;
  turn: boolean;
}

interface Peer {
  uid: string;
  sid: string;
  part: CallPart;
  pc: RTCPeerConnection;
  /** This connection's id; null while we wait for their offer. */
  cid: string | null;
  offerer: boolean;
  /** One stable stream per person (tracks swap inside it, so the video element never reloads). */
  stream: MediaStream;
  pending: RTCIceCandidateInit[];
  state: PeerState;
  why: FailWhy | null;
  born: number;
  everConnected: boolean;
  /** Dropped (disconnected / failed) since, after having been connected. */
  downAt: number | null;
  /** The connection itself reported 'failed'. */
  pcFailed: boolean;
  /** Offers and restart requests sent (the resend budget). */
  sends: number[];
  lastSend: number;
  localTypes: Set<string>;
  remoteTypes: Set<string>;
  quality: Quality | null;
  path: NetPath | null;
  last: { lost: number; got: number } | null;
  ttc: number | null;
}

export const SLOW_MS = 8000;
export const FAIL_MS = 15_000;
export const FAIL_TURN_MS = 20_000;
/** Disconnected this long → restart ICE. */
export const RESTART_AFTER_MS = 3000;
export const RESEND_MS = 2000;
export const MAX_SENDS = 5;
const SEND_WINDOW_MS = 60_000;
/** Reconnecting this long → failed ("lost the connection"). */
export const LOST_MS = 30_000;
/** Waiting this long for their offer → offer ourselves (theirs may have been lost). */
export const ANSWER_WAIT_MS = 4000;
const CPU_STEP_BACK_MS = 120_000;

/** a joined after b (ties broken by socket id) — the later one offers. */
export function joinedAfter(a: Pick<CallPart, 'at' | 'sid'>, b: Pick<CallPart, 'at' | 'sid'>): boolean {
  return a.at > b.at || (a.at === b.at && a.sid > b.sid);
}

/** Each phone uploads one copy per person: share the uplink. */
export function videoBitrate(others: number): number {
  return others <= 1 ? 1_500_000 : others === 2 ? 900_000 : 600_000;
}

/**
 * Through a relay (TURN, $0.05/GB on what the relaying phone receives), a copy of your video
 * never goes above this: 700 kbps one-to-one (with audio and overhead about 0.37 GB per
 * relayed call-hour, from about 0.68 at 1.5 Mbps), 450 kbps a copy in a group.
 */
export const RELAY_VIDEO_BPS = 700_000;
export const RELAY_GROUP_VIDEO_BPS = 450_000;

/** A fresh relay credential lasts at least 3 h 35 min; when the room didn't say, ask again after this. */
export const ICE_REFRESH_MS = 3 * 3600_000;

/**
 * What each copy of your video is encoded at. A mesh runs one encoder per
 * person, so with two or more others each copy drops to 360p (a quarter of
 * the pixels), and to 24 fps with three; a phone that says its CPU is the
 * limit steps down further.
 */
export function encodingFor(others: number, cpuStep = 0, relayed = false): { maxBitrate: number; scaleResolutionDownBy: number; maxFramerate: number } {
  const scale = (others >= 2 ? 2 : 1) * [1, 1.5, 2][Math.max(0, Math.min(2, cpuStep))];
  const fps = others >= 3 ? 24 : 30;
  const bps = relayed ? Math.min(videoBitrate(others), others <= 1 ? RELAY_VIDEO_BPS : RELAY_GROUP_VIDEO_BPS) : videoBitrate(others);
  return { maxBitrate: bps, scaleResolutionDownBy: scale, maxFramerate: cpuStep >= 2 ? Math.min(fps, 20) : fps };
}

export function rateQuality(lossPct: number, rttSec: number | null): Quality {
  if (lossPct > 8 || (rttSec ?? 0) > 0.6) return 'poor';
  if (lossPct > 3 || (rttSec ?? 0) > 0.3) return 'fair';
  return 'good';
}

/** H.264 first (the hardware encoder on iPhones and most Android phones), packetization-mode 1 leading. */
export function preferH264<T extends { mimeType: string; sdpFmtpLine?: string }>(codecs: T[]): T[] {
  const isH264 = (c: T) => /^video\/h264$/i.test(c.mimeType);
  const h264 = codecs.filter(isH264);
  if (!h264.length) return codecs;
  const mode1 = (c: T) => (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 1);
  return [...[...h264].sort((a, b) => mode1(a) - mode1(b)), ...codecs.filter((c) => !isH264(c))];
}

/** A relay (turn:/turns:) server is on the list. */
export function hasTurnServer(ice: RTCIceServer[]): boolean {
  return ice.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u))));
}

/** The configuration every call connection uses (also for ones made ahead of time). */
export function pcConfig(ice: RTCIceServer[], relayOnly = false): RTCConfiguration {
  return { iceServers: ice, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1, ...(relayOnly ? { iceTransportPolicy: 'relay' as const } : {}) };
}

/** 'host' | 'srflx' | 'prflx' | 'relay' from a candidate. */
export function candidateType(c: { type?: string | null; candidate?: string }): string {
  if (c.type) return c.type;
  return / typ (\w+)/.exec(c.candidate ?? '')?.[1] ?? 'unknown';
}

/**
 * Why a connection failed, from the candidate types each side found:
 *  - we found no public address (no srflx / relay): our network blocks it;
 *  - they sent nothing at all: their phone never answered;
 *  - they found only local addresses: their network blocks it;
 *  - both had public addresses: the two networks can't reach each other
 *    directly (symmetric / carrier NAT) — a relay would fix it.
 */
export function classifyFailure(local: Iterable<string>, remote: Iterable<string>, hasTurn: boolean, relayOnly = false): FailWhy {
  const l = new Set(local);
  const r = new Set(remote);
  if (relayOnly && !hasTurn) return 'no_relay';
  const reachable = (s: Set<string>) => s.has('srflx') || s.has('relay') || s.has('prflx');
  if (!reachable(l)) return 'local_blocked';
  if (r.size === 0) return 'unknown';
  if (!reachable(r)) return 'remote_blocked';
  return hasTurn ? 'relay_failed' : 'nat';
}

/** What the screen says about a failed connection. */
export function failureText(why: FailWhy | null, who: string): string {
  switch (why) {
    case 'local_blocked':
      return 'Your network is blocking calls — try switching between Wi-Fi and mobile data.';
    case 'remote_blocked':
      return `${who}’s network is blocking calls — they could try switching between Wi-Fi and mobile data.`;
    case 'nat':
      return 'Can’t connect directly between your two networks — try switching one of you to Wi-Fi.';
    case 'relay_failed':
      return 'Couldn’t connect, even through the relay — check your connection and try again.';
    case 'no_relay':
      return 'Can’t connect directly, and no relay server is set up (relay test mode).';
    case 'lost':
      return `Lost the connection to ${who}.`;
    default:
      return `${who}’s phone isn’t responding.`;
  }
}

const newCid = () => Math.random().toString(36).slice(2, 10);

function preferCodecs(pc: RTCPeerConnection): void {
  try {
    const recv = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
    const send = RTCRtpSender.getCapabilities?.('video')?.codecs;
    // Only when this phone can both encode and decode it.
    if (!recv || !send?.some((c) => /^video\/h264$/i.test(c.mimeType))) return;
    const order = preferH264(recv);
    if (order === recv) return;
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track?.kind === 'video' && typeof t.setCodecPreferences === 'function') t.setCodecPreferences(order);
    }
  } catch { /* unsupported: the browser's default order */ }
}

export interface MeshOptions {
  me: string;
  ice: RTCIceServer[];
  /** Force the relay (TURN) path — for testing that the relay works. */
  relayOnly?: boolean;
  local: () => { audio: MediaStreamTrack | null; video: MediaStreamTrack | null };
  signal: (toSid: string, d: CallSignal) => void;
  onChange: () => void;
  /** A connection made ahead of time (while ringing), its network candidates already gathered. */
  warm?: () => RTCPeerConnection | null;
  /** When to ask for fresh relay credentials (the room's `iceMs`); unknown: ICE_REFRESH_MS when there's a relay. */
  iceMs?: number | null;
  /** The relay credentials are due: ask the room for fresh ones (`{t:'call_ice'}`); they come back through setIce. */
  refreshIce?: () => void;
}

export class CallMesh {
  private peers = new Map<string, Peer>();
  /** Signals from one person, handled one after another. */
  private queues = new Map<string, Promise<void>>();
  /** Candidates that arrived before their connection, by cid. */
  private orphan = new Map<string, RTCIceCandidateInit[]>();
  private statsTimer: number | undefined;
  private tickTimer: number | undefined;
  private closed = false;
  private mySid = '';
  private ice: RTCIceServer[];
  private hasTurn: boolean;
  private cpuStep = 0;
  private cpuHits = 0;
  private cpuAt = 0;
  private cpuNow = false;
  private first: MeshStats | null = null;
  private iceClock: IceClock;

  constructor(private opts: MeshOptions) {
    this.ice = opts.ice;
    this.hasTurn = hasTurnServer(opts.ice);
    this.iceClock = new IceClock(() => this.opts.refreshIce?.());
    this.iceClock.arm(opts.iceMs ?? (this.hasTurn ? ICE_REFRESH_MS : null));
    this.statsTimer = window.setInterval(() => void this.measure(), 3000);
    this.tickTimer = window.setInterval(() => this.tick(), 1000);
  }

  private get failMs(): number {
    return this.hasTurn ? FAIL_TURN_MS : FAIL_MS;
  }

  get views(): PeerView[] {
    return [...this.peers.values()].map((p) => ({
      uid: p.uid,
      name: p.part.name,
      label: p.part.label,
      stream: p.stream,
      state: p.state,
      why: p.state === 'failed' ? p.why : null,
      mic: p.part.mic,
      cam: p.part.cam,
      away: p.part.gone != null,
      quality: p.quality,
      path: p.path,
    }));
  }

  get connectedCount(): number {
    return [...this.peers.values()].filter((p) => p.state === 'connected').length;
  }

  /** The people whose media is reaching us right now (the room keeps them in the call). */
  get connectedUids(): string[] {
    return [...this.peers.values()].filter((p) => p.state === 'connected').map((p) => p.uid);
  }

  /** This phone's encoder can't keep up (CPU-limited) — video is being lowered. */
  get busy(): boolean {
    return this.cpuNow;
  }

  get relayOffered(): boolean {
    return this.hasTurn;
  }

  /** The first connection's outcome (null until something happened). */
  get outcome(): MeshStats | null {
    return this.first;
  }

  /** The call's members changed (from the room). */
  sync(call: Call, mySid: string): void {
    if (this.closed) return;
    this.mySid = mySid;
    const others = call.parts.filter((p) => p.uid !== this.opts.me);
    for (const [uid, p] of this.peers) {
      if (!others.some((o) => o.uid === uid)) {
        this.drop(p);
        this.peers.delete(uid);
      }
    }
    const mine = call.parts.find((p) => p.sid === mySid);
    for (const o of others) {
      const peer = this.peers.get(o.uid);
      if (peer) {
        const moved = peer.sid !== o.sid;
        peer.sid = o.sid;
        peer.part = o;
        // Back in the room on a new connection: pick up where the handshake stopped.
        if (moved && o.gone == null) this.revive(peer);
        continue;
      }
      if (o.gone != null) continue; // away: connect when they're back
      // The newer of the two offers; the other gets ready and waits for it.
      if (mine && joinedAfter(mine, o)) this.offer(this.create(o, true, newCid()));
      else this.create(o, false, null);
    }
    this.retune();
    this.opts.onChange();
  }

  onSignal(fromSid: string, d: CallSignal, call: Call): Promise<void> {
    if (this.closed) return Promise.resolve();
    const part = call.parts.find((p) => p.sid === fromSid);
    if (!part || part.uid === this.opts.me) return Promise.resolve();
    return this.enqueue(part.uid, () => this.handle(part, d));
  }

  /**
   * Our network changed, or we're back in the room: get every stuck connection
   * moving now. A failed one starts over (its candidates belong to the old network).
   */
  kick(): void {
    if (this.closed) return;
    for (const p of [...this.peers.values()]) {
      if (p.part.gone != null) continue;
      if (p.state === 'failed') this.rebuild(p);
      else this.revive(p);
    }
    this.opts.onChange();
  }

  /** "Try again": start over every connection that isn't up, with this phone offering. */
  retry(): void {
    if (this.closed) return;
    for (const p of [...this.peers.values()]) {
      if (p.state === 'connected' || p.part.gone != null) continue;
      this.rebuild(p);
    }
    this.opts.onChange();
  }

  /**
   * Fresh relay credentials for this call (`iceMs`: when to ask again). Every later connection
   * and restart uses them; a connection going through a relay on the ones they replace
   * restarts onto them now, before those lapse.
   */
  setIce(list: RTCIceServer[], iceMs?: number | null): void {
    if (!list.length) return;
    const ice = keepRelay(this.ice, list);
    const renewed = turnRenewed(this.ice, ice);
    this.ice = ice;
    this.hasTurn = hasTurnServer(ice);
    this.iceClock.arm(iceMs ?? (this.hasTurn ? ICE_REFRESH_MS : null));
    for (const p of this.peers.values()) {
      applyIce(p.pc, ice);
      if (renewed && p.path === 'relay' && p.state === 'connected') this.renew(p);
    }
  }

  /** Move a working relayed connection onto fresh credentials: the offerer restarts it, the other side asks it to. */
  private renew(p: Peer): void {
    if (this.closed || p.cid == null) return;
    if (p.offerer) this.restart(p);
    else this.signal(p, { restart: true, renew: true });
  }

  /** Local tracks changed (camera turned on, flipped, opened late): every connection sends the new ones. */
  refreshLocal(): void {
    for (const p of this.peers.values()) this.attach(p);
    this.retune();
  }

  close(): void {
    this.closed = true;
    this.iceClock.stop();
    window.clearInterval(this.statsTimer);
    window.clearInterval(this.tickTimer);
    for (const p of this.peers.values()) this.drop(p);
    this.peers.clear();
    this.orphan.clear();
  }

  /* ------------------------------------------------------- connections */

  private create(part: CallPart, offerer: boolean, cid: string | null, born = Date.now(), stream?: MediaStream): Peer {
    const warm = this.opts.warm?.() ?? null;
    // Made while ringing with the line's credentials: if fresher ones came since (the line
    // reconnected), gather with those; expired ones would leave it with no relay at all.
    if (warm && turnKey(warm.getConfiguration?.().iceServers) !== turnKey(this.ice)) applyIce(warm, this.ice);
    const pc = warm ?? new RTCPeerConnection(pcConfig(this.ice, this.opts.relayOnly));
    if (stream) for (const t of stream.getTracks()) stream.removeTrack(t);
    const peer: Peer = {
      uid: part.uid, sid: part.sid, part, pc, cid, offerer, stream: stream ?? new MediaStream(), pending: [], state: 'connecting', why: null,
      born, everConnected: false, downAt: null, pcFailed: false, sends: [], lastSend: 0, localTypes: new Set(), remoteTypes: new Set(),
      quality: null, path: null, last: null, ttc: null,
    };
    this.peers.set(part.uid, peer);
    if (offerer) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      preferCodecs(pc);
      this.attach(peer);
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate || this.peers.get(peer.uid) !== peer) return;
      peer.localTypes.add(candidateType(e.candidate));
      this.signal(peer, { cand: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (this.peers.get(peer.uid) !== peer) return;
      for (const t of peer.stream.getTracks()) if (t.kind === e.track.kind && t !== e.track) peer.stream.removeTrack(t);
      if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
      this.opts.onChange();
    };
    pc.onconnectionstatechange = () => this.onState(peer);
    if (cid) this.adopt(peer);
    return peer;
  }

  /** Start over with a new connection that this phone offers. */
  private rebuild(p: Peer): Peer {
    this.drop(p);
    const fresh = this.create(p.part, true, newCid(), Date.now(), p.stream);
    this.offer(fresh);
    return fresh;
  }

  private drop(p: Peer): void {
    p.pc.onicecandidate = null;
    p.pc.ontrack = null;
    p.pc.onconnectionstatechange = null;
    try {
      p.pc.close();
    } catch { /* closed */ }
  }

  private onState(peer: Peer): void {
    if (this.peers.get(peer.uid) !== peer) return;
    const s = peer.pc.connectionState;
    const now = Date.now();
    if (s === 'connected') {
      if (!peer.everConnected) peer.ttc = now - peer.born;
      peer.everConnected = true;
      peer.state = 'connected';
      peer.why = null;
      peer.downAt = null;
      peer.pcFailed = false;
      peer.sends = [];
      this.retune();
      void netPath(peer.pc).then((path) => {
        peer.path = path;
        if (path === 'relay') this.retune(); // a relayed copy is capped from the start
        if (this.first?.ttc == null && peer.ttc != null) this.first = { ttc: peer.ttc, path, fail: this.first?.fail ?? null, turn: this.hasTurn };
        this.opts.onChange();
      });
    } else if (s === 'disconnected' || s === 'failed') {
      if (peer.everConnected) {
        peer.downAt ??= now;
        if (peer.state !== 'failed') peer.state = 'reconnecting';
      }
      if (s === 'failed') {
        peer.pcFailed = true;
        if (!peer.everConnected) this.fail(peer, this.classify(peer));
        this.nudge(peer, now, true);
      }
    }
    this.opts.onChange();
  }

  private fail(p: Peer, why: FailWhy): void {
    p.state = 'failed';
    p.why = why;
    this.first ??= { ttc: null, path: null, fail: why, turn: this.hasTurn };
  }

  private classify(p: Peer): FailWhy {
    return classifyFailure(p.localTypes, p.remoteTypes, this.hasTurn, this.opts.relayOnly);
  }

  /** Once a second: the connect watchdog, and keeping handshakes moving. */
  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    let changed = false;
    for (const p of [...this.peers.values()]) {
      if (p.state === 'connected') continue;
      const before = p.state;
      if (!p.everConnected) {
        // Their offer never came (lost on the way?): offer ourselves.
        if (!p.offerer && p.cid == null && p.part.gone == null && now - p.born >= ANSWER_WAIT_MS) {
          const fresh = this.rebuild(p);
          fresh.born = p.born;
          changed = true;
          continue;
        }
        const age = now - p.born;
        if (p.state !== 'failed' && age >= this.failMs) this.fail(p, this.classify(p));
        else if (p.state === 'connecting' && age >= SLOW_MS) p.state = 'slow';
      } else if (p.downAt != null && p.state !== 'failed' && now - p.downAt >= LOST_MS) {
        this.fail(p, 'lost');
      }
      if (p.state !== before) changed = true;
      if (p.part.gone == null) this.nudge(p, now);
    }
    if (changed) this.opts.onChange();
  }

  /**
   * Keep a handshake moving: resend an offer nobody answered (the other phone
   * may have been between connections to the room), or restart a connection
   * that dropped — the offerer restarts, the other side asks it to.
   */
  private nudge(p: Peer, now: number, urgent = false, asked = false): void {
    if (this.closed || (p.state === 'connected' && !asked)) return;
    if (!urgent && now - p.lastSend < RESEND_MS) return;
    p.sends = p.sends.filter((t) => now - t < SEND_WINDOW_MS);
    if (p.sends.length >= MAX_SENDS) return;
    const pc = p.pc;
    if (p.offerer && pc.signalingState === 'have-local-offer' && pc.localDescription) {
      this.budget(p, now);
      this.signal(p, { sdp: pc.localDescription.toJSON() });
      return;
    }
    // `asked`: the other side lost the connection and asked us to restart it.
    const down = asked || p.pcFailed || (p.downAt != null && now - p.downAt >= RESTART_AFTER_MS);
    if (!down || p.cid == null) return;
    this.budget(p, now);
    if (p.offerer) this.restart(p);
    else this.signal(p, { restart: true });
  }

  /** Something changed (their new room connection, our network): act now rather than on the next tick. */
  private revive(p: Peer): void {
    if (p.state === 'connected') return;
    const now = Date.now();
    if (p.state === 'failed' && !(p.offerer && p.pc.signalingState === 'have-local-offer')) {
      this.rebuild(p);
      return;
    }
    p.lastSend = 0;
    p.sends = [];
    this.nudge(p, now, true);
  }

  private budget(p: Peer, now: number): void {
    p.sends.push(now);
    p.lastSend = now;
  }

  private signal(p: Peer, d: CallSignal): void {
    if (p.cid == null) return;
    this.opts.signal(p.sid, { ...d, cid: p.cid } as CallSignal);
  }

  private enqueue(uid: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(uid) ?? Promise.resolve()).then(fn).catch(() => undefined);
    this.queues.set(uid, next);
    return next;
  }

  private offer(p: Peer): void {
    this.budget(p, Date.now());
    void this.enqueue(p.uid, async () => {
      if (this.peers.get(p.uid) !== p) return;
      try {
        await p.pc.setLocalDescription(await p.pc.createOffer());
        this.signal(p, { sdp: p.pc.localDescription!.toJSON() });
      } catch {
        this.fail(p, 'unknown');
        this.opts.onChange();
      }
    });
  }

  private restart(p: Peer): void {
    void this.enqueue(p.uid, async () => {
      if (this.peers.get(p.uid) !== p || p.pc.connectionState === 'closed') return;
      try {
        p.pc.restartIce?.();
        await p.pc.setLocalDescription(await p.pc.createOffer({ iceRestart: true }));
        this.signal(p, { sdp: p.pc.localDescription!.toJSON() });
      } catch { /* the next nudge tries again */ }
    });
  }

  private async handle(part: CallPart, d: CallSignal): Promise<void> {
    if (this.closed) return;
    const cid = d.cid || 'legacy';
    let peer = this.peers.get(part.uid);
    if (peer) {
      peer.sid = part.sid;
      peer.part = part;
    }
    if ('sdp' in d) {
      if (d.sdp.type === 'offer') {
        if (!peer) peer = this.create(part, false, cid);
        else if (peer.cid == null && !peer.offerer) {
          peer.cid = cid;
          this.adopt(peer);
        } else if (peer.cid !== cid) {
          // A different connection from them: they reloaded, rebuilt, or moved to another device.
          const mineInFlight = peer.offerer && peer.pc.signalingState === 'have-local-offer' && peer.state !== 'connected';
          if (mineInFlight && this.mySid > part.sid) return; // we both offered at once — ours stands, they'll take it
          this.drop(peer);
          peer = this.create(part, false, cid, Date.now(), peer.stream);
        }
        await this.answer(peer, d.sdp);
      } else if (d.sdp.type === 'answer' && peer?.offerer && peer.cid === cid && peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(d.sdp);
        peer.sends = [];
        await this.flush(peer);
      }
    } else if ('cand' in d) {
      if (peer && peer.cid === cid) {
        peer.remoteTypes.add(candidateType(d.cand));
        if (!peer.pc.remoteDescription) peer.pending.push(d.cand);
        else await peer.pc.addIceCandidate(d.cand).catch(() => undefined);
      } else {
        this.orphan.set(cid, [...(this.orphan.get(cid) ?? []), d.cand].slice(-40));
        if (this.orphan.size > 8) this.orphan.delete(this.orphan.keys().next().value!);
      }
    } else if ('restart' in d && d.renew) {
      // Their relay credentials were renewed: restart this working connection onto them (if it's ours to offer).
      if (peer && peer.cid === cid && peer.offerer && peer.state === 'connected') this.nudge(peer, Date.now(), true, true);
    } else if ('restart' in d) {
      // They want this connection restarted (only its offerer may), or a new one.
      if (!peer) this.offer(this.create(part, true, newCid()));
      else if (peer.state === 'connected' && peer.pc.connectionState === 'connected') return;
      else if (peer.cid === cid && peer.offerer) this.nudge(peer, Date.now(), true, true);
      else if (peer.cid !== cid) {
        // They're stuck on a connection we've moved on from: resend ours if it's waiting on them, else start fresh.
        if (peer.offerer && peer.pc.signalingState === 'have-local-offer') this.revive(peer);
        else this.rebuild(peer);
      }
    }
    this.opts.onChange();
  }

  private async answer(peer: Peer, sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = peer.pc;
    // The same offer again (resent while our answer was on its way): just answer again.
    if (pc.signalingState === 'stable' && pc.remoteDescription?.sdp === sdp.sdp && pc.localDescription?.type === 'answer') {
      this.signal(peer, { sdp: pc.localDescription.toJSON() });
      return;
    }
    if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
    await pc.setRemoteDescription(sdp);
    this.attach(peer);
    preferCodecs(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    this.signal(peer, { sdp: pc.localDescription!.toJSON() });
    await this.flush(peer);
  }

  /** Candidates that came before we knew which connection they belonged to. */
  private adopt(peer: Peer): void {
    if (!peer.cid) return;
    const early = this.orphan.get(peer.cid);
    if (!early) return;
    this.orphan.delete(peer.cid);
    for (const c of early) peer.remoteTypes.add(candidateType(c));
    peer.pending.push(...early);
  }

  /** Send our current tracks on this connection (answerer: after the offer created the transceivers). */
  private attach(peer: Peer): void {
    const { audio, video } = this.opts.local();
    for (const t of peer.pc.getTransceivers()) {
      if (t.direction === 'stopped' || t.currentDirection === 'stopped') continue;
      const kind = t.receiver.track?.kind;
      const track = kind === 'audio' ? audio : kind === 'video' ? video : null;
      if (t.sender.track !== track) void t.sender.replaceTrack(track).catch(() => undefined);
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const q = peer.pending.splice(0);
    for (const c of q) await peer.pc.addIceCandidate(c).catch(() => undefined);
  }

  /** Share the uplink and the phone's encoder between everyone we send to (less through a relay). */
  private retune(): void {
    for (const p of this.peers.values()) {
      const enc = encodingFor(this.peers.size, this.cpuStep, p.path === 'relay');
      const sender = p.pc.getTransceivers().find((t) => (t.sender.track?.kind ?? t.receiver.track?.kind) === 'video')?.sender;
      if (!sender) continue;
      try {
        const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
        if (!params.encodings?.length) continue;
        const e = params.encodings[0];
        if (e.maxBitrate === enc.maxBitrate && e.scaleResolutionDownBy === enc.scaleResolutionDownBy && e.maxFramerate === enc.maxFramerate) continue;
        e.maxBitrate = enc.maxBitrate;
        e.scaleResolutionDownBy = enc.scaleResolutionDownBy;
        e.maxFramerate = enc.maxFramerate;
        // Smooth motion beats sharpness in a conversation: drop resolution first.
        params.degradationPreference = 'maintain-framerate';
        void sender.setParameters(params).catch(() => undefined);
      } catch { /* older browsers: congestion control still adapts */ }
    }
  }

  /** Connection quality per person (packet loss, round-trip time), and whether our encoder keeps up. */
  private async measure(): Promise<void> {
    let changed = false;
    let relayChanged = false;
    let cpu = false;
    let sending = false;
    for (const p of this.peers.values()) {
      if (p.state !== 'connected') continue;
      try {
        const stats = await p.pc.getStats();
        let lost = 0;
        let got = 0;
        let rtt: number | null = null;
        stats.forEach((r: { type: string; kind?: string; packetsLost?: number; packetsReceived?: number; state?: string; nominated?: boolean; currentRoundTripTime?: number; qualityLimitationReason?: string; framesPerSecond?: number }) => {
          if (r.type === 'inbound-rtp') {
            lost += r.packetsLost ?? 0;
            got += r.packetsReceived ?? 0;
          }
          if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.framesPerSecond ?? 0) > 0) {
            sending = true;
            if (r.qualityLimitationReason === 'cpu') cpu = true;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
        });
        // The path can change under a live connection (an ICE restart, a network change): a relay is capped.
        const path = pathFromReport(stats as unknown as Parameters<typeof pathFromReport>[0]);
        if (path && path !== p.path) {
          p.path = path;
          relayChanged = true;
          changed = true;
        }
        const dLost = p.last ? lost - p.last.lost : 0;
        const dGot = p.last ? got - p.last.got : 0;
        p.last = { lost, got };
        const pct = dGot + dLost > 0 ? (100 * Math.max(0, dLost)) / (dGot + Math.max(0, dLost)) : 0;
        const q = rateQuality(pct, rtt);
        if (q !== p.quality) {
          p.quality = q;
          changed = true;
        }
      } catch { /* closed */ }
    }
    if (relayChanged) this.retune();
    // The phone's CPU is the limit twice running: encode less. Back up after two quiet minutes.
    const now = Date.now();
    this.cpuHits = cpu ? this.cpuHits + 1 : 0;
    if (cpu) this.cpuAt = now;
    if (this.cpuHits >= 2 && this.cpuStep < 2) {
      this.cpuStep += 1;
      this.cpuHits = 0;
      this.retune();
    } else if (!cpu && sending && this.cpuStep > 0 && now - this.cpuAt > CPU_STEP_BACK_MS) {
      this.cpuStep -= 1;
      this.cpuAt = now;
      this.retune();
    }
    if (cpu !== this.cpuNow) {
      this.cpuNow = cpu;
      changed = true;
    }
    if (changed) this.opts.onChange();
  }
}
