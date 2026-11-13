// The microphone is never left on. A fake getUserMedia hands out fake tracks, a fake AudioContext stands in for
// the browser's, and the real recorder (services/dictation/recorder.ts) runs between them; only the model is
// faked. Every test fails on the old hook: it opened the mic in parallel with the model download, reset its one
// "cancelled" flag on the next tap, ignored a tap during "Preparing…", never stopped on a hidden tab or a limit,
// left the Web Speech clock running after an error, and never said why a take ended.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  ready: false,
  loads: [] as Array<{ resolve: (asr: unknown) => void; reject: (e: unknown) => void }>,
  text: 'make it rain'
}));

vi.mock('../services/dictation/whisperEngine', () => ({
  whisperReady: () => model.ready,
  loadWhisper: () =>
    model.ready
      ? Promise.resolve(async () => ({ text: model.text }))
      : new Promise((resolve, reject) => {
          model.loads.push({ resolve, reject });
        }),
  transcribe: async () => model.text
}));

import { TAKE_LIMIT_MS, useDictation, type FinalInfo } from './useDictation';
import { voiceAutoSend } from '../services/dictation/autoSend';

// ---- Fake microphone --------------------------------------------------------

class FakeTrack extends EventTarget {
  stopped = false;
  readyState: 'live' | 'ended' = 'live';
  onended: ((e: Event) => void) | null = null;
  stop = vi.fn(() => {
    // Like a real track, our own stop() never fires `ended`.
    this.stopped = true;
    this.readyState = 'ended';
  });
  /** The browser ends the track itself: permission revoked in site settings, the device unplugged. */
  endByBrowser() {
    this.readyState = 'ended';
    const e = new Event('ended');
    this.onended?.(e);
    this.dispatchEvent(e);
  }
}

const mic = {
  tracks: [] as FakeTrack[],
  calls: 0,
  /** 'auto' answers at once; 'manual' waits for answer(); 'deny' rejects like a blocked permission. */
  mode: 'auto' as 'auto' | 'manual' | 'deny',
  waiting: [] as Array<() => void>
};

const getUserMedia = vi.fn(() => {
  mic.calls += 1;
  if (mic.mode === 'deny') return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  const hand = () => {
    const track = new FakeTrack();
    mic.tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  };
  if (mic.mode === 'auto') return Promise.resolve(hand());
  return new Promise<MediaStream>((resolve) => mic.waiting.push(() => resolve(hand())));
});

const liveTracks = () => mic.tracks.filter((t) => !t.stopped);

const contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 48000;
  destination = {};
  constructor() {
    contexts.push(this);
  }
  suspend = vi.fn(async () => {
    if (this.state !== 'closed') this.state = 'suspended';
  });
  resume = vi.fn(async () => {
    if (this.state !== 'closed') this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  createScriptProcessor = () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null });
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
}
const openContexts = () => contexts.filter((c) => c.state !== 'closed');

// ---- Fake browser dictation -------------------------------------------------

const recognisers: FakeRecognition[] = [];
class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    recognisers.push(this);
  }
  start = vi.fn();
  stop = vi.fn(() => queueMicrotask(() => this.onend?.()));
  abort = vi.fn(() => queueMicrotask(() => this.onend?.()));
  /** The browser hears a final phrase. */
  hear(text: string) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }
}

// ---- Harness ----------------------------------------------------------------

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const setup = (engine: 'whisper' | 'webspeech' = 'whisper') => {
  localStorage.setItem('ds.dictation.v1', JSON.stringify({ engine, model: 'base' }));
  const onFinal = vi.fn<(text: string, info: FinalInfo) => void>();
  const onPartial = vi.fn();
  const hook = renderHook(() => useDictation({ onPartial, onFinal }));
  return { ...hook, onFinal, onPartial };
};

