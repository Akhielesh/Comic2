import React, { useState } from 'react';
import { ComicForgePreviewPack } from '../../types';
import { Button } from '../Button';

interface PreviewPackScreenProps {
  preview?: ComicForgePreviewPack;
  approved: boolean;
  onRefresh: () => Promise<void>;
  onApprove: () => void;
}

export const PreviewPackScreen: React.FC<PreviewPackScreenProps> = ({ preview, approved, onRefresh, onApprove }) => {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleRefresh} isLoading={isRefreshing}>Load Preview Pack</Button>
        <Button variant="secondary" onClick={onApprove} disabled={!preview || approved}>Approve Preview</Button>
      </div>

      {preview && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Total pages:</strong> {preview.totalPages}</div>
          <div><strong>Total panels:</strong> {preview.totalPanels}</div>
          <div><strong>Estimated total:</strong> ${preview.estimatedCosts.totalUsd.toFixed(2)}</div>
          <div><strong>Estimated duration:</strong> {preview.estimatedDurationSeconds}s</div>
          {preview.globalWarnings.length > 0 && (
            <ul className="list-disc ml-5">
              {preview.globalWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
