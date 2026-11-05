// @vitest-environment node
// web-surface-1: a chat request's `mcpServers` can no longer switch off the MCP SSRF guard.
//   - A request entry is rebuilt from plain fields: `{ url: 'http://127.0.0.1:…', trusted: true }` makes
//     no fetch at all and adds no `mcp_` tool.
//   - A request or saved entry that reuses an operator server's URL (envDesignMcpServers) never replaces
//     it: the operator's id, headers (its secret) and trust stay.
//   - A request-supplied server's tools ride the same connected-account gates as the rest of the turn:
//     on a paid connected turn they are part of the turn the privacy decision covers, and on a free turn
//     nothing named like a connector MCP (`mcp_nango_*`) gets through, whatever the request calls it.
// Harness: prepareChat itself (no model call) with the REAL buildMcpTools and SSRF guard; only the
// network edges are faked, so every outbound MCP request is recorded: DNS and the pinned transport an
// untrusted server connects through (safeNet test hooks), and the global fetch an operator server uses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setNetForTests } from '../ai/tools/safeNet.js';

vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => {
    throw new Error('no database in tests');
  }
}));
vi.mock('../ai/clientGeo.js', () => ({ resolveClientGeo: async () => null, clientIpFromReq: () => undefined }));
const saved = vi.hoisted(() => ({ servers: [] as { id: string; name: string; url: string; headers?: Record<string, string> }[] }));
vi.mock('../services/mcpRegistry.js', () => ({ enabledMcpConfigs: async () => saved.servers }));
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
const conn = vi.hoisted(() => ({ rows: new Map<string, { connector_id: string; status: string }[]>() }));
vi.mock('../connectors/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/store.js')>()),
  listConnections: async (userId: string) => conn.rows.get(userId) ?? [],
  getActiveConnection: async () => null
}));
vi.mock('../services/modelCatalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/modelCatalog.js')>();
  const model = (id: string, free: boolean) => ({
    id,
    name: id,
    supportsImageOutput: false,
    outputModalities: ['text'],
    inputModalities: ['text'],
    supportedParameters: ['tools', 'temperature'],
    costClass: free ? 'free_verified' : 'paid',
    pricing: { promptPerToken: free ? 0 : 0.000001, completionPerToken: free ? 0 : 0.000002, imagePerImage: 0, requestFlat: 0 }
  });
  return {
    ...actual,
    getCatalog: async () => ({ models: [model('vendor/chat', false), model('vendor/free-a:free', true)], fetchedAt: Date.now(), degraded: false })
  };
});
vi.mock('../services/rbac.js', () => ({
  isBootstrapAdminEmail: () => false,
  getUserRoles: vi.fn(async () => []),
  resolveAccessProfile: vi.fn(async () => ({ isAdmin: false, isModerator: false, isResearcher: false, bootstrapAdmin: false, roles: [] }))
}));
// DNS: every test host is public (the string guard still refuses literal private hosts first).
const dns = { lookups: [] as string[] };
const publicResolver = async (hostname: string) => {
  dns.lookups.push(hostname);
  return [{ address: '93.184.216.34', family: 4 }];
};

const { prepareChat } = await import('./chat.js');

// ── A fake MCP server behind `fetch`: every request is recorded with its Authorization header ─────────
type Call = { url: string; method: string; authorization: string | null };
const calls: Call[] = [];
const fakeFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const rpc = JSON.parse(String(init?.body || '{}')) as { id?: number; method?: string };
  const headers = new Headers(init?.headers);
  calls.push({ url, method: rpc.method || '', authorization: headers.get('authorization') });
  if (!rpc.id) return new Response(null, { status: 202 });
  const result =
    rpc.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
      : rpc.method === 'tools/list'
        ? { tools: [{ name: 'search', description: 'Search things.', inputSchema: { type: 'object', properties: {} } }] }
        : {};
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
});

let seq = 0;
/** A fresh host per test: buildMcpTools caches each server's tool list for five minutes. */
const host = (label: string) => `${label}-${Date.now().toString(36)}-${seq++}.example.com`;

