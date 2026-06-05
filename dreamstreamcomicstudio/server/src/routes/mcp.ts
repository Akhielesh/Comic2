// MCP routes (Phase 10) — two surfaces:
//
//  • mcpRouter (/api/mcp, behind requireAuth): the user's server-side MCP registry —
//    list / add / delete / health-check their custom MCP servers, plus the curated
//    marketplace catalog. Replaces per-device localStorage.
//
//  • mcpOutboundRouter (/api/connect, bearer-token auth, mounted BEFORE requireAuth):
//    DreamStream's OWN tools published as an authenticated MCP endpoint, so external
//    agents (Claude/Cursor/…) can call our registry over JSON-RPC. Exposes only the
//    read-only, side-effect-free tools; never generate_app or the swarm.

import { Router } from 'express';
import crypto from 'crypto';
import { MCP_OUTBOUND_TOKEN } from '../config.js';
import { resolveTools, toToolSpec } from '../ai/tools/registry.js';
import { MCP_CATALOG } from '../ai/tools/mcpCatalog.js';
import { listMcpServers, saveMcpServer, deleteMcpServer, checkMcpServer, type McpServerRow } from '../services/mcpRegistry.js';

export const mcpRouter = Router();
export const mcpOutboundRouter = Router();

// --- Registry CRUD (authenticated) -------------------------------------------------

// Public view of a saved server: never echo the stored auth headers back to the client,
// just whether auth is configured.
const redactServer = (s: McpServerRow) => ({
  id: s.id,
  name: s.name,
  url: s.url,
  enabled: s.enabled,
  health: s.health,
  lastCheckedAt: s.lastCheckedAt,
  failCount: s.failCount,
  hasAuth: Boolean(s.headers && Object.keys(s.headers).length)
});

// GET /api/mcp — the user's saved servers + the curated marketplace.
mcpRouter.get('/', async (req, res, next) => {
  try {
    const servers = await listMcpServers(req.user!.id).catch(() => [] as McpServerRow[]);
    res.json({ servers: servers.map(redactServer), catalog: MCP_CATALOG });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp — add or update a server (SSRF-guarded in the service).
mcpRouter.post('/', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const result = await saveMcpServer(req.user!.id, {
      name: body.name,
      url: body.url,
      headers: body.headers,
      enabled: body.enabled
    });
    if (result.ok === false) {
      return res.status(400).json({ error: { message: `MCP server rejected: ${result.reason}`, code: 'MCP_URL_REJECTED' } });
    }
    res.json({ server: redactServer(result.server) });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp/:id/check — health-check a server (lists its tools).
mcpRouter.post('/:id/check', async (req, res, next) => {
  try {
    const result = await checkMcpServer(req.user!.id, req.params.id);
    if (!result) return res.status(404).json({ error: { message: 'Server not found.' } });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp/:id
mcpRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteMcpServer(req.user!.id, req.params.id);
    if (!ok) return res.status(404).json({ error: { message: 'Server not found.' } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// --- Outbound MCP endpoint (DreamStream tools as an MCP server) ---------------------

const PROTOCOL_VERSION = '2025-06-18';

// The safe, read-only subset of our registry we publish externally. No generate_app
// (produces app artifacts), no run_agent_swarm (recursive/credentialed), no render_*
// (they only draw caller-supplied data, useless without the UI).
const OUTBOUND_TOOL_NAMES = [
  'web_search',
  'get_news',
  'get_weather',
  'get_stock',
  'find_places',
  'show_map',
  'image_search',
  'video_search'
];

// Constant-time bearer check so the endpoint is genuinely authenticated, not just gated.
const tokenOk = (header: string | undefined): boolean => {
  if (!MCP_OUTBOUND_TOKEN) return false;
  const presented = (header || '').replace(/^Bearer\s+/i, '').trim();
  if (!presented || presented.length !== MCP_OUTBOUND_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(MCP_OUTBOUND_TOKEN));
};

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// POST /api/connect/mcp — JSON-RPC (MCP Streamable HTTP, JSON responses).
mcpOutboundRouter.post('/mcp', async (req, res) => {
  if (!MCP_OUTBOUND_TOKEN) {
    return res.status(503).json({ error: { message: 'The outbound MCP endpoint is not enabled (set MCP_OUTBOUND_TOKEN).', code: 'MCP_OUTBOUND_DISABLED' } });
  }
  if (!tokenOk(req.headers.authorization)) {
    return res.status(401).json({ error: { message: 'Unauthorized: a valid Bearer token is required.', code: 'MCP_UNAUTHORIZED' } });
  }

  const body = (req.body || {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: any };
  const { id, method } = body;

  if (method === 'initialize') {
    return res.json(
      rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'DreamStream Tools', version: '1.0' }
      })
    );
  }
  if (method === 'notifications/initialized' || method === 'ping') {
    return res.json(rpcResult(id, {}));
  }
  if (method === 'tools/list') {
    const tools = resolveTools(OUTBOUND_TOOL_NAMES).map((t) => {
      const spec = toToolSpec(t);
      return { name: spec.function.name, description: spec.function.description, inputSchema: spec.function.parameters };
    });
    return res.json(rpcResult(id, { tools }));
  }
  if (method === 'tools/call') {
    const name = typeof body.params?.name === 'string' ? body.params.name : '';
    const args = body.params?.arguments && typeof body.params.arguments === 'object' ? body.params.arguments : {};
    if (!OUTBOUND_TOOL_NAMES.includes(name)) {
      return res.json(rpcError(id, -32601, `Unknown or unavailable tool: ${name}`));
    }
    const [tool] = resolveTools([name]);
    if (!tool) return res.json(rpcError(id, -32601, `Unknown tool: ${name}`));
    try {
      const out = await tool.execute(args);
      return res.json(rpcResult(id, { content: [{ type: 'text', text: out.content }], isError: false }));
    } catch (err) {
      return res.json(rpcResult(id, { content: [{ type: 'text', text: `Tool error: ${(err as Error)?.message || 'failed'}` }], isError: true }));
    }
  }

  return res.json(rpcError(id, -32601, `Method not found: ${method || '(none)'}`));
});
