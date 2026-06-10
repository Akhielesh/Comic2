import React, { useState } from 'react';
import { Wand2, ArrowRight, Sparkles } from 'lucide-react';
import { recommendModels, type ModelSuggestion } from '../../services/chatSuggest';
import { sourceLabel, providerOrigin, costLabel, type CatalogModel } from '../../services/modelCatalog';
import {
  GLASS, HAIRLINE, MUTED, INK, TRANSITION, SHADOW_SOFT,
  ACCENT_BG, ACCENT_BG_HOVER, ACCENT_SOFT_BG, HOVER_LIFT
} from './studioDesign';

interface ChatModelSuggesterProps {
  models: CatalogModel[];
  /** Start a chat with the chosen model, seeding the goal as the first message. */
  onStart: (model: CatalogModel, goal: string) => void;
}

export const ChatModelSuggester: React.FC<ChatModelSuggesterProps> = ({ models, onStart }) => {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [suggestions, setSuggestions] = useState<ModelSuggestion[] | null>(null);

  const suggest = () => {
    if (!goal.trim()) return;
    setSuggestions(recommendModels(goal, models));
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-2 text-xs font-medium ${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-xl px-3 py-2 ${TRANSITION} hover:bg-[var(--ds-raised)] ${HOVER_LIFT}`}
      >
        <Wand2 className="w-4 h-4" /> Not sure which model? Describe your goal
      </button>
    );
  }

  return (
    <div className={`w-full ${GLASS} ${HAIRLINE} ${SHADOW_SOFT} rounded-2xl p-3 text-left`}>
      <div className={`flex items-center gap-2 mb-2 text-sm font-semibold tracking-tight ${INK}`}><Wand2 className="w-4 h-4" /> Find the right model</div>
      <textarea
        autoFocus
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) suggest(); }}
        rows={2}
        placeholder="e.g. debug a React component / research the latest on a topic / read a screenshot"
        className={`w-full resize-none ${HAIRLINE} rounded-xl bg-[var(--ds-surface-soft)] px-3 py-2 text-sm outline-none focus:border-[#D97757]/40 ${TRANSITION}`}
      />
      <div className="flex justify-between items-center mt-2">
        <button onClick={() => { setOpen(false); setSuggestions(null); }} className={`text-[11px] font-semibold ${MUTED} hover:text-[var(--ds-ink)]`}>Cancel</button>
        <button
          onClick={suggest}
          disabled={!goal.trim() || models.length === 0}
          className={`flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white ${TRANSITION} disabled:opacity-40`}
        >
          <Sparkles className="w-3.5 h-3.5" /> Suggest models
        </button>
      </div>

      {models.length === 0 && (
        <p className={`text-[11px] ${MUTED} mt-2`}>The model catalog is still loading — try again in a moment.</p>
      )}

      {suggestions && (
        <div className="mt-3 space-y-2">
          {suggestions.length === 0 ? (
            <p className={`text-[11px] ${MUTED}`}>No strong match — pick any model from the switcher above.</p>
          ) : (
            suggestions.map(({ model, reasons }, i) => (
              <div key={model.id} className={`${HAIRLINE} rounded-xl p-2.5 ${i === 0 ? ACCENT_SOFT_BG : 'bg-[var(--ds-surface-soft)]'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{sourceLabel(providerOrigin(model))}{i === 0 ? ' · Best match' : ''}</div>
                    <div className={`font-semibold text-sm leading-tight truncate ${INK}`}>{model.name}</div>
                  </div>
                  <span className={`text-[11px] font-semibold ${MUTED} shrink-0`}>{costLabel(model)}</span>
                </div>
                <p className={`text-[11px] ${MUTED} mt-1`}>{reasons.slice(0, 3).join(' · ')}</p>
                <button
                  onClick={() => onStart(model, goal.trim())}
                  className={`mt-2 w-full flex items-center justify-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 ${ACCENT_BG} ${ACCENT_BG_HOVER} text-white ${TRANSITION}`}
                >
                  Start chat with this model <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
