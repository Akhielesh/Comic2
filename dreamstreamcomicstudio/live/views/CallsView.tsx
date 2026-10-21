// Family calls — the people in your nurseries, one tap to video or voice
// call them (or everyone at once), recent calls with missed ones marked, and
// "Ring this device" so a call reaches a phone with the app closed.
import React, { useEffect, useMemo, useState } from 'react';
import { openAuth, useAccount } from '../account';
import { callCenter, useCalls } from '../calls/callCenter';
import { unlockCallAudio } from '../calls/ringtone';
import { MAX_IN_CALL } from '../calls/types';
import { listNurseries, listPeople, type Nursery, type NurseryPerson } from '../monitor/client';
import { needsHomeScreen, pushSupported } from '../monitor/push';
import { ROLE_INFO } from '../monitor/protocol';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Avatar, Btn, cx, type PushToast } from '../ui/primitives';
import { CALLS_SEEN_KEY, isMissed } from './callsBadge';

const when = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};
const length = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function CallsView({ nav, push }: { nav: Nav; push: PushToast }) {
  const account = useAccount();
  const calls = useCalls();
  const [nurseries, setNurseries] = useState<Nursery[] | null>(null);
  const [people, setPeople] = useState<Record<string, NurseryPerson[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const member = account.status === 'member';

  useEffect(() => {
    if (!member) return;
    let alive = true;
    void callCenter.refresh(); // a nursery joined since the app opened gets its line now
    void (async () => {
      const r = await listNurseries();
      if (!alive) return;
      const list = r.ok ? r.nurseries ?? [] : [];
      setNurseries(list);
      const all = await Promise.all(list.map(async (n) => [n.id, (await listPeople(n.id)).people ?? []] as const));
      if (alive) setPeople(Object.fromEntries(all));
    })();
    return () => {
      alive = false;
    };
  }, [member]);

  // Opening Calls clears the missed-call badge.
  useEffect(() => {
    try {
      localStorage.setItem(CALLS_SEEN_KEY, String(Date.now()));
    } catch { /* storage unavailable */ }
  }, [calls.log.length]);

  const place = async (nid: string, who: { uid: string; name: string }[], video: boolean) => {
    unlockCallAudio();
    setBusy(`${nid}:${who.map((w) => w.uid).join(',')}:${video}`);
    const err = await callCenter.call(nid, who, video);
    setBusy(null);
    if (err) push(err, { icon: 'alert', duration: 7000 });
  };

  const toggleRing = async () => {
    if (calls.ringOn) {
      await callCenter.disableRinging();
      push('This device won’t ring when Stream Studio is closed', { icon: 'check' });
      return;
    }
    const r = await callCenter.enableRinging();
    if ('error' in r) push(r.error, { icon: 'alert', duration: 8000 });
    else push('This device will ring for family calls, even with the app closed', { icon: 'bell' });
  };

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const list of Object.values(people)) for (const p of list) m.set(p.user_id, p.label || p.display_name);
    return m;
  }, [people]);

  if (account.status === 'loading') return <div className="page"><div className="skeleton" style={{ height: 120 }} aria-label="Loading account" /></div>;
  if (!member) {
    return (
      <div className="page page-narrow fade-in">
        <div className="monitor-hero">
          <div className="mh-icon"><Icon name="video" size={30} /></div>
          <h1 className="page-title">Family calls</h1>
          <p className="page-sub">Video and voice calls with the people in your nurseries — Grandma, the sitter, the other parent. Device to device, encrypted, never recorded.</p>
          {account.status === 'needs_code' ? (
            <Btn variant="solid" size="lg" icon="lock" onClick={() => openAuth('code')}>Enter your welcome code</Btn>
          ) : (
            <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
              <Btn variant="solid" size="lg" onClick={() => openAuth('create')}>Create account</Btn>
              <Btn variant="ghost" size="lg" onClick={() => openAuth('signin')}>Sign in</Btn>
            </div>
          )}
        </div>
      </div>
    );
  }

  const me = calls.uid;
  const recents = calls.log;
  const homeScreen = needsHomeScreen();

  return (
    <div className="page fade-in calls-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">Video and voice calls with your family — device to device, encrypted, never recorded.</p>
        </div>
      </div>

      <div className={cx('card card-pad ring-card', calls.ringOn && 'on')} data-tour="calls-ring">
        <Icon name="bell" size={18} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{calls.ringOn ? 'This device rings for calls' : 'Ring this device when the app is closed'}</b>
          <small>
            {calls.ringOn
              ? 'Calls reach you even when Stream Studio isn’t open.'
              : homeScreen
                ? 'On iPhone, add Stream Studio to your Home Screen first (Share → Add to Home Screen), then turn this on from there.'
                : pushSupported()
                  ? 'Right now calls ring only while Stream Studio is open somewhere on this device.'
                  : 'This browser can only ring while Stream Studio is open.'}
          </small>
        </div>
        {(pushSupported() || calls.ringOn) && !homeScreen && (
          <Btn variant={calls.ringOn ? 'ghost' : 'solid'} size="sm" onClick={() => void toggleRing()}>{calls.ringOn ? 'Turn off' : 'Turn on'}</Btn>
        )}
      </div>

      {nurseries === null ? (
        <div className="skeleton" style={{ height: 160 }} aria-label="Loading family" />
      ) : nurseries.length === 0 ? (
        <div className="card card-pad empty-calls">
          <Icon name="users" size={22} />
          <p>Calls are for the people in your nurseries. Create a nursery and add your family — or ask a parent to add you to theirs.</p>
          <Btn variant="solid" icon="baby" onClick={() => nav.monitor()}>Open Baby monitor</Btn>
        </div>
      ) : (
        nurseries.map((n) => {
          const list = (people[n.id] ?? []).filter((p) => !p.is_me);
          const line = calls.lines.find((l) => l.nid === n.id);
          const group = list.slice(0, MAX_IN_CALL - 1).map((p) => ({ uid: p.user_id, name: p.label || p.display_name }));
          return (
            <section key={n.id} className="card card-pad family-card" data-tour="calls-family">
              <div className="row family-head">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{n.name}</b>
                  <small className="faint">{n.baby_name ? `${n.baby_name}’s family` : 'Family'}{line && !line.connected ? ' · connecting…' : ''}</small>
                </div>
                {list.length > 1 && (
                  <Btn variant="soft" size="sm" icon="video" disabled={!line?.connected || !!calls.active} onClick={() => void place(n.id, group, true)}>
                    {list.length > MAX_IN_CALL - 1 ? `Call ${MAX_IN_CALL - 1}` : 'Call everyone'}
                  </Btn>
                )}
              </div>
              {people[n.id] == null ? (
                <div className="skeleton" style={{ height: 52 }} />
              ) : list.length === 0 ? (
                <p className="faint family-empty">Nobody else is in this nursery yet. Add people in the nursery’s People &amp; roles to call them.</p>
              ) : (
                <div className="family-list">
                  {list.map((p) => {
                    const who = [{ uid: p.user_id, name: p.label || p.display_name }];
                    const off = !line?.connected || !!calls.active;
                    return (
                      <div key={p.user_id} className="family-row">
                        <Avatar name={p.display_name} size={40} />
                        <div className="family-who">
                          <b>{p.label || p.display_name}</b>
                          <small>{p.label ? `${p.display_name} · ` : ''}{ROLE_INFO[p.role]?.label ?? p.role}</small>
                        </div>
                        <button className="call-chip" onClick={() => void place(n.id, who, false)} disabled={off || busy != null} aria-label={`Voice call ${who[0].name}`} title="Voice call">
                          <Icon name="phone" size={18} />
                        </button>
                        <button className="call-chip video" onClick={() => void place(n.id, who, true)} disabled={off || busy != null} aria-label={`Video call ${who[0].name}`} title="Video call">
                          <Icon name="video" size={18} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}

      <section className="card card-pad recents-card" data-tour="calls-recents">
        <div className="row" style={{ gap: 10 }}>
          <Icon name="clock" size={17} />
          <b style={{ flex: 1 }}>Recent calls</b>
        </div>
        {recents.length === 0 ? (
          <p className="faint family-empty">Your calls will show here — including any you miss.</p>
        ) : (
          <div className="recent-list">
            {recents.map((r) => {
              const out = r.from.uid === me;
              const missed = isMissed(r, me);
              const others = out
                ? r.invited.map((u) => nameOf.get(u) ?? r.joined.find((j) => j.uid === u)?.name ?? 'Someone')
                : [r.from.label || r.from.name, ...r.joined.filter((j) => j.uid !== r.from.uid && j.uid !== me).map((j) => nameOf.get(j.uid) ?? j.name)];
              const back = out
                ? r.invited.map((u) => ({ uid: u, name: nameOf.get(u) ?? 'Someone' }))
                : [{ uid: r.from.uid, name: r.from.label || r.from.name }];
              const status = missed ? 'Missed' : r.answered ? length(r.secs) : out ? (r.why === 'declined' ? 'Declined' : r.why === 'cancelled' ? 'Cancelled' : 'No answer') : 'Declined';
              return (
                <button key={r.id} className={cx('recent-row', missed && 'missed')} onClick={() => void place(r.nid, back.slice(0, MAX_IN_CALL - 1), r.video)} disabled={!!calls.active} title="Call back">
                  <span className="recent-ic"><Icon name={r.video ? 'video' : 'phone'} size={16} /></span>
                  <span className="recent-who">
                    <b>{[...new Set(others)].join(', ')}</b>
                    <small>{out ? 'Outgoing' : 'Incoming'} · {status} · {r.nursery}</small>
                  </span>
                  <span className="recent-when">{when(r.at)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <p className="faint calls-note">
        <Icon name="lock" size={13} /> Calls go straight between devices, encrypted (WebRTC) — our server only helps them find each other. Nothing is recorded. Only people in your nurseries can call you; share-link guests can’t.
      </p>
    </div>
  );
}
