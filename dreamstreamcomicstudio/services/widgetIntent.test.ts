import { describe, it, expect } from 'vitest';
import { resolveWidgetIntent, quickPickSuggestions } from './widgetIntent';

// The top suggestion for a phrase — what one tap would pin.
const top = (q: string) => resolveWidgetIntent(q)[0];

describe('resolveWidgetIntent', () => {
  it('resolves a company name to its stock ticker (the "rivian" case)', () => {
    const s = top('rivian');
    expect(s.def.tool).toBe('get_stock');
    expect(s.args.symbol).toBe('RIVN');
    expect(s.ready).toBe(true);
  });

  it('handles "<company> stock" phrasing', () => {
    expect(top('tesla stock').args.symbol).toBe('TSLA');
    expect(top('apple share price').args.symbol).toBe('AAPL');
  });

  it('maps indices and commodities', () => {
    expect(top('s&p 500').args.symbol).toBe('^GSPC');
    expect(top('gold').args.symbol).toBe('gold');
  });

  it('routes crypto by name or ticker to crypto_price', () => {
    expect(top('bitcoin').def.tool).toBe('crypto_price');
    expect(top('bitcoin').args.coin).toBe('bitcoin');
    expect(top('eth').args.coin).toBe('ethereum');
  });

  it('extracts a weather location', () => {
    const s = top('weather tokyo');
    expect(s.def.tool).toBe('get_weather');
    expect(s.args.location).toBe('tokyo');
    expect(s.ready).toBe(true);
  });

  it('weather with no location opens config instead of erroring', () => {
    const s = top('weather');
    expect(s.def.tool).toBe('get_weather');
    expect(s.ready).toBe(false);
  });

  it('routes news, with sections and free topics', () => {
    expect(top('top news').def.tool).toBe('get_news');
    expect(top('business news').args.topic).toBe('business');
    expect(top('ai news').args.query).toBe('ai');
  });

  it('parses currency pairs', () => {
    const s = top('usd to eur');
    expect(s.def.tool).toBe('exchange_rate');
    expect(s.args).toMatchObject({ from: 'USD', to: 'EUR' });
  });

  it('parses a comparison into compare_stocks', () => {
    const s = top('compare nvidia vs amd');
    expect(s.def.tool).toBe('compare_stocks');
    expect(s.args.symbols).toEqual(['NVDA', 'AMD']);
  });

  it('names direct no-config tools', () => {
    expect(top('fear and greed').def.tool).toBe('get_market_sentiment');
    expect(top('yield curve').def.tool).toBe('get_yield_curve');
  });

  it('falls back to a catalog match for vague input', () => {
    const s = top('portfolio');
    expect(s).toBeTruthy();
    expect(s.def.tool).toBeTruthy();
  });

  it('turns a pasted video link into a playable embed suggestion', () => {
    const s = top('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(s.def.tool).toBe('embed');
    expect(s.args.url).toContain('youtube.com');
    expect(s.ready).toBe(true);
  });

  it('returns nothing for an empty query, and quick picks are available', () => {
    expect(resolveWidgetIntent('')).toEqual([]);
    expect(quickPickSuggestions().length).toBeGreaterThan(0);
  });
});
