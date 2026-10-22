/**
 * The relay picture as real video: when a viewer can't get the direct
 * (peer-to-peer) picture — its network blocks it and there's no TURN server,
 * it's still connecting, or the camera's direct slots are full — the camera
 * encodes ONE small video stream with WebCodecs and sends it through the
 * nursery's room, which passes it to every such viewer. 640 px on the long
 * side, 10–15 fps, ~450 kbit/s, a key frame every 2 s, sound alongside.
 *
 * Camera — `RelayEncoder`:
 *  - draws the live picture into a canvas at 640×360 (or 360×640 / 640×480,
 *    as the lens gives it), makes a VideoFrame from it, and encodes with the
 *    first codec this phone can encode that most relay viewers can decode
 *    (H.264 constrained baseline in Annex B, so every key frame carries its
 *    parameter sets, then VP8, then VP9 — probed with isConfigSupported);
 *    `latencyMode: 'realtime'`. No encoder at all → JPEG frames, 2–5 fps;
 *  - JPEG frames too, for viewers whose browser can't decode the video;
 *  - a key frame every 2 s and whenever the room asks (`relay_key`: someone
 *    subscribed, fell behind, or their decoder failed);
 *  - skips frames (rather than queueing them) while more than 64 KB is still
 *    waiting on the socket, until it drains below 32 KB — then carries on
 *    with the next frame (a skipped frame never reached the encoder, so
 *    nothing is missing: no key frame needed, which would only refill the
 *    socket); a frame that couldn't be sent drops every frame after it until
 *    the next key frame (they'd decode as garbage); keeps backing off while
 *    the uplink is tight (the JPEG pace too);
 *  - bundles the sound captured since the last frame into each message
 *    (relayAudio.ts); sound goes alone only when no frame went out for 150 ms;
 *  - sends nothing at all while the video is paused for privacy, and encodes
 *    nothing while the camera's room socket is down (the sends would only
 *    fail — while the home Wi-Fi keeps the direct picture going).
 *
 * Viewer — `RelayDecoder`: VideoDecoder → canvas (every frame closed right
 * away), JPEG via createImageBitmap, sound through RelaySoundPlayer; acks
 * what it received every 500 ms (`{t:'rx', s}`, plus `k: 1` when its decoder
 * needs a key frame) — and always the last message of a burst, a moment
 * later, so the room never holds a viewer back on an old acknowledgement;
 * falls back to JPEG after repeated decoder errors. Its sound is started
 * from a tap (Listen) — phones play nothing otherwise — and `soundBlocked`
 * tells the screen when relay sound is arriving but not playing.
 * `stream()` is the canvas (captureStream) plus the sound, for the watch
 * screen's <video> — so picture-in-picture and the Listen button work on the
 * relay just as on the direct picture.
 *
 * Frames and sound pass through the room's memory: NOT end-to-end encrypted
 * like the direct picture (with or without TURN), and never stored.
 */

import { RelayPacer, RELAY_MAX_BUFFERED } from './videoBudget';
import { canPlayRelaySound, RelaySoundPlayer, SoundPacker } from './relayAudio';
import { CODEC_STRING, MAX_JPEG_BYTES, MAX_VIDEO_BYTES, nextSeq, pack, RELAY_CODECS, u32, unpack, type RelayCodec, type RelayFrame } from './relayWire';

export const RELAY_LONG_SIDE = 640;
export const KEY_EVERY_MS = 2000;
/** Skip frames while more than this is still waiting on the socket… */
export const SEND_BACKLOG = 64 * 1024;
/** …until it has drained below this (hysteresis: no stop-start on every frame). */
export const SEND_RESUME = 32 * 1024;
/** Sound is small and matters most: it may queue behind a little more. */
const SOUND_MAX_BUFFERED = 256 * 1024;
/** No frame went out for this long: the sound goes on its own. */
const SOUND_ALONE_MS = 150;
/** Encoder rungs: the uplink decides (see RelayRate). */
export const RELAY_RUNGS = [
  { bps: 450_000, fps: 15 },
  { bps: 300_000, fps: 12 },
  { bps: 200_000, fps: 10 },
] as const;

