// @vitest-environment node
// The two chimes (notify SPEC §5.5): this ports the render loop the Web Audio player schedules (a sine per note and
// partial, a linear attack from 0, then setTargetAtTime's exponential decay; one master gain; a 20 ms linear fade at
// the end) and checks the numbers: both chimes peak at -14 dBFS at Normal and -20 dBFS at Soft, are at most 0.6 s,
// end at silence, and no fundamental sits on another sound of the product.
import { describe, expect, it } from 'vitest';
import { CHIMES, CHIME_FADE_S, CHIME_TARGET_PEAK, CHIME_VOLUME, chimeMasterGain, type ChimeSpec } from './chimeSpec';
import type { ChimeTier } from './types';

const RATE = 48_000;

/** The sum of every partial of every note, before the master gain (what the oscillators feed the master). */
function rawSum(spec: ChimeSpec): Float64Array {
  const n = Math.round(spec.length * RATE);
  const out = new Float64Array(n);
  for (const note of spec.notes) {
    for (const p of spec.partials) {
      const f = note.freq * p.mult;
      const tau = note.tau * p.tauScale;
      for (let i = Math.round(note.at * RATE); i < n; i += 1) {
        const t = i / RATE - note.at;
        const env = t < note.attack ? t / note.attack : Math.exp(-(t - note.attack) / tau);
        out[i] += note.gain * p.gain * env * Math.sin(2 * Math.PI * f * t);
      }
    }
  }
  return out;
}

function render(tier: ChimeTier, volume: keyof typeof CHIME_VOLUME): Float64Array {
  const spec = CHIMES[tier];
  const raw = rawSum(spec);
  const n = raw.length;
  const fadeFrom = n - Math.round(CHIME_FADE_S * RATE);
  const gain = chimeMasterGain(tier, volume);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = raw[i] * gain * (i >= fadeFrom ? (n - i) / (n - fadeFrom) : 1);
  return out;
}

const peak = (a: Float64Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const dbfs = (x: number) => 20 * Math.log10(x);

describe('chimeSpec', () => {
  it('holds the approved preview numbers (rel/PROG/notify chime-preview-v2: ready.wav, needsYou.wav)', () => {
    expect(CHIMES.ready.length).toBe(0.52);
    expect(CHIMES.ready.notes).toEqual([
      { at: 0, freq: 830.61, gain: 1, attack: 0.006, tau: 0.1 },
      { at: 0.1, freq: 1244.51, gain: 0.8, attack: 0.006, tau: 0.11 }
    ]);
    expect(CHIMES.ready.partials).toEqual([
      { mult: 1, gain: 1, tauScale: 1 },
      { mult: 2, gain: 0.16, tauScale: 0.6 },
      { mult: 4, gain: 0.08, tauScale: 0.25 }
    ]);
    expect(CHIMES.needsYou.length).toBe(0.6);
    expect(CHIMES.needsYou.notes).toEqual([
      { at: 0, freq: 523.25, gain: 0.9, attack: 0.012, tau: 0.13 },
      { at: 0.15, freq: 622.25, gain: 1, attack: 0.012, tau: 0.14 }
    ]);
    expect(CHIMES.needsYou.partials).toEqual([
      { mult: 1, gain: 1, tauScale: 1 },
      { mult: 2, gain: 0.1, tauScale: 0.6 }
    ]);
    expect(CHIME_TARGET_PEAK).toBeCloseTo(Math.pow(10, -14 / 20), 10);
    expect(CHIME_VOLUME).toEqual({ soft: 0.5, normal: 1 });
    expect(CHIME_FADE_S).toBe(0.02);
  });

  it('stores each chime’s norm as 1 / its raw peak', () => {
    for (const tier of ['ready', 'needsYou'] as const) {
      const raw = peak(rawSum(CHIMES[tier]));
      expect(CHIMES[tier].rawSumPeak, tier).toBeCloseTo(raw, 3);
      expect(CHIMES[tier].norm, tier).toBeCloseTo(1 / raw, 3);
    }
  });

  it('peaks at -14 dBFS at Normal and -20 dBFS at Soft (± 0.2 dB), both chimes alike', () => {
    for (const tier of ['ready', 'needsYou'] as const) {
      expect(Math.abs(dbfs(peak(render(tier, 'normal'))) - -14), tier).toBeLessThanOrEqual(0.2);
      expect(Math.abs(dbfs(peak(render(tier, 'soft'))) - -20), tier).toBeLessThanOrEqual(0.2);
    }
  });

  it('is short: at most 0.6 s, and the last 20 ms fade to silence', () => {
    for (const tier of ['ready', 'needsYou'] as const) {
      expect(CHIMES[tier].length, tier).toBeLessThanOrEqual(0.6);
      const pcm = render(tier, 'normal');
      expect(Math.abs(pcm[pcm.length - 1]), tier).toBeLessThan(1e-3);
      // The fade starts 20 ms before the end and only ever brings the level down.
      const fadeFrom = pcm.length - Math.round(CHIME_FADE_S * RATE);
      const before = peak(pcm.slice(fadeFrom - Math.round(0.02 * RATE), fadeFrom));
      expect(peak(pcm.slice(pcm.length - Math.round(0.005 * RATE))), tier).toBeLessThan(before);
    }
  });

  it('no fundamental within 15 Hz of Stream Studio’s tones (740, 784, 1047 Hz) or the classic beep (987.77 Hz)', () => {
    const taken = [740, 784, 987.77, 1047];
    for (const tier of ['ready', 'needsYou'] as const) {
      for (const note of CHIMES[tier].notes) {
        for (const hz of taken) expect(Math.abs(note.freq - hz), `${tier} ${note.freq} vs ${hz}`).toBeGreaterThan(15);
      }
    }
  });

  it('the master gain is volume × target peak × norm', () => {
    expect(chimeMasterGain('ready', 'normal')).toBeCloseTo(CHIME_TARGET_PEAK * CHIMES.ready.norm, 10);
    expect(chimeMasterGain('needsYou', 'soft')).toBeCloseTo(0.5 * CHIME_TARGET_PEAK * CHIMES.needsYou.norm, 10);
  });
});
