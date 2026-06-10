import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSegment, getEvent, openRoomSocket, type RoomSocket } from './api';
import { ChatPanel } from './ChatPanel';
import { Ema, fmtBps, fmtDuration } from './metrics';
import { MetricsOverlay } from './MetricsOverlay';
import { SegmentPlayer } from './player';
import type { ChatMsg, EventMeta, StreamStatus } from './protocol';
import { formatCountdown } from './schedule';

type Phase = 'join' | 'waiting' | 'watching' | 'denied' | 'kicked' | 'error';

interface FloatingEmoji {
  key: number;
  e: string;
  right: number;
}

export function ViewerView({ eventId }: { eventId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<RoomSocket | null>(null);
  const playerRef = useRef<SegmentPlayer | null>(null);
  const fetchCursorRef = useRef(1);
  const latestKnownRef = useRef(0);
  const inflightRef = useRef(0);
  const downEma = useRef(new Ema());
  const behindEma = useRef(new Ema());
  const floatKey = useRef(0);

  const [phase, setPhase] = useState<Phase>('join');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [floats, setFloats] = useState<FloatingEmoji[]>([]);
  const [muted, setMuted] = useState(true);
  const [metricsOn, setMetricsOn] = useState(false);
  const [downBps, setDownBps] = useState<number | null>(null);
  const [replayOffered, setReplayOffered] = useState(false);
  const [, setClock] = useState(0);

  // ---------------------------------------------------------------- player
  const startPlayer = (m: EventMeta, fromStart: boolean) => {
    const mime = m.mime || 'video/webm';
    if (!SegmentPlayer.canPlay(mime)) {
      setErr(`This browser can't play the stream's codec (${mime}). Try Chrome, Edge or Firefox.`);
      setPhase('error');
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    playerRef.current?.destroy();
    const startSeq = fromStart ? Math.max(1, m.firstSeq || 1) : Math.max(m.firstSeq || 1, m.latestSeq - 1, 1);
    const player = new SegmentPlayer(video, mime, m.segMs);
    player.start(startSeq);
    playerRef.current = player;
    fetchCursorRef.current = startSeq;
    latestKnownRef.current = Math.max(latestKnownRef.current, m.latestSeq);
    video.play().catch(() => {
      /* will start on user gesture */
    });
  };

  // ----------------------------------------------------------------- join
  const join = () => {
    const displayName = name.trim() || `guest-${Math.random().toString(36).slice(2, 6)}`;
    const tokenKey = `lv-token-${eventId}`;
    socketRef.current = openRoomSocket(
      eventId,
      { name: displayName, token: sessionStorage.getItem(tokenKey) || undefined },
      (msg) => {
        switch (msg.t) {
          case 'pending':
            setPhase('waiting');
            break;
          case 'admitted':
            sessionStorage.setItem(tokenKey, msg.token);
            break;
          case 'denied':
            setPhase('denied');
            break;
          case 'kicked':
            setPhase('kicked');
            playerRef.current?.destroy();
            break;
          case 'hello':
            setMeta(msg.meta);
            setStatus(msg.meta.status);
            setStartedAt(msg.meta.startedAt);
            setViewers(msg.meta.viewers);
            setPinned(msg.meta.pinned);
            setChat(msg.chat);
            setPhase('watching');
            if (msg.meta.status === 'ended') setReplayOffered(true);
            else startPlayer(msg.meta, false);
            break;
          case 'chat':
            setChat((c) => [...c.slice(-199), msg.m]);
            break;
          case 'delete':
            setChat((c) => c.filter((m) => m.id !== msg.id));
            break;
          case 'viewers':
            setViewers(msg.n);
            break;
          case 'pin':
            setPinned(msg.text);
            break;
          case 'emoji': {
            const f: FloatingEmoji = { key: ++floatKey.current, e: msg.e, right: Math.random() * 40 };
            setFloats((fs) => [...fs.slice(-14), f]);
            setTimeout(() => setFloats((fs) => fs.filter((x) => x.key !== f.key)), 2400);
            break;
          }
          case 'state':
            setStatus(msg.status);
            setStartedAt(msg.startedAt);
            if (msg.status === 'ended') setReplayOffered(false);
            break;
          case 'segment':
            latestKnownRef.current = Math.max(latestKnownRef.current, msg.seq);
            behindEma.current.push(Math.max(0, Date.now() - msg.at) / 1000);
            break;
        }
      },
      (reason) => {
        if (reason === 'denied') setPhase('denied');
        else if (reason === 'kicked') setPhase('kicked');
        else {
          setErr('Lost connection to the stream.');
          setPhase('error');
        }
      },
    );
  };

  // keep latest status visible to the fetcher interval without re-creating it
  const statusRef = useRef<StreamStatus>('idle');
  statusRef.current = status;

  // ------------------------------------------------- segment fetcher loop
  useEffect(() => {
    const id = window.setInterval(() => {
      setClock((c) => c + 1);
      const player = playerRef.current;
      if (!player) return;
      while (
        inflightRef.current < 3 &&
        player.pendingCount < 6 &&
        fetchCursorRef.current <= latestKnownRef.current
      ) {
        const seq = fetchCursorRef.current++;
        inflightRef.current += 1;
        fetchSegment(eventId, seq)
          .then(({ buf, elapsedMs }) => {
            inflightRef.current -= 1;
            setDownBps(downEma.current.push((buf.byteLength * 8) / (elapsedMs / 1000)));
            player.push(seq, buf);
          })
          .catch(() => {
            inflightRef.current -= 1; // tick()'s stall-skip handles the hole
          });
      }
      player.tick(latestKnownRef.current > 0 && statusRef.current === 'live');
    }, 400);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(
    () => () => {
      socketRef.current?.close();
      playerRef.current?.destroy();
    },
    [],
  );

  // ----------------------------------------------------------------- render
  const liveFor = startedAt && status === 'live' ? fmtDuration((Date.now() - startedAt) / 1000) : null;
  const video = videoRef.current;

  const metricRows: [string, string][] = useMemo(() => {
    const player = playerRef.current;
    return [
      ['Playback', video && video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—'],
      ['Download speed', fmtBps(downBps)],
      ['Buffer ahead', player ? `${player.bufferedAheadSec().toFixed(1)} s` : '—'],
      ['Behind live', behindEma.current.value != null ? `≈ ${behindEma.current.value.toFixed(1)} s + buffer` : '—'],
      ['Next segment', player ? `#${player.wantedSeq}` : '—'],
      ['Viewers', String(viewers)],
      ['Codec', meta?.mime ? meta.mime.split(';')[0].replace('video/', '') : '—'],
      ['Status', status],
    ];
  }, [video, downBps, viewers, meta, status]);

  if (phase === 'join') {
    return (
      <div className="lv-view lv-center">
        <div className="lv-card" style={{ width: 380, maxWidth: '92vw' }}>
          <h3>{meta?.title || 'Join the stream'}</h3>
          <div className="lv-field">
            <label>Your name</label>
            <input value={name} maxLength={24} placeholder="guest" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && join()} />
          </div>
          <button className="lv-btn lv-btn-primary" onClick={join}>
            Join stream
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'waiting') {
    return (
      <div className="lv-view lv-center">
        <div className="lv-card" style={{ width: 380, maxWidth: '92vw', textAlign: 'center' }}>
          <h3>Knocking…</h3>
          <p className="lv-sub" style={{ marginBottom: 0 }}>
            The host or a moderator will let you in shortly.
          </p>
        </div>
      </div>
    );
  }

  if (phase === 'denied' || phase === 'kicked' || phase === 'error') {
    return (
      <div className="lv-view lv-center">
        <div className="lv-banner err">
          {phase === 'denied' && 'The host did not admit you to this stream.'}
          {phase === 'kicked' && 'You were removed from this stream.'}
          {phase === 'error' && (err || 'Something went wrong.')}
        </div>
      </div>
    );
  }

  return (
    <div className="lv-view">
      <div className="lv-studio-grid">
        <div className="lv-stage">
          <div className="lv-preview">
            <div className="lv-overlay-tl">
              {status === 'live' && (
                <span className="lv-pill">
                  <span className="lv-livedot" /> LIVE{liveFor ? ` · ${liveFor}` : ''}
                </span>
              )}
              {status === 'paused' && <span className="lv-pill">⏸ Be right back</span>}
              {status === 'ended' && <span className="lv-pill">ENDED</span>}
              {status === 'idle' && <span className="lv-pill">Starting soon</span>}
            </div>
            <div className="lv-overlay-tr">
              <span className="lv-pill">👁 {viewers}</span>
              <button className="lv-pill" onClick={() => setMetricsOn((v) => !v)} title="Toggle metrics">
                {metricsOn ? '📊 on' : '📊'}
              </button>
            </div>
            <video ref={videoRef} autoPlay muted={muted} playsInline />
            {status === 'paused' && <div className="lv-slate">Be right back</div>}
            {status === 'idle' && (
              <div className="lv-slate">
                {meta?.scheduledAt && meta.scheduledAt > Date.now() ? (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 6 }}>
                      {new Date(meta.scheduledAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize: 18 }}>Starts {formatCountdown(meta.scheduledAt - Date.now())}</div>
                  </div>
                ) : (
                  'Waiting for the host to go live…'
                )}
              </div>
            )}
            {status === 'ended' && replayOffered && (
              <div className="lv-slate">
                <div style={{ textAlign: 'center' }}>
                  <p>This stream has ended.</p>
                  <button
                    className="lv-btn lv-btn-primary"
                    onClick={() => {
                      if (meta) {
                        setReplayOffered(false);
                        startPlayer(meta, true);
                      }
                    }}
                  >
                    ▶ Watch replay
                  </button>
                </div>
              </div>
            )}
            {metricsOn && <MetricsOverlay title="Playback metrics" rows={metricRows} />}
            <div className="lv-reactions">
              {floats.map((f) => (
                <span className="lv-float" style={{ right: f.right }} key={f.key}>
                  {f.e}
                </span>
              ))}
            </div>
            <div className="lv-controls" style={{ justifyContent: 'flex-start', paddingLeft: 18 }}>
              <button
                className="lv-ctl"
                title={muted ? 'Unmute' : 'Mute'}
                onClick={() => {
                  setMuted((m) => !m);
                  videoRef.current?.play().catch(() => undefined);
                }}
              >
                {muted ? '🔇' : '🔊'}
              </button>
              <span style={{ color: '#fff', fontSize: 12, opacity: 0.8 }}>
                {muted ? 'tap to unmute' : meta?.title || ''}
              </span>
            </div>
          </div>
        </div>

        <aside className="lv-rail">
          <div className="lv-rail-tabs">
            <button className="lv-rail-tab active">Chat</button>
          </div>
          <ChatPanel
            messages={chat}
            pinned={pinned}
            canModerate={false}
            onSend={(text) => socketRef.current?.send({ t: 'chat', text })}
            onEmoji={(e) => socketRef.current?.send({ t: 'emoji', e })}
          />
        </aside>
      </div>
    </div>
  );
}
