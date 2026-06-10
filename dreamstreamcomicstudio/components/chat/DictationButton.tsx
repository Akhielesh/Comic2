import React, { useEffect, useRef, useState } from 'react';
import { Mic, Check, X, Loader2, ChevronDown, ShieldCheck, Zap } from 'lucide-react';
import {
  useDictation,
  voiceInputSupported,
  webSpeechSupported,
  type DictationEngine
} from '../../hooks/useDictation';
import type { WhisperModelSize } from '../../services/dictation/whisperEngine';
import { GLASS_STRONG, HAIRLINE, MENU, MUTED, LABEL, TRANSITION, SHADOW_SOFT, ACCENT_TEXT } from './studioDesign';

// Voice dictation control for the composer. Idle: a quiet mic button (long-press the
// chevron area / right-click for engine settings). Recording: a floating glass bar
// with a live level meter, timer and accept/cancel. Transcription is on-device
// Whisper by default — audio never leaves the browser.

interface DictationButtonProps {
  disabled?: boolean;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  /** Called when a take starts, so the composer can snapshot the current draft. */
  onStart?: () => void;
}

const ENGINE_OPTIONS: { id: DictationEngine; label: string; hint: string; icon: React.ReactNode; available: () => boolean }[] = [
  {
    id: 'whisper',
    label: 'On-device Whisper',
    hint: 'Open-source model, runs in your browser. Private — audio never leaves this device.',
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    available: () => true
  },
  {
    id: 'webspeech',
    label: 'Browser dictation',
    hint: 'Instant, streamed by your browser (may use its cloud service).',
    icon: <Zap className="h-3.5 w-3.5" />,
    available: webSpeechSupported
  }
];

const MODEL_OPTIONS: { id: WhisperModelSize; label: string; hint: string }[] = [
  { id: 'tiny', label: 'Fast', hint: '~40 MB · quickest' },
  { id: 'base', label: 'Balanced', hint: '~80 MB · recommended' },
  { id: 'small', label: 'Accurate', hint: '~250 MB · best quality' }
];

const formatClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// --- Waveform -----------------------------------------------------------------
// A smooth voice waveform: slim accent bars whose heights chase the live mic level
// with per-bar phase offsets and critically-damped smoothing. Heights are animated
// imperatively inside one requestAnimationFrame loop (lerp toward a moving target
// each frame) instead of CSS transitions on prop changes, so the wave undulates
// organically rather than jittering. Idle bars settle into a quiet row of dots.

const WAVE_BARS = 14;
const WAVE_HEIGHT = 20; // px — matches the h-5 row
const WAVE_REST = 3; // px — the resting "dot" height

/** Per-bar gain + opacity falloff: full at center, soft at the edges. */
const waveFalloff = (i: number) => {
  const x = (i - (WAVE_BARS - 1) / 2) / ((WAVE_BARS - 1) / 2); // -1..1
  return 0.35 + 0.65 * Math.cos(x * (Math.PI / 2.4));
};

