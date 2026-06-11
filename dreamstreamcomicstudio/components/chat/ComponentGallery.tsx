import React from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { WidgetFrame } from './artifacts/WidgetFrame';
import { DENSITY_AWARE_TYPES } from './artifacts/ChatArtifacts';
import { WeatherStation } from './artifacts/WeatherStation';
import { NewsDigest } from './artifacts/NewsDigest';
import { MarketCard } from './artifacts/MarketCard';
import { VideoResults } from './artifacts/VideoResults';
import { PlacesResults } from './artifacts/PlacesResults';
import { SwarmTraceCard } from './artifacts/SwarmTraceCard';
import { ChartCard } from './artifacts/ChartCard';
import { MetricBoard } from './artifacts/MetricBoard';
import { MapArtifactCard } from './artifacts/MapArtifactCard';
import { DataTableCard } from './artifacts/DataTableCard';
import { HeatmapCard } from './artifacts/HeatmapCard';
import { FinanceTerminal } from './artifacts/FinanceTerminal';
import { CodeStudioCard } from './artifacts/CodeStudioCard';
import { RecipeCard } from './artifacts/RecipeCard';
import { RecipeRunCard } from './artifacts/RecipeRunCard';
import { ResearchReport } from './artifacts/ResearchReport';
import { Quiz } from './artifacts/Quiz';
import { DocumentCard } from './artifacts/DocumentCard';
import { Flashcards } from './artifacts/Flashcards';
import { SqlPlayground } from './artifacts/SqlPlayground';
import { ResourceBundle } from './artifacts/ResourceBundle';
import { CodePlayground } from './artifacts/CodePlayground';
import { GenerativeUICard } from './artifacts/GenerativeUICard';
import { DashboardCard } from './artifacts/DashboardCard';
import { LearningPathCard } from './artifacts/LearningPathCard';
import { ItineraryCard } from './artifacts/ItineraryCard';
import { TickerTape } from './artifacts/TickerTape';
import { MarketSentiment } from './artifacts/MarketSentiment';
import { YieldCurveCard } from './artifacts/YieldCurveCard';
import { PortfolioCard } from './artifacts/PortfolioCard';
import { WhatsChangedCard } from './artifacts/WhatsChangedCard';
import { BoardingPass } from './artifacts/BoardingPass';
import { CurrencyConverter } from './artifacts/CurrencyConverter';
import { WorldClocks } from './artifacts/WorldClocks';
import { PackingListCard } from './artifacts/PackingListCard';
import { TripCountdown } from './artifacts/TripCountdown';
import { GoalTracker } from './artifacts/GoalTracker';
import { CodeReviewCard } from './artifacts/CodeReviewCard';
import { LiveMonitorCard } from './artifacts/LiveMonitorCard';
import { MacroTiles } from './artifacts/MacroTiles';
import { EconCalendar } from './artifacts/EconCalendar';
import { EarningsCountdown } from './artifacts/EarningsCountdown';
import { CentralBankWatch } from './artifacts/CentralBankWatch';
import { PnlCalendar } from './artifacts/PnlCalendar';
import { DebtClock } from './artifacts/DebtClock';
import { FlightStatus } from './artifacts/FlightStatus';
import { TripBudget } from './artifacts/TripBudget';
import { LocalCheatsheet } from './artifacts/LocalCheatsheet';
import { LoyaltyWallet } from './artifacts/LoyaltyWallet';
import { WidgetStack } from './artifacts/WidgetStack';
import { renderArtifactNode } from './artifacts/ChatArtifacts';
import type {
  DashboardArtifact, LearningPathArtifact, ItineraryArtifact,
  TickerTapeArtifact, MarketSentimentArtifact, YieldCurveArtifact, PortfolioArtifact, WhatsChangedArtifact,
  BoardingPassArtifact, CurrencyConverterArtifact, WorldClocksArtifact, PackingListArtifact, TripCountdownArtifact,
  GoalTrackerArtifact, CodeReviewArtifact, LiveMonitorArtifact,
  MacroTilesArtifact, EconCalendarArtifact, EarningsCalendarArtifact, CentralBankWatchArtifact,
  PnlCalendarArtifact, DebtClockArtifact, FlightStatusArtifact, TripBudgetArtifact,
  LocalCheatsheetArtifact, LoyaltyWalletArtifact, WidgetStackArtifact
} from '../../apiTypes';
import type {
  WeatherArtifact, NewsResultsArtifact, StockQuoteArtifact,
  VideoResultsArtifact, PlacesResultsArtifact, SwarmTraceArtifact,
  ChartArtifact, MetricBoardArtifact, MapArtifact,
  DataTableArtifact, HeatmapArtifact, FinanceTerminalArtifact, CodeStudioArtifact,
  RecipeCardArtifact, RecipeRunArtifact, ResearchReportArtifact, QuizArtifact, DocumentArtifact, FlashcardsArtifact, SqlExerciseArtifact, ResourceBundleArtifact, CodeExerciseArtifact,
  GenerativeUIArtifact
} from '../../apiTypes';

const sqlExerciseDemo: SqlExerciseArtifact = {
  title: 'SQL practice — filter & sort',
  instructions: 'Practice a SELECT with a WHERE filter and ORDER BY against a small employees table.',
  schema: "CREATE TABLE employees (id INTEGER, name TEXT, dept TEXT, salary INTEGER);\nINSERT INTO employees VALUES\n  (1,'Ann','Eng',120000),(2,'Bob','Sales',80000),\n  (3,'Cy','Eng',135000),(4,'Di','Sales',95000);",
  task: 'List the names and salaries of Engineering employees earning over 125k, highest first.',
  starterSql: 'SELECT name, salary\nFROM employees\nWHERE ...'
};

const flashcardsDemo: FlashcardsArtifact = {
  title: 'Spanish — common verbs',
  topic: 'Vocabulary',
  cards: [
    { front: 'ser', back: 'to be (permanent)' },
    { front: 'estar', back: 'to be (temporary / location)' },
    { front: 'tener', back: 'to have' },
    { front: 'hacer', back: 'to do / to make' },
    { front: 'poder', back: 'to be able to / can' }
  ]
};

const documentDemo: DocumentArtifact = {
  title: 'SQL JOINs — Cheat Sheet',
  subtitle: 'Quick reference · with examples',
  filename: 'sql-joins-cheatsheet',
  content: [
    '## The four core joins',
    '- **INNER JOIN** — rows with a match in *both* tables.',
    '- **LEFT JOIN** — all left rows + matches (NULLs where none).',
    '- **RIGHT JOIN** — all right rows + matches.',
    '- **FULL OUTER JOIN** — everything from both sides.',
    '',
    '```sql',
    'SELECT o.id, c.name',
    'FROM orders o',
    'LEFT JOIN customers c ON c.id = o.customer_id;',
    '```',
    '',
    '> Tip: start from the table you want *all* rows of, then LEFT JOIN the rest.'
  ].join('\n')
};

const codeExerciseDemo: CodeExerciseArtifact = {
  title: 'Array practice — map & filter',
  instructions: 'Use array methods to transform the data, then log the result.',
  task: 'Log the names of users aged 18 or over, uppercased.',
  language: 'javascript',
  starterCode: "const users = [\n  { name: 'ana', age: 20 },\n  { name: 'bo', age: 16 },\n  { name: 'cy', age: 31 },\n];\n\nconst adults = users\n  .filter(u => u.age >= 18)\n  .map(u => u.name.toUpperCase());\n\nconsole.log(adults);"
};

const pythonExerciseDemo: CodeExerciseArtifact = {
  title: 'Python practice — list comprehension',
  instructions: 'Use a list comprehension, then print the result.',
  task: 'Print the squares of the even numbers from 0 to 9.',
  language: 'python',
  starterCode: 'squares = [n * n for n in range(10) if n % 2 == 0]\nprint(squares)'
};

const resourceBundleDemo: ResourceBundleArtifact = {
  title: 'Photosynthesis study pack',
  description: 'Everything to revise the topic — guide, practice, flashcards.',
  files: [
    { name: 'study-guide.md', label: 'The full guide', content: '# Photosynthesis\n\n6CO2 + 6H2O + light → C6H12O6 + 6O2.\n\n- **Light reactions** (thylakoid): make ATP + NADPH.\n- **Calvin cycle** (stroma): fix CO2 into sugar.' },
    { name: 'practice-questions.md', label: '5 questions', content: '1. Where do the light reactions occur?\n2. Name the two inputs.\n3. What gas is released?\n4. What does the Calvin cycle produce?\n5. Which pigment captures light?' },
    { name: 'flashcards.csv', label: 'Import into Anki', content: 'front,back\nChloroplast,Site of photosynthesis\nChlorophyll,Green pigment that captures light\nStroma,Where the Calvin cycle runs' }
  ]
};

const quizDemo: QuizArtifact = {
  title: 'Photosynthesis — quick check',
  topic: 'Biology',
  description: 'A short mixed-format quiz to test the basics.',
  questions: [
    {
      id: 'q1', type: 'single', prompt: 'Where in the cell does photosynthesis occur?',
      choices: [
        { id: 'a', text: 'Mitochondria' },
        { id: 'b', text: 'Chloroplast' },
        { id: 'c', text: 'Nucleus' },
        { id: 'd', text: 'Ribosome' }
      ],
      correct: ['b'], explanation: 'Chloroplasts contain chlorophyll, which captures light energy.', hint: 'It is green.'
    },
    {
      id: 'q2', type: 'multi', prompt: 'Which are INPUTS to photosynthesis? (select all)',
      choices: [
        { id: 'a', text: 'Carbon dioxide' },
        { id: 'b', text: 'Water' },
        { id: 'c', text: 'Oxygen' },
        { id: 'd', text: 'Sunlight' }
      ],
      correct: ['a', 'b', 'd'], explanation: 'CO₂, water and light are inputs; oxygen is an output.'
    },
    {
      id: 'q3', type: 'true_false', prompt: 'Photosynthesis releases oxygen.',
      choices: [{ id: 't', text: 'True' }, { id: 'f', text: 'False' }],
      correct: ['t']
    },
    {
      id: 'q4', type: 'short', prompt: 'What gas do plants release as a by-product?',
      correct: ['oxygen', 'o2'], explanation: 'Oxygen (O₂) is released during the light reactions.'
    }
  ]
};

