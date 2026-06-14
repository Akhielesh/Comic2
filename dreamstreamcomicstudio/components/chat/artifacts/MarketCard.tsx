import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickChart, LineChart, AreaChart } from 'lucide-react';
import type { StockQuoteArtifact, StockRange, StockPoint, MarketState } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  Expandable,
  Chart,
  Sparkline,
  RangeTabs,
  TrendPill,
  Badge,
  SymbolLogo,
  resolveTheme,
  withAlpha,
  formatPrice,
  formatPercent,
  compactNumber,
  shortDate,
  relativeTime,
  useCompact,
  BULL,
  BEAR
} from './kit';
import type { ChartVariant, ChartPoint } from './kit';

// Flagship finance card in the calm-studio glass language. Two densities:
// - compact: name/symbol + price + trend pill + one sparkline (a glance card)
// - detailed: a chart region that FLEXES to fill whatever height the card is given
//   (drag-resize, expanded lightbox), with crosshair, range timeline and an
//   area/line/candlestick toggle; key-stats footer; fundamentals + headlines drawer.
//   The price tick-pulses green/red when a live refresh moves it, and range-tab
//   switches morph the chart instead of snapping.

const RANGE_ORDER: StockRange[] = ['1D', '5D', '1M', '6M', '1Y', '5Y', 'MAX'];
// How many trailing sessions each range approximates when we have to derive it
// from a single `series` (≈ trading days).
const DERIVE: Record<StockRange, number> = { '1D': 2, '5D': 5, '1M': 22, '6M': 126, '1Y': 252, '5Y': 1260, MAX: Infinity };

// Intraday points carry a full ISO timestamp → label with the time; daily points
// carry a YYYY-MM-DD date → label with a short date.
const pointLabel = (value: string): string =>
  /T\d\d:/.test(value) ? new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : shortDate(value);

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
  series.map((p) => ({ label: pointLabel(p.date), value: p.close }));

const Stat: React.FC<{ label: string; value?: string }> = ({ label, value }) =>
  value ? (
    <span className="text-[11px] text-[var(--ds-muted)]">
      {label} <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{value}</span>
    </span>
  ) : null;

/**
 * The headline price with a tick pulse: when a live refresh moves the value, the
 * number flashes bull/bear (color + a faint tint behind it) and calmly fades back.
 */
const TickPrice: React.FC<{ value: number; formatted: string; className?: string }> = ({ value, formatted, className = '' }) => {
  const prevRef = useRef(value);
  const [pulse, setPulse] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (prevRef.current === value) return;
    const dir: 'up' | 'down' = value > prevRef.current ? 'up' : 'down';
    prevRef.current = value;
    setPulse(dir);
    const t = window.setTimeout(() => setPulse(null), 1100);
    return () => window.clearTimeout(t);
  }, [value]);
  const pulseColor = pulse === 'up' ? BULL : BEAR;
  return (
    <span
      className={`-mx-1 inline-block rounded-md px-1 font-semibold tracking-tight tabular-nums leading-none text-[var(--ds-ink)] ${className}`}
      style={{
        color: pulse ? pulseColor : undefined,
        backgroundColor: pulse ? withAlpha(pulseColor, 0.12) : 'transparent',
        transition: pulse
          ? 'color 120ms ease-out, background-color 120ms ease-out'
          : 'color 700ms ease, background-color 700ms ease'
      }}
    >
      {formatted}
    </span>
  );
};

