import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import type { CurrencyConverterArtifact } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  Sparkline,
  useCompact,
  useLiveData,
  withAlpha,
  BULL,
  BEAR,
  NEUTRAL,
  relativeTime,
  shortDate,
  formatPercent
} from './kit';

// Live FX converter — ECB rate, client-side math, 30-day context.
//  • detailed — an amount input (calm recessed field) ⇄ swap button → the converted
//    result LARGE, the unit-rate line ("1 USD = 83.2 INR · ECB Jun 9"), a 30-day
//    sparkline and a verdict chip (above/below/near the 30-day average — bull tint
//    when the displayed rate buys more than usual). Swap re-runs the producing tool
//    when live, otherwise inverts the rate + series locally.
//  • compact — "1 USD = 83.2 INR" + a tiny sparkline + a verdict dot.

const SPARK_COLOR = '#0ea5e9';

/** Rate-appropriate decimals: 83.21, 0.0120. */
const fmtRate = (r: number): string =>
  r >= 1
    ? r.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : r.toLocaleString(undefined, { maximumFractionDigits: 4 });

export const CurrencyConverter: React.FC<{ data: CurrencyConverterArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const [amountStr, setAmountStr] = useState(() => String(data.amount ?? 1));
  // Local fallback when the live context can't re-run the tool: invert client-side.
  const [swapped, setSwapped] = useState(false);

  // Keep "Updated Xm ago" honest without a model round-trip.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live.asOf) return;
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [live.asOf]);

  const view = useMemo(() => {
    const series = (data.series ?? []).filter(
      (p) => typeof p?.rate === 'number' && Number.isFinite(p.rate) && p.rate > 0
    );
    if (!swapped) {
      const rates = series.map((p) => p.rate);
      const avg = data.avg30d ?? (rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : undefined);
      const vsAvg =
        typeof data.vsAvgPct === 'number'
          ? data.vsAvgPct
          : avg
            ? ((data.rate - avg) / avg) * 100
            : undefined;
      return { from: data.from, to: data.to, rate: data.rate, rates, vsAvg };
    }
    const rate = 1 / data.rate;
    const rates = series.map((p) => 1 / p.rate);
    const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : data.avg30d ? 1 / data.avg30d : undefined;
    const vsAvg = avg ? ((rate - avg) / avg) * 100 : undefined;
    return { from: data.to, to: data.from, rate, rates, vsAvg };
  }, [data, swapped]);

  if (typeof data.rate !== 'number' || !Number.isFinite(data.rate) || data.rate <= 0) return null;

  const amount = parseFloat(amountStr);
  const validAmount = Number.isFinite(amount) && amount >= 0;
  const converted = validAmount ? amount * view.rate : undefined;

  const verdict =
    typeof view.vsAvg === 'number'
      ? view.vsAvg > 0.5
        ? { color: BULL, label: `Above 30-day avg (${formatPercent(view.vsAvg, 1)}) — good time to convert` }
        : view.vsAvg < -0.5
          ? { color: BEAR, label: `Below 30-day avg (${formatPercent(view.vsAvg, 1)})` }
          : { color: NEUTRAL, label: 'Near 30-day average' }
      : null;

  const rateLine = [`1 ${view.from} = ${fmtRate(view.rate)} ${view.to}`, data.date ? `ECB ${shortDate(data.date)}` : null]
    .filter(Boolean)
    .join(' · ');

  const updated = live.asOf ? `Updated ${relativeTime(live.asOf)}` : data.date ? shortDate(data.date) : '';

  const onSwap = () => {
    if (live.canRefresh) void live.refresh({ from: data.to, to: data.from });
    else setSwapped((v) => !v);
  };

  // ── Compact: rate one-liner + tiny sparkline + verdict dot. ──────────────────
  if (compact) {
    return (
      <Surface accent={SPARK_COLOR}>
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[var(--ds-ink)]">{rateLine.split(' · ')[0]}</span>
          {view.rates.length >= 2 && (
            <span className="w-20 shrink-0">
              <Sparkline values={view.rates} color={SPARK_COLOR} width={80} height={22} />
            </span>
          )}
          {verdict && (
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              title={verdict.label}
              style={{ backgroundColor: verdict.color }}
            />
          )}
        </div>
      </Surface>
    );
  }

  // ── Detailed: input ⇄ result, rate line, 30-day sparkline + verdict. ─────────
  return (
    <Surface
      accent={SPARK_COLOR}
      header={
        <>
          <SurfaceTitle>
            {view.from} → {view.to}
          </SurfaceTitle>
          <SurfaceSubtitle>Currency converter</SurfaceSubtitle>
        </>
      }
      right={updated ? <span className="text-[10px] text-[var(--ds-muted)]">{updated}</span> : undefined}
    >
      <div className="px-3 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              aria-label={`Amount in ${view.from}`}
              className="w-28 rounded-lg bg-[var(--ds-well)] px-2 py-1.5 text-right text-sm font-semibold tabular-nums text-[var(--ds-ink)] focus:outline-none focus:ring-2 focus:ring-[#0ea5e9]/40"
            />
            <span className="text-[11px] font-semibold text-[var(--ds-muted)]">{view.from}</span>
          </label>

          <button
            onClick={onSwap}
            disabled={live.refreshing}
            title="Swap currencies"
            aria-label="Swap currencies"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:cursor-default disabled:opacity-60"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
          </button>

          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)] ${live.refreshing ? 'animate-pulse opacity-50' : ''}`}>
              {typeof converted === 'number'
                ? converted.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '—'}
            </span>
            <span className="text-[11px] font-semibold text-[var(--ds-muted)]">{view.to}</span>
          </span>
        </div>

        <p className="mt-1.5 text-[11px] tabular-nums text-[var(--ds-muted)]">{rateLine}</p>

        {view.rates.length >= 2 && (
          <div className="mt-2">
            <Sparkline values={view.rates} color={SPARK_COLOR} height={44} />
          </div>
        )}

        {verdict && (
          <div className="mt-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ color: verdict.color, backgroundColor: withAlpha(verdict.color, 0.1) }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: verdict.color }} />
              {verdict.label}
            </span>
          </div>
        )}
      </div>
    </Surface>
  );
};
