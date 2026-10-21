// The baby tracker: running timers anyone can stop, what's likely next (nap
// sweet spot, next feed and which side), one-tap logging, today at a glance
// with gentle checks, the day's log, trends and growth. Shared live with the
// whole family through the nursery's room; works offline and catches up.
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { accessToken } from '../../account';
import { WORKER_BASE } from '../../config';
import { ageDays as ageOf, ageLabel, dayTotals, dedupeSleep, diaperCheck, doseCheck, feverCheck, nextDose, predictNextFeed, predictNextSleep } from '../../monitor/trackerScience';
import { newTrackId, type TrackerSync } from '../../monitor/trackerSync';
import type { BabyProfile, TrackData, TrackItem, TrackKind } from '../../monitor/trackTypes';
import { Icon } from '../../ui/icons';
import { Btn, cx, type PushToast } from '../../ui/primitives';
import { GrowthCard } from './GrowthCard';
import { TimerCard, stopTimer } from './TimerCard';
import { TrackSheet, type SheetGuidance } from './TrackSheet';
import { TrendsCard } from './TrendsCard';
import { KIND_META, addDays, dayStart, describe, fmtAgo, fmtClock, fmtDay, fmtDur, fmtVol, loadTempUnit, loadVolUnit, saveUnit, type TempUnit, type VolUnit } from './fmt';

const QUICK: TrackKind[] = ['breast', 'bottle', 'diaper', 'sleep', 'pump', 'solids', 'med', 'temp', 'activity', 'growth', 'note'];

