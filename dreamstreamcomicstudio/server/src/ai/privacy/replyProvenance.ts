// Server-side provenance of replies that carried connected-account content (finding C1a).
//
// The chat client sends its history back as plain text (role + content). A reply that was
// answered from the user's Gmail, Drive or Calendar looks like any other text when it comes back,
// so a later turn on a free model could not tell that its history carries connected content. The
// server therefore remembers, per user, a hash of every reply it marked as connected content
// (routes/chat.ts marks a reply only when connector content was actually sent for it, see
// ./scope.ts ConnectorEgressProbe) and recognises those replies when they come back in history.
//
// Storage: `public.chat_connector_replies` (server/sql/chat_connector_replies.sql), keyed by
// (user_id, reply_hash), service role only, bounded per user (the newest CONNECTOR_REPLY_KEEP rows)
// and by age (CONNECTOR_REPLY_TTL_DAYS) by `record_chat_connector_reply`. Only a SHA-256 of the
// normalised reply text is stored, never the text. The backend sleeps when idle, so memory alone
// would forget; a bounded in-process cache answers repeat lookups and covers the moment between a
// reply and the client's next message.
//
// Failure: a write or lookup that fails (database down, the SQL not applied yet) falls back to the
// in-process cache and is logged (`connector_reply_marks_unavailable`, at most once a minute); it
// never blocks or fails a chat. The provenance markers the client may echo
// (connectorData.ts messageCarriesConnectorData) keep working without the store.

import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { logger } from '../../lib/logger.js';
import { textOfContent } from './connectorData.js';

export const CONNECTOR_REPLY_TABLE = 'chat_connector_replies';
/** Rows kept per user (the SQL function prunes older ones). */
export const CONNECTOR_REPLY_KEEP = 2_000;
/** Rows older than this are ignored by lookups and pruned on the next write. */
export const CONNECTOR_REPLY_TTL_DAYS = 365;
/** In-process cache entries (user + hash), oldest evicted first. */
const CACHE_LIMIT = 20_000;
/** A lookup never holds a chat turn longer than this. */
const LOOKUP_TIMEOUT_MS = 1_500;
/** The newest assistant replies of a history that are checked. */
const MAX_LOOKUP_HASHES = 60;

/** The text a reply is recognised by: Unicode NFC, whitespace collapsed, trimmed. */
export const normaliseReplyText = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** SHA-256 (hex) of the normalised reply text; null for an empty reply. */
export const connectorReplyHash = (text: unknown): string | null => {
  const normalised = typeof text === 'string' ? normaliseReplyText(text) : '';
  return normalised ? createHash('sha256').update(normalised).digest('hex') : null;
};

const cache = new Map<string, true>();
const remember = (key: string): void => {
  cache.delete(key);
  cache.set(key, true);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
};
const keyOf = (userId: string, hash: string) => `${userId}:${hash}`;

let lastWarnAt = 0;
const warn = (op: 'write' | 'lookup', err: unknown): void => {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  logger.warn('connector_reply_marks_unavailable', { op, message: String((err as Error)?.message || err).slice(0, 200) });
};

const withTimeout = <T>(work: PromiseLike<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connector reply lookup timed out after ${ms}ms`)), ms);
    Promise.resolve(work).then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    );
  });

/**
 * Remember that `text` is a reply that carried connected-account content for this user. The cache
 * is updated at once (synchronously); the durable write is best-effort and never throws.
 */
export const recordConnectorReply = async (userId: string | undefined, text: unknown): Promise<void> => {
  const hash = connectorReplyHash(text);
  if (!userId || !hash) return;
  remember(keyOf(userId, hash));
  try {
    const { error } = await getSupabaseAdmin().rpc('record_chat_connector_reply', {
      p_user_id: userId,
      p_reply_hash: hash,
      p_keep: CONNECTOR_REPLY_KEEP,
      p_ttl_days: CONNECTOR_REPLY_TTL_DAYS
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    warn('write', err);
  }
};

/** The hashes of the assistant replies in `messages` (newest last, deduplicated, bounded). */
export const assistantReplyHashes = (messages: readonly unknown[] | undefined): string[] => {
  const out: string[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const rec = m && typeof m === 'object' ? (m as { role?: unknown; content?: unknown }) : null;
    if (rec?.role !== 'assistant') continue;
    const hash = connectorReplyHash(textOfContent(rec.content));
    if (hash && !out.includes(hash)) out.push(hash);
  }
  return out.slice(-MAX_LOOKUP_HASHES);
};

/**
 * Does this history contain a reply this server marked as connected content for this user?
 * The cache first, then one indexed lookup (time-boxed). A failed lookup answers from the cache.
 */
export const historyHasConnectorReply = async (userId: string | undefined, messages: readonly unknown[] | undefined): Promise<boolean> => {
  if (!userId) return false;
  const hashes = assistantReplyHashes(messages);
  if (!hashes.length) return false;
  if (hashes.some((h) => cache.has(keyOf(userId, h)))) return true;
  try {
    const since = new Date(Date.now() - CONNECTOR_REPLY_TTL_DAYS * 86_400_000).toISOString();
    const { data, error } = await withTimeout(
      getSupabaseAdmin()
        .from(CONNECTOR_REPLY_TABLE)
        .select('reply_hash')
        .eq('user_id', userId)
        .in('reply_hash', hashes)
        .gte('created_at', since)
        .limit(1),
      LOOKUP_TIMEOUT_MS
    );
    if (error) throw new Error(error.message);
    const rows = (data || []) as { reply_hash?: string }[];
    for (const r of rows) if (r.reply_hash) remember(keyOf(userId, r.reply_hash));
    return rows.length > 0;
  } catch (err) {
    warn('lookup', err);
    return false;
  }
};

/** Tests only: forget the in-process cache. */
export const __resetConnectorReplyCacheForTests = (): void => {
  cache.clear();
  lastWarnAt = 0;
};
