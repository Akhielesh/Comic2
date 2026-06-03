// Minimal MCP (Model Context Protocol) client over Streamable HTTP / JSON-RPC.
//
// Lets users plug in their own remote MCP servers: we initialize, list their tools,
// and proxy tools/call. The listed tools are wrapped as ChatTools so they flow through
// the same agentic loop as the built-ins.
//
// Scope (v1): JSON-RPC over HTTP POST, JSON *or* single-event SSE responses. SSRF
// guards block private/loopback hosts and require https. Full streaming-SSE servers
// and OAuth flows are follow-ups.

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

export const isSafeMcpUrl = (url: string): { ok: boolean; reason?: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'must use https' };
  if (PRIVATE_HOST_RE.test(parsed.hostname) || parsed.hostname.endsWith('.local')) {
    return { ok: false, reason: 'private/loopback hosts are not allowed' };
  }
  return { ok: true };
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

const rpc = async (
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined,
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
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...(server.headers || {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(isNotification ? {} : { id: Math.floor(Math.random() * 1e9) }),
        method,
        ...(params ? { params } : {})
      }),
      signal: controller.signal
    });
    const sid = res.headers.get('mcp-session-id') || sessionId;
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

const handshake = async (server: McpServerConfig, signal?: AbortSignal): Promise<string | undefined> => {
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
  // Best-effort "initialized" notification (some servers require it before tools/list).
  await rpc(server, 'notifications/initialized', undefined, init.sessionId, true, signal).catch(() => undefined);
  return init.sessionId;
};

export const listMcpTools = async (server: McpServerConfig, signal?: AbortSignal): Promise<McpTool[]> => {
  const cached = toolsCache.get(server.url);
  if (cached && Date.now() - cached.at < TOOLS_CACHE_TTL_MS) return cached.tools;

  const safe = isSafeMcpUrl(server.url);
  if (!safe.ok) throw new Error(`MCP server URL rejected: ${safe.reason}`);

  const sessionId = await handshake(server, signal);
  const { result } = await rpc(server, 'tools/list', {}, sessionId, false, signal);
  const tools: McpTool[] = Array.isArray(result?.tools)
    ? result.tools
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    : [];
  toolsCache.set(server.url, { at: Date.now(), tools });
  return tools;
};

const callMcpTool = async (
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string> => {
  const sessionId = await handshake(server, signal);
  const { result } = await rpc(server, 'tools/call', { name: toolName, arguments: args }, sessionId, false, signal);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type === 'text' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (result?.isError) return `Tool error: ${text || 'unknown error'}`;
  return text || 'The tool returned no text content.';
};

// Namespaced tool id so MCP tools never collide with built-ins or each other.
const mcpToolName = (serverId: string, tool: string) => `mcp_${serverId}_${tool}`;

/** Build ChatTools for all tools exposed by the given MCP servers (best-effort per server). */
export const buildMcpTools = async (servers: McpServerConfig[], signal?: AbortSignal): Promise<ChatTool[]> => {
  const out: ChatTool[] = [];
  for (const server of servers) {
    if (!isSafeMcpUrl(server.url).ok) continue;
    let tools: McpTool[] = [];
    try {
      tools = await listMcpTools(server, signal);
    } catch {
      continue; // a broken server shouldn't break the chat
    }
    for (const tool of tools) {
      out.push({
        name: mcpToolName(server.id, tool.name),
        description: `[${server.name}] ${tool.description || tool.name}`,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        execute: async (args, sig): Promise<ToolExecResult> => {
          try {
            const text = await callMcpTool(server, tool.name, args, sig);
            return { content: text };
          } catch (err) {
            return { content: `MCP call failed: ${(err as Error)?.message || 'unknown error'}` };
          }
        }
      });
    }
  }
  return out;
};
