// Host Studio — the hero surface. Real camera → canvas program mixer →
// segmented uploads, with scenes, transport, hotkeys, a four-tab right rail
// (chat / people / activity / health) and a phone broadcaster mode.
//
// One-tap starts land here with an intent (quickStart.ts): an Instant meeting cuts to
// Grid and opens the Invite sheet; Go live now runs a ready check and a 3-second
// countdown. The room connection opens before the camera, so the invite link and
// guests never wait on a camera prompt — and a blocked camera is a fixable card, not
// a dead end.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getEvent, openRoomSocket, sendHostExitBeacon, uploadSegment, type RoomSocket, type SocketStatus } from '../api';
import { SaveSheet, autoSave } from '../components/SaveSheet';
import { checkLimit, fmtRemaining, markAlerted } from '../limits';
import { DiskRecorder, freeSpaceBytes, listUnsavedRecordings, openUnsavedRecording, type FinishedRecording, type UnsavedRecording } from '../recorder';
import { AbrController, SegmentUploader } from '../uploader';
import { keepAwakeAdvice, ScreenWakeLock, type WakeState } from '../wakeLock';
import { IS_LOCAL_DEV, SEGMENT_MS, presetById, type QualityPreset } from '../config';
import { addMyEvent, findMyEvent, updateMyEvent } from '../events';
import { pushEventToCloud } from '../sync';
import { ProgramAudioMixer, takePrimedAudioContext } from '../studio/audioMixer';
import { HostPeers, sanitizeIceServers, type GuestLink } from '../studio/rtc';
import { IceClock } from '../rtcIce';
import { CameraIssue, InviteSheet, ReadyCheck, type ReadyPhase } from '../studio/meetingUi';
import { shareOrCopy, takeStudioIntent } from '../quickStart';
import {
  SegmentedRecorder,
  cameraErrorMessage,
  lensLabel,
  listVideoInputs,
  openCamera,
  openCameraVideo,
  pickSupportedMime,
  recordingFilename,
  setZoom,
  takePrimedCamera,
  zoomCapability,
  type ZoomRange,
} from '../media';
import { Ema, fmtBps, fmtBytes, fmtDuration } from '../metrics';
import type { Nav } from '../nav';
import { guestUrl, viewerUrl } from '../nav';
import { loadPrefs, playChime, savePrefs } from '../prefs';
import { accountSettled, getAccount, useAccount } from '../account';
import { MAX_GUESTS, type ChatMsg, type EventKind, type LobbyEntry, type LogEntry, type PersonEntry, type StreamStatus } from '../protocol';
import { MULTI_SCENES, ProgramCompositor, SCENES, fitCanvasToSource, type ProgramTile, type SceneId } from '../studio/compositor';
import { ActivityRail, ChatRail, HealthRail, PeopleRail } from '../components/rails';
import { normalizeQuick } from '../emoji';
import { SceneSketch } from '../components/scenes';
import { HelpButton } from '../components/Guide';
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
  const account = useAccount();
  // The on-stream name (Settings → Scenes) when set, else the account name — so a rename shows up here.
  const hostName = prefs.hostName.trim() || account.name?.trim() || 'Host';
  // The setup effect below runs once; it reads the latest name (the account may finish loading after mount).
  const hostNameRef = useRef(hostName);
  hostNameRef.current = hostName;

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
  const localRecRef = useRef<DiskRecorder | null>(null);
  const uploaderRef = useRef<SegmentUploader | null>(null);
  const abrRef = useRef<AbrController | null>(null);
  const wakeRef = useRef(new ScreenWakeLock());
  const streamAlertsRef = useRef(new Set<number>());
  const recAlertsRef = useRef(new Set<number>());
  const afterSaveRef = useRef<(() => void) | null>(null);
  const hiddenAtRef = useRef<number | null>(null);
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
  const [wake, setWake] = useState<WakeState>('none');
  useEffect(() => {
    wakeRef.current.onChange = setWake;
  }, []);
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
  const [stats, setStats] = useState({ lastSeq: 0, failures: 0, dropped: 0, backlog: 0, abrBps: null as number | null, upBps: null as number | null, encBps: null as number | null });
  const [pendingSave, setPendingSave] = useState<FinishedRecording | null>(null);
  const [unsaved, setUnsaved] = useState<UnsavedRecording[]>([]);
  const [limitBanner, setLimitBanner] = useState<{ kind: 'stream' | 'rec'; text: string } | null>(null);
  const [streamExtraMin, setStreamExtraMin] = useState(0);
  const [recElapsed, setRecElapsed] = useState(0);
  const [viewerCurve, setViewerCurve] = useState<number[]>([]);
  const [segMs, setSegMs] = useState(SEGMENT_MS);
  const [maxViewers, setMaxViewers] = useState(100);
  const [pipPos, setPipPos] = useState(prefs.pipPos);
  const [pipSize, setPipSize] = useState(prefs.pipSize);
  const [guests, setGuests] = useState<GuestLink[]>([]);
  const [guestKey, setGuestKey] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // One-tap hand-off from Create / the Dashboard — read once, never from the URL, so a
  // copied or reloaded studio link never opens sheets or counts down by itself.
  const [intent] = useState(() => takeStudioIntent(eventId));
  const [kind, setKind] = useState<EventKind>(() => findMyEvent(eventId)?.kind ?? (intent === 'meeting' ? 'meeting' : 'broadcast'));
  const [mediaReady, setMediaReady] = useState(false);
  const [camStarting, setCamStarting] = useState(true);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [camLabel, setCamLabel] = useState('');
  const [roomReady, setRoomReady] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [ready, setReady] = useState<{ phase: ReadyPhase; count: number } | null>(intent === 'live' ? { phase: 'checking', count: 3 } : null);
  const [shareLive, setShareLive] = useState(false);
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
  const isMeeting = kind === 'meeting';
  const meetingIdle = isMeeting && status === 'idle';
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const aliveRef = useRef(true);
  const peopleRef = useRef<PersonEntry[]>([]);
  // ICE list from the room (STUN + TURN when configured); "settled" once it answered or timed out.
  const iceRef = useRef<RTCIceServer[] | null>(null);
  const iceSettledRef = useRef(false);
  const iceTimerRef = useRef<number | null>(null);
  // Relay credentials last a few hours: ask the room for fresh ones when it says (`iceMs`).
  const iceClockRef = useRef(new IceClock(() => socketRef.current?.send({ t: 'ice' })));
  /** Guests we've asked to (re)connect since the last hello — each once. */
  const pingedRef = useRef(new Set<string>());
  const inviteAutoRef = useRef(intent === 'meeting');
  // Socket handlers live for the whole session; these refs give them the current closures.
  const onGuestJoinedRef = useRef<(name: string) => void>(() => undefined);
  const goLiveRef = useRef<() => void>(() => undefined);

  // ------------------------------------------------------------- lifecycle
  /**
   * Ask every guest already in the room to (re)connect: after the camera came up late,
   * the studio reloaded, or a guest's first `ready` landed before we could answer it.
   * Waits for the room's ICE list so the new links start with TURN when there is one.
   */
  const kickGuests = () => {
    const peers = hostPeersRef.current;
    if (!peers || !iceSettledRef.current) return;
    for (const p of peopleRef.current) {
      if (p.role !== 'guest' || peers.has(p.sid) || pingedRef.current.has(p.sid)) continue;
      pingedRef.current.add(p.sid);
      socketRef.current?.send({ t: 'rtc', to: p.sid, d: { ready: true } });
    }
  };

  const settleIce = () => {
    if (iceTimerRef.current != null) window.clearTimeout(iceTimerRef.current);
    iceTimerRef.current = null;
    iceSettledRef.current = true;
    kickGuests();
  };

  /** Camera → program compositor + audio mixer → guest links. Re-runnable ("Try again"). */
  const startMedia = async (p: QualityPreset, primed?: Promise<MediaStream> | null) => {
    if (compRef.current || !aliveRef.current) return;
    setCamErr(null);
    setCamStarting(true);
    let cam: MediaStream;
    try {
      cam = await (primed ?? openCamera(p));
    } catch (e) {
      if (!aliveRef.current) return;
      setCamErr(cameraErrorMessage(e));
      setCamStarting(false);
      return;
    }
    if (!aliveRef.current || compRef.current) {
      cam.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      camRef.current = cam;
      audioTrackRef.current = cam.getAudioTracks()[0] ?? null;
      setCamLabel(cam.getVideoTracks()[0]?.label ?? '');
      // The program follows the camera's real orientation/aspect — a phone
      // held upright streams portrait instead of a hard center-crop.
      const cs = cam.getVideoTracks()[0]?.getSettings() ?? {};
      const dims = fitCanvasToSource(cs.width || p.width, cs.height || p.height, p.width, p.height);
      const comp = new ProgramCompositor(dims.w, dims.h, prefs.fps);
      comp.setHostInitial(hostNameRef.current);
      comp.setLook(prefs.look);
      comp.setPipLayout(prefs.pipPos, prefs.pipSize);
      comp.setCamera(cam);
      comp.onScreenEnded = () => {
        comp.setScene('solo');
        setScene((s) => (s === 'screen' ? 'solo' : s));
        push('Screen share ended', { icon: 'screen' });
      };
      // A meeting opens on Grid: you, plus a seat that says who's still to come.
      if (kindRef.current === 'meeting' && statusRef.current === 'idle') {
        comp.setScene('grid');
        setScene('grid');
        comp.setPlaceholder('Waiting for people — share the invite');
      }
      comp.start();
      compRef.current = comp;

      // Program audio = ONE stable mixed track (host mic + guests), so the
      // encoder never restarts when someone joins. Falls back to the raw
      // mic track if WebAudio is unavailable. A context primed by the tap
      // that started the session is already running (iOS needs that tap).
      let programAudio: MediaStreamTrack | null = audioTrackRef.current;
      try {
        const mixer = new ProgramAudioMixer(takePrimedAudioContext());
        mixer.addSource('host', cam);
        mixerRef.current = mixer;
        programAudio = mixer.track;
      } catch {
        mixerRef.current = null;
      }
      const output = comp.buildOutput(programAudio);
      const programVideo = output.getVideoTracks()[0] ?? null;
      setMixed(output);
      setZoomCap(zoomCapability(cam.getVideoTracks()[0]));
      setDevices(await listVideoInputs());
      if (!aliveRef.current) return; // left while the device list loaded — cleanup already ran

      // On-air guests: host-centric WebRTC mesh, signaled through the room.
      const peers = new HostPeers((sid, d) => socketRef.current?.send({ t: 'rtc', to: sid, d }), iceRef.current);
      peers.setReturnFeed({
        // Guests see the program itself — the host and every other guest, live…
        video: () => programVideo ?? camRef.current?.getVideoTracks()[0] ?? null,
        // …and hear everyone but themselves (mix-minus); the raw mic without WebAudio.
        audioFor: (sid) => mixerRef.current?.minusTrack(sid) ?? audioTrackRef.current,
        release: (sid) => mixerRef.current?.dropMinus(sid),
      });
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
          // Unwire every guest source without a live link — including guests re-linked after
          // a studio reload, whose names never went through guestNamesRef.
          const liveSids = new Set(list.map((g) => g.sid));
          for (const id of mixer.ids()) {
            if (id !== 'host' && !liveSids.has(id)) mixer.removeSource(id);
          }
        }
        comp.setRemoteTiles(tiles);
      };
      peers.onChange = syncGuests;
      hostPeersRef.current = peers;
      setMediaReady(true);
      setCamStarting(false);
      kickGuests();
    } catch (e) {
      // Past the camera, a failure here is the browser (canvas/WebAudio), not permission.
      setCamErr(e instanceof Error ? `The studio couldn’t start on this browser (${e.message}).` : 'The studio couldn’t start on this browser.');
      setCamStarting(false);
    }
  };

  const retryCamera = () => void startMedia(preset);

  /** The room: chat, people, the guest key and signaling. Opens before the camera. */
  const openSocket = () => {
    socketRef.current = openRoomSocket(
      eventId,
      { name: hostNameRef.current, k: hostKey },
      (msg) => {
        switch (msg.t) {
          case 'hello':
            setChat(msg.chat);
            setViewers(msg.meta.viewers);
            setPinned(msg.meta.pinned);
            setStartedAt(msg.meta.startedAt);
            if (msg.log) setLog(msg.log);
            setRoomReady(true);
            if (msg.you.role === 'host') {
              // Mint (or fetch) the guest invite key, and the ICE list for guest links.
              socketRef.current?.send({ t: 'guestkey' });
              pingedRef.current.clear();
              socketRef.current?.send({ t: 'ice' });
              if (iceTimerRef.current != null) window.clearTimeout(iceTimerRef.current);
              iceTimerRef.current = window.setTimeout(settleIce, 2000); // older rooms never answer
            }
            break;
          case 'ice': {
            const list = sanitizeIceServers(msg.servers);
            if (list) {
              iceRef.current = list;
              hostPeersRef.current?.setIceServers(list);
            }
            iceClockRef.current.arm(msg.iceMs);
            settleIce();
            break;
          }
          case 'guestkey':
            setGuestKey(msg.key);
            if (inviteAutoRef.current) {
              inviteAutoRef.current = false;
              setInviteOpen(true);
            }
            break;
          case 'guest':
            guestNamesRef.current.set(msg.sid, msg.name);
            if (!msg.on) {
              hostPeersRef.current?.close(msg.sid);
              push(kindRef.current === 'meeting' ? `${msg.name} left the meeting` : `${msg.name} left the guest seats`, { icon: 'users' });
            } else {
              onGuestJoinedRef.current(msg.name);
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
            peopleRef.current = msg.list;
            setPeople(msg.list);
            // Guests already in the room when the studio (re)loaded never sent a join event:
            // learn their names here so their tiles aren't labelled "Guest".
            for (const p of msg.list) if (p.role === 'guest' && p.name) guestNamesRef.current.set(p.sid, p.name);
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
  };

  useEffect(() => {
    let cancelled = false;
    aliveRef.current = true;
    (async () => {
      const m = pickSupportedMime(undefined, prefs.preferMp4);
      if (!m) {
        setErr('This browser cannot record video (MediaRecorder unsupported). Try Chrome, Edge, Firefox or Safari 16+.');
        return;
      }
      setMime(m);
      let p: QualityPreset;
      try {
        const meta = await getEvent(eventId);
        if (cancelled) return;
        // Adopt-on-open: holding a valid studio link (id + hostKey) IS owning
        // the event. Registering it here makes sessions hosted from a second
        // device land in the local registry AND the account — before this,
        // they never reached the Dashboard or the cloud at all.
        if (!findMyEvent(eventId)) {
          const adopted = {
            id: eventId,
            hostKey,
            title: meta.title,
            createdAt: meta.createdAt || Date.now(),
            scheduledAt: meta.scheduledAt ?? null,
            status: meta.status,
            quality: meta.quality,
            access: meta.access,
            cover: meta.cover,
            kind: meta.kind,
          };
          addMyEvent(adopted);
          void pushEventToCloud(adopted);
        }
        if (meta.kind) {
          kindRef.current = meta.kind;
          setKind(meta.kind);
        }
        setTitle(meta.title);
        setPinned(meta.pinned);
        setSegMs(meta.segMs || SEGMENT_MS);
        setMaxViewers(meta.maxViewers || 100);
        p = presetById(meta.quality);
        setPreset(p);
        nextSeqRef.current = (meta.latestSeq || 0) + 1; // survive a studio reload mid-event
        statusRef.current = meta.status;
        setStatus(meta.status);
        setStartedAt(meta.startedAt);
        if (meta.status !== 'idle') setReady(null); // a reload mid-stream never counts down again
      } catch {
        if (!cancelled) setErr('Couldn’t load this event — check the studio link, or whether the streaming backend is reachable.');
        return;
      }
      // Room first: the invite link and guests don't wait for the camera prompt. The room
      // learns the host's name at connect, so give the account a moment to load (a reload
      // would otherwise announce "Host").
      await accountSettled();
      if (cancelled) return;
      hostNameRef.current = prefs.hostName.trim() || getAccount().name?.trim() || hostNameRef.current;
      openSocket();
      await startMedia(p, takePrimedCamera());
    })();

    const clock = window.setInterval(() => {
      setClock((c) => c + 1);
      if (localRecRef.current) {
        setRecBytes(localRecRef.current.bytes);
        setRecElapsed(localRecRef.current.elapsedMs);
      }
    }, 1000);
    // Recordings that reached disk but were never saved (crash / closed tab).
    void listUnsavedRecordings().then((list) => !cancelled && setUnsaved(list.filter((r) => r.eventId === eventId)));
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
      aliveRef.current = false;
      if (iceTimerRef.current != null) window.clearTimeout(iceTimerRef.current);
      iceClockRef.current.stop();
      window.clearInterval(clock);
      window.clearInterval(speakTimer);
      window.clearInterval(curveTimer);
      window.clearInterval(healthTimer);
      segRecRef.current?.stop();
      uploaderRef.current?.close();
      // Leaving mid-recording: the disk copy survives and shows up as
      // "unsaved" for recovery instead of being silently lost.
      void localRecRef.current?.stop();
      void wakeRef.current.disable();
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

  // The account name can land after the program started: keep the host tile's label current.
  useEffect(() => {
    compRef.current?.setHostInitial(hostName);
  }, [hostName]);

  // The empty-seat hint belongs to a private meeting only — never to a broadcast.
  useEffect(() => {
    compRef.current?.setPlaceholder(meetingIdle ? 'Waiting for people — share the invite' : null);
  }, [meetingIdle, mediaReady]);

  // "Go live now": once camera, mic and room check out, count 3-2-1 and go — unless the
  // browser still gates audio behind a tap, in which case stop at "Tap to go live".
  useEffect(() => {
    if (!ready) return;
    if (status !== 'idle') {
      setReady(null);
      return;
    }
    const audioRunning = () => (mixerRef.current ? mixerRef.current.running : true);
    if (ready.phase === 'checking') {
      if (mediaReady && roomReady && mime && !camErr) setReady({ phase: audioRunning() ? 'counting' : 'tap', count: 3 });
      return;
    }
    if (ready.phase !== 'counting') return;
    const t = window.setTimeout(() => {
      if (ready.count > 1) setReady({ phase: 'counting', count: ready.count - 1 });
      else if (!audioRunning()) setReady({ phase: 'tap', count: 0 });
      else {
        setReady(null);
        goLiveRef.current();
      }
    }, 1000);
    return () => window.clearTimeout(t);
  }, [ready, mediaReady, roomReady, mime, camErr, status]);

  // The "share the watch link" nudge steps aside once someone is watching.
  useEffect(() => {
    if (viewers > 0) setShareLive(false);
  }, [viewers]);

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
      if (statusRef.current === 'live' || localRecRef.current || pendingSaveRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onPageHide = (e: PageTransitionEvent) => {
      // LIVE only: ending a PAUSED (BRB) room here would turn an accidental
      // refresh into "stream over" — paused rooms keep the worker's 2-minute
      // host-gone grace instead, which exists for exactly that.
      if (!e.persisted && statusRef.current === 'live') {
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
    const targetBps = prefs.videoBpsOverride > 0 ? prefs.videoBpsOverride : preset.videoBps;
    // Adaptive bitrate survives pause/resume within a session (the uplink
    // didn't change just because we cut to BRB).
    const abr = abrRef.current ?? new AbrController(targetBps);
    abrRef.current = abr;
    uploaderRef.current?.close();
    const uploader = new SegmentUploader(
      (seq, durMs, blob) => uploadSegment(eventId, hostKey, seq, durMs, blob),
      {
        onUploaded: (seq, durMs, { elapsedMs, bytes }) => {
          upElapsedEma.current.push(elapsedMs);
          const next = abr.observe(elapsedMs, durMs, uploader.pending);
          segRecRef.current?.setVideoBps(next);
          setStats((s) => ({
            ...s,
            lastSeq: Math.max(s.lastSeq, seq),
            abrBps: next,
            encBps: encEma.current.push((bytes * 8) / (durMs / 1000)),
            upBps: upEma.current.push((bytes * 8) / (elapsedMs / 1000)),
          }));
        },
        onFailed: () => {
          segRecRef.current?.setVideoBps(abr.failed());
          setStats((s) => ({ ...s, failures: s.failures + 1, abrBps: abr.current }));
        },
        onDropped: () => {
          segRecRef.current?.setVideoBps(abr.failed());
          setStats((s) => ({ ...s, dropped: s.dropped + 1, abrBps: abr.current }));
        },
        onBacklog: (n) => setStats((s) => (s.backlog === n ? s : { ...s, backlog: n })),
      },
    );
    uploaderRef.current = uploader;
    const rec = new SegmentedRecorder(
      mixed,
      { mimeType: mime, videoBps: abr.current, audioBps: preset.audioBps, segMs, startSeq: nextSeqRef.current },
      (blob, seq, durMs) => {
        nextSeqRef.current = seq + 1;
        uploader.enqueue(seq, durMs, blob);
      },
    );
    rec.start();
    segRecRef.current = rec;
  };

  const goLive = () => {
    if (!mixed) return; // no camera yet — the button says why
    mixerRef.current?.unlock(); // browsers may gesture-gate AudioContexts
    socketRef.current?.send({ t: 'state', status: 'live' });
    if (prefs.slowSec > 0) socketRef.current?.send({ t: 'config', slow: prefs.slowSec });
    // Your quick reactions become the viewers' one-tap bar.
    socketRef.current?.send({ t: 'config', quick: normalizeQuick(prefs.quickReactions) });
    // Restarting an ended event is a NEW session — fresh clock, no stale end.
    const freshStart = statusRef.current === 'ended' ? Date.now() : startedAt ?? Date.now();
    setStartedAt(freshStart);
    setStatus('live');
    startSegments();
    streamAlertsRef.current.clear();
    setStreamExtraMin(0);
    // Phones stop the camera when the screen sleeps — keep it awake on air.
    void wakeRef.current.enable();
    updateMyEvent(eventId, { status: 'live', startedAt: freshStart, endedAt: null });
    const mine = findMyEvent(eventId);
    if (mine) void pushEventToCloud(mine);
    // The event's own auto-record choice (set on Create) wins over the global default.
    if ((mine?.autoRecord ?? prefs.autoRecord) && !localRecRef.current) void startRecording();
    setReady(null);
    setShareLive(true);
    setInviteOpen(false);
    push(kindRef.current === 'meeting' ? 'You are live — this meeting is now broadcasting' : 'You are live', { icon: 'broadcast' });
  };
  goLiveRef.current = goLive;

  /** A meeting that never went live just ends — no recap to show, back to the dashboard. */
  const endMeeting = async () => {
    if (!window.confirm('End the meeting for everyone?')) return;
    socketRef.current?.send({ t: 'state', status: 'ended' });
    setStatus('ended');
    setInviteOpen(false);
    updateMyEvent(eventId, { status: 'ended', endedAt: Date.now() });
    const mine = findMyEvent(eventId);
    if (mine) void pushEventToCloud(mine);
    push('Meeting ended', { icon: 'stop', duration: 3000 });
    if (localRecRef.current) {
      afterSaveRef.current = () => nav.dashboard();
      await stopRecording();
    } else {
      nav.dashboard();
    }
  };

  const pause = () => {
    socketRef.current?.send({ t: 'state', status: 'paused' });
    setStatus('paused');
    segRecRef.current?.stop(); // final partial segment still flushes (the uploader keeps running)
    segRecRef.current = null;
  };

  const resume = () => {
    socketRef.current?.send({ t: 'state', status: 'live' });
    setStatus('live');
    startSegments();
  };

  const endStream = async (opts: { auto?: boolean } = {}) => {
    if (!opts.auto && !window.confirm('End the stream for everyone?')) return;
    socketRef.current?.send({ t: 'state', status: 'ended' });
    setStatus('ended');
    segRecRef.current?.stop();
    segRecRef.current = null;
    void wakeRef.current.disable();
    setLimitBanner(null);
    updateMyEvent(eventId, { status: 'ended', peakViewers: Math.max(...viewerCurve, viewers), endedAt: Date.now() });
    const mine = findMyEvent(eventId);
    if (mine) void pushEventToCloud(mine);
    push(opts.auto ? 'Stream ended — your time limit was reached' : 'Stream ended', { icon: 'stop', duration: 3600 });
    // With a recording to save, the recap waits until the save sheet closes.
    if (localRecRef.current) {
      afterSaveRef.current = () => nav.summary(eventId, hostKey);
      await stopRecording();
    } else {
      nav.summary(eventId, hostKey);
    }
  };

  // ------------------------------------------------------------- recording
  const startingRecRef = useRef(false);
  const startRecording = async () => {
    if (!mixed || !mime || localRecRef.current || startingRecRef.current) return;
    startingRecRef.current = true;
    try {
      const streamBps = prefs.videoBpsOverride > 0 ? prefs.videoBpsOverride : preset.videoBps;
      // Phones get a 1× master: a second high-bitrate encoder is what makes
      // phone streams stutter. Desktops keep the sharper 2.5× master.
      const factor = prefs.recordHighBitrate && !isPhone ? 2.5 : 1;
      const free = await freeSpaceBytes();
      const needPerHour = ((streamBps * factor + 192_000) / 8) * 3600;
      if (free != null && free < needPerHour / 2) {
        push(`Low storage: about ${Math.max(1, Math.round((free / needPerHour) * 60))} min of recording space left on this device`, { icon: 'alert', duration: 5000 });
      }
      const file = recordingFilename(eventId, recPartRef.current, mime);
      localRecRef.current = await DiskRecorder.start(mixed.clone(), mime, Math.round(streamBps * factor), file, {
        eventId,
        title: title || 'Untitled stream',
      });
      recStartRef.current = Date.now();
      recAlertsRef.current.clear();
      setRecElapsed(0);
      setRecOn(true);
      hostLog('rec', 'REC', `Local recording started · part ${recPartRef.current}${localRecRef.current.onDisk ? ' · writing to disk' : ''}`);
      if (prefs.recLimitMin > 0) push(`Recording · auto-stops after ${prefs.recLimitMin} min (you'll get a heads-up first)`, { icon: 'clock', duration: 3200 });
    } catch {
      push('Could not start recording on this browser', { icon: 'alert' });
    } finally {
      startingRecRef.current = false;
    }
  };

  const stopRecording = async () => {
    const rec = localRecRef.current;
    localRecRef.current = null;
    setRecOn(false);
    setLimitBanner((b) => (b?.kind === 'rec' ? null : b));
    if (!rec) return;
    const done = await rec.stop();
    recPartRef.current += 1;
    setRecBytes(0);
    setRecElapsed(0);
    if (done.bytes === 0) {
      afterSaveRef.current?.();
      afterSaveRef.current = null;
      return;
    }
    hostLog('rec', 'REC', `Recording finished · ${fmtBytes(done.bytes)} — waiting for a save location`);
    // A remembered destination saves silently; otherwise ask where it goes.
    const where = prefs.saveTarget !== 'ask' && prefs.saveTarget !== 'picker' ? await autoSave(done, prefs.saveTarget) : null;
    if (where) {
      push(`Recording saved · ${where}`, { icon: 'check', duration: 3600 });
      hostLog('rec', 'REC', `Recording saved · ${where}`);
      afterSaveRef.current?.();
      afterSaveRef.current = null;
    } else {
      setPendingSave(done);
    }
  };

  const closeSaveSheet = () => {
    setPendingSave(null);
    void listUnsavedRecordings().then((list) => setUnsaved(list.filter((r) => r.eventId === eventId)));
    afterSaveRef.current?.();
    afterSaveRef.current = null;
  };

  const recoverUnsaved = async (r: UnsavedRecording) => {
    try {
      setPendingSave(await openUnsavedRecording(r));
    } catch {
      push('That recording is no longer on this device', { icon: 'alert' });
      setUnsaved((u) => u.filter((x) => x.name !== r.name));
    }
  };

  const toggleRec = () => (recOn ? void stopRecording() : void startRecording());
  const pendingSaveRef = useRef(pendingSave);
  pendingSaveRef.current = pendingSave;

  // ------------------------------------------------- time limits + alerts
  // Stream and recording limits from Customize: heads-up at 5 min, 1 min and
  // 10 s (toast + chime + banner with a one-tap extend), then the stream ends
  // or the recording stops and asks where to save.
  const liveSec = startedAt && status === 'live' ? (Date.now() - startedAt) / 1000 : 0;
  useEffect(() => {
    if (status === 'live' && prefs.streamLimitMin > 0) {
      const res = checkLimit(liveSec, prefs.streamLimitMin + streamExtraMin, streamAlertsRef.current);
      if (res.reached) {
        void endStream({ auto: true });
      } else if (res.alertAt != null && res.remainingSec != null) {
        markAlerted(streamAlertsRef.current, res.alertAt);
        const text = `Your stream ends in ${fmtRemaining(res.remainingSec)} (time limit)`;
        setLimitBanner({ kind: 'stream', text });
        push(text, { icon: 'clock', duration: 5000 });
        playChime();
        hostLog('warn', 'LIMIT', text);
      }
    }
    if (localRecRef.current && prefs.recLimitMin > 0) {
      const res = checkLimit(recElapsed / 1000, prefs.recLimitMin, recAlertsRef.current);
      if (res.reached) {
        push('Recording limit reached — stopping and saving', { icon: 'record', duration: 4000 });
        playChime();
        void stopRecording();
      } else if (res.alertAt != null && res.remainingSec != null) {
        markAlerted(recAlertsRef.current, res.alertAt);
        const text = `Recording stops in ${fmtRemaining(res.remainingSec)} (length limit)`;
        setLimitBanner((b) => (b?.kind === 'stream' ? b : { kind: 'rec', text }));
        push(text, { icon: 'record', duration: 5000 });
        playChime();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(liveSec), recElapsed, status]);

  // Phones pause the camera when the browser goes to the background. Say so
  // plainly when the host comes back, instead of letting viewers guess.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
      } else if (hiddenAtRef.current) {
        const away = (Date.now() - hiddenAtRef.current) / 1000;
        hiddenAtRef.current = null;
        if (statusRef.current === 'live' && away > 3 && isPhone) {
          push(`You were away ${Math.round(away)}s — phones pause the camera in the background, so viewers saw a freeze. Keep Stream Studio open while live.`, { icon: 'alert', duration: 6000 });
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [isPhone, push]);

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

  // Someone took a guest seat: off air, cut to Grid for them; on air, the host decides.
  onGuestJoinedRef.current = (name: string) => {
    if (prefs.alertSound === 'soft') playChime();
    const meeting = kindRef.current === 'meeting';
    const offAir = statusRef.current === 'idle' || statusRef.current === 'ended';
    if (offAir && sceneRef.current === 'solo' && compRef.current) {
      void cutScene('grid');
      push(meeting ? `${name} joined the meeting` : `${name} joined as a guest — switched to Grid`, { icon: 'users' });
    } else {
      push(meeting ? `${name} joined the meeting` : `${name} joined as a guest — try Grid (3) or Spotlight (4)`, { icon: 'users' });
    }
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
    // Guests' return feed is the program canvas, so it follows the swap by itself.
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
        else if (meetingIdle) push('Use “Go live with this meeting” to broadcast — G won’t do it by accident', { icon: 'info' });
        else if (status === 'idle') goLive();
      } else if (k === 'i') {
        setInviteOpen(true);
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
  const healthy = stats.failures === 0 && stats.dropped === 0 && sockStatus === 'connected';
  const strained = recOn && status === 'live' && (stats.backlog > 2 || !!abrRef.current?.degraded);
  // Self-view mirroring: explicit preference wins; auto = front cam in Solo
  // (matching camera apps). The outgoing program is NEVER mirrored.
  const mirrorSelf =
    prefs.mirrorPreview === 'on' ? true
    : prefs.mirrorPreview === 'off' ? false
    : facing === 'user' && scene === 'solo';
  // Hidden monitors so the host hears guests (the program preview is muted).
  const guestMonitors = guests.filter((g) => g.cam).map((g) => <AudioSink key={g.sid} stream={g.cam!} />);
  const focusOptions = MULTI_SCENES.has(scene) ? (compRef.current?.allTiles() ?? []) : [];
  const micLevel = useCallback(() => mixerRef.current?.levels().get('host') ?? 0, []);
  const inviteUrl = guestKey ? guestUrl(eventId, guestKey, { meeting: isMeeting }) : null;
  const shareInvite = async () => {
    if (!inviteUrl) return;
    const name = title || (isMeeting ? 'my meeting' : 'my stream');
    const r = await shareOrCopy({
      title: title || 'Stream Studio',
      text: isMeeting ? `Join “${name}” — on camera, no account needed.` : `Join “${name}” on camera as my guest — no account needed.`,
      url: inviteUrl,
    });
    if (r === 'copied') push(`Invite link copied — up to ${MAX_GUESTS} people can join on camera`, { icon: 'check' });
    else if (r === 'failed') push('Couldn’t copy on this browser — use Share or copy it from the box', { icon: 'alert' });
  };
  const copyGuestInvite = async () => {
    if (!inviteUrl) return;
    const r = await shareOrCopy({ url: inviteUrl }, { copyOnly: true });
    push(r === 'copied' ? `Invite link copied — up to ${MAX_GUESTS} people can join on camera` : 'Couldn’t copy on this browser', { icon: r === 'copied' ? 'users' : 'alert' });
  };
  const rotateInvite = () => {
    socketRef.current?.send({ t: 'guestkey', rotate: true });
    push('New invite link — previously shared links no longer work', { icon: 'refresh' });
  };
  const shareWatch = async () => {
    const r = await shareOrCopy({
      title: title || 'Stream Studio',
      text: `Watch “${title || 'my stream'}” live — just enter a name to join.`,
      url: shareUrl,
    });
    if (r === 'copied') push('Watch link copied', { icon: 'check' });
    else if (r === 'failed') push('Couldn’t copy on this browser', { icon: 'alert' });
  };
  const openInvite = () => setInviteOpen(true);
  const inviteSheet = inviteOpen ? (
    <InviteSheet
      url={inviteUrl}
      meeting={isMeeting}
      guests={guests}
      maxGuests={MAX_GUESTS}
      onClose={() => setInviteOpen(false)}
      onShare={() => void shareInvite()}
      onCopy={() => void copyGuestInvite()}
      onRotate={rotateInvite}
    />
  ) : null;
  const cameraIssue = (
    <CameraIssue message={camErr} starting={camStarting && !camErr} onRetry={retryCamera} onInvite={guestKey ? openInvite : undefined} />
  );
  const readyCard = ready ? (
    <ReadyCheck
      camera={mediaReady ? 'ok' : camErr ? 'error' : 'waiting'}
      cameraLabel={camLabel}
      micOk={!!audioTrackRef.current}
      roomOk={roomReady}
      quality={`${preset.id} · needs ≥ ${preset.minUplinkMbps} Mbps upload`}
      phase={ready.phase}
      count={ready.count}
      getMicLevel={micLevel}
      onCancel={() => setReady(null)}
      onGo={goLive}
    />
  ) : null;

  const metricRows: [string, string][] = useMemo(
    () => [
      ['Program', `${preset.width}×${preset.height} @ ${prefs.fps}fps`],
      ['Target bitrate', fmtBps((prefs.videoBpsOverride || preset.videoBps) + preset.audioBps)],
      ['Encoded (actual)', fmtBps(stats.encBps)],
      ['Upload speed', fmtBps(stats.upBps)],
      ['Auto quality', stats.abrBps ? `${fmtBps(stats.abrBps)}${abrRef.current?.degraded ? ' (eased for your uplink)' : ''}` : '—'],
      ['Segment', stats.lastSeq ? `#${stats.lastSeq} · ${segMs / 1000}s` : '—'],
      ['Upload queue', String(stats.backlog)],
      ['Upload failures', `${stats.failures}${stats.dropped ? ` · ${stats.dropped} skipped to stay live` : ''}`],
      ['Viewers', String(viewers)],
      ['Codec', mime ? mime.split(';')[0].replace('video/', '') : '—'],
      ['REC', recOn ? `${fmtBytes(recBytes)} · ${fmtDuration(recElapsed / 1000)}${localRecRef.current?.onDisk ? ' · on disk' : ''}` : 'off'],
    ],
    [preset, prefs, stats, viewers, mime, recOn, recBytes, recElapsed, segMs],
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

  const extendStream = () => {
    setStreamExtraMin((m) => m + 15);
    streamAlertsRef.current.clear();
    setLimitBanner(null);
    push('Added 15 minutes to your stream', { icon: 'clock' });
  };

  const studioBanners = (
    <>
      {shareLive && status === 'live' && (
        <div className="banner info studio-banner share-live" role="status">
          <Icon name="broadcast" size={15} />
          <span style={{ flex: 1 }}><b>You’re live.</b><span className="sl-more"> Share the watch link — viewers join with just a name.</span></span>
          <Btn variant="solid" size="sm" icon="share" onClick={() => void shareWatch()}>Share watch link</Btn>
          <button className="iconbtn" aria-label="Dismiss" onClick={() => setShareLive(false)}><Icon name="x" size={14} /></button>
        </div>
      )}
      {limitBanner && (
        <div className="banner warn studio-banner" role="alert">
          <Icon name="clock" size={15} />
          <span style={{ flex: 1 }}>{limitBanner.text}</span>
          {limitBanner.kind === 'stream' && <Btn variant="soft" size="sm" onClick={extendStream}>+15 min</Btn>}
          {limitBanner.kind === 'rec' && <Btn variant="soft" size="sm" onClick={() => void stopRecording()}>Stop &amp; save now</Btn>}
          <button className="iconbtn" aria-label="Dismiss" onClick={() => setLimitBanner(null)}><Icon name="x" size={14} /></button>
        </div>
      )}
      {status === 'live' && isPhone && wake === 'none' && (
        <div className="banner warn studio-banner" role="alert">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1 }}>This phone may lock its screen, which freezes your stream for viewers. {keepAwakeAdvice()}</span>
        </div>
      )}
      {strained && (
        <div className="banner warn studio-banner">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1 }}>Your connection or device is struggling with streaming <b>and</b> recording at once. Stop the local recording to keep the stream smooth — viewers come first.</span>
          <Btn variant="soft" size="sm" onClick={() => void stopRecording()}>Stop recording</Btn>
        </div>
      )}
      {unsaved.length > 0 && !pendingSave && (
        <div className="banner info studio-banner">
          <Icon name="record" size={15} />
          <span style={{ flex: 1 }}>
            {unsaved.length === 1 ? 'A recording from this event was never saved' : `${unsaved.length} recordings from this event were never saved`} — it&apos;s safe on this device.
          </span>
          <Btn variant="soft" size="sm" onClick={() => void recoverUnsaved(unsaved[0])}>Save it now</Btn>
        </div>
      )}
    </>
  );

  const saveSheet = pendingSave ? (
    <SaveSheet rec={pendingSave} hostKey={hostKey} push={push} onClose={closeSaveSheet} autoStart={prefs.saveTarget === 'drive'} />
  ) : null;

  const mobileCtl: MobileCtl = {
    status, viewers, liveFor, chat, floats, mixed, micOn, camOn, scene,
    zoom: { min: zoomMin, max: zoomMax, step: zoomStep, value: zoomVal },
    hasZoom: hasNativeZoom,
    mirror: mirrorSelf,
    lensCount: devices.length,
    guestCount: guests.length,
    toggleMic, toggleCam, flip: () => void flipCamera(), lens: () => void cycleLens(), applyZoom: (v) => void applyZoom(v),
    cutScene: (s) => void cutScene(s), sendChat, sendEmoji,
    goLive, end: () => void endStream(),
    recOn, toggleRec, recLabel: recOn ? fmtDuration(recElapsed / 1000) : null,
    banners: studioBanners,
    exit: () => (isPhone ? nav.dashboard() : setDevice('desktop')),
    hostName,
    meeting: isMeeting,
    canGoLive: !!mime && !!mixed,
    invite: openInvite,
    shareWatch: () => void shareWatch(),
    endMeeting: () => void endMeeting(),
    overlay: (
      <>
        {cameraIssue}
        {readyCard}
      </>
    ),
  };

  if (isPhone) {
    return (
      <div className="mstudio-fill">
        <MobileStudio ctl={mobileCtl} />
        {guestMonitors}
        {inviteSheet}
        {saveSheet}
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
          {meetingIdle && <Pill tone="accent" icon="users">Meeting · not broadcasting</Pill>}
          {status === 'idle' && !isMeeting && <Pill tone="neutral">Offline</Pill>}
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
        {!meetingIdle && <Pill tone="neutral" icon="eye">{viewers}/{maxViewers}</Pill>}
        <div className="t-sep" />
        {!meetingIdle && <IconBtn name="share" label="Share watch link" onClick={() => void shareWatch()} />}
        <Btn
          variant={meetingIdle ? 'solid' : 'soft'}
          size="sm"
          icon="users"
          onClick={openInvite}
          data-tour="studio-invite"
          title="Invite people on camera (I)"
        >
          {guests.length > 0 ? `Invite · ${guests.length}/${MAX_GUESTS}` : 'Invite'}
        </Btn>
        <IconBtn name="sliders" label="Customize" onClick={() => nav.settings()} />
        <HelpButton />
        {meetingIdle && (
          <>
            <Btn variant="ghost" icon="broadcast" onClick={goLive} disabled={!mime || !mixed} data-tour="studio-golive" title={mixed ? 'Broadcast this meeting to viewers' : 'Waiting for your camera'}>Go live with this meeting</Btn>
            <Btn variant="danger" icon="stop" onClick={() => void endMeeting()}>End meeting</Btn>
          </>
        )}
        {status === 'idle' && !isMeeting && <Btn variant="solid" icon="broadcast" onClick={goLive} disabled={!mime || !mixed} data-tour="studio-golive" title={mixed ? undefined : 'Waiting for your camera'}>Go live</Btn>}
        {(isLive || status === 'paused') && <Btn variant="danger" icon="stop" onClick={() => void endStream()}>End stream</Btn>}
        {status === 'ended' && <Btn variant="solid" icon="broadcast" onClick={goLive} disabled={!mime || !mixed}>Go live again</Btn>}
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
            <div className="preview-wrap" data-tour="studio-preview">
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
                  {recOn && <span className="ov-pill rec"><span className="ov-dot" />REC {fmtDuration(recElapsed / 1000)}{prefs.recLimitMin > 0 ? ` / ${prefs.recLimitMin}m` : ''} · {fmtBytes(recBytes)}</span>}
                  {status === 'live' && prefs.streamLimitMin > 0 && startedAt && (
                    <span className="ov-pill"><Icon name="clock" size={12} />{fmtDuration(Math.max(0, (prefs.streamLimitMin + streamExtraMin) * 60 - liveSec))} left</span>
                  )}
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
                {cameraIssue}
                {readyCard}
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
              <span className="cam-status"><span className="cam-dot" />{camErr ? 'Camera off' : camStarting ? 'Starting camera…' : meetingIdle ? 'Meeting camera' : 'Live camera'}</span>
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
            {studioBanners}
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
                <button className={cx('tbtn', 'rec', recOn && 'on')} onClick={toggleRec} aria-label="Record" title="Record (R)" data-tour="studio-record"><Icon name={recOn ? 'stop' : 'record'} size={16} /></button>
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
            <div className="scene-strip" data-tour="studio-scenes">
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
              <div className="rail-tabs" data-tour="studio-health">
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
                  quick={normalizeQuick(prefs.quickReactions)}
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
                  onCopyGuestInvite={guestKey ? () => void copyGuestInvite() : undefined}
                  onRotateGuestInvite={guestKey ? rotateInvite : undefined}
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
      {inviteSheet}
      {saveSheet}
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
  guestCount: number;
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
  recOn: boolean;
  toggleRec(): void;
  recLabel: string | null;
  banners: React.ReactNode;
  /** An Instant meeting (private until the host goes live). */
  meeting: boolean;
  canGoLive: boolean;
  invite(): void;
  shareWatch(): void;
  endMeeting(): void;
  /** Camera problem card / ready check, drawn over the video. */
  overlay: React.ReactNode;
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
        {ctl.status === 'idle' && <span className="ov-pill">{ctl.meeting ? 'Meeting · not broadcasting' : 'Ready'}</span>}
        {ctl.status === 'ended' && <span className="ov-pill">Ended</span>}
        {!(ctl.meeting && ctl.status === 'idle') && <span className="ov-pill"><Icon name="eye" size={12} />{ctl.viewers}</span>}
        {ctl.guestCount > 0 && <span className="ov-pill"><Icon name="users" size={12} />{ctl.guestCount} {ctl.meeting ? 'here' : 'on air'}</span>}
        <span className="spacer" />
        <button className="ms-topbtn" onClick={ctl.invite} aria-label="Invite people" data-tour="studio-invite"><Icon name="users" size={15} /><span>Invite</span></button>
        {!(ctl.meeting && ctl.status === 'idle') && (
          <button className="ms-topbtn" onClick={ctl.shareWatch} aria-label="Share watch link"><Icon name="share" size={15} /><span>Share</span></button>
        )}
        <button className="ms-x" onClick={ctl.exit} aria-label="Exit phone studio"><Icon name="x" size={16} /></button>
      </div>
      {ctl.overlay}

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
        <button className={cx('ms-round', ctl.recOn && 'rec-on')} onClick={ctl.toggleRec} aria-label={ctl.recOn ? 'Stop recording' : 'Record'}>
          <Icon name={ctl.recOn ? 'stop' : 'record'} size={18} /><span>{ctl.recLabel ?? 'Rec'}</span>
        </button>
      </div>
      <div className="ms-banners">{ctl.banners}</div>

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
        {ctl.status === 'idle' && ctl.meeting ? (
          <>
            <button className="ms-end" onClick={ctl.endMeeting}><span className="ms-end-dot" />End meeting</button>
            <button className="ms-react" onClick={ctl.goLive} disabled={!ctl.canGoLive} aria-label="Go live with this meeting" title="Go live with this meeting"><Icon name="broadcast" size={18} /></button>
          </>
        ) : (
          <>
            {ctl.status === 'idle'
              ? <button className="ms-golive" onClick={ctl.goLive} disabled={!ctl.canGoLive}><Icon name="broadcast" size={18} />Go live</button>
              : <button className="ms-end" onClick={ctl.end}><span className="ms-end-dot" />End stream</button>}
            <button className="ms-react" onClick={() => ctl.sendEmoji('❤️')} aria-label="Send heart"><Icon name="heart" size={18} /></button>
          </>
        )}
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
