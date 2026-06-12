// Live finance widget tools — the server half of the finance widget set (ticker
// tape, fear & greed, yield curve, live-priced portfolio, currency converter).
// Every figure comes from a live, keyless source at call time, so all of these are
// refresh-whitelisted (REFRESHABLE_TOOLS): the client can re-run the exact call to
// update the widget in place, and a live_monitor can loop it on an interval.
//
// Sources (all public, no key):
//  - quotes:      Yahoo Finance / Stooq via getLightQuote (stocks.ts)
//  - sentiment:   CNN Fear & Greed (stocks) + alternative.me (crypto)
//  - yield curve: US Treasury daily par-yield XML feed
//  - FX:          Frankfurter (ECB reference rates)

import type { ChatTool } from './types.js';
import type {
  TickerTapeArtifact,
  MarketSentimentArtifact,
  SentimentGauge,
  YieldCurveArtifact,
  YieldCurvePoint,
  YieldCurveSnapshot,
  PortfolioArtifact,
  PortfolioPosition,
  CurrencyConverterArtifact
} from '../../../../apiTypes.js';
import { getLightQuote } from './stocks.js';
import { fetchJson, fetchText } from './http.js';
import { TtlCache } from '../../lib/cache.js';

const MAX_SYMBOLS = 12;

const strArg = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Accept symbols as an array OR a comma/space separated string (models do both). */
const symbolList = (v: unknown): string[] => {
  const raw = Array.isArray(v)
    ? v.map((s) => String(s))
    : typeof v === 'string'
      ? v.split(/[,\s]+/)
      : [];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_SYMBOLS);
};

// ------------------------------------------------------------------ ticker tape ---

const DEFAULT_TAPE = ['^GSPC', '^IXIC', '^DJI', 'GC=F', 'CL=F', 'BTC-USD', 'EURUSD=X'];

export const tickerTapeTool: ChatTool = {
  name: 'get_ticker_tape',
  description:
    'Build a LIVE multi-asset ticker tape — a scrolling market strip of quotes (price, day change, sparkline) for a set of symbols. Use it when the user wants several prices at a glance ("how are markets doing", a watchlist strip, "my tickers"), as the moving-headline companion to a dashboard. Pass tickers or plain names ("gold", "S&P 500", "bitcoin"); omit symbols for a default market tape (indices, gold, oil, BTC, EURUSD). For ONE asset in depth use get_stock instead.',
  parameters: {
    type: 'object',
    properties: {
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tickers or asset names, e.g. ["AAPL", "gold", "BTC-USD"]. Omit for the default market tape.'
      },
      title: { type: 'string', description: 'Optional strip label, e.g. "My watchlist".' }
    }
  },
  execute: async (args, signal) => {
    const symbols = symbolList(args?.symbols);
    const want = symbols.length ? symbols : DEFAULT_TAPE;
    const settled = await Promise.allSettled(want.map((s) => getLightQuote(s, signal)));
    const items = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getLightQuote>>> => r.status === 'fulfilled')
      .map((r) => r.value);
    if (!items.length) {
      return {
        content: 'Could not fetch live quotes for the ticker tape right now. No card was shown — tell the user market data is temporarily unavailable; do NOT invent prices.',
        notice: { level: 'error' as const, message: 'Live quotes unavailable for the ticker tape.' }
      };
    }
    const failed = want.length - items.length;
    const data: TickerTapeArtifact = {
      title: strArg(args?.title),
      items,
      asOf: new Date().toISOString()
    };
    const line = items.map((i) => `${i.symbol} ${i.price.toFixed(2)} (${i.changePercent >= 0 ? '+' : ''}${i.changePercent.toFixed(2)}%)`).join(' · ');
    return {
      content: `Live ticker tape (${items.length} assets${failed ? `, ${failed} unavailable` : ''}): ${line}. A scrolling market strip is shown to the user — add one short read on the day, not a restatement.`,
      artifacts: [{ type: 'ticker_tape', data }],
      ...(failed ? { notice: { level: 'info' as const, message: `${failed} symbol(s) could not be quoted and were dropped from the tape.` } } : {})
    };
  }
};

// ------------------------------------------------------------- market sentiment ---

const CNN_FNG = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const ALT_FNG = 'https://api.alternative.me/fng/?limit=30';

// CNN blocks generic agents; a desktop UA keeps this public endpoint readable.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

