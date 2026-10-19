// Baby Monitor — CAMERA mode (the phone in the nursery).
// Live only, never recorded: video/audio go peer-to-peer (encrypted) to the
// family's devices. Cry, sound and motion analysis run right here on this
// phone; only small status numbers and events go to the room.
import React, { useEffect, useRef, useState } from 'react';
import { CryDetector, analyzeFrame, type DetectorState } from '../monitor/cryDetector';
import { getDevice, openMonitorSocket, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { MotionTracker } from '../monitor/motion';
import { STATE_INFO, type BabyState, type MonServerMsg, type MonSettings, type ViewerPresence } from '../monitor/protocol';
import { CameraHub, type Quality } from '../monitor/rtc';
import { SOOTHE_OPTIONS, SoothePlayer, type SootheKind } from '../monitor/soothe';
import { startTicker, type Ticker } from '../studio/ticker';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Btn, Meter, Pill, cx, type PushToast } from '../ui/primitives';
import { ScreenWakeLock } from '../wakeLock';
import { MonitorGate } from './MonitorHome';

type BatteryLike = { level: number; charging: boolean; addEventListener(t: string, f: () => void): void };

export function MonitorCamera({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  return (
    <MonitorGate>
      <CameraInner id={id} nav={nav} push={push} />
    </MonitorGate>
  );
}

function CameraInner({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sockRef = useRef<MonitorSocket | null>(null);
  const hubRef = useRef<CameraHub | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const detectorRef = useRef(new CryDetector('medium'));
  const motionRef = useRef(new MotionTracker());
  const sootheRef = useRef(new SoothePlayer());
  const wakeRef = useRef(new ScreenWakeLock());
  const tickersRef = useRef<Ticker[]>([]);
  const talkElsRef = useRef(new Map<string, HTMLAudioElement>());
  const relayTimerRef = useRef<number | undefined>(undefined);
  const facingRef = useRef<'environment' | 'user'>('environment');
  const batteryRef = useRef<{ level: number | null; charging: boolean | null }>({ level: null, charging: null });
  const lastBatteryAlertRef = useRef(0);
  const motionRunRef = useRef<{ since: number | null; lastEvent: number }>({ since: null, lastEvent: 0 });
  const cryStartRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<'ready' | 'starting' | 'running' | 'error'>('ready');
  const [err, setErr] = useState<string | null>(null);
  const [sock, setSock] = useState<MonSocketStatus>('connecting');
  const [nurseryName, setNurseryName] = useState('Nursery');
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [p2pCount, setP2pCount] = useState(0);
  const [state, setState] = useState<BabyState>('calm');
  const [level, setLevel] = useState(0);
  const [motion, setMotion] = useState(0);
  const [light, setLight] = useState(128);
  const [talking, setTalking] = useState<string | null>(null);
  const [soothing, setSoothing] = useState<{ kind: SootheKind; endsAt: number } | null>(null);
  const [dim, setDim] = useState(false);
  const [hiddenWarn, setHiddenWarn] = useState(false);
  const [, setClock] = useState(0);
  const device = getDevice();

  const live = useRef({ level: 0, motion: 0, light: 128, det: 'calm' as DetectorState, cry: 0 });

  const stopAll = (sayBye: boolean) => {
    if (sayBye) sockRef.current?.send({ t: 'bye' });
    tickersRef.current.forEach((t) => t.stop());
    tickersRef.current = [];
    window.clearInterval(relayTimerRef.current);
    hubRef.current?.closeAll();
    window.setTimeout(() => sockRef.current?.close(), sayBye ? 300 : 0);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void audioCtxRef.current?.close().catch(() => undefined);
    sootheRef.current.close();
    for (const a of talkElsRef.current.values()) a.srcObject = null;
    talkElsRef.current.clear();
    void wakeRef.current.disable();
  };

  useEffect(() => () => stopAll(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The preview <video> only mounts once running — attach the stream then.
  useEffect(() => {
    const v = videoRef.current;
    if (phase === 'running' && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => undefined);
    }
  }, [phase, dim]);

  useEffect(() => {
    const t = window.setInterval(() => setClock((c) => c + 1), 1000);
    const onVis = () => {
      if (document.visibilityState === 'hidden' && phase === 'running') setHiddenWarn(true);
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
  }, [phase]);

  const openCam = (facing: 'environment' | 'user') =>
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      // Raw-ish audio: noise suppression / AGC would hide exactly what we listen for.
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });

  const start = async () => {
    setPhase('starting');
    setErr(null);
    sootheRef.current.unlock(); // inside the tap — iOS audio unlock
    let stream: MediaStream;
    try {
      stream = await openCam(facingRef.current);
    } catch {
      try {
        stream = await openCam('user');
        facingRef.current = 'user';
      } catch (e) {
        setErr(e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Camera and microphone access was blocked. Allow them for this site in your browser settings, then try again.'
          : 'Could not open the camera on this device.');
        setPhase('error');
        return;
      }
    }
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
    void wakeRef.current.enable();

    // ---- audio analysis (on-device)
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      void ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      tickersRef.current.push(
        startTicker(100, () => {
          an.getFloatTimeDomainData(buf);
          const out = detectorRef.current.push(analyzeFrame(buf, ctx.sampleRate), Date.now());
          live.current.level = out.level;
          live.current.det = out.state;
          live.current.cry = out.cryConfidence;
          for (const ev of out.events) {
            if (ev === 'cry_start') {
              cryStartRef.current = Date.now();
              sockRef.current?.send({ t: 'event', kind: 'cry' });
            } else if (ev === 'cry_end') {
              cryStartRef.current = null;
              sockRef.current?.send({ t: 'event', kind: 'cry_end', secs: out.crySecs ?? 0 });
            } else if (ev === 'noise' && !sootheRef.current.current) {
              sockRef.current?.send({ t: 'event', kind: 'noise' });
            }
          }
        }),
      );
    } catch {
      push('Sound analysis isn’t available in this browser — video still works', { icon: 'alert' });
    }

    // ---- motion + light (tiny frames)
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    tickersRef.current.push(
      startTicker(500, () => {
        const v = videoRef.current;
        if (!c2d || !v || v.readyState < 2) return;
        c2d.drawImage(v, 0, 0, 64, 48);
        const m = motionRef.current.push(c2d.getImageData(0, 0, 64, 48).data);
        live.current.motion = m.motion;
        live.current.light = m.light;
        const run = motionRunRef.current;
        if (m.motion > 35) {
          run.since ??= Date.now();
          if (Date.now() - run.since > 5000 && Date.now() - run.lastEvent > 10 * 60_000) {
            run.lastEvent = Date.now();
            sockRef.current?.send({ t: 'event', kind: 'motion' });
          }
        } else run.since = null;
      }),
    );

    // ---- battery (where the browser exposes it)
    try {
      const nav2 = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
      const b = await nav2.getBattery?.();
      if (b) {
        const upd = () => {
          batteryRef.current = { level: Math.round(b.level * 100), charging: b.charging };
          if (!b.charging && b.level <= 0.2 && Date.now() - lastBatteryAlertRef.current > 30 * 60_000) {
            lastBatteryAlertRef.current = Date.now();
            sockRef.current?.send({ t: 'event', kind: 'battery', pct: Math.round(b.level * 100) });
          }
        };
        upd();
        b.addEventListener('levelchange', upd);
        b.addEventListener('chargingchange', upd);
      }
    } catch { /* not exposed (iOS) */ }

    // ---- room + peers
    const hub = new CameraHub(
      (to, d) => sockRef.current?.send({ t: 'rtc', to, d }),
      [],
      () => ({ video: streamRef.current?.getVideoTracks()[0] ?? null, audio: streamRef.current?.getAudioTracks()[0] ?? null }),
    );
    hub.onCount = setP2pCount;
    hub.onTalk = (sid, s) => {
      let el = talkElsRef.current.get(sid);
      if (!s) {
        if (el) el.srcObject = null;
        talkElsRef.current.delete(sid);
        return;
      }
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        talkElsRef.current.set(sid, el);
      }
      el.srcObject = s;
      void el.play().catch(() => undefined);
    };
    hubRef.current = hub;

    sockRef.current = openMonitorSocket(id, 'camera', onMsg, () => undefined, (st, detail) => {
      setSock(st);
      if (st === 'closed' && detail) {
        setErr(detail);
        setPhase('error');
        stopAll(false);
      }
    });

    // ---- status heartbeat to the room (also the liveness signal)
    tickersRef.current.push(
      startTicker(2000, () => {
        const l = live.current;
        const st: BabyState =
          l.det === 'crying' ? 'crying' : l.det === 'noisy' && !sootheRef.current.current ? 'noisy' : l.det === 'stirring' || l.motion > 35 ? 'stirring' : 'calm';
        setState(st);
        setLevel(l.level);
        setMotion(l.motion);
        setLight(l.light);
        sockRef.current?.send({
          t: 'status',
          st: {
            state: st,
            level: l.level,
            motion: l.motion,
            light: l.light,
            battery: batteryRef.current.level,
            charging: batteryRef.current.charging,
            soothing: sootheRef.current.current?.kind ?? null,
            cry: l.cry,
          },
        });
      }),
    );
    setPhase('running');
  };

  const onMsg = (m: MonServerMsg) => {
    switch (m.t) {
      case 'hello':
        setNurseryName(m.nursery.name);
        setViewers(m.viewers);
        hubRef.current?.setIce(m.ice);
        applySettings(m.settings);
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
        hubRef.current?.close(m.sid);
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
    detectorRef.current.sensitivity = s.sensitivity;
  };

  const onCmd = (m: Extract<MonServerMsg, { t: 'cmd' }>) => {
    const v = (m.v ?? {}) as Record<string, unknown>;
    if (m.c === 'soothe') {
      const kind = (SOOTHE_OPTIONS.find((o) => o.id === v.kind)?.id ?? 'shush') as SootheKind;
      const minutes = Math.min(120, Math.max(1, Number(v.minutes) || 30));
      sootheRef.current.start(kind, minutes, Number(v.volume) || 0.4);
      setSoothing(sootheRef.current.current);
      detectorRef.current.suppress(3000, Date.now());
      sockRef.current?.send({ t: 'event', kind: 'soothe', msg: `${m.by} started ${SOOTHE_OPTIONS.find((o) => o.id === kind)?.label ?? 'soothing sounds'} for ${minutes} min` });
    } else if (m.c === 'soothe_stop') {
      sootheRef.current.stop();
      setSoothing(null);
      sockRef.current?.send({ t: 'event', kind: 'soothe', msg: `${m.by} stopped the soothing sounds` });
    } else if (m.c === 'quality') {
      void hubRef.current?.setQuality(m.from, (['hd', 'sd', 'audio'].includes(String(v.q)) ? v.q : 'hd') as Quality);
    } else if (m.c === 'flip') {
      void flip();
    } else if (m.c === 'talk') {
      const on = Boolean(v.on);
      setTalking(on ? m.by : null);
      // Their voice comes out of this speaker — don't mistake it for the baby.
      if (on) detectorRef.current.suppress(30_000, Date.now());
      else detectorRef.current.suppress(1500, Date.now());
    }
  };

  const setRelay = (on: boolean) => {
    window.clearInterval(relayTimerRef.current);
    if (!on) return;
    const canvas = document.createElement('canvas');
    relayTimerRef.current = window.setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      const w = 480;
      const h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 270;
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(v, 0, 0, w, h);
      canvas.toBlob((b) => b && sockRef.current?.sendBinary(b), 'image/jpeg', 0.6);
    }, 1000);
  };

  const flip = async () => {
    const next = facingRef.current === 'environment' ? 'user' : 'environment';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: next }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const track = fresh.getVideoTracks()[0];
      const s = streamRef.current;
      if (!s || !track) return;
      s.getVideoTracks().forEach((t) => {
        s.removeTrack(t);
        t.stop();
      });
      s.addTrack(track);
      facingRef.current = next;
      await hubRef.current?.replaceVideo(track);
      if (videoRef.current) videoRef.current.srcObject = s;
    } catch {
      push('This device has no other camera', { icon: 'alert' });
    }
  };

  const stop = () => {
    stopAll(true);
    push('Camera stopped — nothing was recorded', { icon: 'check' });
    nav.nursery(id);
  };

  /* --------------------------------------------------------------- render */

  if (phase === 'ready' || phase === 'starting' || phase === 'error') {
    return (
      <div className="cam-setup fade-in">
        <button className="back-link" onClick={() => nav.nursery(id)}><Icon name="arrowLeft" size={15} />Back</button>
        <div className="cam-setup-card">
          <div className="mh-icon"><Icon name="video" size={28} /></div>
          <h1 className="page-title">Use this {device.name} as the baby camera</h1>
          <ul className="cam-tips">
            <li><Icon name="check" size={14} />Prop it 1–2 m from the crib, out of reach, pointing at the baby.</li>
            <li><Icon name="check" size={14} />Keep it plugged in and on Wi-Fi. The screen stays on (you can dim it).</li>
            <li><Icon name="check" size={14} />Keep this page open — phones pause cameras in the background. If it stops, everyone is alerted.</li>
            <li><Icon name="shield" size={14} />Live only. Nothing is recorded or stored — the picture goes straight to your family’s devices, encrypted.</li>
          </ul>
          {err && <div className="banner err" style={{ marginBottom: 14 }}><Icon name="alert" size={15} />{err}</div>}
          <Btn variant="solid" size="lg" icon="video" onClick={() => void start()} disabled={phase === 'starting'}>
            {phase === 'starting' ? 'Starting…' : 'Start camera'}
          </Btn>
        </div>
      </div>
    );
  }

  const info = STATE_INFO[state];
  return (
    <div className={cx('cam-run', dim && 'dimmed')}>
      <video ref={videoRef} className="cam-video" autoPlay muted playsInline />
      {dim && (
        <button className="cam-dim" onClick={() => setDim(false)} aria-label="Wake the screen">
          <span>Monitoring · tap to wake</span>
        </button>
      )}
      <div className="cam-top">
        <Pill tone={sock === 'connected' ? 'live' : 'warn'} dot pulse={sock === 'connected'}>
          {sock === 'connected' ? 'MONITORING' : sock === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING'}
        </Pill>
        <span className="cam-norec"><Icon name="shield" size={12} />Not recording</span>
        <span className="spacer" />
        <span className="cam-room">{nurseryName}</span>
      </div>

      {hiddenWarn && (
        <div className="banner warn cam-warn">
          <Icon name="alert" size={15} />
          <span style={{ flex: 1 }}>This page was in the background — the camera may have paused. Keep Stream Studio open on this phone.</span>
          <button className="iconbtn" onClick={() => setHiddenWarn(false)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}
      {talking && <div className="cam-talk"><Icon name="mic" size={16} />{talking} is talking…</div>}

      <div className="cam-panel">
        <div className="cam-state">
          <span className={cx('state-dot', `tone-${info.tone}`)} />
          <b>{info.label}</b>
          <span className="faint">{light < 35 ? 'Dark room' : ''}</span>
        </div>
        <div className="cam-meters">
          <label>Sound<Meter value={level} max={45} tone={level > 24 ? 'live' : level > 12 ? 'amber' : 'green'} /></label>
          <label>Motion<Meter value={motion} max={100} tone={motion > 35 ? 'amber' : 'green'} /></label>
        </div>
        {soothing && (
          <div className="cam-soothe">
            <Icon name="volume" size={15} />
            {SOOTHE_OPTIONS.find((o) => o.id === soothing.kind)?.label} · {Math.max(0, Math.ceil((soothing.endsAt - Date.now()) / 60_000))} min left
            <span className="spacer" />
            <Btn variant="subtle" size="sm" onClick={() => { sootheRef.current.stop(); setSoothing(null); }}>Stop</Btn>
          </div>
        )}
        <div className="cam-watchers" aria-live="polite">
          <Icon name="eye" size={14} />
          {viewers.length === 0
            ? 'No one is watching right now'
            : <>Watching now: {viewers.map((v) => `${v.label || v.name} (${v.dn})`).join(', ')}{p2pCount < viewers.length ? ' · connecting…' : ''}</>}
        </div>
        <div className="cam-actions">
          <Btn variant="soft" icon="flip" onClick={() => void flip()}>Flip</Btn>
          <Btn variant="soft" icon="moon" onClick={() => setDim(true)}>Dim screen</Btn>
          <Btn variant="danger" icon="stop" onClick={stop}>Stop camera</Btn>
        </div>
      </div>
    </div>
  );
}
