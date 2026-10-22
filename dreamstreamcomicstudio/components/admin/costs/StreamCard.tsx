import React, { useState } from 'react';
import { ChevronDown, Info, KeyRound, OctagonAlert, Radio, TriangleAlert } from 'lucide-react';
import { RangeTabs, Surface, SurfaceSubtitle, SurfaceTitle } from '../../chat/artifacts/kit';
import type { StreamConsumerRow, StreamCostSection, StreamFeatureRow, StreamHeadroomRow, StreamPathKey } from '../../../shared/types/costCentre';
import { SortableTable, type Column } from './SortableTable';
import { BudgetMeter, CostDelta, KpiTile, SourceBadge } from './CostBits';
import { fmtCount, fmtDay, fmtPct, fmtUsd, pctChange } from './costFormat';
import { PATH_COLOR, PATH_LABEL, STATUS } from './costPalette';

// Admin → Costs → Stream Studio (ADR 0007; docs/features/stream-studio-costs.md §3). What Stream
// Studio and the baby monitor cost: marginal $ (its share of the account's overage — usually $0)
// next to the list-price value of what it used, per feature, per path, per top consumer, against
// every account-wide free allowance, with alerts. Measured = Cloudflare's own analytics; estimated =
// the rooms' counters × list price. Nothing here is charged to users.

const ACCENT = '#D97757';
const PATHS: readonly StreamPathKey[] = ['lan', 'direct', 'turn', 'server'];
const CONSUMER_TABS = ['Nurseries', 'Accounts', 'Events'] as const;
type ConsumerTab = (typeof CONSUMER_TABS)[number];

