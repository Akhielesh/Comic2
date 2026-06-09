// Read-side analytics over the telemetry_events + user_feedback tables. Powers the
// admin "Analytics" panel so the team can actually look at all sessions, failures,
// AI flow and dislikes that the capture pipeline collects.
//
// All reads go through the service role (these tables are write-only-by-service-role
// under RLS). Everything degrades gracefully: if the migration hasn't been applied,
// or storage is disabled, callers get empty results instead of an error.

import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import { logger } from '../lib/logger.js';
import { TtlCache } from '../lib/cache.js';
import { failureSignature } from '../lib/failureSignature.js';

// The overview runs ~9 queries; admin dashboards poll/refresh it repeatedly, so a
// short TTL coalesces those into one round-trip per window per day-range.
const overviewCache = new TtlCache<AnalyticsOverview>(30_000, 64);

const EVENT_COLUMNS = 'id, user_id, session_id, event_type, severity, source, surface, message, metadata, request_id, client_ts, created_at';
const FEEDBACK_COLUMNS = 'id, user_id, session_id, target_type, target_id, vote, category, sentiment, comment, source, surface, metadata, client_ts, created_at';

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const storageReady = () => getSupabaseCapabilityStatus().storagePersistenceEnabled;

const tally = <T extends string>(rows: Array<Record<string, unknown>>, key: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = String(row[key] ?? 'unknown') as T;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

const countIn = async (table: string, since: string, extra?: (q: any) => any): Promise<number> => {
  try {
    let q = getSupabaseAdmin().from(table).select('id', { count: 'exact', head: true }).gte('created_at', since);
    if (extra) q = extra(q);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
};

export interface AnalyticsOverview {
  windowDays: number;
  generatedAt: string;
  storageEnabled: boolean;
  totals: {
    events: number;
    failures: number;
    feedback: number;
    likes: number;
    dislikes: number;
    distinctSessions: number;
    distinctUsers: number;
  };
  eventsBySeverity: Record<string, number>;
  eventsByType: Record<string, number>;
  eventsBySource: Record<string, number>;
  feedbackBySentiment: Record<string, number>;
  feedbackByCategory: Record<string, number>;
  /** Failures grouped by normalized signature — the "same issue happened N times" view. */
  topIssues: Array<{
    signature: string;
    eventType: string;
    source: string;
    count: number;
    sample: string;
    exampleSessionId?: string | null;
  }>;
  recentFailures: Array<Record<string, unknown>>;
  recentDislikes: Array<Record<string, unknown>>;
  /** Aggregated chat quality/latency from chat_turn events. */
  chatPerformance: {
    turns: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    emptyRate: number;
    toolFailureRate: number;
    topModels: Array<{ model: string; count: number }>;
  };
}

const computeAnalyticsOverview = async (windowDays: number): Promise<AnalyticsOverview> => {
  const since = sinceIso(windowDays);
  const base: AnalyticsOverview = {
    windowDays,
    generatedAt: new Date().toISOString(),
    storageEnabled: storageReady(),
    totals: { events: 0, failures: 0, feedback: 0, likes: 0, dislikes: 0, distinctSessions: 0, distinctUsers: 0 },
    eventsBySeverity: {},
    eventsByType: {},
    eventsBySource: {},
    feedbackBySentiment: {},
    feedbackByCategory: {},
    topIssues: [],
    recentFailures: [],
    recentDislikes: [],
    chatPerformance: { turns: 0, avgLatencyMs: 0, p95LatencyMs: 0, emptyRate: 0, toolFailureRate: 0, topModels: [] }
  };
  if (!base.storageEnabled) return base;

  try {
    const admin = getSupabaseAdmin();
    // Cap the rows we pull for in-JS aggregation; counts use exact head queries.
    const AGG_CAP = 5000;
    const [
      totalEvents,
      totalFailures,
      totalFeedback,
      totalLikes,
      totalDislikes,
      eventsRowsRes,
      feedbackRowsRes,
      recentFailuresRes,
      recentDislikesRes,
      chatTurnRowsRes
    ] = await Promise.all([
      countIn('telemetry_events', since),
      countIn('telemetry_events', since, (q) => q.in('severity', ['error', 'critical'])),
      countIn('user_feedback', since),
      countIn('user_feedback', since, (q) => q.eq('vote', 'like')),
      countIn('user_feedback', since, (q) => q.eq('vote', 'dislike')),
      admin.from('telemetry_events').select('severity, event_type, source, session_id, user_id, message').gte('created_at', since).order('created_at', { ascending: false }).limit(AGG_CAP),
      admin.from('user_feedback').select('sentiment, category').gte('created_at', since).limit(AGG_CAP),
      admin.from('telemetry_events').select(EVENT_COLUMNS).in('severity', ['error', 'critical']).gte('created_at', since).order('created_at', { ascending: false }).limit(15),
      admin.from('user_feedback').select(FEEDBACK_COLUMNS).eq('vote', 'dislike').gte('created_at', since).order('created_at', { ascending: false }).limit(15),
      admin.from('telemetry_events').select('metadata').eq('event_type', 'chat_turn').gte('created_at', since).order('created_at', { ascending: false }).limit(AGG_CAP)
    ]);

    const eventRows = (eventsRowsRes.data || []) as Array<Record<string, unknown>>;
    const feedbackRows = (feedbackRowsRes.data || []) as Array<Record<string, unknown>>;
    const chatTurnRows = (chatTurnRowsRes.data || []) as Array<{ metadata?: Record<string, unknown> }>;

    base.totals.events = totalEvents;
    base.totals.failures = totalFailures;
    base.totals.feedback = totalFeedback;
    base.totals.likes = totalLikes;
    base.totals.dislikes = totalDislikes;
    base.totals.distinctSessions = new Set(eventRows.map((r) => r.session_id).filter(Boolean)).size;
    base.totals.distinctUsers = new Set(eventRows.map((r) => r.user_id).filter(Boolean)).size;
    base.eventsBySeverity = tally(eventRows, 'severity');
    base.eventsByType = tally(eventRows, 'event_type');
    base.eventsBySource = tally(eventRows, 'source');
    base.feedbackBySentiment = tally(feedbackRows.filter((r) => r.sentiment), 'sentiment');
    base.feedbackByCategory = tally(feedbackRows.filter((r) => r.category), 'category');

    // "Same issue" aggregation: collapse failures by normalized signature so a
    // recurring error shows as one row with a count, not N scattered lines.
    const issues = new Map<string, AnalyticsOverview['topIssues'][number]>();
    for (const r of eventRows) {
      const severity = String(r.severity);
      if (severity !== 'error' && severity !== 'critical') continue;
      const eventType = String(r.event_type || 'error');
      const source = String(r.source || 'unknown');
      const signature = failureSignature(eventType, source, r.message);
      const existing = issues.get(signature);
      if (existing) {
        existing.count += 1;
        if (!existing.exampleSessionId && r.session_id) existing.exampleSessionId = String(r.session_id);
      } else {
        issues.set(signature, {
          signature,
          eventType,
          source,
          count: 1,
          sample: String(r.message || '').slice(0, 200),
          exampleSessionId: r.session_id ? String(r.session_id) : null
        });
      }
    }
    base.topIssues = Array.from(issues.values()).sort((a, b) => b.count - a.count).slice(0, 15);

    // Chat performance from chat_turn events (compact per-turn metrics).
    if (chatTurnRows.length) {
      const latencies: number[] = [];
      let emptyCount = 0;
      let toolFailedCount = 0;
      const modelTally: Record<string, number> = {};
      for (const row of chatTurnRows) {
        const m = (row.metadata || {}) as Record<string, unknown>;
        const lat = Number(m.latencyMs);
        if (Number.isFinite(lat) && lat >= 0) latencies.push(lat);
        if (m.empty === true) emptyCount += 1;
        if (Number(m.toolsFailed) > 0) toolFailedCount += 1;
        const model = typeof m.model === 'string' && m.model ? m.model : 'unknown';
        modelTally[model] = (modelTally[model] || 0) + 1;
      }
      latencies.sort((a, b) => a - b);
      const turns = chatTurnRows.length;
      const avg = latencies.length ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
      const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
      base.chatPerformance = {
        turns,
        avgLatencyMs: avg,
        p95LatencyMs: p95,
        emptyRate: turns ? emptyCount / turns : 0,
        toolFailureRate: turns ? toolFailedCount / turns : 0,
        topModels: Object.entries(modelTally).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([model, count]) => ({ model, count }))
      };
    }

    base.recentFailures = (recentFailuresRes.data || []) as Array<Record<string, unknown>>;
    base.recentDislikes = (recentDislikesRes.data || []) as Array<Record<string, unknown>>;
    return base;
  } catch (error) {
    logger.warn('analytics_overview_failed', { message: (error as Error)?.message || String(error) });
    return base;
  }
};

// Public, cached entry point. Repeated dashboard refreshes within the TTL share one
// computation; `days` is clamped + part of the key so each range caches separately.
export const getAnalyticsOverview = (daysInput: unknown): Promise<AnalyticsOverview> => {
  const windowDays = clampInt(daysInput, 7, 1, 90);
  return overviewCache.getOrSet(`overview:${windowDays}`, () => computeAnalyticsOverview(windowDays));
};

export interface ListOptions {
  severity?: string;
  source?: string;
  type?: string;
  q?: string;
  limit?: unknown;
  cursor?: unknown;
  days?: unknown;
}

export const listTelemetryEvents = async (opts: ListOptions) => {
  const limit = clampInt(opts.limit, 50, 1, 200);
  const offset = clampInt(opts.cursor, 0, 0, 1_000_000);
  if (!storageReady()) return { items: [], nextCursor: undefined as string | undefined };
  try {
    let query = getSupabaseAdmin()
      .from('telemetry_events')
      .select(EVENT_COLUMNS)
      .gte('created_at', sinceIso(clampInt(opts.days, 30, 1, 90)))
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (opts.severity) query = query.eq('severity', opts.severity);
    if (opts.source) query = query.eq('source', opts.source);
    if (opts.type) query = query.eq('event_type', opts.type);
    if (opts.q) query = query.ilike('message', `%${String(opts.q).replace(/[%_]/g, '')}%`);
    const { data, error } = await query;
    if (error) throw error;
    const items = (data || []) as Array<Record<string, unknown>>;
    return { items, nextCursor: items.length === limit ? String(offset + limit) : undefined };
  } catch (error) {
    logger.warn('analytics_events_failed', { message: (error as Error)?.message || String(error) });
    return { items: [], nextCursor: undefined };
  }
};

export const listFeedback = async (opts: ListOptions & { vote?: string; targetType?: string; sentiment?: string }) => {
  const limit = clampInt(opts.limit, 50, 1, 200);
  const offset = clampInt(opts.cursor, 0, 0, 1_000_000);
  if (!storageReady()) return { items: [], nextCursor: undefined as string | undefined };
  try {
    let query = getSupabaseAdmin()
      .from('user_feedback')
      .select(FEEDBACK_COLUMNS)
      .gte('created_at', sinceIso(clampInt(opts.days, 30, 1, 90)))
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (opts.vote) query = query.eq('vote', opts.vote);
    if (opts.targetType) query = query.eq('target_type', opts.targetType);
    if (opts.sentiment) query = query.eq('sentiment', opts.sentiment);
    const { data, error } = await query;
    if (error) throw error;
    const items = (data || []) as Array<Record<string, unknown>>;
    return { items, nextCursor: items.length === limit ? String(offset + limit) : undefined };
  } catch (error) {
    logger.warn('analytics_feedback_failed', { message: (error as Error)?.message || String(error) });
    return { items: [], nextCursor: undefined };
  }
};

// Reconstruct one visit's flow: every telemetry event + feedback row sharing a
// session id, oldest-first, so an admin can read the sequence of logs/failures.
export const getSessionTimeline = async (sessionId: string) => {
  if (!storageReady() || !sessionId) return { sessionId, events: [], feedback: [] };
  try {
    const admin = getSupabaseAdmin();
    const [eventsRes, feedbackRes] = await Promise.all([
      admin.from('telemetry_events').select(EVENT_COLUMNS).eq('session_id', sessionId).order('created_at', { ascending: true }).limit(500),
      admin.from('user_feedback').select(FEEDBACK_COLUMNS).eq('session_id', sessionId).order('created_at', { ascending: true }).limit(200)
    ]);
    return {
      sessionId,
      events: (eventsRes.data || []) as Array<Record<string, unknown>>,
      feedback: (feedbackRes.data || []) as Array<Record<string, unknown>>
    };
  } catch (error) {
    logger.warn('analytics_session_failed', { message: (error as Error)?.message || String(error) });
    return { sessionId, events: [], feedback: [] };
  }
};

// Per-model typical latency from chat_turn telemetry — powers the speed indicator in
// the model picker so users don't unknowingly pick a slow (often free/queued) model.
// Tool-using turns are excluded (tools dominate latency); only models with a few
// samples are reported. Cached.
const modelSpeedCache = new TtlCache<Record<string, { p50Ms: number; samples: number }>>(120_000, 4);

export const getModelLatency = (daysInput?: unknown): Promise<Record<string, { p50Ms: number; samples: number }>> => {
  const days = clampInt(daysInput, 7, 1, 30);
  return modelSpeedCache.getOrSet(`speed:${days}`, async () => {
    if (!storageReady()) return {};
    try {
      const admin = getSupabaseAdmin();
      const { data, error } = await admin
        .from('telemetry_events')
        .select('metadata')
        .eq('event_type', 'chat_turn')
        .gte('created_at', sinceIso(days))
        .limit(8000);
      if (error || !Array.isArray(data)) return {};
      const byModel = new Map<string, number[]>();
      for (const row of data as Array<{ metadata?: Record<string, unknown> }>) {
        const m = row.metadata || {};
        if (Number(m.toolCount) > 0) continue; // pure model speed only
        const model = typeof m.model === 'string' ? m.model : '';
        const lat = Number(m.latencyMs);
        if (!model || !Number.isFinite(lat) || lat < 0) continue;
        const arr = byModel.get(model) || [];
        arr.push(lat);
        byModel.set(model, arr);
      }
      const out: Record<string, { p50Ms: number; samples: number }> = {};
      for (const [model, lats] of byModel) {
        if (lats.length < 3) continue; // need a few samples to be meaningful
        lats.sort((a, b) => a - b);
        out[model] = { p50Ms: Math.round(lats[Math.floor(lats.length * 0.5)]), samples: lats.length };
      }
      return out;
    } catch {
      return {};
    }
  });
};
