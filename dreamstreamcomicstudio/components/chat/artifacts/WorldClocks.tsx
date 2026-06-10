import React, { useEffect, useState } from 'react';
import { Clock, Moon, Sun } from 'lucide-react';
import type { WorldClocksArtifact, WorldClockZone } from '../../../apiTypes';
import { Surface, SurfaceTitle, useCompact } from './kit';

// Time-zone twins — live world clocks that tick every second, entirely client-side
// (Intl.DateTimeFormat per IANA zone, no server round-trip).
//  • detailed — a grid of zone tiles: an analog SVG clock (accent second hand),
//    big digital time + AM/PM, date line, and a sun/moon awake-or-sleeping chip
//    (waking window defaults 8–22, overridable per zone). With exactly two zones,
//    a footer flags "Good time to call" when both are awake, or scans the next
//    24 h for when the call window opens.
//  • compact — one quiet row per zone: label left, time + sun/moon right.

const SECOND_HAND = '#D97757';

interface ZoneFmts {
  time: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
}

// Intl.DateTimeFormat construction is not free and we tick every second — cache
// formatters per IANA zone for the lifetime of the module. `null` marks a bad zone.
const fmtCache = new Map<string, ZoneFmts | null>();
const getFmts = (tz: string): ZoneFmts | null => {
  if (!fmtCache.has(tz)) {
    try {
      fmtCache.set(tz, {
        time: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }),
        date: new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
      });
    } catch {
      fmtCache.set(tz, null);
    }
  }
  return fmtCache.get(tz) ?? null;
};

interface ZoneNow {
  /** 24h hour (0–23) for sleep math and hands. */
  h: number;
  m: number;
  s: number;
  /** "10:45" */
  time: string;
  /** "AM" / "PM" */
  ampm: string;
  /** "Tue, Jun 10" */
  date: string;
}

const readZone = (now: number, tz: string): ZoneNow | null => {
  const fmts = getFmts(tz);
  if (!fmts) return null;
  const parts = fmts.time.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const h12 = Number(get('hour'));
  const m = Number(get('minute'));
  const s = Number(get('second'));
  if (!Number.isFinite(h12) || !Number.isFinite(m)) return null;
  const ampm = get('dayPeriod');
  const h = (h12 % 12) + (/pm/i.test(ampm) ? 12 : 0);
  return {
    h,
    m,
    s: Number.isFinite(s) ? s : 0,
    time: `${h12}:${String(m).padStart(2, '0')}`,
    ampm: ampm.toUpperCase(),
    date: fmts.date.format(now)
  };
};

/** True when the local hour falls inside the zone's waking window (default 8–22). */
const isAwake = (h: number, zone: WorldClockZone): boolean => {
  const start = zone.wakeStart ?? 8;
  const end = zone.wakeEnd ?? 22;
  return start <= end ? h >= start && h < end : h >= start || h < end;
};

