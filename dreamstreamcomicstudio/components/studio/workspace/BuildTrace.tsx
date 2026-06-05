// BuildTrace (Sprint 2, S2.2): the animated agentic-build timeline. Each streamed stage
// (plan → run → observe → fix → done) springs in as a row; the active stage pulses; a footer
// summarises the result (✓ built / ⚠ stopped) with a small success flourish.

import React from 'react';
import { ListChecks, Play, ScanLine, Wrench, CheckCircle2, OctagonAlert, Sparkles, Hand } from 'lucide-react';
import { Reveal, StatusPulse, useStudioTheme } from '../kit';
import { useStudioBuild } from './buildStore';
import type { BuildStage } from '../../../services/studioBuildApi';

const STAGE_META: Record<BuildStage, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  plan: { label: 'Plan', Icon: ListChecks },
  run: { label: 'Run', Icon: Play },
  observe: { label: 'Observe', Icon: ScanLine },
  fix: { label: 'Fix', Icon: Wrench },
  done: { label: 'Done', Icon: CheckCircle2 },
  stopped: { label: 'Stopped', Icon: OctagonAlert },
};

/** Turn a guard reason into a friendly "over to you" message (S2.4 stuck UX). */
export const friendlyReason = (reason: string): { title: string; hint?: string } => {
  const r = (reason || '').toLowerCase();
  if (r.includes('stuck')) return { title: 'The agent got stuck', hint: 'Edit the code and Build again, or refine it by prompt.' };
  if (r.includes('iteration') || r.includes('cap') || r.includes('max')) {
    return { title: 'Reached the fix limit', hint: 'Edit the code and Build again to keep going.' };
  }
  return { title: `Stopped: ${reason}` };
};

export const BuildTrace: React.FC = () => {
  const t = useStudioTheme();
  const { running, events, result, error, iteration } = useStudioBuild();

  const empty = events.length === 0 && !running && !result && !error;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`text-[11px] font-semibold uppercase tracking-wide ${t.textFaint}`}>Build trace</p>
        {running && <StatusPulse status="starting" label={`Iteration ${iteration}`} />}
      </div>

      {empty && (
        <p className={`text-xs ${t.textFaint}`}>Press <span className={t.accent}>Build</span> to run the app and self-heal errors — the steps stream here.</p>
      )}

      {events.map((e, i) => {
        const meta = STAGE_META[e.stage] ?? STAGE_META.plan;
        const Icon = meta.Icon;
        const isLast = i === events.length - 1;
        const active = running && isLast;
        return (
          <Reveal key={i} distance={6}>
            <div className={`flex items-start gap-2 rounded-md border ${t.edge} px-2.5 py-2`}>
              <span className={`mt-0.5 shrink-0 ${active ? t.accent : t.textDim}`}>
                {active ? <StatusPulse status="starting" hideLabel /> : <Icon className="w-3.5 h-3.5" />}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-semibold ${t.text}`}>{meta.label}</span>
                  {e.iteration > 0 && (e.stage === 'fix' || e.stage === 'observe' || e.stage === 'run') && (
                    <span className={`text-[10px] rounded-full border ${t.edge} px-1.5 ${t.textFaint}`}>iter {e.iteration}</span>
                  )}
                </div>
                <p className={`text-[11px] ${t.textDim} break-words`}>{e.message}</p>
                {e.observation?.summary && (
                  <p className="text-[11px] text-amber-500 break-words">{e.observation.summary}</p>
                )}
              </div>
            </div>
          </Reveal>
        );
      })}

      {result && result.ok && (
        <Reveal>
          <div className="flex items-center gap-2 rounded-md border px-2.5 py-2 border-emerald-500/30 bg-emerald-500/10">
            <Sparkles className="w-4 h-4 text-emerald-500 animate-pulse" />
            <span className="text-xs font-semibold text-emerald-600">
              Built &amp; running{result.iterations ? ` after ${result.iterations} fix${result.iterations > 1 ? 'es' : ''}` : ''} 🎉
            </span>
          </div>
        </Reveal>
      )}

      {result && !result.ok && (() => {
        const f = friendlyReason(result.reason);
        return (
          <Reveal>
            <div className="rounded-md border px-2.5 py-2 border-amber-500/30 bg-amber-500/10">
              <div className="flex items-center gap-2">
                <Hand className="w-4 h-4 text-amber-500 animate-pulse" />
                <span className="text-xs font-semibold text-amber-600">{f.title} — over to you</span>
              </div>
              {f.hint && <p className="pl-6 mt-0.5 text-[11px] text-amber-600/80">{f.hint}</p>}
            </div>
          </Reveal>
        );
      })()}

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-2 text-xs font-semibold text-rose-500 break-words">
          {error}
        </div>
      )}
    </div>
  );
};
