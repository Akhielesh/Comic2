// Sleep, tracked by the room from the camera's minutes: status right now, a
// week of nights and naps, and a full night report (wake-ups, longest
// stretch, room conditions, what happened and how fast the family answered).
import React, { useEffect, useState } from 'react';
import type { MonLog, NightReport, SleepSession, SleepStatus } from '../../monitor/protocol';
import type { MonQuery } from '../../monitor/query';
import { Icon } from '../../ui/icons';
import { Btn, cx, type PushToast } from '../../ui/primitives';
import { LevelChart, SleepWeek, fmtClock, fmtMins } from './charts';

const sinceText = (t: number | null) => (t ? fmtMins(Math.max(0, Math.round((Date.now() - t) / 60_000))) : '');

export function SleepCard({
  query,
  sleep,
  tz,
  baby,
  hasCrib,
  tracking,
  onOpenReport,
}: {
  query: MonQuery | null;
  sleep: SleepStatus | null;
  tz?: string;
  baby: string;
  hasCrib: boolean;
  tracking: boolean;
  onOpenReport: (session?: string) => void;
}) {
  const [sessions, setSessions] = useState<SleepSession[] | null>(null);
  const refresh = `${sleep?.phase}-${sleep?.last?.id ?? ''}-${sleep?.session ?? ''}`;

  useEffect(() => {
    if (!query) return;
    let alive = true;
    void query.ask<{ sessions: SleepSession[] }>('sleep', { days: 7 }).then((r) => alive && r && setSessions(r.sessions));
    return () => {
      alive = false;
    };
  }, [query, refresh]);

  const phase = sleep?.phase ?? 'idle';
  const status =
    !tracking ? { icon: 'moon', tone: 'neutral', line: 'Sleep tracking is off', sub: 'A parent can turn it on in Nursery settings.' }
    : phase === 'asleep' ? { icon: 'moon', tone: 'ok', line: `${baby} is asleep`, sub: `For ${sinceText(sleep!.since)}${sleep!.wakings ? ` · woke ${sleep!.wakings}× so far` : ''} · ${fmtMins(sleep!.asleepMin)} asleep this session` }
    : phase === 'awake' ? { icon: 'sun', tone: 'warn', line: `${baby} woke up`, sub: `Awake for ${sinceText(sleep!.since)} — the session ends after 30 min awake` }
    : phase === 'settling' ? { icon: 'moon', tone: 'info', line: 'Settling down', sub: `Down for sleep ${sinceText(sleep!.since)} ago — tracking starts once ${baby} is still` }
    : { icon: 'sun', tone: 'neutral', line: 'Awake / not in bed', sub: 'Sleep is detected automatically after 10 still, quiet minutes — or tap “Asleep” in Quick log.' };
  const last = sessions?.filter((s) => s.end).slice(-1)[0] ?? sleep?.last ?? null;

  return (
    <div className="card card-pad sleep-card" data-tour="mv-sleep">
      <div className={cx('sleep-now', `tone-${status.tone}`)}>
        <span className="sleep-ic"><Icon name={status.icon} size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{status.line}</b>
          <div className="faint" style={{ fontSize: 12.5 }}>{status.sub}</div>
        </div>
      </div>
      <div className="mv-sect-title" style={{ marginTop: 14 }}>Sleep · last 7 days (hours)</div>
      {sessions ? <SleepWeek sessions={sessions} tz={tz} /> : <div className="faint" style={{ fontSize: 13 }}>Loading…</div>}
      <div className="sw-legend"><span><i className="sw-night" />Night</span><span><i className="sw-nap" />Naps</span></div>
      {last && (
        <button className="sleep-last" onClick={() => onOpenReport(last.id)}>
          <Icon name={last.kind === 'night' ? 'moon' : 'sun'} size={15} />
          <span>
            <b>{last.kind === 'night' ? 'Last night' : 'Last nap'}: {fmtMins(last.asleep_min)}</b>
            <small>
              {last.onset ? `${fmtClock(last.onset, tz)} – ` : ''}{last.end ? fmtClock(last.end, tz) : 'now'} · {last.wakings ? `woke ${last.wakings}×` : 'no wake-ups'} · longest {fmtMins(last.longest_min)}
            </small>
          </span>
          <span className="linkish">Report</span>
        </button>
      )}
      {!hasCrib && tracking && (
        <div className="faint sleep-hint"><Icon name="target" size={12} /> Mark the crib on the camera (Safety → Crib) for the most accurate sleep tracking.</div>
      )}
    </div>
  );
}

