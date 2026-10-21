/**
 * Sound level meter for the nursery camera — A-weighted with "Fast" time
 * weighting (the IEC 61672 sound-level-meter recipe), computed on EVERY
 * sample inside an AudioWorklet, not on occasional snapshots.
 *
 *   mic → A-weighting (3 biquads) → square → Fast (τ = 125 ms) → 8 blocks/s
 *        └ unweighted |peak|
 *
 * Phones don't publish their microphone sensitivity, so dB = dBFS + offset.
 * The offset comes from, in order:
 *   1. the parent's calibration on this phone (quiet-room or match-a-meter),
 *   2. a conservative default, raised whenever the quietest sustained reading
 *      would fall below a phone microphone's own noise floor (~28 dB(A)) —
 *      so the meter can over-read on an unusual phone but never under-read.
 * Uncalibrated readings are shown as "≈".
 */

/** Second-order sections, flattened [b0, b1, b2, a1, a2] × n (a0 = 1). */
export type Sos = number[];

export interface LevelBlock {
  /** Mean square of the A-weighted signal over the block (Leq energy). */
  ms: number;
  /** Fast-weighted mean square at the end of the block. */
  fast: number;
  /** Highest Fast-weighted mean square inside the block (for LAFmax). */
  fmax: number;
  /** Highest unweighted |sample| inside the block (for peak). */
  pk: number;
  /** Samples in the block. */
  n: number;
}

// A-weighting pole frequencies (Hz), IEC 61672-1.
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

/** Bilinear transform of an analog biquad (b2 s² + b1 s + b0) / (a2 s² + a1 s + a0). */
function bilinear(b: [number, number, number], a: [number, number, number], fs: number): number[] {
  const K = 2 * fs;
  const K2 = K * K;
  const [b2, b1, b0] = b;
  const [a2, a1, a0] = a;
  const A0 = a2 * K2 + a1 * K + a0;
  return [
    (b2 * K2 + b1 * K + b0) / A0,
    (2 * b0 - 2 * b2 * K2) / A0,
    (b2 * K2 - b1 * K + b0) / A0,
    (2 * a0 - 2 * a2 * K2) / A0,
    (a2 * K2 - a1 * K + a0) / A0,
  ];
}

