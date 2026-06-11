import React from 'react';
import { Telescope, FileSearch, BookOpenCheck, Layers } from 'lucide-react';
import type { ResearchReportArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// Premium header card for a deep-research run — it frames the brief that follows with
// the actual investigation behind it: the depth, the sub-questions explored, how many
// sources were gathered and how many were read in full, and the source list.
//  • compact — topic + sources/read counts + the first two questions.
//  • detailed — the full investigation summary with every question and source.

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
  <div className="flex items-center gap-2 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-1.5">
    <span className="text-[var(--ds-muted)]">{icon}</span>
    <span className="text-lg font-semibold leading-none tracking-tight text-[var(--ds-ink)]">{value}</span>
    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</span>
  </div>
);

export const ResearchReport: React.FC<{ data: ResearchReportArtifact }> = ({ data }) => {
  const compact = useCompact();
  const sources = data.sources || [];

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <Telescope className="h-4 w-4 shrink-0 text-indigo-600" />
      <div className="min-w-0">
        <SurfaceTitle>Research Report — {data.topic}</SurfaceTitle>
        <SurfaceSubtitle>
          {DEPTH_LABEL[data.depth] || data.depth} depth
          {data.audience ? ` · for ${data.audience}` : ''}
        </SurfaceSubtitle>
      </div>
    </div>
  );

  // ── Compact: topic + counts + first two questions. ──────────────────────────
  if (compact) {
    return (
      <Surface accent="#6366f1" header={header}>
        <div className="space-y-2 px-3 pb-3 pt-0.5">
          <div className="text-[11px] text-[var(--ds-muted)]">
            <span className="font-semibold text-[var(--ds-ink)]">{data.sourceCount}</span> sources
            <span className="mx-1 text-[var(--ds-faint)]">·</span>
            <span className="font-semibold text-[var(--ds-ink)]">{data.readCount}</span> read in full
          </div>
          {data.questions?.length > 0 && (
            <ul className="space-y-1">
              {data.questions.slice(0, 2).map((q, i) => (
                <li key={i} className="flex gap-2 text-xs text-[var(--ds-ink)] opacity-80">
                  <span className="shrink-0 font-semibold text-indigo-500">{i + 1}.</span>
                  <span className="min-w-0 truncate">{q}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full investigation summary. ───────────────────────────────
  return (
    <Surface accent="#6366f1" header={header}>
      <div className="space-y-3 p-3 pt-1">
        {/* Investigation stats */}
        <div className="flex flex-wrap gap-2">
          <Stat icon={<Layers className="h-4 w-4" />} value={data.questions?.length ?? 0} label="questions" />
          <Stat icon={<FileSearch className="h-4 w-4" />} value={data.sourceCount} label="sources" />
          <Stat icon={<BookOpenCheck className="h-4 w-4" />} value={data.readCount} label="read in full" />
        </div>

        {/* Sub-questions investigated */}
        {data.questions?.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Questions investigated</div>
            <ul className="space-y-1">
              {data.questions.map((q, i) => (
                <li key={i} className="flex gap-2 text-xs text-[var(--ds-ink)] opacity-80">
                  <span className="shrink-0 font-semibold text-indigo-500">{i + 1}.</span>
                  <span className="min-w-0">{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Sources */}
        {sources.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Sources ({sources.length})</div>
            <ol className="space-y-0.5">
              {sources.slice(0, 12).map((s, i) => (
                <li key={i} className="flex items-baseline gap-1.5 text-xs">
                  <span className="shrink-0 font-medium text-[var(--ds-muted)]">[{i + 1}]</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate font-medium text-indigo-700 transition-colors duration-200 hover:text-indigo-900 hover:underline"
                    title={s.url}
                  >
                    {s.title || domainOf(s.url)}
                  </a>
                  <span className="shrink-0 text-[10px] text-[var(--ds-muted)]">{domainOf(s.url)}</span>
                </li>
              ))}
              {sources.length > 12 && (
                <li className="text-[10px] font-semibold text-[var(--ds-muted)]">+{sources.length - 12} more sources</li>
              )}
            </ol>
          </div>
        )}
      </div>
    </Surface>
  );
};
