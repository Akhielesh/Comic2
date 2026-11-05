// Register interest: which DreamStream studios a visitor wants to hear about.
//
// No parallel system: an interest registration IS the newsletter's double opt-in row
// (waitlist_signups, kind 'updates'), with the picked studios in product_interests. So the
// existing confirm link (/api/newsletter/confirm), the newsletter-confirm email, the one-click
// unsubscribe and the marketing suppression list all apply unchanged. Two routes write here:
// POST /api/interest (routes/interest.ts) and the older POST /api/newsletter/subscribe for
// kind 'updates' (routes/newsletter.ts, kept for open tabs on the previous frontend).
//
// The callers are unauthenticated, and anyone can type anyone's address. So:
//   * nothing a request does depends on, or reveals, what is already stored: every state (new,
//     pending, subscribed, unsubscribed, throttled) gets the same answer from the routes, and
//     whenever the throttle allows it the address gets a confirmation email;
//   * a confirmed subscriber's picks never change without their click: new picks wait in
//     metadata.pending_interests and apply when they press Confirm (emailStore.confirmSubscriber);
//     an existing row's free-text note is never replaced;
//   * picks are written with a conditional update on what was read (savePicks), so parallel
//     requests for one address keep every request's picks, sent or throttled;
//   * a per-recipient throttle on the confirmation email (security finding abuse-ops-11): none
//     within 10 minutes of the last one, at most 3 a day. The send slot is CLAIMED atomically (a
//     conditional update on confirm_sent_at) before mailing, so parallel requests send one email;
//   * confirmation mail as a whole may use only CONFIRM_EMAIL_BUDGET_SHARE of the daily and
//     monthly email caps, so it can never crowd out sign-in, recovery and invite mail;
//   * tokens are signed (services/confirmToken.ts): only one this server issued for this address
//     is ever re-sent or accepted, and re-sending one never extends its lifetime;
//   * a missing column/table (server/sql/register_interest_2026_11.sql or email_system.sql not
//     applied on that database) is an InterestUnavailableError, which the route answers with
//     503 {code:'interest_unavailable'} instead of a 500 or a silent no-op.
//
// Service role only: the client never reads the list, a token, or anyone's address.

import { EMAIL_MAX_PER_DAY, EMAIL_MAX_PER_MONTH } from '../config.js';
import { getSupabaseAdmin } from './supabase.js';
import { confirmTokenExpired, confirmTokenIssuedAt, confirmTokensAvailable, issueConfirmToken } from './confirmToken.js';
import {
  PENDING_INTERESTS_KEY,
  countConfirmEmailsSince,
  countRecentConfirmEmails,
  latestConfirmEmailAt,
  normalizeEmail
} from './emailStore.js';
import {
  STUDIO_INTERESTS,
  sanitizeStudioInterests,
  type StudioInterestId
} from '../../../services/studioInterests.js';

const TABLE = 'waitlist_signups';
const DAY_MS = 86_400_000;

/** Confirmation-email limits per recipient (email_log, status queued|sent, template newsletter-confirm). */
export const INTEREST_CONFIRM_THROTTLE = { minIntervalMs: 10 * 60_000, maxPerDay: 3 } as const;

/** Share of EMAIL_MAX_PER_DAY / EMAIL_MAX_PER_MONTH that newsletter-confirm mail may use. */
export const CONFIRM_EMAIL_BUDGET_SHARE = 0.5;

/** The database lacks what registering interest needs; answer 503 interest_unavailable. */
export class InterestUnavailableError extends Error {
  readonly code = 'interest_unavailable';
  constructor(detail: string) {
    super(`Register interest is unavailable: ${detail}`);
    this.name = 'InterestUnavailableError';
  }
}

