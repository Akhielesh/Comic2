import { describe, it, expect } from 'vitest';
import { parseDashboardCommand, extractTopic } from './dashboardAi';

describe('parseDashboardCommand — edits', () => {
  it('parses "change weather to Tokyo"', () => {
    const p = parseDashboardCommand('change weather to Tokyo');
    expect(p).toMatchObject({ kind: 'edit', tool: 'get_weather', args: { location: 'Tokyo' } });
  });
  it('parses "set the stocks widget to NVDA"', () => {
    const p = parseDashboardCommand('set the stocks widget to NVDA');
    expect(p).toMatchObject({ kind: 'edit', tool: 'get_stock', args: { symbol: 'NVDA' } });
  });
  it('parses "change news to AI chips"', () => {
    expect(parseDashboardCommand('change news to AI chips')).toMatchObject({
      kind: 'edit', tool: 'get_news', args: { query: 'AI chips' }
    });
  });
  it('parses crypto and fx', () => {
    expect(parseDashboardCommand('switch crypto to solana')).toMatchObject({ kind: 'edit', tool: 'crypto_price', args: { coin: 'solana' } });
    expect(parseDashboardCommand('change fx to USD to EUR')).toMatchObject({ kind: 'edit', tool: 'exchange_rate', args: { from: 'USD', to: 'EUR' } });
  });
});

describe('parseDashboardCommand — board templates', () => {
  it('builds a study board with the topic', () => {
    const p = parseDashboardCommand('build me a study dashboard for machine learning');
    expect(p.kind).toBe('create');
    if (p.kind === 'create') {
      expect(p.name).toBe('Study · machine learning');
      expect(p.tiles.map((t) => t.tool)).toEqual(['video_search', 'get_news']);
      expect(p.tiles[0].args.query).toBe('machine learning tutorial');
    }
  });
  it('builds a trip board around the city', () => {
    const p = parseDashboardCommand('plan a trip to Lisbon');
    if (p.kind === 'create') {
      expect(p.name).toBe('Trip · Lisbon');
      expect(p.tiles.some((t) => t.tool === 'get_weather' && t.args.location === 'Lisbon')).toBe(true);
      expect(p.tiles.some((t) => t.tool === 'show_map')).toBe(true);
    } else {
      expect.fail('expected create');
    }
  });
  it('builds markets and cooking boards', () => {
    expect(parseDashboardCommand('markets snapshot')).toMatchObject({ kind: 'create', name: 'Markets' });
    const cook = parseDashboardCommand('cook dinner: pad thai');
    if (cook.kind === 'create') expect(cook.tiles[0].args.query).toContain('pad thai');
  });
  it('falls back to a generic topic board', () => {
    const p = parseDashboardCommand('quantum computing');
    expect(p.kind).toBe('create');
    if (p.kind === 'create') expect(p.tiles.map((t) => t.tool)).toContain('get_news');
  });
  it('rejects empty commands', () => {
    expect(parseDashboardCommand('   ').kind).toBe('error');
  });
});

describe('extractTopic', () => {
  it('strips filler down to the subject', () => {
    expect(extractTopic('build me a study dashboard for linear algebra')).toBe('linear algebra');
    expect(extractTopic('create a board about coffee')).toBe('coffee');
  });
});
