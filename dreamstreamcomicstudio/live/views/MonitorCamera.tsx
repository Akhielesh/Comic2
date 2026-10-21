// Baby Monitor — CAMERA mode (the phone in the nursery).
//
// A FaceTime-grade camera: real lenses (back, ultra-wide, front) with live
// preview, zoom, flip, two-way audio (parents' voices play on this speaker)
// and parents' video calls shown full-screen. Live only, never recorded:
// video/audio go peer-to-peer (encrypted) to the family's devices. All sound
// and motion analysis — including the AI sound model — runs on this phone;
// only events and a few numbers go to the room.
import React, { useEffect, useRef, useState } from 'react';
import {
  checkBrowser, dropAudioEl, listLenses, mediaErrorText, networkHint, openMedia, openVideoOnly, preferSpeaker, remoteAudioEl,
  setZoom, watchPower, zoomRange, MIC_CONSTRAINTS, type BrowserCheck, type Facing, type Lens, type PowerState, type ZoomRange,
} from '../monitor/camera';
import { getDevice, openMonitorSocket, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { STATE_INFO, STATE_RANK, type BabyState, type MonServerMsg, type MonSettings, type ViewerPresence } from '../monitor/protocol';
import { CameraHub, type Quality } from '../monitor/rtc';
import type { BrainEvent } from '../monitor/soundBrain';
import { SOUND_INFO, type SoundCat } from '../monitor/soundClasses';
import { NurseryEars, type EarsSnapshot, type ModelState } from '../monitor/soundEngine';
import { LEVEL_BAND_INFO, levelBand, loadCalibration, saveCalibration, type Calibration, type MinuteLevels } from '../monitor/soundLevel';
import { FRAME_H, FRAME_W, VisionWatch, type VisionEvent, type Zone } from '../monitor/vision';
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
  // One stable listener (added/removed by identity) — it only touches refs.
  const [onTilt] = useState(() => (e: DeviceOrientationEvent) => {
    for (const ev of visionRef.current.pushTilt(e.beta, e.gamma, Date.now())) {
      sockRef.current?.send({ t: 'event', kind: 'vision', type: ev.type, via: ev.via });
    }
  });
  const sootheRef = useRef(new SoothePlayer());
  const wakeRef = useRef(new ScreenWakeLock());
  const tickersRef = useRef<Ticker[]>([]);
  const talkElsRef = useRef(new Map<string, HTMLAudioElement>());
  const callersRef = useRef(new Map<string, { stream: MediaStream | null; who: string; on: boolean }>());
  const relayTimerRef = useRef<number | undefined>(undefined);
  const lensRef = useRef(loadLens());
  const powerRef = useRef<PowerState>({ level: null, charging: null });
  const unwatchPowerRef = useRef<() => void>(() => undefined);
  const lastBatteryAlertRef = useRef(0);
  const motionRunRef = useRef<{ since: number | null; lastEvent: number }>({ since: null, lastEvent: 0 });
  const talkersRef = useRef(new Map<string, string>());
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
  const [nursery, setNursery] = useState<{ name: string; baby: string | null }>({ name: 'Nursery', baby: null });
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [p2pCount, setP2pCount] = useState(0);
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
  const device = getDevice();
  useFirstVisitTour('camera', phase === 'setup');

  /* ---------------------------------------------------------- lifecycle */

  const stopAll = (sayBye: boolean) => {
    if (sayBye) sockRef.current?.send({ t: 'bye' });
    tickersRef.current.forEach((t) => t.stop());
    tickersRef.current = [];
    window.clearInterval(relayTimerRef.current);
    hubRef.current?.closeAll();
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
    const t = window.setInterval(() => setClock((n) => n + 1), 1000);
    const onVis = () => {
      if (document.visibilityState === 'hidden' && phase === 'running') {
        setHiddenWarn(true);
        // Say so now — a locked phone may stop running this page any second.
        sockRef.current?.send({ t: 'event', kind: 'paused', why: 'hidden' });
      }
      if (document.visibilityState === 'visible') {
        if (phase === 'running') sockRef.current?.send({ t: 'event', kind: 'resumed' });
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
        sockRef.current?.send({ t: 'event', kind: 'noise', type: e.type, phase: e.phase, db: e.db, secs: e.secs, cal: ears.meter.calibrated });
        hubRef.current?.direct({ t: 'ev', kind: 'noise', type: e.type, phase: e.phase, db: e.db, secs: e.secs, at: Date.now(), dev: device.id });
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
      for (const sid of talkersRef.current.keys()) sockRef.current?.send({ t: 'tell', to: sid, c: 'feedback', v: { freq: h.freq } });
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
    tickersRef.current.push(
      startTicker(250, () => {
        const v = videoRef.current;
        if (!c2d || !v || v.readyState < 2 || privacyRef.current) return;
        c2d.drawImage(v, 0, 0, FRAME_W, FRAME_H);
        const now = Date.now();
        const r = vision.push(c2d.getImageData(0, 0, FRAME_W, FRAME_H).data, now);
        earsRef.current?.setMotion(r.frame.motion);
        visionNowRef.current = { crib: r.frame.crib, outside: r.frame.outside, visit: vision.inVisit };
        if (frameN++ % 2 === 0) {
          setMotion(r.frame.motion);
          setLight(r.frame.light);
        }
        for (const e of r.events) sendVision(e);
        const run = motionRunRef.current;
        if (r.frame.motion > 35 && !vision.inVisit) {
          run.since ??= now;
          if (now - run.since > 5000 && now - run.lastEvent > 10 * 60_000) {
            run.lastEvent = now;
            sockRef.current?.send({ t: 'event', kind: 'motion' });
          }
        } else run.since = null;
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
        setSnap(s);
        if (s.level >= 12) setHeard(true);
      }),
    );

    unwatchPowerRef.current = await watchPower((p) => {
      powerRef.current = p;
      setPower(p);
      if (p.charging === false && p.level != null && p.level <= 20 && Date.now() - lastBatteryAlertRef.current > 30 * 60_000) {
        lastBatteryAlertRef.current = Date.now();
        sockRef.current?.send({ t: 'event', kind: 'battery', pct: p.level });
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
    hub.onCount = setP2pCount;
    hub.onTalk = (sid, s) => {
      let el = talkElsRef.current.get(sid);
      if (!s) {
        dropAudioEl(el);
        talkElsRef.current.delete(sid);
        return;
      }
      if (!el) {
        el = remoteAudioEl();
        el.volume = 0.85; // moderate start (ignored on iPhone — the parent's phone shapes the voice there)
        talkElsRef.current.set(sid, el);
      }
      el.srcObject = s;
      void el.play().catch(() => undefined);
    };
    hub.onCallerVideo = (sid, s, who) => {
      const cur = callersRef.current.get(sid);
      if (!s) {
        callersRef.current.delete(sid);
        setCaller((c) => (c?.sid === sid ? pickCaller() : c));
        return;
      }
      callersRef.current.set(sid, { stream: s, who, on: cur?.on ?? false });
    };
    hubRef.current = hub;

    sockRef.current = openMonitorSocket(id, 'camera', onMsg, () => undefined, (st, detail) => {
      setSock(st);
      if (st !== 'connected') authedRef.current = false;
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
            for (const sid of talkersRef.current.keys()) sockRef.current?.send({ t: 'tell', to: sid, c: 'talk_gain', v: { factor: f, db: Math.round(lv) } });
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
        const talkNames = [...talkersRef.current.values()];
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
        };
        sockRef.current?.send({ t: 'status', st });
        // Straight to viewers too — over the home Wi-Fi this keeps working when the internet doesn't.
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
    // Viewers on the same Wi-Fi hear about it directly, room or no room.
    if (!replay) hubRef.current?.direct({ t: 'ev', kind: 'sound', cat: e.cat, phase: e.phase, conf: e.conf, secs: e.secs, at: Date.now(), dev: device.id });
    if (!authedRef.current) return;
    sockRef.current?.send({ t: 'event', kind: 'sound', cat: e.cat, phase: e.phase, conf: e.conf, secs: e.secs, via: e.via });
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

  const sendVision = (e: VisionEvent) => {
    hubRef.current?.direct({ t: 'ev', kind: 'vision', type: e.type, at: Date.now(), dev: device.id });
    sockRef.current?.send({ t: 'event', kind: 'vision', type: e.type, zone: e.zone, name: e.name, secs: e.secs, via: e.via });
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

  const motionNow = useRef(0);
  const lightNow = useRef(128);
  motionNow.current = motion;
  lightNow.current = light;
  const motionVal = () => motionNow.current;
  const lightVal = () => lightNow.current;

  const pickCaller = (): { sid: string; who: string } | null => {
    for (const [sid, c] of callersRef.current) if (c.on && c.stream) return { sid, who: c.who };
    return null;
  };

  const onMsg = (m: MonServerMsg) => {
    switch (m.t) {
      case 'hello':
        setNursery({ name: m.nursery.name, baby: m.nursery.baby });
        setViewers(m.viewers);
        hubRef.current?.setIce(m.ice);
        applySettings(m.settings);
        if (pendingZonesRef.current) {
          sockRef.current?.send({ t: 'settings', zones: { dev: device.id, list: pendingZonesRef.current } });
          pendingZonesRef.current = null;
        }
        flushStats();
        authedRef.current = true;
        syncSounds();
        break;
      case 'stats_ok':
        statsRef.current = statsRef.current.filter((r) => r.m > m.upto);
        saveJson(statsKey(id), statsRef.current);
        break;
      case 'presence':
        setViewers(m.viewers);
        break;
      case 'settings':
        applySettings(m.settings);
        break;
      case 'rtc':
        void hubRef.current?.onSignal(m.from, m.d, m.label || m.name || 'Someone');
        break;
      case 'peer_gone':
        // Their socket left the room; a call that's still up (same Wi-Fi) carries on.
        hubRef.current?.release(m.sid);
        if (talkersRef.current.delete(m.sid)) setTalkers([...talkersRef.current.values()]);
        break;
      case 'cmd':
        onCmd(m);
        break;
      case 'relay_want':
        setRelay(m.n > 0);
        break;
      case 'error':
        if (m.code !== 'removed') push(m.msg, { icon: 'alert' });
        break;
    }
  };

  const applySettings = (s: MonSettings) => {
    earsRef.current?.setSensitivity(s.sensitivity);
    if (earsRef.current) earsRef.current.noise.threshold = s.noiseDb === undefined ? 70 : s.noiseDb;
    // Zones placed from a parent's phone reach this camera too.
    const z = s.zones?.[device.id];
    if (z && !pendingZonesRef.current) {
      zonesRef.current = z;
      setZones(z);
      visionRef.current.setZones(z);
      saveJson(zonesKey(id), z);
    }
  };

  const onCmd = (m: Extract<MonServerMsg, { t: 'cmd' }>) => {
    const v = (m.v ?? {}) as Record<string, unknown>;
    if (m.c === 'soothe') {
      const kind = (SOOTHE_OPTIONS.find((o) => o.id === v.kind)?.id ?? 'shush') as SootheKind;
      const minutes = Math.min(120, Math.max(1, Number(v.minutes) || 30));
      sootheRef.current.start(kind, minutes, Number(v.volume) || 0.4);
      setSoothing(sootheRef.current.current);
      earsRef.current?.suppress(4000);
      sockRef.current?.send({ t: 'event', kind: 'soothe', msg: `${m.by} started ${SOOTHE_OPTIONS.find((o) => o.id === kind)?.label ?? 'soothing sounds'} for ${minutes} min` });
    } else if (m.c === 'soothe_stop') {
      sootheRef.current.stop();
      setSoothing(null);
      sockRef.current?.send({ t: 'event', kind: 'soothe', msg: `${m.by} stopped the soothing sounds` });
    } else if (m.c === 'quality') {
      void hubRef.current?.setQuality(m.from, (['hd', 'sd', 'audio'].includes(String(v.q)) ? v.q : 'hd') as Quality);
    } else if (m.c === 'flip') {
      flip();
    } else if (m.c === 'talk') {
      if (v.on) talkersRef.current.set(m.from, m.by);
      else talkersRef.current.delete(m.from);
      setTalkers([...talkersRef.current.values()]);
      earsRef.current?.setPlayback(talkersRef.current.size > 0);
      // Their voice comes out of this speaker — don't mistake it for the baby.
      // The heartbeat keeps extending this while anyone is still talking.
      earsRef.current?.suppress(v.on ? 3000 : 2000);
    } else if (m.c === 'video') {
      const c = callersRef.current.get(m.from) ?? { stream: null, who: m.by, on: false };
      c.on = Boolean(v.on);
      c.who = m.by;
      callersRef.current.set(m.from, c);
      setCaller(pickCaller());
      if (c.on) {
        setDim(false);
        touch();
      }
    }
  };

  const setRelay = (on: boolean) => {
    window.clearInterval(relayTimerRef.current);
    if (!on) return;
    const canvas = document.createElement('canvas');
    relayTimerRef.current = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || privacyRef.current) return;
      const w = 480;
      const h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 270;
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(v, 0, 0, w, h);
      canvas.toBlob((b) => b && sockRef.current?.sendBinary(b), 'image/jpeg', 0.6);
    }, 1000);
  };

  const togglePrivacy = () => {
    const on = !privacyRef.current;
    privacyRef.current = on;
    setPrivacy(on);
    void hubRef.current?.setVideoEnabled(!on);
    sockRef.current?.send({ t: 'event', kind: 'privacy', on });
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
            <Icon name="shield" size={12} /> Live only. Nothing is recorded or stored — the picture goes straight to your family’s devices, encrypted.
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
  const zoneSummary = crib || dangerN
    ? `${crib ? 'Crib marked' : 'No crib yet'}${dangerN ? ` · ${dangerN} danger zone${dangerN === 1 ? '' : 's'}` : ''}`
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
              <span><b>Crib &amp; danger zones</b><small>{zoneSummary}</small></span>
              <Icon name="chevronRight" size={14} />
            </button>
            <button className="cam-extra" onClick={() => setCalOpen((o) => !o)} aria-expanded={calOpen} data-tour="cam-meter">
              <Icon name="gauge" size={16} />
              <span><b>Sound level meter</b><small>{band ? `${band.label} — ${band.like}` : 'Starting…'}{cal ? ' · calibrated' : ' · approximate until calibrated'}</small></span>
              <span className={cx('db-pill', band && `t-${band.tone}`)}>{dbText}</span>
            </button>
            {calPanel}
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
            : <>Watching: {viewers.map((v) => v.label || v.name).join(', ')}{p2pCount < viewers.length ? ' · connecting…' : ''}</>}
        </div>
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
