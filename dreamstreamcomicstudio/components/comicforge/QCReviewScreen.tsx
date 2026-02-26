import React, { useState } from 'react';
import { ComicForgeQCReport } from '../../types';
import { Button } from '../Button';

interface QCReviewScreenProps {
  reports: ComicForgeQCReport[];
  approved: boolean;
  onRunQc: () => Promise<void>;
  onApprove: () => void;
}

export const QCReviewScreen: React.FC<QCReviewScreenProps> = ({ reports, approved, onRunQc, onApprove }) => {
  const [isRunning, setIsRunning] = useState(false);

  const handleRun = async () => {
    setIsRunning(true);
    try {
      await onRunQc();
    } finally {
      setIsRunning(false);
    }
  };

  const failCount = reports.reduce((sum, report) => sum + report.panelFlags.filter((flag) => flag.severity === 'fail').length, 0);

  return (
    <div className="space-y-6">
      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleRun} isLoading={isRunning}>Run QC</Button>
        <Button variant="secondary" disabled={failCount > 0 || reports.length === 0 || approved} onClick={onApprove}>Approve QC</Button>
      </div>

      <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
        <div><strong>QC reports:</strong> {reports.length}</div>
        <div><strong>Fail flags:</strong> {failCount}</div>
        {reports.map((report) => (
          <div key={report.pageId} className="border border-black rounded-lg p-3 bg-slate-50">
            <div><strong>Page:</strong> {report.pageId}</div>
            <div><strong>Passed:</strong> {report.pagePassed ? 'Yes' : 'No'}</div>
            <div><strong>Flags:</strong> {report.panelFlags.length}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
