// @vitest-environment node
// The agent paths that start model calls of their own carry the connected-account flag:
//   - the swarm (ai/agents/orchestrator.ts): planner, agents and synthesis run in the privacy scope
//     and never on a free worker when the run carries connector content (the caller's scope, the
//     request decision, marked history, or a planned agent offered a connector tool); a free-only
//     run's agents get no connector tool;
//   - recipes (ai/recipes/runRecipe.ts): a recipe listing connector tools (or run in a connector
//     conversation) runs in the scope; a free run gets no connector tool and refuses marked history.
// The engines are spies that record, for each model call, its model, tools and whether the privacy
// scope was active at that moment.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorPrivacyActive, bindConnectorPrivacy, bindConnectorTurnDecision, runWithConnectorPrivacy } from './scope.js';
import { connectedDataFreeModelMessage } from './connectorData.js';
import { routeForConnectorData } from './openrouterPolicy.js';

type Call = { model: string; tools: string[]; scoped: boolean; system: string; noPaidRetry: boolean };
const calls = vi.hoisted(() => ({ list: [] as Call[], plan: '[]' }));
vi.mock('../chat.js', () => ({
  runChat: async (p: { model: string; tools?: { name: string }[]; systemOverride?: string; systemPrompt?: string; noPaidRetry?: boolean }) => {
    const system = String(p.systemOverride || p.systemPrompt || '');
    calls.list.push({ model: p.model, tools: (p.tools || []).map((t) => t.name), scoped: connectorPrivacyActive(), system, noPaidRetry: p.noPaidRetry === true });
    return { text: system.includes('planner for a swarm') ? calls.plan : 'done', model: p.model, usage: {} };
  }
}));
vi.mock('../autoRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../autoRouter.js')>()),
  pickTextModel: vi.fn(async () => 'vendor/worker:free')
}));
vi.mock('../research/deepResearch.js', () => ({
  runDeepResearch: vi.fn(async (p: { model: string }) => {
    calls.list.push({ model: p.model, tools: [], scoped: connectorPrivacyActive(), system: 'research', noPaidRetry: false });
    return { text: 'r', model: p.model, usage: {}, report: {}, trace: {}, citations: [] };
  })
}));

const { runSwarm } = await import('../agents/orchestrator.js');
const { runRecipe } = await import('../recipes/runRecipe.js');
const { TEXT_FALLBACK } = await import('../autoRouter.js');

const base = { provider: 'openrouter' as const, apiKey: 'k', model: 'vendor/chat' };
const ask = (content: string) => [{ role: 'user' as const, content }];
const MARKED = [
  { role: 'user' as const, content: 'Summarise my unread email' },
  { role: 'assistant' as const, content: 'Dana asked to move the launch.', connectorData: true } as never,
  { role: 'user' as const, content: 'And the weather on Friday?' }
];
const planOf = (...agents: string[]) => JSON.stringify(agents.map((agent) => ({ agent, task: `do ${agent}` })));
const CONNECTOR = /^(gmail_|drive_|calendar_|sheets_|connected_data_|maps_lookup|nango_call_api)/;

beforeEach(() => {
  calls.list = [];
  calls.plan = '[]';
});

describe('the swarm (orchestrator) carries the flag', () => {
  it('a plain run is unchanged: free worker, no scope', async () => {
    calls.plan = planOf('weather');
    await runSwarm({ ...base, messages: ask('Weather in Lisbon on Friday?') });
    expect(calls.list.length).toBe(3); // planner, agent, synthesis
    expect(calls.list.slice(0, 2).every((c) => c.model === 'vendor/worker:free')).toBe(true);
    expect(calls.list.every((c) => !c.scoped)).toBe(true);
  });

  it('a planned agent with connector tools (the calendar agent) makes it a connector run: paid worker, every later call scoped', async () => {
    calls.plan = planOf('scheduling', 'weather');
    await runSwarm({ ...base, messages: ask('Am I free on Friday, and what is the weather?') });
    const [planner, ...rest] = calls.list;
    expect(planner.scoped).toBe(false); // nothing connected has been read yet
    expect(rest.length).toBe(3);
    for (const c of rest) {
      expect(c.scoped).toBe(true);
      expect(c.model).not.toMatch(/:free$/);
    }
    expect(rest.some((c) => c.tools.includes('calendar_agenda'))).toBe(true);
    expect(rest.filter((c) => c.system !== '' && c.tools.length).every((c) => c.model === TEXT_FALLBACK)).toBe(true);
  });

  it('a conversation marked as connected content: planner, agents and synthesis all scoped, none on a free model', async () => {
    calls.plan = planOf('weather');
    await runSwarm({ ...base, messages: MARKED });
    expect(calls.list.length).toBe(3);
    for (const c of calls.list) {
      expect(c.scoped).toBe(true);
      expect(c.model).not.toMatch(/:free$/);
    }
  });

  it('the request decision bound by prepareChat, or the caller’s scope (run_agent_swarm inside a connector turn), is inherited', async () => {
    calls.plan = planOf('weather');
    const clientContext = {};
    bindConnectorPrivacy(clientContext, true);
    await runSwarm({ ...base, messages: ask('Weather?'), clientContext });
    expect(calls.list.every((c) => c.scoped && !/:free$/.test(c.model))).toBe(true);

    calls.list = [];
    await runWithConnectorPrivacy(true, () => runSwarm({ ...base, messages: ask('Weather?') }));
    expect(calls.list.every((c) => c.scoped && !/:free$/.test(c.model))).toBe(true);
  });

  it('a free-only run never moves to a paid model: its agents simply get no connector tool', async () => {
    calls.plan = planOf('scheduling');
    await runSwarm({ ...base, model: 'vendor/chat:free', messages: ask('Am I free on Friday?'), noPaidRetry: true });
    for (const c of calls.list) {
      expect(c.tools.filter((t) => CONNECTOR.test(t))).toEqual([]);
      expect(c.scoped).toBe(false);
    }
    expect(calls.list.slice(0, 2).every((c) => c.model === 'vendor/worker:free')).toBe(true);
  });
});

