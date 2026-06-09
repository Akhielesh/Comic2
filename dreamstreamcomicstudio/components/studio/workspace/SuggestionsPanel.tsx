// SuggestionsPanel — real "what should I build next?" recommendations.
//
// This REPLACES the old hardcoded chip row (✨ Polish UI / 🌙 Dark mode / 📱 Responsive / …) that
// the user (rightly) called filler. Instead it asks the coding model to look at the ACTUAL app and
// propose the highest-value next steps as ready-to-run prompts. The request is best-effort: if the
// AI can't be reached (or returns nothing) it falls back to a local heuristic, so it always shows
// genuinely useful, app-aware suggestions — never an empty or broken row.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, RefreshCw, ArrowUpRight, Wrench, Database, Rocket, Wand2, Plus } from 'lucide-react';
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

  // Show heuristic immediately on first paint so the row is never empty while the AI thinks.
  const shown = suggestions.length ? suggestions : heuristic;
  if (!shown.length) return null;

  return (
    <div className={`rounded-lg border ${t.edge} ${t.panel} overflow-hidden ${className ?? ''}`}>
      <div className={`flex items-center gap-2 px-3 py-2 ${t.panelAlt} border-b ${t.edge}`}>
        <Sparkles className={`h-3.5 w-3.5 ${t.accent}`} />
        <span className={`text-[11px] font-bold uppercase tracking-wide ${t.textDim}`}>Suggested next</span>
        <span className={`text-[10px] ${t.textFaint}`}>{source === 'ai' ? 'AI · for this app' : 'ideas'}</span>
        <button
          onClick={() => void fetchSuggestions(signature)}
          disabled={loading || busy}
          title="Refresh suggestions"
          aria-label="Refresh suggestions"
          className={`ml-auto rounded p-1 ${t.hover} ${t.textFaint} disabled:opacity-50 ${t.focusRing}`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="p-2 space-y-1.5">
        {shown.map((s, i) => {
          const meta = s.kind ? KIND_META[s.kind] : undefined;
          const Icon = meta?.Icon ?? ArrowUpRight;
          return (
            <button
              key={`${s.label}-${i}`}
              onClick={() => onPick(s.prompt)}
              disabled={busy}
              title={s.prompt}
              className={`group flex w-full items-start gap-2.5 rounded-lg border ${t.edge} ${t.panelAlt} px-2.5 py-2 text-left ${t.hover} disabled:opacity-50 ${t.focusRing} transition-colors`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta?.tint ?? t.accent}`} />
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-xs font-semibold ${t.text}`}>{s.label}</span>
                {s.why && <span className={`block truncate text-[11px] ${t.textFaint}`}>{s.why}</span>}
              </span>
              <Wand2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 ${t.accent}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
};
