import { describe, it, expect } from 'vitest';
import {
  TOOL_CATALOG, CATEGORY_META, getToolMeta, scoreTools, selectRelevantTools,
  ROUTABLE_TOOL_NAMES, ALL_TOOL_NAMES
} from './toolCatalog';

describe('tool catalogue integrity', () => {
  it('has unique tool names', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool belongs to a declared category, and every category has tools', () => {
    const catIds = new Set(CATEGORY_META.map((c) => c.id));
    for (const t of TOOL_CATALOG) expect(catIds.has(t.category)).toBe(true);
    for (const c of CATEGORY_META) {
      expect(TOOL_CATALOG.some((t) => t.category === c.id)).toBe(true);
    }
  });

  it('every tool carries the metadata the dashboard needs', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.label).toBeTruthy();
      expect(t.provider).toBeTruthy();
      expect(t.rateLimit).toBeTruthy();
      expect(t.dataShape).toBeTruthy();
      expect(t.docsUrl).toMatch(/^https?:\/\//);
      expect(t.keywords.length).toBeGreaterThan(0);
      expect(['none', 'optional', 'required']).toContain(t.auth);
      expect(['api', 'mcp', 'builtin']).toContain(t.kind);
    }
  });

  it('ships at least 30 integrated tools plus the originals', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(40);
    expect(ALL_TOOL_NAMES).toContain('crypto_price');
    expect(getToolMeta('nasa_apod')?.authEnv).toBe('NASA_API_KEY');
  });
});

describe('scoreTools (smart routing)', () => {
  const topNames = (text: string, n = 1) => scoreTools(text).slice(0, n).map((s) => s.name);

  it('routes domain questions to the right tool', () => {
    expect(topNames('how much is bitcoin worth today')).toContain('crypto_price');
    expect(topNames('define the word ephemeral')).toContain('define_word');
    expect(topNames('give me a recipe for carbonara')).toContain('find_recipe');
    expect(topNames('what is the capital of japan and its population')).toContain('country_info');
    expect(topNames('search github for a rust http library', 2)).toContain('github_repo');
    expect(topNames('where is the ISS right now')).toContain('iss_location');
  });

  it('surfaces search_flights for natural flight queries WITHOUT the word "flight"', () => {
    // The real failure: this query routed to web_search because no keyword matched.
    expect(topNames('best deal from iad to bengaluru for july 7th one way', 3)).toContain('search_flights');
    expect(topNames('cheapest flights to tokyo round trip', 3)).toContain('search_flights');
    expect(topNames('fly from SFO to London nonstop', 3)).toContain('search_flights');
  });

  it('returns nothing for a message with no tool intent', () => {
    expect(scoreTools('please rewrite this paragraph to be more concise')).toEqual([]);
  });
});

describe('selectRelevantTools (server-side narrowing)', () => {
  it('passes small enabled sets through unchanged', () => {
    const enabled = ['web_search', 'get_news'];
    expect(selectRelevantTools('anything', enabled, 10)).toEqual(enabled);
  });

  it('narrows a large enabled set to the most relevant, capped at max', () => {
    const enabled = ROUTABLE_TOOL_NAMES.slice();
    const picked = selectRelevantTools('convert 100 usd to eur', enabled, 5);
    expect(picked.length).toBeLessThanOrEqual(5);
    expect(picked).toContain('exchange_rate');
  });

  it('always preserves the swarm meta-tool when enabled', () => {
    const enabled = [...ROUTABLE_TOOL_NAMES, 'run_agent_swarm'];
    const picked = selectRelevantTools('plan and execute a deep dive on EVs', enabled, 6);
    expect(picked).toContain('run_agent_swarm');
  });

  it('falls back to web_search when nothing matches but it is enabled', () => {
    const enabled = ROUTABLE_TOOL_NAMES.slice();
    const picked = selectRelevantTools('zzz qqq no intent here', enabled, 4);
    expect(picked).toContain('web_search');
  });
});
