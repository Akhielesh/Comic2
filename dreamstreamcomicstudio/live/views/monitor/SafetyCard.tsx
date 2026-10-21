// Safety at a glance: open incidents (with who answered and how fast), what
// the camera is watching for and whether each guard is working, and who is
// on duty tonight.
import React, { useState } from 'react';
import type { CamStatus, Duty, Incident, MonLog, MonRole, Zone } from '../../monitor/protocol';
import type { LinkState } from '../../monitor/rtc';
import { LEVEL_BAND_INFO, levelBand } from '../../monitor/soundLevel';
import { Icon } from '../../ui/icons';
import { Btn, cx } from '../../ui/primitives';
import { fmtClock } from './charts';

const INC_ICON: Record<string, string> = {
  alarm: 'siren', glass: 'zap', crash: 'zap', zone: 'target', crib_out: 'target', cry: 'baby', very_loud: 'volume', moved: 'video', offline: 'wifi',
};

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

type Guard = { k: string; icon: string; label: string; state: 'ok' | 'warn' | 'bad' | 'off'; sub: string; action?: { label: string; run: () => void } };

export function SafetyCard({
  incidents,
  duty,
  me,
  status,
  online,
  zones,
  log,
  linkState,
  relayOn,
  baby,
  tz,
  onAck,
  onResolve,
  onDuty,
  onZones,
  compact = false,
}: {
  incidents: Incident[];
  duty: Duty | null;
  me: { uid?: string; role: MonRole } | null;
  status: CamStatus | null;
  online: boolean;
  zones: Zone[];
  log: MonLog[];
  linkState: LinkState;
  relayOn: boolean;
  baby: string;
  tz?: string;
  onAck: (inc: Incident) => void;
  onResolve: (inc: Incident) => void;
  onDuty: (on: boolean) => void;
  onZones: () => void;
  /** Monitor layout: only what needs attention, the full list one tap away. */
  compact?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const canAct = me?.role === 'parent' || me?.role === 'caregiver';
  const open = incidents.filter((i) => i.status !== 'resolved');
  const smart = status?.model === 'ready';
  const crib = zones.find((z) => z.kind === 'crib');
  const dangers = zones.filter((z) => z.kind === 'danger');
  const lastOf = (kind: string, withinMs: number) => [...log].reverse().find((e) => e.kind === kind && Date.now() - e.at < withinMs);
  const moved = lastOf('moved', 30 * 60_000);
  const machine = lastOf('machine', 12 * 60 * 60_000);
  const db = status?.spl ? Math.round(status.spl.db) : null;
  const band = db != null ? LEVEL_BAND_INFO[levelBand(db)] : null;

  const guards: Guard[] = !online
    ? [{ k: 'cam', icon: 'video', label: 'Camera', state: 'bad', sub: 'Not connected — nothing is being watched. Start a camera in the nursery.' }]
    : [
        { k: 'alarm', icon: 'siren', label: 'Smoke & CO alarms', state: 'ok', sub: smart ? 'Listening — beep pattern + smart detection' : 'Listening for the alarm beep pattern' },
        { k: 'glass', icon: 'zap', label: 'Breaking glass, bangs & falls', state: smart ? 'ok' : 'warn', sub: smart ? 'Listening' : status?.model === 'loading' ? 'Smart detection is loading on the camera' : 'Only very loud bangs (smart detection unavailable)' },
        { k: 'cry', icon: 'baby', label: 'Crying & coughing', state: 'ok', sub: smart ? 'Smart detection' : 'Cry analyser' },
        {
          k: 'crib', icon: 'target', label: 'Crib & climbing out', state: crib ? 'ok' : 'off',
          sub: crib ? `Watching the crib${status?.crib != null ? ` · movement ${status.crib}%` : ''}` : 'Mark the crib to get climb-out alerts and better sleep tracking',
          action: canAct ? { label: crib ? 'Edit' : 'Mark the crib', run: onZones } : undefined,
        },
        {
          k: 'zones', icon: 'alert', label: 'Danger zones', state: dangers.length ? 'ok' : 'off',
          sub: dangers.length ? `Watching ${dangers.map((d) => d.name).join(', ')}` : 'Optional — e.g. a window, the stairs, a dresser',
          action: canAct ? { label: dangers.length ? 'Edit' : 'Add', run: onZones } : undefined,
        },
        { k: 'pos', icon: 'video', label: 'Camera position', state: moved ? 'warn' : 'ok', sub: moved ? `Moved ${ago(moved.at)} — check it still sees the crib` : 'Steady' },
        {
          k: 'screen', icon: 'phone', label: 'Camera screen stays on',
          state: status?.paused === 'hidden' ? 'bad' : status?.awake === 'none' ? 'warn' : status?.awake ? 'ok' : 'off',
          sub: status?.paused === 'hidden'
            ? 'The camera phone locked or left the app — its video is paused'
            : status?.awake === 'none'
              ? 'The camera phone may lock and pause the video — on it: turn off Low Power Mode / Battery Saver and set Auto-Lock to Never'
              : status?.awake ? 'The camera phone won’t lock while monitoring' : 'Checking…',
        },
        {
          k: 'noise', icon: 'gauge', label: 'Room noise', state: machine ? 'warn' : db != null && db >= 80 ? 'bad' : 'ok',
          sub: machine ? `Sound machine ran above 50 dB (${fmtClock(machine.at, tz)})` : band ? `${band.label}${db != null ? ` · ${status?.spl?.cal ? '' : '≈'}${db} dB` : ''}` : 'Measuring…',
        },
        {
          k: 'power', icon: 'battery', label: 'Camera power',
          state: status?.charging ? 'ok' : status?.battery != null && status.battery <= 20 ? 'bad' : status?.charging === false ? 'warn' : 'off',
          sub: status?.charging ? `Charging${status.battery != null ? ` · ${status.battery}%` : ''}` : status?.battery != null ? `On battery · ${status.battery}% — plug it in overnight` : 'Keep the camera phone plugged in',
        },
        {
          k: 'net', icon: 'wifi', label: 'Connection', state: linkState === 'connected' ? 'ok' : relayOn ? 'warn' : 'off',
          sub: linkState === 'connected' ? 'Live video, encrypted device-to-device' : relayOn ? 'Low-bandwidth mode — alerts still arrive instantly' : 'Connecting…',
        },
      ];
  const issues = open.length + guards.filter((g) => g.state === 'bad').length;
  const mine = duty && me?.uid === duty.uid;
  const needs = guards.filter((g) => g.state === 'bad' || g.state === 'warn');
  const shown = compact && !showAll ? needs : guards;
  const okCount = guards.filter((g) => g.state === 'ok').length;

  return (
    <div className="card card-pad safety-card" data-tour="mv-safety">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="shield" size={17} />
        <b style={{ flex: 1 }}>Safety</b>
        <span className={cx('safety-pill', issues ? 'bad' : 'ok')}>{issues ? `${issues} need${issues === 1 ? 's' : ''} attention` : 'All clear'}</span>
      </div>

      {open.length > 0 && (
        <div className="inc-list">
          {open.map((i) => (
            <div key={i.id} className={cx('inc', `sev-${i.sev}`, i.status)}>
              <span className="inc-ic"><Icon name={INC_ICON[i.kind] ?? 'alert'} size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{i.title}</b>
                <small>
                  {fmtClock(i.at, tz)} · {i.status === 'acked' && i.ack_by
                    ? `${i.ack_by} answered in ${Math.max(1, Math.round(((i.ack_at ?? i.at) - i.at) / 1000))}s`
                    : `${ago(i.at)} · no one has answered${i.pushes > 1 ? ` · alerted ${i.pushes}×` : ''}`}
                </small>
              </div>
              {canAct && i.status === 'open' && <Btn variant="solid" size="sm" icon="heart" onClick={() => onAck(i)}>I’m on it</Btn>}
              {canAct && <Btn variant="subtle" size="sm" onClick={() => onResolve(i)}>All clear</Btn>}
            </div>
          ))}
        </div>
      )}

      {compact && !showAll && needs.length === 0 && (
        <div className="guard-sum"><Icon name="check" size={14} stroke={2.4} />All {okCount} checks are working{guards.some((g) => g.state === 'off') ? ' · a few optional ones are off' : ''}</div>
      )}
      <div className="guard-list">
        {shown.map((g) => (
          <div key={g.k} className={cx('guard', `st-${g.state}`)}>
            <span className="guard-dot">{g.state === 'ok' ? <Icon name="check" size={11} stroke={2.6} /> : g.state === 'off' ? '' : '!'}</span>
            <Icon name={g.icon} size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{g.label}</b>
              <small>{g.sub}</small>
            </div>
            {g.action && <button className="linkish" onClick={g.action.run}>{g.action.label}</button>}
          </div>
        ))}
      </div>
      {compact && (
        <button className="linkish guard-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only what needs attention' : `See all ${guards.length} checks`}
        </button>
      )}

      <div className={cx('duty-row', compact && 'compact')}>
        <Icon name="heart" size={15} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{duty ? `${mine ? 'You are' : `${duty.name} is`} on duty` : 'No one on duty'}</b>
          {(!compact || duty) && <small>
            {duty
              ? `Until ${fmtClock(duty.until, tz)} — crying and coughing alerts go to ${mine ? 'you' : duty.name} first. Smoke, danger zones and other hazards still reach everyone.`
              : `Everyone gets every alert. Take duty so routine alerts (crying, coughing) come to you first — if no one answers, the rest of the family is alerted.`}
          </small>}
        </div>
        {canAct && (duty ? (mine || me?.role === 'parent') && <Btn variant="subtle" size="sm" onClick={() => onDuty(false)}>End duty</Btn> : <Btn variant="soft" size="sm" onClick={() => onDuty(true)}>Take duty · 12 h</Btn>)}
      </div>
      {!compact && <p className="faint" style={{ fontSize: 11.5, margin: '10px 0 0' }}>
        {baby}’s monitor is an extra pair of eyes and ears, not a medical device — it can’t detect breathing, temperature or unsafe sleep positions.
      </p>}
    </div>
  );
}
