import React, { useCallback, useState } from 'react';
import { REFRESHABLE_TOOLS } from '../../../apiTypes';
import { LiveDataContext } from './kit';
import type { ChatArtifact, WeatherArtifact, VideoResultsArtifact, MapArtifact, NewsResultsArtifact, StockQuoteArtifact, SwarmTraceArtifact, PlacesResultsArtifact, ChartArtifact, MetricBoardArtifact, DataTableArtifact, HeatmapArtifact, FinanceTerminalArtifact, CodeStudioArtifact, RecipeCardArtifact, RecipeRunArtifact, ResearchReportArtifact, QuizArtifact, DocumentArtifact, FlashcardsArtifact, SqlExerciseArtifact, ResourceBundleArtifact, CodeExerciseArtifact, GenerativeUIArtifact, LearningPathArtifact, ItineraryArtifact, StockComparisonArtifact, ReactComponentArtifact } from '../../../apiTypes';
import type { DashboardArtifact, TickerTapeArtifact, MarketSentimentArtifact, YieldCurveArtifact, PortfolioArtifact, WhatsChangedArtifact, BoardingPassArtifact, CurrencyConverterArtifact, WorldClocksArtifact, PackingListArtifact, TripCountdownArtifact, GoalTrackerArtifact, CodeReviewArtifact, LiveMonitorArtifact } from '../../../apiTypes';
import type { MacroTilesArtifact, EconCalendarArtifact, EarningsCalendarArtifact, CentralBankWatchArtifact, PnlCalendarArtifact, DebtClockArtifact, FlightStatusArtifact, TripBudgetArtifact, LocalCheatsheetArtifact, LoyaltyWalletArtifact, WidgetStackArtifact, DirectionsArtifact } from '../../../apiTypes';
import { ArtifactBoundary } from './ArtifactBoundary';
import { WidgetFrame } from './WidgetFrame';
import { WidgetGallery } from './WidgetGallery';
import { WeatherStation } from './WeatherStation';
import { VideoResults } from './VideoResults';
import { MapArtifactCard } from './MapArtifactCard';
import { DirectionsCard } from './DirectionsCard';
import { NewsDigest } from './NewsDigest';
import { MarketCard } from './MarketCard';
import { ComparisonChart } from './ComparisonChart';
import { LiveComponentCard } from './LiveComponentCard';
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
import { LearningPathCard } from './LearningPathCard';
import { ItineraryCard } from './ItineraryCard';
import { TickerTape } from './TickerTape';
import { MarketSentiment } from './MarketSentiment';
import { YieldCurveCard } from './YieldCurveCard';
import { PortfolioCard } from './PortfolioCard';
import { WhatsChangedCard } from './WhatsChangedCard';
import { BoardingPass } from './BoardingPass';
import { CurrencyConverter } from './CurrencyConverter';
import { WorldClocks } from './WorldClocks';
import { PackingListCard } from './PackingListCard';
import { TripCountdown } from './TripCountdown';
import { GoalTracker } from './GoalTracker';
import { CodeReviewCard } from './CodeReviewCard';
import { LiveMonitorCard } from './LiveMonitorCard';
import { MacroTiles } from './MacroTiles';
import { EconCalendar } from './EconCalendar';
import { EarningsCountdown } from './EarningsCountdown';
import { CentralBankWatch } from './CentralBankWatch';
import { PnlCalendar } from './PnlCalendar';
import { DebtClock } from './DebtClock';
import { FlightStatus } from './FlightStatus';
import { TripBudget } from './TripBudget';
import { LocalCheatsheet } from './LocalCheatsheet';
import { LoyaltyWallet } from './LoyaltyWallet';
import { WidgetStack } from './WidgetStack';
import { ClarifyCard } from './ClarifyCard';
import type { ClarifyArtifact } from '../../../apiTypes';
import { EmailTerminal } from './EmailTerminal';
import { EmailCompose } from './EmailCompose';
import type { EmailInboxArtifact, EmailComposeArtifact } from '../../../apiTypes';

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
  directions: (d, k) => <DirectionsCard key={k} data={d as DirectionsArtifact} />,
  news_results: (d, k) => <NewsDigest key={k} data={d as NewsResultsArtifact} />,
  places_results: (d, k) => <PlacesResults key={k} data={d as PlacesResultsArtifact} />,
  stock_quote: (d, k) => <MarketCard key={k} data={d as StockQuoteArtifact} />,
  stock_comparison: (d, k) => <ComparisonChart key={k} data={d as StockComparisonArtifact} />,
  react_component: (d, k) => <LiveComponentCard key={k} data={d as ReactComponentArtifact} />,
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
  dashboard: (d, k) => <DashboardCard key={k} data={d as DashboardArtifact} />,
  learning_path: (d, k) => <LearningPathCard key={k} data={d as LearningPathArtifact} />,
  itinerary: (d, k) => <ItineraryCard key={k} data={d as ItineraryArtifact} />,
  ticker_tape: (d, k) => <TickerTape key={k} data={d as TickerTapeArtifact} />,
  market_sentiment: (d, k) => <MarketSentiment key={k} data={d as MarketSentimentArtifact} />,
  yield_curve: (d, k) => <YieldCurveCard key={k} data={d as YieldCurveArtifact} />,
  portfolio: (d, k) => <PortfolioCard key={k} data={d as PortfolioArtifact} />,
  whats_changed: (d, k) => <WhatsChangedCard key={k} data={d as WhatsChangedArtifact} />,
  boarding_pass: (d, k) => <BoardingPass key={k} data={d as BoardingPassArtifact} />,
  currency_converter: (d, k) => <CurrencyConverter key={k} data={d as CurrencyConverterArtifact} />,
  world_clocks: (d, k) => <WorldClocks key={k} data={d as WorldClocksArtifact} />,
  packing_list: (d, k) => <PackingListCard key={k} data={d as PackingListArtifact} />,
  trip_countdown: (d, k) => <TripCountdown key={k} data={d as TripCountdownArtifact} />,
  goal_tracker: (d, k) => <GoalTracker key={k} data={d as GoalTrackerArtifact} />,
  code_review: (d, k) => <CodeReviewCard key={k} data={d as CodeReviewArtifact} />,
  live_monitor: (d, k) => <LiveMonitorCard key={k} data={d as LiveMonitorArtifact} renderEmbedded={renderArtifactNode} />,
  macro_tiles: (d, k) => <MacroTiles key={k} data={d as MacroTilesArtifact} />,
  econ_calendar: (d, k) => <EconCalendar key={k} data={d as EconCalendarArtifact} />,
  earnings_calendar: (d, k) => <EarningsCountdown key={k} data={d as EarningsCalendarArtifact} />,
  central_bank_watch: (d, k) => <CentralBankWatch key={k} data={d as CentralBankWatchArtifact} />,
  pnl_calendar: (d, k) => <PnlCalendar key={k} data={d as PnlCalendarArtifact} />,
  debt_clock: (d, k) => <DebtClock key={k} data={d as DebtClockArtifact} />,
  flight_status: (d, k) => <FlightStatus key={k} data={d as FlightStatusArtifact} />,
  trip_budget: (d, k) => <TripBudget key={k} data={d as TripBudgetArtifact} />,
  local_cheatsheet: (d, k) => <LocalCheatsheet key={k} data={d as LocalCheatsheetArtifact} />,
  loyalty_wallet: (d, k) => <LoyaltyWallet key={k} data={d as LoyaltyWalletArtifact} />,
  widget_stack: (d, k) => <WidgetStack key={k} data={d as WidgetStackArtifact} renderEmbedded={renderArtifactNode} />,
  clarify: (d, k) => <ClarifyCard key={k} data={d as ClarifyArtifact} />,
  email_inbox: (d, k) => <EmailTerminal key={k} data={d as EmailInboxArtifact} />,
  email_unread: (d, k) => <EmailTerminal key={k} data={d as EmailInboxArtifact} />,
  email_compose: (d, k) => <EmailCompose key={k} data={d as EmailComposeArtifact} />
};

