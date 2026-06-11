import React from 'react';
import type { EarningsCalendarArtifact, EarningsItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, relativeTime, shortDate, useCompact, useLiveData, withAlpha, BULL, BEAR, PALETTES } from './kit';

// Earnings countdown — who reports next, as a horizontal scroll-snap carousel.
//  • detailed — one snap card per report (date ascending): seeded-gradient ticker
//    avatar, symbol + name, a "in 3d · after close" countdown (already-reported
//    items show actual-vs-estimate beat/miss tinted instead), "est EPS $1.42",
//    a violet "±6.0% implied" chip, and the agent's two-line preview.
//  • compact — the next three reports as glance rows (symbol · in Nd · ±move).
// Header right shows a Live badge (or "model data") plus "Updated Xm ago".

const VIOLET = PALETTES.violet.accent; // #8b5cf6
const DAY_MS = 86_400_000;

// Same seeded-avatar approach as NewsDigest: a stable hue pair hashed from the seed.
const seededGradient = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 60%), hsl(${(h + 40) % 360} 45% 48%))`;
};
const tickerInitials = (symbol?: string): string =>
  (symbol ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

const SESSION_LABEL: Record<string, string> = {
  pre: 'before open',
  after: 'after close',
  during: 'during market'
};

const daysUntil = (iso: string): number | undefined => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return undefined;
  return Math.ceil((t - Date.now()) / DAY_MS);
};

const countdownLabel = (days?: number): string =>
  days === undefined ? '' : days <= 0 ? 'today' : `in ${days}d`;

const ImpliedMoveChip: React.FC<{ pct: number }> = ({ pct }) => (
  <span
    className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
    style={{ color: VIOLET, backgroundColor: withAlpha(VIOLET, 0.1) }}
  >
    ±{Math.abs(pct).toFixed(1)}% implied
  </span>
);

const EarningsCard: React.FC<{ item: EarningsItem }> = ({ item }) => {
  const reported = typeof item.epsActual === 'number';
  const days = daysUntil(item.date);
  const session = item.session ? SESSION_LABEL[item.session] : undefined;
  const surprise =
    reported && typeof item.epsEstimate === 'number' ? (item.epsActual as number) - item.epsEstimate : undefined;
  return (
    <div className="min-w-[180px] max-w-[220px] shrink-0 snap-start rounded-xl bg-[var(--ds-well)] p-3">
      <div className="flex items-center gap-2">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white"
          style={{ background: seededGradient(item.symbol) }}
        >
          {tickerInitials(item.symbol)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--ds-ink)]">{item.symbol}</div>
          {item.name && <div className="truncate text-[10px] text-[var(--ds-muted)]">{item.name}</div>}
        </div>
      </div>

      <div className="mt-2 text-[11px] leading-snug">
        {reported ? (
          surprise !== undefined ? (
            <span className="font-semibold tabular-nums" style={{ color: surprise >= 0 ? BULL : BEAR }}>
              EPS ${(item.epsActual as number).toFixed(2)} vs ${(item.epsEstimate as number).toFixed(2)} est ·{' '}
              {surprise >= 0 ? 'beat' : 'miss'}
            </span>
          ) : (
            <span className="font-medium tabular-nums text-[var(--ds-ink)]">
              reported EPS ${(item.epsActual as number).toFixed(2)}
            </span>
          )
        ) : (
          <>
            <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{countdownLabel(days) || shortDate(item.date)}</span>
            {session && <span className="text-[var(--ds-muted)]"> · {session}</span>}
          </>
        )}
      </div>
      <div className="mt-0.5 text-[10px] tabular-nums text-[var(--ds-muted)]">{shortDate(item.date)}</div>

      {(typeof item.epsEstimate === 'number' && !reported) || typeof item.impliedMovePct === 'number' ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {typeof item.epsEstimate === 'number' && !reported && (
            <span className="text-[10px] tabular-nums text-[var(--ds-muted)]">est EPS ${item.epsEstimate.toFixed(2)}</span>
          )}
          {typeof item.impliedMovePct === 'number' && <ImpliedMoveChip pct={item.impliedMovePct} />}
        </div>
      ) : null}

      {item.preview && <p className="mt-1.5 text-[10px] leading-snug text-[var(--ds-muted)] line-clamp-2">{item.preview}</p>}
    </div>
  );
};

export const EarningsCountdown: React.FC<{ data: EarningsCalendarArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();

  const items = (data.items ?? [])
    .filter((it) => it?.symbol && Number.isFinite(new Date(it.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (!items.length) return null;

  const updated = relativeTime(live.asOf ?? data.asOf);
  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'Earnings ahead'}</SurfaceTitle>
      <SurfaceSubtitle>{items.length} {items.length === 1 ? 'report' : 'reports'}</SurfaceSubtitle>
    </>
  );
  const headerRight = (
    <div className="flex flex-col items-end gap-0.5">
      {data.live ? <Badge color={BULL}>Live</Badge> : <SurfaceSubtitle>model data</SurfaceSubtitle>}
      {updated && <SurfaceSubtitle>Updated {updated}</SurfaceSubtitle>}
    </div>
  );

  // ── Compact: the next three reports as glance rows. ──────────────────────────
  if (compact) {
    const upcoming = items.filter((it) => typeof it.epsActual !== 'number');
    const picks = (upcoming.length ? upcoming : items).slice(0, 3);
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {picks.map((it, i) => (
            <div key={`${it.symbol}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold text-white"
                style={{ background: seededGradient(it.symbol) }}
              >
                {tickerInitials(it.symbol)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">{it.symbol}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--ds-ink)]">
                {countdownLabel(daysUntil(it.date)) || shortDate(it.date)}
              </span>
              {typeof it.impliedMovePct === 'number' && (
                <span className="w-12 shrink-0 text-right text-[10px] font-semibold tabular-nums" style={{ color: VIOLET }}>
                  ±{Math.abs(it.impliedMovePct).toFixed(1)}%
                </span>
              )}
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the scroll-snap carousel. ──────────────────────────────────────
  return (
    <Surface header={header} right={headerRight}>
      <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it, i) => (
          <EarningsCard key={`${it.symbol}-${i}`} item={it} />
        ))}
      </div>
    </Surface>
  );
};
