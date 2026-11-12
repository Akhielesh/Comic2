// @vitest-environment node
// Two follow-ups to connected-account privacy (ai/privacy) and the chat helpers:
//  A. Server long-term memory embeds its query — the turn's last user message — through the platform
//     Gemini key (services/userMemory.ts). A conversation that carries, or may carry, connected content
//     (a user with a connection, marked history, a failed connection lookup) never sends that query to
//     Gemini until the owner lists `gemini` in CONNECTOR_PROVIDERS_CONFIRMED, and a withheld (free) turn
//     of a user with connections never embeds it at all — the usage-budget free re-plan included, and a
//     failed connection lookup counting as connections. Memory still reaches the turn through word
//     search and recency. A user with no connection keeps the vector search, and the gate reuses the
//     turn's own connection and provenance lookups (no extra query on the turn's path).
//  B. Every chat helper (enhance, title, memory, auto-memory, memory import, follow-ups) calls the
//     resolved provider's own model: a direct provider used to receive the OpenRouter slug and fail
//     silently. OpenRouter and NVIDIA are unchanged; a withheld helper still sends nothing.
//  C. POST /api/chat/memory runs on the `source` the client sends, under the same wave 0 gates.
// Harness: the real chat route, engine, gateway, providers and memory service; only `fetch` to the
// model and embedding endpoints is faked (no network, no paid call), plus Supabase (the two memory
// tables and the vector RPC, in memory), the connector lookups and the wallet ledger.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// ── Supabase: the memory tables and the vector search, in memory; any other table is unavailable ──
type MemRow = { id: string; user_id: string; product: string; kind: string; content: string; updated_at: string };
const sb = vi.hoisted(() => ({
  rows: [] as MemRow[],
  /** Each user_memories read: its full-text query (undefined for the recency query). */
  reads: [] as { userId?: unknown; textSearch?: string }[],
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  /** Every other table a test touched (each read then fails: there is no database). */
  otherTables: [] as string[]
}));
vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'user_memory_prefs') {
        const q: Record<string, unknown> = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: true }, error: null }) };
        return q;
      }
      if (table !== 'user_memories') {
        sb.otherTables.push(table);
        throw new Error('no database in tests');
      }
      const f: { eq: [string, unknown][]; neq: [string, unknown][]; textSearch?: string } = { eq: [], neq: [] };
      const run = (limit: number) => {
        sb.reads.push({ userId: f.eq.find(([k]) => k === 'user_id')?.[1], textSearch: f.textSearch });
        const out = sb.rows
          .filter(
            (r) =>
              f.eq.every(([k, v]) => (r as Record<string, unknown>)[k] === v) &&
              f.neq.every(([k, v]) => (r as Record<string, unknown>)[k] !== v) &&
              (!f.textSearch || f.textSearch.split(/\s+/).some((w) => w.length > 3 && r.content.toLowerCase().includes(w.toLowerCase())))
          )
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return { data: out.slice(0, limit), error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => (f.eq.push([k, v]), q),
        neq: (k: string, v: unknown) => (f.neq.push([k, v]), q),
        textSearch: (_c: string, query: string) => ((f.textSearch = query), q),
        order: () => q,
        limit: async (n: number) => run(n),
        upsert: async () => ({ error: null })
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'match_user_memories') throw new Error('no database in tests');
      sb.rpc.push({ name, args });
      return { data: sb.rows.filter((r) => r.user_id === args.p_user_id).slice(0, Number(args.p_limit)), error: null };
    }
  })
}));
// The memory service embeds through the platform Gemini key: a (fake) key, so embedText would call out.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  ASSISTANT_GEMINI_API_KEY: 'test-embedding-key'
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

