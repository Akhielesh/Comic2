// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  aWeighting,
  createLevelKernel,
  DEFAULT_OFFSET,
  earsWorkletSource,
  leqOf,
  LevelMeter,
  levelBand,
  MIC_FLOOR_DB,
  NoiseGuard,
  percentile,
  sosGain,
  type LevelBlock,
} from './soundLevel';

const db = (g: number) => 20 * Math.log10(g);
const sine = (f: number, fs: number, secs: number, amp = 1) => {
  const x = new Float32Array(Math.round(fs * secs));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / fs);
  return x;
};
const run = (x: Float32Array, fs: number, block = 0.125) => {
  const k = createLevelKernel(aWeighting(fs), fs, block);
  const out: LevelBlock[] = [];
  k.process(x, out);
  return out;
};
const msDb = (b: LevelBlock[]) => 10 * Math.log10(b.reduce((a, x) => a + x.ms * x.n, 0) / b.reduce((a, x) => a + x.n, 0));

// Exact analog A-weighting (IEC 61672-1 Annex E), dB.
const analogA = (f: number) => {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
};

describe('A-weighting filter', () => {
  it('reproduces the IEC 61672 table values', () => {
    // Table frequencies are base-10 exact (31.5 Hz nominal = 31.62 Hz).
    const table: [number, number][] = [[31.62, -39.4], [63.1, -26.2], [125.9, -16.1], [251.2, -8.6], [501.2, -3.2], [1000, 0], [1995, 1.2], [3981, 1.0], [7943, -1.1]];
    for (const [f, want] of table) expect(analogA(f)).toBeCloseTo(want, 1);
  });

  for (const fs of [44_100, 48_000]) {
    it(`matches the analog curve at ${fs} Hz (Class 1 accuracy up to 8 kHz)`, () => {
      const sos = aWeighting(fs);
      for (const f of [20, 31.5, 63, 125, 250, 500, 1000, 2000, 4000]) expect(Math.abs(db(sosGain(sos, f, fs)) - analogA(f))).toBeLessThan(0.15);
      // Bilinear warping only bites near Nyquist; IEC Class 1 allows ±1.4 dB at 8 kHz.
      expect(Math.abs(db(sosGain(sos, 8000, fs)) - analogA(8000))).toBeLessThan(1.4);
    });
  }

  it('is stable and settles to the right energy on real signals', () => {
    const fs = 48_000;
    // Full-scale 1 kHz sine: mean square 0.5 → −3.01 dBFS.
    expect(msDb(run(sine(1000, fs, 2), fs).slice(4))).toBeCloseTo(-3.01, 1);
    // 100 Hz is attenuated ~19.1 dB.
    expect(msDb(run(sine(100, fs, 2), fs).slice(4))).toBeCloseTo(-3.01 - 19.1, 0);
  });

  it('applies Fast time weighting (τ = 125 ms)', () => {
    const fs = 48_000;
    const out = run(sine(1000, fs, 1, 0.5), fs, 0.0125); // 12.5 ms blocks
    const steady = 0.125; // 0.5² / 2
    // After one time constant the Fast level has reached ~63% of the energy.
    const at125 = out[9].fast;
    expect(at125 / steady).toBeGreaterThan(0.55);
    expect(at125 / steady).toBeLessThan(0.7);
    expect(out[out.length - 1].fast / steady).toBeGreaterThan(0.98);
  });

  it('tracks the unweighted peak and the fast maximum per block', () => {
    const fs = 48_000;
    const x = sine(1000, fs, 0.5, 0.25);
    x[12_000] = 0.9; // a click
    const out = run(x, fs);
    expect(Math.max(...out.map((b) => b.pk))).toBeCloseTo(0.9, 5);
    for (const b of out) expect(b.fmax).toBeGreaterThanOrEqual(b.fast);
  });

  it('serialises into a self-contained worklet', () => {
    const src = earsWorkletSource();
    expect(src).toContain("registerProcessor('ds-ears'");
    // The kernel must not reference anything outside its own parameters.
    const factory = new Function(`${src.split('class DsEars')[0]}; return createLevelKernel;`)() as typeof createLevelKernel;
    const out: LevelBlock[] = [];
    factory(aWeighting(48_000), 48_000, 0.125).process(sine(1000, 48_000, 1), out);
    expect(out).toHaveLength(8);
  });
});

