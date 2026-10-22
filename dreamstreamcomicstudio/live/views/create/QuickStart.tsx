// The top of Create: an optional title and two big one-tap cards — "Instant meeting"
// and "Go live now". Everything else (schedule, invite page, quality, access, cap,
// recording) waits under Advanced.
import React from 'react';
import { MAX_GUESTS } from '../../protocol';
import type { QuickKind } from '../../quickStart';
import { Icon } from '../../ui/icons';
import { Field, cx } from '../../ui/primitives';
import { QUICK_BUSY_COPY } from './useQuickStart';

interface CardDef {
  kind: QuickKind;
  tour: string;
  icon: string;
  title: string;
  body: (maxViewers: number) => string;
  cta: string;
}

const CARDS: CardDef[] = [
  {
    kind: 'meeting',
    tour: 'create-meeting',
    icon: 'users',
    title: 'Instant meeting',
    body: () => `Invite up to ${MAX_GUESTS} people on camera. Private — nothing is broadcast unless you go live.`,
    cta: 'Start meeting',
  },
  {
    kind: 'live',
    tour: 'create-golive',
    icon: 'broadcast',
    title: 'Go live now',
    body: (n) => `Broadcast to up to ${n} viewers. They join with just a name.`,
    cta: 'Go live',
  },
];

export function QuickStart({
  title,
  onTitle,
  placeholder,
  busy,
  disabled,
  maxViewers,
  defaultsLine,
  onStart,
  onOpenAdvanced,
  error,
}: {
  title: string;
  onTitle: (v: string) => void;
  placeholder: string;
  busy: QuickKind | null;
  /** Hard block (backend known unreachable). */
  disabled: boolean;
  maxViewers: number;
  defaultsLine: string;
  onStart: (kind: QuickKind) => void;
  onOpenAdvanced: () => void;
  error: string | null;
}) {
  return (
    <div className="card card-pad quick-start" data-tour="create-quick">
      <Field label="Title" hint="optional — we’ll name it for you" className="tour-anchor">
        <input
          data-tour="create-title"
          className="input"
          value={title}
          maxLength={120}
          placeholder={placeholder}
          onChange={(e) => onTitle(e.target.value)}
        />
      </Field>
      <div className="qs-grid">
        {CARDS.map((c) => {
          const mine = busy === c.kind;
          return (
            <button
              key={c.kind}
              type="button"
              className={cx('quick-card', `qc-${c.kind}`, mine && 'is-busy')}
              data-tour={c.tour}
              disabled={disabled || busy != null}
              aria-busy={mine || undefined}
              onClick={() => onStart(c.kind)}
            >
              <span className="qc-icon" aria-hidden><Icon name={c.icon} size={22} /></span>
              <span className="qc-title">{c.title}</span>
              <span className="qc-body">{c.body(maxViewers)}</span>
              <span className="qc-cta">
                {mine ? <span className="qc-spin" aria-hidden /> : null}
                {mine ? QUICK_BUSY_COPY[c.kind] : c.cta}
                {!mine && <Icon name="arrowRight" size={15} />}
              </span>
            </button>
          );
        })}
      </div>
      <p className="quick-defaults">
        <Icon name="sliders" size={13} />
        <span>
          {defaultsLine} —{' '}
          <button type="button" className="linkish" onClick={onOpenAdvanced}>change in Advanced</button>
        </span>
      </p>
      {error && <div className="banner err" role="alert"><Icon name="alert" size={15} />{error}</div>}
    </div>
  );
}