// The connector lookups: who has which connection; `failing` users' lookups throw.
const conn = vi.hoisted(() => ({
  rows: new Map<string, { connector_id: string; status: string }[]>(),
  failing: new Set<string>(),
  /** Each listConnections call, by user. */
  lookups: [] as string[]
}));
vi.mock('../connectors/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/store.js')>()),
  listConnections: async (userId: string) => {
    conn.lookups.push(userId);
    if (conn.failing.has(userId)) throw new Error('connections store down');
    return conn.rows.get(userId) ?? [];
  },
  getActiveConnection: async () => null
}));
vi.mock('../connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null, retrieveItems: async () => [] }));

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

// The wallet ledger and the estimator (metering is off in this file: no usage budget is checked).
vi.mock('../services/billingLedger.js', () => ({
  reserveUsageTokens: vi.fn(async (input: { reservationId?: string; estimate: unknown; byok?: boolean }) => ({
    allowed: true,
    reservation: { reservationId: input.reservationId ?? 'wallet-res', byokBypass: !!input.byok, estimated: input.estimate, usage: {}, governed: false, walletSkipped: false }
  })),
  settleReservation: vi.fn(async () => ({ actualCt: 0, billableUsd: 0, providerCostUsd: 0, reservationReleased: true })),
  releaseReservation: vi.fn(async () => undefined),
  getBillingSummary: vi.fn()
}));
vi.mock('../services/costEstimator.js', () => {
  // Like the real estimator, a `:free` model is $0 (the metered re-plan test reserves it at $0).
  const est = (model?: string) => {
    const usd = /:free$/.test(model || '') ? 0 : 0.001;
    return {
      currency: 'USD',
      ctPerUsd: 10_000,
      markup: 1.3,
      estimatedProviderCostUsd: usd,
      estimatedBillableUsd: usd * 1.3,
      estimatedCt: Math.round(usd * 13_000),
      lines: [],
      modelPricing: { model }
    };
  };
  return {
    buildEstimateFromRequestBody: (provider: string, model: string, operation: string, _body: unknown, explicit: Record<string, unknown> = {}) => ({ provider, model, operation, ...explicit }),
    estimateCharge: async (seed: { model?: string }) => est(seed.model),
    buildSettleEstimateFromUsage: async (seed: { model?: string }) => est(seed.model)
  };
});
vi.mock('../middleware/accountKeys.js', () => ({ hasAccountKeyFor: vi.fn(async () => false) }));
vi.mock('../services/rbac.js', () => ({ isBootstrapAdminEmail: () => false, getUserRoles: vi.fn(async () => []) }));

const allowance = await import('../services/platformAllowance.js');
const { chatRouter, helperModelFor } = await import('./chat.js');
const { errorHandler } = await import('../middleware/errors.js');
const { defaultModelForProvider } = await import('../ai/gateway.js');
const { NVIDIA_TEXT_MODEL, OPENROUTER_TEXT_MODEL } = await import('../config.js');
const { TEXT_FALLBACK } = await import('../ai/autoRouter.js');
const { CONNECTED_MEMORY_PRODUCT } = await import('../ai/privacy/connectorData.js');

// ── The fake endpoints: every request is recorded per vendor ───────────────────────────────────────
/** `lookups`: the connection and provenance-store lookups made so far (the turn's own path, at its model call). */
type Sent = { url: string; body: Record<string, any>; lookups?: { connections: number; provenance: number } };
const net = vi.hoisted(() => ({
  embeds: [] as { taskType: string; text: string }[],
  openrouter: [] as Sent[],
  nvidia: [] as Sent[],
  anthropic: [] as Sent[],
  openai: [] as Sent[],
  gemini: [] as Sent[]
}));
const realFetch = globalThis.fetch;
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
const fakeFetch = async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  const body = (() => {
    try {
      return JSON.parse(String(init?.body || '{}')) as Record<string, any>;
    } catch {
      return {};
    }
  })();
  if (url.includes(':embedContent')) {
    net.embeds.push({ taskType: String(body.taskType), text: String(body.content?.parts?.[0]?.text ?? '') });
    return json({ embedding: { values: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) } });
  }
  const openAiShape = (log: Sent[], text: string) => {
    log.push({ url, body });
    return json({ model: body.model, choices: [{ message: { content: text } }], usage });
  };
  if (url.startsWith('https://api.anthropic.com/')) {
    net.anthropic.push({ url, body });
    return json({ model: body.model, content: [{ type: 'text', text: '- Likes tides' }], usage: { input_tokens: 10, output_tokens: 10 } });
  }
  if (url.startsWith('https://api.openai.com/')) return openAiShape(net.openai, 'Ocean Tides Explained');
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return openAiShape(net.gemini, 'Ocean Tides Explained');
  if (url.startsWith('https://integrate.api.nvidia.com/')) return openAiShape(net.nvidia, 'Ocean Tides Explained');
  if (url.startsWith('https://openrouter.ai/')) {
    net.openrouter.push({
      url,
      body,
      lookups: { connections: conn.lookups.length, provenance: sb.otherTables.filter((t) => t === 'chat_connector_replies').length }
    });
    const data = { model: body.model, choices: [{ message: { content: 'Here is your answer.' } }], usage: { ...usage, cost: 0.001 } };
    if (body.stream) {
      const sse =
        `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Here is your answer.' } }] })}\n` +
        `data: ${JSON.stringify({ usage: data.usage, choices: [] })}\n` +
        'data: [DONE]\n';
      return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), { status: 200 });
    }
    return json(data);
  }
  return realFetch(input as string, init as RequestInit);
};

