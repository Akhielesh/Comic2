// Stock & index quotes. PRIMARY source is Yahoo Finance's public, keyless chart +
// quote endpoints, which give a real range timeline (intraday 1D through multi-year),
// 52-week range, volume, exchange/currency, fundamentals (market cap, P/E, dividend —
// best-effort via the crumb flow), related peers and recent headlines — everything the
// MarketCard renders. Stooq (CSV) remains a dependency-free FALLBACK for the core quote
// if Yahoo is unavailable.
//
// All upstreams are public and not runtime-verifiable in the build sandbox; every
// enrichment is wrapped so failures degrade to a still-useful quote, never throw.

import type {
  StockQuoteArtifact,
  StockPoint,
  StockCandle,
  StockRange,
  StockStats,
  StockPeer,
  MarketState,
  NewsItem
} from '../../../../apiTypes.js';
import { fetchNews } from './news.js';

const QUOTE_URL = 'https://stooq.com/q/l/';
const HISTORY_URL = 'https://stooq.com/q/d/l/';
const YF_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_SUMMARY = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';
const YF_RECO = 'https://query1.finance.yahoo.com/v6/finance/recommendationsbysymbol';
const YF_CRUMB = 'https://query2.finance.yahoo.com/v1/test/getcrumb';
const DEFAULT_TIMEOUT_MS = 9_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------------------------------------------------------------- Stooq (fallback) ---

// Stooq expects a market suffix; plain alphabetic tickers are assumed US equities.
export const normalizeSymbol = (raw: string): string => {
  const s = raw.trim().toLowerCase();
  if (!s) return s;
  if (s.startsWith('^') || s.includes('.')) return s;
  if (/^[a-z]{1,5}$/.test(s)) return `${s}.us`;
  return s;
};

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export interface StooqQuote {
  symbol: string;
  name?: string;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

export const parseStooqQuoteCsv = (csv: string): StooqQuote | null => {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const row = lines[1].split(',');
  const get = (key: string): string => {
    const i = header.indexOf(key);
    return i >= 0 ? (row[i] || '').trim() : '';
  };
  const close = num(get('close'));
  if (close === undefined || get('close').toUpperCase() === 'N/D') return null;
  return {
    symbol: get('symbol').toUpperCase(),
    name: get('name') || undefined,
    date: get('date') || undefined,
    open: num(get('open')),
    high: num(get('high')),
    low: num(get('low')),
    close,
    volume: num(get('volume'))
  };
};

export const parseStooqHistoryCsv = (csv: string, limit = 30): StockPoint[] => {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const di = header.indexOf('date');
  const ci = header.indexOf('close');
  if (di < 0 || ci < 0) return [];
  const points: StockPoint[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const close = num((cols[ci] || '').trim());
    const date = (cols[di] || '').trim();
    if (close !== undefined && date) points.push({ date, close });
  }
  return points.slice(-limit);
};

// ----------------------------------------------------------------------- helpers -----

const yyyymmdd = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

// Yahoo uses raw tickers (AAPL, ^GSPC). Strip any Stooq ".us" suffix; keep ^/dots.
const yahooSymbol = (raw: string): string => raw.trim().replace(/\.us$/i, '').toUpperCase();

const withTimeout = (signal?: AbortSignal, ms = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) };
};

const fetchJson = async <T>(url: string, signal?: AbortSignal, cookie?: string): Promise<T> => {
  const t = withTimeout(signal);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
      signal: t.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    t.done();
  }
};