/** "27,000 requests" · "69 GB-s" · "0.34 GB" — counts whole, fractional units with sensible digits. */
export const fmtUnits = (value: number, unit: string): string => {
  if (!Number.isFinite(value)) return '—';
  const whole = unit === 'requests' || unit === 'rows' || unit === 'operations' || unit === 'emails';
  if (whole) return `${fmtCount(value)} ${unit}`;
  const digits = value >= 100 ? 0 : value >= 1 ? 1 : value >= 0.01 ? 2 : 3;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: digits })} ${unit}`;
};

const fmtMinutes = (m: number): string => (m >= 120 ? `${(m / 60).toFixed(m >= 6000 ? 0 : 1)} h` : `${Math.round(m)} min`);

const HEADROOM_COLUMNS: Column<StreamHeadroomRow>[] = [
  {
    key: 'label',
    label: 'Allowance',
    value: (r) => r.label,
    className: 'min-w-[180px]',
    render: (r) => (
      <div title={r.note}>
        <div className="font-medium">{r.label}</div>
        <div className="text-[11px] text-[var(--ds-muted)]">{fmtUnits(r.allowance, r.unit)} included</div>
      </div>
    )
  },
  { key: 'used', label: 'Used so far', align: 'right', value: (r) => r.used, render: (r) => fmtUnits(r.used, r.unit) },
  { key: 'projected', label: 'Month end', align: 'right', value: (r) => r.projected, render: (r) => fmtUnits(r.projected, r.unit) },
  { key: 'pct', label: 'Of free tier', align: 'right', value: (r) => r.projectedPct, render: (r) => <BudgetMeter pct={r.projectedPct} /> },
  {
    key: 'crosses',
    label: 'Crosses',
    align: 'right',
    value: (r) => r.crossesOn ?? '',
    render: (r) => (r.crossesOn ? fmtDay(r.crossesOn) : <span className="text-[var(--ds-muted)]">not this month</span>)
  },
  { key: 'overage', label: 'Overage', align: 'right', value: (r) => r.overageUsd, render: (r) => fmtUsd(r.overageUsd) },
  { key: 'source', label: 'Source', value: (r) => r.source, render: (r) => <SourceBadge source={r.source} /> }
];

const FEATURE_COLUMNS: Column<StreamFeatureRow>[] = [
  {
    key: 'label',
    label: 'Feature',
    value: (r) => r.label,
    className: 'min-w-[170px]',
    render: (r) => (
      <div>
        <div className="font-medium">{r.label}</div>
        {r.note && <div className="text-[11px] leading-snug text-[var(--ds-muted)]">{r.note}</div>}
      </div>
    )
  },
  {
    key: 'units',
    label: 'Units',
    value: (r) => r.units.map((u) => `${u.label}: ${fmtUnits(u.value, u.unit)}`).join('; '),
    className: 'min-w-[220px]',
    render: (r) =>
      r.units.length === 0 ? (
        <span className="text-[var(--ds-muted)]">Nothing recorded</span>
      ) : (
        <ul className="space-y-0.5 tabular-nums">
          {r.units.map((u) => (
            <li key={u.label}>
              <span className="text-[var(--ds-muted)]">{u.label}</span> {fmtUnits(u.value, u.unit)}
            </li>
          ))}
        </ul>
      )
  },
  { key: 'usd', label: 'List value', align: 'right', value: (r) => r.listValueUsd, render: (r) => `${fmtUsd(r.listValueUsd)}${r.listValueUsd > 0 && r.source === 'estimated' ? ' est.' : ''}` },
  { key: 'source', label: 'Source', value: (r) => r.source, render: (r) => <SourceBadge source={r.source} /> }
];

const CONSUMER_COLUMNS: Column<StreamConsumerRow>[] = [
  {
    key: 'label',
    label: 'Who',
    value: (r) => r.label,
    className: 'max-w-[280px]',
    render: (r) => (
      <div className="min-w-0">
        <div className="truncate font-medium" title={r.id}>
          {r.label}
        </div>
        {r.owner && <div className="truncate font-mono text-[11px] text-[var(--ds-muted)]">{r.owner}</div>}
      </div>
    )
  },
  { key: 'usd', label: 'List value', align: 'right', value: (r) => r.listValueUsd, render: (r) => `${fmtUsd(r.listValueUsd)}${r.listValueUsd > 0 ? ' est.' : ''}` },
  { key: 'server', label: 'Our server', align: 'right', value: (r) => r.serverMinutes, render: (r) => fmtMinutes(r.serverMinutes) },
  { key: 'turn', label: 'TURN', align: 'right', value: (r) => r.turnGb, render: (r) => fmtUnits(r.turnGb, 'GB') },
  { key: 'minutes', label: 'All paths', align: 'right', value: (r) => r.minutes, render: (r) => fmtMinutes(r.minutes) },
  { key: 'id', label: 'Id', value: (r) => r.id, className: 'max-w-[120px] truncate font-mono text-[11px] text-[var(--ds-muted)]' }
];

/** One horizontal bar per product: minutes by path, stacked, with words beside the colors. */
const PathMix: React.FC<{ mix: StreamCostSection['pathMix'] }> = ({ mix }) => {
  const any = mix.some((m) => PATHS.some((p) => m.minutes[p] > 0));
  return (
    <div className="space-y-3" data-testid="stream-path-mix">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ds-muted)]" aria-label="Path legend">
        {PATHS.map((p) => (
          <li key={p} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: PATH_COLOR[p] }} aria-hidden />
            {PATH_LABEL[p]}
            {(p === 'lan' || p === 'direct') && <span className="text-[10px]">· free</span>}
          </li>
        ))}
      </ul>
      {!any && <p className="text-xs text-[var(--ds-muted)]">No minutes recorded in this period.</p>}
      {any &&
        mix.map((m) => {
          const total = PATHS.reduce((s, p) => s + m.minutes[p], 0);
          return (
            <div key={m.kind}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-[var(--ds-ink)]">{m.label}</span>
                <span className="tabular-nums text-[var(--ds-muted)]">{total > 0 ? fmtMinutes(total) : 'none'}</span>
              </div>
              <div
                className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-sm bg-[var(--ds-well-strong)]"
                role="img"
                aria-label={total > 0 ? `${m.label}: ${PATHS.filter((p) => m.minutes[p] > 0).map((p) => `${PATH_LABEL[p]} ${fmtPct((m.minutes[p] / total) * 100)}`).join(', ')}` : `${m.label}: no minutes`}
              >
                {total > 0 &&
                  PATHS.filter((p) => m.minutes[p] > 0).map((p) => (
                    <span key={p} title={`${PATH_LABEL[p]} · ${fmtMinutes(m.minutes[p])}`} style={{ width: `${Math.max(1.5, (m.minutes[p] / total) * 100)}%`, background: PATH_COLOR[p] }} />
                  ))}
              </div>
            </div>
          );
        })}
    </div>
  );
};

const AlertList: React.FC<{ alerts: StreamCostSection['alerts'] }> = ({ alerts }) =>
  alerts.length === 0 ? null : (
    <ul className="space-y-2" role="alert" aria-label="Stream Studio cost alerts" data-testid="stream-alerts">
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

const KPI_ROWS: { key: 'doRequests' | 'rowsWritten' | 'gbSeconds'; label: string; budget: number; unit: string }[] = [
  { key: 'doRequests', label: 'DO requests', budget: 1000, unit: 'requests' },
  { key: 'rowsWritten', label: 'Rows written', budget: 1800, unit: 'rows' },
  { key: 'gbSeconds', label: 'DO duration', budget: 40, unit: 'GB-s' }
];

const Kpis: React.FC<{ s: StreamCostSection }> = ({ s }) => (
  <div className="space-y-2 text-xs" data-testid="stream-kpis">
    <div className="flex flex-wrap items-center gap-2 text-[var(--ds-muted)]">
      Per active nursery-day · {fmtCount(s.kpis.activeNurseryDays)} this month <SourceBadge source={s.kpis.source} />
    </div>
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {KPI_ROWS.map((k) => {
        const v = s.kpis[k.key];
        const over = v != null && v > k.budget;
        return (
          <li key={k.key} className="rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2.5 py-2">
            <div className="text-[11px] text-[var(--ds-muted)]">{k.label}</div>
            <div className="flex items-center gap-1 text-sm font-semibold tabular-nums text-[var(--ds-ink)]">
              {over && <TriangleAlert className="h-3.5 w-3.5" style={{ color: STATUS.warning }} aria-label="over budget" />}
              {v == null ? '—' : fmtUnits(v, k.unit)}
            </div>
            <div className="text-[10px] text-[var(--ds-muted)]">budget ≤ {fmtCount(k.budget)}</div>
          </li>
        );
      })}
      <li className="rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-2.5 py-2">
        <div className="text-[11px] text-[var(--ds-muted)]">Our-server share</div>
        <div className="text-sm font-semibold tabular-nums text-[var(--ds-ink)]">{s.kpis.serverShare == null ? '—' : fmtPct(s.kpis.serverShare * 100, 1)}</div>
        <div className="text-[10px] text-[var(--ds-muted)]">of monitor minutes · reported</div>
      </li>
    </ul>
    <p className="text-[11px] text-[var(--ds-muted)]">{s.kpis.note}</p>
    <p className="text-[11px] text-[var(--ds-muted)]" data-testid="stream-projection">
      At today’s per-nursery cost (list price, est.):{' '}
      {s.projection.at1k == null ? (
        'not enough monitor data yet.'
      ) : (
        <>
          <span className="font-semibold text-[var(--ds-ink)]">1k nurseries ≈ {fmtUsd(s.projection.at1k)}/mo</span> ·{' '}
          <span className="font-semibold text-[var(--ds-ink)]">10k ≈ {fmtUsd(s.projection.at10k)}/mo</span>
        </>
      )}
    </p>
  </div>
);

const Setup: React.FC<{ s: StreamCostSection }> = ({ s }) => (
  <Surface
    className="!my-0"
    header={
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />
        <div>
          <SurfaceTitle>Stream Studio costs — not measured yet</SurfaceTitle>
          <SurfaceSubtitle>Today it fits inside the $5 Workers Paid plan; connect analytics to see real figures</SurfaceSubtitle>
        </div>
      </div>
    }
  >
    <ol className="list-decimal space-y-1.5 px-3 pb-3 pl-8 text-xs leading-relaxed text-[var(--ds-ink)]">
      <li>
        Create a read-only API token with <span className="font-semibold">Account › Account Analytics › Read</span> (covers GraphQL and Analytics
        Engine).
      </li>
      <li>
        Set <code className="rounded bg-[var(--ds-well-strong)] px-1 font-mono text-[11px]">CF_ANALYTICS_API_TOKEN</code> and{' '}
        <code className="rounded bg-[var(--ds-well-strong)] px-1 font-mono text-[11px]">CLOUDFLARE_ACCOUNT_ID</code> on the backend (Worker secrets or D1{' '}
        <span className="font-mono text-[11px]">backend_env</span>).
      </li>
      <li>
        Optional: <code className="rounded bg-[var(--ds-well-strong)] px-1 font-mono text-[11px]">STREAM_DO_NAMESPACES</code> ={' '}
        <span className="font-mono text-[11px]">MonitorRoom=&lt;id&gt;,EventRoom=&lt;id&gt;,…</span> for per-room figures.
      </li>
      <li>Set a Cloudflare account budget alert (Billing → budget alerts) at $10 — the backstop if metering ever breaks.</li>
    </ol>
    {s.notes.length > 0 && (
      <ul className="list-disc space-y-1 border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-2 pl-7 text-[11px] text-[var(--ds-muted)]">
        {s.notes.slice(0, 3).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    )}
    <p className="flex items-center gap-1.5 border-t border-[var(--ds-hairline-soft)] px-3 py-2 text-[11px] text-[var(--ds-muted)]">
      <KeyRound className="h-3 w-3" aria-hidden /> The token is read server-side only and never sent to the browser.
    </p>
  </Surface>
);

const Notes: React.FC<{ s: StreamCostSection }> = ({ s }) => {
  const [open, setOpen] = useState(false);
  return (
    <Surface className="!my-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--ds-hover)]"
      >
        <span className="flex items-center gap-2">
          <Info className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden />
          <span className="text-sm font-semibold tracking-tight text-[var(--ds-ink)]">How the Stream Studio numbers are computed</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-[var(--ds-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <ul className="list-disc space-y-1 border-t border-[var(--ds-hairline-soft)] px-3 py-3 pl-7 text-xs leading-relaxed text-[var(--ds-muted)]">
          {s.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Surface>
  );
};

export const StreamCard: React.FC<{ stream?: StreamCostSection; days: number }> = ({ stream, days }) => {
  const [who, setWho] = useState<ConsumerTab>('Nurseries');
  if (!stream) {
    return <p className="px-1 py-6 text-center text-xs text-[var(--ds-muted)]">This server doesn’t report Stream Studio costs yet — deploy the backend to see them.</p>;
  }
  const s = stream;
  if (!s.sources.graphql && !s.sources.analyticsEngine) return <Setup s={s} />;

  const consumers = who === 'Nurseries' ? s.top.nurseries : who === 'Accounts' ? s.top.accounts : s.top.events;
  return (
    <div className="space-y-3" data-testid="stream-card">
      <AlertList alerts={s.alerts} />
      {s.errors.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-xs text-[var(--ds-ink)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" style={{ color: STATUS.warning }} aria-hidden />
          <div>
            <div className="font-semibold">Some Cloudflare datasets didn’t answer — the rest is shown</div>
            <ul className="text-[var(--ds-muted)]">
              {s.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          testId="stream-kpi-marginal"
          label="Marginal cost · this month"
          value={fmtUsd(s.marginalUsd)}
          sub={s.marginalUsd === 0 ? 'Inside the free allowances (account-wide).' : 'Stream Studio’s share of what the account owes past the free allowances.'}
        />
        <KpiTile
          testId="stream-kpi-list"
          label={`List value · ${days}d (est.)`}
          value={fmtUsd(s.listValueUsd)}
          delta={<CostDelta pct={s.prevListValueUsd == null ? null : pctChange(s.listValueUsd, s.prevListValueUsd)} label={s.prevListValueUsd == null ? '' : `vs ${fmtUsd(s.prevListValueUsd)} prior ${days}d`} />}
          sub="What the usage would cost at list price with no free tier."
        />
        <KpiTile
          testId="stream-kpi-nursery"
          label="Per active nursery-month (est.)"
          value={s.perNurseryMonthUsd == null ? '—' : fmtUsd(s.perNurseryMonthUsd)}
          sub={`${fmtCount(s.activeNurseries)} active ${s.activeNurseries === 1 ? 'nursery' : 'nurseries'} · broadcast-hour ${s.perBroadcastHourUsd == null ? '—' : fmtUsd(s.perBroadcastHourUsd)}`}
        />
        <KpiTile
          testId="stream-kpi-free"
          label="Minutes on free paths"
          value={s.freePathShare == null ? '—' : fmtPct(s.freePathShare * 100, s.freePathShare >= 0.995 ? 0 : 1)}
          sub="Home Wi-Fi + Direct, of monitor, call and meeting minutes."
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-5">
        <Surface
          className="!my-0 lg:col-span-3"
          header={
            <div>
              <SurfaceTitle>Free-tier headroom</SurfaceTitle>
              <SurfaceSubtitle>
                Month to date ({s.month.daysElapsed} of {s.month.daysInMonth} days), straight-line to month end · account-wide, shared with every Worker
              </SurfaceSubtitle>
            </div>
          }
        >
          <div className="px-3 pb-3">
            <SortableTable
              caption="Stream Studio free-tier headroom"
              csvName="stream-headroom"
              columns={HEADROOM_COLUMNS}
              rows={s.headroom}
              rowKey={(r) => r.id}
              emptyText="No measured figures yet — Cloudflare analytics didn’t return any for this month."
            />
          </div>
        </Surface>
        <Surface
          className="!my-0 lg:col-span-2"
          header={
            <div>
              <SurfaceTitle>Path mix</SurfaceTitle>
              <SurfaceSubtitle>Minutes by path, last {days} days · the frugality scoreboard</SurfaceSubtitle>
            </div>
          }
        >
          <div className="px-3 pb-3">
            <PathMix mix={s.pathMix} />
          </div>
        </Surface>
      </div>

      <Surface
        className="!my-0"
        header={
          <div>
            <SurfaceTitle>By feature</SurfaceTitle>
            <SurfaceSubtitle>Last {days} days · units behind every $ · prices checked {s.pricesCheckedOn}</SurfaceSubtitle>
          </div>
        }
      >
        <div className="px-3 pb-3">
          <SortableTable
            caption="Stream Studio cost by feature"
            csvName={`stream-features-${days}d`}
            columns={FEATURE_COLUMNS}
            rows={s.features}
            rowKey={(r) => r.id}
            emptyText="No features recorded."
          />
        </div>
      </Surface>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Surface
          className="!my-0"
          header={
            <div>
              <SurfaceTitle>Top consumers</SurfaceTitle>
              <SurfaceSubtitle>Admin console only · guests are counted inside their nursery or event, never listed</SurfaceSubtitle>
            </div>
          }
          right={<RangeTabs<ConsumerTab> options={CONSUMER_TABS} value={who} onChange={setWho} accent={ACCENT} />}
        >
          <div className="px-3 pb-3">
            <SortableTable
              caption={`Top ${who.toLowerCase()} by Stream Studio usage`}
              csvName={`stream-top-${who.toLowerCase()}-${days}d`}
              columns={CONSUMER_COLUMNS}
              rows={consumers}
              rowKey={(r) => `${r.scope}:${r.id}`}
              emptyText={`No ${who.toLowerCase()} used anything in this period.`}
              initialSort={{ key: 'usd', dir: 'desc' }}
            />
          </div>
        </Surface>
        <Surface
          className="!my-0"
          header={
            <div>
              <SurfaceTitle>Baby monitor health (ADR 0006)</SurfaceTitle>
              <SurfaceSubtitle>Budgets apply after Phase 0 ships; until then this is the baseline</SurfaceSubtitle>
            </div>
          }
        >
          <div className="px-3 pb-3">
            <Kpis s={s} />
          </div>
        </Surface>
      </div>

      <Notes s={s} />
    </div>
  );
};

export default StreamCard;
