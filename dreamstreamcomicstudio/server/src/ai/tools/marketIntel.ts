// Market-intelligence tools — the "no signup, just build it" live sources from
// docs/features/data-connectors.md §4 (E/F/G). All keyless, all read-only, all
// REFRESHABLE. Each renders through the existing typed data_table artifact, so
// they plug into refresh, /loop monitors, smart stacks and custom dashboards
// with zero new client code.
//
//  - get_predictions      Polymarket Gamma API (prediction-market odds)
//  - get_funding_rates    Binance USD-M perp funding (crypto positioning)
//  - get_stablecoins      DefiLlama (supplies + peg deviations)
//  - get_cot_positioning  CFTC Socrata (weekly Commitments of Traders)

import type { ChatTool } from './types.js';
import type { DataTableArtifact, DataTableRowCell } from '../../../../apiTypes.js';
import { fetchJson } from './http.js';

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// ------------------------------------------------------------------ Polymarket ---

interface PolyMarket {
  question?: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume24hr?: number;
  liquidityNum?: number;
  endDate?: string;
}

const parseJsonArray = (s?: string): string[] => {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

export const predictionsTool: ChatTool = {
  name: 'get_predictions',
  description:
    'Get LIVE prediction-market odds from Polymarket — the highest-volume open markets (or a searched topic) with the market-implied probability, 24h volume and close date. Use when the user asks "what are the odds of X", about election/event probabilities, or what prediction markets think. Probabilities are market prices, not forecasts — say so.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional topic filter, e.g. "election", "fed", "bitcoin". Omit for the top markets by volume.' },
      limit: { type: 'number', description: 'How many markets (default 8, max 12).' }
    }
  },
  execute: async (args, signal) => {
    const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
    const limit = Math.max(1, Math.min(12, num(args?.limit) ?? 8));
    try {
      const markets = await fetchJson<PolyMarket[]>(
        'https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=100',
        { signal }
      );
      const rows = (markets ?? [])
        .map((m) => {
          const outcomes = parseJsonArray(m.outcomes);
          const prices = parseJsonArray(m.outcomePrices).map(Number);
          const yesIdx = Math.max(0, outcomes.findIndex((o) => /^yes$/i.test(o)));
          const yes = prices[yesIdx];
          return { m, yes: Number.isFinite(yes) ? yes : undefined, binary: outcomes.length === 2 };
        })
        .filter((r) => r.binary && r.yes !== undefined && !!r.m.question)
        .filter((r) => !query || r.m.question!.toLowerCase().includes(query))
        .slice(0, limit);
      if (!rows.length) {
        return {
          content: query
            ? `No open Polymarket markets matched "${query}". Try a broader term or omit the query for the top markets.`
            : 'Polymarket returned no open markets right now.',
          notice: { level: 'warn' as const, message: 'No prediction markets to display.' }
        };
      }
      const data: DataTableArtifact = {
        title: query ? `Prediction markets — “${query}”` : 'Prediction markets',
        subtitle: 'Polymarket · market-implied probabilities',
        columns: [
          { label: 'Market', kind: 'text' },
          { label: 'Yes', kind: 'percent', align: 'right' },
          { label: '24h volume', kind: 'currency', align: 'right' },
          { label: 'Closes', kind: 'text', align: 'right' }
        ],
        rows: rows.map((r): DataTableRowCell[] => [
          { value: r.m.question!.slice(0, 90), href: r.m.slug ? `https://polymarket.com/market/${r.m.slug}` : undefined },
          Number((r.yes! * 100).toFixed(1)),
          Math.round(r.m.volume24hr ?? 0),
          r.m.endDate ? r.m.endDate.slice(0, 10) : '—'
        ]),
        caption: `Polymarket · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · prices are odds, not forecasts`,
        palette: 'violet'
      };
      const top = rows[0];
      return {
        content:
          `Live Polymarket odds (${rows.length} markets${query ? ` matching "${query}"` : ''}). Top by volume: "${top.m.question}" — ${(top.yes! * 100).toFixed(0)}% implied. ` +
          'A sortable table is shown; remind the user these are market prices, not forecasts.',
        artifacts: [{ type: 'data_table', data }],
        citations: [{ url: 'https://polymarket.com', title: 'Polymarket' }]
      };
    } catch (err) {
      return {
        content: `Prediction-market lookup failed: ${(err as Error)?.message || 'unknown error'}. No card was shown — do NOT invent odds.`,
        notice: { level: 'error' as const, message: 'Polymarket is unreachable right now.' }
      };
    }
  }
};

// -------------------------------------------------------------- funding rates ---

const DEFAULT_PERPS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

