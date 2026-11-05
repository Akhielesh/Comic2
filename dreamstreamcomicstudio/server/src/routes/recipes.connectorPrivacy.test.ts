// @vitest-environment node
// Recipes and connected-account privacy (Google Limited Use), the /api/recipes half of
// chat.connectorPrivacy.test.ts:
//   - /run runs inside prepareChat's privacy decision: every OpenRouter call of a connector run
//     denies data collection and no free model takes it, even when the request carried no
//     clientContext for runRecipe to read the decision from (history the provenance store knows);
//   - a reply connected content actually entered carries `connectorData: true` and is recorded in
//     the provenance store; other replies are unchanged;
//   - a swarm recipe's hold adds its paid planner and agents on a connector run;
//   - /distill: the transcript goes to the model, so a transcript carrying connector output is a
//     connector call (deny, no free model), and a FREE reflection of one is refused with 409 before
//     anything is reserved or sent. Free only with a pinned paid model is a paid turn.
// Harness: the real recipes route, prepareChat, runRecipe, engines, gateway and OpenRouter provider;
// only `fetch` to OpenRouter is faked (no network, no paid call), plus the usage-budget database
// and the connector lookups.
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
  isMemoryEnabled: async () => true,
  buildUserMemoryBlock: async () => null,
  rememberUserMemories: async () => 0
}));
const conn = vi.hoisted(() => ({ rows: new Map<string, { connector_id: string; status: string }[]>() }));
vi.mock('../connectors/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/store.js')>()),
  listConnections: async (userId: string) => conn.rows.get(userId) ?? [],
  getActiveConnection: async () => null
}));
vi.mock('../connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null, retrieveItems: async () => [] }));
// The provenance store: the real one (in-process cache, the database is unavailable here), observed.
vi.mock('../ai/privacy/replyProvenance.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/privacy/replyProvenance.js')>();
  return { ...actual, recordConnectorReply: vi.fn((userId: string | undefined, text: unknown) => actual.recordConnectorReply(userId, text)) };
});

const FREE_A = 'vendor/free-a:free';
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
    // The route's own default and paid-net models are priced under the ids the code uses (read lazily, at call time).
    getCatalog: async () => {
      const { OPENROUTER_TEXT_MODEL } = await import('../config.js');
      const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');
      return {
        models: [
          textModel('vendor/free-a:free'),
          textModel('vendor/free-b:free'),
          textModel('vendor/smart', 0.000003, 0.000015),
          textModel(OPENROUTER_TEXT_MODEL, 0.0000003, 0.0000025),
          textModel(TEXT_FALLBACK, 0.00000015, 0.0000006)
        ],
        fetchedAt: Date.now(),
        degraded: false
      };
    }
  };
});
vi.mock('../ai/autoRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/autoRouter.js')>()),
  pickSmartChatModel: async () => 'vendor/smart'
}));

type Ev = { userId: string; reservationId: string; costUsd: number; holdUsd: number; status: 'RESERVED' | 'SETTLED' | 'RELEASED'; operation: string };
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
    estimateCharge: async (seed: { model?: string; estimateFloorUsd?: number }) => est(Math.max(price(seed.model), seed.estimateFloorUsd ?? 0), seed.model),
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
const { recordConnectorReply } = await import('../ai/privacy/replyProvenance.js');
const { CONNECTED_DATA_FREE_MODEL_CODE, connectedDataFreeModelMessage } = await import('../ai/privacy/connectorData.js');
const recorded = vi.mocked(recordConnectorReply);

const used = (userId: string) => db.events.filter((e) => e.userId === userId && (e.status === 'SETTLED' || e.status === 'RESERVED')).reduce((s, e) => s + e.costUsd, 0);
allowance.setUsageBudgetRpc({
  tryReserve: async ({ userId, reservationId, estimateUsd, event }) => {
    const budget = Number(event.default_budget_usd);
    const u = used(userId);
    const pct = (v: number) => Math.min(100, Math.round((v / budget) * 1000) / 10);
    if (estimateUsd > 0 && u + estimateUsd > budget) return { governed: true, allowed: false, period: 'lifetime', pct_used: pct(u), pct_left: 100 - pct(u) };
    db.events.push({ userId, reservationId, costUsd: estimateUsd, holdUsd: estimateUsd, status: 'RESERVED', operation: String(event.operation) });
    return { governed: true, allowed: true, pct_used: pct(u + estimateUsd), pct_left: 100 - pct(u + estimateUsd) };
  },
  status: async () => ({ governed: true, budget_usd: 10, spent_usd: 0, inflight_usd: 0 }),
  adminList: async () => []
});

