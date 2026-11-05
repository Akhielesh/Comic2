// web-surface-1: what a chat request may say about MCP servers.
//
// `ChatRequest.mcpServers` comes from the browser (services/mcpServers.ts, localStorage). It used to
// reach ai/tools/mcpClient.ts buildMcpTools as sent, and buildMcpTools trusts an entry's `trusted`
// flag (operator servers may use http and internal hosts) — so `{ url: 'http://127.0.0.1:…',
// trusted: true }` in a request body skipped the SSRF guard. Two rules close it, route side:
//   1. A request entry is REBUILT from plain fields (id, name, url, headers): `trusted` and anything
//      else the body carries is dropped, and only an https URL that passes the strict guard
//      (isSafeMcpUrl, never `allowInternal`) is kept. At most MAX_REQUEST_MCP_SERVERS.
//   2. An operator server (envDesignMcpServers, STUDIO_*_MCP_URL) is never replaced by a request or
//      saved entry that reuses its URL. The operator entry keeps its id — `nango`, whose
//      `mcp_nango_*` tools the connected-account privacy gate (ai/privacy/connectorData.ts
//      isConnectorMcpToolName) withholds from free turns and counts on paid ones — its headers
//      (the operator's secret) and its trust. URLs are compared as a browser would (scheme and host
//      case, a default port, dot segments, a trailing slash or #fragment), so a look-alike spelling
//      is dropped too instead of riding along as a second copy under another id.
// The client never sends `trusted`; saved servers are already rebuilt by services/mcpRegistry.ts.

import { isSafeMcpUrl } from '../ai/tools/mcpClient.js';
import type { McpServerConfig } from '../../../apiTypes.js';

export const MAX_REQUEST_MCP_SERVERS = 10;
/**
 * Entries looked at, valid or not. The body may be 10 MB of entries; each one costs a URL parse, so
 * the scan is bounded, not just the output. The client sends only the chat's enabled servers.
 */
export const MAX_REQUEST_MCP_ENTRIES_SCANNED = 32;
const MAX_ID = 64;
const MAX_NAME = 80;
const MAX_URL = 2048;
const MAX_HEADERS = 8;
const MAX_HEADER_VALUE = 4096;
// An RFC 9110 field name; anything else would make fetch throw for the whole server.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const plainHeaders = (raw: unknown): Record<string, string> | undefined => {
  const src = record(raw);
  if (!src) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [name, value] of Object.entries(src)) {
    if (n >= MAX_HEADERS) break;
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) continue;
    out[name] = value;
    n += 1;
  }
  return n ? out : undefined;
};

/**
 * The request's MCP servers as plain configs: strict-safe https URLs only, no `trusted`, at most 10,
 * taken from the first 32 entries.
 */
export const sanitizeRequestMcpServers = (raw: unknown): McpServerConfig[] => {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const entry of raw.slice(0, MAX_REQUEST_MCP_ENTRIES_SCANNED)) {
    if (out.length >= MAX_REQUEST_MCP_SERVERS) break;
    const s = record(entry);
    if (!s || typeof s.id !== 'string' || typeof s.url !== 'string') continue;
    const id = s.id.trim();
    const url = s.url.trim();
    if (!id || id.length > MAX_ID || !url || url.length > MAX_URL) continue;
    if (!isSafeMcpUrl(url).ok) continue;
    const name = (typeof s.name === 'string' && s.name.trim() ? s.name.trim() : new URL(url).hostname).slice(0, MAX_NAME);
    const headers = plainHeaders(s.headers);
    out.push({ id, name, url, ...(headers ? { headers } : {}) });
  }
  return out;
};

/** A URL as a browser would compare it: normalised by URL, no #fragment, no trailing slash on the path. */
const urlKey = (url: string): string => {
  try {
    const u = new URL(url.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim();
  }
};

/** `servers` without any entry whose URL is one of the operator's (those stay the operator's). */
export const withoutOperatorUrls = <T extends { url: string }>(servers: readonly T[], operator: readonly { url: string }[]): T[] => {
  if (!operator.length) return [...servers];
  const taken = new Set(operator.map((s) => urlKey(s.url)));
  return servers.filter((s) => !taken.has(urlKey(s.url)));
};