interface PremiumIndex {
  symbol?: string;
  markPrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

interface FundingRow {
  symbol: string;
  ratePct: number;
  aprPct: number;
  mark?: number;
  next: string;
}

const fmtNext = (ms?: number): string => (ms ? new Date(ms).toISOString().slice(11, 16) + ' UTC' : '—');

/** Primary source: Binance USD-M (one call, includes mark price). Geo-blocked (451) from some regions. */
const binanceFunding = async (symbols: string[], signal?: AbortSignal): Promise<FundingRow[]> => {
  const all = await fetchJson<PremiumIndex[]>('https://fapi.binance.com/fapi/v1/premiumIndex', { signal });
  const bySymbol = new Map((all ?? []).map((p) => [p.symbol, p]));
  return symbols.flatMap((s) => {
    const p = bySymbol.get(s);
    const rate = num(p?.lastFundingRate);
    if (!p || rate === undefined) return [];
    return [{ symbol: s.replace(/USDT$/, ''), ratePct: rate * 100, aprPct: rate * 3 * 365 * 100, mark: num(p.markPrice), next: fmtNext(p.nextFundingTime) }];
  });
};

/** Fallback source: OKX public API (per-instrument; reachable where Binance/Bybit geo-block). */
const okxFunding = async (symbols: string[], signal?: AbortSignal): Promise<FundingRow[]> => {
  const settled = await Promise.allSettled(
    symbols.map(async (s): Promise<FundingRow> => {
      const inst = `${s.replace(/USDT$/, '')}-USDT-SWAP`;
      const res = await fetchJson<{ data?: { fundingRate?: string; nextFundingTime?: string }[] }>(
        `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(inst)}`,
        { signal }
      );
      const row = res.data?.[0];
      const rate = num(row?.fundingRate);
      if (rate === undefined) throw new Error(`no funding for ${inst}`);
      return { symbol: s.replace(/USDT$/, ''), ratePct: rate * 100, aprPct: rate * 3 * 365 * 100, next: fmtNext(num(row?.nextFundingTime)) };
    })
  );
  return settled.filter((r): r is PromiseFulfilledResult<FundingRow> => r.status === 'fulfilled').map((r) => r.value);
};

export const fundingRatesTool: ChatTool = {
  name: 'get_funding_rates',
  description:
    'Get LIVE crypto perpetual FUNDING RATES (Binance USD-M, OKX fallback) — the 8h rate and annualized equivalent per contract. Positive funding = longs pay shorts (crowded long); deeply negative = crowded short. Use for crypto positioning/sentiment questions ("is the market overheated?", "funding on BTC"). Pass symbols like ["BTCUSDT"] or omit for the majors.',
  parameters: {
    type: 'object',
    properties: {
      symbols: { type: 'array', items: { type: 'string' }, description: 'Perp symbols, e.g. ["BTCUSDT","ETHUSDT"]. Omit for the majors.' }
    }
  },
  execute: async (args, signal) => {
    const wanted = (Array.isArray(args?.symbols) ? (args.symbols as unknown[]) : [])
      .map((s) => String(s).trim().toUpperCase())
      .map((s) => (s.endsWith('USDT') ? s : `${s}USDT`))
      .filter(Boolean);
    const symbols = wanted.length ? wanted.slice(0, 10) : DEFAULT_PERPS;
    try {
      // Binance first (one call, mark prices); OKX fallback where derivatives
      // endpoints are geo-blocked (HTTP 451 from US-region servers).
      let source = 'Binance USD-M';
      let rows: FundingRow[];
      try {
        rows = await binanceFunding(symbols, signal);
      } catch {
        source = 'OKX';
        rows = await okxFunding(symbols, signal);
      }
      if (!rows.length) {
        return { content: `No funding data for ${symbols.join(', ')} — check the symbols (USDT-margined perps).`, notice: { level: 'warn' as const, message: 'No funding rates to display.' } };
      }
      const data: DataTableArtifact = {
        title: 'Perp funding rates',
        subtitle: `${source} · positive = longs pay shorts`,
        columns: [
          { label: 'Contract', kind: 'text' },
          { label: '8h rate', kind: 'deltaPercent', align: 'right' },
          { label: 'Annualized', kind: 'deltaPercent', align: 'right' },
          { label: 'Mark', kind: 'currency', align: 'right' },
          { label: 'Next funding', kind: 'text', align: 'right' }
        ],
        rows: rows.map((r): DataTableRowCell[] => [
          r.symbol,
          Number(r.ratePct.toFixed(4)),
          Number(r.aprPct.toFixed(1)),
          r.mark ?? null,
          r.next
        ]),
        caption: `${source} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        palette: 'ocean'
      };
      const hottest = [...rows].sort((a, b) => Math.abs(b.ratePct) - Math.abs(a.ratePct))[0];
      return {
        content: `Live perp funding (${rows.length} contracts). Most stretched: ${hottest.symbol} at ${hottest.ratePct.toFixed(4)}%/8h (${hottest.aprPct.toFixed(1)}% annualized). Read the POSITIONING (who pays whom), don't restate the table.`,
        artifacts: [{ type: 'data_table', data }],
        citations: [{ url: 'https://www.binance.com/en/futures/funding-history', title: 'Binance funding rates' }]
      };
    } catch (err) {
      return {
        content: `Funding-rate lookup failed: ${(err as Error)?.message || 'unknown error'}. No card was shown.`,
        notice: { level: 'error' as const, message: 'Binance funding data is unreachable right now.' }
      };
    }
  }
};

// ---------------------------------------------------------------- stablecoins ---

interface PeggedAsset {
  name?: string;
  symbol?: string;
  price?: number | string;
  pegType?: string;
  pegMechanism?: string;
  circulating?: { peggedUSD?: number };
}

export const stablecoinsTool: ChatTool = {
  name: 'get_stablecoins',
  description:
    'Get the LIVE stablecoin board (DefiLlama) — circulating supply, price and peg deviation in basis points for the largest USD stablecoins, with depegs flagged. Use for "is USDT/USDC on peg", stablecoin supply trends, or crypto risk checks.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many coins (default 8, max 12).' }
    }
  },
  execute: async (args, signal) => {
    const limit = Math.max(3, Math.min(12, num(args?.limit) ?? 8));
    try {
      const data = await fetchJson<{ peggedAssets?: PeggedAsset[] }>('https://stablecoins.llama.fi/stablecoins?includePrices=true', { signal });
      const coins = (data.peggedAssets ?? [])
        .filter((a) => a.pegType === 'peggedUSD')
        .map((a) => ({
          name: a.name ?? a.symbol ?? '?',
          symbol: a.symbol ?? '',
          mcap: a.circulating?.peggedUSD ?? 0,
          price: num(a.price),
          mechanism: a.pegMechanism ?? '—'
        }))
        .sort((a, b) => b.mcap - a.mcap)
        .slice(0, limit);
      if (!coins.length) throw new Error('no pegged assets returned');
      const table: DataTableArtifact = {
        title: 'Stablecoins',
        subtitle: 'DefiLlama · USD-pegged, by circulating supply',
        columns: [
          { label: 'Coin', kind: 'text' },
          { label: 'Supply', kind: 'currency', align: 'right' },
          { label: 'Price', kind: 'number', align: 'right' },
          { label: 'Peg Δ (bps)', kind: 'delta', align: 'right' },
          { label: 'Mechanism', kind: 'badge', align: 'right' }
        ],
        rows: coins.map((c): DataTableRowCell[] => {
          const devBps = c.price !== undefined ? Number(((c.price - 1) * 10_000).toFixed(1)) : null;
          return [
            { value: c.name, sub: c.symbol },
            c.mcap,
            c.price !== undefined ? Number(c.price.toFixed(4)) : null,
            devBps,
            { value: c.mechanism, color: Math.abs(devBps ?? 0) > 30 ? '#dc2626' : undefined }
          ];
        }),
        caption: `DefiLlama · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · |Δ| > 30 bps = depeg watch`,
        palette: 'mono'
      };
      const depegged = coins.filter((c) => c.price !== undefined && Math.abs((c.price - 1) * 10_000) > 30);
      const total = coins.reduce((s, c) => s + c.mcap, 0);
      return {
        content:
          `Live stablecoin board: top ${coins.length} = $${(total / 1e9).toFixed(1)}B circulating. ` +
          (depegged.length ? `DEPEG WATCH: ${depegged.map((d) => `${d.symbol} ${((d.price! - 1) * 10_000).toFixed(0)} bps`).join(', ')}.` : 'All majors within 30 bps of peg.') +
          ' Comment on supply shifts or peg stress, not the raw list.',
        artifacts: [{ type: 'data_table', data: table }],
        citations: [{ url: 'https://defillama.com/stablecoins', title: 'DefiLlama stablecoins' }]
      };
    } catch (err) {
      return {
        content: `Stablecoin lookup failed: ${(err as Error)?.message || 'unknown error'}. No card was shown.`,
        notice: { level: 'error' as const, message: 'DefiLlama is unreachable right now.' }
      };
    }
  }
};

