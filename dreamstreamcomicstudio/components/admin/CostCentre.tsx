import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Info, RefreshCw, TriangleAlert, Wallet } from 'lucide-react';
import { RangeTabs, Surface, SurfaceSubtitle, SurfaceTitle } from '../chat/artifacts/kit';
import { getCostCentre } from '../../services/adminCosts';
import type {
  AiModelRow,
  AiOperationRow,
  AiUserRow,
  ConnectorRow,
  CostCentreReport,
  CostRangeDays,
  FixedCostRow,
  ProductRow,
  RevenueTierRow
} from '../../shared/types/costCentre';
import { SortableTable, type Column } from './costs/SortableTable';
import { StackedDailyChart } from './costs/StackedDailyChart';
import { BudgetMeter, CategoryBreakdown, CostDelta, KpiTile, PeakDay, SkeletonBlock, SourceBadge } from './costs/CostBits';
import { CloudflareCard } from './costs/CloudflareCard';
import { StreamCard } from './costs/StreamCard';
import { COST_PALETTE_CLASS, CATEGORY_SHORT_LABEL, STACK_ORDER } from './costs/costPalette';
import { fmtCount, fmtDay, fmtTime, fmtUsd, pctChange } from './costs/costFormat';
import { UsageBudgetsPanel } from '../usage/UsageBudgetsPanel';

// Admin → Costs. A cost-benefit view of the whole platform on REAL data
// (GET /api/admin/costs): what it costs to run (AI, email, containers, connectors, fixed
// plans) vs what it brings in (MRR estimate, credit packs), per day and per product. Every
// figure is labelled measured / estimated / fixed, and every assumption is one click away.
// Calm-studio widget language: kit Surface, --ds-* tokens, tabular columns; works in dark.

const RANGE_LABELS = ['7d', '30d', '90d'] as const;
type RangeLabel = (typeof RANGE_LABELS)[number];
const LABEL_TO_DAYS: Record<RangeLabel, CostRangeDays> = { '7d': 7, '30d': 30, '90d': 90 };
const DAYS_TO_LABEL: Record<CostRangeDays, RangeLabel> = { 7: '7d', 30: '30d', 90: '90d' };
const RANGE_STORAGE_KEY = 'ds.admin.costs.days';

const MAIN_TABS = ['Products', 'Stream Studio', 'AI', 'Connectors', 'Fixed costs', 'Revenue'] as const;
type MainTab = (typeof MAIN_TABS)[number];
const AI_TABS = ['By model', 'By user', 'By operation'] as const;
type AiTab = (typeof AI_TABS)[number];
const VIEW_TABS = ['Chart', 'Table'] as const;
type ViewTab = (typeof VIEW_TABS)[number];

const ACCENT = '#D97757';

const readStoredDays = (): CostRangeDays => {
  try {
    const v = Number(window.localStorage.getItem(RANGE_STORAGE_KEY));
    return v === 7 || v === 30 || v === 90 ? v : 30;
  } catch {
    return 30;
  }
};

const storeDays = (days: CostRangeDays) => {
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, String(days));
  } catch {
    /* per-viewer convenience only */
  }
};

const muted = (text: React.ReactNode) => <span className="text-[var(--ds-muted)]">{text}</span>;

// ─── Table column definitions ─────────────────────────────────────────────────────────────

