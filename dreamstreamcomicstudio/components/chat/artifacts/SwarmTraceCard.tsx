import React, { useState } from 'react';
import { Network, Loader2, Check, AlertTriangle, Circle, ChevronDown, Search, ShieldCheck } from 'lucide-react';
import type { SwarmTraceArtifact, SwarmAgentStatus } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

const statusIcon = (status: SwarmAgentStatus) => {
  switch (status) {
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-fuchsia-600 animate-spin" />;
    case 'done':
      return <Check className="w-3.5 h-3.5 text-emerald-600" />;
    case 'error':
      return <AlertTriangle className="w-3.5 h-3.5 text-red-500" />;
    default:
      return <Circle className="w-3.5 h-3.5 text-[var(--ds-faint)]" />;
  }
};

// Verifier confidence (0–1) → a colored chip. Green = well-supported, amber = thin,
// red = weak/unverified. Mirrors the server-side verify.ts banding.
const confidenceStyle = (c: number): string =>
  c >= 0.75
    ? 'border-emerald-200 text-emerald-700 bg-emerald-50'
    : c >= 0.4
      ? 'border-amber-200 text-amber-700 bg-amber-50'
      : 'border-red-200 text-red-600 bg-red-50';

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
//
// TWO VERSIONS: compact (goal + per-agent status dots + done/total, no event logs)
// and detailed (the full expandable trace), via the WidgetFrame density context.
export const SwarmTraceCard: React.FC<{ data: SwarmTraceArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!data?.agents?.length) return null;
  const done = data.agents.filter((a) => a.status === 'done').length;
  const running = data.agents.some((a) => a.status === 'running' || a.status === 'pending');

  // Overall confidence = mean of the agents the verifier scored (shown once the run settles).
  const scored = data.agents.filter((a) => typeof a.confidence === 'number');
  const overall = scored.length ? scored.reduce((s, a) => s + (a.confidence || 0), 0) / scored.length : undefined;

  // ── Compact: one tight row — status icon, label, goal, and done/total. Small and calm
  // (the chunky header/dots are gone); the full per-agent trace lives in the expanded view.
  if (compact) {
    return (
      <Surface accent="#c026d3">
        <div className="flex items-center gap-2 px-3 py-2">
          {running ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 text-fuchsia-600 animate-spin" />
          ) : (
            <Network className="w-3.5 h-3.5 shrink-0 text-fuchsia-700" />
          )}
          <span className="shrink-0 text-[12px] font-semibold text-[var(--ds-ink)]">Agents</span>
          {data.goal && <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--ds-muted)]">{data.goal}</span>}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">
            {running ? `${done}/${data.agents.length}` : `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      accent="#c026d3"
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-fuchsia-700">
            <Network className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <span className="flex items-center gap-1.5">
              <SurfaceTitle>Agent swarm</SurfaceTitle>
              {typeof overall === 'number' && !running && (
                <span
                  title="Verifier confidence across all findings"
                  className={`flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${confidenceStyle(overall)}`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  {Math.round(overall * 100)}%
                </span>
              )}
            </span>
            {data.goal && <SurfaceSubtitle>{data.goal}</SurfaceSubtitle>}
          </div>
        </div>
      }
      right={
        <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">
          {running ? `${done}/${data.agents.length} done` : `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'}`}
        </span>
      }
    >
      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {data.agents.map((a, i) => {
          const expanded = open[a.id + i];
          const flags = a.flags || [];
          const canExpand = Boolean(a.summary || (a.toolEvents && a.toolEvents.length) || flags.length);
          return (
            <li key={a.id + i}>
              <button
                onClick={() => canExpand && setOpen((o) => ({ ...o, [a.id + i]: !expanded }))}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left transition-colors duration-200 ${canExpand ? 'hover:bg-[var(--ds-well)]' : ''}`}
              >
                <span className="mt-0.5 shrink-0">{statusIcon(a.status)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold text-[var(--ds-ink)]">{a.name}</span>
                    {typeof a.confidence === 'number' && a.status === 'done' && (
                      <span className={`rounded-md border px-1 py-px text-[10px] font-semibold ${confidenceStyle(a.confidence)}`}>
                        {Math.round(a.confidence * 100)}%
                      </span>
                    )}
                    {a.toolEvents && a.toolEvents.length > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-emerald-700"><Search className="w-3 h-3" />{a.toolEvents.length}</span>
                    )}
                  </span>
                  <span className="block text-[11px] text-[var(--ds-muted)] truncate">{a.task}</span>
                </span>
                {canExpand && <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-[var(--ds-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />}
              </button>
              {expanded && (
                <div className="px-3 pb-2 pl-9 space-y-1.5">
                  {a.summary && <p className="text-[11px] text-[var(--ds-muted)] whitespace-pre-wrap">{a.summary}</p>}
                  {flags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {flags.map((f, j) => (
                        <span key={j} className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                          ⚠ {FLAG_LABELS[f] || f}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.toolEvents && a.toolEvents.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {a.toolEvents.map((ev, j) => (
                        <span key={j} className={`rounded-md border px-1.5 py-0.5 text-[10px] ${ev.ok ? 'border-emerald-200 text-emerald-700' : 'border-red-200 text-red-600'}`}>
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
    </Surface>
  );
};
