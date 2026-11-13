import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Mic, Check, X, Loader2, ChevronDown, ShieldCheck, Globe, CircleAlert, ArrowUp } from 'lucide-react';
import {
  useDictation,
  voiceInputSupported,
  webSpeechSupported,
  type DictationEngine,
  type FinalInfo
} from '../../hooks/useDictation';
import { downloadMb, type WhisperModelSize } from '../../services/dictation/whisperEngine';
import { DICTATION_ACTION_LABEL } from '../../services/dictation/errors';
import { Button } from '../ds/Button';
import { LiveDot } from '../ds/LiveDot';
import { cn } from '../../lib/utils';
import {
  HAIRLINE,
  MENU,
  MUTED,
  OVERLINE,
  OVERLAY,
  TRANSITION,
  ACCENT_TEXT,
  ACCENT_SOFT_BG,
  ON_ACCENT_TEXT,
  RADIUS_CONTROL,
  RADIUS_PANEL,
  STATUS_INK,
  STATUS_EDGE,
  Z
} from './studioDesign';
import { columnBounds, placeVoiceBox, placeVoiceBoxClearOf, visibleBoundsOf } from './dictationPlacement';

// Voice dictation control for a composer. Idle: a quiet mic and a settings caret. While a take runs: a bar with
// the live level, the timer, Discard and Done. Private on-device Whisper is the default; browser dictation is
// the online choice.
//
// Every box this control opens (settings, the recording bar, an error) sits next to the mic on the side the
// caller names (`align`), flips below the mic when there is no room above (a header pinned to the top), and is
// clamped inside what the person can see — never off screen (dictationPlacement.ts). A caller whose mic sits
// under its text box (Comic Studio) names that box (`stackAboveRef`), and the boxes open above it, so the words
// and the caret stay in view during a take. The boxes come after the mic in the DOM, so Tab reaches them next.

interface DictationButtonProps {
  disabled?: boolean;
  /** Streamed words while a take runs (the whole take so far). Omit to keep the input untouched until the end. */
  onPartial?: (text: string) => void;
  /** The take's words and why it ended (`info.end === 'user'` only when the person tapped Done). */
  onFinal: (text: string, info: FinalInfo) => void;
  /** Called when a take starts, so the composer can snapshot the current draft. */
  onStart?: () => void;
  /** The mic's side of its toolbar: 'end' (default; the boxes line up with its right edge) or 'start' (left). */
  align?: 'start' | 'end';
  /** Show the words heard so far inside the recording bar (for callers that keep their input untouched). */
  showHeard?: boolean;
  /** The error's "Type instead": move the person to the text box. */
  onTypeInstead?: () => void;
  /**
   * The caller sends a browser-dictation take that ends with Done (Comic Studio's "Send when I tap Done" is on and
   * can act). Done then reads Send, so a send is never a surprise. The private voice model never sends, so it
   * never reads Send.
   */
  sendsOnDone?: boolean;
  /** A box to keep in view (the composer the words go into): the boxes open above it rather than over it. */
  stackAboveRef?: React.RefObject<HTMLElement | null>;
  /** The person chose how it listens in the settings (the caller can show what depends on it). */
  onEngineChange?: (engine: DictationEngine) => void;
}

const ENGINE_OPTIONS: { id: DictationEngine; label: string; hint: (mb: number) => string; icon: React.ReactNode; available: () => boolean }[] = [
  {
    id: 'whisper',
    label: 'Private, on this device',
    // What the first use downloads, and from where: the weights from Hugging Face (the only third-party host), the
    // voice engine from our own site (whisperEngine.ts pinOwnRuntime; whisperEngine.test).
    hint: (mb) => `Your voice stays on this device. The first use downloads the voice model once from Hugging Face, and the voice engine from DreamStream (up to about ${mb} MB in all), then it works offline.`,
    icon: <ShieldCheck className="h-3.5 w-3.5" />,
    available: () => true
  },
  {
    id: 'webspeech',
    label: 'Browser dictation, online',
    hint: () => 'Starts at once. Your browser may send your voice to its speech service to turn it into text.',
    icon: <Globe className="h-3.5 w-3.5" />,
    available: webSpeechSupported
  }
];

