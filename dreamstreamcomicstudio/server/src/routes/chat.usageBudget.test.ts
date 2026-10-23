// @vitest-environment node
// P2-PLATFORM-FOLLOWUP: Chat Studio under the per-user usage budget ($10 lifetime across every
// studio; BYOK never counts; nothing is spent once it's used up; governed users never see dollars).
//  1. The background helpers (/enhance, /title, /memory, /followups, the server's auto-memory) are
//     metered for governed users — reserve → provider → settle, release on failure — and degrade
//     at $0 once the budget refuses: a local title, the user's own text, no follow-ups, memory as is.
//  2. An exhausted governed user's chat re-plans onto FREE models only (no paid retry, no paid web
//     plugin) and still answers — zero paid model calls; with no free model it says so calmly.
//  3. Admins and BYOK run exactly as before; /api/recipes prices the whole chain.
//  4. (gate S9) The REAL chat engine runs — only the provider behind the gateway is fake — so the
//     settle is driven by the provider-reported usage the engine sums, holds scale with the
//     context, a turn that fails after spending settles that spend, and governed responses never
//     carry the dollar figure.
// The REAL usage enforcer runs against an in-memory budget database (same rules as
// server/sql/user_usage_budgets.sql); no provider, database or network is ever reached.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// ── No database, no network ──────────────────────────────────────────────────────────────────
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
// `stats.throwOnce` makes the (post-settle) usage-stats call throw once — a stand-in for any
// failure after the turn was already settled (building or sending the payload).
const stats = vi.hoisted(() => ({ throwOnce: false }));
vi.mock('../services/modelStats.js', () => ({
  recordModelUsage: () => {
    if (stats.throwOnce) {
      stats.throwOnce = false;
      throw new Error('stats store down');
    }
  }
}));
// The legacy plan list: allows everything unless a test adds a model to `policy.deny`.
const policy = vi.hoisted(() => ({ deny: new Set<string>() }));
vi.mock('../services/modelAccessPolicy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/modelAccessPolicy.js')>()),
  assertModelAllowedForUser: async (input: { requestedModel?: string }) => {
    if (input.requestedModel && policy.deny.has(input.requestedModel)) {
      throw Object.assign(new Error('Model not allowed on this plan.'), { status: 403, publicCode: 'MODEL_NOT_ALLOWED' });
    }
    return {};
  }
}));
const memory = vi.hoisted(() => ({ remembered: [] as unknown[] }));
vi.mock('../services/userMemory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/userMemory.js')>()),
  buildUserMemoryBlock: async () => null,
  rememberUserMemories: async (...args: unknown[]) => {
    memory.remembered.push(args);
  }
}));
vi.mock('../connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null }));

// The model catalog: two free text models (the free chain), one pricey paid chat model with its
// live per-token price, and no network refresh.
const catalog = vi.hoisted(() => ({ free: true }));
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
      models: [
        ...(catalog.free ? [textModel('meta-llama/llama-3.3-70b-instruct:free'), textModel('qwen/qwen3-32b:free')] : []),
        // $15 / $75 per million tokens (Opus-class) — the local pricing table doesn't know it.
        textModel('vendor/pricey', 0.000015, 0.000075)
      ],
      fetchedAt: Date.now(),
      degraded: false
    })
  };
});

// The chat engine is REAL (gate S9: it is what sums every provider call's reported usage into the
// settle). `engine.calls` records each route-level runChat call (what the route asked for);
// `engine.providerCalls` records every model call the engine makes — where money would be spent.
type Call = { model: string; fallbackModel?: string; fallbackModels?: string[]; webSearch?: boolean; systemOverride?: string; tools?: { name: string }[] };
type ProviderCall = { model: string; fallbackModel?: string; models?: string[]; webSearch?: boolean; freeOnly?: boolean };
type Scripted = { toolCall?: string; costUsd?: number; fail?: boolean; empty?: boolean };
const engine = vi.hoisted(() => ({
  calls: [] as Call[],
  providerCalls: [] as ProviderCall[],
  fail: false,
  costUsd: undefined as number | undefined,
  /** Per-call script, consumed in order (else the default answer). */
  script: [] as Scripted[],
  swarm: vi.fn()
}));
vi.mock('../ai/chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/chat.js')>();
  return {
    ...actual,
    runChat: async (params: Parameters<typeof actual.runChat>[0]) => {
      engine.calls.push({
        model: params.model,
        fallbackModel: params.fallbackModel,
        fallbackModels: params.fallbackModels,
        webSearch: params.webSearch,
        systemOverride: params.systemOverride,
        tools: params.tools
      });
      return actual.runChat(params);
    }
  };
});
vi.mock('../ai/gateway.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/gateway.js')>();
  type Req = { model: string; fallbackModel?: string; models?: string[]; webSearch?: boolean; freeOnly?: boolean; messages: { role: string; content: unknown }[] };
  const reply = (req: Req) => {
    engine.providerCalls.push({ model: req.model, fallbackModel: req.fallbackModel, models: req.models, webSearch: req.webSearch, freeOnly: req.freeOnly });
    const step = engine.script.shift();
    if (engine.fail || step?.fail) throw new Error('provider down');
    const free = /:free$/.test(req.model);
    const usage = { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: step?.costUsd ?? engine.costUsd ?? (free ? 0 : 0.002) };
    if (step?.toolCall) {
      return { text: '', model: req.model, usage, toolCalls: [{ id: 'call-1', name: step.toolCall, arguments: '{}' }] };
    }
    if (step?.empty) return { text: '', model: req.model, usage };
    const system = String(req.messages[0]?.role === 'system' ? req.messages[0].content : '');
    const text = system.includes('short, specific title')
      ? 'Lisbon Trip Planning'
      : system.includes('follow-up suggestions')
        ? '["Show me a map", "Plan day two"]'
        : system.includes('long-term memory')
          ? '- Lives in Lisbon'
          : system.includes('prompt-improvement')
            ? 'A clearer prompt'
            : 'Here is your answer.';
    return { text, model: req.model, usage };
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
vi.mock('../ai/agents/orchestrator.js', () => ({ runSwarm: engine.swarm }));
// The chat image tool's Gemini call (platform money when it runs on the platform key).
const images = vi.hoisted(() => ({ gemini: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AAAA' })) }));
vi.mock('../ai/image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/image.js')>()),
  generateGeminiImage: images.gemini
}));
vi.mock('../ai/recipes/runRecipe.js', () => ({
  runRecipe: vi.fn(async (input: { model: string }) => ({ text: 'Recipe done.', model: input.model, usage: { providerCostUsd: 0.002 } }))
}));

