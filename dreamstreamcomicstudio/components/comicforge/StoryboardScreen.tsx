import React, { useState } from 'react';
import { ComicForgeJobSummary, ComicForgePanelArtifact, ComicForgeStoryboardValidation } from '../../types';
import { Button } from '../Button';
import { getImageUrl } from '../../services/db';

interface StoryboardScreenProps {
  latestJob?: ComicForgeJobSummary;
  validation?: ComicForgeStoryboardValidation;
  panelArtifacts?: ComicForgePanelArtifact[];
  approved: boolean;
  onGenerateThumbnails: () => Promise<void>;
  onValidateStoryboard: () => Promise<void>;
  onApprove: () => void;
}

export const StoryboardScreen: React.FC<StoryboardScreenProps> = ({ latestJob, validation, panelArtifacts, approved, onGenerateThumbnails, onValidateStoryboard, onApprove }) => {
  const [isWorking, setIsWorking] = useState(false);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({});

  React.useEffect(() => {
    const candidates = (panelArtifacts || [])
      .filter((artifact) => artifact.thumbnailImageId && !artifact.thumbnailImageId.startsWith('data:'))
      .map((artifact) => ({
        panelId: artifact.panelId,
        imageId: artifact.thumbnailImageId as string
      }));
    if (candidates.length === 0) return;

    let cancelled = false;
    void Promise.all(candidates.map(async (candidate) => {
      const url = await getImageUrl(candidate.imageId);
      return { panelId: candidate.panelId, url: url || '' };
    })).then((entries) => {
      if (cancelled) return;
      setThumbnailUrls((prev) => {
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

  const withBusy = async (fn: () => Promise<void>) => {
    setIsWorking(true);
    try {
      await fn();
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <Button onClick={() => withBusy(onGenerateThumbnails)} isLoading={isWorking}>Generate Thumbnails</Button>
        <Button variant="secondary" onClick={() => withBusy(onValidateStoryboard)} isLoading={isWorking}>Validate Storyboard</Button>
        <Button variant="secondary" onClick={onApprove} disabled={!validation || !validation.pass || approved}>Approve Storyboard</Button>
      </div>

      {latestJob && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm">
          <div><strong>Job:</strong> {latestJob.id}</div>
          <div><strong>Status:</strong> {latestJob.status}</div>
          <div><strong>Task:</strong> {latestJob.taskType}</div>
        </div>
      )}

      {validation && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Pass:</strong> {validation.pass ? 'Yes' : 'No'}</div>
          <div><strong>Page warnings:</strong> {validation.pageLevelWarnings.length}</div>
          <div><strong>Panel warnings:</strong> {validation.panelLevelWarnings.length}</div>
        </div>
      )}

      {(panelArtifacts || []).some((artifact) => artifact.thumbnailImageId || artifact.thumbnailImageUrl) && (
        <div className="border-2 border-black rounded-xl bg-white p-4 space-y-3">
          <h3 className="font-bold text-sm uppercase tracking-wide">Storyboard Panels</h3>
          <div className="grid md:grid-cols-3 gap-3">
            {(panelArtifacts || [])
              .filter((artifact) => artifact.thumbnailImageId || artifact.thumbnailImageUrl)
              .sort((a, b) => (a.pageNumber - b.pageNumber) || (a.panelIndex - b.panelIndex))
              .map((artifact) => {
                const url = thumbnailUrls[artifact.panelId] || artifact.thumbnailImageUrl;
                return (
                  <div key={artifact.panelId} className="border border-slate-200 rounded-lg p-2 space-y-2">
                    <div className="text-[11px] text-slate-600">
                      Page {artifact.pageNumber} • Panel {artifact.panelIndex}
                    </div>
                    {url ? (
                      <img src={url} alt={`Storyboard ${artifact.panelId}`} className="w-full rounded-md border border-slate-200" />
                    ) : (
                      <div className="h-32 rounded-md border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-500">
                        Loading image...
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};
