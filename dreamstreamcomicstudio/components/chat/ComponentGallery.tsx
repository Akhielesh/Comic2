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
import type {
  WeatherArtifact, NewsResultsArtifact, StockQuoteArtifact,
  VideoResultsArtifact, PlacesResultsArtifact, SwarmTraceArtifact,
  ChartArtifact, MetricBoardArtifact
} from '../../apiTypes';

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

const stock: StockQuoteArtifact = {
  symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', marketState: 'open',
  price: 204.2, change: 2.8, changePercent: 1.39, open: 201.5, high: 205.1, low: 199.8,
  volume: 51_000_000, previousClose: 201.4, asOf: '2026-06-03',
  series: toSeries(maxVals.slice(-30)),
  ranges: {
    '1W': toSeries(maxVals.slice(-5)),
    '1M': toSeries(maxVals.slice(-22)),
    '3M': toSeries(maxVals.slice(-66)),
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
    { id: 'tech', name: 'Tech Reporter', task: 'Latest tech news', status: 'done', summary: 'Found 3 major releases…', toolEvents: [{ tool: 'get_news', query: 'tech', ok: true }] },
    { id: 'finance', name: 'Markets Analyst', task: 'Market summary', status: 'done', summary: 'Indices up 0.8%…', toolEvents: [{ tool: 'get_stock', ok: true }] },
    { id: 'research', name: 'Web Researcher', task: 'Context', status: 'running' }
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

const Item: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">{title}</div>
    {children}
  </div>
);

export const ComponentGallery: React.FC = () => (
  <div className="space-y-4">
    <p className="text-sm text-slate-600">Every rich-output component rendered with sample data — the live UI library.</p>
    <Item title="Weather station (animated · gauges · map)"><WeatherStation data={weather} /></Item>
    <Item title="Market card (hover · range timeline · candlesticks)"><MarketCard data={stock} /></Item>
    <Item title="News digest (lead · source filter · favicons)"><NewsDigest data={news} /></Item>
    <Item title="Places (local) card"><PlacesResults data={places} /></Item>
    <Item title="Video results"><VideoResults data={videos} /></Item>
    <Item title="Agent swarm trace"><SwarmTraceCard data={swarm} /></Item>
    <Item title="Chart — grouped bars (legend · hover)"><ChartCard data={barChart} /></Item>
    <Item title="Chart — donut"><ChartCard data={donutChart} /></Item>
    <Item title="Metric board (KPIs · sparklines · rings)"><MetricBoard data={board} /></Item>
    <Item title="Interactive data table"><ChatMarkdown text={tableMd} /></Item>
  </div>
);
