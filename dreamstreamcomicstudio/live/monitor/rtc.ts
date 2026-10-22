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
 *
 * One camera, many viewers (a mesh): every viewer is its own encoder on the
 * camera phone. So the camera keeps one connection per viewer SESSION (keyed
 * by the viewer, not its socket; a fresh call id builds a fresh connection),
 * prefers H.264 (hardware on iPhone and most Android phones), keeps the frame
 * rate up when it must cut quality, and steps every viewer's picture down a
 * ladder as more people watch over the internet or the phone gets busy —
 * driven by the encoder's own stats every five seconds.
 */

import { TalkProcessor } from './voice';
import type { EncLimit, EncStatus, MonRtc } from './protocol';

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

/** The subset of RTCStatsReport this file reads (a Map of stats dictionaries). */
interface StatsLike {
  forEach(cb: (r: Record<string, unknown> & { type: string; id: string }) => void): void;
  get(id: string): unknown;
}

/** The path a stats report's selected candidate pair uses (null until it's chosen). */
export function pathFromReport(stats: StatsLike): NetPath | null {
  let pairId: string | undefined;
  stats.forEach((r) => {
    if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') pairId = r.selectedCandidatePairId;
  });
  let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
  stats.forEach((r) => {
    if (r.type !== 'candidate-pair') return;
    if (pairId ? r.id === pairId : r.selected || (r.nominated && r.state === 'succeeded')) pair = r as typeof pair;
  });
  if (!pair) return null;
  const local = stats.get(pair.localCandidateId!) as { candidateType?: string; address?: string } | undefined;
  const remote = stats.get(pair.remoteCandidateId!) as { candidateType?: string; address?: string } | undefined;
  return local && remote ? classifyPath(local, remote) : null;
}

/** The path the connection is using right now (null until it's chosen). */
export async function netPath(pc: RTCPeerConnection): Promise<NetPath | null> {
  try {
    return pathFromReport((await pc.getStats()) as unknown as StatsLike);
  } catch {
    return null;
  }
}

/** Messages on the camera → viewer data channel. */
export type DirectMsg =
  | { t: 'st'; st: Record<string, unknown>; dev: string }
  | { t: 'ev'; kind: string; cat?: string; type?: string; phase?: string; conf?: number; secs?: number; db?: number; label?: string; sharp?: boolean; name?: string; at: number; dev: string };
export type Quality = 'hd' | 'sd' | 'audio';

/** A parent's face on the nursery screen doesn't need to be HD. */
const CALLER_VIDEO_BPS = 600_000;
/** Give a direct connection this long before falling back to the relay (it may still connect later). */
const CONNECT_GIVE_UP_MS = 10_000;

/* ------------------------------------------------------ encoding ladder */

export interface Encoding {
  maxBitrate: number;
  scaleResolutionDownBy: number;
  maxFramerate: number;
}

/**
 * The rungs every viewer's picture steps down. The camera captures 720p at
 * up to 24 fps; each viewer over the internet shares the home's upload.
 */
export const LADDER: readonly Encoding[] = [
  { maxBitrate: 1_600_000, scaleResolutionDownBy: 1, maxFramerate: 24 },
  { maxBitrate: 1_100_000, scaleResolutionDownBy: 1, maxFramerate: 24 },
  { maxBitrate: 800_000, scaleResolutionDownBy: 1.5, maxFramerate: 20 },
  { maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 15 },
  { maxBitrate: 320_000, scaleResolutionDownBy: 3, maxFramerate: 12 },
];
/** Through a TURN relay server (pay-per-GB): never more than this. */
const RELAY_CAP: Encoding = { maxBitrate: 650_000, scaleResolutionDownBy: 2, maxFramerate: 20 };
/** "Data saver" chosen by the viewer. */
const SD_CAP: Encoding = { maxBitrate: 450_000, scaleResolutionDownBy: 2, maxFramerate: 15 };
/** Bandwidth trimming never goes below this. */
const MIN_BPS = 300_000;
export const MAX_PRESSURE = 2;

export interface EncodingInput {
  /** Viewers the camera is encoding for (each is an encoder on the phone). */
  peers: number;
  /** Of those, the ones going over the internet — they share the home's upload. */
  internetPeers: number;
  /** This viewer's path; null (not known yet) counts as internet. */
  path: NetPath | null;
  quality: Quality;
  /** Rungs stepped down because the phone's processor is busy (0–2). */
  pressure: number;
  /** This viewer's share after its own connection reported limits (0.2–1). */
  bw?: number;
}

