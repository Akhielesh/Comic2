import React from 'react';
import type { ChatArtifact, WeatherArtifact, VideoResultsArtifact, MapArtifact, NewsResultsArtifact, StockQuoteArtifact } from '../../../apiTypes';
import { WeatherCard } from './WeatherCard';
import { VideoResults } from './VideoResults';
import { MapArtifactCard } from './MapArtifactCard';
import { NewsCard } from './NewsCard';
import { StockCard } from './StockCard';

// Renderer registry for typed rich-output artifacts. Adding a new rich component
// (maps, video grids, PDF viewers…) is a single `case` here — the chat loop and
// storage never change.
const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode => {
  switch (artifact.type) {
    case 'weather':
      return <WeatherCard key={key} data={artifact.data as WeatherArtifact} />;
    case 'video_results':
      return <VideoResults key={key} data={artifact.data as VideoResultsArtifact} />;
    case 'map':
      return <MapArtifactCard key={key} data={artifact.data as MapArtifact} />;
    case 'news_results':
      return <NewsCard key={key} data={artifact.data as NewsResultsArtifact} />;
    case 'stock_quote':
      return <StockCard key={key} data={artifact.data as StockQuoteArtifact} />;
    default:
      return null;
  }
};

export const ChatArtifacts: React.FC<{ artifacts?: ChatArtifact[] }> = ({ artifacts }) => {
  if (!artifacts || artifacts.length === 0) return null;
  return <>{artifacts.map((a, i) => renderArtifact(a, i))}</>;
};
