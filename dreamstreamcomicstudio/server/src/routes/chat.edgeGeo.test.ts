// @vitest-environment node
// When the browser shares no location, Chat uses the approximate place the API Worker attached (X-DS-Geo, from
// Cloudflare's own request data) and passes it through the same sanitizeClientContext caps as a browser location.
// Nothing is looked up by IP. Both call sites are covered: the chat turn (prepareChat) and the public widget refresh.
// No model and no network: prepareChat only prepares the turn, and the refreshed tool is a fake.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
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
vi.mock('../connectors/retrieval.js', () => ({ buildConnectorContextBlock: async () => null, retrieveItems: async () => [] }));
vi.mock('../services/modelCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/modelCatalog.js')>();
  const model = (id: string) => ({
    id,
    name: id,
    supportsImageOutput: false,
    outputModalities: ['text'],
    inputModalities: ['text'],
    supportedParameters: ['tools', 'temperature'],
    costClass: 'paid',
    pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002, imagePerImage: 0, requestFlat: 0 }
  });
  return { ...actual, getCatalog: async () => ({ models: [model('vendor/chat')], fetchedAt: Date.now(), degraded: false }) };
});
vi.mock('../services/rbac.js', () => ({
  isBootstrapAdminEmail: () => false,
  getUserRoles: vi.fn(async () => []),
  resolveAccessProfile: vi.fn(async () => ({ isAdmin: false, isModerator: false, isResearcher: false, bootstrapAdmin: false, roles: [] }))
}));
vi.mock('../ai/tools/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/tools/registry.js')>();
  return { ...actual, resolveTools: vi.fn(actual.resolveTools) };
});

const { prepareChat, chatPublicRouter } = await import('./chat.js');
const { resolveTools } = await import('../ai/tools/registry.js');

const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const EDGE_PLACE = { city: 'Riverton', region: 'North Province', country: 'NZ', lat: -41.29, lng: 174.78 };

const fakeReq = (headers: Record<string, unknown>, body: Record<string, unknown> = {}) => ({
  body: { model: 'vendor/chat', messages: [{ role: 'user', content: 'What is the weather like here today?' }], ...body },
  user: { id: 'member-1', email: 'member-1@example.com' },
  apiKeys: { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } },
  headers,
  header: () => undefined,
  path: '/api/chat'
});

const locationOf = async (headers: Record<string, unknown>, body?: Record<string, unknown>) => {
  const r = await prepareChat(fakeReq(headers, body));
  if (!('prepared' in r)) throw new Error(`prepareChat refused: ${JSON.stringify(r.error)}`);
  return r.prepared.clientContext?.location;
};

describe('chat turn: approximate place from the edge', () => {
  it('uses the X-DS-Geo place when the browser shared none, marked approximate', async () => {
    expect(await locationOf({ 'x-ds-geo': encode(EDGE_PLACE), 'cf-connecting-ip': '203.0.113.9' })).toEqual({ ...EDGE_PLACE, approximate: true });
  });

  it('the browser’s own location wins over the edge place', async () => {
    const browser = { city: 'Harbourside', country: 'AU', lat: -33.87, lng: 151.21 };
    expect(await locationOf({ 'x-ds-geo': encode(EDGE_PLACE) }, { clientContext: { location: browser } })).toEqual({ ...browser, approximate: true });
  });

  it('no header, or a malformed one, means no location (and the IP alone gives none)', async () => {
    expect(await locationOf({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' })).toBeUndefined();
    expect(await locationOf({ 'x-ds-geo': '%E0%A4%A' })).toBeUndefined();
    expect(await locationOf({ 'x-ds-geo': encode({ ip: '203.0.113.9' }) })).toBeUndefined();
  });

  it('the same caps as a browser location apply', async () => {
    const loc = await locationOf({ 'x-ds-geo': encode({ city: 'C'.repeat(300), country: 'nz', lat: 1.23456, lng: 2.34567 }) });
    expect(loc).toEqual({ city: 'C'.repeat(80), country: 'NZ', lat: 1.23, lng: 2.35, approximate: true });
  });
});

describe('widget refresh: approximate place from the edge', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/chat', chatPublicRouter);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const refresh = async (headers: Record<string, string>, body: Record<string, unknown> = {}) => {
    vi.mocked(resolveTools).mockImplementationOnce((names) => [
      { name: names[0], description: 'fake', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: 'ok' }) }
    ]);
    const res = await fetch(`${base}/api/chat/tool-refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ tool: 'get_weather', args: {}, ...body })
    });
    expect(res.status).toBe(200);
    return vi.mocked(resolveTools).mock.lastCall?.[1]?.location;
  };

  it('passes the edge place to the refreshed tool', async () => {
    expect(await refresh({ 'x-ds-geo': encode(EDGE_PLACE) })).toEqual({ ...EDGE_PLACE, approximate: true });
  });

  it('the browser’s location wins, and without either there is none', async () => {
    const browser = { city: 'Harbourside', country: 'AU' };
    expect(await refresh({ 'x-ds-geo': encode(EDGE_PLACE) }, { clientContext: { location: browser } })).toEqual({ ...browser, approximate: true });
    expect(await refresh({})).toBeUndefined();
    expect(await refresh({ 'x-ds-geo': 'not json' })).toBeUndefined();
  });
});
