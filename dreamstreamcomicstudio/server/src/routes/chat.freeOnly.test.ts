// @vitest-environment node
// Chat Studio in the client's DEFAULT "free-only" mode (services/freeOnlyMode.ts: ON unless the
// user opts into paid; every /api/* call carries `X-Free-Only: true` and "the server blocks rather
// than silently charging a paid fallback"). The route used the header only to build the free model
// chain and still handed the engine the PAID `fallbackModel: TEXT_FALLBACK`, so a slow free model
// was retried on the paid net and that cost settled against the governed user's usage. A free-only
// turn now offers no paid retry at all (the provider request carries `freeOnly: true`): a free
// model that answers settles at $0; one that times out fails honestly with nothing spent.
// Harness: the real chat route, engine and usage enforcer over an in-memory budget database; only
// the provider behind the gateway is fake (no network, no paid call).
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
// A spy over the REAL agent team: tests that need the team's own provider calls run it for real
// (through the fake gateway above); the others stub its answer.
vi.mock('../ai/agents/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/agents/orchestrator.js')>();
  return { ...actual, runSwarm: vi.fn(actual.runSwarm) };
});
vi.mock('../ai/image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/image.js')>()),
  generateGeminiImage: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA' }))
}));

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

const allowance = await import('../services/platformAllowance.js');
const { chatRouter } = await import('./chat.js');
const { errorHandler } = await import('../middleware/errors.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');
const { runSwarm } = await import('../ai/agents/orchestrator.js');
const swarm = vi.mocked(runSwarm);
const { runSwarm: realRunSwarm } = await vi.importActual<typeof import('../ai/agents/orchestrator.js')>('../ai/agents/orchestrator.js');

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
app.use('/api/chat', chatRouter);
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
  swarm.mockReset().mockImplementation(async () => ({
    text: 'The team answer.',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: 0 }
  }) as unknown as Awaited<ReturnType<typeof runSwarm>>);
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
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { text?: string; notices?: { message: string }[]; error?: { message?: string; code?: string } } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

let seq = 0;
const freshUser = () => `user-${Date.now()}-${seq++}`;
const isPaid = (model?: string) => Boolean(model) && !/:free$/.test(String(model));
const turnCalls = () => engine.providerCalls.filter((c) => !c.helper);
const turnEvents = (user: string) => db.events.filter((e) => e.userId === user && e.operation === 'chat.completion');
const ASK = { messages: [{ role: 'user', content: 'Explain how tides work in detail' }] };
/** The free models of this catalog: prepareChat's free chain under free-only (pickTextModelChain, freeOnly, max 2), in its own order. */
const FREE_CHAIN = ['meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen3-32b:free'];