/** A transient conflict this request couldn't resolve; answer 503 and let the visitor retry. */
export class InterestRetryError extends Error {
  readonly code = 'try_again';
  constructor(detail: string) {
    super(`Register interest needs a retry: ${detail}`);
    this.name = 'InterestRetryError';
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
  email: string;
  confirmed: boolean;
  confirm_token: string | null;
  confirm_sent_at: string | null;
  unsubscribed_at: string | null;
  product_interests: string[] | null;
  metadata: Record<string, unknown> | null;
}

const ROW_COLUMNS = 'id, email, confirmed, confirm_token, confirm_sent_at, unsubscribed_at, product_interests, metadata';

const iso = (ms: number) => new Date(ms).toISOString();
const timeOf = (value: string | null | undefined): number => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * How far in the future a row's confirm_sent_at may be and still count. The server only ever
 * stamps the current time; a later value came through the old all-column client INSERT grant
 * (before register_interest_2026_11.sql), and trusting it would block every confirmation email
 * to that address for good.
 */
const CLOCK_SKEW_MS = 60_000;

/** The row's confirm_sent_at as a time; -Infinity when missing or planted in the future. */
const sentAtOf = (value: string | null | undefined, now: number): number => {
  const t = timeOf(value);
  return t > now + CLOCK_SKEW_MS ? -Infinity : t;
};

// ── Per-recipient throttle ──────────────────────────────────────────────────────

export type ConfirmThrottle = { code: 'too_soon' | 'too_many'; retryAfterS: number };

/**
 * May we send this address another confirmation email now? The cooldown runs from the later of
 * the last logged send and the row's own confirm_sent_at (stamped before every send), so neither
 * a lagging nor an unreadable log means "unlimited". Only mail that went out (or is going out)
 * counts toward the daily cap: a failed send never locks anyone out. A confirm_sent_at in the
 * future is ignored (sentAtOf). This is the pre-check; the atomic claim in registerInterest is
 * what stops parallel requests.
 */
export const checkConfirmThrottle = async (
  email: string,
  confirmSentAt: string | null,
  now = Date.now()
): Promise<ConfirmThrottle | null> => {
  const dayAgo = iso(now - DAY_MS);
  const [latestLogged, lastDay] = await Promise.all([latestConfirmEmailAt(email), countRecentConfirmEmails(email, dayAgo)]);
  const latest = Math.max(timeOf(latestLogged), sentAtOf(confirmSentAt, now));
  const waitMs = INTEREST_CONFIRM_THROTTLE.minIntervalMs - (now - latest);
  if (Number.isFinite(waitMs) && waitMs > 0) {
    return { code: 'too_soon', retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  if (lastDay != null && lastDay >= INTEREST_CONFIRM_THROTTLE.maxPerDay) {
    // The oldest send in the window ages out within a day; tell them "tomorrow", not a precise time.
    return { code: 'too_many', retryAfterS: Math.ceil(DAY_MS / 1000) };
  }
  return null;
};

/**
 * True once newsletter-confirm mail has used its share of today's or this month's email cap.
 * A global state (never about one address). An unreadable log doesn't block: the mailer's own
 * hard caps still apply to every send.
 */
export const confirmBudgetExhausted = async (now = Date.now()): Promise<boolean> => {
  const share = (cap: number) => (cap > 0 ? Math.max(1, Math.floor(cap * CONFIRM_EMAIL_BUDGET_SHARE)) : 0);
  const dayMax = share(EMAIL_MAX_PER_DAY);
  const monthMax = share(EMAIL_MAX_PER_MONTH);
  if (!dayMax && !monthMax) return false;
  const d = new Date(now);
  const [day, month] = await Promise.all([
    dayMax ? countConfirmEmailsSince(iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) : null,
    monthMax ? countConfirmEmailsSince(iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))) : null
  ]);
  return (dayMax > 0 && day != null && day >= dayMax) || (monthMax > 0 && month != null && month >= monthMax);
};

// ── Register ────────────────────────────────────────────────────────────────────

export interface RegisterInterestInput {
  email: string;
  /** Picked studios; sanitized here too (the shared list is the only thing ever stored). */
  studios: readonly string[];
  /** Which surface it came from (e.g. 'home-stay-updated'); first registration wins. */
  source?: string | null;
  /** Optional free-text note (the older /subscribe form); capped, stored on a NEW row only. */
  feedback?: string | null;
  now?: number;
}

/**
 * What happened. The routes give the visitor the same answer for 'send_confirmation' (once the
 * email went out) and 'throttled': which one it was says something about someone else's address.
 */
export type RegisterInterestResult =
  /** This request holds the send slot: email `token` in a confirm link now, and call `release()` if the send fails. */
  | { outcome: 'send_confirmation'; token: string; release: () => Promise<void> }
  /** Picks saved (savePicks); no email: one went to this address too recently or too often, or a parallel request is sending it. */
  | { outcome: 'throttled'; reason: 'too_soon' | 'too_many' | 'in_flight' }
  /** Confirmation mail has used its share of the email budget for now. Nothing was stored. */
  | { outcome: 'budget_exhausted' };

/** A token from this row worth sending again, so links already in the inbox keep working. */
const reusableToken = (row: InterestRow, email: string, now: number): string | null => {
  if (!row.confirm_token) return null;
  // Only one this server issued for this address (never one written into the row by anyone else).
  const issuedAt = confirmTokenIssuedAt(email, row.confirm_token);
  if (issuedAt === null) return null;
  // Back after unsubscribing: never a link from before it. Unsubscribing clears the token
  // (emailStore.markUnsubscribed), so one that verifies here was issued by the first request
  // since; this comparison also covers the moment between the two statements of that unsubscribe.
  // Re-sending that one keeps the link already in their inbox working.
  if (row.unsubscribed_at && !(issuedAt > timeOf(row.unsubscribed_at))) return null;
  // Its lifetime runs from when it was first issued; don't re-send one about to lapse.
  return confirmTokenExpired(issuedAt, now, 3_600_000) ? null : row.confirm_token;
};

const loadRow = async (email: string): Promise<InterestRow | null> => {
  const { data, error } = await adminOrUnavailable()
    .from(TABLE)
    .select(ROW_COLUMNS)
    .eq('email', email)
    .eq('kind', 'updates')
    .limit(1)
    .maybeSingle();
  if (error) raise(error, 'read');
  return (data as InterestRow | null) ?? null;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The row for this address whatever its case (the unique index is on lower(email); a row a
 * client inserted directly can hold capitals). A row found this way is stored lowercased, so
 * every exact lookup (confirm, unsubscribe) finds it from now on.
 */
const loadRowAnyCase = async (email: string): Promise<InterestRow | null> => {
  const { data, error } = await adminOrUnavailable()
    .from(TABLE)
    .select(ROW_COLUMNS)
    .ilike('email', escapeLike(email))
    .eq('kind', 'updates')
    .limit(10);
  if (error) raise(error, 'read');
  const row = ((data as InterestRow[] | null) ?? []).find((r) => normalizeEmail(r.email) === email) ?? null;
  if (row && row.email !== email) {
    await update(row.id, { email });
    row.email = email;
  }
  return row;
};

const update = async (id: string, fields: Record<string, unknown>): Promise<void> => {
  const { error } = await adminOrUnavailable().from(TABLE).update(fields).eq('id', id);
  if (error) raise(error, 'update');
};

const cleanFeedback = (feedback: string | null | undefined): string | undefined => {
  const text = typeof feedback === 'string' ? feedback.trim().slice(0, 1000) : '';
  return text || undefined;
};

const plainObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

/**
 * The picks part of the update for an existing row. A subscriber's own picks are left alone and
 * the new ones wait for their click; a row nobody has confirmed (yet, or again) just collects them.
 */
const picksUpdate = (row: InterestRow, picked: readonly StudioInterestId[]): Record<string, unknown> => {
  const stored = sanitizeStudioInterests(row.product_interests);
  const metadata = plainObject(row.metadata);
  const fields: Record<string, unknown> = {};
  if (row.confirmed && !row.unsubscribed_at) {
    const waiting = sanitizeStudioInterests(metadata[PENDING_INTERESTS_KEY]);
    const next = sanitizeStudioInterests([...waiting, ...picked.filter((id) => !stored.includes(id))]);
    if (next.length !== waiting.length) fields.metadata = { ...metadata, [PENDING_INTERESTS_KEY]: next };
    return fields;
  }
  const merged = sanitizeStudioInterests([...stored, ...picked]);
  const raw = Array.isArray(row.product_interests) ? row.product_interests.length : 0;
  if (merged.length !== stored.length || raw !== stored.length) fields.product_interests = merged;
  if (PENDING_INTERESTS_KEY in metadata) {
    delete metadata[PENDING_INTERESTS_KEY];
    fields.metadata = metadata;
  }
  return fields;
};

/** A Postgres text[] literal with every element quoted, so any stored value round-trips in a filter. */
const textArrayLiteral = (values: readonly unknown[]): string =>
  `{${values.map((v) => `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(',')}}`;

const loadRowById = async (id: string): Promise<InterestRow | null> => {
  const { data, error } = await adminOrUnavailable().from(TABLE).select(ROW_COLUMNS).eq('id', id).limit(1).maybeSingle();
  if (error) raise(error, 'read');
  return (data as InterestRow | null) ?? null;
};

const SAVE_PICKS_ATTEMPTS = 3;

/**
 * Write this request's picks into an existing row without losing a parallel request's. The
 * update only lands while the row still holds exactly what picksUpdate read: the same picks, the
 * same metadata (waiting picks), and the same subscribed state, which decides where new picks go.
 * (Mutual containment is equality here: both sides are sets of studio ids.) On a miss the row is
 * read again and the merge redone. Runs before the throttle and the send claim, so the picks are
 * kept whether or not this request ends up sending the email. Returns the row as written.
 */
const savePicks = async (initial: InterestRow, picked: readonly StudioInterestId[]): Promise<InterestRow> => {
  let row: InterestRow | null = initial;
  for (let attempt = 0; attempt < SAVE_PICKS_ATTEMPTS; attempt++) {
    if (!row) throw new InterestRetryError('row removed while saving picks');
    const fields = picksUpdate(row, picked);
    if (!Object.keys(fields).length) return row;
    let query = adminOrUnavailable().from(TABLE).update(fields).eq('id', row.id).eq('confirmed', row.confirmed);
    query = row.unsubscribed_at == null ? query.is('unsubscribed_at', null) : query.not('unsubscribed_at', 'is', null);
    if (Array.isArray(row.product_interests)) {
      const picks = textArrayLiteral(row.product_interests);
      query = query.filter('product_interests', 'cs', picks).filter('product_interests', 'cd', picks);
    } else {
      query = query.is('product_interests', null);
    }
    if (row.metadata == null) {
      query = query.is('metadata', null);
    } else {
      const metadata = JSON.stringify(row.metadata);
      query = query.filter('metadata', 'cs', metadata).filter('metadata', 'cd', metadata);
    }
    const { data, error } = await query.select(ROW_COLUMNS);
    if (error) raise(error, 'update');
    const written = Array.isArray(data) ? (data[0] as InterestRow | undefined) : undefined;
    if (written) return written;
    row = await loadRowById(row.id);
  }
  throw new InterestRetryError('picks kept changing under parallel requests');
};

/**
 * Record (or extend) an interest registration and decide whether a confirmation email goes out.
 * Idempotent: one row per address, studios merged in canonical order, re-submits never clear
 * picks or duplicate the row. Does NOT send email: the caller sends the confirm link when the
 * outcome says so, and calls release() if that send fails (so a retry isn't throttled).
 */
export const registerInterest = async (input: RegisterInterestInput): Promise<RegisterInterestResult> => {
  const email = normalizeEmail(input.email);
  const now = input.now ?? Date.now();
  const picked = sanitizeStudioInterests(input.studios);
  const feedback = cleanFeedback(input.feedback);
  const source = typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 200) : null;
  if (!confirmTokensAvailable()) throw new InterestUnavailableError('no signing secret (EMAIL_HMAC_SECRET)');
  const db = adminOrUnavailable();

  // Global, so checked before anything about this address: an exhausted budget answers every
  // visitor the same way.
  if (await confirmBudgetExhausted(now)) return { outcome: 'budget_exhausted' };

  let row = await loadRow(email);

  if (!row) {
    // Throttled even without a row: a recent confirmation to this address from a row since deleted.
    const throttle = await checkConfirmThrottle(email, null, now);
    const token = throttle ? null : issueConfirmToken(email, now);
    const claimedIso = iso(now);
    const { error } = await db.from(TABLE).insert({
      email,
      kind: 'updates',
      source,
      metadata: source ? { source, via: 'interest' } : { via: 'interest' },
      product_interests: picked,
      ...(feedback ? { feedback } : {}),
      confirmed: false,
      // Throttled: store the picks with no live token; the next allowed request issues one.
      confirm_token: token,
      confirm_sent_at: token ? claimedIso : null
    });
    if (!error) {
      if (!token) return { outcome: 'throttled', reason: throttle?.code ?? 'too_soon' };
      // The unique index made this insert the claim: a parallel request for the same address
      // gets 23505 below and finds confirm_sent_at already stamped.
      return {
        outcome: 'send_confirmation',
        token,
        release: async () => {
          try {
            await db
              .from(TABLE)
              .update({ confirm_token: null, confirm_sent_at: null })
              .eq('email', email)
              .eq('kind', 'updates')
              .eq('confirm_token', token);
          } catch (err) {
            console.warn('[interest] release failed', (err as Error)?.message);
          }
        }
      };
    }
    // 23505: a concurrent request (or a row stored with capitals) holds this address — carry on
    // as an existing row.
    if (error.code !== '23505') raise(error, 'insert');
    row = await loadRowAnyCase(email);
    if (!row) throw new InterestRetryError('row not found after a unique violation');
  }

  // The picks first, on their own: kept whether this request sends the email, is throttled, or
  // loses the send claim to a parallel one.
  row = await savePicks(row, picked);
  const throttle = await checkConfirmThrottle(email, row.confirm_sent_at, now);
  // Leave the token and its clock alone so the link already in their inbox works.
  if (throttle) return { outcome: 'throttled', reason: throttle.code };

  // Claim the send slot: the update only lands while no confirmation went out in the last
  // 10 minutes (a confirm_sent_at planted in the future doesn't count), so of N parallel
  // requests exactly one gets a row back and sends.
  const token = reusableToken(row, email, now) ?? issueConfirmToken(email, now);
  const claimedIso = iso(now);
  const cutoffIso = iso(now - INTEREST_CONFIRM_THROTTLE.minIntervalMs);
  const futureIso = iso(now + CLOCK_SKEW_MS);
  const previous = {
    confirm_token: row.confirm_token,
    // Never put a planted future stamp back: it would block this address again.
    confirm_sent_at: Number.isFinite(sentAtOf(row.confirm_sent_at, now)) ? row.confirm_sent_at : null,
    confirmed: row.confirmed
  };
  const { data: claimed, error: claimError } = await db
    .from(TABLE)
    .update({
      confirm_token: token,
      confirm_sent_at: claimedIso,
      // Back after unsubscribing: must confirm again; unsubscribed_at stays until that click.
      ...(row.unsubscribed_at ? { confirmed: false } : {})
    })
    .eq('id', row.id)
    .or(`confirm_sent_at.is.null,confirm_sent_at.lt."${cutoffIso}",confirm_sent_at.gt."${futureIso}"`)
    .select('id');
  if (claimError) raise(claimError, 'claim');
  if (!Array.isArray(claimed) || claimed.length === 0) return { outcome: 'throttled', reason: 'in_flight' };

  const rowId = row.id;
  return {
    outcome: 'send_confirmation',
    token,
    // Put the row back as it was (only if nothing claimed it since), so the failed send doesn't
    // count and the link already in their inbox, if any, still works.
    release: async () => {
      try {
        await db
          .from(TABLE)
          .update(previous)
          .eq('id', rowId)
          .eq('confirm_token', token)
          .eq('confirm_sent_at', claimedIso);
      } catch (err) {
        console.warn('[interest] release failed', (err as Error)?.message);
      }
    }
  };
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
