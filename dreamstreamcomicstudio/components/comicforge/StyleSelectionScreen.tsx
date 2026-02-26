import React, { useMemo, useState } from 'react';
import { ComicForgeStyleBible, ComicForgeStyleRecommendation } from '../../types';
import { Button } from '../Button';

interface StyleSelectionScreenProps {
  recommendations?: ComicForgeStyleRecommendation[];
  styleBible?: ComicForgeStyleBible;
  approved: boolean;
  onSuggest: (input: { customStyleHint?: string }) => Promise<void>;
  onBuildStyleBible: (input: { selectedStyle: string; customPromptOverride?: string }) => Promise<void>;
  onApprove: () => void;
}

export const StyleSelectionScreen: React.FC<StyleSelectionScreenProps> = ({ recommendations, styleBible, approved, onSuggest, onBuildStyleBible, onApprove }) => {
  const [customStyleHint, setCustomStyleHint] = useState('');
  const [selectedStyle, setSelectedStyle] = useState('');
  const [customPromptOverride, setCustomPromptOverride] = useState('');
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);

  const effectiveSelectedStyle = useMemo(() => {
    if (selectedStyle.trim()) return selectedStyle.trim();
    return recommendations?.[0]?.styleName || '';
  }, [selectedStyle, recommendations]);

  const handleSuggest = async () => {
    setIsSuggesting(true);
    try {
      await onSuggest({ customStyleHint: customStyleHint.trim() || undefined });
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleBuild = async () => {
    if (!effectiveSelectedStyle) return;
    setIsBuilding(true);
    try {
      await onBuildStyleBible({
        selectedStyle: effectiveSelectedStyle,
        customPromptOverride: customPromptOverride.trim() || undefined
      });
    } finally {
      setIsBuilding(false);
    }
  };

  return (
    <div className="space-y-6">
      <label className="font-bold text-sm block">
        Optional style hint
        <input
          className="mt-1 w-full border-2 border-black rounded-lg px-3 py-2"
          placeholder="Noir ink, cinematic manga, flat all-ages..."
          value={customStyleHint}
          onChange={(event) => setCustomStyleHint(event.target.value)}
        />
      </label>

      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleSuggest} isLoading={isSuggesting}>Suggest Styles</Button>
      </div>

      {recommendations && recommendations.length > 0 && (
        <div className="grid md:grid-cols-3 gap-3">
          {recommendations.map((recommendation) => {
            const isActive = recommendation.styleName === effectiveSelectedStyle;
            return (
              <button
                key={recommendation.styleName}
                className={`text-left border-2 rounded-xl p-3 ${isActive ? 'border-brand-blue bg-blue-50' : 'border-black bg-white'}`}
                onClick={() => setSelectedStyle(recommendation.styleName)}
              >
                <div className="font-bold">{recommendation.styleName}</div>
                <p className="text-xs mt-1">{recommendation.rationale}</p>
              </button>
            );
          })}
        </div>
      )}

      <label className="font-bold text-sm block">
        Custom style override
        <textarea
          className="mt-1 w-full border-2 border-black rounded-xl p-3 min-h-[100px]"
          value={customPromptOverride}
          onChange={(event) => setCustomPromptOverride(event.target.value)}
        />
      </label>

      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleBuild} isLoading={isBuilding} disabled={!effectiveSelectedStyle}>Build Style Bible</Button>
        <Button variant="secondary" disabled={!styleBible || approved} onClick={onApprove}>Approve Style</Button>
      </div>

      {styleBible && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Line:</strong> {styleBible.lineQuality}</div>
          <div><strong>Shading:</strong> {styleBible.shadingMode}</div>
          <div><strong>Camera language:</strong> {styleBible.cameraLanguage}</div>
          <div><strong>Primary palette:</strong> {styleBible.colorPalette.primary.join(', ') || 'n/a'}</div>
        </div>
      )}
    </div>
  );
};
