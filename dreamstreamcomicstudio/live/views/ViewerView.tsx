// Viewer watch page — name-only join, then live playback over the segment
// rail with a per-device player (MSE → ManagedMediaSource → blob queue), a
// chat rail, floating reactions, theater/fullscreen declutter modes and a
// true mobile layout. Survives refreshes (name + admission token persist).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchSegment, getEvent, openRoomSocket, type RoomSocket, type SocketStatus } from '../api';
import { joinedFlagKey, loadViewerName, saveViewerName } from '../events';
import { Ema, fmtBps, fmtDuration } from '../metrics';
import type { Nav } from '../nav';
import { createLivePlayer, playbackSupport, type LivePlayer } from '../player';
import type { ChatMsg, EventMeta, StreamStatus } from '../protocol';
import { REPLAY_WINDOW_MS } from '../protocol';
import { formatCountdown } from '../schedule';
import { coverGradient } from '../theme';
import { BrbSlate } from '../components/scenes';
import { ChatRail, ReactBar } from '../components/rails';
import { Icon } from '../ui/icons';
import { StreamStudioLogo } from '../ui/logo';
import {
  Avatar, Btn, FloatLayer, Pill, cx, useFloatingEmoji, useMediaQuery, type PushToast,
} from '../ui/primitives';

type Phase = 'join' | 'waiting' | 'watching' | 'denied' | 'kicked' | 'full' | 'error';

