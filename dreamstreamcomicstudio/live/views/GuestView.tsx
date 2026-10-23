// On-air guest seat — the page behind a guest invite link (?e=ID#/guest?g=KEY).
// Setup: name + camera check. Joined: live two-way link to the host — what comes back
// is the program picture plus everyone else's voices (mix-minus), so in a meeting the
// guests see and hear each other too — with mic / cam / screen-share / leave controls
// and the room chat. A link carrying `m=1` (or a room whose kind is "meeting") speaks
// "meeting": private until the host goes live, and the guest is told when that happens.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, openRoomSocket, type GoneReason, type RoomSocket, type SocketStatus } from '../api';
import { loadViewerName, saveViewerName } from '../events';
import { cameraErrorMessage } from '../media';
import type { Nav } from '../nav';
import { isMeetingGuestLink } from '../nav';
import { MAX_GUESTS, type ChatMsg, type EventMeta, type StreamStatus } from '../protocol';
import { GuestPeer, sanitizeIceServers } from '../studio/rtc';
import { PATH_PILL, PATH_TIP } from '../costCopy';
import { streamPathOf } from '../usage/sessionMeter';
import { IceClock } from '../rtcIce';
import { ChatRail } from '../components/rails';
import { Icon } from '../ui/icons';
import { StreamStudioLogo } from '../ui/logo';
import { Btn, Pill, cx, useMediaQuery, type PushToast } from '../ui/primitives';

/** How long a link may sit unconnected before we say what's going on. */
const SLOW_LINK_MS = 15_000;
/** Wait this long for the room's ICE list (TURN) before linking with STUN only. */
const ICE_WAIT_MS = 1500;

