import React, { useEffect, useState } from 'react';

// SymbolLogo — a real company / crypto brand mark for a ticker, with a graceful
// seeded-gradient initials fallback. Shared by every finance card (MarketCard,
// TickerTape, EarningsCountdown, PortfolioCard, comparison cards) so a ticker looks
// like the company, not a coloured monogram.
//
// Logos are pulled from a keyless CDN as plain <img> sources (no server fetch, no
// CORS read), tried in order; the moment one loads we keep it, and if every source
// 404s we render the calm initials avatar. Failed URLs are remembered per-symbol for
// the session so we don't re-hit dead endpoints on every re-render.

const cleanSymbol = (s: string): string => s.replace(/[^A-Za-z0-9.-]/g, '').toUpperCase();

// Crypto tickers that the stock logo CDN won't have — routed to the crypto path.
const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC', 'LINK', 'LTC', 'BCH', 'BTCUSD', 'ETHUSD']);
const CRYPTO_ALIAS: Record<string, string> = { BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', BTCUSD: 'BTC', ETHUSD: 'ETH' };

// Index codes (NASDAQ Composite, S&P 500, Dow, …). Some feeds drop the leading caret,
// so we match the bare code too. None of these collide with a real equity ticker.
const INDEX = new Set(['IXIC', 'GSPC', 'DJI', 'DJIA', 'NDX', 'RUT', 'VIX', 'FTSE', 'N225', 'HSI', 'GDAXI', 'FCHI', 'STOXX', 'SPX']);

// Yahoo-style asset classes the equity/crypto logo CDNs simply don't carry: indices
// (^IXIC), futures (GC=F), forex (EURUSD=X). Must be detected from the RAW symbol —
// cleanSymbol strips the very suffixes that identify them. Returning no sources makes
// the card draw its monogram WITHOUT requesting a logo, which is what stops the 404
// console flood for these tickers (the browser logs a failed <img> before onError fires).
const isNonEquity = (raw: string): boolean => raw.startsWith('^') || /=[FX]$/i.test(raw);

/** Ordered candidate logo URLs for a symbol (best/cleanest first). Pure. */
export const symbolLogoSources = (symbolRaw: string, kindHint?: 'stock' | 'crypto'): string[] => {
  const raw = (symbolRaw || '').trim();
  if (!raw || isNonEquity(raw)) return [];

  const up = cleanSymbol(raw);
  if (!up || INDEX.has(up)) return [];

  // Crypto: explicit hint, a known coin/alias, or a Yahoo pair like BTC-USD / ETH-USDT.
  // The quote side is restricted to fiat/major coins so a dual-class stock such as BRK-B
  // isn't mistaken for a crypto pair.
  const pair = up.match(/^([A-Z0-9]{2,10})-(?:USD[TC]?|EUR|GBP|BTC|ETH)$/);
  if (kindHint === 'crypto' || CRYPTO.has(up) || up in CRYPTO_ALIAS || pair) {
    const base = pair ? pair[1] : (CRYPTO_ALIAS[up] ?? up).replace(/USD$/, '');
    return [`https://assets.parqet.com/logos/crypto/${base}`];
  }

  // Strip a US exchange suffix (BRK.B stays valid; only drop things like ".US").
  const ticker = up.replace(/\.(US|N|O|OQ|NYSE|NASDAQ)$/i, '');
  return [
    `https://assets.parqet.com/logos/symbol/${ticker}`,
    `https://financialmodelingprep.com/image-stock/${ticker}.png`
  ];
};

const seededGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 60%), hsl(${(h + 40) % 360} 45% 48%))`;
};
const initialsOf = (symbol?: string, name?: string): string => {
  if (name) {
    const words = name.replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    if (words.length) return words.slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  }
  return (symbol ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
};

// Session memory of URLs that have already failed, so re-renders skip straight to the
// next candidate / fallback instead of flashing a broken image again.
const DEAD = new Set<string>();

export interface SymbolLogoProps {
  symbol: string;
  name?: string;
  size?: number;
  kind?: 'stock' | 'crypto';
  /** Tailwind rounding for the frame (default rounded-xl). */
  rounded?: string;
  className?: string;
}

export const SymbolLogo: React.FC<SymbolLogoProps> = ({ symbol, name, size = 36, kind, rounded = 'rounded-xl', className = '' }) => {
  const sources = symbolLogoSources(symbol, kind).filter((u) => !DEAD.has(u));
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [symbol, kind]);

  const src = sources[idx];
  const style = { width: size, height: size } as const;

  if (src) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-[var(--ds-hairline-soft)] ${rounded} ${className}`} style={style}>
        <img
          src={src}
          alt={name || symbol}
          width={size}
          height={size}
          loading="lazy"
          className="h-full w-full object-contain p-[3px]"
          onError={() => {
            DEAD.add(src);
            setIdx((i) => i + 1);
          }}
        />
      </span>
    );
  }

  // Fallback — the calm seeded-gradient monogram (matches the prior look everywhere).
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-bold text-white ${rounded} ${className}`}
      style={{ ...style, background: seededGradient(symbol || name || '?'), fontSize: Math.round(size * 0.32) }}
      aria-label={name || symbol}
    >
      {initialsOf(symbol, name)}
    </span>
  );
};