// ── The budget database (mirrors usage_budget_try_reserve) + ledger ─────────────────────────
type Ev = { userId: string; reservationId: string; costUsd: number; status: 'RESERVED' | 'SETTLED' | 'RELEASED'; operation: string; model: string; holdUsd?: number };
const db = vi.hoisted(() => ({ events: [] as Ev[], budgets: new Map<string, number>(), rpcCalls: 0 }));
const ledger = vi.hoisted(() => ({
  reserveUsageTokens: vi.fn(),
  settleReservation: vi.fn(),
  releaseReservation: vi.fn(),
  getBillingSummary: vi.fn()
}));
vi.mock('../services/billingLedger.js', () => ledger);
const seeds = vi.hoisted(() => ({ list: [] as { operation: string; model: string; inputTokens?: number; outputTokens?: number }[] }));
vi.mock('../services/costEstimator.js', () => {
  // Like the real estimator: `:free` models are $0 on their own catalog row; everything else
  // in these tests is a small paid call.
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
    buildEstimateFromRequestBody: (provider: string, model: string, operation: string, _body: unknown, explicit: Record<string, unknown> = {}) => {
      seeds.list.push({ operation, model, inputTokens: explicit.inputTokens as number | undefined, outputTokens: explicit.outputTokens as number | undefined });
      return { provider, model, operation, ...explicit };
    },
    estimateCharge: async (seed: { model?: string }) => est(price(seed.model), seed.model),
    buildSettleEstimateFromUsage: async (seed: { model?: string }, usage?: { providerCostUsd?: number }) =>
      est(usage?.providerCostUsd ?? price(seed.model), seed.model)
  };
});
vi.mock('../middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => false) }));
vi.mock('../services/rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));

const allowance = await import('../services/platformAllowance.js');
const { chatRouter, freeModelsOnlyPlan, localChatTitle, noFreeModelDetails, chatPricedModels } = await import('./chat.js');
const { recipesRouter } = await import('./recipes.js');
const { errorHandler } = await import('../middleware/errors.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');

const used = (userId: string) =>
  db.events.filter((e) => e.userId === userId && (e.status === 'SETTLED' || e.status === 'RESERVED')).reduce((s, e) => s + e.costUsd, 0);

const installFakeRpc = () =>
  allowance.setUsageBudgetRpc({
    tryReserve: async ({ userId, reservationId, estimateUsd, event }) => {
      db.rpcCalls += 1;
      const budget = db.budgets.get(userId) ?? Number(event.default_budget_usd);
      const u = used(userId);
      const pct = (v: number) => Math.min(100, Math.round((v / budget) * 1000) / 10);
      if (estimateUsd > 0 && u + estimateUsd > budget) {
        return { governed: true, allowed: false, period: 'lifetime', pct_used: pct(u), pct_left: 100 - pct(u) };
      }
      db.events.push({ userId, reservationId, costUsd: estimateUsd, holdUsd: estimateUsd, status: 'RESERVED', operation: String(event.operation), model: String(event.model) });
      return { governed: true, allowed: true, pct_used: pct(u + estimateUsd), pct_left: 100 - pct(u + estimateUsd) };
    },
    status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
    adminList: async () => []
  });

/** A user whose $10 is already spent (one settled $10 event): every paid estimate is refused. */
const exhaust = (userId: string) => {
  db.budgets.set(userId, 10);
  db.events.push({ userId, reservationId: `seed-${userId}`, costUsd: 10, status: 'SETTLED', operation: 'seed', model: 'seed' });
};

// ── The app: test headers stand in for auth + key resolution ─────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: String(req.header('x-test-user') || 'user-1'), email: 'tester@example.com' };
  const byok = req.header('x-test-byok') === '1';
  const gemini = req.header('x-test-gemini'); // 'platform' | 'byok' | undefined
  r.apiKeys = {
    providerKeys: {
      openrouter: { key: byok ? 'sk-mine' : 'sk-platform', byok },
      ...(gemini ? { gemini: { key: `gemini-${gemini}`, byok: gemini === 'byok' } } : {})
    },
    ...(gemini ? { geminiKey: `gemini-${gemini}`, geminiByok: gemini === 'byok' } : {})
  };
  if (req.header('x-test-admin') === '1') r.accessProfile = { isAdmin: true };
  next();
});
app.use('/api/chat', chatRouter);
app.use('/api/recipes', recipesRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

let userSeq = 0;
const freshUser = () => `user-${++userSeq}-${Date.now()}`;

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
};

