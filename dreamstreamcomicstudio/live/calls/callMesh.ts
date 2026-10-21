/**
 * The media side of a family call: one RTCPeerConnection to each other person
 * (a mesh, up to four people), DTLS-SRTP encrypted device to device.
 *
 * Who offers: of any two people, the one who joined the call later — so
 * there's never offer glare. Every connection carries an audio and a video
 * transceiver from the start; mute, camera off, flip and turning the camera
 * on mid-call are replaceTrack / enabled flips — no renegotiation.
 *
 * Peers are keyed by person (uid), not by socket: when someone's app
 * reconnects to the room it gets a new socket id, but the media between the
 * phones carries on untouched.
 */

import { netPath, type NetPath } from '../monitor/rtc';
import type { Call, CallPart, CallSignal } from './types';

export type PeerState = 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type Quality = 'good' | 'fair' | 'poor';

export interface PeerView {
  uid: string;
  name: string;
  label: string | null;
  stream: MediaStream | null;
  state: PeerState;
  mic: boolean;
  cam: boolean;
  /** Their app lost the room (the media may still be fine). */
  away: boolean;
  quality: Quality | null;
  path: NetPath | null;
}

interface Peer {
  uid: string;
  sid: string;
  part: CallPart;
  pc: RTCPeerConnection;
  offerer: boolean;
  stream: MediaStream | null;
  pending: RTCIceCandidateInit[];
  state: PeerState;
  restarts: number;
  quality: Quality | null;
  path: NetPath | null;
  last: { lost: number; got: number } | null;
}

/** a joined after b (ties broken by socket id) — the later one offers. */
export function joinedAfter(a: Pick<CallPart, 'at' | 'sid'>, b: Pick<CallPart, 'at' | 'sid'>): boolean {
  return a.at > b.at || (a.at === b.at && a.sid > b.sid);
}

/** Each phone uploads one copy per person: share the uplink. */
export function videoBitrate(others: number): number {
  return others <= 1 ? 1_500_000 : others === 2 ? 900_000 : 600_000;
}

export function rateQuality(lossPct: number, rttSec: number | null): Quality {
  if (lossPct > 8 || (rttSec ?? 0) > 0.6) return 'poor';
  if (lossPct > 3 || (rttSec ?? 0) > 0.3) return 'fair';
  return 'good';
}

export class CallMesh {
  private peers = new Map<string, Peer>();
  /** Candidates that arrived before their offer. */
  private orphan = new Map<string, RTCIceCandidateInit[]>();
  private statsTimer: number | undefined;
  private closed = false;

  constructor(
    private me: string,
    private ice: RTCIceServer[],
    private local: () => { audio: MediaStreamTrack | null; video: MediaStreamTrack | null },
    private signal: (toSid: string, d: CallSignal) => void,
    private onChange: () => void,
  ) {
    this.statsTimer = window.setInterval(() => void this.measure(), 3000);
  }

