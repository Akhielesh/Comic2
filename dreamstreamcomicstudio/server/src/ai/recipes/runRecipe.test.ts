// @vitest-environment node
// Gate S11 / S9: runRecipe runs ONLY the model its caller resolved, checked and priced — never the
// recipe's own settings.model (that pin is resolved by the route). A run that fails part-way
// still reports what it had spent, and the failure text is calm (no raw provider error).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const engines = vi.hoisted(() => ({ chat: vi.fn(), swarm: vi.fn(), research: vi.fn() }));
vi.mock('../chat.js', () => ({ runChat: engines.chat }));
vi.mock('../agents/orchestrator.js', () => ({ runSwarm: engines.swarm }));
vi.mock('../research/deepResearch.js', () => ({ runDeepResearch: engines.research }));

const { runRecipe } = await import('./runRecipe.js');
const { getBuiltinRecipe } = await import('./library.js');
const { withSpentUsage } = await import('../usage.js');

const base = { provider: 'openrouter' as const, apiKey: 'k', model: 'vendor/vetted' };
const pinned = { version: '1.0.0', title: 'Pinned', description: 'd', prompt: 'go', settings: { model: 'vendor/expensive' } };

beforeEach(() => {
  engines.chat.mockReset().mockResolvedValue({ text: 'ok', model: 'vendor/vetted', usage: {} });
  engines.swarm.mockReset().mockResolvedValue({ text: 'ok', model: 'vendor/vetted', usage: {}, artifacts: [], trace: { agents: [] } });
  engines.research.mockReset().mockResolvedValue({ text: 'ok', model: 'vendor/vetted', usage: {}, report: {}, trace: {} });
});

describe('runRecipe never runs an unpriced recipe pin', () => {
  it('single-agent recipe: runChat gets the caller’s model', async () => {
    await runRecipe({ ...base, recipe: pinned });
    expect(engines.chat.mock.calls[0][0].model).toBe('vendor/vetted');
  });

  it('swarm recipe: runSwarm gets the caller’s model', async () => {
    await runRecipe({ ...base, recipe: { ...pinned, swarm: true } });
    expect(engines.swarm.mock.calls[0][0].model).toBe('vendor/vetted');
  });

  it('deep-research recipe: the research engine gets the caller’s model', async () => {
    const builtin = getBuiltinRecipe('deep-research-brief')!;
    await runRecipe({ ...base, recipe: { ...builtin, settings: { ...(builtin.settings || {}), model: 'vendor/expensive' } }, values: { topic: 'tides' } });
    expect(engines.research.mock.calls[0][0].model).toBe('vendor/vetted');
  });
});

describe('runRecipe failure path', () => {
  it('reports what a failed run had already spent, with a calm message', async () => {
    engines.chat.mockRejectedValueOnce(withSpentUsage(new Error('OpenRouter /chat/completions failed: 400 {"error":"context"}'), { providerCostUsd: 0.3, totalTokens: 900 }));
    const r = await runRecipe({ ...base, recipe: pinned });
    expect(r.usage.providerCostUsd).toBe(0.3);
    expect(r.text).toContain("couldn't finish");
    expect(r.text).not.toMatch(/OpenRouter|failed:|\{|400/);
  });

  it('a failure that spent nothing reports nothing to bill', async () => {
    engines.chat.mockRejectedValueOnce(new Error('provider down'));
    expect((await runRecipe({ ...base, recipe: pinned })).usage).toEqual({});
  });
});

describe('runRecipe in free-only mode (noPaidRetry)', () => {
  it('no engine gets the paid retry; each is told to stay free', async () => {
    await runRecipe({ ...base, recipe: pinned, noPaidRetry: true, fallbackModel: 'vendor/paid-net' });
    await runRecipe({ ...base, recipe: { ...pinned, swarm: true }, noPaidRetry: true });
    const builtin = getBuiltinRecipe('deep-research-brief')!;
    await runRecipe({ ...base, recipe: builtin, values: { topic: 'tides' }, noPaidRetry: true });
    for (const engine of [engines.chat, engines.swarm, engines.research]) {
      expect(engine.mock.calls[0][0]).toMatchObject({ noPaidRetry: true });
      expect(engine.mock.calls[0][0].fallbackModel).toBeUndefined();
    }
  });

  it('off: every engine keeps the paid net (the caller’s, else TEXT_FALLBACK)', async () => {
    await runRecipe({ ...base, recipe: pinned });
    await runRecipe({ ...base, recipe: { ...pinned, swarm: true }, fallbackModel: 'vendor/paid-net' });
    expect(engines.chat.mock.calls[0][0].fallbackModel).toBeTruthy();
    expect(engines.chat.mock.calls[0][0].noPaidRetry).toBeUndefined();
    expect(engines.swarm.mock.calls[0][0].fallbackModel).toBe('vendor/paid-net');
  });
});