// A living gallery of the chat's rich-output components, each with sample data, so
// the UI library can be seen and sanity-checked in one place.

const weather: WeatherArtifact = {
  location: 'New York, NY',
  coords: { lat: 40.7128, lng: -74.006 },
  current: { tempC: 22, tempF: 72, feelsLikeC: 23, code: 2, description: 'Partly cloudy', windKph: 12, windDir: 230, windGustKph: 28, humidity: 54, uvIndex: 5, precipProb: 10, pressureHpa: 1014, dewPointC: 12, visibilityKm: 16, cloudCover: 40, isDay: true },
  hourly: Array.from({ length: 12 }, (_, i) => ({ time: new Date(Date.now() + i * 3600_000).toISOString(), tempC: 22 - i * 0.4, code: i % 3, precipProb: i * 4 })),
  daily: Array.from({ length: 5 }, (_, i) => ({ date: new Date(Date.now() + i * 86400_000).toISOString(), minC: 14 + i, maxC: 24 + i, code: [0, 2, 61, 3, 1][i], description: 'Sample', precipProb: i * 10, uvMax: 6, sunrise: new Date().toISOString(), sunset: new Date().toISOString() })),
  airQuality: { usAqi: 42, pm25: 9, category: 'Good' },
  pollen: { grass: 12, tree: 30, weed: 5, level: 'Moderate' }
};

const news: NewsResultsArtifact = {
  query: 'AI', items: [
    { title: 'A breakthrough model ships with agentic tools and parallel execution', url: 'https://techdaily.com/1', source: 'TechDaily', publishedAt: new Date(Date.now() - 3600_000).toISOString(), snippet: 'The release adds parallel tool use, a larger context window, and on-device inference, marking a notable step for agentic workflows across the industry.', sentiment: 'positive', readMinutes: 4 },
    { title: 'Open models close the gap on closed ones', url: 'https://reuters.com/2', source: 'Reuters', publishedAt: new Date(Date.now() - 7200_000).toISOString(), snippet: 'Benchmarks show open-weight models trailing flagship systems by a narrowing margin.' },
    { title: 'Chipmakers race to meet inference demand', url: 'https://bloomberg.com/3', source: 'Bloomberg', publishedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), snippet: 'Capacity constraints push prices higher as data-center buildout accelerates.', sentiment: 'neutral', readMinutes: 6 },
    { title: 'Regulators weigh new disclosure rules for AI systems', url: 'https://theverge.com/4', source: 'The Verge', publishedAt: new Date(Date.now() - 9 * 3600_000).toISOString(), sentiment: 'negative' }
  ]
};

// Build a synthetic price walk and bucket it into ranges + candles so the gallery
// exercises the timeline selector and candlestick toggle.
const walk = (n: number, start: number, drift: number, vol: number): number[] => {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v += drift + Math.sin(i / 4) * vol + (Math.cos(i / 9) * vol) / 2;
    out.push(Number(v.toFixed(2)));
  }
  return out;
};
const dateOffset = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
const toSeries = (vals: number[]): { date: string; close: number }[] =>
  vals.map((close, i) => ({ date: dateOffset(vals.length - i), close }));
const maxVals = walk(260, 150, 0.22, 5);
const candleVals = maxVals.slice(-40);
// Intraday 1D walk (78 5-min bars across a trading session).
const intradayVals = walk(78, 202, 0.03, 1.1);
const intraday = intradayVals.map((close, i) => ({ date: new Date(Date.now() - (intradayVals.length - i) * 5 * 60_000).toISOString(), close }));

const stock: StockQuoteArtifact = {
  symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', marketState: 'open',
  price: 204.2, change: 2.8, changePercent: 1.39, open: 201.5, high: 205.1, low: 199.8,
  volume: 51_000_000, previousClose: 201.4, asOf: '2026-06-03',
  series: toSeries(maxVals.slice(-30)),
  ranges: {
    '1D': intraday,
    '5D': toSeries(maxVals.slice(-5)),
    '1M': toSeries(maxVals.slice(-22)),
    '6M': toSeries(maxVals.slice(-126)),
    '1Y': toSeries(maxVals.slice(-252)),
    MAX: toSeries(maxVals)
  },
  candles: candleVals.map((close, i) => {
    const open = i === 0 ? close - 1 : candleVals[i - 1];
    const high = Math.max(open, close) + Math.abs(Math.sin(i)) * 2;
    const low = Math.min(open, close) - Math.abs(Math.cos(i)) * 2;
    return { date: dateOffset(candleVals.length - i), open, high, low, close };
  }),
  stats: { marketCap: 3.12e12, peRatio: 31.4, eps: 6.5, dividendYield: 0.52, avgVolume: 58_000_000, beta: 1.21, week52Low: 164.1, week52High: 237.2 },
  headlines: [
    { title: 'Apple unveils on-device model toolkit at WWDC', url: 'https://example.com/a', source: 'TechDaily', publishedAt: new Date(Date.now() - 5400_000).toISOString() },
    { title: 'Analysts raise price targets ahead of earnings', url: 'https://example.com/b', source: 'MarketWire', publishedAt: new Date(Date.now() - 3 * 86400_000).toISOString() }
  ],
  related: [
    { symbol: 'MSFT', name: 'Microsoft Corp', price: 429.46, changePercent: 0.5, currency: 'USD' },
    { symbol: 'NVDA', name: 'NVIDIA Corp', price: 214.12, changePercent: -0.09, currency: 'USD' },
    { symbol: 'AMZN', name: 'Amazon.com Inc', price: 253.92, changePercent: 1.56, currency: 'USD' },
    { symbol: 'GOOGL', name: 'Alphabet Inc', price: 182.4, changePercent: 0.83, currency: 'USD' }
  ]
};

