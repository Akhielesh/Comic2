// Baby Monitor — WATCH mode (a parent's phone / laptop).
// Live P2P picture + sound (never recorded), the "is the baby alright?"
// status from the camera's on-device analysis, cry alerts with an "I'm on it"
// hand-off, talk-back, soothing sounds, a 24 h timeline and quick logs.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getDevice, openMonitorSocket, type MonSocketStatus, type MonitorSocket } from '../monitor/client';
import { STATE_INFO, ROLE_INFO, type CamPresence, type CamStatus, type MonLog, type MonRole, type MonServerMsg, type MonSettings, type TimelineBucket, type ViewerPresence } from '../monitor/protocol';
import { currentSubscription, localNotify, needsHomeScreen, pushSupported, subscribe } from '../monitor/push';
import { ViewerLink, type LinkState, type Quality } from '../monitor/rtc';
import { SOOTHE_OPTIONS, type SootheKind } from '../monitor/soothe';
import type { Nav } from '../nav';
import { playChime } from '../prefs';
import { Icon } from '../ui/icons';
import { Btn, Meter, Pill, Segmented, Toggle, cx, useMediaQuery, type PushToast } from '../ui/primitives';
import { ScreenWakeLock } from '../wakeLock';
import { MonitorGate } from './MonitorHome';
import { HelpButton, useFirstVisitTour } from '../components/Guide';

const BUCKET_MS = 5 * 60_000;
const RANK_STATE = ['none', 'calm', 'stirring', 'noisy', 'crying'] as const;
const LOG_ICON: Record<string, string> = {
  cry: 'baby', cry_end: 'check', noise: 'volume', motion: 'activity', offline: 'wifi', online: 'wifi', battery: 'battery',
  feed: 'bottle', diaper: 'sparkles', sleep: 'moon', wake: 'sun', note: 'edit', ack: 'heart', soothe: 'volume', camera: 'video', people: 'users',
};

const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtAgo = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
};

