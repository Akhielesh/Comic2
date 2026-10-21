// The nursery's sound level: a live A-weighted meter from the camera phone,
// history (1 h / 6 h / 24 h) from the room's database, and plain-language
// guidance (quiet bedroom vs. a sound machine that's too loud for sleep).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CamStatus, HistoryPoint, MinuteRow } from '../../monitor/protocol';
import type { MonQuery } from '../../monitor/query';
import { LEVEL_BAND_INFO, leqOf, levelBand } from '../../monitor/soundLevel';
import { Icon } from '../../ui/icons';
import { Segmented, cx } from '../../ui/primitives';
import { DbGauge, LevelChart } from './charts';

const RANGES = { '1h': 60 * 60_000, '6h': 6 * 60 * 60_000, '24h': 24 * 60 * 60_000 } as const;
type Range = keyof typeof RANGES;

export function SoundLevelCard({
  query,
  dev,
  spl,
  online,
  liveMinutes,
  tz,
  machineCheck,
}: {
  query: MonQuery | null;
  dev: string | null;
  spl: CamStatus['spl'] | null | undefined;
  online: boolean;
  liveMinutes: MinuteRow[];
  tz?: string;
  machineCheck: boolean;
}) {
  const [range, setRange] = useState<Range>('6h');
  const [data, setData] = useState<{ from: number; to: number; res: number; pts: HistoryPoint[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const loadedAt = useRef(0);

  // New minutes arrived: refresh the chart (at most every 45 s).
  const liveCount = liveMinutes.length;
  useEffect(() => {
    if (!liveCount) return;
    const wait = Math.max(0, 45_000 - (Date.now() - loadedAt.current));
    const t = window.setTimeout(() => setReload((n) => n + 1), wait + 1500);
    return () => window.clearTimeout(t);
  }, [liveCount]);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    const load = async () => {
      loadedAt.current = Date.now();
      setLoading(true);
      const to = Date.now();
      const r = await query.ask<{ from: number; to: number; res: number; pts: HistoryPoint[] }>('history', { from: to - RANGES[range], to, dev: dev ?? undefined });
      if (alive) {
        if (r) setData({ from: r.from, to: r.to, res: r.res, pts: r.pts });
        setLoading(false);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), range === '1h' ? 60_000 : 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [query, dev, range, reload]);

  // Fold in minutes that arrived live since the last load (1-minute charts).
  const chart = useMemo(() => {
    if (!data) return null;
    const now = Date.now();
    const from = now - RANGES[range];
    let pts = data.pts.filter((p) => p.t >= from - data.res);
    if (data.res === 60_000) {
      const have = new Set(pts.map((p) => p.t));
      const extra = liveMinutes
        .filter((r) => (!dev || r.dev === dev) && r.m >= from && !have.has(r.m))
        .map((r): HistoryPoint => ({ t: r.m, laeq: r.laeq, lmax: r.lmax, l90: r.l90, motion: r.motion, crib: r.crib, light: r.light, state: r.state, cal: r.cal, visit: r.visit, sounds: r.sounds }));
      pts = [...pts, ...extra].sort((a, b) => a.t - b.t);
    }
    return { ...data, from, to: now, pts };
  }, [data, liveMinutes, range, dev]);

  // The last hour at a glance.
  const hour = useMemo(() => {
    if (!chart) return null;
    const since = Date.now() - 60 * 60_000;
    const recent = chart.pts.filter((p) => p.t >= since);
    const leqs = recent.map((p) => p.laeq).filter((v): v is number => v != null);
    if (!leqs.length) return null;
    const l90s = recent.map((p) => p.l90).filter((v): v is number => v != null);
    const maxes = recent.map((p) => p.lmax).filter((v): v is number => v != null);
    return {
      leq: Math.round(leqOf(leqs)),
      bg: l90s.length ? Math.round(l90s.reduce((a, b) => a + b, 0) / l90s.length) : null,
      max: maxes.length ? Math.round(Math.max(...maxes)) : null,
      minutes: recent.length,
    };
  }, [chart]);

  const db = spl && online ? Math.round(spl.db) : null;
  const approx = spl ? !spl.cal : true;
  const band = db != null ? LEVEL_BAND_INFO[levelBand(db)] : null;
  const machine = machineCheck && hour && hour.leq >= 50 && hour.bg != null && hour.leq - hour.bg <= 6 && hour.minutes >= 30;

  return (
    <div className="card card-pad sl-card" data-tour="mv-sound">
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <Icon name="gauge" size={17} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mv-sect-title" style={{ margin: 0 }}>Sound level</div>
          <div className="faint" style={{ fontSize: 12 }}>A-weighted decibels measured by the camera phone{approx ? ' · approximate until calibrated' : ' · calibrated'}</div>
        </div>
      </div>
      <div className="sl-now">
        <div className={cx('sl-big', band && `t-${band.tone}`)}>
          {db == null ? '—' : <>{approx ? <small>≈</small> : null}{db}<small> dB</small></>}
        </div>
        <div className="sl-band">
          <b>{band ? band.label : online ? 'Measuring…' : 'Camera offline'}</b>
          <span className="faint">{band ? band.like : 'The camera phone measures the room’s sound level continuously.'}</span>
        </div>
      </div>
      <DbGauge db={db} approx={approx} />
      {hour && (
        <div className="sl-stats">
          <div><b>{approx ? '≈' : ''}{hour.leq}</b><span>average · last hour</span></div>
          <div><b>{hour.bg == null ? '—' : `${approx ? '≈' : ''}${hour.bg}`}</b><span>background</span></div>
          <div><b>{hour.max == null ? '—' : `${approx ? '≈' : ''}${hour.max}`}</b><span>loudest</span></div>
        </div>
      )}
      {machine && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          <Icon name="alert" size={15} />
          <span>
            A steady sound has averaged {approx ? 'about ' : ''}{hour!.leq} dB for the last hour — above the 50 dB guideline for infant sleep.
            Move the sound machine farther from the crib (2 m / 6½ ft or more) or turn it down.
          </span>
        </div>
      )}
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Segmented label="Range" options={[{ value: '1h', label: '1 h' }, { value: '6h', label: '6 h' }, { value: '24h', label: '24 h' }]} value={range} onChange={(v) => setRange(v as Range)} />
        <span className="spacer" />
        {loading && <span className="faint" style={{ fontSize: 12 }}>Loading…</span>}
      </div>
      {chart && chart.pts.length > 0 ? (
        <LevelChart pts={chart.pts} from={chart.from} to={chart.to} res={chart.res} tz={tz} label={`Sound level over the last ${range}`} />
      ) : (
        <div className="faint sl-empty">{chart ? 'No measurements in this window yet — they appear minute by minute while a camera is on.' : 'Loading history…'}</div>
      )}
    </div>
  );
}