const PRODUCT_COLUMNS: Column<ProductRow>[] = [
  {
    key: 'product',
    label: 'Product',
    value: (r) => r.label,
    className: 'min-w-[190px]',
    render: (r) => (
      <div>
        <div className="font-medium">{r.label}</div>
        <div className="text-[11px] leading-snug text-[var(--ds-muted)]">{r.note}</div>
      </div>
    )
  },
  { key: 'cost', label: 'Cost', align: 'right', value: (r) => r.costUsd, render: (r) => fmtUsd(r.costUsd) },
  {
    key: 'listValue',
    label: 'List value',
    align: 'right',
    value: (r) => r.listValueUsd ?? null,
    render: (r) =>
      r.listValueUsd == null ? (
        muted('—')
      ) : (
        <span title="What the same usage would cost at list price with no free tier — an estimate, not a charge">{fmtUsd(r.listValueUsd)} est.</span>
      )
  },
  { key: 'requests', label: 'Requests', align: 'right', value: (r) => r.requests, render: (r) => fmtCount(r.requests) },
  { key: 'users', label: 'Users', align: 'right', value: (r) => r.users, render: (r) => fmtCount(r.users) },
  {
    key: 'revenue',
    label: 'Revenue',
    align: 'right',
    value: (r) => r.revenueUsd,
    render: (r) =>
      r.revenueUsd === null ? (
        <span className="text-[var(--ds-muted)]" title="Subscriptions and credits cover the whole suite — revenue isn't attributed per product">
          n/a
        </span>
      ) : (
        fmtUsd(r.revenueUsd)
      )
  },
  { key: 'verdict', label: 'Verdict', value: (r) => r.verdict ?? '', className: 'min-w-[260px]' }
];

const AI_MODEL_COLUMNS: Column<AiModelRow>[] = [
  { key: 'provider', label: 'Provider', value: (r) => r.provider },
  { key: 'model', label: 'Model', value: (r) => r.model, className: 'max-w-[260px] truncate font-mono text-[11px]' },
  { key: 'events', label: 'Events', align: 'right', value: (r) => r.events, render: (r) => fmtCount(r.events) },
  { key: 'byok', label: 'On user keys', align: 'right', value: (r) => r.byok, render: (r) => fmtCount(r.byok) },
  { key: 'providerUsd', label: 'Provider $', align: 'right', value: (r) => r.providerUsd, render: (r) => fmtUsd(r.providerUsd) },
  { key: 'billableUsd', label: 'Billable $', align: 'right', value: (r) => r.billableUsd, render: (r) => fmtUsd(r.billableUsd) }
];

const AI_USER_COLUMNS: Column<AiUserRow>[] = [
  { key: 'user', label: 'User', value: (r) => r.email || r.userId, className: 'max-w-[280px] truncate font-mono text-[11px]' },
  { key: 'events', label: 'Events', align: 'right', value: (r) => r.events, render: (r) => fmtCount(r.events) },
  { key: 'providerUsd', label: 'Provider $', align: 'right', value: (r) => r.providerUsd, render: (r) => fmtUsd(r.providerUsd) }
];

const AI_OPERATION_COLUMNS: Column<AiOperationRow>[] = [
  { key: 'operation', label: 'Operation', value: (r) => r.operation, className: 'font-mono text-[11px]' },
  { key: 'events', label: 'Events', align: 'right', value: (r) => r.events, render: (r) => fmtCount(r.events) },
  { key: 'providerUsd', label: 'Provider $', align: 'right', value: (r) => r.providerUsd, render: (r) => fmtUsd(r.providerUsd) }
];

const CONNECTOR_COLUMNS: Column<ConnectorRow>[] = [
  { key: 'provider', label: 'Provider', value: (r) => r.provider, className: 'font-mono text-[11px]' },
  { key: 'calls', label: 'Calls', align: 'right', value: (r) => r.calls, render: (r) => fmtCount(r.calls) },
  { key: 'errors', label: 'Errors', align: 'right', value: (r) => r.errors, render: (r) => fmtCount(r.errors) },
  { key: 'blocked', label: 'Blocked', align: 'right', value: (r) => r.blocked, render: (r) => fmtCount(r.blocked) },
  {
    key: 'budget',
    label: 'Budget / mo',
    align: 'right',
    value: (r) => r.monthlyBudget,
    render: (r) => (r.monthlyBudget === null ? muted('—') : fmtCount(r.monthlyBudget))
  },
  { key: 'pct', label: 'Run-rate', align: 'right', value: (r) => r.pctOfBudget, render: (r) => <BudgetMeter pct={r.pctOfBudget} /> },
  { key: 'peak', label: 'Peak day', align: 'right', value: (r) => r.peakDayPct ?? null, render: (r) => <PeakDay pct={r.peakDayPct} /> },
  { key: 'usd', label: 'Cost', align: 'right', value: (r) => r.usd, render: (r) => fmtUsd(r.usd) }
];

