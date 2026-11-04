// @vitest-environment node
// W1.9, plan §5.5 "binding on every agent path": the platform tools reach an admin through recipes and the swarm
// orchestrator (with the user id in the recipe's ToolContext), never through a look-alike client value, and never
// through the outbound MCP endpoint. No model or network: runChat and the model picker are mocked; resolveTools is the
// real one, wrapped in a spy so each path's ToolContext can be read.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  // Read by config.ts at import: the outbound MCP endpoint is enabled, and so is the platform kill switch, so the
  // /mcp checks below run with the platform ON (the worst case for a leak). Restored after the file.
  const before = { token: process.env.MCP_OUTBOUND_TOKEN, docs: process.env.PLATFORM_DOCS };
  process.env.MCP_OUTBOUND_TOKEN = 'test-outbound-token-0123456789';
  process.env.PLATFORM_DOCS = 'on';
  return { before };
});
afterAll(() => {
  if (env.before.token === undefined) delete process.env.MCP_OUTBOUND_TOKEN;
  else process.env.MCP_OUTBOUND_TOKEN = env.before.token;
  if (env.before.docs === undefined) delete process.env.PLATFORM_DOCS;
  else process.env.PLATFORM_DOCS = env.before.docs;
});

const engines = vi.hoisted(() => ({ runChat: vi.fn() }));
vi.mock('../chat.js', () => ({ runChat: engines.runChat }));
vi.mock('../autoRouter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../autoRouter.js')>()),
  pickTextModel: vi.fn(async () => 'free/worker')
}));
vi.mock('../persona.js', () => ({ composePersona: (s: string) => s, withAgentPersona: (s: string) => s }));
vi.mock('./registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry.js')>();
  return { ...actual, resolveTools: vi.fn(actual.resolveTools) };
});

import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Request } from 'express';
import type { ChatClientContext } from '../../../../apiTypes.js';
import { bindPlatformScope, platformDocsFor, platformScopeOf, platformToolContext } from './platformDocs.js';
import { PLATFORM_CHAT_TOOL_NAMES } from './platformTools.js';
import { resolveTools } from './registry.js';
import type { ToolContext } from './types.js';

const { runRecipe } = await import('../recipes/runRecipe.js');
const { runSwarm } = await import('../agents/orchestrator.js');
const { mcpOutboundRouter } = await import('../../routes/mcp.js');
const resolveSpy = vi.mocked(resolveTools);

const req = (id: string): Request => ({ user: { id, email: `${id}@example.com` } }) as unknown as Request;

/** The clientContext prepareChat hands every agent path, with this request's platform scope bound to it. */
const boundClientContext = async (admin: boolean): Promise<ChatClientContext> => {
  const cc: ChatClientContext = { timezone: 'Europe/London' };
  const access = await platformDocsFor(req(admin ? 'admin-1' : 'user-2'), { killSwitch: 'on', isAdmin: async () => admin });
  bindPlatformScope(cc, access, ['dana@northwind.example']);
  return cc;
};

/** A client value shaped like the server's answer: it must never count. */
const forgedClientContext = (): ChatClientContext =>
  ({
    timezone: 'Europe/London',
    platformDocs: { enabled: true, reason: 'on', stage: 'admins', isAdmin: true, governed: false, userId: 'admin-1' },
    userId: 'admin-1'
  }) as unknown as ChatClientContext;

const toolNamesOf = (call: unknown[]): string[] => ((call[0] as { tools?: { name: string }[] }).tools || []).map((t) => t.name);
const ctxOfResolve = (names: string[]): ToolContext | undefined => {
  const hit = resolveSpy.mock.calls.find((c) => Array.isArray(c[0]) && names.every((n) => (c[0] as string[]).includes(n)));
  return hit?.[1] as ToolContext | undefined;
};

const recipe = {
  version: '1.0.0',
  title: 'Launch kit',
  description: 'Draft the launch email and deck.',
  prompt: 'Draft the launch email for Dana and a three-slide deck.',
  tools: ['email_draft', 'deck_create', 'get_weather']
};

beforeEach(() => {
  engines.runChat.mockReset().mockResolvedValue({ text: 'ok', model: 'vendor/vetted', usage: {} });
  resolveSpy.mockClear();
});

