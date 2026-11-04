// @vitest-environment node
// Chat privacy (Google Limited Use): content from the user's connected accounts never reaches a
// model endpoint that may log or train on it.
//   - A turn that can carry connector content (connector tools offered, the connector context block,
//     marked history) sends `provider: { data_collection: 'deny' }` on EVERY OpenRouter call: the
//     first call, tool-loop rounds, the auto-memory summary, the swarm's planner/agents/synthesis,
//     and the title / memory / follow-up helpers — and no `:free` model takes it.
//   - A free-model turn gets no connector tool and no connector context; a free turn whose history
//     already carries connector content is refused (409, calm copy) before anything is sent.
//   - The free-model fallbacks (capped shared key, usage-budget re-plan) never take such a
//     conversation; the refusal or failure is reported honestly.
//   - A plain turn (no connections, no marked history) is unchanged: no provider field at all.
// Harness: the real chat route, engine, gateway and OpenRouter provider; only `fetch` to OpenRouter
// is faked (no network, no paid call), plus the usage-budget database and the connector lookups.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The connector lookups: who has which connection, and the connector context block (RAG).
const conn = vi.hoisted(() => ({
  rows: new Map<string, { connector_id: string; status: string }[]>(),
  ragBlock: vi.fn(async (_userId: string, _q: string): Promise<string | null> => null)
}));
vi.mock('../connectors/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/store.js')>()),
  listConnections: async (userId: string) => conn.rows.get(userId) ?? [],
  getActiveConnection: async () => null
}));
vi.mock('../connectors/retrieval.js', () => ({
  buildConnectorContextBlock: (userId: string, q: string) => conn.ragBlock(userId, q),
  retrieveItems: async () => []
}));

const FREE_A = 'meta-llama/llama-3.3-70b-instruct:free';
const FREE_B = 'qwen/qwen3-32b:free';
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
        textModel('meta-llama/llama-3.3-70b-instruct:free'),
        textModel('qwen/qwen3-32b:free'),
        textModel('vendor/smart', 0.000003, 0.000015),
        textModel('google/gemini-2.5-flash', 0.0000003, 0.0000025),
        textModel('openai/gpt-4o-mini', 0.00000015, 0.0000006)
      ],
      fetchedAt: Date.now(),
      degraded: false
    })
  };
});
vi.mock('../ai/autoRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/autoRouter.js')>()),
  pickSmartChatModel: async () => 'vendor/smart'
}));

// Usage budget: an in-memory database (as chat.freeOnly.test.ts).
type Ev = { userId: string; reservationId: string; costUsd: number; status: 'RESERVED' | 'SETTLED' | 'RELEASED'; operation: string; model: string };
const db = vi.hoisted(() => ({ events: [] as Ev[], budgets: new Map<string, number>() }));
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
const { markSharedKeyCapped, __resetSharedKeyCircuit } = await import('../ai/providerCircuit.js');
const { CONNECTED_ACCOUNTS_WITHHELD_NOTE, CONNECTED_ACCOUNTS_WITHHELD_NOTICE, CONNECTED_DATA_BUDGET_SENTENCE, CONNECTED_DATA_FREE_MODEL_CODE } =
  await import('../ai/privacy/connectorData.js');

const used = (userId: string) =>
  db.events.filter((e) => e.userId === userId && (e.status === 'SETTLED' || e.status === 'RESERVED')).reduce((s, e) => s + e.costUsd, 0);
allowance.setUsageBudgetRpc({
  tryReserve: async ({ userId, reservationId, estimateUsd, event }) => {
    const budget = db.budgets.get(userId) ?? Number(event.default_budget_usd);
    const u = used(userId);
    const pct = (v: number) => Math.min(100, Math.round((v / budget) * 1000) / 10);
    if (estimateUsd > 0 && u + estimateUsd > budget) return { governed: true, allowed: false, period: 'lifetime', pct_used: pct(u), pct_left: 100 - pct(u) };
    db.events.push({ userId, reservationId, costUsd: estimateUsd, status: 'RESERVED', operation: String(event.operation), model: String(event.model) });
    return { governed: true, allowed: true, pct_used: pct(u + estimateUsd), pct_left: 100 - pct(u + estimateUsd) };
  },
  status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
  adminList: async () => []
});
const exhaust = (userId: string) => {
  db.budgets.set(userId, 10);
  db.events.push({ userId, reservationId: `seed-${userId}`, costUsd: 10, status: 'SETTLED', operation: 'seed', model: 'seed' });
};

