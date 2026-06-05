// Server-side MCP server registry (Phase 10). Persists a user's custom MCP servers so
// they sync across devices instead of living in per-device localStorage. Scoped to a
// userId; writes use the service role and enforce ownership. URLs are SSRF-guarded on
// write (https-only, no private/loopback) — the same guard the chat loop applies.

import { getSupabaseAdmin } from './supabase.js';
import { isSafeMcpUrl, listMcpTools } from '../ai/tools/mcpClient.js';
import type { McpServerConfig } from '../../../apiTypes.js';

// After this many consecutive failed health checks, auto-disable the server so a dead
// endpoint stops adding latency to every chat (the user can re-enable it).
const AUTO_DISABLE_AFTER = 3;

export interface McpServerRow extends McpServerConfig {
  enabled: boolean;
  health: 'ok' | 'error' | 'unknown';
  lastCheckedAt?: string;
  failCount: number;
}

const mapRow = (r: Record<string, any>): McpServerRow => ({
  id: r.id,
  name: r.name,
  url: r.url,
  headers: r.headers && typeof r.headers === 'object' ? r.headers : undefined,
  enabled: r.enabled !== false,
  health: r.health === 'ok' || r.health === 'error' ? r.health : 'unknown',
  lastCheckedAt: r.last_checked_at || undefined,
  failCount: typeof r.fail_count === 'number' ? r.fail_count : 0
});

/** All of a user's saved MCP servers (newest first). */
export const listMcpServers = async (userId: string): Promise<McpServerRow[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('mcp_servers')
    .select('id, name, url, headers, enabled, health, last_checked_at, fail_count')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(50);
  return (data || []).map(mapRow);
};

/** The enabled servers as plain configs, for wrapping into chat tools. */
export const enabledMcpConfigs = async (userId: string): Promise<McpServerConfig[]> => {
  const rows = await listMcpServers(userId);
  return rows
    .filter((r) => r.enabled && isSafeMcpUrl(r.url).ok)
    .map((r) => ({ id: r.id, name: r.name, url: r.url, headers: r.headers }));
};

export const saveMcpServer = async (
  userId: string,
  input: { name?: unknown; url?: unknown; headers?: unknown; enabled?: unknown }
): Promise<{ ok: true; server: McpServerRow } | { ok: false; reason: string }> => {
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const safe = isSafeMcpUrl(url);
  if (!safe.ok) return { ok: false, reason: safe.reason || 'invalid URL' };

  const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : url).slice(0, 80);
  const headers =
    input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
      ? (input.headers as Record<string, string>)
      : {};

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('mcp_servers')
    .upsert(
      {
        user_id: userId,
        name,
        url,
        headers,
        enabled: input.enabled !== false,
        health: 'unknown',
        fail_count: 0,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,url' }
    )
    .select('id, name, url, headers, enabled, health, last_checked_at, fail_count')
    .maybeSingle();
  return data ? { ok: true, server: mapRow(data) } : { ok: false, reason: 'save failed' };
};

export const deleteMcpServer = async (userId: string, id: string): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin.from('mcp_servers').delete().eq('id', id).eq('user_id', userId).select('id');
  return Array.isArray(data) && data.length > 0;
};

/** Health-check one server by listing its tools; updates health + auto-disables on repeated failure. */
export const checkMcpServer = async (
  userId: string,
  id: string
): Promise<{ health: 'ok' | 'error'; toolCount: number; enabled: boolean } | null> => {
  const admin = getSupabaseAdmin();
  const { data: row } = await admin
    .from('mcp_servers')
    .select('id, name, url, headers, fail_count')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!row) return null;

  let health: 'ok' | 'error' = 'error';
  let toolCount = 0;
  try {
    const tools = await listMcpTools({ id: row.id, name: row.name, url: row.url, headers: row.headers });
    health = 'ok';
    toolCount = tools.length;
  } catch {
    health = 'error';
  }

  const failCount = health === 'ok' ? 0 : (row.fail_count || 0) + 1;
  const enabled = failCount < AUTO_DISABLE_AFTER;
  await admin
    .from('mcp_servers')
    .update({ health, fail_count: failCount, enabled, last_checked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId);
  return { health, toolCount, enabled };
};
