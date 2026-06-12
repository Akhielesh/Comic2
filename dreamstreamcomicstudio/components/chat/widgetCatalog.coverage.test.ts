import { describe, it, expect } from 'vitest';
import { REFRESHABLE_TOOLS } from '../../apiTypes';
import { AI_CHAT_TILE, WIDGET_BY_TOOL, WIDGET_CATALOG, buildTileFromFields, searchWidgets } from './widgetCatalog';

// The other half of the "everything is addable" contract: every refreshable
// live-data tool MUST appear in the dashboard's Add-widget catalog. If you
// whitelist a new tool in REFRESHABLE_TOOLS without a catalog entry, this fails.
describe('widget catalog coverage', () => {
  it('covers every REFRESHABLE_TOOL', () => {
    const missing = REFRESHABLE_TOOLS.filter((t) => !WIDGET_BY_TOOL[t]);
    expect(missing).toEqual([]);
  });

  it('includes the AI chat tile and has no duplicate tools', () => {
    expect(WIDGET_BY_TOOL[AI_CHAT_TILE]).toBeTruthy();
    const tools = WIDGET_CATALOG.map((w) => w.tool);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('every entry has picker copy and a category', () => {
    for (const w of WIDGET_CATALOG) {
      expect(w.label.length).toBeGreaterThan(1);
      expect(w.blurb.length).toBeGreaterThan(4);
      expect(w.category.length).toBeGreaterThan(2);
    }
  });
});

describe('searchWidgets', () => {
  it('filters by label/blurb/category, case-insensitive', () => {
    expect(searchWidgets('').length).toBe(WIDGET_CATALOG.length);
    expect(searchWidgets('CRYPTO').some((w) => w.tool === 'crypto_price')).toBe(true);
    expect(searchWidgets('directions').map((w) => w.tool)).toContain('get_directions');
    expect(searchWidgets('zzz-no-match')).toEqual([]);
  });
});

describe('buildTileFromFields', () => {
  it('requires non-optional fields', () => {
    const weather = WIDGET_BY_TOOL.get_weather;
    expect(buildTileFromFields(weather, {}, 'compact')).toBeNull();
    const tile = buildTileFromFields(weather, { location: 'Tokyo' }, 'detailed');
    expect(tile).toEqual({ tool: 'get_weather', args: { location: 'Tokyo' }, label: 'Tokyo', density: 'detailed' });
  });

  it('splits list fields and shapes portfolio holdings', () => {
    const map = buildTileFromFields(WIDGET_BY_TOOL.show_map, { places: 'Eiffel Tower, Louvre' }, 'detailed');
    expect(map?.args.places).toEqual(['Eiffel Tower', 'Louvre']);
    const pf = buildTileFromFields(WIDGET_BY_TOOL.build_portfolio, { holdings: 'aapl, nvda' }, 'detailed');
    expect(pf?.args.holdings).toEqual([{ symbol: 'AAPL' }, { symbol: 'NVDA' }]);
  });

  it('lets a news query override the section', () => {
    const def = WIDGET_BY_TOOL.get_news;
    const tile = buildTileFromFields(def, { topic: 'top', query: 'AI chips' }, 'compact');
    expect(tile?.args).toEqual({ query: 'AI chips' });
    const sectionOnly = buildTileFromFields(def, { topic: 'business' }, 'compact');
    expect(sectionOnly?.args).toEqual({ topic: 'business' });
  });

  it('zero-config widgets build instantly with empty args', () => {
    const tile = buildTileFromFields(WIDGET_BY_TOOL.get_yield_curve, {}, 'compact');
    expect(tile).toEqual({ tool: 'get_yield_curve', args: {}, label: 'Yield curve', density: 'compact' });
  });
});
