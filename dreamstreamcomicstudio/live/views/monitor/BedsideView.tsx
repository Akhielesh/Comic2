// Bedside: a phone or tablet on the nightstand. Dark, calm and glanceable —
// a big clock, how the baby is, the room's sound level and the last thing
// that happened. It dims itself (deep red, kind to night vision), drifts a
// few pixels a minute so an OLED screen doesn't burn in, and lights up the
// moment something needs you.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/icons';
import { cx } from '../../ui/primitives';

export interface BedsideAlert {
  title: string;
  icon: string;
  tone: string;
  ringing: boolean;
  sub: string;
}

const DIM_AFTER_MS = 20_000;

export function BedsideView({
  stream,
  baby,
  state,
  db,
  approx,
  last,
  alert,
  muted,
  canAct,
  talking,
  wake,
  onListen,
  onTalkDown,
  onTalkUp,
  onAck,
  onExit,
}: {
  stream: MediaStream | null;
  baby: string;
  state: { label: string; tone: string; sub: string };
  db: number | null;
  approx: boolean;
  last: { text: string; at: number } | null;
  alert: BedsideAlert | null;
  muted: boolean;
  canAct: boolean;
  talking: boolean;
  wake: 'native' | 'video' | 'none';
  onListen: (on: boolean) => void;
  onTalkDown: () => void;
  onTalkUp: () => void;
  onAck: () => void;
  onExit: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [awakeAt, setAwakeAt] = useState(() => Date.now());
  const [showVideo, setShowVideo] = useState(() => {
    try {
      return localStorage.getItem('ds-bedside-video') !== '0';
    } catch {
      return true;
    }
  });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.srcObject !== stream) v.srcObject = stream;
  }, [stream, showVideo]);
  // An alert always wakes the screen.
  useEffect(() => {
    if (alert?.ringing) setAwakeAt(Date.now());
  }, [alert?.ringing, alert?.title]);

  const dim = !alert?.ringing && now - awakeAt > DIM_AFTER_MS;
  const wakeUp = () => setAwakeAt(Date.now());
  // Burn-in care: drift up to ±6 px, changing each minute.
  const minute = Math.floor(now / 60_000);
  const drift = { transform: `translate(${((minute * 7) % 13) - 6}px, ${((minute * 5) % 13) - 6}px)` };
  const time = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const ago = last ? Math.max(0, Math.round((now - last.at) / 60_000)) : null;

  const toggleVideo = () => {
    setShowVideo((v) => {
      try {
        localStorage.setItem('ds-bedside-video', v ? '0' : '1');
      } catch { /* storage unavailable */ }
      return !v;
    });
  };

  return (
    <div className={cx('bedside', dim && 'dim', alert?.ringing && `ring t-${alert.tone}`)} onPointerDown={wakeUp} role="dialog" aria-label="Bedside view">
      {showVideo && stream && <video ref={videoRef} className="bs-video" autoPlay playsInline muted />}
      <div className="bs-shade" />
      <div className="bs-body" style={drift}>
        <div className="bs-clock" aria-label={`Time ${time}`}>{time}</div>
        <div className={cx('bs-state', `tone-${state.tone}`)}>
          <span className="state-dot" />
          {baby} · {state.label}
        </div>
        <div className="bs-facts">
          {db != null && <span><Icon name="gauge" size={14} />{approx ? '≈' : ''}{Math.round(db)} dB</span>}
          {last && <span><Icon name="clock" size={14} />{last.text} · {ago === 0 ? 'just now' : `${ago} min ago`}</span>}
        </div>
        {wake === 'none' && !dim && (
          <div className="bs-note">This screen may lock by itself — set Auto-Lock / screen timeout to Never while it’s on the nightstand.</div>
        )}
      </div>

      {alert?.ringing && (
        <div className="bs-alert" role="alert">
          <Icon name={alert.icon} size={34} />
          <b>{alert.title}</b>
          <span>{alert.sub}</span>
          {canAct && (
            <button className="bs-btn solid" onClick={(e) => { e.stopPropagation(); onAck(); }}>
              <Icon name="heart" size={18} />I’m on it
            </button>
          )}
        </div>
      )}

      <div className={cx('bs-controls', dim && 'hidden')}>
        <button className={cx('bs-btn', !muted && 'on')} onClick={() => onListen(muted)} aria-pressed={!muted}>
          <Icon name={muted ? 'volumeOff' : 'volume'} size={18} />{muted ? 'Listen' : 'Sound on'}
        </button>
        {canAct && (
          <button
            className={cx('bs-btn', talking && 'on')}
            onPointerDown={onTalkDown}
            onPointerUp={onTalkUp}
            onContextMenu={(e) => e.preventDefault()}
            aria-pressed={talking}
          >
            <Icon name={talking ? 'mic' : 'micOff'} size={18} />{talking ? 'Talking' : 'Talk'}
          </button>
        )}
        <button className={cx('bs-btn', showVideo && 'on')} onClick={toggleVideo} aria-pressed={showVideo}>
          <Icon name={showVideo ? 'video' : 'videoOff'} size={18} />{showVideo ? 'Video' : 'No video'}
        </button>
        <button className="bs-btn" onClick={onExit} aria-label="Leave bedside view">
          <Icon name="x" size={18} />Exit
        </button>
      </div>
    </div>
  );
}
