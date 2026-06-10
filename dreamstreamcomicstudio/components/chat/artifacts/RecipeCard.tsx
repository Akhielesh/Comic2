import React from 'react';
import { BookOpen, Network, Bot, Wrench, Sparkles, Hash, ToggleLeft } from 'lucide-react';
import type { RecipeCardArtifact, RecipeParameterView } from '../../../apiTypes';
import { Surface, Expandable, Chip, Badge } from './kit';

const TONE = { good: '#059669', bad: '#dc2626', neutral: '#6e6a60' } as const;

// A recipe summary card — a reusable, parameterized agent workflow (goose-style).
// Renders the recipe's identity, how it runs (swarm vs single agent), its typed
// parameters, and its tool/agent surface, in the calm-studio glass language.

const paramIcon = (t: RecipeParameterView['input_type']) => {
  switch (t) {
    case 'number':
      return <Hash className="w-3 h-3" />;
    case 'boolean':
      return <ToggleLeft className="w-3 h-3" />;
    default:
      return <Hash className="w-3 h-3" />;
  }
};

const ParamRow: React.FC<{ p: RecipeParameterView }> = ({ p }) => (
  <li className="flex items-start gap-2 py-1">
    <span className="mt-0.5 text-[#6e6a60]">{paramIcon(p.input_type)}</span>
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5">
        <code className="text-[11px] font-semibold text-[#1a1915]">{p.key}</code>
        <Badge color={p.requirement === 'required' ? TONE.bad : TONE.neutral}>{p.requirement}</Badge>
        <span className="text-[10px] uppercase tracking-wider text-[#6e6a60]">{p.input_type}</span>
        {p.default !== undefined && <span className="text-[10px] text-[#6e6a60]">default: {String(p.default)}</span>}
      </span>
      {p.description && <span className="block text-[11px] text-[#6e6a60]">{p.description}</span>}
      {p.options && p.options.length > 0 && (
        <span className="mt-0.5 flex flex-wrap gap-1">
          {p.options.map((o) => (
            <Chip key={o} label={o} />
          ))}
        </span>
      )}
    </span>
  </li>
);

export const RecipeCard: React.FC<{ data: RecipeCardArtifact }> = ({ data }) => {
  if (!data?.title) return null;
  const isSwarm = data.swarm || (data.agents && data.agents.length > 0);
  const params = data.parameters || [];

  return (
    <Surface
      accent={isSwarm ? '#c026d3' : '#0ea5e9'}
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-black/[0.04] p-1.5 text-[#6e6a60]">
            <BookOpen className="w-4 h-4" />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold tracking-tight text-[#1a1915] leading-tight">{data.title}</span>
              {data.builtin ? <Badge color={TONE.good}>built-in</Badge> : <Badge color={TONE.neutral}>saved</Badge>}
              {isSwarm ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-fuchsia-700">
                  <Network className="w-3 h-3" /> swarm
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-sky-700">
                  <Bot className="w-3 h-3" /> agent
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-[12px] text-[#6e6a60]">{data.description}</span>
            {data.id && <code className="text-[10px] text-[#6e6a60]/70">{data.id}</code>}
          </span>
        </div>
      }
    >
      <div className="px-3 pb-2">
        {(data.tools?.length || data.agents?.length) ? (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            {data.agents?.map((a) => (
              <span key={a} className="inline-flex items-center gap-0.5 rounded-md border border-fuchsia-200 bg-fuchsia-50 px-1.5 py-0.5 text-[10px] font-semibold text-fuchsia-700">
                <Bot className="w-3 h-3" />
                {a}
              </span>
            ))}
            {data.tools?.map((t) => (
              <span key={t} className="inline-flex items-center gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                <Wrench className="w-3 h-3" />
                {t}
              </span>
            ))}
          </div>
        ) : null}

        {params.length > 0 && (
          <div>
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Parameters</div>
            <ul className="divide-y divide-black/5">
              {params.map((p) => (
                <ParamRow key={p.key} p={p} />
              ))}
            </ul>
          </div>
        )}
      </div>

      {(data.instructions || (data.activities && data.activities.length > 0)) && (
        <Expandable moreLabel="Show instructions" lessLabel="Hide instructions">
          <div className="space-y-2 px-3 py-2">
            {data.instructions && (
              <div>
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Instructions</div>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-[#6e6a60]">{data.instructions}</p>
              </div>
            )}
            {data.activities && data.activities.length > 0 && (
              <div>
                <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">
                  <Sparkles className="w-3 h-3" /> Follow-ups
                </div>
                <div className="flex flex-wrap gap-1">
                  {data.activities.map((a, i) => (
                    <Chip key={i} label={a} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </Expandable>
      )}
    </Surface>
  );
};
