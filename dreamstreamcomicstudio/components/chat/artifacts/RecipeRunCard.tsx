import React from 'react';
import { ChefHat, Network, Bot, Check, AlertTriangle, Sparkles, Braces } from 'lucide-react';
import type { RecipeRunArtifact } from '../../../apiTypes';
import { Surface, Expandable, Chip } from './kit';

// A record of a recipe run: which recipe ran, with which parameters, in which mode
// (swarm vs single agent), whether it succeeded, and — when the recipe declared a
// response schema — the structured JSON it produced.

const prettyJson = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

export const RecipeRunCard: React.FC<{ data: RecipeRunArtifact }> = ({ data }) => {
  if (!data?.title) return null;
  const ok = data.status === 'done';
  const isSwarm = data.mode === 'swarm';

  return (
    <Surface
      accent={ok ? '#16a34a' : '#dc2626'}
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg border-2 border-black bg-amber-50 p-1.5">
            <ChefHat className="w-4 h-4" />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-display text-[14px] font-extrabold leading-tight">{data.title}</span>
              {isSwarm ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-fuchsia-700">
                  <Network className="w-3 h-3" /> swarm
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-sky-700">
                  <Bot className="w-3 h-3" /> agent
                </span>
              )}
              <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${ok ? 'text-emerald-700' : 'text-brand-red'}`}>
                {ok ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                {ok ? 'ran' : 'failed'}
              </span>
            </span>
            {data.recipeId && <code className="text-[10px] text-slate-400">{data.recipeId}</code>}
          </span>
        </div>
      }
    >
      <div className="px-3 pb-2">
        {data.params.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {data.params.map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1 rounded border border-black/10 bg-slate-50 px-1.5 py-0.5 text-[10px]">
                <span className="font-bold text-slate-500">{p.key}</span>
                <span className="max-w-[14rem] truncate text-slate-700">{p.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {data.structured !== undefined && data.structured !== null && (
        <Expandable moreLabel="Show structured output" lessLabel="Hide structured output">
          <div className="px-3 py-2">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
              <Braces className="w-3 h-3" /> JSON
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg border-2 border-black/10 bg-slate-900 p-2 text-[10.5px] leading-relaxed text-emerald-200">
              {prettyJson(data.structured)}
            </pre>
          </div>
        </Expandable>
      )}

      {data.activities && data.activities.length > 0 && (
        <div className="border-t-2 border-black/10 bg-slate-50 px-3 py-2">
          <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            <Sparkles className="w-3 h-3" /> Follow-ups
          </div>
          <div className="flex flex-wrap gap-1">
            {data.activities.map((a, i) => (
              <Chip key={i} label={a} />
            ))}
          </div>
        </div>
      )}
    </Surface>
  );
};
