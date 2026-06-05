import React, { useState } from 'react';
import { Network, Loader2, Check, AlertTriangle, Circle, ChevronDown, Search, ShieldCheck } from 'lucide-react';
import type { SwarmTraceArtifact, SwarmAgentStatus } from '../../../apiTypes';

const statusIcon = (status: SwarmAgentStatus) => {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-fuchsia-600 animate-spin" />;
    case 'done':
      return <Check className="w-3.5 h-3.5 text-emerald-600" />;
    case 'error':
      return <AlertTriangle className="w-3.5 h-3.5 text-brand-red" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-slate-300" />;
  }
};

// Verifier confidence (0–1) → a colored chip. Green = well-supported, amber = thin,
// red = weak/unverified. Mirrors the server-side verify.ts banding.
const confidenceStyle = (c: number): string =>
  c >= 0.75
    ? 'border-emerald-300 text-emerald-700 bg-emerald-50'
    : c >= 0.4
      ? 'border-amber-300 text-amber-700 bg-amber-50'
      : 'border-red-300 text-brand-red bg-red-50';

// Humanize a verifier flag for the tooltip/badge.
const FLAG_LABELS: Record<string, string> = {
  no_sources: 'no sources',
  unverified_figures: 'unverified figures',
  hedged: 'hedged',
  thin: 'thin',
  empty: 'empty',
  errored: 'errored'
};

// Live trace of the agent swarm: which specialized agents the planner deployed,
// what each is doing, a verifier confidence + flags per finding, and a short summary.
export const SwarmTraceCard: React.FC<{ data: SwarmTraceArtifact }> = ({ data }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!data?.agents?.length) return null;
  const done = data.agents.filter((a) => a.status === 'done').length;
  const running = data.agents.some((a) => a.status === 'running' || a.status === 'pending');

  // Overall confidence = mean of the agents the verifier scored (shown once the run settles).
  const scored = data.agents.filter((a) => typeof a.confidence === 'number');
  const overall = scored.length ? scored.reduce((s, a) => s + (a.confidence || 0), 0) / scored.length : undefined;

  return (
    <div className="my-2 border-2 border-black rounded-lg bg-white shadow-comic overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b-2 border-black bg-fuchsia-50">
        <Network className="w-4 h-4" />
        <span className="text-[12px] font-extrabold uppercase tracking-wide">Agent swarm</span>
        {typeof overall === 'number' && !running && (
          <span
            title="Verifier confidence across all findings"
            className={`flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border ${confidenceStyle(overall)}`}
          >
            <ShieldCheck className="w-3 h-3" />
            {Math.round(overall * 100)}%
          </span>
        )}
        <span className="ml-auto text-[11px] font-bold text-slate-500">
          {running ? `${done}/${data.agents.length} done` : `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {data.agents.map((a, i) => {
          const expanded = open[a.id + i];
          const flags = a.flags || [];
          const canExpand = Boolean(a.summary || (a.toolEvents && a.toolEvents.length) || flags.length);
          return (
            <li key={a.id + i}>
              <button
                onClick={() => canExpand && setOpen((o) => ({ ...o, [a.id + i]: !expanded }))}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left ${canExpand ? 'hover:bg-fuchsia-50/60' : ''}`}
              >
                <span className="mt-0.5 shrink-0">{statusIcon(a.status)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-bold">{a.name}</span>
                    {typeof a.confidence === 'number' && a.status === 'done' && (
                      <span className={`text-[10px] font-bold px-1 py-px rounded border ${confidenceStyle(a.confidence)}`}>
                        {Math.round(a.confidence * 100)}%
                      </span>
                    )}
                    {a.toolEvents && a.toolEvents.length > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-emerald-700"><Search className="w-3 h-3" />{a.toolEvents.length}</span>
                    )}
                  </span>
                  <span className="block text-[11px] text-slate-500 truncate">{a.task}</span>
                </span>
                {canExpand && <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
              </button>
              {expanded && (
                <div className="px-3 pb-2 pl-9 space-y-1.5">
                  {a.summary && <p className="text-[11px] text-slate-600 whitespace-pre-wrap">{a.summary}</p>}
                  {flags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {flags.map((f, j) => (
                        <span key={j} className="text-[10px] px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-700">
                          ⚠ {FLAG_LABELS[f] || f}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.toolEvents && a.toolEvents.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {a.toolEvents.map((ev, j) => (
                        <span key={j} className={`text-[10px] px-1.5 py-0.5 rounded border ${ev.ok ? 'border-emerald-300 text-emerald-700' : 'border-red-300 text-brand-red'}`}>
                          {ev.tool}{ev.query ? `: ${ev.query}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
