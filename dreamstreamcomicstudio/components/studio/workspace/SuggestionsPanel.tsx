// SuggestionsPanel — real "what should I build next?" recommendations.
//
// This REPLACES the old hardcoded chip row (✨ Polish UI / 🌙 Dark mode / 📱 Responsive / …) that
// the user (rightly) called filler. Instead it asks the coding model to look at the ACTUAL app and
// propose the highest-value next steps as ready-to-run prompts. The request is best-effort: if the
// AI can't be reached (or returns nothing) it falls back to a local heuristic, so it always shows
// genuinely useful, app-aware suggestions — never an empty or broken row.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, ArrowUpRight, Wrench, Database, Rocket, Wand2, Plus } from 'lucide-react';
import { useStudioTheme } from '../kit';
import type { StudioSuggestion } from '../../../apiTypes';

const KIND_META: Record<NonNullable<StudioSuggestion['kind']>, { Icon: React.FC<{ className?: string }>; tint: string }> = {
  feature: { Icon: Plus, tint: 'text-violet-400' },
  polish: { Icon: Wand2, tint: 'text-fuchsia-400' },
  fix: { Icon: Wrench, tint: 'text-amber-400' },
  data: { Icon: Database, tint: 'text-sky-400' },
  ship: { Icon: Rocket, tint: 'text-emerald-400' },
};

export interface SuggestionsPanelProps {
  files: { path: string; content: string }[];
  title?: string;
  /** Local heuristic suggestions (strings) to show if the AI call is unavailable. */
  fallback: string[];
  /** Suspend fetching while a build/refine is in flight. */
  busy?: boolean;
  /** Run a suggestion as a refine prompt. */
  onPick: (prompt: string) => void;
  className?: string;
}

const fallbackToSuggestions = (lines: string[]): StudioSuggestion[] =>
  lines.slice(0, 5).map((line) => ({
    label: line.replace(/[.…]+$/, '').split(/\s+/).slice(0, 5).join(' '),
    prompt: line,
    kind: /fix|resolve|missing/i.test(line) ? 'fix' : /split|polish|design|spacing/i.test(line) ? 'polish' : 'feature',
  }));

export const SuggestionsPanel: React.FC<SuggestionsPanelProps> = ({ files, title, fallback, busy, onPick, className }) => {
  const t = useStudioTheme();
  const [suggestions, setSuggestions] = useState<StudioSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<'ai' | 'heuristic' | null>(null);
  // Dismissed for the current app state (like AI Studio's ✕). Re-shows when the code changes.
  const [dismissed, setDismissed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // A cheap, stable signature of the project so we only re-fetch when the code actually changes
  // (not on every render) — and never mid-build.
  const signature = useMemo(
    () => `${files.length}:${files.reduce((n, f) => n + (f.content?.length || 0), 0)}`,
    [files],
  );

  const heuristic = useMemo(() => fallbackToSuggestions(fallback), [fallback]);

  const fetchSuggestions = async (sig: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      // Dynamic import keeps the apiClient/supabase chain out of this component's static module
      // graph (loads in tests/SSR without env), pulling it in only when we actually fetch.
      const { suggestStudioNextSteps } = await import('../../../services/studioSuggestApi');
      const res = await suggestStudioNextSteps({ title, files }, controller.signal);
      if (controller.signal.aborted) return;
      if (res.suggestions.length) { setSuggestions(res.suggestions); setSource('ai'); }
      else { setSuggestions(heuristic); setSource('heuristic'); }
    } catch {
      if (!controller.signal.aborted) { setSuggestions(heuristic); setSource('heuristic'); }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
    void sig;
  };

  // Auto-fetch when the code settles (debounced) and a build isn't running.
  useEffect(() => {
    if (busy || !files.length) return;
    const id = window.setTimeout(() => void fetchSuggestions(signature), 1200);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Re-show suggestions whenever the app actually changes (a fresh code state = fresh ideas).
  useEffect(() => { setDismissed(false); }, [signature]);

  // Show heuristic immediately on first paint so the row is never empty while the AI thinks.
  const shown = suggestions.length ? suggestions : heuristic;
  if (!shown.length || dismissed) return null;

  // A single, compact, dismissible chip row — NOT a stacked card. This is the AI-Studio pattern:
  // the model's next-step ideas sit quietly above the composer as flat pills, not a panel that
  // owns a third of the column. Capped at three so it never crowds the input.
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`} aria-label="Suggested next steps">
      <Sparkles className={`h-3.5 w-3.5 shrink-0 ${t.accent}`} />
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${t.textFaint}`} title={source === 'ai' ? 'AI suggestions for this app' : 'Ideas'}>
        Suggested next
      </span>
      {shown.slice(0, 3).map((s, i) => {
        const meta = s.kind ? KIND_META[s.kind] : undefined;
        const Icon = meta?.Icon ?? ArrowUpRight;
        return (
          <button
            key={`${s.label}-${i}`}
            onClick={() => onPick(s.prompt)}
            disabled={busy}
            title={s.why || s.prompt}
            className={`inline-flex max-w-[15rem] items-center gap-1.5 rounded-full border ${t.edge} ${t.panelAlt} px-2.5 py-1 text-[11px] font-medium ${t.text} ${t.hover} disabled:opacity-50 ${t.focusRing} transition-colors`}
          >
            <Icon className={`h-3 w-3 shrink-0 ${meta?.tint ?? t.accent}`} />
            <span className="truncate">{s.label}</span>
          </button>
        );
      })}
      <button
        onClick={() => setDismissed(true)}
        title="Hide suggestions"
        aria-label="Hide suggestions"
        className={`ml-auto shrink-0 rounded-full p-0.5 ${t.hover} ${t.textFaint} ${t.focusRing}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};
