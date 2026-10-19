/**
 * Peer-to-peer media for the baby monitor (WebRTC, DTLS-SRTP encrypted end
 * to end). Nothing is recorded anywhere; the room only relays signaling.
 *
 * Roles: every VIEWER is the offerer, the CAMERA always answers — so there's
 * never offer glare. The viewer's offer carries
 *   video: recvonly  (the nursery picture)
 *   audio: sendrecv  (nursery sound in; talk-back out, track attached only
 *                     while the parent holds "Talk" — no renegotiation)
 */

import type { MonRtc } from './protocol';

export type Signal = (to: string, d: MonRtc) => void;
export type Quality = 'hd' | 'sd' | 'audio';

const QUALITY_BPS: Record<Exclude<Quality, 'audio'>, number> = { hd: 1_600_000, sd: 450_000 };

/* ------------------------------------------------------------- camera */

interface CamPeer {
  pc: RTCPeerConnection;
  quality: Quality;
  name: string;
}

export class CameraHub {
  private peers = new Map<string, CamPeer>();
  onTalk: ((sid: string, stream: MediaStream | null, who: string) => void) | null = null;
  onCount: ((n: number) => void) | null = null;

  constructor(
    private signal: Signal,
    private ice: RTCIceServer[],
    private tracks: () => { video: MediaStreamTrack | null; audio: MediaStreamTrack | null },
  ) {}

  setIce(ice: RTCIceServer[]): void {
    this.ice = ice;
  }

  get count(): number {
    return [...this.peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
  }

  async onSignal(from: string, d: MonRtc, who = 'Someone'): Promise<void> {
    if (d.bye) return this.close(from);
    if (d.sdp?.type === 'offer') {
      // A fresh offer (new session or ICE restart) — rebuild cleanly unless
      // it's a restart on a live connection.
      let peer = this.peers.get(from);
      if (!peer || peer.pc.signalingState === 'closed') peer = this.create(from, who);
      const { pc } = peer;
      await pc.setRemoteDescription(d.sdp);
      const { video, audio } = this.tracks();
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track?.kind;
        if (kind === 'video') {
          t.direction = 'sendonly';
          await t.sender.replaceTrack(peer.quality === 'audio' ? null : video);
        } else if (kind === 'audio') {
          t.direction = 'sendrecv';
          await t.sender.replaceTrack(audio);
        }
      }
      await this.applyQuality(peer);
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal(from, { sdp: pc.localDescription!.toJSON() });
    } else if (d.ice !== undefined) {
      const peer = this.peers.get(from);
      if (peer && d.ice) await peer.pc.addIceCandidate(d.ice).catch(() => undefined);
    }
  }

  private create(sid: string, who: string): CamPeer {
    this.close(sid);
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    const peer: CamPeer = { pc, quality: 'hd', name: who };
    pc.onicecandidate = (e) => this.signal(sid, { ice: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      // Talk-back: the parent's mic arrives as an audio track; it's silent
      // (no frames) until they hold Talk.
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.onTalk?.(sid, stream, who);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close(sid);
      this.onCount?.(this.count);
    };
    this.peers.set(sid, peer);
    return peer;
  }

  async setQuality(sid: string, q: Quality): Promise<void> {
    const peer = this.peers.get(sid);
    if (!peer) return;
    peer.quality = q;
    const vSender = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video')?.sender;
    if (vSender) await vSender.replaceTrack(q === 'audio' ? null : this.tracks().video).catch(() => undefined);
    await this.applyQuality(peer);
  }

  private async applyQuality(peer: CamPeer): Promise<void> {
    if (peer.quality === 'audio') return;
    for (const s of peer.pc.getSenders()) {
      if (s.track?.kind !== 'video') continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
        p.encodings[0].maxBitrate = QUALITY_BPS[peer.quality];
        p.encodings[0].scaleResolutionDownBy = peer.quality === 'sd' ? 2 : 1;
        await s.setParameters(p);
      } catch {
        /* older browsers: congestion control still adapts */
      }
    }
  }

  /** Camera flip / track swap without renegotiation. */
  async replaceVideo(track: MediaStreamTrack | null): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.quality === 'audio') continue;
      for (const t of peer.pc.getTransceivers()) {
        if (t.receiver.track?.kind === 'video') await t.sender.replaceTrack(track).catch(() => undefined);
      }
    }
  }

  close(sid: string): void {
    const peer = this.peers.get(sid);
    if (!peer) return;
    this.peers.delete(sid);
    this.onTalk?.(sid, null, peer.name);
    try {
      peer.pc.close();
    } catch { /* closed */ }
    this.onCount?.(this.count);
  }

  closeAll(): void {
    for (const sid of [...this.peers.keys()]) this.close(sid);
  }
}

