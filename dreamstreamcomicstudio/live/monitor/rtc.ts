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
 *
 * Overflow: at most DIRECT_CAP viewers get their own encoder over the
 * internet (home Wi-Fi viewers don't count). A viewer that arrives when those
 * slots are full (and says it can watch the relay, `ov`) gets no video until
 * its path is known: on the home Wi-Fi it's let in; otherwise the camera
 * answers `{bye, full}` and the viewer goes straight to the relay picture —
 * one encoder for everyone else, however many they are (relay.ts).
 */

import { TalkProcessor } from './voice';
import { HIDDEN_GRACE_MS } from './viewGate';
import { applyIce, IceClock, keepRelay, turnRenewed } from '../rtcIce';
import { EidSeen } from '../../packages/monitor-core/src/eid';
import { isSealedRtc, type SealedRtc } from '../../packages/monitor-core/src/wire';
import type { EncLimit, EncStatus, MonRtc } from './protocol';

/**
 * Signaling to a peer through the room. Between devices that hold the nursery key `d` is sealed
 * (a `SealedRtc`) — the same callback sends either (`{t:'rtc', to, d}`).
 */
export type Signal = (to: string, d: MonRtc) => void;
/** The same callback, for a sealed `d`. */
const sendSealed = (signal: Signal, to: string, d: SealedRtc): void => (signal as (to: string, d: MonRtc | SealedRtc) => void)(to, d);

/**
 * End-to-end signaling (ADR 0006 D6.3; keys.ts `NurseryKeys` implements it): offers, answers
 * and candidates sealed with the nursery key, so the room forwards what it can't read or change
 * — the DTLS fingerprints that protect the picture can't be swapped by our server.
 */
export interface SignalSeal {
  /** This device holds a nursery key: sticky — unsealed signaling from a peer that seals is refused. */
  holds(): boolean;
  /** Seal for that peer's device (null: no current key). */
  seal(peerDevId: string, d: MonRtc): Promise<SealedRtc | null>;
  /** Open sealed signaling addressed to this device (null: refuse it). */
  open(d: SealedRtc): Promise<{ d: MonRtc; from: string } | null>;
}

/**
 * Hands signals on in the order they arrived. Opening a sealed one is asynchronous (WebCrypto),
 * and two can finish out of order — a candidate opened before the offer it belongs to would be
 * dropped. Each waits for the ones before it to open (not for them to be applied, as before).
 */
export class InOrder {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(p: Promise<T>): Promise<T> {
    const turn = this.tail.then(() => p);
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}

/** Candidates gathered within this window travel in one message (ADR 0006 Phase 0: ICE batching). */
export const ICE_BATCH_MS = 75;

/**
 * Batches ICE candidates: everything gathered within ICE_BATCH_MS goes together (null — the end
 * of candidates — goes with the batch it ends). `flush` decides how: one `ices` message to a peer
 * that takes them, one message per candidate to one that doesn't.
 */
export class IceBatch {
  private buf: (RTCIceCandidateInit | null)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private flush: (list: (RTCIceCandidateInit | null)[]) => void, private ms = ICE_BATCH_MS) {}

  add(c: RTCIceCandidateInit | null): void {
    this.buf.push(c);
    if (this.timer === undefined) this.timer = setTimeout(() => this.now(), this.ms);
  }

  /** Send what's waiting now. */
  now(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buf.length) this.flush(this.buf.splice(0));
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = [];
  }
}

/** The candidates in a signal: a batch (`ices`) or one (`ice`). */
const candidatesOf = (d: MonRtc): RTCIceCandidateInit[] => [...(Array.isArray(d.ices) ? d.ices : []), ...(d.ice ? [d.ice] : [])].filter((c): c is RTCIceCandidateInit => !!c && typeof c === 'object');

/** A signal on the `mon` data channel (ICE restarts once the call is up: nothing through the room). */
export type DcSignal = { t: 'sig'; d: MonRtc };

/**
 * Alerts on first arrival (ADR 0006 D5.1): a camera event can reach a viewer twice — straight over
 * the data channel and as the room's log line — with the same `eid`. Whichever comes first alerts;
 * the other is folded in quietly. Events without an eid (cameras from before) always count.
 */