// `x-test-keys: openrouter,anthropic,…` names the PLATFORM keys the request has (default: OpenRouter).
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => {
  const r = req as unknown as Record<string, unknown>;
  r.user = { id: String(req.header('x-test-user') || 'user-1'), email: 'tester@example.com' };
  const keys = String(req.header('x-test-keys') || 'openrouter').split(',').map((s) => s.trim()).filter(Boolean);
  r.apiKeys = { providerKeys: Object.fromEntries(keys.map((id) => [id, { key: `platform-${id}`, byok: false }])) };
  next();
});
app.use('/api/chat', chatRouter);
app.use(errorHandler);

let server: Server;
let base = '';
beforeAll(async () => {
  allowance.__setMeteringEnabledForTests(false);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', fakeFetch);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  allowance.__setMeteringEnabledForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  delete process.env.CONNECTOR_PROVIDERS_CONFIRMED;
  sb.rows = [];
  sb.reads = [];
  sb.rpc = [];
  sb.otherTables = [];
  conn.lookups = [];
  for (const k of ['embeds', 'openrouter', 'nvidia', 'anthropic', 'openai', 'gemini'] as const) net[k].length = 0;
});

let seq = 0;
const PLAIN_FACT = 'Prefers short answers about the launch plan';
const CONNECTED_FACT = 'Meeting Dana about the launch plan on Friday';
/** A fresh user with two memories (one distilled from connected content); `connected` adds a Gmail link. */
const user = (kind: 'plain' | 'connected' | 'lookupFails' = 'plain') => {
  const id = `u-${kind}-${Date.now()}-${seq++}`;
  if (kind === 'connected') conn.rows.set(id, [{ connector_id: 'gmail', status: 'connected' }]);
  if (kind === 'lookupFails') conn.failing.add(id);
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  sb.rows.push(
    { id: `${id}-1`, user_id: id, product: 'chat_studio', kind: 'fact', content: PLAIN_FACT, updated_at: at(2) },
    { id: `${id}-2`, user_id: id, product: CONNECTED_MEMORY_PRODUCT, kind: 'fact', content: CONNECTED_FACT, updated_at: at(1) }
  );
  return id;
};

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await realFetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, any> | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, json: parsed, text };
};

const QUESTION = 'What should the launch plan include this quarter?';
const ASK = { messages: [{ role: 'user', content: QUESTION }] };
const systemOf = (b: Record<string, any>) => String(b.messages?.[0]?.role === 'system' ? b.messages[0].content : '');
/** The turn's own OpenRouter call (the helpers that follow it carry their own system prompts). */
const turnBody = () => net.openrouter.find((s) => systemOf(s.body).includes('USER MEMORY'))?.body ?? net.openrouter[0]?.body;
const queryEmbeds = () => net.embeds.filter((e) => e.taskType === 'RETRIEVAL_QUERY');
const AUTO_MEMORY = 'You maintain a concise long-term memory';
/** Each chat turn ends with a background auto-memory summary: wait for it, so it never lands in a later test. */
const autoMemorySent = (n: number, log: Sent[] = net.openrouter) =>
  vi.waitFor(() => expect(log.filter((s) => (systemOf(s.body) + String(s.body.system || '')).includes(AUTO_MEMORY))).toHaveLength(n));

