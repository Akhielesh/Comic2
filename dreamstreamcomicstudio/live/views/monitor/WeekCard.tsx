// This week vs last, from what the monitor itself measured: how much the
// camera saw the baby sleep, night wakings, the longest stretch, crying, how
// fast someone answered alerts, and the sound level while asleep. Six rows,
// one headline — the few numbers worth knowing, not a wall of charts.
//
// Push, not poll (ADR 0007 C2): two weeks of day totals barely move within a
// session, so it asks the room once when shown and again only when the page comes
// back into view (or the socket reconnects) after 10 minutes — never on a timer,
// never while hidden.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MonQuery } from '../../monitor/query';
import { Icon } from '../../ui/icons';
import { useOnPageReturn, usePageVisible } from '../../ui/pageVisibility';
import { cx } from '../../ui/primitives';

/** How old the week may get before coming back to the page asks again. */
export const WEEK_STALE_MS = 10 * 60_000;

interface Day {
  day: number;
  sleepMin: number;
  nightMin: number;
  naps: number;
  wakings: number;
  longestMin: number;
  cryMin: number;
  cries: number;
  alerts: number;
  responseSec: number | null;
  sleepLaeq: number | null;
  loud: number;
}

type Metric = {
  k: string;
  label: string;
  icon: string;
  /** Value for a day, or null when that day has nothing to say. */
  of: (d: Day) => number | null;
  fmt: (v: number) => string;
  /** Lower is better (wakings, crying, response time, noise). */
  lowerBetter: boolean;
  /** Smallest change worth calling out. */
  min: number;
};

