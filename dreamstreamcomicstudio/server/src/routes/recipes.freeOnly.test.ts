// @vitest-environment node
// Recipes and the self-retrospective (distill) in the client's DEFAULT free-only mode
// (X-Free-Only: "the server blocks rather than silently charging a paid fallback",
// services/freeOnlyMode.ts). /api/recipes/run and /distill handed every engine the paid
// TEXT_FALLBACK retry unconditionally (routes/recipes.ts), and runRecipe re-added it when it was
// missing, so a free-only recipe's slow free model was retried on the paid model and charged to the
// governed user's usage — the UB-2 class. Now no engine of a free-only run gets a paid retry
// (`freeOnly` on every provider request; free planner/agents for swarm recipes), the run settles at
// $0, and the hold is unchanged (it still prices the paid net: never under-reserved).
// Harness: the real recipes route, runRecipe, swarm and chat engines and the usage enforcer over an
// in-memory budget; only the provider behind the gateway is fake (no network, no paid call).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
vi.mock('../services/mcpRegistry.js', () => ({ enabledMcpConfigs: async () => [] }));
vi.mock('../ai/tools/mcpClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/tools/mcpClient.js')>()),
  buildMcpTools: async () => []
}));
vi.mock('../services/customAgents.js', () => ({ loadCustomAgentDefinitions: async () => [] }));
vi.mock('../services/modelStats.js', () => ({ recordModelUsage: () => undefined }));
vi.mock('../services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelAccessPolicy.js')>()),
  assertModelAllowedForUser: async () => ({})
}));
vi.mock('../services/userMemory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/userMemory.js')>()),
  buildUserMemoryBlock: async () => null,
  rememberUserMemories: async () => undefined
}));
vi.mock('../connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null }));
vi.mock('../connectors/store.js', () => ({ listConnections: async () => [] }));
vi.mock('../services/modelCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/modelCatalog.js')>();
  const textModel = (id: string, promptPerToken = 0, completionPerToken = 0) => ({
    id,
    name: id,
    supportsImageOutput: false,
    outputModalities: ['text'],
    inputModalities: ['text'],
    supportedParameters: ['tools', 'temperature'],
    costClass: promptPerToken || completionPerToken ? 'paid' : 'free_verified',
    pricing: { promptPerToken, completionPerToken, imagePerImage: 0, requestFlat: 0 }
  });
  return {
    ...actual,
    getCatalog: async () => ({
      models: [textModel('meta-llama/llama-3.3-70b-instruct:free'), textModel('qwen/qwen3-32b:free'), textModel('vendor/pricey', 0.000015, 0.000075)],
      fetchedAt: Date.now(),
      degraded: false
    })
  };
});

// Every model call the engine makes — where money would be spent. The turn's own calls are told
// apart from the (documented, separately metered) auto-memory helper by its system prompt.
type ProviderCall = { model: string; fallbackModel?: string; models?: string[]; freeOnly?: boolean; helper: boolean };
type Scripted = { timeout?: boolean; costUsd?: number };
const engine = vi.hoisted(() => ({ providerCalls: [] as ProviderCall[], script: [] as Scripted[] }));
vi.mock('../ai/gateway.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/gateway.js')>();
  type Req = { model: string; fallbackModel?: string; models?: string[]; freeOnly?: boolean; messages: { role: string; content: unknown }[] };
  const reply = (req: Req) => {
    const system = String(req.messages[0]?.role === 'system' ? req.messages[0].content : '');
    engine.providerCalls.push({
      model: req.model,
      fallbackModel: req.fallbackModel,
      models: req.models,
      freeOnly: req.freeOnly,
      helper: system.includes('long-term memory')
    });
    const step = engine.script.shift();
    if (step?.timeout) throw Object.assign(new Error('The model timed out before answering.'), { status: 504, publicCode: 'MODEL_TIMEOUT' });
    const free = /:free$/.test(req.model);
    const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: step?.costUsd ?? (free ? 0 : 0.002) };
    return { text: 'Here is your answer.', model: req.model, usage };
  };
  const provider = {
    id: 'openrouter',
    generateText: async (req: Req) => reply(req),
    generateTextStream: async (req: Req, _ctx: unknown, onDelta: (d: { content?: string }) => void) => {
      const r = reply(req);
      if (r.text) onDelta({ content: r.text });
      return r;
    },
    generateImage: async () => {
      throw new Error('no image calls in this test');
    },
    listModels: async () => []
  };
  return { ...actual, getProvider: () => provider };
});

