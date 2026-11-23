import React, { useEffect, useId, useState, useCallback, useRef } from 'react';
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
import { ContactMessages } from './ContactMessages';
import { cn } from '../../lib/utils';
import { Button, IconButton, Select } from '../ds';
import {
  CHIP,
  CHIP_VARIANT,
  FOCUS_RING,
  MUTED,
  OVERLAY,
  OVERLINE,
  SCRIM,
  SECTION_CARD,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE,
  TEXT_XL,
  TONE_TEXT,
  Z,
  type StatusState,
  type StatusTone
} from '../chat/studioDesign';

const ReportScreenshots = React.lazy(() => import('./ReportScreenshots').then(module => ({default: module.ReportScreenshots})));

const fmt = (iso?: string | null) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
};

// One status vocabulary: critical and error are errors, warn needs attention, the rest are quiet.
const sevState = (s: string): StatusState => (s === 'critical' || s === 'error' ? 'error' : s === 'warn' ? 'attention' : 'waiting');
const SevChip: React.FC<{ severity: string }> = ({ severity }) => (
  <span className={cn(STATUS_CHIP, 'shrink-0', STATUS_CHIP_TONE[sevState(severity)])}>{severity}</span>
);

/** A list row that opens the session flow. */
const ROW = cn('w-full p-2.5 text-left transition-colors duration-[var(--ds-motion-fast)] ease-[var(--ds-ease)] hover:bg-[var(--ds-hover)] disabled:hover:bg-transparent', FOCUS_RING, 'focus-visible:outline-offset-[-2px]');
const LIST = cn(SECTION_CARD, 'divide-y divide-[var(--ds-hairline-soft)]');
const ROW_META = 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]';
const ROW_TEXT = cn('mt-0.5 text-[11px] [overflow-wrap:anywhere]', MUTED);
const EMPTY = cn('p-3 text-xs', MUTED);
/** SECTION_ICON_TILE's shape without its ink, so a tone is chosen against the ink, never stacked on it. */
const ICON_TILE = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-well)]';

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: number; tone?: StatusTone }> = ({ icon, label, value, tone }) => (
  <div className={cn(SECTION_CARD, 'flex items-center gap-3 p-3')}>
    <div className={cn(ICON_TILE, tone ? TONE_TEXT[tone] : 'text-[var(--ds-ink)]')}>{icon}</div>
    <div className="min-w-0">
      <div className={cn(TEXT_XL, 'font-semibold tabular-nums')}>{value.toLocaleString()}</div>
      <div className={OVERLINE}>{label}</div>
    </div>
  </div>
);

