// AgentSettingsPanel — the Flow-parity settings sheet for the v3 Comic Studio.
//
// Controls how much the agent pauses before spending, what it delivers, and its budget.
// Persists into ComicState.agentSettings via onChange (normalized through
// services/comicAgentSettings). Slides in from the right; respects reduced motion.

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentConfirmPolicy, AgentOutputTarget, ComicAgentSettings } from '../../../types';
import {
  agentConfirmLabel,
  DEFAULT_AGENT_OUTPUT_TARGETS,
  makeDefaultComicAgentSettings,
  normalizeComicAgentSettings,
} from '../../../services/comicAgentSettings';
import { springSoft, usePrefersReducedMotion } from '../kit';

export interface AgentSettingsPanelProps {
  open: boolean;
  settings?: ComicAgentSettings;
  onChange: (next: ComicAgentSettings) => void;
  onClose: () => void;
  onOpenDetailed?: () => void;
}

const CONFIRM_OPTIONS: AgentConfirmPolicy[] = ['always', 'big_spends', 'never'];
const OUTPUTS: AgentOutputTarget[] = ['comic', 'book', 'html'];

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="space-y-2 border-t border-[var(--ds-hairline)] py-4 first:border-t-0 first:pt-0">
    <div>
      <div className="text-[13px] font-semibold text-[var(--ds-ink)]">{label}</div>
      {hint && <div className="text-[12px] text-[var(--ds-muted)]">{hint}</div>}
    </div>
    {children}
  </div>
);

export const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ open, settings, onChange, onClose, onOpenDetailed }) => {
  const reduced = usePrefersReducedMotion();
  const s = normalizeComicAgentSettings(settings ?? makeDefaultComicAgentSettings());

  const patch = (p: Partial<ComicAgentSettings>) => onChange(normalizeComicAgentSettings({ ...s, ...p, updatedAt: Date.now() }));

  const toggleOutput = (t: AgentOutputTarget) => {
    const has = s.outputTargets.includes(t);
    const next = has ? s.outputTargets.filter((x) => x !== t) : [...s.outputTargets, t];
    patch({ outputTargets: next.length ? next : DEFAULT_AGENT_OUTPUT_TARGETS });
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/40"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-label="Agent settings"
            className="fixed right-0 top-0 z-50 flex h-full w-[340px] max-w-[88vw] flex-col border-l border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-5 backdrop-blur-md"
            initial={reduced ? false : { x: 360 }}
            animate={{ x: 0 }}
            exit={{ x: 360 }}
            transition={springSoft}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-[var(--ds-ink)]">Agent settings</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg px-2 text-[var(--ds-muted)] hover:text-[var(--ds-ink)]">✕</button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <Row label="Confirm before generating" hint="When the agent should pause for your OK before it spends.">
                <div className="flex flex-col gap-1.5">
                  {CONFIRM_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => patch({ confirmPolicy: opt })}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[13px] transition-colors ${
                        s.confirmPolicy === opt
                          ? 'border-[var(--ds-accent)] bg-[#D97757]/10 text-[var(--ds-ink)]'
                          : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'
                      }`}
                    >
                      <span className={`h-3.5 w-3.5 rounded-full border ${s.confirmPolicy === opt ? 'border-[var(--ds-accent)] bg-[var(--ds-accent)]' : 'border-[var(--ds-hairline)]'}`} />
                      {agentConfirmLabel(opt)}
                    </button>
                  ))}
                </div>
              </Row>

              <Row label="Deliverables" hint="What the agent prepares for you at the end of the build.">
                <div className="flex flex-wrap gap-2">
                  {OUTPUTS.map((t) => {
                    const on = s.outputTargets.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => toggleOutput(t)}
                        aria-pressed={on}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                          on ? 'bg-[var(--ds-accent)] text-white' : 'bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] hover:bg-[var(--ds-hover)]'
                        }`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </Row>

              <Row label="Auto page count" hint="Let the agent infer page count from story length.">
                <button
                  type="button"
                  onClick={() => patch({ autoPageCount: !s.autoPageCount })}
                  aria-pressed={s.autoPageCount}
                  className={`relative h-6 w-11 rounded-full transition-colors ${s.autoPageCount ? 'bg-[var(--ds-accent)]' : 'bg-[var(--ds-well)]'}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${s.autoPageCount ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </Row>

              <Row label="Per-run budget cap" hint="The agent stops and asks before a run would exceed this.">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] text-[var(--ds-muted)]">$</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={s.budgetCapUsd ?? ''}
                    placeholder="none"
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      patch({ budgetCapUsd: Number.isFinite(v) && v > 0 ? v : undefined });
                    }}
                    className="w-28 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-2 py-1.5 text-[13px] text-[var(--ds-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--ds-accent)]"
                  />
                </div>
              </Row>
            </div>

            {onOpenDetailed && (
              <button
                type="button"
                onClick={onOpenDetailed}
                className="mt-3 w-full rounded-xl border border-[var(--ds-hairline)] py-2 text-[13px] font-semibold text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]"
              >
                Switch to Detailed editor
              </button>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
};

export default AgentSettingsPanel;