export function ViewerView({ eventId, nav, push }: { eventId: string; nav: Nav; push: PushToast }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<RoomSocket | null>(null);
  const playerRef = useRef<LivePlayer | null>(null);
  const fetchCursorRef = useRef(1);
  const latestKnownRef = useRef(0);
  const inflightRef = useRef(0);
  const downEma = useRef(new Ema());
  const behindEma = useRef(new Ema());
  const joinedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('join');
  const [name, setName] = useState(loadViewerName);
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [slowSec, setSlowSec] = useState(0);
  const [reactionsOn, setReactionsOn] = useState(true);
  const [muted, setMuted] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [chatSheet, setChatSheet] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [metricsOn, setMetricsOn] = useState(false);
  const [downBps, setDownBps] = useState<number | null>(null);
  const [replayOffered, setReplayOffered] = useState(false);
  const [sockStatus, setSockStatus] = useState<SocketStatus>('connected');
  const [floats, spawnFloat] = useFloatingEmoji();
  const [, setClock] = useState(0);

  const isMobile = useMediaQuery('(max-width: 900px)');

  // Pre-join: fetch public meta so the gate shows the real event.
  useEffect(() => {
    let cancelled = false;
    getEvent(eventId)
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
        setStatus(m.status);
        setStartedAt(m.startedAt);
        setViewers(m.viewers);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : 'Stream not found.');
          setPhase('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // ---------------------------------------------------------------- player
  /** Deferred start: the <video> only mounts after phase flips to 'watching',
   *  and the codec is only known once the host uploaded a first segment — so
   *  playback requests queue here until both are true. */
  const pendingStartRef = useRef<{ meta: EventMeta; fromStart: boolean } | null>(null);

  const startPlayer = (m: EventMeta, fromStart: boolean) => {
    if (!m.mime) {
      // Host hasn't sent a segment yet — wait; the first 'segment' message
      // refetches meta (which then carries the real codec) and retries.
      pendingStartRef.current = { meta: m, fromStart };
      return;
    }
    const mime = m.mime;
    const video = videoRef.current;
    if (!video) {
      pendingStartRef.current = { meta: m, fromStart };
      return;
    }
    playerRef.current?.destroy();
    const player = createLivePlayer(video, mime, m.segMs);
    if (!player) {
      const short = mime.split(';')[0];
      setErr(
        `This device can't decode the stream's codec (${short}). ` +
          (short.includes('webm')
            ? 'The host is sending WebM — iPhones and some TVs only decode MP4/H.264; ask the host to stream from a browser that records MP4 (Chrome 126+, Safari, Edge).'
            : 'Try the latest Chrome, Edge, Safari or Firefox.'),
      );
      setPhase('error');
      return;
    }
    const startSeq = fromStart ? Math.max(1, m.firstSeq || 1) : Math.max(m.firstSeq || 1, m.latestSeq - 1, 1);
    player.start(startSeq);
    playerRef.current = player;
    fetchCursorRef.current = startSeq;
    latestKnownRef.current = Math.max(latestKnownRef.current, m.latestSeq);
    video.play().catch(() => {
      /* will start on user gesture */
    });
  };

  // ----------------------------------------------------------------- join
  const join = (joinName?: string) => {
    if (joinedRef.current) return;
    joinedRef.current = true;
    const displayName = (joinName ?? name).trim() || `guest-${Math.random().toString(36).slice(2, 6)}`;
    saveViewerName(displayName);
    try {
      sessionStorage.setItem(joinedFlagKey(eventId), '1');
    } catch { /* private mode */ }
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
            setSlowSec(msg.meta.slowSec);
            setReactionsOn(msg.meta.reactionsOn);
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
          case 'config':
            setSlowSec(msg.slow);
            setReactionsOn(msg.reactions);
            break;
          case 'notice':
            push(msg.text, { icon: 'info' });
            break;
          case 'full':
            setPhase('full');
            break;
          case 'emoji':
            spawnFloat(msg.e);
            break;
          case 'state':
            setStatus(msg.status);
            setStartedAt(msg.startedAt);
            if (msg.status === 'ended') {
              setReplayOffered(false);
              push('The stream has ended', { icon: 'info' });
            }
            break;
          case 'segment':
            latestKnownRef.current = Math.max(latestKnownRef.current, msg.seq);
            behindEma.current.push(Math.max(0, Date.now() - msg.at) / 1000);
            // Joined before the host's first segment? The codec is known now —
            // refetch meta and start the player with the right mime.
            if (pendingStartRef.current && !pendingStartRef.current.meta.mime) {
              const pending = pendingStartRef.current;
              pendingStartRef.current = null; // guards against concurrent refetches
              getEvent(eventId)
                .then((fresh) => {
                  setMeta(fresh);
                  if (fresh.mime) startPlayer(fresh, pending.fromStart);
                  else pendingStartRef.current = pending; // still unknown — retry on the next segment
                })
                .catch(() => {
                  pendingStartRef.current = pending; // network blip — retry on the next segment
                });
            }
            break;
        }
      },
      (reason) => {
        if (reason === 'denied') setPhase('denied');
        else if (reason === 'kicked') setPhase('kicked');
        else if (reason === 'full') setPhase('full');
        else {
          setErr('Lost connection to the stream.');
          setPhase('error');
        }
      },
      setSockStatus,
    );
  };

  // Refresh-resilient: if this tab already joined the event, rejoin silently.
  useEffect(() => {
    try {
      if (sessionStorage.getItem(joinedFlagKey(eventId)) === '1' && loadViewerName()) join(loadViewerName());
    } catch { /* private mode */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Flush a deferred player start once the <video> exists (first render after
  // phase flips to 'watching') — without this, playback never begins because
  // the hello handler runs before the element is mounted.
  useEffect(() => {
    const pending = pendingStartRef.current;
    if (phase === 'watching' && pending && pending.meta.mime && videoRef.current) {
      pendingStartRef.current = null;
      startPlayer(pending.meta, pending.fromStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, immersive]);

  /** Fullscreen/declutter: real Fullscreen API where the browser allows it
   *  (with landscape lock for landscape streams), CSS takeover everywhere
   *  else (iPhone Safari can't fullscreen a div). */
  const setImmersiveMode = (on: boolean) => {
    setImmersive(on);
    if (!on) setChatSheet(false);
    if (on) {
      const el = stageRef.current;
      el?.requestFullscreen?.()
        .then(() => {
          const v = videoRef.current;
          const o = screen.orientation as ScreenOrientation & { lock?: (m: string) => Promise<void> };
          if (v && v.videoWidth > v.videoHeight) o.lock?.('landscape').catch(() => undefined);
        })
        .catch(() => undefined);
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    }
  };

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) {
        setImmersive(false);
        setChatSheet(false);
      }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

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
  const cover = coverGradient(meta?.cover ?? 0);

  const metricRows: [string, string][] = useMemo(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    return [
      ['Player', player ? player.mode.toUpperCase() : '—'],
      ['Playback', video && video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—'],
      ['Download speed', fmtBps(downBps)],
      ['Buffer ahead', player ? `${player.bufferedAheadSec().toFixed(1)} s` : '—'],
      ['Behind live', behindEma.current.value != null ? `≈ ${behindEma.current.value.toFixed(1)} s + buffer` : '—'],
      ['Next segment', player ? `#${player.wantedSeq}` : '—'],
      ['Viewers', String(viewers)],
      ['Codec', meta?.mime ? meta.mime.split(';')[0].replace('video/', '') : '—'],
      ['Status', status],
    ];
  }, [downBps, viewers, meta, status]);

  const sendChat = (text: string) => socketRef.current?.send({ t: 'chat', text });
  const sendEmoji = (e: string) => {
    socketRef.current?.send({ t: 'emoji', e });
    spawnFloat(e);
  };
  const toggleMute = () => {
    setMuted((m) => !m);
    videoRef.current?.play().catch(() => undefined);
  };

  /* -------------------------------------------------------------- phases */

  if (phase === 'join') {
    const live = status === 'live' || status === 'paused';
    const scheduledMs = meta?.scheduledAt && meta.scheduledAt > Date.now() ? meta.scheduledAt : null;
    return (
      <div className="viewer-root">
        <div className="viewer-join">
          <div className="vj-card">
            <div className="vj-preview">
              <div className="vj-cover" style={{ background: cover }} />
              <Icon name="broadcast" size={34} />
              {live && <span className="vj-live"><span className="pill-dot pulse" />LIVE</span>}
            </div>
            <div className="vj-body">
              <h1 className="vj-title serif">{meta?.title ?? 'Join the stream'}</h1>
              <div className="vj-host">
                {meta && <Avatar name={meta.host} size={26} />}
                <span>
                  {meta?.host ?? ''}
                  {live ? ` · ${viewers} watching now` : scheduledMs ? ` · starts ${formatCountdown(scheduledMs - Date.now())}` : ''}
                </span>
              </div>
              <label className="vj-label" htmlFor="vj-name">Enter your name to watch</label>
              <div className="vj-row">
                <input
                  id="vj-name"
                  className="input"
                  placeholder="e.g. Sam"
                  value={name}
                  maxLength={24}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && join()}
                />
                <Btn variant="solid" iconRight="arrowRight" onClick={() => join()}>Join</Btn>
              </div>
              <div className="vj-note">
                <Icon name="shield" size={13} />
                No account, no sign-up — just a name. Leave anytime.
                {meta?.access === 'approval' ? ' The host approves who gets in.' : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'waiting') {
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="center-card fade-in">
            <h2>Knocking…</h2>
            <p>The host or a moderator will let you in shortly.</p>
            <div className="knock-dots" aria-hidden><span /><span /><span /></div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'denied' || phase === 'kicked' || phase === 'full' || phase === 'error') {
    return (
      <div className="viewer-root">
        <div className="center-screen">
          <div className="center-card fade-in">
            <h2>
              {phase === 'error' ? 'Something went wrong' : phase === 'denied' ? 'Not admitted' : phase === 'full' ? 'Stream is full' : 'Removed'}
            </h2>
            <p>
              {phase === 'denied' && 'The host did not admit you to this stream.'}
              {phase === 'kicked' && 'You were removed from this stream.'}
              {phase === 'full' && `This stream is at its viewer cap${meta ? ` (${meta.maxViewers})` : ''}. Try again in a bit — a spot opens when someone leaves.`}
              {phase === 'error' && (err || 'Something went wrong.')}
            </p>
            {phase === 'full' && (
              <div style={{ marginTop: 16 }}>
                <Btn variant="solid" icon="refresh" onClick={() => location.reload()}>Try again</Btn>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ watching */

  const replayUntil = meta?.endedAt ? meta.endedAt + REPLAY_WINDOW_MS : null;
  const replayOpen = replayUntil != null && Date.now() < replayUntil;

  const stage = (
    <div className="preview" ref={stageRef}>
      <video ref={videoRef} autoPlay muted={muted} playsInline />
      {status === 'paused' && <BrbSlate sub="Starting again in a moment — stay tuned" />}
      {status === 'idle' && (
        <div className="viewer-slate" style={{ background: cover }}>
          <div className="vs-title serif">Starting soon</div>
          {meta?.scheduledAt && meta.scheduledAt > Date.now() ? (
            <>
              <div className="vs-count">{formatCountdown(meta.scheduledAt - Date.now())}</div>
              <div className="vs-sub">
                {new Date(meta.scheduledAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </div>
            </>
          ) : (
            <div className="vs-sub">Waiting for {meta?.host ?? 'the host'} to go live…</div>
          )}
        </div>
      )}
      {status === 'ended' && (
        <div className="viewer-slate">
          <div className="vs-title serif">This stream has ended</div>
          {replayOffered && replayOpen && meta && (
            <Btn
              variant="solid"
              icon="play"
              onClick={() => {
                setReplayOffered(false);
                startPlayer(meta, true);
              }}
            >
              Watch replay
            </Btn>
          )}
          {replayOpen ? (
            <div className="vs-sub">
              Replay available for another {formatCountdown(replayUntil! - Date.now()).replace(/^in /, '')}
            </div>
          ) : (
            <div className="vs-sub">The 24-hour replay window has closed. Thanks for watching.</div>
          )}
        </div>
      )}
      <div className="overlay-tl">
        {status === 'live' && <span className="ov-pill live"><span className="ov-dot pulse" />LIVE{liveFor ? ` · ${liveFor}` : ''}</span>}
        {sockStatus === 'reconnecting' && <span className="ov-pill"><Icon name="refresh" size={12} />Reconnecting…</span>}
      </div>
      <div className="overlay-tr">
        <span className="ov-pill"><Icon name="eye" size={13} />{viewers}</span>
        <button className={cx('ov-pill btn-like', metricsOn && 'active')} onClick={() => setMetricsOn((v) => !v)} aria-label="Playback metrics">
          <Icon name="activity" size={13} />
        </button>
      </div>
      {metricsOn && (
        <div className="metrics-ov">
          <h4>Playback metrics</h4>
          {metricRows.map(([k, v]) => (
            <div className="mrow" key={k}><span>{k}</span><span>{v}</span></div>
          ))}
        </div>
      )}
      <FloatLayer floats={floats} />
      <div className="viewer-controls">
        <button className="pv-ctl" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'volumeOff' : 'volume'} size={18} />
        </button>
        {muted && !immersive && <span className="vc-hint">Tap to unmute</span>}
        {immersive && reactionsOn && !isMobile && <ReactBar onReact={sendEmoji} />}
        <span className="spacer" />
        <button className="pv-ctl" onClick={() => setImmersiveMode(!immersive)} aria-label={immersive ? 'Exit fullscreen' : 'Fullscreen'}>
          <Icon name={immersive ? 'x' : 'maximize'} size={17} />
        </button>
      </div>
      {/* chat stays usable in fullscreen — last messages float over the video */}
      {immersive && (
        <div className="fs-chatpeek" aria-hidden>
          {chat.slice(-3).map((m) => (
            <div className="fs-peek-msg" key={m.id}>
              <span className="fs-peek-name" style={{ color: m.role === 'host' ? 'var(--accent-2)' : '#d9d4cb' }}>{m.name}</span>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      {immersive && (
        <button className="fs-chatbtn" onClick={() => setChatSheet(true)} aria-label="Open chat">
          <Icon name="chat" size={18} />
        </button>
      )}
      {immersive && chatSheet && (
        <div className="ms-chatsheet">
          <button className="ms-sheet-grip" onClick={() => setChatSheet(false)} aria-label="Close chat"><span /></button>
          <div className="ms-sheet-head">
            <b>Live chat</b>
            <span className="faint" style={{ fontSize: 11 }}>{viewers} here</span>
            <span className="spacer" />
            <button className="ms-x" onClick={() => setChatSheet(false)} aria-label="Close chat"><Icon name="x" size={15} /></button>
          </div>
          <div className="ms-sheet-list">
            {chat.map((m) => (
              <div className="vm-msg" key={m.id}>
                <span className="vm-msg-name" style={{ color: m.role === 'host' ? 'var(--accent)' : 'var(--muted)' }}>{m.name}</span>
                <span>{m.text}</span>
              </div>
            ))}
          </div>
          <div className="vm-input-row" style={{ padding: '10px 12px 14px' }}>
            <input
              className="input"
              placeholder="Say something…"
              aria-label="Chat message"
              onKeyDown={(e) => {
                const t = e.target as HTMLInputElement;
                if (e.key === 'Enter' && t.value.trim()) {
                  sendChat(t.value.trim());
                  t.value = '';
                }
              }}
            />
            <button className="vm-send" aria-label="Send"><Icon name="send" size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div className="viewer-root">
        <div className={cx('viewer-mobile', immersive && 'immersive')}>
          <div className="vm-video">
            {stage}
            {immersive && reactionsOn && (
              <div className="vm-immersive-reacts">
                <ReactBar onReact={sendEmoji} vertical />
              </div>
            )}
          </div>
          <div className="vm-head">
            {meta && <Avatar name={meta.host} size={34} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="vm-title">{meta?.title}</div>
              <div className="vm-by">{meta?.host} · {viewers} watching</div>
            </div>
            {status === 'live' && <Pill tone="live" dot pulse>LIVE</Pill>}
          </div>
          <div className="vm-chat" aria-live="polite">
            {pinned && (
              <div className="vm-msg" style={{ color: 'var(--accent-ink)' }}>
                <Icon name="pin" size={12} /> {pinned}
              </div>
            )}
            {chat.slice(-40).map((m) => (
              <div className="vm-msg" key={m.id}>
                <span className="vm-msg-name" style={{ color: m.role === 'host' ? 'var(--accent)' : 'var(--muted)' }}>{m.name}</span>
                <span>{m.text}</span>
              </div>
            ))}
          </div>
          <div className="vm-composer">
            {reactionsOn && (
              <div className="vm-reactions">
                <ReactBar onReact={sendEmoji} />
              </div>
            )}
            <div className="vm-input-row">
              <input
                className="input"
                placeholder="Say something…"
                aria-label="Chat message"
                onKeyDown={(e) => {
                  const t = e.target as HTMLInputElement;
                  if (e.key === 'Enter' && t.value.trim()) {
                    sendChat(t.value.trim());
                    t.value = '';
                  }
                }}
              />
              <button className="vm-send" aria-label="Send"><Icon name="send" size={16} /></button>
            </div>
            {slowSec > 0 && <div className="slow-note" style={{ marginTop: 6 }}>Slow mode — one message every {slowSec}s</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-root">
      <div className="viewer-topbar">
        <span className="rail-logo" style={{ cursor: 'default' }}><StreamStudioLogo /></span>
        <span className="spacer" />
        {status === 'live' && <Pill tone="live" dot pulse>LIVE</Pill>}
      </div>
      <div className={cx('viewer-desktop', immersive && 'immersive')}>
        <div className="vd-main">
          <div className="viewer-stage">{stage}</div>
          <div className="vd-info">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {meta && <Avatar name={meta.host} size={46} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 className="vd-title serif">{meta?.title}</h1>
                <div className="vd-by">{meta?.host}</div>
              </div>
              <Btn variant="ghost" icon="maximize" onClick={() => setImmersiveMode(true)}>Theater</Btn>
            </div>
            <div className="vd-chips">
              <Pill tone="neutral" icon="eye">{viewers} watching</Pill>
              {liveFor && <Pill tone="neutral" icon="clock">{liveFor} elapsed</Pill>}
              {meta && <Pill tone="neutral" icon="globe">{meta.quality}</Pill>}
            </div>
            {meta?.desc && <p className="vd-desc">{meta.desc}</p>}
          </div>
        </div>
        <aside className="vd-rail" aria-label="Live chat">
          <div className="vd-rail-head">
            <Icon name="chat" size={15} /> Live chat <span className="spacer" />
            <span className="faint" style={{ fontSize: 11.5 }}>{viewers} here</span>
          </div>
          <ChatRail
            chat={chat}
            pinned={pinned}
            slowSec={slowSec}
            reactionsOn={reactionsOn}
            onSend={sendChat}
            onReact={sendEmoji}
          />
        </aside>
      </div>
    </div>
  );
}
