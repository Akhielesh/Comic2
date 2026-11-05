// Register interest: which DreamStream studios a visitor wants to hear about.
//
// No parallel system: an interest registration IS the newsletter's double opt-in row
// (waitlist_signups, kind 'updates'), with the picked studios in product_interests. So the
// existing confirm link (/api/newsletter/confirm), the newsletter-confirm email, the one-click
// unsubscribe and the marketing suppression list all apply unchanged. Two routes write here:
// POST /api/interest (routes/interest.ts) and the older POST /api/newsletter/subscribe for
// kind 'updates' (routes/newsletter.ts, kept for open tabs on the previous frontend).
//
// What this module adds on top of the old upsert:
//   * one shared studio list (services/studioInterests.ts), merged, never cleared by a re-submit;
//   * a per-recipient throttle on the confirmation email (security finding abuse-ops-11): none
//     within 10 minutes of the last one, at most 3 a day, counted in email_log;
//   * the confirmation token is reused while it is still valid, so every link already sent works;
//   * an unsubscribed address must confirm again, and nothing about it changes until it does;
//   * a missing column/table (server/sql/register_interest_2026_11.sql or email_system.sql not
//     applied on that database) is an InterestUnavailableError, which the route answers with
//     503 {code:'interest_unavailable'} instead of a 500 or a silent no-op.
//
// Service role only: the client never reads the list, a token, or anyone's address.

import { NEWSLETTER_CONFIRM_TTL_HOURS } from '../config.js';
import { getSupabaseAdmin } from './supabase.js';
import { countRecentConfirmEmails, latestConfirmEmailAt, newConfirmToken, normalizeEmail } from './emailStore.js';
import {
  STUDIO_INTERESTS,
  sanitizeStudioInterests,
  type StudioInterestId
} from '../../../services/studioInterests.js';

const TABLE = 'waitlist_signups';
const DAY_MS = 86_400_000;

/** Confirmation-email limits per recipient (email_log, status queued|sent, template newsletter-confirm). */
export const INTEREST_CONFIRM_THROTTLE = { minIntervalMs: 10 * 60_000, maxPerDay: 3 } as const;

/** The database lacks what registering interest needs; answer 503 interest_unavailable. */
export class InterestUnavailableError extends Error {
  readonly code = 'interest_unavailable';
  constructor(detail: string) {
    super(`Register interest is unavailable: ${detail}`);
    this.name = 'InterestUnavailableError';
  }
}

type DbError = { code?: string; message?: string } | null | undefined;

// Postgres: undefined_table, undefined_column, undefined_function. PostgREST: a relationship,
// function, column or table missing from its schema cache.
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703', '42883', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205']);

/** True when a Supabase/PostgREST error means "that table, column or function doesn't exist". */
export const isMissingSchemaError = (error: DbError): boolean =>
  Boolean(error && error.code && MISSING_SCHEMA_CODES.has(error.code));

const adminOrUnavailable = () => {
  try {
    return getSupabaseAdmin();
  } catch {
    throw new InterestUnavailableError('no service role');
  }
};

/** Throw the right error for a failed query: missing schema → unavailable, anything else → 500. */
const raise = (error: NonNullable<DbError>, what: string): never => {
  if (isMissingSchemaError(error)) throw new InterestUnavailableError(`${what}: ${error.code}`);
  throw new Error(`[interest] ${what} failed: ${error.message || error.code || 'unknown error'}`);
};

interface InterestRow {
  id: string;
  confirmed: boolean;
  confirm_token: string | null;
  confirm_sent_at: string | null;
  unsubscribed_at: string | null;
  product_interests: string[] | null;
}

const ROW_COLUMNS = 'id, confirmed, confirm_token, confirm_sent_at, unsubscribed_at, product_interests';

// ── Per-recipient throttle ──────────────────────────────────────────────────────

export type ConfirmThrottle = { code: 'too_soon' | 'too_many'; retryAfterS: number };

/**
 * May we send this address another confirmation email now? Counts only mail that went out (or
 * is going out): a failed send never locks anyone out. If email_log can't be read, the cooldown
 * falls back to the row's own confirm_sent_at, so a broken log never means "unlimited".
 */