const sseEvents = (text: string) =>
  text
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return event ? { event, data: data ? JSON.parse(data) : null } : null;
    })
    .filter((e): e is { event: string; data: any } => e !== null);

const isPaid = (model?: string) => Boolean(model) && !/:free$/.test(String(model));
/** Every model a recorded engine call could have been billed for. */
const billableModels = (c: Call) => [c.model, c.fallbackModel, ...(c.fallbackModels || [])].filter(Boolean) as string[];
const flushAsync = () => new Promise((r) => setTimeout(r, 30));
const conversation = [
  { role: 'user', content: 'Plan a three day trip to Lisbon for me' },
  { role: 'assistant', content: 'Day 1: Alfama. Day 2: Belém. Day 3: Sintra.' }
];

beforeEach(() => {
  allowance.__resetPlatformAllowance();
  allowance.__setMeteringEnabledForTests(true);
  installFakeRpc();
  db.events = [];
  db.budgets.clear();
  db.rpcCalls = 0;
  engine.calls = [];
  engine.providerCalls = [];
  engine.script = [];
  engine.fail = false;
  engine.costUsd = undefined;
  engine.swarm.mockReset();
  stats.throwOnce = false;
  policy.deny.clear();
  seeds.list = [];
  images.gemini.mockClear();
  catalog.free = true;
  memory.remembered = [];
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

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('background chat helpers — governed users are metered', () => {
  it('title: reserves a small hold, runs the model, settles the actual cost', async () => {
    const user = freshUser();
    const r = await post('/api/chat/title', { messages: conversation }, { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(r.json.title).toBe('Lisbon Trip Planning');
    expect(engine.calls).toHaveLength(1);
    const ev = db.events.filter((e) => e.userId === user);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ operation: 'chat.title', status: 'SETTLED', costUsd: 0.002 });
    // The hold covered the paid net too (estimate at the chain's most expensive model, > $0).
    expect(ledger.reserveUsageTokens.mock.calls[0][0]).toMatchObject({ governed: true, operation: 'chat.title' });
  });

  it('enhance, follow-ups and memory are metered the same way', async () => {
    const user = freshUser();
    const h = { 'x-test-user': user };
    expect((await post('/api/chat/enhance', { text: 'trip lisbon' }, h)).json.enhanced).toBe('A clearer prompt');
    expect((await post('/api/chat/followups', { messages: conversation }, h)).json.suggestions).toEqual(['Show me a map', 'Plan day two']);
    expect((await post('/api/chat/memory', { messages: conversation, memory: '' }, h)).json.memory).toBe('- Lives in Lisbon');
    const ops = db.events.filter((e) => e.userId === user).map((e) => [e.operation, e.status]);
    expect(ops).toEqual([
      ['chat.enhance', 'SETTLED'],
      ['chat.followups', 'SETTLED'],
      ['chat.memory', 'SETTLED']
    ]);
  });

  it('a provider failure releases the hold (nothing counted for a call that never ran)', async () => {
    const user = freshUser();
    engine.fail = true;
    const r = await post('/api/chat/title', { messages: conversation }, { 'x-test-user': user });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(db.events.filter((e) => e.userId === user).map((e) => e.status)).toEqual(['RELEASED']);
    expect(ledger.settleReservation).not.toHaveBeenCalled();
  });
});

describe('background chat helpers — exhausted governed users: $0, no errors', () => {
  it('title falls back to the first words, enhance keeps the text, follow-ups empty, memory unchanged', async () => {
    const user = freshUser();
    exhaust(user);
    const h = { 'x-test-user': user };

    const title = await post('/api/chat/title', { messages: conversation }, h);
    expect(title.status).toBe(200);
    expect(title.json).toMatchObject({ title: 'Plan a three day trip to', skipped: 'usage' });

    const enhance = await post('/api/chat/enhance', { text: 'trip lisbon please' }, h);
    expect(enhance.status).toBe(200);
    expect(enhance.json).toMatchObject({ enhanced: 'trip lisbon please', skipped: 'usage' });

    const followups = await post('/api/chat/followups', { messages: conversation }, h);
    expect(followups.status).toBe(200);
    expect(followups.json).toMatchObject({ suggestions: [], skipped: 'usage' });

    const mem = await post('/api/chat/memory', { messages: conversation, memory: '- Likes tea' }, h);
    expect(mem.status).toBe(200);
    expect(mem.json).toMatchObject({ memory: '- Likes tea', skipped: 'usage' });

    // Zero model calls, nothing reserved beyond the seeded spend, no dollars anywhere.
    expect(engine.calls).toHaveLength(0);
    expect(db.events.filter((e) => e.userId === user)).toHaveLength(1);
    for (const r of [title, enhance, followups, mem]) expect(r.text).not.toMatch(/\$\d|usd|cost/i);
  });

  it('memory import (user-started) is refused honestly, percent-only', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat/memory/import', { source: 'chatgpt', content: '- I live in Lisbon' }, { 'x-test-user': user });
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe('BILLING_LIMIT_EXCEEDED');
    expect(r.json.error.message).toMatch(/used all of your DreamStream usage/);
    expect(r.text).not.toMatch(/\$\d/);
    expect(engine.calls).toHaveLength(0);
  });
});

describe('background chat helpers — admins, BYOK and metering off run unchanged', () => {
  it('admin: runs with no budget check and no hold', async () => {
    const user = freshUser();
    exhaust(user); // even an exhausted-looking row is irrelevant for admins
    const r = await post('/api/chat/title', { messages: conversation }, { 'x-test-user': user, 'x-test-admin': '1' });
    expect(r.json.title).toBe('Lisbon Trip Planning');
    expect(engine.calls).toHaveLength(1);
    expect(db.rpcCalls).toBe(0);
    expect(ledger.reserveUsageTokens).not.toHaveBeenCalled();
  });

  it('BYOK: runs on the user’s own key with no hold', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat/followups', { messages: conversation }, { 'x-test-user': user, 'x-test-byok': '1' });
    expect(r.json.suggestions).toHaveLength(2);
    expect(engine.calls).toHaveLength(1);
    expect(db.rpcCalls).toBe(0);
    expect(ledger.reserveUsageTokens).not.toHaveBeenCalled();
  });

  it('metering off (kill switch): helpers run as before', async () => {
    allowance.__setMeteringEnabledForTests(false);
    const r = await post('/api/chat/enhance', { text: 'trip lisbon' }, { 'x-test-user': freshUser() });
    expect(r.json.enhanced).toBe('A clearer prompt');
    expect(db.rpcCalls).toBe(0);
  });
});

