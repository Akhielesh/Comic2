// Growth on the WHO Child Growth Standards (the charts the CDC and AAP
// recommend for 0–2 years): the latest weight, length and head size with
// their percentiles, and weight over age against the 3rd–97th percentile
// lines. A percentile describes, it doesn't judge — the pediatrician reads
// the trend.
import React, { useMemo, useState } from 'react';
import { ageDays as ageOf, growthForItem } from '../../monitor/trackerScience';
import type { BabyProfile, TrackItem } from '../../monitor/trackTypes';
import { DAYS_PER_MONTH, MAX_AGE_DAYS, WHO_CHART_LINES, valueAtZ, type GrowthMeasure } from '../../monitor/whoGrowth';
import { Icon } from '../../ui/icons';
import { Btn, Segmented } from '../../ui/primitives';
import type { VolUnit } from './fmt';

const MEASURES: { k: GrowthMeasure; field: 'kg' | 'cm' | 'headCm'; label: string; metric: string; imperial: string; toImp: (v: number) => number }[] = [
  { k: 'weight', field: 'kg', label: 'Weight', metric: 'kg', imperial: 'lb', toImp: (v) => v * 2.20462 },
  { k: 'length', field: 'cm', label: 'Length', metric: 'cm', imperial: 'in', toImp: (v) => v / 2.54 },
  { k: 'head', field: 'headCm', label: 'Head', metric: 'cm', imperial: 'in', toImp: (v) => v / 2.54 },
];

export function GrowthCard({ items, baby, now, tz, vol, canLog, onAdd }: { items: TrackItem[]; baby: BabyProfile | null; now: number; tz?: string; vol: VolUnit; canLog: boolean; onAdd: () => void }) {
  const [m, setM] = useState<GrowthMeasure>('weight');
  const growth = useMemo(() => items.filter((i) => i.kind === 'growth' && !i.deleted).sort((a, b) => a.start - b.start), [items]);
  const meta = MEASURES.find((x) => x.k === m)!;
  const imp = vol === 'oz';
  const show = (v: number) => (imp ? Math.round(meta.toImp(v) * 10) / 10 : Math.round(v * 100) / 100);
  const latest = (field: 'kg' | 'cm' | 'headCm') => [...growth].reverse().find((g) => g.data[field] != null);
  const age = ageOf(baby, now, tz);

  // Chart: WHO lines over the baby's age span, plus their points.
  const chart = useMemo(() => {
    if (!baby?.birth || !baby.sex) return null;
    const birth = Date.parse(`${baby.birth}T00:00:00Z`);
    const pts = growth
      .filter((g) => g.data[meta.field] != null)
      .map((g) => ({ d: (g.start - birth) / 86_400_000, v: g.data[meta.field] as number }))
      .filter((p) => p.d >= 0 && p.d <= MAX_AGE_DAYS);
    const lastD = Math.max(age ?? 0, ...pts.map((p) => p.d), 60);
    const span = Math.min(MAX_AGE_DAYS, Math.max(90, lastD + 30));
    const xs = Array.from({ length: 25 }, (_, k) => (k / 24) * span);
    const lines = WHO_CHART_LINES.map((l) => ({ pct: l.pct, pts: xs.map((d) => ({ d, v: valueAtZ(m, baby.sex, d, l.z) })).filter((p): p is { d: number; v: number } => p.v != null) }));
    const all = [...lines.flatMap((l) => l.pts.map((p) => p.v)), ...pts.map((p) => p.v)];
    return { pts, lines, span, lo: Math.min(...all), hi: Math.max(...all) };
  }, [baby, growth, m, meta.field, age]);

  const W = 300;
  const H = 150;
  const x = (d: number) => (chart ? (d / chart.span) * W : 0);
  const y = (v: number) => (chart ? H - ((v - chart.lo) / Math.max(0.001, chart.hi - chart.lo)) * (H - 8) - 4 : 0);

  return (
    <div className="card card-pad gr-card" data-tour="tk-growth">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="ruler" size={17} />
        <b style={{ flex: 1 }}>Growth</b>
        {canLog && <Btn variant="soft" size="sm" icon="plus" onClick={onAdd}>Measure</Btn>}
      </div>
      <div className="gr-latest">
        {MEASURES.map((mm) => {
          const it = latest(mm.field);
          const v = it?.data[mm.field] as number | undefined;
          const g = it ? growthForItem(it, baby, tz) : {};
          const pt = mm.k === 'weight' ? g.weight : mm.k === 'length' ? g.length : g.head;
          return (
            <div key={mm.k}>
              <span>{mm.label}</span>
              <b>{v == null ? '—' : `${imp ? Math.round(mm.toImp(v) * 10) / 10 : v} ${imp ? mm.imperial : mm.metric}`}</b>
              <small className="faint">{pt ? pt.label : v == null ? 'not measured' : baby?.sex && baby.birth ? 'beyond 2 years' : 'add birthday & sex for percentiles'}</small>
            </div>
          );
        })}
      </div>
      {chart && chart.pts.length > 0 && (
        <>
          <Segmented label="Measure" options={MEASURES.map((mm) => ({ value: mm.k, label: mm.label }))} value={m} onChange={(v) => setM(v as GrowthMeasure)} />
          <svg className="gr-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${meta.label} for age against WHO percentiles`}>
            {chart.lines.map((l) => (
              <polyline key={l.pct} className={`gr-line p${l.pct}`} fill="none" points={l.pts.map((p) => `${x(p.d)},${y(p.v)}`).join(' ')} />
            ))}
            {chart.lines.map((l) => {
              const last = l.pts[l.pts.length - 1];
              return last ? <text key={`t${l.pct}`} x={W - 2} y={y(last.v) - 2} textAnchor="end" className="gr-lbl">{l.pct}</text> : null;
            })}
            {chart.pts.map((p, i) => (
              <circle key={i} cx={x(p.d)} cy={y(p.v)} r={3.5} className="gr-pt"><title>{`${Math.round(p.d / DAYS_PER_MONTH * 10) / 10} months: ${show(p.v)} ${imp ? meta.imperial : meta.metric}`}</title></circle>
            ))}
          </svg>
          <p className="faint gr-note">WHO Child Growth Standards, 0–2 years. Lines are the 3rd, 15th, 50th, 85th and 97th percentiles. Following a curve matters more than which one — your pediatrician reads the trend.</p>
        </>
      )}
      {(!baby?.birth || !baby.sex) && growth.length > 0 && <p className="faint gr-note">Add the baby’s birthday and sex (top of the tracker) to see percentiles.</p>}
    </div>
  );
}