/**
 * The encoding for one viewer. Home Wi-Fi viewers don't count against the
 * upload budget; every viewer counts against the processor.
 */
export function encodingFor(i: EncodingInput): Encoding {
  const net = i.path === 'lan' ? 0 : i.internetPeers <= 1 ? 0 : i.internetPeers === 2 ? 1 : i.internetPeers === 3 ? 2 : 3;
  const cpu = i.peers <= 3 ? 0 : i.peers <= 6 ? 2 : 3;
  const rung = Math.min(LADDER.length - 1, Math.max(net, cpu) + Math.max(0, Math.min(MAX_PRESSURE, i.pressure)));
  let e = { ...LADDER[rung] };
  const clamp = (cap: Encoding) => {
    e = {
      maxBitrate: Math.min(e.maxBitrate, cap.maxBitrate),
      scaleResolutionDownBy: Math.max(e.scaleResolutionDownBy, cap.scaleResolutionDownBy),
      maxFramerate: Math.min(e.maxFramerate, cap.maxFramerate),
    };
  };
  if (i.path === 'relay') clamp(RELAY_CAP);
  if (i.quality === 'sd') clamp(SD_CAP);
  const bw = i.bw ?? 1;
  if (bw < 1) e.maxBitrate = Math.min(e.maxBitrate, Math.max(MIN_BPS, Math.round((e.maxBitrate * bw) / 1000) * 1000));
  return e;
}

/* ------------------------------------------------------------- codecs */

export interface CodecLike {
  mimeType: string;
  sdpFmtpLine?: string;
}

/**
 * H.264 first (hardware on iPhones and most Android phones; VP8 is software
 * there), then VP8, then everything else in the browser's order — keeping
 * rtx / red / ulpfec, which carry retransmission and error correction.
 * Among H.264 profiles, constrained baseline with packetization-mode=1 first:
 * it's the one every hardware encoder speaks.
 */
