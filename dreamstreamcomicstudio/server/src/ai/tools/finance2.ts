// Crypto prices (CoinGecko) and fiat exchange rates (Frankfurter / ECB).
// Both free and keyless; CoinGecko's public tier is rate-limited (~10-30 calls/min).

import type { ChatTool } from './types.js';
import { fetchJson } from './http.js';

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
    try {
      const search = await fetchJson<CGSearch>(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`, { signal });
      const top = search.coins?.[0];
      if (!top) return { content: `No cryptocurrency found matching "${coin}".` };
      const price = await fetchJson<Record<string, Record<string, number>>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(top.id)}&vs_currencies=${encodeURIComponent(vs)}&include_market_cap=true&include_24hr_change=true`,
        { signal }
      );
      const row = price[top.id];
      const value = row?.[vs];
      if (typeof value !== 'number') return { content: `No ${vs.toUpperCase()} price available for ${top.name}.` };
      const change = row[`${vs}_24h_change`];
      const mcap = row[`${vs}_market_cap`];
      const dir = typeof change === 'number' ? (change >= 0 ? '▲' : '▼') : '';
      const content =
        `${top.name} (${top.symbol.toUpperCase()}): ${value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 6 : 2 })} ${vs.toUpperCase()} ` +
        `${dir}${typeof change === 'number' ? ` ${change >= 0 ? '+' : ''}${change.toFixed(2)}% (24h)` : ''}` +
        `${typeof mcap === 'number' ? ` · market cap ${Math.round(mcap).toLocaleString()} ${vs.toUpperCase()}` : ''}` +
        `${top.market_cap_rank ? ` · rank #${top.market_cap_rank}` : ''}`;
      return { content, citations: [{ url: `https://www.coingecko.com/en/coins/${top.id}`, title: `${top.name} on CoinGecko` }] };
    } catch (err) {
      return { content: `Crypto price lookup failed: ${(err as Error)?.message || 'unknown error'}.` };
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
