// Register interest: which DreamStream studios a visitor wants to hear about.
//
// No parallel system: an interest registration IS the newsletter's double opt-in row
// (waitlist_signups, kind 'updates'), with the picked studios in product_interests. So the
// existing confirm link (/api/newsletter/confirm), the newsletter-confirm email, the unsubscribe
// link and the marketing suppression list all apply unchanged. Two routes write here:
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
//   * a per-inbox throttle on the confirmation email (security finding abuse-ops-11; an address's
//     +tag and Gmail dot spellings count together, emailStore.inboxKey): none within 10 minutes of the last one, at most 3 a day. Before
//     mailing, a request claims the INBOX until its send is logged (claimInbox: in this backend
//     instance, synchronously, so of parallel requests for victim+1@, victim+2@… exactly one
//     wins) and then the row (a conditional update on confirm_sent_at), so parallel requests send
//     one email;
//   * confirmation mail and early-access receipts together may use only CONFIRM_EMAIL_BUDGET_SHARE
//     of the daily and monthly email caps, so they can never crowd out sign-in, recovery and invite
//     mail; and once the mailer's own hard cap is reached, every address gets the same answer
//     (mailerCapReached is checked before anything about the address);
//   * an answer that sent nothing and one that sent the email are held to the same time
//     (holdAnswer: at least ANSWER_FLOOR_MS, or longer while recent sends took longer), so response
//     time doesn't say which it was, also right after this instance starts;
//   * tokens are signed (services/confirmToken.ts): only one this server issued for this address
//     is ever re-sent or accepted, and re-sending one never extends its lifetime;
//   * a missing column/table (server/sql/register_interest_2026_11.sql or email_system.sql not
//     applied on that database) is an InterestUnavailableError, which the route answers with
//     503 {code:'interest_unavailable'} instead of a 500 or a silent no-op.
//
// Service role only: the client never reads the list, a token, or anyone's address.

import { EMAIL_MAX_PER_DAY, EMAIL_MAX_PER_MONTH, EMAIL_REQUEST_TIMEOUT_MS } from '../config.js';
import { getSupabaseAdmin } from './supabase.js';
import { confirmTokenExpired, confirmTokenIssuedAt, confirmTokensAvailable, issueConfirmToken } from './confirmToken.js';
import {
  ACCESS_REQUESTED_TEMPLATE,
  PENDING_INTERESTS_KEY,
  countPublicFormEmailsSince,
  getUsage,
  guardOnRead,
  inboxKey,
  normalizeEmail,
  recentConfirmEmailsToInbox
} from './emailStore.js';
import {
  STUDIO_INTERESTS,
  sanitizeStudioInterests,
  type StudioInterestId
} from '../../../services/studioInterests.js';

const TABLE = 'waitlist_signups';
const DAY_MS = 86_400_000;

/**
 * Confirmation-email limits per recipient inbox (email_log, status queued|sent, template
 * newsletter-confirm; +tags and Gmail dots count as the same inbox, emailStore.inboxKey).
 */
export const INTEREST_CONFIRM_THROTTLE = { minIntervalMs: 10 * 60_000, maxPerDay: 3 } as const;

/**
 * Share of EMAIL_MAX_PER_DAY / EMAIL_MAX_PER_MONTH that public-form mail (newsletter-confirm and
 * access-requested together, emailStore.PUBLIC_FORM_EMAIL_TEMPLATES) may use.
 */
export const CONFIRM_EMAIL_BUDGET_SHARE = 0.5;

/** At most one early-access receipt (access-requested) per inbox in this long. */
export const ACCESS_RECEIPT_INTERVAL_MS = DAY_MS;

// ── Per-inbox claim (this backend instance) ─────────────────────────────────────

/**
 * The email_log row the throttle counts is written only when the mailer starts the send, several
 * round trips after the throttle's read, and each row's own claim covers one exact address. So
 * parallel requests for different aliases of one inbox (victim+1@gmail.com, victim+2@gmail.com…)
 * could each pass the read and each send. This claim is per inbox and is taken without an await
 * after that read (Node runs one request's code at a time), so of N parallel requests on this
 * instance exactly one gets it; the others are throttled ('in_flight'). The holder releases it once
 * its send is over: by then email_log has the send (which the read counts from then on), or the
 * send failed and doesn't count. A claim nobody released (a crash mid-send) lapses after
 * IN_FLIGHT_MAX_MS. Production runs one backend instance (api-proxy: a single container); with
 * several, each instance's claim is its own and parallel aliases could get one email per instance.
 */
