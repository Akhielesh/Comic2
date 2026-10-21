// Mounted once in the app shell: keeps the family-call lines connected while
// you're signed in, rings for incoming calls (full-screen, with a ringtone),
// and shows the call screen on top of whatever you were doing.
import React, { useEffect, useRef, useState } from 'react';
import { useAccount } from '../../account';
import { callCenter, useCalls, type Ringing } from '../../calls/callCenter';
import { chime, startRing, unlockCallAudio } from '../../calls/ringtone';
import { Icon } from '../../ui/icons';
import { Avatar, cx, gradFor, type PushToast } from '../../ui/primitives';
import { CallScreen } from './CallScreen';

function IncomingCall({ r, busy, push }: { r: Ringing; busy: boolean; push: PushToast }) {
  const [answering, setAnswering] = useState(false);
  const who = r.call.from.label || r.call.from.name;
  const others = r.call.parts.filter((p) => p.uid !== r.call.from.uid);
  const what = `${r.call.video ? 'Video' : 'Audio'} call · ${r.nursery}`;
  const accept = async (video: boolean) => {
    unlockCallAudio();
    setAnswering(true);
    const err = await callCenter.accept(r.nid, r.call.id, video);
    setAnswering(false);
    if (err) push(err, { icon: 'alert', duration: 7000 });
  };
  if (busy) {
    return (
      <div className="call-wait" role="alertdialog" aria-label={`${who} is calling`}>
        <Avatar name={r.call.from.name} size={36} />
        <span><b>{who}</b><small>is calling · {r.nursery}</small></span>
        <button className="call-round sm danger" onClick={() => callCenter.decline(r.nid, r.call.id)} aria-label="Decline"><Icon name="phone" size={16} /></button>
        <button className="call-round sm ok" onClick={() => void accept(r.call.video)} aria-label="End this call and answer"><Icon name="phone" size={16} /></button>
      </div>
    );
  }
  return (
    <div className="call-ring" role="alertdialog" aria-label={`${who} is calling`} style={{ background: `radial-gradient(120% 90% at 50% 0%, rgba(0,0,0,.15), #0b0a09 70%), ${gradFor(r.call.from.name)}` }}>
      <div className="call-ring-who">
        <div className="call-ring-face"><Avatar name={r.call.from.name} size={112} /></div>
        <b>{who}</b>
        <span>{what}</span>
        {others.length > 0 && <small>with {others.map((p) => p.label || p.name).join(', ')}</small>}
      </div>
      <div className="call-ring-acts">
        <div>
          <button className="call-round danger" onClick={() => callCenter.decline(r.nid, r.call.id)} aria-label="Decline" disabled={answering}><Icon name="phone" size={28} /></button>
          <small>Decline</small>
        </div>
        <div>
          <button className="call-round ok" onClick={() => void accept(r.call.video)} aria-label="Accept" disabled={answering}><Icon name={r.call.video ? 'video' : 'phone'} size={28} /></button>
          <small>{answering ? 'Connecting…' : 'Accept'}</small>
        </div>
      </div>
      {r.call.video && (
        <button className="call-ring-audio" onClick={() => void accept(false)} disabled={answering}>
          <Icon name="videoOff" size={15} />Answer without video
        </button>
      )}
    </div>
  );
}

export function CallHost({ push, suspended }: { push: PushToast; suspended: boolean }) {
  const account = useAccount();
  const calls = useCalls();
  const member = account.status === 'member';

  useEffect(() => {
    if (member) callCenter.start();
    else callCenter.stop();
  }, [member]);
  useEffect(() => callCenter.setSuspended(suspended), [suspended]);

  const a = calls.active;
  const inCall = !!a && a.state !== 'ended';
  const ring = calls.ringing[0] ?? null;

  // Sounds: ring for an incoming call, ringback while yours rings, a chime on connect / end.
  const ringing = !!ring && !inCall;
  const ringingBack = a?.state === 'calling';
  useEffect(() => (ringing ? startRing('incoming') : undefined), [ringing]);
  useEffect(() => (ringingBack ? startRing('ringback') : undefined), [ringingBack]);
  const lastState = useRef(a?.state);
  useEffect(() => {
    const prev = lastState.current;
    lastState.current = a?.state;
    if (a?.state === 'connected' && prev !== 'connected') chime('connected');
    if (a?.state === 'ended' && prev && prev !== 'ended') chime('ended');
  }, [a?.state]);

  // The tab title flashes while ringing in the background.
  useEffect(() => {
    if (!ringing || !ring) return;
    const base = document.title;
    let on = false;
    const t = window.setInterval(() => {
      on = !on;
      document.title = on ? `📹 ${ring.call.from.label || ring.call.from.name} is calling` : base;
    }, 1000);
    return () => {
      window.clearInterval(t);
      document.title = base;
    };
  }, [ringing, ring]);

  return (
    <>
      {a && <CallScreen a={a} push={push} />}
      {ring && <div className={cx(inCall && 'call-wait-wrap')}><IncomingCall r={ring} busy={inCall} push={push} /></div>}
    </>
  );
}