export function TrackerPanel({
  nid,
  sync,
  baby,
  babyName,
  tz,
  me,
  canLog,
  isParent,
  guest,
  open,
  onSaveBaby,
  push,
}: {
  nid: string;
  sync: TrackerSync;
  baby: BabyProfile | null;
  babyName: string;
  tz?: string;
  me: string;
  canLog: boolean;
  isParent: boolean;
  guest: boolean;
  /** Open a sheet from elsewhere (the Monitor view's quick log); `n` makes each request unique. */
  open?: { kind: TrackKind; n: number } | null;
  onSaveBaby: (b: BabyProfile) => void;
  push: PushToast;
}) {
  const snap = useSyncExternalStore(sync.subscribe, sync.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const [day, setDay] = useState(() => dayStart(Date.now(), tz));
  const [sheet, setSheet] = useState<{ kind: TrackKind; item: TrackItem | null } | null>(null);
  const [units, setUnits] = useState<{ vol: VolUnit; temp: TempUnit }>(() => ({ vol: loadVolUnit(), temp: loadTempUnit() }));
  const [editBaby, setEditBaby] = useState(false);
  const [birth, setBirth] = useState(baby?.birth ?? '');
  const [sex, setSex] = useState<BabyProfile['sex']>(baby?.sex ?? null);

  // Seconds tick while a timer runs; otherwise twice a minute.
  const running = snap.running.length > 0;
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), running ? 1000 : 30_000);
    return () => window.clearInterval(t);
  }, [running]);
  useEffect(() => {
    void sync.load(Date.now() - 35 * 86_400_000, Date.now() + 86_400_000);
  }, [sync]);
  useEffect(() => {
    sync.onError = (m) => push(m, { icon: 'alert' });
    return () => {
      sync.onError = null;
    };
  }, [sync, push]);
  useEffect(() => {
    if (!open || !canLog) return;
    const run = sync.snapshot().running.find((r) => r.kind === open.kind);
    setSheet({ kind: open.kind, item: run ?? null });
  }, [open?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setBirth(baby?.birth ?? '');
    setSex(baby?.sex ?? null);
  }, [baby?.birth, baby?.sex]);

  const all = useMemo(() => dedupeSleep([...snap.items, ...snap.auto], now), [snap.items, snap.auto, now]);
  const age = ageOf(baby, now, tz);
  const nap = useMemo(() => predictNextSleep(all, baby, now, tz), [all, baby, now, tz]);
  const feed = useMemo(() => predictNextFeed(all, baby, now, tz), [all, baby, now, tz]);
  const today = useMemo(() => dayTotals(all, day, addDays(day, 1, tz), { now, tz }), [all, day, now, tz]);
  // Only judge the hours the log actually covers (a log started this morning isn't "a day with 2 diapers").
  const check = useMemo(() => {
    if (day !== dayStart(now, tz)) return null;
    const first = all.reduce((m, i) => (i.src !== 'monitor' && i.start < m ? i.start : m), now);
    const hours = Math.min(24, (now - first) / 3_600_000);
    return diaperCheck(dayTotals(all, now - hours * 3_600_000, now, { now, tz }), age, hours);
  }, [all, now, age, day, tz]);
  const dayItems = useMemo(
    () => all.filter((i) => i.start < addDays(day, 1, tz) && (i.end ?? now) >= day).sort((a, b) => b.start - a.start),
    [all, day, now, tz],
  );
  const recentMeds = useMemo(() => {
    const seen = new Map<string, { name: string; dose?: number; unit?: TrackData['unit']; everyH?: number }>();
    for (const i of [...all].reverse()) if (i.kind === 'med' && i.data.name && !seen.has(i.data.name.toLowerCase())) seen.set(i.data.name.toLowerCase(), { name: i.data.name, dose: i.data.dose, unit: i.data.unit, everyH: i.data.everyH });
    return [...seen.values()].slice(0, 5);
  }, [all]);
  const meds = useMemo(() => recentMeds.map((m) => nextDose(all, m.name, now)).filter((d): d is NonNullable<typeof d> => !!d && d.last > now - 2 * 86_400_000), [recentMeds, all, now]);
  const lastOf = (kinds: TrackKind[]) => [...all].reverse().find((i) => kinds.includes(i.kind));
  const lastFeed = lastOf(['breast', 'bottle']);
  const lastDiaper = lastOf(['diaper']);

  /* ------------------------------------------------------------ actions */
  const startTimer = (kind: TrackKind, data: TrackData) => {
    const clash = snap.running.find((r) => r.kind === kind || (kind === 'breast' && r.kind === 'bottle'));
    if (clash) {
      push(`${KIND_META[kind].label} timer is already running`, { icon: 'info' });
      return;
    }
    const d = kind === 'breast' && !data.side ? { ...data, side: feed?.suggestSide ?? 'left' } : data;
    sync.put({ id: newTrackId(), kind, start: Date.now(), end: null, by: me, data: d });
    setSheet(null);
  };
  const save = (kind: TrackKind, item: TrackItem | null, v: { start: number; end: number | null; data: TrackData }) => {
    const it: TrackItem = { id: item?.id ?? newTrackId(), kind, start: v.start, end: v.end, by: item?.by ?? me, data: v.data };
    if (kind === 'med') {
      const flag = doseCheck(all, it);
      if (flag && !window.confirm(`${flag.text}\n\nLog it anyway?`)) return;
    }
    sync.put(it);
    setSheet(null);
    if (!item) push(`${KIND_META[kind].label} logged`, { icon: 'check', duration: 1500 });
  };
  const quick = (kind: TrackKind) => {
    if (!canLog) return push('Viewers can see the tracker — ask a parent to make you a caregiver to log', { icon: 'info' });
    if (kind === 'sleep' && snap.running.some((r) => r.kind === 'sleep')) return;
    setSheet({ kind, item: null });
  };

  const guidance = useCallback(
    (kind: TrackKind, d: TrackData): SheetGuidance | null => {
      if (kind === 'temp' && d.c != null) {
        const f = feverCheck(d.c, d.method ?? null, age);
        return f.level === 'ok' ? null : { level: f.level, text: f.text };
      }
      if (kind === 'med' && d.name) {
        const n = nextDose(all, d.name, Date.now());
        if (n && n.ready === false) return { level: 'watch', text: `Last ${n.name} was ${fmtAgo(n.last, Date.now())}. You set every ${n.everyH} h — next allowed around ${fmtClock(n.at!, tz)}.` };
        if (n && n.doses24h >= 4) return { level: 'watch', text: `${n.doses24h} doses of ${n.name} in the last 24 h — check the daily maximum on the label or with your pediatrician.` };
      }
      return null;
    },
    [age, all, tz],
  );

  const exportCsv = async () => {
    const token = await accessToken();
    if (!token) return push('Sign in to download the history', { icon: 'info' });
    try {
      const res = await fetch(`${WORKER_BASE}/api/monitor/${nid}/export?what=track&from=${now - 400 * 86_400_000}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${babyName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'baby'}-tracker.csv`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      push('Couldn’t download right now', { icon: 'alert' });
    }
  };

  const isToday = day === dayStart(now, tz);

  return (
    <div className="tk" data-tour="tk">
      {/* Who, how old, units */}
      <div className="card card-pad tk-head">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <Icon name="baby" size={18} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <b className="tk-name">{babyName}</b>
            <small className="faint">{baby?.birth ? ageLabel(baby, now, tz) : isParent ? 'Add a birthday for age-based guidance' : 'Tracker'}{snap.pending ? ` · ${snap.pending} waiting to sync` : ''}</small>
          </div>
          {isParent && <button className="linkish" onClick={() => setEditBaby((v) => !v)}>{baby?.birth ? 'Edit' : 'Add birthday'}</button>}
          <button className="tk-unit" onClick={() => { const v = units.vol === 'ml' ? 'oz' : 'ml'; saveUnit('vol', v); setUnits((u) => ({ ...u, vol: v })); }} aria-label="Volume unit">{units.vol}</button>
          <button className="tk-unit" onClick={() => { const v = units.temp === 'c' ? 'f' : 'c'; saveUnit('temp', v); setUnits((u) => ({ ...u, temp: v })); }} aria-label="Temperature unit">°{units.temp.toUpperCase()}</button>
        </div>
        {editBaby && isParent && (
          <div className="tk-baby">
            <label><span>Birthday</span><input className="input" type="date" value={birth} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBirth(e.target.value)} /></label>
            <div className="ts-chips" role="radiogroup" aria-label="Sex (for WHO growth charts)">
              {(['f', 'm'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={sex === s} className={cx('cam-chip', sex === s && 'sel')} onClick={() => setSex(sex === s ? null : s)}>{s === 'f' ? 'Girl' : 'Boy'}</button>
              ))}
            </div>
            <small className="faint">Used only for age-based nap guidance and WHO growth percentiles.</small>
            <Btn variant="solid" size="sm" icon="check" onClick={() => { onSaveBaby({ birth: birth || null, sex }); setEditBaby(false); }}>Save</Btn>
          </div>
        )}
      </div>

      {/* Running timers */}
      {snap.running.map((r) => (
        <TimerCard key={r.id} item={r} now={now} tz={tz} onUpdate={(i) => sync.put(i)} onStop={(i) => { sync.put(i); if (i.kind === 'pump') setSheet({ kind: 'pump', item: i }); }} onEdit={() => setSheet({ kind: r.kind, item: r })} />
      ))}

      {/* What's next */}
      {(nap || feed || meds.length > 0) && (
        <div className="card card-pad tk-next" data-tour="tk-next">
          <div className="mv-sect-title" style={{ marginTop: 0 }}>Up next</div>
          {nap && (
            <div className="tk-next-row">
              <Icon name="moon" size={16} />
              <div style={{ flex: 1 }}>
                <b>{nap.bedtime ? 'Bedtime' : nap.napOfDay === 0 ? 'Back to sleep' : `Nap ${nap.napOfDay}`} · {fmtClock(nap.from, tz)}–{fmtClock(nap.to, tz)}</b>
                <small className="faint">{nap.at < now ? 'Past the sweet spot — watch for sleepy cues' : `Sweet spot in ${fmtDur(nap.from - now)}`} · {nap.basis === 'personal' ? `from ${babyName}’s own rhythm` : 'from typical wake windows for this age'}</small>
              </div>
            </div>
          )}
          {feed && !feed.feeding && (
            <div className="tk-next-row">
              <Icon name="bottle" size={16} />
              <div style={{ flex: 1 }}>
                <b>Next feed around {fmtClock(feed.at, tz)}{feed.suggestSide ? ` · start on the ${feed.suggestSide}` : ''}</b>
                <small className="faint">Every ~{fmtDur(feed.intervalMin * 60_000)} · last {fmtAgo(feed.lastFeed, now)} · feed on hunger cues, not the clock</small>
              </div>
            </div>
          )}
          {meds.map((d) => (
            <div key={d.name} className="tk-next-row">
              <Icon name="pill" size={16} />
              <div style={{ flex: 1 }}>
                <b>{d.name}: {d.ready === null ? `last ${fmtAgo(d.last, now)}` : d.ready ? 'next dose allowed now' : `next dose from ${fmtClock(d.at!, tz)}`}</b>
                <small className="faint">{d.doses24h} in the last 24 h{d.everyH ? ` · every ${d.everyH} h as you entered` : ''}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One tap to log */}
      <div className="card card-pad" data-tour="tk-quick">
        <div className="tk-grid">
          {QUICK.filter((k) => k !== 'solids' || age == null || age >= 120).map((k) => {
            const run = snap.running.find((r) => r.kind === k);
            return (
              <button key={k} className={cx('tk-q', `tone-${KIND_META[k].tone}`, run && 'running')} onClick={() => (run ? setSheet({ kind: k, item: run }) : quick(k))} disabled={!canLog && !run}>
                <Icon name={KIND_META[k].icon} size={22} />
                <span>{KIND_META[k].label}</span>
              </button>
            );
          })}
        </div>
        <div className="tk-lasts faint">
          {lastFeed && <span>Fed {fmtAgo(lastFeed.start, now)}</span>}
          {lastDiaper && <span>Diaper {fmtAgo(lastDiaper.start, now)}</span>}
        </div>
      </div>

      {/* The day */}
      <div className="card card-pad tk-day" data-tour="tk-day">
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="iconbtn" onClick={() => setDay((d) => addDays(d, -1, tz))} aria-label="Previous day"><Icon name="chevronLeft" size={16} /></button>
          <b style={{ flex: 1, textAlign: 'center' }}>{fmtDay(day, now, tz)}</b>
          <button className="iconbtn" disabled={isToday} onClick={() => setDay((d) => addDays(d, 1, tz))} aria-label="Next day"><Icon name="chevronRight" size={16} /></button>
        </div>
        <div className="tk-tiles">
          <div><b>{today.feeds}</b><span>feeds{today.bottleMl ? ` · ${fmtVol(today.bottleMl, units.vol)}` : ''}</span></div>
          <div><b>{fmtDur(today.sleep.totalMin * 60_000)}</b><span>sleep · {today.sleep.naps} nap{today.sleep.naps === 1 ? '' : 's'}</span></div>
          <div><b>{today.diapers.total}</b><span>diapers · {today.diapers.wetTotal} wet · {today.diapers.dirtyTotal} dirty</span></div>
          <div><b>{Math.round(today.activityMin.tummy)}</b><span>min tummy time</span></div>
        </div>
        {check && (
          <div className={cx('banner', check.level === 'call' ? 'err' : 'info')} style={{ marginTop: 10 }}>
            <Icon name={check.level === 'call' ? 'alert' : 'info'} size={15} /><span>{check.text}</span>
          </div>
        )}
        <DayRibbon items={dayItems} day={day} end={addDays(day, 1, tz)} now={now} />
        {dayItems.length === 0 ? (
          <p className="faint" style={{ fontSize: 13, margin: '10px 0 0' }}>{snap.loading ? 'Loading…' : isToday ? 'Nothing logged yet today — tap above to start.' : 'Nothing logged this day.'}</p>
        ) : (
          <ul className="tk-list">
            {dayItems.map((i) => (
              <li key={i.id}>
                <button className={cx('tk-item', `tone-${KIND_META[i.kind].tone}`)} onClick={() => i.src !== 'monitor' && canLog && setSheet({ kind: i.kind, item: i })} disabled={i.src === 'monitor' || !canLog}>
                  <span className="tk-time mono">{fmtClock(i.start, tz)}</span>
                  <Icon name={KIND_META[i.kind].icon} size={15} />
                  <span className="tk-text">{describe(i, units, now)}{i.data.note && i.kind !== 'note' ? <small className="faint"> — {i.data.note}</small> : null}</span>
                  <span className="tk-by faint">{i.src === 'monitor' ? 'camera' : i.by.split(' (')[0]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <TrendsCard items={all} baby={baby} now={now} tz={tz} vol={units.vol} />
      <GrowthCard items={all} baby={baby} now={now} tz={tz} vol={units.vol} canLog={canLog} onAdd={() => quick('growth')} />

      <div className="tk-foot faint">
        {!guest && <button className="linkish" onClick={() => void exportCsv()}><Icon name="download" size={13} /> Download for the pediatrician (CSV)</button>}
        <p>Guidance follows AAP and WHO recommendations and is general — it isn’t medical advice. Trust your instincts and call your pediatrician with any worry.</p>
      </div>

      {sheet && (
        <TrackSheet
          kind={sheet.kind}
          item={sheet.item}
          units={units}
          recentMeds={recentMeds}
          canStartTimer={!sheet.item}
          guidance={guidance}
          onStart={(data) => startTimer(sheet.kind, data)}
          onSave={(v) => save(sheet.kind, sheet.item, v)}
          onDelete={() => {
            if (sheet.item) sync.del(sheet.item.id);
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/** The day as a 24-hour ribbon: sleep, feeds and diapers in their own lanes. */
function DayRibbon({ items, day, end, now }: { items: TrackItem[]; day: number; end: number; now: number }) {
  const span = end - day;
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - day) / span) * 100))}%`;
  const w = (a: number, b: number) => `${Math.max(0.6, ((Math.min(b, end) - Math.max(a, day)) / span) * 100)}%`;
  const lanes: { k: string; label: string; kinds: TrackKind[] }[] = [
    { k: 'sleep', label: 'Sleep', kinds: ['sleep'] },
    { k: 'feed', label: 'Feeds', kinds: ['breast', 'bottle', 'solids', 'pump'] },
    { k: 'diaper', label: 'Diapers', kinds: ['diaper'] },
  ];
  return (
    <div className="tk-ribbon" aria-hidden>
      {lanes.map((l) => (
        <div key={l.k} className="tk-lane">
          <span>{l.label}</span>
          <div className="tk-track">
            {items
              .filter((i) => l.kinds.includes(i.kind))
              .map((i) => {
                const e = i.end ?? now;
                const long = e - i.start > 5 * 60_000;
                return <i key={i.id} className={cx(`tone-${KIND_META[i.kind].tone}`, !long && 'dot', i.src === 'monitor' && 'auto')} style={{ left: x(i.start), width: long ? w(i.start, e) : undefined }} />;
              })}
            {now > day && now < end && <b className="tk-now" style={{ left: x(now) }} />}
          </div>
        </div>
      ))}
      <div className="tk-hours"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
    </div>
  );
}