const videos: VideoResultsArtifact = {
  query: 'weather report', results: [
    { title: 'Live storm tracker — DC region', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg', publisher: 'WX News', duration: 'LIVE' }
  ]
};

const places: PlacesResultsArtifact = {
  query: 'restaurants', near: 'your location', anchor: { lat: 40.7128, lng: -74.006 },
  results: [
    { name: 'Trattoria Bella', category: 'restaurant', cuisine: 'italian', lat: 40.713, lng: -74.005, distanceKm: 0.3, address: '12 Mulberry St', openingHours: 'Open until 11 PM', website: 'https://example.com', rating: 4.6, price: 2 },
    { name: 'Corner Cafe', category: 'cafe', cuisine: 'coffee', lat: 40.715, lng: -74.008, distanceKm: 0.6, rating: 4.2, price: 1 }
  ]
};

const swarm: SwarmTraceArtifact = {
  goal: 'Brief me on tech news + the market',
  agents: [
    { id: 'tech', name: 'Tech Reporter', task: 'Latest tech news', status: 'done', summary: 'Found 3 major releases…', confidence: 0.9, flags: [], toolEvents: [{ tool: 'get_news', query: 'tech', ok: true }] },
    { id: 'finance', name: 'Markets Analyst', task: 'Market summary', status: 'done', summary: 'Indices up 0.8%…', confidence: 0.55, flags: ['hedged'], toolEvents: [{ tool: 'get_stock', ok: true }] },
    { id: 'research', name: 'Web Researcher', task: 'Context', status: 'done', summary: 'Background gathered from memory only.', confidence: 0.35, flags: ['no_sources'] }
  ]
};

const barChart: ChartArtifact = {
  variant: 'grouped-bar', title: 'Quarterly revenue by region', subtitle: '$M, FY26', palette: 'ocean', unit: 'M',
  xLabel: 'Quarter', yLabel: '$M',
  series: [
    { name: 'Americas', points: [{ x: 'Q1', y: 120 }, { x: 'Q2', y: 145 }, { x: 'Q3', y: 138 }, { x: 'Q4', y: 162 }] },
    { name: 'EMEA', points: [{ x: 'Q1', y: 88 }, { x: 'Q2', y: 96 }, { x: 'Q3', y: 110 }, { x: 'Q4', y: 121 }] },
    { name: 'APAC', points: [{ x: 'Q1', y: 64 }, { x: 'Q2', y: 78 }, { x: 'Q3', y: 92 }, { x: 'Q4', y: 105 }] }
  ]
};

const donutChart: ChartArtifact = {
  variant: 'donut', title: 'Traffic by source', palette: 'sunset',
  series: [{ points: [{ x: 'Organic', y: 42 }, { x: 'Direct', y: 26 }, { x: 'Social', y: 18 }, { x: 'Referral', y: 14 }] }]
};

const board: MetricBoardArtifact = {
  title: 'Site KPIs · last 30 days', columns: 4,
  tiles: [
    { label: 'Visitors', value: 84230, delta: 5120, deltaPercent: 6.5, spark: [60, 62, 65, 63, 70, 74, 78], status: 'good' },
    { label: 'Bounce rate', value: 38, unit: '%', delta: -2.1, deltaPercent: -5.2, status: 'good', progress: { value: 38, max: 100 } },
    { label: 'Avg. order', value: '$72', delta: 3, deltaPercent: 4.3, spark: [64, 66, 65, 68, 70, 71, 72] },
    { label: 'Errors', value: 12, delta: 4, deltaPercent: 50, status: 'bad', spark: [4, 6, 5, 8, 7, 10, 12] }
  ]
};

const tableMd = `| Model | Params (B) | MMLU | Cost ($/M) |
|---|---|---|---|
| Sonnet 4.6 | 175 | 88.7 | 3.00 |
| Llama 3.1 8B | 8 | 73.0 | 0.06 |
| Gemini Flash | 32 | 78.9 | 0.15 |
| GPT-4o mini | 8 | 82.0 | 0.15 |
| Mixtral 8x7B | 47 | 70.6 | 0.24 |`;

const dataTable: DataTableArtifact = {
  title: 'Watchlist · Megacap tech',
  subtitle: '15-min delayed · USD',
  palette: 'ocean',
  sort: { column: 3, dir: 'desc' },
  caption: 'Source: composite feed · illustrative data',
  columns: [
    { label: 'Symbol', kind: 'badge' },
    { label: 'Company', kind: 'text' },
    { label: 'Price', kind: 'currency', currency: 'USD' },
    { label: 'Chg %', kind: 'deltaPercent' },
    { label: '5d', kind: 'spark' },
    { label: 'Mkt cap', kind: 'number' }
  ],
  rows: [
    [{ value: 'AAPL', color: '#2563eb' }, { value: 'Apple Inc.', sub: 'NASDAQ' }, 204.2, 1.39, { spark: [198, 199, 201, 200, 203, 204] }, 3.12e12],
    [{ value: 'MSFT', color: '#2563eb' }, { value: 'Microsoft Corp', sub: 'NASDAQ' }, 429.46, 0.5, { spark: [421, 423, 425, 424, 428, 429] }, 3.19e12],
    [{ value: 'NVDA', color: '#16a34a' }, { value: 'NVIDIA Corp', sub: 'NASDAQ' }, 214.12, -0.09, { spark: [220, 218, 216, 217, 215, 214] }, 5.28e12],
    [{ value: 'AMZN', color: '#ea580c' }, { value: 'Amazon.com Inc', sub: 'NASDAQ' }, 253.92, 1.56, { spark: [244, 246, 249, 248, 252, 254] }, 2.64e12],
    [{ value: 'GOOGL', color: '#dc2626' }, { value: 'Alphabet Inc', sub: 'NASDAQ' }, 182.4, 0.83, { spark: [178, 179, 181, 180, 182, 182] }, 2.24e12]
  ]
};

const heatmap: HeatmapArtifact = {
  title: 'Sector heatmap', subtitle: 'Today · % change', unit: '%',
  caption: 'Tile size ∝ market cap · illustrative data',
  groups: [
    { name: 'Technology', cells: [
      { label: 'AAPL', value: 1.39, sub: '$3.1T', weight: 5 },
      { label: 'MSFT', value: 0.5, sub: '$3.2T', weight: 5 },
      { label: 'NVDA', value: -0.09, sub: '$5.3T', weight: 6 },
      { label: 'AVGO', value: 2.1, sub: '$1.1T', weight: 3 }
    ] },
    { name: 'Financials', cells: [
      { label: 'JPM', value: -1.2, sub: '$680B', weight: 3 },
      { label: 'BAC', value: -2.4, sub: '$320B', weight: 2 },
      { label: 'V', value: 0.7, sub: '$560B', weight: 2 }
    ] },
    { name: 'Energy', cells: [
      { label: 'XOM', value: 3.6, sub: '$520B', weight: 3 },
      { label: 'CVX', value: 2.9, sub: '$280B', weight: 2 }
    ] }
  ]
};

const terminal: FinanceTerminalArtifact = {
  title: 'Markets Terminal', subtitle: 'US equities · session snapshot', asOf: '2026-06-03', palette: 'mono',
  metrics: {
    title: undefined, columns: 4,
    tiles: [
      { label: 'S&P 500', value: '5,431', delta: 18, deltaPercent: 0.34, status: 'good', spark: [5400, 5410, 5405, 5420, 5431] },
      { label: 'Nasdaq', value: '17,612', delta: 92, deltaPercent: 0.52, status: 'good', spark: [17500, 17540, 17520, 17580, 17612] },
      { label: 'VIX', value: 13.8, delta: -0.6, deltaPercent: -4.2, status: 'good' },
      { label: 'US 10Y', value: '4.28%', delta: 0.03, deltaPercent: 0.7, status: 'neutral' }
    ]
  },
  focus: stock,
  table: dataTable,
  heatmap,
  charts: [
    { variant: 'donut', title: 'Portfolio allocation', palette: 'violet',
      series: [{ points: [{ x: 'Equities', y: 58 }, { x: 'Bonds', y: 22 }, { x: 'Cash', y: 12 }, { x: 'Alt', y: 8 }] }] }
  ],
  news: [
    { title: 'Megacap tech leads broad rally as yields ease', url: 'https://example.com/x', source: 'MarketWire', publishedAt: new Date(Date.now() - 3600_000).toISOString() },
    { title: 'Energy outperforms on supply concerns', url: 'https://example.com/y', source: 'Reuters', publishedAt: new Date(Date.now() - 4 * 3600_000).toISOString() }
  ]
};

const mapArtifact: MapArtifact = {
  title: 'A short walk in Paris',
  markers: [
    { lat: 48.8584, lng: 2.2945, label: 'Eiffel Tower', description: 'Start' },
    { lat: 48.8606, lng: 2.3376, label: 'Louvre', description: 'Finish' }
  ],
  route: [
    { lat: 48.8584, lng: 2.2945 },
    { lat: 48.8606, lng: 2.3376 }
  ]
};

// The single source of truth for the gallery. Each entry that renders a typed
// artifact carries its `type`; gallery.coverage.test.ts asserts every artifact type
// the renderer supports appears here, so a new component can't ship without a demo.
//
// RULE: whenever you add a new artifact component/visual, add a demo entry here
// (with its `type`). The coverage test will fail until you do.
export interface GalleryDemo {
  title: string;
  /** The ChatArtifact `type` this demo covers, when it renders a typed artifact. */
  type?: string;
  /** Gallery section the demo is grouped under. */
  category?: GalleryCategory;
  node: React.ReactNode;
}

export type GalleryCategory =
  | 'Data & charts'
  | 'Finance'
  | 'News & knowledge'
  | 'World & media'
  | 'Travel & life'
  | 'Learning'
  | 'Agents & code';

const codeStudioDemo: CodeStudioArtifact = {
  title: 'Counter App',
  description: 'A simple React counter with increment, decrement, and reset.',
  template: 'react-ts',
  files: [
    {
      path: '/App.tsx',
      content: `import { useState } from 'react';
export default function App() {
  const [count, setCount] = useState(0);
  return (
    <div style={{ fontFamily: 'sans-serif', textAlign: 'center', padding: '2rem' }}>
      <h1>Counter: {count}</h1>
      <button onClick={() => setCount(c => c - 1)}>−</button>
      <button onClick={() => setCount(0)} style={{ margin: '0 0.5rem' }}>Reset</button>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}`,
      language: 'typescript'
    }
  ]
};

const recipeDemo: RecipeCardArtifact = {
  id: 'comic-concept-forge',
  title: 'Comic Concept Forge',
  description: 'Forge a complete comic concept: logline, world, a cast bible, and the first 6 beats.',
  builtin: true,
  agents: [],
  tools: [],
  swarm: false,
  parameters: [
    { key: 'premise', input_type: 'string', requirement: 'required', description: 'The core idea or what-if.' },
    { key: 'genre', input_type: 'string', requirement: 'optional', default: 'sci-fi' },
    { key: 'tone', input_type: 'select', requirement: 'optional', default: 'hopeful', options: ['hopeful', 'noir', 'epic', 'comedic'] }
  ],
  instructions: 'You are a senior comic showrunner. Develop a vivid, internally-consistent comic concept for: {{ premise }} ({{ genre }}, {{ tone }}). Build a logline, a setting bible, a 3–5 character cast with consistent visual signatures, and the first arc beats.',
  activities: ['Expand issue 1 into a script', 'Design a cover concept', 'Write character image prompts']
};

const recipeRunDemo: RecipeRunArtifact = {
  recipeId: 'deep-research-brief',
  title: 'Deep Research Brief',
  mode: 'swarm',
  status: 'done',
  params: [
    { key: 'topic', value: 'solid-state batteries' },
    { key: 'depth', value: 'standard' }
  ],
  structured: { score: 0.82, learnings: ['Lead with the bottom line', 'Cite primary sources with dates'] },
  activities: ['Turn this into a one-slide summary', 'Strongest counter-arguments?']
};

const researchReportDemo: ResearchReportArtifact = {
  topic: 'solid-state batteries',
  depth: 'exhaustive',
  audience: 'a busy executive',
  questions: [
    'What are solid-state batteries and how do they differ from Li-ion?',
    'Which companies and labs lead the field, and what are their timelines?',
    'What energy-density and safety gains do peer-reviewed results show?',
    'What manufacturing and cost barriers remain at scale?',
    'What is the realistic commercialization outlook for EVs by 2030?'
  ],
  sourceCount: 11,
  readCount: 8,
  sources: [
    { title: 'Solid-state battery — Wikipedia', url: 'https://en.wikipedia.org/wiki/Solid-state_battery' },
    { title: 'Toyota outlines solid-state roadmap', url: 'https://www.reuters.com/business/autos-transportation/' },
    { title: 'QuantumScape Q4 results and data', url: 'https://www.quantumscape.com/' },
    { title: 'Nature Energy: sulfide electrolyte advances', url: 'https://www.nature.com/nenergy/' }
  ]
};

// Agent-composed bespoke layout from the whitelisted block tree (reuses the existing
// barChart demo as an embedded chart block).
const generativeUiDemo: GenerativeUIArtifact = {
  title: 'Q3 performance — composed layout',
  subtitle: 'Agent-built from blocks · grid · metrics · chart · callout',
  palette: 'brand',
  accent: '#3B82F6',
  root: {
    kind: 'stack',
    gap: 3,
    children: [
      {
        kind: 'grid',
        columns: 3,
        gap: 2,
        children: [
          { kind: 'metric', label: 'Revenue', value: 1284000, unit: 'USD', deltaPercent: 12.4, spark: [9, 10, 11, 10, 12, 13, 14] },
          { kind: 'metric', label: 'Active users', value: 84230, delta: 5200, spark: [70, 72, 75, 78, 80, 82, 84] },
          { kind: 'metric', label: 'Churn', value: '2.1%', deltaPercent: -0.4 }
        ]
      },
      { kind: 'chart', chart: barChart },
      {
        kind: 'row',
        gap: 2,
        wrap: true,
        children: [
          { kind: 'badge', text: 'On track', tone: 'good' },
          { kind: 'badge', text: 'EU launch', tone: 'info' },
          { kind: 'pill', label: 'MoM', changePercent: 8.3 }
        ]
      },
      { kind: 'callout', tone: 'good', title: 'Takeaway', text: 'Revenue beat plan by 12%, driven by the EU launch; churn is down for the third straight month.' }
    ]
  }
};


// Glass dashboard demo — one widget of each major kind, realistic trip+study mix.
const dashboardDemo: DashboardArtifact = {
  title: 'Tokyo trip · launch week',
  subtitle: 'Flight, prep checklist, budget and countdown in one board — drag cards to rearrange.',
  widgets: [
    { id: 'w-clock', kind: 'clock', title: 'Time zones', size: 'md', timeZones: [{ label: 'New York', tz: 'America/New_York' }, { label: 'Tokyo', tz: 'Asia/Tokyo' }] },
    { id: 'w-count', kind: 'countdown', title: 'Departure', target: new Date(Date.now() + 9 * 86400e3 + 5 * 3600e3).toISOString() },
    { id: 'w-stat', kind: 'stat', title: 'Budget left', value: '$1,840', delta: -120, spark: [2400, 2300, 2240, 2100, 2050, 1960, 1840] },
    { id: 'w-globe', kind: 'globe', title: 'Flight path', size: 'md', globePoints: [{ label: 'JFK', lat: 40.64, lon: -73.78 }, { label: 'HND', lat: 35.55, lon: 139.78 }], globeArcs: [['JFK', 'HND']] },
    { id: 'w-prog', kind: 'progress', title: 'JLPT N5 prep', progress: { value: 34, max: 50, label: '34 of 50 lessons done' } },
    { id: 'w-list', kind: 'list', title: 'Before you fly', items: [{ text: 'Renew passport', done: true }, { text: 'Book Shinkansen seats', meta: 'Fri' }, { text: 'Travel insurance' }, { text: 'Download offline maps' }] },
    { id: 'w-chart', kind: 'chart', title: 'Yen per dollar (30d)', size: 'md', chartVariant: 'area', points: [{ x: 'May 12', y: 151.2 }, { x: 'May 19', y: 152.8 }, { x: 'May 26', y: 154.1 }, { x: 'Jun 2', y: 153.4 }, { x: 'Jun 9', y: 155.0 }] },
    { id: 'w-note', kind: 'note', title: 'Note', text: 'Hotel check-in after 3pm. Ghibli Museum tickets release on the 10th — set an alarm.' }
  ]
};

const learningPathDemo: LearningPathArtifact = {
  id: 'spanish-2-weeks',
  title: 'Spanish in 2 weeks — survival course',
  topic: 'Spanish',
  level: 'beginner',
  description: 'Daily 30-minute path from zero to ordering food, asking directions and small talk.',
  outcomes: ['Hold a 2-minute introduction', 'Order food and ask prices', 'Navigate a city in Spanish'],
  modules: [
    {
      id: 'm1',
      title: 'Sounds & survival phrases',
      summary: 'Pronunciation, greetings, numbers 1–20.',
      estMinutes: 90,
      steps: [
        { id: 'm1-s1', kind: 'read', title: 'How Spanish vowels work', content: 'Spanish has **5 pure vowel sounds** — a, e, i, o, u — always pronounced the same…', estMinutes: 10 },
        { id: 'm1-s2', kind: 'practice', title: 'Say the 10 survival phrases out loud', prompt: 'Drill me on 10 Spanish survival phrases with pronunciation tips.', estMinutes: 15 },
        { id: 'm1-s3', kind: 'quiz', title: 'Checkpoint: greetings & numbers', prompt: 'Quiz me on Spanish greetings and numbers 1–20.', estMinutes: 10 }
      ]
    },
    {
      id: 'm2',
      title: 'Ordering & paying',
      summary: 'Restaurant vocabulary, polite requests, money.',
      estMinutes: 120,
      steps: [
        { id: 'm2-s1', kind: 'read', title: 'The polite request pattern', content: 'Use **"Quisiera…"** (I would like…) — it works everywhere…', estMinutes: 10 },
        { id: 'm2-s2', kind: 'flashcards', title: 'Food vocabulary deck', prompt: 'Make me flashcards for the 30 most useful Spanish food words.', estMinutes: 20 },
        { id: 'm2-s3', kind: 'checkpoint', title: 'Role-play: order a full meal', prompt: 'Role-play a Madrid waiter; I will order a full meal in Spanish and you correct me.', estMinutes: 15 }
      ]
    }
  ],
  palette: 'violet'
};

const itineraryDemo: ItineraryArtifact = {
  title: 'Tokyo in 3 days',
  destination: 'Tokyo, Japan',
  startDate: '2026-07-10',
  endDate: '2026-07-12',
  travelers: 2,
  currency: 'USD',
  budget: { total: 1400, lines: [{ label: 'Hotel (2 nights)', amount: 520 }, { label: 'Food', amount: 360 }, { label: 'Transit & passes', amount: 120 }, { label: 'Tickets & museums', amount: 180 }] },
  days: [
    {
      label: 'Day 1 — Classic east side', date: '2026-07-10', summary: 'Land, drop bags, then Asakusa to the river and electric town.',
      stops: [
        { time: '06:55', name: 'SFO → HND', kind: 'flight', cost: 940, durationMin: 660, transport: { mode: 'flight', from: 'San Francisco (SFO)', to: 'Tokyo Haneda (HND)', carrier: 'ANA', code: 'NH 7', depart: '06:55', arrive: '11:25' } },
        { time: '12:10', name: 'Haneda → Asakusa', kind: 'train', cost: 6, durationMin: 45, transport: { mode: 'train', from: 'Haneda Airport', to: 'Asakusa Stn', carrier: 'Keikyū + Toei Asakusa Line', depart: '12:10', arrive: '12:55' } },
        { time: '14:00', name: 'Sensō-ji Temple', kind: 'sight', lat: 35.7148, lng: 139.7967, notes: 'Arrive mid-afternoon; Nakamise street for snacks.', durationMin: 90 },
        { time: '16:00', name: 'Ichiran Asakusa', kind: 'food', lat: 35.7115, lng: 139.7966, cost: 14, notes: 'Solo-booth tonkotsu ramen.' },
        { time: '18:30', name: 'Tokyo Skytree at sunset', kind: 'sight', lat: 35.7101, lng: 139.8107, cost: 21 }
      ]
    },
    {
      label: 'Day 2 — Shibuya & Harajuku', date: '2026-07-11', summary: 'Pop culture west side loop, evening bay cruise.',
      stops: [
        { time: '09:00', name: 'Asakusa → Hinode Pier', kind: 'ferry', cost: 8, durationMin: 40, transport: { mode: 'ferry', from: 'Asakusa', to: 'Hinode Pier', carrier: 'Tokyo Cruise Sumida line', depart: '09:00', arrive: '09:40' } },
        { time: '09:30', name: 'Meiji Jingu Shrine', kind: 'sight', lat: 35.6764, lng: 139.6993, durationMin: 90 },
        { time: '11:30', name: 'Takeshita Street', kind: 'shopping', lat: 35.6716, lng: 139.7031, notes: 'Crepes + vintage shops.' },
        { time: '15:00', name: 'Shibuya Crossing & Sky', kind: 'sight', lat: 35.6595, lng: 139.7005, cost: 18 },
        { time: '19:00', name: 'Omoide Yokocho izakaya crawl', kind: 'food', lat: 35.6938, lng: 139.6995, cost: 40 }
      ]
    }
  ],
  tips: ['Get a Suica card in Apple/Google Wallet before landing', 'Most small izakaya are cash-only', 'Trains stop ~midnight — plan the last leg'],
  packing: ['Compact umbrella (July showers)', 'Cash (¥20–30k)', 'Comfortable walking shoes'],
  weather: { description: 'Partly cloudy', tempC: 28, tempF: 82, daily: [{ date: '2026-07-10', minC: 24, maxC: 31, description: 'Humid, afternoon shower risk', precipProb: 40 }, { date: '2026-07-11', minC: 24, maxC: 30, description: 'Partly cloudy', precipProb: 20 }] },
  palette: 'ocean'
};

// ── Widget-platform demos: finance, travel and productivity cards. ─────────────

const tickerTapeDemo: TickerTapeArtifact = {
  title: 'Markets',
  asOf: '2026-06-10T14:30:00Z',
  items: [
    { symbol: '^GSPC', name: 'S&P 500', price: 6712.4, change: 38.2, changePercent: 0.57, currency: 'USD', spark: [6630, 6655, 6648, 6674, 6661, 6690, 6705, 6712] },
    { symbol: '^IXIC', name: 'Nasdaq Composite', price: 22418.9, change: -54.1, changePercent: -0.24, currency: 'USD', spark: [22510, 22460, 22490, 22440, 22473, 22431, 22405, 22419] },
    { symbol: 'GC=F', name: 'Gold', price: 3286.5, change: 21.7, changePercent: 0.66, currency: 'USD', spark: [3198, 3220, 3215, 3241, 3236, 3262, 3270, 3287] },
    { symbol: 'CL=F', name: 'Crude Oil (WTI)', price: 71.84, change: -1.12, changePercent: -1.53, currency: 'USD', spark: [74.5, 74.0, 73.2, 73.6, 72.8, 72.2, 72.9, 71.8] },
    { symbol: 'BTC-USD', name: 'Bitcoin', price: 118240, change: 2210, changePercent: 1.9, currency: 'USD', spark: [109800, 112400, 111200, 114800, 113600, 116100, 116030, 118240] },
    { symbol: 'EURUSD=X', name: 'EUR/USD', price: 1.1042, change: 0.0018, changePercent: 0.16, currency: 'USD', spark: [1.096, 1.098, 1.101, 1.099, 1.102, 1.1, 1.103, 1.104] }
  ]
};

const sentimentDemo: MarketSentimentArtifact = {
  asOf: '2026-06-10T14:30:00Z',
  gauges: [
    {
      market: 'stocks',
      score: 62,
      rating: 'greed',
      previous: [
        { label: '1 day ago', score: 58 },
        { label: '1 week ago', score: 49 },
        { label: '1 month ago', score: 41 }
      ],
      history: [38, 41, 39, 44, 47, 45, 49, 52, 50, 55, 58, 62],
      components: [
        { label: 'Market momentum', score: 71, rating: 'greed' },
        { label: 'Price strength', score: 64, rating: 'greed' },
        { label: 'Price breadth', score: 55, rating: 'neutral' },
        { label: 'Put/call options', score: 60, rating: 'greed' },
        { label: 'Volatility (VIX)', score: 48, rating: 'neutral' },
        { label: 'Safe haven demand', score: 67, rating: 'greed' }
      ]
    },
    {
      market: 'crypto',
      score: 54,
      rating: 'Neutral',
      previous: [
        { label: '1 day ago', score: 57 },
        { label: '1 week ago', score: 63 }
      ],
      history: [70, 68, 66, 61, 63, 59, 57, 60, 58, 55, 57, 54]
    }
  ],
  sources: [
    { name: 'CNN Fear & Greed', url: 'https://www.cnn.com/markets/fear-and-greed' },
    { name: 'alternative.me', url: 'https://alternative.me/crypto/fear-and-greed-index/' }
  ]
};

const yieldCurveDemo: YieldCurveArtifact = {
  latest: {
    date: '2026-06-09',
    points: [
      { label: '1M', years: 1 / 12, yieldPct: 4.32 },
      { label: '3M', years: 0.25, yieldPct: 4.24 },
      { label: '6M', years: 0.5, yieldPct: 4.1 },
      { label: '1Y', years: 1, yieldPct: 3.96 },
      { label: '2Y', years: 2, yieldPct: 3.84 },
      { label: '5Y', years: 5, yieldPct: 3.92 },
      { label: '7Y', years: 7, yieldPct: 4.04 },
      { label: '10Y', years: 10, yieldPct: 4.19 },
      { label: '20Y', years: 20, yieldPct: 4.52 },
      { label: '30Y', years: 30, yieldPct: 4.61 }
    ]
  },
  monthAgo: {
    date: '2026-05-08',
    points: [
      { label: '1M', years: 1 / 12, yieldPct: 4.36 },
      { label: '3M', years: 0.25, yieldPct: 4.31 },
      { label: '6M', years: 0.5, yieldPct: 4.2 },
      { label: '1Y', years: 1, yieldPct: 4.08 },
      { label: '2Y', years: 2, yieldPct: 3.97 },
      { label: '5Y', years: 5, yieldPct: 4.0 },
      { label: '7Y', years: 7, yieldPct: 4.1 },
      { label: '10Y', years: 10, yieldPct: 4.22 },
      { label: '20Y', years: 20, yieldPct: 4.5 },
      { label: '30Y', years: 30, yieldPct: 4.58 }
    ]
  },
  yearAgo: {
    date: '2025-06-09',
    points: [
      { label: '1M', years: 1 / 12, yieldPct: 5.12 },
      { label: '3M', years: 0.25, yieldPct: 5.08 },
      { label: '6M', years: 0.5, yieldPct: 4.95 },
      { label: '1Y', years: 1, yieldPct: 4.71 },
      { label: '2Y', years: 2, yieldPct: 4.48 },
      { label: '5Y', years: 5, yieldPct: 4.25 },
      { label: '7Y', years: 7, yieldPct: 4.27 },
      { label: '10Y', years: 10, yieldPct: 4.31 },
      { label: '20Y', years: 20, yieldPct: 4.56 },
      { label: '30Y', years: 30, yieldPct: 4.47 }
    ]
  },
  spread10y2y: 0.35,
  inverted: false
};

const portfolioDemo: PortfolioArtifact = {
  title: 'Growth portfolio',
  currency: 'USD',
  asOf: '2026-06-10T14:30:00Z',
  positions: [
    { symbol: 'NVDA', name: 'NVIDIA', shares: 24, costBasis: 96.5, price: 187.4, change: 4.1, changePercent: 2.24, value: 4497.6, dayPnl: 98.4, totalPnl: 2181.6, totalPnlPercent: 94.2, weightPct: 34.4, spark: [168, 172, 170, 176, 181, 178, 183, 187] },
    { symbol: 'AAPL', name: 'Apple', shares: 18, costBasis: 182.1, price: 224.7, change: -1.2, changePercent: -0.53, value: 4044.6, dayPnl: -21.6, totalPnl: 766.8, totalPnlPercent: 23.4, weightPct: 31.0, spark: [219, 221, 224, 222, 226, 225, 226, 225] },
    { symbol: 'VTI', name: 'Vanguard Total Market', shares: 10, costBasis: 248.0, price: 312.2, change: 1.7, changePercent: 0.55, value: 3122.0, dayPnl: 17.0, totalPnl: 642.0, totalPnlPercent: 25.9, weightPct: 23.9, spark: [302, 305, 304, 308, 306, 310, 311, 312] },
    { symbol: 'BTC-USD', name: 'Bitcoin', shares: 0.012, costBasis: 64200, price: 118240, change: 2210, changePercent: 1.9, value: 1418.9, dayPnl: 26.5, totalPnl: 648.5, totalPnlPercent: 84.2, weightPct: 10.8, spark: [109800, 112400, 111200, 114800, 113600, 116100, 116030, 118240] }
  ],
  totals: { value: 13083.1, dayPnl: 120.3, dayPnlPercent: 0.93, totalPnl: 4238.9, totalPnlPercent: 47.9 }
};

const whatsChangedDemo: WhatsChangedArtifact = {
  since: 'since yesterday',
  summary:
    'Chips led the session — NVDA broke out on the hyperscaler capex headlines while crude slid on the inventory build. Your earnings calendar gets busy Thursday.',
  changes: [
    { kind: 'price', title: 'NVDA +4.2% — broke above its May high', detail: 'Volume 1.8× the 30-day average.', deltaPercent: 4.2, weight: 3 },
    { kind: 'news', title: 'Hyperscalers guide AI capex up again', detail: 'Three outlets corroborate; bullish for accelerators.', weight: 3, url: 'https://news.google.com' },
    { kind: 'price', title: 'Crude oil −1.5% on a surprise inventory build', deltaPercent: -1.5, weight: 2 },
    { kind: 'event', title: 'AVGO earnings Thursday — implied move ±6%', weight: 2 },
    { kind: 'metric', title: '10Y−2Y spread steepened to +0.35 pp', detail: 'Third straight week of steepening.', delta: 0.04, weight: 1 }
  ]
};

const boardingPassDemo: BoardingPassArtifact = {
  airline: 'United',
  flightNumber: 'UA 2402',
  from: { code: 'SFO', city: 'San Francisco', time: '09:15', date: 'Jul 10', terminal: 'I' },
  to: { code: 'HND', city: 'Tokyo Haneda', time: '13:05 +1', date: 'Jul 11' },
  gate: 'G92',
  seat: '21A',
  boardingGroup: '2',
  boardingTime: '08:35',
  passenger: 'A. Traveler',
  status: 'on-time',
  confirmation: 'K8X2QF',
  fareClass: 'Economy Plus (W)',
  baggage: '1 checked · 1 carry-on',
  durationMin: 665,
  aircraft: 'Boeing 787-9',
  notes: ['Gate G92 is a 12-min walk from security — leave the lounge by 08:15', 'Mt. Fuji is on the LEFT side on this route'],
  accent: '#1414D2'
};

const currencyDemo: CurrencyConverterArtifact = {
  from: 'USD',
  to: 'JPY',
  rate: 146.82,
  amount: 500,
  converted: 73410,
  date: '2026-06-09',
  series: [
    { date: '2026-05-11', rate: 143.1 }, { date: '2026-05-13', rate: 143.8 }, { date: '2026-05-15', rate: 144.4 },
    { date: '2026-05-18', rate: 143.9 }, { date: '2026-05-20', rate: 144.8 }, { date: '2026-05-22', rate: 145.3 },
    { date: '2026-05-25', rate: 144.9 }, { date: '2026-05-27', rate: 145.6 }, { date: '2026-05-29', rate: 146.1 },
    { date: '2026-06-02', rate: 145.8 }, { date: '2026-06-04', rate: 146.4 }, { date: '2026-06-09', rate: 146.82 }
  ],
  avg30d: 145.2,
  vsAvgPct: 1.12
};

const worldClocksDemo: WorldClocksArtifact = {
  title: 'Home ↔ destination',
  zones: [
    { label: 'Home — San Francisco', tz: 'America/Los_Angeles' },
    { label: 'Tokyo', tz: 'Asia/Tokyo' }
  ]
};

const packingDemo: PackingListArtifact = {
  id: 'demo-packing-tokyo',
  title: 'Packing — 7 days in Japan',
  destination: 'Tokyo & Kyoto',
  context: '7 days · highs 29°C · rainy-season showers',
  groups: [
    { name: 'Clothing', items: ['Light rain shell', '5× breathable tees', 'Comfortable walking shoes', 'One smart-casual outfit'] },
    { name: 'Documents', items: ['Passport', 'Rail pass voucher', 'Travel insurance PDF'] },
    { name: 'Tech', items: ['Type-A plug adapter', 'Power bank', 'eSIM activated'] },
    { name: 'Extras', items: ['Compact umbrella', 'Coin purse (cash country!)', 'Hand towel'] }
  ],
  tips: ['Laundry machines are common in hotels — pack for 5 days, not 7', 'Konbini sell umbrellas everywhere if you forget one']
};

const tripCountdownDemo: TripCountdownArtifact = {
  destination: 'Kyoto, Japan',
  startDate: '2026-07-10T09:15:00',
  endDate: '2026-07-17',
  title: 'Summer trip',
  weather: {
    description: 'Partly cloudy',
    tempC: 28,
    daily: [
      { date: '2026-06-10', minC: 22, maxC: 29, description: 'Partly cloudy', precipProb: 20 },
      { date: '2026-06-11', minC: 23, maxC: 30, description: 'Humid, shower risk', precipProb: 55 },
      { date: '2026-06-12', minC: 22, maxC: 28, description: 'Light rain', precipProb: 70 },
      { date: '2026-06-13', minC: 21, maxC: 27, description: 'Clearing', precipProb: 30 },
      { date: '2026-06-14', minC: 22, maxC: 29, description: 'Sunny', precipProb: 10 }
    ]
  },
  checklist: [
    { text: 'Book Shinkansen seats', done: true },
    { text: 'Reserve Fushimi Inari sunrise slot', done: false },
    { text: 'Finish packing list', done: false }
  ],
  accent: '#0ea5e9'
};

const goalDemo: GoalTrackerArtifact = {
  id: 'demo-goal-10k',
  title: 'Run a 10k under 60 minutes',
  why: 'Energy, sleep, and a finish line on the calendar.',
  targetDate: '2026-10-04',
  cadence: '3 runs / week',
  metric: { label: 'Longest run', start: 3, target: 10, unit: 'km' },
  milestones: [
    { id: 'm1', title: 'Run 3 km without stopping', due: '2026-06-21' },
    { id: 'm2', title: 'Complete week 4 of the plan (4×/wk)', due: '2026-07-12' },
    { id: 'm3', title: 'Run 6 km at conversational pace', due: '2026-08-02', notes: 'If knees complain, swap one run for cycling.' },
    { id: 'm4', title: 'Run 8 km — long-run Sunday', due: '2026-08-30' },
    { id: 'm5', title: '10k race day 🏁', due: '2026-10-04' }
  ],
  nextActions: ['Schedule the three runs in your calendar tonight', 'Register for the October 4 race (early-bird closes June 20)']
};

const codeReviewDemo: CodeReviewArtifact = {
  title: 'Review: add retry logic to the fetcher',
  target: 'https://github.com/acme/fetcher/pull/482',
  verdict: 'request-changes',
  summary:
    'The retry wrapper is well structured and the tests cover the happy path, but the backoff loop can hammer the upstream on non-retryable errors and a secret leaks into the debug log.',
  scores: [
    { label: 'Correctness', score: 6 },
    { label: 'Security', score: 4 },
    { label: 'Readability', score: 8 },
    { label: 'Tests', score: 7 }
  ],
  stats: { files: 4, additions: 186, deletions: 42 },
  findings: [
    {
      severity: 'critical',
      title: 'API token logged on retry failure',
      detail: 'The full request config — including the Authorization header — is serialized into the warn log.',
      file: 'src/retry.ts',
      line: 58,
      suggestion: "log.warn('retry failed', { url: cfg.url, attempt }); // never log cfg.headers",
      category: 'security'
    },
    {
      severity: 'major',
      title: 'Retries fire on 4xx responses',
      detail: 'Only 408/429/5xx are worth retrying; a 401 will loop five times and mask the real error.',
      file: 'src/retry.ts',
      line: 31,
      suggestion: 'const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);\nif (!RETRYABLE.has(res.status)) throw new HttpError(res);',
      category: 'correctness'
    },
    {
      severity: 'minor',
      title: 'Backoff jitter is deterministic in tests but unseeded in prod',
      file: 'src/backoff.ts',
      line: 12,
      category: 'correctness'
    },
    { severity: 'nit', title: 'Prefer `const` for `attempt` accumulator via reduce', file: 'src/retry.ts', line: 44, category: 'style' }
  ],
  positives: ['Clean separation of backoff policy from the fetch wrapper', 'Table-driven tests make the retry matrix easy to extend']
};

const liveMonitorDemo: LiveMonitorArtifact = {
  label: 'AAPL · every 5 min',
  tool: 'get_stock',
  args: { symbol: 'AAPL' },
  intervalSec: 300,
  asOf: '2026-06-10T14:30:00Z',
  artifact: { type: 'stock_quote', data: stock, origin: { tool: 'get_stock', args: { symbol: 'AAPL' } } }
};

// ── Wave-2 widget demos: macro/calendar, travel ops and the smart stack. ────────

const macroTilesDemo: MacroTilesArtifact = {
  title: 'US macro at a glance',
  live: true,
  asOf: '2026-06-10T14:30:00Z',
  tiles: [
    { label: 'CPI (YoY)', seriesId: 'CPIAUCSL', value: 2.9, unit: '%', delta: -0.1, spark: [3.4, 3.3, 3.3, 3.2, 3.1, 3.1, 3.0, 2.9], nextRelease: '2026-06-11', source: 'FRED', asOf: '2026-05-31' },
    { label: 'Unemployment', seriesId: 'UNRATE', value: 4.1, unit: '%', delta: 0.1, spark: [3.8, 3.9, 3.9, 4.0, 4.0, 4.0, 4.1, 4.1], nextRelease: '2026-07-02', source: 'FRED', asOf: '2026-05-31' },
    { label: 'Fed funds (effective)', seriesId: 'FEDFUNDS', value: 3.83, unit: '%', delta: -0.25, spark: [4.58, 4.58, 4.33, 4.33, 4.08, 4.08, 3.83, 3.83], source: 'FRED', asOf: '2026-05-31' },
    { label: 'GDP (QoQ ann.)', seriesId: 'GDP', value: 2.4, unit: '%', delta: 0.3, spark: [1.6, 2.8, 3.0, 2.1, 1.9, 2.4], nextRelease: '2026-06-26', source: 'FRED', asOf: '2026-03-31' },
    { label: 'Payrolls (monthly Δ)', seriesId: 'PAYEMS', value: '+178K', delta: -22, spark: [256, 212, 190, 240, 200, 178], nextRelease: '2026-07-02', source: 'FRED' },
    { label: '30Y mortgage', seriesId: 'MORTGAGE30US', value: 6.12, unit: '%', delta: -0.08, spark: [6.7, 6.6, 6.5, 6.4, 6.3, 6.3, 6.2, 6.12], source: 'FRED', asOf: '2026-06-04' }
  ]
};

const econCalendarDemo: EconCalendarArtifact = {
  live: true,
  asOf: '2026-06-10T14:30:00Z',
  events: [
    { time: '2026-06-09T10:00:00', title: 'Wholesale inventories (MoM)', country: 'US', importance: 1, actual: 0.2, forecast: 0.1, previous: 0.1, unit: '%' },
    { time: '2026-06-10T08:30:00', title: 'CPI (YoY)', country: 'US', importance: 3, actual: 2.9, forecast: 3.0, previous: 3.1, unit: '%' },
    { time: '2026-06-11T14:00:00', title: 'FOMC rate decision', country: 'US', importance: 3, forecast: 4.0, previous: 4.0, unit: '%' },
    { time: '2026-06-12T08:30:00', title: 'PPI (MoM)', country: 'US', importance: 2, forecast: 0.2, previous: 0.3, unit: '%' },
    { time: '2026-06-13T10:00:00', title: 'UMich consumer sentiment', country: 'US', importance: 2, forecast: 72.5, previous: 71.8 },
    { time: '2026-06-16T05:00:00', title: 'ZEW economic sentiment', country: 'EU', importance: 2, forecast: 38.0, previous: 35.1 },
    { time: '2026-06-17T08:30:00', title: 'Retail sales (MoM)', country: 'US', importance: 3, forecast: 0.3, previous: -0.1, unit: '%' }
  ]
};

const earningsDemo: EarningsCalendarArtifact = {
  live: true,
  asOf: '2026-06-10T14:30:00Z',
  items: [
    { symbol: 'AVGO', name: 'Broadcom', date: '2026-06-09', session: 'after', epsEstimate: 1.85, epsActual: 1.92, impliedMovePct: 6.1, preview: 'Beat on AI networking strength.' },
    { symbol: 'ORCL', name: 'Oracle', date: '2026-06-11', session: 'after', epsEstimate: 1.62, impliedMovePct: 7.4, preview: 'Watch OCI growth rate and capex guide.' },
    { symbol: 'ADBE', name: 'Adobe', date: '2026-06-12', session: 'after', epsEstimate: 4.97, impliedMovePct: 5.2, preview: 'Firefly monetization vs seat growth.' },
    { symbol: 'LEN', name: 'Lennar', date: '2026-06-16', session: 'after', epsEstimate: 2.1, impliedMovePct: 4.0, preview: 'Margins under rate-buydown pressure.' },
    { symbol: 'KR', name: 'Kroger', date: '2026-06-18', session: 'pre', epsEstimate: 1.43, impliedMovePct: 3.5, preview: 'Grocery inflation pass-through read.' }
  ]
};

const centralBanksDemo: CentralBankWatchArtifact = {
  asOf: '2026-06-10T14:30:00Z',
  banks: [
    {
      name: 'Federal Reserve', code: 'Fed', rateName: 'Fed funds target (upper)', ratePct: 4.0,
      nextMeeting: '2026-06-11', lastChange: '−25 bps · Mar 2026',
      impliedPath: [{ label: 'Jun', ratePct: 4.0 }, { label: 'Sep', ratePct: 3.75 }, { label: 'Dec', ratePct: 3.5 }],
      summary: 'Powell: "policy is well positioned" — cuts contingent on shelter disinflation holding.'
    },
    {
      name: 'European Central Bank', code: 'ECB', rateName: 'Deposit facility', ratePct: 2.15,
      nextMeeting: '2026-07-23', lastChange: '−25 bps · Apr 2026',
      impliedPath: [{ label: 'Jul', ratePct: 2.15 }, { label: 'Oct', ratePct: 2.0 }, { label: 'Jan', ratePct: 2.0 }],
      summary: 'Lagarde signals a pause; wage growth cooling faster than staff projections.'
    },
    {
      name: 'Bank of Japan', code: 'BoJ', rateName: 'Policy rate', ratePct: 0.75,
      nextMeeting: '2026-06-16', lastChange: '+25 bps · Jan 2026',
      impliedPath: [{ label: 'Jun', ratePct: 0.75 }, { label: 'Sep', ratePct: 1.0 }],
      summary: 'Ueda keeps the hiking door open as shunto wage gains broaden.'
    }
  ]
};

// Deterministic ~14 weeks of trading-day P&L (weekends skipped).
const pnlDemo: PnlCalendarArtifact = {
  title: 'Daily P&L',
  currency: 'USD',
  days: Array.from({ length: 98 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 2, 2 + i)); // from Mar 2, 2026
    const day = d.getUTCDay();
    if (day === 0 || day === 6) return null;
    const value = Math.round(Math.sin(i * 1.7) * 420 + Math.cos(i * 0.9) * 180);
    return { date: d.toISOString().slice(0, 10), value };
  }).filter((d): d is { date: string; value: number } => d !== null)
};

