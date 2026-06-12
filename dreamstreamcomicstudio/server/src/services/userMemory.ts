// Cross-product user memory (RAG) — storage + retrieval.
//
// The durable, server-side half of DreamStream's memory: distilled facts and
// preferences live in Supabase (user_memories, pgvector), so the user's context
// follows them across Chat Studio, Code Studio and Comic Studio, across devices,
// sessions and AI models. Retrieval is model-agnostic — it returns a plain-text
// system-prompt block any provider can consume.
//
// Degradation ladder (never blocks a chat):
//   1. Gemini embeddings available → cosine search via match_user_memories().
//   2. No embedding key / embed failure → Postgres full-text search.
//   3. FTS finds nothing → most recently updated memories.
//   4. Supabase down / table missing → null (chat proceeds without memory).
//
// Tenant isolation: every query is scoped by the authenticated user's id; the
// table additionally carries owner-only RLS (see server/sql/user_memory_rag.sql).

import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from './supabase.js';
import { ASSISTANT_GEMINI_API_KEY, GEMINI_BASE_URL } from '../config.js';
import { logger } from '../lib/logger.js';

export type MemoryKind = 'fact' | 'preference' | 'project' | 'style';

export interface UserMemoryRow {
  id: string;
  product: string;
  kind: MemoryKind | string;
  content: string;
  updated_at: string;
  similarity?: number;
}

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMS = 768;
const MEMORY_CONTENT_MAX_CHARS = 400;
const RETRIEVE_LIMIT = 8;
const BLOCK_CHAR_BUDGET = 1_400;

// Memory prefs are read on every chat request — cache briefly so the hot path
// costs one DB read per user per minute, not per message.
const prefsCache = new Map<string, { enabled: boolean; at: number }>();
const PREFS_TTL_MS = 60_000;

export const isMemoryEnabled = async (userId: string): Promise<boolean> => {
  const cached = prefsCache.get(userId);
  if (cached && Date.now() - cached.at < PREFS_TTL_MS) return cached.enabled;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('user_memory_prefs')
      .select('enabled')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const enabled = data ? data.enabled !== false : true; // default ON
    prefsCache.set(userId, { enabled, at: Date.now() });
    return enabled;
  } catch (err) {
    logger.warn('user_memory_prefs_read_failed', { message: (err as Error)?.message });
    return true;
  }
};

