import { describe, expect, it } from 'vitest';
import { CryDetector, analyzeFrame, type DetectorOutput } from './cryDetector';
import { compareFrames, lumaOf } from './motion';
import { guessDeviceName } from './client';

const SR = 48_000;
const FRAME = 2048;
const HOP_S = 0.1;

/** Deterministic noise so tests never flake. */
function rng(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

type Gen = (t: number, rand: () => number) => number;

/** Render `seconds` of a signal and run the detector on 100 ms hops. */
function run(gen: Gen, seconds: number, det = new CryDetector('medium')): DetectorOutput[] {
  const rand = rng();
  const out: DetectorOutput[] = [];
  const frame = new Float32Array(FRAME);
  for (let t = 0; t < seconds; t += HOP_S) {
    for (let i = 0; i < FRAME; i++) frame[i] = gen(t + i / SR, rand);
    out.push(det.push(analyzeFrame(frame, SR), Math.round(t * 1000)));
  }
  return out;
}

const quiet: Gen = (_t, r) => r() * 0.004;

/** Infant-cry-like: harmonic, F0 ~450 Hz with vibrato, 1 s bursts with breaths. */
const cry: Gen = (t, r) => {
  if (t < 2) return quiet(t, r);
  const cycle = (t - 2) % 1.45;
  if (cycle > 1.0) return quiet(t, r);
  const f0 = 450;
  const ph = 2 * Math.PI * f0 * t + (25 / 5) * Math.sin(2 * Math.PI * 5 * t);
  return 0.25 * (Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.35 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)) + quiet(t, r);
};

/** Broadband noise (fan, white-noise machine, rain) — loud but unvoiced. */
const noise: Gen = (t, r) => (t < 2 ? quiet(t, r) : r() * 0.6);

/** Adult-speech-like: low F0 (~120 Hz), short syllables. */
const speech: Gen = (t, r) => {
  if (t < 2) return quiet(t, r);
  if ((t - 2) % 0.3 > 0.18) return quiet(t, r);
  const ph = 2 * Math.PI * 120 * t;
  return 0.2 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph)) + quiet(t, r);
};

describe('analyzeFrame', () => {
  it('finds the fundamental of a harmonic tone in the cry range', () => {
    const f = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      const ph = (2 * Math.PI * 480 * i) / SR;
      f[i] = 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph));
    }
    const r = analyzeFrame(f, SR);
    expect(r.pitchHz).not.toBeNull();
    expect(Math.abs((r.pitchHz ?? 0) - 480)).toBeLessThan(12);
    expect(r.clarity).toBeGreaterThan(0.9);
  });

  it('reports silence as unvoiced and very quiet', () => {
    const r = analyzeFrame(new Float32Array(FRAME), SR);
    expect(r.pitchHz).toBeNull();
    expect(r.rmsDb).toBeLessThan(-90);
  });
});

describe('CryDetector', () => {
  it('detects a sustained cry within a few seconds of the first burst', () => {
    const out = run(cry, 9);
    const startIdx = out.findIndex((o) => o.events.includes('cry_start'));
    expect(startIdx).toBeGreaterThan(0);
    expect(startIdx * HOP_S).toBeLessThan(2 + 4.5);
    expect(out[out.length - 1].state).toBe('crying');
    expect(out[out.length - 1].cryConfidence).toBeGreaterThan(50);
  });

  it('does not call broadband noise a cry (fans, rain, white-noise machines)', () => {
    const out = run(noise, 10);
    expect(out.some((o) => o.events.includes('cry_start'))).toBe(false);
    expect(out.some((o) => o.state === 'noisy')).toBe(true);
  });

  it('does not call adult speech a cry', () => {
    const out = run(speech, 10);
    expect(out.some((o) => o.events.includes('cry_start'))).toBe(false);
  });

  it('stays calm in a quiet room', () => {
    const out = run(quiet, 8);
    expect(out.every((o) => o.state === 'calm')).toBe(true);
    expect(out.every((o) => o.events.length === 0)).toBe(true);
  });

  it('ignores audio while suppressed (talk-back / soothing sounds)', () => {
    const det = new CryDetector('high');
    det.suppress(60_000, 0);
    const out = run(cry, 8, det);
    expect(out.some((o) => o.events.includes('cry_start'))).toBe(false);
  });

  it('ends an episode after quiet and reports its length', () => {
    const det = new CryDetector('medium');
    const rand = rng(3);
    const frame = new Float32Array(FRAME);
    const events: { t: number; e: string; secs?: number }[] = [];
    for (let t = 0; t < 25; t += HOP_S) {
      const gen = t < 10 ? cry : quiet;
      for (let i = 0; i < FRAME; i++) frame[i] = gen(t + i / SR, rand);
      const o = det.push(analyzeFrame(frame, SR), Math.round(t * 1000));
      for (const e of o.events) events.push({ t, e, secs: o.crySecs });
    }
    const end = events.find((e) => e.e === 'cry_end');
    expect(events[0].e).toBe('cry_start');
    expect(end).toBeDefined();
    expect(end!.secs).toBeGreaterThanOrEqual(3);
  });
});

describe('motion', () => {
  const frame = (fill: (x: number, y: number) => number) => {
    const d = new Uint8ClampedArray(64 * 48 * 4);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++) {
        const v = fill(x, y);
        const i = (y * 64 + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    return lumaOf(d);
  };

  it('ignores global exposure changes', () => {
    const a = frame((x, y) => 60 + ((x * 7 + y * 3) % 20));
    const b = frame((x, y) => 90 + ((x * 7 + y * 3) % 20)); // whole frame brighter
    expect(compareFrames(a, b).motion).toBeLessThan(5);
  });

  it('scores a moving region', () => {
    const a = frame((x, y) => (x > 10 && x < 26 && y > 10 && y < 30 ? 200 : 50));
    const b = frame((x, y) => (x > 30 && x < 46 && y > 12 && y < 32 ? 200 : 50));
    expect(compareFrames(a, b).motion).toBeGreaterThan(30);
  });

  it('reports light level', () => {
    expect(compareFrames(null, frame(() => 20)).light).toBe(20);
  });
});

describe('device naming', () => {
  it('names common devices plainly', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')).toBe('Android phone');
    expect(guessDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('Mac');
  });
});
