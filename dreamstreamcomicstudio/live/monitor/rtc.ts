/**
 * Peer-to-peer media for the baby monitor (WebRTC, DTLS-SRTP encrypted end
 * to end). Nothing is recorded anywhere; the room only relays signaling.
 *
 * Roles: every VIEWER is the offerer, the CAMERA always answers — so there's
 * never offer glare. The viewer's offer carries
 *   video: sendrecv  (nursery picture in; the parent's face out, attached only
 *                     during a video call)
 *   audio: sendrecv  (nursery sound in; the parent's voice out, attached only
 *                     while they talk)
 * Outgoing tracks are swapped with replaceTrack — no renegotiation, no glare,
 * instant on/off like FaceTime's mute and camera buttons.
 *
 * A data channel ('mon') rides along: the camera sends its status and sound /
 * vision events straight to each viewer, so on the same home Wi-Fi the picture
 * AND the alerts keep going when the internet (and so the room) is down. A
 * connected call is never torn down just because the room lost track of a
 * socket — it ends when the peers themselves can't reach each other.
 */

import { TalkProcessor } from './voice';
import type { MonRtc } from './protocol';

export type Signal = (to: string, d: MonRtc) => void;
/** How the media flows: on the home network, across the internet, or through a relay server. */
export type NetPath = 'lan' | 'internet' | 'relay';

const isPrivateIp = (ip?: string | null) =>
  !!ip && (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip) || ip.endsWith('.local'));

/** Classify a selected ICE candidate pair. */
export function classifyPath(local: { candidateType?: string; address?: string | null }, remote: { candidateType?: string; address?: string | null }): NetPath {
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
  const remoteLocal = remote.candidateType === 'host' || isPrivateIp(remote.address);
  const localLocal = local.candidateType === 'host' || isPrivateIp(local.address);
  return localLocal && remoteLocal ? 'lan' : 'internet';
}

/** The path the connection is using right now (null until it's chosen). */
export async function netPath(pc: RTCPeerConnection): Promise<NetPath | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
    stats.forEach((r: { type: string; id: string; nominated?: boolean; state?: string; selected?: boolean; localCandidateId?: string; remoteCandidateId?: string }) => {
      if (r.type !== 'candidate-pair') return;
      if (pairId ? r.id === pairId : r.selected || (r.nominated && r.state === 'succeeded')) pair = r;
    });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId!) as { candidateType?: string; address?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId!) as { candidateType?: string; address?: string } | undefined;
    return local && remote ? classifyPath(local, remote) : null;
  } catch {
    return null;
  }
}

/** Messages on the camera → viewer data channel. */
export type DirectMsg =
  | { t: 'st'; st: Record<string, unknown>; dev: string }
  | { t: 'ev'; kind: string; cat?: string; type?: string; phase?: string; conf?: number; secs?: number; db?: number; at: number; dev: string };
export type Quality = 'hd' | 'sd' | 'audio';

const QUALITY_BPS: Record<Exclude<Quality, 'audio'>, number> = { hd: 1_600_000, sd: 450_000 };
/** A parent's face on the nursery screen doesn't need to be HD. */
const CALLER_VIDEO_BPS = 600_000;

const videoTransceiver = (pc: RTCPeerConnection) =>
  pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
const audioTransceiver = (pc: RTCPeerConnection) =>
  pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio');

async function capBitrate(sender: RTCRtpSender | undefined, bps: number, scaleDown = 1): Promise<void> {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = bps;
    p.encodings[0].scaleResolutionDownBy = scaleDown;
    await sender.setParameters(p);
  } catch {
    /* older browsers: congestion control still adapts */
  }
}

/* ------------------------------------------------------------- camera */

interface CamPeer {
  pc: RTCPeerConnection;
  quality: Quality;
  name: string;
  dc: RTCDataChannel | null;
}

export class CameraHub {
  private peers = new Map<string, CamPeer>();
  private videoOn = true;
  onTalk: ((sid: string, stream: MediaStream | null, who: string) => void) | null = null;
  /** A parent's camera (video call) — null when the peer leaves. */
  onCallerVideo: ((sid: string, stream: MediaStream | null, who: string) => void) | null = null;
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

  /** Straight to every viewer over the data channel (works without the room). */
  direct(msg: DirectMsg): number {
    const raw = JSON.stringify(msg);
    let n = 0;
    for (const p of this.peers.values()) {
      if (p.dc?.readyState !== 'open') continue;
      try {
        p.dc.send(raw);
        n++;
      } catch { /* closing */ }
    }
    return n;
  }

