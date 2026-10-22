/**
 * WebRTC for on-air guests — a host-centric mesh (≤ MAX_GUESTS seats).
 *
 * Topology: every guest holds ONE RTCPeerConnection to the host; guests never
 * connect to each other. The host receives each guest's camera (+ mic) and
 * optional screen share, mixes them into the program canvas/audio, and the
 * existing segment rail delivers the composite to viewers — so 4 guests cost
 * the host 4 peer links, and viewers still cost ~nothing.
 *
 * Guests still see and hear EACH OTHER: what the host sends back on each link
 * (the "return feed") is the program canvas plus a mix-minus of the audio —
 * everyone except that guest, so nobody hears their own echo. The host picks
 * the tracks per guest through a ReturnFeed; each link's video is capped so
 * four return feeds fit a home uplink.
 *
 * Signaling rides the EventRoom websocket as `{ t: 'rtc', to?, d }` envelopes
 * (see protocol.RtcSignal). Both ends run the "perfect negotiation" pattern:
 * the HOST is impolite, GUESTS are polite, so glare resolves deterministically.
 * Stream labeling: each side sends `meta` (MediaStream.id → 'cam' | 'screen')
 * with every signal, so tiles are labeled before the first frame arrives.
 *
 * ICE: the room hands out STUN + short-lived Cloudflare TURN credentials
 * (`{t:'ice'}`, live-worker/src/ice.ts); until they arrive — or on a room that
 * predates it — links use the STUN pair below. Without TURN, a guest behind a
 * strict NAT on both ends may fail to connect — the UI says so honestly.
 *
 * Recovery: a link that drops to `disconnected` for a few seconds, or
 * `failed`, restarts ICE (a few times, then gives up and says so). A `ready`
 * from the HOST tells a guest to rebuild its link — that is how a studio that
 * reloaded, or whose camera came up late, picks guests back up.
 *
 * Relays cost per GB (Cloudflare TURN bills what it sends to the relaying device), so each
 * link re-reads its network path, and one going through a relay sends less: the return feed
 * ≤ 700 kbps, a guest's camera ≤ 600 kbps and screen ≤ 1 Mbps (lifted again if the path goes
 * direct). TURN credentials are short-lived: the views ask the room for fresh ones when
 * `iceMs` says (live/rtcIce.ts), and a relayed link restarts ICE onto them before the old
 * ones lapse.
 */

import { netPath, type NetPath } from '../monitor/rtc';
import type { RtcSignal } from '../protocol';
import { keepRelay, turnRenewed } from '../rtcIce';

export type TrackKind = 'cam' | 'screen';

/** STUN-only fallback until (or unless) the room sends its ICE list. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/**
 * Keep only well-formed STUN/TURN entries from the room's `{t:'ice'}` reply.
 * Returns null when nothing usable came back (callers keep the fallback).
 */
export function sanitizeIceServers(raw: unknown): RTCIceServer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RTCIceServer[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const { urls, username, credential } = s as { urls?: unknown; username?: unknown; credential?: unknown };
    const list = (Array.isArray(urls) ? urls : [urls]).filter((u): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u));
    if (!list.length) continue;
    out.push({
      urls: list,
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    });
  }
  return out.length ? out : null;
}

/** ICE restarts per link before it stays `failed` and the UI says so. */
export const MAX_ICE_RESTARTS = 3;
/** A link that sits in `disconnected` this long gets an ICE restart. */
export const DISCONNECTED_GRACE_MS = 3000;
/** A connected link re-reads its network path this often (an ICE restart can move it on or off a relay). */
export const PATH_RECHECK_MS = 15_000;

/** Through a relay (TURN, billed per GB): the return feed, a guest's camera and a guest's screen never go above these. */
export const RELAY_RETURN_BPS = 700_000;
export const RELAY_GUEST_CAM_BPS = 600_000;
export const RELAY_GUEST_SCREEN_BPS = 1_000_000;

/**
 * Video budget for one guest's return feed (the program canvas): fewer guests get more,
 * and the picture is scaled to ≤ 540 lines — plenty for a meeting tile, and four
 * encodes of it still fit a home uplink.
 */
