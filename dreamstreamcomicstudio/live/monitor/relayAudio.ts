/**
 * Sound for the relay picture: the nursery's microphone as G.711 μ-law at
 * 8 kHz (64 kbit/s, telephone quality — plenty to hear a baby stir), carried
 * inside the video messages so it costs no extra billed messages.
 *
 *  - Camera: `SoundPacker` resamples the sound engine's microphone tap to
 *    8 kHz (band-limited, StreamResampler) and μ-law encodes it; the relay
 *    encoder takes what's pending with each frame.
 *  - Viewer: `RelaySoundPlayer` decodes and plays through an AudioWorklet
 *    with a ~300 ms jitter buffer (`createJitter`: starts once 300 ms are
 *    buffered, nudges its speed ±3 % to hold that, re-buffers after a gap,
 *    skips ahead if it falls half a second behind). Its output is a MediaStream
 *    track, played by the watch screen's <video> element — so the Listen
 *    button, picture-in-picture and the iPhone's silent switch behave exactly
 *    as they do for the direct (P2P) sound.
 *
 * The pure parts (μ-law, the jitter kernel) are unit-tested; the kernel's
 * source is also what runs inside the worklet (createJitter.toString()).
 */

import { StreamResampler } from './resample';

export const SOUND_RATE = 8000;
/** The viewer's jitter buffer. */
export const JITTER_MS = 300;
/** Never hold more than this much unsent sound on the camera (older sound is dropped). */
const MAX_PENDING = SOUND_RATE;

/* --------------------------------------------------------------- μ-law */

const BIAS = 0x84;
const CLIP = 32635;

/** One sample (-1…1) → a μ-law byte (ITU-T G.711). */
export function muLawEncode(x: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

const DECODE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const exp = (u >> 4) & 7;
    const mant = u & 0x0f;
    const mag = (((mant << 3) + BIAS) << exp) - BIAS;
    t[i] = (u & 0x80 ? -mag : mag) / 32768;
  }
  return t;
})();

export function muLawDecode(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = DECODE[bytes[i]];
  return out;
}

export function muLawEncodeAll(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = muLawEncode(x[i]);
  return out;
}

/* ------------------------------------------------------- camera: packer */

/** Microphone chunks in, μ-law 8 kHz out (whatever has piled up since the last take). */
export class SoundPacker {
  private resampler: StreamResampler | null = null;
  private chunks: Uint8Array[] = [];
  private n = 0;

  push(pcm: Float32Array, rate: number): void {
    if (!this.resampler || this.resampler.inRate !== rate) this.resampler = new StreamResampler(rate, SOUND_RATE);
    const x = this.resampler.push(pcm);
    if (!x.length) return;
    this.chunks.push(muLawEncodeAll(x));
    this.n += x.length;
    // Late sound is worse than none: keep the newest second at most.
    while (this.n > MAX_PENDING && this.chunks.length > 1) this.n -= this.chunks.shift()!.length;
  }

  /** Milliseconds of sound waiting to go out. */
  get pendingMs(): number {
    return (this.n / SOUND_RATE) * 1000;
  }

  /** Everything pending (null when there's nothing). */
  take(): Uint8Array | null {
    if (!this.n) return null;
    const out = new Uint8Array(this.n);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.n = 0;
    return out;
  }

  /** Forget what's pending (privacy pause: nothing captured then is sent later). */
  clear(): void {
    this.chunks = [];
    this.n = 0;
  }
}

/* -------------------------------------------------- viewer: jitter kernel */

export interface JitterStats {
  /** Sound buffered right now, ms. */
  ms: number;
  playing: boolean;
  /** Times it ran dry and re-buffered. */
  underruns: number;
}

export interface Jitter {
  push(x: Float32Array): void;
  /** Fill one output block (at the output rate). */
  pull(out: Float32Array): void;
  stats(): JitterStats;
  reset(): void;
}

/**
 * The jitter buffer + resampler that runs in the audio thread. Self-contained
 * (no imports, no outer variables): its source is copied into the worklet.
 * `inRate` samples in (8 kHz), `outRate` out (the AudioContext's rate), linear
 * interpolation with a fractional read position — the speed nudges are just a
 * slightly longer or shorter step.
 */
export function createJitter(outRate: number, inRate: number, targetMs: number): Jitter {
  const cap = inRate * 4;
  const ring = new Float32Array(cap);
  const target = Math.round((inRate * targetMs) / 1000);
  const high = target + Math.round(inRate * 0.15);
  const low = Math.max(1, target - Math.round(inRate * 0.15));
  const behind = target + Math.round(inRate * 0.5);
  const base = inRate / outRate;
  let w = 0;
  let r = 0;
  let playing = false;
  let speed = 1;
  let underruns = 0;
  let fade = 0;
  const FADE = 64;
  return {
    push(x) {
      for (let i = 0; i < x.length; i++) {
        ring[w % cap] = x[i];
        w++;
      }
      if (w - r > cap) r = w - cap;
    },
    pull(out) {
      let n = w - r;
      if (!playing) {
        if (n < target) {
          out.fill(0);
          return;
        }
        playing = true;
        fade = 0;
      }
      if (n > behind) {
        // Half a second behind (a burst after a stall): jump to the newest sound.
        r = w - target;
        n = target;
      }
      if (speed === 1 && n > high) speed = 1.03;
      else if (speed === 1 && n < low) speed = 0.97;
      else if ((speed > 1 && n <= target) || (speed < 1 && n >= target)) speed = 1;
      const step = base * speed;
      for (let i = 0; i < out.length; i++) {
        if (w - r < 2) {
          // Ran dry: silence, then wait for the buffer to fill again.
          out.fill(0, i);
          playing = false;
          underruns++;
          return;
        }
        const i0 = Math.floor(r);
        const f = r - i0;
        const a = ring[i0 % cap];
        const b = ring[(i0 + 1) % cap];
        const g = fade < FADE ? ++fade / FADE : 1;
        out[i] = (a + (b - a) * f) * g;
        r += step;
      }
    },
    stats() {
      return { ms: Math.round(((w - r) / inRate) * 1000), playing, underruns };
    },
    reset() {
      w = 0;
      r = 0;
      playing = false;
      speed = 1;
    },
  };
}

