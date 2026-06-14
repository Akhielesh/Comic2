import { describe, it, expect } from 'vitest';
import { resolveStockSymbol, coerceSymbol } from './symbolResolve';

describe('resolveStockSymbol', () => {
  it('maps company names to tickers', () => {
    expect(resolveStockSymbol('rivian')?.symbol).toBe('RIVN');
    expect(resolveStockSymbol('Tesla')?.symbol).toBe('TSLA');
    expect(resolveStockSymbol('bank of america')?.symbol).toBe('BAC');
  });
  it('maps indices and commodities', () => {
    expect(resolveStockSymbol('s&p 500')?.symbol).toBe('^GSPC');
    expect(resolveStockSymbol('gold')?.symbol).toBe('gold');
  });
  it('passes through a bare ticker', () => {
    expect(resolveStockSymbol('AAPL')?.symbol).toBe('AAPL');
    expect(resolveStockSymbol('brk.b')?.symbol).toBe('BRK.B');
  });
  it('returns null for non-asset phrases', () => {
    expect(resolveStockSymbol('the weather today')).toBeNull();
    expect(resolveStockSymbol('')).toBeNull();
  });
});

describe('coerceSymbol', () => {
  it('resolves a name but leaves unknown / special symbols untouched', () => {
    expect(coerceSymbol('rivian')).toBe('RIVN');
    expect(coerceSymbol('^GSPC')).toBe('^GSPC');
    expect(coerceSymbol('BTC-USD')).toBe('BTC-USD');
    expect(coerceSymbol('some unknown thing')).toBe('some unknown thing');
  });
});