// ── The fake OpenRouter: every request body is recorded; replies follow a script ──────────────────
type Body = {
  model: string;
  models?: string[];
  provider?: Record<string, unknown>;
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown }[];
  stream?: boolean;
};
type Step = { toolCalls?: { id: string; name: string; arguments: string }[]; text?: string };
const or = vi.hoisted(() => ({ bodies: [] as Body[], script: [] as Step[] }));
const realFetch = globalThis.fetch;
const reply = (body: Body) => {
  const step = or.script.shift();
  const message = step?.toolCalls
    ? { content: '', tool_calls: step.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
    : { content: step?.text ?? (body.messages[0] && String(body.messages[0].content).includes('planner') ? '[]' : 'Here is your answer.') };
  return { model: body.model, choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: /:free$/.test(body.model) ? 0 : 0.001 } };
};
const fakeFetch = async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  if (!url.startsWith('https://openrouter.ai/')) return realFetch(input as string, init as RequestInit);
  const body = JSON.parse(String(init?.body || '{}')) as Body;
  or.bodies.push(body);
  const data = reply(body);
  if (body.stream) {
    const msg = data.choices[0].message as { content?: string; tool_calls?: unknown[] };
    const delta = msg.tool_calls
      ? { tool_calls: (msg.tool_calls as { id: string; function: { name: string; arguments: string } }[]).map((c, index) => ({ index, id: c.id, function: c.function })) }
      : { content: msg.content };
    const sse = `data: ${JSON.stringify({ model: body.model, choices: [{ delta }] })}\n` + `data: ${JSON.stringify({ usage: data.usage, choices: [] })}\n` + 'data: [DONE]\n';
    return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), { status: 200 });
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
};

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
  vi.stubGlobal('fetch', fakeFetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  or.bodies = [];
  or.script = [];
  db.events = [];
  conn.ragBlock.mockReset().mockImplementation(async () => null);
  __resetSharedKeyCircuit();
  ledger.reserveUsageTokens.mockReset().mockImplementation(async (input: { reservationId?: string; estimate: unknown; governed?: boolean; skipWalletLimits?: boolean; byok?: boolean }) => ({
    allowed: true,
    reservation: {
      reservationId: input.reservationId ?? 'wallet-res',
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
afterEach(() => __resetSharedKeyCircuit());

let seq = 0;
/** A fresh user; `connected` gives them a linked Gmail + Calendar. */
const user = (kind: 'plain' | 'connected' | 'disconnected' = 'plain') => {
  const id = `u-${kind}-${Date.now()}-${seq++}`;
  if (kind === 'connected') conn.rows.set(id, [{ connector_id: 'gmail', status: 'connected' }, { connector_id: 'google_calendar', status: 'connected' }]);
  if (kind === 'disconnected') conn.rows.set(id, [{ connector_id: 'gmail', status: 'disconnected' }]);
  return id;
};

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await realFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
};

const toolNames = (b: Body) => (b.tools || []).map((t) => t.function.name);
const systemText = (b: Body) => String(b.messages[0]?.role === 'system' ? b.messages[0].content : '');
const isHelper = (b: Body) => systemText(b).includes('long-term memory') || systemText(b).includes('title for a chat');
const turnBodies = () => or.bodies.filter((b) => !isHelper(b));
const DENY = { data_collection: 'deny' };
const anyFree = (b: Body) => [b.model, ...(b.models || [])].some((m) => /:free$/.test(m));

const ASK_PLAIN = { messages: [{ role: 'user', content: 'Explain how ocean tides work in detail' }] };
const ASK_EMAIL = { messages: [{ role: 'user', content: 'Check my Gmail inbox for the launch email' }] };
const MARKED_HISTORY = [
  { role: 'user', content: 'Summarise my unread email' },
  { role: 'assistant', content: 'Dana asked to move the launch to Friday.', connectorData: true },
  { role: 'user', content: 'Thanks — now tell me a joke' }
];

describe('a plain turn is unchanged', () => {
  it('user without connections, paid mode: no provider field, the usual chain, no connectorData mark', async () => {
    const r = await post('/api/chat', ASK_PLAIN, { 'x-test-user': user('plain') });
    expect(r.status).toBe(200);
    const bodies = turnBodies();
    expect(bodies.length).toBe(1);
    expect('provider' in bodies[0]).toBe(false);
    // A knowledge question takes the fast lane: the fast default with the cheap paid net, as before.
    expect(bodies[0].model).toBe('google/gemini-2.5-flash');
    expect(bodies[0].models).toEqual(['google/gemini-2.5-flash', 'openai/gpt-4o-mini']);
    expect(systemText(bodies[0])).not.toContain(CONNECTED_ACCOUNTS_WITHHELD_NOTE);
    expect(r.json && 'connectorData' in r.json).toBe(false);
    // The connector context block is still looked up exactly as before.
    expect(conn.ragBlock).toHaveBeenCalledTimes(1);
  });

  it('free-only stays free for a user without connections (no provider field, free chain)', async () => {
    const r = await post('/api/chat', ASK_PLAIN, { 'x-test-user': user('plain'), 'X-Free-Only': 'true' });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(/:free$/.test(body.model)).toBe(true);
    expect('provider' in body).toBe(false);
  });
});

describe('a connector turn: every OpenRouter call denies data collection, no free model', () => {
  it("'tools': a connected user's turn offers gmail_search and carries the flag; the reply is marked", async () => {
    const r = await post('/api/chat', ASK_EMAIL, { 'x-test-user': user('connected') });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(toolNames(body)).toContain('gmail_search');
    expect(body.provider).toEqual(DENY);
    expect(anyFree(body)).toBe(false);
    expect(r.json?.connectorData).toBe(true);
  });

  it('tool-loop rounds (after a connector tool ran) and the auto-memory summary carry it too', async () => {
    or.script = [{ toolCalls: [{ id: 'c1', name: 'gmail_search', arguments: '{"query":"launch"}' }] }, { text: 'Dana wrote about Friday.' }];
    const id = user('connected');
    const r = await post('/api/chat', ASK_EMAIL, { 'x-test-user': id });
    expect(r.status).toBe(200);
    const turn = turnBodies();
    expect(turn.length).toBe(2);
    for (const b of turn) expect(b.provider).toEqual(DENY);
    expect(JSON.stringify(turn[1].messages)).toContain('gmail_search');
    await vi.waitFor(() => expect(or.bodies.some(isHelper)).toBe(true));
    for (const b of or.bodies.filter(isHelper)) expect(b.provider).toEqual(DENY);
  });

  it('over /stream as well', async () => {
    const res = await realFetch(`${base}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user('connected') },
      body: JSON.stringify(ASK_EMAIL)
    });
    const text = await res.text();
    expect(text).toContain('event: final');
    expect(text).toContain('"connectorData":true');
    const [body] = turnBodies();
    expect(body.stream).toBe(true);
    expect(body.provider).toEqual(DENY);
  });

  it("'context': connector items can reach the prompt (connection disconnected, so no connector tool) — still flagged", async () => {
    conn.ragBlock.mockImplementation(async () => '\n\n## Connected account data (the user\'s authorized sources)\n- [Gmail] Lunch Friday\n');
    const r = await post('/api/chat', ASK_PLAIN, { 'x-test-user': user('disconnected') });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(toolNames(body).some((n) => n.startsWith('gmail_'))).toBe(false);
    expect(systemText(body)).toContain('## Connected account data');
    expect(body.provider).toEqual(DENY);
  });

  it("'history': a prior assistant turn marked as connected content flags a user without connections", async () => {
    const r = await post('/api/chat', { messages: MARKED_HISTORY }, { 'x-test-user': user('plain') });
    expect(r.status).toBe(200);
    expect(turnBodies()[0].provider).toEqual(DENY);
  });

  it('the swarm entry: planner, agents (calendar agent included) and synthesis all carry it, none on a free model', async () => {
    const res = await realFetch(`${base}/api/chat/swarm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': user('connected') },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Am I free on Friday afternoon, and what is the weather then?' }] })
    });
    const text = await res.text();
    expect(text).toContain('event: final');
    const bodies = turnBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const b of bodies) {
      expect(b.provider).toEqual(DENY);
      expect(anyFree(b)).toBe(false);
    }
  });
});

