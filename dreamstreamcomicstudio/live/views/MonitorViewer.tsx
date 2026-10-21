// Baby Monitor — WATCH mode (a parent's phone / laptop).
//
// Live P2P picture + sound (never recorded) with FaceTime-style controls:
// listen, talk (tap or hold), video call, soothe. The camera phone's
// on-device sound detection drives alerts you can see (colour-coded banners,
// a glowing stage, a full-screen alarm takeover) and hear (distinct sounds
// per category, spoken alerts, vibration) with an "I'm on it" hand-off
// across the family, plus a live "what's happening" card, a 24 h timeline
// and a filterable activity log.
import React, { useSyncExternalStore, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCues, ALERT_META, alertInfo, type AlertCat, type CuePrefs } from '../monitor/alerts';
import { getDevice, openMonitorSocket, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { STATE_INFO, ROLE_INFO, type CamPresence, type CamStatus, type Duty, type Incident, type MinuteRow, type MonLog, type MonRole, type MonServerMsg, type MonSettings, type ShareInfo, type SleepStatus, type TimelineBucket, type ViewerPresence, type BabyState, type Zone } from '../monitor/protocol';
import { MonQuery } from '../monitor/query';
import { currentSubscription, localNotify, needsHomeScreen, pushSupported, subscribe } from '../monitor/push';
import { ViewerLink, type LinkState, type Quality } from '../monitor/rtc';
import { SOUND_INFO, SOUND_CATS, soundHeadline, type SoundCat } from '../monitor/soundClasses';
import { SOOTHE_OPTIONS, type SootheKind } from '../monitor/soothe';
import { markSetup } from '../monitor/setupProgress';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Btn, Meter, Pill, Segmented, Toggle, cx, useMediaQuery, type PushToast } from '../ui/primitives';
import { ScreenWakeLock, type WakeState } from '../wakeLock';
import { BedsideView } from './monitor/BedsideView';
import { TrackerPanel } from './tracker/TrackerPanel';
import { stopTimer } from './tracker/TimerCard';
import { TrackerSync } from '../monitor/trackerSync';
import type { TrackKind } from '../monitor/trackTypes';
import { FOCUS_KEY, MonitorGate } from './MonitorHome';
import { clearGuest, loadGuest, type GuestPass } from '../monitor/guest';
import { PeopleCard } from './monitor/PeopleCard';
import { HelpButton, useFirstVisitTour } from '../components/Guide';
import { NurserySettings } from './monitor/NurserySettings';
import { SafetyCard } from './monitor/SafetyCard';
import { WeekCard } from './monitor/WeekCard';
import { ReportSheet, SleepCard } from './monitor/SleepCard';
import { SoundLevelCard } from './monitor/SoundLevelCard';
import { ZoneEditor } from './monitor/ZoneEditor';

