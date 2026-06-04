import React, { useMemo, useState } from 'react';
import { CandlestickChart, LineChart, AreaChart } from 'lucide-react';
import type { StockQuoteArtifact, StockRange, StockPoint, MarketState } from '../../../apiTypes';
import {
  Surface,
  Expandable,
  Chart,
  RangeTabs,
  TrendPill,
  Badge,
  resolveTheme,
  formatPrice,
  formatPercent,
  compactNumber,
  shortDate,
  relativeTime
} from './kit';
import type { ChartVariant, ChartPoint } from './kit';

// Flagship finance card. Replaces the read-only StockCard with an interactive,
// themeable chart: crosshair hover tooltip, a range timeline, area/line/candlestick
// toggle, a key-stats grid, and an expandable fundamentals + headlines drawer.
// Built entirely from the shared kit so it stays on-style and dependency-free.

const RANGE_ORDER: StockRange[] = ['1D', '1W', '1M', '3M', '1Y', '5Y', 'MAX'];
// How many trailing sessions each range approximates when we have to derive it
// from a single `series` (≈ trading days).
const DERIVE: Record<StockRange, number> = { '1D': 2, '1W': 5, '1M': 22, '3M': 66, '1Y': 252, '5Y': 1260, MAX: Infinity };

const MARKET_BADGE: Record<MarketState, { label: string; color: string }> = {
  open: { label: 'Market open', color: '#059669' },
  closed: { label: 'Market closed', color: '#64748b' },
  pre: { label: 'Pre-market', color: '#f59e0b' },
  after: { label: 'After hours', color: '#8b5cf6' }
};

// Resolve which ranges we can actually show, and the points for each. Uses
// pre-bucketed `data.ranges` when present; otherwise slices the flat `series`.
const buildRanges = (data: StockQuoteArtifact): { available: StockRange[]; points: Record<string, StockPoint[]> } => {
  const points: Record<string, StockPoint[]> = {};
  if (data.ranges && Object.keys(data.ranges).length > 0) {
    for (const r of RANGE_ORDER) {
      const series = data.ranges[r];
      if (series && series.length >= 2) points[r] = series;
    }
    return { available: RANGE_ORDER.filter((r) => points[r]), points };
  }
  const series = data.series ?? [];
  if (series.length < 2) return { available: [], points };
  const seenLengths = new Set<number>();
  const available: StockRange[] = [];
  for (const r of RANGE_ORDER) {
    const n = DERIVE[r] === Infinity ? series.length : Math.min(series.length, DERIVE[r]);
    if (n < 2 || seenLengths.has(n)) continue;
    seenLengths.add(n);
    points[r] = series.slice(-n);
    available.push(r);
  }
  return { available, points };
};

const toChartPoints = (series: StockPoint[]): ChartPoint[] =>
  series.map((p) => ({ label: shortDate(p.date), value: p.close }));

const Stat: React.FC<{ label: string; value?: string }> = ({ label, value }) =>
  value ? (
    <span className="text-[11px] text-slate-500">
      {label} <span className="font-bold text-slate-800">{value}</span>
    </span>
  ) : null;

