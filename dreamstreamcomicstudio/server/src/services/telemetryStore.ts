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

import type { FeedbackInput, TelemetryEventInput, TelemetrySeverity } from '../../../apiTypes.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import { logger } from '../lib/logger.js';

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
const sanitizeMetadata = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    let json = JSON.stringify(value);
    if (json.length > METADATA_MAX_BYTES) {
      json = JSON.stringify({ truncated: true, preview: json.slice(0, METADATA_MAX_BYTES) });
    }
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const normalizeEvent = (raw: unknown, ctx: TelemetryContext) => {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Partial<TelemetryEventInput>;
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
    surface: str(e.surface, 120),
    message: str(e.message, 2000),
    metadata: sanitizeMetadata(e.metadata),
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

  try {
    const { error } = await getSupabaseAdmin().from('telemetry_events').insert(rows);
    if (error) {
      logger.warn('telemetry_persist_failed', { code: (error as { code?: string }).code, message: error.message });
      return { accepted: rows.length, persisted: false };
    }
    return { accepted: rows.length, persisted: true };
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
    surface: str(f.surface, 120),
    metadata: sanitizeMetadata(f.metadata),
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