const h = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} m` : `${Math.round(m)} min`);

const METRICS: Metric[] = [
  { k: 'sleep', label: 'Sleep the camera saw', icon: 'moon', of: (d) => (d.sleepMin > 0 ? d.sleepMin : null), fmt: (v) => `${h(v)} / day`, lowerBetter: false, min: 20 },
  { k: 'wakings', label: 'Night wakings', icon: 'eye', of: (d) => (d.nightMin > 0 ? d.wakings : null), fmt: (v) => `${v.toFixed(1)} a night`, lowerBetter: true, min: 0.4 },
  { k: 'longest', label: 'Longest stretch', icon: 'clock', of: (d) => (d.longestMin > 0 ? d.longestMin : null), fmt: (v) => h(v), lowerBetter: false, min: 20 },
  { k: 'cry', label: 'Crying', icon: 'baby', of: (d) => (d.sleepMin > 0 || d.cries > 0 ? d.cryMin : null), fmt: (v) => `${Math.round(v)} min / day`, lowerBetter: true, min: 3 },
  { k: 'resp', label: 'Time to answer an alert', icon: 'heart', of: (d) => d.responseSec, fmt: (v) => (v < 90 ? `${Math.round(v)} s` : `${Math.round(v / 60)} min`), lowerBetter: true, min: 10 },
  { k: 'noise', label: 'Room while asleep', icon: 'gauge', of: (d) => d.sleepLaeq, fmt: (v) => `${Math.round(v)} dB`, lowerBetter: true, min: 2 },
];

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function WeekCard({ query, baby }: { query: MonQuery | null; baby: string }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [nudge, setNudge] = useState(0);
  const visible = usePageVisible();
  const loadedAt = useRef(0);
  const inflight = useRef<MonQuery | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useOnPageReturn(() => setNudge((n) => n + 1));

  useEffect(() => {
    if (!query || !visible) return; // 0 history queries while hidden
    if (loadedAt.current && Date.now() - loadedAt.current < WEEK_STALE_MS) return;
    if (inflight.current === query) return;
    inflight.current = query;
    void query.ask<{ days: Day[] }>('weeks', { days: 14 }).then((r) => {
      if (inflight.current === query) inflight.current = null;
      if (!mounted.current || !r) return;
      loadedAt.current = Date.now();
      setDays(r.days);
    });
  }, [query, visible, nudge]);

  const rows = useMemo(() => {
    if (!days || days.length < 8) return [];
    const last = days.slice(0, days.length - 7);
    const now = days.slice(-7);
    return METRICS.map((m) => {
      const a = avg(now.map(m.of));
      const b = avg(last.map(m.of));
      const delta = a != null && b != null ? a - b : null;
      const notable = delta != null && Math.abs(delta) >= m.min;
      const better = notable ? (m.lowerBetter ? delta! < 0 : delta! > 0) : null;
      const series = days.map(m.of);
      return { m, a, b, delta, notable, better, series, max: Math.max(1, ...series.map((x) => x ?? 0)) };
    }).filter((r) => r.a != null);
  }, [days]);

  const nights = days ? days.slice(-7).filter((d) => d.nightMin > 0).length : 0;
  const headline = useMemo(() => {
    const good = rows.filter((r) => r.better === true);
    const bad = rows.filter((r) => r.better === false);
    const say = (r: (typeof rows)[number]) => `${r.m.label.toLowerCase()} ${r.m.lowerBetter === (r.delta! < 0) ? 'improved' : 'changed'}: ${r.m.fmt(r.a!)} vs ${r.m.fmt(r.b!)} last week`;
    if (good.length && !bad.length) return { tone: 'good', text: `A better week — ${say(good[0])}.` };
    if (bad.length && !good.length) return { tone: 'watch', text: `Worth a look — ${bad[0].m.label.toLowerCase()} is ${bad[0].m.fmt(bad[0].a!)} vs ${bad[0].m.fmt(bad[0].b!)} last week. Teething, a cold or a schedule change often explain a rough week.` };
    if (good.length && bad.length) return { tone: 'info', text: `Mixed week — ${say(good[0])}; ${bad[0].m.label.toLowerCase()} is up.` };
    return rows.length ? { tone: 'info', text: `A steady week for ${baby}.` } : null;
  }, [rows, baby]);

  return (
    <div className="card card-pad wk-card" data-tour="mv-week">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="chart" size={17} />
        <b style={{ flex: 1 }}>This week</b>
        <span className="faint" style={{ fontSize: 12 }}>vs last week</span>
      </div>
      {!days ? (
        <p className="faint wk-empty">Loading…</p>
      ) : nights < 2 && rows.length === 0 ? (
        <p className="faint wk-empty">Your weekly picture appears after a couple of nights with the camera on — sleep, wakings, crying, response times and the room’s sound while {baby} sleeps.</p>
      ) : (
        <>
          {headline && <div className={cx('wk-head', `tone-${headline.tone}`)}>{headline.text}</div>}
          <div className="wk-rows">
            {rows.map((r) => (
              <div key={r.m.k} className="wk-row">
                <Icon name={r.m.icon} size={15} />
                <div className="wk-lbl">
                  <span>{r.m.label}</span>
                  <b>{r.m.fmt(r.a!)}</b>
                </div>
                <div className="wk-bars" aria-hidden>
                  {r.series.map((v, i) => (
                    <i key={i} className={cx(i >= r.series.length - 7 && 'now', v == null && 'none')} style={{ height: `${v == null ? 6 : Math.max(8, (v / r.max) * 100)}%` }} />
                  ))}
                </div>
                <span className={cx('wk-delta', r.better === true && 'good', r.better === false && 'bad')}>
                  {r.delta == null || !r.notable ? '—' : `${r.delta > 0 ? '▲' : '▼'} ${r.m.fmt(Math.abs(r.delta)).replace(/ \/ day| a night/, '')}`}
                </span>
              </div>
            ))}
          </div>
          {rows.some((r) => r.m.k === 'noise' && (r.a ?? 0) > 50) && (
            <p className="faint wk-note">Above 50 dB while asleep is louder than the infant-sleep guideline — usually a sound machine too close or too loud.</p>
          )}
        </>
      )}
    </div>
  );
}