export function orderCodecs<T extends CodecLike>(codecs: readonly T[], prefer: readonly string[] = ['video/H264', 'video/VP8']): T[] {
  const lower = prefer.map((m) => m.toLowerCase());
  const rank = (c: T) => {
    const i = lower.indexOf(c.mimeType.toLowerCase());
    if (i < 0) return lower.length;
    if (c.mimeType.toLowerCase() !== 'video/h264') return i;
    const fmtp = c.sdpFmtpLine ?? '';
    return i + (/packetization-mode=1/.test(fmtp) ? 0 : 0.4) + (/profile-level-id=42e0/i.test(fmtp) ? 0 : 0.2);
  };
  return codecs
    .map((c, n) => ({ c, n, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.n - b.n)
    .map((x) => x.c);
}

/** Ask for H.264 on this video transceiver (the order says what we'd like to RECEIVE). */
export function preferCodecs(t: RTCRtpTransceiver | undefined): void {
  if (!t || typeof t.setCodecPreferences !== 'function' || typeof RTCRtpReceiver === 'undefined') return;
  try {
    const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
    if (caps?.length) t.setCodecPreferences(orderCodecs(caps));
  } catch {
    /* keep the browser's order */
  }
}

/* -------------------------------------------------------------- stats */

/** One viewer's video encoder, read from the camera's stats. */
export interface EncSample {
  key: string;
  lim: EncLimit | null;
  fps: number | null;
  impl: string | null;
  w: number | null;
  path: NetPath | null;
}

export function readEncStats(stats: StatsLike): Omit<EncSample, 'key'> {
  const out: Omit<EncSample, 'key'> = { lim: null, fps: null, impl: null, w: null, path: pathFromReport(stats) };
  stats.forEach((r) => {
    if (r.type !== 'outbound-rtp' || (r.kind ?? r.mediaType) !== 'video') return;
    const lim = r.qualityLimitationReason;
    out.lim = lim === 'cpu' || lim === 'bandwidth' || lim === 'other' || lim === 'none' ? lim : null;
    out.fps = typeof r.framesPerSecond === 'number' ? r.framesPerSecond : null;
    out.impl = typeof r.encoderImplementation === 'string' ? r.encoderImplementation.slice(0, 40) : null;
    out.w = typeof r.frameWidth === 'number' ? r.frameWidth : null;
  });
  return out;
}

const LIM_RANK: Record<EncLimit, number> = { none: 0, other: 1, bandwidth: 2, cpu: 3 };

/** What the family's screens show about the camera's encoders (relay fps is added by the camera page). */
export function summarizeEnc(samples: readonly EncSample[], pressure: number): Omit<EncStatus, 'relay'> {
  const fpsList = samples.map((s) => s.fps).filter((f): f is number => f != null);
  const lims = samples.map((s) => s.lim).filter((l): l is EncLimit => l != null);
  const widths = samples.map((s) => s.w).filter((w): w is number => w != null);
  return {
    peers: samples.length,
    fps: fpsList.length ? Math.round(Math.min(...fpsList)) : null,
    lim: lims.length ? lims.reduce((a, b) => (LIM_RANK[b] > LIM_RANK[a] ? b : a)) : null,
    impl: samples.find((s) => s.impl)?.impl ?? null,
    w: widths.length ? Math.max(...widths) : null,
    p: pressure,
  };
}

export interface AdaptState {
  /** Rungs everyone is stepped down for the processor. */
  pressure: number;
  /** Stats ticks in a row that reported the processor as the limit. */
  cpuTicks: number;
  /** Since when nobody was CPU-limited. */
  calmSince: number;
  /** Per viewer: bitrate share after bandwidth limits, when it last changed, limited ticks in a row. */
  bw: Record<string, { f: number; at: number; n: number }>;
}

export const newAdapt = (now = 0): AdaptState => ({ pressure: 0, cpuTicks: 0, calmSince: now, bw: {} });
const RECOVER_MS = 30_000;

/**
 * One stats tick. CPU-limited twice in a row → everyone one rung down;
 * 30 s without → one rung back up. Bandwidth-limited over the internet twice
 * in a row (a single reading is just a new call ramping up) → that viewer's
 * bitrate −25 % (floor 300 kbps); 30 s clean → back up.
 */
export function adapt(s: AdaptState, samples: readonly EncSample[], now: number): { s: AdaptState; changed: boolean } {
  let { pressure, cpuTicks, calmSince } = s;
  let changed = false;
  if (samples.some((x) => x.lim === 'cpu')) {
    cpuTicks += 1;
    calmSince = now;
    if (cpuTicks >= 2 && pressure < MAX_PRESSURE) {
      pressure += 1;
      cpuTicks = 0;
      changed = true;
    }
  } else {
    cpuTicks = 0;
    if (pressure > 0 && now - calmSince >= RECOVER_MS) {
      pressure -= 1;
      calmSince = now;
      changed = true;
    }
  }
  const bw: AdaptState['bw'] = {};
  for (const x of samples) {
    const cur = s.bw[x.key] ?? { f: 1, at: now, n: 0 };
    if (x.lim === 'bandwidth' && x.path !== 'lan') {
      if (cur.n + 1 < 2) {
        bw[x.key] = { ...cur, n: cur.n + 1 };
        continue;
      }
      const f = Math.max(0.2, Math.round(cur.f * 75) / 100);
      if (f !== cur.f) changed = true;
      bw[x.key] = { f, at: now, n: 0 };
    } else if (cur.f < 1 && now - cur.at >= RECOVER_MS) {
      bw[x.key] = { f: Math.min(1, Math.round((cur.f / 0.75) * 100) / 100), at: now, n: 0 };
      changed = true;
    } else {
      bw[x.key] = { ...cur, n: 0 };
    }
  }
  return { s: { pressure, cpuTicks, calmSince, bw }, changed };
}

/* ------------------------------------------------------------ helpers */

const videoTransceiver = (pc: RTCPeerConnection) =>
  pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
const audioTransceiver = (pc: RTCPeerConnection) =>
  pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio');

/**
 * Apply an encoding to a sender. Older browsers reject degradationPreference
 * or maxFramerate — drop them one at a time; congestion control still adapts.
 */
async function applyEncoding(sender: RTCRtpSender | undefined, enc: Partial<Encoding> & { maxBitrate: number }, keepFramerate = true): Promise<boolean> {
  if (!sender) return false;
  const attempts: [boolean, boolean][] = keepFramerate ? [[true, true], [false, true], [false, false]] : [[false, false]];
  for (const [pref, fps] of attempts) {
    try {
      const p = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!p.encodings || p.encodings.length === 0) return false; // not negotiated yet
      p.encodings[0].maxBitrate = enc.maxBitrate;
      if (enc.scaleResolutionDownBy != null) p.encodings[0].scaleResolutionDownBy = enc.scaleResolutionDownBy;
      if (fps && enc.maxFramerate != null) (p.encodings[0] as RTCRtpEncodingParameters & { maxFramerate?: number }).maxFramerate = enc.maxFramerate;
      // A baby monitor is about motion: under pressure, lose pixels, not frames.
      if (pref) p.degradationPreference = 'maintain-framerate';
      await sender.setParameters(p);
      return true;
    } catch {
      /* try a simpler set */
    }
  }
  return false;
}

/** Smooth motion over crisp stills when the encoder must choose. */
function hintMotion(t: MediaStreamTrack | null): void {
  if (t && 'contentHint' in t && t.contentHint !== 'motion') {
    try {
      t.contentHint = 'motion';
    } catch { /* read-only in this browser */ }
  }
}

const randomId = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------- camera */

interface CamPeer {
  /** The viewer (its vid; the socket id for older viewers). */
  key: string;
  /** Where to send signaling: the viewer's current room socket. */
  sid: string;
  /** The viewer's call id this connection answers. */
  pcId: string | null;
  pc: RTCPeerConnection;
  quality: Quality;
  name: string;
  dc: RTCDataChannel | null;
  path: NetPath | null;
  /** The last encoding set (skip identical setParameters). */
  applied: string;
}

const STATS_MS = 5000;

export class CameraHub {
  private peers = new Map<string, CamPeer>();
  private videoOn = true;
  private adaptState: AdaptState = newAdapt(Date.now());
  private samples: EncSample[] = [];
  private statsTimer: number | undefined;
  /** setParameters calls on one sender must not interleave: one pass at a time. */
  private applying: Promise<void> = Promise.resolve();
  /** A parent's voice (talk) — null when the peer leaves. Keyed by the viewer. */
  onTalk: ((key: string, stream: MediaStream | null, who: string) => void) | null = null;
  /** A parent's camera (video call) — null when the peer leaves. Keyed by the viewer. */
  onCallerVideo: ((key: string, stream: MediaStream | null, who: string) => void) | null = null;
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

  /** Rungs every picture is stepped down because this phone is busy. */
  get pressure(): number {
    return this.adaptState.pressure;
  }

  /** The encoders right now, for the camera's status (CamStatus.enc). */
  telemetry(): Omit<EncStatus, 'relay'> {
    return summarizeEnc(this.samples, this.adaptState.pressure);
  }

  /** The viewer a room message is about: their vid when they sent one, else whoever uses that socket. */
  keyOf(sid: string, vid?: unknown): string {
    if (typeof vid === 'string' && vid && this.peers.has(vid)) return vid;
    for (const p of this.peers.values()) if (p.sid === sid) return p.key;
    return typeof vid === 'string' && vid ? vid : sid;
  }

  /** The viewer's call is up (whatever happened to their room socket). */
  isConnected(key: string): boolean {
    return this.peers.get(key)?.pc.connectionState === 'connected';
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
    for (const peer of [...this.peers.values()]) {
      if (peer.sid !== sid || peer.pc.connectionState === 'connected') continue;
      this.close(peer.key);
    }
  }

  private videoFor(peer: CamPeer): MediaStreamTrack | null {
    const t = this.videoOn && peer.quality !== 'audio' ? this.tracks().video : null;
    hintMotion(t);
    return t;
  }

  private send(peer: CamPeer, d: MonRtc): void {
    this.signal(peer.sid, peer.pcId ? { ...d, pc: peer.pcId } : d);
  }

  async onSignal(from: string, d: MonRtc, who = 'Someone'): Promise<void> {
    const key = typeof d.vid === 'string' && d.vid ? d.vid.slice(0, 64) : from;
    let peer = this.peers.get(key);
    if (peer) peer.sid = from; // the viewer may be on a new socket
    if (d.bye) {
      // Only the call it names: a late bye from an older call must not end this one.
      if (peer && (!d.pc || !peer.pcId || d.pc === peer.pcId)) this.close(key);
      return;
    }
    if (d.sdp?.type === 'offer') {
      // A new call id is a new call: a fresh connection, never the old one
      // patched with a stranger's ICE and DTLS (an ICE restart keeps the id).
      if (!peer || peer.pc.signalingState === 'closed' || (d.pc && d.pc !== peer.pcId)) peer = this.create(key, from, d.pc ?? null, who);
      if (d.q === 'hd' || d.q === 'sd' || d.q === 'audio') peer.quality = d.q;
      const { pc } = peer;
      try {
        await pc.setRemoteDescription(d.sdp);
        const { audio } = this.tracks();
        const v = videoTransceiver(pc);
        if (v) {
          // sendrecv lets a parent video-call the nursery; an older viewer that
          // offered recvonly still negotiates down to sendonly.
          v.direction = 'sendrecv';
          preferCodecs(v);
          await v.sender.replaceTrack(this.videoFor(peer));
        }
        const a = audioTransceiver(pc);
        if (a) {
          a.direction = 'sendrecv';
          await a.sender.replaceTrack(audio);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.send(peer, { sdp: pc.localDescription!.toJSON() });
        await this.applyEncodings();
      } catch {
        // Start clean next time; the viewer falls back to the relay and retries.
        if (this.peers.get(key) === peer) this.close(key);
      }
    } else if (d.ice !== undefined) {
      if (peer && d.ice && (!d.pc || !peer.pcId || d.pc === peer.pcId)) await peer.pc.addIceCandidate(d.ice).catch(() => undefined);
    }
  }

  private create(key: string, sid: string, pcId: string | null, who: string): CamPeer {
    this.close(key);
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    const peer: CamPeer = { key, sid, pcId, pc, quality: 'hd', name: who, dc: null, path: null, applied: '' };
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'mon') peer.dc = e.channel;
    };
    pc.onicecandidate = (e) => {
      if (this.peers.get(key) === peer) this.send(peer, { ice: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      // Both arrive at connect time and stay silent/black until the parent
      // talks or turns their camera on.
      if (e.track.kind === 'audio') this.onTalk?.(key, stream, who);
      else this.onCallerVideo?.(key, stream, who);
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(key) !== peer) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.close(key);
        return;
      }
      if (pc.connectionState === 'connected') {
        // Which network it uses decides its share of the upload (a path check
        // only — the regular tick judges the encoders).
        window.setTimeout(() => void this.statsTick(false), 1500);
      }
      this.onCount?.(this.count);
      void this.applyEncodings();
    };
    this.peers.set(key, peer);
    this.startStats();
    return peer;
  }

  async setQuality(key: string, q: Quality): Promise<void> {
    const peer = this.peers.get(key);
    if (!peer) return;
    peer.quality = q;
    peer.applied = '';
    await videoTransceiver(peer.pc)?.sender.replaceTrack(this.videoFor(peer)).catch(() => undefined);
    await this.applyEncodings();
  }

  /** Every viewer's encoding for the current audience, network paths and phone load. */
  private applyEncodings(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow()).catch(() => undefined);
    return this.applying;
  }

  private async applyNow(): Promise<void> {
    const live = [...this.peers.values()].filter((p) => p.pc.connectionState !== 'closed' && p.pc.connectionState !== 'failed');
    const internetPeers = live.filter((p) => p.path !== 'lan').length;
    for (const peer of live) {
      if (peer.quality === 'audio') continue;
      const enc = encodingFor({
        peers: live.length,
        internetPeers,
        path: peer.path,
        quality: peer.quality,
        pressure: this.adaptState.pressure,
        bw: this.adaptState.bw[peer.key]?.f ?? 1,
      });
      const sig = JSON.stringify(enc);
      if (sig === peer.applied) continue;
      if (await applyEncoding(videoTransceiver(peer.pc)?.sender, enc)) peer.applied = sig;
    }
  }

  private startStats(): void {
    if (this.statsTimer !== undefined) return;
    this.statsTimer = window.setInterval(() => void this.statsTick(), STATS_MS);
  }

  private stopStats(): void {
    window.clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.samples = [];
  }

  /** Read every encoder, adapt the ladder, remember what to tell the family. */
  private async statsTick(judge = true): Promise<void> {
    const samples: EncSample[] = [];
    for (const peer of [...this.peers.values()]) {
      if (peer.pc.connectionState !== 'connected') continue;
      try {
        const s = readEncStats((await peer.pc.getStats()) as unknown as StatsLike);
        if (s.path) peer.path = s.path;
        // Audio-only and paused viewers have no video encoder to judge.
        if (peer.quality !== 'audio' && this.videoOn) samples.push({ key: peer.key, ...s, path: peer.path });
      } catch { /* closing */ }
    }
    if (judge) {
      this.adaptState = adapt(this.adaptState, samples, Date.now()).s;
      this.samples = samples;
    }
    // Also re-tries any encoding a sender wasn't ready for (only changed ones are set).
    await this.applyEncodings();
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

  close(key: string): void {
    const peer = this.peers.get(key);
    if (!peer) return;
    this.peers.delete(key);
    this.onTalk?.(key, null, peer.name);
    this.onCallerVideo?.(key, null, peer.name);
    try {
      peer.pc.close();
    } catch { /* closed */ }
    if (!this.peers.size) this.stopStats();
    this.onCount?.(this.count);
    // One fewer viewer: the others may step back up.
    void this.applyEncodings();
  }

  /** The camera is stopping: tell every viewer the call is over, then hang up. */
  closeAll(notify = false): void {
    for (const peer of [...this.peers.values()]) {
      if (notify) this.send(peer, { bye: true });
      this.close(peer.key);
    }
    this.stopStats();
  }
}