const debtDemo: DebtClockArtifact = {
  label: 'US national debt',
  amount: 37_214_582_113_402,
  asOf: '2026-06-09',
  perSecond: 48_950,
  previous: { date: '2026-06-08', amount: 37_210_352_833_120 },
  source: 'US Treasury · Debt to the Penny'
};

const flightDemo: FlightStatusArtifact = {
  airline: 'United',
  flightNumber: 'UA2402',
  status: 'active',
  departure: { code: 'SFO', city: 'San Francisco', scheduled: '2026-06-10T09:15:00', actual: '2026-06-10T09:32:00', terminal: 'I', gate: 'G92' },
  arrival: { code: 'HND', city: 'Tokyo Haneda', scheduled: '2026-06-11T13:05:00', estimated: '2026-06-11T13:18:00', terminal: '3' },
  progressPct: 62,
  altitudeM: 10_600,
  speedKmh: 905,
  delayMin: 17,
  live: true,
  asOf: '2026-06-10T14:30:00Z'
};

const tripBudgetDemo: TripBudgetArtifact = {
  title: 'Japan trip budget',
  currency: 'USD',
  total: 3000,
  spent: 1240,
  startDate: '2026-06-06',
  endDate: '2026-06-16',
  categories: [
    { label: 'Food', spent: 420, budget: 600 },
    { label: 'Stay', spent: 520, budget: 1200 },
    { label: 'Transport', spent: 180, budget: 400 },
    { label: 'Fun & shopping', spent: 120, budget: 500 }
  ]
};

