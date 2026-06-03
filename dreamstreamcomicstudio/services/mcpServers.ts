// Client-side registry of user-configured custom MCP servers.
//
// Stored locally (like API keys). Enabled servers are sent in the chat request body;
// the server lists their tools and proxies tool calls into the agentic loop.

import type { McpServerConfig } from '../apiTypes';

const STORAGE = 'dreamstream_mcp_servers';
export const MCP_SERVERS_CHANGED = 'dreamstream:mcp-servers-changed';

const read = (): McpServerConfig[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE);
    const parsed = raw ? (JSON.parse(raw) as McpServerConfig[]) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && s.url) : [];
  } catch {
    return [];
  }
};

const write = (list: McpServerConfig[]) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent(MCP_SERVERS_CHANGED));
  } catch {
    /* ignore */
  }
};

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `mcp_${Date.now()}`;

export const listMcpServers = (): McpServerConfig[] => read();

export const getMcpServersByIds = (ids: string[]): McpServerConfig[] =>
  read().filter((s) => ids.includes(s.id));

export const addMcpServer = (input: { name: string; url: string; authorization?: string }): McpServerConfig => {
  const entry: McpServerConfig = {
    id: uuid(),
    name: input.name.trim() || 'MCP server',
    url: input.url.trim(),
    ...(input.authorization && input.authorization.trim()
      ? { headers: { Authorization: input.authorization.trim() } }
      : {})
  };
  write([...read(), entry]);
  return entry;
};

export const updateMcpServer = (id: string, patch: { name?: string; url?: string; authorization?: string }) => {
  write(
    read().map((s) => {
      if (s.id !== id) return s;
      const next: McpServerConfig = { ...s };
      if (typeof patch.name === 'string') next.name = patch.name.trim() || next.name;
      if (typeof patch.url === 'string' && patch.url.trim()) next.url = patch.url.trim();
      if (patch.authorization !== undefined) {
        next.headers = patch.authorization.trim() ? { Authorization: patch.authorization.trim() } : undefined;
      }
      return next;
    })
  );
};

export const removeMcpServer = (id: string) => write(read().filter((s) => s.id !== id));

export const onMcpServersChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const h = () => handler();
  window.addEventListener(MCP_SERVERS_CHANGED, h);
  return () => window.removeEventListener(MCP_SERVERS_CHANGED, h);
};