const FIXED_COLUMNS: Column<FixedCostRow>[] = [
  { key: 'service', label: 'Service', value: (r) => r.service, className: 'font-medium' },
  { key: 'plan', label: 'Plan', value: (r) => r.plan },
  { key: 'source', label: 'Source', value: (r) => r.source ?? 'fixed', render: (r) => <SourceBadge source={r.source ?? 'fixed'} /> },
  { key: 'usdMonth', label: '$ / month', align: 'right', value: (r) => r.usdMonth, render: (r) => fmtUsd(r.usdMonth) },
  { key: 'perDay', label: '$ / day', align: 'right', value: (r) => r.usdMonth / 30, render: (r) => fmtUsd(r.usdMonth / 30) },
  { key: 'note', label: 'Note', value: (r) => r.note, className: 'min-w-[240px] text-[var(--ds-muted)]' }
];

const REVENUE_COLUMNS: Column<RevenueTierRow>[] = [
  { key: 'tier', label: 'Tier', value: (r) => r.tier, render: (r) => <span className="font-medium capitalize">{r.tier}</span> },
  { key: 'subscribers', label: 'Paying', align: 'right', value: (r) => r.subscribers, render: (r) => fmtCount(r.subscribers) },
  { key: 'comped', label: 'Comped', align: 'right', value: (r) => r.comped ?? 0, render: (r) => fmtCount(r.comped ?? 0) },
  { key: 'price', label: 'Price / mo', align: 'right', value: (r) => r.priceUsd, render: (r) => fmtUsd(r.priceUsd) },
  { key: 'mrr', label: 'MRR', align: 'right', value: (r) => r.mrrUsd, render: (r) => fmtUsd(r.mrrUsd) }
];

const footerRow = (cells: Array<{ text: React.ReactNode; right?: boolean; span?: number }>) => (
  <tr className="border-t border-[var(--ds-hairline)] bg-[var(--ds-well)] text-xs font-semibold text-[var(--ds-ink)]">
    {cells.map((c, i) => (
      <td key={i} colSpan={c.span} className={`px-3 py-2 ${c.right ? 'text-right tabular-nums' : ''}`}>
        {c.text}
      </td>
    ))}
  </tr>
);

// ─── Sections ─────────────────────────────────────────────────────────────────────────────

const DailyTable: React.FC<{ report: CostCentreReport }> = ({ report }) => {
  const columns: Column<CostCentreReport['daily'][number]>[] = [
    { key: 'day', label: 'Day (UTC)', value: (r) => r.day, render: (r) => fmtDay(r.day) },
    ...[...STACK_ORDER].reverse().map((id) => ({
      key: id,
      label: CATEGORY_SHORT_LABEL[id],
      align: 'right' as const,
      value: (r: CostCentreReport['daily'][number]) => r[id],
      render: (r: CostCentreReport['daily'][number]) => fmtUsd(r[id])
    })),
    {
      key: 'total',
      label: 'Total',
      align: 'right',
      value: (r) => STACK_ORDER.reduce((s, id) => s + r[id], 0),
      render: (r) => <span className="font-semibold">{fmtUsd(STACK_ORDER.reduce((s, id) => s + r[id], 0))}</span>
    }
  ];
  return (
    <SortableTable
      caption="Daily cost by category"
      csvName={`costs-daily-${report.range.days}d`}
      columns={columns}
      rows={[...report.daily].reverse()}
      rowKey={(r) => r.day}
      emptyText="No days in range."
    />
  );
};

