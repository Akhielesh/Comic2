// Crypto prices (CoinGecko) and fiat exchange rates (Frankfurter / ECB).
//
// CoinGecko licensing: the keyless public tier and the free Demo key are for
// non-commercial use; commercial display rights start at the Basic plan ($35/mo),
// which also requires visible "Data provided by CoinGecko" attribution (we always
// attribute via citations). Set COINGECKO_API_KEY (+ COINGECKO_API_PLAN=pro for
// paid plans) to authenticate; keyless remains the dev fallback.

import type { ChatTool } from './types.js';
import { fetchJson } from './http.js';
import { TtlCache } from '../../lib/cache.js';

/** Normalize COINGECKO_API_PLAN: anything pro-ish selects the pro host; everything
 *  else (unset, '', 'demo', 'free', stray whitespace/case) means the public host
 *  with the demo-key header. Exported for tests. */
export const cgPlanIsPro = (raw: string | undefined): boolean => /^(pro|paid|analyst|lite|enterprise)$/i.test((raw || '').trim());

const cgConfig = (): { base: string; headers?: Record<string, string> } => {
  const key = (process.env.COINGECKO_API_KEY || '').trim();
  if (key && cgPlanIsPro(process.env.COINGECKO_API_PLAN)) {
    return { base: 'https://pro-api.coingecko.com/api/v3', headers: { 'x-cg-pro-api-key': key } };
  }
  return { base: 'https://api.coingecko.com/api/v3', headers: key ? { 'x-cg-demo-api-key': key } : undefined };
};

// A misconfigured key (demo key + plan=pro, expired key…) must NEVER take crypto
// down entirely — on an auth-ish failure of the keyed config, retry once keyless
// against the public host (the pre-key behavior, which always worked).
const cgFetch = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  const { base, headers } = cgConfig();
  try {
    return await fetchJson<T>(`${base}${path}`, { signal, headers });
  } catch (err) {
    const msg = (err as Error)?.message || '';
    const authish = /\b(400|401|403|10002|10005)\b|unauthorized|api key/i.test(msg);
    if (headers && authish) {
      return fetchJson<T>(`https://api.coingecko.com/api/v3${path}`, { signal });
    }
    throw err;
  }
};