type Ev = { userId: string; reservationId: string; costUsd: number; holdUsd: number; status: 'RESERVED' | 'SETTLED' | 'RELEASED'; operation: string; model: string };
const db = vi.hoisted(() => ({ events: [] as Ev[] }));
const ledger = vi.hoisted(() => ({
  reserveUsageTokens: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
  getBillingSummary: vi.fn()
}));
vi.mock('../services/billingLedger.js', () => ledger);
vi.mock('../services/costEstimator.js', () => {
  const price = (model?: string) => (/:free$/.test(model || '') ? 0 : 0.01);
  const est = (usd: number, model?: string) => ({
    currency: 'USD',
    ctPerUsd: 10_000,
    markup: 1.3,
    estimatedProviderCostUsd: usd,
    estimatedBillableUsd: usd * 1.3,
    estimatedCt: Math.round(usd * 13_000),
    lines: [],
    modelPricing: { model }
  });
  return {
    buildEstimateFromRequestBody: (provider: string, model: string, operation: string, _body: unknown, explicit: Record<string, unknown> = {}) => ({ provider, model, operation, ...explicit }),
    estimateCharge: async (seed: { model?: string }) => est(price(seed.model), seed.model),
    buildSettleEstimateFromUsage: async (seed: { model?: string }, usage?: { providerCostUsd?: number }) => est(usage?.providerCostUsd ?? price(seed.model), seed.model)
  };
});
vi.mock('../middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => false) }));
vi.mock('../services/rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));
vi.mock('../services/recipes.js', () => ({
  listRecipes: async () => [],
  getRecipe: async () => null,
  saveRecipe: async () => null,
  deleteRecipe: async () => false
}));

const allowance = await import('../services/platformAllowance.js');
const { recipesRouter } = await import('./recipes.js');
const { errorHandler } = await import('../middleware/errors.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');

const used = (userId: string) => db.events.filter((e) => e.userId === userId && (e.status === 'SETTLED' || e.status === 'RESERVED')).reduce((s, e) => s + e.costUsd, 0);

allowance.setUsageBudgetRpc({
  tryReserve: async ({ userId, reservationId, estimateUsd, event }) => {
    const budget = Number(event.default_budget_usd);
    const u = used(userId);
    const pct = (v: number) => Math.min(100, Math.round((v / budget) * 1000) / 10);
    if (estimateUsd > 0 && u + estimateUsd > budget) return { governed: true, allowed: false, period: 'lifetime', pct_used: pct(u), pct_left: 100 - pct(u) };
    db.events.push({ userId, reservationId, costUsd: estimateUsd, holdUsd: estimateUsd, status: 'RESERVED', operation: String(event.operation), model: String(event.model) });
    return { governed: true, allowed: true, pct_used: pct(u + estimateUsd), pct_left: 100 - pct(u + estimateUsd) };
  },
  status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
  adminList: async () => []
});

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: String(req.header('x-test-user') || 'user-1'), email: 'tester@example.com' };
  r.apiKeys = { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } };
  next();
});
app.use('/api/recipes', recipesRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  allowance.__setMeteringEnabledForTests(true);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  db.events = [];
  engine.providerCalls = [];
  engine.script = [];
  ledger.reserveUsageTokens.mockReset().mockImplementation(async (input: { reservationId?: string; estimate: unknown; governed?: boolean; skipWalletLimits?: boolean; byok?: boolean }) => ({
    allowed: true,
    reservation: {
      reservationId: input.reservationId ?? (input.byok ? undefined : 'wallet-res'),
      byokBypass: !!input.byok,
      estimated: input.estimate,
      usage: {},
      governed: input.governed === true,
      walletSkipped: input.skipWalletLimits === true
    }
  }));
  ledger.settleReservation.mockReset().mockImplementation(async (input: { reservationId: string; actual: { estimatedProviderCostUsd: number } }) => {
    const ev = db.events.find((e) => e.reservationId === input.reservationId);
    if (ev) Object.assign(ev, { status: 'SETTLED', costUsd: input.actual.estimatedProviderCostUsd });
    return { actualCt: 0, billableUsd: 0, providerCostUsd: input.actual.estimatedProviderCostUsd, reservationReleased: true };
  });
  ledger.releaseReservation.mockReset().mockImplementation(async (input: { reservationId: string }) => {
    const ev = db.events.find((e) => e.reservationId === input.reservationId);
    if (ev) ev.status = 'RELEASED';
  });
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/recipes${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};

let seq = 0;
const freshUser = () => `user-${Date.now()}-${seq++}`;
const isPaid = (model?: string) => Boolean(model) && !/:free$/.test(String(model));
const turnCalls = () => engine.providerCalls.filter((c) => !c.helper);
const runEvents = (user: string) => db.events.filter((e) => e.userId === user && e.operation === 'chat.completion');
const FREE_ONLY = { 'X-Free-Only': 'true' };
const messages = [{ role: 'user', content: 'Plan my week' }];
const single = { recipe: { title: 'Weekly plan', prompt: 'Plan my week in three bullets.' }, messages };
const team = { recipe: { title: 'Team brief', prompt: 'Brief me on tides.', swarm: true }, messages };

const expectNoPaidModel = () => {
  const calls = turnCalls();
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(isPaid(c.model)).toBe(false);
    // Without the fix: fallbackModel === TEXT_FALLBACK and freeOnly undefined on every call.
    expect(c.fallbackModel).toBeUndefined();
    expect(c.freeOnly).toBe(true);
  }
};