const MODEL_OPTIONS: { id: WhisperModelSize; label: string; hint: string }[] = [
  { id: 'tiny', label: 'Fast', hint: 'quickest' },
  { id: 'base', label: 'Balanced', hint: 'recommended' },
  { id: 'small', label: 'Accurate', hint: 'best quality' }
];

/** The widths each box would like; it is narrowed to fit the screen. */
const BOX_WIDTH = { menu: 256, bar: 336, error: 320 } as const;

const formatClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** About two lines of the bar at its widest: the words heard show their newest part, never their first lines. */
export const HEARD_TAIL_CHARS = 140;

/** The newest part of the words heard: the whole text when short, else "…" and the last words (at a word start). */
export const heardTail = (text: string, max = HEARD_TAIL_CHARS): string => {
  const t = text.trim();
  if (t.length <= max) return t;
  const tail = t.slice(t.length - (max - 1)); // one character is the ellipsis
  const cut = tail.indexOf(' ');
  return `…${cut > 0 && cut < 24 ? tail.slice(cut + 1) : tail}`;
};

/**
 * Keep an open box next to the mic and inside the visible area. It writes the position straight onto the box
 * (before paint, and again on resize, scroll, the keyboard and the box's own size changes).
 */
const usePlacedBox = (
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  boxRef: React.RefObject<HTMLElement | null>,
  width: number,
  align: 'start' | 'end',
  stackRef?: React.RefObject<HTMLElement | null>
) => {
  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const place = () => {
      const anchor = anchorRef.current;
      const box = boxRef.current;
      if (!anchor || !box) return;
      const a = anchor.getBoundingClientRect();
      const keepClear = stackRef?.current?.getBoundingClientRect() ?? null;
      const bounds = visibleBoundsOf(anchor);
      // Fit the width first (the height depends on how the words wrap), then place by the real height.
      box.style.width = `${placeVoiceBox(a, { width, height: 0 }, columnBounds(bounds, keepClear), align).width}px`;
      box.style.maxHeight = '';
      const p = placeVoiceBoxClearOf(a, keepClear, { width, height: box.offsetHeight }, bounds, align);
      box.style.left = `${p.left - a.left}px`;
      box.style.top = `${p.top - a.top}px`;
      box.style.maxHeight = `${p.maxHeight}px`;
      box.dataset.side = p.side;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
    if (boxRef.current) ro?.observe(boxRef.current);
    // The text box grows as the person types during a take: the box above it moves with it.
    if (stackRef?.current) ro?.observe(stackRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      ro?.disconnect();
    };
  }, [open, anchorRef, boxRef, width, align, stackRef]);
};

/** A floating box's frame: absolutely placed against the mic's root, on the popover layer, scrolling if it must. */
const BOX = `absolute left-0 top-0 ${Z.popover} overflow-y-auto overscroll-contain animate-fade-in`;

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

/** The recording bar's small square actions: 28 px with a mouse, 44 px on touch. */
const RECORD_BTN = `grid h-7 w-7 shrink-0 place-items-center ${RADIUS_CONTROL} coarse:h-11 coarse:w-11 ${TRANSITION}`;