interface CnnIndicator {
  score?: number;
  rating?: string;
}
interface CnnGraphData {
  fear_and_greed?: {
    score?: number;
    rating?: string;
    previous_close?: number;
    previous_1_week?: number;
    previous_1_month?: number;
    previous_1_year?: number;
  };
  fear_and_greed_historical?: { data?: { x: number; y: number }[] };
  market_momentum_sp500?: CnnIndicator;
  stock_price_strength?: CnnIndicator;
  stock_price_breadth?: CnnIndicator;
  put_call_options?: CnnIndicator;
  market_volatility_vix?: CnnIndicator;
  junk_bond_demand?: CnnIndicator;
  safe_haven_demand?: CnnIndicator;
}

const CNN_COMPONENTS: [keyof CnnGraphData, string][] = [
  ['market_momentum_sp500', 'Market momentum'],
  ['stock_price_strength', 'Price strength'],
  ['stock_price_breadth', 'Price breadth'],
  ['put_call_options', 'Put/call options'],
  ['market_volatility_vix', 'Volatility (VIX)'],
  ['junk_bond_demand', 'Junk bond demand'],
  ['safe_haven_demand', 'Safe haven demand']
];

const stocksSentiment = async (signal?: AbortSignal): Promise<SentimentGauge | null> => {
  try {
    const data = await fetchJson<CnnGraphData>(CNN_FNG, { signal, headers: { 'User-Agent': BROWSER_UA } });
    const fg = data.fear_and_greed;
    if (!fg || typeof fg.score !== 'number') return null;
    const previous = (
      [
        ['1 day ago', fg.previous_close],
        ['1 week ago', fg.previous_1_week],
        ['1 month ago', fg.previous_1_month],
        ['1 year ago', fg.previous_1_year]
      ] as const
    )
      .filter(([, v]) => typeof v === 'number')
      .map(([label, v]) => ({ label, score: Math.round(v as number) }));
    const history = (data.fear_and_greed_historical?.data ?? [])
      .slice(-30)
      .map((p) => p.y)
      .filter((y) => typeof y === 'number');
    const components = CNN_COMPONENTS.flatMap(([key, label]) => {
      const ind = data[key] as CnnIndicator | undefined;
      return ind && (typeof ind.score === 'number' || ind.rating)
        ? [{ label, score: typeof ind.score === 'number' ? Math.round(ind.score) : undefined, rating: ind.rating }]
        : [];
    });
    return {
      market: 'stocks',
      score: Math.round(fg.score),
      rating: fg.rating || 'neutral',
      previous: previous.length ? previous : undefined,
      history: history.length > 1 ? history : undefined,
      components: components.length ? components : undefined
    };
  } catch {
    return null;
  }
};

const cryptoSentiment = async (signal?: AbortSignal): Promise<SentimentGauge | null> => {
  try {
    const data = await fetchJson<{ data?: { value: string; value_classification: string }[] }>(ALT_FNG, { signal });
    const rows = data.data ?? [];
    const latest = rows[0];
    const score = Number(latest?.value);
    if (!latest || !Number.isFinite(score)) return null;
    // alternative.me returns newest-first; the sparkline wants oldest → newest.
    const history = rows
      .map((r) => Number(r.value))
      .filter(Number.isFinite)
      .reverse();
    const prevOf = (idx: number, label: string) => {
      const v = Number(rows[idx]?.value);
      return Number.isFinite(v) ? [{ label, score: v }] : [];
    };
    return {
      market: 'crypto',
      score: Math.round(score),
      rating: latest.value_classification || 'Neutral',
      previous: [...prevOf(1, '1 day ago'), ...prevOf(7, '1 week ago'), ...prevOf(29, '1 month ago')],
      history: history.length > 1 ? history : undefined
    };
  } catch {
    return null;
  }
};