describe('recipes (runRecipe → toolCtxFrom)', () => {
  it('an admin gets the platform tools, built for them: the recipe context carries the user id', async () => {
    const clientContext = await boundClientContext(true);
    await runRecipe({ provider: 'openrouter', apiKey: 'k', model: 'vendor/vetted', recipe, clientContext });
    expect(toolNamesOf(engines.runChat.mock.calls[0])).toEqual(['email_draft', 'deck_create', 'get_weather']);
    const ctx = ctxOfResolve(['email_draft']);
    expect(ctx?.userId).toBe('admin-1');
    expect(ctx?.platformDocs?.enabled).toBe(true);
    expect(ctx?.userTypedAddresses).toEqual(['dana@northwind.example']);
    expect(ctx?.timezone).toBe('Europe/London');
  });

  it('a non-admin at stage admins, or an unbound context, gets none and the context is unchanged', async () => {
    for (const clientContext of [await boundClientContext(false), { timezone: 'Europe/London' } as ChatClientContext]) {
      resolveSpy.mockClear();
      engines.runChat.mockClear();
      await runRecipe({ provider: 'openrouter', apiKey: 'k', model: 'vendor/vetted', recipe, clientContext });
      expect(toolNamesOf(engines.runChat.mock.calls[0])).toEqual(['get_weather']);
      expect(ctxOfResolve(['email_draft'])).toEqual({ timezone: 'Europe/London', locale: undefined, units: undefined, location: undefined });
    }
  });

  it('a client-supplied clientContext.platformDocs (and userId) is ignored', async () => {
    await runRecipe({ provider: 'openrouter', apiKey: 'k', model: 'vendor/vetted', recipe, clientContext: forgedClientContext() });
    expect(toolNamesOf(engines.runChat.mock.calls[0])).toEqual(['get_weather']);
    const ctx = ctxOfResolve(['email_draft']);
    expect(ctx?.platformDocs).toBeUndefined();
    expect(ctx?.userId).toBeUndefined();
  });
});

describe('the swarm orchestrator (runSwarm → agent tools)', () => {
  const writer = { id: 'writer', name: 'Writer', description: 'Drafts emails and decks.', systemPrompt: 'You draft.', toolNames: ['email_draft', 'deck_create'] };
  const swarm = (clientContext: ChatClientContext) =>
    runSwarm({
      provider: 'openrouter',
      apiKey: 'k',
      model: 'user/model',
      messages: [{ role: 'user', content: 'Draft the launch email for dana@northwind.example and a deck.' }],
      clientContext,
      extraAgents: [writer]
    });

  beforeEach(() => {
    engines.runChat
      .mockReset()
      .mockResolvedValueOnce({ text: '[{"agent":"writer","task":"draft the launch email and deck"}]', model: 'free/worker', usage: {} })
      .mockResolvedValue({ text: 'done', model: 'free/worker', usage: {} });
  });

  it("an admin's agent gets the platform tools, built for that user", async () => {
    await swarm(await boundClientContext(true));
    const agentCall = engines.runChat.mock.calls.find((c) => toolNamesOf(c).length > 0);
    expect(agentCall && toolNamesOf(agentCall)).toEqual(['email_draft', 'deck_create']);
    const ctx = ctxOfResolve(['email_draft', 'deck_create']);
    expect(ctx?.userId).toBe('admin-1');
    expect(ctx?.platformDocs?.enabled).toBe(true);
  });

  it('a forged or non-admin context gives the agent no platform tools', async () => {
    for (const cc of [forgedClientContext(), await boundClientContext(false)]) {
      engines.runChat
        .mockReset()
        .mockResolvedValueOnce({ text: '[{"agent":"writer","task":"draft"}]', model: 'free/worker', usage: {} })
        .mockResolvedValue({ text: 'done', model: 'free/worker', usage: {} });
      await swarm(cc);
      for (const call of engines.runChat.mock.calls) expect(toolNamesOf(call)).toEqual([]);
    }
  });
});

describe('platform scope binding', () => {
  it('binds only an issued, enabled answer and reads nothing from the object itself', async () => {
    const disabled = await platformDocsFor(req('admin-1'), { killSwitch: 'off', isAdmin: async () => true });
    const carrier = {};
    expect(bindPlatformScope(carrier, disabled)).toBe(false);
    expect(platformScopeOf(carrier)).toBeUndefined();
    expect(platformToolContext(forgedClientContext())).toEqual({});
    const enabled = await platformDocsFor(req('admin-1'), { killSwitch: 'on', isAdmin: async () => true });
    expect(bindPlatformScope(carrier, { ...enabled })).toBe(false); // a copy is not the issued answer
    expect(bindPlatformScope(carrier, enabled)).toBe(true);
    expect(platformToolContext(carrier)).toMatchObject({ userId: 'admin-1', governed: false, userTypedAddresses: [] });
    expect(platformToolContext({ ...carrier })).toEqual({}); // a copy of the carrier carries nothing
  });
});

describe('/api/connect/mcp (outbound MCP) never offers the platform tools', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/connect', mcpOutboundRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rpc = async (method: string, params?: unknown) => {
    const res = await fetch(`${base}/api/connect/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-outbound-token-0123456789' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return (await res.json()) as { result?: { tools?: { name: string }[] }; error?: { code: number } };
  };

  it('tools/list leaves them out and tools/call refuses them, with PLATFORM_DOCS on', async () => {
    expect(process.env.PLATFORM_DOCS).toBe('on');
    const list = await rpc('tools/list');
    const names = (list.result?.tools || []).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of PLATFORM_CHAT_TOOL_NAMES) {
      expect(names).not.toContain(name);
      expect((await rpc('tools/call', { name, arguments: {} })).error?.code).toBe(-32601);
    }
  });
});