const inboxClaims = new Map<string, { at: number; mark: symbol }>();
const IN_FLIGHT_MAX_MS = 2 * 60_000;

const claimInbox = (scope: 'confirm' | 'access', email: string): (() => void) | null => {
  const now = Date.now();
  for (const [key, claim] of inboxClaims) if (now - claim.at >= IN_FLIGHT_MAX_MS) inboxClaims.delete(key);
  const key = `${scope}:${inboxKey(email)}`;
  if (inboxClaims.has(key)) return null;
  const mark = Symbol(key);
  inboxClaims.set(key, { at: now, mark });
  return () => {
    if (inboxClaims.get(key)?.mark === mark) inboxClaims.delete(key);
  };
};

// ── Answer timing ───────────────────────────────────────────────────────────────

/**
 * Every answer to a valid registration, whether it sent the confirmation email or nothing (throttled),
 * is held to the same time: otherwise the response time would say whether the address got a link in
 * the last 10 minutes or three today. That time is ANSWER_FLOOR_MS, above what a send usually takes
 * (a few database round trips and the email worker), or, while recent sends took longer (a slow
 * email worker), the 95th percentile of the sends in the last SENT_SAMPLE_WINDOW_MS (at most
 * SENT_SAMPLES of them), the newest send counting however old it is. With fewer than 20 of those,
 * that is the slowest one, so everyone else waits as long as a slow send took until it is an hour old
 * and a newer send has come. A sending request's own time counts before its answer is held (its answer
 * takes as long as its send did, and the answers after it wait as long), but that doesn't hide its own
 * answer: a throttled request at that moment is held to the target without it. The floor holds from
 * the first request, so an instance that just started (the backend sleeps when idle and restarts on
 * every deploy) answers like a warm one. Durations count up to the mailer's own timeout, plus its
 * round trips. Per instance, in memory. Residual (docs/email/SECURITY.md): a send slower than the
 * target at that moment answers later than a throttled request would: the first send after the
 * instance starts while sends take longer than the floor, one slower than the newest send and every
 * one in the last hour, and, with 20 or more recent sends, where the target leaves out the top 5%,
 * about one send in 20; and its time raises the target for the next answers.
 */
const sentDurations: { ms: number; at: number }[] = [];
const SENT_SAMPLES = 50;
/**
 * A send older than this no longer sets the hold once a newer one has come, so one slow send can't
 * slow every answer for long. The newest always counts: an hour with no sends dropping the hold back
 * to the floor would make the next slow send answer later than a throttled request would.
 */
export const SENT_SAMPLE_WINDOW_MS = 60 * 60_000;
/** The longest a send can take and still go out: the mailer's timeout and its database round trips. */
const MAX_SAMPLE_MS = EMAIL_REQUEST_TIMEOUT_MS + 5_000;
/** The least time any answer takes. */
export const ANSWER_FLOOR_MS = 2_000;
let answerFloorMs = ANSWER_FLOOR_MS;

const dropOldSamples = (now: number): void => {
  while (sentDurations.length > 1 && now - sentDurations[0].at > SENT_SAMPLE_WINDOW_MS) sentDurations.shift();
};

/** Record how long a request that sent the confirmation email took, from `startedAt`. */
export const noteSentDuration = (startedAt: number, now = Date.now()): void => {
  sentDurations.push({ ms: Math.min(MAX_SAMPLE_MS, Math.max(0, now - startedAt)), at: now });
  if (sentDurations.length > SENT_SAMPLES) sentDurations.shift();
  dropOldSamples(now);
};

/** The time every answer is held to now (see above). */
export const answerTargetMs = (now = Date.now()): number => {
  dropOldSamples(now);
  if (!sentDurations.length) return answerFloorMs;
  const sorted = sentDurations.map((s) => s.ms).sort((a, b) => a - b);
  return Math.max(answerFloorMs, sorted[Math.ceil(sorted.length * 0.95) - 1]);
};

/** Wait until this answer, sent or not, has taken answerTargetMs() since `startedAt`. */
export const holdAnswer = async (startedAt: number): Promise<void> => {
  const wait = answerTargetMs() - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
};

