import React from 'react';
import { GraduationCap } from 'lucide-react';
import type { LearningPathArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, resolveTheme } from './kit';

// Guided learning path card — v1 scaffold. Renders the course outline; the full
// interactive build (per-step completion, progress ring, "do with AI" prompts,
// compact glance mode) lands on top of this shell.

export const LearningPathCard: React.FC<{ data: LearningPathArtifact }> = ({ data }) => {
  const theme = resolveTheme({ palette: (data.palette as never) ?? 'violet' });
  const steps = data.modules.reduce((n, m) => n + m.steps.length, 0);
  return (
    <Surface
      accent={theme.accent}
      header={
        <div className="flex items-center gap-2">
          <GraduationCap className="h-4 w-4" style={{ color: theme.accent }} />
          <div className="min-w-0">
            <SurfaceTitle>{data.title}</SurfaceTitle>
            <SurfaceSubtitle>
              {data.modules.length} modules · {steps} steps{data.estMinutes ? ` · ~${data.estMinutes} min` : ''}
            </SurfaceSubtitle>
          </div>
        </div>
      }
    >
      <ul className="divide-y divide-black/5 border-t border-black/5">
        {data.modules.map((m) => (
          <li key={m.id} className="px-3 py-2">
            <p className="text-[13px] font-semibold text-[#1a1915]">{m.title}</p>
            {m.summary && <p className="text-[11px] text-[#6e6a60]">{m.summary}</p>}
          </li>
        ))}
      </ul>
    </Surface>
  );
};