/** How many relay viewers there are, and what they decode (the room's relay_want). */
export interface RelayWant {
  n: number;
  avc: number;
  vp8: number;
  vp9: number;
  /** Viewers that decode none of them (JPEG only). */
  jpeg: number;
}
export const NO_WANT: RelayWant = { n: 0, avc: 0, vp8: 0, vp9: 0, jpeg: 0 };

/** From the room's message (older rooms only send n: everyone gets JPEG). */
export function readWant(m: Record<string, unknown>): RelayWant {
  const k = (v: unknown) => Math.max(0, Math.min(64, Math.round(Number(v) || 0)));
  const n = k(m.n);
  if (!('avc' in m)) return { ...NO_WANT, n, jpeg: n };
  return { n, avc: k(m.avc), vp8: k(m.vp8), vp9: k(m.vp9), jpeg: k(m.jpeg) };
}

/** The relay picture's size: the camera's aspect, 640 on the long side (never upscaled), even numbers. */
export function relaySize(vw: number, vh: number, long = RELAY_LONG_SIDE): { w: number; h: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (!(vw > 0) || !(vh > 0)) return { w: long, h: even((long * 9) / 16) };
  const s = Math.min(1, long / Math.max(vw, vh));
  return { w: even(vw * s), h: even(vh * s) };
}

export function encoderConfig(codec: RelayCodec, w: number, h: number, bps: number = RELAY_RUNGS[0].bps, fps: number = RELAY_RUNGS[0].fps): VideoEncoderConfig {
  return {
    codec: CODEC_STRING[codec],
    width: w,
    height: h,
    bitrate: bps,
    framerate: fps,
    latencyMode: 'realtime',
    ...(codec === 'avc' ? { avc: { format: 'annexb' as const } } : {}),
  };
}

/** The codecs this phone can encode, best first (H.264, VP8, VP9); empty = JPEG only. */
export async function probeEncoders(w = 640, h = 360): Promise<RelayCodec[]> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return [];
  const out: RelayCodec[] = [];
  for (const c of RELAY_CODECS) {
    try {
      if ((await VideoEncoder.isConfigSupported(encoderConfig(c, w, h))).supported) out.push(c);
    } catch { /* not this one */ }
  }
  return out;
}

let decodable: Promise<RelayCodec[]> | null = null;
/** The codecs this browser can decode (probed once); empty = JPEG only. */
export function probeDecoders(): Promise<RelayCodec[]> {
  decodable ??= (async () => {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return [];
    const out: RelayCodec[] = [];
    for (const c of RELAY_CODECS) {
      try {
        if ((await VideoDecoder.isConfigSupported({ codec: CODEC_STRING[c], optimizeForLatency: true })).supported) out.push(c);
      } catch { /* not this one */ }
    }
    return out;
  })();
  return decodable;
}

/** Tests only. */
export function resetProbe(): void {
  decodable = null;
}

/**
 * Which codec to encode: of those this phone can encode, the one most relay
 * viewers decode (ties: the better codec). Keeps the current one unless
 * another reaches strictly more viewers. Null: nobody decodes any (JPEG only).
 */
export function chooseCodec(can: readonly RelayCodec[], want: RelayWant, current: RelayCodec | null): RelayCodec | null {
  let best: RelayCodec | null = null;
  for (const c of can) if (want[c] > 0 && (!best || want[c] > want[best])) best = c;
  if (current && can.includes(current) && want[current] > 0 && (!best || want[current] >= want[best])) return current;
  return best;
}

/**
 * The uplink decides the rung: a backlog steps down (at most every 3 s);
 * 20 s without one steps back up.
 */
export class RelayRate {
  rung = 0;
  private changedAt = -Infinity;
  private backlogAt = -Infinity;

  onBacklog(now: number): boolean {
    this.backlogAt = now;
    if (this.rung >= RELAY_RUNGS.length - 1 || now - this.changedAt < 3000) return false;
    this.rung += 1;
    this.changedAt = now;
    return true;
  }

  onClear(now: number): boolean {
    if (this.rung === 0 || now - this.backlogAt < 20_000 || now - this.changedAt < 20_000) return false;
    this.rung -= 1;
    this.changedAt = now;
    return true;
  }