/** Render an artifact's bare card via the registry (no frame/boundary). Used by the
 * live monitor to draw its embedded widget and by the gallery — exported here so
 * both share one lookup without creating an import cycle. */
export const renderArtifactNode = (artifact: ChatArtifact): React.ReactNode =>
  ARTIFACT_RENDERERS[artifact.type]?.(artifact.data, 0) ?? null;

/** Every artifact type the renderer can display. Cross-checked against the gallery. */
export const ARTIFACT_TYPES: string[] = Object.keys(ARTIFACT_RENDERERS);

// Cards that implement a bespoke compact ("glance") layout via useDensity(). Cards
// not listed here still get a working compact mode — the WidgetFrame clamps them to
// a short faded preview. Keep this in sync when a card learns a real compact layout.
export const DENSITY_AWARE_TYPES = new Set([
  'weather',
  'stock_quote',
  'stock_comparison',
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
  'map',
  'directions',
  'learning_path',
  'itinerary',
  'ticker_tape',
  'market_sentiment',
  'yield_curve',
  'portfolio',
  'whats_changed',
  'boarding_pass',
  'currency_converter',
  'world_clocks',
  'packing_list',
  'trip_countdown',
  'goal_tracker',
  'code_review',
  'live_monitor',
  'macro_tiles',
  'econ_calendar',
  'earnings_calendar',
  'central_bank_watch',
  'pnl_calendar',
  'debt_clock',
  'flight_status',
  'trip_budget',
  'local_cheatsheet',
  'loyalty_wallet',
  'widget_stack',
  'react_component',
  'email_inbox',
  'email_unread',
  'email_compose'
]);

