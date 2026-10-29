// Baby Monitor — CAMERA mode (the phone in the nursery).
//
// A FaceTime-grade camera: real lenses (back, ultra-wide, front) with live
// preview, zoom, flip, two-way audio (parents' voices play on this speaker)
// and parents' video calls shown full-screen. Live only, never recorded:
// video/audio go peer-to-peer (end-to-end encrypted) to the family's devices —
// and, for viewers the direct picture can't reach (a network that blocks it,
// a full camera, or for a moment while it connects), as one small relay
// stream through the room (never stored; monitor/relay.ts). With a room that
// hands out the nursery key (ADR 0006 `e2e1`, monitor/keys.ts) that relay
// stream and the call signaling are sealed with the family's key on this
// phone (monitor/relayCrypto.ts) — the server passes along what it can't read;
// without one, the relay is not end-to-end encrypted, as before. All
// sound and motion analysis — including the AI sound model — runs on this
// phone; only events and a few numbers go to the room.
import React, { useEffect, useRef, useState } from 'react';
import {
  checkBrowser, dropAudioEl, listLenses, mediaErrorText, networkHint, openMedia, openVideoOnly, preferSpeaker, remoteAudioEl,
  setZoom, watchPower, zoomRange, MIC_CONSTRAINTS, type BrowserCheck, type Facing, type Lens, type PowerState, type ZoomRange,
} from '../monitor/camera';
import { CLOSE_TEXT, getDevice, openMonitorSocket, stepUp, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { STATE_INFO, STATE_RANK, type BabyState, type MonServerMsg, type MonSettings, type ViewerPresence } from '../monitor/protocol';
import { CameraHub, type Quality } from '../monitor/rtc';
import { sceneIntervalMs } from '../monitor/videoBudget';
import { NO_WANT, readWant, RelayEncoder, watchersNote, type RelayWant } from '../monitor/relay';
import { deviceKeys, keysGate, keyStore, NurseryKeys } from '../monitor/keys';
import { holdCameraLock, RelaySealer } from '../monitor/relayCrypto';
import { EidMinter } from '../../packages/monitor-core/src/eid';
import { StatusCadence } from '../monitor/statusCadence';
import type { BrainEvent } from '../monitor/soundBrain';
import { SOUND_INFO, type SoundCat } from '../monitor/soundClasses';
import { NurseryEars, type EarsSnapshot, type ModelState } from '../monitor/soundEngine';
import { LEVEL_BAND_INFO, levelBand, loadCalibration, saveCalibration, type Calibration, type MinuteLevels } from '../monitor/soundLevel';
import { FRAME_H, FRAME_W, VisionWatch, type VisionEvent, type Zone } from '../monitor/vision';
import { birthAt, downAngle, SceneWatch, type SceneEvent, type SceneState } from '../monitor/scene';
import type { SceneAi, SceneAiState } from '../monitor/sceneAi';
import { LoudnessGovernor, SOOTHE_CEILING_DB, TALK_CEILING_DB } from '../monitor/voice';
import { markSetup } from '../monitor/setupProgress';
import { SOOTHE_OPTIONS, SoothePlayer, type SootheKind } from '../monitor/soothe';
import { startTicker, type Ticker } from '../studio/ticker';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Btn, Meter, Pill, cx, type PushToast } from '../ui/primitives';
import { keepAwakeAdvice, ScreenWakeLock, type WakeState } from '../wakeLock';
import { MonitorGate } from './MonitorHome';
import { HelpButton, useFirstVisitTour } from '../components/Guide';
import { ZoneEditor } from './monitor/ZoneEditor';

const LENS_KEY = 'ds-monitor-lens';
/** The last event sequence this phone used (eids keep rising even if the clock steps back across reloads). */
const EID_SEQ_KEY = 'ds-monitor-eid-seq';
const zonesKey = (nid: string) => `ds-monitor-zones-${nid}`;
const statsKey = (nid: string) => `ds-monitor-stats-${nid}`;
/** Minutes kept on the phone while the room is unreachable (6 h). */
const STATS_KEEP = 360;

/** One minute of measurements for the nursery's history. */
interface StatsRow {
  m: number;
  laeq: number;
  lmax: number;
  l10: number;
  l50: number;
  l90: number;
  lpk: number;
  cal: number;
  motion: number | null;
  mmax: number | null;
  crib: number | null;
  outside: number | null;
  light: number | null;
  state: number;
  sounds: Record<string, number>;
  visit: number;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null') as T | null;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch { /* storage full or unavailable */ }
}
const AUTODIM_KEY = 'ds-monitor-autodim';
const AUTODIM_MS = 90_000;

type Phase = 'check' | 'starting' | 'setup' | 'running' | 'error';

const EMPTY_SNAP: EarsSnapshot = { mood: 'calm', sound: null, conf: 0, top: [], ai: false, level: 0, cry: 0, model: 'off', modelProgress: 0, spl: null };

function loadLens(): { id: string | null; facing: Facing } {
  try {
    const raw = JSON.parse(localStorage.getItem(LENS_KEY) || 'null') as { id?: string; facing?: Facing } | null;
    return { id: raw?.id ?? null, facing: raw?.facing === 'user' ? 'user' : 'environment' };
  } catch {
    return { id: null, facing: 'environment' };
  }
}

