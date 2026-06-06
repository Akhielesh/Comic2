// ClarifyPanel — the studio's "the engineer is asking you a few questions" step.
//
// Renders the AI's clarifying questions (single- or multi-select options + an optional custom
// answer) and the assumptions it will otherwise make, then hands back the user's answers. This is
// what makes the build feel like a conversation with a team rather than a one-shot prompt.

import React, { useState } from 'react';
import { Check, Sparkles, ListChecks, ArrowRight, Loader2 } from 'lucide-react';
import { useStudioTheme } from '../kit';
import type { StudioClarifyQuestion, StudioAnswer } from '../../../apiTypes';

export interface ClarifyPanelProps {
  questions: StudioClarifyQuestion[];
  assumptions: string[];
  onSubmit: (answers: StudioAnswer[]) => void;
  onSkip: () => void;
  busy?: boolean;
}

interface QState {
  selected: string[]; // option values
  custom: string;
}

export const ClarifyPanel: React.FC<ClarifyPanelProps> = ({ questions, assumptions, onSubmit, onSkip, busy }) => {
  const t = useStudioTheme();
  const [state, setState] = useState<Record<string, QState>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, { selected: [], custom: '' }]))
  );

  const toggle = (q: StudioClarifyQuestion, value: string) =>
    setState((s) => {
      const cur = s[q.id] ?? { selected: [], custom: '' };
      let selected: string[];
      if (q.kind === 'single') selected = cur.selected.includes(value) ? [] : [value];
      else selected = cur.selected.includes(value) ? cur.selected.filter((v) => v !== value) : [...cur.selected, value];
      return { ...s, [q.id]: { ...cur, selected } };
    });

  const setCustom = (id: string, custom: string) =>
    setState((s) => ({ ...s, [id]: { ...(s[id] ?? { selected: [], custom: '' }), custom } }));

  const buildAnswers = (): StudioAnswer[] => {
    const out: StudioAnswer[] = [];
    for (const q of questions) {
      const cur = state[q.id] ?? { selected: [], custom: '' };
      const labels = cur.selected
        .map((v) => q.options.find((o) => o.value === v)?.label || v);
      const parts = [...labels];
      if (cur.custom.trim()) parts.push(cur.custom.trim());
      if (parts.length) out.push({ question: q.question, answer: parts.join(', ') });
    }
    return out;
  };

  return (
    <div className={`rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} p-4 space-y-4`}>
      <div className="flex items-center gap-2">
        <Sparkles className={`w-5 h-5 ${t.accent}`} />
        <h2 className="font-display text-lg">A few quick questions</h2>
        <span className={`ml-auto text-[11px] ${t.textFaint}`}>Pick options or type your own — or skip and I'll decide.</span>
      </div>

      {questions.map((q) => {
        const cur = state[q.id] ?? { selected: [], custom: '' };
        return (
          <div key={q.id} className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
            <p className="text-sm font-bold mb-2">
              {q.question}
              <span className={`ml-2 text-[10px] font-semibold uppercase ${t.textFaint}`}>{q.kind === 'multi' ? 'pick any' : 'pick one'}</span>
            </p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const on = cur.selected.includes(o.value);
                return (
                  <button
                    key={o.value}
                    onClick={() => toggle(q, o.value)}
                    title={o.hint}
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${t.focusRing} ${
                      on ? `${t.edgeStrong} ${t.accentSoft} ${t.accent}` : `${t.edge} ${t.textDim} ${t.hover}`
                    }`}
                  >
                    {on && <Check className="w-3 h-3" />}
                    {o.label}
                  </button>
                );
              })}
            </div>
            {q.allowCustom && (
              <input
                value={cur.custom}
                onChange={(e) => setCustom(q.id, e.target.value)}
                placeholder="Or describe your own answer…"
                className={`mt-2 w-full rounded-lg border ${t.edge} ${t.panel} ${t.text} text-xs px-2.5 py-2 ${t.focusRing}`}
              />
            )}
          </div>
        );
      })}

      {assumptions.length > 0 && (
        <div className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
          <p className={`flex items-center gap-1.5 text-[11px] font-bold uppercase ${t.textFaint} mb-1`}>
            <ListChecks className="w-3.5 h-3.5" /> I'll assume
          </p>
          <ul className={`text-xs ${t.textDim} space-y-0.5`}>
            {assumptions.map((a, i) => <li key={i}>• {a}</li>)}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => onSubmit(buildAnswers())}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 rounded-full border ${t.edgeStrong} ${t.accentBg} ${t.accentText} px-4 py-2 text-sm font-bold ${t.accentBgHover} disabled:opacity-50 ${t.focusRing}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />} Continue to plan
        </button>
        <button
          onClick={onSkip}
          disabled={busy}
          className={`text-xs font-semibold rounded-full border ${t.edge} px-3 py-2 ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
        >
          Skip — just build it
        </button>
      </div>
    </div>
  );
};
