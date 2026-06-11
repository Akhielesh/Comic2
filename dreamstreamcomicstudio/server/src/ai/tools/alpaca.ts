// US equity quotes via Alpaca Market Data (free Basic plan, IEX feed, ~200 req/min).
// Alpaca is the cleanest free real-time US equities source for end-user display
// (markets itself for "display data" in trading apps — verify display rights in your
// data agreement before relying on it for compliance). When ALPACA_API_KEY_ID +
// ALPACA_API_SECRET_KEY are set, stocks.ts prefers this path for plain US tickers so
// the live price no longer rides on unofficial Yahoo endpoints. IEX covers US
// stocks/ETFs only — indices, futures, FX and non-US listings stay on the old chain.

import type { StockQuoteArtifact, StockPoint, StockCandle, StockRange } from '../../../../apiTypes.js';

const DATA_BASE = 'https://data.alpaca.markets/v2/stocks';
const TIMEOUT_MS = 9_000;

export const alpacaEnabled = (): boolean =>
  Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);

/** Plain US-equity-looking ticker (AAPL, BRK.B is excluded — IEX wants plain). */
export const isAlpacaSymbol = (symbol: string): boolean => /^[A-Za-z]{1,5}$/.test(symbol.trim());

const fetchJson = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || ''
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Alpaca ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

interface AlpacaBar { t: string; o: number; h: number; l: number; c: number; v: number }
interface AlpacaSnapshot {
  latestTrade?: { p?: number; t?: string };
  dailyBar?: AlpacaBar;
  prevDailyBar?: AlpacaBar;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const toPoints = (bars: AlpacaBar[], intraday: boolean): { points: StockPoint[]; candles: StockCandle[] } => {
  const points: StockPoint[] = [];
  const candles: StockCandle[] = [];
  for (const b of bars) {
    const close = num(b.c);
    if (close === undefined) continue;
    const date = intraday ? b.t : b.t.slice(0, 10);
    points.push({ date, close });
    if (num(b.o) !== undefined && num(b.h) !== undefined && num(b.l) !== undefined)
      candles.push({ date, open: b.o, high: b.h, low: b.l, close });
  }
  return { points, candles };
};

const sliceTail = (pts: StockPoint[], n: number): StockPoint[] => (pts.length > n ? pts.slice(-n) : pts);

/** Quote + range timeline from Alpaca IEX. Throws on any failure (caller falls back). */
export const getAlpacaQuote = async (rawSymbol: string, signal?: AbortSignal): Promise<StockQuoteArtifact> => {
  const symbol = rawSymbol.trim().toUpperCase();
  const yearAgo = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date(new Date().toISOString().slice(0, 10)).toISOString();

  const [snapR, dailyR, intradayR] = await Promise.allSettled([
    fetchJson<AlpacaSnapshot>(`${DATA_BASE}/${encodeURIComponent(symbol)}/snapshot?feed=iex`, signal),
    fetchJson<{ bars?: AlpacaBar[] }>(
      `${DATA_BASE}/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${encodeURIComponent(yearAgo)}&limit=400&adjustment=split&feed=iex`,
      signal
    ),
    fetchJson<{ bars?: AlpacaBar[] }>(
      `${DATA_BASE}/${encodeURIComponent(symbol)}/bars?timeframe=5Min&start=${encodeURIComponent(todayStart)}&limit=200&feed=iex`,
      signal
    )
  ]);

  const snap = snapR.status === 'fulfilled' ? snapR.value : undefined;
  const dailyBars = dailyR.status === 'fulfilled' ? dailyR.value.bars || [] : [];
  const intradayBars = intradayR.status === 'fulfilled' ? intradayR.value.bars || [] : [];

  const daily = toPoints(dailyBars, false);
  const intra = toPoints(intradayBars, true);

  const price = num(snap?.latestTrade?.p) ?? num(snap?.dailyBar?.c) ?? daily.points.at(-1)?.close;
  if (price === undefined) throw new Error('No Alpaca price');
  const prevClose = num(snap?.prevDailyBar?.c) ?? daily.points.at(-2)?.close;
  const change = prevClose !== undefined ? price - prevClose : 0;
  const changePercent = prevClose ? (change / prevClose) * 100 : 0;

  const ranges: Partial<Record<StockRange, StockPoint[]>> = {};
  if (intra.points.length > 1) ranges['1D'] = intra.points;
  if (daily.points.length > 1) {
    ranges['5D'] = sliceTail(daily.points, 5);
    ranges['1M'] = sliceTail(daily.points, 22);
    ranges['6M'] = sliceTail(daily.points, 126);
    ranges['1Y'] = daily.points;
  }

  const closes = daily.points.map((p) => p.close);
  const stats =
    closes.length > 10 ? { week52High: Math.max(...closes), week52Low: Math.min(...closes) } : undefined;

  return {
    symbol,
    price,
    change,
    changePercent,
    open: num(snap?.dailyBar?.o),
    high: num(snap?.dailyBar?.h),
    low: num(snap?.dailyBar?.l),
    volume: num(snap?.dailyBar?.v),
    previousClose: prevClose,
    asOf: snap?.latestTrade?.t ? snap.latestTrade.t.slice(0, 10) : undefined,
    currency: 'USD',
    exchange: 'IEX (Alpaca)',
    series: sliceTail(daily.points, 30),
    ranges: Object.keys(ranges).length ? ranges : undefined,
    candles: daily.candles.length > 1 ? daily.candles.slice(-60) : undefined,
    stats
  };
};