// Holds the freshest version of a single artifact. When the server stamped an
// `origin` (the tool call that produced it) and that tool is refresh-whitelisted,
// the widget gets a live-refresh control (WidgetFrame) and cards can re-query with
// patched args (e.g. news topic chips) via useLiveData() — no model round-trip.
const LiveArtifact: React.FC<{ artifact: ChatArtifact }> = ({ artifact }) => {
  const [current, setCurrent] = useState(artifact);
  const [refreshing, setRefreshing] = useState(false);
  const [asOf, setAsOf] = useState<string | undefined>(undefined);
  const origin = current.origin ?? artifact.origin;
  const canRefresh = !!origin && (REFRESHABLE_TOOLS as readonly string[]).includes(origin.tool);

  const refresh = useCallback(
    async (argsPatch?: Record<string, unknown>) => {
      if (!origin) return;
      setRefreshing(true);
      try {
        const { refreshArtifact } = await import('../../../services/chatApi');
        const result = await refreshArtifact(origin.tool, { ...origin.args, ...(argsPatch ?? {}) });
        const next = result.artifacts.find((a) => a.type === current.type) ?? result.artifacts[0];
        if (next) {
          setCurrent(next);
          setAsOf(result.asOf);
        }
      } catch {
        /* keep showing the last good snapshot */
      } finally {
        setRefreshing(false);
      }
    },
    [origin, current.type]
  );

  const node = ARTIFACT_RENDERERS[current.type]?.(current.data, 0) ?? null;
  if (node === null) return null;
  // The AI can pre-pick a glance card by emitting `density: 'compact'` in the data.
  const hint = (current.data as { density?: string } | null | undefined)?.density;
  return (
    <LiveDataContext.Provider value={{ canRefresh, refreshing, asOf, refresh }}>
      <WidgetFrame
        type={current.type}
        densityHint={hint === 'compact' || hint === 'detailed' ? hint : undefined}
        densityAware={DENSITY_AWARE_TYPES.has(current.type)}
        origin={canRefresh ? origin : undefined}
        snapshot={canRefresh ? undefined : { type: current.type, data: current.data }}
      >
        {node}
      </WidgetFrame>
    </LiveDataContext.Provider>
  );
};

const renderArtifact = (artifact: ChatArtifact, key: number): React.ReactNode => {
  if (!ARTIFACT_RENDERERS[artifact.type]) return null;
  // Every artifact is wrapped so a malformed `data` payload (artifact.data is `unknown`)
  // can't blank the whole message — it degrades to a small inline notice instead.
  return (
    <ArtifactBoundary key={key} label={artifact.type}>
      <LiveArtifact artifact={artifact} />
    </ArtifactBoundary>
  );
};

// Large/interactive artifacts (maps, itineraries, code, research) get a roomier
// column in the gallery so they stay legible; compact cards (market quotes, charts,
// KPI boards, news) ride a narrower column so several pack into view at once — e.g.
// "compare gold, oil and the S&P" → three quote cards you swipe through instead of a
// tall stack you scroll past.
const WIDE_IN_GALLERY = new Set(['weather', 'map', 'directions', 'places_results', 'video_results', 'swarm_trace', 'code_studio', 'recipe_card', 'recipe_run', 'research_report', 'quiz', 'document', 'flashcards', 'sql_exercise', 'resource_bundle', 'code_exercise', 'generative_ui', 'dashboard', 'learning_path', 'itinerary', 'ticker_tape', 'portfolio', 'goal_tracker', 'code_review', 'live_monitor', 'macro_tiles', 'econ_calendar', 'earnings_calendar', 'central_bank_watch', 'pnl_calendar', 'flight_status', 'local_cheatsheet', 'widget_stack', 'stock_comparison', 'react_component', 'email_inbox', 'email_unread', 'email_compose']);

// When an assistant turn produces several cards, present them as a horizontal
// scrolling gallery (snap + edge fades + arrows + dots) rather than a tall vertical
// stack — this is the chat's answer to "I'm scrolling through quite a bit".
export const ChatArtifacts: React.FC<{ artifacts?: ChatArtifact[] }> = ({ artifacts }) => {
  if (!artifacts || artifacts.length === 0) return null;
  if (artifacts.length === 1) return <>{renderArtifact(artifacts[0], 0)}</>;
  const items = artifacts
    .filter((a) => ARTIFACT_RENDERERS[a.type])
    .map((a, i) => ({ key: i, node: renderArtifact(a, i), wide: WIDE_IN_GALLERY.has(a.type) }));
  if (items.length === 0) return null;
  if (items.length === 1) return <>{items[0].node}</>;
  return <WidgetGallery items={items} />;
};