const Methodology: React.FC<{ report: CostCentreReport }> = ({ report }) => {
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
          <span className="text-sm font-semibold tracking-tight text-[var(--ds-ink)]">How these numbers are computed</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-[var(--ds-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="space-y-3 border-t border-[var(--ds-hairline-soft)] px-3 py-3 text-xs leading-relaxed text-[var(--ds-ink)]">
          <ul className="space-y-2">
            {report.categories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                <span className="font-semibold">{c.label}</span>
                <SourceBadge source={c.source} />
                <span className="w-full text-[var(--ds-muted)]">{c.note}</span>
              </li>
            ))}
          </ul>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">Definitions</div>
            <ul className="list-disc space-y-1 pl-4 text-[var(--ds-muted)]">
              <li>
                Range: the last {report.range.days} UTC days including today (partial). The trend compares with the {report.range.days} days
                before.
              </li>
              <li>Fixed plan fees (docs/infrastructure/COST_RUNBOOK.md §1) are amortized as monthly ÷ 30 per day.</li>
              <li>
                Active users: distinct signed-in accounts with any recorded activity in the range — telemetry, AI calls, connector calls or
                sandbox runs. Cost per active user = total cost ÷ active users.
              </li>
              <li>
                Revenue: MRR from Stripe-backed active/trialing subscriptions × list price, plus credit packs bought in the range. Revenue is
                not attributed per product.
              </li>
              <li>AI margin = billed to user credits − provider cost, for platform-paid calls only.</li>
              <li>Products: AI calls are attributed by operation prefix (text./image./vision. → Comic Studio; assistant./chat. → Chat).</li>
            </ul>
          </div>
          {report.notes.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">Notes for this range</div>
              <ul className="list-disc space-y-1 pl-4 text-[var(--ds-muted)]">
                {report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Surface>
  );
};

const LoadingSkeleton: React.FC = () => (
  <div className="space-y-4" aria-busy="true" aria-label="Loading costs">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <SkeletonBlock key={i} className="h-[112px]" />
      ))}
    </div>
    <div className="grid gap-3 lg:grid-cols-3">
      <SkeletonBlock className="h-[300px] lg:col-span-2" />
      <SkeletonBlock className="h-[300px]" />
    </div>
    <SkeletonBlock className="h-[240px]" />
  </div>
);

// ─── Main ─────────────────────────────────────────────────────────────────────────────────

