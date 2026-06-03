import React from 'react';
import type { ChatArtifact, WeatherArtifact } from '../../../apiTypes';
import { WeatherCard } from './WeatherCard';

// Renderer registry for typed rich-output artifacts. Adding a new rich component
// (maps, video grids, PDF viewers…) is a single `case` here — the chat loop and
// storage never change.
const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode => {
  switch (artifact.type) {
    case 'weather':
      return <WeatherCard key={key} data={artifact.data as WeatherArtifact} />;
    default:
      return null;
  }
};

export const ChatArtifacts: React.FC<{ artifacts?: ChatArtifact[] }> = ({ artifacts }) => {
  if (!artifacts || artifacts.length === 0) return null;
  return <>{artifacts.map((a, i) => renderArtifact(a, i))}</>;
};
