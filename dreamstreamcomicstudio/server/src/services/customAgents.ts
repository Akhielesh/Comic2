// Durable custom-agent library (Phase 9). Persists a user's own swarm specialists so
// they survive sessions/devices and auto-join their swarm runs, instead of being re-sent
// as request-scoped `extraAgents` every time. The 8 built-ins live in code and are never
// stored here. Every read re-runs `sanitizeCustomAgents` (defense in depth): tool names
// are re-filtered to the allowlist, ids are re-namespaced, and built-ins can't be shadowed.
//
// Scoped to a userId; writes use the service role and enforce ownership in every query.

import { getSupabaseAdmin } from './supabase.js';
import { sanitizeCustomAgents, type AgentDefinition } from '../ai/agents/registry.js';

export interface CustomAgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolNames: string[];
  isPublic: boolean;
  updatedAt: string;
}

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'agent';

const mapRow = (r: Record<string, any>): CustomAgentRow => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description || '',
  systemPrompt: r.system_prompt || '',
  toolNames: Array.isArray(r.tool_names) ? r.tool_names : [],
  isPublic: Boolean(r.is_public),
  updatedAt: r.updated_at
});

/** A user's saved agents (newest first). */
export const listCustomAgents = async (userId: string): Promise<CustomAgentRow[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('custom_agents')
    .select('id, slug, name, description, system_prompt, tool_names, is_public, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(50);
  return (data || []).map(mapRow);
};

/** Create or update one agent. The payload is sanitized before it is stored. */
export const saveCustomAgent = async (
  userId: string,
  input: { id?: string; name?: unknown; description?: unknown; systemPrompt?: unknown; toolNames?: unknown; isPublic?: unknown }
): Promise<CustomAgentRow | null> => {
  // Reuse the swarm's request-time sanitizer so stored agents obey the exact same rules
  // (length caps, allowlisted tools minus the swarm tool, safe ids).
  const [safe] = sanitizeCustomAgents([
    { name: input.name, description: input.description, systemPrompt: input.systemPrompt, toolNames: input.toolNames }
  ]);
  if (!safe) return null;

  const admin = getSupabaseAdmin();
  const slug = slugify(String(input.name || safe.name));
  const row = {
    user_id: userId,
    slug,
    name: safe.name,
    description: safe.description,
    system_prompt: safe.systemPrompt,
    tool_names: safe.toolNames,
    is_public: input.isPublic === true,
    updated_at: new Date().toISOString()
  };

  // Update in place when an id is supplied (ownership-guarded), else upsert on (user, slug).
  if (typeof input.id === 'string' && input.id) {
    const { data } = await admin
      .from('custom_agents')
      .update(row)
      .eq('id', input.id)
      .eq('user_id', userId)
      .select('id, slug, name, description, system_prompt, tool_names, is_public, updated_at')
      .maybeSingle();
    return data ? mapRow(data) : null;
  }
  const { data } = await admin
    .from('custom_agents')
    .upsert(row, { onConflict: 'user_id,slug' })
    .select('id, slug, name, description, system_prompt, tool_names, is_public, updated_at')
    .maybeSingle();
  return data ? mapRow(data) : null;
};

export const deleteCustomAgent = async (userId: string, id: string): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('custom_agents')
    .delete()
    .eq('id', id)
    .eq('user_id', userId)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

/**
 * The user's saved agents as deployable swarm AgentDefinitions (re-sanitized + namespaced).
 * Best-effort: never throws — a DB hiccup must not break a swarm run, it just means the
 * user's saved specialists aren't added this turn.
 */
export const loadCustomAgentDefinitions = async (userId: string): Promise<AgentDefinition[]> => {
  try {
    const rows = await listCustomAgents(userId);
    return sanitizeCustomAgents(
      rows.map((r) => ({ id: r.slug, name: r.name, description: r.description, systemPrompt: r.systemPrompt, toolNames: r.toolNames }))
    );
  } catch {
    return [];
  }
};