  get bps(): number {
    return RELAY_RUNGS[this.rung].bps;
  }

  get fps(): number {
    return RELAY_RUNGS[this.rung].fps;
  }
}

/* -------------------------------------------------------------- camera */

/**
 * The camera's "who's watching" line, after the names: whether some are still
 * connecting, and how many get the picture through the server. That's
 * everyone the room relays to (`relayed`, from relay_want) — including those
 * only bridging while their direct picture connects, which the presence list
 * doesn't mark as on the relay (`onRelay`): their picture passes through the
 * server too, so the camera says so.
 */
export function watchersNote(o: { viewers: number; direct: number; onRelay: number; relayed: number; jpeg: boolean }): string {
  const through = Math.max(o.onRelay, o.relayed);
  const connecting = o.direct < o.viewers - o.onRelay ? ' · connecting…' : '';
  return `${connecting}${through ? ` · ${through} through the server${o.jpeg ? ' (still pictures)' : ''}` : ''}`;
}

export interface RelayEncoderDeps {
  /** The camera's live picture. */
  source: () => HTMLVideoElement | null;
  /** client.sendBinary: false when it wasn't sent (socket closed or backed up). */
  send: (buf: ArrayBuffer, maxBuffered: number) => boolean;
  /** Bytes still waiting on the socket. */
  buffered: () => number;
  /** Video paused for privacy: nothing at all leaves the phone. */
  paused: () => boolean;
  /** The room socket is open (absent = always): while it's down nothing is encoded — every send would fail. */
  open?: () => boolean;
  now?: () => number;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export class RelayEncoder {
  private want: RelayWant = NO_WANT;
  private encoders: RelayCodec[] | null = null;
  private probing: Promise<void> | null = null;
  private codec: RelayCodec | null = null;
  private enc: VideoEncoder | null = null;
  private encKey = '';
  private broken = new Map<RelayCodec, number>();
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private c2d: Canvas2D | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private seq = 0;
  private keyAt = -Infinity;
  private forceKey = true;
  private dropUntilKey = false;
  private backlogged = false;
  private lastVideoAt = -Infinity;
  /** A frame went to the encoder at this time and hasn't come out yet (its message will carry the sound). */
  private encodingAt = -Infinity;
  private jpegAt = -Infinity;
  private jpegBusy = false;
  private sent: number[] = [];
  private readonly pacer = new RelayPacer(2, 5, 3);
  readonly rate = new RelayRate();
  readonly sound = new SoundPacker();
  private readonly now: () => number;

  constructor(private deps: RelayEncoderDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The room's relay_want: start, re-pick the codec, or stop. */
  setWant(w: RelayWant): void {
    this.want = w;
    if (w.n > 0) this.start();
    else this.stop();
  }

  /** The room asks for a key frame (a viewer subscribed, fell behind or lost its decoder). */
  requestKey(): void {
    this.forceKey = true;
  }

  /** Microphone audio from the sound engine (only kept while someone is on the relay). */
  pushSound(pcm: Float32Array, rate: number): void {
    if (this.running && !this.deps.paused() && this.isOpen()) this.sound.push(pcm, rate);
  }

  private isOpen(): boolean {
    return this.deps.open ? this.deps.open() : true;
  }

  get active(): boolean {
    return this.running;
  }

  /** What's being sent now: video (and its codec), JPEG only, or nothing. */
  get mode(): RelayCodec | 'jpeg' | null {
    if (!this.running) return null;
    return this.codec && this.enc ? this.codec : 'jpeg';
  }

  /** The JPEG pace (frames a second) for viewers who can't decode the video. */
  get jpegFps(): number {
    return this.pacer.fps;
  }

  /** Pictures (video or JPEG) actually sent per second, over the last five seconds. */
  sentFps(now = this.now()): number {
    const recent = this.sent.filter((t) => now - t < 5000);
    if (recent.length < 2) return recent.length;
    return Math.round(((recent.length - 1) / Math.max(1, (recent[recent.length - 1] - recent[0]) / 1000)) * 10) / 10;
  }

  private start(): void {
    if (!this.encoders && !this.probing) {
      this.probing = probeEncoders().then((list) => {
        this.encoders = list;
        this.probing = null;
      });
    }
    if (this.running) return;
    this.running = true;
    this.forceKey = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.closeEncoder();
    this.sound.clear();
    this.sent = [];
  }

  private loop = (): void => {
    if (!this.running) return;
    this.timer = setTimeout(this.loop, Math.round(1000 / this.rate.fps));
    try {
      this.step();
    } catch { /* one bad frame never stops the relay */ }
  };

  /** One frame's worth of work (public for tests). */
  step(): void {
    const now = this.now();
    // Until the phone's encoders are known (a few ms): what to send depends on it.
    if (!this.encoders) return;
    if (this.deps.paused() || !this.isOpen()) {
      // Privacy: nothing goes out — and nothing captured meanwhile goes out later.
      // Socket down: no drawing or encoding for sends that can't happen; the room
      // starts every viewer over on a key frame when the camera rejoins.
      this.sound.clear();
      this.forceKey = true;
      return;
    }
    const buffered = this.deps.buffered();
    if (buffered > SEND_BACKLOG || (this.backlogged && buffered > SEND_RESUME)) {
      if (!this.backlogged && this.rate.onBacklog(now)) this.reconfigure();
      this.backlogged = true;
      // The JPEG pace steps down too (it would never see its own threshold: we return first).
      if (this.jpegViewers() > 0 && now - this.jpegAt >= this.pacer.intervalMs) {
        this.jpegAt = now;
        this.pacer.onBacklog();
      }
      this.flushSound(now);
      return;
    }
    // Back under the resume mark: carry on with the next frame. Skipped frames never
    // reached the encoder, so the next one codes against the last one sent — a key
    // frame here would only refill the socket (and lock a tight uplink into key frames).
    if (this.backlogged) this.backlogged = false;
    else if (this.rate.onClear(now)) this.reconfigure();
    const v = this.deps.source();
    if (v && v.readyState >= 2 && v.videoWidth > 0) {
      const { w, h } = relaySize(v.videoWidth, v.videoHeight);
      if (this.draw(v, w, h)) {
        const codec = this.encoders ? chooseCodec(this.encoders.filter((c) => (this.broken.get(c) ?? 0) < 3), this.want, this.codec) : null;
        if (codec) this.encode(codec, w, h, now);
        else if (this.enc) this.closeEncoder();
        const jpegViewers = this.jpegViewers(codec);
        if (jpegViewers > 0 && !this.jpegBusy && now - this.jpegAt >= this.pacer.intervalMs && this.pacer.tick(buffered)) this.sendJpeg(now);
      }
    }
    this.flushSound(now);
  }

  /** Relay viewers who get JPEG (they decode none of what's being encoded). */
  private jpegViewers(codec: RelayCodec | null = this.enc ? this.codec : null): number {
    return this.want.n - (codec ? this.want[codec] : 0);
  }

  private draw(v: HTMLVideoElement, w: number, h: number): boolean {
    if (!this.canvas) {
      this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      this.c2d = this.canvas.getContext('2d') as Canvas2D | null;
    }
    if (!this.c2d) return false;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.c2d.drawImage(v, 0, 0, w, h);
    return true;
  }

  private encode(codec: RelayCodec, w: number, h: number, now: number): void {
    const key = `${codec}:${w}x${h}:${this.rate.rung}`;
    if (!this.enc || this.enc.state === 'closed' || this.encKey !== key) {
      if (!this.configure(codec, w, h, key)) return;
    }
    const enc = this.enc!;
    // The phone can't keep up: skip this frame (nothing is lost — the next one is coded against the last).
    if (enc.encodeQueueSize > 2) return;
    const keyFrame = this.forceKey || now - this.keyAt >= KEY_EVERY_MS;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(this.canvas as HTMLCanvasElement, { timestamp: Math.round(now * 1000) });
    } catch {
      return;
    }
    try {
      this.encodingAt = now;
      enc.encode(frame, { keyFrame });
      if (keyFrame) {
        this.keyAt = now;
        this.forceKey = false;
      }
    } catch {
      this.fail(enc);
    } finally {
      frame.close();
    }
  }

  private configure(codec: RelayCodec, w: number, h: number, key: string): boolean {
    this.closeEncoder();
    try {
      const enc: VideoEncoder = new VideoEncoder({
        output: (chunk) => this.onChunk(chunk, codec, enc),
        error: () => this.fail(enc),
      });
      enc.configure(encoderConfig(codec, w, h, this.rate.bps, this.rate.fps));
      this.enc = enc;
      this.encKey = key;
      this.codec = codec;
      this.forceKey = true;
      this.dropUntilKey = false;
      return true;
    } catch {
      this.broken.set(codec, (this.broken.get(codec) ?? 0) + 1);
      return false;
    }
  }

  /** New bitrate / frame rate: the next frame builds a fresh encoder (with a key frame). */
  private reconfigure(): void {
    this.encKey = '';
  }

  private fail(enc: VideoEncoder): void {
    if (enc !== this.enc) return;
    if (this.codec) this.broken.set(this.codec, (this.broken.get(this.codec) ?? 0) + 1);
    this.closeEncoder();
  }

  private closeEncoder(): void {
    const enc = this.enc;
    this.enc = null;
    this.encKey = '';
    if (enc && enc.state !== 'closed') {
      try {
        enc.close();
      } catch { /* closed */ }
    }
  }

  private onChunk(chunk: EncodedVideoChunk, codec: RelayCodec, enc: VideoEncoder): void {
    if (enc !== this.enc || !this.running || this.deps.paused()) return;
    this.encodingAt = -Infinity;
    const isKey = chunk.type === 'key';
    if (this.dropUntilKey && !isKey) return;
    if (chunk.byteLength > MAX_VIDEO_BYTES) {
      // Too big for the room (a very busy picture): drop it, lower the rate, start over on a key frame.
      this.dropUntilKey = true;
      this.forceKey = true;
      if (this.rate.onBacklog(this.now())) this.reconfigure();
      return;
    }
    this.dropUntilKey = false;
    const body = new Uint8Array(chunk.byteLength);
    chunk.copyTo(body);
    const now = this.now();
    const buf = pack({ kind: 'video', key: isKey, seq: this.seq, ts: u32(chunk.timestamp / 1000), codec, body, audio: this.sound.take() });
    if (this.deps.send(buf, RELAY_MAX_BUFFERED)) {
      this.seq = nextSeq(this.seq);
      this.lastVideoAt = now;
      this.broken.delete(codec);
      this.mark(now);
    } else {
      // Frames after a lost one would decode as garbage: hold them back until a key frame.
      this.dropUntilKey = true;
      this.forceKey = true;
    }
  }

  private sendJpeg(now: number): void {
    const c = this.canvas;
    if (!c) return;
    this.jpegAt = now;
    this.jpegBusy = true;
    const done = (b: Blob | null) => {
      this.jpegBusy = false;
      if (!b || !this.running || b.size > MAX_JPEG_BYTES) return;
      void b.arrayBuffer().then((ab) => {
        if (!this.running || this.deps.paused()) return;
        const buf = pack({ kind: 'jpeg', seq: this.seq, ts: u32(now), body: new Uint8Array(ab) });
        if (this.deps.send(buf, RELAY_MAX_BUFFERED)) {
          this.seq = nextSeq(this.seq);
          this.pacer.onSent(ab.byteLength, this.now());
          if (!this.enc) this.mark(this.now());
        }
      });
    };
    try {
      if ('convertToBlob' in c) void c.convertToBlob({ type: 'image/jpeg', quality: this.pacer.quality }).then(done, () => done(null));
      else c.toBlob(done, 'image/jpeg', this.pacer.quality);
    } catch {
      this.jpegBusy = false;
    }
  }

  /** Sound goes with the frames; alone only when no frame went out for a while. */
  private flushSound(now: number): void {
    // Filling a gap between frames: a short chunk; a JPEG-only camera: ~100 ms chunks (fewer messages).
    if (this.sound.pendingMs < (this.enc ? 40 : 100) || now - this.lastVideoAt < SOUND_ALONE_MS || now - this.encodingAt < SOUND_ALONE_MS) return;
    const audio = this.sound.take();
    if (!audio) return;
    const buf = pack({ kind: 'audio', seq: this.seq, ts: u32(now), codec: this.enc ? this.codec : null, audio });
    if (this.deps.send(buf, SOUND_MAX_BUFFERED)) this.seq = nextSeq(this.seq);
  }

  private mark(now: number): void {
    this.sent = [...this.sent.filter((t) => now - t < 5000), now];
  }
}

/* -------------------------------------------------------------- viewer */

/**
 * What the watch screen's sound controls say. `relaySound`: the <video>
 * plays the relay stream and it carries sound; `blocked`: that sound is
 * arriving but the phone hasn't started it (RelayDecoder.soundBlocked);
 * `hearable`: there is something to hear (the direct picture, or relay
 * sound). Never "Sound on" while the nursery is silent — blocked relay sound
 * brings the tap-to-hear prompt back even after Listen was tapped.
 */
export function soundControls(o: { muted: boolean; hearable: boolean; relaySound: boolean; blocked: boolean }): { on: boolean; tap: boolean } {
  const on = !o.muted && !(o.relaySound && o.blocked);
  return { on, tap: o.hearable && !on };
}

export interface RelayDecoderOpts {
  canvas: () => HTMLCanvasElement | null;
  /** A picture was drawn. */
  onPicture: (now: number) => void;
  /** Acknowledge what arrived (`k: 1` = the decoder needs a key frame). */
  onAck: (ack: { s: number; k?: 1 }) => void;
  /** The <video> element's stream changed (sound arrived, or a new canvas). */
  onStream?: (s: MediaStream | null) => void;
  /** Video keeps failing here: watch the JPEG picture instead. */
  onFallback?: () => void;
  /** The relay sound changed: it started arriving, or started / stopped playing (`soundBlocked`). */
  onSound?: () => void;
  now?: () => number;
}

/** The viewer acknowledges at most this often — and the last message of a burst at most this late. */
export const ACK_EVERY_MS = 500;

export class RelayDecoder {
  private dec: VideoDecoder | null = null;
  private decCodec: RelayCodec | null = null;
  private waitKey = true;
  private last: number | null = null;
  private ackAt = -Infinity;
  /** The seq last acknowledged (a trailing ack only goes when something newer arrived). */
  private acked: number | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private keyAskAt = -Infinity;
  private needKey = false;
  private errors: number[] = [];
  private jpegSeq = { next: 0, drawn: -1 };
  private chain: Promise<void> = Promise.resolve();
  private player: RelaySoundPlayer | null | undefined;
  /** Relay sound arrived since the last reset (the camera is sending some). */
  private heard = false;
  private captured: MediaStream | null = null;
  private capturedFrom: HTMLCanvasElement | null = null;
  private closed = false;
  private readonly now: () => number;
  /** What the last picture was: a video codec or JPEG. */
  codec: RelayCodec | 'jpeg' | null = null;

