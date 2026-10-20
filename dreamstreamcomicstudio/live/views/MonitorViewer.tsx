// Baby Monitor — WATCH mode (a parent's phone / laptop).
//
// Live P2P picture + sound (never recorded) with FaceTime-style controls:
// listen, talk (tap or hold), video call, soothe. The camera phone's
// on-device sound detection drives alerts you can see (colour-coded banners,
// a glowing stage, a full-screen alarm takeover) and hear (distinct sounds
// per category, spoken alerts, vibration) with an "I'm on it" hand-off
// across the family, plus a live "what's happening" card, a 24 h timeline
// and a filterable activity log.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCues, alertInfo, type AlertCat, type CuePrefs } from '../monitor/alerts';
import { getDevice, openMonitorSocket, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { STATE_INFO, ROLE_INFO, type CamPresence, type CamStatus, type MonLog, type MonRole, type MonServerMsg, type MonSettings, type TimelineBucket, type ViewerPresence, type BabyState } from '../monitor/protocol';
import { currentSubscription, localNotify, needsHomeScreen, pushSupported, subscribe } from '../monitor/push';
import { ViewerLink, type LinkState, type Quality } from '../monitor/rtc';
import { SOUND_INFO, SOUND_CATS, soundHeadline, type SoundCat } from '../monitor/soundClasses';
import { SOOTHE_OPTIONS, type SootheKind } from '../monitor/soothe';
import { markSetup } from '../monitor/setupProgress';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Btn, Meter, Pill, Segmented, Toggle, cx, useMediaQuery, type PushToast } from '../ui/primitives';
import { ScreenWakeLock } from '../wakeLock';
import { FOCUS_KEY, MonitorGate } from './MonitorHome';
import { HelpButton, useFirstVisitTour } from '../components/Guide';

const BUCKET_MS = 5 * 60_000;
const SOUND_SET = new Set<string>(SOUND_CATS);
const CARE = new Set(['feed', 'diaper', 'sleep', 'wake', 'note']);
const CAMERA_KINDS = new Set(['offline', 'online', 'battery', 'camera', 'privacy', 'call', 'people', 'soothe', 'motion']);
const PUSH_CATS: { k: string; label: string; locked?: boolean }[] = [
  { k: 'cry', label: 'Crying' }, { k: 'alarm', label: 'Smoke / CO alarm', locked: true }, { k: 'cough', label: 'Coughing' },
  { k: 'crash', label: 'Bangs & crashes' }, { k: 'fuss', label: 'Fussing' }, { k: 'loud', label: 'Other loud sounds' },
  { k: 'offline', label: 'Camera offline' }, { k: 'battery', label: 'Camera battery low' },
];
const DEFAULT_PUSH: Record<string, boolean> = { cry: true, alarm: true, cough: true, crash: true, fuss: false, loud: false, offline: true, battery: true };

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtAgo = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};
const fmtDur = (secs: number) => (secs >= 60 ? `${Math.round(secs / 60)} min` : `${secs}s`);
const dayLabel = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};

const LOG_META: Record<string, { icon: string; tone: string }> = {
  cry_end: { icon: 'check', tone: 'green' }, fuss_end: { icon: 'check', tone: 'green' }, noise: { icon: 'volume', tone: 'amber' },
  motion: { icon: 'activity', tone: 'neutral' }, offline: { icon: 'wifi', tone: 'red' }, online: { icon: 'wifi', tone: 'green' },
  battery: { icon: 'battery', tone: 'amber' }, privacy: { icon: 'eyeOff', tone: 'neutral' }, call: { icon: 'phone', tone: 'violet' },
  feed: { icon: 'bottle', tone: 'blue' }, diaper: { icon: 'sparkles', tone: 'blue' }, sleep: { icon: 'moon', tone: 'blue' },
  wake: { icon: 'sun', tone: 'blue' }, note: { icon: 'edit', tone: 'blue' }, ack: { icon: 'heart', tone: 'accent' },
  soothe: { icon: 'music', tone: 'violet' }, camera: { icon: 'video', tone: 'neutral' }, people: { icon: 'users', tone: 'neutral' },
};
const logMeta = (kind: string) => (SOUND_SET.has(kind) ? { icon: SOUND_INFO[kind as SoundCat].icon, tone: SOUND_INFO[kind as SoundCat].tone } : LOG_META[kind] ?? { icon: 'info', tone: 'neutral' });

const pushKey = (nid: string) => `ds-monitor-push-${nid}`;
const camKey = (nid: string) => `ds-monitor-cam-${nid}`;

interface ActiveAlert {
  key: string;
  cat: AlertCat;
  title: string;
  at: number;
  entryId: string | null;
  acked: string | null;
  ended: number | null;
  secs?: number;
}

type LogFilter = 'all' | 'baby' | 'alerts' | 'care' | 'camera';