beforeEach(() => {
  vi.useFakeTimers();
  model.ready = false;
  model.loads = [];
  mic.tracks = [];
  mic.calls = 0;
  mic.mode = 'auto';
  mic.waiting = [];
  contexts.length = 0;
  recognisers.length = 0;
  getUserMedia.mockClear();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('useDictation: the microphone is never left on', () => {
  it('a failed model download never turns the mic on, and says so in one calm sentence', async () => {
    const { result } = setup();
    act(() => result.current.start());
    expect(result.current.status).toBe('starting');
    expect(getUserMedia).not.toHaveBeenCalled(); // prepare first, then open the mic
    await act(async () => model.loads[0].reject(new TypeError('Failed to fetch')));
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(liveTracks()).toHaveLength(0);
    expect(openContexts()).toHaveLength(0);
    expect(result.current.status).toBe('error');
    expect(result.current.errorInfo).toMatchObject({ code: 'model-download', action: 'retry' });
    expect(result.current.errorInfo?.message).toBe("The voice model didn't download, so your microphone stayed off.");
    expect(result.current.errorInfo?.detail).toContain('TypeError: Failed to fetch');
  });

  it('Cancel during the download: the mic never opens, then or when the download finishes', async () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(liveTracks()).toHaveLength(0);
    expect(openContexts()).toHaveLength(0);
    await act(async () => model.loads[0].resolve(async () => ({ text: 'x' })));
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(liveTracks()).toHaveLength(0);
    expect(result.current.status).toBe('idle');
  });

  it('tapping the mic while it prepares cancels, so recording never starts after the download', async () => {
    const { result } = setup();
    act(() => result.current.start());
    act(() => result.current.stop()); // the busy mic's tap
    expect(result.current.status).toBe('idle');
    await act(async () => model.loads[0].resolve(async () => ({ text: 'x' })));
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('Cancel, tap again, and the first take’s mic arrives late: it is stopped at once and one mic stays live', async () => {
    model.ready = true;
    mic.mode = 'manual';
    const { result } = setup();
    act(() => result.current.start());
    await flush();
    expect(mic.waiting).toHaveLength(1);
    act(() => result.current.cancel());
    act(() => result.current.start());
    await flush();
    expect(mic.waiting).toHaveLength(2);
    await act(async () => mic.waiting[0]()); // the first take's stream lands after its cancel
    await flush();
    await act(async () => mic.waiting[1]());
    await flush();
    expect(mic.tracks).toHaveLength(2);
    expect(mic.tracks[0].stop).toHaveBeenCalled();
    expect(liveTracks()).toEqual([mic.tracks[1]]);
    expect(result.current.status).toBe('recording');
    act(() => result.current.cancel());
    expect(liveTracks()).toHaveLength(0);
    expect(openContexts()).toHaveLength(0);
  });

  it('unmount during the download or while recording: every started track stops and nothing reopens', async () => {
    const first = setup();
    act(() => first.result.current.start());
    first.unmount();
    await act(async () => model.loads[0].resolve(async () => ({ text: 'x' })));
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();

    model.ready = true;
    const second = setup();
    act(() => second.result.current.start());
    await flush();
    expect(second.result.current.status).toBe('recording');
    expect(liveTracks()).toHaveLength(1);
    second.unmount();
    expect(mic.tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
    expect(openContexts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hidden tab stops the take: the mic closes and the words are kept, marked "hidden"', async () => {
    model.ready = true;
    const { result, onFinal } = setup();
    act(() => result.current.start());
    await flush();
    expect(liveTracks()).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(liveTracks()).toHaveLength(0);
    await flush();
    expect(onFinal).toHaveBeenCalledWith('make it rain', { end: 'hidden', engine: 'whisper' });
    expect(result.current.status).toBe('idle');
  });

  it('the take limit stops the mic and keeps the words, marked "limit"', async () => {
    model.ready = true;
    const { result, onFinal } = setup();
    act(() => result.current.start());
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TAKE_LIMIT_MS + 500);
    });
    expect(liveTracks()).toHaveLength(0);
    expect(onFinal).toHaveBeenCalledWith('make it rain', { end: 'limit', engine: 'whisper' });
  });

  it('Done says "user" and Esc says "escape", and both close the mic', async () => {
    model.ready = true;
    const { result, onFinal } = setup();
    act(() => result.current.start());
    await flush();
    act(() => result.current.stop());
    expect(liveTracks()).toHaveLength(0);
    await flush();
    expect(onFinal).toHaveBeenLastCalledWith('make it rain', { end: 'user', engine: 'whisper' });

    act(() => result.current.start());
    await flush();
    act(() => result.current.stop('escape'));
    await flush();
    expect(onFinal).toHaveBeenLastCalledWith('make it rain', { end: 'escape', engine: 'whisper' });
    expect(liveTracks()).toHaveLength(0);
  });

  it('a blocked microphone says what to do and offers "Try again" (a button cannot unblock it)', async () => {
    model.ready = true;
    mic.mode = 'deny';
    const { result } = setup();
    act(() => result.current.start());
    await flush();
    expect(result.current.status).toBe('error');
    expect(result.current.errorInfo).toMatchObject({ code: 'mic-blocked', action: 'retry', tone: 'error' });
    expect(result.current.errorInfo?.message).toBe("To talk, allow the microphone for this site in your browser's settings, then try again.");
    expect(result.current.errorInfo?.detail).toBe('mic-blocked · NotAllowedError: Permission denied');
    expect(openContexts()).toHaveLength(0);
  });
});

describe('useDictation: browser dictation', () => {
  it('an error then the end event leaves no timer running', async () => {
    const { result } = setup('webspeech');
    act(() => result.current.start());
    expect(result.current.status).toBe('recording');
    const rec = recognisers[0];
    act(() => {
      rec.onerror?.({ error: 'network' });
      rec.onend?.();
    });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.status).toBe('error');
    expect(result.current.errorInfo?.code).toBe('offline');
  });

  it('when the browser ends on its own the words are delivered as "engine"; Done delivers "user"', async () => {
    const { result, onFinal } = setup('webspeech');
    act(() => result.current.start());
    act(() => recognisers[0].hear('swap pages two and three'));
    await act(async () => recognisers[0].onend?.()); // the browser's own end (a pause, a session limit)
    expect(onFinal).toHaveBeenLastCalledWith('swap pages two and three', { end: 'engine', engine: 'browser-cloud' });

    act(() => result.current.start());
    act(() => recognisers[1].hear('make it a whisper'));
    act(() => result.current.stop());
    await flush();
    expect(onFinal).toHaveBeenLastCalledWith('make it a whisper', { end: 'user', engine: 'browser-cloud' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a browser that never ends after our stop is ended for it, so its mic cannot stay on', async () => {
    const { result, onFinal } = setup('webspeech');
    act(() => result.current.start());
    const rec = recognisers[0];
    rec.stop.mockImplementation(() => undefined); // never fires `end`
    rec.abort.mockImplementation(() => undefined);
    act(() => rec.hear('add a cat'));
    act(() => result.current.stop());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(rec.abort).toHaveBeenCalled();
    // The browser never confirmed its last words, so the take is not a clean Done: it waits for the person.
    expect(onFinal).toHaveBeenLastCalledWith('add a cat', { end: 'engine', engine: 'browser-cloud' });
    expect(result.current.status).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('when the browser never ends after Done, the words still being heard are kept and nothing can send by itself', async () => {
    const { result, onFinal } = setup('webspeech');
    act(() => result.current.start());
    const rec = recognisers[0];
    rec.stop.mockImplementation(() => undefined); // the browser never answers our stop with `end`
    rec.abort.mockImplementation(() => undefined);
    act(() => {
      // Final "make the cover blue", still-interim " but not page two" (the bar shows both as heard).
      rec.onresult?.({
        resultIndex: 0,
        results: [
          Object.assign([{ transcript: 'make the cover blue' }], { isFinal: true }),
          Object.assign([{ transcript: ' but not page two' }], { isFinal: false })
        ]
      });
    });
    act(() => result.current.stop()); // Done
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    const [text, info] = onFinal.mock.calls.at(-1)!;
    // The person saw "make the cover blue but not page two": the box never gets a shorter, different instruction.
    expect(text).toBe('make the cover blue but not page two');
    expect(info).toEqual({ end: 'engine', engine: 'browser-cloud' });
    // With "Send when I tap Done" on, a take the browser never finished still waits.
    expect(voiceAutoSend({ chosen: true, info, text, lang: 'en-US' })).toBe('wait');
  });
});

describe('useDictation: the bar never says Listening once the microphone is gone', () => {
  it('the browser ends the track mid-take (permission revoked, device unplugged): the take ends, marked "device", and the words are kept', async () => {
    model.ready = true;
    const { result, onFinal } = setup('whisper');
    act(() => result.current.start());
    await flush();
    expect(result.current.status).toBe('recording');
    act(() => mic.tracks[0].endByBrowser());
    expect(result.current.status).not.toBe('recording');
    await flush();
    expect(result.current.status).toBe('idle');
    expect(openContexts()).toHaveLength(0);
    expect(onFinal).toHaveBeenCalledWith('make it rain', { end: 'device', engine: 'whisper' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('our own stop never counts as the device going away', async () => {
    model.ready = true;
    const { result, onFinal } = setup('whisper');
    act(() => result.current.start());
    await flush();
    act(() => result.current.stop());
    await flush();
    mic.tracks[0].endByBrowser(); // a late `ended` after the take is over changes nothing
    await flush();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal).toHaveBeenLastCalledWith('make it rain', { end: 'user', engine: 'whisper' });
  });
});

describe('useDictation: "the microphone stays off" is true while it is said', () => {
  it('openingMic is false during the download and true only while the browser opens the mic', async () => {
    mic.mode = 'manual';
    const { result } = setup('whisper');
    act(() => result.current.start());
    expect(result.current.status).toBe('starting');
    expect(result.current.openingMic).toBe(false); // downloading: the mic is off
    await act(async () => model.loads[0].resolve(async () => ({ text: 'x' })));
    await flush();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('starting');
    expect(result.current.openingMic).toBe(true); // the browser is opening it (and may ask)
    await act(async () => mic.waiting[0]());
    await flush();
    expect(result.current.status).toBe('recording');
    expect(result.current.openingMic).toBe(false);
    act(() => result.current.cancel());
    expect(result.current.openingMic).toBe(false);
  });
});