describe('A. the memory query stays off the Gemini embedding API when the conversation may carry connected content', () => {
  it('a user with a connection (gemini not confirmed): no embedContent request, memory still found by word search', async () => {
    const id = user('connected');
    const r = await post('/api/chat', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    expect(sb.reads.some((q) => q.userId === id && typeof q.textSearch === 'string' && q.textSearch.includes('launch'))).toBe(true);
    expect(systemOf(turnBody())).toContain(PLAIN_FACT);
    await autoMemorySent(1);
  });

  it('a user with no connection keeps the vector search: the query is embedded once and the RPC runs', async () => {
    const id = user('plain');
    const r = await post('/api/chat', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect(queryEmbeds()).toEqual([{ taskType: 'RETRIEVAL_QUERY', text: QUESTION }]);
    expect(sb.rpc.map((c) => c.args.p_user_id)).toEqual([id]);
    expect(systemOf(turnBody())).toContain(PLAIN_FACT);
    await autoMemorySent(1);
  });

  it('once the owner confirms gemini (CONNECTOR_PROVIDERS_CONFIRMED), a connected user’s paid turn embeds the query again', async () => {
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    const id = user('connected');
    const r = await post('/api/chat', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect(queryEmbeds()).toEqual([{ taskType: 'RETRIEVAL_QUERY', text: QUESTION }]);
    expect(sb.rpc).toHaveLength(1);
    await autoMemorySent(1);
  });

  it('a withheld (free) turn of a user with connections never embeds the query, even with gemini confirmed', async () => {
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    const id = user('connected');
    const r = await post('/api/chat', ASK, { 'x-test-user': id, 'X-Free-Only': 'true' });
    expect(r.status).toBe(200);
    expect(/:free$/.test(String(turnBody().model))).toBe(true);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    // Word search, without the rows distilled from connected content (the free-turn rule).
    const system = systemOf(turnBody());
    expect(system).toContain(PLAIN_FACT);
    expect(system).not.toContain(CONNECTED_FACT);
    await autoMemorySent(1);
  });

  it('marked history, or a connection lookup that failed, counts as connected content too (no embedding)', async () => {
    const marked = user('plain');
    const history = [
      { role: 'user', content: 'Summarise my unread email' },
      { role: 'assistant', content: 'Dana asked to move the launch to Friday.', connectorData: true },
      { role: 'user', content: QUESTION }
    ];
    expect((await post('/api/chat', { messages: history }, { 'x-test-user': marked })).status).toBe(200);
    expect(queryEmbeds()).toHaveLength(0);

    const unknown = user('lookupFails');
    expect((await post('/api/chat', ASK, { 'x-test-user': unknown })).status).toBe(200);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    await autoMemorySent(2);
  });

  it('a withheld (free) turn after a failed connection lookup never embeds the query, even with gemini confirmed (fail closed)', async () => {
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    const id = user('lookupFails');
    const r = await post('/api/chat', ASK, { 'x-test-user': id, 'X-Free-Only': 'true' });
    expect(r.status).toBe(200);
    expect(/:free$/.test(String(turnBody().model))).toBe(true);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    expect(sb.reads.some((q) => q.userId === id && typeof q.textSearch === 'string' && q.textSearch.includes('launch'))).toBe(true);
    const system = systemOf(turnBody());
    expect(system).toContain(PLAIN_FACT);
    expect(system).not.toContain(CONNECTED_FACT);
    await autoMemorySent(1);
  });

  it('a reply the provenance store recorded counts as connected content on any provider (no embedding until gemini is confirmed)', async () => {
    const { recordConnectorReply } = await import('../ai/privacy/replyProvenance.js');
    const reply = 'Dana asked to move the launch to Friday.';
    const history = [
      { role: 'user', content: 'Summarise my unread email' },
      { role: 'assistant', content: reply },
      { role: 'user', content: QUESTION }
    ];
    // OpenRouter: the turn's own provenance lookup answers it.
    const viaOpenRouter = user('plain');
    await recordConnectorReply(viaOpenRouter, reply);
    expect((await post('/api/chat', { messages: history }, { 'x-test-user': viaOpenRouter })).status).toBe(200);
    expect(queryEmbeds()).toHaveLength(0);
    await autoMemorySent(1);

    // A direct provider the owner confirmed makes no provenance lookup of its own: the memory gate asks.
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'anthropic';
    const viaAnthropic = user('plain');
    await recordConnectorReply(viaAnthropic, reply);
    const headers = { 'x-test-user': viaAnthropic, 'x-test-keys': 'anthropic', 'X-Text-Source': 'anthropic' };
    expect((await post('/api/chat', { messages: history }, headers)).status).toBe(200);
    expect(net.anthropic.length).toBeGreaterThan(0);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    await autoMemorySent(1, net.anthropic);
  });

  it('the gate reuses the turn’s own lookups: one connection lookup and one provenance lookup before the model call', async () => {
    const id = user('plain');
    const history = [
      { role: 'user', content: 'Tell me about launch plans' },
      { role: 'assistant', content: 'A launch plan names goals, dates and owners.' },
      { role: 'user', content: QUESTION }
    ];
    expect((await post('/api/chat', { messages: history }, { 'x-test-user': id })).status).toBe(200);
    const call = net.openrouter.find((s) => systemOf(s.body).includes('USER MEMORY'));
    expect(call?.lookups).toEqual({ connections: 1, provenance: 1 });
    // Nothing says the conversation may carry connected content: the vector search still runs.
    expect(queryEmbeds()).toEqual([{ taskType: 'RETRIEVAL_QUERY', text: QUESTION }]);
    await autoMemorySent(1);
  });
});

describe('A. the usage-budget free re-plan is a withheld turn: it never embeds the memory query', () => {
  // Metering on, and a budget that refuses every paid hold (a $0 free hold passes): reserveChat
  // re-plans the turn onto free models after prepareChat decided on the paid plan.
  beforeEach(() => {
    allowance.__setMeteringEnabledForTests(true);
    allowance.setUsageBudgetRpc({
      tryReserve: async ({ estimateUsd }) =>
        estimateUsd > 0
          ? { governed: true, allowed: false, period: 'lifetime', pct_used: 100, pct_left: 0 }
          : { governed: true, allowed: true, pct_used: 100, pct_left: 0 },
      status: async () => ({ governed: true, budget_usd: 10, spent_usd: 10, inflight_usd: 0 }),
      adminList: async () => []
    });
  });
  afterEach(() => {
    allowance.setUsageBudgetRpc(null);
    allowance.__setMeteringEnabledForTests(false);
  });

  /** Every model call went to a free model (the paid plan never reached the provider). */
  const allFree = () =>
    net.openrouter.length > 0 &&
    net.openrouter.every((s) => [s.body.model, ...(s.body.models || [])].every((m: unknown) => /:free$/.test(String(m))));

  it('POST /: a connected user with gemini confirmed (the paid plan would embed): word search, no embedContent request', async () => {
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    const id = user('connected');
    const r = await post('/api/chat', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect((r.json?.notices || []).some((n: { tool?: string }) => n.tool === 'usage_budget')).toBe(true);
    expect(allFree()).toBe(true);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    const system = systemOf(turnBody());
    expect(system).toContain(PLAIN_FACT);
    expect(system).not.toContain(CONNECTED_FACT);
  });

  it('/stream: the same re-plan over SSE never embeds the query either', async () => {
    process.env.CONNECTOR_PROVIDERS_CONFIRMED = 'gemini';
    const id = user('connected');
    const r = await post('/api/chat/stream', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect(r.text).toContain('usage_budget');
    expect(allFree()).toBe(true);
    expect(queryEmbeds()).toHaveLength(0);
    expect(sb.rpc).toHaveLength(0);
    expect(systemOf(turnBody())).toContain(PLAIN_FACT);
  });

  it('a user with no connection keeps the vector search on the re-plan (nothing to withhold)', async () => {
    const id = user('plain');
    const r = await post('/api/chat', ASK, { 'x-test-user': id });
    expect(r.status).toBe(200);
    expect(allFree()).toBe(true);
    expect(queryEmbeds()).toEqual([{ taskType: 'RETRIEVAL_QUERY', text: QUESTION }]);
  });
});

describe('B. chat helpers call the resolved provider’s own model', () => {
  const exchange = { messages: [{ role: 'user', content: 'How do ocean tides work?' }, { role: 'assistant', content: 'The moon pulls the water.' }] };
  const ANTHROPIC = defaultModelForProvider('anthropic');

  it('helperModelFor: NVIDIA and OpenRouter keep their defaults; a direct provider gets its own default model', () => {
    expect(helperModelFor('openrouter')).toBe(OPENROUTER_TEXT_MODEL);
    expect(helperModelFor('nvidia')).toBe(NVIDIA_TEXT_MODEL);
    expect(ANTHROPIC).toBeTruthy();
    expect(helperModelFor('anthropic')).toBe(ANTHROPIC);
    expect(helperModelFor('openai')).toBe(defaultModelForProvider('openai'));
    expect(helperModelFor('gemini')).toBe(defaultModelForProvider('gemini'));
  });

  it('title, follow-ups, memory and enhance on an Anthropic key send the Anthropic default model (no OpenRouter slug)', async () => {
    const headers = { 'x-test-user': user('plain'), 'x-test-keys': 'openrouter,anthropic' };
    await post('/api/chat/title', { ...exchange, source: 'anthropic' }, headers);
    await post('/api/chat/followups', { ...exchange, source: 'anthropic' }, headers);
    const memory = await post('/api/chat/memory', { ...exchange, source: 'anthropic', memory: '' }, headers);
    await post('/api/chat/enhance', { text: 'explain tides', source: 'anthropic' }, headers);
    expect(net.anthropic.map((s) => s.body.model)).toEqual([ANTHROPIC, ANTHROPIC, ANTHROPIC, ANTHROPIC]);
    expect(net.openrouter).toHaveLength(0);
    // The helper answered (it used to fail on the wrong model id and fall back to nothing).
    expect(memory.json?.memory).toBe('- Likes tides');
  });

  it('memory import and the auto-memory after an Anthropic turn use it too', async () => {
    const headers = { 'x-test-user': user('plain'), 'x-test-keys': 'anthropic' };
    const imported = await post('/api/chat/memory/import', { source: 'chatgpt', content: 'I like tides.', memory: '' }, headers);
    expect(imported.status).toBe(200);
    expect(net.anthropic.map((s) => s.body.model)).toEqual([ANTHROPIC]);

    net.anthropic.length = 0;
    const turn = await post('/api/chat', { messages: [{ role: 'user', content: 'Tell me about tides in detail' }] }, { ...headers, 'X-Text-Source': 'anthropic' });
    expect(turn.status).toBe(200);
    // The turn itself, then the background auto-memory summary.
    await autoMemorySent(1, net.anthropic);
    for (const s of net.anthropic) expect(s.body.model).toBe(ANTHROPIC);
  });

  it('an OpenAI-compatible direct provider (OpenAI) gets its own default model', async () => {
    await post('/api/chat/title', { ...exchange, source: 'openai' }, { 'x-test-user': user('plain'), 'x-test-keys': 'openai' });
    expect(net.openai.map((s) => s.body.model)).toEqual([defaultModelForProvider('openai')]);
  });

  it('OpenRouter and NVIDIA are unchanged (OpenRouter keeps its fallback chain, NVIDIA none)', async () => {
    const headers = { 'x-test-user': user('plain'), 'x-test-keys': 'openrouter,nvidia' };
    await post('/api/chat/title', exchange, headers);
    expect(net.openrouter).toHaveLength(1);
    expect(net.openrouter[0].body.model).toBe(OPENROUTER_TEXT_MODEL);
    expect(net.openrouter[0].body.models).toEqual([OPENROUTER_TEXT_MODEL, TEXT_FALLBACK]);

    await post('/api/chat/title', { ...exchange, source: 'nvidia' }, headers);
    expect(net.nvidia.map((s) => s.body.model)).toEqual([NVIDIA_TEXT_MODEL]);
    expect('models' in net.nvidia[0].body).toBe(false);
  });

  it('a withheld helper still makes no call: a connected user on the unconfirmed platform Gemini key', async () => {
    const headers = { 'x-test-user': user('connected'), 'x-test-keys': 'gemini' };
    const title = await post('/api/chat/title', { ...exchange, source: 'gemini' }, headers);
    expect(title.json?.title).toBe('How do ocean tides work');
    expect((await post('/api/chat/followups', { ...exchange, source: 'gemini' }, headers)).json?.suggestions).toEqual([]);
    expect((await post('/api/chat/memory', { ...exchange, source: 'gemini', memory: '- Likes tides' }, headers)).json?.memory).toBe('- Likes tides');
    expect(net.gemini).toHaveLength(0);
  });
});

describe('C. POST /api/chat/memory runs on the source the client sends', () => {
  const exchange = { messages: [{ role: 'user', content: 'I live in Lisbon' }, { role: 'assistant', content: 'Noted.' }] };

  it('the named provider is resolved (not the auto pick), with its own model', async () => {
    const headers = { 'x-test-user': user('plain'), 'x-test-keys': 'openrouter,anthropic' };
    const r = await post('/api/chat/memory', { ...exchange, memory: '', source: 'anthropic' }, headers);
    expect(r.json?.memory).toBe('- Likes tides');
    expect(net.anthropic.map((s) => s.body.model)).toEqual([defaultModelForProvider('anthropic')]);
    expect(net.openrouter).toHaveLength(0);

    // Without a source the auto pick (OpenRouter first) runs, as before.
    await post('/api/chat/memory', { ...exchange, memory: '' }, headers);
    expect(net.openrouter).toHaveLength(1);
  });

  it('stays under the wave 0 gates: flagged memory on an unconfirmed platform provider is never sent', async () => {
    const headers = { 'x-test-user': user('plain'), 'x-test-keys': 'openrouter,gemini' };
    const r = await post('/api/chat/memory', { ...exchange, memory: '- Dana launch Friday', memoryConnected: true, source: 'gemini' }, headers);
    expect(r.json?.memory).toBe('- Dana launch Friday');
    expect(net.gemini).toHaveLength(0);
    expect(net.openrouter).toHaveLength(0);
  });
});
