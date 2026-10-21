// The last 7 / 14 / 30 days at a glance — sleep (night + naps), feeds,
// bottle volume and diapers per day — with a few plain-language insights on
// top. Inline SVG, no chart library.
import React, { useMemo, useState } from 'react';
import { dayTotals, insights, type DayTotals } from '../../monitor/trackerScience';
import type { BabyProfile, TrackItem } from '../../monitor/trackTypes';
import { Icon } from '../../ui/icons';
import { Segmented, cx } from '../../ui/primitives';
import { addDays, dayStart, fmtVol, type VolUnit } from './fmt';

type Range = '7' | '14' | '30';

function Bars({ days, series, max, unit, label }: { days: { t: number; key: string }[]; series: { key: string; tone: string; label: string; values: number[] }[]; max: number; unit: string; label: string }) {
  const w = 300;
  const h = 96;
  const n = days.length;
  const bw = Math.max(2, (w - (n - 1) * 2) / n);
  const top = Math.max(1, max);
  return (
    <figure className="tr-chart" aria-label={label}>
      <svg viewBox={`0 0 ${w} ${h + 14}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={w} y1={h - h * f} y2={h - h * f} className="tr-grid" />
        ))}
        {days.map((d, i) => {
          let y = h;
          return (
            <g key={d.key}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                const bh = (v / top) * h;
                y -= bh;
                return bh > 0 ? <rect key={s.key} x={i * (bw + 2)} y={y} width={bw} height={bh} rx={Math.min(2, bw / 3)} className={`tr-bar t-${s.tone}`}><title>{`${s.label}: ${Math.round(v * 10) / 10} ${unit}`}</title></rect> : null;
              })}
              {(n <= 14 || i % 5 === 0) && (
                <text x={i * (bw + 2) + bw / 2} y={h + 12} className="tr-x" textAnchor="middle">{d.key}</text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="tr-legend">
        {series.map((s) => (
          <span key={s.key}><i className={`t-${s.tone}`} />{s.label}</span>
        ))}
        <span className="faint">max {Math.round(max * 10) / 10} {unit}</span>
      </figcaption>
    </figure>
  );
}

export function TrendsCard({ items, baby, now, tz, vol }: { items: TrackItem[]; baby: BabyProfile | null; now: number; tz?: string; vol: VolUnit }) {
  const [range, setRange] = useState<Range>('7');
  const days = useMemo(() => {
    const n = Number(range);
    const today = dayStart(now, tz);
    return Array.from({ length: n }, (_, k) => {
      const t = addDays(today, k - n + 1, tz);
      let key = '';
      try {
        key = new Date(t + 12 * 3_600_000).toLocaleDateString([], { weekday: n <= 7 ? 'short' : undefined, day: n > 7 ? 'numeric' : undefined, timeZone: tz }).replace(/\.$/, '');
      } catch {
        key = String(new Date(t).getDate());
      }
      return { t, key };
    });
  }, [range, now, tz]);
  const totals: DayTotals[] = useMemo(() => days.map((d) => dayTotals(items, d.t, addDays(d.t, 1, tz), { now, tz })), [days, items, now, tz]);
  const tips = useMemo(() => insights(items, baby, now, tz), [items, baby, now, tz]);
  const logged = totals.filter((t) => t.feeds + t.diapers.total + t.sleep.totalMin > 0).length;

  const avg = (f: (t: DayTotals) => number) => {
    const xs = totals.filter((t) => t.feeds + t.diapers.total + t.sleep.totalMin > 0).map(f);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  const sleepH = totals.map((t) => t.sleep.totalMin / 60);
  const ml = totals.map((t) => t.bottleMl);

  return (
    <div className="card card-pad tr-card" data-tour="tk-trends">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="chart" size={17} />
        <b style={{ flex: 1 }}>Trends</b>
        <Segmented label="Range" options={[{ value: '7', label: '7 d' }, { value: '14', label: '14 d' }, { value: '30', label: '30 d' }]} value={range} onChange={(v) => setRange(v as Range)} />
      </div>

      {tips.length > 0 && (
        <ul className="tr-tips">
          {tips.map((t) => (
            <li key={t.id} className={cx(`tone-${t.tone}`)}>
              <Icon name={t.tone === 'good' ? 'sparkles' : t.tone === 'watch' ? 'alert' : 'info'} size={14} />
              <span>{t.text}</span>
            </li>
          ))}
        </ul>
      )}

      {logged < 2 ? (
        <p className="faint" style={{ fontSize: 13, margin: '12px 0 0' }}>Trends appear after a couple of days of logging — feeds, diapers and sleep (the camera logs sleep by itself).</p>
      ) : (
        <>
          <div className="tr-avgs">
            <div><b>{(avg((t) => t.sleep.totalMin) / 60).toFixed(1)} h</b><span>sleep / day</span></div>
            <div><b>{avg((t) => t.feeds).toFixed(1)}</b><span>feeds / day</span></div>
            <div><b>{avg((t) => t.diapers.wetTotal).toFixed(1)}</b><span>wet diapers / day</span></div>
          </div>
          <div className="mv-sect-title" style={{ marginTop: 14 }}>Sleep</div>
          <Bars
            days={days}
            label="Hours of sleep per day"
            unit="h"
            max={Math.max(...sleepH, 1)}
            series={[
              { key: 'n', tone: 'indigo', label: 'Night', values: totals.map((t) => t.sleep.nightMin / 60) },
              { key: 'd', tone: 'sky', label: 'Naps', values: totals.map((t) => t.sleep.dayMin / 60) },
            ]}
          />
          <div className="mv-sect-title">Feeds</div>
          <Bars
            days={days}
            label="Feeds per day"
            unit="feeds"
            max={Math.max(...totals.map((t) => t.feeds), 1)}
            series={[
              { key: 'b', tone: 'rose', label: 'Breast', values: totals.map((t) => t.breastFeeds) },
              { key: 'o', tone: 'amber', label: 'Bottle', values: totals.map((t) => t.bottleFeeds) },
            ]}
          />
          {ml.some((x) => x > 0) && (
            <p className="faint tr-note">Bottles: {fmtVol(avg((t) => t.bottleMl), vol)} a day on average · most {fmtVol(Math.max(...ml), vol)}</p>
          )}
          <div className="mv-sect-title">Diapers</div>
          <Bars
            days={days}
            label="Diapers per day"
            unit="diapers"
            max={Math.max(...totals.map((t) => t.diapers.total), 1)}
            series={[
              { key: 'w', tone: 'teal', label: 'Wet', values: totals.map((t) => t.diapers.wet) },
              { key: 'b', tone: 'violet', label: 'Both', values: totals.map((t) => t.diapers.both) },
              { key: 'd', tone: 'brown', label: 'Dirty', values: totals.map((t) => t.diapers.dirty) },
            ]}
          />
        </>
      )}
    </div>
  );
}