export class FirstArrival {
  private seen = new EidSeen(512);
  /** The camera's own copy (data channel): true = first, alert now. */
  direct(eid: string | null | undefined): boolean {
    return this.seen.first(eid);
  }
  /** The room's copy: 'raise' when it's the first, 'quiet' when the data channel's copy already alerted. */
  room(eid: string | null | undefined): 'raise' | 'quiet' {
    return this.seen.first(eid) ? 'raise' : 'quiet';
  }
}
/** How the media flows: on the home network, across the internet, or through a relay server. */
export type NetPath = 'lan' | 'internet' | 'relay';

/** An address only reachable inside a home network: RFC 1918, link-local, loopback, IPv6 ULA (fc00::/7) or link-local (fe80::/10), an mDNS name. */
export const isPrivateIp = (ip?: string | null): boolean =>
  !!ip &&
  (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(ip) || /^f[cd][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]?:/i.test(ip) || /\.local\.?$/i.test(ip));

/** The /64 of a global IPv6 address (null otherwise): one home's network — a phone on mobile data has a /64 of its own. */
export function v6Net(ip?: string | null): string | null {
  const s = (ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s.includes(':') || !/^[0-9a-f:]+$/.test(s) || isPrivateIp(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(':');
}

/**
 * Classify a selected ICE candidate pair. Home Wi-Fi ('lan') only when both ends are on the home
 * network: a private address (or an mDNS name, which only resolves there) — or the same global
 * IPv6 /64, which is one home's network. A host candidate is NOT enough by itself: two phones on
 * carrier IPv6 have global host candidates and connect host-to-host across the internet — that
 * is 'internet' (it was shown as "Home Wi-Fi" and given the LAN upload budget). A host candidate
 * whose address the browser hides counts as local, as before.
 */
export function classifyPath(local: { candidateType?: string; address?: string | null }, remote: { candidateType?: string; address?: string | null }): NetPath {
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay';
  const home = (c: { candidateType?: string; address?: string | null }) => isPrivateIp(c.address) || (c.candidateType === 'host' && !c.address);
  if (home(local) && home(remote)) return 'lan';
  const l = v6Net(local.address);
  return l && l === v6Net(remote.address) ? 'lan' : 'internet';
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

/**
 * The path the connection is using right now (null until it's chosen). `onReport` sees the
 * same stats report (usage metering reads its relay bytes — no second getStats).
 */
export async function netPath(pc: RTCPeerConnection, onReport?: ((r: RTCStatsReport, pc: RTCPeerConnection) => void) | null): Promise<NetPath | null> {
  try {
    const report = await pc.getStats();
    try {
      onReport?.(report, pc);
    } catch { /* display only */ }
    return pathFromReport(report as unknown as StatsLike);
  } catch {
    return null;
  }
}

/** Messages on the camera → viewer data channel. */
export type DirectMsg =
  | { t: 'st'; st: Record<string, unknown>; dev: string }
  | { t: 'ev'; kind: string; cat?: string; type?: string; phase?: string; conf?: number; secs?: number; db?: number; label?: string; sharp?: boolean; name?: string; at: number; dev: string; eid?: string };
export type Quality = 'hd' | 'sd' | 'audio';

/** A parent's face on the nursery screen doesn't need to be HD. */
const CALLER_VIDEO_BPS = 600_000;
/** Give a direct connection this long before falling back to the relay (it may still connect later). */
const CONNECT_GIVE_UP_MS = 10_000;
/** Viewers served directly over the internet, each its own encoder; the rest watch the relay. */
export const DIRECT_CAP = 4;

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
/** Through a TURN relay server (pay-per-GB): never more than this (ADR 0006 Phase 0: 400 kbit/s at 15 fps). */
export const RELAY_CAP: Encoding = { maxBitrate: 400_000, scaleResolutionDownBy: 2, maxFramerate: 15 };
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
  /** The viewer can watch the relay instead (it may be told the camera is full). */
  ov: boolean;
  /** Arrived while the direct slots were full: no video until it proves to be on the home Wi-Fi. */
  held: boolean;
  /** The viewer's screen is hidden (`{t:'vis'}` on the data channel); after HIDDEN_GRACE_MS, `off`. */
  hidden: boolean;
  hideTimer: number | undefined;
  /** No picture for now — nobody is looking at it (sound keeps going). */
  off: boolean;
  /** The viewer's device key id, when its signaling is sealed: everything to it is sealed too. */
  dk: string | null;
  /** The viewer takes candidate batches (`ib`) and signaling on the data channel (`dcr`). */
  ib: boolean;
  dcr: boolean;
  ice: IceBatch;
  /** Sealed sends go out in order. */
  chain: Promise<void>;
}

/**
 * Viewer → camera over the data channel (free: it never touches our server), for cameras that
 * said `dcc` in their answer: the picture quality it asks for, and whether its screen is shown;
 * for cameras that said `dcr`, ICE restarts (`sig`) once the call is up.
 */
export type ViewerDcMsg = { t: 'q'; q: Quality } | { t: 'vis'; on: boolean } | DcSignal;
/** An ICE restart offered on the data channel gets this long for its answer before it goes through the room. */
export const DC_RESTART_WAIT_MS = 4000;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const STATS_MS = 5000;

export class CameraHub {
  private peers = new Map<string, CamPeer>();
  private videoOn = true;
  /** The nursery's relay data is used up: no picture through a TURN relay. */
  private relayOut = false;
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
  /** The relay credentials are due: ask the room for fresh ones (`{t:'ice'}`). */
  onIceStale: (() => void) | null = null;
  private iceClock = new IceClock(() => this.onIceStale?.());
  /** End-to-end signaling (keys.ts); null: plain, as before. */
  seal: SignalSeal | null = null;
  /** Signals refused: unsealed while this camera holds the nursery key, or sealed ones that didn't open. */
  refused = 0;
  /** Signals from the room, handed on in arrival order. */
  private rx = new InOrder();

  constructor(
    private signal: Signal,
    private ice: RTCIceServer[],
    private tracks: () => { video: MediaStreamTrack | null; audio: MediaStreamTrack | null },
  ) {}

  /**
   * The room's ICE list (STUN + this phone's short-lived TURN credential; `iceMs`: when to
   * ask again). New viewers get it; live connections take it for their next ICE restart —
   * and a viewer reached through a relay is asked to restart now (only the viewer offers),
   * so the night's picture moves onto the fresh credential before the old one lapses.
   */
  setIce(list: RTCIceServer[], iceMs?: number | null): void {
    const ice = keepRelay(this.ice, list);
    const renewed = turnRenewed(this.ice, ice);
    this.ice = ice;
    this.iceClock.arm(iceMs);
    for (const peer of this.peers.values()) {
      applyIce(peer.pc, ice);
      if (renewed && peer.path === 'relay' && peer.pc.connectionState === 'connected') this.send(peer, { re: 1 });
    }
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

  /**
   * The picture this viewer gets: none while the video is paused for privacy, it asked for sound
   * only, it waits for a free slot, its screen has been hidden for a while — or the nursery's relay
   * data is used up and it is reached through a TURN relay (feature doc §4.7: sound only there;
   * the direct and Home Wi-Fi picture carry on).
   */
  private videoFor(peer: CamPeer): MediaStreamTrack | null {
    const t = this.videoOn && peer.quality !== 'audio' && !peer.held && !peer.off && !(this.relayOut && peer.path === 'relay') ? this.tracks().video : null;
    hintMotion(t);
    return t;
  }

  private async refreshVideo(peer: CamPeer): Promise<void> {
    await videoTransceiver(peer.pc)?.sender.replaceTrack(this.videoFor(peer)).catch(() => undefined);
  }

  /** The nursery's relay data is used up (the room's `fair`): viewers reached through TURN get sound only. */
  async setRelayDataOut(out: boolean): Promise<void> {
    if (out === this.relayOut) return;
    this.relayOut = out;
    for (const peer of this.peers.values()) if (peer.path === 'relay') await this.refreshVideo(peer);
  }

  /** A message from a viewer on its data channel (quality, screen shown or hidden). */
  private onViewerDc(peer: CamPeer, raw: unknown): void {
    let m: ViewerDcMsg;
    try {
      m = JSON.parse(String(raw)) as ViewerDcMsg;
    } catch {
      return;
    }
    if (this.peers.get(peer.key) !== peer) return;
    if (m.t === 'q' && (m.q === 'hd' || m.q === 'sd' || m.q === 'audio')) void this.setQuality(peer.key, m.q);
    else if (m.t === 'vis') this.setShown(peer, m.on !== false);
    else if (m.t === 'sig' && m.d && typeof m.d === 'object' && peer.dcr) {
      // On its own call's channel: only that call (an ICE restart keeps the call id), never a new one.
      const d = { ...m.d, vid: peer.key, pc: peer.pcId ?? undefined };
      if (d.sdp?.type === 'offer' && m.d.pc !== peer.pcId) return;
      void this.handle(peer.sid, d, peer.name, peer.dk);
    }
  }

  /**
   * The viewer's screen: hidden for HIDDEN_GRACE_MS → its picture stops (no video to a screen
   * nobody sees; its sound and the data channel's alerts keep going); shown → back at once.
   */
  private setShown(peer: CamPeer, shown: boolean): void {
    window.clearTimeout(peer.hideTimer);
    peer.hideTimer = undefined;
    peer.hidden = !shown;
    if (shown) {
      if (peer.off) {
        peer.off = false;
        void this.refreshVideo(peer);
      }
      return;
    }
    if (peer.off) return;
    peer.hideTimer = window.setTimeout(() => {
      peer.hideTimer = undefined;
      if (this.peers.get(peer.key) !== peer || !peer.hidden) return;
      peer.off = true;
      void this.refreshVideo(peer);
    }, HIDDEN_GRACE_MS);
  }

  /** Direct video slots taken over the internet (connected, not on the home Wi-Fi, not audio-only), besides `except`. */
  internetSlots(except?: CamPeer): number {
    let n = 0;
    for (const p of this.peers.values()) {
      if (p === except || p.held || p.quality === 'audio' || p.pc.connectionState !== 'connected') continue;
      if (p.path !== 'lan') n++;
    }
    return n;
  }

  /**
   * A viewer just connected. If the direct slots are full (or were when it
   * called): on the home Wi-Fi it's let in; over the internet it's told the
   * camera is full and watches the relay instead.
   */
  private async admit(peer: CamPeer): Promise<void> {
    // Audio-only viewers cost no video encoder: never turned away.
    if (!peer.ov || peer.quality === 'audio' || (!peer.held && this.internetSlots(peer) < DIRECT_CAP)) return;
    let path: NetPath | null = null;
    for (let i = 0; i < 4 && !path; i++) {
      path = await netPath(peer.pc);
      if (!path) await sleep(250);
    }
    if (this.peers.get(peer.key) !== peer || peer.pc.connectionState !== 'connected') return;
    if (path) peer.path = path;
    if (path !== 'lan' && this.internetSlots(peer) >= DIRECT_CAP) {
      this.send(peer, { bye: true, full: true });
      this.close(peer.key);
      return;
    }
    if (peer.held) {
      peer.held = false;
      await videoTransceiver(peer.pc)?.sender.replaceTrack(this.videoFor(peer)).catch(() => undefined);
      void this.applyEncodings();
    }
  }

  /**
   * To one viewer: on its data channel once the call is up (when it takes signaling there —
   * nothing through the room), else through the room — sealed when its signaling is.
   */
  private send(peer: CamPeer, d: MonRtc): void {
    const msg = peer.pcId ? { ...d, pc: peer.pcId } : d;
    if (!d.bye && peer.dcr && peer.dc?.readyState === 'open' && peer.pc.connectionState === 'connected') {
      try {
        peer.dc.send(JSON.stringify({ t: 'sig', d: msg } satisfies DcSignal));
        return;
      } catch { /* closing: through the room */ }
    }
    const dk = peer.dk;
    if (dk && this.seal) {
      const seal = this.seal;
      peer.chain = peer.chain.then(async () => {
        // No current key: nothing — a viewer that seals takes no plain signaling anyway.
        const sealed = await seal.seal(dk, msg).catch(() => null);
        if (sealed) sendSealed(this.signal, peer.sid, sealed);
      });
      return;
    }
    this.signal(peer.sid, msg);
  }

  /** A viewer's candidates, batched: one message for a viewer that takes batches, one each otherwise. */
  private sendIce(peer: CamPeer, list: (RTCIceCandidateInit | null)[]): void {
    if (this.peers.get(peer.key) !== peer) return;
    if (peer.ib) this.send(peer, { ices: list });
    else for (const c of list) this.send(peer, { ice: c });
  }

  /**
   * Signaling from a viewer through the room. Sealed: opened with the nursery key (or dropped).
   * Plain: taken only while this camera holds no nursery key — once it does, an unsealed offer
   * is one the room could have written (sticky end to end, ADR 0006 D6.3).
   */
  async onSignal(from: string, raw: MonRtc | SealedRtc, who = 'Someone'): Promise<void> {
    const seal = this.seal;
    // Judged now (sticky: a plain one is refused while this camera holds the key), opened in parallel, handled in order.
    const opened: Promise<{ d: MonRtc; dk: string | null } | null> = isSealedRtc(raw)
      ? seal
        ? seal.open(raw).then((o) => (o ? { d: o.d, dk: o.from } : null), () => null)
        : Promise.resolve(null)
      : Promise.resolve(seal?.holds() ? null : { d: raw as MonRtc, dk: null });
    const o = await this.rx.run(opened);
    if (!o) {
      this.refused += 1;
      return;
    }
    return this.handle(from, o.d, who, o.dk);
  }

  private async handle(from: string, d: MonRtc, who: string, dk: string | null): Promise<void> {
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
      if (!peer || peer.pc.signalingState === 'closed' || (d.pc && d.pc !== peer.pcId)) {
        peer = this.create(key, from, d.pc ?? null, who);
        peer.ov = d.ov === 1;
        // Direct slots full: no video until we know it's on the home Wi-Fi (admit()).
        peer.held = peer.ov && d.q !== 'audio' && this.internetSlots(peer) >= DIRECT_CAP;
        peer.ib = d.ib === 1;
        peer.dcr = d.dcr === 1;
      }
      if (dk) peer.dk = dk;
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
        // dcc: this camera takes the viewer's quality and screen state on the data channel;
        // ib: candidate batches; dcr: ICE restarts on the data channel once the call is up.
        this.send(peer, { sdp: pc.localDescription!.toJSON(), dcc: 1, ib: 1, dcr: 1 });
        await this.applyEncodings();
      } catch {
        // Start clean next time; the viewer falls back to the relay and retries.
        if (this.peers.get(key) === peer) this.close(key);
      }
    } else if (d.ice !== undefined || d.ices) {
      if (!peer || (d.pc && peer.pcId && d.pc !== peer.pcId)) return;
      for (const c of candidatesOf(d)) await peer.pc.addIceCandidate(c).catch(() => undefined);
    }
  }

  private create(key: string, sid: string, pcId: string | null, who: string): CamPeer {
    this.close(key);
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1 });
    const peer: CamPeer = {
      key, sid, pcId, pc, quality: 'hd', name: who, dc: null, path: null, applied: '', ov: false, held: false, hidden: false, hideTimer: undefined, off: false,
      dk: null, ib: false, dcr: false, ice: new IceBatch((list) => this.sendIce(peer, list)), chain: Promise.resolve(),
    };
    pc.ondatachannel = (e) => {
      if (e.channel.label !== 'mon') return;
      peer.dc = e.channel;
      e.channel.onmessage = (ev) => this.onViewerDc(peer, ev.data);
    };
    pc.onicecandidate = (e) => {
      if (this.peers.get(key) === peer) peer.ice.add(e.candidate ? e.candidate.toJSON() : null);
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
        void this.admit(peer);
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
    const wasAudio = peer.quality === 'audio';
    peer.quality = q;
    // An audio-only viewer asking for the picture needs a slot like anyone else.
    if (wasAudio && q !== 'audio' && peer.pc.connectionState === 'connected') {
      await this.admit(peer);
      if (this.peers.get(key) !== peer) return;
    }
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
        const wasRelay = peer.path === 'relay';
        if (s.path) peer.path = s.path;
        // Relay data used up: moving onto (or off) a TURN relay takes the picture away (or brings it back).
        if (this.relayOut && wasRelay !== (peer.path === 'relay')) await this.refreshVideo(peer);
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
    window.clearTimeout(peer.hideTimer);
    peer.ice.clear();
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
    this.iceClock.stop();
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
  /** The camera's direct slots were full: this attempt ended in 'failed', watch the relay. */
  full = false;
  /** The picture this viewer asks for (sent with every offer, so a new call starts right). */
  quality: Quality = 'hd';
  onStream: ((s: MediaStream | null) => void) | null = null;
  onState: ((s: LinkState) => void) | null = null;
  /** Status and events straight from the camera (the data channel). */
  onDirect: ((m: DirectMsg) => void) | null = null;
  onPath: ((p: NetPath | null) => void) | null = null;
  /** Each stats report the path check already takes (usage metering: relay bytes received). */
  onStats: ((r: RTCStatsReport, pc: RTCPeerConnection) => void) | null = null;
  /** The relay credentials are due: ask the room for fresh ones (`{t:'ice'}`). */
  onIceStale: (() => void) | null = null;
  private iceClock = new IceClock(() => this.onIceStale?.());
  private pathTimer: number | undefined;
  private dc: RTCDataChannel | null = null;
  /** The camera takes quality and screen state on the data channel (it said `dcc` in its answer). */
  private dcc = false;
  /** This viewer's screen is shown (picture-in-picture counts): the camera hears it on the data channel. */
  private shown = true;
  private onOnline: (() => void) | null = null;
  /** End-to-end signaling (keys.ts); null: plain, as before. */
  seal: SignalSeal | null = null;
  /** The camera's device key id when it seals (keys.ts `E2ePeers`, sticky); null: a camera that doesn't. */
  camKey: (() => string | null) | null = null;
  /** Signals refused: plain ones from a camera that seals, or sealed ones that didn't open. */
  refused = 0;
  /** Signals from the room, handed on in arrival order. */
  private rx = new InOrder();
  /** The camera takes candidate batches (`ib`) and ICE restarts on the data channel (`dcr`) — it said so in its answer. */
  private ib = false;
  private dcr = false;
  private iceBatch: IceBatch | null = null;
  private chain: Promise<void> = Promise.resolve();
  private dcRestartTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * `vid` identifies this viewer (device + tab) across room reconnects, so the
   * camera keeps one connection for it and finds it again from a new socket.
   */
  constructor(private signal: Signal, private ice: RTCIceServer[], readonly vid = randomId()) {}

  /**
   * The room's ICE list (STUN + this device's short-lived TURN credential; `iceMs`: when to
   * ask again). The next call uses it; the current one takes it for its next ICE restart —
   * and restarts now if it's going through a relay on the credential this replaces, so an
   * all-night relayed picture never outlives it.
   */
  setIce(list: RTCIceServer[], iceMs?: number | null): void {
    const ice = keepRelay(this.ice, list);
    const renewed = turnRenewed(this.ice, ice);
    this.ice = ice;
    this.iceClock.arm(iceMs);
    const pc = this.pc;
    if (!pc) return;
    applyIce(pc, ice);
    if (renewed && this.path === 'relay' && pc.connectionState === 'connected') void this.restartIce();
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

  /** The camera seals its signaling, and so do we (we hold the nursery key). */
  private sealing(): string | null {
    const dk = this.camKey?.() ?? null;
    return dk && this.seal?.holds() ? dk : null;
  }

  /**
   * To the camera: on the data channel once the call is up (when it takes signaling there —
   * nothing through the room), else through the room — sealed when the camera seals and we
   * hold the key. `room`: through the room whatever the channel.
   */
  private send(to: string, d: MonRtc, room = false): void {
    const msg: MonRtc = { ...d, pc: this.pcId ?? undefined, vid: this.vid };
    if (!room && !d.bye && this.dcr && this.dc?.readyState === 'open' && this.pc?.connectionState === 'connected') {
      try {
        this.dc.send(JSON.stringify({ t: 'sig', d: msg } satisfies DcSignal));
        return;
      } catch { /* closing: through the room */ }
    }
    const dk = this.sealing();
    if (dk && this.seal) {
      const seal = this.seal;
      this.chain = this.chain.then(async () => {
        // No current key (the room is on a newer epoch): nothing — the camera would refuse it plain.
        const sealed = await seal.seal(dk, msg).catch(() => null);
        if (sealed) sendSealed(this.signal, to, sealed);
      });
      return;
    }
    this.signal(to, msg);
  }

  /** Our candidates, batched: one message to a camera that takes batches (or seals), one each otherwise. */
  private sendIce(to: string, list: (RTCIceCandidateInit | null)[]): void {
    if (this.ib || this.sealing()) this.send(to, { ices: list });
    else for (const c of list) this.send(to, { ice: c });
  }

  async connect(camSid: string): Promise<void> {
    // Tell the camera the previous call is over, so it frees that encoder now.
    if (this.pc && this.camSid) this.send(this.camSid, { bye: true });
    this.teardown(false);
    this.camSid = camSid;
    this.pcId = randomId();
    this.full = false;
    this.dcc = false;
    this.ib = false;
    this.dcr = false;
    this.setState('connecting');
    // A candidate gathered ahead (iceCandidatePoolSize): the home Wi-Fi path is tried a moment sooner.
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle', iceCandidatePoolSize: 1 });
    this.pc = pc;
    // The order of codecs in our offer is what we'd like to receive: H.264 first.
    preferCodecs(pc.addTransceiver('video', { direction: 'sendrecv' }));
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    const dc = pc.createDataChannel('mon', { ordered: true });
    this.dc = dc;
    // A screen that is already hidden says so as soon as it can (the camera then waits the grace).
    dc.onopen = () => {
      if (!this.shown) this.sendDc({ t: 'vis', on: false });
    };
    dc.onmessage = (e) => {
      let m: DirectMsg | DcSignal;
      try {
        m = JSON.parse(String(e.data)) as DirectMsg | DcSignal;
      } catch {
        return; /* not ours */
      }
      // Signaling on the call's own channel (an ICE restart): from the camera, end to end already.
      if (m.t === 'sig') {
        if (this.pc === pc && m.d && typeof m.d === 'object') void this.handle(m.d);
        return;
      }
      this.onDirect?.(m);
    };
    const remote = new MediaStream();
    pc.ontrack = (e) => {
      remote.addTrack(e.track);
      this.onStream?.(remote);
    };
    this.iceBatch?.clear();
    const batch = new IceBatch((list) => {
      if (this.pc === pc && this.camSid) this.sendIce(this.camSid, list);
    });
    this.iceBatch = batch;
    pc.onicecandidate = (e) => {
      if (this.pc === pc) batch.add(e.candidate ? e.candidate.toJSON() : null);
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
    // The network came back or changed (Wi-Fi ↔ mobile data): find the best path NOW — back onto
    // the home Wi-Fi as soon as it's there — instead of waiting for the old one to time out.
    if (this.onOnline) window.removeEventListener?.('online', this.onOnline);
    this.onOnline = () => {
      // Only between negotiations (a restart mid-offer would fail the call), and once it got going.
      if (this.pc === pc && pc.signalingState === 'stable' && pc.connectionState !== 'closed' && pc.connectionState !== 'new') void this.restartIce();
    };
    window.addEventListener?.('online', this.onOnline);
    await pc.setLocalDescription(await pc.createOffer());
    if (this.pc !== pc) return;
    // ov: if the camera's direct slots are full, we'll watch its relay picture;
    // ib / dcr: we take candidate batches, and ICE restarts on the data channel.
    this.send(camSid, { sdp: pc.localDescription!.toJSON(), q: this.quality, ov: 1, ib: 1, dcr: 1 });
  }

  /** Re-read which network path the call uses (it can change after an ICE restart). */
  private async checkPath(): Promise<void> {
    const pc = this.pc;
    window.clearTimeout(this.pathTimer);
    if (!pc) return;
    const p = await netPath(pc, this.onStats);
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

  /**
   * A fresh ICE negotiation on the same call. While the call is up and the camera takes it, the
   * offer goes on the data channel (nothing through the room — a relay credential renewed, the
   * network changed); an answer that doesn't come back in DC_RESTART_WAIT_MS (the channel was
   * already gone) sends the same offer through the room.
   */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.camSid) return;
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      const offer = { sdp: pc.localDescription!.toJSON(), q: this.quality };
      const viaDc = this.dcr && this.dc?.readyState === 'open' && pc.connectionState === 'connected';
      this.send(this.camSid, offer);
      clearTimeout(this.dcRestartTimer);
      if (viaDc) {
        this.dcRestartTimer = setTimeout(() => {
          if (this.pc === pc && this.camSid && pc.signalingState === 'have-local-offer') this.send(this.camSid, offer, true);
        }, DC_RESTART_WAIT_MS);
      }
    } catch {
      this.setState('failed');
    }
  }

  /**
   * Signaling from the camera through the room. Sealed: opened with the nursery key (or dropped).
   * Plain: taken unless we hold the key and this camera seals — then it's the room's, not the
   * camera's (sticky end to end, ADR 0006 D6.3). A camera that doesn't seal (an older app) is
   * taken as always.
   */
  async onSignal(from: string, raw: MonRtc | SealedRtc): Promise<void> {
    const pc = this.pc;
    if (!pc || from !== this.camSid) return;
    const seal = this.seal;
    // Judged now, opened in parallel, handled in arrival order (an answer before its candidates).
    let opened: Promise<MonRtc | null>;
    if (isSealedRtc(raw)) {
      const dk = this.camKey?.() ?? null;
      opened = seal ? seal.open(raw).then((o) => (o && (!dk || o.from === dk) ? o.d : null), () => null) : Promise.resolve(null);
    } else opened = Promise.resolve(this.sealing() ? null : (raw as MonRtc));
    const d = await this.rx.run(opened);
    if (!d) {
      this.refused += 1;
      return;
    }
    if (this.pc !== pc || from !== this.camSid) return;
    return this.handle(d);
  }

  private async handle(d: MonRtc): Promise<void> {
    if (!this.pc) return;
    // Answers, candidates and byes for an older call of ours are stale.
    if (d.pc && d.pc !== this.pcId) return;
    if (d.sdp?.type === 'answer') {
      if (d.dcc === 1) this.dcc = true;
      if (d.ib === 1) this.ib = true;
      if (d.dcr === 1) this.dcr = true;
      clearTimeout(this.dcRestartTimer);
      await this.pc.setRemoteDescription(d.sdp).catch(() => this.setState('failed'));
    } else if (d.ice || d.ices) {
      for (const c of candidatesOf(d)) await this.pc?.addIceCandidate(c).catch(() => undefined);
    } else if (d.re) {
      // The camera's relay credential was renewed: restart onto it (only we offer).
      if (this.pc.connectionState === 'connected') await this.restartIce();
    } else if (d.bye) {
      this.teardown(false);
      if (d.full) {
        // Its direct slots are taken: straight to the relay picture (retried later).
        this.full = true;
        window.clearTimeout(this.connectTimer);
        this.setState('failed');
        return;
      }
      // The camera hung up (it's stopping): the call is over, not failed.
      this.setState('closed');
    }
  }

  private sendDc(m: ViewerDcMsg): boolean {
    if (!this.dcc || this.dc?.readyState !== 'open') return false;
    try {
      this.dc.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The picture quality, straight to the camera over the data channel when it takes it there
   * (free — no message through our server). False: send it through the room instead.
   */
  sendQuality(q: Quality): boolean {
    return this.sendDc({ t: 'q', q });
  }

  /**
   * This viewer's screen is shown or hidden (picture-in-picture counts as shown). The camera
   * stops the picture after HIDDEN_GRACE_MS hidden and brings it back at once (viewGate.ts).
   */
  setShown(shown: boolean): void {
    if (shown === this.shown) return;
    this.shown = shown;
    this.sendDc({ t: 'vis', on: shown });
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
    clearTimeout(this.dcRestartTimer);
    this.iceBatch?.clear();
    this.iceBatch = null;
    if (this.onOnline) window.removeEventListener?.('online', this.onOnline);
    this.onOnline = null;
    this.dc = null;
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
    this.iceClock.stop();
    if (this.camSid && this.pc) this.send(this.camSid, { bye: true });
    void this.stopTalk();
    void this.stopVideo();
    this.teardown(false);
    this.camSid = null;
    this.setState('closed');
  }
}
