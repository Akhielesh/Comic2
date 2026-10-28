// @vitest-environment node
// Gate follow-up (F1 review, the L3 residual): the swarm orchestrator and task delegation make many
// model calls — the planner, every agent (with one retry), the synthesis. When one of those calls
// threw, what it had already spent was dropped from the run's merged usage; and when the RUNNER
// threw (synthesis failed, a progress callback threw after the agents had run) everything the run
// had spent was dropped, so the chat turn released its hold over real platform spend. Now every
// caught failure's spend (ai/usage.ts spentUsageOf) joins the merged usage, and a rethrow carries
// the merged spend (withSpentUsage) so the turn settles it. A merged usage is exact only when every
// part reported a cost; otherwise the reported part survives as the settle's floor.
// No provider or network: runChat, the model picker and the tool registry are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiUsage } from '../../../../apiTypes.js';

vi.mock('../autoRouter.js', () => ({
  pickTextModel: vi.fn(async () => 'free/worker'),
  TEXT_FALLBACK: 'fallback/model'
}));
vi.mock('../persona.js', () => ({ composePersona: (s: string) => s, withAgentPersona: (s: string) => s }));
// Agents get no real tools (nothing external could run); the registry's tool names stay real.
vi.mock('../tools/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/registry.js')>()),
  resolveTools: () => []
}));

const runChatMock = vi.fn();
vi.mock('../chat.js', () => ({ runChat: (...args: unknown[]) => runChatMock(...args) }));

const { runSwarm } = await import('./orchestrator.js');
const { runDelegation } = await import('./delegate.js');
const { spentUsageOf, withSpentUsage } = await import('../usage.js');

/** A usage record with a reported cost (what an OpenRouter runChat reports). */
const u = (providerCostUsd: number, totalTokens: number): ApiUsage => ({
  promptTokens: totalTokens - 10,
  candidatesTokens: 10,
  totalTokens,
  providerCostUsd
});
const partial = (err: unknown) => (spentUsageOf(err) as { partialProviderCostUsd?: number } | undefined)?.partialProviderCostUsd;

// One custom agent with no tools: the planner's JSON names it, so the run is exactly
// planner → agent (→ retry) → synthesis, in that call order.
const probe = { id: 'probe', name: 'Probe', description: 'Looks things up.', systemPrompt: 'You probe.', toolNames: [] as string[] };
const swarmParams = {
  provider: 'openrouter' as const,
  apiKey: 'k',
  model: 'user/model',
  messages: [{ role: 'user' as const, content: 'Brief me on the probe.' }],
  extraAgents: [probe]
};
const plan = { text: '[{"agent":"probe","task":"look it up"}]', usage: u(0.01, 100) };

beforeEach(() => {
  runChatMock.mockReset();
});

