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
import { confirmTokenExpired, confirmTokenIssuedAt } from './confirmToken.js';
import { STUDIO_INTEREST_IDS, sanitizeStudioInterests, type StudioInterestId } from '../../../services/studioInterests.js';

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

// ── Per-recipient newsletter-confirm throttle (services/interestStore.ts) ───────────
// Same idea as the auth throttle above, for the double opt-in email (security finding
// abuse-ops-11: re-subscribing used to re-send it on every request). Unlike the auth helpers,
// these report a log they couldn't read (undefined / null) instead of 0, so the caller can fall
// back to the subscriber row's own confirm_sent_at rather than silently allowing a send.

export const NEWSLETTER_CONFIRM_TEMPLATE = 'newsletter-confirm';

/**
 * The inbox an address delivers to, for per-recipient limits only (mail always goes to, and is
 * logged under, the address as typed): lowercased, without a +tag (most providers deliver
 * a+tag@x to a@x), and for Gmail without dots, with googlemail.com folded into gmail.com. So
 * "victim+1@gmail.com", "v.ictim@gmail.com" and "victim@googlemail.com" share one allowance.
 */
export const inboxKey = (email: string): string => {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;
  let local = normalized.slice(0, at);
  let domain = normalized.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
};

/** LIKE pattern characters escaped (PostgREST passes the backslashes through to ILIKE). */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Confirmation-log rows read per lookup. The confirmation budget (interestStore.ts
 * CONFIRM_EMAIL_BUDGET_SHARE of EMAIL_MAX_PER_DAY) keeps a day's sends far below this.
 */
const INBOX_LOOKUP_LIMIT = 1000;

/**
 * When confirmation emails went (or are going) to this INBOX since `sinceIso`, newest first: the
 * address itself and every alias of it (inboxKey). Rows are read by domain and matched here, since
 * the aliases can't be listed up front. null = log unreadable.
 */
export const recentConfirmEmailsToInbox = async (email: string, sinceIso: string): Promise<string[] | null> => {
  const db = adminOrNull();
  if (!db) return null;
  const key = inboxKey(email);
  const domain = key.slice(key.lastIndexOf('@') + 1);
  // Both Gmail domains in one pattern (the match below drops anything else it catches).
  const pattern = domain === 'gmail.com' ? '%@g%mail.com' : `%@${escapeLike(domain)}`;
  try {
    const { data, error } = await db
      .from('email_log')
      .select('to_email, created_at')
      .ilike('to_email', pattern)
      .eq('template', NEWSLETTER_CONFIRM_TEMPLATE)
      .in('status', AUTH_EMAIL_COUNTED_STATUSES)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(INBOX_LOOKUP_LIMIT);
    if (error) return null;
    return ((data as Array<{ to_email?: string; created_at?: string }> | null) ?? [])
      .filter((r) => typeof r.to_email === 'string' && typeof r.created_at === 'string' && inboxKey(r.to_email) === key)
      .map((r) => r.created_at as string);
  } catch {
    return null;
  }
};

/**
 * Confirmation emails sent to ANY address since `sinceIso` (the template's own budget, so
 * unauthenticated confirmation mail can't use up the capacity sign-in and recovery mail need);
 * null = log unreadable.
 */