const BUCKET_MS = 5 * 60_000;
const SOUND_SET = new Set<string>(SOUND_CATS);
const CARE = new Set(['feed', 'diaper', 'sleep', 'wake', 'note']);
const ROOM_KINDS = new Set([
  'offline', 'online', 'battery', 'camera', 'privacy', 'call', 'people', 'soothe', 'motion', 'moved', 'paused', 'dark', 'lights_on', 'lights_off',
  'visit_start', 'visit_end', 'very_loud', 'loud_db', 'machine', 'noise', 'duty', 'resolved', 'escalated',
]);
const BABY_KINDS = new Set(['cry', 'fuss', 'cough', 'sneeze', 'snore', 'hiccup', 'babble', 'laugh', 'cry_end', 'fuss_end', 'asleep', 'woke', 'resettled', 'sleep_report', 'zone', 'crib_out']);
/** Log kinds that raise an in-app alert (besides the sound categories). */
const ROOM_ALERTS = new Set<string>(Object.keys(ALERT_META));
const PUSH_CATS: { k: string; label: string; locked?: boolean }[] = [
  { k: 'cry', label: 'Crying' }, { k: 'alarm', label: 'Smoke / CO alarm', locked: true }, { k: 'zone', label: 'Danger zones & climbing out' },
  { k: 'glass', label: 'Breaking glass' }, { k: 'crash', label: 'Bangs & crashes' }, { k: 'cough', label: 'Coughing' },
  { k: 'noise', label: 'Very loud noise (85 dB+)' }, { k: 'camera', label: 'Camera moved or knocked' }, { k: 'cat', label: 'Cat in the nursery' },
  { k: 'offline', label: 'Camera offline' }, { k: 'battery', label: 'Camera battery low' }, { k: 'report', label: 'Morning sleep report' },
  { k: 'insight', label: 'Sound machine too loud' }, { k: 'fuss', label: 'Fussing' }, { k: 'loud', label: 'Noise above your threshold' },
  { k: 'guest', label: 'New guests & wrong passcodes (parents)' },
];
const DEFAULT_PUSH: Record<string, boolean> = {
  cry: true, alarm: true, zone: true, glass: true, crash: true, cough: true, noise: true, camera: true, cat: true,
  offline: true, battery: true, report: true, insight: true, fuss: false, loud: false, guest: true,
};

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const readFlag = (k: string) => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const writeFlag = (k: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(k, '1');
    else localStorage.removeItem(k);
  } catch { /* storage unavailable */ }
};
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
  zone: { icon: 'target', tone: 'red' }, crib_out: { icon: 'target', tone: 'red' }, moved: { icon: 'video', tone: 'amber' }, paused: { icon: 'videoOff', tone: 'amber' }, dark: { icon: 'eyeOff', tone: 'amber' },
  lights_on: { icon: 'sun', tone: 'neutral' }, lights_off: { icon: 'moon', tone: 'neutral' }, visit_start: { icon: 'users', tone: 'violet' }, visit_end: { icon: 'users', tone: 'neutral' },
  very_loud: { icon: 'volume', tone: 'amber' }, loud_db: { icon: 'volume', tone: 'amber' }, machine: { icon: 'gauge', tone: 'amber' },
  asleep: { icon: 'moon', tone: 'blue' }, woke: { icon: 'sun', tone: 'blue' }, resettled: { icon: 'moon', tone: 'blue' }, sleep_report: { icon: 'moon', tone: 'violet' },
  duty: { icon: 'heart', tone: 'accent' }, resolved: { icon: 'check', tone: 'green' }, escalated: { icon: 'bell', tone: 'red' },
  motion: { icon: 'activity', tone: 'neutral' }, offline: { icon: 'wifi', tone: 'red' }, online: { icon: 'wifi', tone: 'green' },
  battery: { icon: 'battery', tone: 'amber' }, privacy: { icon: 'eyeOff', tone: 'neutral' }, call: { icon: 'phone', tone: 'violet' },
  feed: { icon: 'bottle', tone: 'blue' }, diaper: { icon: 'sparkles', tone: 'blue' }, sleep: { icon: 'moon', tone: 'blue' },
  wake: { icon: 'sun', tone: 'blue' }, note: { icon: 'edit', tone: 'blue' }, ack: { icon: 'heart', tone: 'accent' },
  soothe: { icon: 'music', tone: 'violet' }, camera: { icon: 'video', tone: 'neutral' }, people: { icon: 'users', tone: 'neutral' },
};
const logMeta = (kind: string) => (SOUND_SET.has(kind) ? { icon: SOUND_INFO[kind as SoundCat].icon, tone: SOUND_INFO[kind as SoundCat].tone } : LOG_META[kind] ?? { icon: 'info', tone: 'neutral' });

const pushKey = (nid: string) => `ds-monitor-push-${nid}`;
/** In-app cue settings, most important first. */
const CUE_ORDER: AlertCat[] = ['cry', 'alarm', 'glass', 'zone', 'crib_out', 'cough', 'crash', 'cat', 'very_loud', 'moved', 'paused', 'offline', 'battery', 'machine', 'fuss', 'loud', 'babble', 'laugh', 'voices', 'music', 'dog'];
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

