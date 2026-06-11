// Host Studio — the hero surface. Real camera → canvas program mixer →
// segmented uploads, with scenes, transport, hotkeys, a four-tab right rail
// (chat / people / activity / health) and a phone broadcaster mode.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, openRoomSocket, sendHostExitBeacon, uploadSegment, type RoomSocket, type SocketStatus } from '../api';
import { IS_LOCAL_DEV, SEGMENT_MS, presetById, type QualityPreset } from '../config';
import { addMyRecording, findMyEvent, updateMyEvent } from '../events';
import { pushEventToCloud } from '../sync';
import { ProgramAudioMixer } from '../studio/audioMixer';
import { HostPeers, type GuestLink } from '../studio/rtc';
import {
  LocalRecorder,
  SegmentedRecorder,
  downloadBlob,
  lensLabel,
  listVideoInputs,
  openCamera,
  openCameraVideo,
  pickSupportedMime,
  recordingFilename,
  setZoom,
  zoomCapability,
  type ZoomRange,
} from '../media';
import { Ema, fmtBps, fmtBytes, fmtDuration } from '../metrics';
import type { Nav } from '../nav';
import { guestUrl, viewerUrl } from '../nav';
import { loadPrefs, playChime, savePrefs } from '../prefs';
import type { ChatMsg, LobbyEntry, LogEntry, PersonEntry, StreamStatus } from '../protocol';
import { MULTI_SCENES, ProgramCompositor, SCENES, fitCanvasToSource, type ProgramTile, type SceneId } from '../studio/compositor';
import { uploadRecording } from '../api';
import { ActivityRail, ChatRail, HealthRail, PeopleRail } from '../components/rails';
import { SceneSketch } from '../components/scenes';
import { Icon } from '../ui/icons';
import { StreamStudioMark } from '../ui/logo';
import {
  Btn, FloatLayer, IconBtn, Pill, Segmented, Tabs, cx,
  useFloatingEmoji, useMediaQuery, type PushToast,
} from '../ui/primitives';

type RailTab = 'chat' | 'people' | 'activity' | 'health';

/** <video> bound to a MediaStream (the program preview). `mirror` flips the
 *  host's SELF-VIEW only — what viewers and the recording get is unmirrored,
 *  matching how every camera app behaves. */
function VideoSink({ stream, className, mirror }: { stream: MediaStream | null; className?: string; mirror?: boolean }) {
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
      muted
      playsInline
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
      aria-label="Program preview"
    />
  );
}

