import React from 'react';
import { OctagonAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Surface, SurfaceSubtitle, SurfaceTitle } from '../../chat/artifacts/kit';
import type { CspViolationRow, SecuritySection, SecuritySignalRow } from '../../../shared/types/costCentre';
import { SortableTable, type Column } from './SortableTable';
import { KpiTile } from './CostBits';
import { fmtCount } from './costFormat';
import { STATUS } from './costPalette';

// Admin → Costs → Security (ADR 0006 WS-8). Aggregate, privacy-safe signals: the browser protections'
// violation counts (CSP), sign-ins and the alerts about them, and the live Worker's refusals and
// disconnects. Counts only — no account, nursery, device, IP, token, email or URL is ever shown.
// What to do when something fires: docs/infrastructure/live-security-runbook.md.

const PAGE_LABEL: Record<string, string> = { live: 'Stream Studio', main: 'Main app', srcdoc: 'Chat artifact', other: 'Other' };

const CSP_COLUMNS: Column<CspViolationRow>[] = [
  { key: 'page', label: 'App', value: (r) => PAGE_LABEL[r.page] ?? r.page },
  { key: 'directive', label: 'Directive', value: (r) => r.directive, className: 'font-mono text-[11px]' },
  { key: 'blocked', label: 'Blocked', value: (r) => r.blocked, className: 'max-w-[220px] truncate font-mono text-[11px]' },
  {
    key: 'disposition',
    label: 'Mode',
    value: (r) => r.disposition,
    render: (r) => (r.disposition === 'enforce' ? 'Blocked' : r.disposition === 'report' ? 'Report only' : 'Unknown')
  },
  { key: 'party', label: 'Whose code', value: (r) => (r.firstParty ? 'ours' : 'extension'), render: (r) => (r.firstParty ? 'Ours' : 'Browser extension') },
  { key: 'count', label: 'Reports', align: 'right', value: (r) => r.count, render: (r) => fmtCount(r.count) }
];

const SIGNAL_COLUMNS: Column<SecuritySignalRow>[] = [
  {
    key: 'label',
    label: 'What',
    value: (r) => r.label,
    className: 'min-w-[240px]',
    render: (r) => (
      <div className="flex items-start gap-1.5">
        {r.tone === 'bad' && r.count > 0 && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: STATUS.warning }} aria-label="worth a look" />}
        <span>{r.label}</span>
      </div>
    )
  },
  { key: 'count', label: 'This period', align: 'right', value: (r) => r.count, render: (r) => fmtCount(r.count) },
  { key: 'prev', label: 'Period before', align: 'right', value: (r) => r.prevCount, render: (r) => (r.prevCount == null ? '—' : fmtCount(r.prevCount)) },
  {
    key: 'where',
    label: 'Where',
    value: (r) => r.bySurface.map((b) => `${b.surface} ${b.count}`).join(', '),
    sortable: false,
    render: (r) => (r.bySurface.length ? r.bySurface.map((b) => `${b.surface} ${fmtCount(b.count)}`).join(' · ') : <span className="text-[var(--ds-muted)]">—</span>)
  }
];