const cheatsheetDemo: LocalCheatsheetArtifact = {
  destination: 'Tokyo',
  language: 'Japanese',
  currency: 'JPY (¥)',
  police: '110',
  ambulance: '119',
  tipping: 'Not customary — refusing change can cause confusion; never tip at restaurants',
  plug: 'Type A / B',
  voltage: '100V · 50/60Hz',
  cashNorm: 'Cash-heavy: many izakaya and shrines are card-free; load a Suica for transit',
  tapWater: 'Safe to drink',
  phrases: [
    { local: 'すみません', meaning: 'Excuse me / sorry', say: 'soo-mee-mah-sen' },
    { local: 'ありがとうございます', meaning: 'Thank you (polite)', say: 'ah-ree-gah-toh go-zai-mas' },
    { local: '英語を話せますか？', meaning: 'Do you speak English?', say: 'ay-go o ha-nah-seh-mas-ka' },
    { local: 'お会計お願いします', meaning: 'The bill, please', say: 'o-kai-kay o-neh-gai-shi-mas' }
  ],
  warnings: ['Ignore street touts in Kabukichō offering "free" bar guides', 'Taxis are honest but expensive — trains beat them until midnight'],
  etiquette: ['Stand left on Tokyo escalators (right in Osaka)', 'No phone calls on trains; set your phone to manner mode', 'Carry your trash — public bins are rare']
};

