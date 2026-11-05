// Persists telemetry events + user feedback to Supabase using the service role.
//
// Design rules (mirrors waitlist/storage conventions in this codebase):
// - NEVER throw. Telemetry/feedback is best-effort; a capture failure must never
//   break the user's request. Every path resolves to a small status object.
// - Degrade gracefully. If the service role isn't configured, or the migration
//   (server/sql/telemetry_feedback.sql) hasn't been applied yet, we still emit a
//   structured, timestamped log line so nothing is silently lost — and report
//   persisted:false so the caller/route stays honest.
// - Enrich server-side. The client supplies the payload; the server stamps the
//   request id, ip, user agent and the authoritative server receive time.
// - Bound what anyone can make the free-plan database keep (abuse-ops-3: it is 500 MB and these
//   routes are public). A signed-out client's row is stored only when it is warn / error /
//   critical, with a 1,000-character message and 4,500 bytes of metadata, within an in-memory
//   budget of 300 rows per IPv4 address or IPv6 /64 and 3,000 rows in all per UTC day. A signed-in
//   account may store 5,000 events and 50 feedback rows a UTC day. Server-side 5xx records have a
//   row budget of their own (300 per sender, 3,000 a day) and a size ceiling of their own.
//   Above 150 MB in the two tables (public.telemetry_table_bytes(),
//   server/sql/telemetry_table_bytes_2026_11.sql; the check is skipped while that function is
//   absent) nothing more is stored, except signed-in feedback up to 160 MB and server 5xx records
//   up to 170 MB: past 160 MB only the server writes, so a flood of client rows can neither use up
//   the 5xx records' budget nor close their size gate. Between two size reads (5 minutes apart)
//   the bytes stored since the last read count too. Everything refused is still logged.

import type { FeedbackInput, TelemetryEventInput, TelemetrySeverity } from '../../../apiTypes.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import { logger } from '../lib/logger.js';
import { clientKey } from '../lib/clientKey.js';
import { loggablePath, maskCapabilityUrls } from '../../../shared/capabilityPath.js';

export interface TelemetryContext {
  userId: string | null;
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

const SEVERITIES: ReadonlySet<TelemetrySeverity> = new Set(['debug', 'info', 'warn', 'error', 'critical']);
const VOTES = new Set(['like', 'dislike']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'frustrated']);

const str = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
};

// Coarse ISO-timestamp guard: accept anything Date can parse, normalize to ISO.
const isoTs = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// Keep metadata to a sane object and cap its serialized size so a runaway payload
// (a giant stack or pasted blob) can't bloat the table.
const METADATA_MAX_BYTES = 8_000;
/** Signed-out callers (abuse-ops-3): a stack trace fits, a pasted blob doesn't. */
export const ANON_METADATA_MAX_BYTES = 4_500;
/** Signed-out callers' event message (signed-in: 2,000). */
export const ANON_MESSAGE_MAX_CHARS = 1_000;
/** Strings anywhere in the metadata: a capability URL inside them is masked (S19 — an error thrown
 *  by an inline or extension-injected script reports the PAGE URL, /c/<slug>…, as its filename
 *  and stack frame). Every other value is kept as sent. */