function Sink({ stream, mirror, muted, className }: { stream: MediaStream | null; mirror?: boolean; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      if (stream) v.play().catch(() => undefined);
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}

type Phase = 'setup' | 'joined' | 'left';

export function GuestView({ eventId, guestKey, nav, push }: { eventId: string; guestKey: string; nav: Nav; push: PushToast }) {
  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [name, setName] = useState(loadViewerName);
  const [cam, setCam] = useState<MediaStream | null>(null);
  const [hostStream, setHostStream] = useState<MediaStream | null>(null);
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState>('new');
  /** How our link to the host travels (Home Wi-Fi · Direct · our relay), once known. */
  const [linkPath, setLinkPath] = useState<'lan' | 'internet' | 'relay' | null>(null);
  const [linkEpoch, setLinkEpoch] = useState(0);
  const [slow, setSlow] = useState(false);
  const [sockStatus, setSockStatus] = useState<SocketStatus>('connected');
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [gone, setGone] = useState<GoneReason | 'kicked-live' | null>(null);

  const sockRef = useRef<RoomSocket | null>(null);
  const peerRef = useRef<GuestPeer | null>(null);
  const camRef = useRef<MediaStream | null>(null);
  const iceRef = useRef<RTCIceServer[] | null>(null);
  const iceWaitRef = useRef<number | null>(null);
  // Relay credentials last a couple of hours: ask the room for fresh ones when it says (`iceMs`).
  const iceClockRef = useRef(new IceClock(() => sockRef.current?.send({ t: 'ice' })));
  /** Bumps on every hello — a late ICE reply or timer from an older socket is ignored. */
  const helloSeqRef = useRef(0);
  const statusRef = useRef<StreamStatus>('idle');
  const aliveRef = useRef(true);
  const isPhone = useMediaQuery('(max-width: 700px)');

  // The link says "meeting" from the first paint; the room's own kind wins once known.
  const meetingLink = useMemo(() => isMeetingGuestLink(location.hash), []);
  const meeting = meta?.kind ? meta.kind === 'meeting' : meetingLink;
  // The socket handler outlives renders — give it the current meeting/host facts.
  const meetingRef = useRef(meeting);
  meetingRef.current = meeting;
  const hostNameRef = useRef('The host');
  hostNameRef.current = meta?.host || 'The host';

  const openCam = () => {
    setCamErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamErr('This page can’t use the camera here — open the invite link in Safari, Chrome or Edge.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
      .then((s) => {
        if (!aliveRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        camRef.current?.getTracks().forEach((t) => t.stop());
        camRef.current = s;
        setCam(s);
      })
      .catch((e) => aliveRef.current && setCamErr(cameraErrorMessage(e)));
  };

  // Camera check runs from the moment the page opens (setup preview).
  useEffect(() => {
    aliveRef.current = true;
    getEvent(eventId)
      .then((m) => aliveRef.current && setMeta(m))
      .catch(() => aliveRef.current && setErr('This event link is not reachable.'));
    openCam();
    return () => {
      aliveRef.current = false;
      if (iceWaitRef.current != null) window.clearTimeout(iceWaitRef.current);
      iceClockRef.current.stop();
      peerRef.current?.close();
      sockRef.current?.close();
      camRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Say plainly when a link is slow to come up (strict networks without a relay).
  useEffect(() => {
    setSlow(false);
    if (phase !== 'joined' || rtcState === 'connected') return;
    const t = window.setTimeout(() => setSlow(true), SLOW_LINK_MS);
    return () => window.clearTimeout(t);
  }, [phase, rtcState, linkEpoch]);

  /** (Re)build the link to the host and tell it we're ready. */
  const buildPeer = (seq: number) => {
    if (seq !== helloSeqRef.current || !camRef.current) return;
    if (iceWaitRef.current != null) window.clearTimeout(iceWaitRef.current);
    iceWaitRef.current = null;
    peerRef.current?.close();
    const peer = new GuestPeer((d) => sockRef.current?.send({ t: 'rtc', d }), camRef.current, iceRef.current);
    peer.onHostStream = setHostStream;
    peer.onState = setRtcState;
    peer.onPath = setLinkPath;
    peerRef.current = peer;
    setHostStream(null);
    setRtcState('new');
    setLinkPath(null);
    setSharing(false);
    setLinkEpoch((n) => n + 1);
    sockRef.current?.send({ t: 'rtc', d: { ready: true } });
  };

  const join = () => {
    const clean = name.trim().slice(0, 24);
    if (!clean || !camRef.current) return;
    saveViewerName(clean);
    setPhase('joined');

    sockRef.current = openRoomSocket(
      eventId,
      { name: clean, g: guestKey },
      (msg) => {
        switch (msg.t) {
          case 'hello': {
            if (msg.you.role !== 'guest') {
              setErr('This guest link is no longer valid — ask the host for a fresh one.');
              sockRef.current?.close();
              return;
            }
            setChat(msg.chat);
            setMeta(msg.meta);
            statusRef.current = msg.meta.status;
            setStatus(msg.meta.status);
            // Fresh socket = fresh seat: drop the old link, fetch ICE (TURN when the
            // owner set it up), then link — or link with STUN if the room doesn't answer.
            helloSeqRef.current += 1;
            const seq = helloSeqRef.current;
            peerRef.current?.close();
            peerRef.current = null;
            setHostStream(null);
            setSharing(false);
            sockRef.current?.send({ t: 'ice' });
            if (iceWaitRef.current != null) window.clearTimeout(iceWaitRef.current);
            iceWaitRef.current = window.setTimeout(() => buildPeer(seq), ICE_WAIT_MS);
            break;
          }
          case 'ice': {
            const list = sanitizeIceServers(msg.servers);
            if (list) iceRef.current = list;
            iceClockRef.current.arm(msg.iceMs);
            if (!peerRef.current) buildPeer(helloSeqRef.current);
            else if (list) peerRef.current.setIceServers(list);
            break;
          }
          case 'rtc':
            // The host asking us to (re)connect: its studio reloaded or its camera came up
            // after we joined. Rebuild and answer. (Before our first link, ours is coming.)
            if (msg.d.ready) {
              if (peerRef.current) buildPeer(helloSeqRef.current);
            } else {
              void peerRef.current?.handle(msg.d);
            }
            break;
          case 'state':
            if (meetingRef.current && msg.status === 'live' && statusRef.current === 'idle') {
              push(`${hostNameRef.current} started broadcasting this meeting — you’re on the stream now`, { icon: 'broadcast', duration: 5000 });
            }
            statusRef.current = msg.status;
            setStatus(msg.status);
            break;
          case 'chat':
            setChat((c) => [...c.slice(-199), msg.m]);
            break;
          case 'delete':
            setChat((c) => c.filter((x) => x.id !== msg.id));
            break;
          case 'kicked':
            setGone('kicked');
            break;
          case 'full':
            setGone('full');
            break;
          case 'notice':
            push(msg.text, { icon: 'info' });
            break;
        }
      },
      (reason) => setGone(reason),
      setSockStatus,
    );
  };

  const leave = () => {
    sockRef.current?.send({ t: 'rtc', d: { bye: true } });
    if (iceWaitRef.current != null) window.clearTimeout(iceWaitRef.current);
    iceClockRef.current.stop();
    peerRef.current?.close();
    peerRef.current = null;
    sockRef.current?.close();
    sockRef.current = null;
    setHostStream(null);
    setPhase('left');
  };

  const toggleMic = () => {
    const next = !micOn;
    camRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
  };

  const toggleCam = () => {
    const next = !camOn;
    camRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setCamOn(next);
  };

  const flip = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: next }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch {
        fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: next, width: { ideal: 1280 }, height: { ideal: 720 } } });
      }
      const newTrack = fresh.getVideoTracks()[0];
      const old = camRef.current;
      if (!newTrack || !old) return;
      const oldTrack = old.getVideoTracks()[0];
      old.removeTrack(oldTrack);
      old.addTrack(newTrack);
      oldTrack?.stop();
      newTrack.enabled = camOn;
      await peerRef.current?.replaceCamVideoTrack(newTrack);
      setFacing(next);
      setCam(null); // retrigger the sink with the same stream object
      setCam(old);
    } catch {
      push('No camera facing the other way', { icon: 'alert' });
    }
  };

  const toggleShare = async () => {
    const peer = peerRef.current;
    if (!peer) return;
    if (sharing) {
      peer.setScreen(null);
      setSharing(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        peer.setScreen(null);
        setSharing(false);
      });
      peer.setScreen(stream);
      setSharing(true);
      push(meeting ? 'You are sharing your screen with the meeting' : 'You are sharing your screen with the program', { icon: 'screen' });
    } catch {
      /* picker dismissed */
    }
  };

  /* --------------------------------------------------------------- render */

  if (err) {
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card">
            <StreamStudioLogo size={22} />
            <div className="banner err" style={{ marginTop: 14 }}><Icon name="alert" size={15} />{err}</div>
          </div>
        </div>
      </div>
    );
  }

  if (gone) {
    const text =
      gone === 'kicked' ? (meeting ? 'The host removed you from the meeting.' : 'The host removed you from the on-air guests.')
      : gone === 'full' ? (meeting ? `This meeting is full — all ${MAX_GUESTS} seats are taken.` : 'All guest seats are taken for this event.')
      : gone === 'denied' ? 'The host declined this join.'
      : 'Lost the connection to the event room.';
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card">
            <StreamStudioLogo size={22} />
            <p className="muted" style={{ margin: '14px 0 16px' }}>{text}</p>
            <div className="row" style={{ gap: 8 }}>
              {gone === 'failed' && <Btn variant="solid" onClick={() => location.reload()}>Try again</Btn>}
              <Btn variant={gone === 'failed' ? 'subtle' : 'solid'} onClick={() => nav.viewer(eventId)}>{meeting ? 'Watch instead' : 'Watch the stream'}</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'left') {
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card">
            <StreamStudioLogo size={22} />
            <p className="muted" style={{ margin: '14px 0 16px' }}>
              {meeting ? 'You left the meeting.' : 'You left the guest seat. The stream carries on without you.'}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="solid" onClick={() => location.reload()}>{meeting ? 'Rejoin the meeting' : 'Rejoin as guest'}</Btn>
              {(!meeting || status === 'live') && <Btn variant="subtle" onClick={() => nav.viewer(eventId)}>Watch instead</Btn>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'setup') {
    const title = meta?.title ?? (meeting ? 'this meeting' : 'this stream');
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card gv-setup">
            <StreamStudioLogo size={22} />
            <h2 className="serif" style={{ margin: '12px 0 2px' }}>
              {meeting ? `Join “${title}”` : `Join “${title}” as a guest`}
            </h2>
            <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5 }}>
              {meeting
                ? `You’ll join on camera with ${meta?.host || 'the host'}. No account needed.`
                : 'You’ll appear on the program with your camera and mic. The host hears and mixes you live.'}
            </p>
            <div className="gv-preview">
              <Sink stream={cam} mirror muted className="program-video" />
              {!cam && !camErr && <div className="gv-preview-empty">Waiting for camera…</div>}
              {camErr && (
                <div className="gv-preview-empty gv-cam-err" role="alert">
                  <Icon name="videoOff" size={20} />
                  <span>{camErr}</span>
                  <Btn variant="solid" size="sm" icon="refresh" onClick={openCam}>Try again</Btn>
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={name}
                maxLength={24}
                placeholder={meeting ? 'Your name' : 'Your name (shown on the program)'}
                aria-label={meeting ? 'Your name' : 'Guest name'}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
              />
              <Btn variant="solid" icon={meeting ? 'users' : 'broadcast'} disabled={!name.trim() || !cam} onClick={join}>{meeting ? 'Join meeting' : 'Join'}</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const connected = rtcState === 'connected';
  // In a meeting the return feed IS the meeting grid (you included) — no extra self tile.
  const showSelf = !(meeting && hostStream && connected);
  const waitingText =
    status === 'ended'
      ? meeting ? 'The meeting has ended — thanks for joining!' : 'The stream has ended — thanks for being on it!'
      : rtcState === 'failed'
        ? 'Could not reach the host directly (restrictive network). Try another network or watch the stream instead.'
        : rtcState === 'disconnected' || rtcState === 'closed'
          ? 'The connection dropped — reconnecting by itself…'
          : `Waiting for ${meta?.host || 'the host'}…`;
  return (
    <div className="gv-stage">
      <div className="gv-top">
        <StreamStudioLogo size={20} wordmark={!isPhone} />
        <span className="gv-title">{meta?.title ?? ''}</span>
        <span className="spacer" />
        {status === 'live' && <Pill tone="live" dot pulse>{meeting ? 'Live — you’re being broadcast' : 'LIVE'}</Pill>}
        {status === 'paused' && <Pill tone="warn" icon="pause">Paused</Pill>}
        {!meeting && (status === 'idle' || status === 'ended') && <Pill tone="neutral">Off air</Pill>}
        {sockStatus === 'reconnecting' && <Pill tone="warn" icon="refresh">Reconnecting…</Pill>}
        <Pill tone={connected ? 'ok' : 'warn'} icon={meeting && connected ? 'users' : 'signal'}>
          {connected ? (meeting ? 'In the meeting' : 'On air with the host') : rtcState === 'failed' ? 'Link failed' : 'Connecting…'}
        </Pill>
        {connected && linkPath && (
          <span className="gv-path" title={PATH_TIP[streamPathOf(linkPath) ?? 'direct']}>
            <Pill tone="neutral" icon={linkPath === 'lan' ? 'wifi' : 'lock'}>{PATH_PILL[streamPathOf(linkPath) ?? 'direct']}</Pill>
          </span>
        )}
      </div>

      <div className="gv-main">
        <div className="gv-video-wrap">
          <Sink stream={hostStream} className="program-video" />
          {(!hostStream || status === 'ended') && (
            <div className="gv-waiting">
              <div className="brb-orb"><span /></div>
              <div className="serif" style={{ fontSize: 18, marginTop: 10 }}>{waitingText}</div>
              {slow && status !== 'ended' && rtcState !== 'failed' && (
                <p className="gv-slow" role="status">
                  Still connecting… Some networks (mobile data, office Wi-Fi) block direct video. It keeps retrying — switching to Wi-Fi usually fixes it.
                </p>
              )}
              {status === 'ended' && (
                <div style={{ marginTop: 14 }}>
                  <Btn variant="solid" onClick={leave}>{meeting ? 'Leave' : 'Leave the seat'}</Btn>
                </div>
              )}
            </div>
          )}
          {showSelf && (
            <div className="gv-self">
              <Sink stream={cam} mirror={facing === 'user'} muted className="program-video" />
              {sharing && <span className="gv-sharing"><Icon name="screen" size={12} /> sharing</span>}
            </div>
          )}
          {!showSelf && sharing && <span className="gv-sharing gv-sharing-solo"><Icon name="screen" size={12} /> sharing</span>}
        </div>
        {chatOpen && (
          <aside className="gv-chat">
            <ChatRail
              chat={chat}
              pinned={null}
              onSend={(text) => sockRef.current?.send({ t: 'chat', text })}
              onReact={(e) => sockRef.current?.send({ t: 'emoji', e })}
            />
          </aside>
        )}
      </div>

      <div className="gv-bar">
        <button className={cx('pv-ctl', !micOn && 'off')} onClick={toggleMic} aria-label="Microphone"><Icon name={micOn ? 'mic' : 'micOff'} size={18} /></button>
        <button className={cx('pv-ctl', !camOn && 'off')} onClick={toggleCam} aria-label="Camera"><Icon name={camOn ? 'video' : 'videoOff'} size={18} /></button>
        <button className="pv-ctl" onClick={() => void flip()} aria-label="Flip camera"><Icon name="flip" size={18} /></button>
        {!isPhone && (
          <button className="pv-ctl" style={sharing ? { background: 'var(--accent)' } : undefined} onClick={() => void toggleShare()} aria-label="Share screen">
            <Icon name="screen" size={18} />
          </button>
        )}
        <button className={cx('pv-ctl', chatOpen && 'off')} onClick={() => setChatOpen((o) => !o)} aria-label="Chat"><Icon name="chat" size={18} /></button>
        <button className="pv-ctl gv-leave" onClick={leave} aria-label="Leave"><Icon name="x" size={18} /></button>
      </div>
    </div>
  );
}
