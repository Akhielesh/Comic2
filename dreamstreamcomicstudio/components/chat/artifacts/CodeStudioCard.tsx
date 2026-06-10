// Inline chat artifact card for code_studio. Shown in the message thread; a single
// "Open in Code Studio" CTA hands the app off to the dedicated Code Studio workspace
// (chat is a feeder — plan decision D6). One run path, no competing buttons (Sprint 0,
// S0.2): "Build in Studio" (WebContainer) and the Sandpack "Quick preview" side panel are
// retired here in favour of the one route.

import React from 'react';
import { Code2, FileCode, Layers, Download, ArrowRight, Sparkles } from 'lucide-react';
import { downloadArtifactZip } from '../../../services/studioLauncher';
import { useStudioHandoff } from '../../../services/studioHandoff';
import { Surface, SurfaceTitle, Badge } from './kit';
import type { CodeStudioArtifact } from '../../../apiTypes';

const TEMPLATE_LABELS: Record<string, string> = {
  'react-ts': 'React + TypeScript',
  react: 'React',
  'vanilla-ts': 'TypeScript',
  vanilla: 'JavaScript',
  static: 'HTML / CSS',
};

const TEMPLATE_COLORS: Record<string, string> = {
  'react-ts': '#0284c7',
  react: '#2563eb',
  'vanilla-ts': '#7c3aed',
  vanilla: '#d97706',
  static: '#059669',
};

export const CodeStudioCard: React.FC<{ data: CodeStudioArtifact }> = ({ data }) => {
  const openInStudio = useStudioHandoff((s) => s.open);
  const templateLabel = TEMPLATE_LABELS[data.template] || data.template;
  const templateColor = TEMPLATE_COLORS[data.template] || '#6e6a60';

  return (
    <Surface
      accent="#84cc16"
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-lime-700">
            <Code2 className="w-4 h-4" />
          </span>
          <SurfaceTitle>{data.title}</SurfaceTitle>
        </div>
      }
      right={<Badge color={templateColor}>{templateLabel}</Badge>}
    >
      <div className="px-3 pb-3">
        {data.description && (
          <p className="text-[12px] text-[var(--ds-muted)] mb-2.5">{data.description}</p>
        )}

        {/* File list */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {data.files.slice(0, 6).map((f) => (
            <span
              key={f.path}
              className="flex items-center gap-1 text-[10px] font-mono text-[var(--ds-ink)] bg-[var(--ds-well)] border border-[var(--ds-hairline)] rounded-md px-1.5 py-0.5"
            >
              <FileCode className="w-2.5 h-2.5 text-[var(--ds-muted)]" />
              {f.path.split('/').filter(Boolean).pop() || f.path}
            </span>
          ))}
          {data.files.length > 6 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold bg-[var(--ds-well)] border border-[var(--ds-hairline)] rounded-md px-1.5 py-0.5 text-[var(--ds-muted)]">
              <Layers className="w-2.5 h-2.5" />
              +{data.files.length - 6} more
            </span>
          )}
        </div>

        {/* Single CTA → the Code Studio workspace. .zip is a quiet secondary (a download, not a run path). */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => openInStudio(data)}
            title="Open this app in the Code Studio workspace"
            className="group flex items-center gap-2 text-sm font-semibold rounded-lg pl-3.5 pr-3 py-1.5 bg-[var(--ds-accent)] text-white transition-colors duration-200 hover:bg-[var(--ds-accent-hover)]"
          >
            <Sparkles className="w-3.5 h-3.5 transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110" />
            Open in Code Studio
            <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
          <button
            onClick={() => void downloadArtifactZip(data)}
            title="Download all files as a .zip"
            className="flex items-center gap-1.5 text-xs font-semibold rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 py-1.5 text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]"
          >
            <Download className="w-3 h-3" />
            .zip
          </button>
        </div>
      </div>
    </Surface>
  );
};