export function MonitorViewer({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  return (
    <MonitorGate>
      <ViewerInner id={id} nav={nav} push={push} />
    </MonitorGate>
  );
}

function ViewerInner({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const sockRef = useRef<MonitorSocket | null>(null);
  const linkRef = useRef<ViewerLink | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const selfRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const relayUrlRef = useRef<string | null>(null);
  const wakeRef = useRef(new ScreenWakeLock());
  const cuesRef = useRef(new AlertCues());
  const retryRef = useRef<number | undefined>(undefined);
  const vapidRef = useRef<string | null>(null);
  const micMeterRef = useRef<{ ctx: AudioContext; timer: number } | null>(null);
  const pressRef = useRef<number | null>(null);

  const [reconnectKey, setReconnectKey] = useState(0);
  const [sock, setSock] = useState<MonSocketStatus>('connecting');
  const [closedMsg, setClosedMsg] = useState<string | null>(null);
  const [me, setMe] = useState<{ sid: string; role: MonRole; name: string; label: string | null } | null>(null);
  const [nursery, setNursery] = useState<{ name: string; baby: string | null }>({ name: 'Nursery', baby: null });
  const [cams, setCams] = useState<CamPresence[]>([]);
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [status, setStatus] = useState<Record<string, { st: CamStatus; at: number; since: number }>>({});
  const statusRef = useRef<Record<string, { st: CamStatus; at: number; since: number }>>({});
  const [levels, setLevels] = useState<Record<string, number[]>>({});
  const [log, setLog] = useState<MonLog[]>([]);
  const [tl, setTl] = useState<TimelineBucket[]>([]);
  const [settings, setSettings] = useState<MonSettings>({ sensitivity: 'medium', cryRepeatMin: 3 });
  const [camSid, setCamSid] = useState<string | null>(null);
  const [linkState, setLinkState] = useState<LinkState>('idle');
  const [relayOn, setRelayOn] = useState(false);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [muted, setMuted] = useState(true);
  const [night, setNight] = useState(false);
  const [quality, setQuality] = useState<Quality>('hd');
  const [talk, setTalk] = useState<'off' | 'starting' | 'on'>('off');
  const [micLevel, setMicLevel] = useState(0);
  const [call, setCall] = useState<{ stream: MediaStream; facing: 'user' | 'environment' } | null>(null);
  const [sootheOpen, setSootheOpen] = useState(false);
  const [sootheKind, setSootheKind] = useState<SootheKind>('shush');
  const [sootheMin, setSootheMin] = useState(30);
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [cues, setCues] = useState<CuePrefs>(() => cuesRef.current.prefs);
  const [pushOn, setPushOn] = useState(false);
  const [pushPrefs, setPushPrefs] = useState<Record<string, boolean>>(DEFAULT_PUSH);
  const [keepAwake, setKeepAwake] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [note, setNote] = useState('');
  const [, setClock] = useState(0);
  const wide = useMediaQuery('(min-width: 980px)');

  const canAct = me?.role === 'parent' || me?.role === 'caregiver';
  useFirstVisitTour('watch', sock === 'connected');
  const cam = cams.find((c) => c.sid === camSid) ?? null;
  const camStatus = cam ? status[cam.dev] : undefined;
  const baby = nursery.baby || 'Baby';

  /* ------------------------------------------------------------ socket */
  useEffect(() => {
    setClosedMsg(null);
    const link = new ViewerLink((to, d) => sockRef.current?.send({ t: 'rtc', to, d }), []);
    link.onState = setLinkState;
    link.onStream = (s) => {
      const v = videoRef.current;
      if (v && v.srcObject !== s) {
        v.srcObject = s;
        if (s) void v.play().catch(() => undefined);
      }
      setHasVideo(!!s && s.getVideoTracks().length > 0);
    };
    linkRef.current = link;

    const onBinary = (data: Blob) => {
      const url = URL.createObjectURL(data);
      if (relayUrlRef.current) URL.revokeObjectURL(relayUrlRef.current);
      relayUrlRef.current = url;
      setRelayUrl(url);
    };

    const sockNow = openMonitorSocket(id, 'viewer', (m) => onMsgRef.current(m), onBinary, (s, detail) => {
      setSock(s);
      if (s === 'closed') setClosedMsg(detail || 'Disconnected from the nursery.');
    });
    sockRef.current = sockNow;
    const tick = window.setInterval(() => setClock((c) => c + 1), 5000);
    const cues = cuesRef.current;
    const unlock = () => cues.unlock();
    window.addEventListener('pointerdown', unlock);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(retryRef.current);
      window.removeEventListener('pointerdown', unlock);
      link.close();
      sockNow.close();
      stopMicMeter();
      cues.stopAll();
      if (relayUrlRef.current) URL.revokeObjectURL(relayUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reconnectKey]);

  useEffect(() => () => cuesRef.current.close(), []);

  // Attach the self-view (video call) whenever it mounts.
  useEffect(() => {
    const v = selfRef.current;
    if (v && call && v.srcObject !== call.stream) {
      v.srcObject = call.stream;
      void v.play().catch(() => undefined);
    }
  });

  const pickCam = (list: CamPresence[], current: string | null): string | null => {
    if (current && list.some((c) => c.sid === current)) return current;
    let preferred: string | null = null;
    try {
      preferred = localStorage.getItem(camKey(id));
    } catch { /* storage unavailable */ }
    return (list.find((c) => c.dev === preferred) ?? list[0])?.sid ?? null;
  };

  /* ------------------------------------------------------------ alerts */
  const raise = (cat: AlertCat, title: string, entryId: string | null, silent = false) => {
    const now = Date.now();
    const key = entryId || `${cat}-${now}`;
    setAlerts((list) => {
      // Fold a repeat of a still-active category into the existing banner.
      const open = list.find((a) => a.cat === cat && !a.ended && now - a.at < 10 * 60_000);
      if (open) return list.map((a) => (a === open ? { ...a, entryId: entryId ?? a.entryId } : a));
      return [{ key, cat, title, at: now, entryId, acked: null, ended: null }, ...list].slice(0, 6);
    });
    if (silent) return;
    cuesRef.current.raise(key, cat, title);
    if (document.visibilityState !== 'visible' && !pushOnRef.current && cuesRef.current.enabled(cat)) {
      void localNotify(title, `${nursery.name} — tap to check in`, `${id}-${cat}`, location.href);
    }
  };

  const resolve = (cat: AlertCat, secs?: number) => {
    cuesRef.current.stopCat(cat);
    setAlerts((list) => list.map((a) => (a.cat === cat && !a.ended ? { ...a, ended: Date.now(), secs } : a)));
  };

  const dismiss = (key: string) => {
    cuesRef.current.stop(key);
    setAlerts((list) => list.filter((a) => a.key !== key));
  };

  const onMsg = (m: MonServerMsg) => {
    switch (m.t) {
      case 'hello': {
        setMe({ sid: m.you.sid, role: m.you.role, name: m.you.name, label: m.you.label });
        setNursery(m.nursery);
        setCams(m.cams);
        setViewers(m.viewers);
        setLog(m.log);
        setTl(m.tl);
        setSettings(m.settings);
        vapidRef.current = m.vapid;
        linkRef.current?.setIce(m.ice);
        const st: Record<string, { st: CamStatus; at: number; since: number }> = {};
        for (const c of m.cams) if (c.status && c.statusAt) st[c.dev] = { st: c.status, at: c.statusAt, since: c.statusAt };
        statusRef.current = st;
        setStatus(st);
        setCamSid((cur) => pickCam(m.cams, cur));
        markSetup(id, 'watch');
        try {
          const focus = sessionStorage.getItem(FOCUS_KEY);
          if (focus) {
            sessionStorage.removeItem(FOCUS_KEY);
            window.setTimeout(() => document.querySelector(`[data-tour="mv-${focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 600);
          }
        } catch { /* storage unavailable */ }
        if (m.cams.length) markSetup(id, 'camera');
        // An episode still in progress when we join: show it (no sound).
        const recent = [...m.log].reverse().find((e) => (e.kind === 'cry' || e.kind === 'alarm') && Date.now() - e.at < 3 * 60_000);
        if (recent && !m.log.some((e) => e.at > recent.at && (e.kind === 'cry_end' || e.kind === 'ack'))) {
          raise(recent.kind as AlertCat, recent.msg.split(' · ')[0], recent.id, true);
        }
        void restorePush();
        break;
      }
      case 'presence':
        if (m.cams.length) markSetup(id, 'camera');
        setCams(m.cams);
        setViewers(m.viewers);
        setCamSid((cur) => pickCam(m.cams, cur));
        break;
      case 'rtc':
        void linkRef.current?.onSignal(m.from, m.d);
        break;
      case 'status': {
        const old = statusRef.current[m.dev];
        const since = old && old.st.state === m.st.state ? old.since : m.at;
        // Fallback trigger in case the cry's log line was rate-limited away.
        if (m.st.state === 'crying' && old?.st.state !== 'crying') raise('cry', soundHeadline('cry', nursery.baby), null);
        const next = { ...statusRef.current, [m.dev]: { st: m.st, at: m.at, since } };
        statusRef.current = next;
        setStatus(next);
        setLevels((prev) => ({ ...prev, [m.dev]: [...(prev[m.dev] ?? []).slice(-59), m.st.level] }));
        setTl((prev) => {
          const t = Math.floor(m.at / BUCKET_MS) * BUCKET_MS;
          const rank = { calm: 1, stirring: 2, awake: 2, noisy: 3, fussing: 4, crying: 5 }[m.st.state as BabyState] ?? 1;
          const last = prev[prev.length - 1];
          if (last && last[0] === t) {
            if (rank <= last[1]) return prev;
            return [...prev.slice(0, -1), [t, rank, last[2]]];
          }
          return [...prev.filter((b) => b[0] > Date.now() - 24 * 3600_000), [t, rank, 0]];
        });
        break;
      }
      case 'log': {
        const e = m.entry;
        setLog((l) => [...l.slice(-399), e]);
        if (SOUND_SET.has(e.kind)) raise(e.kind as SoundCat, e.msg.split(' · ')[0], e.id);
        else if (e.kind === 'cry_end') resolve('cry', e.secs);
        else if (e.kind === 'fuss_end') resolve('fuss', e.secs);
        else if (e.kind === 'offline') raise('offline', e.msg, e.id);
        else if (e.kind === 'online') resolve('offline');
        else if (e.kind === 'battery') raise('battery', e.msg, e.id);
        break;
      }
      case 'ack': {
        const who = m.by === me?.name ? 'You' : m.label || m.by;
        cuesRef.current.acked();
        setAlerts((list) => list.map((a) => (!a.ended && !a.acked ? { ...a, acked: who } : a)));
        if (who !== 'You') push(`${who} is checking on ${baby}`, { icon: 'heart', duration: 4000 });
        break;
      }
      case 'settings':
        setSettings(m.settings);
        break;
      case 'cam_gone':
        if (linkRef.current?.target === m.sid) linkRef.current.close();
        break;
      case 'roles_changed':
        setReconnectKey((k) => k + 1);
        break;
      case 'push_ok':
        setPushOn(true);
        markSetup(id, 'alerts');
        break;
      case 'notice':
        push(m.text, { icon: 'info', duration: 4000 });
        break;
      case 'error':
        if (['removed', 'ended', 'forbidden', 'auth'].includes(m.code)) setClosedMsg(m.msg);
        else push(m.msg, { icon: 'alert' });
        break;
    }
  };

  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  const onMsgRef = useRef(onMsg);
  onMsgRef.current = onMsg;

  // Episodes without an "end" (coughs, bangs…) fade out of the banner area.
  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      setAlerts((list) =>
        list.filter((a) => {
          if (a.ended) return now - a.ended < 90_000;
          const sev = alertInfo(a.cat).severity;
          if (a.cat === 'cry' || a.cat === 'fuss' || a.cat === 'offline') return true;
          if (a.cat === 'alarm') return !a.acked || now - a.at < 120_000;
          return now - a.at < (sev === 'info' ? 60_000 : 150_000);
        }),
      );
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  /* ---------------------------------------------------------- P2P link */
  useEffect(() => {
    const link = linkRef.current;
    if (!link || sock !== 'connected') return;
    if (!camSid) {
      link.close();
      setRelayOn(false);
      return;
    }
    if (link.target !== camSid || link.state === 'closed' || link.state === 'idle') {
      void link.connect(camSid);
      const c = cams.find((x) => x.sid === camSid);
      if (c) {
        try {
          localStorage.setItem(camKey(id), c.dev);
        } catch { /* storage unavailable */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camSid, sock]);

  useEffect(() => {
    if (!cam) return;
    if (linkState === 'failed') {
      if (!relayOn) {
        setRelayOn(true);
        sockRef.current?.send({ t: 'relay', on: true, dev: cam.dev });
      }
      window.clearTimeout(retryRef.current);
      retryRef.current = window.setTimeout(() => camSid && void linkRef.current?.connect(camSid), 60_000);
    } else if (linkState === 'connected' && relayOn) {
      setRelayOn(false);
      sockRef.current?.send({ t: 'relay', on: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkState, cam?.dev]);

  useEffect(() => {
    if (keepAwake) void wakeRef.current.enable();
    else void wakeRef.current.disable();
    return () => void wakeRef.current.disable();
  }, [keepAwake]);

  /* ----------------------------------------------------------- actions */
  const listen = (on = true) => {
    setMuted(!on);
    const v = videoRef.current;
    if (v) {
      v.muted = !on;
      if (on) void v.play().catch(() => undefined);
    }
    cuesRef.current.unlock();
  };

  const stopMicMeter = () => {
    const mm = micMeterRef.current;
    if (!mm) return;
    window.clearInterval(mm.timer);
    void mm.ctx.close().catch(() => undefined);
    micMeterRef.current = null;
    setMicLevel(0);
  };

  const startMicMeter = (track: MediaStreamTrack) => {
    stopMicMeter();
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Float32Array(an.fftSize);
      const timer = window.setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        setMicLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
      }, 90);
      micMeterRef.current = { ctx, timer };
    } catch { /* no meter */ }
  };

  const startTalk = async (): Promise<boolean> => {
    const link = linkRef.current;
    if (!link || !cam || talk !== 'off') return talk === 'on';
    setTalk('starting');
    if (muted) listen(true); // two-way: hear the nursery while you talk
    sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: true } });
    const track = await link.startTalk();
    if (!track) {
      sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: false } });
      setTalk('off');
      push('Microphone unavailable — allow it for this site to talk to the nursery', { icon: 'alert' });
      return false;
    }
    startMicMeter(track);
    setTalk('on');
    markSetup(id, 'talk');
    return true;
  };

  const stopTalk = async () => {
    stopMicMeter();
    await linkRef.current?.stopTalk();
    if (cam) sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: false } });
    setTalk('off');
  };

  // Tap = toggle the mic; press and hold = talk only while holding.
  const onTalkDown = () => {
    pressRef.current = Date.now();
    if (talk === 'off') void startTalk();
  };
  const onTalkUp = () => {
    const held = pressRef.current != null && Date.now() - pressRef.current > 450;
    const wasOn = talk === 'on';
    pressRef.current = null;
    if (held) void stopTalk();
    else if (wasOn) void stopTalk();
  };

  const toggleCall = async (facing: 'user' | 'environment' = 'user') => {
    const link = linkRef.current;
    if (!link || !cam) return;
    if (call && facing === call.facing) {
      await link.stopVideo();
      call.stream.getTracks().forEach((t) => t.stop());
      setCall(null);
      sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'video', v: { on: false } });
      return;
    }
    const s = await link.startVideo(facing);
    if (!s) {
      push('Camera unavailable — allow it for this site to video call the nursery', { icon: 'alert' });
      return;
    }
    call?.stream.getTracks().forEach((t) => t.stop());
    setCall({ stream: s, facing });
    sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'video', v: { on: true } });
    if (talk === 'off') void startTalk(); // a video call is a call: mic on too
  };

  const setQ = (q: Quality) => {
    setQuality(q);
    if (cam) sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'quality', v: { q } });
  };

  const soothe = (on: boolean) => {
    if (!cam) return;
    sockRef.current?.send({ t: 'cmd', to: cam.sid, c: on ? 'soothe' : 'soothe_stop', v: { kind: sootheKind, minutes: sootheMin } });
    setSootheOpen(false);
    push(on ? 'Soothing sounds starting in the nursery' : 'Stopping soothing sounds', { icon: 'music' });
  };

  const ack = (a?: ActiveAlert) => {
    sockRef.current?.send({ t: 'ack', id: a?.entryId ?? '' });
    cuesRef.current.acked();
    setAlerts((list) => list.map((x) => (!x.ended && !x.acked ? { ...x, acked: 'You' } : x)));
  };

  const quickLog = (kind: 'feed' | 'diaper' | 'sleep' | 'wake' | 'note', text = '') => {
    sockRef.current?.send({ t: 'log', kind, text });
    if (kind === 'note') setNote('');
  };

  const updateCues = (patch: Partial<CuePrefs>) => {
    const next = { ...cues, ...patch, cats: { ...cues.cats, ...(patch.cats ?? {}) } };
    setCues(next);
    cuesRef.current.setPrefs(next);
  };

  const restorePush = async () => {
    let enabled = false;
    let prefs = pushPrefs;
    try {
      enabled = localStorage.getItem(pushKey(id)) === '1';
      const saved = JSON.parse(localStorage.getItem(`${pushKey(id)}-prefs`) || 'null') as Record<string, boolean> | null;
      if (saved) {
        prefs = { ...DEFAULT_PUSH, ...saved, ...(saved.noise !== undefined && saved.loud === undefined ? { loud: saved.noise } : {}), alarm: true };
        setPushPrefs(prefs);
      }
    } catch { /* storage unavailable */ }
    if (!enabled) return;
    const sub = await currentSubscription();
    if (sub) sockRef.current?.send({ t: 'push_sub', sub: sub.toJSON(), prefs });
  };

  const enablePush = async (prefs = pushPrefs) => {
    const vapid = vapidRef.current;
    if (!vapid) {
      push('Alerts aren’t available yet — try again in a moment', { icon: 'alert' });
      return;
    }
    const r = await subscribe(vapid);
    if ('error' in r) {
      push(r.error, { icon: 'alert', duration: 7000 });
      return;
    }
    sockRef.current?.send({ t: 'push_sub', sub: r, prefs });
    try {
      localStorage.setItem(pushKey(id), '1');
      localStorage.setItem(`${pushKey(id)}-prefs`, JSON.stringify(prefs));
    } catch { /* storage unavailable */ }
  };

  const disablePush = async () => {
    const sub = await currentSubscription();
    if (sub) sockRef.current?.send({ t: 'push_unsub', endpoint: sub.endpoint });
    setPushOn(false);
    try {
      localStorage.removeItem(pushKey(id));
    } catch { /* storage unavailable */ }
  };

  const updatePushPref = (k: string, v: boolean) => {
    const next = { ...pushPrefs, [k]: v, alarm: true };
    setPushPrefs(next);
    try {
      localStorage.setItem(`${pushKey(id)}-prefs`, JSON.stringify(next));
    } catch { /* storage unavailable */ }
    if (pushOn) void enablePush(next);
  };

  const fullscreen = () => {
    const el = stageRef.current;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el?.requestFullscreen?.().catch(() => undefined);
  };

  /* ------------------------------------------------------------ derived */
  const now = Date.now();
  const state: BabyState | 'offline' | 'unknown' = !cam ? 'unknown' : !camStatus ? 'unknown' : now - camStatus.at < 30_000 ? camStatus.st.state : 'offline';
  const info = STATE_INFO[state];
  const today = useMemo(() => summarize(log, tl), [log, tl]);
  const soothingNow = camStatus?.st.soothing ?? null;
  const live = alerts.filter((a) => !a.ended);
  const top = live[0] ?? alerts[0] ?? null;
  const glow = live.length ? alertInfo(live[0].cat).tone : null;
  const alarmTakeover = live.find((a) => a.cat === 'alarm' && !a.acked);
  const others = (camStatus?.st.talk || camStatus?.st.call) ?? null;
  const hearing = camStatus && state !== 'offline' && state !== 'unknown' ? camStatus.st.top ?? [] : [];
  const levelHist = cam ? levels[cam.dev] ?? [] : [];
  const visibleLog = useMemo(() => filterLog(log, logFilter), [log, logFilter]);

  if (closedMsg && sock === 'closed') {
    return (
      <div className="page page-narrow">
        <div className="banner warn"><Icon name="lock" size={15} />{closedMsg}</div>
        <div className="row" style={{ marginTop: 14 }}>
          <Btn variant="ghost" icon="arrowLeft" onClick={() => nav.monitor()}>All nurseries</Btn>
          <Btn variant="solid" icon="refresh" onClick={() => setReconnectKey((k) => k + 1)}>Try again</Btn>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------- the stage */
  const stage = (
    <div className={cx('mv-stage', night && 'night', glow && `glow-${glow}`)} ref={stageRef} data-tour="mv-stage">
      <video ref={videoRef} autoPlay playsInline muted={muted} className={cx(!hasVideo && 'hidden')} />
      {relayOn && relayUrl && <img src={relayUrl} alt="Nursery snapshot (low-bandwidth mode)" className="mv-relay" />}
      {call && <video ref={selfRef} className={cx('mv-self', call.facing === 'user' && 'mirror')} autoPlay playsInline muted />}
      {!cam && (
        <div className="mv-empty">
          <Icon name="video" size={30} />
          <b>No camera is on</b>
          <span>On the phone in the nursery, open this nursery and tap “Be the camera”.</span>
        </div>
      )}
      {cam && !hasVideo && !relayUrl && (
        <div className="mv-empty">
          <div className="knock-dots" aria-hidden><span /><span /><span /></div>
          <span>{linkState === 'failed' ? 'Your network blocks direct video — switching to low-bandwidth mode…' : quality === 'audio' ? 'Audio-only mode' : 'Connecting securely to the camera…'}</span>
        </div>
      )}
      {camStatus?.st.paused && state !== 'offline' && (
        <div className="mv-paused">
          <Icon name={camStatus.st.paused === 'privacy' ? 'eyeOff' : 'videoOff'} size={20} />
          {camStatus.st.paused === 'privacy' ? 'Video paused for privacy — sound monitoring and alerts continue' : 'The camera phone paused the video (a call or another app). Sound monitoring continues.'}
        </div>
      )}
      <div className="mv-ov-tl">
        <span className={cx('state-chip', `tone-${info.tone}`)}><span className="state-dot" />{info.label}</span>
        {relayOn && <span className="ov-pill">Low-bandwidth · 1 fps · no audio</span>}
        {linkState === 'connected' && <span className="ov-pill"><Icon name="lock" size={11} />Encrypted · P2P</span>}
      </div>
      <div className="mv-ov-tr">
        <button className="mv-mini" onClick={() => setNight((v) => !v)} aria-pressed={night} aria-label="Night view" title="Night view"><Icon name="moon" size={16} /></button>
        <button className="mv-mini" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen"><Icon name="maximize" size={16} /></button>
      </div>
      {cam && muted && hasVideo && (
        <button className="mv-listen" onClick={() => listen(true)}><Icon name="volume" size={18} />Tap to hear the nursery</button>
      )}
      {(talk === 'on' || others) && (
        <div className="mv-talking" aria-live="polite">
          <span className="talk-wave" aria-hidden><i /><i /><i /><i /></span>
          {talk === 'on' ? (call ? 'You’re on video with the nursery' : 'The nursery can hear you') : `${others} ${camStatus?.st.call ? 'is on video' : 'is talking'}`}
        </div>
      )}
      <div className="mv-controls">
        <button className={cx('mv-round', !muted && 'on')} onClick={() => listen(muted)} aria-label={muted ? 'Listen' : 'Mute nursery sound'} aria-pressed={!muted}>
          <Icon name={muted ? 'volumeOff' : 'volume'} size={20} /><span>{muted ? 'Listen' : 'Sound on'}</span>
        </button>
        {canAct && cam && (
          <button
            className={cx('mv-round talk', talk !== 'off' && 'on')}
            style={{ '--lvl': String(micLevel) } as React.CSSProperties}
            onPointerDown={onTalkDown}
            onPointerUp={onTalkUp}
            onPointerLeave={() => pressRef.current != null && Date.now() - pressRef.current > 450 && void stopTalk()}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={talk === 'on' ? 'Stop talking' : 'Talk (tap) or hold to talk'}
            aria-pressed={talk === 'on'}
            data-tour="mv-talk"
          >
            <Icon name={talk === 'on' ? 'mic' : 'micOff'} size={22} /><span>{talk === 'on' ? 'Talking' : 'Talk'}</span>
          </button>
        )}
        {canAct && cam && (
          <button className={cx('mv-round', call && 'on')} onClick={() => void toggleCall(call?.facing ?? 'user')} aria-label={call ? 'End video' : 'Video call the nursery'} aria-pressed={!!call} data-tour="mv-call">
            <Icon name={call ? 'video' : 'videoOff'} size={20} /><span>{call ? 'End video' : 'Video'}</span>
          </button>
        )}
        {canAct && cam && (
          <button className={cx('mv-round', (sootheOpen || soothingNow) && 'on')} onClick={() => setSootheOpen((v) => !v)} aria-label="Soothing sounds">
            <Icon name="music" size={20} /><span>Soothe</span>
          </button>
        )}
      </div>
      {sootheOpen && cam && (
        <div className="mv-soothe">
          {soothingNow ? (
            <div className="row">
              <span style={{ flex: 1 }}>Playing: <b>{SOOTHE_OPTIONS.find((o) => o.id === soothingNow)?.label}</b></span>
              <Btn variant="danger" size="sm" onClick={() => soothe(false)}>Stop</Btn>
            </div>
          ) : (
            <>
              <div className="soothe-grid">
                {SOOTHE_OPTIONS.map((o) => (
                  <button key={o.id} className={cx('soothe-opt', sootheKind === o.id && 'sel')} onClick={() => setSootheKind(o.id)}>
                    <b>{o.label}</b><small>{o.sub}</small>
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <Segmented label="Duration" options={[{ value: '15', label: '15m' }, { value: '30', label: '30m' }, { value: '60', label: '1h' }]} value={String(sootheMin)} onChange={(v) => setSootheMin(Number(v))} />
                <span className="spacer" />
                <Btn variant="solid" size="sm" icon="play" onClick={() => soothe(true)}>Play in nursery</Btn>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );

  /* ---------------------------------------------------------- now card */
  const nowCard = (
    <div className={cx('card mv-status', `tone-${info.tone}`)} data-tour="mv-status">
      <div className="mvs-head">
        <span className={cx('state-dot big', `tone-${info.tone}`)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mvs-state">{nursery.baby ? `${nursery.baby} · ` : ''}{info.label}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {camStatus && state !== 'unknown' && state !== 'offline' ? `${info.sub} · for ${fmtAgo(now - camStatus.since)}` : info.sub}
          </div>
        </div>
        {camStatus && state !== 'offline' && (
          <span className={cx('ai-badge', camStatus.st.model === 'ready' && 'on')} title={camStatus.st.model === 'ready' ? 'Smart sound detection is on' : 'Basic cry detection'}>
            <Icon name="ear" size={12} />{camStatus.st.model === 'ready' ? 'Smart ears' : camStatus.st.model === 'loading' ? 'Ears loading' : 'Basic ears'}
          </span>
        )}
      </div>
      {camStatus && state !== 'unknown' && state !== 'offline' && (
        <>
          <div className="mv-hearing" data-tour="mv-hearing">
            <div className="mv-sect-title" style={{ marginBottom: 6 }}>Hearing now</div>
            {hearing.length === 0 ? (
              <div className="faint" style={{ fontSize: 13 }}>{camStatus.st.model === 'ready' ? 'Quiet — nothing in particular' : 'Listening for crying and loud sounds'}</div>
            ) : (
              hearing.map(([c, v]) => (
                <div key={c} className={cx('hear-row', `t-${SOUND_INFO[c].tone}`)}>
                  <Icon name={SOUND_INFO[c].icon} size={14} />
                  <span>{SOUND_INFO[c].label}</span>
                  <i style={{ width: `${Math.max(4, v)}%` }} />
                  <b className="mono">{v}%</b>
                </div>
              ))
            )}
          </div>
          <div className="mvs-meters">
            <label><span>Sound · last 2 min</span><Sparkline values={levelHist} max={45} /></label>
            <label><span>Motion</span><Meter value={camStatus.st.motion} max={100} tone={camStatus.st.motion > 35 ? 'amber' : 'green'} /></label>
          </div>
          <div className="mvs-chips">
            {camStatus.st.light < 35 && <Pill tone="info" icon="moon">Dark room — try Night view</Pill>}
            {camStatus.st.battery != null && (
              <Pill tone={camStatus.st.battery <= 20 && !camStatus.st.charging ? 'live' : 'neutral'} icon="battery">
                {camStatus.st.battery}%{camStatus.st.charging ? ' · charging' : ''}
              </Pill>
            )}
            {soothingNow && <Pill tone="accent" icon="music">{SOOTHE_OPTIONS.find((o) => o.id === soothingNow)?.label}</Pill>}
          </div>
        </>
      )}
      {cams.length > 1 && (
        <div className="mvs-cams">
          {cams.map((c) => (
            <button key={c.sid} className={cx('cam-chip', c.sid === camSid && 'sel')} onClick={() => setCamSid(c.sid)}>
              <Icon name="video" size={13} />{c.dn}
            </button>
          ))}
        </div>
      )}
      {cam && (
        <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
          <Segmented label="Quality" options={[{ value: 'hd', label: 'HD' }, { value: 'sd', label: 'Data saver' }, { value: 'audio', label: 'Audio only' }]} value={quality} onChange={(v) => setQ(v as Quality)} />
          {canAct && <Btn variant="subtle" size="sm" icon="flip" onClick={() => sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'flip' })}>Flip nursery camera</Btn>}
          <span className="faint" style={{ fontSize: 12 }}>{cam.dn} · started by {cam.by}</span>
        </div>
      )}
    </div>
  );

  /* -------------------------------------------------------- alert stack */
  const alertStack = top && (
    <div className="mv-alerts" role="alert" aria-live="assertive">
      {[top, ...alerts.filter((a) => a !== top && !a.ended).slice(0, 1)].map((a) => {
        const ai = alertInfo(a.cat);
        return (
          <div key={a.key} className={cx('mv-alert', `t-${ai.tone}`, !a.ended && !a.acked && 'ringing', a.ended && 'ended')}>
            <span className="mv-alert-icon"><Icon name={ai.icon} size={20} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{a.ended ? a.title.replace(' is crying', ' settled').replace(' is fussing', ' settled') : a.title}</b>
              <div style={{ fontSize: 12.5 }}>
                {a.ended
                  ? `${a.secs ? `After ${fmtDur(a.secs)} · ` : ''}${fmtTime(a.ended)}`
                  : a.acked
                    ? `${a.acked === 'You' ? 'You are' : `${a.acked} is`} checking on it · ${fmtAgo(now - a.at)} ago`
                    : `${fmtAgo(now - a.at)} ago · no one has responded yet`}
              </div>
            </div>
            {!a.ended && !a.acked && canAct && <Btn variant="solid" size="sm" icon="heart" onClick={() => ack(a)}>I’m on it</Btn>}
            {!a.ended && canAct && cam && talk === 'off' && (a.cat === 'cry' || a.cat === 'fuss') && <Btn variant="soft" size="sm" icon="mic" onClick={() => void startTalk()}>Talk</Btn>}
            {!a.ended && canAct && cam && !soothingNow && (a.cat === 'cry' || a.cat === 'fuss') && <Btn variant="soft" size="sm" icon="music" onClick={() => setSootheOpen(true)}>Soothe</Btn>}
            {!a.ended && a.cat !== 'alarm' && <Btn variant="subtle" size="sm" onClick={() => { cuesRef.current.snooze(a.cat, 5); dismiss(a.key); push(`${alertInfo(a.cat).label} alerts snoozed for 5 min on this device`, { icon: 'bell' }); }}>Snooze 5m</Btn>}
            {(a.ended || !canAct) && <button className="iconbtn" onClick={() => dismiss(a.key)} aria-label="Dismiss"><Icon name="x" size={15} /></button>}
          </div>
        );
      })}
    </div>
  );

  const takeover = alarmTakeover && (
    <div className="mv-takeover" role="alertdialog" aria-label="Alarm in the nursery">
      <Icon name="siren" size={44} />
      <h2>Alarm sounding in the nursery</h2>
      <p>The camera hears a smoke or carbon-monoxide alarm pattern. Check on {baby} now.</p>
      <div className="row" style={{ gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
        {canAct ? <Btn variant="solid" size="lg" icon="heart" onClick={() => ack(alarmTakeover)}>I’m on it</Btn> : null}
        <Btn variant="soft" size="lg" onClick={() => dismiss(alarmTakeover.key)}>Dismiss on this device</Btn>
      </div>
    </div>
  );

  /* ------------------------------------------------------------- care */
  const quickLogs = canAct && (
    <div className="card card-pad mv-quick" data-tour="mv-log">
      <div className="mv-sect-title">Quick log</div>
      <div className="quick-grid">
        <button onClick={() => quickLog('feed')}><Icon name="bottle" size={17} />Fed</button>
        <button onClick={() => quickLog('diaper')}><Icon name="sparkles" size={17} />Diaper</button>
        <button onClick={() => quickLog('sleep')}><Icon name="moon" size={17} />Asleep</button>
        <button onClick={() => quickLog('wake')}><Icon name="sun" size={17} />Awake</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input" value={note} maxLength={160} placeholder="Add a note (e.g. 120 ml, slight fever)…" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && quickLog('note', note.trim())} aria-label="Note" />
        <Btn variant="soft" icon="plus" disabled={!note.trim()} onClick={() => quickLog('note', note.trim())}>Add</Btn>
      </div>
    </div>
  );

  const timeline = (
    <div className="card card-pad" data-tour="mv-timeline">
      <div className="mv-sect-title">Last 24 hours</div>
      <TimelineStrip tl={tl} />
      <div className="today-grid">
        <div><b>{today.cries}</b><span>cry episodes{today.cryMin ? ` · ${today.cryMin} min` : ''}</span></div>
        <div><b>{today.calmH}</b><span>calm (camera on)</span></div>
        <div><b>{today.coughs}</b><span>coughing spells</span></div>
        <div><b>{today.lastFeed ?? '—'}</b><span>last fed</span></div>
        <div><b>{today.lastDiaper ?? '—'}</b><span>last diaper</span></div>
        <div><b>{today.awake}</b><span>happy wake-ups</span></div>
      </div>
      {today.sleeping && <div className="banner info" style={{ marginTop: 10 }}><Icon name="moon" size={15} />Logged asleep since {today.sleeping}</div>}
    </div>
  );

  const activity = (
    <div className="card mv-activity" data-tour="mv-activity">
      <div className="card-head"><Icon name="activity" size={15} /><h3>Activity log</h3></div>
      <div className="log-filters" role="tablist" aria-label="Filter the log">
        {([['all', 'All'], ['baby', 'Baby sounds'], ['alerts', 'Alerts'], ['care', 'Care'], ['camera', 'Camera']] as [LogFilter, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={logFilter === k} className={cx('log-filter', logFilter === k && 'sel')} onClick={() => setLogFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="mv-log-list">
        {visibleLog.length === 0 && <div className="faint" style={{ padding: 16, fontSize: 13 }}>Nothing here yet — cries, coughs, wake-ups, feeds and notes show up as they happen.</div>}
        {visibleLog.map((row) =>
          'day' in row ? (
            <div key={`d-${row.day}`} className="mv-log-day">{row.day}</div>
          ) : (
            <div key={row.e.id} className={cx('mv-log', `k-${row.e.kind}`)}>
              <span className={cx('log-ic', `t-${logMeta(row.e.kind).tone}`)}><Icon name={logMeta(row.e.kind).icon} size={13} /></span>
              <span className="mv-log-msg">
                {row.e.msg}
                {row.e.by && CARE.has(row.e.kind) ? <span className="faint"> · {row.e.by}</span> : null}
                {row.e.conf ? <span className="faint"> · {row.e.conf}% sure</span> : null}
              </span>
              <span className="mono faint">{fmtTime(row.e.at)}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );

  /* --------------------------------------------------------- settings */
  const alertsCard = (
    <div className="card card-pad mv-alertcfg" data-tour="mv-alerts">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="bell" size={17} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Alerts on this device</b>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {!pushSupported()
              ? 'This browser can’t alert in the background — keep this page open.'
              : needsHomeScreen()
                ? 'iPhone: Share → Add to Home Screen, open it from there, then turn this on.'
                : 'Notifications even when Stream Studio is closed or the phone is locked.'}
          </div>
        </div>
        <Toggle on={pushOn} onChange={(v) => void (v ? enablePush() : disablePush())} label="Background alerts" />
      </div>
      <div className="alert-prefs">
        {PUSH_CATS.map(({ k, label, locked }) => (
          <label key={k} title={locked ? 'Always on for safety' : undefined}>
            <input type="checkbox" checked={locked ? true : pushPrefs[k] ?? false} disabled={locked} onChange={(e) => updatePushPref(k, e.target.checked)} />
            {label}{locked ? ' · always on' : ''}
          </label>
        ))}
      </div>
      {pushOn && <Btn variant="soft" size="sm" icon="bell" onClick={() => sockRef.current?.send({ t: 'push_test' })}>Send a test notification</Btn>}

      <div className="mv-sect-title" style={{ marginTop: 16 }}>While this screen is open</div>
      <div className="cue-grid">
        <label className="row" style={{ gap: 8 }}><Toggle size="sm" on={cues.sound} onChange={(v) => updateCues({ sound: v })} label="Alert sounds" />Alert sounds</label>
        <label className="row" style={{ gap: 8 }}><Toggle size="sm" on={cues.speak} onChange={(v) => updateCues({ speak: v })} label="Speak alerts" />Speak alerts aloud</label>
        <label className="row" style={{ gap: 8 }}><Toggle size="sm" on={cues.vibrate} onChange={(v) => updateCues({ vibrate: v })} label="Vibrate" />Vibrate (phones)</label>
        <label className="row" style={{ gap: 8 }}><Toggle size="sm" on={cues.repeat} onChange={(v) => updateCues({ repeat: v })} label="Repeat until answered" />Repeat until someone responds</label>
      </div>
      <label className="cue-volume">
        <Icon name="volume" size={15} />
        <input type="range" className="slider" min={0} max={1} step={0.05} value={cues.volume} style={{ '--pct': `${cues.volume * 100}%` } as React.CSSProperties} onChange={(e) => updateCues({ volume: Number(e.target.value) })} aria-label="Alert volume" />
      </label>
      <div className="cue-cats">
        {(['cry', 'alarm', 'cough', 'crash', 'fuss', 'loud', 'babble', 'laugh', 'voices', 'music', 'dog', 'offline', 'battery'] as AlertCat[]).map((c) => {
          const ai = alertInfo(c);
          return (
            <div key={c} className={cx('cue-cat', `t-${ai.tone}`)}>
              <input type="checkbox" checked={c === 'alarm' ? true : cues.cats[c]} disabled={c === 'alarm'} onChange={(e) => updateCues({ cats: { ...cues.cats, [c]: e.target.checked } })} aria-label={`${ai.label} alerts`} />
              <Icon name={ai.icon} size={14} />
              <span>{ai.label}</span>
              <button className="linkish" onClick={() => cuesRef.current.preview(c, c === 'offline' || c === 'battery' ? ai.label : soundHeadline(c as SoundCat, nursery.baby))}>Preview</button>
            </div>
          );
        })}
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13, marginTop: 12 }}>
        <Toggle size="sm" on={keepAwake} onChange={setKeepAwake} label="Keep screen on" />Keep this screen on (bedside mode)
      </label>
    </div>
  );

  const peopleCard = (
    <div className="card card-pad">
      <div className="mv-sect-title">Watching now</div>
      <div className="watch-list">
        {viewers.map((v) => (
          <div key={v.sid} className="watch-row">
            <span className="watch-name">{v.label || v.name}{v.sid === me?.sid ? ' (you)' : ''}</span>
            <span className="faint">{v.dn} · {ROLE_INFO[v.role].label}{v.relay ? ' · low-bandwidth' : ''}</span>
          </div>
        ))}
      </div>
      {me?.role === 'parent' && viewers.length > 1 && (
        <Btn variant="danger" size="sm" icon="x" onClick={() => {
          if (window.confirm('Disconnect everyone else watching right now? They can rejoin if they’re still members.')) sockRef.current?.send({ t: 'end_all' });
        }}>End other sessions</Btn>
      )}
      {me?.role === 'parent' && (
        <div className="mv-settings">
          <div className="mv-sect-title" style={{ marginTop: 14 }}>Sound detection (parents)</div>
          <Segmented label="Sensitivity" options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} value={settings.sensitivity} onChange={(v) => sockRef.current?.send({ t: 'settings', sensitivity: v })} />
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>High catches soft whimpers and distant sounds; Low only alerts on clear, close cries.</div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <span style={{ fontSize: 13 }}>Repeat cry notifications every</span>
            <Segmented label="Repeat" options={[{ value: '2', label: '2m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }, { value: '10', label: '10m' }]} value={String(settings.cryRepeatMin)} onChange={(v) => sockRef.current?.send({ t: 'settings', cryRepeatMin: Number(v) })} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="mv-page fade-in">
      {takeover}
      <div className="mv-top">
        <button className="iconbtn" onClick={() => nav.nursery(id)} aria-label="Back"><Icon name="arrowLeft" size={17} /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mv-title">{nursery.name}</div>
          <div className="faint" style={{ fontSize: 12 }}>
            {sock === 'connected' ? `${getDevice().name} · ${me ? ROLE_INFO[me.role].label : ''}` : sock === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          </div>
        </div>
        <Pill tone="neutral" icon="eye">{viewers.length}</Pill>
        <HelpButton />
      </div>
      {alertStack}
      <div className={cx('mv-grid', wide && 'wide')}>
        <div className="mv-col">
          {stage}
          {nowCard}
          {quickLogs}
        </div>
        <div className="mv-col">
          {timeline}
          {activity}
          {alertsCard}
          {peopleCard}
        </div>
      </div>
      <p className="mv-disclaimer">
        Live only — nothing is recorded or stored. Sound detection runs on the camera phone. Not a medical device: it doesn’t monitor breathing or safe sleep.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- bits */

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const w = 160;
  const h = 28;
  if (values.length < 2) return <div className="spark spark-empty" />;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (Math.min(max, v) / max) * (h - 2) - 1}`).join(' ');
  const last = values[values.length - 1];
  return (
    <svg className={cx('spark', last > 24 ? 'hi' : last > 12 ? 'mid' : 'lo')} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`Sound level now ${last} dB above the room`}>
      <polyline points={pts} fill="none" />
    </svg>
  );
}

function TimelineStrip({ tl }: { tl: TimelineBucket[] }) {
  const end = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
  const start = end - 24 * 3600_000 + BUCKET_MS;
  const map = new Map(tl.map((b) => [b[0], b[1]]));
  const cells: number[] = [];
  for (let t = start; t <= end; t += BUCKET_MS) cells.push(map.get(t) ?? 0);
  const marks = [0, 6, 12, 18].map((h) => {
    const t = start + h * 3600_000;
    return { left: `${(h / 24) * 100}%`, label: new Date(t).toLocaleTimeString([], { hour: 'numeric' }) };
  });
  return (
    <div className="tl-wrap" aria-label="Calm, awake, fussing and crying over the last 24 hours">
      <div className="tl-strip">
        {cells.map((r, i) => <i key={i} className={`r${r}`} />)}
      </div>
      <div className="tl-marks">
        {marks.map((m) => <span key={m.left} style={{ left: m.left }}>{m.label}</span>)}
        <span style={{ right: 0 }}>now</span>
      </div>
      <div className="tl-legend">
        <span><i className="r1" />Calm</span><span><i className="r2" />Awake / stirring</span><span><i className="r3" />Noisy</span><span><i className="r4" />Fussing</span><span><i className="r5" />Crying</span><span><i className="r0" />Camera off</span>
      </div>
    </div>
  );
}

type LogRow = { day: string } | { e: MonLog };

function filterLog(log: MonLog[], f: LogFilter): LogRow[] {
  const keep = (e: MonLog) =>
    f === 'all' ||
    (f === 'baby' && ['cry', 'fuss', 'cough', 'babble', 'laugh', 'cry_end', 'fuss_end'].includes(e.kind)) ||
    (f === 'alerts' && ['cry', 'fuss', 'cough', 'alarm', 'crash', 'loud', 'offline', 'battery', 'noise'].includes(e.kind)) ||
    (f === 'care' && (CARE.has(e.kind) || e.kind === 'ack')) ||
    (f === 'camera' && CAMERA_KINDS.has(e.kind));
  const rows: LogRow[] = [];
  let lastDay = '';
  for (const e of log.slice().reverse()) {
    if (!keep(e)) continue;
    const d = dayLabel(e.at);
    if (d !== lastDay) {
      rows.push({ day: d });
      lastDay = d;
    }
    rows.push({ e });
    if (rows.length > 160) break;
  }
  return rows;
}

function summarize(log: MonLog[], tl: TimelineBucket[]) {
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = log.filter((l) => l.at >= dayAgo);
  const last = (k: MonLog['kind']) => {
    const e = [...recent].reverse().find((l) => l.kind === k);
    return e ? fmtTime(e.at) : null;
  };
  const lastSleep = [...recent].reverse().find((l) => l.kind === 'sleep' || l.kind === 'wake');
  const calmMin = tl.filter((b) => b[0] >= dayAgo && b[1] === 1).length * 5;
  const crySecs = recent.filter((l) => l.kind === 'cry_end').reduce((s, l) => s + (l.secs ?? 0), 0);
  return {
    cries: recent.filter((l) => l.kind === 'cry').length,
    cryMin: Math.round(crySecs / 60),
    coughs: recent.filter((l) => l.kind === 'cough').length,
    awake: recent.filter((l) => l.kind === 'babble' || l.kind === 'laugh').length,
    calmH: calmMin >= 60 ? `${Math.floor(calmMin / 60)}h ${calmMin % 60}m` : `${calmMin}m`,
    lastFeed: last('feed'),
    lastDiaper: last('diaper'),
    sleeping: lastSleep?.kind === 'sleep' ? fmtTime(lastSleep.at) : null,
  };
}
