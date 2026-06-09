// The plan-phase "thinking" view — replaces the bare spinner while the build plan is being drafted
// with a live engineering-team trace: each specialist (Planner, Architect, Designer, Flow) lights up
// in turn and a checklist assembles, so the wait shows real work happening (Lovable/Emergent-style)
// instead of an opaque loader. The roles mirror the studio agent constitution; the plan that lands
// next (PlanPanel) is the real output — this is an honest progress view of the planning work, not a
// fabricated debate.

import React, { useEffect, useState } from 'react';
import { Boxes, Palette, Route, ListChecks, Check, Loader2 } from 'lucide-react';
import { useStudioTheme } from './kit';

interface PlanAgent {
  id: string;
  role: string;
  Icon: React.FC<{ className?: string }>;
  line: string;
}

// The engineering team, in dependency order (plan → architecture → design → flow).
export const PLAN_AGENTS: PlanAgent[] = [
  { id: 'planner', role: 'Planner', Icon: ListChecks, line: 'Bounding the scope to the smallest plan that nails the core loop…' },
  { id: 'architect', role: 'Architect', Icon: Boxes, line: 'Choosing the stack, the file shape and where state lives…' },
  { id: 'designer', role: 'Designer', Icon: Palette, line: 'Setting the look, the layout and every state (loading/empty/error)…' },
  { id: 'flow', role: 'Flow', Icon: Route, line: 'Walking the happy path and the edge cases — no dead ends…' }
];

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

export const StudioPlanThinking: React.FC<{ className?: string }> = ({ className }) => {
  const t = useStudioTheme();
  // `active` = index of the specialist currently "thinking"; everything before it is done. It walks
  // forward and parks on the last one until the real plan arrives and replaces this whole view.
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setActive(PLAN_AGENTS.length - 1); // show the team engaged, no motion
      return;
    }
    const id = setInterval(() => setActive((i) => Math.min(i + 1, PLAN_AGENTS.length - 1)), 1300);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Your engineering team is drafting the build plan"
      className={`rounded-xl border ${t.edgeStrong} ${t.panel} p-4 space-y-3 ${className ?? ''}`}
    >
      <div className="flex items-center gap-2">
        <Loader2 className={`w-4 h-4 animate-spin ${t.accent}`} />
        <h2 className={`font-display text-base ${t.text}`}>Your engineering team is drafting the plan…</h2>
      </div>

      <ul className="space-y-2">
        {PLAN_AGENTS.map((agent, i) => {
          const done = i < active;
          const current = i === active;
          const Icon = agent.Icon;
          return (
            <li key={agent.id} className={`flex items-start gap-2.5 ${done || current ? '' : 'opacity-45'}`}>
              <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${done ? `${t.edgeStrong} ${t.accent}` : t.edge}`}>
                {done ? <Check className="w-3 h-3" /> : current ? <Loader2 className={`w-3 h-3 animate-spin ${t.accent}`} /> : <Icon className={`w-3 h-3 ${t.textFaint}`} />}
              </span>
              <div className="min-w-0">
                <p className={`text-xs font-bold ${t.text}`}>
                  {agent.role}
                  {current && <span className={`ml-1.5 font-semibold ${t.textFaint}`}>working…</span>}
                  {done && <span className={`ml-1.5 font-semibold ${t.accent}`}>ready</span>}
                </p>
                <p className={`text-[11px] leading-snug ${t.textDim}`}>{agent.line}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className={`text-[11px] ${t.textFaint}`}>Assembling the build checklist — you'll review it before anything is built.</p>
    </div>
  );
};
