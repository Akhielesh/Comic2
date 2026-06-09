// Persistence for the email system (Supabase, service-role). Backs three things:
//   • email_log         — one row per send attempt (observability + cost accounting)
//   • email_suppressions — the working unsubscribe list (marketing only)
//   • waitlist_signups   — newsletter double opt-in (confirm/unsubscribe columns)
//
// Every function is defensive: a missing SUPABASE_SERVICE_ROLE_KEY or a transient DB error
// must never crash a request or block an essential email, so failures degrade to safe
// defaults (and are logged), mirroring services/telemetryStore.ts.

import crypto from 'crypto';
import { getSupabaseAdmin } from './supabase.js';
import { NEWSLETTER_CONFIRM_TTL_HOURS } from '../config.js';

export type EmailKind = 'essential' | 'marketing';
export type EmailStatus = 'queued' | 'sent' | 'failed' | 'suppressed' | 'rate_limited' | 'skipped';

export const normalizeEmail = (raw: string): string => (raw || '').trim().toLowerCase();

const adminOrNull = () => {
  try {
    return getSupabaseAdmin();
  } catch {
    return null;
  }
};

export interface EmailLogEntry {
  toEmail: string;
  template: string;
  kind: EmailKind;
  status: EmailStatus;
  messageId?: string;
  error?: string;
  userId?: string | null;
  requestId?: string | null;
}

