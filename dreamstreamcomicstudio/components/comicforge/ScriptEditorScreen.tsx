import React, { useMemo, useState } from 'react';
import { ComicForgeStructuredScriptAnalysis } from '../../types';
import { Button } from '../Button';

interface ScriptEditorScreenProps {
  initialScript?: string;
  analysis?: ComicForgeStructuredScriptAnalysis;
  approved: boolean;
  onAnalyze: (rawScriptText: string) => Promise<void>;
  onApprove: () => void;
}

export const ScriptEditorScreen: React.FC<ScriptEditorScreenProps> = ({ initialScript, analysis, approved, onAnalyze, onApprove }) => {
  const [script, setScript] = useState(initialScript || '');
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const unresolvedCount = useMemo(
    () => (analysis?.ambiguityFlags || []).filter((flag) => !flag.resolved).length,
    [analysis]
  );

  const handleAnalyze = async () => {
    if (!script.trim()) return;
    setIsAnalyzing(true);
    try {
      await onAnalyze(script.trim());
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <textarea
        className="w-full min-h-[220px] border-2 border-black rounded-xl p-4 font-mono text-sm"
        placeholder="Paste your story script..."
        value={script}
        onChange={(event) => setScript(event.target.value)}
      />

      <div className="flex flex-wrap gap-3">
        <Button onClick={handleAnalyze} isLoading={isAnalyzing}>Analyze Script</Button>
        <Button
          variant="secondary"
          onClick={onApprove}
          disabled={!analysis || unresolvedCount > 0 || approved}
        >
          Approve Analysis
        </Button>
      </div>

      {analysis && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Tone:</strong> {analysis.tone || 'N/A'}</div>
          <div><strong>Genre:</strong> {analysis.genre || 'N/A'}</div>
          <div><strong>Estimated Panels:</strong> {analysis.estimatedPanelCount}</div>
          <div><strong>Cast:</strong> {analysis.castList.map((entry) => entry.name).join(', ') || 'None'}</div>
          <div><strong>Unresolved Ambiguities:</strong> {unresolvedCount}</div>
          {unresolvedCount > 0 && (
            <p className="text-red-700 font-bold">Resolve ambiguity flags in backend workflow before approval.</p>
          )}
        </div>
      )}
    </div>
  );
};
