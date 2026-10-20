/**
 * Smoke / CO alarm recognizer for the nursery camera.
 *
 * Alarms are standardized (ISO 8201 / NFPA 72): a loud piezo tone, usually
 * 2.7–4.2 kHz, in the "temporal-three" pattern for smoke/fire (three 0.5 s
 * beeps 0.5 s apart, then a 1.5 s pause) or "temporal-four" for carbon
 * monoxide (four 0.1 s beeps 0.1 s apart, then ~5 s). That pattern is far
 * more reliable than any learned classifier, so it's detected directly from
 * the spectrum — a dog, a cry or music never makes a narrow 3 kHz tone that
 * beeps in that rhythm.
 */

const BAND_LO = 2500;
const BAND_HI = 4600;
/** Peak must stand this far above the spectrum's median (dB) — a pure tone. */
const TONAL_DB = 22;
/** And be loud in absolute terms (analyser dBFS). */
const MIN_PEAK_DB = -55;
/**
 * And nothing comparable below 2 kHz: an alarm's tone IS its fundamental,
 * whereas a cry or a laugh reaching 3 kHz is a harmonic of a strong ~400 Hz voice.
 */
const LOW_BAND_GAP_DB = 12;
/** A beep holds its pitch; voices glide. Max pitch spread within one beep (Hz). */
const MAX_BEEP_SPREAD_HZ = 120;

export interface AlarmToneOutput {
  active: boolean;
  /** Which pattern matched while active. */
  pattern: 'T3' | 'T4' | 'continuous' | null;
}

interface Seg {
  start: number;
  end: number;
  hz: number;
  /** Pitch spread within the beep (Hz). */
  spread: number;
}

export class AlarmToneDetector {
  private on: { start: number; last: number; hz: number; lo: number; hi: number } | null = null;
  private segs: Seg[] = [];
  private activeUntil = 0;
  private pattern: AlarmToneOutput['pattern'] = null;

  /**
   * One spectrum frame (AnalyserNode.getFloatFrequencyData, dB per bin).
   * Call every ~50 ms; `binHz` = sampleRate / fftSize.
   */
  push(spectrumDb: Float32Array, binHz: number, now: number): AlarmToneOutput {
    const tone = AlarmToneDetector.toneOf(spectrumDb, binHz);
    if (tone) {
      // Same beep continues (allow one missed frame and ±200 Hz drift).
      if (this.on && now - this.on.last <= 120 && Math.abs(tone - this.on.hz) < 200) {
        this.on.last = now;
        this.on.lo = Math.min(this.on.lo, tone);
        this.on.hi = Math.max(this.on.hi, tone);
      } else {
        this.closeSeg();
        this.on = { start: now, last: now, hz: tone, lo: tone, hi: tone };
      }
    } else if (this.on && now - this.on.last > 120) {
      this.closeSeg();
    }
    this.segs = this.segs.filter((s) => now - s.end < 8000);

    const matched = this.match(now);
    if (matched) {
      this.pattern = matched;
      this.activeUntil = now + (matched === 'T4' ? 9000 : 6000);
    }
    const active = now < this.activeUntil;
    if (!active) this.pattern = null;
    return { active, pattern: active ? this.pattern : null };
  }

  private closeSeg(): void {
    if (this.on) {
      this.segs.push({ start: this.on.start, end: this.on.last + 50, hz: this.on.hz, spread: this.on.hi - this.on.lo });
      this.on = null;
    }
  }

  private match(now: number): AlarmToneOutput['pattern'] {
    // A tone that just keeps going for 3 s (some alarms are continuous).
    if (this.on && this.on.last - this.on.start >= 3000 && this.on.hi - this.on.lo <= MAX_BEEP_SPREAD_HZ) return 'continuous';
    const s = this.segs.filter((x) => x.spread <= MAX_BEEP_SPREAD_HZ);
    const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
    for (let i = 0; i + 2 < s.length; i++) {
      // Temporal-three: 3 beeps of ~0.5 s, gaps ~0.5 s, steady pitch.
      const a = s[i], b = s[i + 1], c = s[i + 2];
      const beeps = [a, b, c].every((x) => within(x.end - x.start, 300, 800));
      const gaps = within(b.start - a.end, 250, 800) && within(c.start - b.end, 250, 800);
      const pitch = Math.abs(a.hz - b.hz) < 250 && Math.abs(b.hz - c.hz) < 250;
      if (beeps && gaps && pitch) return 'T3';
    }
    for (let i = 0; i + 3 < s.length; i++) {
      // Temporal-four: 4 beeps of ~0.1 s, gaps ~0.1 s, all the same pitch. A
      // single 50 ms frame isn't a beep — that's how cry harmonics flicker.
      const q = s.slice(i, i + 4);
      const beeps = q.every((x) => within(x.end - x.start, 90, 260));
      const gaps = q.slice(1).every((x, k) => within(x.start - q[k].end, 40, 300));
      const pitch = Math.max(...q.map((x) => x.hz)) - Math.min(...q.map((x) => x.hz)) < 200;
      if (beeps && gaps && pitch) return 'T4';
    }
    void now;
    return null;
  }

  /** The alarm-band tone frequency in this frame, or null. */
  static toneOf(spectrumDb: Float32Array, binHz: number): number | null {
    const lo = Math.max(1, Math.floor(BAND_LO / binHz));
    const hi = Math.min(spectrumDb.length - 2, Math.ceil(BAND_HI / binHz));
    let peak = -Infinity;
    let at = -1;
    for (let i = lo; i <= hi; i++) {
      if (spectrumDb[i] > peak) {
        peak = spectrumDb[i];
        at = i;
      }
    }
    if (at < 0 || !Number.isFinite(peak) || peak < MIN_PEAK_DB) return null;
    // Median of the speech/music band as the "background" reference.
    const ref: number[] = [];
    const rlo = Math.max(1, Math.floor(300 / binHz));
    const rhi = Math.min(spectrumDb.length - 1, Math.ceil(8000 / binHz));
    for (let i = rlo; i <= rhi; i += 2) if (Number.isFinite(spectrumDb[i])) ref.push(spectrumDb[i]);
    if (ref.length < 8) return null;
    ref.sort((x, y) => x - y);
    const median = ref[Math.floor(ref.length / 2)];
    if (peak - median < TONAL_DB) return null;
    let low = -Infinity;
    const llo = Math.max(1, Math.floor(150 / binHz));
    const lhi = Math.ceil(2000 / binHz);
    for (let i = llo; i <= lhi; i++) if (spectrumDb[i] > low) low = spectrumDb[i];
    if (peak - low < LOW_BAND_GAP_DB) return null;
    // Parabolic interpolation: bins are ~23 Hz wide, beeps are judged on ±60 Hz.
    const a = spectrumDb[at - 1], b = spectrumDb[at], c = spectrumDb[at + 1];
    const d = a - 2 * b + c;
    const shift = d !== 0 && Number.isFinite(d) ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
    return (at + shift) * binHz;
  }
}