const pushKey = (nid: string) => `ds-monitor-push-${nid}`;
const camKey = (nid: string) => `ds-monitor-cam-${nid}`;

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
  const stageRef = useRef<HTMLDivElement | null>(null);
  const relayUrlRef = useRef<string | null>(null);
  const wakeRef = useRef(new ScreenWakeLock());
  const retryRef = useRef<number | undefined>(undefined);
  const lastCryAlertRef = useRef(0);
  const vapidRef = useRef<string | null>(null);

  const [reconnectKey, setReconnectKey] = useState(0);
  const [sock, setSock] = useState<MonSocketStatus>('connecting');
  const [closedMsg, setClosedMsg] = useState<string | null>(null);
  const [me, setMe] = useState<{ sid: string; role: MonRole; name: string; label: string | null } | null>(null);
  const [nursery, setNursery] = useState<{ name: string; baby: string | null }>({ name: 'Nursery', baby: null });
  const [cams, setCams] = useState<CamPresence[]>([]);
  const [viewers, setViewers] = useState<ViewerPresence[]>([]);
  const [status, setStatus] = useState<Record<string, { st: CamStatus; at: number; since: number }>>({});
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
  const [talking, setTalking] = useState(false);
  const [sootheOpen, setSootheOpen] = useState(false);
  const [sootheKind, setSootheKind] = useState<SootheKind>('shush');
  const [sootheMin, setSootheMin] = useState(30);
  const [alert, setAlert] = useState<{ entryId: string | null; at: number; acked: string | null } | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushPrefs, setPushPrefs] = useState({ cry: true, offline: true, battery: true, noise: false });
  const [keepAwake, setKeepAwake] = useState(false);
  const [note, setNote] = useState('');
  const [, setClock] = useState(0);
  const wide = useMediaQuery('(min-width: 980px)');

  const canAct = me?.role === 'parent' || me?.role === 'caregiver';
  useFirstVisitTour('watch', sock === 'connected');
  const cam = cams.find((c) => c.sid === camSid) ?? null;
  const camStatus = cam ? status[cam.dev] : undefined;

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
    const tick = window.setInterval(() => setClock((c) => c + 1), 15_000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(retryRef.current);
      link.close();
      sockNow.close();
      if (relayUrlRef.current) URL.revokeObjectURL(relayUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reconnectKey]);

  const pickCam = (list: CamPresence[], current: string | null): string | null => {
    if (current && list.some((c) => c.sid === current)) return current;
    let preferred: string | null = null;
    try {
      preferred = localStorage.getItem(camKey(id));
    } catch { /* storage unavailable */ }
    return (list.find((c) => c.dev === preferred) ?? list[0])?.sid ?? null;
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
        setStatus(st);
        setCamSid((cur) => pickCam(m.cams, cur));
        void restorePush();
        break;
      }
      case 'presence':
        setCams(m.cams);
        setViewers(m.viewers);
        setCamSid((cur) => pickCam(m.cams, cur));
        break;
      case 'rtc':
        void linkRef.current?.onSignal(m.from, m.d);
        break;
      case 'status':
        setStatus((prev) => {
          const old = prev[m.dev];
          const since = old && old.st.state === m.st.state ? old.since : m.at;
          if (m.st.state === 'crying' && old?.st.state !== 'crying') onCry(null);
          return { ...prev, [m.dev]: { st: m.st, at: m.at, since } };
        });
        // Live-extend today's timeline with the worst state per 5-min bucket.
        setTl((prev) => {
          const t = Math.floor(m.at / BUCKET_MS) * BUCKET_MS;
          const rank = RANK_STATE.indexOf(m.st.state as (typeof RANK_STATE)[number]);
          const last = prev[prev.length - 1];
          if (last && last[0] === t) {
            if (rank <= last[1]) return prev;
            return [...prev.slice(0, -1), [t, rank, last[2]]];
          }
          return [...prev.filter((b) => b[0] > Date.now() - 24 * 3600_000), [t, rank, 0]];
        });
        break;
      case 'log':
        setLog((l) => [...l.slice(-299), m.entry]);
        if (m.entry.kind === 'cry') onCry(m.entry.id);
        if (m.entry.kind === 'offline') {
          push(m.entry.msg, { icon: 'alert', duration: 6000 });
          if (document.visibilityState !== 'visible' && !pushOnRef.current) void localNotify('Baby camera offline', m.entry.msg, `${id}-offline`, location.href);
        }
        break;
      case 'ack':
        setAlert((a) => (a ? { ...a, acked: m.label || m.by } : a));
        if (m.by !== me?.name) push(`${m.label || m.by} is checking on it`, { icon: 'heart', duration: 4000 });
        break;
      case 'settings':
        setSettings(m.settings);
        break;
      case 'cam_gone':
        if (linkRef.current?.target === m.sid) linkRef.current.close();
        break;
      case 'roles_changed':
        setReconnectKey((k) => k + 1); // re-auth picks up a new role
        break;
      case 'push_ok':
        setPushOn(true);
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
  // The socket outlives renders — always dispatch to the latest handler.
  const onMsgRef = useRef(onMsg);
  onMsgRef.current = onMsg;

  const onCry = (entryId: string | null) => {
    const now = Date.now();
    setAlert((a) => (a && now - a.at < 60_000 ? { ...a, entryId: entryId ?? a.entryId } : { entryId, at: now, acked: null }));
    if (now - lastCryAlertRef.current < 20_000) return;
    lastCryAlertRef.current = now;
    try {
      navigator.vibrate?.([300, 120, 300]);
    } catch { /* unsupported */ }
    playChime();
    window.setTimeout(playChime, 650);
    if (document.visibilityState !== 'visible' && !pushOnRef.current) {
      void localNotify(`${nursery.baby || 'Baby'} is crying`, `${nursery.name} — tap to check in`, `${id}-cry`, location.href);
    }
  };

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

  // P2P blocked by the network → low-bandwidth snapshot relay, and keep
  // retrying the real link every minute.
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
  const listen = () => {
    setMuted(false);
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      void v.play().catch(() => undefined);
    }
  };

  const toggleTalk = async () => {
    const link = linkRef.current;
    if (!link || !cam) return;
    if (talking) {
      await link.stopTalk();
      sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: false } });
      setTalking(false);
    } else {
      sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: true } });
      const ok = await link.startTalk();
      if (!ok) {
        sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'talk', v: { on: false } });
        push('Microphone unavailable — allow it to talk to the nursery', { icon: 'alert' });
        return;
      }
      setTalking(true);
    }
  };

  const setQ = (q: Quality) => {
    setQuality(q);
    if (cam) sockRef.current?.send({ t: 'cmd', to: cam.sid, c: 'quality', v: { q } });
  };

  const soothe = (on: boolean) => {
    if (!cam) return;
    sockRef.current?.send({ t: 'cmd', to: cam.sid, c: on ? 'soothe' : 'soothe_stop', v: { kind: sootheKind, minutes: sootheMin } });
    setSootheOpen(false);
    push(on ? 'Soothing sounds starting in the nursery' : 'Stopping soothing sounds', { icon: 'volume' });
  };

  const ack = () => {
    sockRef.current?.send({ t: 'ack', id: alert?.entryId ?? '' });
    setAlert((a) => (a ? { ...a, acked: 'You' } : a));
  };

  const quickLog = (kind: 'feed' | 'diaper' | 'sleep' | 'wake' | 'note', text = '') => {
    sockRef.current?.send({ t: 'log', kind, text });
    if (kind === 'note') setNote('');
  };

  const restorePush = async () => {
    let enabled = false;
    try {
      enabled = localStorage.getItem(pushKey(id)) === '1';
      const saved = localStorage.getItem(`${pushKey(id)}-prefs`);
      if (saved) setPushPrefs(JSON.parse(saved));
    } catch { /* storage unavailable */ }
    if (!enabled) return;
    const sub = await currentSubscription();
    if (sub) {
      let prefs = pushPrefs;
      try {
        prefs = JSON.parse(localStorage.getItem(`${pushKey(id)}-prefs`) || 'null') ?? pushPrefs;
      } catch { /* default */ }
      sockRef.current?.send({ t: 'push_sub', sub: sub.toJSON(), prefs });
    }
  };

  const enablePush = async (prefs = pushPrefs) => {
    const vapid = vapidRef.current;
    if (!vapid) {
      push('Alerts aren’t available yet — try again in a moment', { icon: 'alert' });
      return;
    }
    const r = await subscribe(vapid);
    if ('error' in r) {
      push(r.error, { icon: 'alert', duration: 6000 });
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

  const updatePushPref = (k: keyof typeof pushPrefs, v: boolean) => {
    const next = { ...pushPrefs, [k]: v };
    setPushPrefs(next);
    if (pushOn) void enablePush(next);
  };

  const fullscreen = () => {
    const el = stageRef.current;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el?.requestFullscreen?.().catch(() => undefined);
  };

  /* ------------------------------------------------------------ derived */
  const now = Date.now();
  const state = !cam ? 'unknown' : !camStatus ? 'unknown' : now - camStatus.at < 30_000 ? camStatus.st.state : 'offline';
  const info = STATE_INFO[state];
  const today = useMemo(() => summarize(log, tl), [log, tl]);
  const crying = state === 'crying';
  const soothingNow = camStatus?.st.soothing ?? null;

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

  const stage = (
    <div className={cx('mv-stage', night && 'night')} ref={stageRef} data-tour="mv-stage">
      <video ref={videoRef} autoPlay playsInline muted={muted} className={cx(!hasVideo && 'hidden')} />
      {relayOn && relayUrl && <img src={relayUrl} alt="Nursery snapshot (low-bandwidth mode)" className="mv-relay" />}
      {!cam && (
        <div className="mv-empty">
          <Icon name="video" size={30} />
          <b>No camera is on</b>
          <span>Open this nursery on a phone in the room and tap “Be the camera”.</span>
        </div>
      )}
      {cam && !hasVideo && !relayUrl && (
        <div className="mv-empty">
          <div className="knock-dots" aria-hidden><span /><span /><span /></div>
          <span>{linkState === 'failed' ? 'Your network blocks direct video — switching to low-bandwidth mode…' : quality === 'audio' ? 'Audio-only mode' : 'Connecting securely to the camera…'}</span>
        </div>
      )}
      <div className="mv-ov-tl">
        <span className={cx('state-chip', `tone-${info.tone}`)}><span className="state-dot" />{info.label}</span>
        {relayOn && <span className="ov-pill">Low-bandwidth · 1 fps · no audio</span>}
        {linkState === 'connected' && <span className="ov-pill"><Icon name="lock" size={11} />Encrypted · P2P</span>}
      </div>
      {cam && muted && (
        <button className="mv-listen" onClick={listen}><Icon name="volume" size={18} />Tap to hear the nursery</button>
      )}
      {talking && <div className="mv-talking"><Icon name="mic" size={15} />Talking to the nursery…</div>}
      <div className="mv-controls">
        {canAct && cam && (
          <button className={cx('mv-ctl', talking && 'on')} onClick={() => void toggleTalk()} aria-label={talking ? 'Stop talking' : 'Talk'} data-tour="mv-talk">
            <Icon name={talking ? 'micOff' : 'mic'} size={18} /><span>{talking ? 'Stop' : 'Talk'}</span>
          </button>
        )}
        {canAct && cam && (
          <button className={cx('mv-ctl', (sootheOpen || soothingNow) && 'on')} onClick={() => setSootheOpen((v) => !v)} aria-label="Soothing sounds">
            <Icon name="music" size={18} /><span>Soothe</span>
          </button>
        )}
        <button className={cx('mv-ctl', night && 'on')} onClick={() => setNight((v) => !v)} aria-label="Night view">
          <Icon name="moon" size={18} /><span>Night</span>
        </button>
        <button className="mv-ctl" onClick={fullscreen} aria-label="Fullscreen">
          <Icon name="maximize" size={18} /><span>Full</span>
        </button>
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

  const statusCard = (
    <div className={cx('card mv-status', `tone-${info.tone}`)} data-tour="mv-status">
      <div className="mvs-head">
        <span className={cx('state-dot big', `tone-${info.tone}`)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mvs-state">{nursery.baby ? `${nursery.baby} · ` : ''}{info.label}</div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {camStatus && state !== 'unknown' ? `${info.sub} · for ${fmtAgo(now - camStatus.since)}` : info.sub}
          </div>
        </div>
      </div>
      {camStatus && state !== 'unknown' && (
        <div className="mvs-meters">
          <label><span>Sound</span><Meter value={camStatus.st.level} max={45} tone={camStatus.st.level > 24 ? 'live' : camStatus.st.level > 12 ? 'amber' : 'green'} /></label>
          <label><span>Motion</span><Meter value={camStatus.st.motion} max={100} tone={camStatus.st.motion > 35 ? 'amber' : 'green'} /></label>
          <div className="mvs-chips">
            {camStatus.st.light < 35 && <Pill tone="info" icon="moon">Dark room — try Night view</Pill>}
            {camStatus.st.battery != null && (
              <Pill tone={camStatus.st.battery <= 20 && !camStatus.st.charging ? 'live' : 'neutral'} icon="battery">
                {camStatus.st.battery}%{camStatus.st.charging ? ' · charging' : ''}
              </Pill>
            )}
            {soothingNow && <Pill tone="accent" icon="music">{SOOTHE_OPTIONS.find((o) => o.id === soothingNow)?.label}</Pill>}
          </div>
        </div>
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
          <span className="faint" style={{ fontSize: 12 }}>{cam.dn} · started by {cam.by}</span>
        </div>
      )}
    </div>
  );

  const alertBanner = (crying || (alert && now - alert.at < 120_000)) && (
    <div className={cx('mv-alert', crying && 'live')} role="alert">
      <Icon name="baby" size={20} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{crying ? `${nursery.baby || 'Baby'} is crying` : `${nursery.baby || 'Baby'} was crying`}</b>
        <div style={{ fontSize: 12.5 }}>{alert?.acked ? `${alert.acked === 'You' ? 'You are' : `${alert.acked} is`} checking on it` : 'No one has responded yet'}</div>
      </div>
      {canAct && !alert?.acked && <Btn variant="solid" size="sm" icon="heart" onClick={ack}>I’m on it</Btn>}
      {canAct && cam && !soothingNow && <Btn variant="soft" size="sm" icon="music" onClick={() => setSootheOpen(true)}>Soothe</Btn>}
    </div>
  );

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
        <div><b>{today.cries}</b><span>cry episodes</span></div>
        <div><b>{today.calmH}</b><span>calm (camera on)</span></div>
        <div><b>{today.lastFeed ?? '—'}</b><span>last fed</span></div>
        <div><b>{today.lastDiaper ?? '—'}</b><span>last diaper</span></div>
      </div>
      {today.sleeping && <div className="banner info" style={{ marginTop: 10 }}><Icon name="moon" size={15} />Logged asleep since {today.sleeping}</div>}
    </div>
  );

  const activity = (
    <div className="card mv-activity">
      <div className="card-head"><Icon name="activity" size={15} /><h3>Activity</h3></div>
      <div className="mv-log-list">
        {log.length === 0 && <div className="faint" style={{ padding: 16, fontSize: 13 }}>Nothing yet — cries, wake-ups, feeds and notes will show up here.</div>}
        {log.slice().reverse().slice(0, 80).map((e) => (
          <div key={e.id} className={cx('mv-log', `k-${e.kind}`)}>
            <Icon name={LOG_ICON[e.kind] ?? 'info'} size={14} />
            <span className="mv-log-msg">{e.msg}{e.by && !['ack', 'people'].includes(e.kind) ? <span className="faint"> · {e.by}</span> : null}</span>
            <span className="mono faint">{fmtTime(e.at)}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const alertsCard = (
    <div className="card card-pad" data-tour="mv-alerts">
      <div className="row" style={{ gap: 10 }}>
        <Icon name="bell" size={17} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Alerts on this device</b>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {!pushSupported()
              ? 'This browser can’t alert in the background — keep this page open.'
              : needsHomeScreen()
                ? 'On iPhone: Share → Add to Home Screen, open it from there, then turn alerts on.'
                : 'Get notified even when Stream Studio is closed.'}
          </div>
        </div>
        <Toggle on={pushOn} onChange={(v) => void (v ? enablePush() : disablePush())} label="Background alerts" />
      </div>
      <div className="alert-prefs">
        {([['cry', 'Crying'], ['offline', 'Camera offline'], ['battery', 'Low battery'], ['noise', 'Loud noises']] as const).map(([k, l]) => (
          <label key={k}><input type="checkbox" checked={pushPrefs[k]} onChange={(e) => updatePushPref(k, e.target.checked)} />{l}</label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        {pushOn && <Btn variant="soft" size="sm" icon="bell" onClick={() => sockRef.current?.send({ t: 'push_test' })}>Send test alert</Btn>}
        <label className="row" style={{ gap: 8, fontSize: 13 }}>
          <Toggle size="sm" on={keepAwake} onChange={setKeepAwake} label="Keep screen on" />Keep this screen on (bedside mode)
        </label>
      </div>
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
          <div className="mv-sect-title" style={{ marginTop: 14 }}>Cry detection (parents)</div>
          <Segmented label="Sensitivity" options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} value={settings.sensitivity} onChange={(v) => sockRef.current?.send({ t: 'settings', sensitivity: v })} />
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>High catches soft whimpers; Low ignores fussing and only alerts on full cries.</div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <span style={{ fontSize: 13 }}>Repeat cry alerts every</span>
            <Segmented label="Repeat" options={[{ value: '2', label: '2m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }, { value: '10', label: '10m' }]} value={String(settings.cryRepeatMin)} onChange={(v) => sockRef.current?.send({ t: 'settings', cryRepeatMin: Number(v) })} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="mv-page fade-in">
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
      {alertBanner}
      <div className={cx('mv-grid', wide && 'wide')}>
        <div className="mv-col">
          {stage}
          {statusCard}
          {quickLogs}
        </div>
        <div className="mv-col">
          {timeline}
          {alertsCard}
          {activity}
          {peopleCard}
        </div>
      </div>
      <p className="mv-disclaimer">
        Live only — nothing is recorded or stored. Cry detection runs on the camera phone. Not a medical device: it doesn’t monitor breathing or safe sleep.
      </p>
    </div>
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
    <div className="tl-wrap" aria-label="Calm, stirring and crying over the last 24 hours">
      <div className="tl-strip">
        {cells.map((r, i) => <i key={i} className={`r${r}`} />)}
      </div>
      <div className="tl-marks">
        {marks.map((m) => <span key={m.left} style={{ left: m.left }}>{m.label}</span>)}
        <span style={{ right: 0 }}>now</span>
      </div>
      <div className="tl-legend">
        <span><i className="r1" />Calm</span><span><i className="r2" />Stirring</span><span><i className="r3" />Noisy</span><span><i className="r4" />Crying</span><span><i className="r0" />Camera off</span>
      </div>
    </div>
  );
}

function summarize(log: MonLog[], tl: TimelineBucket[]) {
  const dayAgo = Date.now() - 24 * 3600_000;
  const recent = log.filter((l) => l.at >= dayAgo);
  const last = (k: MonLog['kind']) => {
    const e = [...recent].reverse().find((l) => l.kind === k);
    return e ? fmtTime(e.at) : null;
  };
  const lastSleep = [...recent].reverse().find((l) => l.kind === 'sleep' || l.kind === 'wake');
  const calmBuckets = tl.filter((b) => b[0] >= dayAgo && b[1] === 1).length;
  const calmMin = calmBuckets * 5;
  return {
    cries: recent.filter((l) => l.kind === 'cry').length,
    calmH: calmMin >= 60 ? `${Math.floor(calmMin / 60)}h ${calmMin % 60}m` : `${calmMin}m`,
    lastFeed: last('feed'),
    lastDiaper: last('diaper'),
    sleeping: lastSleep?.kind === 'sleep' ? fmtTime(lastSleep.at) : null,
  };
}