describe('free models never receive connector content', () => {
  it('a free-only turn of a connected user: no connector tool, no connector context, the model is told why', async () => {
    const r = await post('/api/chat', ASK_EMAIL, { 'x-test-user': user('connected'), 'X-Free-Only': 'true' });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(/:free$/.test(body.model)).toBe(true);
    expect(toolNames(body).filter((n) => /^(gmail_|drive_|calendar_|sheets_|connected_data_|maps_lookup)/.test(n))).toEqual([]);
    expect(conn.ragBlock).not.toHaveBeenCalled();
    expect(systemText(body)).toContain(CONNECTED_ACCOUNTS_WITHHELD_NOTE);
    // It asked about email, so the reply says honestly why the accounts weren't used.
    expect((r.json?.notices || []).map((n: { message: string }) => n.message)).toContain(CONNECTED_ACCOUNTS_WITHHELD_NOTICE);
    expect('provider' in body).toBe(false);
  });

  it('a pinned free model (paid mode) is a free turn too', async () => {
    const r = await post('/api/chat', { ...ASK_EMAIL, model: FREE_B }, { 'x-test-user': user('connected') });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(body.model).toBe(FREE_B);
    expect(toolNames(body)).not.toContain('gmail_search');
  });

  it('a free-only turn whose history carries connector content is refused: calm 409, nothing sent, nothing reserved', async () => {
    const id = user('plain');
    for (const path of ['/api/chat', '/api/chat/stream', '/api/chat/swarm']) {
      const r = await post(path, { messages: MARKED_HISTORY }, { 'x-test-user': id, 'X-Free-Only': 'true' });
      expect(r.status).toBe(409);
      expect(r.json?.error?.code).toBe(CONNECTED_DATA_FREE_MODEL_CODE);
      expect(r.json?.error?.message).toMatch(/switch to a standard model/);
    }
    expect(or.bodies).toHaveLength(0);
    expect(db.events.filter((e) => e.userId === id)).toHaveLength(0);
  });
});

