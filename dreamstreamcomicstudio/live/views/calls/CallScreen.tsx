// The call itself, FaceTime-style: the people you're talking to fill the
// screen, you're a small picture in a corner, and five round buttons do
// everything — mute, camera, flip, add someone, hang up. Controls fade away
// while you talk; a tap brings them back. Minimize keeps the call going in a
// small floating window while you use the rest of the app.
//
// It never spins forever: after 8 s it says "Still connecting…", and if a
// connection can't be made it says why (your network, theirs, or the two
// can't reach each other directly) with Try again and Audio only.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { callCenter, type ActiveView } from '../../calls/callCenter';
import { failureText, type PeerView } from '../../calls/callMesh';
import { MAX_IN_CALL } from '../../calls/types';
import { listPeople, type NurseryPerson } from '../../monitor/client';
import { Icon } from '../../ui/icons';
import { Avatar, cx, type PushToast } from '../../ui/primitives';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

/** A <video> bound to a stream; audio plays from it unless muted. */
function StreamVideo({ stream, muted, mirror, className }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} className={cx(className, mirror && 'mirror')} autoPlay playsInline muted={muted} />;
}

/** Whether a stream's video is really arriving (not a camera-off black frame). */
function useHasVideo(stream: MediaStream | null, cam: boolean): boolean {
  const [live, setLive] = useState(false);
  // The stream stays the same while tracks swap inside it: follow the track itself.
  const track = stream?.getVideoTracks()[0] ?? null;
  useEffect(() => {
    const t = track;
    if (!t) {
      setLive(false);
      return;
    }
    const upd = () => setLive(t.readyState === 'live' && !t.muted);
    upd();
    t.addEventListener('mute', upd);
    t.addEventListener('unmute', upd);
    t.addEventListener('ended', upd);
    return () => {
      t.removeEventListener('mute', upd);
      t.removeEventListener('unmute', upd);
      t.removeEventListener('ended', upd);
    };
  }, [track]);
  return live && cam;
}

const tileText = (p: PeerView): string => {
  if (p.state === 'connected') return p.cam ? '' : 'Camera off';
  if (p.state === 'slow') return 'Still connecting…';
  if (p.state === 'failed') return '';
  return 'Connecting…';
};

/** One person. `solo`: the only other person (the big status panel explains a failure instead). */
function Tile({ p, solo }: { p: PeerView; solo?: boolean }) {
  const video = useHasVideo(p.stream, p.cam);
  const who = p.label || p.name;
  return (
    <div className={cx('call-tile', !video && 'no-video')} data-uid={p.uid} data-state={p.state}>
      <StreamVideo stream={p.stream} className={cx('call-tile-v', !video && 'hidden')} />
      {!video && (
        <div className="call-tile-face">
          <Avatar name={p.name} size={92} />
          <span>{tileText(p)}</span>
        </div>
      )}
      <div className="call-tile-name">
        {!p.mic && <Icon name="micOff" size={13} />}
        <span>{who}</span>
        {p.quality === 'poor' && p.state === 'connected' && <em className="call-weak">weak connection</em>}
      </div>
      {p.state === 'failed' ? (
        !solo && (
          <div className="call-tile-veil failed" role="status">
            <b><Icon name="alert" size={15} />Couldn’t connect</b>
            <small>{failureText(p.why, who)}</small>
            <button className="call-pill sm" onClick={() => callCenter.retry()}><Icon name="refresh" size={13} />Try again</button>
          </div>
        )
      ) : (
        (p.state === 'reconnecting' || p.away) && <div className="call-tile-veil"><Icon name="refresh" size={16} />Reconnecting…</div>
      )}
    </div>
  );
}

function CallButton({ icon, label, on, danger, onClick, disabled }: { icon: string; label: string; on?: boolean; danger?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={cx('call-btn', on && 'on', danger && 'danger')} onClick={onClick} aria-label={label} aria-pressed={on} disabled={disabled}>
      <span className="call-btn-ic"><Icon name={icon} size={24} /></span>
      <small>{label}</small>
    </button>
  );
}

