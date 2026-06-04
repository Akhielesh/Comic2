import React from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { WeatherCard } from './artifacts/WeatherCard';
import { NewsCard } from './artifacts/NewsCard';
import { StockCard } from './artifacts/StockCard';
import { VideoResults } from './artifacts/VideoResults';
import { PlacesResults } from './artifacts/PlacesResults';
import { SwarmTraceCard } from './artifacts/SwarmTraceCard';
import type {
  WeatherArtifact, NewsResultsArtifact, StockQuoteArtifact,
  VideoResultsArtifact, PlacesResultsArtifact, SwarmTraceArtifact
} from '../../apiTypes';

// A living gallery of the chat's rich-output components, each with sample data, so
// the UI library can be seen and sanity-checked in one place.

const weather: WeatherArtifact = {
  location: 'New York, NY',
  current: { tempC: 22, tempF: 72, feelsLikeC: 23, code: 2, description: 'Partly cloudy', windKph: 12, humidity: 54, uvIndex: 5, precipProb: 10, isDay: true },
  hourly: Array.from({ length: 12 }, (_, i) => ({ time: new Date(Date.now() + i * 3600_000).toISOString(), tempC: 22 - i * 0.4, code: i % 3, precipProb: i * 4 })),
  daily: Array.from({ length: 5 }, (_, i) => ({ date: new Date(Date.now() + i * 86400_000).toISOString(), minC: 14 + i, maxC: 24 + i, code: [0, 2, 61, 3, 1][i], description: 'Sample', precipProb: i * 10, uvMax: 6, sunrise: new Date().toISOString(), sunset: new Date().toISOString() })),
  airQuality: { usAqi: 42, pm25: 9, category: 'Good' },
  pollen: { grass: 12, tree: 30, weed: 5, level: 'Moderate' }
};

const news: NewsResultsArtifact = {
  query: 'AI', items: [
    { title: 'A breakthrough model ships with agentic tools', url: 'https://example.com/1', source: 'TechDaily', publishedAt: new Date(Date.now() - 3600_000).toISOString(), snippet: 'The release adds parallel tool use and…' },
    { title: 'Open models close the gap on closed ones', url: 'https://example.com/2', source: 'Wire', publishedAt: new Date(Date.now() - 7200_000).toISOString() }
  ]
};

const stock: StockQuoteArtifact = {
  symbol: 'AAPL', name: 'Apple Inc.', price: 204.2, change: 2.8, changePercent: 1.39, open: 201.5, high: 205.1, low: 199.8, volume: 51_000_000, previousClose: 201.4, asOf: '2026-06-03',
  series: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, close: 190 + Math.sin(i / 3) * 6 + i * 0.4 }))
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

const tableMd = `| Model | Context | Free |
|---|---|---|
| Sonnet 4.6 | 200K | No |
| Llama 3.1 8B | 128K | Yes |
| Gemini Flash | 1M | Partial |`;

const Item: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div className="text-[11px] font-bold uppercase text-slate-500 mb-1">{title}</div>
    {children}
  </div>
);

export const ComponentGallery: React.FC = () => (
  <div className="space-y-4">
    <p className="text-sm text-slate-600">Every rich-output component rendered with sample data — the live UI library.</p>
    <Item title="Weather card"><WeatherCard data={weather} /></Item>
    <Item title="Stock card"><StockCard data={stock} /></Item>
    <Item title="News card"><NewsCard data={news} /></Item>
    <Item title="Places (local) card"><PlacesResults data={places} /></Item>
    <Item title="Video results"><VideoResults data={videos} /></Item>
    <Item title="Agent swarm trace"><SwarmTraceCard data={swarm} /></Item>
    <Item title="Interactive table (sort + search)"><ChatMarkdown text={tableMd} /></Item>
  </div>
);
