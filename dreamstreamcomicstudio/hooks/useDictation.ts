import { useCallback, useEffect, useRef, useState } from 'react';
import { dictationSupported, startPcmRecorder, type PcmRecorder } from '../services/dictation/recorder';
import {
  loadWhisper,
  transcribe,
  whisperReady,
  type WhisperModelSize,
  type WhisperLoadProgress
} from '../services/dictation/whisperEngine';

// Voice dictation state machine. Two engines:
//
//  - 'whisper' (default): open-source Whisper running fully on-device via
//    transformers.js. Private — audio never leaves the browser. First use downloads
//    the model once (progress reported); afterwards it starts instantly from cache.
//    While recording, the accumulated audio is re-transcribed every few seconds so
//    the user sees live partial text, then the full take is finalized on stop.
//
//  - 'webspeech': the browser's built-in SpeechRecognition. Instant and streamed,
//    but Chrome routes audio through Google's servers — offered as the "instant"
//    option, not the default.

export type DictationEngine = 'whisper' | 'webspeech';
export type DictationStatus = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error';

export interface DictationSettings {
  engine: DictationEngine;
  model: WhisperModelSize;
}

const SETTINGS_KEY = 'ds.dictation.v1';
const PARTIAL_INTERVAL_MS = 4000;

export const webSpeechSupported = (): boolean =>
  typeof window !== 'undefined' &&
  !!((window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition);

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

interface UseDictationOptions {
  /** Streamed partial text while recording (replaces the previous partial). */
  onPartial: (text: string) => void;
  /** Final transcript for the take. Empty string means nothing was recognized. */
  onFinal: (text: string) => void;
}

export const useDictation = ({ onPartial, onFinal }: UseDictationOptions) => {
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<WhisperLoadProgress | null>(null);
  const [settings, setSettingsState] = useState<DictationSettings>(loadDictationSettings);

  const recorderRef = useRef<PcmRecorder | null>(null);
  const recognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const cancelledRef = useRef(false);
  const partialBusyRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  // Keep the latest callbacks without retriggering effects mid-recording.
  const cbRef = useRef({ onPartial, onFinal });
  cbRef.current = { onPartial, onFinal };

  const setSettings = useCallback((next: DictationSettings) => {
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* preference just won't persist */
    }
  }, []);

  const clearTimers = () => {
    timersRef.current.forEach((t) => window.clearInterval(t));
    timersRef.current = [];
  };

  const teardown = useCallback(() => {
    clearTimers();
    recorderRef.current?.stop();
    recorderRef.current = null;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setLevel(0);
    setElapsed(0);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  // ---- Whisper engine -------------------------------------------------------

  const startWhisper = useCallback(async () => {
    cancelledRef.current = false;
    setStatus('starting');
    setError(null);
    try {
      if (!whisperReady(settings.model)) setDownload({ progress: 0, status: 'downloading' });
      const [asr, recorder] = await Promise.all([
        loadWhisper(settings.model, setDownload),
        startPcmRecorder(setLevel)
      ]);
      setDownload(null);
      if (cancelledRef.current) {
        recorder.stop();
        return;
      }
      recorderRef.current = recorder;
      setStatus('recording');

      timersRef.current.push(window.setInterval(() => setElapsed(recorder.duration()), 250));
      // Live-ish partials: re-transcribe the take so far, skipping if a pass is
      // still running (a long take decodes slower than the interval).
      timersRef.current.push(
        window.setInterval(async () => {
          if (partialBusyRef.current || !recorderRef.current) return;
          partialBusyRef.current = true;
          try {
            const text = await transcribe(asr, recorderRef.current.snapshot());
            if (recorderRef.current && !cancelledRef.current && text) cbRef.current.onPartial(text);
          } catch {
            /* partial pass is best-effort */
          } finally {
            partialBusyRef.current = false;
          }
        }, PARTIAL_INTERVAL_MS)
      );
    } catch (e) {
      teardown();
      setDownload(null);
      setStatus('error');
      setError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow the mic in your browser settings to dictate.'
        : 'Could not start dictation. Check your microphone and connection, then try again.');
    }
  }, [settings.model, teardown]);

  const stopWhisper = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    clearTimers();
    const audio = recorder.stop();
    setLevel(0);
    setStatus('transcribing');
    try {
      const asr = await loadWhisper(settings.model);
      // Wait out any in-flight partial pass so we don't decode concurrently.
      while (partialBusyRef.current) await new Promise((r) => setTimeout(r, 60));
      const text = await transcribe(asr, audio);
      if (!cancelledRef.current) cbRef.current.onFinal(text);
      setStatus('idle');
    } catch {
      setStatus('error');
      setError('Transcription failed. Try again.');
    }
    setElapsed(0);
  }, [settings.model]);

  // ---- Web Speech engine ----------------------------------------------------

  const startWebSpeech = useCallback(() => {
    cancelledRef.current = false;
    setError(null);
    const Ctor = ((window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => any) | undefined;
    if (!Ctor) {
      setStatus('error');
      setError('This browser has no built-in speech recognition — switch to on-device Whisper.');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let finalText = '';
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (!cancelledRef.current) cbRef.current.onPartial((finalText + interim).trim());
    };
    rec.onerror = (e: any) => {
      if (cancelledRef.current) return;
      setStatus('error');
      setError(e?.error === 'not-allowed'
        ? 'Microphone access was denied. Allow the mic in your browser settings to dictate.'
        : 'Speech recognition failed — try on-device Whisper instead.');
      recognitionRef.current = null;
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return;
      recognitionRef.current = null;
      if (!cancelledRef.current) cbRef.current.onFinal(finalText.trim());
      setStatus('idle');
      setElapsed(0);
      clearTimers();
    };
    const startedAt = Date.now();
    timersRef.current.push(window.setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 250));
    recognitionRef.current = rec;
    rec.start();
    setStatus('recording');
  }, []);

  // ---- Public API -----------------------------------------------------------

  const start = useCallback(() => {
    if (status === 'recording' || status === 'starting' || status === 'transcribing') return;
    if (settings.engine === 'webspeech') startWebSpeech();
    else void startWhisper();
  }, [status, settings.engine, startWebSpeech, startWhisper]);

  /** Finish the take and deliver the final transcript. */
  const stop = useCallback(() => {
    if (settings.engine === 'webspeech') recognitionRef.current?.stop();
    else void stopWhisper();
  }, [settings.engine, stopWhisper]);

  /** Discard the take entirely. */
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    teardown();
    setStatus('idle');
    setError(null);
    setDownload(null);
  }, [teardown]);

  return { status, level, elapsed, error, download, settings, setSettings, start, stop, cancel };
};
