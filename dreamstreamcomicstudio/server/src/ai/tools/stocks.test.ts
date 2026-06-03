import { describe, it, expect } from 'vitest';
import { normalizeSymbol, parseStooqQuoteCsv, parseStooqHistoryCsv } from './stocks.js';

describe('normalizeSymbol', () => {
  it('appends .us to plain US tickers', () => {
    expect(normalizeSymbol('AAPL')).toBe('aapl.us');
    expect(normalizeSymbol('tsla')).toBe('tsla.us');
  });
  it('passes through indices and already-suffixed symbols', () => {
    expect(normalizeSymbol('^SPX')).toBe('^spx');
    expect(normalizeSymbol('eurusd')).toBe('eurusd'); // 6 chars, not 1-5 alpha
    expect(normalizeSymbol('BTC.V')).toBe('btc.v');
  });
});

describe('parseStooqQuoteCsv', () => {
  const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nAAPL.US,2026-06-03,22:00:05,200.5,205.1,199.8,204.2,51000000,APPLE';
  it('parses a quote row', () => {
    const q = parseStooqQuoteCsv(csv);
    expect(q?.symbol).toBe('AAPL.US');
    expect(q?.close).toBe(204.2);
    expect(q?.open).toBe(200.5);
    expect(q?.volume).toBe(51000000);
    expect(q?.name).toBe('APPLE');
  });
  it('returns null for an unknown symbol (N/D)', () => {
    const nd = 'Symbol,Date,Time,Open,High,Low,Close,Volume,Name\nZZZZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D,';
    expect(parseStooqQuoteCsv(nd)).toBeNull();
  });
  it('returns null for empty input', () => {
    expect(parseStooqQuoteCsv('')).toBeNull();
  });
});

describe('parseStooqHistoryCsv', () => {
  const csv =
    'Date,Open,High,Low,Close,Volume\n' +
    '2026-05-30,100,101,99,100.5,1000\n' +
    '2026-05-31,100.5,102,100,101.2,1100\n' +
    '2026-06-01,101.2,103,101,102.8,1200';
  it('extracts the closing series', () => {
    const pts = parseStooqHistoryCsv(csv);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ date: '2026-05-30', close: 100.5 });
    expect(pts[2].close).toBe(102.8);
  });
  it('respects the limit, keeping the most recent', () => {
    const pts = parseStooqHistoryCsv(csv, 2);
    expect(pts).toHaveLength(2);
    expect(pts[0].date).toBe('2026-05-31');
  });
});
