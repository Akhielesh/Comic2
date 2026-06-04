import React from 'react';
import type { ChatArtifact, WeatherArtifact, VideoResultsArtifact, MapArtifact, NewsResultsArtifact, StockQuoteArtifact, SwarmTraceArtifact, PlacesResultsArtifact, ChartArtifact, MetricBoardArtifact } from '../../../apiTypes';
import { WeatherStation } from './WeatherStation';
import { VideoResults } from './VideoResults';
import { MapArtifactCard } from './MapArtifactCard';
import { NewsDigest } from './NewsDigest';
import { MarketCard } from './MarketCard';
import { SwarmTraceCard } from './SwarmTraceCard';
import { PlacesResults } from './PlacesResults';
import { ChartCard } from './ChartCard';
import { MetricBoard } from './MetricBoard';

// Renderer registry for typed rich-output artifacts. Adding a new rich component is
// a single entry here — the chat loop and storage never change.
//
// CONVENTION (enforced by gallery.coverage.test.ts): every artifact type registered
// here MUST also have a live demo in ComponentGallery.tsx. If you add a renderer
// without a gallery demo, the coverage test fails. See ComponentGallery for the
// other half of the contract.
const ARTIFACT_RENDERERS: Record<string, (data: unknown, key: number) => React.ReactNode> = {
  weather: (d, k) => <WeatherStation key={k} data={d as WeatherArtifact} />,
  video_results: (d, k) => <VideoResults key={k} data={d as VideoResultsArtifact} />,
  map: (d, k) => <MapArtifactCard key={k} data={d as MapArtifact} />,
  news_results: (d, k) => <NewsDigest key={k} data={d as NewsResultsArtifact} />,
  places_results: (d, k) => <PlacesResults key={k} data={d as PlacesResultsArtifact} />,
  stock_quote: (d, k) => <MarketCard key={k} data={d as StockQuoteArtifact} />,
  swarm_trace: (d, k) => <SwarmTraceCard key={k} data={d as SwarmTraceArtifact} />,
  chart: (d, k) => <ChartCard key={k} data={d as ChartArtifact} />,
  metric_board: (d, k) => <MetricBoard key={k} data={d as MetricBoardArtifact} />
};

/** Every artifact type the renderer can display. Cross-checked against the gallery. */
export const ARTIFACT_TYPES: string[] = Object.keys(ARTIFACT_RENDERERS);

const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode =>
  ARTIFACT_RENDERERS[artifact.type]?.(artifact.data, key) ?? null;

// Large/interactive artifacts span the full width; compact cards (market quotes,
// charts, KPI boards, news) pack two-up so the model can aggregate several data
// sources side by side — e.g. "compare gold, oil and the S&P" → three quote cards
// laid out in a grid instead of a tall stack.
const FULL_WIDTH = new Set(['weather', 'map', 'places_results', 'video_results', 'swarm_trace']);

export const ChatArtifacts: React.FC<{ artifacts?: ChatArtifact[] }> = ({ artifacts }) => {
  if (!artifacts || artifacts.length === 0) return null;
  if (artifacts.length === 1) return <>{renderArtifact(artifacts[0], 0)}</>;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {artifacts.map((a, i) => (
        <div key={i} className={FULL_WIDTH.has(a.type) ? 'sm:col-span-2' : 'min-w-0'}>
          {renderArtifact(a, i)}
        </div>
      ))}
    </div>
  );
};
