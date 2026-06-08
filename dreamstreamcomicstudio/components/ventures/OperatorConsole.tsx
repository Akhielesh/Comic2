// Operator Console — the 24/7 Autopilot cockpit (Epic A8). Watch ventures, draft new ones from
// an idea, approve the roadmap + checkpoints, see budget/spend, pause/resume, and read the live
// activity stream (polled; real-time WS is F4). Self-contained; talks to /api/ventures via
// services/venturesApi. Reachable at ?view=ventures (flag-gated + admin-only on the server until GA).

import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../../services/venturesApi';
import type { Venture, VentureDetail, Goal, VentureEvent } from '../../services/venturesApi';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-neutral-700 text-neutral-200',
  roadmap_pending: 'bg-amber-500/20 text-amber-300 border border-amber-500/40',
  active: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40',
  paused: 'bg-orange-500/20 text-orange-300 border border-orange-500/40',
  archived: 'bg-neutral-800 text-neutral-400'
};

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-neutral-400',
  warn: 'text-amber-300',
  error: 'text-rose-400'
};

const Badge: React.FC<{ status: string }> = ({ status }) => (
  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || 'bg-neutral-700 text-neutral-200'}`}>
    {status.replace(/_/g, ' ')}
  </span>
);

const num = (n: number | null | undefined) => (typeof n === 'number' ? n : 0);

const BudgetMeter: React.FC<{ detail: VentureDetail }> = ({ detail }) => {
  if (!detail.budget) return null;
  const { budget, spend } = detail.budget;
  const cap = num(budget.usdTotal);
  const pct = cap > 0 ? Math.min(100, Math.round((num(spend.usdTotal) / cap) * 100)) : 0;
  const tone =
    detail.budgetAlert === 'exceeded' ? 'bg-rose-500' : detail.budgetAlert === 'warn' ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-neutral-400">
        <span>Spend</span>
        <span>
          ${num(spend.usdTotal).toFixed(2)}{cap > 0 ? ` / $${cap.toFixed(2)}` : ''} total
          {' · '}${num(spend.usdToday).toFixed(2)}{num(budget.usdPerDay) ? ` / $${num(budget.usdPerDay).toFixed(2)}` : ''} today
        </span>
      </div>
      {cap > 0 && (
        <div className="h-2 w-full rounded-full bg-neutral-800 overflow-hidden">
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
};

export const OperatorConsole: React.FC<{ isAdmin?: boolean; onBack?: () => void }> = ({ onBack }) => {
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VentureDetail | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [events, setEvents] = useState<VentureEvent[]>([]);
  const [idea, setIdea] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const handleErr = (e: unknown) => {
    const err = e as { code?: string; message?: string };
    if (err?.code === 'VENTURES_DISABLED' || /not enabled/i.test(err?.message || '')) {
      setDisabled(true);
      return;
    }
    setError(err?.message || String(e));
  };

  const loadVentures = useCallback(async () => {
    try {
      setVentures(await api.listVentures());
      setError(null);
    } catch (e) {
      handleErr(e);
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const [d, g, ev] = await Promise.all([api.getVenture(id), api.listGoals(id), api.listEvents(id, 60)]);
      setDetail(d);
      setGoals(g);
      setEvents(ev);
      setError(null);
    } catch (e) {
      handleErr(e);
    }
  }, []);

  useEffect(() => {
    void loadVentures();
  }, [loadVentures]);

  // Poll the selected venture (live-ish; real-time WS is F4).
  useEffect(() => {
    if (!selectedId) return;
    void refreshDetail(selectedId);
    const t = setInterval(() => void refreshDetail(selectedId), 5000);
    return () => clearInterval(t);
  }, [selectedId, refreshDetail]);

  const draft = async () => {
    if (!idea.trim()) return;
    setBusy('draft');
    try {
      const { id } = await api.createIntake(idea.trim());
      setIdea('');
      await loadVentures();
      setSelectedId(id);
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(null);
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      if (selectedId) await refreshDetail(selectedId);
      await loadVentures();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (disabled) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-200 flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold">Autopilot isn't enabled yet</h1>
          <p className="text-neutral-400 text-sm">
            The autonomous ventures layer is built but turned off (<code>VENTURES_ENABLED=false</code>). An admin can
            enable it once a model key + worker are configured. See <code>docs/studio/autopilot</code>.
          </p>
          {onBack && (
            <button onClick={onBack} className="px-4 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm">
              Back
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex">
      {/* Left: venture list + intake */}
      <aside className="w-80 border-r border-neutral-800 flex flex-col">
        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
          <h1 className="font-semibold">Autopilot</h1>
          {onBack && (
            <button onClick={onBack} className="text-xs text-neutral-400 hover:text-neutral-200">
              ← Back
            </button>
          )}
        </div>
        <div className="p-4 border-b border-neutral-800 space-y-2">
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe a product idea to build…"
            className="w-full h-20 text-sm bg-neutral-900 border border-neutral-800 rounded p-2 resize-none focus:outline-none focus:border-violet-500"
          />
          <button
            onClick={draft}
            disabled={!idea.trim() || busy === 'draft'}
            className="w-full py-2 rounded bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium"
          >
            {busy === 'draft' ? 'Drafting roadmap…' : 'Draft a venture'}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {ventures.length === 0 && <p className="p-4 text-sm text-neutral-500">No ventures yet.</p>}
          {ventures.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedId(v.id)}
              className={`w-full text-left px-4 py-3 border-b border-neutral-900 hover:bg-neutral-900 ${selectedId === v.id ? 'bg-neutral-900' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{v.name}</span>
                <Badge status={v.status} />
              </div>
              {v.summary && <p className="text-xs text-neutral-500 mt-1 line-clamp-2">{v.summary}</p>}
            </button>
          ))}
        </div>
      </aside>

      {/* Right: detail */}
      <main className="flex-1 overflow-y-auto">
        {error && <div className="m-4 p-3 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm">{error}</div>}
        {!detail && <div className="p-8 text-neutral-500">Select a venture, or draft one from an idea.</div>}
        {detail && (
          <div className="p-6 space-y-6 max-w-4xl">
            <header className="space-y-2">
              <div className="flex items-center gap-3">
                <h2 className="text-2xl font-semibold">{detail.venture.name}</h2>
                <Badge status={detail.venture.status} />
                {detail.venture.pauseReason && (
                  <span className="text-xs text-orange-300">paused: {detail.venture.pauseReason}</span>
                )}
              </div>
              {detail.venture.summary && <p className="text-neutral-400 text-sm">{detail.venture.summary}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {detail.venture.status === 'roadmap_pending' && (
                  <button
                    onClick={() => act('approve', () => api.approveRoadmap(detail.venture.id))}
                    disabled={busy === 'approve'}
                    className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium"
                  >
                    {busy === 'approve' ? 'Activating…' : 'Approve roadmap & activate'}
                  </button>
                )}
                {detail.venture.status === 'active' && (
                  <button
                    onClick={() => act('pause', () => api.setVentureStatus(detail.venture.id, 'paused'))}
                    disabled={busy === 'pause'}
                    className="px-3 py-1.5 rounded bg-orange-600/80 hover:bg-orange-500 disabled:opacity-50 text-sm"
                  >
                    Pause
                  </button>
                )}
                {detail.venture.status === 'paused' && (
                  <button
                    onClick={() => act('resume', () => api.setVentureStatus(detail.venture.id, 'active'))}
                    disabled={busy === 'resume'}
                    className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm"
                  >
                    Resume
                  </button>
                )}
                {detail.venture.deployUrl && (
                  <a
                    href={detail.venture.deployUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-sm"
                  >
                    Open live ↗
                  </a>
                )}
              </div>
            </header>

            <section className="rounded-lg border border-neutral-800 p-4">
              <BudgetMeter detail={detail} />
            </section>

            {detail.openCheckpoints.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-amber-300">Approvals needed ({detail.openCheckpoints.length})</h3>
                {detail.openCheckpoints.map((c) => (
                  <div key={c.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{c.title}</div>
                      <div className="text-xs text-neutral-400">{c.kind.replace(/_/g, ' ')}{c.detail ? ` — ${c.detail}` : ''}</div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => act('cp-' + c.id, () => api.resolveCheckpoint(detail.venture.id, c.id, 'approve'))}
                        disabled={busy === 'cp-' + c.id}
                        className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-medium"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => act('cp-' + c.id, () => api.resolveCheckpoint(detail.venture.id, c.id, 'deny'))}
                        disabled={busy === 'cp-' + c.id}
                        className="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-xs"
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              {/* Roadmap */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-neutral-300">Roadmap ({goals.length})</h3>
                <div className="space-y-1">
                  {goals.length === 0 && <p className="text-xs text-neutral-500">No goals yet.</p>}
                  {goals.map((g) => (
                    <div key={g.id} className="flex items-center justify-between gap-2 rounded border border-neutral-800 px-3 py-2">
                      <span className="text-sm truncate">{g.title}</span>
                      <Badge status={g.status} />
                    </div>
                  ))}
                </div>
              </section>

              {/* Activity */}
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-neutral-300">Activity</h3>
                <div className="space-y-1 font-mono text-xs">
                  {events.length === 0 && <p className="text-neutral-500 font-sans">No activity yet.</p>}
                  {events.map((e) => (
                    <div key={e.id} className="flex gap-2">
                      <span className="text-neutral-600 shrink-0">{new Date(e.createdAt).toLocaleTimeString()}</span>
                      <span className={LEVEL_COLORS[e.level] || 'text-neutral-400'}>
                        {e.kind}
                        {e.message ? `: ${e.message}` : ''}
                        {typeof e.costUsd === 'number' ? ` ($${e.costUsd.toFixed(3)})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default OperatorConsole;