export const checkConfirmThrottle = async (
  email: string,
  confirmSentAt: string | null,
  now = Date.now()
): Promise<ConfirmThrottle | null> => {
  const dayAgo = new Date(now - DAY_MS).toISOString();
  const [latestLogged, lastDay] = await Promise.all([latestConfirmEmailAt(email), countRecentConfirmEmails(email, dayAgo)]);
  const latest = latestLogged === undefined ? confirmSentAt : latestLogged;
  const sinceLast = latest ? now - Date.parse(latest) : Infinity;
  const waitMs = INTEREST_CONFIRM_THROTTLE.minIntervalMs - sinceLast;
  if (Number.isFinite(waitMs) && waitMs > 0) {
    return { code: 'too_soon', retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  if (lastDay != null && lastDay >= INTEREST_CONFIRM_THROTTLE.maxPerDay) {
    // The oldest send in the window ages out within a day; tell them "tomorrow", not a precise time.
    return { code: 'too_many', retryAfterS: Math.ceil(DAY_MS / 1000) };
  }
  return null;
};

// ── Register ────────────────────────────────────────────────────────────────────

export interface RegisterInterestInput {
  email: string;
  /** Picked studios; sanitized here too (the shared list is the only thing ever stored). */
  studios: readonly string[];
  /** Which surface it came from (e.g. 'home-stay-updated'); first registration wins. */
  source?: string | null;
  /** Optional free-text note (the older /subscribe form); capped, replaces an earlier one. */
  feedback?: string | null;
  now?: number;
}

export type RegisterInterestResult =
  /** Already confirmed and subscribed: picks merged, nothing to send. */
  | { outcome: 'confirmed'; studios: StudioInterestId[]; added: StudioInterestId[] }
  /** Picks saved; the caller must email `token` in a confirm link now. */
  | { outcome: 'send_confirmation'; token: string; studios: StudioInterestId[]; added: StudioInterestId[]; firstTime: boolean }
  /** Picks saved; a confirmation went out too recently (or too often) to send another. */
  | { outcome: 'throttled'; throttle: ConfirmThrottle; studios: StudioInterestId[]; added: StudioInterestId[] };

/** Canonical union of the stored picks and the new ones. */
const mergeStudios = (stored: unknown, picked: readonly string[]) => {
  const before = sanitizeStudioInterests(stored);
  const studios = sanitizeStudioInterests([...before, ...picked]);
  const added = studios.filter((id) => !before.includes(id));
  return { studios, added, changed: added.length > 0 || before.length !== (Array.isArray(stored) ? stored.length : 0) };
};

/** A still-valid token can be sent again, so links already in the inbox keep working. */
const reusableToken = (row: InterestRow, now: number): string | null => {
  if (!row.confirm_token || !row.confirm_sent_at) return null;
  if (NEWSLETTER_CONFIRM_TTL_HOURS <= 0) return row.confirm_token;
  const ageMs = now - Date.parse(row.confirm_sent_at);
  // Re-sending restarts the clock, but don't reuse one that is about to lapse anyway.
  return ageMs < NEWSLETTER_CONFIRM_TTL_HOURS * 3_600_000 - 3_600_000 ? row.confirm_token : null;
};

const loadRow = async (email: string): Promise<InterestRow | null> => {
  const db = adminOrUnavailable();
  const { data, error } = await db
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq('email', email)
    .eq('kind', 'updates')
    .limit(1)
    .maybeSingle();
  if (error) raise(error, 'read');
  return (data as InterestRow | null) ?? null;
};

const update = async (id: string, fields: Record<string, unknown>): Promise<void> => {
  const { error } = await adminOrUnavailable().from(TABLE).update(fields).eq('id', id);
  if (error) raise(error, 'update');
};

const cleanFeedback = (feedback: string | null | undefined): string | undefined => {
  const text = typeof feedback === 'string' ? feedback.trim().slice(0, 1000) : '';
  return text || undefined;
};

/**
 * Record (or extend) an interest registration. Idempotent: one row per address, studios merged
 * in canonical order, re-submits never clear picks or duplicate the row. Does NOT send email —
 * the caller sends the confirm link when the outcome says so (then a send failure can be told
 * to the visitor instead of being swallowed).
 */
export const registerInterest = async (input: RegisterInterestInput): Promise<RegisterInterestResult> => {
  const email = normalizeEmail(input.email);
  const now = input.now ?? Date.now();
  const picked = sanitizeStudioInterests(input.studios);
  const feedback = cleanFeedback(input.feedback);
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 200) : null;

  let row = await loadRow(email);

  if (!row) {
    const throttle = await checkConfirmThrottle(email, null, now);
    const token = newConfirmToken();
    const nowIso = new Date(now).toISOString();
    const { error } = await adminOrUnavailable()
      .from(TABLE)
      .insert({
        email,
        kind: 'updates',
        source,
        metadata: source ? { source, via: 'interest' } : { via: 'interest' },
        product_interests: picked,
        ...(feedback ? { feedback } : {}),
        confirmed: false,
        // Throttled (a recent confirmation to this address from a row since deleted): store the
        // picks with no live token; the next allowed request issues one.
        confirm_token: throttle ? null : token,
        confirm_sent_at: throttle ? null : nowIso
      });
    if (!error) {
      return throttle
        ? { outcome: 'throttled', throttle, studios: picked, added: picked }
        : { outcome: 'send_confirmation', token, studios: picked, added: picked, firstTime: true };
    }
    // 23505: a concurrent request created the row first — carry on as an existing row.
    if (error.code !== '23505') raise(error, 'insert');
    row = await loadRow(email);
    if (!row) throw new Error('[interest] row vanished after a unique violation');
  }

  const { studios, added, changed } = mergeStudios(row.product_interests, picked);
  const subscribed = row.confirmed && !row.unsubscribed_at;

  if (subscribed) {
    if (changed || feedback) await update(row.id, { product_interests: studios, ...(feedback ? { feedback } : {}) });
    return { outcome: 'confirmed', studios, added };
  }

  // Pending, or unsubscribed and asking again: either way a confirmation is needed.
  const throttle = await checkConfirmThrottle(email, row.confirm_sent_at, now);
  if (throttle) {
    // Keep the picks (they only take effect once confirmed); leave the token and its clock alone
    // so the link already in their inbox still works.
    if (changed || feedback) await update(row.id, { product_interests: studios, ...(feedback ? { feedback } : {}) });
    return { outcome: 'throttled', throttle, studios, added };
  }

  const token = reusableToken(row, now) ?? newConfirmToken();
  await update(row.id, {
    product_interests: studios,
    ...(feedback ? { feedback } : {}),
    confirm_token: token,
    confirm_sent_at: new Date(now).toISOString(),
    // An unsubscribed row must be confirmed again; unsubscribed_at stays until that click.
    confirmed: false
  });
  return { outcome: 'send_confirmation', token, studios, added, firstTime: false };
};

// ── Admin summary (counts only) ─────────────────────────────────────────────────

export interface InterestSummaryRow {
  id: StudioInterestId;
  label: string;
  /** Confirmed, still-subscribed addresses that picked this studio. */
  confirmed: number;
  /** Picked it but haven't clicked the confirmation link yet. */
  pending: number;
  /** Request-access waitlist entries (kind 'access') that picked it. */
  accessRequests: number;
}

export interface InterestSummary {
  studios: InterestSummaryRow[];
  /** Every interest/newsletter subscriber, whatever they picked. */
  totals: { confirmed: number; pending: number; unsubscribed: number; accessRequests: number };
  /** 'rpc' = waitlist_interest_summary() in SQL; 'scan' = counted here (SQL file not applied yet). */
  source: 'rpc' | 'scan';
  /** True when the scan stopped at its row cap; counts are then lower bounds. */
  truncated: boolean;
  generatedAt: string;
}

type Tally = { confirmed: number; pending: number; unsubscribed: number; accessRequests: number };
const emptyTally = (): Tally => ({ confirmed: 0, pending: 0, unsubscribed: 0, accessRequests: 0 });

const SCAN_PAGE = 1000;
const SCAN_MAX_ROWS = 50_000;

const toSummary = (tallies: Map<string, Tally>, source: 'rpc' | 'scan', truncated: boolean): InterestSummary => ({
  studios: STUDIO_INTERESTS.map(({ id, label }) => {
    const t = tallies.get(id) ?? emptyTally();
    return { id, label, confirmed: t.confirmed, pending: t.pending, accessRequests: t.accessRequests };
  }),
  totals: tallies.get('*') ?? emptyTally(),
  source,
  truncated,
  generatedAt: new Date().toISOString()
});

const viaRpc = async (): Promise<InterestSummary | null> => {
  const { data, error } = await adminOrUnavailable().rpc('waitlist_interest_summary');
  if (error) {
    if (isMissingSchemaError(error)) return null; // function not applied yet → scan instead
    raise(error, 'summary');
  }
  const tallies = new Map<string, Tally>();
  for (const r of (data as Array<Record<string, unknown>>) ?? []) {
    tallies.set(String(r.studio), {
      confirmed: Number(r.confirmed) || 0,
      pending: Number(r.pending) || 0,
      unsubscribed: Number(r.unsubscribed) || 0,
      accessRequests: Number(r.access_requests) || 0
    });
  }
  return toSummary(tallies, 'rpc', false);
};

/** Fallback before the SQL file is applied: page through the (non-PII) columns and count here. */
const viaScan = async (): Promise<InterestSummary> => {
  const db = adminOrUnavailable();
  const tallies = new Map<string, Tally>();
  const bump = (key: string, field: keyof Tally) => {
    const t = tallies.get(key) ?? emptyTally();
    t[field] += 1;
    tallies.set(key, t);
  };
  let truncated = false;
  for (let from = 0; ; from += SCAN_PAGE) {
    if (from >= SCAN_MAX_ROWS) {
      truncated = true;
      break;
    }
    const { data, error } = await db
      .from(TABLE)
      .select('kind, confirmed, unsubscribed_at, product_interests')
      .order('id', { ascending: true })
      .range(from, from + SCAN_PAGE - 1);
    if (error) raise(error, 'summary scan');
    const rows = (data as Array<{ kind: string; confirmed: boolean; unsubscribed_at: string | null; product_interests: unknown }>) ?? [];
    for (const r of rows) {
      const field: keyof Tally =
        r.kind === 'access' ? 'accessRequests' : r.unsubscribed_at ? 'unsubscribed' : r.confirmed ? 'confirmed' : 'pending';
      bump('*', field);
      for (const id of sanitizeStudioInterests(r.product_interests)) bump(id, field);
    }
    if (rows.length < SCAN_PAGE) break;
  }
  return toSummary(tallies, 'scan', truncated);
};

/** Counts per studio (confirmed vs pending) for the admin console. Never returns an address. */
export const getInterestSummary = async (): Promise<InterestSummary> => (await viaRpc()) ?? viaScan();
