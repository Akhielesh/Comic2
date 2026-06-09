// StudioBuildFlow — the "engineering team" build experience for a NEW app.
//
// Instead of one-shotting a prompt into a single file, the studio runs an explicit, honest flow:
//   Understand (clarifying questions) → Plan (reviewable build plan) → Build (multi-file, streamed)
//   → Review (the agent team, in the workspace once files exist).
// This component renders the active stage + a phase stepper, with real loading states so nothing
// ever claims to be "ready" before there's actually an app.

import React from 'react';
import { Loader2, Check, Brain, ListChecks, Hammer, ShieldCheck, AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';
import { useStudioTheme } from './kit';
import { ClarifyPanel, PlanPanel, ActivityFeed, LiveProgress } from './workspace';
import { StudioPlanThinking } from './StudioPlanThinking';
import type { StudioClarifyResult, StudioBuildPlan, StudioAnswer } from '../../apiTypes';

export type StudioFlowPhase = 'idle' | 'clarifying' | 'questions' | 'planning' | 'plan' | 'building' | 'error';

export interface StudioFlowState {
  phase: StudioFlowPhase;
  prompt: string;
  clarify?: StudioClarifyResult;
  answers: StudioAnswer[];
  plan?: StudioBuildPlan;
  error?: string;
}

export interface StudioBuildFlowProps {
  state: StudioFlowState;
  onSubmitAnswers: (answers: StudioAnswer[]) => void;
  onSkipQuestions: () => void;
  onBuild: () => void;
  onRegeneratePlan: () => void;
  onBack: () => void;
  onRetry: () => void;
  busy: boolean;
}

const STEPS: { key: string; label: string; icon: React.FC<{ className?: string }>; phases: StudioFlowPhase[] }[] = [
  { key: 'understand', label: 'Understand', icon: Brain, phases: ['clarifying', 'questions'] },
  { key: 'plan', label: 'Plan', icon: ListChecks, phases: ['planning', 'plan'] },
  { key: 'build', label: 'Build', icon: Hammer, phases: ['building'] },
  { key: 'review', label: 'Review', icon: ShieldCheck, phases: [] },
];

const Stepper: React.FC<{ phase: StudioFlowPhase }> = ({ phase }) => {
  const t = useStudioTheme();
  let active = STEPS.findIndex((s) => s.phases.includes(phase));
  if (phase === 'building') active = 2;
  if (active < 0) active = phase === 'error' ? -1 : 0;
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = active > i;
        const isActive = active === i;
        const Icon = s.icon;
        return (
          <React.Fragment key={s.key}>
            <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
              isActive ? `${t.edgeStrong} ${t.accentSoft} ${t.accent}` : done ? `${t.edge} ${t.textDim}` : `${t.edge} ${t.textFaint}`
            }`}>
              {done ? <Check className="w-3 h-3" /> : isActive ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
              {s.label}
            </div>
            {i < STEPS.length - 1 && <div className={`h-px w-4 ${t.edge} border-t`} />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const Loading: React.FC<{ label: string; sub?: string }> = ({ label, sub }) => {
  const t = useStudioTheme();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Loader2 className={`w-7 h-7 animate-spin ${t.accent}`} />
      <p className={`text-sm font-bold ${t.text}`}>{label}</p>
      {sub && <p className={`text-xs ${t.textFaint} max-w-md`}>{sub}</p>}
    </div>
  );
};

export const StudioBuildFlow: React.FC<StudioBuildFlowProps> = ({
  state, onSubmitAnswers, onSkipQuestions, onBuild, onRegeneratePlan, onBack, onRetry, busy
}) => {
  const t = useStudioTheme();
  return (
    <div className="flex-1 min-h-0 overflow-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className={`inline-flex items-center gap-1 text-xs font-semibold ${t.textDim} ${t.hover} rounded-md px-1.5 py-1 ${t.focusRing}`}>
            <ArrowLeft className="w-4 h-4" /> Start over
          </button>
          <Stepper phase={state.phase} />
        </div>

        <div className={`rounded-lg border ${t.edge} ${t.panelAlt} px-3 py-2`}>
          <p className={`text-[11px] font-bold uppercase ${t.textFaint}`}>Building</p>
          <p className="text-sm font-semibold truncate">{state.prompt}</p>
        </div>

        {state.phase === 'clarifying' && (
          <Loading label="Understanding your idea…" sub="A senior engineer is reviewing your request and deciding what to ask." />
        )}

        {state.phase === 'questions' && state.clarify && (
          <ClarifyPanel
            questions={state.clarify.questions}
            assumptions={state.clarify.assumptions}
            onSubmit={onSubmitAnswers}
            onSkip={onSkipQuestions}
            busy={busy}
          />
        )}

        {state.phase === 'planning' && <StudioPlanThinking />}

        {state.phase === 'plan' && state.plan && (
          <PlanPanel plan={state.plan} onBuild={onBuild} onRegenerate={onRegeneratePlan} onBack={onBack} busy={busy} />
        )}

        {state.phase === 'building' && (
          <div className={`rounded-xl border ${t.edgeStrong} ${t.panel} overflow-hidden`}>
            {/* Premium loading screen with a live, rolling status ticker (no opaque spinner). */}
            <LiveProgress phase="generating" active variant="screen" />
            <div className={`border-t ${t.edge} p-4 space-y-2`}>
              <p className={`text-xs ${t.textFaint}`}>Writing the planned files. The preview opens automatically once the app is ready — then the agent team reviews it.</p>
              <ActivityFeed onRetry={onRetry} />
            </div>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 space-y-3">
            <p className="flex items-center gap-2 text-sm font-bold text-rose-400">
              <AlertTriangle className="w-4 h-4" /> {state.error || 'Something went wrong.'}
            </p>
            <div className="flex gap-2">
              <button onClick={onRetry} className={`inline-flex items-center gap-1.5 rounded-full border ${t.edgeStrong} px-3 py-1.5 text-xs font-bold ${t.text} ${t.hover} ${t.focusRing}`}>
                <RotateCcw className="w-3.5 h-3.5" /> Try again
              </button>
              <button onClick={onBack} className={`inline-flex items-center gap-1.5 rounded-full border ${t.edge} px-3 py-1.5 text-xs font-semibold ${t.textDim} ${t.hover} ${t.focusRing}`}>
                <ArrowLeft className="w-3.5 h-3.5" /> Start over
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
