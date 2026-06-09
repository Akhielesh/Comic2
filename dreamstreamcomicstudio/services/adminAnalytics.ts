// Admin-only client for the telemetry/feedback analytics endpoints (/api/admin/analytics/*).
// Mirrors the server shapes in server/services/telemetryAnalytics.ts.

import { get } from './apiClient';

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
  topIssues: Array<{
    signature: string;
    eventType: string;
    source: string;
    count: number;
    sample: string;
    exampleSessionId?: string | null;
  }>;
  recentFailures: TelemetryEventRow[];
  recentDislikes: FeedbackRow[];
  chatPerformance: {
    turns: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    emptyRate: number;
    toolFailureRate: number;
    topModels: Array<{ model: string; count: number }>;
  };
}

export interface TelemetryEventRow {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  event_type: string;
  severity: string;
  source: string;
  surface?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
  request_id?: string | null;
  client_ts?: string | null;
  created_at: string;
}

export interface FeedbackRow {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  target_type: string;
  target_id?: string | null;
  vote?: string | null;
  category?: string | null;
  sentiment?: string | null;
  comment?: string | null;
  source: string;
  surface?: string | null;
  metadata?: Record<string, unknown>;
  client_ts?: string | null;
  created_at: string;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== null) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

export const getAnalyticsOverview = (days = 7): Promise<AnalyticsOverview> =>
  get<AnalyticsOverview>(`/api/admin/analytics/overview${qs({ days })}`);

export const listAnalyticsEvents = (filters: {
  severity?: string; source?: string; type?: string; q?: string; days?: number; limit?: number; cursor?: string;
} = {}): Promise<{ items: TelemetryEventRow[]; nextCursor?: string }> =>
  get(`/api/admin/analytics/events${qs(filters)}`);

export const listAnalyticsFeedback = (filters: {
  vote?: string; targetType?: string; sentiment?: string; days?: number; limit?: number; cursor?: string;
} = {}): Promise<{ items: FeedbackRow[]; nextCursor?: string }> =>
  get(`/api/admin/analytics/feedback${qs(filters)}`);

export const getSessionTimeline = (sessionId: string): Promise<{ sessionId: string; events: TelemetryEventRow[]; feedback: FeedbackRow[] }> =>
  get(`/api/admin/analytics/sessions/${encodeURIComponent(sessionId)}`);
