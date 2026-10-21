import React from 'react';
import { ArrowDownRight, ArrowUpRight, Calculator, Gauge, Lock, Minus, OctagonAlert, TriangleAlert } from 'lucide-react';
import { Badge, BEAR, BULL, NEUTRAL, Sparkline } from '../../chat/artifacts/kit';
import type { CostCategory, CostSource } from '../../../shared/types/costCentre';
import { CATEGORY_COLOR, STATUS } from './costPalette';
import { fmtPct, fmtUsd } from './costFormat';

// Small, calm-studio building blocks for the cost centre (tokens only, no comic styles).

// ─── Provenance badge ─────────────────────────────────────────────────────────────────────
// Icon + word, never color alone: measured (a gauge read), estimated (calculated), fixed (locked fee).
const SOURCE_META: Record<CostSource, { label: string; title: string; Icon: typeof Gauge }> = {
  measured: { label: 'Measured', title: 'Summed from rows the platform recorded', Icon: Gauge },
  estimated: { label: 'Estimated', title: 'Derived from usage × documented unit prices and assumptions', Icon: Calculator },
  fixed: { label: 'Fixed', title: 'Flat plan fee, amortized per day (monthly ÷ 30)', Icon: Lock }
};

export const SourceBadge: React.FC<{ source: CostSource }> = ({ source }) => {
  const meta = SOURCE_META[source];
  return (
    <Badge color="var(--ds-muted)" title={meta.title}>
      <meta.Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
};

// ─── Cost delta (up is BAD for costs) ─────────────────────────────────────────────────────
// The kit TrendPill colors "up" green, which is right for prices but wrong for spend, so the
// cost tile carries its own pill: direction × "is up good?" → color, always with an arrow + text.
export const CostDelta: React.FC<{ pct: number | null; upIsGood?: boolean; label: string }> = ({ pct, upIsGood = false, label }) => {
  if (pct === null) {
    return <span className="text-[11px] text-[var(--ds-muted)]">No prior-period baseline</span>;
  }
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const good = flat ? null : up === upIsGood;
  const color = good === null ? NEUTRAL : good ? BULL : BEAR;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-[11px]">
      <span
        className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold"
        style={{ color, backgroundColor: `${color}1a` }}
      >
        <Icon className="h-3 w-3" aria-hidden />
        {flat ? 'flat' : `${up ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`}
      </span>
      <span className="text-[var(--ds-muted)]">{label}</span>
    </span>
  );
};

// ─── KPI tile (stat-tile contract: label · value · delta · optional trend) ─────────────────
export const KpiTile: React.FC<{
  label: string;
  value: string;
  suffix?: string;
  delta?: React.ReactNode;
  sub?: React.ReactNode;
  spark?: number[];
  testId?: string;
}> = ({ label, value, suffix, delta, sub, spark, testId }) => (
  <div
    className="flex min-w-0 flex-col gap-1 rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface)] p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur-md"
    data-testid={testId}
  >
    <div className="text-[11px] font-medium text-[var(--ds-muted)]">{label}</div>
    {/* Proportional figures for a standalone value (tabular-nums only in columns). */}
    <div className="truncate text-2xl font-semibold tracking-tight text-[var(--ds-ink)]">
      {value}
      {suffix && <span className="ml-0.5 text-sm font-medium text-[var(--ds-muted)]">{suffix}</span>}
    </div>
    {delta}
    {sub && <div className="text-[11px] leading-snug text-[var(--ds-muted)]">{sub}</div>}
    {spark && spark.length > 1 && spark.some((v) => v !== spark[0]) && (
      <div className="mt-auto pt-1">
        <Sparkline values={spark} color="#898781" height={26} fill={false} />
      </div>
    )}
  </div>
);

// ─── Budget meter (fill carries severity; track is a lighter step of the same hue) ────────
export const BudgetMeter: React.FC<{ pct: number | null }> = ({ pct }) => {
  if (pct === null) return <span className="text-[var(--ds-muted)]">no budget</span>;
  const fill = pct >= 100 ? STATUS.critical : pct >= 80 ? STATUS.warning : 'var(--cc-ai)';
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span
        className="relative inline-block h-1.5 w-16 overflow-hidden rounded-sm"
        style={{ background: `color-mix(in srgb, ${fill} 20%, transparent)` }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(100, pct))}
        aria-label="Monthly run-rate vs budget"
      >
        <span className="absolute inset-y-0 left-0 rounded-r-[3px]" style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%`, background: fill }} />
      </span>
      <span className="w-12 tabular-nums">{fmtPct(pct, pct < 10 ? 1 : 0)}</span>
    </span>
  );
};

/** Peak-day % with a status icon + word once it nears the per-day cap. */
export const PeakDay: React.FC<{ pct: number | null | undefined }> = ({ pct }) => {
  if (pct === null || pct === undefined) return <span className="text-[var(--ds-muted)]">—</span>;
  if (pct >= 100) {
    return (
      <span className="inline-flex items-center gap-1">
        <OctagonAlert className="h-3.5 w-3.5" style={{ color: STATUS.critical }} aria-hidden />
        {fmtPct(pct)} <span className="text-[var(--ds-muted)]">at cap</span>
      </span>
    );
  }
  if (pct >= 80) {
    return (
      <span className="inline-flex items-center gap-1">
        <TriangleAlert className="h-3.5 w-3.5" style={{ color: STATUS.warning }} aria-hidden />
        {fmtPct(pct)} <span className="text-[var(--ds-muted)]">near cap</span>
      </span>
    );
  }
  return <span>{fmtPct(pct)}</span>;
};

// ─── Category breakdown: horizontal bars, colored by entity (same as the chart) ───────────
export const CategoryBreakdown: React.FC<{ categories: CostCategory[] }> = ({ categories }) => {
  const total = categories.reduce((s, c) => s + c.usd, 0);
  const max = Math.max(0, ...categories.map((c) => c.usd));
  const ordered = [...categories].sort((a, b) => b.usd - a.usd);
  return (
    <ul className="space-y-3" aria-label="Cost by category">
      {ordered.map((c) => {
        const share = total > 0 ? (c.usd / total) * 100 : 0;
        return (
          <li key={c.id} title={c.note}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: CATEGORY_COLOR[c.id] }} aria-hidden />
                <span className="truncate text-xs font-medium text-[var(--ds-ink)]">{c.label}</span>
                <SourceBadge source={c.source} />
              </span>
              <span className="shrink-0 text-xs tabular-nums">
                <span className="font-semibold text-[var(--ds-ink)]">{fmtUsd(c.usd)}</span>
                <span className="ml-1.5 inline-block w-10 text-right text-[var(--ds-muted)]">{fmtPct(share, share > 0 && share < 1 ? 1 : 0)}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-sm bg-[var(--ds-well-strong)]">
              <div
                className="h-2 rounded-r-[4px] transition-[width] duration-500 ease-out"
                style={{ width: `${max > 0 ? Math.max(c.usd > 0 ? 1.5 : 0, (c.usd / max) * 100) : 0}%`, background: CATEGORY_COLOR[c.id] }}
              />
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[var(--ds-muted)]">{c.note}</p>
          </li>
        );
      })}
    </ul>
  );
};

// ─── Loading skeleton (first load only — refetches keep the frame) ────────────────────────
export const SkeletonBlock: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded-2xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well-strong)] ${className}`} />
);