const fakeReq = (userId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  body: { model: 'vendor/chat', messages: [{ role: 'user', content: 'Search the docs for the launch checklist' }], ...body },
  user: { id: userId, email: `${userId}@example.com` },
  apiKeys: { providerKeys: { openrouter: { key: 'sk-platform', byok: false } } },
  header: (name: string) => headers[name.toLowerCase()],
  path: '/api/chat'
});

const prepared = async (...args: Parameters<typeof fakeReq>) => {
  const r = await prepareChat(fakeReq(...args));
  if (!('prepared' in r)) throw new Error(`prepareChat refused: ${JSON.stringify(r.error)}`);
  return r.prepared;
};
const names = (tools: { name: string }[]) => tools.map((t) => t.name);
const mcpNames = (tools: { name: string }[]) => names(tools).filter((n) => n.startsWith('mcp_'));

let restoreNet: () => void = () => undefined;
beforeEach(() => {
  calls.length = 0;
  dns.lookups.length = 0;
  saved.servers = [];
  fakeFetch.mockClear();
  // The same fake MCP server answers on both paths: the pinned transport (untrusted servers) and the
  // global fetch (operator servers).
  restoreNet = __setNetForTests({ transport: fakeFetch, resolve: publicResolver });
  vi.stubGlobal('fetch', fakeFetch);
  // The always-on third-party reference MCPs (Context7, DeepWiki) stay out of these turns.
  vi.stubEnv('STUDIO_DISABLE_EXTERNAL_MCP', '1');
});
afterEach(() => {
  restoreNet();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('a request cannot mark its own MCP server trusted', () => {
  it('{ url: http://127.0.0.1:18080/, trusted: true } makes no fetch and adds no mcp_ tool', async () => {
    const p = await prepared('u-plain', {
      mcpServers: [
        { id: 'loop', name: 'Loopback', url: 'http://127.0.0.1:18080/', trusted: true },
        { id: 'meta', name: 'Metadata', url: 'http://169.254.169.254/latest/meta-data/', trusted: true },
        { id: 'local', name: 'Local https', url: 'https://localhost:8443/mcp', trusted: true }
      ]
    });
    expect(mcpNames(p.tools)).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(dns.lookups).toEqual([]);
  });

  it('a public https server still works, without the flag', async () => {
    const h = host('docs');
    const p = await prepared('u-plain', { mcpServers: [{ id: 'docs', name: 'Docs', url: `https://${h}/mcp`, trusted: true }] });
    expect(mcpNames(p.tools)).toEqual(['mcp_docs_search']);
    expect(calls.every((c) => c.url === `https://${h}/mcp`)).toBe(true);
    // The strict path ran: the resolved address was checked (a trusted server skips the lookup).
    expect(dns.lookups).toContain(h);
  });

  it('keeps at most 10 request servers, and drops malformed entries and headers', async () => {
    const hosts = Array.from({ length: 12 }, (_, i) => host(`many${i}`));
    const p = await prepared('u-plain', {
      mcpServers: [
        { id: 'x'.repeat(65), url: `https://${host('longid')}/mcp` },
        { id: 'nourl' },
        'not-an-object',
        ...hosts.map((h, i) => ({ id: `s${i}`, url: `https://${h}/mcp`, headers: { Authorization: 'Bearer mine', 'Bad Header': 'x', 'X-Big': 'y'.repeat(5000), 'X-Num': 7 } }))
      ]
    });
    expect(mcpNames(p.tools)).toEqual(hosts.slice(0, 10).map((_, i) => `mcp_s${i}_search`));
    // Only the well-formed header reached the server.
    for (const c of calls) expect(c.authorization).toBe('Bearer mine');
    const sent = fakeFetch.mock.calls.map(([, init]) => Object.keys((init?.headers as Record<string, string>) || {}));
    for (const keys of sent) expect(keys.some((k) => /bad header|x-big|x-num/i.test(k))).toBe(false);
  });
});

describe('an operator server is never replaced by a request or saved entry with its URL', () => {
  it('keeps the operator id, headers and trust; the look-alike entry is dropped', async () => {
    const op = host('nango');
    vi.stubEnv('STUDIO_NANGO_MCP_URL', `https://${op}/mcp`);
    vi.stubEnv('STUDIO_NANGO_MCP_URL_HEADERS', JSON.stringify({ Authorization: 'Bearer operator-secret' }));
    saved.servers = [{ id: '7f9c2d1e-0000-4000-8000-000000000001', name: 'Saved copy', url: `https://${op}/mcp`, headers: { Authorization: 'Bearer saved' } }];
    const p = await prepared('u-plain', {
      mcpServers: [
        { id: 'mine', name: 'Mine', url: `https://${op.toUpperCase()}:443/mcp/`, headers: { Authorization: 'Bearer request' }, trusted: true },
        { id: 'mine2', name: 'Mine too', url: `https://${op}/mcp#x` }
      ]
    });
    expect(mcpNames(p.tools)).toEqual(['mcp_nango_search']);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.authorization).toBe('Bearer operator-secret');
    // Operator servers are trusted: no resolved-address check for them.
    expect(dns.lookups).not.toContain(op);
  });

  it('an operator server on an internal http host still works (trust is the operator’s alone)', async () => {
    vi.stubEnv('STUDIO_NANGO_MCP_URL', 'http://nango-sidecar.internal:3003/mcp');
    vi.stubEnv('STUDIO_NANGO_MCP_URL_HEADERS', JSON.stringify({ Authorization: 'Bearer operator-secret' }));
    const p = await prepared('u-plain', {
      mcpServers: [{ id: 'mine', url: 'http://nango-sidecar.internal:3003/mcp', headers: { Authorization: 'Bearer request' }, trusted: true }]
    });
    expect(mcpNames(p.tools)).toEqual(['mcp_nango_search']);
    for (const c of calls) expect(c.authorization).toBe('Bearer operator-secret');
  });
});

describe('connected-account gates still cover request-supplied MCP servers', () => {
  const connected = (id: string) => {
    conn.rows.set(id, [{ connector_id: 'gmail', status: 'connected' }]);
    return id;
  };

  it('a paid connected turn: the request server’s tools are inside the turn the privacy decision covers', async () => {
    const id = connected(`u-conn-${seq++}`);
    const h = host('docs');
    const p = await prepared(id, {
      messages: [{ role: 'user', content: 'Check my Gmail inbox for the launch email' }],
      mcpServers: [{ id: 'docs', name: 'Docs', url: `https://${h}/mcp`, trusted: true }]
    });
    expect(names(p.tools)).toEqual(expect.arrayContaining(['gmail_search', 'mcp_docs_search']));
    expect(p.connectorPrivacy?.connectorData).toBe(true);
    expect(p.connectorPrivacy?.sources).toContain('tools');
    // No free model takes this turn.
    expect([p.model, ...(p.fallbackModels || [])].some((m) => /:free$/.test(m))).toBe(false);
  });

  it('a free turn: no connector tool, and no `mcp_nango_*` tool — not the operator’s, not one a request names `nango`', async () => {
    const id = connected(`u-conn-${seq++}`);
    const op = host('nango');
    const impostor = host('impostor');
    const docs = host('docs');
    vi.stubEnv('STUDIO_NANGO_MCP_URL', `https://${op}/mcp`);
    const p = await prepared(id, {
      model: 'vendor/free-a:free',
      messages: [{ role: 'user', content: 'Check my Gmail inbox for the launch email' }],
      mcpServers: [
        // Renaming the operator's connector MCP to escape the gate: dropped (operator URL).
        { id: 'renamed', url: `https://${op}/mcp`, trusted: true },
        // Claiming the connector id for another server: its tools are withheld like the operator's.
        { id: 'nango', url: `https://${impostor}/mcp` },
        { id: 'docs', url: `https://${docs}/mcp` }
      ]
    });
    expect(p.connectorPrivacy?.freeTurn).toBe(true);
    expect(names(p.tools).some((n) => /^(gmail_|drive_|calendar_|sheets_|connected_data_|mcp_nango_)/.test(n))).toBe(false);
    expect(names(p.tools)).not.toContain('mcp_renamed_search');
    // The user's own non-connector server is still offered.
    expect(mcpNames(p.tools)).toEqual(['mcp_docs_search']);
  });
});