const loyaltyDemo: LoyaltyWalletArtifact = {
  title: 'Your programs',
  cards: [
    {
      program: 'United MileagePlus', member: 'A. Traveler', number: '1234', points: 84_200, pointsLabel: 'miles',
      tier: 'Gold', tierProgress: { value: 8200, max: 12_000, nextTier: 'Platinum' }, accent: '#1414D2',
      note: 'Enough for a one-way SFO→HND saver — 24k miles on the July dates.'
    },
    {
      program: 'Marriott Bonvoy', member: 'A. Traveler', number: '5678', points: 61_500, pointsLabel: 'points',
      tier: 'Platinum', tierProgress: { value: 38, max: 75, nextTier: 'Titanium' }, accent: '#b45309',
      note: 'Kyoto Mon–Thu runs 38k/night — book with points, pay cash on the weekend.'
    },
    { program: 'JR East', points: 3_180, pointsLabel: 'points', tier: 'Basic', accent: '#0f766e', expiry: '2027-03-31' }
  ]
};

const widgetStackDemo: WidgetStackArtifact = {
  label: 'Morning glance',
  intervalSec: 8,
  items: [
    { type: 'stock_quote', data: stock, origin: { tool: 'get_stock', args: { symbol: 'AAPL' } } },
    { type: 'currency_converter', data: currencyDemo, origin: { tool: 'convert_currency', args: { from: 'USD', to: 'JPY' } } },
    { type: 'debt_clock', data: debtDemo, origin: { tool: 'get_national_debt', args: {} } }
  ]
};