export const MarketCard: React.FC<{ data: StockQuoteArtifact }> = ({ data }) => {
  const compact = useCompact();
  const theme = resolveTheme({ trend: data.change });
  const currency = data.currency ?? 'USD';

  const { available, points } = useMemo(() => buildRanges(data), [data]);
  const defaultRange: StockRange = available.includes('1D') ? '1D' : available.includes('1M') ? '1M' : available[available.length - 1] ?? 'MAX';
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

  // ── Compact: a glance card — headline price + trend + one sparkline. ──
  if (compact) {
    const sparkValues = (points[defaultRange] ?? data.series ?? []).map((p) => p.close);
    return (
      <Surface
        accent={theme.accent}
        header={
          <span className="flex min-w-0 items-center gap-2">
            <SymbolLogo symbol={data.symbol} name={data.name} size={30} />
            <span className="min-w-0">
              <SurfaceTitle>{data.name || data.symbol}</SurfaceTitle>
              <SurfaceSubtitle>
                {data.symbol}
                {data.exchange ? ` · ${data.exchange}` : ''}
                {market ? ` · ${market.label}` : ''}
              </SurfaceSubtitle>
            </span>
          </span>
        }
        right={
          <>
            <div className="text-xl leading-none">
              <TickPrice value={data.price} formatted={formatPrice(data.price, currency)} />
            </div>
            <div className="mt-1 flex justify-end">
              <TrendPill change={data.change} changePercent={data.changePercent} size="sm" />
            </div>
          </>
        }
      >
        {sparkValues.length > 1 && (
          <div className="px-3 pb-2.5">
            <Sparkline values={sparkValues} color={theme.accent} height={44} direction={data.change >= 0 ? 'up' : 'down'} />
          </div>
        )}
      </Surface>
    );
  }

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
      className="flex min-h-[calc(100%-1rem)] flex-col"
      header={
        <div className="flex items-center gap-2">
          <SymbolLogo symbol={data.symbol} name={data.name} size={40} />
          <div className="min-w-0">
            <SurfaceTitle>{data.name || data.symbol}</SurfaceTitle>
            <SurfaceSubtitle>
              {data.symbol}
              {data.exchange ? ` · ${data.exchange}` : ''}
              {data.asOf ? ` · ${data.asOf}` : ''}
            </SurfaceSubtitle>
          </div>
          {market && <Badge color={market.color}>{market.label}</Badge>}
        </div>
      }
      right={
        <>
          <div className="text-2xl leading-none">
            <TickPrice value={data.price} formatted={formatPrice(data.price, currency)} />
          </div>
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
        <div className="inline-flex rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5">
          {variants
            .filter((v) => v.show)
            .map(({ id, Icon }) => (
              <button
                key={id}
                onClick={() => setVariant(id)}
                aria-pressed={effectiveVariant === id}
                title={id}
                className={`rounded-md p-1 transition-all duration-200 ${
                  effectiveVariant === id
                    ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
                    : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
        </div>
      </div>

      {/* The chart region flexes: in normal chat flow it sizes by width (≈ a third of
          the card width, capped), and when the card is stretched taller — drag-resize
          or the expanded lightbox — it absorbs the extra height into a BIG chart. */}
      {chartPoints.length > 1 && (
        <div className="relative grow">
          <Chart
            points={chartPoints}
            candles={candles}
            variant={effectiveVariant}
            color={theme.accent}
            up={theme.up}
            down={theme.down}
            baseline={effectiveVariant !== 'candlestick' ? data.previousClose : undefined}
            formatValue={(n) => formatPrice(n, currency)}
            height={150}
            aspect={0.34}
            maxHeight={420}
          />
        </div>
      )}

      {/* Expanded fundamentals + headlines + peers */}
      {(stats || (data.headlines && data.headlines.length > 0) || (data.related && data.related.length > 0)) && (
        <Expandable defaultOpen>
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
                <div className="mb-1 flex justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
                  <span>52-wk low {formatPrice(week52.low, currency)}</span>
                  <span>52-wk high {formatPrice(week52.high, currency)}</span>
                </div>
                <div className="relative h-1.5 rounded-full bg-[var(--ds-well-strong)]">
                  <div
                    className="absolute -top-1 h-3.5 w-1.5 -translate-x-1/2 rounded-full border border-[var(--ds-canvas)]"
                    style={{ left: `${Math.min(100, Math.max(0, week52Pct))}%`, backgroundColor: theme.accent }}
                  />
                </div>
              </div>
            )}

            {data.headlines && data.headlines.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Latest headlines</div>
                {data.headlines.slice(0, 3).map((h) => (
                  <a
                    key={h.url}
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs font-medium text-[var(--ds-ink)] transition-colors duration-200 hover:text-[var(--ds-accent)]"
                  >
                    {h.title}
                    {(h.source || h.publishedAt) && (
                      <span className="ml-1 font-normal text-[var(--ds-muted)]">
                        · {h.source}
                        {h.publishedAt ? ` · ${relativeTime(h.publishedAt)}` : ''}
                      </span>
                    )}
                  </a>
                ))}
              </div>
            )}

            {data.related && data.related.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Related</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {data.related.slice(0, 4).map((p) => {
                    const pos = (p.changePercent ?? 0) >= 0;
                    return (
                      <div key={p.symbol} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--ds-well)] px-2 py-1">
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-semibold text-[var(--ds-ink)]">{p.name || p.symbol}</div>
                          <div className="text-[10px] text-[var(--ds-muted)]">{p.symbol}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">
                            {p.price != null ? formatPrice(p.price, p.currency || currency) : '—'}
                          </div>
                          {p.changePercent != null && (
                            <div className={`text-[10px] font-semibold tabular-nums ${pos ? 'text-emerald-600' : 'text-red-600'}`}>
                              {formatPercent(p.changePercent)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </Expandable>
      )}
    </Surface>
  );
};