/** Hidden monitor so the HOST hears a guest (the program mix is previewed muted). */
function AudioSink({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (a.srcObject !== stream) {
      a.srcObject = stream;
      a.play().catch(() => undefined);
    }
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

export function StudioView({ eventId, hostKey, nav, push }: { eventId: string; hostKey: string; nav: Nav; push: PushToast }) {
  const prefs = useMemo(loadPrefs, []);
  const hostName = prefs.hostName.trim() || 'Host';

  // ------------------------------------------------------------------ refs
  const camRef = useRef<MediaStream | null>(null);          // current camera (video; first one also carries audio)
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const compRef = useRef<ProgramCompositor | null>(null);
  const mixerRef = useRef<ProgramAudioMixer | null>(null);
  const hostPeersRef = useRef<HostPeers | null>(null);
  const guestNamesRef = useRef(new Map<string, string>());
  const tileVideosRef = useRef(new Map<string, HTMLVideoElement>());
  const socketRef = useRef<RoomSocket | null>(null);
  const segRecRef = useRef<SegmentedRecorder | null>(null);
  const localRecRef = useRef<LocalRecorder | null>(null);
  const nextSeqRef = useRef(1);
  const recPartRef = useRef(1);
  const upEma = useRef(new Ema());
  const encEma = useRef(new Ema());
  const upElapsedEma = useRef(new Ema());
  const composerRef = useRef<HTMLInputElement | null>(null);
  const viewersRef = useRef(0);
  const prevLobbyRef = useRef(0);

  // ----------------------------------------------------------------- state
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<QualityPreset>(presetById(prefs.qualityId));
  const [mime, setMime] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [viewers, setViewers] = useState(0);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyEntry[]>([]);
  const [people, setPeople] = useState<PersonEntry[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [scene, setScene] = useState<SceneId>('solo');
  const [mixed, setMixed] = useState<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDevice, setActiveDevice] = useState<string | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [zoomCap, setZoomCap] = useState<ZoomRange | null>(null);
  const [zoomVal, setZoomVal] = useState(1);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [recOn, setRecOn] = useState(false);
  const [recBytes, setRecBytes] = useState(0);
  const [metricsOn, setMetricsOn] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>('chat');
  const [chatOpen, setChatOpen] = useState(prefs.chatOpen);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [sockStatus, setSockStatus] = useState<SocketStatus>('connected');
  const [stats, setStats] = useState({ lastSeq: 0, failures: 0, upBps: null as number | null, encBps: null as number | null });
  const [viewerCurve, setViewerCurve] = useState<number[]>([]);
  const [segMs, setSegMs] = useState(SEGMENT_MS);
  const [maxViewers, setMaxViewers] = useState(100);
  const [pipPos, setPipPos] = useState(prefs.pipPos);
  const [pipSize, setPipSize] = useState(prefs.pipSize);
  const [guests, setGuests] = useState<GuestLink[]>([]);
  const [guestKey, setGuestKey] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [floats, spawnFloat] = useFloatingEmoji();
  const [, setClock] = useState(0); // 1 Hz re-render for timers

  const isPhone = useMediaQuery('(max-width: 700px)');
  const shareUrl = viewerUrl(eventId);
  const isLive = status === 'live';
  viewersRef.current = viewers;
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const statusRef = useRef(status);
  statusRef.current = status;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const focusIdRef = useRef(focusId);
  focusIdRef.current = focusId;
  const lastAutoFocusRef = useRef<{ id: string | null; at: number }>({ id: null, at: 0 });
  const recStartRef = useRef(0);

  // ------------------------------------------------------------- lifecycle
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = pickSupportedMime(undefined, prefs.preferMp4);
      if (!m) {
        setErr('This browser cannot record video (MediaRecorder unsupported). Try Chrome, Edge, Firefox or Safari 16+.');
        return;
      }
      setMime(m);
      try {
        const meta = await getEvent(eventId);
        if (cancelled) return;
        setTitle(meta.title);
        setPinned(meta.pinned);
        setSegMs(meta.segMs || SEGMENT_MS);
        setMaxViewers(meta.maxViewers || 100);
        const p = presetById(meta.quality);
        setPreset(p);
        nextSeqRef.current = (meta.latestSeq || 0) + 1; // survive a studio reload mid-event
        setStatus(meta.status);
        setStartedAt(meta.startedAt);

        const cam = await openCamera(p);
        if (cancelled) {
          cam.getTracks().forEach((t) => t.stop());
          return;
        }
        camRef.current = cam;
        audioTrackRef.current = cam.getAudioTracks()[0] ?? null;
        // The program follows the camera's real orientation/aspect — a phone
        // held upright streams portrait instead of a hard center-crop.
        const cs = cam.getVideoTracks()[0]?.getSettings() ?? {};
        const dims = fitCanvasToSource(cs.width || p.width, cs.height || p.height, p.width, p.height);
        const comp = new ProgramCompositor(dims.w, dims.h, prefs.fps);
        comp.setHostInitial(hostName);
        comp.setLook(prefs.look);
        comp.setPipLayout(prefs.pipPos, prefs.pipSize);
        comp.setCamera(cam);
        comp.onScreenEnded = () => {
          comp.setScene('solo');
          setScene((s) => (s === 'screen' ? 'solo' : s));
          push('Screen share ended', { icon: 'screen' });
        };
        comp.start();
        compRef.current = comp;

        // Program audio = ONE stable mixed track (host mic + guests), so the
        // encoder never restarts when someone joins. Falls back to the raw
        // mic track if WebAudio is unavailable.
        let programAudio: MediaStreamTrack | null = audioTrackRef.current;
        try {
          const mixer = new ProgramAudioMixer();
          mixer.addSource('host', cam);
          mixerRef.current = mixer;
          programAudio = mixer.track;
        } catch {
          mixerRef.current = null;
        }
        setMixed(comp.buildOutput(programAudio));
        setZoomCap(zoomCapability(cam.getVideoTracks()[0]));
        setDevices(await listVideoInputs());

        // On-air guests: host-centric WebRTC mesh, signaled through the room.
        const peers = new HostPeers((sid, d) => socketRef.current?.send({ t: 'rtc', to: sid, d }));
        peers.setReturnFeed(cam.getVideoTracks()[0] ?? null, audioTrackRef.current);
        const syncGuests = () => {
          const list = peers.guests();
          setGuests(list);
          const mixer = mixerRef.current;
          const seen = new Set<string>();
          const tiles: ProgramTile[] = [];
          const videoFor = (stream: MediaStream): HTMLVideoElement => {
            let v = tileVideosRef.current.get(stream.id);
            if (!v) {
              v = document.createElement('video');
              v.muted = true; // tile video only — guest AUDIO flows through the mixer
              v.playsInline = true;
              v.srcObject = stream;
              v.play().catch(() => undefined);
              tileVideosRef.current.set(stream.id, v);
            }
            return v;
          };
          for (const g of list) {
            if (g.cam) {
              seen.add(g.cam.id);
              tiles.push({ id: `${g.sid}-cam`, label: g.name, kind: 'cam', video: videoFor(g.cam) });
              if (mixer) mixer.addSource(g.sid, g.cam);
            } else if (mixer) {
              mixer.removeSource(g.sid);
            }
            if (g.screen) {
              seen.add(g.screen.id);
              tiles.push({ id: `${g.sid}-screen`, label: `${g.name}'s screen`, kind: 'screen', video: videoFor(g.screen) });
            }
          }
          for (const [id, v] of tileVideosRef.current) {
            if (!seen.has(id)) {
              v.srcObject = null;
              tileVideosRef.current.delete(id);
            }
          }
          if (mixer) {
            const liveSids = new Set(list.map((g) => g.sid));
            for (const g of guestNamesRef.current.keys()) {
              if (!liveSids.has(g) && mixer.has(g)) mixer.removeSource(g);
            }
          }
          comp.setRemoteTiles(tiles);
        };
        peers.onChange = syncGuests;
        hostPeersRef.current = peers;
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Camera unavailable or live worker unreachable.');
        return;
      }

      socketRef.current = openRoomSocket(
        eventId,
        { name: hostName, k: hostKey },
        (msg) => {
          switch (msg.t) {
            case 'hello':
              setChat(msg.chat);
              setViewers(msg.meta.viewers);
              setPinned(msg.meta.pinned);
              setStartedAt(msg.meta.startedAt);
              if (msg.log) setLog(msg.log);
              // Mint (or fetch) the guest invite key for this event.
              if (msg.you.role === 'host') socketRef.current?.send({ t: 'guestkey' });
              break;
            case 'guestkey':
              setGuestKey(msg.key);
              break;
            case 'guest':
              guestNamesRef.current.set(msg.sid, msg.name);
              if (!msg.on) {
                hostPeersRef.current?.close(msg.sid);
                push(`${msg.name} left the guest seats`, { icon: 'users' });
              } else {
                push(`${msg.name} joined as a guest — try Grid (3) or Spotlight (4)`, { icon: 'users' });
                if (prefs.alertSound === 'soft') playChime();
              }
              break;
            case 'rtc':
              void hostPeersRef.current?.onSignal(
                msg.from,
                guestNamesRef.current.get(msg.from) ?? 'Guest',
                msg.d,
              );
              break;
            case 'chat':
              setChat((c) => [...c.slice(-199), msg.m]);
              break;
            case 'delete':
              setChat((c) => c.filter((x) => x.id !== msg.id));
              break;
            case 'viewers':
              setViewers(msg.n);
              break;
            case 'lobby':
              setLobby(msg.pending);
              break;
            case 'people':
              setPeople(msg.list);
              break;
            case 'log':
              setLog((l) => [...l.slice(-299), msg.entry]);
              break;
            case 'pin':
              setPinned(msg.text);
              break;
            case 'emoji':
              spawnFloat(msg.e);
              break;
            case 'milestone':
              if (prefs.alertMilestones) {
                push(`${msg.n} viewers — new peak!`, { icon: 'star' });
                if (prefs.alertSound === 'soft') playChime();
              }
              break;
            case 'config':
              setMaxViewers(msg.maxViewers);
              break;
            case 'state':
              setStatus(msg.status);
              setStartedAt(msg.startedAt);
              break;
          }
        },
        () => setErr('Lost connection to the event room.'),
        setSockStatus,
      );
    })();

    const clock = window.setInterval(() => {
      setClock((c) => c + 1);
      if (localRecRef.current) setRecBytes(localRecRef.current.bytes);
    }, 1000);
    // Who's talking: light the speaking ring on cam tiles and, in Spotlight/
    // Sidebar with focus on Auto and no screen on stage, follow the active
    // speaker (2.5 s hysteresis so the stage never ping-pongs mid-sentence).
    const EMPTY = new Set<string>();
    const speakTimer = window.setInterval(() => {
      const mixer = mixerRef.current;
      const comp = compRef.current;
      if (!mixer || !comp) return;
      if (!MULTI_SCENES.has(sceneRef.current)) {
        comp.setSpeaking(EMPTY);
        return;
      }
      const speaking = new Set<string>();
      let loudest: { id: string; lvl: number } | null = null;
      for (const [src, lvl] of mixer.levels()) {
        const tileId = src === 'host' ? 'host-cam' : `${src}-cam`;
        if (lvl > 0.045) speaking.add(tileId);
        if (lvl > 0.06 && (!loudest || lvl > loudest.lvl)) loudest = { id: tileId, lvl };
      }
      comp.setSpeaking(speaking);
      if (
        (sceneRef.current === 'spotlight' || sceneRef.current === 'sidebar') &&
        focusIdRef.current == null &&
        loudest
      ) {
        const tiles = comp.allTiles();
        if (!tiles.some((t) => t.kind === 'screen') && tiles.some((t) => t.id === loudest!.id)) {
          const last = lastAutoFocusRef.current;
          if (last.id !== loudest.id && Date.now() - last.at > 2500) {
            lastAutoFocusRef.current = { id: loudest.id, at: Date.now() };
            comp.setFocus(loudest.id);
          }
        }
      }
    }, 250);
    const curveTimer = window.setInterval(() => {
      setViewerCurve((cv) => [...cv.slice(-119), viewersRef.current]);
    }, 10_000);
    // Network telemetry → the room's durable health curve (analyze & improve).
    const healthTimer = window.setInterval(() => {
      if (statusRef.current !== 'live') return;
      socketRef.current?.send({
        t: 'health',
        up: Math.round(statsRef.current.upBps ?? 0),
        enc: Math.round(statsRef.current.encBps ?? 0),
        fail: statsRef.current.failures,
      });
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(clock);
      window.clearInterval(speakTimer);
      window.clearInterval(curveTimer);
      window.clearInterval(healthTimer);
      segRecRef.current?.stop();
      void localRecRef.current?.stop();
      hostPeersRef.current?.closeAll();
      mixerRef.current?.close();
      for (const v of tileVideosRef.current.values()) v.srcObject = null;
      tileVideosRef.current.clear();
      socketRef.current?.close();
      compRef.current?.stop();
      camRef.current?.getTracks().forEach((t) => t.stop());
      audioTrackRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, hostKey]);

  // Lobby alerts (someone knocked).
  useEffect(() => {
    if (lobby.length > prevLobbyRef.current && prefs.alertJoins) {
      push(`${lobby[lobby.length - 1]?.name ?? 'Someone'} is waiting in the lobby`, { icon: 'users' });
      if (prefs.alertSound === 'soft') playChime();
    }
    prevLobbyRef.current = lobby.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.length]);

  const hostLog = (kind: LogEntry['kind'], tag: string, msg: string) =>
    socketRef.current?.send({ t: 'log', kind, tag, msg });

  /** Screen + cam layout — applied live and remembered for next time. */
  const applyPip = (pos: typeof pipPos, size: typeof pipSize) => {
    setPipPos(pos);
    setPipSize(size);
    compRef.current?.setPipLayout(pos, size);
    savePrefs({ ...loadPrefs(), pipPos: pos, pipSize: size });
  };

  // Guardrail: closing the tab while on air ENDS the stream (cost + viewer
  // safety). beforeunload warns first; if the host proceeds, the pagehide
  // beacon tells the room to end now — restartable from the same studio link.
  // Silent drops (crash, network) skip pagehide; the room's 2-minute paused
  // grace still backstops those.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (statusRef.current === 'live') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onPageHide = (e: PageTransitionEvent) => {
      if (!e.persisted && (statusRef.current === 'live' || statusRef.current === 'paused')) {
        sendHostExitBeacon(eventId, hostKey);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [eventId, hostKey]);

  // ------------------------------------------------------------- streaming
  const startSegments = () => {
    if (!mixed || !mime) return;
    const videoBps = prefs.videoBpsOverride > 0 ? prefs.videoBpsOverride : preset.videoBps;
    const rec = new SegmentedRecorder(
      mixed,
      { mimeType: mime, videoBps, audioBps: preset.audioBps, segMs, startSeq: nextSeqRef.current },
      (blob, seq, durMs) => {
        nextSeqRef.current = seq + 1;
        uploadSegment(eventId, hostKey, seq, durMs, blob)
          .then(({ elapsedMs, bytes }) => {
            upElapsedEma.current.push(elapsedMs);
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
    mixerRef.current?.unlock(); // browsers may gesture-gate AudioContexts
    socketRef.current?.send({ t: 'state', status: 'live' });
    if (prefs.slowSec > 0) socketRef.current?.send({ t: 'config', slow: prefs.slowSec });
    setStatus('live');
    startSegments();
    updateMyEvent(eventId, { status: 'live', startedAt: startedAt ?? Date.now() });
    const mine = findMyEvent(eventId);
    if (mine) void pushEventToCloud(mine);
    if (prefs.autoRecord && !localRecRef.current) startRecording();
    push('You are live', { icon: 'broadcast' });
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
    updateMyEvent(eventId, { status: 'ended', peakViewers: Math.max(...viewerCurve, viewers), endedAt: Date.now() });
    const mine = findMyEvent(eventId);
    if (mine) void pushEventToCloud(mine);
    push('Stream ended', { icon: 'stop' });
    nav.summary(eventId, hostKey);
  };

  // ------------------------------------------------------------- recording
  const startRecording = () => {
    if (!mixed || !mime) return;
    const videoBps = prefs.videoBpsOverride > 0 ? prefs.videoBpsOverride : preset.videoBps;
    localRecRef.current = new LocalRecorder(mixed.clone(), mime, videoBps, prefs.recordHighBitrate ? 2.5 : 1);
    recStartRef.current = Date.now();
    setRecOn(true);
    hostLog('rec', 'REC', `Local recording started · part ${recPartRef.current}`);
  };

  const stopRecording = async () => {
    const rec = localRecRef.current;
    localRecRef.current = null;
    setRecOn(false);
    if (rec) {
      const blob = await rec.stop();
      const durMs = Date.now() - recStartRef.current;
      if (blob.size > 0 && mime) {
        const file = recordingFilename(eventId, recPartRef.current, mime);
        downloadBlob(blob, file); // device copy first — never lose the master
        addMyRecording({ eventId, title: title || 'Untitled stream', file, bytes: blob.size, at: Date.now() });
        hostLog('rec', 'REC', `Recording saved to device · ${fmtBytes(blob.size)}`);
        if (prefs.cloudRecordings) {
          // Background upload to the 7-day server store; survives leaving the studio.
          push(`Uploading ${fmtBytes(blob.size)} to your 7-day cloud store…`, { icon: 'refresh' });
          uploadRecording(eventId, hostKey, blob, { file, durMs })
            .then(() => push('Recording stored in the cloud (kept 7 days)', { icon: 'check' }))
            .catch(() => push('Cloud upload failed — the device copy is safe', { icon: 'alert' }));
        }
      }
      recPartRef.current += 1;
      setRecBytes(0);
    }
  };

  const toggleRec = () => (recOn ? void stopRecording() : startRecording());

  // ---------------------------------------------------------------- scenes
  const cutScene = async (id: SceneId) => {
    if (id === scene) return;
    const comp = compRef.current;
    if (!comp) return;
    if (id === 'screen' && !comp.screenActive) {
      const ok = await comp.startScreenShare();
      if (!ok) {
        push('Screen share was cancelled', { icon: 'screen' });
        return;
      }
    }
    // The host's own share survives cuts BETWEEN layouts that can show it;
    // cutting to a cam-only scene stops it (same behavior as before).
    if (id !== 'screen' && !MULTI_SCENES.has(id) && comp.screenActive) comp.stopScreenShare();
    comp.setScene(id === 'brb' ? 'solo' : id);
    setScene(id);
    if (id === 'brb') {
      if (status === 'live') pause();
      push('Be right back — uploads paused', { icon: 'pause' });
    } else if (status === 'paused') {
      resume();
    }
    hostLog('scene', 'SCENE', `Cut to “${SCENES.find((s) => s.id === id)?.name}”`);
  };

  // ---------------------------------------------------------------- camera
  const switchCamera = async (deviceId: string) => {
    try {
      const fresh = await openCameraVideo(preset, { deviceId });
      swapCameraStream(fresh);
      setActiveDevice(deviceId);
    } catch {
      push('Could not switch camera', { icon: 'alert' });
    }
  };

  const flipCamera = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      // `exact` forces the browser to actually switch lenses (Android/iOS
      // happily return the same camera for a soft facingMode hint).
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { exact: next },
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: prefs.fps },
          },
        });
      } catch {
        fresh = await openCameraVideo(preset, { facingMode: next });
      }
      swapCameraStream(fresh);
      setFacing(next);
      setActiveDevice(fresh.getVideoTracks()[0]?.getSettings().deviceId ?? null);
      setDevices(await listVideoInputs()); // labels fill in after first grant
    } catch {
      push('This device has no camera facing the other way', { icon: 'alert' });
    }
  };

  /** Step through every physical lens the device exposes (0.5× / 1× / tele…). */
  const cycleLens = async () => {
    if (devices.length < 2) {
      await flipCamera();
      return;
    }
    const idx = Math.max(0, devices.findIndex((d) => d.deviceId === activeDevice));
    const nextDev = devices[(idx + 1) % devices.length];
    await switchCamera(nextDev.deviceId);
    push(lensLabel(nextDev.label, (idx + 1) % devices.length), { icon: 'video', duration: 1200 });
  };

  /** The encoder records the canvas, so camera swaps never restart it. */
  const swapCameraStream = (fresh: MediaStream) => {
    const old = camRef.current;
    camRef.current = fresh;
    compRef.current?.setCamera(fresh);
    fresh.getVideoTracks().forEach((t) => (t.enabled = camOn));
    // Guests' return feed follows the camera swap in place (no renegotiation).
    void hostPeersRef.current?.replaceCamTrack(fresh.getVideoTracks()[0] ?? null);
    const cap = zoomCapability(fresh.getVideoTracks()[0]);
    setZoomCap(cap);
    setZoomVal(cap?.value ?? 1);
    old?.getVideoTracks().forEach((t) => t.stop());
  };

  const toggleMic = () => {
    const next = !micOn;
    if (audioTrackRef.current) audioTrackRef.current.enabled = next;
    setMicOn(next);
  };

  const toggleCam = () => {
    const next = !camOn;
    camRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    compRef.current?.setCamEnabled(next);
    setCamOn(next);
  };

  // Zoom is the camera's NATIVE zoom only (Chrome Android / Safari 17+ expose
  // it on the track). Devices without it simply don't show a zoom control —
  // no synthesized crop-zoom.
  const applyZoom = async (v: number) => {
    setZoomVal(v);
    const track = camRef.current?.getVideoTracks()[0];
    if (track && zoomCap) {
      try {
        await setZoom(track, v);
      } catch {
        /* device refused the zoom level */
      }
    }
  };

  const zoomMin = zoomCap ? zoomCap.min : 1;
  const zoomMax = zoomCap ? Math.max(zoomCap.max, zoomCap.min + 0.1) : 1;
  const zoomStep = zoomCap ? zoomCap.step : 0.1;
  const hasNativeZoom = !!zoomCap && zoomMax > zoomMin;

  // ------------------------------------------------------------------ chat
  const sendChat = (text: string) => socketRef.current?.send({ t: 'chat', text });
  const sendEmoji = (e: string) => {
    socketRef.current?.send({ t: 'emoji', e });
    spawnFloat(e);
  };
  const delChat = (id: string) => socketRef.current?.send({ t: 'delete', id });

  // --------------------------------------------------------------- hotkeys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const k = e.key.toLowerCase();
      if (k === 'g') {
        if (isLive || status === 'paused') void endStream();
        else if (status === 'idle') goLive();
      } else if (k === ' ') {
        e.preventDefault();
        toggleMic();
      } else if (k === 'v') toggleCam();
      else if (k === 'r') toggleRec();
      else if (k === 'b') void cutScene(scene === 'brb' ? 'solo' : 'brb');
      else if (k === 'm') setMetricsOn((v) => !v);
      else if (k === '/') {
        e.preventDefault();
        setChatOpen(true);
        setRailTab('chat');
        setTimeout(() => composerRef.current?.focus(), 50);
      } else if (k >= '1' && k <= '6') {
        const sc = SCENES[Number(k) - 1];
        if (sc) void cutScene(sc.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ----------------------------------------------------------------- render
  const liveFor = startedAt && (status === 'live' || status === 'paused') ? fmtDuration((Date.now() - startedAt) / 1000) : null;
  const sceneObj = SCENES.find((s) => s.id === scene) || SCENES[0];
  const latencyEst = upElapsedEma.current.value != null ? segMs / 1000 + upElapsedEma.current.value / 1000 + 1 : null;
  const healthy = stats.failures === 0 && sockStatus === 'connected';
  // Self-view mirroring: explicit preference wins; auto = front cam in Solo
  // (matching camera apps). The outgoing program is NEVER mirrored.
  const mirrorSelf =
    prefs.mirrorPreview === 'on' ? true
    : prefs.mirrorPreview === 'off' ? false
    : facing === 'user' && scene === 'solo';
  // Hidden monitors so the host hears guests (the program preview is muted).
  const guestMonitors = guests.filter((g) => g.cam).map((g) => <AudioSink key={g.sid} stream={g.cam!} />);
  const focusOptions = MULTI_SCENES.has(scene) ? (compRef.current?.allTiles() ?? []) : [];
  const copyGuestInvite = () => {
    if (!guestKey) return;
    navigator.clipboard?.writeText(guestUrl(eventId, guestKey)).catch(() => undefined);
    push('Guest invite link copied — up to 4 guests can join on air', { icon: 'users' });
  };

  const metricRows: [string, string][] = useMemo(
    () => [
      ['Program', `${preset.width}×${preset.height} @ ${prefs.fps}fps`],
      ['Target bitrate', fmtBps((prefs.videoBpsOverride || preset.videoBps) + preset.audioBps)],
      ['Encoded (actual)', fmtBps(stats.encBps)],
      ['Upload speed', fmtBps(stats.upBps)],
      ['Segment', stats.lastSeq ? `#${stats.lastSeq} · ${segMs / 1000}s` : '—'],
      ['Upload failures', String(stats.failures)],
      ['Viewers', String(viewers)],
      ['Codec', mime ? mime.split(';')[0].replace('video/', '') : '—'],
      ['REC', recOn ? fmtBytes(recBytes) : 'off'],
    ],
    [preset, prefs, stats, viewers, mime, recOn, recBytes, segMs],
  );

  const railTabs = [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'people', label: 'People', icon: 'users', badge: lobby.length },
    { id: 'activity', label: 'Activity', icon: 'activity' },
    { id: 'health', label: 'Health', icon: 'signal' },
  ];

  if (err) {
    return (
      <div className="studio">
        <div className="studio-top">
          <button className="rail-logo" onClick={() => nav.dashboard()} aria-label="Back to dashboard"><StreamStudioMark size={26} /></button>
          <div className="st-title">Studio</div>
        </div>
        <div style={{ padding: 24 }}>
          <div className="banner err"><Icon name="alert" size={16} />{err}</div>
        </div>
      </div>
    );
  }

  const mobileCtl: MobileCtl = {
    status, viewers, liveFor, chat, floats, mixed, micOn, camOn, scene,
    zoom: { min: zoomMin, max: zoomMax, step: zoomStep, value: zoomVal },
    hasZoom: hasNativeZoom,
    mirror: mirrorSelf,
    lensCount: devices.length,
    toggleMic, toggleCam, flip: () => void flipCamera(), lens: () => void cycleLens(), applyZoom: (v) => void applyZoom(v),
    cutScene: (s) => void cutScene(s), sendChat, sendEmoji,
    goLive, end: () => void endStream(),
    exit: () => (isPhone ? nav.dashboard() : setDevice('desktop')),
    hostName,
  };

  if (isPhone) {
    return (
      <div className="mstudio-fill">
        <MobileStudio ctl={mobileCtl} />
        {guestMonitors}
      </div>
    );
  }

  return (
    <div className="studio">
      <div className="studio-top">
        <button
          className="rail-logo"
          style={{ padding: '4px 6px' }}
          aria-label="Back to dashboard"
          onClick={() => {
            if (isLive && !window.confirm('Leave the studio? Uploads stop while you are away.')) return;
            nav.dashboard();
          }}
        >
          <StreamStudioMark size={26} />
        </button>
        <div className="st-title">{title || 'Untitled stream'}</div>
        <div className="st-meta">
          {status === 'live' && <Pill tone="live" dot pulse>LIVE</Pill>}
          {status === 'paused' && <Pill tone="warn" icon="pause">Be right back</Pill>}
          {status === 'idle' && <Pill tone="neutral">Offline</Pill>}
          {status === 'ended' && <Pill tone="neutral">Ended</Pill>}
          {liveFor && <span className="st-timer">{liveFor}</span>}
        </div>
        <span className="spacer" />
        <Segmented
          label="Studio device"
          options={[{ value: 'desktop', label: 'Desktop', icon: 'screen' }, { value: 'mobile', label: 'Phone', icon: 'user' }]}
          value={device}
          onChange={(v) => setDevice(v as 'desktop' | 'mobile')}
        />
        <div className="t-sep" />
        {sockStatus === 'reconnecting'
          ? <Pill tone="warn" icon="refresh">Reconnecting…</Pill>
          : <Pill tone={healthy ? 'ok' : 'warn'} icon="signal">{healthy ? 'Healthy' : 'Degraded'}</Pill>}
        <Pill tone="neutral" icon="eye">{viewers}/{maxViewers}</Pill>
        <div className="t-sep" />
        <IconBtn
          name="link"
          label="Copy viewer link"
          onClick={() => {
            navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
            push('Viewer link copied', { icon: 'check' });
          }}
        />
        <IconBtn name="users" label="Copy guest invite link" onClick={copyGuestInvite} />
        <IconBtn name="sliders" label="Customize" onClick={() => nav.settings()} />
        {status === 'idle' && <Btn variant="solid" icon="broadcast" onClick={goLive} disabled={!mime}>Go live</Btn>}
        {(isLive || status === 'paused') && <Btn variant="danger" icon="stop" onClick={() => void endStream()}>End stream</Btn>}
        {status === 'ended' && <Btn variant="solid" icon="broadcast" onClick={goLive} disabled={!mime}>Go live again</Btn>}
        {status === 'ended' && <Btn variant="subtle" icon="chart" onClick={() => nav.summary(eventId, hostKey)}>View recap</Btn>}
      </div>

      {device === 'mobile' ? (
        <div className="studio-mobile-bg">
          <div className="mstudio-wrap">
            <div className="phone mstudio-frame">
              <div className="phone-notch" />
              <div className="phone-screen">
                <MobileStudio ctl={mobileCtl} />
              </div>
            </div>
            <p className="muted" style={{ textAlign: 'center', fontSize: 12.5, marginTop: 16, maxWidth: 320 }}>
              Phone broadcasting preview — open your private studio link on a phone to host from it for real.
            </p>
          </div>
        </div>
      ) : (
        <div className="studio-main">
          <div className="studio-stage">
            {/* program preview */}
            <div className="preview-wrap">
              <div className="preview">
                <VideoSink stream={mixed} className="program-video" mirror={mirrorSelf} />
                {status === 'paused' && (
                  <div className="preview-slate">
                    <div className="brb-orb"><span /></div>
                    <div className="slate-title">Be right back</div>
                    <div className="slate-sub">Viewers see this slate — uploads are paused</div>
                  </div>
                )}
                {status === 'ended' && (
                  <div className="preview-slate">
                    <div className="slate-title">Stream ended</div>
                    <div className="slate-sub">Nice one. Your recap is ready.</div>
                  </div>
                )}
                <div className="overlay-tl">
                  {status === 'live' && <span className="ov-pill live"><span className="ov-dot pulse" />LIVE{liveFor ? ` · ${liveFor}` : ''}</span>}
                  {status === 'paused' && <span className="ov-pill">PAUSED</span>}
                  {recOn && <span className="ov-pill rec"><span className="ov-dot" />REC {fmtBytes(recBytes)}</span>}
                </div>
                <div className="overlay-tr">
                  <span className="ov-pill"><Icon name="eye" size={13} />{viewers}</span>
                  <button className={cx('ov-pill btn-like', metricsOn && 'active')} onClick={() => setMetricsOn((v) => !v)} aria-label="Toggle metrics (M)">
                    <Icon name="activity" size={13} />
                  </button>
                </div>
                {metricsOn && (
                  <div className="metrics-ov">
                    <h4>Studio metrics</h4>
                    {metricRows.map(([k, v]) => (
                      <div className="mrow" key={k}><span>{k}</span><span>{v}</span></div>
                    ))}
                  </div>
                )}
                {prefs.floatingReactions && <FloatLayer floats={floats} />}
                <div className="preview-controls">
                  <button className={cx('pv-ctl', !micOn && 'off')} onClick={toggleMic} aria-label="Microphone (Space)" title="Mic (Space)">
                    <Icon name={micOn ? 'mic' : 'micOff'} size={18} />
                  </button>
                  <button className={cx('pv-ctl', !camOn && 'off')} onClick={toggleCam} aria-label="Camera (V)" title="Camera (V)">
                    <Icon name={camOn ? 'video' : 'videoOff'} size={18} />
                  </button>
                  <button
                    className="pv-ctl"
                    style={scene === 'screen' ? { background: 'var(--accent)' } : undefined}
                    onClick={() => void cutScene(scene === 'screen' ? 'solo' : 'screen')}
                    aria-label="Share screen"
                    title="Share screen (2)"
                  >
                    <Icon name="screen" size={18} />
                  </button>
                  <button className="pv-ctl" onClick={() => void cutScene(scene === 'brb' ? 'solo' : 'brb')} aria-label="Be right back (B)" title="Be right back (B)">
                    <Icon name={status === 'paused' ? 'play' : 'pause'} size={18} />
                  </button>
                </div>
              </div>
            </div>

            {/* camera source bar */}
            <div className="cam-bar">
              <span className="cam-status"><span className="cam-dot" />Live camera</span>
              <div className="cam-controls">
                {devices.length > 1 && (
                  <label className="cam-ctl-row">
                    <Icon name="video" size={14} className="faint" />
                    <select
                      className="cam-select"
                      value={activeDevice || ''}
                      aria-label="Camera device"
                      onChange={(e) => void switchCamera(e.target.value)}
                    >
                      {devices.map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || lensLabel(d.label, i)}</option>
                      ))}
                    </select>
                  </label>
                )}
                {hasNativeZoom && (
                  <div className="cam-ctl-row">
                    <Icon name="search" size={14} className="faint" />
                    <input
                      type="range"
                      className="slider cam-zoom"
                      min={zoomMin}
                      max={zoomMax}
                      step={zoomStep}
                      value={zoomVal}
                      aria-label="Camera zoom"
                      onChange={(e) => void applyZoom(Number(e.target.value))}
                      style={{ '--pct': `${((zoomVal - zoomMin) / (zoomMax - zoomMin)) * 100}%` } as React.CSSProperties}
                    />
                    <span className="mono cam-zoom-val">{zoomVal.toFixed(1)}×</span>
                  </div>
                )}
                <button className="cam-flip" onClick={() => void flipCamera()} title="Flip camera"><Icon name="flip" size={15} />Flip</button>
                {MULTI_SCENES.has(scene) && scene !== 'grid' && focusOptions.length > 1 && (
                  <label className="cam-ctl-row">
                    <Icon name="star" size={14} className="faint" />
                    <select
                      className="cam-select"
                      value={focusId ?? ''}
                      aria-label="Featured tile"
                      onChange={(e) => {
                        const id = e.target.value || null;
                        setFocusId(id);
                        lastAutoFocusRef.current = { id: null, at: 0 };
                        compRef.current?.setFocus(id);
                      }}
                    >
                      <option value="">Auto (screen → speaker)</option>
                      {focusOptions.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}{t.kind === 'screen' ? ' · screen' : ''}</option>
                      ))}
                    </select>
                  </label>
                )}
                {scene === 'screen' && (
                  <>
                    <Segmented
                      label="Camera position"
                      options={[
                        { value: 'br', label: '↘' }, { value: 'bl', label: '↙' },
                        { value: 'tr', label: '↗' }, { value: 'tl', label: '↖' },
                        { value: 'side', label: 'Side' },
                      ]}
                      value={pipPos}
                      onChange={(v) => applyPip(v as typeof pipPos, pipSize)}
                    />
                    <Segmented
                      label="Camera size"
                      options={[{ value: 'sm', label: 'S' }, { value: 'md', label: 'M' }, { value: 'lg', label: 'L' }]}
                      value={pipSize}
                      onChange={(v) => applyPip(pipPos, v as typeof pipSize)}
                    />
                  </>
                )}
                <span className="spacer" />
              </div>
            </div>
            {IS_LOCAL_DEV && (
              <div className="localdev-note">
                <Icon name="alert" size={14} />
                You're on localhost — share links only work on this machine. Deploy the app (or tunnel it) so phones and other devices can watch.
              </div>
            )}

            {/* transport */}
            <div className="transport">
              <div className="t-group">
                <button className={cx('tbtn', !micOn && 'off')} onClick={toggleMic} aria-label="Microphone" title="Mic (Space)"><Icon name={micOn ? 'mic' : 'micOff'} size={18} /></button>
                <button className={cx('tbtn', !camOn && 'off')} onClick={toggleCam} aria-label="Camera" title="Camera (V)"><Icon name={camOn ? 'video' : 'videoOff'} size={18} /></button>
                <button className={cx('tbtn', scene === 'screen' && 'on')} onClick={() => void cutScene(scene === 'screen' ? 'solo' : 'screen')} aria-label="Share screen" title="Share screen"><Icon name="screen" size={18} /></button>
              </div>
              <div className="t-sep" />
              <div className="t-group">
                <button className={cx('tbtn', 'rec', recOn && 'on')} onClick={toggleRec} aria-label="Record" title="Record (R)"><Icon name={recOn ? 'stop' : 'record'} size={16} /></button>
                <button className={cx('tbtn', status === 'paused' && 'on')} onClick={() => void cutScene(scene === 'brb' ? 'solo' : 'brb')} aria-label="Be right back" title="Be right back (B)"><Icon name="flag" size={17} /></button>
              </div>
              <div className="t-sep" />
              <div className="t-group">
                <button className="tbtn" onClick={() => setMetricsOn((v) => !v)} aria-label="Metrics" title="Metrics (M)"><Icon name="activity" size={17} /></button>
                <button className="tbtn" onClick={() => nav.settings()} aria-label="Customize" title="Customize"><Icon name="gear" size={17} /></button>
              </div>
              <span className="spacer" />
              <div className="t-status">
                <span className="mono" style={{ fontSize: 11.5 }}>{sceneObj.name}</span>
                <span className="faint">·</span>
                <span className="mono" style={{ fontSize: 11.5, color: stats.upBps ? 'var(--green)' : 'var(--faint)' }}>
                  up {fmtBps(stats.upBps)}
                </span>
              </div>
            </div>

            {/* scenes */}
            <div className="scene-strip">
              <div className="ss-head">
                <h4>Scenes</h4>
                <span className="faint" style={{ fontSize: 11 }}>press 1–3 to cut</span>
                <span className="spacer" />
                <Btn variant="subtle" size="sm" icon="sliders" onClick={() => nav.settings()}>Customize</Btn>
              </div>
              <div className="scene-list">
                {SCENES.map((s, i) => {
                  const active = scene === s.id;
                  return (
                    <button key={s.id} className={cx('scene-card', active && isLive && 'live', active && !isLive && 'live')} onClick={() => void cutScene(s.id)}>
                      <div className="scene-thumb">
                        <SceneSketch kind={s.id} initial={hostName[0] || '·'} />
                      </div>
                      <div className="sc-foot">
                        <span className="sc-name">{i + 1}. {s.name}</span>
                        {active && <span className="sc-live">● {status === 'paused' && s.id === 'brb' ? 'ON AIR' : 'LIVE'}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* right rail */}
          {chatOpen && (
            <aside className="studio-rail" aria-label="Studio panels">
              <div className="rail-tabs">
                <Tabs tabs={railTabs} value={railTab} onChange={(t) => setRailTab(t as RailTab)} />
                <button className="rail-collapse-btn" onClick={() => setChatOpen(false)} aria-label="Collapse panel">
                  <Icon name="chevronRight" size={16} />
                </button>
              </div>
              {railTab === 'chat' && (
                <ChatRail
                  chat={chat}
                  pinned={pinned}
                  canModerate
                  composerRef={composerRef}
                  onSend={sendChat}
                  onReact={sendEmoji}
                  onDelete={delChat}
                  onUnpin={() => socketRef.current?.send({ t: 'pin', text: null })}
                />
              )}
              {railTab === 'people' && (
                <PeopleRail
                  hostName={hostName}
                  people={people}
                  lobby={lobby}
                  guests={guests}
                  onCopyGuestInvite={guestKey ? copyGuestInvite : undefined}
                  onAdmit={(sid) => socketRef.current?.send({ t: 'admit', sid })}
                  onDeny={(sid) => socketRef.current?.send({ t: 'deny', sid })}
                  onKick={(sid) => socketRef.current?.send({ t: 'kick', sid })}
                  onPromote={(sid) => socketRef.current?.send({ t: 'promote', sid })}
                />
              )}
              {railTab === 'activity' && <ActivityRail log={log} />}
              {railTab === 'health' && (
                <HealthRail
                  upBps={stats.upBps}
                  encBps={stats.encBps}
                  targetBps={(prefs.videoBpsOverride || preset.videoBps) + preset.audioBps}
                  minUplinkMbps={preset.minUplinkMbps}
                  failures={stats.failures}
                  lastSeq={stats.lastSeq}
                  behindSec={latencyEst}
                  fps={prefs.fps}
                  viewers={viewers}
                  viewerCurve={viewerCurve}
                  mime={mime}
                />
              )}
            </aside>
          )}
          {!chatOpen && (
            <button className="rail-reopen" onClick={() => setChatOpen(true)} aria-label="Show chat">
              <Icon name="chat" size={18} />
            </button>
          )}
        </div>
      )}
      {guestMonitors}
    </div>
  );
}

