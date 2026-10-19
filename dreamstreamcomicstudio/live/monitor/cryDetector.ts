/**
 * On-device cry detection for the baby camera. Runs entirely on the camera
 * phone — audio is never uploaded for analysis.
 *
 * What makes an infant cry distinguishable from room noise and adult speech:
 *  - strongly VOICED / harmonic (high autocorrelation clarity), unlike fans,
 *    white-noise machines, traffic or rain (broadband, low clarity);
 *  - fundamental frequency ~250–900 Hz (adult speech sits ~85–255 Hz);
 *  - loud relative to the room's own noise floor;
 *  - rhythmic BURSTS of 0.4–1.5 s separated by inhalation gaps, repeating —
 *    speech voicing comes in much shorter syllables.
 *
 * analyzeFrame() extracts features from one ~40 ms frame; CryDetector turns
 * the feature stream into calm / stirring / noisy / crying plus start/end
 * events, with an adaptive noise floor and three sensitivity levels.
 *
 * Honest limits (surfaced in the UI): this is an attentive ear, not a medical
 * device — it does not monitor breathing, temperature or sleep safety.
 */

export interface FrameFeatures {
  /** Frame loudness, dBFS (−100 … 0). */
  rmsDb: number;
  /** Estimated fundamental (Hz) when the frame is voiced, else null. */
  pitchHz: number | null;
  /** Normalized autocorrelation at the pitch lag, 0–1 (harmonicity). */
  clarity: number;
}

export type Sensitivity = 'low' | 'medium' | 'high';
export type DetectorState = 'calm' | 'stirring' | 'noisy' | 'crying';

export interface DetectorOutput {
  state: DetectorState;
  /** dB above the adaptive noise floor (0–60). */
  level: number;
  /** 0–100: how cry-like the last few seconds were. */
  cryConfidence: number;
  events: ('cry_start' | 'cry_end' | 'noise')[];
  /** Seconds of the cry that just ended (on cry_end). */
  crySecs?: number;
}

const MIN_F0 = 250;
const MAX_F0 = 900;

export function analyzeFrame(x: Float32Array, sampleRate: number): FrameFeatures {
  const n = x.length;
  let sum = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  for (let i = 0; i < n; i++) {
    const v = x[i] - mean;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / (n || 1));
  const rmsDb = rms > 1e-6 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  if (rmsDb < -75) return { rmsDb, pitchHz: null, clarity: 0 };

  // Normalized autocorrelation over the infant-cry pitch range.
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_F0));
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / (MIN_F0 * 0.9)));
  let bestLag = -1;
  let best = 0;
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let c = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      const a = x[i] - mean;
      const b = x[i + lag] - mean;
      c += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const r = e1 > 0 && e2 > 0 ? c / Math.sqrt(e1 * e2) : 0;
    corr[lag] = r;
  }
  // First strong peak (avoids octave errors from picking a later multiple).
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) globalMax = Math.max(globalMax, corr[lag]);
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    if (corr[lag] >= globalMax * 0.9 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag;
      best = corr[lag];
      break;
    }
  }
  if (bestLag < 0) return { rmsDb, pitchHz: null, clarity: Math.max(0, globalMax) };
  // Parabolic interpolation for a sub-sample lag.
  const y0 = corr[bestLag - 1];
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const pitchHz = sampleRate / (bestLag + Math.max(-0.5, Math.min(0.5, shift)));
  return { rmsDb, pitchHz: pitchHz >= MIN_F0 * 0.9 && pitchHz <= MAX_F0 * 1.05 ? pitchHz : null, clarity: Math.max(0, best) };
}

const THRESH: Record<Sensitivity, { db: number; clarity: number; episode: number }> = {
  high: { db: 9, clarity: 0.5, episode: 0.28 },
  medium: { db: 13, clarity: 0.58, episode: 0.35 },
  low: { db: 19, clarity: 0.65, episode: 0.45 },
};

interface Sample {
  t: number;
  cry: boolean;
  loud: boolean;
  active: boolean;
}

