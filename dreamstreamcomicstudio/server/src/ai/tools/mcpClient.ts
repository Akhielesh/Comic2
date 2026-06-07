// Minimal MCP (Model Context Protocol) client over Streamable HTTP / JSON-RPC.
//
// Lets users plug in their own remote MCP servers: we initialize, list their tools,
// and proxy tools/call. The listed tools are wrapped as ChatTools so they flow through
// the same agentic loop as the built-ins.
//
// Scope (v1): JSON-RPC over HTTP POST, JSON *or* single-event SSE responses. SSRF
// guards block private/loopback hosts and require https. Full streaming-SSE servers
// and OAuth flows are follow-ups.

import { lookup } from 'node:dns/promises';
import type { McpServerConfig } from '../../../../apiTypes.js';
import type { ChatTool, ToolExecResult } from './registry.js';

const MCP_TIMEOUT_MS = 15_000;
const TOOLS_CACHE_TTL_MS = 5 * 60_000;
const PROTOCOL_VERSION = '2025-06-18';

const toolsCache = new Map<string, { at: number; tools: McpTool[] }>();

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// --- SSRF guard: only https, block obvious internal hosts. ------------------
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?fc|\[?fd)/i;

export const isSafeMcpUrl = (
  url: string,
  opts: { allowInternal?: boolean } = {}
): { ok: boolean; reason?: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  // "Trusted" (operator-configured) servers — e.g. a self-hosted MCP sidecar — may use http and
  // internal hostnames. The strict path (user-supplied URLs) still requires https + public hosts
  // so the SSRF guard isn't weakened for anything a user can set.
  if (opts.allowInternal) {
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'must be http(s)' };
    return { ok: true };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'must use https' };
  if (PRIVATE_HOST_RE.test(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    return { ok: false, reason: 'private/loopback hosts are not allowed' };
  }
  return { ok: true };
};

// Block private/loopback/link-local/CGNAT/metadata ranges (IPv4 + IPv4-mapped IPv6 + IPv6).
const isPrivateIp = (ip: string): boolean => {
  const addr = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
  if (addr.includes('.')) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const low = addr.toLowerCase();
  return low === '::1' || low === '::' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
};

// Resolve the host and ensure NO resolved IP is private. Closes the DNS-rebinding bypass of
// the hostname-string guard above (a public name pointing at 169.254.169.254/127.0.0.1).
// Trusted (operator-configured) servers skip this.
const assertResolvedHostSafe = async (url: string, allowInternal: boolean): Promise<void> => {
  if (allowInternal) return;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error('invalid URL');
  }
  let addrs: { address: string }[] = [];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error('MCP server host could not be resolved');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('MCP server resolves to a private/internal address');
  }
};

// Parse a JSON-RPC result from a JSON body or a (single-event) SSE body.
const parseRpcBody = (text: string): any => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // SSE: collect data: lines and parse the last JSON object.
    const datas = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    for (let i = datas.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(datas[i]);
      } catch {
        /* keep looking */
      }
    }
    return null;
  }
};

interface McpSession {
  sessionId?: string;
  /** Version the server negotiated at initialize — echoed on every later request. */
  protocolVersion: string;
}

const rpc = async (
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown> | undefined,
  session: { sessionId?: string; protocolVersion?: string } | undefined,
  isNotification: boolean,
  signal?: AbortSignal
): Promise<{ result: any; sessionId?: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // Spec MUST: send the negotiated protocol version on all post-initialize requests
        // (strict servers 400 without it). Omitted on the initialize call itself.
        ...(session?.protocolVersion ? { 'MCP-Protocol-Version': session.protocolVersion } : {}),
        ...(session?.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
        ...(server.headers || {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(isNotification ? {} : { id: Math.floor(Math.random() * 1e9) }),
        method,
        ...(params ? { params } : {})
      }),
      // Don't auto-follow redirects: a 3xx to an internal host is a classic SSRF escape
      // past the resolved-IP guard. MCP endpoints don't legitimately redirect.
      redirect: 'manual',
      signal: controller.signal
    });
    const sid = res.headers.get('mcp-session-id') || session?.sessionId;
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`MCP ${method} returned a redirect (${res.status}) — not followed for security`);
    }
    if (isNotification) return { result: null, sessionId: sid };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP ${method} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const text = await res.text();
    const json = parseRpcBody(text);
    if (json?.error) throw new Error(`MCP ${method} error: ${json.error.message || 'unknown'}`);
    return { result: json?.result, sessionId: sid };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const handshake = async (server: McpServerConfig, signal?: AbortSignal): Promise<McpSession> => {
  const init = await rpc(
    server,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'DreamStream Chat', version: '1.0' }
    },
    undefined,
    false,
    signal
  );
  // Honor the version the server negotiated (it may downgrade); fall back to ours.
  const negotiated =
    typeof init.result?.protocolVersion === 'string' ? init.result.protocolVersion : PROTOCOL_VERSION;
  const session: McpSession = { sessionId: init.sessionId, protocolVersion: negotiated };
  // Best-effort "initialized" notification (some servers require it before tools/list).
  await rpc(server, 'notifications/initialized', undefined, session, true, signal).catch(() => undefined);
  return session;
};

