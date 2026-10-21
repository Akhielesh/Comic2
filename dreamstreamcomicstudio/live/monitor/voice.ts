/**
 * Two-way audio that doesn't scream or startle.
 *
 *  - TalkProcessor (parent's phone): mic → high-pass 120 Hz → compressor /
 *    limiter → gain with a soft fade-in. Shouting and whispering arrive at
 *    similar, moderate loudness; the nursery can turn it down remotely.
 *  - HowlDetector (camera phone): acoustic feedback — the parent's phone in
 *    the same room as the camera — shows up as one pure tone towering over
 *    the rest of the spectrum and holding steady. Crying, voices and music
 *    spread their energy across harmonics and move; a howl doesn't.
 *  - LoudnessGovernor (camera phone): the camera's own sound meter measures
 *    what actually reaches the crib and nudges talk and soothing sounds back
 *    under a ceiling (soothing: 50 dB, the infant-sleep guideline).
 */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------- talk processor */

export class TalkProcessor {
  readonly out: MediaStreamTrack;
  private ctx: AudioContext;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private buf: Float32Array;
  private target = 0.85;

  private constructor(ctx: AudioContext, gain: GainNode, analyser: AnalyserNode, out: MediaStreamTrack) {
    this.ctx = ctx;
    this.gain = gain;
    this.analyser = analyser;
    this.out = out;
    this.buf = new Float32Array(analyser.fftSize);
  }

  /** Wrap a mic track; returns null if Web Audio isn't available (send the raw track). */
  static create(track: MediaStreamTrack): TalkProcessor | null {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      void ctx.resume().catch(() => undefined);
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 120;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -28;
      comp.knee.value = 8;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const dest = ctx.createMediaStreamDestination();
      src.connect(hp).connect(comp).connect(gain).connect(dest);
      gain.connect(analyser);
      const out = dest.stream.getAudioTracks()[0];
      if (!out) throw new Error('no track');
      const p = new TalkProcessor(ctx, gain, analyser, out);
      // Fade in so the first word never lands as a bang in the nursery.
      gain.gain.linearRampToValueAtTime(p.target, ctx.currentTime + 0.35);
      return p;
    } catch {
      return null;
    }
  }

  get level(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) s += v * v;
    return Math.min(1, Math.sqrt(s / this.buf.length) * 6);
  }

  get volume(): number {
    return this.target;
  }

  /** The nursery asked for it quieter (factor < 1) or allowed it louder (> 1). */
  scale(factor: number): number {
    this.target = clamp(this.target * factor, 0.15, 1);
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(this.target, t + 0.3);
    return this.target;
  }

  close(): void {
    this.out.stop();
    void this.ctx.close().catch(() => undefined);
  }
}

/* -------------------------------------------------------- howl detector */

export interface HowlFrame {
  howl: boolean;
  /** Frequency of the dominant tone, Hz. */
  freq: number;
  /** How far the peak towers over the band's median, dB. */
  papr: number;
}

const HOWL_LO = 150;
const HOWL_HI = 6000;
const HOWL_PAPR_DB = 32;
const HOWL_NEIGHBOUR_DB = 18;
const HOWL_MIN_DB = -58;
const HOWL_HOLD_MS = 280;
/** A howl's harmonic partners sit at least this far below it. */
const HOWL_HARMONIC_DB = 24;

/**
 * Feed AnalyserNode spectra (dB per bin) ~20 times a second. Fires when one
 * narrow tone dominates and stays at the same pitch for ~0.3 s.
 */
export class HowlDetector {
  private since = 0;
  private bin = -1;

  push(spectrumDb: Float32Array, binHz: number, now: number): HowlFrame {
    const lo = Math.max(1, Math.floor(HOWL_LO / binHz));
    const hi = Math.min(spectrumDb.length - 4, Math.ceil(HOWL_HI / binHz));
    let peak = -Infinity;
    let at = -1;
    for (let i = lo; i < hi; i++) {
      if (spectrumDb[i] > peak) {
        peak = spectrumDb[i];
        at = i;
      }
    }
    const band = Array.from(spectrumDb.subarray(lo, hi)).sort((a, b) => a - b);
    const median = band[(band.length / 2) | 0] ?? -120;
    // A howl is narrow: the bins 4–8 away are far below the peak.
    let nb = 0;
    let nbn = 0;
    for (const d of [-8, -7, -6, -5, -4, 4, 5, 6, 7, 8]) {
      const j = at + d;
      if (j > 0 && j < spectrumDb.length) {
        nb += spectrumDb[j];
        nbn++;
      }
    }
    const neighbours = nbn ? nb / nbn : -120;
    const papr = peak - median;
    // Voices and cries are harmonic (strong partners at ½×, 2×, 3× the peak);
    // feedback is a near-pure sinusoid.
    const near = (c: number) => {
      let m = -Infinity;
      for (let j = Math.round(c) - 2; j <= Math.round(c) + 2; j++) if (j > 0 && j < spectrumDb.length) m = Math.max(m, spectrumDb[j]);
      return m;
    };
    const partner = Math.max(near(at * 2), near(at * 3), near(at / 2));
    const pure = peak - partner >= HOWL_HARMONIC_DB;
    const tonal = at > 0 && peak > HOWL_MIN_DB && papr >= HOWL_PAPR_DB && peak - neighbours >= HOWL_NEIGHBOUR_DB && pure;
    if (tonal && (this.bin < 0 || Math.abs(at - this.bin) <= 1)) {
      if (!this.since) this.since = now;
      this.bin = at;
    } else {
      this.since = tonal ? now : 0;
      this.bin = tonal ? at : -1;
    }
    return { howl: !!this.since && now - this.since >= HOWL_HOLD_MS, freq: Math.round(at * binHz), papr: Math.round(papr) };
  }

  reset(): void {
    this.since = 0;
    this.bin = -1;
  }
}

/* --------------------------------------------------- loudness governor */

/** Ceilings at the camera (≈ at the crib), dB(A). */
export const TALK_CEILING_DB = 65;
export const SOOTHE_CEILING_DB = 50;

/**
 * Closed loop on the camera's meter: while something is playing in the
 * nursery, compare the 1-second level with the ceiling and return a gain
 * factor (< 1 = turn down, 1 = hold, > 1 = may come back up slowly).
 */
export class LoudnessGovernor {
  private over = 0;

  constructor(private ceiling: number) {}

  step(leq1: number, baseline: number | null): number {
    // Only judge what the playback adds over the room's own background.
    if (baseline != null && leq1 < baseline + 3) {
      this.over = 0;
      return 1.03;
    }
    if (leq1 > this.ceiling + 6) {
      this.over = 0;
      return 0.6;
    }
    if (leq1 > this.ceiling) {
      this.over++;
      return this.over >= 2 ? 0.82 : 1;
    }
    this.over = 0;
    return leq1 < this.ceiling - 8 ? 1.03 : 1;
  }
}