/** 7 → "7 AM", 0 → "12 AM", 15 → "3 PM". */
const hourLabel = (h: number): string => {
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${h < 12 ? 'AM' : 'PM'}`;
};

// ── Analog face: hairline dial, 12 ticks, hour/min hands + accent second hand. ──
const AnalogClock: React.FC<{ h: number; m: number; s: number; size?: number }> = ({ h, m, s, size = 72 }) => {
  const c = size / 2;
  const r = c - 2;
  const hand = (deg: number, len: number, width: number, color: string, key: string) => (
    <line
      key={key}
      x1={c}
      y1={c}
      x2={c}
      y2={c - len}
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      transform={`rotate(${deg} ${c} ${c})`}
    />
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="var(--ds-well)" stroke="var(--ds-hairline)" strokeWidth="1" />
      {Array.from({ length: 12 }, (_, i) => {
        const cardinal = i % 3 === 0;
        return (
          <line
            key={i}
            x1={c}
            y1={c - r + 1.5}
            x2={c}
            y2={c - r + (cardinal ? 6 : 4)}
            stroke={cardinal ? 'var(--ds-muted)' : 'var(--ds-hairline)'}
            strokeWidth={cardinal ? 1.5 : 1}
            transform={`rotate(${i * 30} ${c} ${c})`}
          />
        );
      })}
      {hand(((h % 12) + m / 60) * 30, r * 0.48, 2.5, 'var(--ds-ink)', 'h')}
      {hand((m + s / 60) * 6, r * 0.7, 1.75, 'var(--ds-ink)', 'm')}
      {hand(s * 6, r * 0.8, 1, SECOND_HAND, 's')}
      <circle cx={c} cy={c} r="2" fill={SECOND_HAND} />
    </svg>
  );
};

export const WorldClocks: React.FC<{ data: WorldClocksArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const zones = (data.zones ?? []).filter((z) => z?.tz && readZone(now, z.tz) !== null);
  if (!zones.length) return null;

  const header = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Clock className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
      <SurfaceTitle>{data.title ?? 'World clocks'}</SurfaceTitle>
    </span>
  );

  // ── Compact: one quiet row per zone. ────────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header}>
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {zones.map((zone, i) => {
            const t = readZone(now, zone.tz);
            if (!t) return null;
            const awake = isAwake(t.h, zone);
            return (
              <li key={`${zone.tz}-${i}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ds-ink)]">{zone.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[13px] font-semibold tabular-nums text-[var(--ds-ink)]">
                    {t.time}
                    <span className="ml-0.5 text-[10px] font-medium text-[var(--ds-muted)]">{t.ampm}</span>
                  </span>
                  {awake ? (
                    <Sun className="h-3 w-3 text-amber-500" aria-label="awake" />
                  ) : (
                    <Moon className="h-3 w-3 text-[var(--ds-muted)]" aria-label="sleeping" />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </Surface>
    );
  }

  // ── Call-window footer (exactly two zones). ─────────────────────────────────
  let footer: React.ReactNode;
  if (zones.length === 2) {
    const [a, b] = zones;
    const ta = readZone(now, a.tz);
    const tb = readZone(now, b.tz);
    if (ta && tb) {
      if (isAwake(ta.h, a) && isAwake(tb.h, b)) {
        footer = (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--ds-ink)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#059669]" />
            Good time to call — both awake
          </span>
        );
      } else {
        // Scan the next 24 h hourly for the first moment both are awake.
        for (let i = 1; i <= 24; i++) {
          const t = now + i * 3_600_000;
          const fa = readZone(t, a.tz);
          const fb = readZone(t, b.tz);
          if (fa && fb && isAwake(fa.h, a) && isAwake(fb.h, b)) {
            const sleeper = !isAwake(tb.h, b) ? { zone: b, hour: fb.h } : { zone: a, hour: fa.h };
            footer = (
              <span className="text-[11px] text-[var(--ds-muted)]">
                Call window opens ~{hourLabel(sleeper.hour)} in {sleeper.zone.label}
              </span>
            );
            break;
          }
        }
      }
    }
  }

  // ── Detailed: analog + digital tiles in a responsive grid. ──────────────────
  return (
    <Surface header={header} footer={footer}>
      <div className="grid grid-cols-1 gap-2 px-3 pb-3 sm:grid-cols-2">
        {zones.map((zone, i) => {
          const t = readZone(now, zone.tz);
          if (!t) return null;
          const awake = isAwake(t.h, zone);
          return (
            <div key={`${zone.tz}-${i}`} className="flex items-center gap-3 rounded-xl bg-[var(--ds-well)] p-3">
              <AnalogClock h={t.h} m={t.m} s={t.s} />
              <div className="min-w-0 flex-1">
                <p className="text-xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">
                  {t.time}
                  <span className="ml-1 text-[11px] font-semibold text-[var(--ds-muted)]">{t.ampm}</span>
                </p>
                <p className="truncate text-[11px] text-[var(--ds-muted)]">{t.date}</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ds-ink)]">{zone.label}</span>
                  {awake ? (
                    <Sun className="h-3 w-3 shrink-0 text-amber-500" aria-label="awake" />
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--ds-well-strong)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--ds-muted)]">
                      <Moon className="h-2.5 w-2.5" />
                      sleeping
                    </span>
                  )}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Surface>
  );
};