describe('free-only mode (X-Free-Only, the client default) for a governed user with usage left', () => {
  it('never offers the paid retry: the turn runs on the free chain with freeOnly set, and settles at $0', async () => {
    const user = freshUser();
    const r = await post('/api/chat', ASK, { 'x-test-user': user, 'X-Free-Only': 'true' });
    expect(r.status).toBe(200);
    expect(r.json?.text).toBe('Here is your answer.');
    const calls = turnCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(isPaid(c.model)).toBe(false);
      // Without the fix: fallbackModel === TEXT_FALLBACK ('openai/gpt-4o-mini') and freeOnly undefined.
      expect(c.fallbackModel).toBeUndefined();
      expect(c.freeOnly).toBe(true);
      expect(c.models?.every((m) => !isPaid(m))).toBe(true);
    }
    const events = turnEvents(user);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'SETTLED', costUsd: 0 });
  });

  it('a slow free model is NOT retried on the paid model: the turn fails honestly and nothing is spent', async () => {
    const user = freshUser();
    engine.script = [{ timeout: true }];
    const r = await post('/api/chat', ASK, { 'x-test-user': user, 'X-Free-Only': 'true' });
    // Without the fix: 200, a second call on TEXT_FALLBACK, chat.completion SETTLED at $0.002 and a
    // "used a faster model" notice.
    expect(turnCalls().some((c) => c.model === TEXT_FALLBACK || isPaid(c.model))).toBe(false);
    expect(r.status).toBe(504);
    expect(r.json?.error?.code).toBe('MODEL_TIMEOUT');
    const events = turnEvents(user);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('RELEASED');
    expect(db.events.filter((e) => e.userId === user && e.status === 'SETTLED')).toHaveLength(0);
  });

  it('same over /stream: the provider request carries freeOnly and no paid fallback', async () => {
    const user = freshUser();
    const res = await fetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user, 'X-Free-Only': 'true' },
      body: JSON.stringify(ASK)
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('event: final');
    for (const c of turnCalls()) {
      expect(c.fallbackModel).toBeUndefined();
      expect(c.freeOnly).toBe(true);
      expect(isPaid(c.model)).toBe(false);
    }
    expect(turnEvents(user)[0]).toMatchObject({ status: 'SETTLED', costUsd: 0 });
  });

  it('/swarm: the agent team runs with no paid model anywhere (planner, agents, synthesis) and settles at $0', async () => {
    const user = freshUser();
    swarm.mockImplementation(realRunSwarm);
    const res = await fetch(`${base}/api/chat/swarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user, 'X-Free-Only': 'true' },
      body: JSON.stringify(ASK)
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    // Without the fix: the team is swapped for one free model (runSwarm never called) — or, before
    // that, run with fallbackModel === TEXT_FALLBACK on every call.
    expect(swarm).toHaveBeenCalledTimes(1);
    expect(swarm.mock.calls[0][0]).toMatchObject({ noPaidRetry: true, fallbackModel: undefined });
    expect(body).toContain('event: trace');
    expect(body).toContain('event: final');
    const calls = turnCalls();
    // The planner, at least one agent and the synthesis.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(isPaid(c.model)).toBe(false);
      expect(c.fallbackModel).toBeUndefined();
      expect(c.freeOnly).toBe(true);
    }
    const events = turnEvents(user);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'SETTLED', costUsd: 0 });
    expect(body).not.toMatch(/instead of the agent team/);
    // The synthesis (the team's last call) carries the prepared FREE chain, so one throttled free model
    // falls through to the other free one. Without the fix: `models` undefined on every team call.
    const chain = swarm.mock.calls[0][0].fallbackModels;
    expect([...(chain || [])].sort()).toEqual([...FREE_CHAIN].sort());
    const synth = calls[calls.length - 1];
    expect(synth.models).toEqual(chain);
    expect(synth.models?.[0]).toBe(synth.model);
    expect(synth.models?.some((m) => isPaid(m) || m === TEXT_FALLBACK)).toBe(false);
  });

  it('/swarm: a slow free model in the team is never retried on the paid model', async () => {
    const user = freshUser();
    swarm.mockImplementation(realRunSwarm);
    // The planner times out (the heuristic plan takes over), then everything else answers.
    engine.script = [{ timeout: true }];
    const res = await fetch(`${base}/api/chat/swarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user, 'X-Free-Only': 'true' },
      body: JSON.stringify(ASK)
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: final');
    expect(turnCalls().some((c) => c.model === TEXT_FALLBACK || isPaid(c.model))).toBe(false);
    // The turn itself settles at $0 (the auto-memory helper is metered on its own, as documented).
    expect(turnEvents(user)).toEqual([expect.objectContaining({ status: 'SETTLED', costUsd: 0 })]);
  });
});

describe('free-only OFF (the user opted into paid models): unchanged', () => {
  it('the paid chain keeps its paid net', async () => {
    const user = freshUser();
    const r = await post('/api/chat', ASK, { 'x-test-user': user });
    expect(r.status).toBe(200);
    const first = turnCalls()[0];
    expect(first.fallbackModel).toBe(TEXT_FALLBACK);
    expect(first.freeOnly).toBeUndefined();
  });

  it('/swarm still runs the agent team with its paid net, and adds no free-only note', async () => {
    const user = freshUser();
    const res = await fetch(`${base}/api/chat/swarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: JSON.stringify(ASK)
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(swarm).toHaveBeenCalledTimes(1);
    expect(swarm.mock.calls[0][0]).toMatchObject({ fallbackModel: TEXT_FALLBACK });
    expect(swarm.mock.calls[0][0].fallbackModels).toBeUndefined();
    expect(body).toContain('The team answer.');
    expect(body).not.toMatch(/Free-Only mode/);
  });
});