describe('free-only recipes (X-Free-Only) never reach a paid model', () => {
  it('a single-agent recipe runs on the free chain with no paid retry and settles at $0', async () => {
    const user = freshUser();
    const r = await post('/run', single, { 'x-test-user': user, ...FREE_ONLY });
    expect(r.status).toBe(200);
    expect(r.text).toContain('event: final');
    expectNoPaidModel();
    expect(runEvents(user)).toEqual([expect.objectContaining({ status: 'SETTLED', costUsd: 0 })]);
  });

  it('a slow free model is not retried on the paid model', async () => {
    const user = freshUser();
    engine.script = [{ timeout: true }];
    const r = await post('/run', single, { 'x-test-user': user, ...FREE_ONLY });
    expect(r.status).toBe(200);
    expect(turnCalls().some((c) => c.model === TEXT_FALLBACK || isPaid(c.model))).toBe(false);
    expect(db.events.filter((e) => e.userId === user && e.status === 'SETTLED' && e.costUsd > 0)).toHaveLength(0);
  });

  it('a swarm recipe runs the agent team (planner, agents, synthesis) on free models only and settles at $0', async () => {
    const user = freshUser();
    const r = await post('/run', team, { 'x-test-user': user, ...FREE_ONLY });
    expect(r.status).toBe(200);
    expect(r.text).toContain('event: trace');
    expect(turnCalls().length).toBeGreaterThanOrEqual(3);
    expectNoPaidModel();
    expect(runEvents(user)).toEqual([expect.objectContaining({ status: 'SETTLED', costUsd: 0 })]);
  });

  it('distill (the self-retrospective) gets no paid retry either', async () => {
    const user = freshUser();
    const r = await post('/distill', { goal: 'Plan my week', transcript: 'User: plan my week\nAI: Here is your plan.', messages }, { 'x-test-user': user, ...FREE_ONLY });
    expect(r.status).toBe(200);
    expectNoPaidModel();
    expect(runEvents(user)).toEqual([expect.objectContaining({ status: 'SETTLED', costUsd: 0 })]);
  });

  it('the hold still prices the paid net (never under-reserved)', async () => {
    const user = freshUser();
    await post('/run', single, { 'x-test-user': user, ...FREE_ONLY });
    expect(runEvents(user)[0].holdUsd).toBeGreaterThan(0);
  });
});

describe('free-only OFF (the user opted into paid models): unchanged', () => {
  it('a recipe keeps its paid net', async () => {
    const user = freshUser();
    const r = await post('/run', single, { 'x-test-user': user });
    expect(r.status).toBe(200);
    const first = turnCalls()[0];
    expect(first.fallbackModel).toBe(TEXT_FALLBACK);
    expect(first.freeOnly).toBeUndefined();
  });

  it('a swarm recipe keeps the paid net on the team’s calls', async () => {
    const user = freshUser();
    await post('/run', team, { 'x-test-user': user });
    expect(turnCalls().length).toBeGreaterThanOrEqual(3);
    for (const c of turnCalls()) expect(c.fallbackModel).toBe(TEXT_FALLBACK);
  });
});