  constructor(private opts: RelayDecoderOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** A binary message from the room (the socket hands over Blobs: decoded strictly in order). */
  push(data: Blob | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      this.handle(data);
      return;
    }
    this.chain = this.chain
      .then(() => data.arrayBuffer())
      .then((ab) => this.handle(ab))
      .catch(() => undefined);
  }

  /** Relay sound is arriving and this browser can play it (it may still need a tap — see soundBlocked). */
  get hasSound(): boolean {
    return !!this.player && this.heard;
  }

  get soundRunning(): boolean {
    return !!this.player?.running;
  }

  /**
   * Relay sound is arriving but isn't playing: the phone hasn't let it start
   * (no tap yet, or a call / Siri / the lock screen interrupted it). The
   * screen must say so — never "Sound on" while the nursery is silent.
   */
  get soundBlocked(): boolean {
    return this.hasSound && !this.soundRunning;
  }

  /** Jitter-buffer reading (for diagnostics). */
  get soundStats() {
    return this.player?.stats ?? null;
  }

  /** Call from a tap: phones only start sound from a gesture. */
  resumeSound(): void {
    void this.player?.resume();
  }

  /**
   * Call from the Listen tap, even before the relay is in use: iPhones only
   * start an AudioContext inside a gesture, and the relay can take over at
   * any moment later (the network blocks the direct picture, the camera is
   * full, ICE drops) — when its first sound arrives from the socket, outside
   * any tap, a context made then would stay silent. So it's made and started
   * now, while the tap counts.
   */
  prepareSound(): void {
    if (this.closed) return;
    if (this.ensurePlayer() && this.capturedFrom) this.rebuildStream(this.capturedFrom);
    void this.player?.resume();
  }