export const DictationButton: React.FC<DictationButtonProps> = ({
  disabled,
  onPartial,
  onFinal,
  onStart,
  align = 'end',
  showHeard = false,
  onTypeInstead,
  sendsOnDone = false,
  stackAboveRef,
  onEngineChange
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [heard, setHeard] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // The settings popup is a plain group of toggle buttons (a disclosure), not an ARIA menu: the caret
  // says expanded/collapsed and which element it controls, never aria-haspopup (that announces a menu).
  const menuId = useId();
  const detailsId = useId();
  const { status, level, elapsed, errorInfo, download, openingMic, settings, setSettings, liveEngine, start, stop, cancel, dismissError } = useDictation({
    onPartial: (text) => {
      if (showHeard) setHeard(text);
      onPartial?.(text);
    },
    onFinal
  });

  const busy = status === 'starting' || status === 'recording' || status === 'transcribing';
  const showError = status === 'error' && !!errorInfo;

  usePlacedBox(menuOpen, rootRef, menuRef, BOX_WIDTH.menu, align, stackAboveRef);
  usePlacedBox(busy, rootRef, barRef, BOX_WIDTH.bar, align, stackAboveRef);
  usePlacedBox(showError, rootRef, errorRef, BOX_WIDTH.error, align, stackAboveRef);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    // Esc closes the settings wherever focus is (the caret keeps it after a click), before a sheet underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      caretRef.current?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);

  // Esc belongs to the take while it runs: it stops listening and keeps the words (never sends, never discards).
  // A window listener in the capture phase runs before a sheet's own Esc, so the sheet under the composer stays.
  // While the words are written down Esc is held and does nothing: the words then land (closing a sheet then
  // could take the composer, and the words, with it). Discard in the bar drops them.
  useEffect(() => {
    if (status !== 'starting' && status !== 'recording' && status !== 'transcribing') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      if (status !== 'transcribing') stop('escape');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [status, stop]);

  useEffect(() => {
    if (status === 'starting') setHeard('');
    if (status !== 'error') setDetailsOpen(false);
  }, [status]);

  if (!voiceInputSupported()) return null;

  const startTake = () => {
    setMenuOpen(false);
    setHeard(''); // a new take never shows the last take's words (browser dictation goes straight to Listening)
    onStart?.();
    start();
  };

  const onErrorAction = () => {
    if (!errorInfo) return;
    if (errorInfo.action === 'type') {
      dismissError();
      onTypeInstead?.();
      return;
    }
    startTake(); // Try again (after the person allowed the mic in the browser's settings, this one works)
  };

  const onDevice = (liveEngine ?? settings.engine) === 'whisper';
  // Done sends only for browser dictation the caller will send (never the private model): then it says Send.
  const doneSends = sendsOnDone && liveEngine === 'browser-cloud';
  const micLabel = status === 'starting' ? 'Cancel voice dictation' : busy ? (doneSends ? 'Finish and send' : 'Finish dictation') : 'Start voice dictation';
  const micTitle =
    status === 'starting'
      ? 'Cancel'
      : busy
        ? doneSends
          ? 'Send the message'
          : 'Finish and add the words'
        : settings.engine === 'webspeech'
          ? 'Voice typing · browser dictation, online'
          : 'Voice typing · private, on this device';
  const tone = errorInfo?.tone ?? 'error';

  return (
    <div ref={rootRef} data-voice-root className="relative shrink-0">
      {/* Split control: the mic and its settings caret. Each is its own target — ≥ 24 px with a mouse
          (WCAG 2.5.8; the caret was 21 px) and 44 px on touch (the mic was 36, the caret 21–26). */}
      <div className={`flex items-stretch ${HAIRLINE} ${RADIUS_CONTROL} bg-[var(--ds-surface-soft)] ${TRANSITION} ${busy ? 'ring-1 ring-[var(--ds-ring)]' : ''}`}>
        <button
          ref={micRef}
          type="button"
          onClick={() => {
            if (busy) stop(); // Done while listening; while preparing this cancels, so the mic never opens later
            else startTake();
          }}
          disabled={disabled && !busy}
          aria-pressed={status === 'recording'}
          className={`grid place-items-center p-2.5 coarse:min-h-11 coarse:min-w-11 ${TRANSITION} disabled:opacity-40 ${busy ? ACCENT_TEXT : `${MUTED} hover:text-[var(--ds-ink)]`}`}
          title={micTitle}
          aria-label={micLabel}
        >
          <Mic className="h-4 w-4" aria-hidden />
        </button>
        <button
          ref={caretRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={busy}
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          className={`grid min-w-6 place-items-center border-l border-[var(--ds-hairline-soft)] px-1.5 coarse:min-h-11 coarse:min-w-11 ${MUTED} hover:text-[var(--ds-ink)] ${TRANSITION} disabled:opacity-40`}
          title="Dictation settings"
          aria-label="Dictation settings"
          data-dictation-settings
        >
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </div>

      {/* Engine / model settings */}
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="group"
          aria-label="Dictation settings"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            setMenuOpen(false);
            caretRef.current?.focus();
          }}
          className={cn(BOX, MENU)}
          style={{ width: BOX_WIDTH.menu }}
        >
          <div className={`px-3 pt-2 pb-1 ${OVERLINE}`}>How it listens</div>
          {ENGINE_OPTIONS.filter((o) => o.available()).map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                setSettings({ ...settings, engine: o.id });
                onEngineChange?.(o.id);
              }}
              aria-pressed={settings.engine === o.id}
              className={`flex w-full items-start gap-2 px-3 py-2 text-left coarse:min-h-11 ${TRANSITION} ${settings.engine === o.id ? ACCENT_SOFT_BG : 'hover:bg-[var(--ds-hover)]'}`}
            >
              <span className={`mt-0.5 ${settings.engine === o.id ? ACCENT_TEXT : MUTED}`}>{o.icon}</span>
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-[var(--ds-ink)]">{o.label}</span>
                <span className={`block text-[11px] ${MUTED}`}>{o.hint(downloadMb(settings.model))}</span>
              </span>
            </button>
          ))}
          {settings.engine === 'whisper' && (
            <>
              <div className={`border-t border-[var(--ds-hairline-soft)] px-3 pt-2 pb-1 ${OVERLINE}`}>Accuracy (downloads once)</div>
              <div className="flex gap-1 px-3 pb-2.5">
                {MODEL_OPTIONS.map((m) => {
                  const mb = downloadMb(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSettings({ ...settings, model: m.id })}
                      title={`${m.label}: ${m.hint}, up to about ${mb} MB`}
                      aria-pressed={settings.model === m.id}
                      className={`flex flex-1 flex-col items-center ${RADIUS_CONTROL} border px-1.5 py-1 text-[11px] font-semibold coarse:min-h-11 ${TRANSITION} ${
                        settings.model === m.id
                          ? `border-transparent bg-[var(--ds-accent)] ${ON_ACCENT_TEXT}`
                          : `border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] ${MUTED} hover:bg-[var(--ds-hover)]`
                      }`}
                    >
                      <span>{m.label}</span>
                      <span className="text-[10px] font-normal tabular-nums opacity-80" aria-hidden>
                        {mb} MB
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* The take's bar: preparing, listening, writing it down. */}
      {busy && (
        <div ref={barRef} data-voice-bar className={cn(BOX, OVERLAY, 'px-3.5 py-2')} style={{ width: BOX_WIDTH.bar }}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {status === 'transcribing' ? (
              <>
                <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${ACCENT_TEXT}`} aria-hidden />
                <span className="flex-1 truncate text-[12px] font-medium text-[var(--ds-ink)]">Writing down what you said…</span>
                {/* Drops the words when this step finishes (the mic is already off). */}
                <button type="button" onClick={cancel} className={`${RECORD_BTN} ${MUTED} hover:bg-[var(--ds-hover)]`} title="Discard what you said" aria-label="Discard what you said">
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </>
            ) : status === 'starting' ? (
              <>
                <Loader2 className={`h-4 w-4 shrink-0 animate-spin ${ACCENT_TEXT}`} aria-hidden />
                {openingMic ? (
                  // The download is done and the browser is opening the mic (it may ask first): it is no longer "off".
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--ds-ink)]">Opening your microphone…</span>
                    <span className={`block text-[11px] ${MUTED}`}>Allow it if your browser asks.</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-[var(--ds-ink)]">
                      Getting voice typing ready…{download ? ` ${Math.round(download.progress * 100)}%` : ''}
                    </span>
                    <span className={`block text-[11px] ${MUTED}`}>Your microphone stays off until it's ready.</span>
                  </span>
                )}
                <button type="button" onClick={cancel} className={`${RECORD_BTN} ${MUTED} hover:bg-[var(--ds-hover)]`} title="Cancel" aria-label="Cancel voice typing">
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </>
            ) : (
              <>
                <span className={`flex shrink-0 items-center gap-1.5 text-[12px] font-semibold ${STATUS_INK.active}`}>
                  <LiveDot className="h-2 w-2" />
                  Listening
                </span>
                {/* The level meter only where we hear the level (the private model); the online engine gives us none. */}
                {onDevice && <Waveform level={level} />}
                <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-ink)]">{formatClock(elapsed)}</span>
                {onDevice ? (
                  <span className={`hidden text-[11px] sm:block ${MUTED}`}>on this device</span>
                ) : (
                  // Where the voice goes, at every width (a phone shows no tooltip). One short word: the bar can be
                  // narrow on a wide screen too (a side pane), and Done must never be pushed out of it.
                  <span className={`shrink-0 text-[11px] ${MUTED}`}>online</span>
                )}
                {/* Discard and Done stay together at the right; in a narrow bar they wrap under the status, never out of it. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={cancel} className={`${RECORD_BTN} ${MUTED} hover:bg-[var(--ds-hover)]`} title="Discard what you said" aria-label="Discard recording">
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => stop()}
                    className={`${RECORD_BTN} bg-[var(--ds-accent)] ${ON_ACCENT_TEXT} hover:bg-[var(--ds-accent-hover)]`}
                    title={doneSends ? 'Send: your words go in the box and send' : 'Done: add the words to your message'}
                    aria-label={doneSends ? 'Send the message' : 'Finish and insert text'}
                  >
                    {doneSends ? <ArrowUp className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                  </button>
                </span>
              </>
            )}
          </div>
          {showHeard && status === 'recording' && (
            // The newest words, two lines at most, pinned to the bottom so the latest stay in view as the take grows.
            <p aria-live="off" className={`mt-1 flex max-h-[2.75em] flex-col justify-end overflow-hidden text-[12px] leading-snug [overflow-wrap:anywhere] ${MUTED}`}>
              {heard ? heardTail(heard) : 'Speak now…'}
            </p>
          )}
        </div>
      )}

      {/* An error: one calm sentence, one action, the technical detail only on request. */}
      {showError && errorInfo && (
        <div
          ref={errorRef}
          role={tone === 'error' ? 'alert' : 'status'}
          data-voice-error={errorInfo.code}
          className={cn(BOX, 'border bg-[var(--ds-raised)] px-3 py-2.5 shadow-[shadow:var(--ds-shadow-overlay)]', RADIUS_PANEL, STATUS_EDGE[tone])}
          style={{ width: BOX_WIDTH.error }}
        >
          <div className="flex items-start gap-2">
            <CircleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${STATUS_INK[tone]}`} aria-hidden />
            <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">{errorInfo.message}</p>
            <button type="button" onClick={dismissError} aria-label="Dismiss" title="Dismiss" className={cn('-mr-1.5 -mt-1', RECORD_BTN, MUTED, 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]')}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
            <Button type="button" size="sm" variant="outline" onClick={onErrorAction}>
              {DICTATION_ACTION_LABEL[errorInfo.action]}
            </Button>
            <Button type="button" size="sm" variant="ghost" className={MUTED} aria-expanded={detailsOpen} aria-controls={detailsOpen ? detailsId : undefined} onClick={() => setDetailsOpen((v) => !v)}>
              {detailsOpen ? 'Hide details' : 'Show details'}
            </Button>
          </div>
          {detailsOpen && (
            <p id={detailsId} className={`mt-1.5 pl-6 font-mono text-[11px] leading-snug [overflow-wrap:anywhere] ${MUTED}`}>
              {errorInfo.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
