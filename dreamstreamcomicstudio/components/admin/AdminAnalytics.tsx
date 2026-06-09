import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, AlertTriangle, ThumbsDown, ThumbsUp, Activity, Users, Layers, X } from 'lucide-react';
import {
  getAnalyticsOverview,
  listAnalyticsEvents,
  listAnalyticsFeedback,
  getSessionTimeline,
  type AnalyticsOverview,
  type TelemetryEventRow,
  type FeedbackRow
} from '../../services/adminAnalytics';

const fmt = (iso?: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
};

const sevColor = (s: string) =>
  s === 'critical' ? 'bg-red-200 text-red-900'
    : s === 'error' ? 'bg-red-100 text-red-700'
      : s === 'warn' ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600';

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: number; tone?: string }> = ({ icon, label, value, tone }) => (
  <div className="border-2 border-black rounded-xl bg-white p-3 flex items-center gap-3">
    <div className={`w-9 h-9 rounded-lg border-2 border-black flex items-center justify-center ${tone || 'bg-brand-yellow'}`}>{icon}</div>
    <div>
      <div className="text-xl font-display leading-none tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  </div>
);

const Chips: React.FC<{ title: string; data: Record<string, number> }> = ({ title, data }) => {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} className="text-[11px] font-bold border-2 border-black rounded-full px-2 py-0.5 bg-white">
            {k} <span className="text-slate-500 tabular-nums">{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

type Tab = 'overview' | 'events' | 'feedback';

export const AdminAnalytics: React.FC = () => {
  const [days, setDays] = useState(7);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  const [events, setEvents] = useState<TelemetryEventRow[]>([]);
  const [eventsSeverity, setEventsSeverity] = useState('');
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [feedbackVote, setFeedbackVote] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [session, setSession] = useState<{ id: string; events: TelemetryEventRow[]; feedback: FeedbackRow[] } | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await getAnalyticsOverview(days));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const loadEvents = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await listAnalyticsEvents({ days, severity: eventsSeverity || undefined, limit: 100 });
      setEvents(res.items);
    } catch { /* surfaced via overview error if persistent */ } finally { setListLoading(false); }
  }, [days, eventsSeverity]);

  const loadFeedback = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await listAnalyticsFeedback({ days, vote: feedbackVote || undefined, limit: 100 });
      setFeedback(res.items);
    } catch { /* ignore */ } finally { setListLoading(false); }
  }, [days, feedbackVote]);

  useEffect(() => { if (tab === 'events') void loadEvents(); }, [tab, loadEvents]);
  useEffect(() => { if (tab === 'feedback') void loadFeedback(); }, [tab, loadFeedback]);

  const openSession = async (sessionId?: string | null) => {
    if (!sessionId) return;
    const t = await getSessionTimeline(sessionId);
    setSession({ id: sessionId, events: t.events, feedback: t.feedback });
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {(['overview', 'events', 'feedback'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs font-bold uppercase border-2 border-black rounded-full px-3 py-1 ${tab === t ? 'bg-black text-white' : 'bg-white hover:bg-slate-100'}`}
            >{t}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white">
            <option value={1}>Last 24h</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={() => void loadOverview()} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white hover:bg-slate-100 flex items-center gap-1">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
          </button>
        </div>
      </div>

      {overview && !overview.storageEnabled && (
        <div className="border-2 border-amber-400 bg-amber-50 text-amber-800 rounded-lg px-3 py-2 text-xs font-bold flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Persistence is off — apply server/sql/telemetry_feedback.sql and set SUPABASE_SERVICE_ROLE_KEY. Showing empty data.
        </div>
      )}
      {error && <div className="border-2 border-red-400 bg-red-50 text-red-700 rounded-lg px-3 py-2 text-xs font-bold">{error}</div>}

      {tab === 'overview' && overview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat icon={<Activity className="w-4 h-4" />} label="Events" value={overview.totals.events} />
            <Stat icon={<AlertTriangle className="w-4 h-4" />} label="Failures" value={overview.totals.failures} tone="bg-red-200" />
            <Stat icon={<ThumbsDown className="w-4 h-4" />} label="Dislikes" value={overview.totals.dislikes} tone="bg-red-100" />
            <Stat icon={<ThumbsUp className="w-4 h-4" />} label="Likes" value={overview.totals.likes} tone="bg-green-100" />
            <Stat icon={<Layers className="w-4 h-4" />} label="Sessions" value={overview.totals.distinctSessions} tone="bg-sky-100" />
            <Stat icon={<Users className="w-4 h-4" />} label="Users" value={overview.totals.distinctUsers} tone="bg-violet-100" />
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Chips title="By severity" data={overview.eventsBySeverity} />
            <Chips title="By source" data={overview.eventsBySource} />
            <Chips title="By event type" data={overview.eventsByType} />
            <Chips title="Feedback sentiment" data={overview.feedbackBySentiment} />
            <Chips title="Feedback category" data={overview.feedbackByCategory} />
          </div>

          {overview.chatPerformance && overview.chatPerformance.turns > 0 && (
            <div className="border-2 border-black rounded-xl bg-white p-3">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Chat performance ({overview.chatPerformance.turns.toLocaleString()} turns)</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div><div className="text-lg font-display tabular-nums">{(overview.chatPerformance.avgLatencyMs / 1000).toFixed(1)}s</div><div className="text-[10px] font-bold uppercase text-slate-500">Avg latency</div></div>
                <div><div className="text-lg font-display tabular-nums">{(overview.chatPerformance.p95LatencyMs / 1000).toFixed(1)}s</div><div className="text-[10px] font-bold uppercase text-slate-500">p95 latency</div></div>
                <div><div className={`text-lg font-display tabular-nums ${overview.chatPerformance.emptyRate > 0.05 ? 'text-brand-red' : ''}`}>{(overview.chatPerformance.emptyRate * 100).toFixed(1)}%</div><div className="text-[10px] font-bold uppercase text-slate-500">Empty answers</div></div>
                <div><div className={`text-lg font-display tabular-nums ${overview.chatPerformance.toolFailureRate > 0.1 ? 'text-amber-600' : ''}`}>{(overview.chatPerformance.toolFailureRate * 100).toFixed(1)}%</div><div className="text-[10px] font-bold uppercase text-slate-500">Tool failures</div></div>
              </div>
              {overview.chatPerformance.topModels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {overview.chatPerformance.topModels.map((m) => (
                    <span key={m.model} className="text-[11px] font-bold border-2 border-black rounded-full px-2 py-0.5 bg-white">
                      {m.model} <span className="text-slate-500 tabular-nums">{m.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {overview.topIssues && overview.topIssues.length > 0 && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Top issues (same failure, grouped)</div>
              <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100">
                {overview.topIssues.map((issue) => (
                  <button
                    key={issue.signature}
                    onClick={() => void openSession(issue.exampleSessionId)}
                    disabled={!issue.exampleSessionId}
                    className="w-full text-left p-2.5 hover:bg-slate-50 disabled:hover:bg-white"
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="px-1.5 py-0.5 rounded font-bold bg-red-100 text-red-700 tabular-nums">×{issue.count}</span>
                      <span className="font-bold">{issue.eventType}</span>
                      <span className="text-slate-400">{issue.source}</span>
                    </div>
                    {issue.sample && <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">{issue.sample}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Recent failures</div>
              <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100 max-h-72 overflow-y-auto">
                {overview.recentFailures.length === 0 && <div className="p-3 text-xs text-slate-400">No failures in window.</div>}
                {overview.recentFailures.map((r) => (
                  <button key={r.id} onClick={() => void openSession(r.session_id)} className="w-full text-left p-2.5 hover:bg-slate-50">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={`px-1.5 py-0.5 rounded font-bold ${sevColor(r.severity)}`}>{r.severity}</span>
                      <span className="font-bold">{r.event_type}</span>
                      <span className="text-slate-400">{r.source}</span>
                      <span className="ml-auto text-slate-400 tabular-nums">{fmt(r.created_at)}</span>
                    </div>
                    {r.message && <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">{r.message}</div>}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Recent dislikes</div>
              <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100 max-h-72 overflow-y-auto">
                {overview.recentDislikes.length === 0 && <div className="p-3 text-xs text-slate-400">No dislikes in window.</div>}
                {overview.recentDislikes.map((r) => (
                  <button key={r.id} onClick={() => void openSession(r.session_id)} className="w-full text-left p-2.5 hover:bg-slate-50">
                    <div className="flex items-center gap-2 text-[11px]">
                      <ThumbsDown className="w-3 h-3 text-brand-red" />
                      <span className="font-bold">{r.target_type}</span>
                      {r.sentiment && <span className="text-amber-700">{r.sentiment}</span>}
                      <span className="ml-auto text-slate-400 tabular-nums">{fmt(r.created_at)}</span>
                    </div>
                    {r.comment && <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">“{r.comment}”</div>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'events' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select value={eventsSeverity} onChange={(e) => setEventsSeverity(e.target.value)} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white">
              <option value="">All severities</option>
              {['critical', 'error', 'warn', 'info', 'debug'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {listLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          </div>
          <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100 max-h-[28rem] overflow-y-auto">
            {events.length === 0 && !listLoading && <div className="p-3 text-xs text-slate-400">No events.</div>}
            {events.map((r) => (
              <button key={r.id} onClick={() => void openSession(r.session_id)} className="w-full text-left p-2.5 hover:bg-slate-50">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className={`px-1.5 py-0.5 rounded font-bold ${sevColor(r.severity)}`}>{r.severity}</span>
                  <span className="font-bold">{r.event_type}</span>
                  <span className="text-slate-400">{r.source}{r.surface ? ` · ${r.surface}` : ''}</span>
                  <span className="ml-auto text-slate-400 tabular-nums">{fmt(r.created_at)}</span>
                </div>
                {r.message && <div className="text-[11px] text-slate-600 mt-0.5 line-clamp-2">{r.message}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'feedback' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select value={feedbackVote} onChange={(e) => setFeedbackVote(e.target.value)} className="text-xs font-bold border-2 border-black rounded-md px-2 py-1 bg-white">
              <option value="">All feedback</option>
              <option value="dislike">Dislikes</option>
              <option value="like">Likes</option>
            </select>
            {listLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          </div>
          <div className="border-2 border-black rounded-xl bg-white divide-y-2 divide-slate-100 max-h-[28rem] overflow-y-auto">
            {feedback.length === 0 && !listLoading && <div className="p-3 text-xs text-slate-400">No feedback.</div>}
            {feedback.map((r) => (
              <button key={r.id} onClick={() => void openSession(r.session_id)} className="w-full text-left p-2.5 hover:bg-slate-50">
                <div className="flex items-center gap-2 text-[11px]">
                  {r.vote === 'dislike' ? <ThumbsDown className="w-3 h-3 text-brand-red" /> : r.vote === 'like' ? <ThumbsUp className="w-3 h-3 text-green-600" /> : null}
                  <span className="font-bold">{r.target_type}</span>
                  {r.category && <span className="text-slate-500">{r.category}</span>}
                  {r.sentiment && <span className="text-amber-700">{r.sentiment}</span>}
                  <span className="ml-auto text-slate-400 tabular-nums">{fmt(r.created_at)}</span>
                </div>
                {r.comment && <div className="text-[11px] text-slate-600 mt-0.5">“{r.comment}”</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {session && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setSession(null)}>
          <div className="w-full max-w-2xl bg-white border-4 border-black rounded-2xl shadow-comic max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="bg-black text-white px-4 py-2 flex items-center justify-between">
              <span className="font-display text-sm truncate">Session flow · {session.id}</span>
              <button onClick={() => setSession(null)}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-3 overflow-y-auto space-y-1.5">
              {session.events.length === 0 && session.feedback.length === 0 && <div className="text-xs text-slate-400">No events recorded for this session.</div>}
              {session.events.map((r) => (
                <div key={r.id} className="text-[11px] border-l-2 border-slate-200 pl-2">
                  <span className="text-slate-400 tabular-nums mr-2">{fmt(r.created_at)}</span>
                  <span className={`px-1 rounded font-bold ${sevColor(r.severity)}`}>{r.severity}</span>
                  <span className="font-bold ml-1">{r.event_type}</span>
                  {r.message && <span className="text-slate-600"> — {r.message}</span>}
                  {r.metadata && Object.keys(r.metadata).length > 0 && (
                    <pre className="text-[10px] bg-slate-50 border border-slate-200 rounded p-1 mt-0.5 overflow-x-auto">{JSON.stringify(r.metadata, null, 2).slice(0, 1200)}</pre>
                  )}
                </div>
              ))}
              {session.feedback.map((r) => (
                <div key={r.id} className="text-[11px] border-l-2 border-brand-yellow pl-2">
                  <span className="text-slate-400 tabular-nums mr-2">{fmt(r.created_at)}</span>
                  <span className="font-bold">feedback</span> {r.vote || ''} {r.sentiment || ''} {r.comment ? `— “${r.comment}”` : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
