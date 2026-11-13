import React from 'react';
import { Search } from 'lucide-react';
import type { Card } from '../../../../shared/comic/doc';
import type { ComicStudioController } from '../../useStudio';
import { composeInStudio } from '../composerBus';
import { ResearchPanel } from '../ResearchPanel';
import { CardShell } from '../ui';

export function ResearchCard({ card, studio }: { card: Extract<Card, { type: 'research' }>; studio: ComicStudioController }) {
  const projectId = studio.doc?.id;
  if (!projectId) return null;
  return (
    <CardShell title="Research sources" icon={<Search aria-hidden className="size-4" />} aria-label="Research sources" className="min-w-0 max-w-full">
      <p className="text-[13px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">{card.query}</p>
      <ResearchPanel
        key={`${projectId}:${card.id}`}
        projectId={projectId}
        suppliedResults={card.results}
        onAdd={(result, file) => composeInStudio({ research: { projectId, result, ...(file ? { file } : {}) } })}
      />
    </CardShell>
  );
}