export function relayPlayerSource(): string {
  return `const createJitter = ${createJitter.toString()};
class DsRelayPlay extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.j = createJitter(sampleRate, o.inRate, o.targetMs);
    this.n = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) this.j.push(d);
      else if (d && d.t === 'reset') this.j.reset();
    };
  }
  process(inputs, outputs) {
    const o = outputs[0];
    if (o && o[0]) {
      this.j.pull(o[0]);
      for (let c = 1; c < o.length; c++) o[c].set(o[0]);
    }
    if (++this.n % 200 === 0) this.port.postMessage({ t: 'st', s: this.j.stats() });
    return true;
  }
}
registerProcessor('ds-relay-play', DsRelayPlay);`;
}

/* ------------------------------------------------------- viewer: player */

type Ctx = typeof AudioContext;
const audioCtor = (): Ctx | null =>
  typeof window === 'undefined' ? null : window.AudioContext || (window as unknown as { webkitAudioContext?: Ctx }).webkitAudioContext || null;

/** This browser can play relay sound (AudioWorklet + a MediaStream output). */
export function canPlayRelaySound(): boolean {
  const C = audioCtor();
  return !!C && typeof AudioWorkletNode !== 'undefined' && 'audioWorklet' in C.prototype && 'createMediaStreamDestination' in C.prototype;
}

export class RelaySoundPlayer {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode;
  private queue: Float32Array[] = [];
  private closed = false;
  /** Latest jitter-buffer reading from the audio thread. */
  stats: JitterStats = { ms: 0, playing: false, underruns: 0 };
  readonly ready: Promise<boolean>;

  private constructor(C: Ctx, onState?: () => void) {
    this.ctx = new C();
    // Started (a tap), or stopped (a call, Siri, the lock screen): the screen shows which.
    if (onState) {
      try {
        this.ctx.addEventListener('statechange', () => {
          if (!this.closed) onState();
        });
      } catch { /* no state events: the screen polls */ }
    }
    this.dest = this.ctx.createMediaStreamDestination();
    this.ready = this.init();
  }

  /**
   * Null when this browser can't (relay sound is then simply absent, as before).
   * Make it inside a tap where possible: iPhones only start sound from one.
   */
  static create(onState?: () => void): RelaySoundPlayer | null {
    const C = audioCtor();
    if (!C || !canPlayRelaySound()) return null;
    try {
      return new RelaySoundPlayer(C, onState);
    } catch {
      return null;
    }
  }

  private async init(): Promise<boolean> {
    try {
      const url = URL.createObjectURL(new Blob([relayPlayerSource()], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (this.closed) return false;
      const node = new AudioWorkletNode(this.ctx, 'ds-relay-play', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { inRate: SOUND_RATE, targetMs: JITTER_MS },
      });
      node.port.onmessage = (e) => {
        const m = e.data as { t: string; s?: JitterStats };
        if (m.t === 'st' && m.s) this.stats = m.s;
      };
      // Linear interpolation leaves images above 4 kHz: a gentle low-pass removes them.
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3600;
      lp.Q.value = 0.7;
      node.connect(lp).connect(this.dest);
      this.node = node;
      for (const q of this.queue) node.port.postMessage(q, [q.buffer]);
      this.queue = [];
      void this.resume();
      return true;
    } catch {
      return false;
    }
  }

  /** The sound as a track for the <video> element. */
  get track(): MediaStreamTrack | null {
    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  push(ulaw: Uint8Array): void {
    // Until a tap starts the sound (phones), nothing plays: don't queue a whole night of it.
    if (this.closed || !ulaw.length || this.ctx.state !== 'running') return;
    const pcm = muLawDecode(ulaw);
    if (this.node) this.node.port.postMessage(pcm, [pcm.buffer]);
    else if (this.queue.length < 50) this.queue.push(pcm);
  }

  /** Start (or restart after the phone suspended it) — call from a tap where possible. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running' && !this.closed) await this.ctx.resume().catch(() => undefined);
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Start over (a different camera, or after a long gap). */
  reset(): void {
    this.queue = [];
    this.node?.port.postMessage({ t: 'reset' });
  }

  close(): void {
    this.closed = true;
    this.node?.disconnect();
    this.track?.stop();
    void this.ctx.close().catch(() => undefined);
  }
}