export const MarketCard: React.FC<{ data: StockQuoteArtifact }> = ({ data }) => {
  const theme = resolveTheme({ trend: data.change });
  const currency = data.currency ?? 'USD';

  const { available, points } = useMemo(() => buildRanges(data), [data]);
  const defaultRange: StockRange = available.includes('1M') ? '1M' : available[available.length - 1] ?? 'MAX';
  const [range, setRange] = useState<StockRange>(defaultRange);
  const activeRange = available.includes(range) ? range : defaultRange;

  const hasCandles = Boolean(data.candles && data.candles.length > 1);
  const [variant, setVariant] = useState<ChartVariant>('area');
  const effectiveVariant: ChartVariant = variant === 'candlestick' && !hasCandles ? 'area' : variant;

  const chartPoints = useMemo(() => toChartPoints(points[activeRange] ?? data.series ?? []), [points, activeRange, data.series]);
  const candles = hasCandles
    ? data.candles!.map((c) => ({ label: shortDate(c.date), open: c.open, high: c.high, low: c.low, close: c.close }))
    : undefined;

  const market = data.marketState ? MARKET_BADGE[data.marketState] : null;
  const stats = data.stats;
  const week52 =
    stats && typeof stats.week52Low === 'number' && typeof stats.week52High === 'number'
      ? { low: stats.week52Low, high: stats.week52High }
      : null;
  const week52Pct = week52 && week52.high > week52.low ? ((data.price - week52.low) / (week52.high - week52.low)) * 100 : null;

  const variants: { id: ChartVariant; Icon: typeof AreaChart; show: boolean }[] = [
    { id: 'area', Icon: AreaChart, show: true },
    { id: 'line', Icon: LineChart, show: true },
    { id: 'candlestick', Icon: CandlestickChart, show: hasCandles }
  ];

  return (
    <Surface
      accent={theme.accent}
      header={
        <div className="flex items-center gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-extrabold">{data.name || data.symbol}</div>
            <div className="text-[11px] font-semibold text-slate-500">
              {data.symbol}
              {data.exchange ? ` · ${data.exchange}` : ''}
              {data.asOf ? ` · ${data.asOf}` : ''}
            </div>
          </div>
          {market && <Badge color={market.color}>{market.label}</Badge>}
        </div>
      }
      right={
        <>
          <div className="font-display text-xl leading-none">{formatPrice(data.price, currency)}</div>
          <div className="mt-1 flex justify-end">
            <TrendPill change={data.change} changePercent={data.changePercent} size="sm" />
          </div>
        </>
      }
      footer={
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Stat label="Open" value={data.open != null ? formatPrice(data.open, currency) : undefined} />
          <Stat label="High" value={data.high != null ? formatPrice(data.high, currency) : undefined} />
          <Stat label="Low" value={data.low != null ? formatPrice(data.low, currency) : undefined} />
          <Stat label="Prev" value={data.previousClose != null ? formatPrice(data.previousClose, currency) : undefined} />
          <Stat label="Vol" value={data.volume ? compactNumber(data.volume) : undefined} />
        </div>
      }
    >
      {/* Chart controls */}
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        {available.length > 1 ? (
          <RangeTabs<StockRange> options={available} value={activeRange} accent={theme.accent} onChange={setRange} />
        ) : (
          <span />
        )}
        <div className="inline-flex gap-1">
          {variants
            .filter((v) => v.show)
            .map(({ id, Icon }) => (
              <button
                key={id}
                onClick={() => setVariant(id)}
                aria-pressed={effectiveVariant === id}
                title={id}
                className={`rounded-md border-2 p-1 transition-colors ${
                  effectiveVariant === id ? 'border-black bg-slate-900 text-white' : 'border-black/15 text-slate-500 hover:border-black/40'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
        </div>
      </div>

      {chartPoints.length > 1 && (
        <Chart
          points={chartPoints}
          candles={candles}
          variant={effectiveVariant}
          color={theme.accent}
          up={theme.up}
          down={theme.down}
          baseline={effectiveVariant !== 'candlestick' ? data.previousClose : undefined}
          formatValue={(n) => formatPrice(n, currency)}
          height={140}
        />
      )}

      {/* Expanded fundamentals + headlines */}
      {(stats || (data.headlines && data.headlines.length > 0)) && (
        <Expandable>
          <div className="space-y-3 p-3">
            {stats && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] sm:grid-cols-3">
                <Stat label="Mkt cap" value={stats.marketCap != null ? compactNumber(stats.marketCap) : undefined} />
                <Stat label="P/E" value={stats.peRatio != null ? stats.peRatio.toFixed(1) : undefined} />
                <Stat label="EPS" value={stats.eps != null ? formatPrice(stats.eps, currency) : undefined} />
                <Stat label="Div yield" value={stats.dividendYield != null ? formatPercent(stats.dividendYield) : undefined} />
                <Stat label="Avg vol" value={stats.avgVolume != null ? compactNumber(stats.avgVolume) : undefined} />
                <Stat label="Beta" value={stats.beta != null ? stats.beta.toFixed(2) : undefined} />
              </div>
            )}

            {week52 && week52Pct != null && (
              <div>
                <div className="mb-1 flex justify-between text-[10px] font-bold uppercase text-slate-400">
                  <span>52-wk low {formatPrice(week52.low, currency)}</span>
                  <span>52-wk high {formatPrice(week52.high, currency)}</span>
                </div>
                <div className="relative h-1.5 rounded-full bg-slate-200">
                  <div
                    className="absolute -top-1 h-3.5 w-1.5 -translate-x-1/2 rounded-full border border-white"
                    style={{ left: `${Math.min(100, Math.max(0, week52Pct))}%`, backgroundColor: theme.accent }}
                  />
                </div>
              </div>
            )}

            {data.headlines && data.headlines.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-bold uppercase text-slate-400">Latest headlines</div>
                {data.headlines.slice(0, 3).map((h) => (
                  <a
                    key={h.url}
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs font-semibold text-slate-700 hover:text-blue-600"
                  >
                    {h.title}
                    {(h.source || h.publishedAt) && (
                      <span className="ml-1 font-normal text-slate-400">
                        · {h.source}
                        {h.publishedAt ? ` · ${relativeTime(h.publishedAt)}` : ''}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            )}
          </div>
        </Expandable>
      )}
    </Surface>
  );
};
