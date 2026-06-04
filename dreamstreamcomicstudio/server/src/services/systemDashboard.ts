// System dashboard data — live, honest, no vendor tokens required for this slice.
//
// - Tool health: pings each upstream tool API and reports up/down + latency.
// - Dependencies: documented free-tier limits for every platform dependency, plus a
//   `connected` flag + envVar so the UI shows exactly what to add for LIVE vendor
//   usage (Railway/Cloudflare/Supabase). Live numbers light up once those tokens
//   exist; until then we're upfront that they're not connected.
// - Rate limits: the actual configured request limits.

import type { ToolHealth, DependencyInfo } from '../../../apiTypes.js';
import {
  RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_TEXT_MAX_REQUESTS,
  RATE_LIMIT_IMAGE_MAX_REQUESTS, FOURSQUARE_API_KEY
} from '../config.js';

const PING_TIMEOUT_MS = 5_000;

const ping = async (id: string, label: string, url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<ToolHealth> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { method, signal: controller.signal, headers: { 'User-Agent': 'DreamStream/health' } });
    return { id, label, ok: res.ok, latencyMs: Date.now() - started, status: res.status };
  } catch (err) {
    return { id, label, ok: false, error: (err as Error)?.message || 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
};

/** Live-ping every upstream tool API in parallel. */
export const pingTools = async (): Promise<ToolHealth[]> =>
  Promise.all([
    ping('open-meteo', 'Weather (Open-Meteo)', 'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m'),
    ping('overpass', 'Places (OSM Overpass)', 'https://overpass-api.de/api/status'),
    ping('nominatim', 'Geocoding (Nominatim)', 'https://nominatim.openstreetmap.org/status.php'),
    ping('stooq', 'Stocks (Stooq)', 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'),
    ping('google-news', 'News (Google News)', 'https://news.google.com/rss', 'HEAD'),
    ping('duckduckgo', 'Search (DuckDuckGo)', 'https://duckduckgo.com/', 'HEAD'),
    ...(FOURSQUARE_API_KEY ? [ping('foursquare', 'Places (Foursquare)', 'https://places-api.foursquare.com/places/search?ll=0,0&limit=1')] : [])
  ]);

const env = (name: string): boolean => Boolean(process.env[name]);

/** Documented dependency limits + which have live metrics connected. */
export const dependencyInfo = (): DependencyInfo[] => [
  {
    id: 'railway', label: 'Railway (backend host)',
    freeTier: 'Trial/Hobby: limited execution hours + $5 usage credit/mo; sleeps when idle on free.',
    connected: env('RAILWAY_API_TOKEN'), envVar: 'RAILWAY_API_TOKEN',
    docsUrl: 'https://docs.railway.com/reference/pricing'
  },
  {
    id: 'cloudflare', label: 'Cloudflare Pages (frontend)',
    freeTier: 'Free: 500 builds/mo, unlimited requests/bandwidth, 100k Functions req/day.',
    connected: env('CLOUDFLARE_API_TOKEN'), envVar: 'CLOUDFLARE_API_TOKEN',
    docsUrl: 'https://developers.cloudflare.com/pages/platform/limits/'
  },
  {
    id: 'supabase', label: 'Supabase (DB / auth / storage)',
    freeTier: 'Free: 500MB DB, 1GB storage, 50k MAU, pauses after 7 days inactivity.',
    connected: env('SUPABASE_SERVICE_ROLE_KEY'), envVar: 'SUPABASE_SERVICE_ROLE_KEY',
    docsUrl: 'https://supabase.com/pricing'
  },
  {
    id: 'openrouter', label: 'OpenRouter (models)',
    freeTier: 'Free models: rate-limited (≈20 req/min, daily cap); paid models billed per token.',
    connected: env('OPENROUTER_API_KEY'), envVar: 'OPENROUTER_API_KEY',
    docsUrl: 'https://openrouter.ai/docs/limits'
  },
  {
    id: 'foursquare', label: 'Foursquare Places',
    freeTier: 'Free tier: generous monthly Places API call allowance.',
    connected: Boolean(FOURSQUARE_API_KEY), envVar: 'FOURSQUARE_API_KEY',
    docsUrl: 'https://docs.foursquare.com/'
  },
  { id: 'open-meteo', label: 'Open-Meteo (weather)', freeTier: 'Free, no key: ~10k calls/day fair use.', connected: true, docsUrl: 'https://open-meteo.com/en/terms' },
  { id: 'overpass', label: 'OSM Overpass (places)', freeTier: 'Free, no key: fair-use, shared public instance.', connected: true, docsUrl: 'https://dev.overpass-api.de/' },
  { id: 'stooq', label: 'Stooq (stocks)', freeTier: 'Free, no key: fair-use CSV.', connected: true },
  { id: 'google-news', label: 'Google News RSS', freeTier: 'Free, no key: public RSS.', connected: true }
];

export const rateLimitSummary = (): { scope: string; perWindow: number; windowMs: number }[] => [
  { scope: 'general', perWindow: RATE_LIMIT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
  { scope: 'text/chat', perWindow: RATE_LIMIT_TEXT_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS },
  { scope: 'image', perWindow: RATE_LIMIT_IMAGE_MAX_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS }
];