// ── The fake OpenRouter: every request body is recorded; replies follow a script ──────────────────
type Body = { model: string; models?: string[]; provider?: Record<string, unknown>; messages: { role: string; content: unknown }[]; stream?: boolean };
type Step = { toolCalls?: { id: string; name: string; arguments: string }[]; text?: string };
const or = vi.hoisted(() => ({ bodies: [] as Body[], script: [] as Step[] }));
const realFetch = globalThis.fetch;
const reply = (body: Body) => {
  const step = or.script.shift();
  const system = String(body.messages[0]?.content ?? '');
  const message = step?.toolCalls
    ? { content: '', tool_calls: step.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
    : { content: step?.text ?? (system.includes('planner') ? '[]' : 'Here is your answer.') };
  return { model: body.model, choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: /:free$/.test(body.model) ? 0 : 0.001 } };
};
const fakeFetch = async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  if (!url.startsWith('https://openrouter.ai/')) return realFetch(input as string, init as RequestInit);
  const body = JSON.parse(String(init?.body || '{}')) as Body;
  or.bodies.push(body);
  const data = reply(body);
  if (body.stream) {
    const msg = data.choices[0].message as { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    const delta = msg.tool_calls ? { tool_calls: msg.tool_calls.map((c, index) => ({ index, id: c.id, function: c.function })) } : { content: msg.content };
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
app.use('/api/recipes', recipesRouter);
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
  recorded.mockClear();
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

let seq = 0;
/** A fresh user; `connected` gives them a linked Gmail + Calendar. */
const user = (kind: 'plain' | 'connected' = 'plain') => {
  const id = `r-${kind}-${Date.now()}-${seq++}`;
  if (kind === 'connected') conn.rows.set(id, [{ connector_id: 'gmail', status: 'connected' }, { connector_id: 'google_calendar', status: 'connected' }]);
  return id;
};
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await realFetch(`${base}/api/recipes${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
};
/** The `final` event's payload of an SSE recipe run. */
const finalOf = (sse: string): Record<string, any> | null => {
  const m = sse.match(/event: final\ndata: (.*)\n/);
  return m ? JSON.parse(m[1]) : null;
};
const isHelper = (b: Body) => String(b.messages[0]?.content ?? '').includes('long-term memory');
const turnBodies = () => or.bodies.filter((b) => !isHelper(b));
const anyFree = (b: Body) => [b.model, ...(b.models || [])].some((m) => /:free$/.test(m));
const DENY = { data_collection: 'deny' };
const FREE_ONLY = { 'X-Free-Only': 'true' };
const runEvents = (userId: string) => db.events.filter((e) => e.userId === userId && e.operation === 'chat.completion');

const ASK = [{ role: 'user', content: 'Plan my week in three bullets' }];
const single = (tools: string[] = ['web_search']) => ({ recipe: { title: 'Weekly plan', prompt: 'Plan my week in three bullets.', tools }, messages: ASK });
const team = { recipe: { title: 'Team brief', prompt: 'Brief me on tides.', swarm: true }, messages: ASK };
/** A transcript carrying a connector tool's output (the JSON tool protocol's TOOL_RESULT line). */
const CONNECTOR_TRANSCRIPT = 'User: what did Dana say?\nTOOL_RESULT (gmail_search): Dana asked to move the launch to Friday.\nAI: Dana wants Friday.';
const PLAIN_TRANSCRIPT = 'User: plan my week\nAI: Here is your plan.';

describe('/run follows prepareChat’s privacy decision', () => {
  it('a connected user’s run: every model call denies data collection and none is on a free model', async () => {
    const r = await post('/run', single(), { 'x-test-user': user('connected') });
    expect(r.status).toBe(200);
    const bodies = turnBodies();
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b.provider).toEqual(DENY);
      expect(anyFree(b)).toBe(false);
    }
  });

  it('history the provenance store knows (plain text, no clientContext) makes it a connector run, and its reply is marked', async () => {
    const id = user('plain');
    const earlier = 'Dana asked to move the launch to Friday.';
    await recordConnectorReply(id, earlier);
    recorded.mockClear();
    const messages = [{ role: 'user', content: 'Summarise my unread email' }, { role: 'assistant', content: earlier }, ...ASK];
    const r = await post('/run', { ...single(), messages }, { 'x-test-user': id });
    expect(r.status).toBe(200);
    for (const b of turnBodies()) expect(b.provider).toEqual(DENY);
    expect(finalOf(r.text)?.connectorData).toBe(true);
    expect(recorded).toHaveBeenCalledWith(id, 'Here is your answer.');
  });

  it('a reply a connector tool answered carries connectorData: true and is recorded', async () => {
    const id = user('connected');
    or.script = [{ toolCalls: [{ id: 'c1', name: 'gmail_search', arguments: '{"query":"launch"}' }] }, { text: 'Dana wrote about Friday.' }];
    const r = await post('/run', single(['gmail_search']), { 'x-test-user': id });
    expect(r.status).toBe(200);
    const final = finalOf(r.text);
    expect(final?.toolEvents?.some((e: { tool: string }) => e.tool === 'gmail_search')).toBe(true);
    expect(final?.connectorData).toBe(true);
    expect(recorded).toHaveBeenCalledWith(id, 'Dana wrote about Friday.');
  });

  it('a reply nothing connected entered is not marked (deny still applies to the run)', async () => {
    const r = await post('/run', single(), { 'x-test-user': user('connected') });
    const final = finalOf(r.text);
    expect(final).not.toBeNull();
    expect(final && 'connectorData' in final).toBe(false);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('a plain user’s run is unchanged: no provider field, no mark', async () => {
    const r = await post('/run', single(), { 'x-test-user': user('plain') });
    expect(r.status).toBe(200);
    for (const b of turnBodies()) expect('provider' in b).toBe(false);
    const final = finalOf(r.text);
    expect(final && 'connectorData' in final).toBe(false);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('a connected user’s swarm recipe holds for its paid planner and agents too', async () => {
    const plain = user('plain');
    await post('/run', team, { 'x-test-user': plain });
    const connected = user('connected');
    await post('/run', team, { 'x-test-user': connected });
    const [plainHold] = runEvents(plain);
    const [connectedHold] = runEvents(connected);
    expect(plainHold.holdUsd).toBeGreaterThan(0);
    expect(connectedHold.holdUsd).toBeGreaterThan(plainHold.holdUsd);
  });
});

describe('/distill: the transcript is connected content when it carries connector output', () => {
  it('a free-only reflection of such a transcript is refused (409) before anything is reserved or sent', async () => {
    const id = user('plain');
    const r = await post('/distill', { goal: 'Reply to Dana', transcript: CONNECTOR_TRANSCRIPT, messages: ASK }, { 'x-test-user': id, ...FREE_ONLY });
    expect(r.status).toBe(409);
    expect(r.json?.error?.code).toBe(CONNECTED_DATA_FREE_MODEL_CODE);
    expect(r.json?.error?.message).toBe(connectedDataFreeModelMessage(true));
    expect(or.bodies).toHaveLength(0);
    expect(runEvents(id)).toHaveLength(0);
  });

  it('a pinned free model (not Free only) is refused too, with the “pick a standard model” copy', async () => {
    const r = await post('/distill', { goal: 'Reply to Dana', transcript: CONNECTOR_TRANSCRIPT, messages: ASK, model: FREE_A }, { 'x-test-user': user('plain') });
    expect(r.status).toBe(409);
    expect(r.json?.error?.message).toBe(connectedDataFreeModelMessage(false));
    expect(or.bodies).toHaveLength(0);
  });

  it('a paid reflection of such a transcript runs with data collection denied and no free model', async () => {
    const r = await post('/distill', { goal: 'Reply to Dana', transcript: CONNECTOR_TRANSCRIPT, messages: ASK }, { 'x-test-user': user('plain') });
    expect(r.status).toBe(200);
    const bodies = turnBodies();
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b.provider).toEqual(DENY);
      expect(anyFree(b)).toBe(false);
    }
  });

  it('Free only with a pinned paid model is a paid turn: it runs on that model, denied', async () => {
    const r = await post('/distill', { goal: 'Reply to Dana', transcript: CONNECTOR_TRANSCRIPT, messages: ASK, model: 'vendor/smart' }, { 'x-test-user': user('plain'), ...FREE_ONLY });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(body.model).toBe('vendor/smart');
    expect(body.provider).toEqual(DENY);
  });

  it('a plain transcript is unchanged: a free-only reflection runs on a free model with no provider field', async () => {
    const r = await post('/distill', { goal: 'Plan my week', transcript: PLAIN_TRANSCRIPT, messages: ASK }, { 'x-test-user': user('plain'), ...FREE_ONLY });
    expect(r.status).toBe(200);
    const [body] = turnBodies();
    expect(/:free$/.test(body.model)).toBe(true);
    expect('provider' in body).toBe(false);
  });
});
