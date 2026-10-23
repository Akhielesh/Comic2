// Mounted once in the app shell: keeps the family-call lines (and your own
// line, for direct calls) connected while you're signed in, rings for incoming
// calls (full-screen, with a ringtone), and shows the call screen on top of
// whatever you were doing. "Answer" on a call notification opens
// #/call/<nursery>/<call>?answer=<proof> (#/call/d/<call> for a direct call),
// which picks up as soon as the app is back in the room — one tap from the lock
// screen. The proof is a one-time token the service worker leaves only when
// "Answer" is really tapped (takeAnswerProof); any other address — a link
// someone sent you, a reload — just shows the call ringing, never answers it.
//
// A direct call from someone outside your family says so ("Stream Studio member
// · not in your family"), answers with your camera off unless you choose video,
// and offers Decline & block. Added to a call by someone else, it says who.
import React, { useEffect, useRef, useState } from 'react';
import { useAccount } from '../../account';
import { answerFromHash, callCenter, takeAnswerProof, useCalls, type Ringing } from '../../calls/callCenter';
import { chime, startRing, unlockCallAudio } from '../../calls/ringtone';
import { callReceiptText } from '../../costCopy';
import { dueRelayNotice, requestAccountUsage } from '../../usage/usageClient';
import { Icon } from '../../ui/icons';
import { Avatar, cx, gradFor, type PushToast } from '../../ui/primitives';
import { CallScreen } from './CallScreen';

/** Who's calling, as the ring screen says it (a family label first). */
export function ringWho(r: Pick<Ringing, 'call' | 'direct'>): string {
  return r.direct?.label || r.call.from.label || r.call.from.name;
}

/** A direct call from someone outside your family: answer with the camera off unless you pick video. */
export const audioFirst = (r: Pick<Ringing, 'direct'>): boolean => !!r.direct && !r.direct.family;

function IncomingCall({ r, busy, push }: { r: Ringing; busy: boolean; push: PushToast }) {
  const [answering, setAnswering] = useState(false);
  const who = ringWho(r);
  const others = r.call.parts.filter((p) => p.uid !== r.call.from.uid);
  const stranger = audioFirst(r);
  const what = `${r.call.video ? 'Video' : 'Audio'} call · ${r.nursery}`;
  const accept = async (video: boolean) => {
    unlockCallAudio();
    setAnswering(true);
    const err = await callCenter.accept(r.nid, r.call.id, video);
    setAnswering(false);
    if (err) push(err, { icon: 'alert', duration: 7000 });
  };
  const decline = (block = false) => {
    const done = callCenter.decline(r.nid, r.call.id, block);
    if (!done) return;
    const name = done.who.name;
    // Only say it's done once your line has it; otherwise say when it will be.
    if (done.now) push(`${name} is blocked — their calls won’t reach you. Unblock them in Calls.`, { icon: 'shield', duration: 7000 });
    else push(`${name} will be blocked as soon as you’re back online — until then their calls can still ring your other devices.`, { icon: 'alert', duration: 9000 });
  };
  const by = r.direct?.by ?? null;
  // Outside your family, Accept answers by voice; video is a deliberate second choice.
  const mainVideo = r.call.video && !stranger;
  if (busy) {
    return (
      <div className="call-wait" role="alertdialog" aria-label={`${who} is calling`}>
        <Avatar name={r.call.from.name} size={36} />
        <span><b>{who}</b><small>is calling · {r.nursery}</small></span>
        <button className="call-round sm danger" onClick={() => decline()} aria-label="Decline"><Icon name="phone" size={16} /></button>
        <button className="call-round sm ok" onClick={() => void accept(mainVideo)} aria-label="End this call and answer"><Icon name="phone" size={16} /></button>
      </div>
    );
  }
  return (
    <div className={cx('call-ring', stranger && 'stranger')} role="alertdialog" aria-label={`${who} is calling`} style={{ background: `radial-gradient(120% 90% at 50% 0%, rgba(0,0,0,.15), #0b0a09 70%), ${gradFor(r.call.from.name)}` }}>
      <div className="call-ring-who">
        <div className="call-ring-face"><Avatar name={r.call.from.name} size={112} /></div>
        <b>{who}</b>
        <span>{what}</span>
        {r.direct?.label && r.direct.label !== r.call.from.name && <small>{r.call.from.name}</small>}
        {by && <small>Added by {by.name}</small>}
        {others.length > 0 && <small>with {others.map((p) => p.label || p.name).join(', ')}</small>}
        {stranger && (
          <small className="call-ring-note">
            <Icon name="shield" size={13} />
            {by && !by.family ? `${by.name} isn’t in any of your nurseries.` : 'Not in any of your nurseries.'} Answering starts with your camera off.
          </small>
        )}
      </div>
      <div className="call-ring-acts">
        <div>
          <button className="call-round danger" onClick={() => decline()} aria-label="Decline" disabled={answering}><Icon name="phone" size={28} /></button>
          <small>Decline</small>
        </div>
        <div>
          <button className="call-round ok" onClick={() => void accept(mainVideo)} aria-label={stranger && r.call.video ? 'Accept with voice only' : 'Accept'} disabled={answering}><Icon name={mainVideo ? 'video' : 'phone'} size={28} /></button>
          <small>{answering ? 'Connecting…' : stranger && r.call.video ? 'Accept (voice)' : 'Accept'}</small>
        </div>
      </div>
      <div className="call-ring-more">
        {r.call.video && (
          <button className="call-ring-audio" onClick={() => void accept(!mainVideo)} disabled={answering}>
            <Icon name={mainVideo ? 'videoOff' : 'video'} size={15} />{mainVideo ? 'Answer without video' : 'Answer with video'}
          </button>
        )}
        {stranger && (
          <button className="call-ring-audio danger" onClick={() => decline(true)} disabled={answering}>
            <Icon name="shield" size={15} />Decline &amp; block
          </button>
        )}
      </div>
    </div>
  );
}

