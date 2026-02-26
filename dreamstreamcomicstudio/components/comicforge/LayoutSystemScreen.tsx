import React, { useState } from 'react';
import { ComicForgeLayoutTemplate } from '../../types';
import { Button } from '../Button';

interface LayoutSystemScreenProps {
  layoutTemplate?: ComicForgeLayoutTemplate;
  approved: boolean;
  onExtractLayout: (input: { referenceImageUrl?: string; layoutHint?: string }) => Promise<void>;
  onBuildLetteringRules: (input: { captionStyle?: 'box' | 'borderless'; balloonStyle?: 'round' | 'spiky' | 'cloud' | 'rectangular'; sfxStyle?: string }) => Promise<void>;
  onApprove: () => void;
}

export const LayoutSystemScreen: React.FC<LayoutSystemScreenProps> = ({ layoutTemplate, approved, onExtractLayout, onBuildLetteringRules, onApprove }) => {
  const [referenceImageUrl, setReferenceImageUrl] = useState('');
  const [layoutHint, setLayoutHint] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  const handleExtract = async () => {
    setIsWorking(true);
    try {
      await onExtractLayout({
        referenceImageUrl: referenceImageUrl.trim() || undefined,
        layoutHint: layoutHint.trim() || undefined
      });
    } finally {
      setIsWorking(false);
    }
  };

  const handleLettering = async () => {
    setIsWorking(true);
    try {
      await onBuildLetteringRules({
        captionStyle: 'box',
        balloonStyle: 'round',
        sfxStyle: 'impact'
      });
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <input
        className="w-full border-2 border-black rounded-lg px-3 py-2"
        placeholder="Optional layout reference image URL"
        value={referenceImageUrl}
        onChange={(event) => setReferenceImageUrl(event.target.value)}
      />
      <textarea
        className="w-full border-2 border-black rounded-xl p-3 min-h-[90px]"
        placeholder="Optional layout notes"
        value={layoutHint}
        onChange={(event) => setLayoutHint(event.target.value)}
      />

      <div className="flex gap-3 flex-wrap">
        <Button onClick={handleExtract} isLoading={isWorking}>Extract Layout</Button>
        <Button variant="secondary" onClick={handleLettering} isLoading={isWorking}>Build Lettering Rules</Button>
        <Button variant="secondary" disabled={!layoutTemplate || approved} onClick={onApprove}>Approve Layout</Button>
      </div>

      {layoutTemplate && (
        <div className="border-2 border-black rounded-xl bg-white p-4 text-sm space-y-2">
          <div><strong>Template:</strong> {layoutTemplate.name}</div>
          <div><strong>Panels:</strong> {layoutTemplate.panelCount}</div>
          <div><strong>Balloon style:</strong> {layoutTemplate.balloonStyle}</div>
          <div><strong>Caption style:</strong> {layoutTemplate.captionStyle}</div>
        </div>
      )}
    </div>
  );
};
