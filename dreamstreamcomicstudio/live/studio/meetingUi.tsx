// Studio surfaces for the one-tap flows: the Invite sheet (meetings open it by
// themselves), the "Go live now" ready check + countdown, and the camera-problem
// card that keeps the room usable while the host sorts out permission.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons';
import { Btn, cx, initials, redactUrlSearchParams } from '../ui/primitives';
import type { GuestLink } from './rtc';

/* ------------------------------------------------------------ invite sheet */

export function InviteSheet({
  url,
  meeting,
  guests,
  maxGuests,
  onClose,
  onShare,
  onCopy,
  onRotate,
}: {
  /** The guest link, or null while the room is still minting it. */
  url: string | null;
  meeting: boolean;
  guests: GuestLink[];
  maxGuests: number;
  onClose: () => void;
  onShare: () => void;
  onCopy: () => void;
  onRotate: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (url) actionsRef.current?.querySelector('button')?.focus();
  }, [url]);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);

  const taken = guests.length;
  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-labelledby="invite-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet invite-sheet">
        <div className="sheet-head">
          <span className="sheet-icon"><Icon name="users" size={19} /></span>
          <div style={{ flex: 1 }}>
            <h2 id="invite-title" className="sheet-title serif">Invite people</h2>
            <div className="sheet-sub">
              Anyone with this link joins on camera (up to {maxGuests}). Make a new link anytime to cut off old ones.
            </div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="invite-link mono" aria-label="Invite link">
          <Icon name="link" size={14} className="faint" />
          {url ? <span>{redactUrlSearchParams(url)}</span> : <span className="faint">Making your invite link…</span>}
        </div>

        <div className="invite-actions" ref={actionsRef}>
          <Btn variant="solid" icon="share" disabled={!url} onClick={onShare}>Share invite</Btn>
          <Btn variant="soft" icon="copy" disabled={!url} onClick={onCopy}>Copy link</Btn>
          <Btn
            variant={armed ? 'danger' : 'subtle'}
            icon={armed ? 'alert' : 'refresh'}
            disabled={!url}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              onRotate();
            }}
          >
            {armed ? 'Tap again — old links stop working' : 'New link'}
          </Btn>
        </div>

        <div className="invite-seats" aria-label={`${taken} of ${maxGuests} seats taken`}>
          {Array.from({ length: maxGuests }, (_, i) => {
            const g = guests[i];
            const linked = g?.state === 'connected';
            return (
              <span key={g?.sid ?? `seat-${i}`} className={cx('seat', g && 'is-taken', linked && 'is-live')} title={g ? g.name : 'Open seat'}>
                {g ? initials(g.name) : <Icon name="user" size={13} />}
              </span>
            );
          })}
          <span className="seat-note">
            {taken === 0 ? `All ${maxGuests} seats are open` : `${taken} of ${maxGuests} seats taken`}
            {guests.some((g) => g.state !== 'connected') && ' · connecting…'}
          </span>
        </div>

        <div className="sheet-foot">
          <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>
            {meeting
              ? 'Private — nothing is broadcast. Go live any time to stream this meeting to viewers.'
              : 'Guests appear in your program in Grid, Spotlight or Sidebar. No account needed.'}
          </span>
          <Btn variant="ghost" onClick={onClose}>Done</Btn>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- ready check */

export type ReadyPhase = 'checking' | 'counting' | 'tap';

function MicBar({ getLevel }: { getLevel: () => number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => {
      const lvl = Math.min(1, getLevel() * 6);
      if (ref.current) ref.current.style.transform = `scaleX(${Math.max(0.02, lvl)})`;
    }, 120);
    return () => window.clearInterval(t);
  }, [getLevel]);
  return (
    <span className="rc-meter" aria-hidden>
      <span ref={ref} />
    </span>
  );
}

export function ReadyCheck({
  camera,
  cameraLabel,
  micOk,
  roomOk,
  quality,
  phase,
  count,
  getMicLevel,
  onCancel,
  onGo,
}: {
  camera: 'waiting' | 'ok' | 'error';
  cameraLabel: string;
  micOk: boolean;
  roomOk: boolean;
  quality: string;
  phase: ReadyPhase;
  count: number;
  getMicLevel: () => number;
  onCancel: () => void;
  onGo: () => void;
}) {
  const row = (ok: boolean | null, label: string, detail: React.ReactNode) => (
    <li className={cx('rc-row', ok === true && 'is-ok', ok === false && 'is-bad')}>
      <span className="rc-dot" aria-hidden>{ok === true ? <Icon name="check" size={12} /> : ok === false ? <Icon name="x" size={12} /> : <span className="rc-spin" />}</span>
      <b>{label}</b>
      <span className="rc-detail">{detail}</span>
    </li>
  );
  return (
    <div className="ready-check" data-tour="studio-ready" role="status" aria-live="polite">
      <div className="rc-head">
        <Icon name="broadcast" size={16} />
        <b>Ready check</b>
      </div>
      <ul className="rc-list">
        {row(camera === 'ok' ? true : camera === 'error' ? false : null, 'Camera', camera === 'ok' ? cameraLabel || 'On' : camera === 'error' ? 'Not available' : 'Waiting for permission…')}
        {row(camera === 'waiting' ? null : micOk, 'Mic', micOk ? <MicBar getLevel={getMicLevel} /> : camera === 'waiting' ? 'Waiting…' : 'No microphone')}
        {row(roomOk ? true : null, 'Room', roomOk ? 'Connected' : 'Connecting…')}
        {row(true, 'Quality', quality)}
      </ul>
      <div className="rc-foot">
        {phase === 'counting' && (
          <>
            <span className="rc-count" aria-label={`Going live in ${count}`}>Going live in <b key={count}>{count}</b>…</span>
            <Btn variant="ghost" size="sm" onClick={onCancel}>Cancel</Btn>
          </>
        )}
        {phase === 'tap' && (
          <>
            <Btn variant="solid" icon="broadcast" onClick={onGo}>Tap to go live</Btn>
            <Btn variant="ghost" size="sm" onClick={onCancel}>Not yet</Btn>
          </>
        )}
        {phase === 'checking' && (
          <>
            <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>{camera === 'error' ? 'Fix the camera to go live.' : 'Getting everything ready…'}</span>
            <Btn variant="ghost" size="sm" onClick={onCancel}>Cancel</Btn>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- camera problem */

export function CameraIssue({
  message,
  starting,
  onRetry,
  onInvite,
}: {
  message: string | null;
  starting: boolean;
  onRetry: () => void;
  onInvite?: () => void;
}) {
  if (!message && !starting) return null;
  return (
    <div className="cam-issue" role={message ? 'alert' : 'status'}>
      <span className="ci-icon" aria-hidden><Icon name={message ? 'videoOff' : 'video'} size={22} /></span>
      {message ? (
        <>
          <b>Camera unavailable</b>
          <p>{message}</p>
          <div className="ci-actions">
            <Btn variant="solid" icon="refresh" onClick={onRetry}>Try again</Btn>
            {onInvite && <Btn variant="soft" icon="users" onClick={onInvite}>Invite people</Btn>}
          </div>
          <small>Your room is already open — the invite link works while you sort this out.</small>
        </>
      ) : (
        <>
          <b>Starting your camera…</b>
          <p>Allow camera and microphone when your browser asks.</p>
        </>
      )}
    </div>
  );
}