describe('runSwarm never drops nested spend', () => {
  it('an agent that failed (both attempts) still bills what each attempt spent', async () => {
    runChatMock
      .mockResolvedValueOnce(plan)
      .mockRejectedValueOnce(withSpentUsage(new Error('blip'), u(0.2, 2_000)))
      .mockRejectedValueOnce(withSpentUsage(new Error('blip again'), u(0.3, 3_000)))
      .mockResolvedValueOnce({ text: 'Synthesized.', model: 'user/model', usage: u(0.05, 500) });
    const res = await runSwarm(swarmParams);
    expect(runChatMock).toHaveBeenCalledTimes(4); // planner, agent, its retry, synthesis
    expect(res.trace.agents.map((a) => a.status)).toEqual(['error']);
    expect(res.text).toBe('Synthesized.');
    expect(res.usage.providerCostUsd).toBeCloseTo(0.56, 9);
    expect(res.usage.totalTokens).toBe(5_600);
  });

  it('a synthesis failure rethrows with everything the run had spent (planner, agent, the failed call)', async () => {
    runChatMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ text: 'Agent finding.', usage: u(0.2, 2_000) })
      .mockRejectedValueOnce(withSpentUsage(new Error('synthesis failed'), u(0.05, 500)));
    const err = await runSwarm(swarmParams).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('synthesis failed');
    expect(spentUsageOf(err)?.providerCostUsd).toBeCloseTo(0.26, 9);
    expect(spentUsageOf(err)?.totalTokens).toBe(2_600);
  });

  it('a progress callback that throws after the agents ran (a closed SSE socket) never erases their spend', async () => {
    runChatMock
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ text: 'Agent finding.', usage: u(0.2, 2_000) })
      .mockResolvedValueOnce({ text: 'never reached', usage: u(9, 9_000) });
    const err = await runSwarm({
      ...swarmParams,
      onProgress: (trace) => {
        if (trace.agents.some((a) => a.status === 'done' || a.status === 'error')) throw new Error('write after end');
      }
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('write after end');
    expect(spentUsageOf(err)?.providerCostUsd).toBeCloseTo(0.21, 9);
  });

  it('a run that spent nothing rethrows its error unchanged (nothing to settle)', async () => {
    runChatMock.mockRejectedValue(new Error('provider down'));
    const err = await runSwarm(swarmParams).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('provider down');
    expect(spentUsageOf(err)).toBeUndefined();
  });

  it('parts without a reported cost make the merged cost a floor, never a fake exact cost', async () => {
    runChatMock
      .mockResolvedValueOnce({ text: '[{"agent":"probe","task":"look"}]', usage: { totalTokens: 100 } })
      .mockResolvedValueOnce({ text: 'Agent finding.', usage: u(0.2, 2_000) })
      .mockResolvedValueOnce({ text: 'Synthesized.', usage: { promptTokens: 400, candidatesTokens: 100, totalTokens: 500 } });
    const res = await runSwarm(swarmParams);
    expect(res.usage.providerCostUsd).toBeUndefined();
    expect((res.usage as { partialProviderCostUsd?: number }).partialProviderCostUsd).toBeCloseTo(0.2, 9);
    expect(res.usage.totalTokens).toBe(2_600);
  });
});

describe('runDelegation never drops nested spend', () => {
  const params = {
    provider: 'openrouter' as const,
    apiKey: 'k',
    model: 'user/model',
    goal: 'Compare A and B',
    subtasks: ['look up A', 'look up B']
  };

  it('a failed helper still bills what it spent; the aggregate includes every helper', async () => {
    runChatMock
      .mockRejectedValueOnce(withSpentUsage(new Error('helper blip'), u(0.2, 2_000)))
      .mockResolvedValueOnce({ text: 'B is …', usage: u(0.1, 1_000) })
      .mockResolvedValueOnce({ text: 'Aggregated.', model: 'user/model', usage: u(0.05, 500) });
    const res = await runDelegation(params);
    expect(runChatMock).toHaveBeenCalledTimes(3);
    expect(res.trace.agents.map((a) => a.status)).toEqual(['error', 'done']);
    expect(res.notices?.some((n) => /Helper 1 failed/.test(n.message))).toBe(true);
    expect(res.usage.providerCostUsd).toBeCloseTo(0.35, 9);
    expect(res.usage.totalTokens).toBe(3_500);
  });

  it('an aggregation failure rethrows with the helpers’ spend and its own', async () => {
    runChatMock
      .mockResolvedValueOnce({ text: 'A is …', usage: u(0.2, 2_000) })
      .mockResolvedValueOnce({ text: 'B is …', usage: u(0.1, 1_000) })
      .mockRejectedValueOnce(withSpentUsage(new Error('aggregate failed'), u(0.05, 500)));
    const err = await runDelegation(params).catch((e) => e);
    expect(err.message).toBe('aggregate failed');
    expect(spentUsageOf(err)?.providerCostUsd).toBeCloseTo(0.35, 9);
    expect(partial(err)).toBeUndefined();
  });

  it('a run that spent nothing rethrows its error unchanged', async () => {
    runChatMock.mockRejectedValue(new Error('provider down'));
    const err = await runDelegation(params).catch((e) => e);
    expect(err.message).toBe('provider down');
    expect(spentUsageOf(err)).toBeUndefined();
  });

  it('a helper without a reported cost keeps the reported part as a floor', async () => {
    runChatMock
      .mockResolvedValueOnce({ text: 'A is …', usage: { totalTokens: 2_000 } })
      .mockResolvedValueOnce({ text: 'B is …', usage: u(0.1, 1_000) })
      .mockResolvedValueOnce({ text: 'Aggregated.', usage: u(0.05, 500) });
    const res = await runDelegation(params);
    expect(res.usage.providerCostUsd).toBeUndefined();
    expect((res.usage as { partialProviderCostUsd?: number }).partialProviderCostUsd).toBeCloseTo(0.15, 9);
  });
});