const AlertList: React.FC<{ alerts: SecuritySection['alerts'] }> = ({ alerts }) =>
  alerts.length === 0 ? (
    <div className="flex items-center gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-xs text-[var(--ds-muted)]" data-testid="security-clear">
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden /> Nothing here needs a look right now — for what was measured (see each panel).
    </div>
  ) : (
    <ul className="space-y-2" role="alert" aria-label="Security alerts" data-testid="security-alerts">
      {alerts.map((a) => {
        const Icon = a.severity === 'critical' ? OctagonAlert : TriangleAlert;
        return (
          <li key={a.id} className="flex items-start gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-xs">
            <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: a.severity === 'critical' ? STATUS.critical : STATUS.warning }} aria-hidden />
            <div className="min-w-0">
              <div className="font-semibold text-[var(--ds-ink)]">
                {a.title} <span className="font-normal text-[var(--ds-muted)]">· {a.severity}</span>
              </div>
              <div className="text-[var(--ds-muted)]">{a.cause}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );

const n = (v: number | null) => (v == null ? '—' : fmtCount(v));

export const SecurityCard: React.FC<{ security?: SecuritySection; days: number }> = ({ security, days }) => {
  if (!security) {
    return <p className="px-1 py-6 text-center text-xs text-[var(--ds-muted)]">This server doesn’t report security signals yet — deploy the backend to see them.</p>;
  }
  const s = security;
  return (
    <div className="space-y-3" data-testid="security-card">
      <AlertList alerts={s.alerts} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          testId="security-kpi-csp"
          label="Stream Studio CSP · last 48 h"
          value={n(s.csp.firstPartyLive48h)}
          sub={
            s.csp.measured
              ? `Violations by our own code of the policy that will be enforced. Enforcing waits for 0.${
                  s.csp.trustedTypesLive ? ` (Trusted Types reports, report-only for good, not counted: ${n(s.csp.trustedTypesLive)} in ${days}d.)` : ''
                }`
              : 'Not measured yet.'
          }
        />
        <KpiTile
          testId="security-kpi-signins"
          label={`New sign-ins · ${days}d`}
          value={n(s.signIns.newSessions)}
          sub={s.signIns.measured ? `${n(s.signIns.alertsEmailed)} emailed an alert` : 'Not measured yet.'}
        />
        <KpiTile
          testId="security-kpi-secured"
          label={`“Not you?” used · ${days}d`}
          value={n(s.signIns.secured)}
          sub={s.signIns.measured ? 'Each one is a suspected takeover.' : 'Not measured yet.'}
        />
        <KpiTile
          testId="security-kpi-mfa"
          label={`Two-step refusals · ${days}d`}
          value={s.signals.counted ? fmtCount(s.signals.rows.find((r) => r.id === 'mfa_refused')?.count ?? 0) : '—'}
          sub={s.signals.counted ? 'Tokens without the second step, refused.' : 'Not counted yet.'}
        />
      </div>

      <Surface
        className="!my-0"
        header={
          <div>
            <SurfaceTitle>Browser protections (CSP)</SurfaceTitle>
            <SurfaceSubtitle>
              {s.csp.measured
                ? `Last ${days} days · ${n(s.csp.total)} reports · ${n(s.csp.extension)} from browser extensions · blocked for real on Stream Studio: ${n(s.csp.firstPartyLiveEnforced)}${
                    s.csp.trustedTypesLive != null ? ` · Trusted Types inventory (report-only): ${n(s.csp.trustedTypesLive)}` : ''
                  }`
                : 'Not measured'}
            </SurfaceSubtitle>
          </div>
        }
      >
        <div className="space-y-2 px-3 pb-3 text-xs">
          <p className="text-[var(--ds-muted)]" data-testid="security-csp-note">
            {s.csp.note}
          </p>
          {s.csp.error && <p className="font-mono text-[11px] text-[var(--ds-muted)]">{s.csp.error}</p>}
          {s.csp.measured && (
            <SortableTable
              caption="Content-Security-Policy violation reports"
              csvName={`security-csp-${days}d`}
              columns={CSP_COLUMNS}
              rows={s.csp.top}
              rowKey={(r) => `${r.page}|${r.directive}|${r.blocked}|${r.disposition}|${r.firstParty}`}
              emptyText="No violation reports in this period."
              initialSort={{ key: 'count', dir: 'desc' }}
            />
          )}
        </div>
      </Surface>

      <div className="grid items-start gap-3 lg:grid-cols-5">
        <Surface
          className="!my-0 lg:col-span-2"
          header={
            <div>
              <SurfaceTitle>Sign-ins and devices</SurfaceTitle>
              <SurfaceSubtitle>Last {days} days · from security_events, counts only</SurfaceSubtitle>
            </div>
          }
        >
          <div className="space-y-2 px-3 pb-3 text-xs" data-testid="security-signins">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
              <dt className="text-[var(--ds-muted)]">New sign-ins</dt>
              <dd className="text-right font-semibold text-[var(--ds-ink)]">{n(s.signIns.newSessions)}</dd>
              <dt className="text-[var(--ds-muted)]">Alerts emailed</dt>
              <dd className="text-right font-semibold text-[var(--ds-ink)]">{n(s.signIns.alertsEmailed)}</dd>
              <dt className="text-[var(--ds-muted)]">“Not you?” used</dt>
              <dd className="text-right font-semibold text-[var(--ds-ink)]">{n(s.signIns.secured)}</dd>
              <dt className="text-[var(--ds-muted)]">Devices added</dt>
              <dd className="text-right font-semibold text-[var(--ds-ink)]">{n(s.signIns.devicesAdded)}</dd>
              <dt className="text-[var(--ds-muted)]">Devices revoked</dt>
              <dd className="text-right font-semibold text-[var(--ds-ink)]">{n(s.signIns.devicesRevoked)}</dd>
            </dl>
            <p className="text-[11px] text-[var(--ds-muted)]">{s.signIns.note}</p>
            {s.signIns.error && <p className="font-mono text-[11px] text-[var(--ds-muted)]">{s.signIns.error}</p>}
          </div>
        </Surface>
        <Surface
          className="!my-0 lg:col-span-3"
          header={
            <div>
              <SurfaceTitle>Sessions, refusals and disconnects</SurfaceTitle>
              <SurfaceSubtitle>The live Worker’s counts · names and a socket kind only, never who</SurfaceSubtitle>
            </div>
          }
        >
          <div className="space-y-2 px-3 pb-3 text-xs">
            <p className="text-[11px] text-[var(--ds-muted)]" data-testid="security-signals-note">
              {s.signals.note}
            </p>
            {s.signals.measured && (
              <SortableTable
                caption="Security signals from the live Worker"
                csvName={`security-signals-${days}d`}
                columns={SIGNAL_COLUMNS}
                rows={s.signals.rows}
                rowKey={(r) => r.id}
                emptyText="No signals."
              />
            )}
          </div>
        </Surface>
      </div>

      {s.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-[11px] text-[var(--ds-muted)]" data-testid="security-notes">
          {s.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SecurityCard;
