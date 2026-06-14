import React, { useState } from 'react';
import type { PnlCalendarArtifact, PnlDay } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, formatPrice, formatSigned, shortDate, useCompact, withAlpha, BULL, BEAR } from './kit';

// P&L calendar — a GitHub-contribution-style heatmap of daily profit and loss.
//  • detailed — ISO-week columns × Mon-first weekday rows of larger 13px rounded
//    cells: green/red intensity scales with |value| against the 90th-percentile day
//    (clamped 0.15–1); empty/zero days stay hairline-toned so the grid reads in
//    both themes. Month labels mark column boundaries, M/W/F label the rows, an
//    interactive readout above the grid names the hovered day, an intensity legend
//    explains the colour scale, and a richer stats footer shows total, green-day
//    rate, average/day, current green streak, and best/worst day.
//  • compact — total + win rate beside a 14-day mini strip of the latest cells.

// Compact mini-strip cells.
const CELL = 10;
const GAP = 2;
const PITCH = CELL + GAP;
// Detailed grid — deliberately larger / more expansive than the mini strip.
const D_CELL = 13;
const D_GAP = 3;
const D_PITCH = D_CELL + D_GAP;
const LEFT = 22; // weekday label gutter
const TOP = 16; // month label band
const DAY_MS = 86_400_000;

/** Parse an ISO day as a LOCAL date so weekday bucketing doesn't shift by TZ. */
const parseDay = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const keyOf = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);
/** Monday-first weekday index (Mon 0 … Sun 6). */
const weekday = (d: Date): number => (d.getDay() + 6) % 7;

