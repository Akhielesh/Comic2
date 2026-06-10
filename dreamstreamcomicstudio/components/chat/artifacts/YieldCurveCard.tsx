import React, { useState } from 'react';
import type { YieldCurveArtifact, YieldCurvePoint, YieldCurveSnapshot } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, RangeTabs, Sparkline, formatSigned, shortDate, useCompact, BULL, BEAR, NEUTRAL, PALETTES } from './kit';

// US Treasury yield curve — yield % across maturities on a sqrt(years) x-scale so
// the short end (1M…1Y) doesn't crush together. A RangeTabs control morphs the
// curve to a 1M-ago / 1Y-ago snapshot (today stays behind as a dashed reference);
// the path `d` gets a CSS transition so browsers that interpolate paths animate
// the morph, and the rest simply snap — both fine.
//  • compact — the 2s10s spread + inverted badge + a static sparkline of the curve.
//  • detailed — full chart with axis labels, snapshot tabs, and per-maturity readouts.

type CurveTab = 'Today' | '1M ago' | '1Y ago';

const ACCENT = PALETTES.brand.accent;
const W = 260;
const H = 120;
const PAD_L = 26;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 18;

// The maturity labels worth printing under the axis (the rest would collide).
const X_LABELS = new Set(['1M', '3M', '2Y', '10Y', '30Y']);

const byYears = (pts: YieldCurvePoint[]): YieldCurvePoint[] => [...pts].sort((a, b) => a.years - b.years);

const spreadColor = (spread?: number): string =>
  typeof spread === 'number' && spread < 0 ? BEAR : typeof spread === 'number' && spread > 0 ? BULL : NEUTRAL;

export const YieldCurveCard: React.FC<{ data: YieldCurveArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [tab, setTab] = useState<CurveTab>('Today');
  const latestPts = byYears(data.latest?.points ?? []);
  if (!latestPts.length) return null;

  const spread = data.spread10y2y;
  const tint = spreadColor(spread);
  const invertedBadge = data.inverted ? <Badge color={BEAR}>Inverted 2s10s</Badge> : null;
  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'US Treasury yield curve'}</SurfaceTitle>
      {data.latest?.date && <SurfaceSubtitle>{shortDate(data.latest.date)}</SurfaceSubtitle>}
    </>
  );
  const spreadLine = typeof spread === 'number' ? (
    <span className="text-[11px] font-semibold tabular-nums" style={{ color: tint }}>
      10Y−2Y spread: {formatSigned(spread, 2)} pp
    </span>
  ) : null;

  // ── Compact: spread + badge + a static sparkline of the latest curve. ────────
  if (compact) {
    return (
      <Surface header={header} right={invertedBadge ?? undefined}>
        <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
          <div className="min-w-0">
            {spreadLine ?? <span className="text-[11px] text-[var(--ds-muted)]">{latestPts.length} maturities</span>}
          </div>
          {latestPts.length > 1 && (
            <div className="w-28 shrink-0">
              <Sparkline values={latestPts.map((p) => p.yieldPct)} color={data.inverted ? BEAR : ACCENT} width={112} height={32} />
            </div>
          )}
        </div>
      </Surface>
    );
  }

  // ── Detailed: morphing snapshot chart. ───────────────────────────────────────
  const snapshots: Partial<Record<CurveTab, YieldCurveSnapshot>> = {
    'Today': data.latest,
    '1M ago': data.monthAgo,
    '1Y ago': data.yearAgo
  };
  const tabs = (['Today', '1M ago', '1Y ago'] as const).filter((t) => (snapshots[t]?.points?.length ?? 0) > 1);
  const safeTab: CurveTab = tabs.includes(tab) ? tab : 'Today';
  const activeSnap = snapshots[safeTab];
  const activePts = byYears(activeSnap?.points ?? latestPts);
  const comparing = safeTab !== 'Today';

  // Shared scales across every available snapshot, so the morph compares fairly
  // and the axes don't jump between tabs.
  const allPts = tabs.flatMap((t) => snapshots[t]?.points ?? []);
  const pool = allPts.length ? allPts : latestPts;
  const sMin = Math.sqrt(Math.min(...pool.map((p) => p.years)));
  const sMax = Math.sqrt(Math.max(...pool.map((p) => p.years)));
  const yMin = Math.min(...pool.map((p) => p.yieldPct)) - 0.15;
  const yMax = Math.max(...pool.map((p) => p.yieldPct)) + 0.15;
  const x = (years: number) => PAD_L + ((Math.sqrt(years) - sMin) / (sMax - sMin || 1)) * (W - PAD_L - PAD_R);
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - yMin) / (yMax - yMin || 1));
  const pathOf = (pts: YieldCurvePoint[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.years).toFixed(1)},${y(p.yieldPct).toFixed(1)}`).join(' ');

  const ticks = [yMin + 0.15, (yMin + yMax) / 2, yMax - 0.15];
  const xLabels = latestPts.filter((p) => X_LABELS.has(p.label.toUpperCase()));

  return (
    <Surface header={header} right={invertedBadge ?? undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2">
        {spreadLine ?? <span />}
        {tabs.length > 1 && <RangeTabs<CurveTab> options={tabs} value={safeTab} accent={ACCENT} onChange={setTab} />}
      </div>

      <div className="px-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          {/* Y gridlines + min/mid/max tick labels */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke="var(--ds-hairline-soft)" strokeWidth="1" />
              <text x={PAD_L - 4} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--ds-muted)">{t.toFixed(1)}</text>
            </g>
          ))}

          {/* Today stays behind as a muted dashed reference while comparing. */}
          {comparing && (
            <path d={pathOf(latestPts)} fill="none" stroke="var(--ds-muted)" strokeWidth="1.25" strokeDasharray="3 3" opacity="0.55" />
          )}

          {/* The active snapshot — path `d` transitions where supported (Chromium). */}
          <path
            d={pathOf(activePts)}
            fill="none"
            stroke={ACCENT}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ transition: 'd 400ms ease' }}
          />
          {activePts.map((p) => (
            <circle
              key={p.label}
              cx={x(p.years)}
              cy={y(p.yieldPct)}
              r="2.2"
              fill={ACCENT}
              style={{ transition: 'cx 400ms ease, cy 400ms ease' }}
            />
          ))}

          {/* Maturity labels under the axis (subset, to avoid collisions). */}
          {xLabels.map((p) => (
            <text key={p.label} x={x(p.years)} y={H - 4} textAnchor="middle" fontSize="9" fill="var(--ds-muted)">{p.label}</text>
          ))}
        </svg>
        {comparing && activeSnap?.date && (
          <div className="pb-1 text-[9px] text-[var(--ds-muted)]">
            {shortDate(activeSnap.date)} (solid) vs today (dashed)
          </div>
        )}
      </div>

      {/* Per-maturity readouts for the latest snapshot. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-3 pb-3 pt-1.5">
        {latestPts.map((p) => (
          <div key={p.label} className="min-w-[2.25rem]">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{p.label}</div>
            <div className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">{p.yieldPct.toFixed(2)}%</div>
          </div>
        ))}
      </div>
    </Surface>
  );
};