export const marketSentimentTool: ChatTool = {
  name: 'get_market_sentiment',
  description:
    "Get the LIVE Fear & Greed sentiment gauges — CNN's Fear & Greed index for stocks (with its component indicators: momentum, breadth, put/call, VIX…) and alternative.me's index for crypto. Use whenever the user asks about market mood/sentiment, fear & greed, whether the market is greedy or fearful, or risk appetite. Renders animated gauges with history; cite what the components say, don't restate the number.",
  parameters: {
    type: 'object',
    properties: {
      market: {
        type: 'string',
        enum: ['stocks', 'crypto', 'both'],
        description: 'Which gauge(s) to fetch. Default "both".'
      }
    }
  },
  execute: async (args, signal) => {
    const market = strArg(args?.market) ?? 'both';
    const [stocks, crypto] = await Promise.all([
      market !== 'crypto' ? stocksSentiment(signal) : Promise.resolve(null),
      market !== 'stocks' ? cryptoSentiment(signal) : Promise.resolve(null)
    ]);
    const gauges = [stocks, crypto].filter((g): g is SentimentGauge => g !== null);
    if (!gauges.length) {
      return {
        content: 'Live sentiment data is unavailable right now (both sentiment sources failed). No card was shown — say so honestly; do NOT invent a score.',
        notice: { level: 'error' as const, message: 'Fear & Greed sources are unreachable right now.' }
      };
    }
    const wanted = market === 'both' ? 2 : 1;
    const data: MarketSentimentArtifact = {
      asOf: new Date().toISOString(),
      gauges,
      sources: [
        ...(gauges.some((g) => g.market === 'stocks') ? [{ name: 'CNN Fear & Greed', url: 'https://www.cnn.com/markets/fear-and-greed' }] : []),
        ...(gauges.some((g) => g.market === 'crypto') ? [{ name: 'alternative.me', url: 'https://alternative.me/crypto/fear-and-greed-index/' }] : [])
      ]
    };
    const line = gauges.map((g) => `${g.market}: ${g.score}/100 (${g.rating})`).join(' · ');
    return {
      content: `Live market sentiment — ${line}. An animated Fear & Greed gauge card is shown to the user; add a brief read of what is driving it (components/history), not a restatement.`,
      artifacts: [{ type: 'market_sentiment', data }],
      citations: data.sources?.map((s) => ({ url: s.url, title: s.name })),
      ...(gauges.length < wanted
        ? { notice: { level: 'warn' as const, message: `Only the ${gauges[0].market} gauge was reachable; the other sentiment source failed.` } }
        : {})
    };
  }
};

// ----------------------------------------------------------------- yield curve ---