export const countConfirmEmailsSince = async (sinceIso: string): Promise<number | null> => {
  const db = adminOrNull();
  if (!db) return null;
  try {
    const { count, error } = await db
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('template', NEWSLETTER_CONFIRM_TEMPLATE)
      .in('status', AUTH_EMAIL_COUNTED_STATUSES)
      .gte('created_at', sinceIso);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
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

export type SubscribeOutcome = 'new' | 'already_registered';

/**
 * Studio ids a signup can register interest in — the one shared list in
 * services/studioInterests.ts (the retired code_studio / dashboards are gone).
 */
export const WAITLIST_PRODUCTS = STUDIO_INTEREST_IDS;

export interface SubscriberIntent {
  /** Whitelisted product ids the person wants first access to. */
  productInterests?: string[];
  /** Optional free-text "what would you like to see" (capped upstream). */
  feedback?: string;
}

const sanitizeIntent = (intent?: SubscriberIntent): { product_interests?: string[]; feedback?: string } => {
  const out: { product_interests?: string[]; feedback?: string } = {};
  const products = sanitizeStudioInterests(intent?.productInterests);
  if (products.length) out.product_interests = products;
  const feedback = typeof intent?.feedback === 'string' ? intent.feedback.trim().slice(0, 1000) : '';
  if (feedback) out.feedback = feedback;
  return out;
};

/**
 * Upsert a request-access (kind 'access') waitlist row and return what happened. There is no
 * confirm flow for these: an existing row reports 'already_registered' and is left as it was,
 * except that newly picked studios are ADDED to its picks (never replacing or dropping one), and
 * a note is stored only if the row has none. Anyone can type anyone's address, so a stranger can
 * neither wipe someone's picks nor overwrite their note. Idempotent on (lower(email), kind).
 *
 * Newsletter / interest rows (kind 'updates') go through registerInterest() in
 * services/interestStore.ts instead: it owns the double opt-in and the per-recipient throttle.
 */
export const upsertSubscriber = async (
  email: string,
  kind: 'access',
  token: string,
  metadata: Record<string, unknown> = {},
  intent?: SubscriberIntent
): Promise<{ outcome: SubscribeOutcome }> => {
  const db = adminOrNull();
  const normalized = normalizeEmail(email);
  if (!db) return { outcome: 'new' };
  const intentCols = sanitizeIntent(intent);

  // '*' rather than named columns: on a database without product_interests / feedback the lookup
  // still finds the row (and there is then nothing to merge).
  const { data: existing } = await db
    .from('waitlist_signups')
    .select('*')
    .eq('email', normalized)
    .eq('kind', kind)
    .limit(1)
    .maybeSingle();

  const now = new Date().toISOString();
  if (existing) {
    const row = existing as { id: string; product_interests?: unknown; feedback?: unknown };
    const fields: Record<string, unknown> = {};
    if (intentCols.product_interests) {
      const stored = sanitizeStudioInterests(row.product_interests);
      const merged = sanitizeStudioInterests([...stored, ...intentCols.product_interests]);
      if (merged.length !== stored.length) fields.product_interests = merged;
    }
    const hasNote = typeof row.feedback === 'string' && row.feedback.trim() !== '';
    if (intentCols.feedback && !hasNote) fields.feedback = intentCols.feedback;
    if (Object.keys(fields).length) await db.from('waitlist_signups').update(fields).eq('id', row.id);
    // 'access' rows have no confirm step — the email is simply already on the list.
    return { outcome: 'already_registered' };
  }

  await db.from('waitlist_signups').insert({
    email: normalized,
    kind,
    source: typeof metadata.source === 'string' ? metadata.source : null,
    metadata,
    ...intentCols,
    confirmed: false,
    confirm_token: token,
    confirm_sent_at: now
  });
  return { outcome: 'new' };
};

// ── Confirming (the link in newsletter-confirm) ─────────────────────────────────
// Two steps, on purpose. GET /api/newsletter/confirm only LOOKS at the link (inspectConfirmLink)
// and shows a page with a Confirm button: mail-security scanners fetch every link in incoming
// mail, and a plain fetch must never subscribe anyone or undo their unsubscribe. Only the POST
// that button sends (a person's click) runs confirmSubscriber.

/** Studio picks a confirmed subscriber asked for that wait for their next confirm click. */
export const PENDING_INTERESTS_KEY = 'pending_interests';

export type ConfirmOutcome =
  /** This click opted the address in (new, or back after unsubscribing): send the welcome. */
  | 'confirmed'
  /** An active subscriber confirmed new studio picks. */
  | 'updated'
  /** The token holder is already subscribed (a second click, or an older link). */
  | 'already_confirmed';

interface ConfirmRow {
  id: string;
  confirm_token: string | null;
  confirmed: boolean;
  unsubscribed_at: string | null;
  product_interests?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

const isSubscribedRow = (row: { confirmed: boolean; unsubscribed_at?: string | null }) =>
  Boolean(row.confirmed && !row.unsubscribed_at);

const sameToken = (stored: string | null, given: string): boolean => {
  const a = Buffer.from(stored || '');
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * The newsletter row a confirm link points at, once the token proves this server issued it for
 * this address and it hasn't expired. A forged or unknown token never reaches the database.
 */
const loadConfirmTarget = async (
  db: NonNullable<ReturnType<typeof adminOrNull>>,
  email: string,
  token: string
): Promise<{ row: ConfirmRow; matches: boolean } | null> => {
  const issuedAt = confirmTokenIssuedAt(email, token);
  if (issuedAt === null || confirmTokenExpired(issuedAt)) return null;
  const { data, error } = await db
    .from('waitlist_signups')
    .select('id, confirm_token, confirmed, unsubscribed_at, product_interests, metadata')
    .eq('email', email)
    .eq('kind', 'updates')
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as ConfirmRow;
  return { row, matches: sameToken(row.confirm_token, token) };
};

/**
 * What a still-good confirm link would do, so the Confirm page can say it before the click.
 * `subscribed`: the address already gets updates, about `current`, and pressing Confirm adds
 * `adding` (the picks waiting on this click). Otherwise pressing Confirm subscribes it to
 * `adding` (the picks stored on the row). Studio ids only, from the shared list.
 */
export type ConfirmLinkState =
  | { state: 'ready'; subscribed: boolean; current: StudioInterestId[]; adding: StudioInterestId[] }
  | { state: 'already_confirmed' };

/**
 * GET: is this confirm link still good? 'ready' = show the Confirm button, with what it confirms;
 * 'already_confirmed' = nothing left to do; null = invalid or expired. Read-only.
 */
export const inspectConfirmLink = async (email: string, token: string): Promise<ConfirmLinkState | null> => {
  const db = adminOrNull();
  if (!db || !token) return null;
  const target = await loadConfirmTarget(db, normalizeEmail(email), token);
  if (!target) return null;
  const { row } = target;
  if (!target.matches) return isSubscribedRow(row) ? { state: 'already_confirmed' } : null;
  const stored = sanitizeStudioInterests(row.product_interests);
  if (!isSubscribedRow(row)) return { state: 'ready', subscribed: false, current: [], adding: stored };
  // The same picks confirmSubscriber applies on the click.
  const waiting = row.metadata && typeof row.metadata === 'object' ? row.metadata[PENDING_INTERESTS_KEY] : undefined;
  const adding = sanitizeStudioInterests(waiting).filter((id) => !stored.includes(id));
  return { state: 'ready', subscribed: true, current: stored, adding };
};

/**
 * POST (the Confirm button): flip the row to confirmed, apply studio picks waiting on this click,
 * and lift an earlier unsubscribe. The address leaves the MARKETING suppression list ('all', i.e.
 * bounces and complaints, is never lifted here): a person just pressed Confirm on a link only
 * their inbox received. Single-use: the update only lands while the row still holds this token.
 * null = invalid, expired, or superseded.
 */
export const confirmSubscriber = async (email: string, token: string): Promise<ConfirmOutcome | null> => {
  const db = adminOrNull();
  if (!db || !token) return null;
  const normalized = normalizeEmail(email);
  const target = await loadConfirmTarget(db, normalized, token);
  if (!target) return null;
  const { row, matches } = target;
  const wasSubscribed = isSubscribedRow(row);
  if (!matches) return wasSubscribed ? 'already_confirmed' : null;

  const fields: Record<string, unknown> = { confirmed: true, confirm_token: null, unsubscribed_at: null };
  if (!wasSubscribed) fields.confirmed_at = new Date().toISOString();
  const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : null;
  if (metadata && PENDING_INTERESTS_KEY in metadata) {
    // Picks asked for while already subscribed take effect now. (A row that wasn't subscribed
    // keeps the picks it was registered with; anything else stashed there is dropped.)
    const pending = sanitizeStudioInterests(metadata[PENDING_INTERESTS_KEY]);
    delete metadata[PENDING_INTERESTS_KEY];
    fields.metadata = metadata;
    if (wasSubscribed && pending.length) {
      fields.product_interests = sanitizeStudioInterests([...(row.product_interests ?? []), ...pending]);
    }
  }
  const { data: updated, error } = await db
    .from('waitlist_signups')
    .update(fields)
    .eq('id', row.id)
    .eq('confirm_token', token)
    .select('id');
  if (error) {
    console.warn('[email] confirmSubscriber update failed', error.message);
    return null;
  }
  // Another click used this token a moment ago, and it is confirmed now.
  if (!Array.isArray(updated) || updated.length === 0) return 'already_confirmed';
  try {
    await db.from('email_suppressions').delete().eq('email', normalized).eq('scope', 'marketing');
  } catch (err) {
    console.warn('[email] confirmSubscriber unsuppress error', (err as Error)?.message);
  }
  return wasSubscribed ? 'updated' : 'confirmed';
};

/**
 * Stamp the waitlist row(s) unsubscribed and add the address to the suppression list. The
 * newsletter / interest row also drops what only mattered while subscribed — its studio picks
 * (including any waiting for a confirm click), free-text note and any pending confirm token — so
 * an unsubscribed address keeps no interests. The suppression row stays: it's what stops us
 * emailing the address again.
 */
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
    // Separate statement: on a database without the interest columns, the stamp above still lands.
    await db
      .from('waitlist_signups')
      .update({ product_interests: [], feedback: null, confirm_token: null })
      .eq('email', normalized)
      .eq('kind', 'updates');
    const { data } = await db.from('waitlist_signups').select('id, metadata').eq('email', normalized).eq('kind', 'updates');
    for (const r of (data as Array<{ id: string; metadata: Record<string, unknown> | null }> | null) ?? []) {
      if (!r.metadata || typeof r.metadata !== 'object' || !(PENDING_INTERESTS_KEY in r.metadata)) continue;
      const metadata = { ...r.metadata };
      delete metadata[PENDING_INTERESTS_KEY];
      await db.from('waitlist_signups').update({ metadata }).eq('id', r.id);
    }
  } catch (err) {
    console.warn('[email] markUnsubscribed error', (err as Error)?.message);
  }
};
