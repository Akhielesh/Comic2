// LiveProgress — the studio's honest "the agent is working" surface.
//
// This REPLACES the old jittery auto-fix banner (the red/violet bar that flipped between
// "auto-fixing…" and "⚠ Error → Fix with AI" and flashed on every preview hiccup). Instead it
// shows a calm, premium loading view with REAL rolling status — the live console lines the agent
// is producing right now (writing files, resolving imports, booting the preview, solving errors)
// — so the wait shows actual work instead of an opaque, glitchy screen.
//
// Two variants:
//   • screen — full-pane loading state (no preview yet): a glowing orb, the phase, and a live ticker
//   • strip  — a slim, calm status bar pinned to the top of the preview while iterating
//
// When work has STOPPED but an error remains unresolved, it shows a single, calm (non-flashing)
// "couldn't fully resolve" notice with a manual Fix-with-AI action. No strobing.

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Wand2, Sparkles, Hammer, ShieldCheck, Wrench, AlertTriangle } from 'lucide-react';
import { useStudioTheme } from '../kit';
import { useStudioLogs, type LogLevel } from './logsStore';
import { useStudioActivity } from './activityStore';

export type ProgressPhase = 'generating' | 'building' | 'fixing' | 'reviewing';

const PHASE_META: Record<ProgressPhase, { title: string; Icon: React.FC<{ className?: string }>; captions: string[] }> = {
  generating: {
    title: 'Building your app',
    Icon: Hammer,
    captions: ['Designing the structure…', 'Writing components…', 'Wiring up state…', 'Styling the UI…', 'Booting the preview…'],
  },
  building: {
    title: 'Running it in a live container',
    Icon: Hammer,
    captions: ['Installing dependencies…', 'Starting the dev server…', 'Watching the logs…', 'Probing the preview…'],
  },
  fixing: {
    title: 'Solving errors so it runs cleanly',
    Icon: Wrench,
    captions: ['Reading the error…', 'Finding the root cause…', 'Patching the code…', 'Re-checking the preview…'],
  },
  reviewing: {
    title: 'Your agent team is reviewing the app',
    Icon: ShieldCheck,
    captions: ['Architecture review…', 'Checking the UI & accessibility…', 'Hardening the data flow…', 'Verifying it all holds together…'],
  },
};

// Only surface meaningful lifecycle lines in the ticker (skip raw noise); map level → tone.
const LEVEL_DOT: Record<LogLevel, string> = {
  system: 'bg-slate-400',
  info: 'bg-sky-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400',
  success: 'bg-emerald-400',
};

const useRollingCaption = (captions: string[], active: boolean): string => {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % captions.length), 1800);
    return () => window.clearInterval(id);
  }, [active, captions.length]);
  return captions[i % captions.length];
};

/** The last few console lines, newest last — the honest "what's happening now" ticker. */
const useTicker = (limit = 5): { id: number; level: LogLevel; text: string }[] => {
  const entries = useStudioLogs((s) => s.entries);
  return entries.slice(-limit);
};

export interface LiveProgressProps {
  phase: ProgressPhase;
  /** True while the agent is actively working (drives the spinner + ticker). */
  active: boolean;
  variant?: 'screen' | 'strip';
  /** A sticky, unresolved preview error (shown calmly once work has stopped). */
  error?: string | null;
  /** Manual "Fix with AI" — resets the budget and re-engages the loop. */
  onFix?: () => void;
  className?: string;
}