describe('chat turns — exhausted governed user: zero paid calls, free chat still answers', () => {
  it('POST /: re-plans onto free models, answers, and says so calmly', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi there' }] }, { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(r.json.text).toBe('Here is your answer.');
    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0];
    expect(billableModels(call).every((m) => !isPaid(m))).toBe(true);
    expect(call.fallbackModel).toBeUndefined();
    expect(call.webSearch).toBe(false);
    const notice = (r.json.notices || []).find((n: { tool?: string }) => n.tool === 'usage_budget');
    expect(notice.message).toMatch(/free model/);
    expect(notice.message).not.toMatch(/\$\d/);
    expect(r.json.billing).toMatchObject({ governed: true });
    expect(JSON.stringify(r.json.billing)).not.toMatch(/usd|cost|estimated/i);
    // The free turn was reserved (at $0) and settled at $0 — still metered, never unreserved.
    const free = db.events.filter((e) => e.userId === user && e.operation === 'chat.completion');
    expect(free).toEqual([expect.objectContaining({ costUsd: 0, status: 'SETTLED' })]);
    // No paid auto-memory write-back after a free-only turn.
    await flushAsync();
    expect(engine.calls).toHaveLength(1);
  });

  it('a pinned paid model is swapped for a free one, and the note names it', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post(
      '/api/chat',
      { model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'Explain recursion with an example' }] },
      { 'x-test-user': user }
    );
    expect(r.status).toBe(200);
    expect(engine.calls.every((c) => billableModels(c).every((m) => !isPaid(m)))).toBe(true);
    const notice = r.json.notices.find((n: { tool?: string }) => n.tool === 'usage_budget');
    expect(notice.message).toContain('instead of anthropic/claude-sonnet-4');
  });

  it('a pinned :free model keeps working (only its paid retry is dropped)', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post(
      '/api/chat',
      { model: 'z-ai/glm-4.5-air:free', messages: [{ role: 'user', content: 'hello' }] },
      { 'x-test-user': user }
    );
    expect(r.status).toBe(200);
    expect(engine.calls[0]).toMatchObject({ model: 'z-ai/glm-4.5-air:free', fallbackModels: ['z-ai/glm-4.5-air:free'] });
    expect(engine.calls[0].fallbackModel).toBeUndefined();
  });

  it('/stream: same free-only re-plan over SSE', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat/stream', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': user });
    expect(r.status).toBe(200);
    const events = sseEvents(r.text);
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['meta', 'delta', 'final']));
    const final = events.find((e) => e.event === 'final')!.data;
    expect(final.text).toBe('Here is your answer.');
    expect(engine.calls.every((c) => billableModels(c).every((m) => !isPaid(m)))).toBe(true);
  });

  it('/swarm: the agent team needs paid models, so one free model answers instead', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post(
      '/api/chat/swarm',
      { tools: ['run_agent_swarm'], messages: [{ role: 'user', content: 'Research the best laptops thoroughly' }] },
      { 'x-test-user': user }
    );
    expect(r.status).toBe(200);
    expect(engine.swarm).not.toHaveBeenCalled();
    const final = sseEvents(r.text).find((e) => e.event === 'final')!.data;
    expect(final.text).toBe('Here is your answer.');
    expect(final.notices.find((n: { tool?: string }) => n.tool === 'usage_budget').message).toContain('instead of the agent team');
    expect(engine.calls.every((c) => billableModels(c).every((m) => !isPaid(m)))).toBe(true);
    // The paid agent meta-tools (swarm, deep research) are never offered to a free-only turn.
    const offered = (engine.calls[0].tools || []).map((t) => t.name);
    expect(offered).not.toContain('run_agent_swarm');
    expect(offered).not.toContain('deep_research');
    expect(offered.length).toBeGreaterThan(0); // the keyless tools stay
  });

  it('no free model available: a calm 402, nothing spent, no model call', async () => {
    const user = freshUser();
    exhaust(user);
    catalog.free = false;
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': user });
    expect(r.status).toBe(402);
    expect(r.json.error.message).toMatch(/Free models are busy right now too, so nothing was spent/);
    expect(r.text).not.toMatch(/\$\d/);
    expect(engine.calls).toHaveLength(0);
    expect(db.events.filter((e) => e.userId === user)).toHaveLength(1);
  });

  it('budget unavailable is NOT downgraded: it stays an honest refusal', async () => {
    const user = freshUser();
    allowance.setUsageBudgetRpc({
      tryReserve: async () => {
        throw new Error('connection refused');
      },
      status: async () => ({}),
      adminList: async () => []
    });
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': user });
    expect(r.status).toBe(402);
    expect(r.json.error.details.reason).toBe('usage_budget_unavailable');
    expect(engine.calls).toHaveLength(0);
  });
});

