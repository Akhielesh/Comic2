import React from 'react';
import type { ChatArtifact, WeatherArtifact, VideoResultsArtifact, MapArtifact, NewsResultsArtifact, StockQuoteArtifact, SwarmTraceArtifact, PlacesResultsArtifact, ChartArtifact, MetricBoardArtifact, DataTableArtifact, HeatmapArtifact, FinanceTerminalArtifact, CodeStudioArtifact, RecipeCardArtifact, RecipeRunArtifact, ResearchReportArtifact, QuizArtifact, DocumentArtifact, FlashcardsArtifact, SqlExerciseArtifact, ResourceBundleArtifact, CodeExerciseArtifact, GenerativeUIArtifact } from '../../../apiTypes';
import type { DashboardArtifact } from '../../../apiTypes';
import { ArtifactBoundary } from './ArtifactBoundary';
import { WidgetFrame } from './WidgetFrame';
import { WeatherStation } from './WeatherStation';
import { VideoResults } from './VideoResults';
import { MapArtifactCard } from './MapArtifactCard';
import { NewsDigest } from './NewsDigest';
import { MarketCard } from './MarketCard';
import { SwarmTraceCard } from './SwarmTraceCard';
import { PlacesResults } from './PlacesResults';
import { ChartCard } from './ChartCard';
import { MetricBoard } from './MetricBoard';
import { DataTableCard } from './DataTableCard';
import { HeatmapCard } from './HeatmapCard';
import { FinanceTerminal } from './FinanceTerminal';
import { CodeStudioCard } from './CodeStudioCard';
import { RecipeCard } from './RecipeCard';
import { RecipeRunCard } from './RecipeRunCard';
import { ResearchReport } from './ResearchReport';
import { Quiz } from './Quiz';
import { DocumentCard } from './DocumentCard';
import { Flashcards } from './Flashcards';
import { SqlPlayground } from './SqlPlayground';
import { ResourceBundle } from './ResourceBundle';
import { CodePlayground } from './CodePlayground';
import { GenerativeUICard } from './GenerativeUICard';
import { DashboardCard } from './DashboardCard';

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
  metric_board: (d, k) => <MetricBoard key={k} data={d as MetricBoardArtifact} />,
  data_table: (d, k) => <DataTableCard key={k} data={d as DataTableArtifact} />,
  market_heatmap: (d, k) => <HeatmapCard key={k} data={d as HeatmapArtifact} />,
  finance_terminal: (d, k) => <FinanceTerminal key={k} data={d as FinanceTerminalArtifact} />,
  code_studio: (d, k) => <CodeStudioCard key={k} data={d as CodeStudioArtifact} />,
  recipe_card: (d, k) => <RecipeCard key={k} data={d as RecipeCardArtifact} />,
  recipe_run: (d, k) => <RecipeRunCard key={k} data={d as RecipeRunArtifact} />,
  research_report: (d, k) => <ResearchReport key={k} data={d as ResearchReportArtifact} />,
  quiz: (d, k) => <Quiz key={k} data={d as QuizArtifact} />,
  document: (d, k) => <DocumentCard key={k} data={d as DocumentArtifact} />,
  flashcards: (d, k) => <Flashcards key={k} data={d as FlashcardsArtifact} />,
  sql_exercise: (d, k) => <SqlPlayground key={k} data={d as SqlExerciseArtifact} />,
  resource_bundle: (d, k) => <ResourceBundle key={k} data={d as ResourceBundleArtifact} />,
  code_exercise: (d, k) => <CodePlayground key={k} data={d as CodeExerciseArtifact} />,
  generative_ui: (d, k) => <GenerativeUICard key={k} data={d as GenerativeUIArtifact} />,
  dashboard: (d, k) => <DashboardCard key={k} data={d as DashboardArtifact} />
};

/** Every artifact type the renderer can display. Cross-checked against the gallery. */
export const ARTIFACT_TYPES: string[] = Object.keys(ARTIFACT_RENDERERS);

// Cards that implement a bespoke compact ("glance") layout via useDensity(). Cards
// not listed here still get a working compact mode — the WidgetFrame clamps them to
// a short faded preview. Keep this in sync when a card learns a real compact layout.
export const DENSITY_AWARE_TYPES = new Set([
  'weather',
  'stock_quote',
  'news_results',
  'chart',
  'metric_board',
  'data_table',
  'market_heatmap',
  'finance_terminal',
  'places_results',
  'video_results',
  'research_report',
  'swarm_trace',
  'flashcards',
  'document',
  'map'
]);

const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode => {
  const node = ARTIFACT_RENDERERS[artifact.type]?.(artifact.data, key) ?? null;
  if (node === null) return null;
  // The AI can pre-pick a glance card by emitting `density: 'compact'` in the data.
  const hint = (artifact.data as { density?: string } | null | undefined)?.density;
  // Every artifact is wrapped so a malformed `data` payload (artifact.data is `unknown`)
  // can't blank the whole message — it degrades to a small inline notice instead.
  return (
    <ArtifactBoundary key={key} label={artifact.type}>
      <WidgetFrame
        type={artifact.type}
        densityHint={hint === 'compact' || hint === 'detailed' ? hint : undefined}
        densityAware={DENSITY_AWARE_TYPES.has(artifact.type)}
      >
        {node}
      </WidgetFrame>
    </ArtifactBoundary>
  );
};

// Large/interactive artifacts span the full width; compact cards (market quotes,
// charts, KPI boards, news) pack two-up so the model can aggregate several data
// sources side by side — e.g. "compare gold, oil and the S&P" → three quote cards
// laid out in a grid instead of a tall stack.
const FULL_WIDTH = new Set(['weather', 'map', 'places_results', 'video_results', 'swarm_trace', 'code_studio', 'recipe_card', 'recipe_run', 'research_report', 'quiz', 'document', 'flashcards', 'sql_exercise', 'resource_bundle', 'code_exercise', 'generative_ui', 'dashboard']);

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