const fetchText = async (url: string, signal?: AbortSignal): Promise<string> => {
  const t = withTimeout(signal);
  try {
    const res = await fetch(url, { headers: { Accept: 'text/csv,text/plain', 'User-Agent': UA }, signal: t.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    t.done();
  }
};

const MARKET_STATE: Record<string, MarketState> = { PRE: 'pre', REGULAR: 'open', POST: 'after', POSTPOST: 'closed', PREPRE: 'pre', CLOSED: 'closed' };

interface YfChart {
  meta: Record<string, unknown>;
  points: StockPoint[];
  candles: StockCandle[];
}

// Fetch one Yahoo chart window → closing series + OHLC candles + raw meta.
const yfChart = async (symbol: string, range: string, interval: string, signal?: AbortSignal): Promise<YfChart> => {
  const url = `${YF_CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const data = await fetchJson<any>(url, signal);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('No chart data');
  const meta = (r.meta || {}) as Record<string, unknown>;
  const ts: number[] = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const points: StockPoint[] = [];
  const candles: StockCandle[] = [];
  const intraday = /m$/.test(interval); // minute intervals → label with time, else date
  for (let i = 0; i < ts.length; i++) {
    const close = num(q.close?.[i]);
    if (close === undefined) continue;
    const d = new Date(ts[i] * 1000);
    const label = intraday ? d.toISOString() : d.toISOString().slice(0, 10);
    points.push({ date: label, close });
    const o = num(q.open?.[i]);
    const h = num(q.high?.[i]);
    const l = num(q.low?.[i]);
    if (o !== undefined && h !== undefined && l !== undefined) candles.push({ date: label, open: o, high: h, low: l, close });
  }
  return { meta, points, candles };
};

const sliceTail = (pts: StockPoint[], n: number): StockPoint[] => (pts.length > n ? pts.slice(-n) : pts);

// Best-effort fundamentals via Yahoo quoteSummary (needs a crumb + cookie). Any
// failure (consent walls, missing crumb) silently yields no stats.
const yfFundamentals = async (symbol: string, signal?: AbortSignal): Promise<StockStats | undefined> => {
  try {
    // 1) get a session cookie, 2) exchange it for a crumb, 3) call quoteSummary.
    const t = withTimeout(signal, 6_000);
    let cookie = '';
    try {
      const res = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, signal: t.signal });
      const sc = (res.headers as any).getSetCookie?.() as string[] | undefined;
      cookie = (sc && sc.length ? sc : [res.headers.get('set-cookie') || '']).map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    } catch {
      /* ignore */
    } finally {
      t.done();
    }
    if (!cookie) return undefined;
    const crumb = (await (await fetch(YF_CRUMB, { headers: { 'User-Agent': UA, Cookie: cookie } })).text()).trim();
    if (!crumb || crumb.includes('<')) return undefined;
    const url = `${YF_SUMMARY}/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,price&crumb=${encodeURIComponent(crumb)}`;
    const data = await fetchJson<any>(url, signal, cookie);
    const r = data?.quoteSummary?.result?.[0];
    if (!r) return undefined;
    const sd = r.summaryDetail || {};
    const ks = r.defaultKeyStatistics || {};
    const pr = r.price || {};
    const raw = (o: any): number | undefined => num(o?.raw);
    const stats: StockStats = {
      marketCap: raw(pr.marketCap) ?? raw(sd.marketCap),
      peRatio: raw(sd.trailingPE),
      week52High: raw(sd.fiftyTwoWeekHigh),
      week52Low: raw(sd.fiftyTwoWeekLow),
      dividendYield: raw(sd.dividendYield) !== undefined ? raw(sd.dividendYield)! * 100 : undefined,
      avgVolume: raw(sd.averageVolume) ?? raw(sd.averageDailyVolume3Month),
      eps: raw(ks.trailingEps),
      beta: raw(sd.beta) ?? raw(ks.beta)
    };
    return Object.values(stats).some((v) => v !== undefined) ? stats : undefined;
  } catch {
    return undefined;
  }
};

// Best-effort related/peer companies (keyless), each with a light quote.
const yfRelated = async (symbol: string, signal?: AbortSignal): Promise<StockPeer[] | undefined> => {
  try {
    const data = await fetchJson<any>(`${YF_RECO}/${encodeURIComponent(symbol)}`, signal);
    const recs: any[] = data?.finance?.result?.[0]?.recommendedSymbols || [];
    const symbols = recs.map((x) => String(x?.symbol || '')).filter(Boolean).slice(0, 4);
    if (!symbols.length) return undefined;
    const peers = await Promise.allSettled(
      symbols.map(async (sym): Promise<StockPeer> => {
        const { meta } = await yfChart(sym, '1d', '1d', signal);
        const price = num(meta.regularMarketPrice);
        const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);
        const changePercent = price !== undefined && prev ? ((price - prev) / prev) * 100 : undefined;
        return {
          symbol: sym,
          name: (typeof meta.shortName === 'string' && meta.shortName) || (typeof meta.longName === 'string' ? (meta.longName as string) : undefined),
          price,
          changePercent,
          currency: typeof meta.currency === 'string' ? meta.currency : undefined
        };
      })
    );
    const out = peers.filter((p): p is PromiseFulfilledResult<StockPeer> => p.status === 'fulfilled' && p.value.price !== undefined).map((p) => p.value);
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
};

const yfHeadlines = async (name: string, signal?: AbortSignal): Promise<NewsItem[] | undefined> => {
  try {
    const news = await fetchNews({ query: `${name} stock` }, signal, 3);
    return news.items.length ? news.items : undefined;
  } catch {
    return undefined;
  }
};

// Assemble a rich quote from Yahoo. Throws if the core chart calls all fail (caller
// then falls back to Stooq).
const getYahooQuote = async (rawSymbol: string, signal?: AbortSignal): Promise<StockQuoteArtifact> => {
  const symbol = yahooSymbol(rawSymbol);

  // Core windows: intraday (1D) for the live tick + meta, ~5y daily for the mid
  // ranges + candles, monthly max for the long view. Parallel, best-effort each.
  const [intradayR, dailyR, maxR] = await Promise.allSettled([
    yfChart(symbol, '1d', '2m', signal),
    yfChart(symbol, '5y', '1d', signal),
    yfChart(symbol, 'max', '1mo', signal)
  ]);

  const intraday = intradayR.status === 'fulfilled' ? intradayR.value : undefined;
  const daily = dailyR.status === 'fulfilled' ? dailyR.value : undefined;
  const max = maxR.status === 'fulfilled' ? maxR.value : undefined;
  const primary = intraday || daily || max;
  if (!primary) throw new Error('Yahoo chart unavailable');
  const meta = primary.meta;

  const price = num(meta.regularMarketPrice) ?? daily?.points.at(-1)?.close;
  if (price === undefined) throw new Error('No price');
  const prevClose = num(meta.chartPreviousClose) ?? num(meta.previousClose) ?? daily?.points.at(-2)?.close;
  const change = prevClose !== undefined ? price - prevClose : 0;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  const dailyPts = daily?.points ?? [];
  const ranges: Partial<Record<StockRange, StockPoint[]>> = {};
  if (intraday && intraday.points.length > 1) ranges['1D'] = intraday.points;
  if (dailyPts.length > 1) {
    ranges['5D'] = sliceTail(dailyPts, 5);
    ranges['1M'] = sliceTail(dailyPts, 22);
    ranges['6M'] = sliceTail(dailyPts, 126);
    ranges['1Y'] = sliceTail(dailyPts, 252);
    ranges['5Y'] = dailyPts;
  }
  if (max && max.points.length > 1) ranges['MAX'] = max.points;

  const stats: StockStats = {
    week52High: num(meta.fiftyTwoWeekHigh),
    week52Low: num(meta.fiftyTwoWeekLow)
  };

  const name =
    (typeof meta.longName === 'string' && meta.longName) ||
    (typeof meta.shortName === 'string' ? (meta.shortName as string) : undefined) ||
    symbol;
  const exchange =
    (typeof meta.fullExchangeName === 'string' && meta.fullExchangeName) ||
    (typeof meta.exchangeName === 'string' ? (meta.exchangeName as string) : undefined);
  const marketState = typeof meta.marketState === 'string' ? MARKET_STATE[meta.marketState as string] : undefined;
  const asOf = num(meta.regularMarketTime) ? new Date((meta.regularMarketTime as number) * 1000).toISOString().slice(0, 10) : undefined;

  // Enrichments — parallel, each degrades to undefined.
  const [fund, related, headlines] = await Promise.allSettled([
    yfFundamentals(symbol, signal),
    yfRelated(symbol, signal),
    yfHeadlines(name, signal)
  ]);
  const fundStats = fund.status === 'fulfilled' ? fund.value : undefined;
  const mergedStats: StockStats = { ...stats, ...(fundStats || {}) };

  // Candlesticks from the daily series (~60 most recent sessions).
  const candles: StockCandle[] | undefined = daily && daily.candles.length > 1 ? daily.candles.slice(-60) : undefined;

  return {
    symbol,
    name,
    price,
    change,
    changePercent,
    open: num(meta.regularMarketOpen) ?? num(intraday?.candles?.[0]?.open) ?? num(daily?.candles.at(-1)?.open),
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    previousClose: prevClose,
    asOf,
    currency: typeof meta.currency === 'string' ? meta.currency : undefined,
    exchange,
    marketState,
    series: dailyPts.length ? sliceTail(dailyPts, 30) : intraday?.points,
    ranges: Object.keys(ranges).length ? ranges : undefined,
    candles,
    stats: Object.values(mergedStats).some((v) => v !== undefined) ? mergedStats : undefined,
    headlines: headlines.status === 'fulfilled' ? headlines.value : undefined,
    related: related.status === 'fulfilled' ? related.value : undefined
  };
};

// Stooq fallback: basic quote + ~30-session sparkline (no fundamentals/peers).
const getStooqQuote = async (rawSymbol: string, signal?: AbortSignal): Promise<StockQuoteArtifact> => {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) throw new Error('No ticker symbol was provided.');
  const quoteCsv = await fetchText(`${QUOTE_URL}?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcvn&h&e=csv`, signal);
  const quote = parseStooqQuoteCsv(quoteCsv);
  if (!quote || quote.close === undefined) throw new Error(`No quote found for "${rawSymbol}".`);

  let series: StockPoint[] = [];
  try {
    const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const histCsv = await fetchText(
      `${HISTORY_URL}?s=${encodeURIComponent(symbol)}&d1=${yyyymmdd(since)}&d2=${yyyymmdd(new Date())}&i=d`,
      signal
    );
    series = parseStooqHistoryCsv(histCsv, 30);
  } catch {
    /* sparkline is optional */
  }

  const price = quote.close;
  const previousClose = series.length >= 2 ? series[series.length - 2].close : quote.open;
  const change = typeof previousClose === 'number' ? price - previousClose : 0;
  const changePercent = typeof previousClose === 'number' && previousClose !== 0 ? (change / previousClose) * 100 : 0;
  return {
    symbol: quote.symbol,
    name: quote.name,
    price,
    change,
    changePercent,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    previousClose: typeof previousClose === 'number' ? previousClose : undefined,
    asOf: quote.date,
    series: series.length ? series : undefined
  };
};

export const getStockQuote = async (rawSymbol: string, signal?: AbortSignal): Promise<StockQuoteArtifact> => {
  const trimmed = rawSymbol?.trim();
  if (!trimmed) throw new Error('No ticker symbol was provided.');
  try {
    return await getYahooQuote(trimmed, signal);
  } catch {
    // Yahoo blocked/unavailable — fall back to the keyless Stooq quote.
    return await getStooqQuote(trimmed, signal);
  }
};

/** A trimmed quote for building watchlists/heatmaps where the full enrichment
 * (fundamentals, peers, headlines) would be too slow across many symbols. */
export interface LightQuote {
  symbol: string;
  name?: string;
  price: number;
  change: number;
  changePercent: number;
  currency?: string;
  /** ~20–30 recent closes for a sparkline. */
  spark?: number[];
}

// Fast quote: one intraday window (live tick + meta) + one month of daily closes
// for a spark. Degrades to the Stooq quote if Yahoo is blocked. Never throws on a
// recoverable gap — callers Promise.allSettled across a watchlist.
export const getLightQuote = async (rawSymbol: string, signal?: AbortSignal): Promise<LightQuote> => {
  const trimmed = rawSymbol?.trim();
  if (!trimmed) throw new Error('No ticker symbol was provided.');
  const symbol = yahooSymbol(trimmed);
  try {
    const [intradayR, monthR] = await Promise.allSettled([
      yfChart(symbol, '1d', '5m', signal),
      yfChart(symbol, '1mo', '1d', signal)
    ]);
    const intraday = intradayR.status === 'fulfilled' ? intradayR.value : undefined;
    const month = monthR.status === 'fulfilled' ? monthR.value : undefined;
    const primary = intraday || month;
    if (!primary) throw new Error('No chart data');
    const meta = primary.meta;
    const price = num(meta.regularMarketPrice) ?? month?.points.at(-1)?.close ?? intraday?.points.at(-1)?.close;
    if (price === undefined) throw new Error('No price');
    const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose) ?? month?.points.at(-2)?.close;
    const change = prev !== undefined ? price - prev : 0;
    const changePercent = prev ? (change / prev) * 100 : 0;
    const name =
      (typeof meta.shortName === 'string' && meta.shortName) ||
      (typeof meta.longName === 'string' ? (meta.longName as string) : undefined) ||
      symbol;
    const spark = (month?.points ?? intraday?.points ?? []).map((p) => p.close).slice(-30);
    return { symbol, name, price, change, changePercent, currency: typeof meta.currency === 'string' ? meta.currency : undefined, spark: spark.length > 1 ? spark : undefined };
  } catch {
    const q = await getStooqQuote(trimmed, signal);
    return {
      symbol: q.symbol,
      name: q.name,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      currency: q.currency,
      spark: q.series && q.series.length > 1 ? q.series.map((p) => p.close) : undefined
    };
  }
};
