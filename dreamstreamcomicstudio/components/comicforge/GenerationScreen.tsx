import React, { useState } from 'react';
import { ComicForgeJobSummary } from '../../types';
import { Button } from '../Button';

interface GenerationScreenProps {
  latestJob?: ComicForgeJobSummary;
  approved: boolean;
  onGenerate: (quality: 'draft' | 'final') => Promise<void>;
  onApprove: () => void;
}

export const GenerationScreen: React.FC<GenerationScreenProps> = ({ latestJob, approved, onGenerate, onApprove }) => {
  const [isWorking, setIsWorking] = useState(false);

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
    </div>
  );
};
