// A running timer (breastfeed, sleep, pump, tummy time…) that any phone in
// the family can switch or stop. Breast sides are derived from the entry
// itself — the current side started after the finished sides' seconds — so
// every device shows the same numbers without extra state.
import React from 'react';
import type { TrackItem } from '../../monitor/trackTypes';
import { Icon } from '../../ui/icons';
import { Btn, cx } from '../../ui/primitives';
import { ACTIVITY_LABEL, KIND_META, fmtClock } from './fmt';

const mmss = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** Seconds per side right now, counting the side that's running. */
export function breastSides(i: TrackItem, now: number): { left: number; right: number; current: 'left' | 'right' | null } {
  const left = i.data.left ?? 0;
  const right = i.data.right ?? 0;
  const end = i.end ?? now;
  const current = i.end == null ? i.data.side ?? null : null;
  const running = current ? Math.max(0, (end - i.start) / 1000 - left - right) : 0;
  return { left: left + (current === 'left' ? running : 0), right: right + (current === 'right' ? running : 0), current };
}

/** The entry after switching to `side` (the finished segment is banked). */
export function switchSide(i: TrackItem, side: 'left' | 'right', now: number): TrackItem {
  const s = breastSides(i, now);
  return { ...i, data: { ...i.data, left: Math.round(s.left), right: Math.round(s.right), side } };
}

/** The entry, stopped now. */
export function stopTimer(i: TrackItem, now: number): TrackItem {
  if (i.kind === 'breast') {
    const s = breastSides(i, now);
    return { ...i, end: now, data: { ...i.data, left: Math.round(s.left), right: Math.round(s.right) } };
  }
  return { ...i, end: now };
}

export function TimerCard({ item, now, tz, onUpdate, onStop, onEdit }: { item: TrackItem; now: number; tz?: string; onUpdate: (i: TrackItem) => void; onStop: (i: TrackItem) => void; onEdit: () => void }) {
  const meta = KIND_META[item.kind];
  const total = (now - item.start) / 1000;
  const title = item.kind === 'activity' && item.data.type ? ACTIVITY_LABEL[item.data.type] : item.kind === 'sleep' ? 'Asleep' : item.kind === 'breast' ? 'Breastfeeding' : item.kind === 'pump' ? 'Pumping' : meta.label;
  const sides = item.kind === 'breast' ? breastSides(item, now) : null;

  return (
    <div className={cx('timer-card', `tone-${meta.tone}`)} aria-live="off">
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="tc-icon"><Icon name={meta.icon} size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{title}</b>
          <small className="faint">since {fmtClock(item.start, tz)} · {item.by.split(' (')[0]}</small>
        </div>
        <span className="tc-time mono">{mmss(total)}</span>
      </div>
      {sides && (
        <div className="tc-sides">
          {(['left', 'right'] as const).map((side) => (
            <button
              key={side}
              type="button"
              className={cx('tc-side', sides.current === side && 'on')}
              aria-pressed={sides.current === side}
              onClick={() => sides.current !== side && onUpdate(switchSide(item, side, Date.now()))}
            >
              <b>{side === 'left' ? 'Left' : 'Right'}</b>
              <span className="mono">{mmss(sides[side])}</span>
              <small>{sides.current === side ? 'feeding' : 'tap to switch'}</small>
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <Btn variant="solid" size="sm" icon="stop" onClick={() => onStop(stopTimer(item, Date.now()))}>
          {item.kind === 'sleep' ? 'Woke up' : 'Stop'}
        </Btn>
        <Btn variant="subtle" size="sm" icon="edit" onClick={onEdit}>Edit</Btn>
      </div>
    </div>
  );
}
