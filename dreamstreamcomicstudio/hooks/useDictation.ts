import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioContext, dictationSupported, startPcmRecorder, type PcmRecorder } from '../services/dictation/recorder';
import {
  loadWhisper,
  transcribe,
  whisperReady,
  type WhisperModelSize,
  type WhisperLoadProgress
} from '../services/dictation/whisperEngine';
import { dictationError, fromMediaError, fromSpeechError, type DictationErrorInfo } from '../services/dictation/errors';

// Voice dictation state machine. Two engines:
//
//  - 'whisper' (default): open-source Whisper running fully on-device via
//    transformers.js. Private — audio never leaves the browser. First use downloads
//    the model once (progress reported); afterwards it starts instantly from cache.
//    While recording, the accumulated audio is re-transcribed every few seconds so
//    the user sees live partial text, then the full take is finalized on stop.
//
//  - 'webspeech': the browser's built-in SpeechRecognition. Instant and streamed,
//    but the browser may send the audio to its speech service (Google in Chrome,
//    Apple in Safari) — offered as the online option, not the default.
//
// The microphone is on only while the take is recording:
//  - One take = one id. Every async step checks the id when it resumes; a step from a
//    cancelled or replaced take stops whatever it opened and returns.
//  - Whisper prepares first, then opens the mic: a failed or cancelled download never
//    turns it on. Tapping the mic again while it prepares cancels.
//  - One clean-up path stops the recorder and every track, aborts the recognition,
//    clears every timer and listener and closes the audio context. Cancel, errors, a
//    hidden tab, the time limit and unmount all go through it.
//
// Each final transcript says why the take ended (`FinalInfo.end`): only 'user' means
// the person tapped Done. A caller that sends on its own must check it.

export type DictationEngine = 'whisper' | 'webspeech';
export type DictationStatus = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error';
/** The engine a take actually ran on: Whisper on this device, or the browser's online dictation. */
export type LiveEngine = 'whisper' | 'browser-cloud';
/**
 * Why a take ended. 'user' is Done (the mic tapped again, or the finish button); 'escape' is Esc; 'hidden' is
 * the tab going to the background; 'limit' is the take limit; 'device' is the browser ending the microphone
 * itself (permission revoked, the device unplugged); 'engine' is the browser ending its own dictation (after a
 * pause, a network drop or its session limit), or never ending it after our stop, so we ended it: either way it
 * did not confirm its last words, so the take is not a clean Done. 'silence' and 'no-speech' are reserved for the
 * endpointer that comes later; nothing produces them yet.
 */
export type TakeEnd = 'user' | 'escape' | 'silence' | 'no-speech' | 'limit' | 'hidden' | 'device' | 'engine';

export interface FinalInfo {
  end: TakeEnd;
  engine: LiveEngine;
}

export interface DictationSettings {
  engine: DictationEngine;
  model: WhisperModelSize;
}

const SETTINGS_KEY = 'ds.dictation.v1';
const PARTIAL_INTERVAL_MS = 4000;
const CLOCK_MS = 250;
/** After our own stop, how long the browser gets to end its dictation before we end it. */
const SPEECH_END_WAIT_MS = 2000;
/** The longest take: past this it finishes by itself and the words wait (the PCM buffer stays bounded). */
export const TAKE_LIMIT_MS = 120_000;

const speechCtor = (): (new () => any) | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => any) | undefined;
};

export const webSpeechSupported = (): boolean => !!speechCtor();

export const voiceInputSupported = dictationSupported;

export const loadDictationSettings = (): DictationSettings => {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<DictationSettings>;
    return {
      engine: raw.engine === 'webspeech' && webSpeechSupported() ? 'webspeech' : 'whisper',
      model: raw.model === 'tiny' || raw.model === 'small' ? raw.model : 'base'
    };
  } catch {
    return { engine: 'whisper', model: 'base' };
  }
};

export interface UseDictationOptions {
  /** Streamed partial text while recording (replaces the previous partial). */
  onPartial?: (text: string) => void;
  /** Final transcript for the take, and why it ended. Empty string means nothing was recognized. */
  onFinal: (text: string, info: FinalInfo) => void;
}