  /**
   * The room says a viewer's socket left. If our call with them is still up
   * (their internet blipped, or the house's did), keep it; it closes itself
   * if they really are gone.
   */
  release(sid: string): void {
    const peer = this.peers.get(sid);
    if (!peer) return;
    if (peer.pc.connectionState === 'connected') return;
    this.close(sid);
  }

  private videoFor(peer: CamPeer): MediaStreamTrack | null {
    return this.videoOn && peer.quality !== 'audio' ? this.tracks().video : null;
  }

  async onSignal(from: string, d: MonRtc, who = 'Someone'): Promise<void> {
    if (d.bye) return this.close(from);
    if (d.sdp?.type === 'offer') {
      let peer = this.peers.get(from);
      if (!peer || peer.pc.signalingState === 'closed') peer = this.create(from, who);
      const { pc } = peer;
      await pc.setRemoteDescription(d.sdp);
      const { audio } = this.tracks();
      const v = videoTransceiver(pc);
      if (v) {
        // sendrecv lets a parent video-call the nursery; an older viewer that
        // offered recvonly still negotiates down to sendonly.
        v.direction = 'sendrecv';
        await v.sender.replaceTrack(this.videoFor(peer));
      }
      const a = audioTransceiver(pc);
      if (a) {
        a.direction = 'sendrecv';
        await a.sender.replaceTrack(audio);
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
    const peer: CamPeer = { pc, quality: 'hd', name: who, dc: null };
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'mon') peer.dc = e.channel;
    };
    pc.onicecandidate = (e) => this.signal(sid, { ice: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      // Both arrive at connect time and stay silent/black until the parent
      // talks or turns their camera on.
      if (e.track.kind === 'audio') this.onTalk?.(sid, stream, who);
      else this.onCallerVideo?.(sid, stream, who);
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
    await videoTransceiver(peer.pc)?.sender.replaceTrack(this.videoFor(peer)).catch(() => undefined);
    await this.applyQuality(peer);
  }

  private async applyQuality(peer: CamPeer): Promise<void> {
    if (peer.quality === 'audio') return;
    await capBitrate(videoTransceiver(peer.pc)?.sender, QUALITY_BPS[peer.quality], peer.quality === 'sd' ? 2 : 1);
  }

  /** Camera flip / lens swap / recovery without renegotiation. */
  async replaceVideo(): Promise<void> {
    for (const peer of this.peers.values()) {
      await videoTransceiver(peer.pc)?.sender.replaceTrack(this.videoFor(peer)).catch(() => undefined);
    }
  }

  async replaceAudio(): Promise<void> {
    const { audio } = this.tracks();
    for (const peer of this.peers.values()) {
      await audioTransceiver(peer.pc)?.sender.replaceTrack(audio).catch(() => undefined);
    }
  }

  /** Privacy pause: video off for everyone, sound monitoring continues. */
  async setVideoEnabled(on: boolean): Promise<void> {
    this.videoOn = on;
    await this.replaceVideo();
  }

  close(sid: string): void {
    const peer = this.peers.get(sid);
    if (!peer) return;
    this.peers.delete(sid);
    this.onTalk?.(sid, null, peer.name);
    this.onCallerVideo?.(sid, null, peer.name);
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
  private talkRaw: MediaStreamTrack | null = null;
  private talkProc: TalkProcessor | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private connectTimer: number | undefined;
  private disconnectedAt: number | null = null;
  private watchdog: number | undefined;
  state: LinkState = 'idle';
  path: NetPath | null = null;
  onStream: ((s: MediaStream | null) => void) | null = null;
  onState: ((s: LinkState) => void) | null = null;
  /** Status and events straight from the camera (the data channel). */
  onDirect: ((m: DirectMsg) => void) | null = null;
  onPath: ((p: NetPath | null) => void) | null = null;
  private pathTimer: number | undefined;

  constructor(private signal: Signal, private ice: RTCIceServer[]) {}

  setIce(ice: RTCIceServer[]): void {
    this.ice = ice;
  }

  get target(): string | null {
    return this.camSid;
  }

  get talking(): boolean {
    return !!this.talkTrack;
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
    pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    const dc = pc.createDataChannel('mon', { ordered: true });
    dc.onmessage = (e) => {
      try {
        this.onDirect?.(JSON.parse(String(e.data)) as DirectMsg);
      } catch { /* not ours */ }
    };
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
        void this.checkPath();
        // Re-attach a live mic/camera after an ICE restart or reconnect.
        void this.reattach();
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

  /** Re-read which network path the call uses (it can change after an ICE restart). */
  private async checkPath(): Promise<void> {
    const pc = this.pc;
    window.clearTimeout(this.pathTimer);
    if (!pc) return;
    const p = await netPath(pc);
    if (pc !== this.pc) return;
    if (p !== this.path) {
      this.path = p;
      this.onPath?.(p);
    }
    this.pathTimer = window.setTimeout(() => void this.checkPath(), p ? 20_000 : 2000);
  }

  /**
   * The camera came back to the room under a new session id. If the call
   * itself never dropped (same camera, still connected), just send future
   * signaling to the new id instead of rebuilding the call.
   */
  retarget(camSid: string): boolean {
    if (!this.pc || this.pc.connectionState !== 'connected') return false;
    this.camSid = camSid;
    return true;
  }

  private async reattach(): Promise<void> {
    if (!this.pc) return;
    if (this.talkTrack) await audioTransceiver(this.pc)?.sender.replaceTrack(this.talkTrack).catch(() => undefined);
    if (this.camTrack) {
      const s = videoTransceiver(this.pc)?.sender;
      await s?.replaceTrack(this.camTrack).catch(() => undefined);
      await capBitrate(s, CALLER_VIDEO_BPS);
    }
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

  /** Open the mic to the nursery (FaceTime-style unmute). Returns the mic track for a level meter. */
  async startTalk(): Promise<MediaStreamTrack | null> {
    if (!this.pc) return null;
    try {
      if (!this.talkTrack) {
        // No automatic gain: it pumps up room noise and feeds howling. Our own
        // compressor keeps the voice at a moderate, steady level instead.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
        this.talkRaw = stream.getAudioTracks()[0] ?? null;
        if (this.talkRaw) {
          this.talkProc = TalkProcessor.create(this.talkRaw);
          this.talkTrack = this.talkProc?.out ?? this.talkRaw;
        }
      }
      const sender = audioTransceiver(this.pc)?.sender;
      if (!sender || !this.talkTrack) return null;
      await sender.replaceTrack(this.talkTrack);
      return this.talkTrack;
    } catch {
      return null;
    }
  }

  async stopTalk(): Promise<void> {
    const sender = this.pc ? audioTransceiver(this.pc)?.sender : undefined;
    await sender?.replaceTrack(null).catch(() => undefined);
    this.talkProc?.close();
    this.talkProc = null;
    this.talkRaw?.stop();
    this.talkRaw = null;
    this.talkTrack?.stop();
    this.talkTrack = null;
  }

  /** The nursery measured our voice as too loud: scale it (returns the new volume, or null). */
  scaleTalk(factor: number): number | null {
    return this.talkProc ? this.talkProc.scale(factor) : null;
  }

  /** Video call: show this device's camera on the nursery screen. */
  async startVideo(facing: 'user' | 'environment' = 'user'): Promise<MediaStream | null> {
    if (!this.pc) return null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20, max: 24 } },
        audio: false,
      });
      this.camTrack?.stop();
      this.camTrack = s.getVideoTracks()[0] ?? null;
      const sender = videoTransceiver(this.pc)?.sender;
      if (!sender || !this.camTrack) return null;
      await sender.replaceTrack(this.camTrack);
      await capBitrate(sender, CALLER_VIDEO_BPS);
      return s;
    } catch {
      return null;
    }
  }

  async stopVideo(): Promise<void> {
    const sender = this.pc ? videoTransceiver(this.pc)?.sender : undefined;
    await sender?.replaceTrack(null).catch(() => undefined);
    this.camTrack?.stop();
    this.camTrack = null;
  }

  private teardown(notify: boolean): void {
    window.clearTimeout(this.connectTimer);
    window.clearInterval(this.watchdog);
    window.clearTimeout(this.pathTimer);
    if (this.path) {
      this.path = null;
      this.onPath?.(null);
    }
    if (this.pc) {
      if (notify && this.camSid) this.signal(this.camSid, { bye: true });
      try {
        this.pc.close();
      } catch { /* closed */ }
    }
    this.pc = null;
    this.onStream?.(null);
  }

  /** Full stop: also releases the mic and camera. */
  close(): void {
    if (this.camSid && this.pc) this.signal(this.camSid, { bye: true });
    void this.stopTalk();
    void this.stopVideo();
    this.teardown(false);
    this.camSid = null;
    this.setState('closed');
  }
}