export const CostCentre: React.FC = () => {
  const [days, setDays] = useState<CostRangeDays>(readStoredDays);
  const [report, setReport] = useState<CostCentreReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewTab>('Chart');
  const [tab, setTab] = useState<MainTab>('Products');
  const [aiTab, setAiTab] = useState<AiTab>('By model');
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (fresh = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const next = await getCostCentre(days, { fresh, signal: controller.signal });
        if (!controller.signal.aborted) setReport(next);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error && err.message ? err.message : 'Could not load costs.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [days]
  );

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const selectRange = (label: RangeLabel) => {
    const next = LABEL_TO_DAYS[label];
    setDays(next);
    storeDays(next);
  };

  const derived = useMemo(() => {
    if (!report) return null;
    const dailyTotals = report.daily.map((d) => STACK_ORDER.reduce((s, id) => s + d[id], 0));
    const comped = report.revenue.byTier.reduce((s, t) => s + (t.comped || 0), 0);
    const paying = report.revenue.byTier.reduce((s, t) => s + t.subscribers, 0);
    const fixedMonthly = report.fixed.reduce((s, f) => s + f.usdMonth, 0);
    const mrr = report.totals.revenueMrrUsd;
    const monthlyRunRate = (report.totals.costUsd / report.range.days) * 30;
    return { dailyTotals, comped, paying, fixedMonthly, mrr, monthlyRunRate };
  }, [report]);

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-[var(--ds-ink)]">
          <Wallet className="h-4 w-4 text-[var(--ds-muted)]" aria-hidden /> Cost centre
        </h2>
        <p className="text-xs text-[var(--ds-muted)]">What DreamStream costs to run vs what it brings in — every figure labelled measured, estimated or fixed.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {((report?.stream?.alerts.length ?? 0) > 0 || (report?.stream?.errors.length ?? 0) > 0) && (
          <button
            type="button"
            onClick={() => setTab('Stream Studio')}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
            data-testid="stream-alert-badge"
          >
            <TriangleAlert className="h-3.5 w-3.5" style={{ color: report!.stream!.alerts.some((a) => a.severity === 'critical') ? '#d03b3b' : '#fab219' }} aria-hidden />
            {report!.stream!.alerts.length > 0 && `${report!.stream!.alerts.length} Stream Studio ${report!.stream!.alerts.length === 1 ? 'alert' : 'alerts'}`}
            {/* A dataset that didn't answer is not "no alerts": its alerts couldn't be checked. */}
            {report!.stream!.errors.length > 0 && `${report!.stream!.alerts.length > 0 ? ' · ' : 'Stream Studio: '}couldn’t measure ${report!.stream!.errors.length} ${report!.stream!.errors.length === 1 ? 'dataset' : 'datasets'}`}
          </button>
        )}
        <span className="text-[11px] text-[var(--ds-muted)]" aria-live="polite">
          {report ? `As of ${fmtTime(report.generatedAt)}` : loading ? 'Loading…' : ''}
        </span>
        <RangeTabs<RangeLabel> options={RANGE_LABELS} value={DAYS_TO_LABEL[days]} onChange={selectRange} accent={ACCENT} />
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-50"
          aria-label="Refresh costs"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (!report && loading) {
    body = <LoadingSkeleton />;
  } else if (!report || !derived) {
    body = (
      <Surface className="!my-0">
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <TriangleAlert className="h-5 w-5 text-[#d03b3b]" aria-hidden />
          <div className="text-sm font-semibold text-[var(--ds-ink)]">Couldn't load the cost report</div>
          <p className="max-w-md text-xs text-[var(--ds-muted)]">{error || 'The server returned no data.'}</p>
          <button
            type="button"
            onClick={() => void load(true)}
            className="mt-1 rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]"
          >
            Retry
          </button>
        </div>
      </Surface>
    );
  } else {
    const t = report.totals;
    const noAiSpend = t.aiProviderUsd === 0;
    const aiNote = report.ai.byokEvents ? `${fmtCount(report.ai.byokEvents)} ${report.ai.byokEvents === 1 ? 'call' : 'calls'} ran on users' own keys (not platform spend).` : null;
    body = (
      // Refetch keeps the frame: the previous render dims instead of flashing a skeleton.
      <div className={`space-y-4 transition-opacity duration-200 ${loading ? 'opacity-60' : 'opacity-100'}`} aria-busy={loading}>
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-3 py-2 text-xs text-[var(--ds-ink)]" role="alert">
            <TriangleAlert className="h-4 w-4 shrink-0 text-[#d03b3b]" aria-hidden />
            Refresh failed: {error}. Showing the last loaded report.
            <button type="button" onClick={() => void load(true)} className="ml-auto font-semibold text-[#D97757] hover:underline">
              Retry
            </button>
          </div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            testId="kpi-total"
            label={`Total cost · ${report.range.days}d`}
            value={fmtUsd(t.costUsd)}
            delta={<CostDelta pct={pctChange(t.costUsd, t.prevCostUsd)} label={`vs ${fmtUsd(t.prevCostUsd)} prior ${report.range.days}d`} />}
            sub={`≈ ${fmtUsd(derived.monthlyRunRate)}/mo run-rate`}
            spark={derived.dailyTotals}
          />
          <KpiTile
            testId="kpi-ai"
            label="AI spend (provider)"
            value={fmtUsd(t.aiProviderUsd)}
            sub={
              noAiSpend ? (
                <>
                  No AI spend recorded in this period.
                  {aiNote && <span className="block">{aiNote}</span>}
                </>
              ) : (
                <>
                  Billable {fmtUsd(t.aiBillableUsd)} · margin {fmtUsd(t.aiMarginUsd)}
                  {aiNote && <span className="block">{aiNote}</span>}
                </>
              )
            }
          />
          <KpiTile
            testId="kpi-revenue"
            label="Revenue (MRR est.)"
            value={fmtUsd(derived.mrr)}
            suffix="/mo"
            sub={
              <>
                {derived.paying > 0 ? `${fmtCount(derived.paying)} paying subscriber${derived.paying === 1 ? '' : 's'}` : 'No paying subscribers'}
                {derived.comped > 0 ? ` · ${fmtCount(derived.comped)} comped` : ''}
                <span className="block">Credit packs this period: {fmtUsd(t.creditRevenueUsd)}</span>
              </>
            }
          />
          <KpiTile
            testId="kpi-per-user"
            label="Cost per active user"
            value={t.costPerActiveUserUsd === null ? '—' : fmtUsd(t.costPerActiveUserUsd)}
            sub={`${fmtCount(t.activeUsers)} active of ${fmtCount(t.users)} users`}
          />
        </div>

        {/* Daily chart + where it goes */}
        <div className="grid gap-3 lg:grid-cols-3">
          <Surface
            className="!my-0 lg:col-span-2"
            header={
              <div>
                <SurfaceTitle>Daily cost by category</SurfaceTitle>
                <SurfaceSubtitle>UTC days, stacked · hover or focus a day for its breakdown</SurfaceSubtitle>
              </div>
            }
            right={<RangeTabs<ViewTab> options={VIEW_TABS} value={view} onChange={setView} accent={ACCENT} />}
          >
            <div className="px-3 pb-3">{view === 'Chart' ? <StackedDailyChart daily={report.daily} height={250} /> : <DailyTable report={report} />}</div>
          </Surface>
          <Surface
            className="!my-0"
            header={
              <div>
                <SurfaceTitle>Where it goes</SurfaceTitle>
                <SurfaceSubtitle>
                  {fmtUsd(t.costUsd)} over {report.range.days} days · fixed {fmtUsd(derived.fixedMonthly)}/mo
                </SurfaceSubtitle>
              </div>
            }
          >
            <div className="px-3 pb-3">
              <CategoryBreakdown categories={report.categories} />
            </div>
          </Surface>
        </div>

        {/* Detail tables */}
        <Surface
          className="!my-0"
          header={
            <div>
              <SurfaceTitle>Details</SurfaceTitle>
              <SurfaceSubtitle>Click a column to sort · export any table as CSV</SurfaceSubtitle>
            </div>
          }
        >
          <div className="space-y-3 px-3 pb-3">
            <div className="-mx-1 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Detail tables">
              <RangeTabs<MainTab> options={MAIN_TABS} value={tab} onChange={setTab} accent={ACCENT} />
            </div>

            {tab === 'Products' && (
              <SortableTable
                caption="Products cost-benefit"
                csvName={`costs-products-${report.range.days}d`}
                columns={PRODUCT_COLUMNS}
                rows={report.products}
                rowKey={(r) => r.id}
                emptyText="No products to compare."
              />
            )}

            {tab === 'Stream Studio' && <StreamCard stream={report.stream} days={report.range.days} />}

            {tab === 'AI' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <RangeTabs<AiTab> options={AI_TABS} value={aiTab} onChange={setAiTab} accent={ACCENT} />
                  <span className="text-[11px] text-[var(--ds-muted)]">
                    {noAiSpend ? 'No AI spend recorded in this period.' : `${fmtUsd(t.aiProviderUsd)} provider · ${fmtUsd(t.aiBillableUsd)} billable`}
                    {aiNote ? ` ${aiNote}` : ''}
                  </span>
                </div>
                {aiTab === 'By model' && (
                  <SortableTable
                    caption="AI usage by model"
                    csvName={`costs-ai-models-${report.range.days}d`}
                    columns={AI_MODEL_COLUMNS}
                    rows={report.ai.byModel}
                    rowKey={(r) => `${r.provider}/${r.model}`}
                    emptyText="No AI spend recorded in this period."
                    initialSort={{ key: 'providerUsd', dir: 'desc' }}
                  />
                )}
                {aiTab === 'By user' && (
                  <SortableTable
                    caption="AI usage by user"
                    csvName={`costs-ai-users-${report.range.days}d`}
                    columns={AI_USER_COLUMNS}
                    rows={report.ai.topUsers}
                    rowKey={(r) => r.userId}
                    emptyText="No AI spend recorded in this period."
                    initialSort={{ key: 'providerUsd', dir: 'desc' }}
                  />
                )}
                {aiTab === 'By operation' && (
                  <SortableTable
                    caption="AI usage by operation"
                    csvName={`costs-ai-operations-${report.range.days}d`}
                    columns={AI_OPERATION_COLUMNS}
                    rows={report.ai.byOperation}
                    rowKey={(r) => r.operation}
                    emptyText="No AI spend recorded in this period."
                    initialSort={{ key: 'providerUsd', dir: 'desc' }}
                  />
                )}
              </div>
            )}

            {tab === 'Connectors' && (
              <SortableTable
                caption="Data connectors vs budget"
                csvName={`costs-connectors-${report.range.days}d`}
                columns={CONNECTOR_COLUMNS}
                rows={report.connectors}
                rowKey={(r) => r.provider}
                emptyText="No connector calls recorded in this period."
                initialSort={{ key: 'calls', dir: 'desc' }}
              />
            )}

            {tab === 'Fixed costs' && (
              <SortableTable
                caption="Fixed monthly costs"
                csvName="costs-fixed"
                columns={FIXED_COLUMNS}
                rows={report.fixed}
                rowKey={(r) => r.service}
                emptyText="No fixed costs configured."
                footer={footerRow([
                  { text: 'Total', span: 3 },
                  { text: fmtUsd(derived.fixedMonthly), right: true },
                  { text: fmtUsd(derived.fixedMonthly / 30), right: true },
                  { text: '' }
                ])}
              />
            )}

            {tab === 'Revenue' && (
              <div className="space-y-2">
                <SortableTable
                  caption="Revenue by tier"
                  csvName="costs-revenue-tiers"
                  columns={REVENUE_COLUMNS}
                  rows={report.revenue.byTier}
                  rowKey={(r) => r.tier}
                  emptyText="No paid plans configured."
                  footer={footerRow([
                    { text: 'Total' },
                    { text: fmtCount(derived.paying), right: true },
                    { text: fmtCount(derived.comped), right: true },
                    { text: '' },
                    { text: fmtUsd(derived.mrr), right: true }
                  ])}
                />
                <p className="text-[11px] text-[var(--ds-muted)]">
                  Credit packs bought in the last {report.range.days} days: <span className="font-semibold text-[var(--ds-ink)]">{fmtUsd(report.revenue.creditPurchasesUsd)}</span>.
                  Net of running costs at this run-rate: {fmtUsd(derived.mrr - derived.monthlyRunRate)}/mo.
                </p>
              </div>
            )}
          </div>
        </Surface>

        {/* Method + live Cloudflare */}
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <Methodology report={report} />
          <CloudflareCard cloudflare={report.cloudflare} days={report.range.days} />
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-4 p-1 text-[var(--ds-ink)] ${COST_PALETTE_CLASS}`}>
      {header}
      {body}
      {/* Per-user usage budgets ($10 lifetime per user, all studios) — independent of the report above. */}
      <UsageBudgetsPanel />
    </div>
  );
};

export default CostCentre;