const maskStrings = (_key: string, v: unknown): unknown => (typeof v === 'string' ? maskCapabilityUrls(v) : v);
/** Over the cap: `{truncated, preview}`, with the preview cut until the whole stored object fits. */
const truncatedPreview = (json: string, maxBytes: number): Record<string, unknown> => {
  let keep = Math.min(json.length, maxBytes);
  for (let i = 0; i < 12 && keep > 0; i++) {
    const out = { truncated: true, preview: json.slice(0, keep) };
    const size = Buffer.byteLength(JSON.stringify(out));
    if (size <= maxBytes) return out;
    // Shrink in proportion: escapes and multi-byte characters make bytes ≠ characters.
    keep = Math.max(0, Math.floor((keep * maxBytes) / size) - 16);
  }
  return { truncated: true };
};
const sanitizeMetadata = (value: unknown, maxBytes = METADATA_MAX_BYTES): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const json = JSON.stringify(value, maskStrings);
    if (Buffer.byteLength(json) > maxBytes) return truncatedPreview(json, maxBytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// ── Storage budgets (abuse-ops-3) ───────────────────────────────────────────────
// In memory, per process: they reset when the container restarts or sleeps, which only ever
// happens after 15 quiet minutes — a flood keeps it awake and counting. A brake on what one
// sender can make us store, not an exact meter.
/** Severities a signed-out caller's row is stored for; debug / info are logged only. */
const ANON_STORED_SEVERITIES: ReadonlySet<string> = new Set(['warn', 'error', 'critical']);
export const ANON_ROWS_PER_DAY = 3_000;
export const ANON_ROWS_PER_CLIENT_PER_DAY = 300;
/** A signed-in account's events a UTC day: far above what one person's tabs send, far below a flood. */
export const ACCOUNT_EVENT_ROWS_PER_DAY = 5_000;
/** A signed-in account's feedback rows a UTC day (each one is a deliberate click or comment). */
export const ACCOUNT_FEEDBACK_ROWS_PER_DAY = 50;
/** Server-side 5xx records: per account or sender, and in all. */
export const SERVER_ROWS_PER_SENDER_PER_DAY = 300;
export const SERVER_ROWS_PER_DAY = 3_000;

type Pool = 'anon' | 'account_events' | 'account_feedback' | 'server';
const POOL_LIMITS: Record<Pool, { perSender: number; perDay: number }> = {
  anon: { perSender: ANON_ROWS_PER_CLIENT_PER_DAY, perDay: ANON_ROWS_PER_DAY },
  account_events: { perSender: ACCOUNT_EVENT_ROWS_PER_DAY, perDay: Number.POSITIVE_INFINITY },
  account_feedback: { perSender: ACCOUNT_FEEDBACK_ROWS_PER_DAY, perDay: Number.POSITIVE_INFINITY },
  server: { perSender: SERVER_ROWS_PER_SENDER_PER_DAY, perDay: SERVER_ROWS_PER_DAY }
};

let budgetDay = '';
const poolUse = new Map<Pool, { today: number; bySender: Map<string, number> }>();
const budgetRefusals = new Map<string, number>();

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** The budget key: the account when signed in, else the IPv4 address / IPv6 /64. */
const senderKey = (ctx: TelemetryContext): string => (ctx.userId ? `u:${ctx.userId}` : `ip:${clientKey(ctx.ip) ?? 'unknown'}`);

/** How many of `wanted` rows this sender may still store today in `pool` (and count them as stored). */
const takeBudget = (pool: Pool, sender: string, wanted: number, now = Date.now()): number => {
  const day = utcDay(now);
  if (day !== budgetDay) {
    budgetDay = day;
    poolUse.clear();
    budgetRefusals.clear();
  }
  const limits = POOL_LIMITS[pool];
  let use = poolUse.get(pool);
  if (!use) poolUse.set(pool, (use = { today: 0, bySender: new Map() }));
  const used = use.bySender.get(sender) ?? 0;
  const granted = Math.max(0, Math.min(wanted, limits.perSender - used, limits.perDay - use.today));
  // Only a sender that was granted something is remembered: a signed-out pool holds at most its
  // per-day rows in keys however many /64s a flood rotates through; an account pool holds the
  // accounts that stored something today.
  if (granted > 0) {
    use.bySender.set(sender, used + granted);
    use.today += granted;
  }
  if (granted < wanted) {
    const scope = use.today >= limits.perDay ? 'day' : 'sender';
    const key = `${pool}:${scope}`;
    const n = (budgetRefusals.get(key) ?? 0) + 1;
    budgetRefusals.set(key, n);
    // One line at the 1st, 10th, 100th … refusal of each kind per day — never a log flood.
    if (Number.isInteger(Math.log10(n))) {
      logger.warn('telemetry_budget_exhausted', { pool, scope, refusals: n, rowsToday: use.today, day });
    }
  }
  return granted;
};

// ── Table-size gate (abuse-ops-3) ───────────────────────────────────────────────
export const TELEMETRY_STORAGE_LIMIT_BYTES = 150 * 1024 * 1024;
/** Signed-in feedback still lands up to here: deliberate, 50 a day per account, so 10 MB of room. */
export const FEEDBACK_STORAGE_LIMIT_BYTES = 160 * 1024 * 1024;
/**
 * Server 5xx records (the failure-spike check's input) land up to here. Past the feedback ceiling
 * only they are written: 10 MB of their own, about a day and a half at the pool's worst case
 * (3,000 rows a day of up to ~2.5 KB) and far longer at a normal error rate. The purge (§2.4f,
 * owner O8) is what keeps the gate open for good.
 */
export const SERVER_STORAGE_LIMIT_BYTES = 170 * 1024 * 1024;
const SIZE_CHECK_TTL_MS = 5 * 60_000;
/** The last size read (null bytes: unknown — function absent or the call failed). */
let sizeCheck: { at: number; bytes: number | null } | null = null;
let sizeCheckInFlight: Promise<number | null> | null = null;
/**
 * Bytes stored since the last size read (JSON size of each inserted row): without it, one account
 * at the route limit could add ~100 MB after the table passed the limit before the cached answer
 * flipped. An estimate (indexes and TOAST differ), corrected at every read.
 */
let bytesSinceCheck = 0;
let fullLoggedAt = 0;

const isMissingFunction = (error: { code?: string; message?: string }) =>
  error.code === 'PGRST202' || error.code === '42883' || /could not find the function|does not exist/i.test(error.message || '');

/** The last read of public.telemetry_table_bytes(), at most once per 5 minutes. */
const lastTableBytes = async (): Promise<number | null> => {
  if (sizeCheck && Date.now() - sizeCheck.at < SIZE_CHECK_TTL_MS) return sizeCheck.bytes;
  if (sizeCheckInFlight) return sizeCheckInFlight;
  // Reset when the read is issued, not when it answers: a row stored meanwhile may then be counted
  // twice (in the read and here), never not at all.
  bytesSinceCheck = 0;
  sizeCheckInFlight = (async () => {
    let bytes: number | null = null;
    try {
      const { data, error } = await getSupabaseAdmin().rpc('telemetry_table_bytes');
      if (error) {
        if (!isMissingFunction(error)) logger.warn('telemetry_size_check_failed', { code: error.code, message: error.message });
      } else {
        const n = Number(data);
        bytes = Number.isFinite(n) ? n : null;
      }
    } catch (err) {
      logger.warn('telemetry_size_check_threw', { message: (err as Error)?.message || String(err) });
    }
    sizeCheck = { at: Date.now(), bytes };
    return bytes;
  })().finally(() => {
    sizeCheckInFlight = null;
  });
  return sizeCheckInFlight;
};

/**
 * True when telemetry_events + user_feedback (the last read plus what was stored since) are past
 * `limitBytes`. Fails open: before telemetry_table_bytes() exists (or if the call fails) the
 * check is skipped, as before this gate existed.
 */
const telemetryStorageFull = async (limitBytes = TELEMETRY_STORAGE_LIMIT_BYTES): Promise<boolean> => {
  const last = await lastTableBytes();
  if (last === null) return false;
  const bytes = last + bytesSinceCheck;
  if (bytes <= limitBytes) return false;
  if (sizeCheck && fullLoggedAt !== sizeCheck.at) {
    fullLoggedAt = sizeCheck.at; // once per size read
    logger.warn('telemetry_storage_full', { bytes, lastReadBytes: last, limitBytes });
  }
  return true;
};

const noteStored = (rows: unknown): void => {
  try {
    bytesSinceCheck += Buffer.byteLength(JSON.stringify(rows));
  } catch {
    // unreachable for the plain rows built here; never let accounting break a write
  }
};

/** Test hook: forget the day's budgets and the cached size check. */
export const resetTelemetryLimits = (): void => {
  budgetDay = '';
  poolUse.clear();
  budgetRefusals.clear();
  sizeCheck = null;
  sizeCheckInFlight = null;
  bytesSinceCheck = 0;
  fullLoggedAt = 0;
};

const normalizeEvent = (raw: unknown, ctx: TelemetryContext) => {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Partial<TelemetryEventInput>;
  const anonymous = !ctx.userId;
  const eventType = str(e.eventType, 80) || 'log';
  const severity = typeof e.severity === 'string' && SEVERITIES.has(e.severity as TelemetrySeverity)
    ? e.severity
    : 'info';
  return {
    user_id: ctx.userId,
    session_id: str(e.sessionId, 128),
    event_type: eventType,
    severity,
    source: str(e.source, 40) || 'unknown',
    // The client sends window.location.pathname: a /c/<slug> or /share/<token> page is a read
    // capability, and old cached bundles keep sending it raw — masked here, server-side (S19).
    surface: str(loggablePath(e.surface), 120),
    message: str(typeof e.message === 'string' ? maskCapabilityUrls(e.message) : e.message, anonymous ? ANON_MESSAGE_MAX_CHARS : 2000),
    metadata: sanitizeMetadata(e.metadata, anonymous ? ANON_METADATA_MAX_BYTES : METADATA_MAX_BYTES),
    request_id: str(ctx.requestId, 128),
    ip: str(ctx.ip, 64),
    user_agent: str(ctx.userAgent, 400),
    client_ts: isoTs(e.clientTs)
  };
};

export interface RecordResult {
  accepted: number;
  persisted: boolean;
}

/** Where the rows come from: a client batch, or the server's own 5xx record (its own budget). */
type EventOrigin = 'client' | 'server';

const recordEvents = async (rawEvents: unknown[], ctx: TelemetryContext, origin: EventOrigin): Promise<RecordResult> => {
  const rows = (Array.isArray(rawEvents) ? rawEvents : [])
    .map((raw) => normalizeEvent(raw, ctx))
    .filter((row) => row.event_type);

  if (rows.length === 0) return { accepted: 0, persisted: false };

  // Always emit a compact, timestamped log line — this is the "simple but
  // informative log" backstop that works even before the table exists.
  for (const row of rows) {
    const level = row.severity === 'critical' || row.severity === 'error' ? 'error'
      : row.severity === 'warn' ? 'warn' : 'info';
    logger[level]('telemetry_event', {
      type: row.event_type,
      source: row.source,
      surface: row.surface,
      sessionId: row.session_id,
      userId: row.user_id,
      requestId: row.request_id,
      message: row.message
    });
  }

  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
    return { accepted: rows.length, persisted: false };
  }
  // Not tied to an account: only warn and above. Then the size gate (the server's 5xx records
  // stop at their own, higher ceiling) and the sender's day budget in its pool.
  let toStore = ctx.userId ? rows : rows.filter((row) => ANON_STORED_SEVERITIES.has(row.severity));
  const sizeLimit = origin === 'server' ? SERVER_STORAGE_LIMIT_BYTES : TELEMETRY_STORAGE_LIMIT_BYTES;
  if (toStore.length === 0 || (await telemetryStorageFull(sizeLimit))) return { accepted: rows.length, persisted: false };
  const pool: Pool = origin === 'server' ? 'server' : ctx.userId ? 'account_events' : 'anon';
  toStore = toStore.slice(0, takeBudget(pool, senderKey(ctx), toStore.length));
  if (toStore.length === 0) return { accepted: rows.length, persisted: false };

  try {
    const { error } = await getSupabaseAdmin().from('telemetry_events').insert(toStore);
    if (error) {
      logger.warn('telemetry_persist_failed', { code: (error as { code?: string }).code, message: error.message });
      return { accepted: rows.length, persisted: false };
    }
    noteStored(toStore);
    // Honest: true only when every accepted event was stored.
    return { accepted: rows.length, persisted: toStore.length === rows.length };
  } catch (error) {
    logger.warn('telemetry_persist_threw', { message: (error as Error)?.message || String(error) });
    return { accepted: rows.length, persisted: false };
  }
};