const TREASURY_XML = (yyyymm: string) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${yyyymm}`;

const MATURITIES: { field: string; label: string; years: number }[] = [
  { field: 'BC_1MONTH', label: '1M', years: 1 / 12 },
  { field: 'BC_2MONTH', label: '2M', years: 2 / 12 },
  { field: 'BC_3MONTH', label: '3M', years: 0.25 },
  { field: 'BC_4MONTH', label: '4M', years: 4 / 12 },
  { field: 'BC_6MONTH', label: '6M', years: 0.5 },
  { field: 'BC_1YEAR', label: '1Y', years: 1 },
  { field: 'BC_2YEAR', label: '2Y', years: 2 },
  { field: 'BC_3YEAR', label: '3Y', years: 3 },
  { field: 'BC_5YEAR', label: '5Y', years: 5 },
  { field: 'BC_7YEAR', label: '7Y', years: 7 },
  { field: 'BC_10YEAR', label: '10Y', years: 10 },
  { field: 'BC_20YEAR', label: '20Y', years: 20 },
  { field: 'BC_30YEAR', label: '30Y', years: 30 }
];

interface CurveRow {
  date: string;
  yields: Record<string, number>;
}

/** Parse the Treasury par-yield XML feed (regex-based — the feed is flat OData). */
export const parseTreasuryXml = (xml: string): CurveRow[] => {
  const rows: CurveRow[] = [];
  const props = xml.match(/<m:properties[^>]*>[\s\S]*?<\/m:properties>/g) ?? [];
  for (const block of props) {
    const dateMatch = block.match(/<d:NEW_DATE[^>]*>([^<]+)</);
    if (!dateMatch) continue;
    const date = dateMatch[1].slice(0, 10);
    const yields: Record<string, number> = {};
    const re = /<d:(BC_[A-Z0-9]+)[^>]*>([\d.]+)</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const v = Number(m[2]);
      if (Number.isFinite(v)) yields[m[1]] = v;
    }
    if (Object.keys(yields).length) rows.push({ date, yields });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
};

const toSnapshot = (row: CurveRow): YieldCurveSnapshot => ({
  date: row.date,
  points: MATURITIES.flatMap(({ field, label, years }): YieldCurvePoint[] =>
    typeof row.yields[field] === 'number' ? [{ label, years, yieldPct: row.yields[field] }] : []
  )
});

const yyyymmOf = (d: Date): string => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

// The Treasury feed is slow (~6s per month) and only updates once a business day —
// cache parsed months so dashboard tiles refresh instantly instead of riding the
// 20s tool-refresh timeout (the live fetch alone used to take ~19s).
const curveMonthCache = new TtlCache<CurveRow[]>(30 * 60_000, 24);

const fetchCurveMonth = async (yyyymm: string, signal?: AbortSignal): Promise<CurveRow[]> => {
  const cached = curveMonthCache.get(yyyymm);
  if (cached) return cached;
  try {
    const rows = parseTreasuryXml(await fetchText(TREASURY_XML(yyyymm), { signal, accept: 'application/xml, text/xml' }));
    if (rows.length) curveMonthCache.set(yyyymm, rows);
    return rows;
  } catch {
    return [];
  }
};

/** The row closest to a target date within a list (assumes rows sorted ascending). */
const closestTo = (rows: CurveRow[], targetIso: string): CurveRow | undefined => {
  let best: CurveRow | undefined;
  let bestGap = Infinity;
  const target = new Date(targetIso).getTime();
  for (const r of rows) {
    const gap = Math.abs(new Date(r.date).getTime() - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = r;
    }
  }
  return best;
};

export const yieldCurveTool: ChatTool = {
  name: 'get_yield_curve',
  description:
    'Get the LIVE US Treasury yield curve (daily par yields, 1M–30Y) with comparison snapshots from ~1 month and ~1 year ago, the 10Y−2Y spread and an inversion flag. Use whenever the user asks about the yield curve, treasury yields, curve inversion, rates across maturities, or recession signals from rates. Renders a morphing curve chart; explain the shape and what changed, not the raw numbers.',
  parameters: { type: 'object', properties: {} },
  execute: async (_args, signal) => {
    try {
      const now = new Date();
      const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      // Current month can be empty in the first days of a month — pull the prior
      // month alongside it and treat the union as "recent". The year-ago month is
      // computable from "now" (within days of the latest row — immaterial for a
      // "~1 year ago" snapshot), so all three months fetch IN PARALLEL: the
      // sequential year-ago fetch used to push the tool to ~19s, right against
      // the 20s refresh timeout, which made the dashboard tile flaky.
      const yearAgoGuess = new Date(now.getTime() - 365 * 86_400_000);
      const [cur, prev, yearRows] = await Promise.all([
        fetchCurveMonth(yyyymmOf(now), signal),
        fetchCurveMonth(yyyymmOf(prevMonth), signal),
        fetchCurveMonth(yyyymmOf(yearAgoGuess), signal)
      ]);
      const recent = [...prev, ...cur];
      const latestRow = recent.at(-1);
      if (!latestRow) throw new Error('Treasury feed returned no rows');
      const latest = toSnapshot(latestRow);

      const monthAgoTarget = new Date(new Date(latestRow.date).getTime() - 30 * 86_400_000);
      const yearAgoTarget = new Date(new Date(latestRow.date).getTime() - 365 * 86_400_000);
      const monthAgoRow = closestTo(recent, monthAgoTarget.toISOString());
      const yearAgoRow = closestTo(yearRows, yearAgoTarget.toISOString());

      const y10 = latest.points.find((p) => p.label === '10Y')?.yieldPct;
      const y2 = latest.points.find((p) => p.label === '2Y')?.yieldPct;
      const spread = y10 !== undefined && y2 !== undefined ? Number((y10 - y2).toFixed(2)) : undefined;

      const data: YieldCurveArtifact = {
        latest,
        monthAgo: monthAgoRow && monthAgoRow.date !== latestRow.date ? toSnapshot(monthAgoRow) : undefined,
        yearAgo: yearAgoRow ? toSnapshot(yearAgoRow) : undefined,
        spread10y2y: spread,
        inverted: spread !== undefined ? spread < 0 : undefined
      };
      const ends = `${latest.points[0]?.label} ${latest.points[0]?.yieldPct}% → 10Y ${y10 ?? '—'}% → 30Y ${latest.points.at(-1)?.yieldPct}%`;
      return {
        content:
          `US Treasury par yield curve as of ${latest.date}: ${ends}. 10Y−2Y spread ${spread !== undefined ? `${spread > 0 ? '+' : ''}${spread} pp${spread < 0 ? ' (INVERTED)' : ''}` : 'n/a'}. ` +
          'A morphing curve card (today vs 1M vs 1Y ago) is shown to the user — read the SHAPE (steepening/flattening/inversion) and what changed, do not list every maturity.',
        artifacts: [{ type: 'yield_curve', data }],
        citations: [{ url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates', title: 'US Treasury daily par yield curve' }]
      };
    } catch (err) {
      return {
        content: `Could not fetch the live Treasury yield curve (${(err as Error)?.message || 'unknown error'}). No card was shown — say the data is temporarily unavailable; do NOT recite remembered yields.`,
        notice: { level: 'error' as const, message: 'Treasury yield-curve feed is unreachable right now.' }
      };
    }
  }
};

// ------------------------------------------------------------------- portfolio ---

interface HoldingArg {
  symbol: string;
  shares?: number;
  costBasis?: number;
}

const coerceHoldings = (v: unknown): HoldingArg[] => {
  if (!Array.isArray(v)) return [];
  return v
    .flatMap((h) => {
      if (typeof h === 'string') return [{ symbol: h.trim() }];
      if (!h || typeof h !== 'object') return [];
      const r = h as Record<string, unknown>;
      const symbol = strArg(r.symbol);
      if (!symbol) return [];
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined);
      return [{ symbol, shares: num(r.shares), costBasis: num(r.costBasis) }];
    })
    .slice(0, MAX_SYMBOLS);
};

export const portfolioTool: ChatTool = {
  name: 'build_portfolio',
  description:
    "Build a LIVE-priced portfolio card from the user's holdings. Pass each holding's symbol with optional shares and per-share costBasis; the SERVER fetches live quotes and computes value, day P&L, total P&L and allocation weights — never compute these yourself. Use whenever the user lists holdings/positions ('I own 10 AAPL and 5 NVDA…'), asks how their portfolio is doing, or wants an allocation view. Renders a portfolio hero with allocation donut and holdings table.",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional card title, e.g. "Retirement portfolio".' },
      holdings: {
        type: 'array',
        description: 'The positions. shares/costBasis optional (watch-only entries are fine).',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Ticker or asset name, e.g. "AAPL", "gold", "BTC-USD".' },
            shares: { type: 'number', description: 'Quantity held.' },
            costBasis: { type: 'number', description: 'Average cost per share/unit.' }
          },
          required: ['symbol']
        }
      }
    },
    required: ['holdings']
  },
  execute: async (args, signal) => {
    const holdings = coerceHoldings(args?.holdings);
    if (!holdings.length) return { content: 'No usable holdings were provided (each needs at least a symbol).' };
    const settled = await Promise.allSettled(holdings.map((h) => getLightQuote(h.symbol, signal)));
    const positions: PortfolioPosition[] = [];
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const q = r.value;
      const h = holdings[i];
      const value = h.shares !== undefined ? h.shares * q.price : undefined;
      const dayPnl = h.shares !== undefined ? h.shares * q.change : undefined;
      const totalPnl = h.shares !== undefined && h.costBasis !== undefined ? (q.price - h.costBasis) * h.shares : undefined;
      const totalPnlPercent = h.costBasis ? ((q.price - h.costBasis) / h.costBasis) * 100 : undefined;
      positions.push({
        symbol: q.symbol,
        name: q.name,
        shares: h.shares,
        costBasis: h.costBasis,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
        currency: q.currency,
        value,
        dayPnl,
        totalPnl,
        totalPnlPercent,
        spark: q.spark
      });
    });
    if (!positions.length) {
      return {
        content: 'Could not fetch a live quote for any of the holdings. No card was shown — tell the user market data is temporarily unavailable; do NOT invent prices.',
        notice: { level: 'error' as const, message: 'Live quotes unavailable for the portfolio.' }
      };
    }
    const valued = positions.filter((p) => p.value !== undefined);
    const totalValue = valued.reduce((s, p) => s + (p.value as number), 0);
    for (const p of valued) p.weightPct = totalValue > 0 ? ((p.value as number) / totalValue) * 100 : undefined;
    const totalDay = valued.reduce((s, p) => s + (p.dayPnl ?? 0), 0);
    const withBasis = valued.filter((p) => p.totalPnl !== undefined);
    const totalPnl = withBasis.length ? withBasis.reduce((s, p) => s + (p.totalPnl as number), 0) : undefined;
    const basisValue = withBasis.reduce((s, p) => s + (p.costBasis as number) * (p.shares as number), 0);
    const data: PortfolioArtifact = {
      title: strArg(args?.title),
      currency: positions[0]?.currency,
      positions: positions.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
      totals: valued.length
        ? {
            value: totalValue,
            dayPnl: totalDay,
            dayPnlPercent: totalValue - totalDay !== 0 ? (totalDay / (totalValue - totalDay)) * 100 : undefined,
            totalPnl,
            totalPnlPercent: totalPnl !== undefined && basisValue > 0 ? (totalPnl / basisValue) * 100 : undefined
          }
        : undefined,
      asOf: new Date().toISOString()
    };
    const failed = holdings.length - positions.length;
    const summary = valued.length
      ? `total ${totalValue.toFixed(2)} ${data.currency ?? ''}, day P&L ${totalDay >= 0 ? '+' : ''}${totalDay.toFixed(2)}${totalPnl !== undefined ? `, total P&L ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}` : ''}`
      : positions.map((p) => `${p.symbol} ${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%`).join(', ');
    return {
      content: `Live-priced portfolio (${positions.length} positions${failed ? `, ${failed} unquotable` : ''}): ${summary}. A portfolio card with allocation and holdings is shown — add a short read (concentration, biggest mover), not a restatement.`,
      artifacts: [{ type: 'portfolio', data }],
      ...(failed ? { notice: { level: 'warn' as const, message: `${failed} holding(s) could not be quoted and were left out.` } } : {})
    };
  }
};

// ---------------------------------------------------------------- FX converter ---

const FRANKFURTER = 'https://api.frankfurter.app';

export const currencyConverterTool: ChatTool = {
  name: 'convert_currency',
  description:
    'Convert between fiat currencies with a LIVE interactive converter card — current ECB rate, a 30-day rate trend, and a "vs 30-day average" verdict (is now a good time to exchange?). Use whenever the user converts money or asks about an exchange rate before a trip/transfer. The card lets the user edit the amount client-side. (exchange_rate gives a plain-text answer; prefer THIS when a widget helps.)',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '3-letter source currency code, e.g. "USD".' },
      to: { type: 'string', description: '3-letter target currency code, e.g. "INR".' },
      amount: { type: 'number', description: 'Amount to convert (default 1).' }
    },
    required: ['from', 'to']
  },
  execute: async (args, signal) => {
    const from = String(args?.from || '').trim().toUpperCase();
    const to = String(args?.to || '').trim().toUpperCase();
    const amount = typeof args?.amount === 'number' && Number.isFinite(args.amount) && args.amount > 0 ? args.amount : 1;
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      return { content: 'Provide two different 3-letter currency codes, e.g. from "USD" to "EUR".' };
    }
    try {
      const start = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 10);
      const [latest, range] = await Promise.all([
        fetchJson<{ date?: string; rates?: Record<string, number> }>(`${FRANKFURTER}/latest?from=${from}&to=${to}`, { signal }),
        fetchJson<{ rates?: Record<string, Record<string, number>> }>(`${FRANKFURTER}/${start}..?from=${from}&to=${to}`, { signal }).catch(() => null)
      ]);
      const rate = latest.rates?.[to];
      if (typeof rate !== 'number') return { content: `No exchange rate available for ${from} → ${to}.` };
      const series = range?.rates
        ? Object.entries(range.rates)
            .map(([date, r]) => ({ date, rate: r[to] }))
            .filter((p) => typeof p.rate === 'number')
            .sort((a, b) => a.date.localeCompare(b.date))
        : undefined;
      const avg30d = series?.length ? series.reduce((s, p) => s + p.rate, 0) / series.length : undefined;
      const vsAvgPct = avg30d ? ((rate - avg30d) / avg30d) * 100 : undefined;
      const data: CurrencyConverterArtifact = {
        from,
        to,
        rate,
        amount,
        converted: amount * rate,
        date: latest.date,
        series,
        avg30d,
        vsAvgPct: vsAvgPct !== undefined ? Number(vsAvgPct.toFixed(2)) : undefined
      };
      return {
        content:
          `${amount} ${from} = ${(amount * rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${to} (1 ${from} = ${rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${to}, ECB ${latest.date}).` +
          (vsAvgPct !== undefined ? ` The rate is ${vsAvgPct >= 0 ? '+' : ''}${vsAvgPct.toFixed(1)}% vs its 30-day average.` : '') +
          ' A live converter card is shown to the user — keep prose to one short line.',
        artifacts: [{ type: 'currency_converter', data }],
        citations: [{ url: 'https://www.frankfurter.app', title: 'Frankfurter (ECB reference rates)' }]
      };
    } catch (err) {
      return {
        content: `Currency conversion failed: ${(err as Error)?.message || 'unknown error'}. No card was shown.`,
        notice: { level: 'error' as const, message: 'Live exchange rates are unavailable right now.' }
      };
    }
  }
};

export const MARKET_WIDGET_TOOLS: ChatTool[] = [
  tickerTapeTool,
  marketSentimentTool,
  yieldCurveTool,
  portfolioTool,
  currencyConverterTool
];
