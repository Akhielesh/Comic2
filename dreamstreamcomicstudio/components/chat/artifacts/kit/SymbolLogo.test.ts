import { describe, it, expect } from 'vitest';
import { symbolLogoSources } from './SymbolLogo';

describe('symbolLogoSources', () => {
  it('returns stock logo CDN candidates for a plain ticker', () => {
    const out = symbolLogoSources('AAPL');
    expect(out[0]).toBe('https://assets.parqet.com/logos/symbol/AAPL');
    expect(out.some((u) => u.includes('financialmodelingprep.com/image-stock/AAPL.png'))).toBe(true);
  });

  it('routes known crypto tickers (and aliases) to the crypto path', () => {
    expect(symbolLogoSources('BTC')[0]).toBe('https://assets.parqet.com/logos/crypto/BTC');
    expect(symbolLogoSources('bitcoin')[0]).toBe('https://assets.parqet.com/logos/crypto/BTC');
    expect(symbolLogoSources('ETHUSD')[0]).toBe('https://assets.parqet.com/logos/crypto/ETH');
  });

  it('honours an explicit crypto kind hint', () => {
    expect(symbolLogoSources('PEPE', 'crypto')[0]).toBe('https://assets.parqet.com/logos/crypto/PEPE');
  });

  it('uppercases and strips junk, and returns nothing for an empty symbol', () => {
    expect(symbolLogoSources(' aapl ')[0]).toBe('https://assets.parqet.com/logos/symbol/AAPL');
    expect(symbolLogoSources('!!!')).toEqual([]);
    expect(symbolLogoSources('')).toEqual([]);
  });

  it('returns no sources for indices, futures and forex (these CDNs have no logo → 404)', () => {
    // Indices — with caret (^GSPC) and the bare code some feeds send (IXIC).
    expect(symbolLogoSources('^GSPC')).toEqual([]);
    expect(symbolLogoSources('^IXIC')).toEqual([]);
    expect(symbolLogoSources('DJI')).toEqual([]);
    // Futures (GC=F → GCF) and forex (EURUSD=X → EURUSDX) — the exact symbols that 404'd.
    expect(symbolLogoSources('GC=F')).toEqual([]);
    expect(symbolLogoSources('NG=F')).toEqual([]);
    expect(symbolLogoSources('EURUSD=X')).toEqual([]);
  });

  it('routes Yahoo crypto pairs (BTC-USD, ETH-USDT) to the crypto path by base coin', () => {
    expect(symbolLogoSources('BTC-USD')[0]).toBe('https://assets.parqet.com/logos/crypto/BTC');
    expect(symbolLogoSources('ETH-USDT')[0]).toBe('https://assets.parqet.com/logos/crypto/ETH');
  });

  it('does NOT mistake a dual-class stock ticker (BRK-B) for a crypto pair', () => {
    expect(symbolLogoSources('BRK-B')[0]).toBe('https://assets.parqet.com/logos/symbol/BRK-B');
  });
});
