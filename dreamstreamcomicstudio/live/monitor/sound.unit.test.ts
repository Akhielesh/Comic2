// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { AlarmToneDetector } from './alarmTone';
import { AlertCues, DEFAULT_CUES, alertInfo, loadCues } from './alerts';
import { RollingWindow, StreamResampler } from './resample';
import { SoundBrain, type BrainEvent, type BrainFrame } from './soundBrain';
import { SOUND_INFO, scoreRow, scoreRows, soundHeadline, type CatScores } from './soundClasses';

const sine = (hz: number, sr: number, secs: number, amp = 0.5) => {
  const x = new Float32Array(Math.round(sr * secs));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return x;
};
const rms = (x: Float32Array, from = 0) => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length - from));
};
const zeroCrossings = (x: Float32Array) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
  return n;
};

describe('StreamResampler', () => {
  it('converts 48 kHz to 16 kHz keeping pitch and level', () => {
    const r = new StreamResampler(48_000, 16_000);
    const x = sine(1000, 48_000, 1);
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 997) parts.push(r.push(x.subarray(i, i + 997))); // odd chunk sizes
    const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      y.set(p, o);
      o += p.length;
    }
    expect(y.length).toBeGreaterThan(15_950);
    expect(y.length).toBeLessThanOrEqual(16_000);
    expect(zeroCrossings(y) / (y.length / 16_000)).toBeGreaterThan(1990); // ≈ 2 per cycle × 1000 Hz
    expect(zeroCrossings(y) / (y.length / 16_000)).toBeLessThan(2010);
    expect(rms(y, 100)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it('removes tones above the new Nyquist instead of aliasing them', () => {
    const y = new StreamResampler(48_000, 16_000).push(sine(12_000, 48_000, 0.5));
    expect(rms(y, 100)).toBeLessThan(0.02);
  });

  it('handles 44.1 kHz input', () => {
    const y = new StreamResampler(44_100, 16_000).push(sine(440, 44_100, 1));
    expect(Math.abs(y.length - 16_000)).toBeLessThan(10);
  });
});

describe('RollingWindow', () => {
  it('keeps the newest samples and counts fresh ones', () => {
    const w = new RollingWindow(4);
    w.push(Float32Array.from([1, 2, 3]));
    expect(w.full).toBe(false);
    w.push(Float32Array.from([4, 5]));
    expect(w.full).toBe(true);
    expect(w.fresh).toBe(5);
    expect(Array.from(w.take())).toEqual([2, 3, 4, 5]);
    expect(w.fresh).toBe(0);
    w.push(Float32Array.from([6, 7, 8, 9, 10]));
    expect(Array.from(w.take())).toEqual([7, 8, 9, 10]);
  });
});

describe('sound categories', () => {
  it('maps YAMNet classes with weights', () => {
    const row = new Float32Array(521);
    row[20] = 0.8; // Baby cry
    row[22] = 0.9; // Wail → cry ×0.6 = 0.54
    row[382] = 1; // generic Alarm (down-weighted)
    row[393] = 0.2; // Smoke detector
    const s = scoreRow(row);
    expect(s.cry).toBeCloseTo(0.8);
    expect(s.alarm).toBeCloseTo(0.25);
    expect(s.loud).toBe(0);
  });

  it('takes the max over several rows', () => {
    const data = new Float32Array(521 * 2);
    data[42] = 0.2;
    data[521 + 42] = 0.7; // Cough in the second hop
    expect(scoreRows(data, 2).cough).toBeCloseTo(0.7);
  });

  it('personalizes headlines', () => {
    expect(soundHeadline('cry', 'Aria')).toBe('Aria is crying');
    expect(soundHeadline('cry', '')).toBe('Baby is crying');
    expect(SOUND_INFO.alarm.severity).toBe('urgent');
  });
});

/* ------------------------------------------------------------ brain */

const zero = (): CatScores => ({ cry: 0, fuss: 0, cough: 0, babble: 0, laugh: 0, voices: 0, music: 0, alarm: 0, crash: 0, loud: 0, dog: 0, ambient: 0, silence: 0 });

/** Drive the brain at 10 Hz for `secs`, with model output every 0.48 s. */
function run(brain: SoundBrain, clock: { t: number }, secs: number, frame: Partial<BrainFrame>, scores?: Partial<CatScores> | null): BrainEvent[] {
  const out: BrainEvent[] = [];
  const steps = Math.round(secs * 10);
  for (let i = 0; i < steps; i++) {
    clock.t += 100;
    const hop = scores !== undefined && scores !== null && clock.t % 500 === 0;
    out.push(
      ...brain.update(
        { level: 20, heur: 'calm', heurCryConf: 0, alarmTone: false, motion: 0, ...frame, scores: hop ? { ...zero(), ...scores } : null },
        clock.t,
      ),
    );
  }
  return out;
}

describe('SoundBrain', () => {
  it('starts a cry after it persists, ends it after a quiet hold, and reports duration', () => {
    const b = new SoundBrain();
    const c = { t: 0 };
    const start = run(b, c, 4, {}, { cry: 0.9 });
    expect(start.map((e) => `${e.phase}:${e.cat}`)).toEqual(['start:cry']);
    expect(start[0].via).toBe('ai');
    expect(b.state(c.t).mood).toBe('crying');
    run(b, c, 6, {}, { cry: 0.9 });
    const end = run(b, c, 10, {}, { cry: 0 });
    expect(end.map((e) => `${e.phase}:${e.cat}`)).toEqual(['end:cry']);
    expect(end[0].secs).toBeGreaterThanOrEqual(8);
    expect(b.state(c.t).mood).toBe('calm');
  });

  it('ignores recognized sounds that are barely audible (another room)', () => {
    const b = new SoundBrain();
    const ev = run(b, { t: 0 }, 5, { level: 2 }, { cry: 0.95 });
    expect(ev).toEqual([]);
  });

  it('names one sound: a cry is not also babbling or voices', () => {
    const b = new SoundBrain();
    const ev = run(b, { t: 0 }, 6, {}, { cry: 0.9, babble: 0.8, voices: 0.9, laugh: 0.6 });
    expect(ev.map((e) => e.cat)).toEqual(['cry']);
  });

  it('keeps cooldown repeats silent but still shows the mood', () => {
    const b = new SoundBrain();
    const c = { t: 0 };
    expect(run(b, c, 6, {}, { babble: 0.7 }).map((e) => e.phase)).toEqual(['start']);
    run(b, c, 10, {}, { babble: 0 }); // ends
    const again = run(b, c, 6, {}, { babble: 0.7 }); // within 20 min
    expect(again).toEqual([]);
    expect(b.state(c.t).mood).toBe('awake');
  });

  it('suppresses baby sounds while a parent talks, but never an alarm', () => {
    const b = new SoundBrain();
    const c = { t: 0 };
    b.suppress(30_000, c.t);
    expect(run(b, c, 5, {}, { cry: 0.95 })).toEqual([]);
    const ev = run(b, c, 4, { alarmTone: true }, { cry: 0.95 });
    expect(ev.map((e) => `${e.cat}:${e.via}`)).toEqual(['alarm:alarm-pattern']);
  });

  it('falls back to the cry analyser when the model is not running', () => {
    const b = new SoundBrain();
    const ev = run(b, { t: 0 }, 4, { heur: 'crying', heurCryConf: 70 }, null);
    expect(ev.map((e) => `${e.cat}:${e.via}`)).toEqual(['cry:cry-analyser']);
    expect(b.state(4000).ai).toBe(false);
  });

  it('does not let the cry analyser override a model that hears adult voices', () => {
    const b = new SoundBrain();
    const ev = run(b, { t: 0 }, 5, { heur: 'crying', heurCryConf: 80 }, { cry: 0.2, voices: 0.9 });
    expect(ev.map((e) => e.cat)).not.toContain('cry');
  });

  it('flags a sustained loud sound nothing else explains', () => {
    const b = new SoundBrain();
    const ev = run(b, { t: 0 }, 4, { level: 32 }, null);
    expect(ev.map((e) => `${e.cat}:${e.via}`)).toEqual(['loud:loudness']);
  });

  it('reports what the model hears and the most important sound', () => {
    const b = new SoundBrain();
    const c = { t: 0 };
    run(b, c, 5, {}, { cough: 0.95, babble: 0.4 });
    const s = b.state(c.t);
    expect(s.sound).toBe('cough');
    expect(s.top[0]).toEqual(['cough', 95]);
    expect(s.ai).toBe(true);
  });
});

/* ------------------------------------------------------- alarm tone */

const BIN_HZ = 48_000 / 2048;
function spectrum(toneHz: number | null): Float32Array {
  const s = new Float32Array(1024).fill(-95);
  for (let i = 0; i < s.length; i++) s[i] = -95 + 6 * Math.sin(i * 1.7); // uneven background
  if (toneHz) {
    const b = Math.round(toneHz / BIN_HZ);
    s[b] = -20;
    s[b - 1] = -32;
    s[b + 1] = -32;
  }
  return s;
}

function playPattern(d: AlarmToneDetector, pattern: [number, number][], hz: number, start = 0): { t: number; active: boolean } {
  let t = start;
  let active = false;
  for (const [on, off] of pattern) {
    for (let x = 0; x < on; x += 50) active = d.push(spectrum(hz), BIN_HZ, (t += 50)).active || active;
    for (let x = 0; x < off; x += 50) active = d.push(spectrum(null), BIN_HZ, (t += 50)).active || active;
  }
  return { t, active };
}

describe('AlarmToneDetector', () => {
  it('recognizes the smoke-alarm temporal-three pattern', () => {
    const d = new AlarmToneDetector();
    const r = playPattern(d, [[500, 500], [500, 500], [500, 1500]], 3150);
    expect(r.active).toBe(true);
    expect(d.push(spectrum(null), BIN_HZ, r.t + 50).pattern).toBe('T3');
  });

  it('recognizes the CO-alarm temporal-four pattern', () => {
    const d = new AlarmToneDetector();
    const r = playPattern(d, [[100, 100], [100, 100], [100, 100], [100, 5000]], 3400);
    expect(r.active).toBe(true);
  });

  it('ignores single beeps, slow beeping and tones outside the alarm band', () => {
    expect(playPattern(new AlarmToneDetector(), [[200, 3000]], 3150).active).toBe(false); // microwave beep
    expect(playPattern(new AlarmToneDetector(), [[500, 2000], [500, 2000], [500, 2000]], 3150).active).toBe(false);
    expect(playPattern(new AlarmToneDetector(), [[500, 500], [500, 500], [500, 500]], 1000).active).toBe(false);
  });

  it('needs a pure tone, not broadband noise', () => {
    expect(AlarmToneDetector.toneOf(spectrum(null), BIN_HZ)).toBeNull();
    expect(AlarmToneDetector.toneOf(spectrum(3150), BIN_HZ)).toBeGreaterThan(3000);
  });
});

/* ------------------------------------------------------------- cues */

describe('alert cues', () => {
  it('keeps smoke/CO alarms on no matter what was saved', () => {
    localStorage.setItem('ds-monitor-cues', JSON.stringify({ sound: false, cats: { alarm: false, cry: false } }));
    const p = loadCues();
    expect(p.sound).toBe(false);
    expect(p.cats.alarm).toBe(true);
    expect(p.cats.cry).toBe(false);
    expect(p.cats.cough).toBe(DEFAULT_CUES.cats.cough);
    localStorage.removeItem('ds-monitor-cues');
  });

  it('respects per-category choices and snoozes, except for alarms', () => {
    const c = new AlertCues();
    c.prefs = { ...DEFAULT_CUES, sound: false, vibrate: false, cats: { ...DEFAULT_CUES.cats, babble: false } };
    expect(c.enabled('cry')).toBe(true);
    expect(c.enabled('babble')).toBe(false);
    c.snooze('cry', 5);
    expect(c.isSnoozed('cry')).toBe(true);
    c.raise('k1', 'cry', 'Aria is crying');
    expect(c.anyRinging).toBe(false); // snoozed
    c.raise('k2', 'alarm', 'Alarm');
    expect(c.anyRinging).toBe(true); // alarms ignore snooze
    c.acked();
    expect(c.anyRinging).toBe(false);
    c.close();
  });

  it('describes camera alerts too', () => {
    expect(alertInfo('offline').severity).toBe('high');
    expect(alertInfo('cough').label).toBe('Coughing');
  });
});
