// Admin → Provider status (reliability.md §4). Read-only: live ModelHealth for EVERY registry model (all routes,
// OpenRouter's public provider rows, this container's own observations) plus the breaker events this container
// recorded since it booted. One request when opened and one per "Refresh" click — no timers (the container
// sleeps after 15 idle minutes, and "since boot" restarts with it, which the section says). The server re-checks
// requireAdmin on /api/comic/models/status/admin.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import type { ModelHealth, RouteHealth } from '../../../../shared/comic/modelHealth';
import { getImageModel } from '../../../../shared/comic/models';
import { cx } from '../../conversation/ui';
import { ModelHealthDot } from '../ModelHealthDot';
import { ROUTE_NAME, clockTime, friendlyReason, sourceLine, timeAgo } from '../copy';
import { fetchProviderStatusReport, type ProviderStatusReport } from '../statusApi';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';
const PANEL = 'rounded-[var(--ds-radius-panel)] border border-[var(--ds-hairline)] bg-[var(--ds-surface)] shadow-[shadow:var(--ds-shadow-soft)]';

const pct = (v: number | null): string => (typeof v === 'number' ? `${Math.round(v * 10) / 10}%` : '—');

const RouteRow: React.FC<{ route: RouteHealth; now: number }> = ({ route, now }) => (
  <li className="min-w-0 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] px-3 py-2">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
      <span className="font-semibold text-[var(--ds-ink)]">{ROUTE_NAME[route.route]}</span>
      <ModelHealthDot state={route.state} />
      <code className="min-w-0 truncate text-[11.5px] text-[var(--ds-muted)]" title={route.model}>
        {route.model}
      </code>
      <span className="ml-auto text-[11.5px] text-[var(--ds-muted)]">
        {route.source === 'none' ? 'no live data' : `${route.source === 'openrouter' ? 'OpenRouter status' : 'our calls'}, ${timeAgo(route.checkedAt, now)}`}
      </span>
    </div>
    {route.reason && <p className="mt-1 text-[12px] text-[var(--ds-ink)] [overflow-wrap:anywhere]">{friendlyReason(route.reason)}</p>}
    {route.providers && route.providers.length > 0 && (
      <ul className="mt-1.5 space-y-0.5 text-[11.5px] tabular-nums text-[var(--ds-muted)]" aria-label="OpenRouter providers">
        {route.providers.map((p) => (
          <li key={p.name} className="flex min-w-0 flex-wrap gap-x-3">
            <span className="min-w-0 truncate text-[var(--ds-ink)]">{p.name}</span>
            <span>{p.status === 0 ? 'serving' : p.status === null ? 'status unknown' : `status ${p.status}`}</span>
            <span>30 min {pct(p.uptime30m)}</span>
            <span>24 h {pct(p.uptime1d)}</span>
          </li>
        ))}
      </ul>
    )}
    {route.observed && (
      <p className="mt-1 text-[11.5px] tabular-nums text-[var(--ds-muted)]">
        Our calls (5 min): {route.observed.ok} ok · {route.observed.upstreamFailures} upstream failures in a row
        {route.observed.lastCode ? ` · last ${route.observed.lastCode}` : ''}
        {route.observed.lastFailureAt ? ` · last failure ${clockTime(route.observed.lastFailureAt, now)}` : ''}
        {route.observed.lastSuccessAt ? ` · last success ${clockTime(route.observed.lastSuccessAt, now)}` : ''}
      </p>
    )}
  </li>
);

const ModelRow: React.FC<{ health: ModelHealth; now: number }> = ({ health, now }) => {
  const spec = getImageModel(health.modelId);
  return (
    <li className={cx(PANEL, 'min-w-0 p-3')} data-model={health.modelId}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-[var(--ds-ink)]">{spec?.nickname || health.modelId}</span>
        <ModelHealthDot health={health} label={spec?.nickname || health.modelId} now={now} />
        {spec && !spec.pickable && <span className="text-[11px] text-[var(--ds-muted)]">not in the picker</span>}
        <span className="ml-auto text-[11.5px] text-[var(--ds-muted)]">{sourceLine(health, now)}</span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {health.routes.map((r) => (
          <RouteRow key={`${r.route}-${r.model}`} route={r} now={now} />
        ))}
      </ul>
    </li>
  );
};

export const ProviderStatusSection: React.FC = () => {
  const [report, setReport] = useState<ProviderStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    fetchProviderStatusReport({ signal: ctrl.signal })
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setReport(r);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError((err as Error)?.message || "Couldn't read provider status.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const now = report?.now ?? Date.now();
  const events = report ? [...report.breakerEvents].reverse() : [];

  return (
    <section aria-labelledby="provider-status-title" className="min-w-0 space-y-4">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h2 id="provider-status-title" className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-[var(--ds-ink)]">
          <Activity className="h-4 w-4 text-[var(--ds-accent)]" aria-hidden /> Provider status
        </h2>
        <span className="text-[12px] text-[var(--ds-muted)]">
          Read-only · OpenRouter's public status (cached 3 min) + this server's own calls
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className={`ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-3 text-[12.5px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] disabled:opacity-50 coarse:min-h-11 ${FOCUS}`}
        >
          <RefreshCw className={cx('h-3.5 w-3.5', loading && 'motion-safe:animate-spin')} aria-hidden /> Refresh
        </button>
      </header>

      <div role="status" aria-live="polite" className="text-[12.5px] text-[var(--ds-muted)]">
        {error ? `Couldn't read provider status: ${error}` : !report && loading ? 'Checking every model…' : ''}
      </div>

      {report && (
        <>
          <ul className="space-y-3" aria-label="Image models">
            {report.models.map((m) => (
              <ModelRow key={m.modelId} health={m} now={now} />
            ))}
          </ul>

          <div className={cx(PANEL, 'min-w-0 p-3')}>
            <h3 className="text-[13.5px] font-semibold text-[var(--ds-ink)]">Breaker events on this server</h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--ds-muted)]">
              Since it started {report.bootedAt ? `${clockTime(report.bootedAt, now)} (${timeAgo(report.bootedAt, now)})` : ''}. The server sleeps after 15 idle minutes, and
              this list starts over when it wakes. Key, billing and safety errors never count.
            </p>
            {events.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-[var(--ds-ink)]">No route has tripped since then.</p>
            ) : (
              <ol className="mt-2 space-y-1 text-[12px] tabular-nums">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex min-w-0 flex-wrap gap-x-3 text-[var(--ds-ink)]">
                    <span className="text-[var(--ds-muted)]">{clockTime(e.at, now)}</span>
                    <span className="font-medium">{e.event === 'opened' ? 'Paused' : 'Recovered'}</span>
                    <span>{ROUTE_NAME[e.route]}</span>
                    <code className="min-w-0 truncate text-[11.5px] text-[var(--ds-muted)]">{e.model}</code>
                    {e.event === 'opened' && (
                      <span className="text-[var(--ds-muted)]">
                        after {e.failures} failures{e.code ? ` (${e.code})` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default ProviderStatusSection;
