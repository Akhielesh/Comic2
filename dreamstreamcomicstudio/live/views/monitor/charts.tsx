// Inline-SVG charts for the nursery: sound level over time (with the baby's
// state underneath) and a week of sleep. Times are in the nursery's zone.
import React from 'react';
import type { HistoryPoint, SleepSession } from '../../monitor/protocol';
import { cx } from '../../ui/primitives';

const DB_MIN = 20;
const DB_MAX = 95;
const STATE_CLASS = ['', 's-calm', 's-stir', 's-noisy', 's-fuss', 's-cry'];

export function fmtClock(t: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(t));
  } catch {
    return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

export function fmtHour(t: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: tz }).format(new Date(t));
  } catch {
    return new Date(t).toLocaleTimeString([], { hour: 'numeric' });
  }
}

export const fmtMins = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

/**
 * Sound level (LAeq per bucket, area) with peaks (LAmax, thin line), the
 * 50 dB infant-sleep guideline, optional motion, and a state ribbon.
 */
export function LevelChart({
  pts,
  from,
  to,
  res,
  tz,
  height = 132,
  showMotion = false,
  label = 'Sound level over time',
}: {
  pts: HistoryPoint[];
  from: number;
  to: number;
  res: number;
  tz?: string;
  height?: number;
  showMotion?: boolean;
  label?: string;
}) {
  const W = 600;
  const H = height;
  const ribbon = 8;
  const plotH = H - ribbon - 18;
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * W;
  const y = (db: number) => plotH - ((Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * plotH;
  // Break lines where the camera was off.
  const runs: HistoryPoint[][] = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (run && p.t - run[run.length - 1].t <= res * 2.5) run.push(p);
    else runs.push([p]);
  }
  const area = (run: HistoryPoint[]) => {
    const ok = run.filter((p) => p.laeq != null);
    if (!ok.length) return '';
    const top = ok.map((p) => `${x(p.t + res / 2).toFixed(1)},${y(p.laeq!).toFixed(1)}`).join(' L');
    return `M${x(ok[0].t + res / 2).toFixed(1)},${plotH} L${top} L${x(ok[ok.length - 1].t + res / 2).toFixed(1)},${plotH} Z`;
  };
  const line = (run: HistoryPoint[], k: 'lmax') =>
    run.filter((p) => p[k] != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t + res / 2).toFixed(1)},${y(p[k]!).toFixed(1)}`).join(' ');
  const motion = (run: HistoryPoint[]) =>
    run.filter((p) => (p.crib ?? p.motion) != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t + res / 2).toFixed(1)},${(plotH - (Math.min(100, (p.crib ?? p.motion)!) / 100) * plotH * 0.45).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * (to - from));
  const approx = pts.some((p) => p.laeq != null) && !pts.some((p) => p.cal);

  return (
    <div className="lv-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <rect className="band b-quiet" x={0} y={y(40)} width={W} height={plotH - y(40)} />
        <rect className="band b-moderate" x={0} y={y(60)} width={W} height={y(40) - y(60)} />
        <rect className="band b-loud" x={0} y={y(80)} width={W} height={y(60) - y(80)} />
        <rect className="band b-vloud" x={0} y={0} width={W} height={y(80)} />
        <line className="guide" x1={0} x2={W} y1={y(50)} y2={y(50)} />
        {runs.map((r, i) => <path key={`a${i}`} className="lv-area" d={area(r)} />)}
        {runs.map((r, i) => <path key={`m${i}`} className="lv-max" d={line(r, 'lmax')} />)}
        {showMotion && runs.map((r, i) => <path key={`mo${i}`} className="lv-motion" d={motion(r)} />)}
        {pts.map((p) =>
          p.state ? <rect key={p.t} className={cx('lv-state', STATE_CLASS[p.state])} x={x(p.t)} y={plotH + 4} width={Math.max(1, x(p.t + res) - x(p.t))} height={ribbon} /> : null,
        )}
      </svg>
      <div className="lv-axis">
        {ticks.map((t, i) => <span key={i} style={{ left: `${(i / 4) * 100}%` }}>{fmtHour(t, tz)}</span>)}
      </div>
      <div className="lv-legend">
        <span><i className="k-area" />Average {approx ? '(≈)' : ''}</span>
        <span><i className="k-max" />Peaks</span>
        {showMotion && <span><i className="k-motion" />Movement</span>}
        <span><i className="k-guide" />50 dB sleep guideline</span>
      </div>
    </div>
  );
}

/** Seven days of sleep: nights and naps stacked, by the day the sleep ended. */
export function SleepWeek({ sessions, tz, days = 7, now = Date.now() }: { sessions: SleepSession[]; tz?: string; days?: number; now?: number }) {
  const dayKey = (t: number) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    } catch {
      return new Date(t).toISOString().slice(0, 10);
    }
  };
  const label = (t: number) => {
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: tz }).format(new Date(t));
    } catch {
      return '';
    }
  };
  const cols = Array.from({ length: days }, (_, i) => {
    const t = now - (days - 1 - i) * 86_400_000;
    return { key: dayKey(t), label: label(t), night: 0, nap: 0, today: i === days - 1 };
  });
  for (const s of sessions) {
    if (s.summary?.discarded) continue;
    const col = cols.find((c) => c.key === dayKey(s.end ?? s.start));
    if (col) col[s.kind] += s.asleep_min;
  }
  const max = Math.max(12 * 60, ...cols.map((c) => c.night + c.nap));
  return (
    <div className="sleep-week" role="img" aria-label={`Sleep over the last ${days} days`}>
      {cols.map((c) => (
        <div key={c.key} className={cx('sw-col', c.today && 'today')} title={`${fmtMins(c.night + c.nap)} (${fmtMins(c.night)} night, ${fmtMins(c.nap)} naps)`}>
          <div className="sw-bar">
            <i className="sw-nap" style={{ height: `${(c.nap / max) * 100}%` }} />
            <i className="sw-night" style={{ height: `${(c.night / max) * 100}%` }} />
          </div>
          <span className="sw-h">{c.night + c.nap ? `${Math.round(((c.night + c.nap) / 60) * 10) / 10}` : '–'}</span>
          <span className="sw-d">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A horizontal sound-level gauge with nursery bands. */
export function DbGauge({ db, approx }: { db: number | null; approx: boolean }) {
  const pct = db == null ? 0 : ((Math.min(DB_MAX, Math.max(DB_MIN, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * 100;
  return (
    <div className="db-gauge" role="meter" aria-valuemin={DB_MIN} aria-valuemax={DB_MAX} aria-valuenow={db ?? undefined} aria-label={`Sound level ${db == null ? 'unknown' : `${approx ? 'about ' : ''}${db} decibels`}`}>
      <div className="dg-track">
        <i className="dg-q" /><i className="dg-m" /><i className="dg-l" /><i className="dg-v" />
        {db != null && <b className="dg-needle" style={{ left: `${pct}%` }} />}
      </div>
      <div className="dg-scale">
        {[20, 40, 60, 80].map((v) => <span key={v} style={{ left: `${((v - DB_MIN) / (DB_MAX - DB_MIN)) * 100}%` }}>{v}</span>)}
        <span style={{ right: 0 }}>dB</span>
      </div>
    </div>
  );
}
