/**
 * WebRTC for on-air guests — a host-centric mesh (≤ MAX_GUESTS seats).
 *
 * Topology: every guest holds ONE RTCPeerConnection to the host; guests never
 * connect to each other. The host receives each guest's camera (+ mic) and
 * optional screen share, mixes them into the program canvas/audio, and the
 * existing segment rail delivers the composite to viewers — so 4 guests cost
 * the host 4 peer links, and viewers still cost ~nothing.
 *
 * Signaling rides the EventRoom websocket as `{ t: 'rtc', to?, d }` envelopes
 * (see protocol.RtcSignal). Both ends run the "perfect negotiation" pattern:
 * the HOST is impolite, GUESTS are polite, so glare resolves deterministically.
 * Stream labeling: each side sends `meta` (MediaStream.id → 'cam' | 'screen')
 * with every signal, so tiles are labeled before the first frame arrives.
 *
 * STUN only (Cloudflare + Google). Without TURN, a guest behind a symmetric
 * NAT on BOTH ends may fail to connect — the UI surfaces that state honestly.
 */

import type { RtcSignal } from '../protocol';

export type TrackKind = 'cam' | 'screen';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

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

  constructor(polite: boolean, private signal: SendSignal) {
    this.polite = polite;
    this.pc = new RTCPeerConnection(RTC_CONFIG);

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
    this.pc.onconnectionstatechange = () => this.onConnectionState?.(this.pc.connectionState);
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

  /** What kind a remote stream id maps to right now. */
  kindOf(streamId: string): TrackKind {
    return this.remoteMeta[streamId] ?? 'cam';
  }

  close(): void {
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
 * The host's side of the mesh: one PeerLink per guest, fed with the host's
 * cam+mic return feed so guests can see and hear the host with sub-second
 * latency (the segmented program is ~10 s behind — useless for conversation).
 */
export class HostPeers {
  private links = new Map<string, { link: PeerLink; name: string; camSender: RTCRtpSender | null; state: RTCPeerConnectionState; cam: MediaStream | null; screen: MediaStream | null }>();
  private returnStream: MediaStream | null = null;
  /** Any guest's media or connection state changed — re-render tiles. */
  onChange: (() => void) | null = null;

  constructor(private sendTo: (sid: string, d: RtcSignal) => void) {}

  /** The host's cam+mic feed guests receive (tracks, not a clone — toggles apply). */
  setReturnFeed(camTrack: MediaStreamTrack | null, micTrack: MediaStreamTrack | null): void {
    const tracks = [camTrack, micTrack].filter(Boolean) as MediaStreamTrack[];
    this.returnStream = tracks.length ? new MediaStream(tracks) : null;
  }

  /** Camera flipped/switched mid-call — swap the outgoing video track in place. */
  async replaceCamTrack(track: MediaStreamTrack | null): Promise<void> {
    for (const entry of this.links.values()) {
      if (entry.camSender) {
        try {
          await entry.camSender.replaceTrack(track);
        } catch {
          /* sender mid-teardown */
        }
      }
    }
  }

  ensure(sid: string, name: string): void {
    const existing = this.links.get(sid);
    if (existing) {
      // A `ready` after we already have a link = the guest page reloaded.
      existing.link.close();
      this.links.delete(sid);
      this.onChange?.();
    }
    const link = new PeerLink(false, (d) => this.sendTo(sid, d));
    const entry = { link, name, camSender: null as RTCRtpSender | null, state: 'new' as RTCPeerConnectionState, cam: null as MediaStream | null, screen: null as MediaStream | null };
    if (this.returnStream) entry.camSender = link.addLocalStream(this.returnStream, 'cam');
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
      this.onChange?.();
    };
    this.links.set(sid, entry);
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
    const entry = this.links.get(sid);
    if (!entry) {
      // Signal from a guest we haven't set up (e.g. studio reloaded) — build
      // the link first so the offer lands somewhere.
      this.ensure(sid, name);
    }
    await this.links.get(sid)?.link.handle(d);
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
      this.onChange?.();
    }
  }

  closeAll(): void {
    for (const { link } of this.links.values()) link.close();
    this.links.clear();
    this.onChange?.();
  }
}

/* ------------------------------- guest side ------------------------------- */

/**
 * A guest's single link to the host: sends cam+mic (and an optional screen
 * share), receives the host's cam+mic return feed.
 */
export class GuestPeer {
  private link: PeerLink;
  private screenStream: MediaStream | null = null;
  private camSender: RTCRtpSender | null = null;
  onHostStream: ((stream: MediaStream | null) => void) | null = null;
  onState: ((s: RTCPeerConnectionState) => void) | null = null;

  constructor(send: SendSignal, cam: MediaStream) {
    this.link = new PeerLink(true, send);
    this.camSender = this.link.addLocalStream(cam, 'cam');
    this.link.onRemote = ({ stream }) => this.onHostStream?.(stream);
    this.link.onRemoteGone = () => this.onHostStream?.(null);
    this.link.onConnectionState = (s) => this.onState?.(s);
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
    }
    if (stream) {
      this.screenStream = stream;
      this.link.addLocalStream(stream, 'screen');
    }
  }

  get screenActive(): boolean {
    return !!this.screenStream;
  }

  handle(d: RtcSignal): Promise<void> {
    return this.link.handle(d);
  }

  close(): void {
    this.setScreen(null);
    this.link.close();
  }
}