/* ===================== phone broadcaster (real pipeline) ================== */

interface MobileCtl {
  status: StreamStatus;
  viewers: number;
  liveFor: string | null;
  chat: ChatMsg[];
  floats: { key: number; e: string; right: number }[];
  mixed: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  scene: SceneId;
  zoom: { min: number; max: number; step: number; value: number };
  hasZoom: boolean;
  mirror: boolean;
  lensCount: number;
  toggleMic(): void;
  toggleCam(): void;
  flip(): void;
  lens(): void;
  applyZoom(v: number): void;
  cutScene(s: SceneId): void;
  sendChat(text: string): void;
  sendEmoji(e: string): void;
  goLive(): void;
  end(): void;
  exit(): void;
  hostName: string;
}

function MobileStudio({ ctl }: { ctl: MobileCtl }) {
  const [showScenes, setShowScenes] = useState(false);
  const [showChat, setShowChat] = useState(false);

  return (
    <div className="ms-video">
      <VideoSink stream={ctl.mixed} className="program-video" mirror={ctl.mirror} />
      {ctl.status === 'paused' && (
        <div className="preview-slate">
          <div className="brb-orb"><span /></div>
          <div className="slate-title">Be right back</div>
        </div>
      )}

      <FloatLayer floats={ctl.floats} style={{ right: 12, bottom: 150 }} />

      {/* top status */}
      <div className="ms-top">
        {ctl.status === 'live' && <span className="ov-pill live"><span className="ov-dot pulse" />LIVE {ctl.liveFor ?? ''}</span>}
        {ctl.status === 'paused' && <span className="ov-pill">PAUSED</span>}
        {ctl.status === 'idle' && <span className="ov-pill">Ready</span>}
        {ctl.status === 'ended' && <span className="ov-pill">Ended</span>}
        <span className="ov-pill"><Icon name="eye" size={12} />{ctl.viewers}</span>
        <span className="spacer" />
        <button className="ms-x" onClick={ctl.exit} aria-label="Exit phone studio"><Icon name="x" size={16} /></button>
      </div>

      {/* right action rail */}
      <div className="ms-rail">
        <button className={cx('ms-round', !ctl.micOn && 'off')} onClick={ctl.toggleMic} aria-label="Microphone">
          <Icon name={ctl.micOn ? 'mic' : 'micOff'} size={20} /><span>Mic</span>
        </button>
        <button className={cx('ms-round', !ctl.camOn && 'off')} onClick={ctl.toggleCam} aria-label="Camera">
          <Icon name={ctl.camOn ? 'video' : 'videoOff'} size={20} /><span>Cam</span>
        </button>
        <button className="ms-round" onClick={ctl.flip} aria-label="Flip camera">
          <Icon name="flip" size={20} /><span>Flip</span>
        </button>
        {ctl.lensCount > 2 && (
          <button className="ms-round" onClick={ctl.lens} aria-label="Switch lens">
            <Icon name="video" size={20} /><span>Lens</span>
          </button>
        )}
        {ctl.hasZoom && (
          <div className="ms-zoom">
            <Icon name="search" size={14} />
            <input
              type="range"
              className="slider"
              min={ctl.zoom.min}
              max={ctl.zoom.max}
              step={ctl.zoom.step}
              value={ctl.zoom.value}
              aria-label="Camera zoom"
              onChange={(e) => ctl.applyZoom(Number(e.target.value))}
              style={{ '--pct': `${((ctl.zoom.value - ctl.zoom.min) / (ctl.zoom.max - ctl.zoom.min)) * 100}%` } as React.CSSProperties}
            />
            <span className="mono">{ctl.zoom.value.toFixed(1)}×</span>
          </div>
        )}
        <button className={cx('ms-round', showScenes && 'active')} onClick={() => setShowScenes((s) => !s)} aria-label="Scenes">
          <Icon name="layers" size={20} /><span>Scene</span>
        </button>
      </div>

      {/* chat peek */}
      <div className="ms-chatpeek" aria-hidden>
        {ctl.chat.slice(-3).map((m) => (
          <div className="ms-peek-msg" key={m.id}>
            <span className="ms-peek-name" style={{ color: m.role === 'host' ? 'var(--accent-2)' : '#d9d4cb' }}>{m.name}</span>
            <span>{m.text}</span>
          </div>
        ))}
      </div>

      {/* scene picker */}
      {showScenes && (
        <div className="ms-scenes" role="radiogroup" aria-label="Scenes">
          {SCENES.map((s) => (
            <button key={s.id} className={cx('ms-scene', ctl.scene === s.id && 'sel')} onClick={() => { ctl.cutScene(s.id); setShowScenes(false); }}>
              <div className="ms-scene-thumb"><SceneSketch kind={s.id} initial={ctl.hostName[0] || '·'} /></div>
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* bottom bar */}
      <div className="ms-bottom">
        <button className="ms-chatbtn" onClick={() => setShowChat(true)} aria-label="Open chat"><Icon name="chat" size={18} /><span>Chat</span></button>
        {ctl.status === 'idle'
          ? <button className="ms-golive" onClick={ctl.goLive}><Icon name="broadcast" size={18} />Go live</button>
          : <button className="ms-end" onClick={ctl.end}><span className="ms-end-dot" />End stream</button>}
        <button className="ms-react" onClick={() => ctl.sendEmoji('❤️')} aria-label="Send heart"><Icon name="heart" size={18} /></button>
      </div>

      {/* chat sheet */}
      {showChat && (
        <div className="ms-chatsheet">
          <button className="ms-sheet-grip" onClick={() => setShowChat(false)} aria-label="Close chat"><span /></button>
          <div className="ms-sheet-head">
            <b>Live chat</b>
            <span className="faint" style={{ fontSize: 11 }}>{ctl.viewers} here</span>
            <span className="spacer" />
            <button className="ms-x" onClick={() => setShowChat(false)} aria-label="Close chat"><Icon name="x" size={15} /></button>
          </div>
          <div className="ms-sheet-list">
            {ctl.chat.map((m) => (
              <div className="vm-msg" key={m.id}>
                <span className="vm-msg-name" style={{ color: m.role === 'host' ? 'var(--accent)' : 'var(--muted)' }}>{m.name}</span>
                <span>{m.text}</span>
              </div>
            ))}
          </div>
          <div className="vm-input-row" style={{ padding: '10px 12px 14px' }}>
            <input
              className="input"
              placeholder="Reply to chat…"
              aria-label="Chat message"
              onKeyDown={(e) => {
                const t = (e.target as HTMLInputElement);
                if (e.key === 'Enter' && t.value.trim()) {
                  ctl.sendChat(t.value.trim());
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
}
