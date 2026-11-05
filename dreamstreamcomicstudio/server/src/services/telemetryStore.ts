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
// - Bound what anyone without an account can store (abuse-ops-3: the free-plan database is
//   500 MB and these routes are public). A row not tied to an account — a signed-out client's
//   event or feedback, or a server error from a signed-out request — is stored only when it is
//   warn / error / critical, with a 1,000-character message and 4,500 bytes of metadata, within
//   an in-memory budget of 300 rows per IPv4 address or IPv6 /64 and 3,000 rows in all per UTC
//   day. Above 150 MB in the two tables (public.telemetry_table_bytes(),
//   server/sql/telemetry_table_bytes_2026_11.sql; the check is skipped while that function is
//   absent) only a signed-in person's feedback is still stored. Everything refused is still logged.

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

// ── Anonymous storage budget (abuse-ops-3) ──────────────────────────────────────
// In memory, per process: it resets when the container restarts or sleeps, which only ever
// happens after 15 quiet minutes — a flood keeps it awake and counting. A brake on what an
// unauthenticated sender can make us store, not an exact meter.
/** Severities a signed-out caller's row is stored for; debug / info are logged only. */
const ANON_STORED_SEVERITIES: ReadonlySet<string> = new Set(['warn', 'error', 'critical']);
export const ANON_ROWS_PER_DAY = 3_000;
export const ANON_ROWS_PER_CLIENT_PER_DAY = 300;

let budgetDay = '';
let anonRowsToday = 0;
const anonRowsByClient = new Map<string, number>();
const budgetRefusals = new Map<string, number>();

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** How many of `wanted` rows this sender may still store today (and count them as stored). */
const takeAnonBudget = (ip: string | undefined, wanted: number, now = Date.now()): number => {
  const day = utcDay(now);
  if (day !== budgetDay) {
    budgetDay = day;
    anonRowsToday = 0;
    anonRowsByClient.clear();
    budgetRefusals.clear();
  }
  const key = clientKey(ip) ?? 'unknown';
  const used = anonRowsByClient.get(key) ?? 0;
  const granted = Math.max(0, Math.min(wanted, ANON_ROWS_PER_CLIENT_PER_DAY - used, ANON_ROWS_PER_DAY - anonRowsToday));
  // Only a sender that was granted something is remembered, so the map holds at most
  // ANON_ROWS_PER_DAY keys however many /64s a flood rotates through.
  if (granted > 0) {
    anonRowsByClient.set(key, used + granted);
    anonRowsToday += granted;
  }
  if (granted < wanted) {
    const scope = anonRowsToday >= ANON_ROWS_PER_DAY ? 'day' : 'client';
    const n = (budgetRefusals.get(scope) ?? 0) + 1;
    budgetRefusals.set(scope, n);
    // One line at the 1st, 10th, 100th … refusal of each kind per day — never a log flood.
    if (Number.isInteger(Math.log10(n))) {
      logger.warn('telemetry_anon_budget_exhausted', { scope, refusals: n, rowsToday: anonRowsToday, day });
    }
  }
  return granted;
};

// ── Table-size gate (abuse-ops-3) ───────────────────────────────────────────────
export const TELEMETRY_STORAGE_LIMIT_BYTES = 150 * 1024 * 1024;
const SIZE_CHECK_TTL_MS = 5 * 60_000;
let sizeCheck: { at: number; full: boolean } | null = null;
let sizeCheckInFlight: Promise<boolean> | null = null;

const isMissingFunction = (error: { code?: string; message?: string }) =>
  error.code === 'PGRST202' || error.code === '42883' || /could not find the function|does not exist/i.test(error.message || '');

/**
 * True when telemetry_events + user_feedback are past TELEMETRY_STORAGE_LIMIT_BYTES. Asks
 * public.telemetry_table_bytes() at most once per 5 minutes. Fails open: before that function
 * exists (or if the call fails) the check is skipped, as before this gate existed.
 */
const telemetryStorageFull = async (): Promise<boolean> => {
  if (sizeCheck && Date.now() - sizeCheck.at < SIZE_CHECK_TTL_MS) return sizeCheck.full;
  if (sizeCheckInFlight) return sizeCheckInFlight;
  sizeCheckInFlight = (async () => {
    let full = false;
    try {
      const { data, error } = await getSupabaseAdmin().rpc('telemetry_table_bytes');
      if (error) {
        if (!isMissingFunction(error)) logger.warn('telemetry_size_check_failed', { code: error.code, message: error.message });
      } else {
        const bytes = Number(data);
        full = Number.isFinite(bytes) && bytes > TELEMETRY_STORAGE_LIMIT_BYTES;
        if (full) logger.warn('telemetry_storage_full', { bytes, limitBytes: TELEMETRY_STORAGE_LIMIT_BYTES });
      }
    } catch (err) {
      logger.warn('telemetry_size_check_threw', { message: (err as Error)?.message || String(err) });
    }
    sizeCheck = { at: Date.now(), full };
    return full;
  })().finally(() => {
    sizeCheckInFlight = null;
  });
  return sizeCheckInFlight;
};

/** Test hook: forget the day's budgets and the cached size check. */
export const resetTelemetryLimits = (): void => {
  budgetDay = '';
  anonRowsToday = 0;
  anonRowsByClient.clear();
  budgetRefusals.clear();
  sizeCheck = null;
  sizeCheckInFlight = null;
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

export const recordTelemetryEvents = async (
  rawEvents: unknown[],
  ctx: TelemetryContext
): Promise<RecordResult> => {
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
  // Not tied to an account: only warn and above, within the sender's and the day's budget.
  let toStore = ctx.userId ? rows : rows.filter((row) => ANON_STORED_SEVERITIES.has(row.severity));
  if (toStore.length === 0 || (await telemetryStorageFull())) return { accepted: rows.length, persisted: false };
  if (!ctx.userId) toStore = toStore.slice(0, takeAnonBudget(ctx.ip, toStore.length));
  if (toStore.length === 0) return { accepted: rows.length, persisted: false };

  try {
    const { error } = await getSupabaseAdmin().from('telemetry_events').insert(toStore);
    if (error) {
      logger.warn('telemetry_persist_failed', { code: (error as { code?: string }).code, message: error.message });
      return { accepted: rows.length, persisted: false };
    }
    // Honest: true only when every accepted event was stored.
    return { accepted: rows.length, persisted: toStore.length === rows.length };
  } catch (error) {
    logger.warn('telemetry_persist_threw', { message: (error as Error)?.message || String(error) });
    return { accepted: rows.length, persisted: false };
  }
};

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
  // Signed-out feedback shares the anonymous budget and stops at the size limit; a signed-in
  // person's feedback (low volume, deliberately submitted) is always stored.
  if (!ctx.userId && ((await telemetryStorageFull()) || takeAnonBudget(ctx.ip, 1) < 1)) {
    return { persisted: false };
  }

  try {
    const { error } = await getSupabaseAdmin().from('user_feedback').insert(row);
    if (error) {
      logger.warn('feedback_persist_failed', { code: (error as { code?: string }).code, message: error.message });
      return { persisted: false };
    }
    return { persisted: true };
  } catch (error) {
    logger.warn('feedback_persist_threw', { message: (error as Error)?.message || String(error) });
    return { persisted: false };
  }
};

// Best-effort capture of a server-side error as a telemetry event. Called from the
// error-handling middleware for 5xx failures so "every failed request" lands in the
// same store as client-reported failures. Fire-and-forget; never blocks the response.
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
  void recordTelemetryEvents(
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
    { userId: fields.userId ?? null, requestId: fields.requestId, ip: fields.ip }
  );
};
