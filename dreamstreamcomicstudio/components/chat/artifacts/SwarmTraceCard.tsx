import React, { useState } from 'react';
import { Network, Loader2, Check, AlertTriangle, Circle, ChevronDown, Search } from 'lucide-react';
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

// Live trace of the agent swarm: which specialized agents the planner deployed,
// what each is doing, and a short summary of each finding once complete.
export const SwarmTraceCard: React.FC<{ data: SwarmTraceArtifact }> = ({ data }) => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!data?.agents?.length) return null;
  const done = data.agents.filter((a) => a.status === 'done').length;
  const running = data.agents.some((a) => a.status === 'running' || a.status === 'pending');

  return (
    <div className="my-2 border-2 border-black rounded-lg bg-white shadow-comic overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b-2 border-black bg-fuchsia-50">
        <Network className="w-4 h-4" />
        <span className="text-[12px] font-extrabold uppercase tracking-wide">Agent swarm</span>
        <span className="ml-auto text-[11px] font-bold text-slate-500">
          {running ? `${done}/${data.agents.length} done` : `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {data.agents.map((a, i) => {
          const expanded = open[a.id + i];
          const canExpand = Boolean(a.summary || (a.toolEvents && a.toolEvents.length));
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