export function MonitorCamera({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  return (
    <MonitorGate>
      <CameraInner id={id} nav={nav} push={push} />
    </MonitorGate>
  );
}

function CameraInner({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const callerRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sockRef = useRef<MonitorSocket | null>(null);
  /** The room has said hello on the current connection. */
  const authedRef = useRef(false);
  /** Sounds the room has been told have started (and not yet ended). */
  const toldRef = useRef(new Set<SoundCat>());
  const hubRef = useRef<CameraHub | null>(null);
  const earsRef = useRef<NurseryEars | null>(null);
  const visionRef = useRef(new VisionWatch());
  // Smart vision (beta): on-device object + pose models, about once a second.
  const sceneWatchRef = useRef(new SceneWatch());
  const sceneAiRef = useRef<SceneAi | null>(null);
  const sceneNowRef = useRef<SceneState | null>(null);
  const [sceneOn, setSceneOn] = useState(() => {
    try {
      const v = localStorage.getItem('ds-cam-scene');
      if (v === '1' || v === '0') return v === '1';
    } catch { /* storage unavailable */ }
    return (navigator.hardwareConcurrency ?? 2) >= 4;
  });
  const [sceneAi, setSceneAi] = useState<SceneAiState>('idle');
  const zonesRef = useRef<Zone[]>(loadJson<Zone[]>(zonesKey(id), []));
  const pendingZonesRef = useRef<Zone[] | null>(null);
  const statsRef = useRef<StatsRow[]>(loadJson<StatsRow[]>(statsKey(id), []));
  const minuteAccRef = useRef<{ sounds: Record<string, number>; worst: number }>({ sounds: {}, worst: 1 });
  const visionNowRef = useRef<{ crib: number | null; outside: number | null; visit: boolean }>({ crib: null, outside: null, visit: false });
  const tiltOnRef = useRef(false);
  // Loudness at the crib: talk ≤ 65 dB, soothing ≤ 50 dB (measured by this phone's meter).
  const talkGovRef = useRef(new LoudnessGovernor(TALK_CEILING_DB));
  const sootheGovRef = useRef(new LoudnessGovernor(SOOTHE_CEILING_DB));
  const bgRef = useRef<number | null>(null);
  /** Event ids (`<dev>:<seq>`, ADR 0006): the room stores each event once, viewers alert on the first copy. */
  const eidRef = useRef<EidMinter | null>(null);
  const nextEid = (): string | undefined => {
    try {
      if (!eidRef.current) eidRef.current = new EidMinter(getDevice().id, Number(localStorage.getItem(EID_SEQ_KEY)) || 0);
      const eid = eidRef.current.next();
      localStorage.setItem(EID_SEQ_KEY, String(eidRef.current.seq));
      return eid;
    } catch {
      return eidRef.current ? eidRef.current.next() : undefined;
    }
  };
  /** A camera event to the room, with its id (the same one its data-channel copy carries). */
  const sendEvent = (ev: Record<string, unknown>, eid: string | undefined = nextEid()) => sockRef.current?.send({ t: 'event', ...ev, ...(eid ? { eid } : {}) });
  /** Ids of sound events that reached viewers directly while the room was away: the room gets the same ones. */
  const heldEidsRef = useRef(new Map<string, string>());
  /** This phone's keys for the nursery (null until loaded, or without WebCrypto): sealed signaling and relay. */
  const keysRef = useRef<NurseryKeys | null>(null);
  const keysReadyRef = useRef<Promise<NurseryKeys | null> | null>(null);
  /** The same, for signaling: it never waits on a hung storage for more than a moment. */
  const keysGateRef = useRef<Promise<NurseryKeys | null>>(Promise.resolve(null));
  /** Room messages that need the keys wait for them, in order. */
  const keyChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** This tab is the only camera of the nursery on this phone (Web Locks): only then does it seal. */
  const camLockRef = useRef<{ release: (() => void) | null; held: boolean }>({ release: null, held: false });
  const sealerRef = useRef<RelaySealer | null>(null);
  // One stable listener (added/removed by identity) — it only touches refs.
  const [onTilt] = useState(() => (e: DeviceOrientationEvent) => {
    for (const ev of visionRef.current.pushTilt(e.beta, e.gamma, Date.now())) {
      sendEvent({ kind: 'vision', type: ev.type, via: ev.via });
    }
    // Smart vision: a phone looking straight down sees a lying baby as "upright".
    if (e.beta != null && e.gamma != null) sceneWatchRef.current.setContext({ downAngle: downAngle(e.beta, e.gamma, lensRef.current.facing === 'user') });
  });
  const sootheRef = useRef(new SoothePlayer());
  const wakeRef = useRef(new ScreenWakeLock());
  const tickersRef = useRef<Ticker[]>([]);
  /** What goes to the room: news at once, a keepalive every 2 min — every 2 s only while it asks (live_want). */
  const cadenceRef = useRef(new StatusCadence());
  // Keyed by the viewer (CameraHub keys), so a parent's socket reconnecting mid-talk keeps their voice.
  const talkElsRef = useRef(new Map<string, HTMLAudioElement>());
  const callersRef = useRef(new Map<string, { stream: MediaStream | null; who: string; on: boolean }>());
  /** The relay picture (one encoder for every viewer who can't get the direct one). */
  const relayRef = useRef<RelayEncoder | null>(null);
  /** Viewers being encoded for (P2P) — smart vision steps back when it's more than one. */
  const peersRef = useRef(0);
  /** Latest motion / light (the heartbeat reads these; the screen may not re-render while dimmed). */
  const motionRef = useRef(0);
  const lightRef = useRef(128);
  const dimRef = useRef(false);
  const lensRef = useRef(loadLens());
  const powerRef = useRef<PowerState>({ level: null, charging: null });
  const unwatchPowerRef = useRef<() => void>(() => undefined);
  const lastBatteryAlertRef = useRef(0);
  const motionRunRef = useRef<{ since: number | null; lastEvent: number }>({ since: null, lastEvent: 0 });
  /** Who is talking into the nursery: viewer key → their name and current socket. */
  const talkersRef = useRef(new Map<string, { who: string; sid: string }>());
  const privacyRef = useRef(false);
  const interruptedRef = useRef(false);
  const lastTouchRef = useRef(Date.now());
  const recoveringRef = useRef(false);

  const [check] = useState<BrowserCheck>(() => checkBrowser());
  const [phase, setPhase] = useState<Phase>('check');
  const [err, setErr] = useState<string | null>(null);
  const [lenses, setLenses] = useState<Lens[]>([]);
  const [lensId, setLensId] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>(lensRef.current.facing);
  const [zoom, setZoomRange] = useState<ZoomRange | null>(null);
  const [zoomVal, setZoomVal] = useState(1);
  const [res, setRes] = useState<string>('');
  const [sock, setSock] = useState<MonSocketStatus>('connecting');
  /** Why the room connection is waiting (the second sign-in step), while it reconnects. */
  const [sockNote, setSockNote] = useState<string | null>(null);
  const [nursery, setNursery] = useState<{ name: string; baby: string | null }>({ name: 'Nursery', baby: null });
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [p2pCount, setP2pCount] = useState(0);
  /** What the relay sends right now (for the status line): a video codec, JPEG, or nothing. */
  const [relayMode, setRelayMode] = useState<string | null>(null);
  /** Viewers getting the relay picture — including those only bridging while their direct picture connects. */
  const [relayViewers, setRelayViewers] = useState(0);
  const [snap, setSnap] = useState<EarsSnapshot>(EMPTY_SNAP);
  const [motion, setMotion] = useState(0);
  const [light, setLight] = useState(128);
  const [model, setModel] = useState<{ s: ModelState; p: number }>({ s: 'off', p: 0 });
  const [heard, setHeard] = useState(false);
  const [power, setPower] = useState<PowerState>({ level: null, charging: null });
  const [talkers, setTalkers] = useState<string[]>([]);
  const [caller, setCaller] = useState<{ sid: string; who: string } | null>(null);
  const [soothing, setSoothing] = useState<{ kind: SootheKind; endsAt: number } | null>(null);
  const [dim, setDim] = useState(false);
  const [autoDim, setAutoDim] = useState(() => {
    try {
      return localStorage.getItem(AUTODIM_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [privacy, setPrivacy] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [hiddenWarn, setHiddenWarn] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [wake, setWake] = useState<WakeState>('none');
  const [zones, setZones] = useState<Zone[]>(zonesRef.current);
  const [zoneEdit, setZoneEdit] = useState(false);
  const [cal, setCal] = useState<Calibration | null>(() => loadCalibration());
  const [calOpen, setCalOpen] = useState(false);
  const [calInput, setCalInput] = useState('');
  const [, setClock] = useState(0);
  /** The nursery key changed (arrived, rotated): the status line re-reads it. */
  const [, setKeyTick] = useState(0);
  const device = getDevice();
  useFirstVisitTour('camera', phase === 'setup');

  // The nursery key (ADR 0006 D6.3): this phone's device keys and the wraps it holds, loaded
  // while the camera is set up — so the first viewer's signaling is judged with them — and the
  // lock that makes this tab the nursery's only camera on this phone (only then does it seal).
  useEffect(() => {
    let alive = true;
    const ready = (async () => {
      const dev = await deviceKeys();
      if (!dev || !alive) return null;
      const k = new NurseryKeys({ nid: id, device: dev, store: keyStore(), name: getDevice().name, send: (m) => sockRef.current?.send(m), onChange: () => setKeyTick((n) => n + 1) });
      await k.load();
      if (!alive) return null;
      keysRef.current = k;
      if (hubRef.current) hubRef.current.seal = k;
      return k;
    })().catch(() => null);
    keysReadyRef.current = ready;
    keysGateRef.current = keysGate(ready);
    void holdCameraLock(id).then((release) => {
      if (!alive) return release?.();
      camLockRef.current = { release, held: !!release };
    });
    return () => {
      alive = false;
      keysRef.current?.close();
      keysRef.current = null;
      camLockRef.current.release?.();
      camLockRef.current = { release: null, held: false };
    };
  }, [id]);

  /* ---------------------------------------------------------- lifecycle */

  const stopAll = (sayBye: boolean) => {
    if (sayBye) sockRef.current?.send({ t: 'bye' });
    tickersRef.current.forEach((t) => t.stop());
    tickersRef.current = [];
    relayRef.current?.stop();
    relayRef.current = null;
    // Stopping on purpose: viewers end the call now instead of waiting for it to time out.
    hubRef.current?.closeAll(sayBye);
    hubRef.current = null;
    const s = sockRef.current;
    sockRef.current = null;
    window.setTimeout(() => s?.close(), sayBye ? 300 : 0);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    earsRef.current?.stop();
    earsRef.current = null;
    sootheRef.current.close();
    for (const el of talkElsRef.current.values()) dropAudioEl(el);
    talkElsRef.current.clear();
    callersRef.current.clear();
    unwatchPowerRef.current();
    void wakeRef.current.disable();
    if (tiltOnRef.current) window.removeEventListener('deviceorientation', onTilt);
    tiltOnRef.current = false;
  };

  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  useEffect(() => () => stopAll(phaseRef.current === 'running'), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Smart vision: load the models once monitoring starts, then about one
  // frame a second (slower if this phone struggles). Paused while the video
  // is paused for privacy or the page is in the background.
  useEffect(() => {
    sceneWatchRef.current.setZones(zonesRef.current);
    if (phase !== 'running' || !sceneOn) {
      sceneNowRef.current = null;
      return;
    }
    let alive = true;
    let timer: number | undefined;
    void (async () => {
      setSceneAi('loading');
      const { SceneAi } = await import('../monitor/sceneAi');
      const ai = sceneAiRef.current ?? new SceneAi();
      sceneAiRef.current = ai;
      const ok = await ai.load();
      if (import.meta.env?.DEV) (globalThis as unknown as { __dsScene?: unknown }).__dsScene = { ai, watch: sceneWatchRef.current, now: () => sceneNowRef.current };
      if (!alive) return;
      setSceneAi(ok ? 'ready' : 'failed');
      if (!ok) return;
      const tick = () => {
        if (!alive) return;
        const v = videoRef.current;
        if (v && document.visibilityState === 'visible' && !privacyRef.current) {
          const f = ai.detect(v);
          if (f) {
            const { state, events } = sceneWatchRef.current.push(f, Date.now());
            sceneNowRef.current = state;
            for (const e of events) sendScene(e);
          }
        }
        // The live picture comes first: slower with several viewers or a busy phone
        // (the relay counts as a viewer). Sound and cry detection never slow down.
        const peers = peersRef.current + (relayRef.current?.active ? 1 : 0);
        timer = window.setTimeout(tick, sceneIntervalMs(ai.cost, peers, hubRef.current?.pressure ?? 0));
      };
      tick();
    })();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      sceneNowRef.current = null;
    };
  }, [phase, sceneOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // The <video> elements mount per phase — (re)attach streams whenever they do.
  useEffect(() => {
    const v = videoRef.current;
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => undefined);
    }
    const c = callerRef.current;
    const cs = caller ? callersRef.current.get(caller.sid)?.stream ?? null : null;
    if (c && c.srcObject !== cs) {
      c.srcObject = cs;
      if (cs) void c.play().catch(() => undefined);
    }
  });

  useEffect(() => {
    let minute = -1;
    const t = window.setInterval(() => {
      // Dimmed, only the clock's minute is on screen: re-render once a minute, not every second.
      const m = Math.floor(Date.now() / 60_000);
      if (dimRef.current && m === minute) return;
      minute = m;
      setClock((n) => n + 1);
    }, 1000);
    const onVis = () => {
      if (document.visibilityState === 'hidden' && phase === 'running') {
        setHiddenWarn(true);
        // Say so now — a locked phone may stop running this page any second.
        sendEvent({ kind: 'paused', why: 'hidden' });
      }
      if (document.visibilityState === 'visible') {
        if (phase === 'running') sendEvent({ kind: 'resumed' });
        void recover();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (phase === 'running') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dim: an idle camera screen goes black (battery + no glow in the
  // nursery). A parent's video call or a tap wakes it.
  useEffect(() => {
    if (phase !== 'running' || !autoDim || dim || caller) return;
    const t = window.setInterval(() => {
      if (Date.now() - lastTouchRef.current > AUTODIM_MS) setDim(true);
    }, 5000);
    return () => window.clearInterval(t);
  }, [phase, autoDim, dim, caller]);

  const touch = () => {
    lastTouchRef.current = Date.now();
  };

  /* -------------------------------------------------------------- media */

  const videoTrack = () => streamRef.current?.getVideoTracks()[0] ?? null;

  const watchTrack = (t: MediaStreamTrack) => {
    const mark = (down: boolean) => {
      if (interruptedRef.current === down) return;
      interruptedRef.current = down;
      setInterrupted(down);
      if (down) window.setTimeout(() => void recover(), 1500);
    };
    t.addEventListener('ended', () => mark(true));
    t.addEventListener('mute', () => mark(true));
    t.addEventListener('unmute', () => mark(false));
  };

  const afterVideoChange = (t: MediaStreamTrack) => {
    watchTrack(t);
    const s = t.getSettings();
    setLensId(s.deviceId ?? null);
    const f: Facing = s.facingMode === 'user' ? 'user' : s.facingMode === 'environment' ? 'environment' : facing;
    setFacing(f);
    setRes(s.height ? `${s.height}p` : '');
    const z = zoomRange(t);
    setZoomRange(z);
    setZoomVal(z ? Math.max(z.min, Math.min(z.max, (s as MediaTrackSettings & { zoom?: number }).zoom ?? z.min)) : 1);
    lensRef.current = { id: s.deviceId ?? null, facing: f };
    try {
      localStorage.setItem(LENS_KEY, JSON.stringify(lensRef.current));
    } catch { /* storage unavailable */ }
    const v = videoRef.current;
    if (v) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => undefined);
    }
  };

  /** Open camera + mic, start the ears — the setup preview. */
  const startPreview = async () => {
    setPhase('starting');
    setErr(null);
    preferSpeaker();
    sootheRef.current.unlock(); // inside the tap — iOS audio unlock
    let stream: MediaStream;
    try {
      stream = await openMedia({ deviceId: lensRef.current.id, facing: lensRef.current.facing, audio: true });
    } catch (e) {
      setErr(mediaErrorText(e, check));
      setPhase('error');
      return;
    }
    streamRef.current = stream;
    const vt = stream.getVideoTracks()[0];
    if (vt) afterVideoChange(vt);
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => void recover()));
    void listLenses().then(setLenses);
    wakeRef.current.onChange = setWake;
    void wakeRef.current.enable();

    // ---- the ears (cry analyser + alarm pattern + AI model + sound level meter)
    const ears = new NurseryEars(loadCalibration());
    earsRef.current = ears;
    ears.onModel = (s, p) => setModel({ s, p });
    ears.onEvents = (events) => {
      for (const e of events) sendSound(e);
    };
    ears.onNoise = (events) => {
      for (const e of events) {
        const eid = nextEid();
        sendEvent({ kind: 'noise', type: e.type, phase: e.phase, db: e.db, secs: e.secs, cal: ears.meter.calibrated }, eid);
        hubRef.current?.direct({ t: 'ev', kind: 'noise', type: e.type, phase: e.phase, db: e.db, secs: e.secs, at: Date.now(), dev: device.id, eid });
      }
    };
    ears.onMinute = (lv) => addMinute(lv);
    // Feedback (a parent's phone in this room): silence the talk audio at once,
    // and tell the talkers so their phones go half-duplex.
    ears.onHowl = (h) => {
      for (const el of talkElsRef.current.values()) {
        el.muted = true;
        window.setTimeout(() => (el.muted = false), 900);
      }
      for (const t of talkersRef.current.values()) sockRef.current?.send({ t: 'tell', to: t.sid, c: 'feedback', v: { freq: h.freq } });
    };
    try {
      await ears.start(stream, { ai: true });
    } catch {
      push('Sound analysis isn’t available in this browser — video still works', { icon: 'alert' });
    }

    // ---- vision: motion, zones, visits, lights, camera moved (tiny frames, 4 fps)
    const canvas = document.createElement('canvas');
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    const vision = visionRef.current;
    vision.setZones(zonesRef.current);
    let frameN = 0;
    let lastMood: string | null = null;
    // Shrink the frame before reading it (createImageBitmap resizes on the GPU
    // where it can), so only 64×48 pixels come back to the CPU four times a
    // second — not a whole 720p frame. Falls back to drawing the video directly.
    let shrinkFails = typeof createImageBitmap === 'function' ? 0 : 3;
    let grabbing = false;
    const grab = async (v: HTMLVideoElement) => {
      if (!c2d) return;
      if (shrinkFails < 3) {
        try {
          const bmp = await createImageBitmap(v, { resizeWidth: FRAME_W, resizeHeight: FRAME_H, resizeQuality: 'low' });
          c2d.drawImage(bmp, 0, 0, FRAME_W, FRAME_H);
          bmp.close();
          shrinkFails = 0;
          return;
        } catch {
          shrinkFails += 1;
        }
      }
      c2d.drawImage(v, 0, 0, FRAME_W, FRAME_H);
    };
    const look = () => {
      if (!c2d) return;
      const now = Date.now();
      const r = vision.push(c2d.getImageData(0, 0, FRAME_W, FRAME_H).data, now);
      earsRef.current?.setMotion(r.frame.motion);
      visionNowRef.current = { crib: r.frame.crib, outside: r.frame.outside, visit: vision.inVisit };
      motionRef.current = r.frame.motion;
      lightRef.current = r.frame.light;
      // The meters only matter on a lit screen.
      if (frameN++ % 2 === 0 && !dimRef.current) {
        setMotion(r.frame.motion);
        setLight(r.frame.light);
      }
      for (const e of r.events) sendVision(e);
      const run = motionRunRef.current;
      if (r.frame.motion > 35 && !vision.inVisit) {
        run.since ??= now;
        if (now - run.since > 5000 && now - run.lastEvent > 10 * 60_000) {
          run.lastEvent = now;
          sendEvent({ kind: 'motion' });
        }
      } else run.since = null;
    };
    tickersRef.current.push(
      startTicker(250, () => {
        const v = videoRef.current;
        if (!c2d || !v || v.readyState < 2 || privacyRef.current || grabbing) return;
        grabbing = true;
        void grab(v)
          .then(() => !privacyRef.current && look())
          .catch(() => undefined)
          .finally(() => (grabbing = false));
      }),
      // Per-minute tallies: what was heard and the worst state.
      startTicker(1000, () => {
        const s = earsRef.current?.snapshot();
        if (!s) return;
        const acc = minuteAccRef.current;
        if (s.sound) acc.sounds[s.sound] = (acc.sounds[s.sound] ?? 0) + 1;
        acc.worst = Math.max(acc.worst, STATE_RANK[s.mood as BabyState] ?? 1);
        // Adult sounds tell the vision engine a grown-up is in the room.
        if (s.sound === 'voices' || (s.sound as string) === 'footsteps' || (s.sound as string) === 'door') vision.hintPresence(Date.now());
      }),
      // Live sound readout for the setup checks and the running screen.
      startTicker(500, () => {
        const s = earsRef.current?.snapshot();
        if (!s) return;
        // Dimmed, the screen shows only the state: re-render when it changes, not twice a second.
        if (!dimRef.current || s.mood !== lastMood) setSnap(s);
        lastMood = s.mood;
        if (s.level >= 12) setHeard(true);
      }),
    );

    unwatchPowerRef.current = await watchPower((p) => {
      powerRef.current = p;
      setPower(p);
      if (p.charging === false && p.level != null && p.level <= 20 && Date.now() - lastBatteryAlertRef.current > 30 * 60_000) {
        lastBatteryAlertRef.current = Date.now();
        sendEvent({ kind: 'battery', pct: p.level });
      }
    });
    setPhase('setup');
  };

  /** Recover from an interruption (phone call, another app took the camera, background). */
  const recover = async () => {
    const s = streamRef.current;
    if (!s || recoveringRef.current || document.visibilityState !== 'visible') return;
    recoveringRef.current = true;
    try {
      const vt = s.getVideoTracks()[0];
      if (!vt || vt.readyState === 'ended') {
        try {
          const fresh = await openVideoOnly({ deviceId: lensRef.current.id, facing: lensRef.current.facing });
          s.getVideoTracks().forEach((t) => s.removeTrack(t));
          s.addTrack(fresh);
          afterVideoChange(fresh);
          await hubRef.current?.replaceVideo();
          interruptedRef.current = false;
          setInterrupted(false);
        } catch {
          window.setTimeout(() => void recover(), 5000);
        }
      }
      const at = s.getAudioTracks()[0];
      if (!at || at.readyState === 'ended') {
        try {
          const fresh = (await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })).getAudioTracks()[0];
          if (fresh) {
            s.getAudioTracks().forEach((t) => s.removeTrack(t));
            s.addTrack(fresh);
            fresh.addEventListener('ended', () => void recover());
            earsRef.current?.attach(s);
            await hubRef.current?.replaceAudio();
          }
        } catch { /* keep trying on the next visibility change */ }
      }
    } finally {
      recoveringRef.current = false;
    }
  };

  /** Switch lens. iOS can only run one camera: stop the old one first. */
  const useLens = async (want: { id: string | null; facing: Facing }) => {
    const s = streamRef.current;
    if (!s) return;
    const prev = { ...lensRef.current };
    s.getVideoTracks().forEach((t) => {
      s.removeTrack(t);
      t.stop();
    });
    try {
      const t = await openVideoOnly({ deviceId: want.id, facing: want.facing });
      s.addTrack(t);
      afterVideoChange(t);
    } catch {
      push('That camera couldn’t start — switching back', { icon: 'alert' });
      try {
        const t = await openVideoOnly({ deviceId: prev.id, facing: prev.facing });
        s.addTrack(t);
        afterVideoChange(t);
      } catch {
        setInterrupted(true);
      }
    }
    await hubRef.current?.replaceVideo();
  };

  const flip = () => {
    const back = lenses.find((l) => l.facing === 'environment' && l.rank === 1) ?? lenses.find((l) => l.facing === 'environment');
    const front = lenses.find((l) => l.facing === 'user');
    if (facing === 'environment') void useLens({ id: front?.id ?? null, facing: 'user' });
    else void useLens({ id: back?.id ?? null, facing: 'environment' });
  };

  const onZoom = (z: number) => {
    setZoomVal(z);
    const t = videoTrack();
    if (t) void setZoom(t, z);
  };

  /* --------------------------------------------------------------- room */

  const goLive = () => {
    const hub = new CameraHub(
      (to, d) => sockRef.current?.send({ t: 'rtc', to, d }),
      [],
      () => ({ video: videoTrack(), audio: streamRef.current?.getAudioTracks()[0] ?? null }),
    );
    hub.onCount = (n) => {
      peersRef.current = n;
      setP2pCount(n);
    };
    // Holding the nursery key, the camera seals its signaling and refuses unsealed offers.
    hub.seal = keysRef.current;
    // Relay credentials last a few hours: the room is asked for fresh ones before they lapse.
    hub.onIceStale = () => sockRef.current?.send({ t: 'ice' });
    hub.onTalk = (key, s) => {
      let el = talkElsRef.current.get(key);
      if (!s) {
        dropAudioEl(el);
        talkElsRef.current.delete(key);
        return;
      }
      if (!el) {
        el = remoteAudioEl();
        el.volume = 0.85; // moderate start (ignored on iPhone — the parent's phone shapes the voice there)
        talkElsRef.current.set(key, el);
      }
      el.srcObject = s;
      void el.play().catch(() => undefined);
    };
    hub.onCallerVideo = (key, s, who) => {
      const cur = callersRef.current.get(key);
      if (!s) {
        callersRef.current.delete(key);
        setCaller((c) => (c?.sid === key ? pickCaller() : c));
        return;
      }
      callersRef.current.set(key, { stream: s, who, on: cur?.on ?? false });
    };
    hubRef.current = hub;

    sockRef.current = openMonitorSocket(id, 'camera', onMsg, () => undefined, (st, detail) => {
      setSock(st);
      setSockNote(st === 'reconnecting' ? detail ?? null : null);
      if (st !== 'connected') {
        authedRef.current = false;
        // Nothing can reach relay viewers now: stop encoding for them (the home Wi-Fi
        // keeps the direct picture going). The room re-sends relay_want when we rejoin.
        setRelay(NO_WANT);
      }
      if (st === 'closed' && detail) {
        setErr(detail);
        setPhase('error');
        stopAll(false);
      }
    });

    // Loudness governor: what plays here must stay gentle at the crib.
    tickersRef.current.push(
      startTicker(1000, () => {
        const ears = earsRef.current;
        if (!ears) return;
        const lv = ears.meter.live(Date.now()).leq1;
        const talking = talkersRef.current.size > 0;
        const soothing = !!sootheRef.current.current;
        if (!talking && !soothing) {
          // The room's own background, for judging what playback adds.
          bgRef.current = bgRef.current == null ? lv : bgRef.current * 0.9 + lv * 0.1;
          return;
        }
        if (talking) {
          const f = talkGovRef.current.step(lv, bgRef.current);
          if (f < 1) {
            for (const t of talkersRef.current.values()) sockRef.current?.send({ t: 'tell', to: t.sid, c: 'talk_gain', v: { factor: f, db: Math.round(lv) } });
            // Where the browser allows it (not iPhone), turn the speaker down here too.
            for (const el of talkElsRef.current.values()) el.volume = Math.max(0.3, el.volume * f);
          }
        }
        if (soothing) {
          const f = sootheGovRef.current.step(lv, bgRef.current);
          if (f !== 1) sootheRef.current.scale(f);
        }
      }),
    );

    // Status heartbeat (also the liveness signal the room watches).
    tickersRef.current.push(
      startTicker(2000, () => {
        const ears = earsRef.current;
        const s = ears?.snapshot() ?? EMPTY_SNAP;
        // Keep ignoring the speaker while anyone is still talking.
        if (talkersRef.current.size && ears) ears.suppress(3000);
        const talkNames = [...new Set([...talkersRef.current.values()].map((t) => t.who))];
        const relay = relayRef.current;
        const relayFps = relay?.sentFps() ?? 0;
        const enc = hubRef.current ? { ...hubRef.current.telemetry(), relay: relayFps, rc: relay?.mode ?? null } : null;
        setRelayMode((m) => (m === (relay?.mode ?? null) ? m : relay?.mode ?? null));
        const callerOn = [...callersRef.current.values()].find((c) => c.on);
        const st = {
            state: s.mood as BabyState,
            level: s.level,
            motion: motionVal(),
            light: lightVal(),
            spl: s.spl ? { db: s.spl.db, leq: s.spl.leq1, max: s.spl.max1, cal: s.spl.calibrated } : null,
            crib: visionNowRef.current.crib,
            outside: visionNowRef.current.outside,
            visit: visionNowRef.current.visit,
            scene: sceneNowRef.current,
            battery: powerRef.current.level,
            charging: powerRef.current.charging,
            soothing: sootheRef.current.current?.kind ?? null,
            cry: s.cry,
            sound: s.sound,
            conf: s.conf,
            top: s.top,
            model: s.model,
            paused: privacyRef.current ? 'privacy' : interruptedRef.current ? 'interrupted' : null,
            awake: wakeRef.current.state,
            talk: talkNames.length ? talkNames.join(' & ') : null,
            call: callerOn?.who ?? null,
            enc,
        };
        if (cadenceRef.current.due(st, Date.now())) sockRef.current?.send({ t: 'status', st });
        // Straight to viewers every 2 s — over the home Wi-Fi this keeps working when the internet doesn't.
        hubRef.current?.direct({ t: 'st', st, dev: device.id });
      }),
    );
    touch();
    markSetup(id, 'camera');
    enableTilt();
    setPhase('running');
  };

  /** The phone's tilt sensor catches a knocked-over camera (iOS asks inside this tap). */
  const enableTilt = () => {
    if (tiltOnRef.current) return;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    const on = () => {
      tiltOnRef.current = true;
      window.addEventListener('deviceorientation', onTilt);
    };
    if (DOE?.requestPermission) void DOE.requestPermission().then((r) => r === 'granted' && on()).catch(() => undefined);
    else if (DOE) on();
  };

  /**
   * Sound events reach the room only once it's listening (after 'hello').
   * Anything that started during setup or while offline is caught up by
   * syncSounds() on the next hello — so a cry already going when monitoring
   * starts still alerts the family, exactly once.
   */
  const sendSound = (e: BrainEvent, replay = false) => {
    // One id for both copies: a viewer alerts on whichever arrives first, once. A replay after the
    // room was away reuses the id viewers already had straight from this phone.
    const held = `${e.cat}:${e.phase}`;
    const eid = (replay ? heldEidsRef.current.get(held) : undefined) ?? nextEid();
    // Viewers on the same Wi-Fi hear about it directly, room or no room.
    if (!replay) hubRef.current?.direct({ t: 'ev', kind: 'sound', cat: e.cat, phase: e.phase, conf: e.conf, secs: e.secs, at: Date.now(), dev: device.id, eid });
    if (!authedRef.current) {
      if (eid) heldEidsRef.current.set(held, eid);
      return;
    }
    heldEidsRef.current.delete(held);
    sendEvent({ kind: 'sound', cat: e.cat, phase: e.phase, conf: e.conf, secs: e.secs, via: e.via }, eid);
    if (e.phase === 'start') toldRef.current.add(e.cat);
    else toldRef.current.delete(e.cat);
  };
  const syncSounds = () => {
    const brain = earsRef.current?.brain;
    if (!brain) return;
    const now = brain.ongoing();
    for (const e of now) if (!toldRef.current.has(e.cat)) sendSound(e, true);
    const still = new Set(now.map((e) => e.cat));
    for (const cat of [...toldRef.current]) if (!still.has(cat)) sendSound({ phase: 'end', cat, conf: 0, via: 'ai' }, true);
  };

  const sendScene = (e: SceneEvent) => {
    const { type, ...rest } = e as SceneEvent & Record<string, unknown>;
    const eid = nextEid();
    sendEvent({ kind: 'scene', type, ...rest }, eid);
    hubRef.current?.direct({ t: 'ev', kind: 'scene', type, ...(rest as Record<string, string | number | boolean>), at: Date.now(), dev: device.id, eid });
  };

  const toggleScene = () => {
    setSceneOn((on) => {
      try {
        localStorage.setItem('ds-cam-scene', on ? '0' : '1');
      } catch { /* storage unavailable */ }
      return !on;
    });
  };

  const sendVision = (e: VisionEvent) => {
    const eid = nextEid();
    hubRef.current?.direct({ t: 'ev', kind: 'vision', type: e.type, at: Date.now(), dev: device.id, eid });
    sendEvent({ kind: 'vision', type: e.type, zone: e.zone, name: e.name, secs: e.secs, via: e.via }, eid);
  };

  /** One minute of sound + vision → the history buffer (kept on the phone until the room has it). */
  const addMinute = (lv: MinuteLevels) => {
    const vm = visionRef.current.minute();
    const acc = minuteAccRef.current;
    minuteAccRef.current = { sounds: {}, worst: 1 };
    if (phaseRef.current !== 'running') return;
    const row: StatsRow = {
      m: lv.m, laeq: lv.laeq, lmax: lv.lmax, l10: lv.l10, l50: lv.l50, l90: lv.l90, lpk: lv.lpk, cal: lv.calibrated ? 1 : 0,
      motion: vm?.motion ?? null, mmax: vm?.mmax ?? null, crib: vm?.crib ?? null, outside: vm?.outside ?? null, light: vm?.light ?? null,
      state: acc.worst, sounds: acc.sounds, visit: vm?.visit ? 1 : 0,
    };
    statsRef.current = [...statsRef.current.filter((r) => r.m !== row.m), row].slice(-STATS_KEEP);
    saveJson(statsKey(id), statsRef.current);
    flushStats();
  };

  const flushStats = () => {
    const s = sockRef.current;
    if (!s?.open || !statsRef.current.length) return;
    s.send({ t: 'stats', rows: statsRef.current.slice(-240) });
  };

  const saveZoneList = (list: Zone[]) => {
    zonesRef.current = list;
    setZones(list);
    visionRef.current.setZones(list);
    sceneWatchRef.current.setZones(list);
    saveJson(zonesKey(id), list);
    if (sockRef.current?.open) sockRef.current.send({ t: 'settings', zones: { dev: device.id, list } });
    else pendingZonesRef.current = list;
    setZoneEdit(false);
    push(list.length ? 'Zones saved — the camera watches them now' : 'Zones cleared', { icon: 'check' });
  };

  const calibrate = (how: 'quiet' | 'meter' | 'reset') => {
    const ears = earsRef.current;
    if (!ears) return;
    if (how === 'reset') {
      ears.setCalibration(null);
      saveCalibration(null);
      setCal(null);
      push('Sound meter back to automatic', { icon: 'check' });
      return;
    }
    const reading = Number(calInput.replace(',', '.'));
    if (how === 'meter' && !(reading >= 20 && reading <= 110)) {
      push('Enter the other meter’s reading in dB (20–110)', { icon: 'alert' });
      return;
    }
    const c = how === 'quiet' ? ears.meter.calibrateQuiet(Date.now(), 30) : ears.meter.calibrateTo(reading, Date.now());
    if (!c) {
      push(how === 'quiet' ? 'Keep the room quiet for 10 seconds, then try again' : 'Give the meter a few seconds of sound, then try again', { icon: 'alert' });
      return;
    }
    saveCalibration(c);
    setCal(c);
    setCalOpen(false);
    setCalInput('');
    push('Sound meter calibrated on this phone', { icon: 'check' });
  };

  const motionVal = () => motionRef.current;
  const lightVal = () => lightRef.current;
  dimRef.current = dim;

  const pickCaller = (): { sid: string; who: string } | null => {
    for (const [sid, c] of callersRef.current) if (c.on && c.stream) return { sid, who: c.who };
    return null;
  };

  const onMsg = (m: MonServerMsg) => {
    switch (m.t) {
      case 'hello':
        setNursery({ name: m.nursery.name, baby: m.nursery.baby });
        setViewers(m.viewers);
        hubRef.current?.setIce(m.ice, m.iceMs);
        // A new room connection: full-rate status until it says otherwise (rooms before live_want never do).
        cadenceRef.current.reset();
        void hubRef.current?.setRelayDataOut(m.fair?.level === 'out');
        applySettings(m.settings);
        if (pendingZonesRef.current) {
          sockRef.current?.send({ t: 'settings', zones: { dev: device.id, list: pendingZonesRef.current } });
          pendingZonesRef.current = null;
        }
        flushStats();
        authedRef.current = true;
        syncSounds();
        // Rooms that hand out the nursery key: this phone's keys, then its wrap (or the first epoch).
        void keysReadyRef.current?.then((k) => k?.onHello(m, 'camera'));
        break;
      case 'key_req':
      case 'key_wrap':
      case 'key_rotate':
      case 'key_conflict':
        void keysReadyRef.current?.then((k) => k?.onMessage(m as unknown as { t: string } & Record<string, unknown>));
        break;
      case 'stats_ok':
        statsRef.current = statsRef.current.filter((r) => r.m > m.upto);
        saveJson(statsKey(id), statsRef.current);
        break;
      case 'presence':
        setViewers(m.viewers);
        break;
      case 'ice':
        hubRef.current?.setIce(m.servers, m.iceMs);
        break;
      case 'settings':
        applySettings(m.settings);
        break;
      case 'rtc':
        // Judged with the nursery key once it's loaded (a sealed offer opens; a plain one is refused while it holds one).
        void keysGateRef.current.then(() => hubRef.current?.onSignal(m.from, m.d, m.label || m.name || 'Someone'));
        break;
      case 'peer_gone':
        // Their socket left the room; a call that's still up (same Wi-Fi) carries on.
        hubRef.current?.release(m.sid);
        // A talker whose call is still up is only changing sockets (they say so again on reconnect).
        for (const [key, t] of [...talkersRef.current]) {
          if (t.sid === m.sid && !hubRef.current?.isConnected(key)) talkersRef.current.delete(key);
        }
        setTalkers([...new Set([...talkersRef.current.values()].map((t) => t.who))]);
        break;
      case 'cmd':
        onCmd(m);
        break;
      case 'relay_want':
        setRelay(readWant(m as unknown as Record<string, unknown>));
        break;
      case 'live_want':
        cadenceRef.current.setLive(m.on);
        break;
      case 'fair':
        // Relay data used up: viewers reached through a TURN relay get sound only (the direct picture carries on).
        void hubRef.current?.setRelayDataOut(m.relay.level === 'out');
        break;
      case 'relay_key':
        relayRef.current?.requestKey();
        break;
      case 'error':
        if (m.code !== 'removed') push(m.msg, { icon: 'alert' });
        break;
    }
  };

  const applySettings = (s: MonSettings) => {
    earsRef.current?.setSensitivity(s.sensitivity);
    // Smart vision: before ~5 months a baby can only be lying down.
    if (s.baby) sceneWatchRef.current.setContext({ bornAt: birthAt(s.baby.birth) });
    if (earsRef.current) earsRef.current.noise.threshold = s.noiseDb === undefined ? 70 : s.noiseDb;
    // Zones placed from a parent's phone reach this camera too.
    const z = s.zones?.[device.id];
    if (z && !pendingZonesRef.current) {
      zonesRef.current = z;
      setZones(z);
      visionRef.current.setZones(z);
      sceneWatchRef.current.setZones(z);
      saveJson(zonesKey(id), z);
    }
  };

  const onCmd = (m: Extract<MonServerMsg, { t: 'cmd' }>) => {
    const v = (m.v ?? {}) as Record<string, unknown>;
    // The viewer this is about, even if they're on a new socket since the call started.
    const key = hubRef.current?.keyOf(m.from, v.vid) ?? m.from;
    if (m.c === 'soothe') {
      const kind = (SOOTHE_OPTIONS.find((o) => o.id === v.kind)?.id ?? 'shush') as SootheKind;
      const minutes = Math.min(120, Math.max(1, Number(v.minutes) || 30));
      sootheRef.current.start(kind, minutes, Number(v.volume) || 0.4);
      setSoothing(sootheRef.current.current);
      earsRef.current?.suppress(4000);
      sendEvent({ kind: 'soothe', msg: `${m.by} started ${SOOTHE_OPTIONS.find((o) => o.id === kind)?.label ?? 'soothing sounds'} for ${minutes} min` });
    } else if (m.c === 'soothe_stop') {
      sootheRef.current.stop();
      setSoothing(null);
      sendEvent({ kind: 'soothe', msg: `${m.by} stopped the soothing sounds` });
    } else if (m.c === 'quality') {
      void hubRef.current?.setQuality(key, (['hd', 'sd', 'audio'].includes(String(v.q)) ? v.q : 'hd') as Quality);
    } else if (m.c === 'flip') {
      flip();
    } else if (m.c === 'talk') {
      if (v.on) talkersRef.current.set(key, { who: m.by, sid: m.from });
      else talkersRef.current.delete(key);
      setTalkers([...new Set([...talkersRef.current.values()].map((t) => t.who))]);
      earsRef.current?.setPlayback(talkersRef.current.size > 0);
      // Their voice comes out of this speaker — don't mistake it for the baby.
      // The heartbeat keeps extending this while anyone is still talking.
      earsRef.current?.suppress(v.on ? 3000 : 2000);
    } else if (m.c === 'video') {
      const c = callersRef.current.get(key) ?? { stream: null, who: m.by, on: false };
      c.on = Boolean(v.on);
      c.who = m.by;
      callersRef.current.set(key, c);
      setCaller(pickCaller());
      if (c.on) {
        setDim(false);
        touch();
      }
    }
  };

  /**
   * The relay picture, for viewers who can't get the direct one (their
   * network blocks it, it's still connecting, or the direct slots are full):
   * one small video stream (WebCodecs, 10–15 fps) with the nursery's sound,
   * through the room to all of them — JPEG for browsers that can't decode it.
   * Frames are skipped rather than queued behind a slow upload, and nothing
   * at all is sent while the video is paused for privacy.
   */
  const setRelay = (want: RelayWant) => {
    let enc = relayRef.current;
    if (!enc && want.n > 0) {
      // Sealed with the nursery key when this phone holds it (relayCrypto.ts): the room forwards
      // bytes it can't read. A camera that seals but has no key yet sends nothing until it does.
      const sealer =
        sealerRef.current ??
        new RelaySealer({
          nid: id,
          devId: () => keysRef.current?.devId ?? null,
          key: () => (camLockRef.current.held ? keysRef.current?.sealing() ?? null : null),
          required: () => !!keysRef.current && (keysRef.current.active || keysRef.current.holds()),
          send: (buf, max) => !!sockRef.current?.sendBinary(buf, max),
          buffered: () => sockRef.current?.bufferedAmount() ?? 0,
          onLost: () => relayRef.current?.requestKey(),
        });
      sealerRef.current = sealer;
      enc = new RelayEncoder({
        source: () => videoRef.current,
        send: sealer.send,
        buffered: () => sockRef.current?.bufferedAmount() ?? 0,
        paused: () => privacyRef.current,
        open: () => !!sockRef.current?.open,
      });
      relayRef.current = enc;
    }
    setRelayViewers(want.n);
    if (!enc) return;
    enc.setWant(want);
    // The microphone feeds the relay's sound only while someone is on it.
    earsRef.current?.setRelayTap(enc.active ? (pcm, rate) => relayRef.current?.pushSound(pcm, rate) : null);
  };

  const togglePrivacy = () => {
    const on = !privacyRef.current;
    privacyRef.current = on;
    setPrivacy(on);
    void hubRef.current?.setVideoEnabled(!on);
    sendEvent({ kind: 'privacy', on });
    push(on ? 'Video paused — sound monitoring and alerts continue' : 'Video is back on', { icon: on ? 'eyeOff' : 'eye' });
  };

  const toggleAutoDim = () => {
    const next = !autoDim;
    setAutoDim(next);
    try {
      localStorage.setItem(AUTODIM_KEY, next ? '1' : '0');
    } catch { /* storage unavailable */ }
  };

  const stop = () => {
    stopAll(phase === 'running');
    push('Camera stopped — nothing was recorded', { icon: 'check' });
    nav.nursery(id);
  };

  /* ------------------------------------------------------------- render */

  if (phase === 'check' || phase === 'starting' || phase === 'error') {
    return (
      <div className="cam-setup fade-in">
        <button className="back-link" onClick={() => nav.nursery(id)}><Icon name="arrowLeft" size={15} />Back</button>
        <div className="cam-setup-card">
          <div className="mh-icon"><Icon name="video" size={28} /></div>
          <h1 className="page-title">Make this {device.name} the baby camera</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55 }}>
            It works like a FaceTime call that only your family can join: live video and sound to your devices, your voice and face back to the nursery — and smart alerts for crying, coughing, alarms and more.
          </p>
          <ol className="cam-steps">
            <li><b>Allow camera &amp; microphone</b> — the next screen asks once.</li>
            <li><b>Pick the lens &amp; frame the crib</b> — with a live preview and a quick sound check.</li>
            <li><b>Start monitoring</b> — keep this page open; the screen can go dark.</li>
          </ol>
          {!check.ok && (
            <div className="banner err"><Icon name="alert" size={15} /><span style={{ flex: 1 }}>{check.problem}</span></div>
          )}
          {!check.ok && check.inApp && (
            <Btn variant="soft" icon="copy" onClick={() => void navigator.clipboard?.writeText(location.href).then(() => push('Link copied — paste it into your browser', { icon: 'check' }))}>
              Copy this page’s link
            </Btn>
          )}
          {err && <div className="banner err" role="alert"><Icon name="alert" size={15} /><span style={{ flex: 1 }}>{err}</span></div>}
          <Btn variant="solid" size="lg" icon="video" onClick={() => void startPreview()} disabled={!check.ok || phase === 'starting'} data-tour="cam-allow">
            {phase === 'starting' ? 'Opening the camera…' : err ? 'Try again' : 'Allow camera & microphone'}
          </Btn>
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            <Icon name="shield" size={12} /> Live only — nothing is recorded or stored. The picture and sound go device-to-device, end-to-end encrypted, wherever the network allows.{' '}
            {/* Holding the family's key, this phone only ever sends the server path sealed (relayCrypto.ts) — say so; otherwise, the plain truth. */}
            {keysRef.current?.holds()
              ? 'For a moment while a connection starts, when a network blocks direct video, or when the camera is full, they pass through our server instead: in memory only, never stored, and end-to-end encrypted with your family’s key — our server passes them along without being able to see or hear them.'
              : 'For a moment while a connection starts, when a network blocks direct video, or when the camera is full, they pass through our server instead: in memory only, never stored, not end-to-end encrypted.'}
          </p>
        </div>
      </div>
    );
  }

  const info = STATE_INFO[snap.mood as BabyState];
  const soundInfo = snap.sound ? SOUND_INFO[snap.sound] : null;
  const showCaller = phase === 'running' && caller && callersRef.current.get(caller.sid)?.stream;
  const dark = light < 35;
  const db = snap.spl ? Math.round(snap.spl.db) : null;
  const band = db != null ? LEVEL_BAND_INFO[levelBand(db)] : null;
  const dbText = db != null ? `${cal ? '' : '≈'}${db} dB` : '—';
  const crib = zones.find((z) => z.kind === 'crib');
  const dangerN = zones.filter((z) => z.kind === 'danger').length;
  const playN = zones.filter((z) => z.kind === 'activity').length;
  const zoneSummary = crib || dangerN || playN
    ? `${crib ? 'Crib marked' : 'No crib yet'}${dangerN ? ` · ${dangerN} danger zone${dangerN === 1 ? '' : 's'}` : ''}${playN ? ` · ${playN} play area${playN === 1 ? '' : 's'}` : ''}`
    : 'Optional — mark the crib for sleep tracking and climb-out alerts';

  const zoneEditor = zoneEdit && (
    <ZoneEditor stream={streamRef.current} mirror={facing === 'user'} zones={zones} onSave={saveZoneList} onClose={() => setZoneEdit(false)} babyName={nursery.baby} />
  );

  const calPanel = calOpen && (
    <div className="cam-cal fade-in">
      <p>Every phone’s microphone is a little different, so the meter starts approximate. Calibrate it once on this phone:</p>
      <div className="cam-cal-row">
        <Btn variant="soft" size="sm" icon="moon" onClick={() => calibrate('quiet')}>The room is quiet now</Btn>
        <span className="faint">sets a quiet bedroom to 30 dB</span>
      </div>
      <div className="cam-cal-row">
        <input className="input" inputMode="decimal" placeholder="e.g. 42" value={calInput} onChange={(e) => setCalInput(e.target.value)} aria-label="Reading on another sound meter, dB" />
        <span className="faint">dB on another meter, held next to this phone</span>
        <Btn variant="soft" size="sm" onClick={() => calibrate('meter')} disabled={!calInput.trim()}>Match</Btn>
      </div>
      {cal && <Btn variant="subtle" size="sm" onClick={() => calibrate('reset')}>Reset to automatic</Btn>}
    </div>
  );

  if (phase === 'setup') {
    const checks: { k: string; ok: boolean | null; label: string; sub: string }[] = [
      { k: 'cam', ok: true, label: 'Camera', sub: `${lenses.find((l) => l.id === lensId)?.label ?? (facing === 'user' ? 'Front camera' : 'Back camera')}${res ? ` · ${res}` : ''}` },
      { k: 'mic', ok: heard ? true : null, label: 'Microphone', sub: heard ? 'Hears the room clearly' : 'Make a sound — clap or say hello' },
      {
        k: 'ai', ok: model.s === 'ready' ? true : model.s === 'failed' ? false : null, label: 'Smart sound detection',
        sub: model.s === 'ready' ? 'On — recognizes crying, fussing, coughing, alarms & more' : model.s === 'failed' ? 'Unavailable on this device — basic cry detection is on' : `Getting ready${model.p ? ` · ${Math.round(model.p * 100)}%` : '…'} (one-time 16 MB download)`,
      },
      { k: 'light', ok: dark ? false : true, label: 'Light', sub: dark ? 'Room is dark — viewers can use Night view; a dim night-light helps a lot' : 'Good' },
      {
        k: 'power', ok: power.charging === true ? true : power.charging === false ? false : null, label: 'Power',
        sub: power.charging === true ? `Charging${power.level != null ? ` · ${power.level}%` : ''}` : power.charging === false ? `On battery${power.level != null ? ` (${power.level}%)` : ''} — plug it in for overnight monitoring` : 'Keep it plugged in for overnight monitoring',
      },
      { k: 'awake', ok: wake !== 'none', label: 'Screen stays on', sub: wake !== 'none' ? 'This phone won’t lock while it’s the camera (the screen can still dim)' : `This phone may lock and pause the video. ${keepAwakeAdvice()}` },
      { k: 'net', ok: networkHint().online ? !networkHint().slow : false, label: 'Network', sub: !networkHint().online ? 'Offline — connect to Wi-Fi' : networkHint().slow ? 'Slow connection — Wi-Fi is better' : networkHint().type === 'cellular' ? 'Mobile data — Wi-Fi is better overnight' : 'Connected' },
    ];
    return (
      <div className="cam-run cam-setup-run" onPointerDown={touch}>
        <video ref={videoRef} className={cx('cam-video', facing === 'user' && 'mirror')} autoPlay muted playsInline />
        <div className="cam-top">
          <button className="cam-round sm" onClick={stop} aria-label="Cancel"><Icon name="x" size={18} /></button>
          <span className="cam-norec"><Icon name="shield" size={12} />Preview · not live yet</span>
          <span className="spacer" />
          <HelpButton className="cam-round sm" />
        </div>
        <div className="cam-sheet fade-in" data-tour="cam-setup">
          <div className="cam-sheet-head">
            <b>Set up the camera</b>
            <span className="faint">Point it at the crib, then start.</span>
          </div>
          <div className="cam-lenses" data-tour="cam-lens">
            {(lenses.length ? lenses : [{ id: '', label: facing === 'user' ? 'Front camera' : 'Back camera', facing, rank: 0 } as Lens]).map((l) => (
              <button key={l.id || l.label} className={cx('cam-chip', (l.id ? l.id === lensId : true) && 'sel')} onClick={() => l.id && l.id !== lensId && void useLens({ id: l.id, facing: l.facing ?? facing })}>
                <Icon name="video" size={13} />{l.label}
              </button>
            ))}
            {lenses.length > 1 && <button className="cam-chip" onClick={flip} aria-label="Flip camera"><Icon name="flip" size={13} />Flip</button>}
          </div>
          {zoom && (
            <label className="cam-zoom">
              <Icon name="zoomIn" size={15} />
              <input type="range" className="slider" min={zoom.min} max={zoom.max} step={zoom.step} value={zoomVal}
                style={{ '--pct': `${((zoomVal - zoom.min) / (zoom.max - zoom.min)) * 100}%` } as React.CSSProperties}
                onChange={(e) => onZoom(Number(e.target.value))} aria-label="Zoom" />
              <span className="mono">{zoomVal.toFixed(1)}×</span>
            </label>
          )}
          <div className="cam-checks" data-tour="cam-checks">
            {(() => {
              const passed = checks.filter((c) => c.ok === true).length;
              return (
                <button className={cx('cam-check-summary', passed === checks.length && 'ok')} onClick={() => setChecksOpen((o) => !o)} aria-expanded={checksOpen}>
                  <span className="cam-check-dot">{passed === checks.length ? <Icon name="check" size={12} stroke={2.4} /> : passed}</span>
                  <span>{passed === checks.length ? 'Everything looks good' : `${passed} of ${checks.length} checks passed`}</span>
                  <Meter value={snap.level} max={40} tone={snap.level > 24 ? 'live' : snap.level > 12 ? 'amber' : 'green'} />
                  <Icon name="chevronDown" size={14} />
                </button>
              );
            })()}
            {checks.filter((c) => checksOpen || c.ok !== true).map((c) => (
              <div key={c.k} className={cx('cam-check', c.ok === true && 'ok', c.ok === false && 'bad')}>
                <span className="cam-check-dot">{c.ok === true ? <Icon name="check" size={12} stroke={2.4} /> : c.ok === false ? '!' : ''}</span>
                <div>
                  <b>{c.label}</b>
                  <span>{c.sub}</span>
                  {c.k === 'mic' && <Meter value={snap.level} max={40} tone={snap.level > 24 ? 'live' : snap.level > 12 ? 'amber' : 'green'} />}
                </div>
              </div>
            ))}
          </div>
          <div className="cam-extras">
            <div className="cam-extras-title">Make it smarter <span className="faint">· optional</span></div>
            <button className="cam-extra" onClick={() => setZoneEdit(true)} data-tour="cam-zones">
              <Icon name="target" size={16} />
              <span><b>Crib, danger zones &amp; play areas</b><small>{zoneSummary}</small></span>
              <Icon name="chevronRight" size={14} />
            </button>
            <button className="cam-extra" onClick={() => setCalOpen((o) => !o)} aria-expanded={calOpen} data-tour="cam-meter">
              <Icon name="gauge" size={16} />
              <span><b>Sound level meter</b><small>{band ? `${band.label} — ${band.like}` : 'Starting…'}{cal ? ' · calibrated' : ' · approximate until calibrated'}</small></span>
              <span className={cx('db-pill', band && `t-${band.tone}`)}>{dbText}</span>
            </button>
            {calPanel}
            <button className="cam-extra" onClick={toggleScene} aria-pressed={sceneOn} data-tour="cam-scene">
              <Icon name="sparkles" size={16} />
              <span>
                <b>Smart vision <span className="beta-tag">beta</span></b>
                <small>
                  {sceneOn
                    ? 'Posture, rolling over, what’s in hand or within reach, play areas — worked out on this phone. Uses more battery.'
                    : 'Off — turn on to see posture, rolling over, objects within reach and play areas'}
                </small>
              </span>
              <span className={cx('tog-pill', sceneOn && 'on')}>{sceneOn ? 'On' : 'Off'}</span>
            </button>
          </div>
          <button className="cam-tips-toggle" onClick={() => setTipsOpen((o) => !o)} aria-expanded={tipsOpen}>
            <Icon name="checklist" size={15} />Placement &amp; safety tips<Icon name="chevronDown" size={14} />
          </button>
          {tipsOpen && (
            <ul className="cam-tips">
              <li><Icon name="check" size={14} />1–2 m (3–6 ft) from the crib, higher than the mattress, pointing down at the baby.</li>
              <li><Icon name="check" size={14} />Phone and cable at least 1 m (3 ft) out of reach of the crib — never on or in it.</li>
              <li><Icon name="check" size={14} />Use the back camera for the sharpest picture; the front camera lets the baby see you during a video call.</li>
              <li><Icon name="check" size={14} />Plugged in, on Wi-Fi, with Do Not Disturb or Low Power Mode OFF.</li>
              <li><Icon name="shield" size={14} />Not a medical device: it doesn’t monitor breathing or safe sleep.</li>
            </ul>
          )}
          <Btn variant="solid" size="lg" icon="broadcast" onClick={goLive} data-tour="cam-start">Start monitoring</Btn>
        </div>
        {zoneEditor}
      </div>
    );
  }

  // ---- running
  const talkLine = talkers.length ? `${talkers.join(' & ')} ${talkers.length > 1 ? 'are' : 'is'} talking` : null;
  // Viewers on the relay picture aren't "connecting" — they're watching through the server
  // (those only bridging while their direct picture connects still are, but count as through it).
  const watching = watchersNote({ viewers: viewers.length, direct: p2pCount, onRelay: viewers.filter((v) => v.relay).length, relayed: relayViewers, jpeg: relayMode === 'jpeg', sound: relayMode === 'sound' });
  const busy = (hubRef.current?.pressure ?? 0) > 0;
  // How the picture through our server goes now: sealed with the family's key, plain (a room without the key), or waiting for the key.
  const relaySeal = relayRef.current?.active ? (sealerRef.current?.mode ?? 'plain') : 'plain';
  return (
    <div className={cx('cam-run', dim && 'dimmed')} onPointerDown={touch}>
      {showCaller ? (
        <>
          <video ref={callerRef} className="cam-video cover" autoPlay muted playsInline />
          <video ref={videoRef} className={cx('cam-pip', facing === 'user' && 'mirror')} autoPlay muted playsInline />
        </>
      ) : (
        <video ref={videoRef} className={cx('cam-video', facing === 'user' && 'mirror', privacy && 'blurred')} autoPlay muted playsInline />
      )}

      {dim && (
        <button className="cam-dim" onClick={() => { setDim(false); touch(); }} aria-label="Wake the screen">
          <span className={cx('state-dot', `tone-${info.tone}`)} />
          <span>{new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <small>Monitoring {nursery.baby ? nursery.baby : 'the nursery'} · {info.label} · tap to wake</small>
        </button>
      )}

      <div className="cam-top">
        <Pill tone={sock === 'connected' || p2pCount > 0 ? 'live' : 'warn'} dot pulse={sock === 'connected'}>
          {sock === 'connected' ? 'MONITORING' : p2pCount > 0 ? `ON WI-FI · ${p2pCount} WATCHING` : sock === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING'}
        </Pill>
        <span className="cam-norec"><Icon name="shield" size={12} />Not recording</span>
        <span className="spacer" />
        <span className="cam-viewers" title={viewers.map((v) => v.label || v.name).join(', ')}>
          <Icon name="eye" size={13} />{viewers.length}
        </span>
        <HelpButton className="cam-round sm" />
      </div>

      {hiddenWarn && (
        <div className="banner warn cam-warn">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1 }}>This page was in the background — phones pause the camera there. Keep Stream Studio open on this phone (the screen can be dark).</span>
          <button className="iconbtn" onClick={() => setHiddenWarn(false)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}
      {sock === 'reconnecting' && sockNote === CLOSE_TEXT.mfa_required && (
        <div className="banner warn cam-warn" role="alert">
          <Icon name="lock" size={15} />
          <span style={{ flex: 1 }}>Your nursery asks for the code from your authenticator app before this camera reconnects. Sound detection keeps running on this phone, but alerts can’t reach anyone until it does.</span>
          <Btn variant="soft" size="sm" onClick={() => void stepUp().then((ok) => ok && sockRef.current?.reconnect())}>Enter code</Btn>
        </div>
      )}
      {interrupted && !privacy && (
        <button className="cam-interrupt" onClick={() => void recover()}>
          <Icon name="videoOff" size={22} />
          <b>Camera paused by the phone</b>
          <span>A call or another app took the camera. Tap to resume — sound monitoring is still on.</span>
        </button>
      )}
      {privacy && (
        <div className="cam-privacy">
          <Icon name="eyeOff" size={22} />
          <b>Video paused for privacy</b>
          <span>Sound monitoring and alerts continue.</span>
          <Btn variant="solid" size="sm" icon="eye" onClick={togglePrivacy}>Resume video</Btn>
        </div>
      )}
      {(talkLine || showCaller) && (
        <div className="cam-talk" aria-live="polite">
          <span className="talk-wave" aria-hidden><i /><i /><i /><i /></span>
          {showCaller ? `${caller!.who} is on video` : talkLine}
        </div>
      )}

      <div className="cam-panel">
        <div className="cam-state">
          <span className={cx('state-dot', `tone-${info.tone}`)} />
          <b>{info.label}</b>
          {soundInfo && <span className="cam-hear"><Icon name={soundInfo.icon} size={13} />{soundInfo.label}</span>}
          <span className="spacer" />
          <span className={cx('cam-ai', snap.model === 'ready' && 'on')} title={snap.model === 'ready' ? 'Smart sound detection is on' : snap.model === 'failed' ? 'Basic cry detection (smart detection unavailable)' : 'Smart sound detection is getting ready'}>
            <Icon name="ear" size={12} />{snap.model === 'ready' ? 'Smart ears' : snap.model === 'failed' ? 'Basic ears' : 'Loading ears'}
          </span>
        </div>
        <div className="cam-meters">
          <label>
            <span className="cam-meter-label">Sound{db != null && <b className={cx('db-val', band && `t-${band.tone}`)}>{dbText}</b>}</span>
            {db != null
              ? <Meter value={Math.max(0, db - 25)} max={65} tone={db >= 80 ? 'live' : db >= 60 ? 'amber' : 'green'} />
              : <Meter value={snap.level} max={45} tone={snap.level > 24 ? 'live' : snap.level > 12 ? 'amber' : 'green'} />}
          </label>
          <label>Motion<Meter value={motion} max={100} tone={motion > 35 ? 'amber' : 'green'} /></label>
        </div>
        <div className="cam-links">
          <button onClick={() => setZoneEdit(true)}><Icon name="target" size={13} />{crib ? `Zones · ${1 + dangerN}` : 'Mark the crib'}</button>
          <button onClick={() => setCalOpen((o) => !o)} aria-expanded={calOpen}><Icon name="gauge" size={13} />{cal ? 'Meter calibrated' : 'Calibrate meter'}</button>
        </div>
        {calPanel}
        {soothing && (
          <div className="cam-soothe">
            <Icon name="music" size={15} />
            {SOOTHE_OPTIONS.find((o) => o.id === soothing.kind)?.label} · {Math.max(0, Math.ceil((soothing.endsAt - Date.now()) / 60_000))} min left
            <span className="spacer" />
            <Btn variant="subtle" size="sm" onClick={() => { sootheRef.current.stop(); setSoothing(null); }}>Stop</Btn>
          </div>
        )}
        <div className="cam-watchers" aria-live="polite">
          <Icon name="users" size={14} />
          {viewers.length === 0
            ? 'No one is watching right now — alerts still go out'
            : <>Watching: {viewers.map((v) => v.label || v.name).join(', ')}{watching}</>}
        </div>
        {relayViewers > 0 && relaySeal === 'sealed' && (
          <div className="cam-watchers cam-e2e" role="status">
            <Icon name="lock" size={14} />
            <span>The picture through our server is end-to-end encrypted with your family’s key: the server passes it along without being able to see or hear it, and never stores it.</span>
          </div>
        )}
        {relayViewers > 0 && relaySeal === null && (
          <div className="cam-watchers cam-e2e" role="status">
            <Icon name="lock" size={14} />
            <span>Getting this phone your family’s key — the picture through our server waits for it. Sound alerts are unaffected.</span>
          </div>
        )}
        {busy && (
          <div className="cam-busy" role="status">
            <Icon name="gauge" size={14} />
            <span>This phone is busy, so viewers get a smaller picture.{sceneOn ? '' : ' Plugging it in and closing other apps helps.'}</span>
            {sceneOn && <button className="cam-busy-act" onClick={toggleScene}>Turn off Smart vision</button>}
          </div>
        )}
        <div className="cam-controls">
          {lenses.length > 1 && (
            <button className="cam-round" onClick={flip} aria-label="Flip camera"><Icon name="flip" size={20} /><span>Flip</span></button>
          )}
          <button className={cx('cam-round', privacy && 'on')} onClick={togglePrivacy} aria-label={privacy ? 'Resume video' : 'Pause video'}>
            <Icon name={privacy ? 'eye' : 'eyeOff'} size={20} /><span>{privacy ? 'Video on' : 'Privacy'}</span>
          </button>
          <button className="cam-round" onClick={() => setDim(true)} onDoubleClick={toggleAutoDim} aria-label="Dim the screen">
            <Icon name="moon" size={20} /><span>{autoDim ? 'Dim · auto' : 'Dim'}</span>
          </button>
          <button className="cam-round end" onClick={stop} aria-label="Stop camera"><Icon name="stop" size={20} /><span>Stop</span></button>
        </div>
        <button className="cam-autodim" onClick={toggleAutoDim}>
          {autoDim ? 'Screen dims by itself after 90 s — tap to keep it on' : 'Screen stays on — tap to let it dim by itself'}
        </button>
      </div>
      {zoneEditor}
    </div>
  );
}
