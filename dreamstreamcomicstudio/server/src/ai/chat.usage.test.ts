// @vitest-environment node
// Gate S9 / L2 / L3: runChat must report the REAL provider usage of the whole turn — every
// provider call (first call, every tool round, the timeout and empty-answer retries, the JSON
// tools loop) plus what a meta-tool spent on its own nested model calls — so the route settles
// the real cost. Before the fix it returned `{promptChars, estimatedTokens}` from the last user
// message alone (a two-round $1.85 turn settled at $0.000008). A free-models-only turn never
// retries on a paid model. No network: the provider is a fake behind the gateway.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateTextRequest, GenerateTextResult } from './providers/types.js';

type Step = (req: GenerateTextRequest) => Partial<GenerateTextResult> | Error;
const fake = vi.hoisted(() => ({
  steps: [] as Step[],
  requests: [] as GenerateTextRequest[],
  streamed: 0
}));

const answer = (req: GenerateTextRequest): GenerateTextResult => {
  fake.requests.push(req);
  const step = fake.steps.shift();
  const out = step ? step(req) : { text: 'done', usage: {} };
  if (out instanceof Error) throw out;
  return { text: '', model: req.model, usage: {}, ...out } as GenerateTextResult;
};

vi.mock('./gateway.js', () => {
  const provider = {
    id: 'openrouter',
    generateText: vi.fn(async (req: GenerateTextRequest) => answer(req)),
    generateTextStream: vi.fn(async (req: GenerateTextRequest, _ctx: unknown, onDelta: (d: { content?: string }) => void) => {
      const r = answer(req);
      fake.streamed += 1;
      if (r.text) onDelta({ content: r.text });
      return r;
    }),
    generateImage: vi.fn(),
    listModels: vi.fn()
  };
  return {
    getProvider: () => provider,
    resolveProviderContext: (key?: string) => ({ apiKey: key || 'platform', byok: false })
  };
});

const { runChat, TOOL_BUDGET_NOTICE, TOOL_BUDGET_TOOL_RESULT } = await import('./chat.js');
type TurnBudgetRound = import('./chat.js').TurnBudgetRound;
const { spentUsageOf } = await import('./usage.js');
const { TEXT_FALLBACK } = await import('./autoRouter.js');

const timeout = () => Object.assign(new Error('The model took too long to respond (timed out after 50s).'), { status: 504, publicCode: 'MODEL_TIMEOUT' });

const probeTool = (usage?: Record<string, number>) => ({
  name: 'run_agent_swarm',
  description: 'probe',
  parameters: { type: 'object', properties: {} },
  execute: vi.fn(async () => ({ content: 'the agents answered', ...(usage ? { usage } : {}) }))
});

const base = {
  provider: 'openrouter' as const,
  apiKey: 'k',
  model: 'acme/strong',
  messages: [{ role: 'user' as const, content: 'hi' }],
  fallbackModel: TEXT_FALLBACK,
  timeoutMs: 50_000
};

beforeEach(() => {
  fake.steps = [];
  fake.requests = [];
  fake.streamed = 0;
});