export function returnFeedEncoding(guests: number, sourceHeight: number, relayed = false): { maxBitrate: number; scaleResolutionDownBy: number } {
  const base = guests <= 1 ? 1_200_000 : guests === 2 ? 900_000 : 700_000;
  const maxBitrate = relayed ? Math.min(base, RELAY_RETURN_BPS) : base;
  const scale = sourceHeight > 540 ? Math.round((sourceHeight / 540) * 100) / 100 : 1;
  return { maxBitrate, scaleResolutionDownBy: scale };
}

/** Apply a send cap to one video sender (before negotiation it may have no encodings yet). */
async function capSender(sender: RTCRtpSender, enc: { maxBitrate: number; scaleResolutionDownBy: number }): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const e = params.encodings[0];
    if (e.maxBitrate === enc.maxBitrate && e.scaleResolutionDownBy === enc.scaleResolutionDownBy) return;
    e.maxBitrate = enc.maxBitrate;
    e.scaleResolutionDownBy = enc.scaleResolutionDownBy;
    await sender.setParameters(params);
  } catch {
    /* not negotiated yet / older browser — re-applied once connected; congestion control still adapts */
  }
}

/** Cap one video sender's bitrate (null: no cap of ours — congestion control alone, as off a relay). */
async function limitBitrate(sender: RTCRtpSender | null, bps: number | null): Promise<void> {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const e = params.encodings[0];
    if (bps == null ? e.maxBitrate == null : e.maxBitrate === bps) return;
    if (bps == null) delete e.maxBitrate;
    else e.maxBitrate = bps;
    await sender.setParameters(params);
  } catch {
    /* not negotiated yet: re-applied when the path is next read */
  }
}

export interface RemoteStream {
  kind: TrackKind;
  stream: MediaStream;
}

type SendSignal = (d: RtcSignal) => void;

