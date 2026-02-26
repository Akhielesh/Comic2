import React, { useState } from 'react';
import { ComicForgeJobSummary, ComicForgePanelArtifact } from '../../types';
import { Button } from '../Button';
import { getImageUrl } from '../../services/db';

interface GenerationScreenProps {
  latestJob?: ComicForgeJobSummary;
  panelArtifacts?: ComicForgePanelArtifact[];
  approved: boolean;
  onGenerate: (quality: 'draft' | 'final') => Promise<void>;
  onApprove: () => void;
}

export const GenerationScreen: React.FC<GenerationScreenProps> = ({ latestJob, panelArtifacts, approved, onGenerate, onApprove }) => {
  const [isWorking, setIsWorking] = useState(false);
  const [resolvedUrls, setResolvedUrls] = useState<Record<string, string>>({});

  React.useEffect(() => {
    const candidates = (panelArtifacts || [])
      .map((artifact) => ({
        panelId: artifact.panelId,
        imageId: artifact.finalImageId || artifact.draftImageId
      }))
      .filter((entry): entry is { panelId: string; imageId: string } => Boolean(entry.imageId) && !entry.imageId.startsWith('data:'));
    if (candidates.length === 0) return;

    let cancelled = false;
    void Promise.all(candidates.map(async (candidate) => {
      const url = await getImageUrl(candidate.imageId);
      return { panelId: candidate.panelId, url: url || '' };
    })).then((entries) => {
      if (cancelled) return;
      setResolvedUrls((prev) => {
        const next = { ...prev };
        entries.forEach((entry) => {
          if (entry.url) next[entry.panelId] = entry.url;
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [panelArtifacts]);

  const handleGenerate = async (quality: 'draft' | 'final') => {
    setIsWorking(true);
    try {
      await onGenerate(quality);
    } finally {
      setIsWorking(false);
    }
  };

  const canApprove = latestJob?.status === 'done';

  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <Button onClick={() => handleGenerate('draft')} isLoading={isWorking}>Generate Draft</Button>
        <Button variant="secondary" onClick={() => handleGenerate('final')} isLoading={isWorking}>Generate Final</Button>
        <Button variant="secondary" disabled={!canApprove || approved} onClick={onApprove}>Approve Generation</Button>
      </div>

      {latestJob && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-1">
          <div><strong>Job:</strong> {latestJob.id}</div>
          <div><strong>Status:</strong> {latestJob.status}</div>
          <div><strong>Progress:</strong> {typeof latestJob.progress === 'number' ? `${latestJob.progress}%` : 'n/a'}</div>
          {latestJob.errorMessage && <div className="text-red-700"><strong>Error:</strong> {latestJob.errorMessage}</div>}
        </div>
      )}

      {(panelArtifacts || []).some((artifact) => artifact.draftImageId || artifact.finalImageId || artifact.draftImageUrl || artifact.finalImageUrl) && (
        <div className="border-2 border-black rounded-xl bg-white p-4 space-y-3">
          <h3 className="font-bold text-sm uppercase tracking-wide">Generated Panels</h3>
          <div className="grid md:grid-cols-3 gap-3">
            {(panelArtifacts || [])
              .filter((artifact) => artifact.draftImageId || artifact.finalImageId || artifact.draftImageUrl || artifact.finalImageUrl)
              .sort((a, b) => (a.pageNumber - b.pageNumber) || (a.panelIndex - b.panelIndex))
              .map((artifact) => {
                const url = resolvedUrls[artifact.panelId] || artifact.finalImageUrl || artifact.draftImageUrl;
                return (
                  <div key={artifact.panelId} className="border border-slate-200 rounded-lg p-2 space-y-2">
                    <div className="text-[11px] text-slate-600">
                      Page {artifact.pageNumber} • Panel {artifact.panelIndex}
                    </div>
                    {url ? (
                      <img src={url} alt={`Generated ${artifact.panelId}`} className="w-full rounded-md border border-slate-200" />
                    ) : (
                      <div className="h-32 rounded-md border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-500">
                        Loading image...
                      </div>
                    )}
                    <div className="text-[11px] text-slate-500">
                      {artifact.finalImageId ? 'Final' : 'Draft'}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};