describe('chat turns — governed with usage left, admins and BYOK: unchanged', () => {
  it('governed with usage left: the normal paid chain with its paid net, priced in full', async () => {
    const user = freshUser();
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(engine.calls[0].fallbackModel).toBe(TEXT_FALLBACK);
    expect(r.json.notices?.find((n: { tool?: string }) => n.tool === 'usage_budget')).toBeUndefined();
    // The server's auto-memory write-back is metered on its own hold.
    await flushAsync();
    const ops = db.events.filter((e) => e.userId === user).map((e) => e.operation);
    expect(ops).toEqual(['chat.completion', 'chat.memory.auto']);
    expect(db.events.filter((e) => e.userId === user).every((e) => e.status === 'SETTLED')).toBe(true);
  });

  it('/swarm with usage left still runs the agent team (priced at the whole chain)', async () => {
    engine.swarm.mockResolvedValue({ text: 'Team answer.', model: 'google/gemini-2.5-flash', usage: { providerCostUsd: 0.004 } });
    const user = freshUser();
    const r = await post('/api/chat/swarm', { messages: [{ role: 'user', content: 'Compare three laptops' }] }, { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(engine.swarm).toHaveBeenCalledTimes(1);
    expect(sseEvents(r.text).find((e) => e.event === 'final')!.data.text).toBe('Team answer.');
    expect(db.events.find((e) => e.userId === user && e.operation === 'chat.completion')).toMatchObject({ status: 'SETTLED', costUsd: 0.004 });
  });

  it('admin: paid chain, no budget check', async () => {
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': freshUser(), 'x-test-admin': '1' });
    expect(r.status).toBe(200);
    expect(engine.calls[0].fallbackModel).toBe(TEXT_FALLBACK);
    expect(db.rpcCalls).toBe(0);
  });

  it('BYOK: paid chain on the user’s key, the budget is never consulted', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': user, 'x-test-byok': '1' });
    expect(r.status).toBe(200);
    expect(engine.calls[0].fallbackModel).toBe(TEXT_FALLBACK);
    expect(db.rpcCalls).toBe(0);
  });
});

describe('chat image tool — never platform image money outside the budget', () => {
  type ToolLike = { name: string; execute: (args: Record<string, unknown>) => Promise<{ content: string }> };
  const imageTool = () => (engine.calls[0].tools as unknown as ToolLike[] | undefined)?.find((t) => t.name === 'generate_image');
  const ask = { tools: ['generate_image'], messages: [{ role: 'user', content: 'Draw a cat on a skateboard' }] };

  it('governed user on the platform Gemini key: the tool is offered keyless and answers how to add a key ($0)', async () => {
    const r = await post('/api/chat', ask, { 'x-test-user': freshUser(), 'x-test-gemini': 'platform' });
    expect(r.status).toBe(200);
    const tool = imageTool();
    expect(tool).toBeTruthy();
    const out = await tool!.execute({ prompt: 'a cat on a skateboard' });
    expect(out.content).toMatch(/No image-generation key is configured/);
    expect(images.gemini).not.toHaveBeenCalled();
  });

  it('exhausted governed user (free-models-only turn): still no platform image call', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post('/api/chat', ask, { 'x-test-user': user, 'x-test-gemini': 'platform' });
    expect(r.status).toBe(200);
    const out = await imageTool()!.execute({ prompt: 'a cat' });
    expect(out.content).toMatch(/No image-generation key is configured/);
    expect(images.gemini).not.toHaveBeenCalled();
  });

  it('governed user with their OWN Gemini key: generates on it', async () => {
    const r = await post('/api/chat', ask, { 'x-test-user': freshUser(), 'x-test-gemini': 'byok' });
    expect(r.status).toBe(200);
    await imageTool()!.execute({ prompt: 'a cat' });
    expect(images.gemini).toHaveBeenCalledWith('gemini-byok', 'a cat', '1:1', '1K');
  });

  it('admin: the platform image key works as before', async () => {
    const r = await post('/api/chat', ask, { 'x-test-user': freshUser(), 'x-test-admin': '1', 'x-test-gemini': 'platform' });
    expect(r.status).toBe(200);
    await imageTool()!.execute({ prompt: 'a cat' });
    expect(images.gemini).toHaveBeenCalledWith('gemini-platform', 'a cat', '1:1', '1K');
  });

  it('metering off (kill switch): unchanged — the platform image key works', async () => {
    allowance.__setMeteringEnabledForTests(false);
    const r = await post('/api/chat', ask, { 'x-test-user': freshUser(), 'x-test-gemini': 'platform' });
    expect(r.status).toBe(200);
    await imageTool()!.execute({ prompt: 'a cat' });
    expect(images.gemini).toHaveBeenCalledTimes(1);
  });

  it('no image tool unless the user enabled it', async () => {
    await post('/api/chat', { messages: ask.messages }, { 'x-test-user': freshUser(), 'x-test-gemini': 'platform' });
    expect(imageTool()).toBeUndefined();
  });
});

