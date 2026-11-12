// Settings › Contact messages, persisted with the service role (server/sql/contact_messages.sql).
//
// The browser never touches public.contact_messages: it POSTs to /api/contact (routes/contact.ts),
// which validates, rate-limits and then writes here. Admins read and mark messages through
// /api/admin/contact-messages (routes/admin.ts).
//
// Rules:
// - NEVER throw. Every path resolves to a small result, so a route can answer honestly (503 when
//   the store is not there yet) instead of crashing.
// - NEVER log a message's text or the address someone typed: logs carry codes only.

import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import { logger } from '../lib/logger.js';

/** The caps server/sql/contact_messages.sql checks (char_length counts code points); shared with the form. */
export { CONTACT_EMAIL_MAX, CONTACT_EMAIL_MIN, CONTACT_MESSAGE_MAX } from '../../../shared/contactMessage.js';
/** One admin page of messages, newest first. */
export const CONTACT_PAGE_LIMIT = 50;

const TABLE = 'contact_messages';
const COLUMNS = 'id, email, message, created_at, handled_at';

export interface ContactMessageRow {
  id: string;
  email: string;
  message: string;
  created_at: string;
  handled_at: string | null;
}

export interface ContactMessageInput {
  userId: string;
  email: string;
  message: string;
}

export type ContactInsertResult = { ok: true } | { ok: false; reason: 'unavailable' | 'failed' };

export type ContactListResult =
  | { ok: true; items: ContactMessageRow[]; nextCursor?: string }
  | { ok: false; reason: 'unavailable' | 'failed' };

export type ContactHandledResult =
  | { ok: true; handledAt: string }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'failed' };

/** The seam routes depend on; tests pass a fake. */
export interface ContactStore {
  insert(input: ContactMessageInput): Promise<ContactInsertResult>;
  list(opts?: { limit?: unknown; cursor?: unknown }): Promise<ContactListResult>;
  markHandled(id: string): Promise<ContactHandledResult>;
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * The table is not there yet (server/sql/contact_messages.sql not applied): PostgREST answers PGRST205,
 * Postgres 42P01. That is "not set up", not an outage, so it maps to 'unavailable' like a missing
 * service role, and the admin reader can say so instead of "the service didn't answer".
 */
const tableMissing = (error: unknown): boolean => ['PGRST205', '42P01'].includes(errorCode(error) ?? '');

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const persistenceOn = (): boolean => getSupabaseCapabilityStatus().storagePersistenceEnabled;

/** The exact row the server writes: who sent it, the reply-to address and the text. Nothing else. */
export const contactInsertRow = (input: ContactMessageInput) => ({
  user_id: input.userId,
  email: input.email,
  message: input.message
});

const toRow = (raw: Record<string, unknown>): ContactMessageRow => ({
  id: String(raw.id ?? ''),
  email: String(raw.email ?? ''),
  message: String(raw.message ?? ''),
  created_at: String(raw.created_at ?? ''),
  handled_at: typeof raw.handled_at === 'string' ? raw.handled_at : null
});

export const insertContactMessage = async (input: ContactMessageInput): Promise<ContactInsertResult> => {
  if (!persistenceOn()) return { ok: false, reason: 'unavailable' };
  try {
    const { error } = await getSupabaseAdmin().from(TABLE).insert(contactInsertRow(input));
    if (error) {
      logger.warn('contact_persist_failed', { code: errorCode(error) });
      return { ok: false, reason: tableMissing(error) ? 'unavailable' : 'failed' };
    }
    return { ok: true };
  } catch (error) {
    logger.warn('contact_persist_threw', { code: errorCode(error) });
    return { ok: false, reason: 'failed' };
  }
};

export const listContactMessages = async (opts: { limit?: unknown; cursor?: unknown } = {}): Promise<ContactListResult> => {
  if (!persistenceOn()) return { ok: false, reason: 'unavailable' };
  const limit = clampInt(opts.limit, CONTACT_PAGE_LIMIT, 1, CONTACT_PAGE_LIMIT);
  const offset = clampInt(opts.cursor, 0, 0, 1_000_000);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select(COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      logger.warn('contact_list_failed', { code: errorCode(error) });
      return { ok: false, reason: tableMissing(error) ? 'unavailable' : 'failed' };
    }
    const items = ((data || []) as Array<Record<string, unknown>>).map(toRow);
    return { ok: true, items, ...(items.length === limit ? { nextCursor: String(offset + limit) } : {}) };
  } catch (error) {
    logger.warn('contact_list_threw', { code: errorCode(error) });
    return { ok: false, reason: 'failed' };
  }
};

/**
 * Marks a message handled. Idempotent: the first time stamps handled_at; a second call keeps that
 * first time and answers it again. An id with no row is not_found.
 */
export const markContactMessageHandled = async (id: string): Promise<ContactHandledResult> => {
  if (!persistenceOn()) return { ok: false, reason: 'unavailable' };
  try {
    const admin = getSupabaseAdmin();
    const { data: updated, error } = await admin
      .from(TABLE)
      .update({ handled_at: new Date().toISOString() })
      .eq('id', id)
      .is('handled_at', null)
      .select('id, handled_at')
      .maybeSingle();
    if (error) {
      logger.warn('contact_handled_failed', { code: errorCode(error) });
      return { ok: false, reason: tableMissing(error) ? 'unavailable' : 'failed' };
    }
    if (updated && typeof (updated as { handled_at?: unknown }).handled_at === 'string') {
      return { ok: true, handledAt: (updated as { handled_at: string }).handled_at };
    }
    // Nothing updated: either it was already handled (keep the first time) or there is no such row.
    const { data: existing, error: readError } = await admin.from(TABLE).select('id, handled_at').eq('id', id).maybeSingle();
    if (readError) {
      logger.warn('contact_handled_read_failed', { code: errorCode(readError) });
      return { ok: false, reason: tableMissing(readError) ? 'unavailable' : 'failed' };
    }
    const handledAt = (existing as { handled_at?: unknown } | null)?.handled_at;
    if (typeof handledAt === 'string') return { ok: true, handledAt };
    return { ok: false, reason: 'not_found' };
  } catch (error) {
    logger.warn('contact_handled_threw', { code: errorCode(error) });
    return { ok: false, reason: 'failed' };
  }
};

/** The production store: the service-role Supabase client. */
export const supabaseContactStore: ContactStore = {
  insert: insertContactMessage,
  list: listContactMessages,
  markHandled: markContactMessageHandled
};