describe('recipes (runRecipe) carry the flag', () => {
  const recipe = (tools: string[], extra: Record<string, unknown> = {}) => ({ version: '1.0.0', title: 'R', description: 'd', prompt: 'go', tools, ...extra });

  it('a recipe without connector tools runs unscoped (unchanged)', async () => {
    await runRecipe({ ...base, recipe: recipe(['web_search']) });
    expect(calls.list).toHaveLength(1);
    expect(calls.list[0].scoped).toBe(false);
  });

  it('a recipe listing a connector tool runs scoped', async () => {
    await runRecipe({ ...base, recipe: recipe(['gmail_search', 'web_search']) });
    expect(calls.list[0].scoped).toBe(true);
    expect(calls.list[0].tools).toContain('gmail_search');
  });

  it('marked history, the bound request decision or the caller scope make it scoped (single, swarm and research recipes)', async () => {
    await runRecipe({ ...base, recipe: recipe(['web_search']), priorMessages: MARKED.slice(0, 2) });
    const clientContext = {};
    bindConnectorPrivacy(clientContext, true);
    await runRecipe({ ...base, recipe: recipe([], { swarm: true }), clientContext });
    await runWithConnectorPrivacy(true, () =>
      runRecipe({ ...base, recipe: { ...recipe([]), id: 'deep-research-brief', params: [{ key: 'topic', type: 'string', required: true }] } as never, values: { topic: 'tides' } })
    );
    expect(calls.list.length).toBeGreaterThanOrEqual(3);
    for (const c of calls.list) expect(c.scoped).toBe(true);
  });

  it('a free run gets no connector tool; with marked history it is refused calmly and nothing runs', async () => {
    await runRecipe({ ...base, recipe: recipe(['gmail_search', 'web_search']), noPaidRetry: true });
    expect(calls.list[0].tools).toEqual(['web_search']);
    expect(calls.list[0].scoped).toBe(false);

    calls.list = [];
    const r = await runRecipe({ ...base, model: 'vendor/chat:free', recipe: recipe(['web_search']), priorMessages: MARKED.slice(0, 2) });
    // A free model the user picked (not Free only): the copy says to pick a standard model.
    expect(r.text).toBe(connectedDataFreeModelMessage(false));
    expect(calls.list).toHaveLength(0);

    const freeOnly = await runRecipe({ ...base, recipe: recipe(['web_search']), priorMessages: MARKED.slice(0, 2), noPaidRetry: true });
    expect(freeOnly.text).toBe(connectedDataFreeModelMessage(true));
    expect(calls.list).toHaveLength(0);
  });

  it("uses prepareChat's own free-turn decision: a $0 pinned model without the `:free` suffix gets no connector tool", async () => {
    const clientContext = {};
    bindConnectorTurnDecision(clientContext, { connectorData: false, freeTurn: true });
    await runRecipe({ ...base, model: 'vendor/zero-priced', recipe: recipe(['gmail_search', 'web_search']), clientContext });
    expect(calls.list[0].tools).toEqual(['web_search']);
    expect(calls.list[0].scoped).toBe(false);

    // …and Free only with a pinned paid model is a paid turn there too: tools kept, scoped.
    calls.list = [];
    const paidCtx = {};
    bindConnectorTurnDecision(paidCtx, { connectorData: true, freeTurn: false });
    await runRecipe({ ...base, model: 'vendor/smart', recipe: recipe(['gmail_search']), clientContext: paidCtx, noPaidRetry: true });
    expect(calls.list[0].tools).toContain('gmail_search');
    expect(calls.list[0].scoped).toBe(true);
  });
});

describe('Free only with a pinned paid model on a connector turn (the swarm)', () => {
  it('planner and agents run on the pinned model: no call is refused and none is on a free model', async () => {
    calls.plan = planOf('scheduling', 'weather');
    const clientContext = {};
    bindConnectorPrivacy(clientContext, true);
    await runWithConnectorPrivacy(true, () =>
      runSwarm({ ...base, model: 'vendor/smart', messages: ask('Am I free on Friday, and the weather?'), clientContext, noPaidRetry: true })
    );
    expect(calls.list.length).toBe(4); // planner, 2 agents, synthesis
    for (const c of calls.list) {
      expect(c.model).toBe('vendor/smart');
      expect(c.scoped).toBe(true);
      expect(c.noPaidRetry).toBe(true);
      // What the provider would do with it: never a refusal (a free model under Free only would be).
      expect(routeForConnectorData({ model: c.model, freeOnly: true }).ok).toBe(true);
    }
    // The flagged paid turn keeps its connector tools (the chat turn does too).
    expect(calls.list.some((c) => c.tools.includes('calendar_agenda'))).toBe(true);
  });
});