/** How long to wait for the call to show up after opening from the notification. */
const AUTO_ANSWER_MS = 20_000;

export function CallHost({ push, suspended }: { push: PushToast; suspended: boolean }) {
  const account = useAccount();
  const calls = useCalls();
  const member = account.status === 'member';

  // Answer from the notification: pick up as soon as the call rings here — but
  // only with the service worker's one-time proof that "Answer" was tapped.
  const [autoAnswer, setAutoAnswer] = useState<{ nid: string; id: string; until: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const on = () => {
      const x = answerFromHash(location.hash);
      if (!x) return;
      // The proof is used up either way; a reload of this address mustn't try again.
      try {
        history.replaceState(history.state, '', `${location.pathname}${location.search}${location.hash.slice(0, location.hash.indexOf('?'))}`);
      } catch { /* sandboxed */ }
      void takeAnswerProof(x).then((ok) => {
        if (ok && alive) setAutoAnswer({ nid: x.nid, id: x.id, until: Date.now() + AUTO_ANSWER_MS });
      });
    };
    on();
    window.addEventListener('hashchange', on);
    return () => {
      alive = false;
      window.removeEventListener('hashchange', on);
    };
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
      // (Someone outside your family: answered by voice, as on the ring screen.)
      void callCenter.accept(r.nid, r.call.id, r.call.video && !audioFirst(r)).then((err) => err && push(err, { icon: 'alert', duration: 7000 }));
      return;
    }
    const t = window.setTimeout(() => {
      setAutoAnswer(null);
      if (callCenter.snapshot().active?.id !== autoAnswer.id) push('That call has ended.', { icon: 'phone', duration: 5000 });
    }, Math.max(0, autoAnswer.until - Date.now()));
    return () => window.clearTimeout(t);
  }, [autoAnswer, calls.ringing, push]);

  useEffect(() => {
    if (member) callCenter.start(account.userId);
    else callCenter.stop();
  }, [member, account.userId]);

  // Things the call store wants said (e.g. someone you added can't be reached).
  const noticeAt = calls.notice?.at;
  useEffect(() => {
    const n = callCenter.snapshot().notice;
    if (noticeAt && n) push(n.text, { icon: 'alert', duration: 7000 });
  }, [noticeAt, push]);
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

  // The receipt when a call that connected ends: "12 min · direct · free" (ADR 0007 D4).
  // After a relayed call you placed, one look at your month says if relay data is at 80% / 100%.
  const receipt = a?.state === 'ended' ? a.receipt : null;
  const uid = account.userId;
  const saidRef = useRef<unknown>(null);
  useEffect(() => {
    // Once per call (push isn't a stable function, so it can't be what re-runs this).
    if (!receipt || saidRef.current === receipt) return;
    saidRef.current = receipt;
    push(callReceiptText(receipt), { icon: receipt.path === 'turn' ? 'globe' : 'check', duration: 5000 });
    if (receipt.path !== 'turn' || !receipt.outgoing || !uid) return;
    void requestAccountUsage().then((u) => {
      const n = u && dueRelayNotice('account', uid, u.usage, u.allowances.relayDataGb);
      if (n) push(n.text, { icon: 'alert', duration: 9000 });
    });
  }, [receipt, uid, push]);

  // The tab title flashes while ringing in the background.
  useEffect(() => {
    if (!ringing || !ring) return;
    const base = document.title;
    let on = false;
    const t = window.setInterval(() => {
      on = !on;
      document.title = on ? `📹 ${ringWho(ring)} is calling` : base;
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
