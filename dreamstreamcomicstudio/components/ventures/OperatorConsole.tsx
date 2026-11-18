// Operator Console — the Autopilot cockpit (Epic A8). Watch ventures, draft new ones from an
// idea, approve the roadmap + checkpoints, see budget/spend, pause, and read the activity stream
// (polled). Self-contained; talks to /api/ventures via services/venturesApi. Reachable at
// ?view=ventures (signed in; admin-only on the server while VENTURES_ENABLED is off).
//
// The build stage was retired with Code Studio (ADR 0005): nothing is built automatically, an
// approved roadmap stays paused ('build_retired') and the server refuses to resume (410).

import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../../services/venturesApi';
import type { Venture, VentureDetail, Goal, VentureEvent } from '../../services/venturesApi';
import { cn } from '../../lib/utils';
import { Button, buttonClasses } from '../ds';
import {
  FIELD,
  FOCUS_RING,
  HOVER_ROW,
  INK,
  MUTED,
  OVERLINE,
  SECTION_CARD,
  STATUS_CHIP,
  STATUS_CHIP_TONE,
  STATUS_INK,
  STATUS_SURFACE,
  TONE_FILL,
  TONE_TEXT,
  type StatusState
} from '../chat/studioDesign';

// One status vocabulary (Atlas): the words always ride with the tint.
const STATUS_STATE: Record<string, StatusState> = {
  draft: 'waiting',
  roadmap_pending: 'attention',
  active: 'healthy',
  paused: 'attention',
  archived: 'waiting'
};

const LEVEL_COLORS: Record<string, string> = {
  info: MUTED,
  warn: TONE_TEXT.warning,
  error: TONE_TEXT.danger
};

const Badge: React.FC<{ status: string }> = ({ status }) => (
  <span className={cn(STATUS_CHIP, 'shrink-0', STATUS_CHIP_TONE[STATUS_STATE[status] || 'waiting'])}>
    {status.replace(/_/g, ' ')}
  </span>
);

const num = (n: number | null | undefined) => (typeof n === 'number' ? n : 0);

const PAUSE_LABELS: Record<string, string> = {
  build_retired: 'build stage retired',
  manual: 'paused by you',
  budget: 'budget reached',
  checkpoint: 'waiting on an approval',
  kill: 'emergency stop',
  stuck: 'stuck'
};

const BUILD_RETIRED_COPY =
  'Nothing is built automatically any more: the build stage was retired with Code Studio. Roadmaps, goals, budgets, approvals and signals still work.';

// ApiError carries the response body in `details`; read the server's error code from there.
const errorCode = (e: unknown): string | undefined => {
  const err = e as { code?: string; details?: { error?: { code?: string } } };
  return err?.code || err?.details?.error?.code;
};

const RetiredBanner: React.FC = () => (
  <div role="note" className={cn('m-4 rounded-[var(--ds-radius-panel)] border p-3 text-sm', STATUS_SURFACE.attention, INK)}>
    <span className={cn('font-medium', STATUS_INK.attention)}>Build stage retired.</span> {BUILD_RETIRED_COPY}
  </div>
);