/* ------------------------------------------------------------- viewer */

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export class ViewerLink {
  private pc: RTCPeerConnection | null = null;
  /** This call's id (MonRtc.pc) — fresh per connect(). */
  private pcId: string | null = null;
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
  /** The picture this viewer asks for (sent with every offer, so a new call starts right). */
  quality: Quality = 'hd';
  onStream: ((s: MediaStream | null) => void) | null = null;
  onState: ((s: LinkState) => void) | null = null;
  /** Status and events straight from the camera (the data channel). */
  onDirect: ((m: DirectMsg) => void) | null = null;
  onPath: ((p: NetPath | null) => void) | null = null;
  private pathTimer: number | undefined;

  /**
   * `vid` identifies this viewer (device + tab) across room reconnects, so the
   * camera keeps one connection for it and finds it again from a new socket.
   */
  constructor(private signal: Signal, private ice: RTCIceServer[], readonly vid = randomId()) {}

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

  private send(to: string, d: MonRtc): void {
    this.signal(to, { ...d, pc: this.pcId ?? undefined, vid: this.vid });
  }

  async connect(camSid: string): Promise<void> {
    // Tell the camera the previous call is over, so it frees that encoder now.
    if (this.pc && this.camSid) this.send(this.camSid, { bye: true });
    this.teardown(false);
    this.camSid = camSid;
    this.pcId = randomId();
    this.setState('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    // The order of codecs in our offer is what we'd like to receive: H.264 first.
    preferCodecs(pc.addTransceiver('video', { direction: 'sendrecv' }));
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
    pc.onicecandidate = (e) => {
      if (this.pc === pc) this.send(camSid, { ice: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
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
    // Some networks block P2P outright — after a short wait, let the caller
    // fall back to the relay. The attempt keeps going: a late connect wins.
    this.connectTimer = window.setTimeout(() => {
      if (this.pc === pc && pc.connectionState !== 'connected') this.setState('failed');
    }, CONNECT_GIVE_UP_MS);
    window.clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => {
      if (this.pc === pc && this.disconnectedAt && Date.now() - this.disconnectedAt > 6000) {
        this.disconnectedAt = Date.now();
        void this.restartIce();
      }
    }, 2000);
    await pc.setLocalDescription(await pc.createOffer());
    if (this.pc !== pc) return;
    this.send(camSid, { sdp: pc.localDescription!.toJSON(), q: this.quality });
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
      await applyEncoding(s, { maxBitrate: CALLER_VIDEO_BPS }, false);
    }
  }

  private async restartIce(): Promise<void> {
    if (!this.pc || !this.camSid) return;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      this.send(this.camSid, { sdp: this.pc.localDescription!.toJSON(), q: this.quality });
    } catch {
      this.setState('failed');
    }
  }

  async onSignal(from: string, d: MonRtc): Promise<void> {
    if (!this.pc || from !== this.camSid) return;
    // Answers, candidates and byes for an older call of ours are stale.
    if (d.pc && d.pc !== this.pcId) return;
    if (d.sdp?.type === 'answer') {
      await this.pc.setRemoteDescription(d.sdp).catch(() => this.setState('failed'));
    } else if (d.ice) {
      await this.pc.addIceCandidate(d.ice).catch(() => undefined);
    } else if (d.bye) {
      // The camera hung up (it's stopping): the call is over, not failed.
      this.teardown(false);
      this.setState('closed');
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
      await applyEncoding(sender, { maxBitrate: CALLER_VIDEO_BPS }, false);
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
      if (notify && this.camSid) this.send(this.camSid, { bye: true });
      try {
        this.pc.close();
      } catch { /* closed */ }
    }
    this.pc = null;
    this.onStream?.(null);
  }

  /** Full stop: also releases the mic and camera. */
  close(): void {
    if (this.camSid && this.pc) this.send(this.camSid, { bye: true });
    void this.stopTalk();
    void this.stopVideo();
    this.teardown(false);
    this.camSid = null;
    this.setState('closed');
  }
}
