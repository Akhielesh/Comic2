// Persistence for the email system (Supabase, service-role). Backs three things:
//   • email_log         — one row per send attempt (observability + cost accounting)
//   • email_suppressions — the working unsubscribe list (marketing only)
//   • waitlist_signups   — newsletter double opt-in (confirm/unsubscribe columns)
//
// Delivery logging is best effort. Consent-related writes must succeed before the route
// acknowledges them. Marketing sends require a successful suppression check.

import crypto from 'crypto';
import { RECEIPT_TEMPLATES } from '../../../shared/email/index.js';
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
  openReceiptHash?: string;
  ackReceiptHash?: string;
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
        ...(entry.openReceiptHash ? { open_receipt_hash: entry.openReceiptHash } : {}),
        ...(entry.ackReceiptHash ? { ack_receipt_hash: entry.ackReceiptHash } : {}),
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

export const receiptHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
export const RECEIPT_LIFETIME_DAYS = 90;
const receiptCutoff = () => new Date(Date.now() - RECEIPT_LIFETIME_DAYS * 86_400_000).toISOString();

/** Stamps only the first request, without retaining identity, IP, client or per-open history. */
export const recordImageRequest = async (token: string, legacy = false): Promise<void> => {
  const db = adminOrNull();
  if (!db) return;
  let query = db.from('email_log').update({ opened_at: new Date().toISOString() })
    .is('opened_at', null).gte('created_at', receiptCutoff()).in('status', ['queued', 'sent'])
    .in('template', [...RECEIPT_TEMPLATES]);
  query = legacy ? query.eq('id', token).is('receipt_version', null) : query.eq('open_receipt_hash', receiptHash(token));
  await query;
};

/** Acknowledge a message only once. Repeated submissions of its still-valid link return the same success. */
export const acknowledgeMessage = async (token: string): Promise<boolean> => {
  const db = adminOrNull();
  if (!db) throw new Error('Receipt store unavailable');
  const hash = receiptHash(token);
  const cutoff = receiptCutoff();
  const { data, error } = await db.from('email_log').update({ acknowledged_at: new Date().toISOString() })
    .eq('ack_receipt_hash', hash).is('acknowledged_at', null).gte('created_at', cutoff)
    .in('status', ['queued', 'sent']).in('template', [...RECEIPT_TEMPLATES]).select('id').maybeSingle();
  if (error) throw new Error('Receipt store unavailable');
  if (data) return true;
  const existing = await db.from('email_log').select('acknowledged_at').eq('ack_receipt_hash', hash)
    .gte('created_at', cutoff).in('status', ['queued', 'sent']).in('template', [...RECEIPT_TEMPLATES]).maybeSingle();
  if (existing.error) throw new Error('Receipt store unavailable');
  return Boolean(existing.data?.acknowledged_at);
};

/** Treat an unavailable suppression list as suppressed until it can be checked. */
export const isSuppressed = async (email: string, scope: 'marketing' | 'all' = 'marketing'): Promise<boolean> => {
  const db = adminOrNull();
  if (!db) return true;
  try {
    const { data, error } = await db
      .from('email_suppressions')
      .select('scope')
      .eq('email', normalizeEmail(email))
      .in('scope', scope === 'all' ? ['all'] : ['marketing', 'all']);
    if (error) return true;
    return !Array.isArray(data) || data.length > 0;
  } catch {
    return true;
  }
};

