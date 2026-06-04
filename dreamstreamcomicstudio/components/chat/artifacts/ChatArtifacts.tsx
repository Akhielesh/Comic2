import React from 'react';
import type { ChatArtifact, WeatherArtifact, VideoResultsArtifact, MapArtifact, NewsResultsArtifact, StockQuoteArtifact, SwarmTraceArtifact, PlacesResultsArtifact } from '../../../apiTypes';
import { WeatherStation } from './WeatherStation';
import { VideoResults } from './VideoResults';
import { MapArtifactCard } from './MapArtifactCard';
import { NewsDigest } from './NewsDigest';
import { MarketCard } from './MarketCard';
import { SwarmTraceCard } from './SwarmTraceCard';
import { PlacesResults } from './PlacesResults';

// Renderer registry for typed rich-output artifacts. Adding a new rich component
// (maps, video grids, PDF viewers…) is a single `case` here — the chat loop and
// storage never change.
const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode => {
  switch (artifact.type) {
    case 'weather':
      return <WeatherStation key={key} data={artifact.data as WeatherArtifact} />;
    case 'video_results':
      return <VideoResults key={key} data={artifact.data as VideoResultsArtifact} />;
    case 'map':
      return <MapArtifactCard key={key} data={artifact.data as MapArtifact} />;
    case 'news_results':
      return <NewsDigest key={key} data={artifact.data as NewsResultsArtifact} />;
    case 'places_results':
      return <PlacesResults key={key} data={artifact.data as PlacesResultsArtifact} />;
    case 'stock_quote':
      return <MarketCard key={key} data={artifact.data as StockQuoteArtifact} />;
    case 'swarm_trace':
      return <SwarmTraceCard key={key} data={artifact.data as SwarmTraceArtifact} />;
    default:
      return null;
  }
};

export const ChatArtifacts: React.FC<{ artifacts?: ChatArtifact[] }> = ({ artifacts }) => {
  if (!artifacts || artifacts.length === 0) return null;
  return <>{artifacts.map((a, i) => renderArtifact(a, i))}</>;
};
