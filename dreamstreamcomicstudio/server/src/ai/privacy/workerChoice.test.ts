// @vitest-environment node
// Delegation (ai/agents/delegate.ts) and deep research (ai/research/deepResearch.ts) pick their
// worker model explicitly inside a connector turn (the privacy scope, ./scope.ts), with the swarm's
// rule (orchestrator.ts):
//   - not Free only: the paid net the caller priced (its non-free fallbackModel, else TEXT_FALLBACK),
//     never a free pick the provider backstop would swap or refuse;
//   - Free only with a pinned paid model (a flagged paid turn): that same pinned model, never a free
//     pick the provider would refuse (409 inside the meta-tool);
//   - outside a connector turn: unchanged (a free worker).
// The engine is a spy that records, for each model call, its model and whether the scope was active.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorPrivacyActive, runWithConnectorPrivacy } from './scope.js';
import { routeForConnectorData } from './openrouterPolicy.js';

type Call = { model: string; scoped: boolean; system: string };
const calls = vi.hoisted(() => ({ list: [] as Call[] }));
vi.mock('../chat.js', () => ({
  runChat: async (p: { model: string; systemOverride?: string }) => {
    calls.list.push({ model: p.model, scoped: connectorPrivacyActive(), system: String(p.systemOverride || '') });
    return { text: '["What drives tides?"]', model: p.model, usage: {} };
  }
}));
const picks = vi.hoisted(() => ({ count: 0 }));
vi.mock('../autoRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../autoRouter.js')>()),
  pickTextModel: vi.fn(async () => {
    picks.count += 1;
    return 'vendor/worker:free';
  })
}));
vi.mock('../tools/search.js', () => ({
  webSearch: async () => ({ results: [{ title: 'Tides', url: 'https://example.org/tides', snippet: 'The moon.' }], provider: 'fake', tried: [], status: 'ok' })
}));
vi.mock('../research/readable.js', () => ({ fetchReadable: async () => null }));

const { runDelegation } = await import('../agents/delegate.js');
const { runDeepResearch } = await import('../research/deepResearch.js');
const { TEXT_FALLBACK } = await import('../autoRouter.js');

const FREE = 'vendor/worker:free';
const base = { provider: 'openrouter' as const, apiKey: 'k', model: 'vendor/smart' };

/** Run delegation; its helper calls are every call but the last (the aggregation). */
const delegateWorkers = async (opts: Record<string, unknown> = {}, scoped = false) => {
  const run = () => runDelegation({ ...base, goal: 'Compare tides', subtasks: ['Tides in Lisbon', 'Tides in Porto'], ...opts });
  await (scoped ? runWithConnectorPrivacy(true, run) : run());
  return calls.list.slice(0, -1);
};
/** Run deep research; its planner is the first call. */
const researchPlanner = async (opts: Record<string, unknown> = {}, scoped = false) => {
  const run = () => runDeepResearch({ ...base, topic: 'tides', depth: 'quick', ...opts });
  await (scoped ? runWithConnectorPrivacy(true, run) : run());
  return calls.list[0];
};

beforeEach(() => {
  calls.list = [];
  picks.count = 0;
});

describe('delegation helpers', () => {
  it('outside a connector turn: a free worker (unchanged)', async () => {
    const workers = await delegateWorkers();
    expect(workers).toHaveLength(2);
    expect(workers.every((c) => c.model === FREE && !c.scoped)).toBe(true);
  });

  it('inside a connector turn: the paid net, never a free pick', async () => {
    const workers = await delegateWorkers({}, true);
    expect(workers.every((c) => c.model === TEXT_FALLBACK && c.scoped)).toBe(true);
    expect(picks.count).toBe(0);
  });

  it("uses the caller's own paid fallback when it gave one, and ignores a free one", async () => {
    expect((await delegateWorkers({ fallbackModel: 'vendor/net' }, true)).map((c) => c.model)).toEqual(['vendor/net', 'vendor/net']);
    calls.list = [];
    expect((await delegateWorkers({ fallbackModel: 'vendor/other:free' }, true)).map((c) => c.model)).toEqual([TEXT_FALLBACK, TEXT_FALLBACK]);
  });

  it('Free only with a pinned paid model in a connector turn: the pinned model, which the provider accepts', async () => {
    const workers = await delegateWorkers({ noPaidRetry: true }, true);
    for (const c of workers) {
      expect(c.model).toBe('vendor/smart');
      expect(routeForConnectorData({ model: c.model, freeOnly: true }).ok).toBe(true);
    }
    // What the old free pick would have met: a refusal.
    expect(routeForConnectorData({ model: FREE, freeOnly: true }).ok).toBe(false);
  });

  it('Free only otherwise keeps its free pick (outside a turn, or a free pinned model)', async () => {
    expect((await delegateWorkers({ noPaidRetry: true })).every((c) => c.model === FREE)).toBe(true);
    calls.list = [];
    expect((await delegateWorkers({ noPaidRetry: true, model: 'vendor/chat:free' }, true)).every((c) => c.model === FREE)).toBe(true);
  });
});

describe('deep research planner', () => {
  it('outside a connector turn: a free worker (unchanged)', async () => {
    const planner = await researchPlanner();
    expect(planner.model).toBe(FREE);
    expect(planner.scoped).toBe(false);
  });

  it('inside a connector turn: the paid net, never a free pick', async () => {
    const planner = await researchPlanner({}, true);
    expect(planner.model).toBe(TEXT_FALLBACK);
    expect(planner.scoped).toBe(true);
    expect(picks.count).toBe(0);
  });

  it("uses the caller's own paid fallback when it gave one, and ignores a free one", async () => {
    expect((await researchPlanner({ fallbackModel: 'vendor/net' }, true)).model).toBe('vendor/net');
    calls.list = [];
    expect((await researchPlanner({ fallbackModel: 'vendor/other:free' }, true)).model).toBe(TEXT_FALLBACK);
  });

  it('Free only with a pinned paid model in a connector turn: the pinned model', async () => {
    const planner = await researchPlanner({ noPaidRetry: true }, true);
    expect(planner.model).toBe('vendor/smart');
    expect(routeForConnectorData({ model: planner.model, freeOnly: true }).ok).toBe(true);
  });

  it('Free only otherwise keeps its free pick', async () => {
    expect((await researchPlanner({ noPaidRetry: true })).model).toBe(FREE);
    calls.list = [];
    expect((await researchPlanner({ noPaidRetry: true, model: 'vendor/chat:free' }, true)).model).toBe(FREE);
  });
});
