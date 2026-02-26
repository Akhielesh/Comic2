import React, { useState } from 'react';
import { ComicForgeJobSummary, ComicForgeStoryboardValidation } from '../../types';
import { Button } from '../Button';

interface StoryboardScreenProps {
  latestJob?: ComicForgeJobSummary;
  validation?: ComicForgeStoryboardValidation;
  approved: boolean;
  onGenerateThumbnails: () => Promise<void>;
  onValidateStoryboard: () => Promise<void>;
  onApprove: () => void;
}

export const StoryboardScreen: React.FC<StoryboardScreenProps> = ({ latestJob, validation, approved, onGenerateThumbnails, onValidateStoryboard, onApprove }) => {
  const [isWorking, setIsWorking] = useState(false);

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
    </div>
  );
};