/** A client's batch (routes/telemetry.ts). */
export const recordTelemetryEvents = (rawEvents: unknown[], ctx: TelemetryContext): Promise<RecordResult> =>
  recordEvents(rawEvents, ctx, 'client');

const normalizeFeedback = (raw: unknown, ctx: TelemetryContext) => {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Partial<FeedbackInput>;
  const vote = typeof f.vote === 'string' && VOTES.has(f.vote) ? f.vote : null;
  const sentiment = typeof f.sentiment === 'string' && SENTIMENTS.has(f.sentiment) ? f.sentiment : null;
  return {
    user_id: ctx.userId,
    session_id: str(f.sessionId, 128),
    target_type: str(f.targetType, 40) || 'platform',
    target_id: str(f.targetId, 200),
    vote,
    category: str(f.category, 80),
    sentiment,
    comment: str(f.comment, 4000),
    source: str(f.source, 40) || 'unknown',
    surface: str(loggablePath(f.surface), 120),
    metadata: sanitizeMetadata(f.metadata, ctx.userId ? METADATA_MAX_BYTES : ANON_METADATA_MAX_BYTES),
    request_id: str(ctx.requestId, 128),
    ip: str(ctx.ip, 64),
    user_agent: str(ctx.userAgent, 400),
    client_ts: isoTs(f.clientTs)
  };
};

