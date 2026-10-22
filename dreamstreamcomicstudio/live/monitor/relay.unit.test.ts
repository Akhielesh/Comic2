// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseCodec, encoderConfig, NO_WANT, probeDecoders, probeEncoders, readWant, RelayDecoder, RelayEncoder, RelayRate, relaySize, resetProbe, soundControls, watchersNote, type RelayWant } from './relay';
import { pack, unpack, type RelayCodec } from './relayWire';

/* ------------------------------------------------------------ fakes */

let supported: Record<string, boolean>;
let encoders: FakeEncoder[];
let decoders: FakeDecoder[];
let canvases: FakeCanvas[];

class FakeChunk {
  constructor(readonly type: 'key' | 'delta', readonly timestamp: number, readonly byteLength = 1200) {}
  copyTo(dst: Uint8Array) {
    dst.fill(this.type === 'key' ? 1 : 2);
  }
}

class FakeEncoder {
  state = 'unconfigured';
  encodeQueueSize = 0;
  config: VideoEncoderConfig | null = null;
  frames: { key: boolean; ts: number }[] = [];
  /** Size of the next chunks (bytes); key frames `keySize` when set. */
  size = 1200;
  keySize: number | null = null;
  constructor(private init: { output: (c: FakeChunk) => void; error: (e: unknown) => void }) {
    encoders.push(this);
  }
  configure(c: VideoEncoderConfig) {
    this.config = c;
    this.state = 'configured';
  }
  /** Every encode errors (a broken hardware encoder) for these codecs. */
  static failing = new Set<string>();
  encode(f: { timestamp: number }, o?: { keyFrame?: boolean }) {
    this.frames.push({ key: !!o?.keyFrame, ts: f.timestamp });
    if (FakeEncoder.failing.has(this.config?.codec ?? '')) return this.init.error(new Error('encoder died'));
    this.init.output(new FakeChunk(o?.keyFrame ? 'key' : 'delta', f.timestamp, o?.keyFrame ? this.keySize ?? this.size : this.size));
  }
  fail() {
    this.init.error(new Error('boom'));
  }
  close() {
    this.state = 'closed';
  }
  static async isConfigSupported(c: { codec: string }) {
    return { supported: !!supported[c.codec], config: c };
  }
}

class FakeFrame {
  closed = false;
  constructor(readonly src: unknown, readonly init: { timestamp: number }) {}
  get timestamp() {
    return this.init.timestamp;
  }
  close() {
    this.closed = true;
  }
}

class FakeCanvas {
  draws = 0;
  constructor(public width: number, public height: number) {
    canvases.push(this);
  }
  getContext() {
    return { drawImage: () => void this.draws++ };
  }
  async convertToBlob() {
    return new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 9, 9)], { type: 'image/jpeg' });
  }
}

class FakeDecoder {
  state = 'unconfigured';
  decodeQueueSize = 0;
  config: { codec: string } | null = null;
  chunks: { type: string; timestamp: number }[] = [];
  frames: { closed: boolean; close: () => void; displayWidth: number; displayHeight: number }[] = [];
  constructor(private init: { output: (f: unknown) => void; error: (e: unknown) => void }) {
    decoders.push(this);
  }
  configure(c: { codec: string }) {
    this.config = c;
    this.state = 'configured';
  }
  decode(c: { type: string; timestamp: number }) {
    this.chunks.push(c);
    const f = {
      closed: false,
      displayWidth: 640,
      displayHeight: 360,
      close() {
        this.closed = true;
      },
    };
    this.frames.push(f);
    this.init.output(f);
  }
  fail() {
    this.init.error(new Error('bad data'));
  }
  close() {
    this.state = 'closed';
  }
  static async isConfigSupported(c: { codec: string }) {
    return { supported: !!supported[c.codec], config: c };
  }
}

class FakeEncodedChunk {
  constructor(readonly init: { type: string; timestamp: number; data: Uint8Array }) {}
  get type() {
    return this.init.type;
  }
  get timestamp() {
    return this.init.timestamp;
  }
}