// ----------------------------------------------------------- COT positioning ---

// CFTC "Legacy — Futures Only" weekly report via the public Socrata API (keyless).
const COT_URL =
  'https://publicreporting.cftc.gov/resource/6dca-aqww.json?' +
  '$select=market_and_exchange_names,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,' +
  'change_in_noncomm_long_all,change_in_noncomm_short_all,open_interest_all&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=1500';

const DEFAULT_COT_MARKETS = ['GOLD', 'SILVER', 'CRUDE OIL', 'E-MINI S&P 500', 'NASDAQ', 'EURO FX', 'JAPANESE YEN', '10-YEAR', 'BITCOIN'];

interface CotRow {
  market_and_exchange_names?: string;
  report_date_as_yyyy_mm_dd?: string;
  noncomm_positions_long_all?: string;
  noncomm_positions_short_all?: string;
  change_in_noncomm_long_all?: string;
  change_in_noncomm_short_all?: string;
  open_interest_all?: string;
}

export const cotPositioningTool: ChatTool = {
  name: 'get_cot_positioning',
  description:
    "Get the LIVE weekly COT (Commitments of Traders) speculative positioning from the CFTC — non-commercial net longs and the week's change for major futures (gold, oil, S&P, FX, rates, bitcoin). Use for 'how are speculators positioned in X', crowded-trade checks, or macro positioning context. Data is weekly (Tuesday positions, Friday release).",
  parameters: {
    type: 'object',
    properties: {
      markets: { type: 'array', items: { type: 'string' }, description: 'Market name filters, e.g. ["gold","crude","s&p"]. Omit for the standard macro set.' }
    }
  },
  execute: async (args, signal) => {
    const wanted = (Array.isArray(args?.markets) ? (args.markets as unknown[]) : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
    const filters = wanted.length ? wanted.slice(0, 10) : DEFAULT_COT_MARKETS;
    try {
      const rows = await fetchJson<CotRow[]>(COT_URL, { signal, timeoutMs: 15_000 });
      const latestDate = rows?.[0]?.report_date_as_yyyy_mm_dd;
      if (!latestDate) throw new Error('no report rows returned');
      const week = rows.filter((r) => r.report_date_as_yyyy_mm_dd === latestDate);
      // First match per filter keeps the headline contract (the feed lists ~250 markets).
      const picked = filters
        .map((f) => week.find((r) => (r.market_and_exchange_names ?? '').toUpperCase().includes(f)))
        .filter((r): r is CotRow => !!r)
        .filter((r, i, arr) => arr.findIndex((x) => x.market_and_exchange_names === r.market_and_exchange_names) === i);
      if (!picked.length) {
        return {
          content: `The latest COT report (${latestDate.slice(0, 10)}) had no markets matching ${filters.join(', ')}. Try broader names ("gold", "crude", "euro").`,
          notice: { level: 'warn' as const, message: 'No COT markets matched the filter.' }
        };
      }
      const table: DataTableArtifact = {
        title: 'COT — speculative positioning',
        subtitle: `Non-commercial futures · week of ${latestDate.slice(0, 10)}`,
        columns: [
          { label: 'Market', kind: 'text' },
          { label: 'Net spec', kind: 'delta', align: 'right' },
          { label: 'Δ week', kind: 'delta', align: 'right' },
          { label: 'Long', kind: 'number', align: 'right' },
          { label: 'Short', kind: 'number', align: 'right' },
          { label: 'OI', kind: 'number', align: 'right' }
        ],
        rows: picked.map((r): DataTableRowCell[] => {
          const long = num(r.noncomm_positions_long_all) ?? 0;
          const short = num(r.noncomm_positions_short_all) ?? 0;
          const dLong = num(r.change_in_noncomm_long_all) ?? 0;
          const dShort = num(r.change_in_noncomm_short_all) ?? 0;
          const name = (r.market_and_exchange_names ?? '').split(' - ')[0].trim();
          return [name.slice(0, 40), long - short, dLong - dShort, long, short, num(r.open_interest_all) ?? null];
        }),
        caption: 'CFTC Legacy futures-only · Tuesday positions, released Fridays',
        palette: 'mono'
      };
      return {
        content:
          `COT positioning, week of ${latestDate.slice(0, 10)} (${picked.length} markets). ` +
          'Read the EXTREMES and week-over-week swings (crowded longs/shorts), not every row. Note the data is as of Tuesday.',
        artifacts: [{ type: 'data_table', data: table }],
        citations: [{ url: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm', title: 'CFTC Commitments of Traders' }]
      };
    } catch (err) {
      return {
        content: `COT lookup failed: ${(err as Error)?.message || 'unknown error'}. No card was shown — do NOT recite remembered positioning.`,
        notice: { level: 'error' as const, message: 'CFTC public reporting API is unreachable right now.' }
      };
    }
  }
};

export const MARKET_INTEL_TOOLS: ChatTool[] = [predictionsTool, fundingRatesTool, stablecoinsTool, cotPositioningTool];
