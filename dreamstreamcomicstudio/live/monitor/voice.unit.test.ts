// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HowlDetector, LoudnessGovernor, SOOTHE_CEILING_DB } from './voice';

const BIN_HZ = 48_000 / 2048;
const BINS = 1024;

/** A spectrum in dB: a noise floor plus peaks [freq Hz, dB]. */
function spectrum(floor: number, peaks: [number, number][], jitter = 0, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2 * jitter;
  const out = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) out[i] = floor + rnd();
  for (const [f, db] of peaks) {
    const c = Math.round(f / BIN_HZ);
    for (let d = -1; d <= 1; d++) out[c + d] = Math.max(out[c + d], db - Math.abs(d) * 6);
  }
  return out;
}

const run = (d: HowlDetector, frames: Float32Array[], stepMs = 50) => frames.map((f, i) => d.push(f, BIN_HZ, i * stepMs));

describe('HowlDetector', () => {
  it('fires on a steady feedback tone within ~0.3 s', () => {
    const d = new HowlDetector();
    const out = run(d, Array.from({ length: 10 }, (_, i) => spectrum(-90, [[1870, -30]], 3, i + 1)));
    const first = out.findIndex((f) => f.howl);
    expect(first).toBeGreaterThan(3);
    expect(first).toBeLessThanOrEqual(7);
    expect(out[first].freq).toBeGreaterThan(1800);
    expect(out[first].freq).toBeLessThan(1950);
  });

  it('ignores a crying baby: harmonics that move in pitch', () => {
    const d = new HowlDetector();
    const frames = Array.from({ length: 30 }, (_, i) => {
      const f0 = 420 + 60 * Math.sin(i / 2); // vibrato and melody
      return spectrum(-75, [[f0, -32], [f0 * 2, -36], [f0 * 3, -40], [f0 * 4, -45], [f0 * 5, -50]], 4, i + 7);
    });
    expect(run(d, frames).some((f) => f.howl)).toBe(false);
  });

  it('ignores broadband noise and quiet rooms', () => {
    const d = new HowlDetector();
    expect(run(d, Array.from({ length: 30 }, (_, i) => spectrum(-50, [], 6, i + 3))).some((f) => f.howl)).toBe(false);
    expect(run(d, Array.from({ length: 30 }, (_, i) => spectrum(-110, [[1000, -75]], 2, i + 5))).some((f) => f.howl)).toBe(false);
  });

  it('lets go when the tone stops', () => {
    const d = new HowlDetector();
    run(d, Array.from({ length: 10 }, (_, i) => spectrum(-90, [[2500, -28]], 2, i + 1)));
    expect(d.push(spectrum(-90, [], 2, 99), BIN_HZ, 600).howl).toBe(false);
  });
});

describe('LoudnessGovernor', () => {
  it('turns soothing sounds down until the crib is at or under 50 dB, then holds', () => {
    const g = new LoudnessGovernor(SOOTHE_CEILING_DB);
    let gain = 0.6;
    // A crude room: the camera hears 62 dB at gain 0.6 (≈ 20·log10 scaling).
    const level = () => 62 + 20 * Math.log10(gain / 0.6);
    for (let i = 0; i < 30; i++) gain = Math.min(1, gain * g.step(level(), 30));
    expect(level()).toBeLessThanOrEqual(SOOTHE_CEILING_DB + 0.5);
    expect(level()).toBeGreaterThan(SOOTHE_CEILING_DB - 9);
  });

  it('acts at once on something far too loud', () => {
    expect(new LoudnessGovernor(65).step(80, 35)).toBe(0.6);
  });

  it('never chases the room’s own background', () => {
    expect(new LoudnessGovernor(50).step(55, 54)).toBeGreaterThan(1);
  });
});