export const GALLERY_DEMOS: GalleryDemo[] = [
  { title: 'Guided learning path (modules · tracked progress · practice prompts)', type: 'learning_path', category: 'Learning', node: <LearningPathCard data={learningPathDemo} /> },
  { title: 'Travel itinerary (day tabs · map · budget · live weather)', type: 'itinerary', category: 'World & media', node: <ItineraryCard data={itineraryDemo} /> },
  { title: 'Weather station (animated · gauges · map)', type: 'weather', category: 'World & media', node: <WeatherStation data={weather} /> },
  { title: 'Market card (hover · range timeline · candlesticks)', type: 'stock_quote', category: 'Finance', node: <MarketCard data={stock} /> },
  { title: 'News digest (compact · source-branded · snippets)', type: 'news_results', category: 'News & knowledge', node: <NewsDigest data={news} /> },
  { title: 'Places (local) card', type: 'places_results', category: 'World & media', node: <PlacesResults data={places} /> },
  { title: 'Map (markers · route)', type: 'map', category: 'World & media', node: <MapArtifactCard data={mapArtifact} /> },
  { title: 'Video results', type: 'video_results', category: 'World & media', node: <VideoResults data={videos} /> },
  { title: 'Agent swarm trace', type: 'swarm_trace', category: 'Agents & code', node: <SwarmTraceCard data={swarm} /> },
  { title: 'Chart — grouped bars (legend · hover)', type: 'chart', category: 'Data & charts', node: <ChartCard data={barChart} /> },
  { title: 'Chart — donut', category: 'Data & charts', node: <ChartCard data={donutChart} /> },
  { title: 'Metric board (KPIs · sparklines · rings)', type: 'metric_board', category: 'Data & charts', node: <MetricBoard data={board} /> },
  { title: 'Data table (typed cells · sortable · sparklines)', type: 'data_table', category: 'Data & charts', node: <DataTableCard data={dataTable} /> },
  { title: 'Generative UI (agent-composed layout · grid · metrics · chart · callout)', type: 'generative_ui', category: 'Data & charts', node: <GenerativeUICard data={generativeUiDemo} /> },
  { title: 'Glass dashboard (drag-drop widgets · clock · countdown · globe · chart · checklist)', type: 'dashboard', category: 'Data & charts', node: <DashboardCard data={dashboardDemo} /> },
  { title: 'Market heatmap (sectors · cap-weighted tiles)', type: 'market_heatmap', category: 'Finance', node: <HeatmapCard data={heatmap} /> },
  { title: 'Finance Terminal (composite: quote · KPIs · table · heatmap · news)', type: 'finance_terminal', category: 'Finance', node: <FinanceTerminal data={terminal} /> },
  { title: 'Code Studio card (multi-file app · live preview)', type: 'code_studio', category: 'Agents & code', node: <CodeStudioCard data={codeStudioDemo} /> },
  { title: 'Recipe card (reusable agent workflow · params · tools)', type: 'recipe_card', category: 'Agents & code', node: <RecipeCard data={recipeDemo} /> },
  { title: 'Recipe run (params · structured output · follow-ups)', type: 'recipe_run', category: 'Agents & code', node: <RecipeRunCard data={recipeRunDemo} /> },
  { title: 'Research report (questions · sources read · grounded brief header)', type: 'research_report', category: 'News & knowledge', node: <ResearchReport data={researchReportDemo} /> },
  { title: 'Quiz (MCQ · multi-select · true/false · short answer · self-grading)', type: 'quiz', category: 'Learning', node: <Quiz data={quizDemo} /> },
  { title: 'Document (custom resource · download .md / .html / PDF)', type: 'document', category: 'News & knowledge', node: <DocumentCard data={documentDemo} /> },
  { title: 'Flashcards (flip · known/review · shuffle · progress)', type: 'flashcards', category: 'Learning', node: <Flashcards data={flashcardsDemo} /> },
  { title: 'SQL playground (real sandboxed execution · results · errors)', type: 'sql_exercise', category: 'Learning', node: <SqlPlayground data={sqlExerciseDemo} /> },
  { title: 'Code playground (run real JS · console + errors)', type: 'code_exercise', category: 'Learning', node: <CodePlayground data={codeExerciseDemo} /> },
  { title: 'Code playground — Python (Pyodide · real tracebacks)', type: 'code_exercise', category: 'Learning', node: <CodePlayground data={pythonExerciseDemo} /> },
  { title: 'Resource bundle (per-file download + all as .zip)', type: 'resource_bundle', category: 'News & knowledge', node: <ResourceBundle data={resourceBundleDemo} /> },
  { title: 'Markdown table (inline)', category: 'Data & charts', node: <ChatMarkdown text={tableMd} /> },
  { title: 'Ticker tape (live scrolling market strip · pause on hover)', type: 'ticker_tape', category: 'Finance', node: <TickerTape data={tickerTapeDemo} /> },
  { title: 'Fear & Greed (live sentiment gauges · components · history)', type: 'market_sentiment', category: 'Finance', node: <MarketSentiment data={sentimentDemo} /> },
  { title: 'Yield curve (morphs today ↔ 1M ↔ 1Y ago · inversion flag)', type: 'yield_curve', category: 'Finance', node: <YieldCurveCard data={yieldCurveDemo} /> },
  { title: 'Portfolio (live-priced · allocation donut · P&L)', type: 'portfolio', category: 'Finance', node: <PortfolioCard data={portfolioDemo} /> },
  { title: 'What changed (agent changelog · weighted · deltas)', type: 'whats_changed', category: 'News & knowledge', node: <WhatsChangedCard data={whatsChangedDemo} /> },
  { title: 'Boarding pass (flip card · status glow · QR)', type: 'boarding_pass', category: 'Travel & life', node: <BoardingPass data={boardingPassDemo} /> },
  { title: 'Currency converter (live ECB rate · 30-day verdict)', type: 'currency_converter', category: 'Travel & life', node: <CurrencyConverter data={currencyDemo} /> },
  { title: 'World clocks (ticking · sleep shading · call window)', type: 'world_clocks', category: 'Travel & life', node: <WorldClocks data={worldClocksDemo} /> },
  { title: 'Packing list (check-off · saved progress · tips)', type: 'packing_list', category: 'Travel & life', node: <PackingListCard data={packingDemo} /> },
  { title: 'Trip countdown (live D/H/M/S · weather strip · prep list)', type: 'trip_countdown', category: 'Travel & life', node: <TripCountdown data={tripCountdownDemo} /> },
  { title: 'Goal tracker (/goal · milestones · saved progress)', type: 'goal_tracker', category: 'Travel & life', node: <GoalTracker data={goalDemo} /> },
  { title: 'Code review (/code-review · verdict · findings · fixes)', type: 'code_review', category: 'Agents & code', node: <CodeReviewCard data={codeReviewDemo} /> },
  { title: 'Live monitor (/loop · auto-refreshing wrapped widget)', type: 'live_monitor', category: 'Agents & code', node: <LiveMonitorCard data={liveMonitorDemo} renderEmbedded={renderArtifactNode} /> },
  { title: 'Macro tiles (FRED-live indicators · release countdowns)', type: 'macro_tiles', category: 'Finance', node: <MacroTiles data={macroTilesDemo} /> },
  { title: 'Economic calendar (timeline · importance · beat/miss)', type: 'econ_calendar', category: 'Finance', node: <EconCalendar data={econCalendarDemo} /> },
  { title: 'Earnings countdown (carousel · implied move · previews)', type: 'earnings_calendar', category: 'Finance', node: <EarningsCountdown data={earningsDemo} /> },
  { title: 'Central bank watch (rates · meeting countdowns · implied path)', type: 'central_bank_watch', category: 'Finance', node: <CentralBankWatch data={centralBanksDemo} /> },
  { title: 'National debt clock (live odometer · $/second drift)', type: 'debt_clock', category: 'Finance', node: <DebtClock data={debtDemo} /> },
  { title: 'Calendar heatmap (daily P&L · win rate · best/worst)', type: 'pnl_calendar', category: 'Data & charts', node: <PnlCalendar data={pnlDemo} /> },
  { title: 'Flight tracker (route arc · live progress · delays)', type: 'flight_status', category: 'Travel & life', node: <FlightStatus data={flightDemo} /> },
  { title: 'Trip budget burn (fuel gauge · pace verdict · categories)', type: 'trip_budget', category: 'Travel & life', node: <TripBudget data={tripBudgetDemo} /> },
  { title: 'Destination cheat-sheet (emergency · plugs · phrases · scams)', type: 'local_cheatsheet', category: 'Travel & life', node: <LocalCheatsheet data={cheatsheetDemo} /> },
  { title: 'Loyalty wallet (stacked cards · tier progress · redemption tips)', type: 'loyalty_wallet', category: 'Travel & life', node: <LoyaltyWallet data={loyaltyDemo} /> },
  { title: 'Smart stack (auto-rotating live cards · per-card refresh)', type: 'widget_stack', category: 'Agents & code', node: <WidgetStack data={widgetStackDemo} renderEmbedded={renderArtifactNode} /> }
];