describe('the free-model fallbacks never take a connector conversation', () => {
  it('capped shared key: a connected conversation keeps its paid chain (no free fallback); a plain one still degrades to free', async () => {
    markSharedKeyCapped();
    const history = [
      { role: 'user', content: 'What is on my calendar tomorrow?' },
      { role: 'assistant', content: 'You have a dentist appointment at 9.' },
      { role: 'user', content: 'Explain how ocean tides work in detail' }
    ];
    await post('/api/chat', { messages: history }, { 'x-test-user': user('connected') });
    const connected = turnBodies()[0];
    expect(anyFree(connected)).toBe(false);
    expect(connected.provider).toEqual(DENY);

    or.bodies = [];
    await post('/api/chat', { messages: history }, { 'x-test-user': user('plain') });
    expect(/:free$/.test(turnBodies()[0].model)).toBe(true);
  });

  it('usage used up: no free re-plan for a connected conversation — an honest refusal, no model call', async () => {
    const id = user('connected');
    exhaust(id);
    const history = [
      { role: 'user', content: 'Summarise my unread email' },
      { role: 'assistant', content: 'Dana asked to move the launch.' },
      { role: 'user', content: 'And anything from Sam?' }
    ];
    const r = await post('/api/chat', { messages: history }, { 'x-test-user': id });
    expect(r.status).toBe(402);
    expect(JSON.stringify(r.json)).toContain(CONNECTED_DATA_BUDGET_SENTENCE);
    expect(or.bodies).toHaveLength(0);
  });

  it('usage used up, first message of a new chat: the free re-plan runs without connector tools or context', async () => {
    const id = user('connected');
    exhaust(id);
    const r = await post('/api/chat', ASK_EMAIL, { 'x-test-user': id });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(/:free$/.test(body.model)).toBe(true);
    expect(toolNames(body)).not.toContain('gmail_search');
    expect(conn.ragBlock).not.toHaveBeenCalled();
    expect('provider' in body).toBe(false);
  });
});

describe('summaries and titles generated from a connected conversation', () => {
  it('/title and /followups carry the flag for a connected user and not for a plain one', async () => {
    const exchange = { messages: [{ role: 'user', content: 'Summarise my unread email' }, { role: 'assistant', content: 'Dana asked to move the launch.' }] };
    await post('/api/chat/title', exchange, { 'x-test-user': user('connected') });
    await post('/api/chat/followups', exchange, { 'x-test-user': user('connected') });
    expect(or.bodies).toHaveLength(2);
    for (const b of or.bodies) expect(b.provider).toEqual(DENY);
    or.bodies = [];
    await post('/api/chat/title', exchange, { 'x-test-user': user('plain') });
    expect(or.bodies).toHaveLength(1);
    expect('provider' in or.bodies[0]).toBe(false);
  });
});
