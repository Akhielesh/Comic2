/**
 * ProgramAudioMixer — the audio half of the program mixer.
 *
 * The compositor's canvas gives the program its video track; this gives it ONE
 * stable audio track that is the live mix of host mic + every on-air guest.
 * Sources connect/disconnect mid-stream without touching the MediaRecorder
 * (the destination track never changes — exactly like the canvas trick).
 *
 * Mix-minus: each guest also gets its own output — everyone EXCEPT that guest —
 * which rides back on the guest's peer link, so guests hear the host and each
 * other without hearing themselves (no echo, no feedback loop).
 *
 * Track-level toggles still work: a muted source track simply contributes
 * silence. Browsers may start an AudioContext suspended until a user gesture;
 * `primeAudioContext()` creates one inside the tap that started the session
 * (so "Go live now" is never silent on iOS) and `unlock()` resumes it on go-live.
 */

type Ctor = typeof AudioContext;

const audioCtor = (): Ctor | undefined =>
  typeof window === 'undefined'
    ? undefined
    : window.AudioContext || (window as { webkitAudioContext?: Ctor }).webkitAudioContext;

let primed: AudioContext | null = null;

/**
 * Create (or wake) an AudioContext from inside a user gesture — call it in the click
 * handler that starts a meeting or a live session. The studio adopts it, so audio is
 * already running when the program starts. Safe to call repeatedly; never throws.
 */
export function primeAudioContext(): void {
  try {
    if (!primed || primed.state === 'closed') {
      const Ctx = audioCtor();
      if (!Ctx) return;
      primed = new Ctx();
    }
    if (primed.state === 'suspended') void primed.resume().catch(() => undefined);
  } catch {
    primed = null;
  }
}

/** Hand the primed context over (once). Null when none was primed or it was closed. */
export function takePrimedAudioContext(): AudioContext | null {
  const ctx = primed;
  primed = null;
  return ctx && ctx.state !== 'closed' ? ctx : null;
}

/**
 * Which sources feed each guest's mix-minus: every source except the guest itself.
 * Pure, so the wiring rule is testable without WebAudio.
 */
export function mixMinusPlan(sources: string[], guests: string[]): Map<string, string[]> {
  const plan = new Map<string, string[]>();
  for (const g of guests) plan.set(g, sources.filter((s) => s !== g));
  return plan;
}

interface Source {
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  stream: MediaStream;
  trackId: string;
}

export class ProgramAudioMixer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private sources = new Map<string, Source>();
  private minus = new Map<string, MediaStreamAudioDestinationNode>();
  /** Live gain→mix-minus connections, as `${source}>${guest}`. */
  private wired = new Set<string>();
  private levelBuf = new Uint8Array(128);

  constructor(ctx?: AudioContext | null) {
    if (ctx && ctx.state !== 'closed') {
      this.ctx = ctx;
    } else {
      const Ctx = audioCtor();
      if (!Ctx) throw new Error('WebAudio unavailable');
      this.ctx = new Ctx();
    }
    this.dest = this.ctx.createMediaStreamDestination();
  }

  /** The mixed program audio track — hand this to the compositor's output. */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0];
  }

  /** True once the context is actually producing audio (not gesture-suspended). */
  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Resume a gesture-suspended context (call from a click handler). */
  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** Add (or replace) a named source. Only audio tracks are read. */
  addSource(id: string, stream: MediaStream, volume = 1): void {
    const audio = stream.getAudioTracks()[0];
    if (!audio) return;
    const prev = this.sources.get(id);
    if (prev && prev.stream === stream && prev.trackId === audio.id) return; // unchanged — keep the wiring (no click)
    this.removeSource(id);
    try {
      const node = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      // Analyser taps the post-gain signal — it powers speaking indicators
      // and active-speaker focus without touching the mix.
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      node.connect(gain).connect(this.dest);
      gain.connect(analyser);
      this.sources.set(id, { node, gain, analyser, stream, trackId: audio.id });
      this.rewire();
    } catch {
      /* stream ended between checks */
    }
  }

  removeSource(id: string): void {
    const s = this.sources.get(id);
    if (s) {
      try {
        s.node.disconnect();
        s.gain.disconnect();
        s.analyser.disconnect();
      } catch {
        /* already detached */
      }
      this.sources.delete(id);
      for (const key of Array.from(this.wired)) if (key.startsWith(`${id}>`)) this.wired.delete(key);
    }
  }

  /**
   * The mix-minus track for one guest — everyone but them. Created on first ask and kept
   * in step as people join and leave; `dropMinus` frees it.
   */
  minusTrack(guestId: string): MediaStreamTrack {
    let out = this.minus.get(guestId);
    if (!out) {
      out = this.ctx.createMediaStreamDestination();
      this.minus.set(guestId, out);
      this.rewire();
    }
    return out.stream.getAudioTracks()[0];
  }

  dropMinus(guestId: string): void {
    const out = this.minus.get(guestId);
    if (!out) return;
    for (const [id, s] of this.sources) {
      if (this.wired.delete(`${id}>${guestId}`)) {
        try {
          s.gain.disconnect(out);
        } catch {
          /* already detached */
        }
      }
    }
    this.minus.delete(guestId);
  }

  /** Bring every gain→mix-minus connection in line with `mixMinusPlan`. */
  private rewire(): void {
    const plan = mixMinusPlan(Array.from(this.sources.keys()), Array.from(this.minus.keys()));
    const want = new Set<string>();
    for (const [guest, srcs] of plan) for (const s of srcs) want.add(`${s}>${guest}`);
    for (const key of want) {
      if (this.wired.has(key)) continue;
      const [src, guest] = key.split('>');
      const s = this.sources.get(src);
      const out = this.minus.get(guest);
      if (!s || !out) continue;
      try {
        s.gain.connect(out);
        this.wired.add(key);
      } catch {
        /* node torn down mid-change */
      }
    }
    for (const key of Array.from(this.wired)) {
      if (want.has(key)) continue;
      const [src, guest] = key.split('>');
      try {
        const s = this.sources.get(src);
        const out = this.minus.get(guest);
        if (s && out) s.gain.disconnect(out);
      } catch {
        /* already detached */
      }
      this.wired.delete(key);
    }
  }

  /** Instantaneous RMS level (0..~1) per source — who is talking right now.
   *  Muted tracks read ~0, so mic toggles are respected automatically. */
  levels(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, s] of this.sources) {
      try {
        s.analyser.getByteTimeDomainData(this.levelBuf);
        let sum = 0;
        for (let i = 0; i < this.levelBuf.length; i++) {
          const v = (this.levelBuf[i] - 128) / 128;
          sum += v * v;
        }
        out.set(id, Math.sqrt(sum / this.levelBuf.length));
      } catch {
        out.set(id, 0);
      }
    }
    return out;
  }

  /** Ids of every wired source (the host's own mic is `host`). */
  ids(): string[] {
    return Array.from(this.sources.keys());
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  close(): void {
    for (const id of Array.from(this.minus.keys())) this.dropMinus(id);
    for (const id of Array.from(this.sources.keys())) this.removeSource(id);
    void this.ctx.close().catch(() => undefined);
  }
}
