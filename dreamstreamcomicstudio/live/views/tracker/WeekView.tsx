// The week at a glance, Huckleberry-style: one 24-hour strip per day — sleep as
// blocks, feeds and diapers as ticks — so rhythms (bedtime drifting, a long
// first stretch, cluster feeds) jump out without reading a word. Tap a day to
// open it above.
import React, { useMemo } from 'react';
import type { TrackItem, TrackKind } from '../../monitor/trackTypes';
import { cx } from '../../ui/primitives';
import { KIND_META, addDays, dayStart, fmtDur } from './fmt';

const FEEDS: TrackKind[] = ['breast', 'bottle', 'solids', 'pump'];

export function WeekView({ items, now, tz, day, onPick }: { items: TrackItem[]; now: number; tz?: string; day: number; onPick: (day: number) => void }) {
  const days = useMemo(() => {
    const today = dayStart(now, tz);
    return Array.from({ length: 7 }, (_, k) => addDays(today, k - 6, tz));
  }, [now, tz]);
  const rows = useMemo(
    () =>
      days.map((d) => {
        const end = addDays(d, 1, tz);
        const inDay = items.filter((i) => !i.deleted && i.start < end && (i.end ?? now) > d);
        const sleepMin = inDay
          .filter((i) => i.kind === 'sleep')
          .reduce((m, i) => m + Math.max(0, Math.min(i.end ?? now, end, now) - Math.max(i.start, d)) / 60_000, 0);
        return { d, end, inDay, sleepMin, feeds: inDay.filter((i) => FEEDS.includes(i.kind) && i.start >= d).length };
      }),
    [days, items, now, tz],
  );
  const any = rows.some((r) => r.inDay.length > 0);
  const label = (d: number) => {
    try {
      return new Date(d + 12 * 3_600_000).toLocaleDateString([], { weekday: 'short', day: 'numeric', timeZone: tz });
    } catch {
      return new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    }
  };

  return (
    <div className="card card-pad wkv" data-tour="tk-week">
      <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
        <b style={{ flex: 1 }}>The week</b>
        <span className="wkv-legend" aria-hidden>
          <i className="tone-indigo" />sleep <i className="tone-rose dot" />feeds <i className="tone-teal dot" />diapers
        </span>
      </div>
      {!any ? (
        <p className="faint" style={{ fontSize: 13, margin: '8px 0 0' }}>A week of logs draws itself here — sleep, feeds and diapers, one line per day.</p>
      ) : (
        <div className="wkv-grid" role="list">
          {rows.map((r, k) => {
            const span = r.end - r.d;
            const pct = (t: number) => Math.max(0, Math.min(100, ((t - r.d) / span) * 100));
            return (
              <button
                key={r.d}
                role="listitem"
                className={cx('wkv-row', r.d === day && 'sel')}
                style={{ animationDelay: `${k * 40}ms` }}
                onClick={() => onPick(r.d)}
                aria-label={`${label(r.d)}: ${fmtDur(r.sleepMin * 60_000)} sleep, ${r.feeds} feeds`}
              >
                <span className="wkv-day">{label(r.d)}</span>
                <span className="wkv-track">
                  {r.inDay.map((i) => {
                    const e = Math.min(i.end ?? now, now);
                    const long = i.kind === 'sleep' && e - i.start > 5 * 60_000;
                    const lane = i.kind === 'sleep' ? 'sl' : i.kind === 'diaper' ? 'dp' : FEEDS.includes(i.kind) ? 'fd' : null;
                    if (!lane) return null;
                    return (
                      <i
                        key={i.id}
                        className={cx(`tone-${KIND_META[i.kind].tone}`, `wkv-${lane}`, !long && 'dot', i.src === 'monitor' && 'auto', i.end == null && 'live')}
                        style={{ left: `${pct(i.start)}%`, width: long ? `${Math.max(0.8, pct(e) - pct(i.start))}%` : undefined }}
                      />
                    );
                  })}
                  {now > r.d && now < r.end && <b className="tk-now" style={{ left: `${pct(now)}%` }} />}
                </span>
                <span className="wkv-sum">{r.sleepMin ? fmtDur(r.sleepMin * 60_000) : '—'}</span>
              </button>
            );
          })}
          <div className="wkv-hours" aria-hidden><span /><span className="wkv-axis"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></span><span /></div>
        </div>
      )}
    </div>
  );
}