export class CryDetector {
  private floor: number | null = null;
  private window: Sample[] = [];
  private crying = false;
  private cryStartedAt = 0;
  private lastCryFrameAt = 0;
  private burstStart: number | null = null;
  private lastBurstFrameAt = 0;
  private bursts: { start: number; end: number }[] = [];
  private loudSince: number | null = null;
  private lastNoiseEventAt = -Infinity;
  private suppressedUntil = 0;

  constructor(public sensitivity: Sensitivity = 'medium') {}

  /** Ignore audio for a while (talk-back or soothing sounds just started). */
  suppress(ms: number, now: number): void {
    this.suppressedUntil = Math.max(this.suppressedUntil, now + ms);
  }

  get noiseFloorDb(): number {
    return this.floor ?? -60;
  }

  push(f: FrameFeatures, now: number): DetectorOutput {
    const th = THRESH[this.sensitivity];
    // Adaptive floor: falls fast to quiet frames, rises slowly to steady noise
    // (a fan turning on raises it within ~a minute; a cry doesn't).
    if (this.floor == null) this.floor = Math.max(-85, f.rmsDb);
    else if (f.rmsDb < this.floor) this.floor += (f.rmsDb - this.floor) * 0.25;
    else this.floor += Math.min(f.rmsDb - this.floor, 6) * 0.004;
    this.floor = Math.max(-85, this.floor);

    const level = Math.max(0, Math.min(60, f.rmsDb - this.floor));
    const muted = now < this.suppressedUntil;
    const voicedCry = !muted && level >= th.db && f.pitchHz != null && f.clarity >= th.clarity;
    const loud = !muted && level >= 24;
    const active = !muted && level >= 7;

    // Burst tracking: contiguous cry frames, tolerating 150 ms dropouts.
    if (voicedCry) {
      if (this.burstStart == null || now - this.lastBurstFrameAt > 150) this.closeBurst(now);
      if (this.burstStart == null) this.burstStart = now;
      this.lastBurstFrameAt = now;
      this.lastCryFrameAt = now;
    } else if (this.burstStart != null && now - this.lastBurstFrameAt > 150) {
      this.closeBurst(now);
    }

    this.window.push({ t: now, cry: voicedCry, loud, active });
    while (this.window.length && now - this.window[0].t > 6000) this.window.shift();
    this.bursts = this.bursts.filter((b) => now - b.end < 8000);

    const frames = this.window.length || 1;
    const cryFrac = this.window.filter((s) => s.cry).length / frames;
    const realBursts = this.bursts.filter((b) => b.end - b.start >= 350);
    const longBurst = this.burstStart != null && now - this.burstStart >= 1400;
    const confidence = Math.round(Math.min(100, (cryFrac / th.episode) * 60 + Math.min(realBursts.length, 3) * 13));

    const events: DetectorOutput['events'] = [];
    let crySecs: number | undefined;
    if (!this.crying && this.window.length >= 10 && cryFrac >= th.episode && (realBursts.length >= 2 || longBurst)) {
      this.crying = true;
      this.cryStartedAt = now;
      events.push('cry_start');
    } else if (this.crying && now - this.lastCryFrameAt > 8000) {
      this.crying = false;
      crySecs = Math.round((this.lastCryFrameAt - this.cryStartedAt) / 1000);
      events.push('cry_end');
    }

    // Sustained loud non-cry sound (a crash, a dog, a door) → "noisy".
    if (loud && !voicedCry) this.loudSince ??= now;
    else if (!loud) this.loudSince = null;
    const noisy = !this.crying && this.loudSince != null && now - this.loudSince >= 900;
    if (noisy && now - this.lastNoiseEventAt > 60_000) {
      this.lastNoiseEventAt = now;
      events.push('noise');
    }

    const activeFrac = this.window.filter((s) => s.active).length / frames;
    const state: DetectorState = this.crying ? 'crying' : noisy ? 'noisy' : activeFrac > 0.15 || cryFrac > 0.08 ? 'stirring' : 'calm';
    return { state, level: Math.round(level), cryConfidence: confidence, events, crySecs };
  }

  private closeBurst(now: number): void {
    if (this.burstStart != null) {
      this.bursts.push({ start: this.burstStart, end: Math.min(now, this.lastBurstFrameAt) });
      this.burstStart = null;
    }
  }
}
