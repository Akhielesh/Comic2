// PlanPanel — the studio's "here's the build plan, approve it" step.
//
// Shows the tech-lead's plan (summary, stack, features, file tree, data sources, notes) before any
// code is written, so the user sees what will be built and can approve, regenerate, or go back.

import React from 'react';
import { Wand2, RefreshCw, ArrowLeft, Loader2, FileCode2, CheckCircle2, Database, Layers, ListChecks } from 'lucide-react';
import { useStudioTheme } from '../kit';
import type { StudioBuildPlan } from '../../../apiTypes';

export interface PlanPanelProps {
  plan: StudioBuildPlan;
  onBuild: () => void;
  onRegenerate: () => void;
  onBack: () => void;
  busy?: boolean;
}

export const PlanPanel: React.FC<PlanPanelProps> = ({ plan, onBuild, onRegenerate, onBack, busy }) => {
  const t = useStudioTheme();
  return (
    <div className={`rounded-xl border ${t.edgeStrong} ${t.panel} ${t.text} p-4 space-y-4`}>
      <div className="flex items-start gap-2">
        <Layers className={`w-5 h-5 mt-0.5 ${t.accent}`} />
        <div className="min-w-0">
          <h2 className="font-display text-lg leading-tight">{plan.title}</h2>
          {plan.appType && <p className={`text-[11px] font-semibold uppercase ${t.textFaint}`}>{plan.appType}</p>}
        </div>
      </div>

      {plan.summary && <p className={`text-sm ${t.textDim}`}>{plan.summary}</p>}

      {plan.stack.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {plan.stack.map((s, i) => (
            <span key={i} className={`rounded-full border ${t.edge} px-2.5 py-1 text-[11px] font-semibold ${t.textDim}`}>{s}</span>
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3">
        {plan.features.length > 0 && (
          <div className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
            <p className={`flex items-center gap-1.5 text-[11px] font-bold uppercase ${t.textFaint} mb-1.5`}>
              <ListChecks className="w-3.5 h-3.5" /> Features ({plan.features.length})
            </p>
            <ul className="space-y-1">
              {plan.features.map((f, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs">
                  <CheckCircle2 className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${t.accent}`} /> <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.files.length > 0 && (
          <div className={`rounded-lg border ${t.edge} ${t.panelAlt} p-3`}>
            <p className={`flex items-center gap-1.5 text-[11px] font-bold uppercase ${t.textFaint} mb-1.5`}>
              <FileCode2 className="w-3.5 h-3.5" /> Files ({plan.files.length})
            </p>
            <ul className="space-y-1 max-h-56 overflow-auto">
              {plan.files.map((f, i) => (
                <li key={i} className="text-xs">
                  <span className="font-mono">{f.path}</span>
                  {f.purpose && <span className={`block text-[10px] ${t.textFaint}`}>{f.purpose}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {plan.dataSources && plan.dataSources.length > 0 && (
        <div className={`flex items-start gap-1.5 text-xs ${t.textDim}`}>
          <Database className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${t.accent}`} />
          <span><span className="font-bold">Live data:</span> {plan.dataSources.join(', ')}</span>
        </div>
      )}

      {plan.notes && plan.notes.length > 0 && (
        <ul className={`text-[11px] ${t.textFaint} space-y-0.5`}>
          {plan.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={onBuild}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 rounded-full border ${t.edgeStrong} ${t.accentBg} ${t.accentText} px-4 py-2 text-sm font-bold ${t.accentBgHover} disabled:opacity-50 ${t.focusRing}`}
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Build this plan
        </button>
        <button
          onClick={onRegenerate}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-full border ${t.edge} px-3 py-2 ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Regenerate
        </button>
        <button
          onClick={onBack}
          disabled={busy}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-full border ${t.edge} px-3 py-2 ${t.textDim} ${t.hover} disabled:opacity-50 ${t.focusRing}`}
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
      </div>
    </div>
  );
};
