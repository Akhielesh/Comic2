// Inline chat artifact card for code_studio. Shown in the message thread; the
// "Open Studio" button opens the full editor+preview in the side panel.

import React from 'react';
import { Code2, Play, FileCode, Layers } from 'lucide-react';
import { useChatPanel } from '../panelContext';
import type { CodeStudioArtifact } from '../../../apiTypes';

const TEMPLATE_LABELS: Record<string, string> = {
  'react-ts': 'React + TypeScript',
  react: 'React',
  'vanilla-ts': 'TypeScript',
  vanilla: 'JavaScript',
  static: 'HTML / CSS',
};

const TEMPLATE_COLORS: Record<string, string> = {
  'react-ts': 'bg-sky-100 text-sky-700 border-sky-300',
  react: 'bg-blue-100 text-blue-700 border-blue-300',
  'vanilla-ts': 'bg-violet-100 text-violet-700 border-violet-300',
  vanilla: 'bg-amber-100 text-amber-700 border-amber-300',
  static: 'bg-emerald-100 text-emerald-700 border-emerald-300',
};

export const CodeStudioCard: React.FC<{ data: CodeStudioArtifact }> = ({ data }) => {
  const openPanel = useChatPanel();
  const templateLabel = TEMPLATE_LABELS[data.template] || data.template;
  const templateColor = TEMPLATE_COLORS[data.template] || 'bg-slate-100 text-slate-700 border-slate-300';

  return (
    <div className="border-2 border-black rounded-xl shadow-comic bg-white overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-lime-100 border-b-2 border-black">
        <Code2 className="w-4 h-4 shrink-0 text-lime-700" />
        <span className="font-bold text-sm truncate flex-1">{data.title}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${templateColor}`}>
          {templateLabel}
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {data.description && (
          <p className="text-xs text-slate-600 mb-2.5">{data.description}</p>
        )}

        {/* File list */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {data.files.slice(0, 6).map((f) => (
            <span
              key={f.path}
              className="flex items-center gap-1 text-[10px] font-mono bg-slate-100 border border-slate-300 rounded px-1.5 py-0.5"
            >
              <FileCode className="w-2.5 h-2.5 text-slate-500" />
              {f.path.split('/').filter(Boolean).pop() || f.path}
            </span>
          ))}
          {data.files.length > 6 && (
            <span className="flex items-center gap-1 text-[10px] font-bold bg-slate-100 border border-slate-300 rounded px-1.5 py-0.5 text-slate-500">
              <Layers className="w-2.5 h-2.5" />
              +{data.files.length - 6} more
            </span>
          )}
        </div>

        {/* CTA */}
        <button
          onClick={() => openPanel?.({ type: 'code_studio', data })}
          className="flex items-center gap-1.5 text-xs font-bold border-2 border-black rounded-full px-3 py-1 bg-lime-400 hover:bg-lime-300 shadow-[2px_2px_0_#000] hover:translate-y-[1px] hover:shadow-[1px_1px_0_#000] transition-all"
        >
          <Play className="w-3 h-3" />
          Open in Studio
        </button>
      </div>
    </div>
  );
};
