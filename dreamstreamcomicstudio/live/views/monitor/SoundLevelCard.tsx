// The nursery's sound level: a live A-weighted meter from the camera phone,
// history (1 h / 6 h / 24 h) from the room's database, and plain-language
// guidance (quiet bedroom vs. a sound machine that's too loud for sleep).
//
// Push, not poll (ADR 0007 C2): the chart asks the room for history when it's
// first shown, when the range changes, and when it's stale and something new
// arrives — the room's pushed minutes, or the page coming back into view.
// Never on a timer, and never while the page is hidden.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CamStatus, HistoryPoint, MinuteRow } from '../../monitor/protocol';
import type { MonQuery } from '../../monitor/query';
import { LEVEL_BAND_INFO, leqOf, levelBand } from '../../monitor/soundLevel';
import { Icon } from '../../ui/icons';
import { useOnPageReturn, usePageVisible } from '../../ui/pageVisibility';
import { Segmented, cx } from '../../ui/primitives';
import { DbGauge, LevelChart } from './charts';

const RANGES = { '1h': 60 * 60_000, '6h': 6 * 60 * 60_000, '24h': 24 * 60 * 60_000 } as const;
type Range = keyof typeof RANGES;
/**
 * How old the history may get before something new asks for it again — one chart
 * bucket (the room answers 1 h at 1-min, 6 h at 5-min, 24 h at 15-min resolution).
 * The 1-hour chart folds in the room's pushed minutes, so it rarely needs a reload.
 */
export const SOUND_HISTORY_STALE_MS: Record<Range, number> = { '1h': 5 * 60_000, '6h': 5 * 60_000, '24h': 15 * 60_000 };

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
  const [nudge, setNudge] = useState(0);
  const visible = usePageVisible();
  const want = `${dev ?? ''}|${range}`;
  const wantRef = useRef(want);
  wantRef.current = want;
  /** What's on screen: which view of the history, and when it was fetched. */
  const loaded = useRef<{ key: string; at: number } | null>(null);
  const inflight = useRef<{ key: string; q: MonQuery } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Something new: the room pushed minutes, or the page came back. Each only asks
  // if the chart is stale (checked below), so a burst costs one query at most.
  // (Keyed on the newest row, not the count: the viewer keeps only the last 240.)
  const newest = liveMinutes.length ? liveMinutes[liveMinutes.length - 1] : null;
  const liveKey = newest ? `${newest.dev}:${newest.m}:${liveMinutes.length}` : '';
  useEffect(() => {
    if (liveKey) setNudge((n) => n + 1);
  }, [liveKey]);
  useOnPageReturn(() => setNudge((n) => n + 1));

  useEffect(() => {
    if (!query || !visible) return; // 0 history queries while hidden
    const key = want;
    const cur = loaded.current;
    if (cur && cur.key === key && Date.now() - cur.at < SOUND_HISTORY_STALE_MS[range]) return;
    if (inflight.current && inflight.current.key === key && inflight.current.q === query) return;
    const mine = { key, q: query };
    inflight.current = mine;
    setLoading(true);
    const to = Date.now();
    void query.ask<{ from: number; to: number; res: number; pts: HistoryPoint[] }>('history', { from: to - RANGES[range], to, dev: dev ?? undefined }).then((r) => {
      if (inflight.current === mine) inflight.current = null;
      if (!mounted.current || wantRef.current !== key) return;
      // Only a real answer counts as loaded — a timeout asks again on the next nudge.
      if (r) {
        loaded.current = { key, at: Date.now() };
        setData({ from: r.from, to: r.to, res: r.res, pts: r.pts });
      }
      setLoading(false);
    });
  }, [query, want, dev, range, visible, nudge]);

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
