import { describe, it, expect } from 'vitest';
import { sanitizePlan, selectAgentsHeuristic, getAgent, AGENTS } from './registry.js';
import { KNOWN_TOOL_NAMES } from '../tools/registry.js';

describe('agent registry integrity', () => {
  it('every agent only references allowlisted tools', () => {
    for (const agent of Object.values(AGENTS)) {
      for (const tool of agent.toolNames) {
        expect(KNOWN_TOOL_NAMES).toContain(tool);
      }
    }
  });
});

describe('sanitizePlan', () => {
  it('keeps valid agents and fills missing tasks with the goal', () => {
    const plan = sanitizePlan(
      [
        { agent: 'news', task: 'find AI headlines' },
        { agent: 'finance', task: '' }
      ],
      'fallback goal'
    );
    expect(plan).toEqual([
      { agent: 'news', task: 'find AI headlines' },
      { agent: 'finance', task: 'fallback goal' }
    ]);
  });

  it('drops unknown agents and deduplicates', () => {
    const plan = sanitizePlan(
      [
        { agent: 'news', task: 'a' },
        { agent: 'nonsense', task: 'b' },
        { agent: 'news', task: 'c' }
      ],
      'g'
    );
    expect(plan).toEqual([{ agent: 'news', task: 'a' }]);
  });

  it('is case-insensitive on agent ids and caps at 4', () => {
    const plan = sanitizePlan(
      [
        { agent: 'NEWS', task: 't' },
        { agent: 'Finance', task: 't' },
        { agent: 'weather', task: 't' },
        { agent: 'tech', task: 't' },
        { agent: 'research', task: 't' }
      ],
      'g'
    );
    expect(plan).toHaveLength(4);
    expect(plan[0].agent).toBe('news');
  });

  it('returns [] for non-array input', () => {
    expect(sanitizePlan('nope', 'g')).toEqual([]);
    expect(sanitizePlan(null, 'g')).toEqual([]);
  });
});

describe('selectAgentsHeuristic', () => {
  it('routes weather + news goals to the right agents', () => {
    const ids = selectAgentsHeuristic("what's the latest news and weather in Tokyo").map((p) => p.agent);
    expect(ids).toContain('news');
    expect(ids).toContain('weather');
    expect(ids).toContain('research'); // always included for breadth
  });

  it('routes finance keywords to the finance agent', () => {
    expect(selectAgentsHeuristic('how is the stock market and bitcoin price').map((p) => p.agent)).toContain('finance');
  });

  it('falls back to research alone for a generic goal', () => {
    expect(selectAgentsHeuristic('explain quantum tunneling').map((p) => p.agent)).toEqual(['research']);
  });

  it('never returns more than 4 agents', () => {
    const ids = selectAgentsHeuristic('news weather stocks tech near me restaurants ai gadgets');
    expect(ids.length).toBeLessThanOrEqual(4);
  });
});

describe('getAgent', () => {
  it('resolves known ids and rejects unknown', () => {
    expect(getAgent('news')?.name).toBe('News Analyst');
    expect(getAgent('ghost')).toBeUndefined();
  });
});