/** Insert a send-log row; returns its id (or null if logging is unavailable). */
export const logSend = async (entry: EmailLogEntry): Promise<string | null> => {
  const db = adminOrNull();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('email_log')
      .insert({
        to_email: normalizeEmail(entry.toEmail),
        template: entry.template,
        kind: entry.kind,
        status: entry.status,
        message_id: entry.messageId ?? null,
        error: entry.error ?? null,
        user_id: entry.userId ?? null,
        request_id: entry.requestId ?? null
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[email] logSend failed', error.message);
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    console.warn('[email] logSend error', (err as Error)?.message);
    return null;
  }
};

/** Patch a send-log row (status / messageId / error). Best-effort. */
export const patchLog = async (
  id: string,
  fields: { status?: EmailStatus; messageId?: string; error?: string }
): Promise<void> => {
  const db = adminOrNull();
  if (!db || !id) return;
  try {
    await db
      .from('email_log')
      .update({
        ...(fields.status ? { status: fields.status } : {}),
        ...(fields.messageId ? { message_id: fields.messageId } : {}),
        ...(fields.error ? { error: fields.error } : {})
      })
      .eq('id', id);
  } catch (err) {
    console.warn('[email] patchLog error', (err as Error)?.message);
  }
};

/** Mark a logged email as opened (read receipt). Only stamps the first open. */
export const markOpened = async (id: string): Promise<void> => {
  const db = adminOrNull();
  if (!db || !id) return;
  try {
    await db.from('email_log').update({ opened_at: new Date().toISOString() }).eq('id', id).is('opened_at', null);
  } catch (err) {
    console.warn('[email] markOpened error', (err as Error)?.message);
  }
};

/** True if the address has opted out of marketing (or all) mail. */
export const isSuppressed = async (email: string, scope: 'marketing' | 'all' = 'marketing'): Promise<boolean> => {
  const db = adminOrNull();
  if (!db) return false;
  try {
    const { data, error } = await db
      .from('email_suppressions')
      .select('scope')
      .eq('email', normalizeEmail(email))
      .in('scope', scope === 'all' ? ['all'] : ['marketing', 'all']);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
};

/** Add an address to the suppression list (idempotent). */
export const suppress = async (
  email: string,
  reason: string,
  scope: 'marketing' | 'all' = 'marketing'
): Promise<void> => {
  const db = adminOrNull();
  if (!db) return;
  try {
    await db
      .from('email_suppressions')
      .upsert({ email: normalizeEmail(email), scope, reason }, { onConflict: 'email,scope' });
  } catch (err) {
    console.warn('[email] suppress error', (err as Error)?.message);
  }
};

export interface EmailUsage {
  day: number;
  month: number;
}

/** Count emails actually SENT in the current UTC day + month (drives the hard cap). */
export const getUsage = async (): Promise<EmailUsage> => {
  const db = adminOrNull();
  if (!db) return { day: 0, month: 0 };
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const count = async (since: string): Promise<number> => {
    try {
      const { count: c } = await db
        .from('email_log')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'sent')
        .gte('created_at', since);
      return c ?? 0;
    } catch {
      return 0;
    }
  };
  const [day, month] = await Promise.all([count(dayStart), count(monthStart)]);
  return { day, month };
};

/** Recent send-log rows for the admin Email Console (delivery + opens). Service-role only. */
export const recentLog = async (limit = 50): Promise<Array<Record<string, unknown>>> => {
  const db = adminOrNull();
  if (!db) return [];
  try {
    const { data } = await db
      .from('email_log')
      .select('id, to_email, template, kind, status, message_id, error, opened_at, created_at')
      .order('created_at', { ascending: false })
      .limit(Math.min(200, Math.max(1, Math.floor(limit))));
    return (data as Array<Record<string, unknown>>) || [];
  } catch {
    return [];
  }
};

// ── Newsletter double opt-in ────────────────────────────────────────────────────
export const newConfirmToken = (): string => crypto.randomBytes(24).toString('hex');

export type SubscribeOutcome = 'new' | 'pending' | 'already_confirmed';

/**
 * Upsert a waitlist subscriber and return what happened. For 'updates' we (re)issue a
 * confirm token unless the address is already confirmed. Idempotent on (lower(email), kind).
 */
export const upsertSubscriber = async (
  email: string,
  kind: 'updates' | 'access',
  token: string,
  metadata: Record<string, unknown> = {}
): Promise<{ outcome: SubscribeOutcome }> => {
  const db = adminOrNull();
  const normalized = normalizeEmail(email);
  if (!db) return { outcome: 'pending' };

  const { data: existing } = await db
    .from('waitlist_signups')
    .select('id, confirmed')
    .eq('email', normalized)
    .eq('kind', kind)
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  if (existing) {
    if ((existing as { confirmed?: boolean }).confirmed) return { outcome: 'already_confirmed' };
    // Re-issue a fresh token + restart the expiry clock.
    await db
      .from('waitlist_signups')
      .update({ confirm_token: token, confirm_sent_at: now, unsubscribed_at: null })
      .eq('id', (existing as { id: string }).id);
    return { outcome: 'pending' };
  }

  await db.from('waitlist_signups').insert({
    email: normalized,
    kind,
    source: typeof metadata.source === 'string' ? metadata.source : null,
    metadata,
    confirmed: false,
    confirm_token: token,
    confirm_sent_at: now
  });
  return { outcome: 'new' };
};

/** Verify a confirm token and flip the row to confirmed. Returns true on success. */
export const confirmSubscriber = async (email: string, token: string): Promise<boolean> => {
  const db = adminOrNull();
  if (!db || !token) return false;
  const normalized = normalizeEmail(email);
  const { data } = await db
    .from('waitlist_signups')
    .select('id, confirm_token, confirmed, confirm_sent_at')
    .eq('email', normalized)
    .eq('kind', 'updates')
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const row = data as { id: string; confirm_token: string | null; confirmed: boolean; confirm_sent_at: string | null };
  if (row.confirmed) return true; // already confirmed — treat as success (idempotent link)
  // Constant-time token comparison.
  const a = Buffer.from(row.confirm_token || '');
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  // Strict link timeout: reject an expired confirm link (0 hours = never expires).
  if (NEWSLETTER_CONFIRM_TTL_HOURS > 0 && row.confirm_sent_at) {
    const ageMs = Date.now() - new Date(row.confirm_sent_at).getTime();
    if (ageMs > NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000) {
      // Expired — clear the stale token so it can't be retried.
      await db.from('waitlist_signups').update({ confirm_token: null }).eq('id', row.id);
      return false;
    }
  }
  await db
    .from('waitlist_signups')
    .update({ confirmed: true, confirmed_at: new Date().toISOString(), confirm_token: null })
    .eq('id', row.id);
  return true;
};

/** Stamp the waitlist row(s) unsubscribed and add the address to the suppression list. */
export const markUnsubscribed = async (email: string): Promise<void> => {
  const db = adminOrNull();
  const normalized = normalizeEmail(email);
  await suppress(normalized, 'user_unsubscribe', 'marketing');
  if (!db) return;
  try {
    await db
      .from('waitlist_signups')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('email', normalized);
  } catch (err) {
    console.warn('[email] markUnsubscribed error', (err as Error)?.message);
  }
};