/** Shared negotiation core for one peer link. */
class PeerLink {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private readonly polite: boolean;
  private remoteMeta: Record<string, TrackKind> = {};
  private localMeta = new Map<string, TrackKind>();
  private knownStreams = new Map<string, MediaStream>();
  /** A labeled remote stream gained its first track (or its label arrived). */
  onRemote: ((r: RemoteStream) => void) | null = null;
  onRemoteGone: ((streamId: string) => void) | null = null;
  onConnectionState: ((s: RTCPeerConnectionState) => void) | null = null;
  /** The network path this link uses (null until known); a relay is billed per GB, so it's capped. */
  path: NetPath | null = null;
  onPath: ((p: NetPath) => void) | null = null;
  private restarts = 0;
  private discTimer: ReturnType<typeof setTimeout> | null = null;
  private pathTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(polite: boolean, private signal: SendSignal, iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS) {
    this.polite = polite;
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.emitSdp();
      } catch {
        /* connection is closing */
      } finally {
        this.makingOffer = false;
      }
    };
    this.pc.onicecandidate = (e) => this.signal({ ice: e.candidate ? e.candidate.toJSON() : null, meta: this.metaRecord() });
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.recover(st);
      this.onConnectionState?.(st);
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      this.knownStreams.set(stream.id, stream);
      this.onRemote?.({ kind: this.remoteMeta[stream.id] ?? 'cam', stream });
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          this.knownStreams.delete(stream.id);
          this.onRemoteGone?.(stream.id);
        }
      };
    };
  }

  private metaRecord(): Record<string, TrackKind> {
    const out: Record<string, TrackKind> = {};
    for (const [id, kind] of this.localMeta) out[id] = kind;
    return out;
  }

  private emitSdp(): void {
    const ld = this.pc.localDescription;
    if (!ld) return;
    this.signal({ sdp: { type: ld.type as 'offer' | 'answer', sdp: ld.sdp }, meta: this.metaRecord() });
  }

  /** Add (and label) every track of a local stream. Returns the video sender. */
  addLocalStream(stream: MediaStream, kind: TrackKind): RTCRtpSender | null {
    this.localMeta.set(stream.id, kind);
    let videoSender: RTCRtpSender | null = null;
    for (const track of stream.getTracks()) {
      const sender = this.pc.addTrack(track, stream);
      if (track.kind === 'video') videoSender = sender;
    }
    return videoSender;
  }

  removeLocalStream(stream: MediaStream): void {
    this.localMeta.delete(stream.id);
    const ids = new Set(stream.getTracks().map((t) => t.id));
    for (const sender of this.pc.getSenders()) {
      if (sender.track && ids.has(sender.track.id)) {
        try {
          this.pc.removeTrack(sender);
        } catch {
          /* already removed */
        }
      }
    }
  }

  async handle(d: RtcSignal): Promise<void> {
    if (d.meta) {
      // Labels can arrive before or after ontrack — re-announce on upgrade so
      // a tile that started life as 'cam' relabels to 'screen' correctly.
      const before = this.remoteMeta;
      this.remoteMeta = { ...this.remoteMeta, ...d.meta };
      for (const [id, stream] of this.knownStreams) {
        if (d.meta[id] && d.meta[id] !== before[id]) {
          this.onRemote?.({ kind: d.meta[id], stream });
        }
      }
    }
    try {
      if (d.sdp?.type) {
        const offerCollision = d.sdp.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(d.sdp as RTCSessionDescriptionInit);
        if (d.sdp.type === 'offer') {
          await this.pc.setLocalDescription();
          this.emitSdp();
        }
      } else if (d.ice !== undefined) {
        if (d.ice) {
          try {
            await this.pc.addIceCandidate(d.ice);
          } catch (err) {
            if (!this.ignoreOffer) throw err;
          }
        }
      }
    } catch {
      /* negotiation hiccup — the next offer recovers */
    }
  }

  /**
   * Self-healing: `failed` restarts ICE at once; `disconnected` gets a short grace (Wi-Fi
   * handovers often recover alone) — a little longer on the polite side, so the host's
   * restart usually wins and the two never collide. Capped, then the failure is final.
   */
  private recover(st: RTCPeerConnectionState): void {
    if (this.discTimer) {
      clearTimeout(this.discTimer);
      this.discTimer = null;
    }
    if (st === 'connected') {
      this.restarts = 0;
      void this.checkPath();
      return;
    }
    if (st === 'failed') this.restartIce();
    else if (st === 'disconnected') {
      this.discTimer = setTimeout(() => {
        this.discTimer = null;
        if (this.pc.connectionState === 'disconnected') this.restartIce();
      }, DISCONNECTED_GRACE_MS + (this.polite ? 1500 : 0));
    }
  }

  /** Ask for a fresh ICE round (perfect negotiation carries the new offer). */
  restartIce(): boolean {
    if (this.closed || this.restarts >= MAX_ICE_RESTARTS || typeof this.pc.restartIce !== 'function') return false;
    this.restarts += 1;
    try {
      this.pc.restartIce();
      return true;
    } catch {
      return false;
    }
  }

  /** Which network path the link uses now (re-read while connected); tells the owner when it changes. */
  private async checkPath(): Promise<void> {
    if (this.pathTimer) clearTimeout(this.pathTimer);
    this.pathTimer = null;
    if (this.closed || this.pc.connectionState !== 'connected') return;
    const p = await netPath(this.pc);
    if (this.closed || this.pc.connectionState !== 'connected') return;
    if (p && p !== this.path) {
      this.path = p;
      this.onPath?.(p);
    }
    this.pathTimer = setTimeout(() => void this.checkPath(), PATH_RECHECK_MS);
  }

  /**
   * New ICE list from the room (TURN arrived, or fresh credentials): use it, and re-gather if
   * not up yet — or, if the link goes through a relay on the credentials these replace,
   * restart onto them now, before those lapse.
   */
  setIceServers(list: RTCIceServer[]): void {
    if (this.closed) return;
    let renewed = false;
    try {
      const cur = this.pc.getConfiguration();
      const iceServers = keepRelay(cur.iceServers ?? [], list);
      renewed = turnRenewed(cur.iceServers, iceServers);
      this.pc.setConfiguration({ ...cur, iceServers });
    } catch {
      return;
    }
    const st = this.pc.connectionState;
    if (this.pc.remoteDescription && st !== 'connected' && st !== 'new') this.restartIce();
    else if (renewed && st === 'connected' && this.path === 'relay') this.restartIce();
  }

  /** What kind a remote stream id maps to right now. */
  kindOf(streamId: string): TrackKind {
    return this.remoteMeta[streamId] ?? 'cam';
  }

  close(): void {
    this.closed = true;
    if (this.discTimer) clearTimeout(this.discTimer);
    this.discTimer = null;
    if (this.pathTimer) clearTimeout(this.pathTimer);
    this.pathTimer = null;
    try {
      this.pc.close();
    } catch {
      /* closed */
    }
  }
}