  /** The sound player, made once (null when this browser can't play relay sound). True when just made. */
  private ensurePlayer(): boolean {
    if (this.player !== undefined) return false;
    this.player = canPlayRelaySound() ? RelaySoundPlayer.create(() => this.opts.onSound?.()) : null;
    return !!this.player;
  }

  handle(ab: ArrayBuffer): void {
    if (this.closed) return;
    const m = unpack(ab);
    if (!m) return;
    if (!m.legacy) this.last = m.seq;
    if (m.audio) this.playSound(m.audio);
    if (m.kind === 'jpeg') this.drawJpeg(m.body!);
    else if (m.kind === 'video') this.decode(m);
    this.maybeAck();
  }

  private maybeAck(): void {
    if (this.last == null) return;
    const now = this.now();
    const ask = this.needKey && now - this.keyAskAt >= 1000;
    if (ask || now - this.ackAt >= ACK_EVERY_MS) return this.sendAck(now, ask);
    // Inside the 500 ms: this message is still acknowledged, a moment later, if
    // nothing newer is. Otherwise the last message of a burst (after a stall)
    // is never acknowledged, the room thinks this viewer is far behind and
    // holds everything back — and with nothing arriving, it never acks again.
    if (this.ackTimer === undefined) this.ackTimer = setTimeout(this.trailingAck, Math.max(1, ACK_EVERY_MS - (now - this.ackAt)));
  }