export const LiveProgress: React.FC<LiveProgressProps> = ({ phase, active, variant = 'strip', error, onFix, className }) => {
  const t = useStudioTheme();
  const meta = PHASE_META[phase];
  const caption = useRollingCaption(meta.captions, active);
  const ticker = useTicker(variant === 'screen' ? 5 : 1);
  const activitySummary = useStudioActivity((s) => s.summary);
  const tickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tickerRef.current) tickerRef.current.scrollTop = tickerRef.current.scrollHeight; }, [ticker.length]);

  // The newest console line, if any, is the most honest "current status" label.
  const latest = ticker[ticker.length - 1];
  const statusLine = latest?.text || caption;
  const Icon = meta.Icon;

  // ---- STRIP: calm, single-line status pinned above the preview ----
  if (variant === 'strip') {
    // Working → calm accent strip with the live status. Not working + error → calm (non-flashing) notice.
    if (active) {
      return (
        <div className={`flex items-center gap-2 px-3 py-2 border-b ${t.edge} ${t.accentSoft} text-xs ${className ?? ''}`}>
          <Loader2 className={`h-3.5 w-3.5 shrink-0 animate-spin ${t.accent}`} />
          <span className={`min-w-0 flex-1 truncate ${t.text}`}>{statusLine}</span>
          <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${t.accent}`}>{meta.title}</span>
        </div>
      );
    }
    if (error) {
      return (
        <div className={`flex items-start gap-2 px-3 py-2 border-b border-amber-500/25 bg-amber-500/10 text-xs ${className ?? ''}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-amber-700 dark:text-amber-200/90" title={error}>
            Couldn’t fully resolve this on its own — {error}
          </span>
          {onFix && (
            <button
              onClick={onFix}
              className={`shrink-0 inline-flex items-center gap-1 rounded-full ${t.accentBg} ${t.accentText} px-2.5 py-1 text-[11px] font-bold ${t.accentBgHover}`}
            >
              <Wand2 className="h-3 w-3" /> Fix with AI
            </button>
          )}
        </div>
      );
    }
    return null;
  }

  // ---- SCREEN: full-pane premium loading view with a live ticker ----
  return (
    <div className={`flex h-full min-h-[16rem] flex-col items-center justify-center gap-5 p-6 text-center ${className ?? ''}`}>
      {/* Glowing orb */}
      <div className="relative">
        <div className={`absolute -inset-4 rounded-full ${t.accentGrad} opacity-30 blur-2xl ${active ? 'animate-pulse' : ''}`} aria-hidden />
        <div className={`relative flex h-16 w-16 items-center justify-center rounded-2xl border ${t.edgeStrong} ${t.glass} ${t.glow}`}>
          {active ? <Loader2 className={`h-7 w-7 animate-spin ${t.accent}`} /> : <Icon className={`h-7 w-7 ${t.accent}`} />}
        </div>
      </div>

      <div className="space-y-1">
        <p className={`font-display text-lg ${t.text}`}>{meta.title}{active ? '…' : ''}</p>
        <p className={`text-xs ${t.textDim} max-w-sm`}>{active ? caption : (activitySummary || 'Ready.')}</p>
      </div>

      {/* Live console ticker — the rolling, honest record of what's happening right now. */}
      {ticker.length > 0 && (
        <div
          ref={tickerRef}
          className={`w-full max-w-sm space-y-1 rounded-xl border ${t.edge} ${t.panelAlt} p-3 text-left max-h-32 overflow-hidden`}
          aria-live="polite"
        >
          {ticker.map((e, idx) => {
            const newest = idx === ticker.length - 1;
            return (
              <div key={e.id} className={`flex items-center gap-2 text-[11px] ${newest ? t.text : t.textFaint} ${newest ? '' : 'opacity-60'}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[e.level]} ${newest && active ? 'animate-pulse' : ''}`} />
                <span className="min-w-0 flex-1 truncate font-mono">{e.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {!active && error && onFix && (
        <button
          onClick={onFix}
          className={`inline-flex items-center gap-1.5 rounded-full ${t.accentBg} ${t.accentText} px-3.5 py-1.5 text-xs font-bold ${t.accentBgHover}`}
        >
          <Wand2 className="h-3.5 w-3.5" /> Fix with AI
        </button>
      )}

      {!active && !error && (
        <span className={`inline-flex items-center gap-1.5 text-[11px] ${t.textFaint}`}>
          <Sparkles className="h-3.5 w-3.5" /> Live preview will appear here.
        </span>
      )}
    </div>
  );
};
