import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, openRoomSocket, uploadSegment, type RoomSocket } from './api';
import { ChatPanel, avatarStyle } from './ChatPanel';
import { LIMITS, SEGMENT_MS, presetById, type QualityPreset } from './config';
import {
  LocalRecorder,
  SegmentedRecorder,
  downloadBlob,
  lensLabel,
  listVideoInputs,
  openCamera,
  pickSupportedMime,
  recordingFilename,
  setZoom,
  zoomCapability,
  type ZoomRange,
} from './media';
import { Ema, fmtBps, fmtBytes, fmtDuration } from './metrics';
import { MetricsOverlay } from './MetricsOverlay';
import type { ChatMsg, LobbyEntry, StreamStatus } from './protocol';

type RailTab = 'chat' | 'lobby' | 'info';

export function StudioView({ eventId, hostKey }: { eventId: string; hostKey: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<RoomSocket | null>(null);
  const segRecRef = useRef<SegmentedRecorder | null>(null);
  const localRecRef = useRef<LocalRecorder | null>(null);
  const nextSeqRef = useRef(1);
  const recPartRef = useRef(1);
  const upEma = useRef(new Ema());
  const encEma = useRef(new Ema());

  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<QualityPreset>(presetById('720p'));
  const [mime, setMime] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDevice, setActiveDevice] = useState<string | null>(null);
  const [zoom, setZoomState] = useState<ZoomRange | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [recOn, setRecOn] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recBytes, setRecBytes] = useState(0);
  const [metricsOn, setMetricsOn] = useState(false);
  const [tab, setTab] = useState<RailTab>('chat');
  const [stats, setStats] = useState({ lastSeq: 0, failures: 0, upBps: null as number | null, encBps: null as number | null });
  const [, setClock] = useState(0); // 1 Hz re-render for timers

  const shareUrl = `${location.origin}${location.pathname}?e=${eventId}`;

  // ------------------------------------------------------------- lifecycle
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = pickSupportedMime();
      if (!m) {
        setErr('This browser cannot record video (MediaRecorder unsupported). Try Chrome, Edge, Firefox or Safari 16+.');
        return;
      }
      setMime(m);
      try {
        const meta = (await getEvent(eventId)) as { title: string; quality: string; latestSeq: number; status: StreamStatus; pinned: string | null };
        if (cancelled) return;
        setTitle(meta.title);
        setPinned(meta.pinned);
        const p = presetById(meta.quality);
        setPreset(p);
        nextSeqRef.current = (meta.latestSeq || 0) + 1; // survive a studio reload mid-event
        if (meta.status === 'live' || meta.status === 'paused') setStatus(meta.status);

        const stream = await openCamera(p);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setZoomState(zoomCapability(stream.getVideoTracks()[0]));
        setDevices(await listVideoInputs());
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Camera unavailable or live worker unreachable.');
        return;
      }

      socketRef.current = openRoomSocket(
        eventId,
        { name: 'Host', k: hostKey },
        (msg) => {
          switch (msg.t) {
            case 'hello':
              setChat(msg.chat);
              setViewers(msg.meta.viewers);
              setPinned(msg.meta.pinned);
              setStartedAt(msg.meta.startedAt);
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
            case 'lobby':
              setLobby(msg.pending);
              break;
            case 'pin':
              setPinned(msg.text);
              break;
            case 'state':
              setStatus(msg.status);
              setStartedAt(msg.startedAt);
              break;
          }
        },
        () => setErr('Lost connection to the event room.'),
      );
    })();

    const clock = window.setInterval(() => {
      setClock((c) => c + 1);
      if (localRecRef.current) setRecBytes(localRecRef.current.bytes);
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      segRecRef.current?.stop();
      void localRecRef.current?.stop();
      socketRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, hostKey]);

  // ------------------------------------------------------------- streaming
  const startSegments = () => {
    if (!streamRef.current || !mime) return;
    const rec = new SegmentedRecorder(
      streamRef.current,
      { mimeType: mime, videoBps: preset.videoBps, audioBps: preset.audioBps, segMs: SEGMENT_MS, startSeq: nextSeqRef.current },
      (blob, seq, durMs) => {
        nextSeqRef.current = seq + 1;
        uploadSegment(eventId, hostKey, seq, durMs, blob)
          .then(({ elapsedMs, bytes }) => {
            setStats((s) => ({
              ...s,
              lastSeq: Math.max(s.lastSeq, seq),
              encBps: encEma.current.push((bytes * 8) / (durMs / 1000)),
              upBps: upEma.current.push((bytes * 8) / (elapsedMs / 1000)),
            }));
          })
          .catch(() => setStats((s) => ({ ...s, failures: s.failures + 1 })));
      },
    );
    rec.start();
    segRecRef.current = rec;
  };

  const goLive = () => {
    socketRef.current?.send({ t: 'state', status: 'live' });
    setStatus('live');
    startSegments();
  };

  const pause = () => {
    socketRef.current?.send({ t: 'state', status: 'paused' });
    setStatus('paused');
    segRecRef.current?.stop(); // final partial segment still flushes
    segRecRef.current = null;
  };

  const resume = () => {
    socketRef.current?.send({ t: 'state', status: 'live' });
    setStatus('live');
    startSegments();
  };

  const endStream = async () => {
    if (!window.confirm('End the stream for everyone?')) return;
    socketRef.current?.send({ t: 'state', status: 'ended' });
    setStatus('ended');
    segRecRef.current?.stop();
    segRecRef.current = null;
    if (localRecRef.current) await stopRecording();
  };

  // ------------------------------------------------------------- recording
  const startRecording = () => {
    if (!streamRef.current || !mime) return;
    const clone = streamRef.current.clone();
    localRecRef.current = new LocalRecorder(clone, mime, preset.videoBps);
    setRecOn(true);
    setRecPaused(false);
  };

  const stopRecording = async () => {
    const rec = localRecRef.current;
    localRecRef.current = null;
    setRecOn(false);
    setRecPaused(false);
    if (rec) {
      const blob = await rec.stop();
      if (blob.size > 0 && mime) downloadBlob(blob, recordingFilename(eventId, recPartRef.current, mime));
      recPartRef.current += 1;
      setRecBytes(0);
    }
  };

  const toggleRecPause = () => {
    const rec = localRecRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.pause();
      setRecPaused(true);
    } else {
      rec.resume();
      setRecPaused(false);
    }
  };

  // ---------------------------------------------------------------- camera
  const switchCamera = async (deviceId: string) => {
    if (!streamRef.current) return;
    try {
      const fresh = await openCamera(preset, deviceId);
      const old = streamRef.current;
      streamRef.current = fresh;
      if (videoRef.current) videoRef.current.srcObject = fresh;
      setZoomState(zoomCapability(fresh.getVideoTracks()[0]));
      setActiveDevice(deviceId);
      fresh.getAudioTracks().forEach((t) => (t.enabled = micOn));
      fresh.getVideoTracks().forEach((t) => (t.enabled = camOn));
      if (segRecRef.current) {
        segRecRef.current.stop();
        startSegments(); // sequence numbering continues
      }
      if (localRecRef.current) {
        await stopRecording(); // lens change closes the file…
        startRecording(); // …and a new part begins on the new lens
      }
      old.getTracks().forEach((t) => t.stop());
    } catch {
      setErr('Could not switch camera.');
    }
  };

  const toggleTrack = (kind: 'audio' | 'video') => {
    const stream = streamRef.current;
    if (!stream) return;
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    const next = !(kind === 'audio' ? micOn : camOn);
    tracks.forEach((t) => (t.enabled = next));
    if (kind === 'audio') setMicOn(next);
    else setCamOn(next);
  };

  const applyZoom = async (value: number) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !zoom) return;
    try {
      await setZoom(track, value);
      setZoomState({ ...zoom, value });
    } catch {
      /* device refused the zoom level */
    }
  };

  // ----------------------------------------------------------------- render
  const liveFor = startedAt && (status === 'live' || status === 'paused') ? fmtDuration((Date.now() - startedAt) / 1000) : null;
  const settings = streamRef.current?.getVideoTracks()[0]?.getSettings();

  const metricRows: [string, string][] = useMemo(
    () => [
      ['Capture', settings ? `${settings.width}×${settings.height} @ ${Math.round(settings.frameRate || 0)}fps` : '—'],
      ['Target bitrate', fmtBps(preset.videoBps + preset.audioBps)],
      ['Encoded (actual)', fmtBps(stats.encBps)],
      ['Upload speed', fmtBps(stats.upBps)],
      ['Segment', stats.lastSeq ? `#${stats.lastSeq} · ${SEGMENT_MS / 1000}s` : '—'],
      ['Upload failures', String(stats.failures)],
      ['Viewers', String(viewers)],
      ['Codec', mime ? mime.split(';')[0].replace('video/', '') : '—'],
      ['REC', recOn ? `${fmtBytes(recBytes)}${recPaused ? ' · paused' : ''}` : 'off'],
    ],
    [settings, preset, stats, viewers, mime, recOn, recBytes, recPaused],
  );

  if (err) {
    return (
      <div className="lv-view">
        <div className="lv-banner err">{err}</div>
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
              {status === 'paused' && <span className="lv-pill">⏸ PAUSED</span>}
              {status === 'ended' && <span className="lv-pill">ENDED</span>}
              {recOn && <span className="lv-pill lv-rec">REC {fmtBytes(recBytes)}</span>}
            </div>
            <div className="lv-overlay-tr">
              <span className="lv-pill">👁 {viewers}</span>
              <button className="lv-pill" onClick={() => setMetricsOn((v) => !v)} title="Toggle metrics">
                {metricsOn ? '📊 on' : '📊'}
              </button>
            </div>
            <video ref={videoRef} autoPlay muted playsInline />
            {status === 'paused' && <div className="lv-slate">Paused — viewers see “Be right back”</div>}
            {metricsOn && <MetricsOverlay title="Studio metrics" rows={metricRows} />}
            <div className="lv-controls">
              <button className={`lv-ctl${micOn ? '' : ' off'}`} title="Microphone" onClick={() => toggleTrack('audio')}>
                {micOn ? '🎙' : '🔇'}
              </button>
              <button className={`lv-ctl${camOn ? '' : ' off'}`} title="Camera" onClick={() => toggleTrack('video')}>
                📷
              </button>
              {devices.length > 1 && (
                <span className="lv-lens-group">
                  {devices.slice(0, 4).map((d, i) => (
                    <button
                      key={d.deviceId}
                      className={`lv-lens${activeDevice === d.deviceId || (!activeDevice && i === 0) ? ' active' : ''}`}
                      onClick={() => switchCamera(d.deviceId)}
                    >
                      {lensLabel(d.label, i)}
                    </button>
                  ))}
                </span>
              )}
              {zoom && zoom.max > zoom.min && (
                <span className="lv-zoom">
                  🔍
                  <input
                    type="range"
                    min={zoom.min}
                    max={zoom.max}
                    step={zoom.step}
                    value={zoom.value}
                    onChange={(e) => applyZoom(Number(e.target.value))}
                  />
                  {zoom.value.toFixed(1)}×
                </span>
              )}
              {status === 'live' && (
                <button className="lv-ctl" title="Pause — viewers see a Be Right Back slate" onClick={pause}>
                  ⏸
                </button>
              )}
              {status === 'paused' && (
                <button className="lv-ctl" title="Resume" onClick={resume}>
                  ▶
                </button>
              )}
              <button
                className={`lv-ctl lv-recbtn${recOn ? ' on' : ''}`}
                title="Record the program feed (camera only — never your screen, never the chat)"
                onClick={recOn ? stopRecording : startRecording}
              >
                {recOn ? '■ Stop REC' : '● REC'}
              </button>
              {recOn && (
                <button className="lv-ctl" title={recPaused ? 'Resume recording' : 'Pause recording'} onClick={toggleRecPause}>
                  {recPaused ? '⏯' : '⏸︎REC'}
                </button>
              )}
              {status === 'idle' && (
                <button className="lv-btn lv-btn-live" onClick={goLive} disabled={!mime}>
                  Go live
                </button>
              )}
              {(status === 'live' || status === 'paused') && (
                <button className="lv-btn lv-btn-live" onClick={endStream}>
                  End stream
                </button>
              )}
            </div>
          </div>
          <div className="lv-health">
            <span>
              <b>{title || 'Untitled stream'}</b>
            </span>
            <span>
              <b>{preset.label}</b>
            </span>
            <span>up {fmtBps(stats.upBps)}</span>
            <span>
              seg #{stats.lastSeq}
              {stats.failures > 0 ? ` · ${stats.failures} failed` : ''}
            </span>
            <span className="lv-recnote">
              <b>● REC</b> captures the program feed only — never your screen, never the chat
            </span>
          </div>
          <div className="lv-linkbox">
            <span className="lv-link-text">{shareUrl}</span>
            <button onClick={() => navigator.clipboard?.writeText(shareUrl)}>Copy viewer link</button>
          </div>
        </div>

        <aside className="lv-rail">
          <div className="lv-rail-tabs">
            <button className={`lv-rail-tab${tab === 'chat' ? ' active' : ''}`} onClick={() => setTab('chat')}>
              Chat
            </button>
            <button className={`lv-rail-tab${tab === 'lobby' ? ' active' : ''}`} onClick={() => setTab('lobby')}>
              Lobby{lobby.length > 0 && <span className="lv-badge">{lobby.length}</span>}
            </button>
            <button className={`lv-rail-tab${tab === 'info' ? ' active' : ''}`} onClick={() => setTab('info')}>
              Info
            </button>
          </div>
          {tab === 'chat' && (
            <ChatPanel
              messages={chat}
              pinned={pinned}
              canModerate
              onSend={(text) => socketRef.current?.send({ t: 'chat', text })}
              onEmoji={(e) => socketRef.current?.send({ t: 'emoji', e })}
              onDelete={(id) => socketRef.current?.send({ t: 'delete', id })}
            />
          )}
          {tab === 'lobby' && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {lobby.length === 0 && <div className="lv-sysmsg" style={{ padding: 20 }}>nobody waiting</div>}
              {lobby.map((p) => (
                <div className="lv-person" key={p.sid}>
                  <div className="lv-avatar" style={avatarStyle(p.name)} />
                  <div className="lv-meta">
                    <div className="lv-name">{p.name}</div>
                    <div className="lv-note">waiting to join</div>
                  </div>
                  <button className="lv-mini admit" onClick={() => socketRef.current?.send({ t: 'admit', sid: p.sid })}>
                    Admit
                  </button>
                  <button className="lv-mini deny" onClick={() => socketRef.current?.send({ t: 'deny', sid: p.sid })}>
                    Deny
                  </button>
                </div>
              ))}
            </div>
          )}
          {tab === 'info' && (
            <div style={{ padding: 16, overflowY: 'auto' }}>
              <table className="lv-limits">
                <tbody>
                  {LIMITS.map(({ label, value }) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
