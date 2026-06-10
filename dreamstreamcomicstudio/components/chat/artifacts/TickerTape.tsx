import React, { useId } from 'react';
import type { TickerTapeArtifact, TickerTapeItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Sparkline, formatPrice, formatPercent, relativeTime, useCompact, useLiveData, BULL, BEAR, NEUTRAL } from './kit';

// Live ticker tape — the classic "infinite marquee ribbon", calm-studio edition.
//  • detailed — a continuously left-scrolling strip of quote chips (symbol · price ·
//    signed % · mini sparkline) over a divided list of the same quotes, so the data
//    is readable even while the ribbon is moving. The marquee pauses on hover and,
//    under prefers-reduced-motion, collapses to a static wrapped grid.
//  • compact — no marquee at all: the three biggest absolute movers as glance rows.
// The marquee is a CSS keyframes loop (transform only, 60fps): the chip row is
// rendered twice and translated by -50%, so the wrap point is seamless.

const trendColor = (changePercent?: number): string =>
  typeof changePercent === 'number' && changePercent > 0 ? BULL : typeof changePercent === 'number' && changePercent < 0 ? BEAR : NEUTRAL;

/** One marquee chip: symbol · price · signed % · 40px sparkline. */
const QuoteChip: React.FC<{ item: TickerTapeItem }> = ({ item }) => {
  const color = trendColor(item.changePercent);
  return (
    <span className="flex shrink-0 items-center gap-2 border-r border-[var(--ds-hairline-soft)] px-3 py-2">
      <span className="text-[11px] font-semibold text-[var(--ds-ink)]">{item.symbol}</span>
      <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">{formatPrice(item.price, item.currency ?? 'USD')}</span>
      <span className="text-[11px] font-semibold tabular-nums" style={{ color }}>{formatPercent(item.changePercent)}</span>
      {item.spark && item.spark.length > 1 && (
        <span className="w-10 shrink-0">
          <Sparkline values={item.spark} color={color} width={40} height={14} fill={false} />
        </span>
      )}
    </span>
  );
};

export const TickerTape: React.FC<{ data: TickerTapeArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const uid = useId().replace(/:/g, '');
  const items = data.items ?? [];
  if (!items.length) return null;

  const updated = relativeTime(live.asOf ?? data.asOf);
  const header = <SurfaceTitle>{data.title ?? 'Markets'}</SurfaceTitle>;
  const headerRight = updated ? <SurfaceSubtitle>Updated {updated}</SurfaceSubtitle> : undefined;

  // ── Compact: the 3 biggest absolute movers, no marquee, no controls. ─────────
  if (compact) {
    const movers = [...items]
      .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0))
      .slice(0, 3);
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {movers.map((it, i) => (
            <div key={`${it.symbol}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">{it.symbol}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--ds-ink)]">{formatPrice(it.price, it.currency ?? 'USD')}</span>
              <span className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums" style={{ color: trendColor(it.changePercent) }}>
                {formatPercent(it.changePercent)}
              </span>
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: marquee ribbon + static divided list. ──────────────────────────
  const cls = `tt-${uid}`;
  // Scroll speed scales with the number of chips so density doesn't change pace.
  const durationS = Math.max(18, items.length * 4);
  const css = `
@keyframes ${cls}-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.${cls} .${cls}-track { animation: ${cls}-scroll ${durationS}s linear infinite; }
.${cls}:hover .${cls}-track { animation-play-state: paused; }
.${cls}-static { display: none; }
@media (prefers-reduced-motion: reduce) {
  .${cls} { display: none; }
  .${cls}-static { display: flex; }
}`;

  return (
    <Surface header={header} right={headerRight}>
      <style>{css}</style>

      {/* Marquee ribbon — duplicated chip row, translated by -50% for a seamless loop. */}
      <div
        className={`${cls} overflow-hidden border-y border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]`}
        style={{
          maskImage: 'linear-gradient(to right, transparent, black 20px, black calc(100% - 20px), transparent)',
          WebkitMaskImage: 'linear-gradient(to right, transparent, black 20px, black calc(100% - 20px), transparent)'
        }}
      >
        <div className={`${cls}-track flex w-max`}>
          <div className="flex">
            {items.map((it, i) => <QuoteChip key={`a-${it.symbol}-${i}`} item={it} />)}
          </div>
          <div className="flex" aria-hidden="true">
            {items.map((it, i) => <QuoteChip key={`b-${it.symbol}-${i}`} item={it} />)}
          </div>
        </div>
      </div>
      {/* Reduced-motion fallback: the same chips as a static wrapped grid. */}
      <div className={`${cls}-static flex-wrap border-y border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]`}>
        {items.map((it, i) => <QuoteChip key={`s-${it.symbol}-${i}`} item={it} />)}
      </div>

      {/* The same quotes as readable divided rows. */}
      <ul className="divide-y divide-[var(--ds-hairline-soft)]">
        {items.map((it, i) => {
          const color = trendColor(it.changePercent);
          return (
            <li key={`${it.symbol}-${i}`} className="flex items-center gap-2 px-3 py-1.5 transition-colors duration-200 hover:bg-[var(--ds-well)]">
              <div className="min-w-0 flex-1">
                <span className="block text-xs font-semibold leading-tight text-[var(--ds-ink)]">{it.symbol}</span>
                {it.name && <span className="block truncate text-[10px] text-[var(--ds-muted)]">{it.name}</span>}
              </div>
              {it.spark && it.spark.length > 1 && (
                <div className="w-16 shrink-0">
                  <Sparkline values={it.spark} color={color} width={64} height={20} fill={false} />
                </div>
              )}
              <div className="w-24 shrink-0 text-right">
                <div className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">{formatPrice(it.price, it.currency ?? 'USD')}</div>
                <div className="text-[10px] font-semibold tabular-nums" style={{ color }}>{formatPercent(it.changePercent)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
};