export const useDictation = ({ onPartial, onFinal }: UseDictationOptions) => {
  const [status, setStatusState] = useState<DictationStatus>('idle');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [errorInfo, setErrorInfo] = useState<DictationErrorInfo | null>(null);
  const [download, setDownload] = useState<WhisperLoadProgress | null>(null);
  const [settings, setSettingsState] = useState<DictationSettings>(loadDictationSettings);
  const [liveEngine, setLiveEngine] = useState<LiveEngine | null>(null);
  /** True only while the browser opens the mic after the download (it may ask): the mic is no longer "off". */
  const [openingMic, setOpeningMic] = useState(false);

  const statusRef = useRef<DictationStatus>('idle');
  const setStatus = useCallback((next: DictationStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** The live take's id. Bumped by start and cancel, so a continuation from an older take knows it is stale. */
  const takeRef = useRef(0);
  const mountedRef = useRef(true);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const recognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  /** The audio context made in the tap, until the recorder takes it over. */
  const contextRef = useRef<AudioContext | null>(null);
  /** Web Speech: why our own stop ended the take (null until we stop it). */
  const speechEndRef = useRef<TakeEnd | null>(null);
  /** Web Speech: ends the live take and delivers its words (the end event, or the watchdog with `cut`). */
  const speechCompleteRef = useRef<((cut?: boolean) => void) | null>(null);
  // A cancelled decode can still be running on the shared Whisper model.
  const transcriptionRef = useRef<Promise<void> | null>(null);
  const timersRef = useRef<number[]>([]);
  const cleanupsRef = useRef<Array<() => void>>([]);
  // Keep the latest callbacks without retriggering effects mid-recording.
  const cbRef = useRef({ onPartial, onFinal });
  cbRef.current = { onPartial, onFinal };

  const isLive = (take: number) => mountedRef.current && take === takeRef.current;

  const setSettings = useCallback((next: DictationSettings) => {
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* preference just won't persist */
    }
  }, []);

  /** The one clean-up path: mic, recognition, timers, listeners and the audio context. */
  const release = useCallback(() => {
    timersRef.current.forEach((t) => window.clearInterval(t));
    timersRef.current = [];
    cleanupsRef.current.forEach((fn) => fn());
    cleanupsRef.current = [];
    const recorder = recorderRef.current;
    recorderRef.current = null;
    recorder?.stop();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try {
      rec?.abort();
    } catch {
      /* already ended */
    }
    const ctx = contextRef.current;
    contextRef.current = null;
    try {
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    } catch {
      /* already closed */
    }
  }, []);

  const trackTranscription = (pass: Promise<void>) => {
    transcriptionRef.current = pass;
    void pass.finally(() => {
      if (transcriptionRef.current === pass) transcriptionRef.current = null;
    });
  };

  const resetMeters = () => {
    setLevel(0);
    setElapsed(0);
  };

  /** Discard the take entirely: nothing is delivered, and anything it opened is closed. */
  const cancel = useCallback(() => {
    takeRef.current += 1;
    release();
    setStatus('idle');
    setErrorInfo(null);
    setDownload(null);
    setOpeningMic(false);
    setLiveEngine(null);
    resetMeters();
  }, [release, setStatus]);

  const fail = (take: number, info: DictationErrorInfo) => {
    if (!isLive(take)) return;
    takeRef.current += 1; // nothing from this take may land after its error
    release();
    setDownload(null);
    setOpeningMic(false);
    setLiveEngine(null);
    resetMeters();
    setErrorInfo(info);
    setStatus('error');
  };

  // Unmount: the take ends with the component, and nothing it started stays on.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      takeRef.current += 1;
      release();
    };
  }, [release]);

  // Holds the latest finish function so the clock and the tab listener always call the current one.
  const finishRef = useRef<(take: number, end: TakeEnd) => void>(() => undefined);

  /**
   * While a take is preparing or recording: the clock, the take limit (counted from when the mic opens, never
   * during a download) and the stop when the tab goes to the background.
   */
  const watchTake = (take: number) => {
    let recordingSince: number | null = null;
    timersRef.current.push(
      window.setInterval(() => {
        if (!isLive(take) || statusRef.current !== 'recording') return;
        recordingSince ??= Date.now();
        const ms = Date.now() - recordingSince;
        setElapsed(ms / 1000);
        if (ms >= TAKE_LIMIT_MS) finishRef.current(take, 'limit');
      }, CLOCK_MS)
    );
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && isLive(take)) finishRef.current(take, 'hidden');
    };
    const onPageHide = () => {
      if (isLive(take)) finishRef.current(take, 'hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    cleanupsRef.current.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    });
  };

  // ---- Whisper engine -------------------------------------------------------

  const startWhisper = (take: number) => {
    const model = settingsRef.current.model;
    setStatus('starting');
    setLiveEngine('whisper');
    // Made inside the tap so it may run after the download (iOS starts audio only from a gesture); quiet until then.
    contextRef.current = createAudioContext();
    try {
      void contextRef.current?.suspend?.().catch(() => undefined);
    } catch {
      /* not every context can suspend; it stays idle without a source */
    }
    watchTake(take);
    if (!whisperReady(model)) setDownload({ progress: 0, status: 'downloading' });
    void (async () => {
      let asr: Awaited<ReturnType<typeof loadWhisper>>;
      try {
        asr = await loadWhisper(model, (p) => {
          if (isLive(take)) setDownload(p);
        });
      } catch (e) {
        fail(take, dictationError('model-download', e));
        return;
      }
      if (!isLive(take)) return; // cancelled during the download: the mic never opens
      setDownload(null);
      setOpeningMic(true); // from here the bar no longer says the mic stays off: the browser is opening it

      let recorder: PcmRecorder;
      const context = contextRef.current;
      contextRef.current = null; // the recorder owns it now, and closes it on stop or failure
      try {
        recorder = await startPcmRecorder(
          (l) => {
            if (isLive(take)) setLevel(l);
          },
          {
            context,
            // The browser took the mic away mid-take: stop saying "Listening" and keep what was captured.
            onEnded: () => {
              if (isLive(take)) finishRef.current(take, 'device');
            }
          }
        );
      } catch (e) {
        fail(take, fromMediaError(e));
        return;
      }
      if (!isLive(take)) {
        recorder.stop(); // the browser handed over the mic after a cancel: close it at once
        return;
      }
      recorderRef.current = recorder;
      setOpeningMic(false);
      setStatus('recording');

      // Live-ish partials: re-transcribe the take so far, skipping if a pass is
      // still running (a long take decodes slower than the interval).
      timersRef.current.push(
        window.setInterval(() => {
          if (transcriptionRef.current || recorderRef.current !== recorder || !isLive(take)) return;
          trackTranscription(transcribe(asr, recorder.snapshot()).then((text) => {
            if (isLive(take) && recorderRef.current === recorder && text) cbRef.current.onPartial?.(text);
          }).catch(() => {
            /* partial pass is best-effort */
          }));
        }, PARTIAL_INTERVAL_MS)
      );
    })();
  };

  const finishWhisper = (take: number, end: TakeEnd) => {
    const recorder = recorderRef.current;
    if (!recorder) {
      cancel(); // still preparing: Done, Esc, a hidden tab or the limit all just stop it
      return;
    }
    // Close the mic first, then write the words down.
    timersRef.current.forEach((t) => window.clearInterval(t));
    timersRef.current = [];
    cleanupsRef.current.forEach((fn) => fn());
    cleanupsRef.current = [];
    recorderRef.current = null;
    const audio = recorder.stop();
    resetMeters();
    setStatus('transcribing');
    const model = settingsRef.current.model;
    const previous = transcriptionRef.current;
    trackTranscription((async () => {
      try {
        // Finish any earlier decode before starting another. A cancelled take may still be waiting here.
        if (previous) await previous;
        if (!isLive(take)) return;
        const asr = await loadWhisper(model);
        if (!isLive(take)) return;
        const text = await transcribe(asr, audio);
        if (!isLive(take)) return;
        setStatus('idle');
        setLiveEngine(null);
        cbRef.current.onFinal(text, { end, engine: 'whisper' });
      } catch (e) {
        fail(take, dictationError('transcribe', e));
      }
    })());
  };

  // ---- Web Speech engine ----------------------------------------------------

  const startWebSpeech = (take: number) => {
    const Ctor = speechCtor();
    if (!Ctor) {
      fail(take, dictationError('no-engine'));
      return;
    }
    const prefixedOnly = !(window as unknown as Record<string, unknown>).SpeechRecognition;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let finalText = '';
    // The words the browser has heard but not finalized yet (the bar shows them too). Kept so a take the browser
    // never finishes still delivers everything the person saw, not a shorter, different instruction.
    let interimText = '';
    const heardSoFar = () => (finalText + interimText).trim();
    speechEndRef.current = null;
    rec.onresult = (e: any) => {
      if (!isLive(take)) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      interimText = interim;
      cbRef.current.onPartial?.(heardSoFar());
    };
    rec.onerror = (e: any) => {
      if (!isLive(take)) return;
      const info = fromSpeechError(e?.error, { prefixedOnly });
      if (!info) return; // 'aborted' after our own stop: the end event follows
      const said = heardSoFar();
      // Words already heard are kept (the browser ended the take, so they wait for the person).
      if (said) cbRef.current.onFinal(said, { end: 'engine', engine: 'browser-cloud' });
      fail(take, info); // clears the clock too, so no timer outlives the error
    };
    /** `cut`: the browser never ended after our stop, so we did; its last words were never confirmed. */
    const complete = (cut = false) => {
      if (!isLive(take)) return;
      const end: TakeEnd = cut ? 'engine' : (speechEndRef.current ?? 'engine');
      recognitionRef.current = null;
      takeRef.current += 1;
      release();
      resetMeters();
      setStatus('idle');
      setLiveEngine(null);
      cbRef.current.onFinal(heardSoFar(), { end, engine: 'browser-cloud' });
    };
    rec.onend = () => complete();
    speechCompleteRef.current = complete;
    recognitionRef.current = rec;
    setLiveEngine('browser-cloud');
    setStatus('recording');
    watchTake(take);
    try {
      rec.start();
    } catch (e) {
      fail(take, dictationError('generic', e));
    }
  };

  const finishWebSpeech = (take: number, end: TakeEnd) => {
    const rec = recognitionRef.current;
    if (!rec) return;
    speechEndRef.current = end;
    try {
      rec.stop(); // the browser delivers its last result, then `end`
    } catch {
      /* the watchdog below finishes it */
    }
    // If the browser never says it ended, end the take ourselves so its mic cannot stay on. The words still being
    // heard are kept, and the take ends as 'engine', never a clean Done, so it never sends by itself.
    const watchdog = window.setTimeout(() => {
      if (!isLive(take) || recognitionRef.current !== rec) return;
      try {
        rec.abort();
      } catch {
        /* already ended */
      }
      speechCompleteRef.current?.(true);
    }, SPEECH_END_WAIT_MS);
    cleanupsRef.current.push(() => window.clearTimeout(watchdog));
  };

  finishRef.current = (take: number, end: TakeEnd) => {
    if (!isLive(take)) return;
    if (statusRef.current === 'starting') {
      cancel();
      return;
    }
    if (statusRef.current !== 'recording') return;
    if (recognitionRef.current) finishWebSpeech(take, end);
    else finishWhisper(take, end);
  };

  // ---- Public API -----------------------------------------------------------

  /** Start a take. Call it inside the person's tap. */
  const start = useCallback(() => {
    const s = statusRef.current;
    if (s === 'recording' || s === 'starting' || s === 'transcribing') return;
    takeRef.current += 1;
    const take = takeRef.current;
    release();
    setErrorInfo(null);
    resetMeters();
    if (settingsRef.current.engine === 'webspeech') startWebSpeech(take);
    else startWhisper(take);
  }, [release]);

  /**
   * Finish the take and deliver the words. `end` says why: 'user' (Done, the default) or 'escape' (Esc).
   * While the take is still preparing this cancels it, so the mic never opens after the tap.
   */
  const stop = useCallback((end: 'user' | 'escape' = 'user') => {
    finishRef.current(takeRef.current, end);
  }, []);

  /** Close an error and go back to idle. */
  const dismissError = useCallback(() => {
    if (statusRef.current !== 'error') return;
    setErrorInfo(null);
    setStatus('idle');
  }, [setStatus]);

  return {
    status,
    level,
    elapsed,
    /** The error's one calm sentence (kept for older callers; `errorInfo` has the action and detail). */
    error: errorInfo?.message ?? null,
    errorInfo,
    download,
    /** True while the browser opens the mic after the download: the bar must not say it stays off. */
    openingMic,
    settings,
    setSettings,
    liveEngine,
    start,
    stop,
    cancel,
    dismissError
  };
};