export function CallScreen({ a, push }: { a: ActiveView; push: PushToast }) {
  const [now, setNow] = useState(() => Date.now());
  const [chrome, setChrome] = useState(true);
  const [mini, setMini] = useState(false);
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<NurseryPerson[] | null>(null);
  const hideRef = useRef<number | undefined>(undefined);
  const [corner, setCorner] = useState<'br' | 'bl' | 'tr' | 'tl'>('br');
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Controls fade out while you talk; any tap brings them back.
  const poke = () => {
    setChrome(true);
    window.clearTimeout(hideRef.current);
    if (a.state === 'connected') hideRef.current = window.setTimeout(() => setChrome(false), 5000);
  };
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideRef.current);
  }, [a.state]); // eslint-disable-line react-hooks/exhaustive-deps

  // A finished call closes itself after a moment (unless there's a choice to make).
  useEffect(() => {
    if (a.state !== 'ended') return;
    const t = window.setTimeout(() => callCenter.dismiss(), a.ended?.why === 'done' ? 2500 : 9000);
    return () => window.clearTimeout(t);
  }, [a.state, a.ended?.why]);

  // Who else could join: the nursery's people not already in (or rung for) the call.
  useEffect(() => {
    if (!adding || people) return;
    void listPeople(a.nid).then((r) => setPeople(r.ok ? r.people ?? [] : []));
  }, [adding, people, a.nid]);

  const others = a.peers;
  const inCall = new Set([...(a.call?.parts.map((p) => p.uid) ?? [])]);
  const addable = (people ?? []).filter((p) => !p.is_me && !inCall.has(p.user_id));
  const full = (a.call?.parts.length ?? 1) >= MAX_IN_CALL;

  const title = useMemo(() => {
    if (others.length) return others.map((p) => p.label || p.name).join(', ');
    if (a.asked.length) return a.asked.map((p) => p.name).join(', ');
    return a.call ? a.call.from.label || a.call.from.name : 'Call';
  }, [others, a.asked, a.call]);

  const status =
    a.state === 'ended' ? a.ended?.text ?? 'Call ended'
    : a.state === 'calling' ? (a.call ? 'Ringing…' : 'Calling…')
    : a.state === 'connecting' || a.state === 'starting' ? 'Connecting…'
    : a.state === 'slow' ? 'Still connecting…'
    : a.state === 'failed' ? 'Couldn’t connect'
    : a.since ? clock(now - a.since) : '';
  const lan = others.length > 0 && others.every((p) => p.path === 'lan');
  const relayed = a.state === 'connected' && others.some((p) => p.path === 'relay');
  const waiting = a.state !== 'connected';
  const failed = a.state === 'failed';

  const micText = async () => {
    const err = await callCenter.toggleMic();
    if (err) push(err, { icon: 'alert', duration: 6000 });
  };

  const onSelfDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onSelfUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12) return;
    // Snap to the nearest corner, like FaceTime.
    const right = e.clientX > window.innerWidth / 2;
    const bottom = e.clientY > window.innerHeight / 2;
    setCorner(`${bottom ? 'b' : 't'}${right ? 'r' : 'l'}` as typeof corner);
  };

  const camText = async () => {
    const err = await callCenter.toggleCam();
    if (err) push(err, { icon: 'alert', duration: 6000 });
  };

  if (mini) {
    const lead = others[0];
    return (
      <div className="call-mini" role="dialog" aria-label={`Call with ${title}`}>
        <button className="call-mini-body" onClick={() => setMini(false)} aria-label="Back to the call">
          {lead ? <Tile p={lead} /> : <div className="call-tile no-video"><div className="call-tile-face"><Avatar name={title} size={56} /></div></div>}
          <span className="call-mini-time">{status}</span>
        </button>
        <button className="call-mini-end" onClick={() => callCenter.hangup()} aria-label="Hang up"><Icon name="phone" size={16} /></button>
        {/* Other people's audio keeps playing from the tile above. */}
        {others.slice(1).map((p) => <StreamVideo key={p.uid} stream={p.stream} className="call-hidden-audio" />)}
      </div>
    );
  }

  return (
    <div className={cx('call-root', !chrome && 'quiet', `n-${Math.max(1, others.length)}`)} role="dialog" aria-label={`Call with ${title}`} onPointerDown={poke}>
      {/* Your own picture fills the screen until someone picks up. */}
      {waiting && a.cam && <StreamVideo stream={a.local} muted mirror={a.facing === 'user'} className="call-backdrop" />}
      {others.length > 0 && (
        <div className="call-tiles">
          {others.map((p) => <Tile key={p.uid} p={p} solo={others.length === 1} />)}
        </div>
      )}

      <div className="call-top">
        <button className="call-icon-btn" onClick={() => setMini(true)} aria-label="Minimize the call" title="Minimize"><Icon name="chevronDown" size={20} /></button>
        <div className="call-title">
          <b>{title}</b>
          <span>
            {a.call?.video === false && a.state !== 'ended' ? 'Audio · ' : ''}{status}
            {lan && a.state === 'connected' ? ' · Home Wi-Fi' : relayed ? ' · via relay' : ''}
          </span>
        </div>
        {a.relayTest && a.state !== 'ended' && <span className="call-relay-tag" title="Relay test mode (?relay=1): media may only go through the relay server">Relay test</span>}
        <span className="call-lock" title="Encrypted device to device. Never recorded."><Icon name="lock" size={14} /></span>
      </div>

      {a.busy && a.state === 'connected' && (
        <div className="call-busy" role="status"><Icon name="alert" size={13} />Your phone is busy — sending smaller video to keep up</div>
      )}

      {(waiting || others.length === 0) && (
        <div className={cx('call-status', failed && 'failed')} role={failed ? 'alert' : undefined}>
          <div className={cx('call-faces', a.state === 'calling' && 'pulse')}>
            {(a.asked.length ? a.asked.map((p) => p.name) : [a.call?.from.name ?? title]).slice(0, 3).map((n) => <Avatar key={n} name={n} size={a.asked.length > 1 ? 72 : 104} />)}
          </div>
          <b>{title}</b>
          <span>{status}</span>
          {a.state === 'slow' && <small className="call-hint">Taking longer than usual — still trying.</small>}
          {failed && (
            <>
              <p className="call-fail-why">{a.failText ?? 'The call couldn’t connect.'}</p>
              <div className="call-end-acts">
                <button className="call-pill" onClick={() => callCenter.retry()}><Icon name="refresh" size={15} />Try again</button>
                {a.cam && <button className="call-pill ghost" onClick={() => callCenter.retry(true)}><Icon name="phone" size={15} />Audio only</button>}
              </div>
            </>
          )}
          {a.state === 'ended' && (
            <div className="call-end-acts">
              {a.outgoing && a.asked.length > 0 && a.ended?.why !== 'done' && (
                <button className="call-pill" onClick={() => void callCenter.call(a.nid, a.asked, a.video).then((e) => e && push(e, { icon: 'alert' }))}><Icon name="refresh" size={15} />Call again</button>
              )}
              <button className="call-pill ghost" onClick={() => callCenter.dismiss()}>Close</button>
            </div>
          )}
        </div>
      )}

      {a.state !== 'ended' && (a.cam ? (
        !waiting && (
          <div className={cx('call-self', `c-${corner}`)} onPointerDown={onSelfDown} onPointerUp={onSelfUp}>
            <StreamVideo stream={a.local} muted mirror={a.facing === 'user'} />
            {!a.mic && <span className="call-self-mute"><Icon name="micOff" size={12} /></span>}
          </div>
        )
      ) : (
        !waiting && <div className={cx('call-self', 'off', `c-${corner}`)}><Icon name="videoOff" size={18} /></div>
      ))}

      {a.state !== 'ended' && (
        <div className="call-ctl" role="toolbar" aria-label="Call controls">
          <CallButton icon={a.mic ? 'mic' : 'micOff'} label={a.mic ? 'Mute' : 'Unmute'} on={!a.mic} onClick={() => void micText()} />
          <CallButton icon={a.cam ? 'video' : 'videoOff'} label={a.cam ? 'Camera' : 'Camera off'} on={!a.cam} onClick={() => void camText()} />
          <CallButton icon="flip" label="Flip" onClick={() => void callCenter.flip()} disabled={!a.canFlip || !a.cam} />
          <CallButton icon="users" label="Add" onClick={() => setAdding(true)} disabled={!a.id || full} />
          <CallButton icon="phone" label="End" danger onClick={() => callCenter.hangup()} />
        </div>
      )}

      {adding && (
        <div className="call-add" role="dialog" aria-label="Add someone to the call">
          <div className="call-add-head">
            <b>Add to the call</b>
            <button className="call-icon-btn" onClick={() => setAdding(false)} aria-label="Close"><Icon name="x" size={18} /></button>
          </div>
          {!people ? (
            <p className="call-add-empty">Loading…</p>
          ) : addable.length === 0 ? (
            <p className="call-add-empty">Everyone in {a.nursery} is already here. Add people to the nursery to call them.</p>
          ) : (
            addable.map((p) => (
              <button
                key={p.user_id}
                className="call-add-row"
                onClick={() => {
                  callCenter.invite([p.user_id]);
                  setAdding(false);
                  push(`Ringing ${p.label || p.display_name}…`, { icon: 'phone' });
                }}
              >
                <Avatar name={p.display_name} size={36} />
                <span><b>{p.label || p.display_name}</b><small>{p.label ? p.display_name : ''}</small></span>
                <Icon name="phone" size={18} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
