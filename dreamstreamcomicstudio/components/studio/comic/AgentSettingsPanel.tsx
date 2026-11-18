// AgentSettingsPanel — the Flow-parity settings sheet for the v3 Comic Studio.
//
// Controls how much the agent pauses before spending, what it delivers, and its budget.
// Persists into ComicState.agentSettings via onChange (normalized through
// services/comicAgentSettings). Slides in from the right; respects reduced motion.

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AgentConfirmPolicy, AgentOutputTarget, ComicAgentSettings, ConsistencyPolicy } from '../../../types';
import {
  agentConfirmLabel,
  consistencyLabel,
  DEFAULT_AGENT_OUTPUT_TARGETS,
  makeDefaultComicAgentSettings,
  normalizeComicAgentSettings,
} from '../../../services/comicAgentSettings';
import { springSoft, usePrefersReducedMotion } from '../kit';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button, IconButton, FILTER_CHIP, FILTER_CHIP_ON, SWITCH_HIT_AREA, SWITCH_THUMB, SWITCH_TRACK } from '../../ds';
import {
  ACCENT_SOFT_BG,
  CHIP_VARIANT,
  DENSITY,
  FIELD_GROUP,
  FIELD_EMBEDDED,
  FOCUS_RING,
  INK,
  MUTED,
  RADIUS_CONTROL,
  RADIUS_ROUND,
  SCRIM,
  TRANSITION,
  Z
} from '../../chat/studioDesign';

/** A choice row (confirm policy, consistency): the ink edge and the accent tint when chosen. */
const choice = (on: boolean) =>
  cn(
    'border text-[13px]',
    RADIUS_CONTROL,
    TRANSITION,
    DENSITY.touch,
    FOCUS_RING,
    on ? cn('border-[var(--ds-ink)]', ACCENT_SOFT_BG, INK) : cn('border-[var(--ds-hairline)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]', MUTED)
  );

export interface AgentSettingsPanelProps {
  open: boolean;
  settings?: ComicAgentSettings;
  onChange: (next: ComicAgentSettings) => void;
  onClose: () => void;
  onOpenDetailed?: () => void;
}

const CONFIRM_OPTIONS: AgentConfirmPolicy[] = ['always', 'big_spends', 'never'];
const OUTPUTS: AgentOutputTarget[] = ['comic', 'book', 'html'];
const CONSISTENCY_OPTIONS: ConsistencyPolicy[] = ['resilient', 'strict'];

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
            className={cn('fixed inset-0', Z.scrim, SCRIM)}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.aside
            role="dialog"
            aria-label="Agent settings"
            className={cn('fixed right-0 top-0 flex h-full w-[340px] max-w-[88vw] flex-col border-l border-[var(--ds-overlay-edge)] bg-[var(--ds-raised)] p-5 shadow-[shadow:var(--ds-shadow-overlay)]', Z.sheet, INK)}
            initial={reduced ? false : { x: 360 }}
            animate={{ x: 0 }}
            exit={{ x: 360 }}
            transition={springSoft}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-[var(--ds-ink)]">Agent settings</h2>
              <IconButton label="Close" title={null} onClick={onClose} className={cn('-mr-2', MUTED)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <Row label="Confirm before generating" hint="When the agent should pause for your OK before it spends.">
                <div className="flex flex-col gap-1.5">
                  {CONFIRM_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      aria-pressed={s.confirmPolicy === opt}
                      onClick={() => patch({ confirmPolicy: opt })}
                      className={cn('flex items-center gap-2 px-3 py-2 text-left', choice(s.confirmPolicy === opt))}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'h-3.5 w-3.5 shrink-0 border',
                          RADIUS_ROUND,
                          s.confirmPolicy === opt ? 'border-[var(--ds-ink)] bg-[var(--ds-ink)]' : 'border-[var(--ds-control-border)]'
                        )}
                      />
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
                        className={cn(FILTER_CHIP, FOCUS_RING, TRANSITION, on ? FILTER_CHIP_ON : cn(CHIP_VARIANT.outline, 'hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]'))}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </Row>

              <Row label="Consistency" hint="Keep one image model for a uniform book, or finish even if it must fall back.">
                <div className="flex gap-2">
                  {CONSISTENCY_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => patch({ consistencyPolicy: opt })}
                      aria-pressed={s.consistencyPolicy === opt}
                      className={cn('min-w-0 flex-1 px-3 py-2 text-[12px] font-medium', choice(s.consistencyPolicy === opt))}
                    >
                      {consistencyLabel(opt)}
                    </button>
                  ))}
                </div>
              </Row>

              <Row label="Auto page count" hint="Let the agent infer page count from story length.">
                <button
                  type="button"
                  onClick={() => patch({ autoPageCount: !s.autoPageCount })}
                  aria-pressed={s.autoPageCount}
                  aria-label="Auto page count"
                  data-state={s.autoPageCount ? 'checked' : 'unchecked'}
                  className={cn(SWITCH_TRACK, SWITCH_HIT_AREA, FOCUS_RING)}
                >
                  <span data-state={s.autoPageCount ? 'checked' : 'unchecked'} className={SWITCH_THUMB} />
                </button>
              </Row>

              <Row label="Per-run budget cap" hint="The agent stops and asks before a run would exceed this.">
                <div className={cn(FIELD_GROUP, 'w-36 px-2.5', DENSITY.comfortable)}>
                  <span aria-hidden className={cn('text-[14px]', MUTED)}>$</span>
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
                    aria-label="Per-run budget cap in USD"
                    className={cn(FIELD_EMBEDDED, 'py-1.5 text-[13px] tabular-nums', INK, 'placeholder:text-[var(--ds-muted)]')}
                  />
                </div>
              </Row>
            </div>

            {onOpenDetailed && (
              <Button type="button" variant="outline" onClick={onOpenDetailed} className="mt-3 w-full">
                Switch to Detailed editor
              </Button>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
};

export default AgentSettingsPanel;
