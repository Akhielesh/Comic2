import React from 'react';
import type { MarketSentimentArtifact, SentimentGauge } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, RadialGauge, Sparkline, relativeTime, useCompact, NEUTRAL } from './kit';

// Market sentiment — the fear & greed dial(s), calm-studio edition. One section per
// market (stocks from CNN's index, crypto from alternative.me), each a radial gauge
// tinted by its band plus prior readings, a history sparkline, and (for stocks) the
// sub-indicator breakdown.
//  • compact — one glance row per gauge: a small dial beside the market + rating word.
//  • detailed — full sections with previous-reading chips, history, components, and
//    a sources/as-of footer.

/** Band color for a 0–100 fear→greed score. */
const toneFor = (score?: number): string => {
  if (typeof score !== 'number' || !Number.isFinite(score)) return NEUTRAL;
  if (score <= 24) return '#dc2626'; // extreme fear
  if (score <= 44) return '#f97316'; // fear
  if (score <= 55) return '#64748b'; // neutral
  if (score <= 75) return '#84cc16'; // greed
  return '#059669'; // extreme greed
};

const marketLabel = (market: SentimentGauge['market']): string => (market === 'crypto' ? 'Crypto' : 'Stocks');

const GaugeSection: React.FC<{ gauge: SentimentGauge }> = ({ gauge }) => {
  const tone = toneFor(gauge.score);
  const previous = gauge.previous ?? [];
  const history = gauge.history ?? [];
  const components = gauge.components ?? [];
  return (
    <section className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <RadialGauge value={gauge.score} max={100} display={String(Math.round(gauge.score))} color={tone} size={92} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{marketLabel(gauge.market)}</div>
          <div className="text-lg font-semibold capitalize leading-tight tracking-tight" style={{ color: tone }}>{gauge.rating}</div>
          {previous.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {previous.map((p, i) => (
                <span key={i} className="rounded-full bg-[var(--ds-well)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--ds-muted)]">
                  {p.label} · {Math.round(p.score)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {history.length > 1 && (
        <div className="mt-2">
          <Sparkline values={history} color={tone} height={36} />
        </div>
      )}

      {components.length > 0 && (
        <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {components.map((c, i) => {
            const cTone = toneFor(c.score);
            return (
              <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate text-[var(--ds-muted)]">{c.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {typeof c.score === 'number' && <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{Math.round(c.score)}</span>}
                  {c.rating && <span className="text-[10px] font-medium capitalize" style={{ color: cTone }}>{c.rating}</span>}
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: cTone }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export const MarketSentiment: React.FC<{ data: MarketSentimentArtifact }> = ({ data }) => {
  const compact = useCompact();
  const gauges = data.gauges ?? [];
  if (!gauges.length) return null;

  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'Fear & Greed'}</SurfaceTitle>
      <SurfaceSubtitle>Market sentiment</SurfaceSubtitle>
    </>
  );

  // ── Compact: one glance row per gauge — small dial + market + rating. ────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {gauges.map((g, i) => {
            const tone = toneFor(g.score);
            return (
              <div key={i} className="flex items-center gap-3 px-3 py-1.5">
                <RadialGauge value={g.score} max={100} display={String(Math.round(g.score))} color={tone} size={56} />
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{marketLabel(g.market)}</div>
                  <div className="text-sm font-semibold capitalize leading-tight" style={{ color: tone }}>{g.rating}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Surface>
    );
  }

  // ── Detailed: full sections + sources footer. ────────────────────────────────
  const sources = data.sources ?? [];
  const asOf = relativeTime(data.asOf);
  const footer = (sources.length > 0 || asOf) ? (
    <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--ds-muted)]">
      <span className="min-w-0 truncate">
        {sources.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && ' · '}
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="transition-colors duration-200 hover:text-[var(--ds-ink)] hover:underline">
              {s.name}
            </a>
          </React.Fragment>
        ))}
      </span>
      {asOf && <span className="shrink-0">as of {asOf}</span>}
    </div>
  ) : undefined;

  return (
    <Surface header={header} footer={footer}>
      <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {gauges.map((g, i) => <GaugeSection key={i} gauge={g} />)}
      </div>
    </Surface>
  );
};