/* ------------------------------- host side ------------------------------- */

export interface GuestLink {
  sid: string;
  name: string;
  state: RTCPeerConnectionState;
  cam: MediaStream | null;
  screen: MediaStream | null;
}

/**
 * What the host sends back to one guest. `video` is shared by every link (the program
 * canvas, or the raw camera as a fallback); `audioFor` is per guest — a mix-minus of
 * everyone else. `release` frees a guest's mix when its link goes away.
 */
export interface ReturnFeed {
  video(): MediaStreamTrack | null;
  audioFor(sid: string): MediaStreamTrack | null;
  release?(sid: string): void;
}

interface HostEntry {
  link: PeerLink;
  name: string;
  /** The return-feed stream this link carries (labelled 'cam' for the guest). */
  out: MediaStream | null;
  videoSender: RTCRtpSender | null;
  state: RTCPeerConnectionState;
  cam: MediaStream | null;
  screen: MediaStream | null;
}

/**
 * The host's side of the mesh: one PeerLink per guest, each fed with that guest's return
 * feed (program video + mix-minus audio) so guests see and hear the host AND each other
 * with sub-second latency (the segmented program is ~10 s behind — useless for talking).
 */
export class HostPeers {
  private links = new Map<string, HostEntry>();
  private feed: ReturnFeed | null = null;
  private iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS;
  /** Any guest's media or connection state changed — re-render tiles. */
  onChange: (() => void) | null = null;

  constructor(private sendTo: (sid: string, d: RtcSignal) => void, iceServers?: RTCIceServer[] | null) {
    if (iceServers?.length) this.iceServers = iceServers;
  }

  /** The room's ICE list (STUN + TURN): new links use it, links still connecting re-gather. */
  setIceServers(list: RTCIceServer[]): void {
    this.iceServers = keepRelay(this.iceServers, list);
    for (const e of this.links.values()) e.link.setIceServers(list);
  }

  /** How each guest's return feed is built. Set before guests connect. */
  setReturnFeed(feed: ReturnFeed): void {
    this.feed = feed;
  }

  /** The shared return video changed (camera fallback mode swapped cameras) — swap in place. */
  async replaceCamTrack(track: MediaStreamTrack | null): Promise<void> {
    for (const entry of this.links.values()) {
      if (entry.videoSender) {
        try {
          await entry.videoSender.replaceTrack(track);
        } catch {
          /* sender mid-teardown */
        }
      }
    }
  }

  /** Re-apply every link's video cap — the guest count changed (so the per-link budget did), or a link's path did. */
  private recap(): void {
    const n = this.links.size;
    for (const e of this.links.values()) {
      const track = e.videoSender?.track;
      if (!e.videoSender || !track) continue;
      const h = track.getSettings?.().height ?? 720;
      void capSender(e.videoSender, returnFeedEncoding(n, h, e.link.path === 'relay'));
    }
  }

  ensure(sid: string, name: string): void {
    const existing = this.links.get(sid);
    if (existing) {
      // A `ready` after we already have a link = the guest rebuilt its side (page
      // reload, or it answered our own `ready`): start this link over too.
      existing.link.close();
      this.links.delete(sid);
    }
    const link = new PeerLink(false, (d) => this.sendTo(sid, d), this.iceServers);
    const entry: HostEntry = { link, name, out: null, videoSender: null, state: 'new', cam: null, screen: null };
    const video = this.feed?.video() ?? null;
    const audio = this.feed?.audioFor(sid) ?? null;
    const tracks = [video, audio].filter(Boolean) as MediaStreamTrack[];
    if (tracks.length) {
      entry.out = new MediaStream(tracks);
      entry.videoSender = link.addLocalStream(entry.out, 'cam');
    }
    link.onRemote = ({ kind, stream }) => {
      // Relabels move the stream between slots — never leave a stale ref.
      if (entry.cam?.id === stream.id && kind !== 'cam') entry.cam = null;
      if (entry.screen?.id === stream.id && kind !== 'screen') entry.screen = null;
      if (kind === 'screen') entry.screen = stream;
      else entry.cam = stream;
      this.onChange?.();
    };
    link.onRemoteGone = (streamId) => {
      if (entry.screen?.id === streamId) entry.screen = null;
      if (entry.cam?.id === streamId) entry.cam = null;
      this.onChange?.();
    };
    link.onConnectionState = (s) => {
      entry.state = s;
      if (s === 'connected') this.recap(); // encodings exist now — make the cap stick
      this.onChange?.();
    };
    link.onPath = () => this.recap(); // onto or off a relay: its return feed's cap follows
    this.links.set(sid, entry);
    this.recap();
    this.onChange?.();
  }

