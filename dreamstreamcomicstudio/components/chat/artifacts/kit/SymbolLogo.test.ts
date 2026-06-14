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
});
