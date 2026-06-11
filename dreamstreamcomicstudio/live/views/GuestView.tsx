// On-air guest seat — the page behind a guest invite link (?e=ID&g=KEY).
// Setup: name + camera check. Joined: live two-way link to the host (their
// cam+mic comes back over the same peer connection, sub-second), with mic /
// cam / screen-share / leave controls and the room chat. The PROGRAM viewers
// watch is the host's composite — guests are sources, not viewers.
import React, { useEffect, useRef, useState } from 'react';
import { getEvent, openRoomSocket, type GoneReason, type RoomSocket, type SocketStatus } from '../api';
import { loadViewerName, saveViewerName } from '../events';
import type { Nav } from '../nav';
import type { ChatMsg, EventMeta, StreamStatus } from '../protocol';
import { GuestPeer } from '../studio/rtc';
import { ChatRail } from '../components/rails';
import { Icon } from '../ui/icons';
import { StreamStudioLogo } from '../ui/logo';
import { Btn, Pill, cx, useMediaQuery, type PushToast } from '../ui/primitives';

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
  const [phase, setPhase] = useState<Phase>('setup');
  const [name, setName] = useState(loadViewerName);
  const [cam, setCam] = useState<MediaStream | null>(null);
  const [hostStream, setHostStream] = useState<MediaStream | null>(null);
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState>('new');
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
  const isPhone = useMediaQuery('(max-width: 700px)');

  // Camera check runs from the moment the page opens (setup preview).
  useEffect(() => {
    let cancelled = false;
    getEvent(eventId).then((m) => !cancelled && setMeta(m)).catch(() => !cancelled && setErr('This event link is not reachable.'));
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        camRef.current = s;
        setCam(s);
      })
      .catch(() => !cancelled && setErr('Camera/mic unavailable — allow access to join as a guest.'));
    return () => {
      cancelled = true;
      peerRef.current?.close();
      sockRef.current?.close();
      camRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

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
            setStatus(msg.meta.status);
            // Fresh socket = fresh seat: rebuild the peer and tell the host.
            peerRef.current?.close();
            const peer = new GuestPeer((d) => sockRef.current?.send({ t: 'rtc', d }), camRef.current!);
            peer.onHostStream = setHostStream;
            peer.onState = setRtcState;
            peerRef.current = peer;
            setSharing(false);
            sockRef.current?.send({ t: 'rtc', d: { ready: true } });
            break;
          }
          case 'rtc':
            void peerRef.current?.handle(msg.d);
            break;
          case 'state':
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
      push('You are sharing your screen with the program', { icon: 'screen' });
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
      gone === 'kicked' ? 'The host removed you from the on-air guests.'
      : gone === 'full' ? 'All guest seats are taken for this event.'
      : gone === 'denied' ? 'The host declined this join.'
      : 'Lost the connection to the event room.';
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card">
            <StreamStudioLogo size={22} />
            <p className="muted" style={{ margin: '14px 0 16px' }}>{text}</p>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="solid" onClick={() => nav.viewer(eventId)}>Watch the stream</Btn>
              {gone === 'failed' && <Btn variant="subtle" onClick={() => location.reload()}>Try again</Btn>}
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
            <p className="muted" style={{ margin: '14px 0 16px' }}>You left the guest seat. The stream carries on without you.</p>
            <div className="row" style={{ gap: 8 }}>
              <Btn variant="solid" onClick={() => location.reload()}>Rejoin as guest</Btn>
              <Btn variant="subtle" onClick={() => nav.viewer(eventId)}>Watch instead</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="gv-card gv-setup">
            <StreamStudioLogo size={22} />
            <h2 className="serif" style={{ margin: '12px 0 2px' }}>Join “{meta?.title ?? 'this stream'}” as a guest</h2>
            <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5 }}>
              You'll appear on the program with your camera and mic. The host hears and mixes you live.
            </p>
            <div className="gv-preview">
              <Sink stream={cam} mirror muted className="program-video" />
              {!cam && <div className="gv-preview-empty">Waiting for camera…</div>}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 14 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={name}
                maxLength={24}
                placeholder="Your name (shown on the program)"
                aria-label="Guest name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
              />
              <Btn variant="solid" icon="broadcast" disabled={!name.trim() || !cam} onClick={join}>Join</Btn>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const connected = rtcState === 'connected';
  return (
    <div className="gv-stage">
      <div className="gv-top">
        <StreamStudioLogo size={20} wordmark={!isPhone} />
        <span className="gv-title">{meta?.title ?? ''}</span>
        <span className="spacer" />
        {status === 'live' && <Pill tone="live" dot pulse>LIVE</Pill>}
        {status === 'paused' && <Pill tone="warn" icon="pause">Paused</Pill>}
        {(status === 'idle' || status === 'ended') && <Pill tone="neutral">Off air</Pill>}
        {sockStatus === 'reconnecting' && <Pill tone="warn" icon="refresh">Reconnecting…</Pill>}
        <Pill tone={connected ? 'ok' : 'warn'} icon="signal">
          {connected ? 'On air with the host' : rtcState === 'failed' ? 'Link failed' : 'Linking…'}
        </Pill>
      </div>

      <div className="gv-main">
        <div className="gv-video-wrap">
          <Sink stream={hostStream} className="program-video" />
          {(!hostStream || status === 'ended') && (
            <div className="gv-waiting">
              <div className="brb-orb"><span /></div>
              <div className="serif" style={{ fontSize: 18, marginTop: 10 }}>
                {status === 'ended'
                  ? 'The stream has ended — thanks for being on it!'
                  : rtcState === 'failed'
                    ? 'Could not reach the host directly (restrictive network). Try another network or watch the stream instead.'
                    : rtcState === 'disconnected' || rtcState === 'closed'
                      ? 'The host stepped away — hang tight, you reconnect automatically.'
                      : 'Waiting for the host…'}
              </div>
              {status === 'ended' && (
                <div style={{ marginTop: 14 }}>
                  <Btn variant="solid" onClick={leave}>Leave the seat</Btn>
                </div>
              )}
            </div>
          )}
          <div className="gv-self">
            <Sink stream={cam} mirror={facing === 'user'} muted className="program-video" />
            {sharing && <span className="gv-sharing"><Icon name="screen" size={12} /> sharing</span>}
          </div>
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
