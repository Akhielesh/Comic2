// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createJitter, muLawDecode, muLawEncode, muLawEncodeAll, relayPlayerSource, SOUND_RATE, SoundPacker } from './relayAudio';

describe('μ-law (G.711)', () => {
  it('matches the standard code points', () => {
    expect(muLawEncode(0)).toBe(0xff);
    expect(muLawEncode(1)).toBe(0x80);
    expect(muLawEncode(-1)).toBe(0x00);
    const d = muLawDecode(Uint8Array.of(0xff, 0x7f, 0x80, 0x00));
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(-0);
    expect(Math.round(d[2] * 32768)).toBe(32124);
    expect(Math.round(d[3] * 32768)).toBe(-32124);
  });

  it('round-trips within μ-law’s step size (about 6 % of the level, never worse than 1/1000 of full scale near silence)', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = i / 1000;
      const y = muLawDecode(Uint8Array.of(muLawEncode(x)))[0];
      expect(Math.abs(y - x)).toBeLessThanOrEqual(Math.max(0.001, Math.abs(x) * 0.065));
    }
    // Clipping, not wrapping.
    expect(muLawEncode(3)).toBe(muLawEncode(1));
    expect(muLawEncodeAll(Float32Array.of(0, 1, -1))).toEqual(Uint8Array.of(0xff, 0x80, 0x00));
  });
});

describe('SoundPacker (camera)', () => {
  const tone = (n: number, rate: number, f = 440) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / rate));

  it('turns the microphone’s rate into 8 kHz μ-law and hands over what piled up', () => {
    const p = new SoundPacker();
    for (let i = 0; i < 10; i++) p.push(tone(480, 48_000), 48_000); // 100 ms at 48 kHz
    expect(p.pendingMs).toBeGreaterThan(95);
    expect(p.pendingMs).toBeLessThanOrEqual(100);
    const b = p.take()!;
    expect(Math.abs(b.length - 800)).toBeLessThan(10); // ~100 ms at 8 kHz, one byte a sample
    expect(p.take()).toBeNull();
    // The tone survives (not silence, not clipped).
    const x = muLawDecode(b);
    const peak = Math.max(...x.map(Math.abs));
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.6);
  });

  it('keeps at most the newest second, and forgets everything on clear (privacy)', () => {
    const p = new SoundPacker();
    for (let i = 0; i < 30; i++) p.push(tone(4410, 44_100), 44_100); // 3 s
    expect(p.pendingMs).toBeLessThanOrEqual(1000);
    expect(p.pendingMs).toBeGreaterThan(800);
    p.clear();
    expect(p.take()).toBeNull();
  });
});

describe('jitter buffer (viewer, runs in the audio thread)', () => {
  const OUT = 48_000;
  const block = () => new Float32Array(128);
  /** ms of 8 kHz sound */
  const chunk = (ms: number, v = 0.5) => new Float32Array((SOUND_RATE * ms) / 1000).fill(v);
  const pullMs = (j: ReturnType<typeof createJitter>, ms: number) => {
    const out: number[] = [];
    for (let i = 0; i < Math.round((OUT * ms) / 1000 / 128); i++) {
      const b = block();
      j.pull(b);
      out.push(...b);
    }
    return out;
  };

  it('stays silent until 300 ms are buffered, then plays', () => {
    const j = createJitter(OUT, SOUND_RATE, 300);
    j.push(chunk(200));
    expect(pullMs(j, 50).every((v) => v === 0)).toBe(true);
    expect(j.stats().playing).toBe(false);
    j.push(chunk(150));
    const out = pullMs(j, 50);
    expect(j.stats().playing).toBe(true);
    expect(out.at(-1)).toBeCloseTo(0.5, 5); // past the short fade-in
  });

  it('runs dry → silence and re-buffers (counts the underrun)', () => {
    const j = createJitter(OUT, SOUND_RATE, 300);
    j.push(chunk(320));
    pullMs(j, 400);
    expect(j.stats()).toMatchObject({ playing: false, underruns: 1 });
    j.push(chunk(100));
    expect(pullMs(j, 20).every((v) => v === 0)).toBe(true); // waits for 300 ms again
  });

  it('holds the delay near the target: speeds up a little when too much piles up', () => {
    const j = createJitter(OUT, SOUND_RATE, 300);
    j.push(chunk(700)); // 400 ms more than wanted
    pullMs(j, 100);
    const before = j.stats().ms;
    // Feed exactly real time for 2 s: a plain 1.0× player would stay ~400 ms over.
    for (let i = 0; i < 20; i++) {
      j.push(chunk(100));
      pullMs(j, 100);
    }
    expect(j.stats().ms).toBeLessThan(before - 30);
  });

  it('a second behind (a burst after a stall) jumps to the newest sound', () => {
    const j = createJitter(OUT, SOUND_RATE, 300);
    j.push(chunk(2500));
    pullMs(j, 10);
    expect(j.stats().ms).toBeLessThanOrEqual(310);
  });

  it('the worklet source is self-contained and runs as an AudioWorkletProcessor', () => {
    const src = relayPlayerSource();
    let Proc: (new (o: unknown) => { port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void }; process: (i: unknown, o: Float32Array[][]) => boolean }) | null = null;
    class AudioWorkletProcessor {
      port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (_m: unknown) => undefined };
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', src)(AudioWorkletProcessor, (_n: string, c: typeof Proc) => (Proc = c), OUT);
    expect(Proc).not.toBeNull();
    const p = new Proc!({ processorOptions: { inRate: SOUND_RATE, targetMs: 300 } });
    p.port.onmessage!({ data: chunk(400, 0.25) });
    const out = [[new Float32Array(128)]];
    for (let i = 0; i < 20; i++) expect(p.process([], out)).toBe(true);
    expect(out[0][0][127]).toBeCloseTo(0.25, 5);
  });
});