/** |H(e^jw)| of a cascade at frequency f. */
export function sosGain(sos: Sos, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  let g = 1;
  for (let o = 0; o < sos.length; o += 5) {
    const nr = sos[o] + sos[o + 1] * c1 + sos[o + 2] * c2;
    const ni = sos[o + 1] * s1 + sos[o + 2] * s2;
    const dr = 1 + sos[o + 3] * c1 + sos[o + 4] * c2;
    const di = sos[o + 3] * s1 + sos[o + 4] * s2;
    g *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return g;
}

/** Digital A-weighting filter for a sample rate, normalised to 0 dB at 1 kHz. */
export function aWeighting(fs: number): Sos {
  const w = (f: number) => 2 * Math.PI * f;
  const [w1, w2, w3, w4] = [w(F1), w(F2), w(F3), w(F4)];
  const sos = [
    ...bilinear([1, 0, 0], [1, 2 * w1, w1 * w1], fs), // s² / (s + ω1)²
    ...bilinear([1, 0, 0], [1, w2 + w3, w2 * w3], fs), // s² / (s + ω2)(s + ω3)
    ...bilinear([0, 0, 1], [1, 2 * w4, w4 * w4], fs), // 1 / (s + ω4)²
  ];
  const g = 1 / sosGain(sos, 1000, fs);
  for (let i = 10; i < 13; i++) sos[i] *= g;
  return sos;
}

/**
 * The per-sample kernel. Self-contained on purpose: its source text is
 * serialised into the AudioWorklet, so it may not reference anything outside
 * its own parameters.
 */
export function createLevelKernel(sos: number[], fs: number, blockSec: number) {
  const nsec = sos.length / 5;
  const z1 = new Float64Array(nsec);
  const z2 = new Float64Array(nsec);
  const k = 1 / (0.125 * fs);
  const blockLen = Math.max(1, Math.round(blockSec * fs));
  let fast = 0;
  let acc = 0;
  let fmax = 0;
  let pk = 0;
  let n = 0;
  return {
    process(x: Float32Array, out: { ms: number; fast: number; fmax: number; pk: number; n: number }[]): void {
      for (let i = 0; i < x.length; i++) {
        const raw = x[i];
        let v = raw;
        for (let s = 0; s < nsec; s++) {
          const o = s * 5;
          const y = sos[o] * v + z1[s];
          z1[s] = sos[o + 1] * v - sos[o + 3] * y + z2[s];
          z2[s] = sos[o + 2] * v - sos[o + 4] * y;
          v = y;
        }
        const sq = v * v;
        fast += (sq - fast) * k;
        acc += sq;
        if (fast > fmax) fmax = fast;
        const a = raw < 0 ? -raw : raw;
        if (a > pk) pk = a;
        if (++n >= blockLen) {
          out.push({ ms: acc / n, fast, fmax, pk, n });
          acc = 0;
          fmax = 0;
          pk = 0;
          n = 0;
        }
      }
    },
  };
}

export const LEVEL_BLOCK_SEC = 0.125;

/**
 * AudioWorklet: the level kernel on every sample, plus (when the AI model is
 * ready) raw PCM chunks for the sound classifier.
 */
export function earsWorkletSource(): string {
  return `const createLevelKernel = ${createLevelKernel.toString()};
class DsEars extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.k = createLevelKernel(o.sos, sampleRate, o.block);
    this.pcm = false;
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.out = [];
    this.port.onmessage = (e) => { if (e.data && 'pcm' in e.data) this.pcm = !!e.data.pcm; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.k.process(ch, this.out);
      if (this.out.length) { this.port.postMessage({ t: 'lv', b: this.out }); this.out = []; }
      if (this.pcm) {
        for (let i = 0; i < ch.length; i++) {
          this.buf[this.n++] = ch[i];
          if (this.n === this.buf.length) {
            this.port.postMessage({ t: 'pcm', d: this.buf }, [this.buf.buffer]);
            this.buf = new Float32Array(2048);
            this.n = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('ds-ears', DsEars);`;
}

/* ------------------------------------------------------------ the meter */

/** No phone microphone reads below its own self-noise (~28 dB(A)). */
export const MIC_FLOOR_DB = 28;
/** Default dBFS → dB offset before calibration (then raised by the floor rule). */
export const DEFAULT_OFFSET = 100;

export interface Calibration {
  offset: number;
  method: 'quiet' | 'meter';
  at: number;
}

export interface LiveLevel {
  /** Fast-weighted level right now, dB(A). */
  db: number;
  /** Leq over the last second, dB(A). */
  leq1: number;
  /** Fast max over the last second, dB(A). */
  max1: number;
  calibrated: boolean;
}

/** One minute of sound, all dB(A) except lpk (unweighted peak). */
export interface MinuteLevels {
  /** Minute start, epoch ms. */
  m: number;
  laeq: number;
  lmax: number;
  l10: number;
  l50: number;
  l90: number;
  lpk: number;
  calibrated: boolean;
}

const dbfs = (ms: number) => 10 * Math.log10(Math.max(ms, 1e-20));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Percentile of an ascending array (p in 0–100). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -200;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** Energy average of dB values. */
export function leqOf(dbs: number[]): number {
  if (!dbs.length) return -200;
  let e = 0;
  for (const d of dbs) e += 10 ** (d / 10);
  return 10 * Math.log10(e / dbs.length);
}

export class LevelMeter {
  calibration: Calibration | null;
  onMinute: ((m: MinuteLevels) => void) | null = null;

  private fastDb = -200;
  /** Last second of blocks (dBFS) for live numbers + calibration. */
  private recent: { at: number; ms: number; fmax: number }[] = [];
  private minute = -1;
  private mE = 0;
  private mN = 0;
  private mMax = 0;
  private mPk = 0;
  private mFast: number[] = [];
  /** Lowest per-minute L90 seen, dBFS — drives the floor rule. */
  private floorFs = Infinity;
  /** Last hour of minute energies (dBFS Leq) for the sound-machine check. */
  private hourFs: { m: number; leq: number }[] = [];

  constructor(calibration: Calibration | null = null) {
    this.calibration = calibration;
  }

  /** dBFS → dB(A) offset in use right now. */
  offset(): number {
    if (this.calibration) return this.calibration.offset;
    const floorRule = Number.isFinite(this.floorFs) ? MIC_FLOOR_DB - this.floorFs : -Infinity;
    return Math.max(DEFAULT_OFFSET, floorRule);
  }

  get calibrated(): boolean {
    return !!this.calibration;
  }

  push(blocks: LevelBlock[], now: number): void {
    if (!blocks.length) return;
    const m = Math.floor(now / 60_000) * 60_000;
    if (this.minute === -1) this.minute = m;
    if (m !== this.minute) this.closeMinute(m);
    for (const b of blocks) {
      this.fastDb = dbfs(b.fast);
      this.mE += b.ms * b.n;
      this.mN += b.n;
      if (b.fmax > this.mMax) this.mMax = b.fmax;
      if (b.pk > this.mPk) this.mPk = b.pk;
      this.mFast.push(this.fastDb);
      this.recent.push({ at: now, ms: b.ms, fmax: b.fmax });
    }
    const cut = now - 10_000;
    while (this.recent.length && this.recent[0].at < cut) this.recent.shift();
  }

  private closeMinute(next: number): void {
    if (this.mN > 0) {
      const sorted = this.mFast.slice().sort((a, b) => a - b);
      const leqFs = dbfs(this.mE / this.mN);
      const l90Fs = percentile(sorted, 10);
      // Only trust a floor from a well-filled minute.
      if (sorted.length >= 200) this.floorFs = Math.min(this.floorFs, l90Fs);
      this.hourFs.push({ m: this.minute, leq: leqFs });
      while (this.hourFs.length && this.hourFs[0].m <= next - 60 * 60_000) this.hourFs.shift();
      const off = this.offset();
      this.onMinute?.({
        m: this.minute,
        laeq: r1(leqFs + off),
        lmax: r1(dbfs(this.mMax) + off),
        l10: r1(percentile(sorted, 90) + off),
        l50: r1(percentile(sorted, 50) + off),
        l90: r1(l90Fs + off),
        lpk: r1(20 * Math.log10(Math.max(this.mPk, 1e-10)) + off),
        calibrated: this.calibrated,
      });
    }
    this.minute = next;
    this.mE = 0;
    this.mN = 0;
    this.mMax = 0;
    this.mPk = 0;
    this.mFast = [];
  }

  live(now: number): LiveLevel {
    const off = this.offset();
    const sec = this.recent.filter((r) => r.at >= now - 1000);
    let e = 0;
    let mx = 0;
    for (const r of sec) {
      e += r.ms;
      if (r.fmax > mx) mx = r.fmax;
    }
    return {
      db: r1(Math.max(0, this.fastDb + off)),
      leq1: r1(Math.max(0, (sec.length ? dbfs(e / sec.length) : this.fastDb) + off)),
      max1: r1(Math.max(0, (sec.length ? dbfs(mx) : this.fastDb) + off)),
      calibrated: this.calibrated,
    };
  }

  /** Leq over the last hour of complete minutes (dB(A)), or null with < 50 min of data. */
  hourLeq(): { leq: number; minutes: number } | null {
    if (this.hourFs.length < 50) return null;
    return { leq: r1(leqOf(this.hourFs.map((h) => h.leq)) + this.offset()), minutes: this.hourFs.length };
  }

  /** Calibrate so the quiet room's background (L90 of the last 10 s) reads `target` dB. */
  calibrateQuiet(now: number, target = 30): Calibration | null {
    const fs = this.recent.filter((r) => r.at >= now - 10_000).map((r) => dbfs(r.ms)).sort((a, b) => a - b);
    if (fs.length < 16) return null;
    this.calibration = { offset: r1(target - percentile(fs, 10)), method: 'quiet', at: now };
    return this.calibration;
  }

  /** Calibrate so the last 3 s Leq matches another meter's reading. */
  calibrateTo(reading: number, now: number): Calibration | null {
    const fs = this.recent.filter((r) => r.at >= now - 3000);
    if (fs.length < 8 || !Number.isFinite(reading)) return null;
    const leqFs = dbfs(fs.reduce((a, r) => a + r.ms, 0) / fs.length);
    this.calibration = { offset: r1(reading - leqFs), method: 'meter', at: now };
    return this.calibration;
  }
}

/* --------------------------------------------------------- noise guard */

export interface NoiseEvent {
  type: 'loud' | 'very_loud';
  phase: 'start' | 'end';
  /** Highest level in the episode so far, dB(A). */
  db: number;
  secs?: number;
}

/** Above this, even short exposure is the level hearing guidance warns about. */
export const VERY_LOUD_DB = 85;

/**
 * Turns the live level into episodes: "louder than the family's threshold for
 * 3 s" and "very loud (≥ 85 dB) for 2 s". An episode ends after 8 s below.
 */
export class NoiseGuard {
  /** dB(A) threshold for "loud"; null = off. */
  threshold: number | null = 70;
  private ep: Record<'loud' | 'very_loud', { above: number; start: number; below: number; on: boolean; max: number }> = {
    loud: { above: 0, start: 0, below: 0, on: false, max: 0 },
    very_loud: { above: 0, start: 0, below: 0, on: false, max: 0 },
  };

  push(db: number, now: number): NoiseEvent[] {
    const out: NoiseEvent[] = [];
    const check = (type: 'loud' | 'very_loud', limit: number | null, holdMs: number) => {
      const e = this.ep[type];
      if (limit == null) {
        if (e.on) out.push({ type, phase: 'end', db: Math.round(e.max), secs: Math.round((now - e.start) / 1000) });
        e.on = false;
        e.above = 0;
        e.max = 0;
        return;
      }
      if (db >= limit) {
        e.below = 0;
        if (!e.above) e.above = now;
        e.max = Math.max(e.max, db);
        if (!e.on && now - e.above >= holdMs) {
          e.on = true;
          e.start = e.above;
          out.push({ type, phase: 'start', db: Math.round(e.max) });
        }
        return;
      }
      e.above = 0;
      if (!e.on) {
        e.max = 0;
        return;
      }
      if (!e.below) e.below = now;
      if (now - e.below >= 8000) {
        e.on = false;
        out.push({ type, phase: 'end', db: Math.round(e.max), secs: Math.round((e.below - e.start) / 1000) });
        e.max = 0;
      }
    };
    check('loud', this.threshold, 3000);
    check('very_loud', VERY_LOUD_DB, 2000);
    return out;
  }
}

/* -------------------------------------------------------------- display */

export type LevelBand = 'quiet' | 'moderate' | 'loud' | 'very_loud';

/** Bands for a nursery: <40 quiet, 40–60 conversation, 60–80 loud, ≥80 harmful with exposure. */
export function levelBand(db: number): LevelBand {
  if (db < 40) return 'quiet';
  if (db < 60) return 'moderate';
  if (db < 80) return 'loud';
  return 'very_loud';
}

export const LEVEL_BAND_INFO: Record<LevelBand, { label: string; tone: 'ok' | 'info' | 'warn' | 'live'; like: string }> = {
  quiet: { label: 'Quiet', tone: 'ok', like: 'like a quiet bedroom or a whisper' },
  moderate: { label: 'Moderate', tone: 'info', like: 'like a conversation or a sound machine' },
  loud: { label: 'Loud', tone: 'warn', like: 'like a vacuum cleaner or loud TV' },
  very_loud: { label: 'Very loud', tone: 'live', like: 'like a smoke alarm or lawn mower up close' },
};

/* ---------------------------------------------------------- calibration */

const CAL_KEY = 'ds-monitor-cal';

export function loadCalibration(): Calibration | null {
  try {
    const c = JSON.parse(localStorage.getItem(CAL_KEY) || 'null') as Calibration | null;
    return c && Number.isFinite(c.offset) && c.offset > 40 && c.offset < 200 ? c : null;
  } catch {
    return null;
  }
}

export function saveCalibration(c: Calibration | null): void {
  try {
    if (c) localStorage.setItem(CAL_KEY, JSON.stringify(c));
    else localStorage.removeItem(CAL_KEY);
  } catch { /* storage unavailable */ }
}
