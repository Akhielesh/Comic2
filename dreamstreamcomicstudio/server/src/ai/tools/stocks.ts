// Stock & index quotes via Stooq — free, keyless, CSV. Returns a current quote
// plus ~30 sessions of closing prices for a sparkline, as a StockQuoteArtifact the
// client renders as a card with an SVG chart (no charting dependency needed).
//
// Public endpoint — not runtime-verifiable in the sandbox; the CSV parsers are pure
// + unit-tested and all network failures degrade to a clear message.

import type { StockQuoteArtifact, StockPoint } from '../../../../apiTypes.js';

const QUOTE_URL = 'https://stooq.com/q/l/';
const HISTORY_URL = 'https://stooq.com/q/d/l/';
const DEFAULT_TIMEOUT_MS = 10_000;

// Stooq expects a market suffix; plain alphabetic tickers are assumed US equities.
// Indices (^SPX) and already-suffixed symbols (BTC.V, EURUSD) pass through.
export const normalizeSymbol = (raw: string): string => {
  const s = raw.trim().toLowerCase();
  if (!s) return s;
  if (s.startsWith('^') || s.includes('.')) return s;
  if (/^[a-z]{1,5}$/.test(s)) return `${s}.us`;
  return s;
};

const num = (v: string): number | undefined => {
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

// Parse a Stooq quote CSV (header: Symbol,Date,Time,Open,High,Low,Close,Volume,Name).
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
  // Stooq returns "N/D" for unknown symbols.
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

// Parse a Stooq daily history CSV (Date,Open,High,Low,Close,Volume) → closing series.
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

const fetchText = async (url: string, signal: AbortSignal): Promise<string> => {
  const res = await fetch(url, { headers: { Accept: 'text/csv,text/plain' }, signal });
  if (!res.ok) throw new Error(`Stooq returned ${res.status}`);
  return res.text();
};

const yyyymmdd = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

export const getStockQuote = async (
  rawSymbol: string,
  signal?: AbortSignal
): Promise<StockQuoteArtifact> => {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) throw new Error('No ticker symbol was provided.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const quoteCsv = await fetchText(
      `${QUOTE_URL}?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcvn&h&e=csv`,
      controller.signal
    );
    const quote = parseStooqQuoteCsv(quoteCsv);
    if (!quote || quote.close === undefined) throw new Error(`No quote found for "${rawSymbol}".`);

    // ~45 calendar days of history for a ~30-session sparkline (best-effort).
    let series: StockPoint[] = [];
    try {
      const since = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const histCsv = await fetchText(
        `${HISTORY_URL}?s=${encodeURIComponent(symbol)}&d1=${yyyymmdd(since)}&d2=${yyyymmdd(new Date())}&i=d`,
        controller.signal
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
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};