  async onSignal(sid: string, name: string, d: RtcSignal): Promise<void> {
    if (d.bye) {
      this.close(sid);
      return;
    }
    if (d.ready) {
      this.ensure(sid, name);
      return;
    }
    if (!this.links.has(sid)) {
      // Signal from a guest we haven't set up (e.g. studio reloaded) — build
      // the link first so the offer lands somewhere.
      this.ensure(sid, name);
    }
    await this.links.get(sid)?.link.handle(d);
  }

  has(sid: string): boolean {
    return this.links.has(sid);
  }

  guests(): GuestLink[] {
    return Array.from(this.links.entries()).map(([sid, e]) => ({
      sid,
      name: e.name,
      state: e.state,
      cam: e.cam,
      screen: e.screen,
    }));
  }

  close(sid: string): void {
    const entry = this.links.get(sid);
    if (entry) {
      entry.link.close();
      this.links.delete(sid);
      this.feed?.release?.(sid);
      this.recap();
      this.onChange?.();
    }
  }

  closeAll(): void {
    for (const [sid, { link }] of this.links) {
      link.close();
      this.feed?.release?.(sid);
    }
    this.links.clear();
    this.onChange?.();
  }
}

/* ------------------------------- guest side ------------------------------- */

/**
 * A guest's single link to the host: sends cam+mic (and an optional screen
 * share), receives the host's return feed — the program picture and everyone
 * else's voices.
 */
export class GuestPeer {
  private link: PeerLink;
  private screenStream: MediaStream | null = null;
  private camSender: RTCRtpSender | null = null;
  private screenSender: RTCRtpSender | null = null;
  onHostStream: ((stream: MediaStream | null) => void) | null = null;
  onState: ((s: RTCPeerConnectionState) => void) | null = null;

  constructor(send: SendSignal, cam: MediaStream, iceServers?: RTCIceServer[] | null) {
    this.link = new PeerLink(true, send, iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS);
    this.camSender = this.link.addLocalStream(cam, 'cam');
    this.link.onRemote = ({ stream }) => this.onHostStream?.(stream);
    this.link.onRemoteGone = () => this.onHostStream?.(null);
    this.link.onConnectionState = (s) => this.onState?.(s);
    this.link.onPath = () => void this.capUplink();
  }

  /** Through a relay our camera and screen send less (billed per GB); off it, no cap of ours. */
  private async capUplink(): Promise<void> {
    const relayed = this.link.path === 'relay';
    await limitBitrate(this.camSender, relayed ? RELAY_GUEST_CAM_BPS : null);
    await limitBitrate(this.screenSender, relayed ? RELAY_GUEST_SCREEN_BPS : null);
  }

  /** Guest flipped their camera — swap the outgoing video track in place. */
  async replaceCamVideoTrack(track: MediaStreamTrack): Promise<void> {
    try {
      await this.camSender?.replaceTrack(track);
    } catch {
      /* sender mid-teardown */
    }
  }

  /** Start/stop the guest's own screen share (renegotiates in place). */
  setScreen(stream: MediaStream | null): void {
    if (this.screenStream) {
      this.link.removeLocalStream(this.screenStream);
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.screenSender = null;
    }
    if (stream) {
      this.screenStream = stream;
      this.screenSender = this.link.addLocalStream(stream, 'screen');
      if (this.link.path === 'relay') void limitBitrate(this.screenSender, RELAY_GUEST_SCREEN_BPS);
    }
  }

  get screenActive(): boolean {
    return !!this.screenStream;
  }

  setIceServers(list: RTCIceServer[]): void {
    this.link.setIceServers(list);
  }

  handle(d: RtcSignal): Promise<void> {
    return this.link.handle(d);
  }

  close(): void {
    this.setScreen(null);
    this.link.close();
  }
}