/** Tests only: forget the in-memory claims and timings (one test's sends must not throttle the next). */
export const resetInterestGuardsForTests = (opts: { answerFloorMs?: number } = {}): void => {
  inboxClaims.clear();
  sentDurations.length = 0;
  answerFloorMs = opts.answerFloorMs ?? ANSWER_FLOOR_MS;
};

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
 * May we send this address another confirmation email now? Counted per inbox, so aliases of one
 * address (+tags, Gmail dots) can't each get their own allowance. The cooldown runs from the later of
 * the last logged send and the row's own confirm_sent_at (stamped before every send), so a lagging
 * log is no free pass. If email_log can't be read, no confirmation email is sent until it can: the
 * per-inbox limits live only in the log (each alias has its own row), so reading nothing would let
 * every alias send. Only mail that went out (or is going out) counts toward the daily cap: a failed
 * send never locks anyone out. A confirm_sent_at in the future is ignored (sentAtOf). This is the
 * pre-check; the atomic claim in registerInterest is what stops parallel requests.
 */
export const checkConfirmThrottle = async (
  email: string,
  confirmSentAt: string | null,
  now = Date.now()
): Promise<ConfirmThrottle | null> => {
  // One read covers both limits: every send to this inbox (any alias of it) in the last day.
  const sends = await recentConfirmEmailsToInbox(email, iso(now - DAY_MS));
  // Unreadable log: fail closed (the routes answer a throttled request the same way as a sent one).
  if (sends === null) return { code: 'too_many', retryAfterS: Math.ceil(INTEREST_CONFIRM_THROTTLE.minIntervalMs / 1000) };
  const lastDay = sends.length;
  const latest = Math.max(timeOf(sends[0]), sentAtOf(confirmSentAt, now));
  const waitMs = INTEREST_CONFIRM_THROTTLE.minIntervalMs - (now - latest);
  if (Number.isFinite(waitMs) && waitMs > 0) {
    return { code: 'too_soon', retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  if (lastDay >= INTEREST_CONFIRM_THROTTLE.maxPerDay) {
    // The oldest send in the window ages out within a day; tell them "tomorrow", not a precise time.
    return { code: 'too_many', retryAfterS: Math.ceil(DAY_MS / 1000) };
  }
  return null;
};

/**
 * True once public-form mail (confirmations and early-access receipts) has used its share of today's
 * or this month's email cap. A global state (never about one address). An unreadable log doesn't
 * block here: with the log unreadable no confirmation or receipt is sent anyway (checkConfirmThrottle
 * and claimAccessReceipt fail closed on the same log), and the mailer's own hard caps, which count
 * only what the log shows, don't hold then.
 */
export const confirmBudgetExhausted = async (now = Date.now()): Promise<boolean> => {
  const share = (cap: number) => (cap > 0 ? Math.max(1, Math.floor(cap * CONFIRM_EMAIL_BUDGET_SHARE)) : 0);
  const dayMax = share(EMAIL_MAX_PER_DAY);
  const monthMax = share(EMAIL_MAX_PER_MONTH);
  if (!dayMax && !monthMax) return false;
  const d = new Date(now);
  const [day, month] = await Promise.all([
    dayMax ? countPublicFormEmailsSince(iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))) : null,
    monthMax ? countPublicFormEmailsSince(iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))) : null
  ]);
  return (dayMax > 0 && day != null && day >= dayMax) || (monthMax > 0 && month != null && month >= monthMax);
};

/**
 * True when the mailer itself would refuse every send (mailer.ts step 3: EMAIL_MAX_PER_DAY /
 * EMAIL_MAX_PER_MONTH over every template, counted the same way by emailStore.getUsage). Checked
 * before anything about the address, so a capped mailer answers every address the same way instead
 * of failing only the sends (which would tell a throttled address from one that isn't).
 */
export const mailerCapReached = async (): Promise<boolean> => {
  if (!(EMAIL_MAX_PER_DAY > 0) && !(EMAIL_MAX_PER_MONTH > 0)) return false;
  const usage = await getUsage();
  return (EMAIL_MAX_PER_MONTH > 0 && usage.month >= EMAIL_MAX_PER_MONTH) || (EMAIL_MAX_PER_DAY > 0 && usage.day >= EMAIL_MAX_PER_DAY);
};

/**
 * May the early-access receipt (access-requested) go to this address now? Not when public-form mail
 * has used its budget share or the mailer is capped, and at most once per inbox per day (every alias
 * of the address counts, and parallel requests are claimed per inbox like confirmations; an
 * unreadable log skips the receipt, as it holds confirmations). Returns the release to call once the
 * send is over (sent or not), or null: skip the receipt (the request itself is stored and answered
 * the same way either way).
 */