const Waveform: React.FC<{ level: number }> = ({ level }) => {
  const levelRef = useRef(level);
  levelRef.current = level;
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const phases = Array.from({ length: WAVE_BARS }, (_, i) => i * 1.7 + Math.random() * Math.PI);
    const speeds = Array.from({ length: WAVE_BARS }, () => 2.4 + Math.random() * 1.8);
    const heights = new Array<number>(WAVE_BARS).fill(0);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const amp = Math.min(1, levelRef.current * 1.9);
      for (let i = 0; i < WAVE_BARS; i++) {
        // Target: live level, shaped by the center falloff and a slow per-bar wobble.
        const wobble = 0.55 + 0.45 * Math.sin(t * speeds[i] + phases[i]);
        const target = amp * waveFalloff(i) * wobble;
        // Critically-damped chase — quick attack, gentle release.
        const rate = target > heights[i] ? 22 : 9;
        heights[i] += (target - heights[i]) * (1 - Math.exp(-dt * rate));
        const el = barsRef.current[i];
        if (el) el.style.height = `${WAVE_REST + heights[i] * (WAVE_HEIGHT - WAVE_REST)}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex h-5 items-center gap-[2px]" aria-hidden>
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="w-[2px] rounded-full bg-[var(--ds-accent)]"
          style={{ height: WAVE_REST, opacity: 0.3 + 0.7 * waveFalloff(i) }}
        />
      ))}
    </div>
  );
};

export const DictationButton: React.FC<DictationButtonProps> = ({ disabled, onPartial, onFinal, onStart }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { status, level, elapsed, error, download, settings, setSettings, start, stop, cancel } = useDictation({
    onPartial,
    onFinal
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  if (!voiceInputSupported()) return null;

  const busy = status === 'starting' || status === 'recording' || status === 'transcribing';

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* Engine / model settings */}
      {menuOpen && (
        <div className={`absolute bottom-full right-0 z-30 mb-2 w-64 overflow-hidden ${MENU} animate-fade-in`}>
          <div className={`px-3 pt-2 pb-1 ${LABEL}`}>Dictation engine</div>
          {ENGINE_OPTIONS.filter((o) => o.available()).map((o) => (
            <button
              key={o.id}
              onClick={() => setSettings({ ...settings, engine: o.id })}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left ${TRANSITION} ${settings.engine === o.id ? 'bg-[#D97757]/10' : 'hover:bg-[var(--ds-hover)]'}`}
            >
              <span className={`mt-0.5 ${settings.engine === o.id ? ACCENT_TEXT : MUTED}`}>{o.icon}</span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-[var(--ds-ink)]">{o.label}</span>
                <span className={`block text-[11px] ${MUTED}`}>{o.hint}</span>
              </span>
            </button>
          ))}
          {settings.engine === 'whisper' && (
            <>
              <div className={`border-t border-[var(--ds-hairline-soft)] px-3 pt-2 pb-1 ${LABEL}`}>Model (downloads once)</div>
              <div className="flex gap-1 px-3 pb-2.5">
                {MODEL_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSettings({ ...settings, model: m.id })}
                    title={m.hint}
                    className={`flex-1 rounded-lg border px-1.5 py-1 text-[11px] font-semibold ${TRANSITION} ${
                      settings.model === m.id
                        ? 'border-transparent bg-[var(--ds-accent)] text-white'
                        : `border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Recording / transcribing bar floats above the composer row. */}
      {busy && (
        <div
          className={`absolute bottom-full right-0 z-30 mb-2 flex w-[min(21rem,80vw)] items-center gap-3 ${GLASS_STRONG} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl px-3.5 py-2 animate-fade-in`}
        >
          {status === 'transcribing' ? (
            <>
              <Loader2 className={`h-4 w-4 animate-spin ${ACCENT_TEXT}`} />
              <span className="flex-1 truncate text-[12px] font-medium text-[var(--ds-ink)]">Transcribing on-device…</span>
            </>
          ) : download ? (
            <>
              <Loader2 className={`h-4 w-4 animate-spin ${ACCENT_TEXT}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-[var(--ds-ink)]">
                  Preparing voice model… {Math.round(download.progress * 100)}%
                </span>
                <span className={`block text-[10px] ${MUTED}`}>One-time download, then it's instant & offline</span>
              </span>
              <button onClick={cancel} className={`rounded-lg p-1.5 ${MUTED} hover:bg-[var(--ds-hover)] ${TRANSITION}`} title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
              <Waveform level={level} />
              <span className="flex-1 text-[12px] font-semibold tabular-nums text-[var(--ds-ink)]">{formatClock(elapsed)}</span>
              <span className={`hidden text-[10px] sm:block ${MUTED}`}>
                {settings.engine === 'whisper' ? 'on-device' : 'browser'}
              </span>
              <button
                onClick={cancel}
                className={`rounded-lg p-1.5 ${MUTED} hover:bg-[var(--ds-hover)] ${TRANSITION}`}
                title="Discard recording"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                onClick={stop}
                className={`rounded-lg bg-[var(--ds-accent)] p-1.5 text-white hover:bg-[var(--ds-accent-hover)] ${TRANSITION}`}
                title="Finish and insert text"
              >
                <Check className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      )}

      {error && status === 'error' && (
        <div
          className={`absolute bottom-full right-0 z-30 mb-2 w-[min(20rem,78vw)] rounded-2xl border border-red-200 bg-red-50/95 px-3 py-2 text-[11px] font-medium text-red-700 ${SHADOW_SOFT} animate-fade-in`}
        >
          {error}
        </div>
      )}

      <div className={`flex items-stretch ${HAIRLINE} rounded-xl bg-[var(--ds-surface-soft)] ${TRANSITION} ${busy ? 'ring-1 ring-[#D97757]/40' : ''}`}>
        <button
          onClick={() => {
            if (busy) {
              stop();
            } else {
              setMenuOpen(false);
              onStart?.();
              start();
            }
          }}
          disabled={disabled && !busy}
          className={`p-2.5 ${TRANSITION} disabled:opacity-40 ${busy ? ACCENT_TEXT : `${MUTED} hover:text-[var(--ds-ink)]`}`}
          title={busy ? 'Finish dictation' : 'Dictate with your voice (on-device)'}
          aria-label={busy ? 'Finish dictation' : 'Start voice dictation'}
        >
          <Mic className={`h-4 w-4 ${status === 'recording' ? 'animate-pulse' : ''}`} />
        </button>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy}
          className={`border-l border-[var(--ds-hairline-soft)] px-1 ${MUTED} hover:text-[var(--ds-ink)] ${TRANSITION} disabled:opacity-40`}
          title="Dictation settings"
          aria-label="Dictation settings"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};
