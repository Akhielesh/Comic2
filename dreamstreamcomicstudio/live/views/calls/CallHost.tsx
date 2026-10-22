// Mounted once in the app shell: keeps the family-call lines connected while
// you're signed in, rings for incoming calls (full-screen, with a ringtone),
// and shows the call screen on top of whatever you were doing. "Answer" on a
// call notification opens #/call/<nursery>/<call>?answer=1, which picks up as
// soon as the app is back in the room — one tap from the lock screen.
import React, { useEffect, useRef, useState } from 'react';
import { useAccount } from '../../account';
import { answerFromHash, callCenter, useCalls, type Ringing } from '../../calls/callCenter';
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

/** How long to wait for the call to show up after opening from the notification. */
const AUTO_ANSWER_MS = 20_000;

export function CallHost({ push, suspended }: { push: PushToast; suspended: boolean }) {
  const account = useAccount();
  const calls = useCalls();
  const member = account.status === 'member';

  // Answer from the notification: pick up as soon as the call rings here.
  const [autoAnswer, setAutoAnswer] = useState<{ nid: string; id: string; until: number } | null>(() => {
    const x = typeof location !== 'undefined' ? answerFromHash(location.hash) : null;
    return x ? { ...x, until: Date.now() + AUTO_ANSWER_MS } : null;
  });
  useEffect(() => {
    const on = () => {
      const x = answerFromHash(location.hash);
      if (x) setAutoAnswer({ ...x, until: Date.now() + AUTO_ANSWER_MS });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!autoAnswer) return;
    const r = calls.ringing.find((x) => x.nid === autoAnswer.nid && x.call.id === autoAnswer.id);
    if (r) {
      setAutoAnswer(null);
      // Answered once: a reload of this address mustn't answer again.
      try {
        history.replaceState(history.state, '', `${location.pathname}${location.search}#/calls`);
      } catch { /* sandboxed */ }
      void callCenter.accept(r.nid, r.call.id, r.call.video).then((err) => err && push(err, { icon: 'alert', duration: 7000 }));
      return;
    }
    const t = window.setTimeout(() => {
      setAutoAnswer(null);
      if (callCenter.snapshot().active?.id !== autoAnswer.id) push('That call has ended.', { icon: 'phone', duration: 5000 });
    }, Math.max(0, autoAnswer.until - Date.now()));
    return () => window.clearTimeout(t);
  }, [autoAnswer, calls.ringing, push]);

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
