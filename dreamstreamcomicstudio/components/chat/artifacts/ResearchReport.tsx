import React from 'react';
import { Telescope, FileSearch, BookOpenCheck, Layers } from 'lucide-react';
import type { ResearchReportArtifact } from '../../../apiTypes';
import { Surface } from './kit';

// Premium header card for a deep-research run — it frames the brief that follows with the
// actual investigation behind it: the depth, the sub-questions explored, how many sources
// were gathered and how many were read in full, and the source list. This is what makes
// deep research read like a research PRODUCT rather than a wall of text.

const DEPTH_LABEL: Record<string, string> = {
  quick: 'Quick scan',
  standard: 'Standard',
  exhaustive: 'Exhaustive'
};

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const Stat: React.FC<{ icon: React.ReactNode; value: React.ReactNode; label: string }> = ({ icon, value, label }) => (
  <div className="flex items-center gap-2 rounded-lg border-2 border-black/10 bg-white px-3 py-1.5">
    <span className="text-slate-500">{icon}</span>
    <span className="font-display text-lg leading-none">{value}</span>
    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
  </div>
);

export const ResearchReport: React.FC<{ data: ResearchReportArtifact }> = ({ data }) => {
  const sources = data.sources || [];
  return (
    <Surface
      accent="#6366f1"
      header={
        <div className="flex items-center gap-2">
          <Telescope className="h-4 w-4 shrink-0 text-indigo-600" />
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold">Research Report — {data.topic}</div>
            <div className="text-[11px] font-semibold text-slate-500">
              {DEPTH_LABEL[data.depth] || data.depth} depth
              {data.audience ? ` · for ${data.audience}` : ''}
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        {/* Investigation stats */}
        <div className="flex flex-wrap gap-2">
          <Stat icon={<Layers className="h-4 w-4" />} value={data.questions?.length ?? 0} label="questions" />
          <Stat icon={<FileSearch className="h-4 w-4" />} value={data.sourceCount} label="sources" />
          <Stat icon={<BookOpenCheck className="h-4 w-4" />} value={data.readCount} label="read in full" />
        </div>

        {/* Sub-questions investigated */}
        {data.questions?.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Questions investigated</div>
            <ul className="space-y-1">
              {data.questions.map((q, i) => (
                <li key={i} className="flex gap-2 text-xs text-slate-700">
                  <span className="font-display text-indigo-500">{i + 1}.</span>
                  <span className="min-w-0">{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sources */}
        {sources.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Sources ({sources.length})</div>
            <ol className="space-y-0.5">
              {sources.slice(0, 12).map((s, i) => (
                <li key={i} className="flex items-baseline gap-1.5 text-xs">
                  <span className="font-display text-slate-400">[{i + 1}]</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate font-semibold text-indigo-700 hover:underline"
                    title={s.url}
                  >
                    {s.title || domainOf(s.url)}
                  </a>
                  <span className="shrink-0 text-[10px] text-slate-400">{domainOf(s.url)}</span>
                </li>
              ))}
              {sources.length > 12 && (
                <li className="text-[10px] font-bold text-slate-400">+{sources.length - 12} more sources</li>
              )}
            </ol>
          </div>
        )}
      </div>
    </Surface>
  );
};