export const PnlCalendar: React.FC<{ data: PnlCalendarArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [hovered, setHovered] = useState<(PnlDay & { dt: Date }) | null>(null);

  const entries = (data.days ?? [])
    .map((d) => ({ ...d, dt: parseDay(d.date) }))
    .filter((d): d is PnlDay & { dt: Date } => d.dt !== null && typeof d.value === 'number' && Number.isFinite(d.value));
  if (!entries.length) return null;

  const currency = data.currency ?? 'USD';
  const fmtVal = (v: number): string =>
    data.unit
      ? `${formatSigned(v, Math.abs(v) >= 100 ? 0 : 1)}${data.unit}`
      : `${v < 0 ? '-' : '+'}${formatPrice(Math.abs(v), currency)}`;

  const byKey = new Map<string, PnlDay & { dt: Date }>();
  for (const e of entries) byKey.set(keyOf(e.dt), e);

  // Intensity reference: the 90th-percentile |value| so one outlier doesn't wash
  // every other day down to the floor alpha.
  const absSorted = entries.map((e) => Math.abs(e.value)).filter((v) => v > 0).sort((a, b) => a - b);
  const p90 = absSorted.length ? absSorted[Math.min(absSorted.length - 1, Math.floor(absSorted.length * 0.9))] : 1;
  const cellFill = (day?: PnlDay): string => {
    if (!day || day.value === 0) return 'var(--ds-hairline-soft)';
    const alpha = Math.min(1, Math.max(0.15, Math.abs(day.value) / (p90 || 1)));
    return withAlpha(day.value > 0 ? BULL : BEAR, alpha);
  };
  const cellTitle = (day: PnlDay): string => `${shortDate(day.date)} · ${fmtVal(day.value)}${day.note ? ` · ${day.note}` : ''}`;

  // Stats.
  const total = entries.reduce((sum, e) => sum + e.value, 0);
  const winRate = Math.round((entries.filter((e) => e.value > 0).length / entries.length) * 100);
  const best = entries.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = entries.reduce((a, b) => (b.value < a.value ? b : a));
  const avg = total / entries.length;
  // Current green streak: consecutive most-recent traded days that closed positive.
  const chrono = [...entries].sort((a, b) => a.dt.getTime() - b.dt.getTime());
  let streak = 0;
  for (let i = chrono.length - 1; i >= 0 && chrono[i].value > 0; i -= 1) streak += 1;

  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'P&L calendar'}</SurfaceTitle>
      <SurfaceSubtitle>{entries.length} {entries.length === 1 ? 'day' : 'days'} tracked</SurfaceSubtitle>
    </>
  );

  const minDate = entries.reduce((a, b) => (b.dt < a.dt ? b : a)).dt;
  const maxDate = entries.reduce((a, b) => (b.dt > a.dt ? b : a)).dt;

  // ── Compact: total + win rate + a 14-day mini strip. ─────────────────────────
  if (compact) {
    const strip = Array.from({ length: 14 }, (_, i) => addDays(maxDate, i - 13));
    return (
      <Surface header={header}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3">
          <span
            className="text-lg font-semibold tabular-nums tracking-tight"
            style={{ color: total > 0 ? BULL : total < 0 ? BEAR : 'var(--ds-ink)' }}
          >
            {fmtVal(total)}
          </span>
          <span className="text-[11px] text-[var(--ds-muted)]">
            <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{winRate}%</span> green days
          </span>
          <svg width={14 * PITCH - GAP} height={CELL} className="ml-auto shrink-0" role="img" aria-label="Last 14 days">
            {strip.map((d, i) => {
              const day = byKey.get(keyOf(d));
              return (
                <rect key={i} x={i * PITCH} y={0} width={CELL} height={CELL} rx={2} fill={cellFill(day)}>
                  {day && <title>{cellTitle(day)}</title>}
                </rect>
              );
            })}
          </svg>
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full contribution grid. ────────────────────────────────────
  const start = addDays(minDate, -weekday(minDate)); // Monday of the first week
  const end = addDays(maxDate, 6 - weekday(maxDate)); // Sunday of the last week
  const weeks: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 7)) weeks.push(d);

  const width = LEFT + weeks.length * D_PITCH - D_GAP;
  const height = TOP + 7 * D_PITCH - D_GAP;
  const fmtDay = (d: Date): string => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hoveredKey = hovered ? keyOf(hovered.dt) : null;

  // Intensity legend — small swatches from loss → neutral → profit, GitHub-style.
  const swatch = (fill: string, key: string) => (
    <span key={key} className="h-[11px] w-[11px] rounded-[3px]" style={{ background: fill }} />
  );
  const legend = (
    <div className="ml-auto flex items-center gap-1 text-[10px] text-[var(--ds-muted)]">
      <span>Loss</span>
      {[0.85, 0.5, 0.25].map((a, i) => swatch(withAlpha(BEAR, a), `l-${i}`))}
      {swatch('var(--ds-hairline-soft)', 'zero')}
      {[0.25, 0.5, 0.85].map((a, i) => swatch(withAlpha(BULL, a), `g-${i}`))}
      <span>Profit</span>
    </div>
  );

  const footer = (
    <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-[var(--ds-muted)]">
      <span>
        total{' '}
        <span className="font-semibold tabular-nums" style={{ color: total > 0 ? BULL : total < 0 ? BEAR : 'var(--ds-ink)' }}>
          {fmtVal(total)}
        </span>
      </span>
      <span>
        <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{winRate}%</span> green
      </span>
      <span>
        avg <span className="font-semibold tabular-nums" style={{ color: avg > 0 ? BULL : avg < 0 ? BEAR : 'var(--ds-ink)' }}>{fmtVal(avg)}</span>/day
      </span>
      {streak > 0 && (
        <span>
          <span className="font-semibold tabular-nums" style={{ color: BULL }}>{streak}</span>-day streak
        </span>
      )}
      <span>
        best <span className="font-semibold tabular-nums" style={{ color: BULL }}>{fmtVal(best.value)}</span> · {shortDate(best.date)}
      </span>
      <span>
        worst <span className="font-semibold tabular-nums" style={{ color: BEAR }}>{fmtVal(worst.value)}</span> · {shortDate(worst.date)}
      </span>
    </div>
  );

  return (
    <Surface header={header} footer={footer}>
      {/* Readout: names the hovered day (date · value · note), else the tracked range + legend. */}
      <div className="flex min-h-[20px] items-center gap-2 px-3 pt-0.5 text-[11px]">
        {hovered ? (
          <>
            <span className="font-medium text-[var(--ds-ink)]">{shortDate(hovered.date)}</span>
            <span className="font-semibold tabular-nums" style={{ color: hovered.value > 0 ? BULL : hovered.value < 0 ? BEAR : 'var(--ds-ink)' }}>
              {fmtVal(hovered.value)}
            </span>
            {hovered.note && <span className="min-w-0 truncate text-[var(--ds-muted)]">{hovered.note}</span>}
          </>
        ) : (
          <span className="text-[var(--ds-muted)]">
            {fmtDay(minDate)} – {fmtDay(maxDate)}
          </span>
        )}
        <span className="ml-auto hidden sm:flex">{legend}</span>
      </div>

      <div className="overflow-x-auto px-3 pb-2 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <svg width={width} height={height} role="img" aria-label="Daily P&L heatmap" onMouseLeave={() => setHovered(null)}>
          {/* Month labels where the column's Monday enters a new month. */}
          {weeks.map((monday, w) => {
            if (w > 0 && monday.getMonth() === weeks[w - 1].getMonth()) return null;
            // Skip a leading stub label that would collide with next week's change.
            if (w === 0 && weeks.length > 1 && weeks[1].getMonth() !== monday.getMonth()) return null;
            return (
              <text key={`m-${w}`} x={LEFT + w * D_PITCH} y={10} fontSize="10" fontWeight={600} fill="var(--ds-muted)">
                {monday.toLocaleDateString(undefined, { month: 'short' })}
              </text>
            );
          })}
          {/* Weekday labels on Mon/Wed/Fri rows. */}
          {([[0, 'M'], [2, 'W'], [4, 'F']] as const).map(([row, label]) => (
            <text key={label} x={0} y={TOP + row * D_PITCH + D_CELL - 3} fontSize="10" fill="var(--ds-muted)">
              {label}
            </text>
          ))}
          {weeks.map((monday, w) =>
            Array.from({ length: 7 }, (_, row) => {
              const d = addDays(monday, row);
              const day = byKey.get(keyOf(d));
              const isHovered = hoveredKey === keyOf(d);
              return (
                <rect
                  key={`${w}-${row}`}
                  x={LEFT + w * D_PITCH}
                  y={TOP + row * D_PITCH}
                  width={D_CELL}
                  height={D_CELL}
                  rx={3}
                  fill={cellFill(day)}
                  stroke={isHovered ? 'var(--ds-ink)' : 'transparent'}
                  strokeWidth={1.5}
                  style={{ cursor: day ? 'pointer' : 'default' }}
                  onMouseEnter={() => setHovered(day ?? null)}
                >
                  {day && <title>{cellTitle(day)}</title>}
                </rect>
              );
            })
          )}
        </svg>
      </div>
    </Surface>
  );
};
