// @vitest-environment node
// Gate L3 / S9: the in-chat meta-tools (run_agent_swarm, delegate_tasks, deep_research) make
// their own paid model calls (planner, helper agents, synthesis). Their usage must reach the chat
// turn's settle: each tool returns the engine's usage (and, when the engine failed part-way, what
// it had already spent). Before the fix they returned only content/citations/artifacts — $0.
import { describe, expect, it, vi } from 'vitest';

const engines = vi.hoisted(() => ({
  swarm: vi.fn(),
  delegate: vi.fn(),
  research: vi.fn()
}));
vi.mock('./orchestrator.js', () => ({ runSwarm: engines.swarm }));
vi.mock('./delegate.js', () => ({ runDelegation: engines.delegate }));
vi.mock('../research/deepResearch.js', () => ({ runDeepResearch: engines.research }));

const { makeSwarmTool } = await import('./swarmTool.js');
const { makeDelegateTool } = await import('./delegateTool.js');
const { makeDeepResearchTool } = await import('../research/deepResearchTool.js');
const { withSpentUsage } = await import('../usage.js');

const ctx = { provider: 'openrouter' as const, apiKey: 'k', model: 'acme/strong', fallbackModel: 'openai/gpt-4o-mini' };
const usage = { promptTokens: 9_000, candidatesTokens: 1_000, totalTokens: 10_000, providerCostUsd: 0.42 };

describe('meta-tools report their nested usage', () => {
  it('run_agent_swarm returns the swarm’s summed usage', async () => {
    engines.swarm.mockResolvedValueOnce({ text: 'Team answer', trace: { agents: [{ name: 'News', status: 'done' }] }, citations: [], artifacts: [], usage });
    const out = await makeSwarmTool(ctx).execute({ goal: 'brief me' });
    expect(out.usage).toEqual(usage);
    expect(out.content).not.toContain('0.42'); // usage never reaches the model-facing text
  });

  it('delegate_tasks returns the helpers’ summed usage', async () => {
    engines.delegate.mockResolvedValueOnce({ text: 'Aggregated', trace: { agents: [{ status: 'done' }] }, citations: [], artifacts: [], usage });
    const out = await makeDelegateTool(ctx).execute({ goal: 'compare', subtasks: ['a', 'b'] });
    expect(out.usage).toEqual(usage);
  });

  it('deep_research returns the research engine’s usage', async () => {
    engines.research.mockResolvedValueOnce({
      text: 'Brief',
      report: { sourceCount: 3, readCount: 2 },
      trace: { agents: [] },
      citations: [],
      usage
    });
    const out = await makeDeepResearchTool(ctx).execute({ topic: 'tides' });
    expect(out.usage).toEqual(usage);
  });

  it('a run that failed part-way still reports what it had spent', async () => {
    const spent = { promptTokens: 5_000, candidatesTokens: 100, totalTokens: 5_100, providerCostUsd: 0.2 };
    engines.swarm.mockRejectedValueOnce(withSpentUsage(new Error('synthesis failed'), spent));
    engines.delegate.mockRejectedValueOnce(withSpentUsage(new Error('aggregate failed'), spent));
    engines.research.mockRejectedValueOnce(withSpentUsage(new Error('synth failed'), spent));
    expect((await makeSwarmTool(ctx).execute({ goal: 'x' })).usage).toEqual(spent);
    expect((await makeDelegateTool(ctx).execute({ goal: 'x', subtasks: ['a'] })).usage).toEqual(spent);
    expect((await makeDeepResearchTool(ctx).execute({ topic: 'x' })).usage).toEqual(spent);
  });

  it('a run that spent nothing reports nothing', async () => {
    engines.swarm.mockRejectedValueOnce(new Error('planner down'));
    expect((await makeSwarmTool(ctx).execute({ goal: 'x' })).usage).toBeUndefined();
  });
});

// UB-2 class: a free-only (X-Free-Only) /api/chat turn builds these meta-tools with noPaidRetry and no
// fallbackModel; each tool hands it to its engine, which then never retries on (or picks) a paid model.
describe('meta-tools carry free-only to their engines', () => {
  const freeCtx = { provider: 'openrouter' as const, apiKey: 'k', model: 'meta-llama/llama-3.3-70b-instruct:free', noPaidRetry: true };
  const done = { text: 'ok', trace: { agents: [] }, report: { sourceCount: 0, readCount: 0 }, citations: [], artifacts: [], usage };

  it('run_agent_swarm, delegate_tasks and deep_research pass noPaidRetry and no paid fallback', async () => {
    engines.swarm.mockResolvedValueOnce(done);
    engines.delegate.mockResolvedValueOnce(done);
    engines.research.mockResolvedValueOnce(done);
    await makeSwarmTool(freeCtx).execute({ goal: 'brief me' });
    await makeDelegateTool(freeCtx).execute({ goal: 'compare', subtasks: ['a', 'b'] });
    await makeDeepResearchTool(freeCtx).execute({ topic: 'tides' });
    // Without the fix: noPaidRetry never reached the engines.
    for (const engine of [engines.swarm, engines.delegate, engines.research]) {
      expect(engine.mock.lastCall?.[0]).toMatchObject({ noPaidRetry: true, fallbackModel: undefined });
    }
  });

  it('off: the engines keep the paid net they were given', async () => {
    engines.swarm.mockResolvedValueOnce(done);
    engines.delegate.mockResolvedValueOnce(done);
    engines.research.mockResolvedValueOnce(done);
    await makeSwarmTool(ctx).execute({ goal: 'brief me' });
    await makeDelegateTool(ctx).execute({ goal: 'compare', subtasks: ['a', 'b'] });
    await makeDeepResearchTool(ctx).execute({ topic: 'tides' });
    for (const engine of [engines.swarm, engines.delegate, engines.research]) {
      expect(engine.mock.lastCall?.[0]).toMatchObject({ fallbackModel: 'openai/gpt-4o-mini' });
      expect(engine.mock.lastCall?.[0].noPaidRetry).toBeUndefined();
    }
  });
});
