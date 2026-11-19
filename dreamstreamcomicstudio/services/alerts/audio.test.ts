// The audio lifecycle (notify SPEC §5.6) on a fake AudioContext: no context before a person's gesture or while the sound
// is off; one is made, resumed and suspended inside the first gesture (ambient audio session where the browser has
// one); it is resumed only to play and suspended again when the chime ends; a context the browser keeps suspended plays
// nothing; a browser without Web Audio never throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armAudioUnlock, audioContext, closeAudio, syncAudioToSound, unlockAudio, __resetAudioForTests } from './audio';
import { playChime } from './chime';
import { CHIMES } from './chimeSpec';

interface FakeParam {
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
}
const param = (): FakeParam => ({ setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() });

interface FakeOsc {
  type: string;
  frequency: FakeParam;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

let resumable = true;
const made: FakeCtx[] = [];
class FakeCtx {
  state: AudioContextState = 'suspended';
  currentTime = 1;
  destination = {};
  oscillators: FakeOsc[] = [];
  gains: { gain: FakeParam; connect: ReturnType<typeof vi.fn> }[] = [];
  resume = vi.fn(async () => {
    if (resumable && this.state !== 'closed') this.state = 'running';
  });
  suspend = vi.fn(async () => {
    if (this.state !== 'closed') this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createOscillator = vi.fn(() => {
    const osc: FakeOsc = { type: 'sine', frequency: param(), connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.oscillators.push(osc);
    return osc;
  });
  createGain = vi.fn(() => {
    const g = { gain: param(), connect: vi.fn() };
    this.gains.push(g);
    return g;
  });
  constructor() {
    made.push(this);
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};
const press = () => window.dispatchEvent(new Event('pointerdown'));

beforeEach(() => {
  made.length = 0;
  resumable = true;
  __resetAudioForTests();
  vi.stubGlobal('AudioContext', FakeCtx);
});
afterEach(() => {
  __resetAudioForTests();
  vi.unstubAllGlobals();
  delete (navigator as { audioSession?: unknown }).audioSession;
});

describe('audio unlock', () => {
  it('creates nothing before a gesture, and plays nothing then', async () => {
    const off = armAudioUnlock();
    expect(made).toHaveLength(0);
    expect(await playChime('ready', 'normal')).toBe(false);
    expect(made).toHaveLength(0);
    off();
  });

  it('creates nothing while the sound is off, even on a press', () => {
    syncAudioToSound(false);
    press();
    expect(made).toHaveLength(0);
    expect(audioContext()).toBeNull();
  });

  it('the first press creates the context, resumes it inside the gesture, then suspends it; later presses add nothing', async () => {
    syncAudioToSound(true);
    press();
    expect(made).toHaveLength(1);
    const ctx = made[0];
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    await flush();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('suspended');
    press();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(made).toHaveLength(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('a key press unlocks too; the audio session is set to ambient where the browser has one', () => {
    (navigator as { audioSession?: { type: string } }).audioSession = { type: 'auto' };
    armAudioUnlock();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(made).toHaveLength(1);
    expect((navigator as unknown as { audioSession: { type: string } }).audioSession.type).toBe('ambient');
  });

  it('turning the sound off closes the context; on again re-arms for the next press', async () => {
    syncAudioToSound(true);
    press();
    const ctx = made[0];
    syncAudioToSound(false);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(audioContext()).toBeNull();
    syncAudioToSound(true);
    expect(made).toHaveLength(1);
    press();
    expect(made).toHaveLength(2);
  });

  it('closeAudio (sign-out) closes it and removes the listener', () => {
    armAudioUnlock();
    closeAudio();
    press();
    expect(made).toHaveLength(0);
    unlockAudio();
    const ctx = made[0];
    closeAudio();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('never throws when the browser has no Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    armAudioUnlock();
    expect(() => press()).not.toThrow();
    expect(unlockAudio()).toBeNull();
    expect(await playChime('needsYou', 'soft')).toBe(false);
    vi.stubGlobal('AudioContext', function Broken() {
      throw new Error('NotAllowed');
    });
    expect(() => unlockAudio()).not.toThrow();
  });
});

describe('playChime', () => {
  it('resumes before it plays, schedules every note and partial, and suspends when the last one ends', async () => {
    unlockAudio();
    await flush();
    const ctx = made[0];
    ctx.resume.mockClear();
    ctx.suspend.mockClear();
    const played = playChime('ready', 'normal');
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).not.toHaveBeenCalled(); // nothing is scheduled before the context runs
    expect(await played).toBe(true);
    const spec = CHIMES.ready;
    expect(ctx.oscillators).toHaveLength(spec.notes.length * spec.partials.length);
    expect(ctx.oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(spec.notes[0].freq, ctx.currentTime);
    for (const osc of ctx.oscillators) expect(osc.stop).toHaveBeenCalledWith(ctx.currentTime + spec.length);
    expect(ctx.suspend).not.toHaveBeenCalled();
    ctx.oscillators.slice(0, -1).forEach((o) => o.onended?.());
    expect(ctx.suspend).not.toHaveBeenCalled();
    ctx.oscillators.at(-1)!.onended?.();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
  });

  it('two chimes in a row keep the context running until the second ends', async () => {
    unlockAudio();
    await flush();
    const ctx = made[0];
    ctx.suspend.mockClear();
    await playChime('ready', 'normal');
    await playChime('needsYou', 'normal', { after: 0.75 });
    const first = ctx.oscillators.slice(0, CHIMES.ready.notes.length * CHIMES.ready.partials.length);
    first.at(-1)!.onended?.();
    expect(ctx.suspend).not.toHaveBeenCalled();
    ctx.oscillators.at(-1)!.onended?.();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.oscillators.at(-1)!.start).toHaveBeenCalledWith(ctx.currentTime + 0.75 + CHIMES.needsYou.notes[1].at);
  });

  it('skips the sound when the browser keeps the context suspended', async () => {
    unlockAudio();
    await flush();
    resumable = false;
    const ctx = made[0];
    expect(await playChime('needsYou', 'normal')).toBe(false);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });
});