export const setMemoryEnabled = async (userId: string, enabled: boolean): Promise<void> => {
  const { error } = await getSupabaseAdmin()
    .from('user_memory_prefs')
    .upsert({ user_id: userId, enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  prefsCache.set(userId, { enabled, at: Date.now() });
};

// ── Embeddings ──────────────────────────────────────────────────────────────────
const l2normalize = (v: number[]): number[] => {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
};

/** Embed text for storage or query. Null when no key / on failure — callers fall back to FTS. */
export const embedText = async (
  text: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'
): Promise<number[] | null> => {
  if (!ASSISTANT_GEMINI_API_KEY) return null;
  try {
    const res = await fetch(
      `${GEMINI_BASE_URL}/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${ASSISTANT_GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: text.slice(0, 8_000) }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMS
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMS) return null;
    // Truncated-dimension Gemini embeddings are not pre-normalized; cosine
    // search expects unit vectors.
    return l2normalize(values);
  } catch (err) {
    logger.warn('user_memory_embed_failed', { message: (err as Error)?.message });
    return null;
  }
};

// ── Writes ──────────────────────────────────────────────────────────────────────
const hashContent = (content: string): string =>
  createHash('sha256').update(content.trim().toLowerCase()).digest('hex');

export interface MemoryWriteItem {
  content: string;
  kind?: MemoryKind;
}

/**
 * Upsert distilled memory items for a user. Dedupe is content-hash based so
 * re-distilling the same fact refreshes updated_at instead of duplicating.
 * Best-effort by design: failures are logged, never thrown into the chat path.
 */
export const rememberUserMemories = async (
  userId: string,
  product: string,
  sessionId: string | null,
  items: MemoryWriteItem[]
): Promise<number> => {
  const cleaned = items
    .map((i) => ({ kind: i.kind ?? 'fact', content: i.content.replace(/^[-•*]\s*/, '').trim().slice(0, MEMORY_CONTENT_MAX_CHARS) }))
    .filter((i) => i.content.length >= 8);
  if (!cleaned.length) return 0;
  if (!(await isMemoryEnabled(userId))) return 0;
  try {
    const rows = await Promise.all(
      cleaned.map(async (item) => ({
        user_id: userId,
        product,
        session_id: sessionId,
        kind: item.kind,
        content: item.content,
        content_hash: hashContent(item.content),
        embedding: await embedText(item.content, 'RETRIEVAL_DOCUMENT'),
        updated_at: new Date().toISOString()
      }))
    );
    const { error } = await getSupabaseAdmin()
      .from('user_memories')
      .upsert(rows, { onConflict: 'user_id,content_hash' });
    if (error) throw new Error(error.message);
    return rows.length;
  } catch (err) {
    logger.warn('user_memory_write_failed', { message: (err as Error)?.message });
    return 0;
  }
};

// ── Retrieval ───────────────────────────────────────────────────────────────────
const fetchByVector = async (userId: string, queryEmbedding: number[]): Promise<UserMemoryRow[]> => {
  const { data, error } = await getSupabaseAdmin().rpc('match_user_memories', {
    p_user_id: userId,
    p_embedding: queryEmbedding,
    p_limit: RETRIEVE_LIMIT
  });
  if (error) throw new Error(error.message);
  return (data || []) as UserMemoryRow[];
};

const fetchByText = async (userId: string, query: string): Promise<UserMemoryRow[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_memories')
    .select('id, product, kind, content, updated_at')
    .eq('user_id', userId)
    .textSearch('content', query, { type: 'websearch', config: 'english' })
    .order('updated_at', { ascending: false })
    .limit(RETRIEVE_LIMIT);
  if (error) throw new Error(error.message);
  return (data || []) as UserMemoryRow[];
};

const fetchRecent = async (userId: string, limit = RETRIEVE_LIMIT): Promise<UserMemoryRow[]> => {
  const { data, error } = await getSupabaseAdmin()
    .from('user_memories')
    .select('id, product, kind, content, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []) as UserMemoryRow[];
};

/** Raw memory rows relevant to a query (vector → FTS → recency). */
export const retrieveUserMemories = async (userId: string, queryText: string): Promise<UserMemoryRow[]> => {
  const query = (queryText || '').trim();
  try {
    if (query) {
      const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY');
      if (queryEmbedding) {
        const rows = await fetchByVector(userId, queryEmbedding);
        if (rows.length) return rows;
      } else {
        const rows = await fetchByText(userId, query).catch(() => []);
        if (rows.length) return rows;
      }
    }
    return await fetchRecent(userId);
  } catch (err) {
    logger.warn('user_memory_retrieve_failed', { message: (err as Error)?.message });
    return [];
  }
};

/**
 * The system-prompt block injected before every model call (any provider, any
 * studio). Returns null when memory is off, empty, or unavailable.
 */
export const buildUserMemoryBlock = async (userId: string, queryText: string): Promise<string | null> => {
  if (!(await isMemoryEnabled(userId))) return null;
  const rows = await retrieveUserMemories(userId, queryText);
  if (!rows.length) return null;
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `- ${row.content}`;
    if (used + line.length > BLOCK_CHAR_BUDGET) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return null;
  return `\n\nUSER MEMORY (durable facts this user chose to have remembered across DreamStream products; use them to personalize, never recite them unprompted, never present them as things the user said in THIS conversation):\n${lines.join('\n')}`;
};

// ── Management (settings / privacy surface) ────────────────────────────────────
export const listUserMemories = async (userId: string, limit = 100): Promise<UserMemoryRow[]> =>
  fetchRecent(userId, Math.min(Math.max(limit, 1), 500)).catch(() => []);

export const deleteUserMemory = async (userId: string, memoryId: string): Promise<boolean> => {
  const { error, count } = await getSupabaseAdmin()
    .from('user_memories')
    .delete({ count: 'exact' })
    .eq('user_id', userId)
    .eq('id', memoryId);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
};

export const deleteAllUserMemories = async (userId: string): Promise<number> => {
  const { error, count } = await getSupabaseAdmin()
    .from('user_memories')
    .delete({ count: 'exact' })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return count ?? 0;
};