describe('SSE routes — a usage check that throws answers instead of hanging', () => {
  it('/stream and /swarm return an error response before any byte is streamed; nothing runs', async () => {
    // A user the budget does not govern goes to the token wallet; make that ledger throw.
    allowance.setUsageBudgetRpc({
      tryReserve: async () => ({ governed: false, allowed: true }),
      status: async () => ({}),
      adminList: async () => []
    });
    ledger.reserveUsageTokens.mockReset().mockRejectedValue(new Error('wallet down'));
    for (const path of ['/api/chat/stream', '/api/chat/swarm']) {
      const r = await post(path, { messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-user': freshUser() });
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(r.text).not.toMatch(/event: /);
    }
    expect(engine.calls).toHaveLength(0);
    expect(engine.swarm).not.toHaveBeenCalled();
  });
});

describe('/api/recipes prices the whole chain (free primary, paid retry)', () => {
  const recipe = { title: 'Trip helper', instructions: 'Plan a short trip.' };

  it('an exhausted governed user with a pinned :free model is refused before any spend', async () => {
    const user = freshUser();
    exhaust(user);
    const r = await post(
      '/api/recipes/run',
      { recipe, values: {}, model: 'z-ai/glm-4.5-air:free', messages: [{ role: 'user', content: 'go' }] },
      { 'x-test-user': user }
    );
    expect(r.status).toBe(402);
    expect(r.text).not.toMatch(/\$\d/);
  });

  it('a governed user with usage left runs, and the hold covers the paid retry', async () => {
    const user = freshUser();
    const r = await post(
      '/api/recipes/run',
      { recipe, values: {}, model: 'z-ai/glm-4.5-air:free', messages: [{ role: 'user', content: 'go' }] },
      { 'x-test-user': user }
    );
    expect(r.status).toBe(200);
    const reserved = db.events.find((e) => e.userId === user);
    expect(reserved?.costUsd).toBeGreaterThan(0); // priced at TEXT_FALLBACK, not the $0 primary
  });
});

describe('helpers', () => {
  it('localChatTitle: first words, capitalized, no trailing punctuation; small talk stays untitled', () => {
    expect(localChatTitle('what is the best way to learn rust in 2026?')).toBe('What is the best way to');
    expect(localChatTitle('  **Fix** my CORS error!!  ')).toBe('Fix my CORS error');
    expect(localChatTitle('hi')).toBe('');
    expect(localChatTitle('test')).toBe('');
    expect(localChatTitle('')).toBe('');
    expect(localChatTitle(`${'x'.repeat(80)} y`).length).toBeLessThanOrEqual(61);
  });

  it('freeModelsOnlyPlan keeps only :free models, drops paid meta-tools and the web plugin', async () => {
    const base = {
      resolved: { provider: 'openrouter' as const, apiKey: 'k' },
      messages: [{ role: 'user' as const, content: 'hi' }],
      model: 'a/one:free',
      requestedModel: '',
      reasoningLevel: 'none' as const,
      webSearch: true,
      fallbackModels: ['a/one:free', TEXT_FALLBACK],
      tools: [{ name: 'run_agent_swarm' }, { name: 'deep_research' }, { name: 'delegate_tasks' }, { name: 'web_search' }] as never[],
      customAgents: [],
      attachments: []
    };
    const plan = await freeModelsOnlyPlan(base as never);
    expect(plan).toMatchObject({ model: 'a/one:free', fallbackModels: ['a/one:free'], webSearch: false, freeModelsOnly: true });
    expect(plan!.tools.map((t) => t.name)).toEqual(['web_search']);
    expect(chatPricedModels(plan!)).toEqual(['a/one:free']); // no paid retry priced or sent
    expect(await freeModelsOnlyPlan({ ...base, resolved: { provider: 'nvidia', apiKey: 'k' } } as never)).toBeNull();
  });

  it('noFreeModelDetails keeps the percent-only message and adds the calm reason', () => {
    const d = noFreeModelDetails({ reason: 'usage_budget_exhausted', message: 'You have used it all.' } as never);
    expect(d.message).toBe('You have used it all. Free models are busy right now too, so nothing was spent — try again in a few minutes.');
  });
});

describe('gate S9 — the real engine’s provider usage drives the settle', () => {
  const ask = (content: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: 'user', content }], ...extra });
  const turnEvents = (user: string) => db.events.filter((e) => e.userId === user && e.operation === 'chat.completion');

  it('settles the SUM the provider reported across every call of the turn (tool round + answer)', async () => {
    const user = freshUser();
    // Round 1 asks for a tool (an unknown one: nothing external runs), round 2 answers.
    engine.script = [{ toolCall: 'no_such_tool', costUsd: 0.3 }, { costUsd: 0.07 }];
    const r = await post('/api/chat', ask('Explain how tides work'), { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(engine.providerCalls.length).toBeGreaterThanOrEqual(2);
    const ev = turnEvents(user);
    expect(ev).toHaveLength(1);
    expect(ev[0].status).toBe('SETTLED');
    expect(ev[0].costUsd).toBeCloseTo(0.37, 9);
  });

  it('a turn that fails AFTER a paid round settles that spend instead of releasing it (POST / and /stream)', async () => {
    for (const path of ['/api/chat', '/api/chat/stream']) {
      const user = freshUser();
      engine.script = [{ toolCall: 'no_such_tool', costUsd: 0.3 }, { fail: true }];
      const r = await post(path, ask('Explain how tides work'), { 'x-test-user': user });
      if (path === '/api/chat') expect(r.status).toBeGreaterThanOrEqual(500);
      else expect(sseEvents(r.text).map((e) => e.event)).toContain('error');
      const ev = turnEvents(user);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ status: 'SETTLED' });
      expect(ev[0].costUsd).toBeCloseTo(0.3, 9);
    }
  });

  it('review: a failure AFTER the turn settled never flips the settled row to RELEASED (/, /stream, /swarm)', async () => {
    engine.swarm.mockResolvedValue({ text: 'Team answer.', model: 'google/gemini-2.5-flash', usage: { providerCostUsd: 0.25 } });
    for (const path of ['/api/chat', '/api/chat/stream', '/api/chat/swarm']) {
      const user = freshUser();
      engine.script = [{ costUsd: 0.25 }];
      stats.throwOnce = true;
      const r = await post(path, ask('Explain how tides work'), { 'x-test-user': user });
      if (path === '/api/chat') expect(r.status).toBeGreaterThanOrEqual(500);
      else expect(sseEvents(r.text).map((e) => e.event)).toContain('error');
      expect(stats.throwOnce).toBe(false); // the post-settle failure really happened
      const ev = turnEvents(user);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ status: 'SETTLED' });
      expect(ev[0].costUsd).toBeCloseTo(0.25, 9);
    }
  });

  it('a failure that spent nothing still releases the hold', async () => {
    const user = freshUser();
    engine.fail = true;
    const r = await post('/api/chat', ask('Explain how tides work'), { 'x-test-user': user });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(turnEvents(user).map((e) => e.status)).toEqual(['RELEASED']);
  });

  it('governed responses never carry the dollar figure; admins keep it', async () => {
    const governed = await post('/api/chat', ask('hi'), { 'x-test-user': freshUser() });
    expect(governed.status).toBe(200);
    expect(governed.json.usage).toMatchObject({ totalTokens: expect.any(Number) });
    expect(governed.json.usage.providerCostUsd).toBeUndefined();
    expect(governed.text).not.toMatch(/providerCostUsd|usd/i);
    const admin = await post('/api/chat', ask('hi'), { 'x-test-user': freshUser(), 'x-test-admin': '1' });
    expect(admin.json.usage.providerCostUsd).toBeCloseTo(0.002, 9);
  });

  it('holds scale with the prepared context (chat and recipes), not the first 8,000 body characters', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'word '.repeat(4_800) }));
    history.push({ role: 'user', content: 'Summarize all of that' });
    const big = await post('/api/chat', { messages: history }, { 'x-test-user': freshUser() });
    expect(big.status).toBe(200);
    const bigSeed = seeds.list.find((x) => x.operation === 'chat.completion');
    expect(bigSeed?.inputTokens).toBeGreaterThanOrEqual(170_000);

    seeds.list = [];
    await post('/api/chat', ask('hi'), { 'x-test-user': freshUser() });
    const small = seeds.list.find((x) => x.operation === 'chat.completion');
    expect(small?.inputTokens).toBeLessThan(bigSeed!.inputTokens! / 10);

    seeds.list = [];
    const run = await post(
      '/api/recipes/run',
      { recipe: { title: 'Summarizer', instructions: 'Summarize the conversation.' }, values: {}, messages: history },
      { 'x-test-user': freshUser() }
    );
    expect(run.status).toBe(200);
    expect(seeds.list.find((x) => x.operation === 'chat.completion')?.inputTokens).toBeGreaterThanOrEqual(170_000);
  });

  it('a pinned model the pricing table does not know is held at its live catalog price', async () => {
    const user = freshUser();
    const r = await post('/api/chat', ask('Explain recursion with an example', { model: 'vendor/pricey' }), { 'x-test-user': user });
    expect(r.status).toBe(200);
    // ≥ 2,048 answer tokens at $75/M alone is $0.15 — the pricing table's guess was $0.01.
    expect(turnEvents(user)[0].holdUsd).toBeGreaterThan(0.15);
  });

  it('review: an OpenRouter VARIANT of a pricey model (`:nitro`, `:online`, any case) is held at its base model’s live price', async () => {
    // The catalog lists only `vendor/pricey`; OpenRouter still serves `vendor/pricey:nitro` at
    // (at least) that price. The hold used to miss the catalog row and fall to the cheap table guess.
    for (const pin of ['vendor/pricey:nitro', 'vendor/pricey:online', 'Vendor/Pricey']) {
      const user = freshUser();
      const r = await post('/api/chat', ask('Explain recursion with an example', { model: pin }), { 'x-test-user': user });
      expect(r.status).toBe(200);
      expect(turnEvents(user)[0].holdUsd).toBeGreaterThan(0.15);
    }
  });

  it('review: catalogEntryFor resolves variants to the base row, but never a `:free` id to its paid base', async () => {
    const { catalogEntryFor } = await import('./chat.js');
    const rows = [{ id: 'vendor/pricey' }, { id: 'vendor/cheap:free' }];
    expect(catalogEntryFor(rows, 'vendor/pricey:nitro')?.id).toBe('vendor/pricey');
    expect(catalogEntryFor(rows, 'vendor/cheap:free')?.id).toBe('vendor/cheap:free');
    expect(catalogEntryFor(rows, 'vendor/pricey:free')).toBeUndefined();
    expect(catalogEntryFor(rows, 'vendor/unknown')).toBeUndefined();
    expect(catalogEntryFor(rows, '')).toBeUndefined();
  });

  it('review (MODEL_NOT_ALLOWED decision): a pin outside the legacy plan list is advisory — held at its live price, settled at real cost, never free', async () => {
    policy.deny.add('vendor/pricey');
    const user = freshUser();
    engine.script = [{ costUsd: 0.42 }];
    const r = await post('/api/chat', ask('Explain recursion with an example', { model: 'vendor/pricey' }), { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(engine.providerCalls[0].model).toBe('vendor/pricey');
    const ev = turnEvents(user)[0];
    expect(ev.holdUsd).toBeGreaterThan(0.15);
    expect(ev).toMatchObject({ status: 'SETTLED' });
    expect(ev.costUsd).toBeCloseTo(0.42, 9);
    // …and a governed user whose usage can't cover it is re-planned onto a free model instead.
    engine.providerCalls = [];
    const poor = freshUser();
    db.budgets.set(poor, 0.1);
    const r2 = await post('/api/chat', ask('Explain recursion with an example', { model: 'vendor/pricey' }), { 'x-test-user': poor });
    expect(r2.status).toBe(200);
    expect(engine.providerCalls.some((c) => c.model === 'vendor/pricey')).toBe(false);
  });

  it('a governed user whose usage can’t cover a pricey pin gets a free model instead — never the unpriced pin', async () => {
    const user = freshUser();
    db.budgets.set(user, 0.1);
    const r = await post('/api/chat', ask('Explain recursion with an example', { model: 'vendor/pricey' }), { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(engine.providerCalls.some((c) => c.model === 'vendor/pricey')).toBe(false);
    const notice = r.json.notices.find((n: { tool?: string }) => n.tool === 'usage_budget');
    expect(notice.message).toContain('instead of vendor/pricey');
  });

  it('a pinned :free model on a real question gets no paid web plugin; a paid pin keeps it', async () => {
    await post('/api/chat', ask('Explain how tides work in detail', { model: 'z-ai/glm-4.5-air:free' }), { 'x-test-user': freshUser() });
    expect(engine.calls[0].webSearch).toBe(false);
    expect(engine.providerCalls[0].webSearch).toBeFalsy();
    engine.calls = [];
    await post('/api/chat', ask('Explain how tides work in detail', { model: 'vendor/pricey' }), { 'x-test-user': freshUser() });
    expect(engine.calls[0].webSearch).toBe(true);
  });

  it('L2: a free-models-only turn never reaches a paid model at the provider, even after an empty answer', async () => {
    const user = freshUser();
    exhaust(user);
    engine.script = [{ empty: true }];
    const r = await post('/api/chat', ask('Explain how tides work'), { 'x-test-user': user });
    expect(r.status).toBe(200);
    expect(r.json.text).toBe('Here is your answer.');
    expect(engine.providerCalls.length).toBe(2);
    for (const c of engine.providerCalls) {
      expect(isPaid(c.model)).toBe(false);
      expect((c.models || []).every((m) => !isPaid(m))).toBe(true);
      expect(c.fallbackModel).toBeUndefined();
      expect(c.freeOnly).toBe(true);
    }
  });
});