const BudgetMeter: React.FC<{ detail: VentureDetail }> = ({ detail }) => {
  if (!detail.budget) return null;
  const { budget, spend } = detail.budget;
  const cap = num(budget.usdTotal);
  const pct = cap > 0 ? Math.min(100, Math.round((num(spend.usdTotal) / cap) * 100)) : 0;
  const tone =
    detail.budgetAlert === 'exceeded' ? TONE_FILL.danger : detail.budgetAlert === 'warn' ? TONE_FILL.warning : TONE_FILL.success;
  return (
    <div className="space-y-1">
      <div className={cn('flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs tabular-nums', MUTED)}>
        <span>Spend</span>
        <span>
          ${num(spend.usdTotal).toFixed(2)}{cap > 0 ? ` / $${cap.toFixed(2)}` : ''} total
          {' · '}${num(spend.usdToday).toFixed(2)}{num(budget.usdPerDay) ? ` / $${num(budget.usdPerDay).toFixed(2)}` : ''} today
        </span>
      </div>
      {cap > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--ds-well-strong)]">
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
    const err = e as { message?: string };
    const code = errorCode(e);
    if (code === 'VENTURES_DISABLED' || /not enabled/i.test(err?.message || '')) {
      setDisabled(true);
      return;
    }
    if (code === 'VENTURES_BUILD_RETIRED') {
      setError(`This venture can't be resumed. ${BUILD_RETIRED_COPY}`);
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
      <div className={cn('flex min-h-screen items-center justify-center bg-[var(--ds-canvas)] p-8', INK)}>
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-xl font-semibold">Autopilot is admin-only</h1>
          <p className={cn('text-sm', MUTED)}>
            Ventures is turned off for everyone else (<code>VENTURES_ENABLED=false</code>) since its build stage was
            retired with Code Studio. Admins can still draft ventures and plan roadmaps. See <code>docs/ventures</code>.
          </p>
          {onBack && (
            <Button variant="outline" onClick={onBack}>
              Back
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex min-h-screen flex-col bg-[var(--ds-canvas)] md:flex-row', INK)}>
      {/* Left: venture list + intake (stacks above the detail on phones) */}
      <aside className="flex w-full flex-col border-b border-[var(--ds-hairline)] bg-[var(--ds-sidebar)] md:w-80 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between border-b border-[var(--ds-hairline)] p-4">
          <h1 className="font-semibold">Autopilot</h1>
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack} className={MUTED}>
              ← Back
            </Button>
          )}
        </div>
        <div className="space-y-2 border-b border-[var(--ds-hairline)] p-4">
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe a product idea to plan…"
            className={cn(FIELD, 'h-20 w-full resize-none p-2 text-sm')}
          />
          <Button onClick={draft} disabled={!idea.trim() || busy === 'draft'} className="w-full">
            {busy === 'draft' ? 'Drafting roadmap…' : 'Draft a venture'}
          </Button>
        </div>
        <div className="max-h-[50vh] flex-1 space-y-0.5 overflow-y-auto p-2 md:max-h-none">
          {ventures.length === 0 && <p className={cn('p-2 text-sm', MUTED)}>No ventures yet.</p>}
          {ventures.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedId(v.id)}
              aria-current={selectedId === v.id ? 'true' : undefined}
              className={cn('w-full px-3 py-3 text-left', HOVER_ROW, selectedId === v.id && 'bg-[var(--ds-active)]', FOCUS_RING)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{v.name}</span>
                <Badge status={v.status} />
              </div>
              {v.summary && <p className={cn('mt-1 line-clamp-2 text-xs', MUTED)}>{v.summary}</p>}
            </button>
          ))}
        </div>
      </aside>

      {/* Right: detail */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <RetiredBanner />
        {error && <div className={cn('m-4 rounded-[var(--ds-radius-panel)] border p-3 text-sm [overflow-wrap:anywhere]', STATUS_SURFACE.error, STATUS_INK.error)}>{error}</div>}
        {!detail && <div className={cn('p-8', MUTED)}>Select a venture, or draft one from an idea.</div>}
        {detail && (
          <div className="max-w-4xl space-y-6 p-4 sm:p-6">
            <header className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="min-w-0 text-[length:var(--ds-text-2xl)] font-semibold leading-8 [overflow-wrap:anywhere]">{detail.venture.name}</h2>
                <Badge status={detail.venture.status} />
                {detail.venture.pauseReason && (
                  <span className={cn('text-xs', STATUS_INK.attention)}>
                    {PAUSE_LABELS[detail.venture.pauseReason] || `paused: ${detail.venture.pauseReason}`}
                  </span>
                )}
              </div>
              {detail.venture.summary && <p className={cn('text-sm', MUTED)}>{detail.venture.summary}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                {detail.venture.status === 'roadmap_pending' && (
                  <Button size="sm" onClick={() => act('approve', () => api.approveRoadmap(detail.venture.id))} disabled={busy === 'approve'}>
                    {busy === 'approve' ? 'Approving…' : 'Approve roadmap'}
                  </Button>
                )}
                {detail.venture.status === 'active' && (
                  <Button size="sm" variant="outline" onClick={() => act('pause', () => api.setVentureStatus(detail.venture.id, 'paused'))} disabled={busy === 'pause'}>
                    Pause
                  </Button>
                )}
                {/* No Resume: with the build stage retired the server refuses 'active' (410), so a
                    paused venture stays paused whatever paused it. */}
                {detail.venture.deployUrl && (
                  <a
                    href={detail.venture.deployUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClasses({ variant: 'outline', size: 'sm' })}
                  >
                    Open live ↗
                  </a>
                )}
              </div>
            </header>

            <section className={cn(SECTION_CARD, 'p-4')}>
              <BudgetMeter detail={detail} />
            </section>

            {detail.openCheckpoints.length > 0 && (
              <section className="space-y-2">
                <h3 className={cn('text-sm font-semibold', STATUS_INK.attention)}>Approvals needed ({detail.openCheckpoints.length})</h3>
                {detail.openCheckpoints.map((c) => (
                  <div key={c.id} className={cn('flex flex-wrap items-center justify-between gap-3 rounded-[var(--ds-radius-panel)] border p-3', STATUS_SURFACE.attention)}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium [overflow-wrap:anywhere]">{c.title}</div>
                      <div className={cn('text-xs [overflow-wrap:anywhere]', MUTED)}>{c.kind.replace(/_/g, ' ')}{c.detail ? ` — ${c.detail}` : ''}</div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" onClick={() => act('cp-' + c.id, () => api.resolveCheckpoint(detail.venture.id, c.id, 'approve'))} disabled={busy === 'cp-' + c.id}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act('cp-' + c.id, () => api.resolveCheckpoint(detail.venture.id, c.id, 'deny'))} disabled={busy === 'cp-' + c.id}>
                        Deny
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              {/* Roadmap */}
              <section className="space-y-2">
                <h3 className={OVERLINE}>Roadmap ({goals.length})</h3>
                <div className="space-y-1">
                  {goals.length === 0 && <p className={cn('text-xs', MUTED)}>No goals yet.</p>}
                  {goals.map((g) => (
                    <div key={g.id} className="flex items-center justify-between gap-2 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] px-3 py-2">
                      <span className="min-w-0 truncate text-sm">{g.title}</span>
                      <Badge status={g.status} />
                    </div>
                  ))}
                </div>
              </section>

              {/* Activity */}
              <section className="space-y-2">
                <h3 className={OVERLINE}>Activity</h3>
                <div className="space-y-1 font-mono text-xs">
                  {events.length === 0 && <p className={cn('font-sans', MUTED)}>No activity yet.</p>}
                  {events.map((e) => (
                    <div key={e.id} className="flex gap-2">
                      <span className={cn('shrink-0 tabular-nums', MUTED)}>{new Date(e.createdAt).toLocaleTimeString()}</span>
                      <span className={cn('min-w-0 [overflow-wrap:anywhere]', LEVEL_COLORS[e.level] || MUTED)}>
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