  get views(): PeerView[] {
    return [...this.peers.values()].map((p) => ({
      uid: p.uid,
      name: p.part.name,
      label: p.part.label,
      stream: p.stream,
      state: p.state,
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

  /** The call's members changed (from the room). */
  sync(call: Call, mySid: string): void {
    if (this.closed) return;
    const others = call.parts.filter((p) => p.uid !== this.me);
    for (const [uid, p] of this.peers) {
      if (!others.some((o) => o.uid === uid)) {
        p.pc.close();
        this.peers.delete(uid);
      }
    }
    const mine = call.parts.find((p) => p.sid === mySid);
    for (const o of others) {
      const peer = this.peers.get(o.uid);
      if (peer) {
        peer.sid = o.sid;
        peer.part = o;
        continue;
      }
      // The newer of the two offers; the other waits for it.
      if (mine && joinedAfter(mine, o) && o.gone == null) void this.offer(this.create(o, true));
    }
    this.retune();
    this.onChange();
  }

  async onSignal(fromSid: string, d: CallSignal, call: Call): Promise<void> {
    if (this.closed) return;
    const part = call.parts.find((p) => p.sid === fromSid);
    if (!part || part.uid === this.me) return;
    let peer = this.peers.get(part.uid);
    try {
      if ('sdp' in d) {
        if (d.sdp.type === 'offer') {
          // A fresh offer from someone we were offering to means they started over (reloaded): start over too.
          const stale = peer && (peer.offerer || peer.pc.connectionState === 'failed' || peer.pc.connectionState === 'closed');
          if (!peer || stale) {
            peer?.pc.close();
            peer = this.create(part, false);
          }
          peer.sid = fromSid;
          await peer.pc.setRemoteDescription(d.sdp);
          this.attach(peer);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.signal(peer.sid, { sdp: peer.pc.localDescription!.toJSON() });
          await this.flush(peer);
        } else if (d.sdp.type === 'answer' && peer && peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(d.sdp);
          await this.flush(peer);
        }
      } else if ('cand' in d) {
        if (!peer) {
          this.orphan.set(fromSid, [...(this.orphan.get(fromSid) ?? []), d.cand].slice(-40));
        } else if (!peer.pc.remoteDescription) peer.pending.push(d.cand);
        else await peer.pc.addIceCandidate(d.cand).catch(() => undefined);
      }
    } catch {
      /* a bad or out-of-order message: the next offer recovers */
    }
  }

  /** Local tracks changed (camera turned on, flipped): every connection sends the new ones. */
  refreshLocal(): void {
    for (const p of this.peers.values()) this.attach(p);
    this.retune();
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.statsTimer);
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
  }

  private create(part: CallPart, offerer: boolean): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const peer: Peer = { uid: part.uid, sid: part.sid, part, pc, offerer, stream: null, pending: [], state: 'connecting', restarts: 0, quality: null, path: null, last: null };
    this.peers.set(part.uid, peer);
    if (offerer) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      this.attach(peer);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peer.sid, { cand: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const tracks = [...(peer.stream?.getTracks() ?? []).filter((t) => t.kind !== e.track.kind), e.track];
      peer.stream = new MediaStream(tracks);
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (this.peers.get(peer.uid) !== peer) return;
      if (s === 'connected') {
        peer.state = 'connected';
        peer.restarts = 0;
        this.retune();
        void netPath(pc).then((path) => {
          peer.path = path;
          this.onChange();
        });
      } else if (s === 'disconnected') peer.state = 'reconnecting';
      else if (s === 'failed') {
        // The offerer restarts ICE (new network paths); three tries, then it's failed.
        if (peer.offerer && peer.restarts < 3) {
          peer.restarts += 1;
          peer.state = 'reconnecting';
          void this.offer(peer, true);
        } else peer.state = 'failed';
      }
      this.onChange();
    };
    const early = this.orphan.get(part.sid);
    if (early) {
      peer.pending.push(...early);
      this.orphan.delete(part.sid);
    }
    return peer;
  }

  /** Send our current tracks on this connection (answerer: after the offer created the transceivers). */
  private attach(peer: Peer): void {
    const { audio, video } = this.local();
    for (const t of peer.pc.getTransceivers()) {
      if (t.direction === 'stopped' || t.currentDirection === 'stopped') continue;
      const kind = t.receiver.track?.kind;
      const track = kind === 'audio' ? audio : kind === 'video' ? video : null;
      if (t.sender.track !== track) void t.sender.replaceTrack(track).catch(() => undefined);
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
    }
  }

  private async offer(peer: Peer, iceRestart = false): Promise<void> {
    try {
      if (iceRestart) peer.pc.restartIce();
      await peer.pc.setLocalDescription(await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
      this.signal(peer.sid, { sdp: peer.pc.localDescription!.toJSON() });
    } catch {
      peer.state = 'failed';
      this.onChange();
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const q = peer.pending.splice(0);
    for (const c of q) await peer.pc.addIceCandidate(c).catch(() => undefined);
  }

  /** Share the uplink between everyone we send to. */
  private retune(): void {
    const bps = videoBitrate(this.peers.size);
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        if (params.encodings[0].maxBitrate === bps) continue;
        params.encodings[0].maxBitrate = bps;
        void sender.setParameters(params).catch(() => undefined);
      } catch { /* older browsers: congestion control still adapts */ }
    }
  }

  /** Connection quality per person, from packet loss and round-trip time. */
  private async measure(): Promise<void> {
    let changed = false;
    for (const p of this.peers.values()) {
      if (p.state !== 'connected') continue;
      try {
        const stats = await p.pc.getStats();
        let lost = 0;
        let got = 0;
        let rtt: number | null = null;
        stats.forEach((r: { type: string; kind?: string; packetsLost?: number; packetsReceived?: number; state?: string; nominated?: boolean; currentRoundTripTime?: number }) => {
          if (r.type === 'inbound-rtp') {
            lost += r.packetsLost ?? 0;
            got += r.packetsReceived ?? 0;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.currentRoundTripTime != null) rtt = r.currentRoundTripTime;
        });
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
    if (changed) this.onChange();
  }
}
