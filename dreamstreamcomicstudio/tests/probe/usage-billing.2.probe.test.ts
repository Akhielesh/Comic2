// @vitest-environment node
// Probe: Chat Studio in the client's DEFAULT "free-only" mode (services/freeOnlyMode.ts: ON unless
// the user opts into paid; every /api/* call carries `X-Free-Only: true`, "the server blocks rather
// than silently charging a paid fallback"). routes/chat.ts reads the header for the model chain
// but never sets `freeModelsOnly`, so runChatParams still hands the engine the PAID
// `fallbackModel: TEXT_FALLBACK` (and no `noPaidRetry`/`freeOnly`), and chatPricedModels prices the
// hold at the paid net. Expected for a governed user: a free-only turn never retries on a paid
// model and nothing is taken from their usage. Observed: a timed-out free model is retried on the
// paid TEXT_FALLBACK and that cost is settled against the user's usage.
// Harness: the real chat route, engine and usage enforcer over an in-memory budget database; only
// the provider behind the gateway is fake (no network, no paid call).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../../server/src/services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../../server/src/ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
vi.mock('../../server/src/services/mcpRegistry.js', () => ({ enabledMcpConfigs: async () => [] }));
vi.mock('../../server/src/ai/tools/mcpClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/ai/tools/mcpClient.js')>()),
  buildMcpTools: async () => []
}));
vi.mock('../../server/src/services/customAgents.js', () => ({ loadCustomAgentDefinitions: async () => [] }));
vi.mock('../../server/src/services/modelStats.js', () => ({ recordModelUsage: () => undefined }));
vi.mock('../../server/src/services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/services/modelAccessPolicy.js')>()),
  assertModelAllowedForUser: async () => ({})
}));
vi.mock('../../server/src/services/userMemory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/services/userMemory.js')>()),
  buildUserMemoryBlock: async () => null,
  rememberUserMemories: async () => undefined
}));
vi.mock('../../server/src/connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null }));
vi.mock('../../server/src/services/modelCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/services/modelCatalog.js')>();
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

type ProviderCall = { model: string; fallbackModel?: string; models?: string[]; freeOnly?: boolean };
type Scripted = { timeout?: boolean; costUsd?: number };
const engine = vi.hoisted(() => ({ providerCalls: [] as ProviderCall[], script: [] as Scripted[] }));
vi.mock('../../server/src/ai/gateway.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/ai/gateway.js')>();
  type Req = { model: string; fallbackModel?: string; models?: string[]; freeOnly?: boolean; messages: { role: string; content: unknown }[] };
  const reply = (req: Req) => {
    engine.providerCalls.push({ model: req.model, fallbackModel: req.fallbackModel, models: req.models, freeOnly: req.freeOnly });
    const step = engine.script.shift();
    if (step?.timeout) throw Object.assign(new Error('The model timed out before answering.'), { publicCode: 'MODEL_TIMEOUT' });
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
vi.mock('../../server/src/ai/agents/orchestrator.js', () => ({ runSwarm: vi.fn() }));
vi.mock('../../server/src/ai/image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/src/ai/image.js')>()),
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
vi.mock('../../server/src/services/billingLedger.js', () => ledger);
vi.mock('../../server/src/services/costEstimator.js', () => {
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
vi.mock('../../server/src/middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => false) }));
vi.mock('../../server/src/services/rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));

const allowance = await import('../../server/src/services/platformAllowance.js');
const { chatRouter } = await import('../../server/src/routes/chat.js');
const { errorHandler } = await import('../../server/src/middleware/errors.js');
const { TEXT_FALLBACK } = await import('../../server/src/ai/autoRouter.js');

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
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const isPaid = (model?: string) => Boolean(model) && !/:free$/.test(String(model));

describe('free-only mode (client default) for a governed user with usage left', () => {
  it('hands the engine a paid retry and prices the hold at it; a slow free model is retried on the paid model and charged', async () => {
    const user = `user-${Date.now()}`;
    engine.script = [{ timeout: true }];
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'Explain how tides work in detail' }] }, { 'x-test-user': user, 'X-Free-Only': 'true' });
    const events = db.events.filter((e) => e.userId === user);
    process.stderr.write(`probe2 ${JSON.stringify({ status: r.status, text: r.json?.text, notices: r.json?.notices, providerCalls: engine.providerCalls, events, TEXT_FALLBACK })}\n`);
    expect(r.status).toBe(200);
    // Expected for a free-only turn: no paid model offered as a retry, nothing spent.
    for (const c of engine.providerCalls) {
      expect(isPaid(c.model)).toBe(false);
      expect(c.fallbackModel).toBeUndefined();
    }
    expect(events.filter((e) => e.status === 'SETTLED').reduce((s, e) => s + e.costUsd, 0)).toBe(0);
  });
});