describe('LevelMeter', () => {
  // Feed a constant level (dBFS) for some seconds starting at t.
  const feed = (m: LevelMeter, levelFs: number, secs: number, t: number) => {
    const ms = 10 ** (levelFs / 10);
    for (let i = 0; i < secs * 8; i++) m.push([{ ms, fast: ms, fmax: ms, pk: Math.sqrt(2 * ms), n: 6000 }], t + i * 125);
    return t + secs * 1000;
  };

  it('reports per-minute Leq, Lmax and percentiles with the offset applied', () => {
    const m = new LevelMeter({ offset: 100, method: 'meter', at: 0 });
    const got: { laeq: number; l90: number; l10: number; lmax: number }[] = [];
    m.onMinute = (x) => got.push(x);
    let t = 0;
    t = feed(m, -70, 48, t); // background 30 dB for 48 s
    t = feed(m, -40, 12, t); // a 60 dB event for 12 s (20% of the minute)
    feed(m, -70, 1, t); // next minute closes the first
    expect(got).toHaveLength(1);
    expect(got[0].l90).toBe(30);
    expect(got[0].l10).toBe(60);
    expect(got[0].lmax).toBe(60);
    expect(got[0].laeq).toBeCloseTo(53, 0); // 20% of the time at +30 dB → ~53 dB Leq
  });

  it('never under-reads: the quietest minute is lifted to the microphone floor', () => {
    const m = new LevelMeter(null);
    expect(m.offset()).toBe(DEFAULT_OFFSET);
    let t = 0;
    t = feed(m, -95, 61, t); // a very low-gain pipeline: default would read 5 dB
    feed(m, -95, 1, t);
    expect(m.offset()).toBe(MIC_FLOOR_DB + 95);
    expect(m.live(t + 1000).db).toBeCloseTo(MIC_FLOOR_DB, 0);
  });

  it('calibrates from a quiet room or from another meter', () => {
    const m = new LevelMeter(null);
    let t = feed(m, -62, 12, 0);
    expect(m.calibrateQuiet(t, 30)?.offset).toBe(92);
    t = feed(m, -40, 4, t);
    expect(m.calibrateTo(55, t)?.offset).toBe(95);
    expect(m.live(t).db).toBeCloseTo(55, 0);
    expect(m.calibrated).toBe(true);
  });

  it('computes the last hour’s Leq for the sound-machine check', () => {
    const m = new LevelMeter({ offset: 100, method: 'meter', at: 0 });
    let t = 0;
    for (let i = 0; i < 61; i++) t = feed(m, -48, 60, t); // a steady 52 dB machine
    expect(m.hourLeq()?.leq).toBeCloseTo(52, 0);
  });
});

describe('level helpers', () => {
  it('percentiles, energy averages and bands', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(leqOf([30, 30])).toBeCloseTo(30, 5);
    expect(leqOf([30, 60])).toBeCloseTo(57, 0);
    expect(levelBand(35)).toBe('quiet');
    expect(levelBand(52)).toBe('moderate');
    expect(levelBand(70)).toBe('loud');
    expect(levelBand(88)).toBe('very_loud');
  });
});

describe('NoiseGuard', () => {
  const play = (g: NoiseGuard, seq: [number, number][]) => {
    const out: ReturnType<NoiseGuard['push']> = [];
    let t = 0;
    for (const [db, secs] of seq) for (let i = 0; i < secs * 4; i++, t += 250) out.push(...g.push(db, t));
    return out;
  };

  it('needs 3 s above the threshold, then reports the episode with its peak and length', () => {
    const g = new NoiseGuard();
    g.threshold = 70;
    const ev = play(g, [[40, 5], [72, 2], [40, 1], [74, 6], [78, 2], [45, 12]]);
    expect(ev).toEqual([
      { type: 'loud', phase: 'start', db: 74 },
      { type: 'loud', phase: 'end', db: 78, secs: 8 },
    ]);
  });

  it('flags very loud noise (≥ 85 dB) after 2 s, independent of the threshold', () => {
    const g = new NoiseGuard();
    g.threshold = null;
    const ev = play(g, [[88, 3], [40, 10]]);
    expect(ev.map((e) => `${e.type}:${e.phase}`)).toEqual(['very_loud:start', 'very_loud:end']);
  });

  it('closes an open episode when the alert is switched off', () => {
    const g = new NoiseGuard();
    play(g, [[75, 4]]);
    g.threshold = null;
    expect(g.push(75, 10_000)).toEqual([{ type: 'loud', phase: 'end', db: 75, secs: 10 }]);
  });
});
