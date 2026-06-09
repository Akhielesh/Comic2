import React from 'react';
import { ChatMarkdown } from './ChatMarkdown';
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
import type {
  WeatherArtifact, NewsResultsArtifact, StockQuoteArtifact,
  VideoResultsArtifact, PlacesResultsArtifact, SwarmTraceArtifact,
  ChartArtifact, MetricBoardArtifact, MapArtifact,
  DataTableArtifact, HeatmapArtifact, FinanceTerminalArtifact, CodeStudioArtifact,
  RecipeCardArtifact, RecipeRunArtifact, ResearchReportArtifact, QuizArtifact, DocumentArtifact, FlashcardsArtifact, SqlExerciseArtifact, ResourceBundleArtifact, CodeExerciseArtifact
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
  node: React.ReactNode;
}

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

export const GALLERY_DEMOS: GalleryDemo[] = [
  { title: 'Weather station (animated · gauges · map)', type: 'weather', node: <WeatherStation data={weather} /> },
  { title: 'Market card (hover · range timeline · candlesticks)', type: 'stock_quote', node: <MarketCard data={stock} /> },
  { title: 'News digest (compact · source-branded · snippets)', type: 'news_results', node: <NewsDigest data={news} /> },
  { title: 'Places (local) card', type: 'places_results', node: <PlacesResults data={places} /> },
  { title: 'Map (markers · route)', type: 'map', node: <MapArtifactCard data={mapArtifact} /> },
  { title: 'Video results', type: 'video_results', node: <VideoResults data={videos} /> },
  { title: 'Agent swarm trace', type: 'swarm_trace', node: <SwarmTraceCard data={swarm} /> },
  { title: 'Chart — grouped bars (legend · hover)', type: 'chart', node: <ChartCard data={barChart} /> },
  { title: 'Chart — donut', node: <ChartCard data={donutChart} /> },
  { title: 'Metric board (KPIs · sparklines · rings)', type: 'metric_board', node: <MetricBoard data={board} /> },
  { title: 'Data table (typed cells · sortable · sparklines)', type: 'data_table', node: <DataTableCard data={dataTable} /> },
  { title: 'Market heatmap (sectors · cap-weighted tiles)', type: 'market_heatmap', node: <HeatmapCard data={heatmap} /> },
  { title: 'Finance Terminal (composite: quote · KPIs · table · heatmap · news)', type: 'finance_terminal', node: <FinanceTerminal data={terminal} /> },
  { title: 'Code Studio card (multi-file app · live preview)', type: 'code_studio', node: <CodeStudioCard data={codeStudioDemo} /> },
  { title: 'Recipe card (reusable agent workflow · params · tools)', type: 'recipe_card', node: <RecipeCard data={recipeDemo} /> },
  { title: 'Recipe run (params · structured output · follow-ups)', type: 'recipe_run', node: <RecipeRunCard data={recipeRunDemo} /> },
  { title: 'Research report (questions · sources read · grounded brief header)', type: 'research_report', node: <ResearchReport data={researchReportDemo} /> },
  { title: 'Quiz (MCQ · multi-select · true/false · short answer · self-grading)', type: 'quiz', node: <Quiz data={quizDemo} /> },
  { title: 'Document (custom resource · download .md / .html / PDF)', type: 'document', node: <DocumentCard data={documentDemo} /> },
  { title: 'Flashcards (flip · known/review · shuffle · progress)', type: 'flashcards', node: <Flashcards data={flashcardsDemo} /> },
  { title: 'SQL playground (real sandboxed execution · results · errors)', type: 'sql_exercise', node: <SqlPlayground data={sqlExerciseDemo} /> },
  { title: 'Code playground (run real JS · console + errors)', type: 'code_exercise', node: <CodePlayground data={codeExerciseDemo} /> },
  { title: 'Resource bundle (per-file download + all as .zip)', type: 'resource_bundle', node: <ResourceBundle data={resourceBundleDemo} /> },
  { title: 'Markdown table (inline)', node: <ChatMarkdown text={tableMd} /> }
];

/** Artifact types that have a live demo in the gallery (used by the coverage test). */
export const GALLERY_DEMO_TYPES: string[] = GALLERY_DEMOS.filter((d) => d.type).map((d) => d.type as string);

export const ComponentGallery: React.FC = () => (
  <div className="space-y-4">
    <p className="text-sm text-slate-600">Every rich-output component rendered with sample data — the live UI library.</p>
    {GALLERY_DEMOS.map((d) => (
      <div key={d.title}>
        <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">{d.title}</div>
        {d.node}
      </div>
    ))}
  </div>
);