const Chips: React.FC<{ title: string; data: Record<string, number> }> = ({ title, data }) => {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (entries.length === 0) return null;
  return (
    <div>
      <div className={cn(OVERLINE, 'mb-1')}>{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span key={k} className={cn(CHIP, CHIP_VARIANT.filled)}>
            <span className="min-w-0 truncate">{k}</span> <span className={cn('tabular-nums', MUTED)}>{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

type Tab = 'overview' | 'events' | 'feedback' | 'contact';

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
  const [feedbackCursor, setFeedbackCursor] = useState<string>();
  const [feedbackError, setFeedbackError] = useState(false);
  const feedbackRequest = useRef(0);
  const [listLoading, setListLoading] = useState(false);
  const sessionTitleId = useId();
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

  const loadFeedback = useCallback(async (cursor?: string) => {
    const requestId = ++feedbackRequest.current;
    setListLoading(true);
    setFeedbackError(false);
    if (!cursor) {
      setFeedback([]);
      setFeedbackCursor(undefined);
    }
    try {
      const targetType = feedbackVote === 'bug' || feedbackVote === 'feedback' ? feedbackVote : undefined;
      const res = await listAnalyticsFeedback({ days, targetType, vote: targetType ? undefined : feedbackVote || undefined, limit: 100, cursor });
      if (requestId !== feedbackRequest.current) return;
      setFeedback(existing => cursor ? [...new Map([...existing, ...res.items].map(row => [row.id, row])).values()] : res.items);
      setFeedbackCursor(res.nextCursor);
    } catch {
      if (requestId === feedbackRequest.current) setFeedbackError(true);
    } finally {
      if (requestId === feedbackRequest.current) setListLoading(false);
    }
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
        <div className="flex flex-wrap items-center gap-2">
          {(['overview', 'events', 'feedback', 'contact'] as Tab[]).map((t) => (
            <Button
              key={t}
              size="sm"
              variant="ghost"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={cn('capitalize', tab === t ? 'bg-[var(--ds-active)] text-[var(--ds-ink)]' : MUTED)}
            >{t}</Button>
          ))}
        </div>
        {/* The day range, Refresh and telemetry banners belong to the analytics tabs; Contact has its own Refresh. */}
        {tab !== 'contact' && (
          <div className="flex items-center gap-2">
            <Select size="sm" value={days} onChange={(e) => setDays(Number(e.target.value))} wrapperClassName="w-auto" className="w-auto" aria-label="Date range">
              <option value={1}>Last 24h</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </Select>
            <Button variant="outline" size="sm" onClick={() => { void loadOverview(); if (tab === 'feedback') void loadFeedback(); }}>
              {loading ? <Loader2 className="w-3.5 h-3.5 motion-safe:animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </Button>
          </div>
        )}
      </div>

      {tab !== 'contact' && overview && !overview.storageEnabled && (
        <div className={cn('flex items-center gap-2 rounded-[var(--ds-radius-control)] border px-3 py-2 text-xs font-medium text-[var(--ds-ink)]', STATUS_SURFACE.attention)}>
          <AlertTriangle className={cn('w-4 h-4 shrink-0', STATUS_INK.attention)} aria-hidden /> Persistence is off — apply server/sql/telemetry_feedback.sql and set SUPABASE_SERVICE_ROLE_KEY. Showing empty data.
        </div>
      )}
      {tab !== 'contact' && error && <div className={cn('rounded-[var(--ds-radius-control)] border px-3 py-2 text-xs font-medium [overflow-wrap:anywhere]', STATUS_SURFACE.error, STATUS_INK.error)}>{error}</div>}

      {tab === 'overview' && overview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat icon={<Activity className="w-4 h-4" />} label="Events" value={overview.totals.events} />
            <Stat icon={<AlertTriangle className="w-4 h-4" />} label="Failures" value={overview.totals.failures} tone="danger" />
            <Stat icon={<ThumbsDown className="w-4 h-4" />} label="Dislikes" value={overview.totals.dislikes} tone="danger" />
            <Stat icon={<ThumbsUp className="w-4 h-4" />} label="Likes" value={overview.totals.likes} tone="success" />
            <Stat icon={<Layers className="w-4 h-4" />} label="Sessions" value={overview.totals.distinctSessions} />
            <Stat icon={<Users className="w-4 h-4" />} label="Users" value={overview.totals.distinctUsers} />
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Chips title="By severity" data={overview.eventsBySeverity} />
            <Chips title="By source" data={overview.eventsBySource} />
            <Chips title="By event type" data={overview.eventsByType} />
            <Chips title="Feedback sentiment" data={overview.feedbackBySentiment} />
            <Chips title="Feedback category" data={overview.feedbackByCategory} />
          </div>

          {overview.chatPerformance && overview.chatPerformance.turns > 0 && (
            <div className={cn(SECTION_CARD, 'p-3')}>
              <div className={cn(OVERLINE, 'mb-2')}>Chat performance ({overview.chatPerformance.turns.toLocaleString()} turns)</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div><div className="text-lg font-semibold tabular-nums">{(overview.chatPerformance.avgLatencyMs / 1000).toFixed(1)}s</div><div className={OVERLINE}>Avg latency</div></div>
                <div><div className="text-lg font-semibold tabular-nums">{(overview.chatPerformance.p95LatencyMs / 1000).toFixed(1)}s</div><div className={OVERLINE}>p95 latency</div></div>
                <div><div className={cn('text-lg font-semibold tabular-nums', overview.chatPerformance.emptyRate > 0.05 && TONE_TEXT.danger)}>{(overview.chatPerformance.emptyRate * 100).toFixed(1)}%</div><div className={OVERLINE}>Empty answers</div></div>
                <div><div className={cn('text-lg font-semibold tabular-nums', overview.chatPerformance.toolFailureRate > 0.1 && TONE_TEXT.warning)}>{(overview.chatPerformance.toolFailureRate * 100).toFixed(1)}%</div><div className={OVERLINE}>Tool failures</div></div>
              </div>
              {overview.chatPerformance.topModels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {overview.chatPerformance.topModels.map((m) => (
                    <span key={m.model} className={cn(CHIP, CHIP_VARIANT.filled)}>
                      <span className="min-w-0 truncate">{m.model}</span> <span className={cn('tabular-nums', MUTED)}>{m.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {overview.topIssues && overview.topIssues.length > 0 && (
            <div>
              <div className={cn(OVERLINE, 'mb-1')}>Top issues (same failure, grouped)</div>
              <div className={LIST}>
                {overview.topIssues.map((issue) => (
                  <button
                    key={issue.signature}
                    onClick={() => void openSession(issue.exampleSessionId)}
                    disabled={!issue.exampleSessionId}
                    className={ROW}
                  >
                    <div className={ROW_META}>
                      <span className={cn(STATUS_CHIP, 'tabular-nums', STATUS_CHIP_TONE.error)}>×{issue.count}</span>
                      <span className="font-semibold">{issue.eventType}</span>
                      <span className={MUTED}>{issue.source}</span>
                    </div>
                    {issue.sample && <div className={cn(ROW_TEXT, 'line-clamp-2')}>{issue.sample}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-4">
            <div>
              <div className={cn(OVERLINE, 'mb-1')}>Recent failures</div>
              <div className={cn(LIST, 'max-h-72 overflow-y-auto')}>
                {overview.recentFailures.length === 0 && <div className={EMPTY}>No failures in window.</div>}
                {overview.recentFailures.map((r) => (
                  <button key={r.id} onClick={() => void openSession(r.session_id)} className={ROW}>
                    <div className={ROW_META}>
                      <SevChip severity={r.severity} />
                      <span className="font-semibold">{r.event_type}</span>
                      <span className={MUTED}>{r.source}</span>
                      <span className={cn('ml-auto tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                    </div>
                    {r.message && <div className={cn(ROW_TEXT, 'line-clamp-2')}>{r.message}</div>}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className={cn(OVERLINE, 'mb-1')}>Recent dislikes</div>
              <div className={cn(LIST, 'max-h-72 overflow-y-auto')}>
                {overview.recentDislikes.length === 0 && <div className={EMPTY}>No dislikes in window.</div>}
                {overview.recentDislikes.map((r) => (
                  <button key={r.id} onClick={() => void openSession(r.session_id)} className={ROW}>
                    <div className={ROW_META}>
                      <ThumbsDown className={cn('w-3 h-3', TONE_TEXT.danger)} />
                      <span className="font-semibold">{r.target_type}</span>
                      {r.sentiment && <span className={TONE_TEXT.warning}>{r.sentiment}</span>}
                      <span className={cn('ml-auto tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                    </div>
                    {r.comment && <div className={cn(ROW_TEXT, 'line-clamp-2')}>“{r.comment}”</div>}
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
            <Select size="sm" value={eventsSeverity} onChange={(e) => setEventsSeverity(e.target.value)} wrapperClassName="w-auto" className="w-auto" aria-label="Severity">
              <option value="">All severities</option>
              {['critical', 'error', 'warn', 'info', 'debug'].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            {listLoading && <Loader2 className={cn('w-4 h-4 motion-safe:animate-spin', MUTED)} />}
          </div>
          <div className={cn(LIST, 'max-h-[28rem] overflow-y-auto')}>
            {events.length === 0 && !listLoading && <div className={EMPTY}>No events.</div>}
            {events.map((r) => (
              <button key={r.id} onClick={() => void openSession(r.session_id)} className={ROW}>
                <div className={ROW_META}>
                  <SevChip severity={r.severity} />
                  <span className="font-semibold">{r.event_type}</span>
                  <span className={MUTED}>{r.source}{r.surface ? ` · ${r.surface}` : ''}</span>
                  <span className={cn('ml-auto tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                </div>
                {r.message && <div className={cn(ROW_TEXT, 'line-clamp-2')}>{r.message}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'contact' && <ContactMessages />}

      {tab === 'feedback' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Select size="sm" value={feedbackVote} onChange={(e) => setFeedbackVote(e.target.value)} wrapperClassName="w-auto" className="w-auto" aria-label="Feedback">
              <option value="">All feedback</option>
              <option value="bug">Bug reports</option>
              <option value="feedback">General reports</option>
              <option value="dislike">Dislikes</option>
              <option value="like">Likes</option>
            </Select>
            {listLoading && <Loader2 className={cn('w-4 h-4 motion-safe:animate-spin', MUTED)} />}
          </div>
          <div className={cn(LIST, 'max-h-[28rem] overflow-y-auto')}>
            {feedback.length === 0 && !listLoading && !feedbackError && <div className={EMPTY}>No feedback.</div>}
            {feedbackError && <p role="alert" className={EMPTY}>Reports could not be loaded. Refresh to try again.</p>}
            {feedback.map((r) => (
              <div key={r.id} className={ROW}>
                <div className={ROW_META}>
                  {r.vote === 'dislike' ? <ThumbsDown className={cn('w-3 h-3', TONE_TEXT.danger)} /> : r.vote === 'like' ? <ThumbsUp className={cn('w-3 h-3', TONE_TEXT.success)} /> : null}
                  <span className="font-semibold">{r.target_type}</span>
                  {r.category && <span className={MUTED}>{r.category}</span>}
                  {r.sentiment && <span className={TONE_TEXT.warning}>{r.sentiment}</span>}
                  <span className={cn('ml-auto tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                </div>
                {r.comment && <div className={ROW_TEXT}>“{r.comment}”</div>}
                {(r.target_type==='feedback' || r.target_type==='bug') && <p className={MUTED}>Report {r.id}{r.surface?' · '+r.surface:''}</p>}
                {(r.target_type==='feedback' || r.target_type==='bug') && Number(r.metadata?.attachmentCount)>0 &&
                  <React.Suspense fallback={<span className={MUTED}>Loading attachment controls…</span>}>
                    <ReportScreenshots id={r.id} count={Math.min(10,Number(r.metadata?.attachmentCount))} />
                  </React.Suspense>}
                {r.session_id && <Button size="sm" variant="ghost" onClick={()=>void openSession(r.session_id)}>Open session</Button>}
              </div>
            ))}
          </div>
          {feedbackCursor && <Button size="sm" variant="outline" disabled={listLoading}
            onClick={() => void loadFeedback(feedbackCursor)}>Load more feedback</Button>}
        </div>
      )}

      {session && (
        <div className={cn('fixed inset-0 flex items-center justify-center p-4', Z.dialog, SCRIM)} onClick={() => setSession(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby={sessionTitleId} className={cn(OVERLAY, 'flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden')} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-2 border-b border-[var(--ds-hairline)] py-2 pl-4 pr-2">
              <h3 id={sessionTitleId} className="m-0 min-w-0 truncate text-sm font-semibold">Session flow · {session.id}</h3>
              <IconButton label="Close" onClick={() => setSession(null)} className={MUTED}><X className="w-5 h-5" /></IconButton>
            </div>
            <div className="p-3 overflow-y-auto space-y-1.5">
              {session.events.length === 0 && session.feedback.length === 0 && <div className={cn('text-xs', MUTED)}>No events recorded for this session.</div>}
              {session.events.map((r) => (
                <div key={r.id} className="border-l-2 border-[var(--ds-hairline)] pl-2 text-[11px] [overflow-wrap:anywhere]">
                  <span className={cn('mr-2 tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                  <SevChip severity={r.severity} />
                  <span className="ml-1 font-semibold">{r.event_type}</span>
                  {r.message && <span className={MUTED}> — {r.message}</span>}
                  {r.metadata && Object.keys(r.metadata).length > 0 && (
                    <pre className="mt-0.5 overflow-x-auto rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-well)] p-1 text-[11px]">{JSON.stringify(r.metadata, null, 2).slice(0, 1200)}</pre>
                  )}
                </div>
              ))}
              {session.feedback.map((r) => (
                <div key={r.id} className="border-l-2 border-[var(--ds-ink)] pl-2 text-[11px] [overflow-wrap:anywhere]">
                  <span className={cn('mr-2 tabular-nums', MUTED)}>{fmt(r.created_at)}</span>
                  <span className="font-semibold">feedback</span> {r.vote || ''} {r.sentiment || ''} {r.comment ? `— “${r.comment}”` : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