export interface FeedbackResult {
  persisted: boolean;
}

export const recordFeedback = async (raw: unknown, ctx: TelemetryContext): Promise<FeedbackResult> => {
  const row = normalizeFeedback(raw, ctx);

  // A row with no signal at all (no vote, no comment, no sentiment) isn't useful.
  if (!row.vote && !row.comment && !row.sentiment && !row.category) {
    return { persisted: false };
  }

  logger.info('user_feedback', {
    target: row.target_type,
    targetId: row.target_id,
    vote: row.vote,
    sentiment: row.sentiment,
    category: row.category,
    source: row.source,
    surface: row.surface,
    userId: row.user_id,
    requestId: row.request_id,
    hasComment: Boolean(row.comment)
  });

  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
    return { persisted: false };
  }
  // Signed-out feedback shares the anonymous budget and stops at the size limit. A signed-in
  // person's (deliberate, low volume) has 50 a day and 10 MB of room past the limit.
  const refused = ctx.userId
    ? (await telemetryStorageFull(FEEDBACK_STORAGE_LIMIT_BYTES)) || takeBudget('account_feedback', senderKey(ctx), 1) < 1
    : (await telemetryStorageFull()) || takeBudget('anon', senderKey(ctx), 1) < 1;
  if (refused) return { persisted: false };

  try {
    const { error } = await getSupabaseAdmin().from('user_feedback').insert(row);
    if (error) {
      logger.warn('feedback_persist_failed', { code: (error as { code?: string }).code, message: error.message });
      return { persisted: false };
    }
    noteStored(row);
    return { persisted: true };
  } catch (error) {
    logger.warn('feedback_persist_threw', { message: (error as Error)?.message || String(error) });
    return { persisted: false };
  }
};

// Best-effort capture of a server-side error as a telemetry event. Called from the
// error-handling middleware for 5xx failures so "every failed request" lands in the
// same store as client-reported failures. Fire-and-forget; never blocks the response.
// Its rows draw on the server pool, never a client's, and stop at SERVER_STORAGE_LIMIT_BYTES, past
// what any client row may reach: a flood of client-sent events must not stop the 5xx records the
// failure-spike check reads (verification/checks/telemetryFailureSpike.ts).
export const recordServerError = (fields: {
  requestId?: string;
  path?: string;
  method?: string;
  status: number;
  code?: string;
  message?: string;
  userId?: string | null;
  ip?: string;
}): void => {
  void recordEvents(
    [
      {
        eventType: 'server_error',
        severity: fields.status >= 500 ? 'critical' : 'error',
        source: 'server',
        surface: fields.path,
        message: fields.message,
        metadata: { status: fields.status, code: fields.code, method: fields.method }
      }
    ],
    { userId: fields.userId ?? null, requestId: fields.requestId, ip: fields.ip },
    'server'
  );
};