// Cache discovery per (url + headers): two users hitting the same URL with different auth
// must NOT share a tool list (keying by url alone leaked one user's tools to another).
const cacheKey = (server: McpServerConfig): string => `${server.url}::${JSON.stringify(server.headers || {})}`;

export const listMcpTools = async (
  server: McpServerConfig,
  signal?: AbortSignal,
  allowInternal = false
): Promise<McpTool[]> => {
  const key = cacheKey(server);
  const cached = toolsCache.get(key);
  if (cached && Date.now() - cached.at < TOOLS_CACHE_TTL_MS) return cached.tools;

  const safe = isSafeMcpUrl(server.url, { allowInternal });
  if (!safe.ok) throw new Error(`MCP server URL rejected: ${safe.reason}`);
  await assertResolvedHostSafe(server.url, allowInternal);

  const session = await handshake(server, signal);
  const { result } = await rpc(server, 'tools/list', {}, session, false, signal);
  const tools: McpTool[] = Array.isArray(result?.tools)
    ? result.tools
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    : [];
  toolsCache.set(key, { at: Date.now(), tools });
  return tools;
};

const callMcpTool = async (
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  allowInternal: boolean,
  signal?: AbortSignal
): Promise<ToolExecResult> => {
  await assertResolvedHostSafe(server.url, allowInternal);
  const session = await handshake(server, signal);
  const { result } = await rpc(server, 'tools/call', { name: toolName, arguments: args }, session, false, signal);
  const content = Array.isArray(result?.content) ? result.content : [];

  // Map the FULL MCP content array — previously only text survived, so image/data tools
  // looked like they "returned nothing".
  const textParts: string[] = [];
  const images: NonNullable<ToolExecResult['images']> = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') textParts.push(c.text);
    else if (c.type === 'image' && typeof c.data === 'string') {
      const mime = typeof c.mimeType === 'string' ? c.mimeType : 'image/png';
      const url = c.data.startsWith('data:') ? c.data : `data:${mime};base64,${c.data}`;
      images.push({ url, source: server.name });
    } else if (c.type === 'resource_link' && typeof c.uri === 'string') {
      textParts.push(`[resource] ${c.name || c.uri}: ${c.uri}`);
    } else if (c.type === 'resource' && c.resource && typeof c.resource === 'object') {
      const r = c.resource as Record<string, unknown>;
      if (typeof r.text === 'string') textParts.push(r.text);
      else if (typeof r.uri === 'string') textParts.push(`[resource] ${r.uri}`);
    }
  }
  // Structured tool output (MCP `structuredContent`) — serialize so the model can use it.
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    try {
      textParts.push('```json\n' + JSON.stringify(result.structuredContent, null, 2) + '\n```');
    } catch {
      /* ignore unserializable structured content */
    }
  }

  const text = textParts.join('\n').trim();
  if (result?.isError) {
    return {
      content: text || 'The tool reported an error.',
      notice: { level: 'error', message: `${server.name}: ${toolName} reported an error.` }
    };
  }
  return {
    content: text || (images.length ? `Returned ${images.length} image(s).` : 'The tool returned no content.'),
    ...(images.length ? { images } : {})
  };
};

// Namespaced tool id so MCP tools never collide with built-ins or each other.
const mcpToolName = (serverId: string, tool: string) => `mcp_${serverId}_${tool}`;

/**
 * Build ChatTools for all tools exposed by the given MCP servers (best-effort per server).
 * Servers flagged `trusted` (operator-configured, e.g. a self-hosted sidecar) may use http/internal
 * hosts; user-supplied servers stay behind the strict https + public-host SSRF guard.
 */
// Cap tools imported from a single server so one chatty server can't flood the model's
// tool list (and blow past provider tool limits).
const MAX_TOOLS_PER_SERVER = 40;

export const buildMcpTools = async (
  servers: (McpServerConfig & { trusted?: boolean })[],
  signal?: AbortSignal
): Promise<ChatTool[]> => {
  const wrap = (server: McpServerConfig & { trusted?: boolean }, tool: McpTool, allowInternal: boolean): ChatTool => ({
    name: mcpToolName(server.id, tool.name),
    description: `[${server.name}] ${tool.description || tool.name}`,
    parameters:
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    execute: async (args, sig): Promise<ToolExecResult> => {
      try {
        return await callMcpTool(server, tool.name, args, allowInternal, sig);
      } catch (err) {
        const message = (err as Error)?.message || 'unknown error';
        return { content: `MCP call failed: ${message}`, notice: { level: 'error', message: `${server.name}: ${message}` } };
      }
    }
  });

  // Discover servers in PARALLEL — a slow/broken one no longer serializes latency across
  // all of them (and never fails the chat: per-server failures are isolated).
  const settled = await Promise.allSettled(
    servers.map(async (server): Promise<ChatTool[]> => {
      const allowInternal = Boolean(server.trusted);
      if (!isSafeMcpUrl(server.url, { allowInternal }).ok) return [];
      const tools = await listMcpTools(server, signal, allowInternal);
      return tools.slice(0, MAX_TOOLS_PER_SERVER).map((tool) => wrap(server, tool, allowInternal));
    })
  );
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
};