/* ------------------------------------------------------------- viewer */

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export class ViewerLink {
  private pc: RTCPeerConnection | null = null;
  private camSid: string | null = null;
  private talkTrack: MediaStreamTrack | null = null;
  private connectTimer: number | undefined;
  private disconnectedAt: number | null = null;
  private watchdog: number | undefined;
  state: LinkState = 'idle';
  onStream: ((s: MediaStream | null) => void) | null = null;
  onState: ((s: LinkState) => void) | null = null;

  constructor(private signal: Signal, private ice: RTCIceServer[]) {}

  setIce(ice: RTCIceServer[]): void {
    this.ice = ice;
  }

  get target(): string | null {
    return this.camSid;
  }

  private setState(s: LinkState): void {
    this.state = s;
    this.onState?.(s);
  }

  async connect(camSid: string): Promise<void> {
    this.teardown(false);
    this.camSid = camSid;
    this.setState('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    const remote = new MediaStream();
    pc.ontrack = (e) => {
      remote.addTrack(e.track);
      this.onStream?.(remote);
    };
    pc.onicecandidate = (e) => this.signal(camSid, { ice: e.candidate ? e.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        window.clearTimeout(this.connectTimer);
        this.disconnectedAt = null;
        this.setState('connected');
      } else if (s === 'disconnected') {
        this.disconnectedAt ??= Date.now();
        this.setState('reconnecting');
      } else if (s === 'failed') {
        this.setState('failed');
      }
    };
    // Some networks block P2P outright — give up after 15 s and let the
    // caller fall back to the low-bandwidth relay.
    this.connectTimer = window.setTimeout(() => {
      if (this.pc === pc && pc.connectionState !== 'connected') this.setState('failed');
    }, 15_000);
    // A link stuck "disconnected" for 6 s gets an ICE restart.
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      if (this.pc === pc && this.disconnectedAt && Date.now() - this.disconnectedAt > 6000) {
        this.disconnectedAt = Date.now();
        void this.restartIce();
      }
    }, 2000);
    await pc.setLocalDescription(await pc.createOffer());
    this.signal(camSid, { sdp: pc.localDescription!.toJSON() });
  }

  private async restartIce(): Promise<void> {
    if (!this.pc || !this.camSid) return;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      this.signal(this.camSid, { sdp: this.pc.localDescription!.toJSON() });
    } catch {
      this.setState('failed');
    }
  }

  async onSignal(from: string, d: MonRtc): Promise<void> {
    if (!this.pc || from !== this.camSid) return;
    if (d.sdp?.type === 'answer') {
      await this.pc.setRemoteDescription(d.sdp).catch(() => this.setState('failed'));
    } else if (d.ice) {
      await this.pc.addIceCandidate(d.ice).catch(() => undefined);
    } else if (d.bye) {
      this.teardown(true);
    }
  }

  /** Push-to-talk: attach the mic to the pre-negotiated audio sender. */
  async startTalk(): Promise<boolean> {
    if (!this.pc) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.talkTrack = stream.getAudioTracks()[0] ?? null;
      const sender = this.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio')?.sender;
      if (!sender || !this.talkTrack) return false;
      await sender.replaceTrack(this.talkTrack);
      return true;
    } catch {
      return false;
    }
  }

  async stopTalk(): Promise<void> {
    const sender = this.pc?.getTransceivers().find((t) => t.receiver.track?.kind === 'audio')?.sender;
    await sender?.replaceTrack(null).catch(() => undefined);
    this.talkTrack?.stop();
    this.talkTrack = null;
  }

  private teardown(notify: boolean): void {
    window.clearTimeout(this.connectTimer);
    window.clearInterval(this.watchdog);
    void this.stopTalk();
    if (this.pc) {
      if (notify && this.camSid) this.signal(this.camSid, { bye: true });
      try {
        this.pc.close();
      } catch { /* closed */ }
    }
    this.pc = null;
    this.onStream?.(null);
  }

  close(): void {
    if (this.camSid && this.pc) this.signal(this.camSid, { bye: true });
    this.teardown(false);
    this.camSid = null;
    this.setState('closed');
  }
}