type LogFilter = 'all' | 'baby' | 'alerts' | 'care' | 'room';
/** monitor: the picture and what needs you · all: every card · bedside: the nightstand view. */
type ViewMode = 'monitor' | 'track' | 'all' | 'bedside';
const VIEW_KEY = 'ds-monitor-view';
/** Log lines worth showing on the nightstand ("Cried 3 min · 2:14"). */
const BEDSIDE_KINDS = new Set(['cry', 'cry_end', 'fuss', 'fuss_end', 'cough', 'asleep', 'woke', 'resettled', 'zone', 'crib_out', 'alarm', 'glass', 'crash', 'very_loud', 'feed', 'diaper', 'sleep', 'wake', 'note', 'ack', 'resolved']);
const canPip = () =>
  typeof document !== 'undefined' &&
  ((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled === true ||
    typeof (HTMLVideoElement.prototype as unknown as { webkitSetPresentationMode?: unknown }).webkitSetPresentationMode === 'function');

export function MonitorViewer({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  // Guests (share link + passcode) watch without an account.
  const [guest, setGuest] = useState(() => loadGuest(id));
  if (guest) return <ViewerInner id={id} nav={nav} push={push} guest={guest} onLeave={() => { clearGuest(id); setGuest(null); nav.monitor(); }} />;
  return (
    <MonitorGate>
      <ViewerInner id={id} nav={nav} push={push} />
    </MonitorGate>
  );
}

function ViewerInner({ id, nav, push, guest, onLeave }: { id: string; nav: Nav; push: PushToast; guest?: GuestPass | null; onLeave?: () => void }) {
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
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [shareErr, setShareErr] = useState<string | null>(null);
  const [me, setMe] = useState<{ sid: string; uid: string; role: MonRole; name: string; label: string | null } | null>(null);
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
  const [wake, setWake] = useState<WakeState>('none');
  const [view, setViewState] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'monitor' || v === 'all' || v === 'track') return v;
    } catch { /* storage unavailable */ }
    return typeof window !== 'undefined' && window.matchMedia?.('(min-width: 980px)').matches ? 'all' : 'monitor';
  });
  const [pip, setPip] = useState(false);
  const tracker = useMemo(() => new TrackerSync(id), [id]);
  const trackSnap = useSyncExternalStore(tracker.subscribe, tracker.snapshot);
  /** Open a tracker sheet from elsewhere (the Monitor view's quick log). */
  const [trackOpen, setTrackOpen] = useState<{ kind: TrackKind; n: number } | null>(null);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [duty, setDuty] = useState<Duty | null>(null);
  const [sleep, setSleep] = useState<SleepStatus | null>(null);
  const [liveMinutes, setLiveMinutes] = useState<MinuteRow[]>([]);
  const [query, setQuery] = useState<MonQuery | null>(null);
  const queryRef = useRef<MonQuery | null>(null);
  const [report, setReport] = useState<{ session?: string } | null>(null);
  const [zoneEdit, setZoneEdit] = useState(false);
  const [stalled, setStalled] = useState(false);
  // Two-way audio etiquette: walkie-talkie by default, silent alerts near the nursery.
  const [hearWhileTalking, setHearWhileTalking] = useState(() => readFlag('ds-monitor-hear-while-talking'));
  const [silentHere, setSilentHere] = useState(() => readFlag(`ds-monitor-silent-${id}`));
  const [near, setNear] = useState(false);
  const loudToldRef = useRef(false);
  const lastFrameRef = useRef(Date.now());
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
      if (s !== 'connected') tracker.detach();
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
      queryRef.current?.cancelAll();
      stopMicMeter();
      cues.stopAll();
      if (relayUrlRef.current) URL.revokeObjectURL(relayUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reconnectKey]);

  useEffect(() => () => cuesRef.current.close(), []);
  useEffect(() => {
    cuesRef.current.quiet = silentHere || near;
  }, [silentHere, near]);

  // Attach the self-view (video call) whenever it mounts.
  useEffect(() => {
    const v = selfRef.current;
    if (v && call && v.srcObject !== call.stream) {
      v.srcObject = call.stream;
      void v.play().catch(() => undefined);
    }
  });

  // Notice a frozen picture (e.g. the camera phone locked its screen) even when
  // the camera can't tell us — it may already be suspended.
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void }) | null;
    if (!v || !hasVideo) {
      setStalled(false);
      return;
    }
    let alive = true;
    let handle = 0;
    let lastTime = -1;
    const onFrame = () => {
      lastFrameRef.current = Date.now();
      if (alive && v.requestVideoFrameCallback) handle = v.requestVideoFrameCallback(onFrame);
    };
    lastFrameRef.current = Date.now();
    if (v.requestVideoFrameCallback) handle = v.requestVideoFrameCallback(onFrame);
    const onVis = () => {
      if (document.visibilityState === 'visible') lastFrameRef.current = Date.now();
    };
    document.addEventListener('visibilitychange', onVis);
    const t = window.setInterval(() => {
      if (!v.requestVideoFrameCallback && v.currentTime !== lastTime) {
        lastTime = v.currentTime;
        lastFrameRef.current = Date.now();
      }
      setStalled(document.visibilityState === 'visible' && Date.now() - lastFrameRef.current > 6000);
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      if (handle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(handle);
    };
  }, [hasVideo]);

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
    if (m.t === 'track' || m.t === 'track_del' || m.t === 'track_err') {
      tracker.handle(m);
      return;
    }
    switch (m.t) {
      case 'hello': {
        setMe({ sid: m.you.sid, uid: m.you.uid, role: m.you.role, name: m.you.name, label: m.you.label });
        setIncidents((m.incidents ?? []).filter((i) => i.status !== 'resolved'));
        setDuty(m.duty ?? null);
        setSleep(m.sleep ?? null);
        // A fresh query channel per connection: cards reload their history.
        queryRef.current?.cancelAll();
        queryRef.current = new MonQuery((q) => sockRef.current?.send(q));
        setQuery(queryRef.current);
        tracker.attach((msg) => sockRef.current?.send(msg), queryRef.current, m.track);
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
        if (!guest) markSetup(id, 'watch');
        try {
          const focus = sessionStorage.getItem(FOCUS_KEY);
          if (focus) {
            sessionStorage.removeItem(FOCUS_KEY);
            window.setTimeout(() => document.querySelector(`[data-tour="mv-${focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 600);
          }
        } catch { /* storage unavailable */ }
        if (m.cams.length) markSetup(id, 'camera');
        // An episode still in progress when we join: show it (no sound).
        const recent = [...m.log].reverse().find((e) => ['cry', 'alarm', 'zone', 'crib_out', 'glass'].includes(e.kind) && Date.now() - e.at < 3 * 60_000);
        if (recent && !m.log.some((e) => e.at > recent.at && (e.kind === 'cry_end' || e.kind === 'ack' || e.kind === 'resolved'))) {
          raise(recent.kind as AlertCat, recent.msg.split(' · ')[0], recent.id, true);
        }
        void restorePush();
        break;
      }
      case 'share':
        setShare(m.share);
        setShareErr(null);
        break;
      case 'share_err':
        setShareErr(m.msg);
        break;
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
        else if (ROOM_ALERTS.has(e.kind)) raise(e.kind as AlertCat, e.msg.split(' · ')[0], e.id);
        else if (e.kind === 'escalated') {
          // Nobody answered: sound the alert again, louder in everyone's ears.
          const inc = incidentsRef.current.find((i) => i.id === e.incident);
          const cat = inc && (SOUND_SET.has(inc.kind) || ROOM_ALERTS.has(inc.kind)) ? (inc.kind as AlertCat) : null;
          if (cat) cuesRef.current.raise(`${e.id}`, cat, e.msg);
        } else if (e.kind === 'cry_end') resolve('cry', e.secs);
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
      case 'incident': {
        const inc = m.inc;
        setIncidents((list) => [inc, ...list.filter((i) => i.id !== inc.id)].filter((i) => i.status !== 'resolved'));
        if (inc.status === 'resolved' && (SOUND_SET.has(inc.kind) || ROOM_ALERTS.has(inc.kind))) resolve(inc.kind as AlertCat);
        break;
      }
      case 'duty':
        setDuty(m.duty);
        break;
      case 'sleep':
        setSleep(m.sleep);
        break;
      case 'minutes':
        setLiveMinutes((prev) => [...prev, ...m.rows].slice(-240));
        break;
      case 'r':
        queryRef.current?.handle(m);
        break;
      case 'tell':
        if (m.c === 'talk_gain') {
          linkRef.current?.scaleTalk(m.v.factor ?? 1);
          if (!loudToldRef.current) {
            loudToldRef.current = true;
            push(`Turned your voice down — it was ${m.v.db ? `about ${m.v.db} dB ` : ''}loud at the crib`, { icon: 'volume', duration: 4500 });
          }
        } else if (m.c === 'feedback') {
          // We're close enough to the camera to howl: break the loop.
          setNear(true);
          if (videoRef.current) videoRef.current.muted = true;
          linkRef.current?.scaleTalk(0.7);
        }
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
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents;
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
    wakeRef.current.onChange = setWake;
    if (keepAwake || view === 'bedside') void wakeRef.current.enable();
    else void wakeRef.current.disable();
    return () => void wakeRef.current.disable();
  }, [keepAwake, view]);

  const setView = (v: ViewMode) => {
    setViewState(v);
    if (v !== 'bedside') {
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch { /* storage unavailable */ }
    }
  };

  /** Pop the picture out (system picture-in-picture) to keep watching in other apps. */
  const togglePip = async () => {
    const v = videoRef.current as (HTMLVideoElement & { webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string }) | null;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
      else v.webkitSetPresentationMode?.(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    } catch {
      push('This browser can’t pop the video out right now', { icon: 'info' });
    }
  };
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const on = () => setPip(true);
    const off = () => setPip(false);
    v.addEventListener('enterpictureinpicture', on);
    v.addEventListener('leavepictureinpicture', off);
    return () => {
      v.removeEventListener('enterpictureinpicture', on);
      v.removeEventListener('leavepictureinpicture', off);
    };
  }, [hasVideo]);

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

  /** duplex: a video call stays two-way (unless the phones are howling). */
  const startTalk = async (opts: { duplex?: boolean } = {}): Promise<boolean> => {
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
    // Walkie-talkie: the nursery's sound pauses on this phone while you talk,
    // so the two phones can't feed back into each other.
    if ((near || (!opts.duplex && !hearWhileTalking)) && videoRef.current) videoRef.current.muted = true;
    return true;
  };

  const stopTalk = async () => {
    stopMicMeter();
    await linkRef.current?.stopTalk();
    if (cam) sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: false } });
    setTalk('off');
    if (videoRef.current) videoRef.current.muted = muted;
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
    if (talk === 'off') void startTalk({ duplex: true }); // a video call is a call: mic on too
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

  const ackIncident = (inc: Incident) => {
    sockRef.current?.send({ t: 'ack', inc: inc.id });
    cuesRef.current.acked();
    setAlerts((list) => list.map((x) => (!x.ended && !x.acked ? { ...x, acked: 'You' } : x)));
  };

  const resolveIncident = (inc: Incident) => {
    sockRef.current?.send({ t: 'resolve', inc: inc.id });
    if (SOUND_SET.has(inc.kind) || ROOM_ALERTS.has(inc.kind)) resolve(inc.kind as AlertCat);
  };

  const camZones: Zone[] = cam ? settings.zones?.[cam.dev] ?? [] : [];
  const saveZones = (list: Zone[]) => {
    if (!cam) return;
    sockRef.current?.send({ t: 'settings', zones: { dev: cam.dev, list } });
    setZoneEdit(false);
    push(list.length ? `Zones saved — ${cam.dn} watches them now` : 'Zones cleared', { icon: 'check' });
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
          {guest ? (
            <Btn variant="ghost" icon="logout" onClick={() => onLeave?.()}>Close</Btn>
          ) : (
            <>
              <Btn variant="ghost" icon="arrowLeft" onClick={() => nav.monitor()}>All nurseries</Btn>
              <Btn variant="solid" icon="refresh" onClick={() => setReconnectKey((k) => k + 1)}>Try again</Btn>
            </>
          )}
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
      {camStatus?.st.paused && state !== 'offline' ? (
        <div className="mv-paused">
          <Icon name={camStatus.st.paused === 'privacy' ? 'eyeOff' : 'videoOff'} size={20} />
          {camStatus.st.paused === 'privacy'
            ? 'Video paused for privacy — sound monitoring and alerts continue'
            : camStatus.st.paused === 'hidden'
              ? 'The camera phone locked its screen or left the app, so its video stopped. Open Stream Studio on that phone.'
              : 'The camera phone paused the video (a call or another app). Sound monitoring continues.'}
        </div>
      ) : stalled && hasVideo && state !== 'offline' ? (
        <div className="mv-paused">
          <Icon name="videoOff" size={20} />
          The picture stopped updating — the camera phone may have locked its screen. Sound and alerts continue; check the camera phone.
        </div>
      ) : null}
      <div className="mv-ov-tl">
        <span className={cx('state-chip', `tone-${info.tone}`)}><span className="state-dot" />{info.label}</span>
        {camStatus?.st.spl && state !== 'offline' && state !== 'unknown' && (
          <span className={cx('ov-pill db', camStatus.st.spl.db >= 80 ? 'hot' : camStatus.st.spl.db >= 60 && 'warm')} title="Sound level in the nursery (A-weighted)">
            <Icon name="gauge" size={11} />{camStatus.st.spl.cal ? '' : '≈'}{Math.round(camStatus.st.spl.db)} dB
          </span>
        )}
        {relayOn && <span className="ov-pill">Low-bandwidth · 1 fps · no audio</span>}
        {linkState === 'connected' && <span className="ov-pill p2p" title="Encrypted, device-to-device"><Icon name="lock" size={11} /><span>Encrypted · P2P</span></span>}
      </div>
      <div className="mv-ov-tr">
        <button className="mv-mini" onClick={() => setNight((v) => !v)} aria-pressed={night} aria-label="Night view" title="Night view"><Icon name="moon" size={16} /></button>
        {hasVideo && canPip() && (
          <button className="mv-mini" onClick={() => void togglePip()} aria-pressed={pip} aria-label="Pop out the video" title="Pop out — keep watching in other apps"><Icon name="layers" size={16} /></button>
        )}
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
  const runningSleep = trackSnap.running.find((r) => r.kind === 'sleep');
  const openTrack = (kind: TrackKind) => {
    setView('track');
    setTrackOpen({ kind, n: Date.now() });
  };
  const quickLogs = canAct && (
    <div className="card card-pad mv-quick" data-tour="mv-log">
      <div className="row" style={{ alignItems: 'center' }}>
        <div className="mv-sect-title" style={{ margin: 0, flex: 1 }}>Quick log</div>
        <button className="linkish" onClick={() => setView('track')}>Open the tracker</button>
      </div>
      <div className="quick-grid">
        <button onClick={() => openTrack('bottle')}><Icon name="bottle" size={17} />Bottle</button>
        <button onClick={() => openTrack('breast')}><Icon name="breast" size={17} />Breast</button>
        <button onClick={() => openTrack('diaper')}><Icon name="diaper" size={17} />Diaper</button>
        <button onClick={() => {
          if (!runningSleep) return openTrack('sleep');
          tracker.put(stopTimer(runningSleep, Date.now()));
          push(`${baby} woke up — sleep logged`, { icon: 'sun', duration: 2000 });
        }}><Icon name={runningSleep ? 'sun' : 'moon'} size={17} />{runningSleep ? 'Woke up' : 'Sleep'}</button>
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
        {([['all', 'All'], ['baby', 'Baby'], ['alerts', 'Alerts'], ['care', 'Care'], ['room', 'Room & camera']] as [LogFilter, string][]).map(([k, l]) => (
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
        {([...CUE_ORDER, ...SOUND_CATS.filter((c) => !CUE_ORDER.includes(c))] as AlertCat[]).map((c) => {
          const ai = alertInfo(c);
          return (
            <div key={c} className={cx('cue-cat', `t-${ai.tone}`)}>
              <input type="checkbox" checked={c === 'alarm' ? true : cues.cats[c] ?? false} disabled={c === 'alarm'} onChange={(e) => updateCues({ cats: { ...cues.cats, [c]: e.target.checked } })} aria-label={`${ai.label} alerts`} />
              <Icon name={ai.icon} size={14} />
              <span>{ai.label}</span>
              <button className="linkish" onClick={() => cuesRef.current.preview(c, ROOM_ALERTS.has(c) ? ai.label : soundHeadline(c as SoundCat, nursery.baby))}>Preview</button>
            </div>
          );
        })}
      </div>
      <label className="row" style={{ gap: 8, fontSize: 13, marginTop: 12 }}>
        <Toggle size="sm" on={keepAwake} onChange={setKeepAwake} label="Keep screen on" />Keep this screen on (Bedside view does this for you)
      </label>
      <label className="row" style={{ gap: 8, fontSize: 13, marginTop: 8 }}>
        <Toggle size="sm" on={silentHere} onChange={(v) => { setSilentHere(v); writeFlag(`ds-monitor-silent-${id}`, v); }} label="Silent alerts on this device" />
        Silent alerts on this device — vibrate &amp; screen only (for a phone in the nursery)
      </label>
      <label className="row" style={{ gap: 8, fontSize: 13, marginTop: 8 }}>
        <Toggle size="sm" on={hearWhileTalking} onChange={(v) => { setHearWhileTalking(v); writeFlag('ds-monitor-hear-while-talking', v); }} label="Hear the nursery while talking" />
        Hear the nursery while I talk (only with headphones — otherwise the phones can howl)
      </label>
    </div>
  );

  const lastLine = [...log].reverse().find((e) => BEDSIDE_KINDS.has(e.kind)) ?? null;
  const bedside = view === 'bedside' && (
    <BedsideView
      stream={(videoRef.current?.srcObject as MediaStream | null) ?? null}
      baby={baby}
      state={{ label: info.label, tone: info.tone, sub: info.sub }}
      db={camStatus?.st.spl && state !== 'offline' && state !== 'unknown' ? camStatus.st.spl.db : null}
      approx={!camStatus?.st.spl?.cal}
      last={lastLine ? { text: lastLine.msg.split(' · ')[0], at: lastLine.at } : null}
      alert={
        top && !top.ended
          ? {
              title: top.title,
              icon: alertInfo(top.cat).icon,
              tone: alertInfo(top.cat).tone,
              ringing: !top.acked,
              sub: top.acked ? `${top.acked === 'You' ? 'You are' : `${top.acked} is`} checking on it` : 'No one has responded yet',
            }
          : null
      }
      muted={muted}
      canAct={canAct}
      talking={talk === 'on'}
      wake={wake}
      onListen={(on) => listen(on)}
      onTalkDown={onTalkDown}
      onTalkUp={onTalkUp}
      onAck={() => top && ack(top)}
      onExit={() => setView('monitor')}
    />
  );

  return (
    <div className={cx('mv-page fade-in', `mode-${view}`)}>
      {bedside}
      {takeover}
      <div className="mv-top">
        {!guest && <button className="iconbtn" onClick={() => nav.nursery(id)} aria-label="Back"><Icon name="arrowLeft" size={17} /></button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mv-title">{nursery.name}{guest && <span className="pill-guest sm">Guest</span>}</div>
          <div className="faint" style={{ fontSize: 12 }}>
            {sock === 'connected' ? `${getDevice().name} · ${me ? ROLE_INFO[me.role].label : ''}` : sock === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
          </div>
        </div>
        <div className="mv-views" role="radiogroup" aria-label="Layout" data-tour="mv-views">
          <button role="radio" aria-checked={view === 'monitor'} className={cx(view === 'monitor' && 'sel')} onClick={() => setView('monitor')} title="Monitor — the picture and what needs you">
            <Icon name="video" size={15} /><span>Monitor</span>
          </button>
          <button role="radio" aria-checked={view === 'track'} className={cx(view === 'track' && 'sel')} onClick={() => setView('track')} title="Tracker — feeds, diapers, sleep, growth and what’s next">
            <Icon name="bottle" size={15} /><span>Tracker</span>
          </button>
          <button role="radio" aria-checked={view === 'all'} className={cx(view === 'all' && 'sel')} onClick={() => setView('all')} title="Everything — sleep, sound level, logs and settings">
            <Icon name="grid" size={15} /><span>All</span>
          </button>
          <button role="radio" aria-checked={false} onClick={() => setView('bedside')} title="Bedside — a dark nightstand view that dims itself">
            <Icon name="moon" size={15} /><span>Bedside</span>
          </button>
        </div>
        <HelpButton />
      </div>
      {alertStack}
      {near && (
        <div className="banner info mv-near">
          <Icon name="volume" size={15} />
          <span style={{ flex: 1 }}>
            This phone is close enough to the camera to cause feedback. The nursery’s sound pauses here while you talk, and alert sounds on this phone are silent (vibrate and screen only) so they don’t reach the baby.
          </span>
          <Btn variant="subtle" size="sm" onClick={() => setNear(false)}>I moved away</Btn>
        </div>
      )}
      <div className={cx('mv-grid', wide && 'wide')}>
        <div className="mv-col">
          {(view !== 'track' || cam) && stage}
          {view !== 'track' && nowCard}
          {view !== 'track' && quickLogs}
        </div>
        <div className="mv-col">
          {view === 'track' ? (
            <TrackerPanel
              nid={id}
              sync={tracker}
              baby={settings.baby ?? null}
              babyName={baby}
              tz={settings.tz}
              me={me ? (me.label ? `${me.name} (${me.label})` : me.name) : 'Me'}
              canLog={canAct}
              isParent={me?.role === 'parent' && !guest}
              guest={!!guest}
              open={trackOpen}
              onSaveBaby={(b) => sockRef.current?.send({ t: 'settings', baby: b })}
              push={push}
            />
          ) : (
          <>
          <SafetyCard
            incidents={incidents}
            duty={duty}
            me={me}
            status={camStatus && state !== 'offline' ? camStatus.st : null}
            online={!!cam && state !== 'offline' && state !== 'unknown'}
            zones={camZones}
            log={log}
            linkState={linkState}
            relayOn={relayOn}
            baby={baby}
            tz={settings.tz}
            onAck={ackIncident}
            onResolve={resolveIncident}
            onDuty={(on) => sockRef.current?.send({ t: 'duty', on, hours: 12 })}
            onZones={() => (hasVideo ? setZoneEdit(true) : push('Wait for the live picture, then mark the zones', { icon: 'info' }))}
            compact={view === 'monitor'}
          />
          {view === 'monitor' ? (
            <button className="mv-more" onClick={() => setView('all')}>
              <Icon name="grid" size={15} />
              <span>Sleep, sound level, activity log, alerts &amp; people</span>
              <Icon name="chevronRight" size={15} />
            </button>
          ) : (
          <>
          <WeekCard query={query} baby={baby} />
          <SleepCard query={query} sleep={sleep} tz={settings.tz} baby={baby} hasCrib={camZones.some((z) => z.kind === 'crib')} tracking={settings.sleepTracking !== false} onOpenReport={(session) => setReport({ session })} />
          <SoundLevelCard query={query} dev={cam?.dev ?? null} spl={camStatus?.st.spl} online={!!cam && state !== 'offline' && state !== 'unknown'} liveMinutes={liveMinutes} tz={settings.tz} machineCheck={settings.machineCheck !== false} />
          {timeline}
          {activity}
          {alertsCard}
          {!guest && <NurserySettings nid={id} nurseryName={nursery.name} role={me?.role ?? null} settings={settings} send={(msg) => sockRef.current?.send(msg)} push={push} />}
          <PeopleCard
            nid={id}
            me={me}
            guest={!!guest}
            viewers={viewers}
            share={share}
            shareErr={shareErr}
            baby={baby}
            nurseryName={nursery.name}
            send={(msg) => {
              setShareErr(null);
              sockRef.current?.send(msg);
            }}
            push={push}
            onLeave={() => {
              if (window.confirm('Leave this nursery? You’ll need the link and passcode to come back.')) {
                sockRef.current?.send({ t: 'bye' });
                onLeave?.();
              }
            }}
          />
          </>
          )}
          </>
          )}
        </div>
      </div>
      {report && (
        <ReportSheet
          query={query}
          session={report.session}
          tz={settings.tz}
          baby={baby}
          canDelete={me?.role === 'parent'}
          onDelete={(session) => sockRef.current?.send({ t: 'sleep_delete', session })}
          onClose={() => setReport(null)}
          push={push}
        />
      )}
      {zoneEdit && cam && (
        <ZoneEditor stream={(videoRef.current?.srcObject as MediaStream | null) ?? null} zones={camZones} onSave={saveZones} onClose={() => setZoneEdit(false)} babyName={nursery.baby} />
      )}
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
    (f === 'baby' && BABY_KINDS.has(e.kind)) ||
    (f === 'alerts' && (e.sev ? e.sev === 'urgent' || e.sev === 'warn' : ['cry', 'fuss', 'cough', 'alarm', 'crash', 'loud', 'offline', 'battery', 'noise'].includes(e.kind))) ||
    (f === 'care' && (e.sev === 'care' || CARE.has(e.kind) || e.kind === 'ack')) ||
    (f === 'room' && (ROOM_KINDS.has(e.kind) || (SOUND_SET.has(e.kind) && !BABY_KINDS.has(e.kind))));
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