const EVENT_ICON: Record<string, string> = {
  cry: 'baby', fuss: 'baby', cough: 'wind', sneeze: 'wind', alarm: 'siren', glass: 'zap', crash: 'zap', zone: 'target', crib_out: 'target',
  visit_start: 'users', woke: 'sun', asleep: 'moon', resettled: 'moon', feed: 'bottle', diaper: 'sparkles', very_loud: 'volume', loud_db: 'volume',
  machine: 'gauge', ack: 'heart', lights_on: 'sun', moved: 'video', offline: 'wifi',
};

export function ReportSheet({
  query,
  session,
  tz,
  baby,
  canDelete,
  onDelete,
  onClose,
  push,
}: {
  query: MonQuery | null;
  session?: string;
  tz?: string;
  baby: string;
  canDelete: boolean;
  onDelete: (id: string) => void;
  onClose: () => void;
  push: PushToast;
}) {
  const [report, setReport] = useState<NightReport | null | undefined>(undefined);

  useEffect(() => {
    if (!query) return;
    let alive = true;
    void query.ask<{ report: NightReport | null }>('report', { session }).then((r) => alive && setReport(r ? r.report : null));
    return () => {
      alive = false;
    };
  }, [query, session]);

  const r = report;
  const s = r?.summary ?? null;
  const end = r?.end ?? Date.now();
  const toSleep = r && r.onset && r.source === 'manual' ? Math.round((r.onset - r.start) / 60_000) : null;
  const light = s?.light == null ? null : s.light < 20 ? 'Dark' : s.light < 60 ? 'Dim' : 'Bright';
  const counts = s?.counts ?? {};
  const copy = () => {
    if (!r) return;
    const lines = [
      `${baby} — ${r.kind === 'night' ? 'night' : 'nap'} of ${new Date(r.start).toLocaleDateString()}`,
      `Asleep ${fmtMins(r.asleep_min)}${r.onset ? ` (${fmtClock(r.onset, tz)} – ${fmtClock(end, tz)})` : ''}`,
      `Wake-ups: ${r.wakings}${r.wakings ? ` · awake ${fmtMins(r.awake_min)} in total` : ''} · longest stretch ${fmtMins(r.longest_min)}`,
      r.cry_min ? `Crying: ${fmtMins(r.cry_min)}` : 'No crying',
      counts.cough ? `Coughing: ${counts.cough} time${counts.cough === 1 ? '' : 's'}` : '',
      r.laeq != null ? `Room: averaged ${Math.round(r.laeq)} dB${s?.l90 != null ? `, background ${Math.round(s.l90)} dB` : ''}` : '',
    ].filter(Boolean);
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => push('Summary copied', { icon: 'check' }));
  };

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="rep-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet report-sheet fade-in">
        <div className="sheet-head">
          <div className="sheet-icon"><Icon name={r?.kind === 'nap' ? 'sun' : 'moon'} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="rep-title" className="sheet-title serif">{r ? `${r.kind === 'night' ? 'Night' : 'Nap'} report` : 'Sleep report'}</h2>
            <div className="sheet-sub">{r ? `${new Date(r.start).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz })}${r.source === 'manual' ? ' · started from your “Asleep” tap' : ' · detected automatically'}` : ' '}</div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={17} /></button>
        </div>
        {report === undefined && <div className="faint" style={{ padding: 12 }}>Loading the report…</div>}
        {report === null && <div className="faint" style={{ padding: 12 }}>No finished sleep sessions yet. They appear after {baby}’s first tracked nap or night.</div>}
        {r && (
          <>
            <div className="rep-hero">
              <div><b>{fmtMins(r.asleep_min)}</b><span>asleep</span></div>
              <div><b>{r.onset ? fmtClock(r.onset, tz) : '—'}</b><span>fell asleep</span></div>
              <div><b>{r.end ? fmtClock(r.end, tz) : 'now'}</b><span>woke up</span></div>
              <div><b>{r.wakings}</b><span>wake-up{r.wakings === 1 ? '' : 's'}</span></div>
              <div><b>{fmtMins(r.longest_min)}</b><span>longest stretch</span></div>
              <div><b>{r.cry_min ? fmtMins(r.cry_min) : 'None'}</b><span>crying</span></div>
            </div>
            {r.pts.length > 0 && <LevelChart pts={r.pts} from={r.start} to={end} res={r.res} tz={tz} showMotion label="Sound and movement during the session" />}
            {(s?.wakeups?.length ?? 0) > 0 && (
              <div className="rep-sect">
                <div className="mv-sect-title">Wake-ups</div>
                {s!.wakeups!.map((w) => (
                  <div key={w.at} className="rep-row"><Icon name="sun" size={13} /><span>{fmtClock(w.at, tz)}</span><span className="faint">awake {fmtMins(Math.max(1, w.mins))}{w.cried ? ' · cried' : ''}</span></div>
                ))}
              </div>
            )}
            <div className="rep-sect">
              <div className="mv-sect-title">The room</div>
              <div className="rep-grid">
                <div><b>{r.laeq == null ? '—' : `${Math.round(r.laeq)} dB`}</b><span>average sound</span></div>
                <div><b>{s?.l90 == null ? '—' : `${Math.round(s.l90)} dB`}</b><span>background</span></div>
                <div><b>{s?.peak == null ? '—' : `${Math.round(s.peak)} dB`}</b><span>loudest moment</span></div>
                <div><b>{light ?? '—'}</b><span>light</span></div>
                <div><b>{s?.visits ?? 0}</b><span>visits</span></div>
                <div><b>{toSleep != null ? fmtMins(Math.max(0, toSleep)) : r.response != null ? `${Math.round(r.response)}s` : '—'}</b><span>{toSleep != null ? 'to fall asleep' : 'avg. response to alerts'}</span></div>
              </div>
              {(counts.cough || counts.sneeze || counts.snore) ? (
                <div className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>
                  {[counts.cough && `coughed ${counts.cough}×`, counts.sneeze && `sneezed ${counts.sneeze}×`, counts.snore && 'some snoring or noisy breathing'].filter(Boolean).join(' · ')}
                  {counts.snore ? ' — regular snoring is worth mentioning to your pediatrician.' : ''}
                </div>
              ) : null}
              {r.laeq != null && r.laeq >= 50 && <div className="banner warn" style={{ marginTop: 8 }}><Icon name="gauge" size={15} />The room averaged above 50 dB — consider a quieter or more distant sound machine.</div>}
            </div>
            {r.events.length > 0 && (
              <div className="rep-sect">
                <div className="mv-sect-title">What happened</div>
                <div className="rep-events">
                  {r.events.map((e: MonLog) => (
                    <div key={e.id} className={cx('rep-row', `sev-${e.sev ?? 'info'}`)}>
                      <Icon name={EVENT_ICON[e.kind] ?? 'info'} size={13} />
                      <span className="mono">{fmtClock(e.at, tz)}</span>
                      <span>{e.msg.split(' · ')[0]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
              {canDelete && <Btn variant="subtle" size="sm" icon="trash" onClick={() => { if (window.confirm('Remove this session from the sleep history? (e.g. the baby wasn’t actually in the crib)')) { onDelete(r.id); onClose(); } }}>Not a real sleep</Btn>}
              <Btn variant="soft" size="sm" icon="copy" onClick={copy}>Copy summary</Btn>
              <Btn variant="solid" size="sm" onClick={onClose}>Done</Btn>
            </div>
            <p className="faint" style={{ fontSize: 11.5, margin: '10px 0 0' }}>Estimated from the camera’s movement and sound — not a medical device.</p>
          </>
        )}
      </div>
    </div>
  );
}