describe('runChat reports the whole turn’s real provider usage', () => {
  it('native loop: sums every tool round and the meta-tool’s nested usage', async () => {
    fake.steps = [
      () => ({ text: '', toolCalls: [{ id: 'c1', name: 'run_agent_swarm', arguments: '{}' }], usage: { promptTokens: 100_000, completionTokens: 10, costUsd: 0.9 } }),
      () => ({ text: 'Final answer.', usage: { promptTokens: 100_500, completionTokens: 400, costUsd: 0.95 } })
    ];
    const tool = probeTool({ promptTokens: 1_000, candidatesTokens: 100, totalTokens: 1_100, providerCostUsd: 0.5 });
    const r = await runChat({ ...base, tools: [tool] });
    expect(r.text).toBe('Final answer.');
    expect(r.usage.providerCostUsd).toBeCloseTo(2.35, 9);
    expect(r.usage.promptTokens).toBe(201_500);
    expect(r.usage.candidatesTokens).toBe(510);
    expect(r.usage.estimatedTokens).toBeUndefined();
  });

  it('streaming: the same sums when deltas stream', async () => {
    fake.steps = [
      () => ({ text: '', toolCalls: [{ id: 'c1', name: 'run_agent_swarm', arguments: '{}' }], usage: { promptTokens: 1_000, completionTokens: 10, costUsd: 0.01 } }),
      () => ({ text: 'Streamed.', usage: { promptTokens: 1_200, completionTokens: 50, costUsd: 0.02 } })
    ];
    const deltas: string[] = [];
    const r = await runChat({ ...base, tools: [probeTool()], onDelta: (d) => d.content && deltas.push(d.content) });
    expect(fake.streamed).toBe(2);
    expect(deltas.join('')).toBe('Streamed.');
    expect(r.usage.providerCostUsd).toBeCloseTo(0.03, 9);
    expect(r.usage.promptTokens).toBe(2_200);
  });

  it('JSON-tools loop (direct provider): sums the loop’s calls', async () => {
    fake.steps = [
      () => ({ text: '{"name":"run_agent_swarm","arguments":{}}', usage: { promptTokens: 500, completionTokens: 20 } }),
      () => ({ text: 'Answer from the JSON loop.', usage: { promptTokens: 700, completionTokens: 60 } })
    ];
    const r = await runChat({ ...base, provider: 'anthropic', model: 'claude-x', fallbackModel: undefined, tools: [probeTool()] });
    expect(r.text).toBe('Answer from the JSON loop.');
    expect(r.usage.promptTokens).toBe(1_200);
    expect(r.usage.candidatesTokens).toBe(80);
    // No call reported a cost → settlement prices the summed tokens.
    expect(r.usage.providerCostUsd).toBeUndefined();
  });

  it('a call without token counts is estimated from the whole context it sent', async () => {
    const history = Array.from({ length: 6 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'x'.repeat(20_000) }));
    fake.steps = [() => ({ text: 'ok', usage: {} })];
    const r = await runChat({ ...base, messages: [...history, { role: 'user', content: 'and?' }] });
    // ≥ 120,000 chars of history → ≥ 30,000 prompt tokens (not "1 word ≈ 1.33 tokens of 'and?'").
    expect(r.usage.promptTokens!).toBeGreaterThanOrEqual(30_000);
  });

  it('counts the timeout retry and the empty-answer retry', async () => {
    fake.steps = [
      () => timeout(),
      () => ({ text: '', usage: { promptTokens: 300, completionTokens: 0, costUsd: 0.001 } }),
      () => ({ text: 'Recovered.', usage: { promptTokens: 300, completionTokens: 30, costUsd: 0.002 } })
    ];
    const r = await runChat({ ...base, model: 'slow/model' });
    expect(fake.requests.map((q) => q.model)).toEqual(['slow/model', TEXT_FALLBACK, TEXT_FALLBACK]);
    expect(r.text).toBe('Recovered.');
    expect(r.usage.providerCostUsd).toBeCloseTo(0.003, 9);
    expect(r.usage.promptTokens).toBe(600);
  });

  it('a turn that fails after a paid round carries what it spent on the error', async () => {
    fake.steps = [
      () => ({ text: '', toolCalls: [{ id: 'c1', name: 'run_agent_swarm', arguments: '{}' }], usage: { promptTokens: 100_000, completionTokens: 10, costUsd: 0.9 } }),
      () => Object.assign(new Error('context length exceeded'), { status: 400 })
    ];
    const err = await runChat({ ...base, tools: [probeTool()] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(spentUsageOf(err)?.providerCostUsd).toBeCloseTo(0.9, 9);
  });

  it('review: paid rounds then a final call that reported no usage keep the reported part as a floor', async () => {
    fake.steps = [
      () => ({ text: '', toolCalls: [{ id: 'c1', name: 'run_agent_swarm', arguments: '{}' }], usage: { promptTokens: 100_000, completionTokens: 10, costUsd: 0.9 } }),
      // e.g. a stream cut by the idle timeout returns its partial text with no usage chunk
      () => ({ text: 'Partial answer', model: 'free/a:free', usage: {} })
    ];
    const r = await runChat({ ...base, tools: [probeTool()], onDelta: () => undefined });
    expect(r.usage.providerCostUsd).toBeUndefined();
    expect((r.usage as { partialProviderCostUsd?: number }).partialProviderCostUsd).toBeCloseTo(0.9, 9);
  });

  it('a failure before any call carries nothing', async () => {
    fake.steps = [() => new Error('provider down')];
    const err = await runChat(base).catch((e) => e);
    expect(spentUsageOf(err)).toBeUndefined();
  });
});

describe('L2: a free-models-only turn never retries on a paid model', () => {
  it('noPaidRetry: a timeout surfaces honestly — no paid call', async () => {
    fake.steps = [() => timeout()];
    const err = await runChat({ ...base, model: 'free/a:free', fallbackModel: undefined, noPaidRetry: true }).catch((e) => e);
    expect(err?.publicCode).toBe('MODEL_TIMEOUT');
    expect(fake.requests.map((q) => q.model)).toEqual(['free/a:free']);
  });

  it('noPaidRetry: an empty answer retries the SAME free model, and the provider is told free-only', async () => {
    fake.steps = [() => ({ text: '', usage: { costUsd: 0 } }), () => ({ text: 'Free answer.', usage: { costUsd: 0 } })];
    const r = await runChat({ ...base, model: 'free/a:free', fallbackModel: undefined, fallbackModels: ['free/a:free', 'free/b:free'], noPaidRetry: true });
    expect(r.text).toBe('Free answer.');
    expect(fake.requests.map((q) => q.model)).toEqual(['free/a:free', 'free/a:free']);
    for (const q of fake.requests) {
      expect(q.freeOnly).toBe(true);
      expect(q.fallbackModel).toBeUndefined();
      expect([q.model, ...(q.models || [])].every((m) => /:free$/.test(m))).toBe(true);
    }
    expect(r.usage.providerCostUsd).toBe(0);
  });

  it('no reserved paid net (fallbackModel unset) means no engine paid retry either', async () => {
    fake.steps = [() => timeout()];
    await runChat({ ...base, model: 'free/a:free', fallbackModel: undefined }).catch(() => undefined);
    expect(fake.requests.map((q) => q.model)).toEqual(['free/a:free']);
  });

  it('with a reserved paid net the engine still recovers on it (unchanged)', async () => {
    fake.steps = [() => ({ text: '' }), () => ({ text: 'From the net.' })];
    const r = await runChat({ ...base, model: 'free/a:free' });
    expect(r.text).toBe('From the net.');
    expect(fake.requests.map((q) => q.model)).toEqual(['free/a:free', TEXT_FALLBACK]);
  });
});