// Majors resolve without a /search round-trip (3 upstream calls per tile refresh
// against a 30/min demo budget is how a crypto board rate-limits itself).
const KNOWN_COINS: Record<string, { id: string; name: string; symbol: string; rank?: number }> = {
  bitcoin: { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', rank: 1 },
  btc: { id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', rank: 1 },
  ethereum: { id: 'ethereum', name: 'Ethereum', symbol: 'eth', rank: 2 },
  eth: { id: 'ethereum', name: 'Ethereum', symbol: 'eth', rank: 2 },
  tether: { id: 'tether', name: 'Tether', symbol: 'usdt' },
  usdt: { id: 'tether', name: 'Tether', symbol: 'usdt' },
  solana: { id: 'solana', name: 'Solana', symbol: 'sol' },
  sol: { id: 'solana', name: 'Solana', symbol: 'sol' },
  xrp: { id: 'ripple', name: 'XRP', symbol: 'xrp' },
  ripple: { id: 'ripple', name: 'XRP', symbol: 'xrp' },
  bnb: { id: 'binancecoin', name: 'BNB', symbol: 'bnb' },
  dogecoin: { id: 'dogecoin', name: 'Dogecoin', symbol: 'doge' },
  doge: { id: 'dogecoin', name: 'Dogecoin', symbol: 'doge' },
  cardano: { id: 'cardano', name: 'Cardano', symbol: 'ada' },
  ada: { id: 'cardano', name: 'Cardano', symbol: 'ada' },
  litecoin: { id: 'litecoin', name: 'Litecoin', symbol: 'ltc' },
  ltc: { id: 'litecoin', name: 'Litecoin', symbol: 'ltc' }
};

/** Resolve a user/model coin string to a CoinGecko id without burning quota on
 *  majors. Exported for tests. */
export const resolveKnownCoin = (raw: string) => KNOWN_COINS[raw.trim().toLowerCase()] ?? null;

// Searched ids barely change — keep them for a day. Full results stay fresh-ish
// for a minute so dashboard refresh bursts collapse into one upstream pass.
const coinIdCache = new TtlCache<{ id: string; name: string; symbol: string; rank?: number }>(24 * 60 * 60_000, 300);
const cryptoResultCache = new TtlCache<{ content: string; artifacts: unknown[]; citations: unknown[] }>(60_000, 100);

interface CGSearch {
  coins?: { id: string; name: string; symbol: string; market_cap_rank?: number; thumb?: string }[];
}

export const cryptoPriceTool: ChatTool = {
  name: 'crypto_price',
  description:
    'Get the current price, market cap and 24h change of a cryptocurrency via CoinGecko. Use whenever the user asks about a crypto/coin/token price (Bitcoin, Ethereum, Solana, Dogecoin, etc.) — NOT get_stock, which is for equities/indices.',
  parameters: {
    type: 'object',
    properties: {
      coin: { type: 'string', description: 'Coin name or symbol, e.g. "bitcoin", "BTC", "ethereum", "solana".' },
      vs: { type: 'string', description: 'Fiat currency to price in (default "usd"), e.g. "usd", "eur", "gbp".' }
    },
    required: ['coin']
  },
  execute: async (args, signal) => {
    const coin = String(args?.coin || '').trim();
    const vs = (String(args?.vs || 'usd').trim().toLowerCase() || 'usd');
    if (!coin) return { content: 'No coin was provided.' };
    const cacheKey = `${coin.toLowerCase()}:${vs}`;
    const cached = cryptoResultCache.get(cacheKey);
    if (cached) return cached as never;
    try {
      let top = resolveKnownCoin(coin) ?? coinIdCache.get(coin.toLowerCase()) ?? null;
      if (!top) {
        const search = await cgFetch<CGSearch>(`/search?query=${encodeURIComponent(coin)}`, signal);
        const hit = search.coins?.[0];
        if (!hit) return { content: `No cryptocurrency found matching "${coin}".` };
        top = { id: hit.id, name: hit.name, symbol: hit.symbol, rank: hit.market_cap_rank };
        coinIdCache.set(coin.toLowerCase(), top);
      }
      const price = await cgFetch<Record<string, Record<string, number>>>(
        `/simple/price?ids=${encodeURIComponent(top.id)}&vs_currencies=${encodeURIComponent(vs)}&include_market_cap=true&include_24hr_change=true`,
        signal
      );
      const row = price[top.id];
      const value = row?.[vs];
      if (typeof value !== 'number') return { content: `No ${vs.toUpperCase()} price available for ${top.name}.` };
      const change = row[`${vs}_24h_change`];
      const mcap = row[`${vs}_market_cap`];
      const dir = typeof change === 'number' ? (change >= 0 ? '▲' : '▼') : '';
      const changePercent = typeof change === 'number' ? change : 0;
      const changeAbs = changePercent ? value - value / (1 + changePercent / 100) : 0;

      // Best-effort 1-YEAR daily price series → the interactive MarketCard derives its
      // range tabs (1M/6M/1Y…) by ~daily point count, so a year of DAILY points makes
      // those ranges accurate. (The old 7-day hourly series made every range show the
      // same week, mislabeled as "1M"/"6M".)
      let series: { date: string; close: number }[] | undefined;
      try {
        const chart = await cgFetch<{ prices?: [number, number][] }>(
          `/coins/${encodeURIComponent(top.id)}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=365`,
          signal
        );
        const pts = chart.prices || [];
        if (pts.length) {
          // Keep ~daily resolution (one point ≈ one day) so range-by-point-count is right;
          // only downsample if CoinGecko returned a finer (e.g. hourly) granularity.
          const step = Math.max(1, Math.floor(pts.length / 370));
          series = pts.filter((_, i) => i % step === 0).map(([ms, p]) => ({ date: new Date(ms).toISOString(), close: p }));
        }
      } catch {
        /* sparkline optional */
      }

      const content =
        `${top.name} (${top.symbol.toUpperCase()}): ${value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 6 : 2 })} ${vs.toUpperCase()} ` +
        `${dir}${typeof change === 'number' ? ` ${change >= 0 ? '+' : ''}${change.toFixed(2)}% (24h)` : ''}` +
        `${typeof mcap === 'number' ? ` · market cap ${Math.round(mcap).toLocaleString()} ${vs.toUpperCase()}` : ''}` +
        `${top.rank ? ` · rank #${top.rank}` : ''}. A live price card is shown to the user.`;
      const result = {
        content,
        artifacts: [
          {
            type: 'stock_quote',
            data: {
              symbol: top.symbol.toUpperCase(),
              name: top.name,
              price: value,
              change: changeAbs,
              changePercent,
              currency: vs.toUpperCase(),
              exchange: 'CoinGecko',
              marketState: 'open' as const,
              ...(series ? { series } : {}),
              ...(typeof mcap === 'number' ? { stats: { marketCap: mcap } } : {})
            }
          }
        ],
        // Required attribution wording per CoinGecko's API license.
        citations: [{ url: `https://www.coingecko.com/en/coins/${top.id}`, title: 'Data provided by CoinGecko' }]
      };
      cryptoResultCache.set(cacheKey, result);
      return result;
    } catch (err) {
      const message = (err as Error)?.message || 'unknown error';
      // CoinGecko's keyless tier rate-limits (429) often; tell the UI honestly rather than
      // letting the model decide it's an unknown coin.
      const rateLimited = /\b429\b|rate.?limit/i.test(message);
      return {
        content: `Crypto price lookup failed: ${message}.`,
        notice: {
          level: rateLimited ? 'warn' : 'error',
          message: rateLimited
            ? 'Live crypto data is rate-limited right now — try again in a moment.'
            : 'Live crypto price data is unavailable right now.'
        }
      };
    }
  }
};

export const exchangeRateTool: ChatTool = {
  name: 'exchange_rate',
  description:
    'Convert between fiat currencies / get exchange rates using official ECB reference rates (Frankfurter). Use whenever the user asks to convert money, "how much is X USD in EUR", or wants a currency exchange rate.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '3-letter source currency code, e.g. "USD".' },
      to: { type: 'string', description: '3-letter target currency code, e.g. "EUR". For multiple, comma-separate.' },
      amount: { type: 'number', description: 'Amount to convert (default 1).' }
    },
    required: ['from', 'to']
  },
  execute: async (args, signal) => {
    const from = String(args?.from || '').trim().toUpperCase();
    const to = String(args?.to || '').trim().toUpperCase();
    const amount = typeof args?.amount === 'number' && Number.isFinite(args.amount) && args.amount > 0 ? args.amount : 1;
    if (!/^[A-Z]{3}$/.test(from) || !to) return { content: 'Provide valid 3-letter currency codes, e.g. from "USD" to "EUR".' };
    try {
      const data = await fetchJson<{ amount?: number; base?: string; date?: string; rates?: Record<string, number> }>(
        `https://api.frankfurter.app/latest?amount=${amount}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { signal }
      );
      const rates = data.rates || {};
      const keys = Object.keys(rates);
      if (!keys.length) return { content: `No exchange rate available for ${from} → ${to}.` };
      const lines = keys.map((k) => `${amount} ${from} = ${rates[k].toLocaleString(undefined, { maximumFractionDigits: 4 })} ${k}`);
      return { content: `${lines.join('\n')}${data.date ? `\n(ECB reference rates, ${data.date})` : ''}` };
    } catch (err) {
      return { content: `Exchange rate lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
};

export const FINANCE2_TOOLS: ChatTool[] = [cryptoPriceTool, exchangeRateTool];
