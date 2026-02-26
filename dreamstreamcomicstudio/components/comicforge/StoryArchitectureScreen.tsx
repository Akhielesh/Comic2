import React, { useState } from 'react';
import { ComicForgeStoryArchitecture } from '../../types';
import { Button } from '../Button';

interface StoryArchitectureScreenProps {
  architecture?: ComicForgeStoryArchitecture;
  approved: boolean;
  onBuild: (input: { pacingPreference: 'fast_action' | 'balanced' | 'slow_emotional'; targetPageCountOverride?: number }) => Promise<void>;
  onApprove: () => void;
}

export const StoryArchitectureScreen: React.FC<StoryArchitectureScreenProps> = ({ architecture, approved, onBuild, onApprove }) => {
  const [pacingPreference, setPacingPreference] = useState<'fast_action' | 'balanced' | 'slow_emotional'>('balanced');
  const [targetPages, setTargetPages] = useState('');
  const [isBuilding, setIsBuilding] = useState(false);

  const handleBuild = async () => {
    setIsBuilding(true);
    try {
      await onBuild({
        pacingPreference,
        targetPageCountOverride: targetPages.trim() ? Number(targetPages) : undefined
      });
    } finally {
      setIsBuilding(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-2 gap-4">
        <label className="font-bold text-sm">
          Pacing
          <select
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={pacingPreference}
            onChange={(event) => setPacingPreference(event.target.value as 'fast_action' | 'balanced' | 'slow_emotional')}
          >
            <option value="fast_action">Fast / Action-Driven</option>
            <option value="balanced">Balanced</option>
            <option value="slow_emotional">Slow / Emotional</option>
          </select>
        </label>

        <label className="font-bold text-sm">
          Target Page Count (optional)
          <input
            className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
            value={targetPages}
            onChange={(event) => setTargetPages(event.target.value.replace(/[^0-9]/g, ''))}
            placeholder="AI suggested if empty"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={handleBuild} isLoading={isBuilding}>Build Architecture</Button>
        <Button variant="secondary" disabled={!architecture || approved} onClick={onApprove}>Approve Architecture</Button>
      </div>

      {architecture && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Suggested Page Count:</strong> {architecture.suggestedPageCount}</div>
          <div><strong>Beat Count:</strong> {architecture.beatSheet.length}</div>
          <div><strong>Pages Planned:</strong> {architecture.pagePlan.length}</div>
          {architecture.globalWarnings.length > 0 && (
            <ul className="list-disc ml-5">
              {architecture.globalWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