/** Artifact types that have a live demo in the gallery (used by the coverage test). */
export const GALLERY_DEMO_TYPES: string[] = GALLERY_DEMOS.filter((d) => d.type).map((d) => d.type as string);

const CATEGORY_ORDER: GalleryCategory[] = [
  'Data & charts',
  'Finance',
  'News & knowledge',
  'World & media',
  'Travel & life',
  'Learning',
  'Agents & code'
];

// The live component library: every widget in both of its versions. The segmented
// control switches the whole gallery between the compact (glance) and detailed
// (expansive) builds, rendered through the same WidgetFrame the chat uses.
export const ComponentGallery: React.FC = () => {
  const [density, setDensity] = React.useState<'compact' | 'detailed'>('detailed');
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--ds-muted)]">
          Every rich-output widget, live with sample data. Each one ships in two versions — a compact glance card and a
          detailed expansive view — and is resizable in chat.
        </p>
        <div className="inline-flex shrink-0 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
          {(['compact', 'detailed'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDensity(d)}
              aria-pressed={density === d}
              className={`rounded-md px-2.5 py-1 capitalize transition-all duration-200 ${
                density === d ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      {CATEGORY_ORDER.map((cat) => {
        const demos = GALLERY_DEMOS.filter((d) => (d.category ?? 'Data & charts') === cat);
        if (demos.length === 0) return null;
        return (
          <section key={cat}>
            <h3 className="mb-2 border-b border-[var(--ds-hairline-soft)] pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
              {cat}
            </h3>
            <div className="space-y-4">
              {demos.map((d) => (
                <div key={d.title}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-muted)]">
                    <span className="truncate">{d.title}</span>
                    {d.type && (
                      <code className="shrink-0 rounded bg-[var(--ds-well-strong)] px-1 py-px text-[10px] text-[var(--ds-muted)]">{d.type}</code>
                    )}
                  </div>
                  {d.type ? (
                    <WidgetFrame
                      type={d.type}
                      densityAware={DENSITY_AWARE_TYPES.has(d.type)}
                      forcedDensity={density}
                    >
                      {d.node}
                    </WidgetFrame>
                  ) : (
                    d.node
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
