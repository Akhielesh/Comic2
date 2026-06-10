import React from 'react';
import { Minus, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import type { TripBudgetArtifact } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  LinearGauge,
  formatPrice,
  shortDate,
  useCompact,
  BULL,
  BEAR,
  NEUTRAL
} from './kit';

// Trip budget burn gauge — pace math runs client-side from dates + spend.
//  • detailed — "$1,240 / $3,000" header (spent tinted by verdict), a banded fuel
//    gauge (green→amber→red), the pace verdict ("At this pace you'll exceed budget
//    by day 9"), per-category mini gauges (over-budget rows tinted red) and a
//    "Day 4 of 10 · 40% of time, 41% of budget" time-vs-money line.
//  • compact — "$1,240 / $3,000 · on pace" + the fuel gauge.

const DAY_MS = 86_400_000;
const AMBER = '#f59e0b';
const CATEGORY_ACCENT = '#0ea5e9';

interface Verdict {
  color: string;
  /** Full sentence for the detailed view. */
  line: string;
  /** Lowercase fragment for the compact one-liner. */
  short: string;
  icon: React.ElementType;
}

export const TripBudget: React.FC<{ data: TripBudgetArtifact }> = ({ data }) => {
  const compact = useCompact();

  const total = data.total;
  const spent = data.spent;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  if (typeof spent !== 'number' || !Number.isFinite(spent)) return null;

  const currency = data.currency ?? 'USD';
  const pct = spent / total;

  // ── Pace math: only meaningful while the trip dates bracket "now". ───────────
  const start = data.startDate ? new Date(data.startDate).getTime() : NaN;
  const end = data.endDate ? new Date(data.endDate).getTime() : NaN;
  const now = Date.now();
  const datesKnown = Number.isFinite(start) && Number.isFinite(end) && end > start && now >= start && now <= end;
  const totalDays = datesKnown ? Math.max(1, Math.round((end - start) / DAY_MS)) : undefined;
  const elapsedDays = datesKnown ? Math.max(0.5, (now - start) / DAY_MS) : undefined;
  const dailyBurn = elapsedDays ? spent / elapsedDays : undefined;
  const projected = dailyBurn !== undefined && totalDays !== undefined ? dailyBurn * totalDays : undefined;

  let verdict: Verdict;
  if (projected !== undefined && dailyBurn !== undefined && dailyBurn > 0 && projected > total * 1.05) {
    const exceedDay = Math.ceil(total / dailyBurn);
    verdict = {
      color: BEAR,
      line: `At this pace you'll exceed budget by day ${exceedDay}`,
      short: 'over pace',
      icon: TrendingUp
    };
  } else if (projected !== undefined && projected < total * 0.9) {
    verdict = { color: BULL, line: 'Under pace — on track', short: 'under pace', icon: TrendingDown };
  } else if (projected !== undefined) {
    verdict = { color: NEUTRAL, line: 'On pace', short: 'on pace', icon: Minus };
  } else if (spent > total) {
    verdict = { color: BEAR, line: 'Over budget', short: 'over budget', icon: TrendingUp };
  } else {
    verdict = {
      color: NEUTRAL,
      line: `${formatPrice(total - spent, currency)} remaining`,
      short: `${formatPrice(total - spent, currency)} left`,
      icon: Minus
    };
  }

  const gauge = (
    <LinearGauge
      value={spent}
      max={total}
      height={10}
      bands={[
        { to: 0.7, color: BULL },
        { to: 0.9, color: AMBER },
        { to: 1, color: BEAR }
      ]}
    />
  );
  const spentLine = (
    <span className="text-sm font-semibold tabular-nums">
      <span style={{ color: verdict.color }}>{formatPrice(spent, currency)}</span>
      <span className="font-normal text-[var(--ds-muted)]"> / {formatPrice(total, currency)}</span>
    </span>
  );

  // ── Compact: "$1,240 / $3,000 · on pace" + the gauge. ────────────────────────
  if (compact) {
    return (
      <Surface>
        <div className="space-y-1.5 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Wallet className="h-3.5 w-3.5 shrink-0" style={{ color: verdict.color }} />
            <span className="min-w-0 flex-1 truncate text-[13px]">
              {spentLine}
              <span className="text-[var(--ds-muted)]"> · {verdict.short}</span>
            </span>
          </div>
          {gauge}
        </div>
      </Surface>
    );
  }

  // ── Detailed: fuel gauge + verdict + categories + time-vs-money. ─────────────
  const dateRange = [data.startDate && shortDate(data.startDate), data.endDate && shortDate(data.endDate)]
    .filter(Boolean)
    .join(' – ');
  const VerdictIcon = verdict.icon;

  const categories = data.categories ?? [];
  // Categories without an explicit budget share whatever the explicit ones leave over.
  const explicitBudget = categories.reduce((n, c) => n + (typeof c.budget === 'number' ? c.budget : 0), 0);
  const unbudgeted = categories.filter((c) => typeof c.budget !== 'number').length;
  const inferredShare = unbudgeted > 0 ? Math.max(0, total - explicitBudget) / unbudgeted : 0;

  const dayN = totalDays !== undefined && elapsedDays !== undefined ? Math.min(totalDays, Math.floor(elapsedDays) + 1) : undefined;
  const timePct = totalDays !== undefined && elapsedDays !== undefined ? Math.round((elapsedDays / totalDays) * 100) : undefined;

  return (
    <Surface
      header={
        <div className="flex min-w-0 items-center gap-2">
          <Wallet className="h-4 w-4 shrink-0" style={{ color: verdict.color }} />
          <div className="min-w-0">
            <SurfaceTitle>{data.title ?? 'Trip budget'}</SurfaceTitle>
            {dateRange && <SurfaceSubtitle>{dateRange}</SurfaceSubtitle>}
          </div>
        </div>
      }
      right={spentLine}
    >
      <div className="space-y-2.5 px-3 pb-3 pt-0.5">
        <div>
          {gauge}
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold" style={{ color: verdict.color }}>
            <VerdictIcon className="h-3 w-3 shrink-0" />
            {verdict.line}
          </p>
        </div>

        {categories.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">By category</p>
            {categories.map((cat, i) => {
              const budget = typeof cat.budget === 'number' ? cat.budget : inferredShare;
              const over = budget > 0 && cat.spent > budget;
              return (
                <div key={`${cat.label}-${i}`} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 truncate text-[11px] text-[var(--ds-ink)]">{cat.label}</span>
                  <div className="min-w-0 flex-1">
                    <LinearGauge value={cat.spent} max={budget || cat.spent || 1} height={5} color={over ? BEAR : CATEGORY_ACCENT} />
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums">
                    <span className={over ? 'font-semibold' : 'text-[var(--ds-ink)]'} style={over ? { color: BEAR } : undefined}>
                      {formatPrice(cat.spent, currency)}
                    </span>
                    {budget > 0 && <span className="text-[var(--ds-muted)]">/{formatPrice(budget, currency)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {dayN !== undefined && timePct !== undefined && (
          <p className="text-[11px] tabular-nums text-[var(--ds-muted)]">
            Day {dayN} of {totalDays} · {timePct}% of time, {Math.round(pct * 100)}% of budget
          </p>
        )}
      </div>
    </Surface>
  );
};
