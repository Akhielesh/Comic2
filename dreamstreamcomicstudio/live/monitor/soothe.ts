/**
 * Soothing sounds played by the camera phone in the nursery, started remotely
 * by a parent. Synthesized with WebAudio — no audio files to download.
 */

export type SootheKind = 'white' | 'pink' | 'brown' | 'shush' | 'heartbeat';

export const SOOTHE_OPTIONS: { id: SootheKind; label: string; sub: string }[] = [
  { id: 'shush', label: 'Shush', sub: 'Rhythmic “shhh” like a parent' },
  { id: 'white', label: 'White noise', sub: 'Bright, masks household sounds' },
  { id: 'pink', label: 'Rain', sub: 'Softer pink noise' },
  { id: 'brown', label: 'Ocean', sub: 'Deep brown noise' },
  { id: 'heartbeat', label: 'Heartbeat', sub: 'Slow, womb-like pulse' },
];

function noiseBuffer(ctx: AudioContext, kind: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

export class SoothePlayer {
  private ctx: AudioContext | null = null;
  private nodes: AudioNode[] = [];
  private out: GainNode | null = null;
  private stopTimer: number | undefined;
  private beat: number | undefined;
  private level = 0.4;
  private ceiling = 0.4;
  current: { kind: SootheKind; endsAt: number } | null = null;

  /** Call from a user gesture (Start camera) so iOS lets audio play later. */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
    }
    void this.ctx.resume().catch(() => undefined);
  }

  start(kind: SootheKind, minutes: number, volume = 0.4): void {
    this.unlock();
    const ctx = this.ctx;
    if (!ctx) return;
    this.stop(true);
    const out = ctx.createGain();
    this.level = this.ceiling = Math.max(0.05, Math.min(0.9, volume));
    out.gain.setValueAtTime(0, ctx.currentTime);
    out.gain.linearRampToValueAtTime(this.level, ctx.currentTime + 2.5);
    out.connect(ctx.destination);
    this.out = out;

    if (kind === 'heartbeat') {
      const thump = (at: number, strength: number) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(70, at);
        o.frequency.exponentialRampToValueAtTime(42, at + 0.18);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(strength, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + 0.3);
      };
      const schedule = () => {
        const t = ctx.currentTime + 0.05;
        thump(t, 0.9);
        thump(t + 0.32, 0.6);
      };
      schedule();
      this.beat = window.setInterval(schedule, 950); // ~63 bpm
    } else {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, kind === 'shush' ? 'white' : kind);
      src.loop = true;
      let tail: AudioNode = src;
      if (kind === 'shush') {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3000;
        bp.Q.value = 0.8;
        const am = ctx.createGain();
        am.gain.value = 0.55;
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = 0.75; // "shhh … shhh …"
        lfoGain.gain.value = 0.45;
        lfo.connect(lfoGain).connect(am.gain);
        lfo.start();
        src.connect(bp).connect(am);
        tail = am;
        this.nodes.push(lfo, lfoGain, bp);
      }
      tail.connect(out);
      src.start();
      this.nodes.push(src, tail);
    }
    this.current = { kind, endsAt: Date.now() + minutes * 60_000 };
    this.stopTimer = window.setTimeout(() => this.stop(), minutes * 60_000);
  }

  /** Loudness governor: scale the volume (never above what the parent chose). */
  scale(factor: number): number {
    const ctx = this.ctx;
    const out = this.out;
    if (!ctx || !out) return this.level;
    this.level = Math.max(0.02, Math.min(this.ceiling, this.level * factor));
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
    out.gain.linearRampToValueAtTime(this.level, ctx.currentTime + 0.8);
    return this.level;
  }

  stop(immediate = false): void {
    window.clearTimeout(this.stopTimer);
    window.clearInterval(this.beat);
    const ctx = this.ctx;
    const out = this.out;
    const nodes = this.nodes;
    this.nodes = [];
    this.out = null;
    this.current = null;
    if (!ctx || !out) return;
    const end = immediate ? 0.05 : 3;
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
    out.gain.linearRampToValueAtTime(0, ctx.currentTime + end);
    window.setTimeout(() => {
      for (const n of nodes) {
        try {
          (n as AudioScheduledSourceNode).stop?.();
        } catch { /* not started */ }
        n.disconnect();
      }
      out.disconnect();
    }, end * 1000 + 100);
  }

  close(): void {
    this.stop(true);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