export const claimAccessReceipt = async (email: string, now = Date.now()): Promise<(() => void) | null> => {
  const [budget, capped, recent] = await Promise.all([
    confirmBudgetExhausted(now),
    mailerCapReached(),
    recentConfirmEmailsToInbox(email, iso(now - ACCESS_RECEIPT_INTERVAL_MS), ACCESS_REQUESTED_TEMPLATE)
  ]);
  if (budget || capped || recent === null || recent.length > 0) return null;
  return claimInbox('access', email);
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
  /**
   * This request holds the send slot: email `token` in a confirm link now, then call `sent()` once
   * the email went out, or `release()` if the send failed (either way the inbox claim is let go).
   */
  | { outcome: 'send_confirmation'; token: string; sent: () => void; release: () => Promise<void> }
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

const loadRowById = async (id: string): Promise<InterestRow | null> => {
  const { data, error } = await adminOrUnavailable().from(TABLE).select(ROW_COLUMNS).eq('id', id).limit(1).maybeSingle();
  if (error) raise(error, 'read');
  return (data as InterestRow | null) ?? null;
};

const SAVE_PICKS_ATTEMPTS = 3;

/**
 * Write this request's picks into an existing row without losing a parallel request's. The
 * update only lands while the row still holds exactly what picksUpdate read: the same picks, the
 * same waiting picks (metadata.pending_interests), and the same subscribed state, which decides
 * where new picks go. Only those server-decided values are compared, never the rest of the
 * client-writable metadata, and only while they have the shape the server writes (comparablePicks).
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
    // emailStore.guardOnRead: the subscribed state, the picks and the waiting picks as read. (Picks
    // that aren't comparablePicks, e.g. a NULL element or thousands of entries only the old
    // all-column client insert could plant, aren't compared: whenever this update writes the
    // picks, it writes the cleaned list in their place. Of the metadata, only the waiting picks,
    // the one part picksUpdate decides from: a client can insert any metadata, and a value
    // JavaScript can't hold exactly (a 20-digit number) never compares equal after the round trip,
    // so every guarded update missed and the address got 503 for good. Planted waiting picks are
    // replaced or removed whenever this update writes the metadata.)
    const query = guardOnRead(adminOrUnavailable().from(TABLE).update(fields).eq('id', row.id), row);
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

  // Global, so checked before anything about this address: an exhausted budget, or a mailer at its
  // hard cap, answers every visitor the same way.
  const [budget, capped] = await Promise.all([confirmBudgetExhausted(now), mailerCapReached()]);
  if (budget || capped) return { outcome: 'budget_exhausted' };

  let row = await loadRow(email);

  if (!row) {
    // Throttled even without a row: a recent confirmation to this address from a row since deleted.
    const throttle = await checkConfirmThrottle(email, null, now);
    // The inbox claim (no await between the check above and this): a parallel request for another
    // alias of this inbox is throttled even though its row is new.
    const releaseInbox = throttle ? null : claimInbox('confirm', email);
    const token = releaseInbox ? issueConfirmToken(email, now) : null;
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
      if (!token) return { outcome: 'throttled', reason: throttle?.code ?? 'in_flight' };
      // The unique index made this insert the claim: a parallel request for the same address
      // gets 23505 below and finds confirm_sent_at already stamped.
      return {
        outcome: 'send_confirmation',
        token,
        sent: () => releaseInbox?.(),
        release: async () => {
          releaseInbox?.();
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
    // Nothing was stored with this token: give the inbox back before deciding again below.
    releaseInbox?.();
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
  // The inbox first (no await since the check above), then the row.
  const releaseInbox = claimInbox('confirm', email);
  if (!releaseInbox) return { outcome: 'throttled', reason: 'in_flight' };

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
  let claimed: unknown;
  try {
    const { data, error: claimError } = await db
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
    claimed = data;
  } catch (err) {
    releaseInbox();
    throw err;
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    releaseInbox();
    return { outcome: 'throttled', reason: 'in_flight' };
  }

  const rowId = row.id;
  return {
    outcome: 'send_confirmation',
    token,
    sent: releaseInbox,
    // Put the row back as it was (only if nothing claimed it since), so the failed send doesn't
    // count and the link already in their inbox, if any, still works.
    release: async () => {
      releaseInbox();
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