/** A product update requires an active, double-opted-in updates subscription. */
export const hasConfirmedUpdates = async (email: string): Promise<boolean> => {
  const db = adminOrNull();
  if (!db) return false;
  try {
    const { data, error } = await db.from('waitlist_signups').select('id')
      .eq('email', normalizeEmail(email)).eq('kind', 'updates').eq('confirmed', true)
      .is('unsubscribed_at', null).maybeSingle();
    return !error && Boolean(data?.id);
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
  if (!db) throw storeFailed('unsubscribe (no service role)');
  const { error } = await db
    .from('email_suppressions')
    .upsert({ email: normalizeEmail(email), scope, reason }, { onConflict: 'email,scope' });
  if (error) throw storeFailed('suppression', error);
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

// ── Per-recipient auth-email throttle (routes/authEmail.ts) ─────────────────────
// The backend sends confirm / reset / magic-link mail itself, so it owns the throttling GoTrue
// used to do. email_log is the durable record (the in-memory rate limiter resets whenever the
// container sleeps). Only mail that went out — or is going out — counts: a failed send never
// locks the user out of retrying. Failures read as 0 / null: a log hiccup must not block sign-up.

/** Templates the auth-email routes send; to_email is stored lowercased (normalizeEmail). */
export const AUTH_EMAIL_TEMPLATES = ['auth-confirm-signup', 'auth-recovery', 'auth-magic-link'] as const;
const AUTH_EMAIL_COUNTED_STATUSES: EmailStatus[] = ['queued', 'sent'];

/** How many auth emails this address was sent since `sinceIso`. */
export const countRecentAuthEmails = async (email: string, sinceIso: string): Promise<number> => {
  const db = adminOrNull();
  if (!db) return 0;
  try {
    const { count, error } = await db
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('to_email', normalizeEmail(email))
      .in('template', [...AUTH_EMAIL_TEMPLATES])
      .in('status', AUTH_EMAIL_COUNTED_STATUSES)
      .gte('created_at', sinceIso);
    if (error) {
      console.warn('[email] countRecentAuthEmails failed', error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.warn('[email] countRecentAuthEmails error', (err as Error)?.message);
    return 0;
  }
};

/** When this address was last sent an auth email (ISO), or null. Drives the "wait N seconds" answer. */
export const latestAuthEmailAt = async (email: string): Promise<string | null> => {
  const db = adminOrNull();
  if (!db) return null;
  try {
    const { data, error } = await db
      .from('email_log')
      .select('created_at')
      .eq('to_email', normalizeEmail(email))
      .in('template', [...AUTH_EMAIL_TEMPLATES])
      .in('status', AUTH_EMAIL_COUNTED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { created_at?: string }).created_at ?? null;
  } catch {
    return null;
  }
};

/** Recent send-log rows for the admin Email Console (delivery + opens). Service-role only. */
export const recentLog = async (limit = 50): Promise<Array<Record<string, unknown>>> => {
  const db = adminOrNull();
  if (!db) throw new Error('Email log unavailable');
  const { data, error } = await db.from('email_log')
    .select('id, to_email, template, kind, status, message_id, error, opened_at, acknowledged_at, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(200, Math.max(1, Math.floor(limit))));
  if (error) throw new Error('Email log unavailable; check the email_system.sql migration');
  return (data as Array<Record<string, unknown>>) || [];
};

// ── Newsletter double opt-in ────────────────────────────────────────────────────
export const newConfirmToken = (): string => crypto.randomBytes(24).toString('hex');

export type SubscribeOutcome = 'new' | 'pending' | 'already_confirmed' | 'already_registered';

export interface SubscriberIntent {
  /** Optional free-text note (capped upstream); also kept in the existing feedback column. */
  feedback?: string;
}

const sanitizeIntent = (intent?: SubscriberIntent): { feedback?: string } => {
  const feedback = typeof intent?.feedback === 'string' ? intent.feedback.trim().slice(0, 1000) : '';
  return feedback ? { feedback } : {};
};

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
/** True when a row's (or a request's) metadata holds a yes to updates (`metadata.consent.updates === true`). */
const saysYesToUpdates = (metadata: unknown): boolean => asObject(asObject(metadata).consent).updates === true;

/** A failed store operation may be retried without overwriting a successful registration. */
const storeFailed = (step: string, error?: { code?: string; message?: string } | null): Error =>
  new Error(`waitlist ${step} failed${error?.code ? ` (${error.code})` : ''}`);

/**
 * Store a waitlist signup and return what happened. Idempotent on (lower(email), kind).
 * - A new address gets one row: its metadata and intent (the note), unconfirmed.
 * - An address already on the list keeps its row as it is: rows are keyed by an email the caller
 *   supplies, so a repeat (or a stranger) never replaces the answers stored there. Two narrow exceptions:
 *   - an 'access' row that holds no yes to updates, when this request ticked the box: only `metadata.consent`
 *     is set to the new yes (answers, feedback and every other key are kept, and a yes is never turned back
 *     into a no). That adds nothing a stranger could not already do with a new row, and the flag is only a
 *     request from an unverified address, never a reason to mail it (docs/features/register-interest.md).
 *   - an unconfirmed, subscribed 'updates' row with interest emails on: reuse its live token,
 *     or conditionally replace its expired/missing token before the mailer uses it.
 * Throws when nothing could be stored (no service role, or the database refused): supabase-js returns
 * its errors instead of throwing, so each one is read here. A unique violation on insert (two requests
 * at once) counts as already on the list.
 */
export const upsertSubscriber = async (
  email: string,
  kind: 'updates' | 'access',
  token: string,
  metadata: Json = {},
  intent?: SubscriberIntent,
  options: { reissueToken?: boolean } = {}
): Promise<{ outcome: SubscribeOutcome; confirmToken?: string }> => {
  const db = adminOrNull();
  const normalized = normalizeEmail(email);
  if (!db) throw storeFailed('store (no service role)');
  const intentCols = sanitizeIntent(intent);

  type Signup = {
    id: string;
    confirmed: boolean;
    metadata: unknown;
    confirm_token: string | null;
    confirm_sent_at: string | null;
    unsubscribed_at: string | null;
    mail_requested_at?: string | null;
  };
  const fields = 'id, confirmed, metadata, confirm_token, confirm_sent_at, unsubscribed_at';
  const { data: row, error: lookupError } = await db
    .from('waitlist_signups')
    .select(options.reissueToken ? 'id, confirmed, metadata, confirm_token, confirm_sent_at, unsubscribed_at, mail_requested_at' : fields)
    .eq('email', normalized)
    .eq('kind', kind)
    .limit(1)
    .maybeSingle<Signup>();
  if (lookupError) throw storeFailed('lookup', lookupError);

  const now = new Date().toISOString();
  if (row) {
    // 'access' rows have no confirm step: the email is simply already on the list.
    if (kind === 'access') {
      // A ticked box on a later visit is recorded (the thank-you says they will hear when updates start); the rest
      // of the row stays as the first visit left it, and a stored yes is never overwritten.
      if (saysYesToUpdates(metadata) && !saysYesToUpdates(row.metadata)) {
        const { error: consentError } = await db
          .from('waitlist_signups')
          .update({ metadata: { ...asObject(row.metadata), consent: asObject(metadata).consent } })
          .eq('id', row.id);
        if (consentError) throw storeFailed('consent update', consentError);
      }
      return { outcome: 'already_registered' };
    }
    if (row.confirmed) return { outcome: 'already_confirmed' };
    if (!options.reissueToken || row.unsubscribed_at) return { outcome: 'already_registered' };
    const previous = row.confirm_token ?? null;
    if (previous && row.confirm_sent_at && (NEWSLETTER_CONFIRM_TTL_HOURS === 0 ||
        Date.parse(row.confirm_sent_at) >= Date.now() - NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000)) {
      // A repeat request must not invalidate a confirmation link already in the person's inbox.
      // At most one resend request per minute, including concurrent posts. The DB trigger
      // coalesces pending work for the same row and template.
      if (!row.mail_requested_at || Date.parse(row.mail_requested_at) <= Date.now() - 60_000) {
        let request = db.from('waitlist_signups').update({ mail_requested_at: now })
          .eq('id', row.id).eq('confirmed', false).eq('confirm_token', previous).is('unsubscribed_at', null);
        request = row.mail_requested_at ? request.eq('mail_requested_at', row.mail_requested_at) : request.is('mail_requested_at', null);
        const { error } = await request;
        if (error) throw storeFailed('confirmation request', error);
      }
      return { outcome: 'pending', confirmToken: previous };
    }
    let renew = db.from('waitlist_signups')
      .update({ confirm_token: token, confirm_sent_at: now, mail_requested_at: now })
      .eq('id', row.id).eq('confirmed', false).is('unsubscribed_at', null);
    renew = previous === null ? renew.is('confirm_token', null) : renew.eq('confirm_token', previous);
    const { data: renewed, error: renewError } = await renew.select('id').maybeSingle();
    if (renewError) throw storeFailed('token renewal', renewError);
    return { outcome: renewed ? 'pending' : 'already_registered' };
  }

  const { error: insertError } = await db.from('waitlist_signups').insert({
    email: normalized,
    kind,
    source: typeof metadata.source === 'string' ? metadata.source : null,
    metadata,
    ...intentCols,
    confirmed: false,
    confirm_token: token,
    confirm_sent_at: now,
    ...(options.reissueToken ? { mail_requested_at: now } : {})
  });
  if (insertError) {
    if (insertError.code === '23505') return { outcome: 'already_registered' };
    throw storeFailed('insert', insertError);
  }
  return { outcome: 'new' };
};

/** Consume a live token atomically. Only the request that changed a row may send a welcome. */
export const confirmSubscriber = async (email: string, token: string, requestWelcome = false): Promise<boolean> => {
  if (!token) return false;
  const db = adminOrNull();
  if (!db) throw storeFailed('confirmation (no service role)');
  let query = db.from('waitlist_signups')
    .update({ confirmed: true, confirmed_at: new Date().toISOString(), confirm_token: null,
      ...(requestWelcome ? { mail_requested_at: new Date().toISOString() } : {}) })
    .eq('email', normalizeEmail(email)).eq('kind', 'updates').eq('confirmed', false)
    .eq('confirm_token', token).is('unsubscribed_at', null);
  if (NEWSLETTER_CONFIRM_TTL_HOURS > 0) {
    const cutoff = new Date(Date.now() - NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000).toISOString();
    query = query.gte('confirm_sent_at', cutoff);
  }
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw storeFailed('confirmation', error);
  return Boolean(data);
};

/** Apply the suppression first. Both operations are safe to retry after a database error. */
export const markUnsubscribed = async (email: string): Promise<void> => {
  const db = adminOrNull();
  if (!db) throw storeFailed('unsubscribe (no service role)');
  const normalized = normalizeEmail(email);
  await suppress(normalized, 'user_unsubscribe', 'marketing');
  const { error } = await db.from('waitlist_signups')
    .update({ unsubscribed_at: new Date().toISOString(), confirm_token: null })
    .eq('email', normalized);
  if (error) throw storeFailed('unsubscribe', error);
};