beforeEach(() => {
  supported = { 'avc1.42E01E': true, vp8: true, 'vp09.00.10.08': true };
  encoders = [];
  decoders = [];
  canvases = [];
  vi.stubGlobal('VideoEncoder', FakeEncoder);
  vi.stubGlobal('VideoFrame', FakeFrame);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeEncodedChunk);
  resetProbe();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const want = (w: Partial<RelayWant>): RelayWant => ({ ...NO_WANT, ...w });

/* ------------------------------------------------------- pure parts */

describe('relay picture: sizes, codecs, rates', () => {
  it('keeps the camera’s shape at 640 on the long side, never upscaled, even sizes', () => {
    expect(relaySize(1280, 720)).toEqual({ w: 640, h: 360 });
    expect(relaySize(720, 1280)).toEqual({ w: 360, h: 640 }); // a phone held upright
    expect(relaySize(1440, 1080)).toEqual({ w: 640, h: 480 });
    expect(relaySize(320, 240)).toEqual({ w: 320, h: 240 });
    expect(relaySize(1279, 721)).toEqual({ w: 640, h: 360 });
    expect(relaySize(0, 0)).toEqual({ w: 640, h: 360 });
  });

  it('configures realtime encoding, H.264 in Annex B (parameter sets in every key frame)', () => {
    expect(encoderConfig('avc', 640, 360)).toMatchObject({ codec: 'avc1.42E01E', width: 640, height: 360, latencyMode: 'realtime', avc: { format: 'annexb' }, bitrate: 450_000, framerate: 15 });
    expect(encoderConfig('vp8', 640, 360)).not.toHaveProperty('avc');
  });

  it('probes H.264 → VP8 → VP9 with isConfigSupported (nothing → JPEG)', async () => {
    supported['avc1.42E01E'] = false;
    expect(await probeEncoders()).toEqual(['vp8', 'vp9']);
    vi.stubGlobal('VideoEncoder', undefined);
    expect(await probeEncoders()).toEqual([]);
    supported.vp8 = false;
    expect(await probeDecoders()).toEqual(['vp9']);
  });

  it('picks the codec most relay viewers decode, keeping the current one unless another reaches more', () => {
    const can: RelayCodec[] = ['avc', 'vp8', 'vp9'];
    expect(chooseCodec(can, want({ n: 2, avc: 2, vp8: 2 }), null)).toBe('avc');
    expect(chooseCodec(can, want({ n: 3, avc: 1, vp8: 3 }), null)).toBe('vp8');
    expect(chooseCodec(['vp8'], want({ n: 1, avc: 1 }), null)).toBeNull(); // nobody decodes what we encode → JPEG
    expect(chooseCodec(can, want({ n: 2, avc: 2, vp8: 2 }), 'vp8')).toBe('vp8'); // no flapping on a tie
    expect(chooseCodec(can, want({ n: 3, avc: 3, vp8: 2 }), 'vp8')).toBe('avc');
  });

  it('reads relay_want from this room and from an older one (n only → everyone JPEG)', () => {
    expect(readWant({ n: 3, avc: 2, vp8: 3, vp9: 0, jpeg: 0 })).toEqual({ n: 3, avc: 2, vp8: 3, vp9: 0, jpeg: 0 });
    expect(readWant({ n: 2 })).toEqual({ n: 2, avc: 0, vp8: 0, vp9: 0, jpeg: 2 });
    expect(readWant({ n: -4, avc: 'x' })).toEqual({ n: 0, avc: 0, vp8: 0, vp9: 0, jpeg: 0 });
  });

  it('steps the bitrate down on a backlog (at most every 3 s) and back up after 20 s clear', () => {
    const r = new RelayRate();
    expect(r.onBacklog(0)).toBe(true);
    expect([r.bps, r.fps]).toEqual([300_000, 12]);
    expect(r.onBacklog(1000)).toBe(false);
    expect(r.onBacklog(4000)).toBe(true);
    expect(r.onBacklog(9000)).toBe(false); // floor
    expect(r.onClear(20_000)).toBe(false);
    expect(r.onClear(29_100)).toBe(true);
    expect(r.rung).toBe(1);
  });
});

/* ------------------------------------------------------------ camera */

describe('RelayEncoder (camera)', () => {
  function rig(opts: { buffered?: number; paused?: boolean } = {}) {
    const sent: ArrayBuffer[] = [];
    const state = { now: 1_000_000, buffered: opts.buffered ?? 0, paused: opts.paused ?? false, accept: true, open: true };
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    const enc = new RelayEncoder({
      source: () => video,
      send: (b) => {
        if (!state.accept) return false;
        sent.push(b);
        return true;
      },
      buffered: () => state.buffered,
      paused: () => state.paused,
      open: () => state.open,
      now: () => state.now,
    });
    const frames = () => sent.map((b) => unpack(b)!);
    const step = (ms = 66) => {
      state.now += ms;
      enc.step();
    };
    return { enc, sent, state, frames, step, video };
  }

  it('encodes one stream in the codec its viewers decode, starting on a key frame, one every 2 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step } = rig();
    enc.setWant(want({ n: 2, avc: 1, vp8: 2 }));
    await vi.advanceTimersByTimeAsync(0); // the encoder probe
    for (let i = 0; i < 65; i++) step(); // ~4.3 s at 15 fps
    const f = frames();
    expect(f.every((m) => m.kind === 'video' && m.codec === 'vp8')).toBe(true);
    expect(encoders.at(-1)!.config).toMatchObject({ codec: 'vp8', width: 640, height: 360, latencyMode: 'realtime' });
    expect(f[0].key).toBe(true);
    const keys = f.map((m, i) => (m.key ? i : -1)).filter((i) => i >= 0);
    expect(keys).toEqual([0, 31, 62]); // the first frame, then every 2 s
    // Sequence numbers count up by one per message.
    expect(f.map((m) => m.seq)).toEqual(f.map((_, i) => i));
    enc.stop();
  });

  it('sends a key frame when the room asks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step } = rig();
    enc.setWant(want({ n: 1, avc: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    step();
    step();
    enc.requestKey();
    step();
    expect(frames().map((m) => m.key)).toEqual([true, false, true]);
    enc.stop();
  });

  it('skips frames while the socket is backed up (64 KB) and restarts on a key frame at a lower rate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step, state } = rig();
    enc.setWant(want({ n: 1, avc: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    step();
    step();
    state.buffered = 70 * 1024;
    step();
    step();
    expect(frames()).toHaveLength(2);
    state.buffered = 1000;
    step();
    const f = frames();
    expect(f).toHaveLength(3);
    expect(f[2].key).toBe(true);
    expect(encoders.at(-1)!.config).toMatchObject({ bitrate: 300_000, framerate: 12 });
    enc.stop();
  });

  it('a frame that could not be sent holds back every frame after it until a key frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step, state } = rig();
    enc.setWant(want({ n: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    step();
    state.accept = false;
    step(); // lost
    state.accept = true;
    step(); // the encoder was told: this one is a key frame
    step();
    expect(frames().map((m) => m.key)).toEqual([true, true, false]);
    enc.stop();
  });

  it('bundles the sound captured since the last frame; sends it alone when no frame went out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step, state } = rig();
    enc.setWant(want({ n: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    const mic = () => enc.pushSound(new Float32Array(3200).fill(0.2), 48_000); // ~67 ms
    mic();
    step();
    let f = frames();
    expect(f[0].audio!.length).toBeGreaterThan(400);
    // The uplink backs up: no frames, but the nursery is still heard.
    state.buffered = 100 * 1024;
    for (let i = 0; i < 5; i++) {
      mic();
      step();
    }
    f = frames();
    expect(f.slice(1).some((m) => m.kind === 'audio' && m.codec === 'vp8')).toBe(true);
    expect(f.slice(1).every((m) => m.kind === 'audio')).toBe(true);
    enc.stop();
  });

  it('privacy pause: nothing at all goes out, and sound from the pause is never sent later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, sent, step, state } = rig();
    enc.setWant(want({ n: 2, vp8: 1, jpeg: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    state.paused = true;
    enc.pushSound(new Float32Array(48_000).fill(0.3), 48_000);
    for (let i = 0; i < 30; i++) step();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
    state.paused = false;
    step();
    await vi.advanceTimersByTimeAsync(0);
    const f = sent.map((b) => unpack(b)!);
    expect(f[0]).toMatchObject({ kind: 'video', key: true, audio: null });
    enc.stop();
  });

  it('JPEG for viewers who can’t decode the video, alongside it; JPEG + sound when the phone has no encoder', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = rig();
    a.enc.setWant(want({ n: 2, avc: 1, jpeg: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      a.step();
      await vi.advanceTimersByTimeAsync(0);
    }
    const kinds = new Set(a.frames().map((m) => m.kind));
    expect([...kinds].sort()).toEqual(['jpeg', 'video']);
    expect(a.enc.mode).toBe('avc');
    a.enc.stop();

    vi.stubGlobal('VideoEncoder', undefined);
    const b = rig();
    b.enc.setWant(want({ n: 1, avc: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      b.enc.pushSound(new Float32Array(3200).fill(0.2), 48_000);
      b.step();
      await vi.advanceTimersByTimeAsync(0);
    }
    const f = b.frames();
    expect(b.enc.mode).toBe('jpeg');
    expect(f.some((m) => m.kind === 'jpeg')).toBe(true);
    expect(f.some((m) => m.kind === 'audio' && m.codec === null)).toBe(true);
    expect(f.some((m) => m.kind === 'video')).toBe(false);
    b.enc.stop();
  });

  it('an encoder that keeps failing is given up for the next codec', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step } = rig();
    FakeEncoder.failing.add('avc1.42E01E');
    enc.setWant(want({ n: 1, avc: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) step();
    expect(frames()).toHaveLength(0);
    step();
    expect(frames().map((m) => [m.codec, m.key])).toEqual([['vp8', true]]);
    expect(enc.mode).toBe('vp8');
    FakeEncoder.failing.clear();
    enc.stop();
  });

  it('leaving a backlog carries on with the next frame — no key frame to refill the socket — once it drains below 32 KB', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step, state } = rig();
    enc.setWant(want({ n: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    step();
    step();
    state.buffered = 70 * 1024;
    step(); // the first backlog steps the rate down: a new encoder, whose first frame is a key frame
    state.buffered = 1000;
    step();
    step();
    expect(frames().map((m) => m.key)).toEqual([true, false, true, false]);
    // Backed up again within 3 s: same rate, same encoder.
    state.buffered = 70 * 1024;
    step();
    state.buffered = 48 * 1024; // below 64 KB, but not yet below 32 KB: still skipping
    step();
    step();
    expect(frames()).toHaveLength(4);
    state.buffered = 20 * 1024;
    step();
    step();
    // The skipped frames never reached the encoder: the next one codes against the last one sent.
    expect(frames().map((m) => m.key)).toEqual([true, false, true, false, false, false]);
    expect(encoders).toHaveLength(2);
    enc.stop();
  });

  it('a tight uplink keeps a moving picture (deltas), not key frames at a frame or two a second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sent: { at: number; key: boolean }[] = [];
    const s = { now: 1_000_000, buffered: 90 * 1024 };
    // 288 kbit/s: 2 KB deltas at 12 fps and a 20 KB key frame every 2 s fit; a key frame on every recovery doesn't.
    const UPLINK = 36; // bytes per ms
    vi.stubGlobal(
      'VideoEncoder',
      class extends FakeEncoder {
        size = 2000;
        keySize = 20_000;
      },
    );
    const video = { readyState: 4, videoWidth: 1280, videoHeight: 720 } as HTMLVideoElement;
    const enc = new RelayEncoder({
      source: () => video,
      send: (b) => {
        s.buffered += b.byteLength;
        const m = unpack(b)!;
        if (m.kind === 'video') sent.push({ at: s.now, key: m.key });
        return true;
      },
      buffered: () => s.buffered,
      paused: () => false,
      now: () => s.now,
    });
    enc.setWant(want({ n: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    let last = s.now;
    for (let i = 0; i < 400; i++) {
      s.now += Math.round(1000 / enc.rate.fps);
      s.buffered = Math.max(0, s.buffered - (s.now - last) * UPLINK);
      last = s.now;
      enc.step();
    }
    const tail = sent.filter((f) => f.at > s.now - 20_000);
    const keys = tail.filter((f) => f.key).length;
    expect(tail.length / 20).toBeGreaterThanOrEqual(8); // frames a second
    expect(keys / tail.length).toBeLessThan(0.2);
    enc.stop();
  });

  it('the JPEG pace steps down while the socket is backed up (it never saw its own 80 KB mark: frames stop at 64 KB)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, step, state } = rig();
    enc.setWant(want({ n: 1, jpeg: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(enc.jpegFps).toBe(3);
    state.buffered = 70 * 1024;
    for (let i = 0; i < 20; i++) step();
    expect(enc.jpegFps).toBe(2);
    enc.stop();
  });

  it('encodes nothing while the room socket is down (every send would fail), and starts again on a key frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, frames, step, state } = rig();
    enc.setWant(want({ n: 2, vp8: 1, jpeg: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    step();
    step();
    await vi.advanceTimersByTimeAsync(0);
    const encoded = encoders.at(-1)!.frames.length;
    const drawn = canvases[0].draws;
    const n = frames().length;
    state.open = false;
    state.accept = false;
    for (let i = 0; i < 45; i++) {
      enc.pushSound(new Float32Array(3200).fill(0.2), 48_000);
      step();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(encoders.at(-1)!.frames.length).toBe(encoded); // no encoding (let alone key frames)…
    expect(canvases[0].draws).toBe(drawn); // …no drawing, no JPEG
    state.open = true;
    state.accept = true;
    step();
    const back = frames().slice(n).filter((m) => m.kind === 'video');
    expect(back[0]).toMatchObject({ key: true, audio: null }); // nothing captured during the outage goes out
    enc.stop();
  });

  it('stops when nobody is left on the relay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { enc, sent } = rig();
    enc.setWant(want({ n: 1, vp8: 1 }));
    await vi.advanceTimersByTimeAsync(200);
    const n = sent.length;
    expect(n).toBeGreaterThan(0);
    enc.setWant(NO_WANT);
    expect(enc.active).toBe(false);
    expect(encoders.at(-1)!.state).toBe('closed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBe(n);
  });
});

/* ------------------------------------------------------------ viewer */

describe('RelayDecoder (viewer)', () => {
  function rig() {
    const acks: { s: number; k?: 1 }[] = [];
    const pictures: number[] = [];
    let fallback = 0;
    const t = { now: 5_000 };
    const canvas = {
      width: 0,
      height: 0,
      draws: 0,
      getContext() {
        return { drawImage: () => void canvas.draws++ };
      },
    };
    const dec = new RelayDecoder({
      canvas: () => canvas as unknown as HTMLCanvasElement,
      onPicture: (now) => pictures.push(now),
      onAck: (a) => acks.push(a),
      onFallback: () => void fallback++,
      now: () => t.now,
    });
    let seq = 100;
    const video = (key: boolean, codec: RelayCodec = 'vp8') => pack({ kind: 'video', key, seq: seq++, ts: seq * 66, codec, body: Uint8Array.of(1, 2, 3) });
    return { dec, acks, pictures, canvas, t, video, fallbacks: () => fallback };
  }

  it('waits for a key frame (asking for one), then decodes into the canvas and closes every frame', () => {
    const { dec, acks, pictures, canvas, t, video } = rig();
    dec.handle(video(false));
    expect(decoders).toHaveLength(0);
    expect(acks).toEqual([{ s: 100, k: 1 }]);
    t.now += 100;
    dec.handle(video(true));
    t.now += 66;
    dec.handle(video(false));
    const d = decoders[0];
    expect(d.config).toEqual({ codec: 'vp8', optimizeForLatency: true });
    expect(d.chunks.map((c) => c.type)).toEqual(['key', 'delta']);
    expect(d.frames.every((f) => f.closed)).toBe(true);
    expect([canvas.width, canvas.height, canvas.draws]).toEqual([640, 360, 2]);
    expect(pictures).toHaveLength(2);
    expect(dec.codec).toBe('vp8');
  });

  it('acknowledges what arrived every 500 ms', () => {
    const { dec, acks, t, video } = rig();
    dec.handle(video(true));
    for (let i = 0; i < 16; i++) {
      t.now += 66;
      dec.handle(video(false));
    }
    expect(acks.map((a) => a.s)).toEqual([100, 108, 116]);
    expect(acks.every((a) => !a.k)).toBe(true);
  });

  it('acknowledges the last message of a burst too, a moment later (or the room holds it back for good)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { dec, acks, t, video } = rig();
    dec.handle(video(true));
    // A stall ends: everything held meanwhile arrives at once.
    for (let i = 0; i < 20; i++) dec.handle(video(false));
    expect(acks.map((a) => a.s)).toEqual([100]);
    t.now += 499;
    vi.advanceTimersByTime(499);
    expect(acks).toHaveLength(1);
    t.now += 1;
    vi.advanceTimersByTime(1);
    expect(acks.map((a) => a.s)).toEqual([100, 120]);
    // Nothing newer: nothing more to say.
    t.now += 3000;
    vi.advanceTimersByTime(3000);
    expect(acks).toHaveLength(2);
    // Steady messages: still one acknowledgement per 500 ms, the newest each time.
    for (let i = 0; i < 15; i++) {
      t.now += 66;
      vi.advanceTimersByTime(66);
      dec.handle(video(false));
    }
    t.now += 500;
    vi.advanceTimersByTime(500);
    expect(acks.slice(2).map((a) => a.s)).toEqual([121, 128, 135]);
    dec.close();
  });

  it('a decoder error closes it, asks for a key frame, and three in a row fall back to still pictures', () => {
    const { dec, acks, t, video, fallbacks } = rig();
    dec.handle(video(true));
    decoders[0].fail();
    expect(decoders[0].state).toBe('closed');
    t.now += 1500;
    dec.handle(video(false)); // a delta: dropped, a key is asked for
    expect(acks.at(-1)).toMatchObject({ k: 1 });
    dec.handle(video(true));
    expect(decoders).toHaveLength(2);
    decoders[1].fail();
    dec.handle(video(true));
    decoders[2].fail();
    expect(fallbacks()).toBe(1);
  });

  it('a different codec starts a new decoder at its key frame', () => {
    const { dec, video } = rig();
    dec.handle(video(true, 'vp8'));
    dec.handle(video(false, 'avc'));
    expect(decoders).toHaveLength(1);
    dec.handle(video(true, 'avc'));
    expect(decoders).toHaveLength(2);
    expect(decoders[1].config!.codec).toBe('avc1.42E01E');
    expect(decoders[0].state).toBe('closed');
  });

  it('a device that falls behind starts over at the next key frame instead of drifting', () => {
    const { dec, video } = rig();
    dec.handle(video(true));
    decoders[0].decodeQueueSize = 9;
    dec.handle(video(false));
    expect(decoders[0].chunks).toHaveLength(1);
    dec.handle(video(true));
    expect(decoders).toHaveLength(2);
    expect(decoders[1].chunks.map((c) => c.type)).toEqual(['key']);
  });

  it('draws JPEGs (framed or bare, from older cameras) in order', async () => {
    const bmp = (w: number) => ({ width: w, height: w / 2, close: vi.fn() });
    const order: number[] = [];
    let n = 0;
    vi.stubGlobal('createImageBitmap', async () => {
      const w = [640, 320][n++];
      // The first decode finishes last.
      await new Promise((r) => setTimeout(r, w === 640 ? 20 : 0));
      order.push(w);
      return bmp(w);
    });
    const { dec, canvas, pictures } = rig();
    dec.handle(pack({ kind: 'jpeg', seq: 1, ts: 1, body: Uint8Array.of(0xff, 0xd8, 0xff, 1) }));
    dec.handle(Uint8Array.of(0xff, 0xd8, 0xff, 2).buffer);
    await new Promise((r) => setTimeout(r, 40));
    expect(order).toEqual([320, 640]);
    // The older frame, decoded late, never covers the newer one.
    expect(canvas.width).toBe(320);
    expect(pictures).toHaveLength(1);
    expect(dec.codec).toBe('jpeg');
  });

  it('keeps Blob messages in order (the socket hands over Blobs)', async () => {
    const { dec, video } = rig();
    const blobs = [video(true), video(false), video(false)].map((b) => new Blob([b]));
    for (const b of blobs) dec.push(b);
    await new Promise((r) => setTimeout(r, 10));
    expect(decoders[0].chunks.map((c) => c.type)).toEqual(['key', 'delta', 'delta']);
  });
});

/* ------------------------------------------------------ viewer: sound */

describe('RelayDecoder sound on phones (a context only starts inside a tap)', () => {
  let posted: unknown[];
  let ctxs: FakeAudioCtx[];
  class FakeAudioCtx {
    /** Like WebKit: resume() only starts it inside a tap. */
    static tap = false;
    state: string = 'suspended';
    private fns: (() => void)[] = [];
    constructor() {
      ctxs.push(this);
    }
    get audioWorklet() {
      return { addModule: async () => undefined };
    }
    async resume() {
      if (FakeAudioCtx.tap && this.state !== 'running') this.set('running');
    }
    async close() {
      this.state = 'closed';
    }
    addEventListener(_t: string, f: () => void) {
      this.fns.push(f);
    }
    /** A phone call, Siri or the lock screen. */
    set(state: string) {
      this.state = state;
      for (const f of this.fns) f();
    }
    createMediaStreamDestination() {
      const track = { kind: 'audio', stop() {} };
      return { stream: { getAudioTracks: () => [track] } };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect: (x: unknown) => x };
    }
  }
  class FakeWorkletNode {
    port = { postMessage: (m: unknown) => void posted.push(m), onmessage: null as unknown };
    connect(x: unknown) {
      return x;
    }
    disconnect() {}
  }
  class FakeMediaStream {
    constructor(readonly tracks: { kind: string }[]) {}
    getAudioTracks() {
      return this.tracks.filter((x) => x.kind === 'audio');
    }
    getVideoTracks() {
      return this.tracks.filter((x) => x.kind === 'video');
    }
  }
  beforeEach(() => {
    posted = [];
    ctxs = [];
    FakeAudioCtx.tap = false;
    vi.stubGlobal('window', { AudioContext: FakeAudioCtx });
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.stubGlobal('MediaStream', FakeMediaStream);
  });

  function rig() {
    let changes = 0;
    const streams: (MediaStream | null)[] = [];
    // A canvas that can't be captured (the <video> then gets the sound alone).
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) } as unknown as HTMLCanvasElement;
    const dec = new RelayDecoder({
      canvas: () => canvas,
      onPicture: () => undefined,
      onAck: () => undefined,
      onStream: (x) => streams.push(x),
      onSound: () => void changes++,
    });
    let seq = 1;
    const sound = () => dec.handle(pack({ kind: 'audio', seq: seq++, ts: seq * 100, codec: null, audio: new Uint8Array(400).fill(0x55) }));
    return { dec, sound, streams, changes: () => changes };
  }

  it('Listen tapped before the relay took over: the player is made and started in that tap, so relay sound plays when it comes', async () => {
    const { dec, sound } = rig();
    FakeAudioCtx.tap = true;
    dec.prepareSound(); // the Listen tap — still on the direct picture
    FakeAudioCtx.tap = false;
    await flush();
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0].state).toBe('running');
    // Later, from the socket (no tap): the relay's first sound.
    sound();
    sound();
    expect(posted.filter((m) => m instanceof Float32Array)).toHaveLength(2);
    expect(dec.hasSound).toBe(true);
    expect(dec.soundBlocked).toBe(false);
    dec.close();
  });

  it('relay sound that arrives outside a tap is reported blocked until a tap starts it (and again after a phone call)', async () => {
    const { dec, sound, streams, changes } = rig();
    sound();
    await flush();
    expect(dec.hasSound).toBe(true);
    expect(dec.soundBlocked).toBe(true); // arriving, not playing: the screen must not say "Sound on"
    expect(changes()).toBeGreaterThan(0);
    expect(streams.at(-1)?.getAudioTracks()).toHaveLength(1);
    const c = changes();
    FakeAudioCtx.tap = true;
    dec.resumeSound(); // a tap anywhere
    await flush();
    expect(dec.soundBlocked).toBe(false);
    expect(changes()).toBeGreaterThan(c);
    ctxs[0].set('interrupted');
    expect(dec.soundBlocked).toBe(true);
    dec.close();
  });

  it('the sound controls never say "Sound on" while relay sound waits for a tap', () => {
    expect(soundControls({ muted: false, hearable: true, relaySound: true, blocked: true })).toEqual({ on: false, tap: true });
    expect(soundControls({ muted: false, hearable: true, relaySound: true, blocked: false })).toEqual({ on: true, tap: false });
    expect(soundControls({ muted: true, hearable: true, relaySound: false, blocked: false })).toEqual({ on: false, tap: true });
    // The direct picture's sound plays through the <video>: a stale relay player doesn't matter.
    expect(soundControls({ muted: false, hearable: true, relaySound: false, blocked: true })).toEqual({ on: true, tap: false });
    expect(soundControls({ muted: true, hearable: false, relaySound: false, blocked: false })).toEqual({ on: false, tap: false });
  });
});

describe('camera: who gets the picture through the server', () => {
  it('counts viewers bridging while their direct picture connects (their picture passes through the server too)', () => {
    // Two viewers connecting: both on the instant picture — not listed as "on the relay", but relayed.
    expect(watchersNote({ viewers: 2, direct: 0, onRelay: 0, relayed: 2, jpeg: false })).toBe(' · connecting… · 2 through the server');
    expect(watchersNote({ viewers: 3, direct: 2, onRelay: 1, relayed: 1, jpeg: true })).toBe(' · 1 through the server (still pictures)');
    expect(watchersNote({ viewers: 2, direct: 2, onRelay: 0, relayed: 0, jpeg: false })).toBe('');
  });
});