  private trailingAck = (): void => {
    this.ackTimer = undefined;
    if (this.closed || this.last == null || this.last === this.acked) return;
    const now = this.now();
    this.sendAck(now, this.needKey && now - this.keyAskAt >= 1000);
  };

  private sendAck(now: number, ask: boolean): void {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    const s = this.last!;
    this.opts.onAck(ask ? { s, k: 1 } : { s });
    this.ackAt = now;
    this.acked = s;
    if (ask) {
      this.keyAskAt = now;
      this.needKey = false;
    }
  }

  private askKey(): void {
    this.needKey = true;
  }

  private decode(m: RelayFrame): void {
    if (typeof VideoDecoder === 'undefined' || !m.codec || !m.body) return;
    if (!this.dec || this.dec.state === 'closed' || this.decCodec !== m.codec) {
      if (!m.key) return this.askKey();
      if (!this.configure(m.codec)) return;
    }
    const dec = this.dec!;
    if (this.waitKey && !m.key) return this.askKey();
    if (dec.decodeQueueSize > 6) {
      // This device can't keep up: start over at a key frame instead of falling further behind.
      if (!m.key) {
        this.waitKey = true;
        return this.askKey();
      }
      if (!this.configure(m.codec)) return;
    }
    this.waitKey = false;
    try {
      this.dec!.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts * 1000, data: m.body }));
    } catch {
      this.onError(this.dec);
    }
  }

  private configure(codec: RelayCodec): boolean {
    this.closeDecoder();
    try {
      const dec: VideoDecoder = new VideoDecoder({
        output: (f) => this.draw(f, dec),
        error: () => this.onError(dec),
      });
      dec.configure({ codec: CODEC_STRING[codec], optimizeForLatency: true });
      this.dec = dec;
      this.decCodec = codec;
      this.waitKey = true;
      return true;
    } catch {
      this.onError(null);
      return false;
    }
  }

  private onError(dec: VideoDecoder | null): void {
    if (dec && dec !== this.dec) return;
    this.closeDecoder();
    this.waitKey = true;
    this.askKey();
    const now = this.now();
    this.errors = [...this.errors.filter((t) => now - t < 20_000), now];
    if (this.errors.length >= 3) {
      this.errors = [];
      this.opts.onFallback?.();
    }
  }

  private closeDecoder(): void {
    const dec = this.dec;
    this.dec = null;
    this.decCodec = null;
    if (dec && dec.state !== 'closed') {
      try {
        dec.close();
      } catch { /* closed */ }
    }
  }

  private draw(frame: VideoFrame, dec: VideoDecoder): void {
    try {
      if (dec !== this.dec || this.closed) return;
      const c = this.opts.canvas();
      if (!c) return;
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      c.getContext('2d')?.drawImage(frame, 0, 0, w, h);
      this.codec = this.decCodec;
      this.jpegSeq.drawn = this.jpegSeq.next;
      this.picture(c);
    } finally {
      frame.close();
    }
  }

  private drawJpeg(body: Uint8Array): void {
    const seq = this.jpegSeq.next++;
    const paint = (img: CanvasImageSource & { width: number; height: number }) => {
      const c = this.opts.canvas();
      // Decoding is async: never let an older frame overwrite a newer one.
      if (!c || this.closed || seq < this.jpegSeq.drawn) return;
      this.jpegSeq.drawn = seq;
      if (c.width !== img.width) c.width = img.width;
      if (c.height !== img.height) c.height = img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);
      this.codec = 'jpeg';
      this.picture(c);
    };
    const blob = new Blob([body], { type: 'image/jpeg' });
    if (typeof createImageBitmap === 'function') {
      void createImageBitmap(blob)
        .then((bmp) => {
          paint(bmp);
          bmp.close();
        })
        .catch(() => undefined);
    } else {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        paint(im);
        URL.revokeObjectURL(url);
      };
      im.onerror = () => URL.revokeObjectURL(url);
      im.src = url;
    }
  }

  private picture(c: HTMLCanvasElement): void {
    if (this.capturedFrom !== c) this.rebuildStream(c);
    this.opts.onPicture(this.now());
  }

  private playSound(ulaw: Uint8Array): void {
    this.ensurePlayer();
    const snd = this.player?.track;
    // The <video> plays the sound with the picture: its stream needs the track.
    if (snd && !this.captured?.getAudioTracks().some((t) => t === snd)) {
      const c = this.capturedFrom ?? this.opts.canvas();
      if (c) this.rebuildStream(c);
    }
    if (!this.heard) {
      this.heard = !!this.player;
      if (this.heard) this.opts.onSound?.();
    }
    this.player?.push(ulaw);
  }

  /** The canvas as a video track plus the sound, for the <video> element (null when the browser can't capture a canvas). */
  stream(): MediaStream | null {
    return this.captured;
  }

  private rebuildStream(c: HTMLCanvasElement): void {
    const tracks: MediaStreamTrack[] = [];
    let video: MediaStreamTrack | null = null;
    if (this.capturedFrom === c) video = this.captured?.getVideoTracks()[0] ?? null;
    else {
      this.captured?.getVideoTracks().forEach((t) => t.stop());
      try {
        video = typeof c.captureStream === 'function' ? c.captureStream().getVideoTracks()[0] ?? null : null;
      } catch {
        video = null;
      }
      this.capturedFrom = c;
    }
    if (video) tracks.push(video);
    const snd = this.player?.track;
    if (snd) tracks.push(snd);
    this.captured = tracks.length ? new MediaStream(tracks) : null;
    this.opts.onStream?.(this.captured);
  }

  /** A different camera, or the relay was dropped: start clean (the next picture starts on a key frame). */
  reset(): void {
    this.closeDecoder();
    this.waitKey = true;
    this.last = null;
    this.acked = null;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    this.needKey = false;
    this.jpegSeq.drawn = this.jpegSeq.next;
    this.codec = null;
    this.heard = false;
    this.player?.reset();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    this.closeDecoder();
    this.player?.close();
    this.player = undefined;
    this.captured?.getVideoTracks().forEach((t) => t.stop());
    this.captured = null;
    this.capturedFrom = null;
  }
}
