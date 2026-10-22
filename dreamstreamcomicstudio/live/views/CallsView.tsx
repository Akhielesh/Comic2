// Calls — video and voice calls with your family, or with anyone on Stream
// Studio found by name. Search at the top (family badged as family), your
// favourites one tap away, the people in your nurseries, recent calls with
// missed ones marked, "Ring this device" so a call reaches a phone with the
// app closed, and who may call you (with the people you blocked).
//
// Family calls still go through the nursery (exactly as before); anyone else
// is called through your personal line. Calling someone outside your family
// for the first time asks first — two people can share a name.
import React, { useEffect, useMemo, useState } from 'react';
import { openAuth, searchPeople, useAccount, type Person } from '../account';
import { callCenter, useCalls } from '../calls/callCenter';
import { unlockCallAudio } from '../calls/ringtone';
import { MAX_IN_CALL, type CallWho } from '../calls/types';
import { listNurseries, listPeople, type Nursery, type NurseryPerson } from '../monitor/client';
import { openInvite } from '../monitor/invite';
import { needsHomeScreen, pushSupported } from '../monitor/push';
import { ROLE_INFO } from '../monitor/protocol';
import type { Nav } from '../nav';
import { Icon } from '../ui/icons';
import { Avatar, Btn, cx, IconBtn, Segmented, type PushToast } from '../ui/primitives';
import { CALLS_SEEN_KEY, isMissed } from './callsBadge';
import { badgeFor, familyMap, loadConfirmed, needsConfirm, recentPeople, saveConfirmed, type FamilyMember } from './calls/people';

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

type Who = { uid: string; name: string };

/** One person you could call: voice, video and a star. */
function PersonActions({ p, fav, off, onCall, onFav }: { p: Who; fav: boolean; off: boolean; onCall: (video: boolean) => void; onFav: () => void }) {
  return (
    <>
      <button className={cx('star-chip', fav && 'on')} onClick={onFav} aria-pressed={fav} aria-label={fav ? `Remove ${p.name} from favourites` : `Add ${p.name} to favourites`} title={fav ? 'Favourite' : 'Add to favourites'}>
        <Icon name="star" size={17} />
      </button>
      <button className="call-chip" onClick={() => onCall(false)} disabled={off} aria-label={`Voice call ${p.name}`} title="Voice call">
        <Icon name="phone" size={18} />
      </button>
      <button className="call-chip video" onClick={() => onCall(true)} disabled={off} aria-label={`Video call ${p.name}`} title="Video call">
        <Icon name="video" size={18} />
      </button>
    </>
  );
}

export function CallsView({ nav, push }: { nav: Nav; push: PushToast }) {
  const account = useAccount();
  const calls = useCalls();
  const [nurseries, setNurseries] = useState<Nursery[] | null>(null);
  const [people, setPeople] = useState<Record<string, NurseryPerson[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Person[] | null>(null);
  const [confirm, setConfirm] = useState<{ p: Who; video: boolean } | null>(null);
  const [editFavs, setEditFavs] = useState(false);
  const member = account.status === 'member';

  useEffect(() => {
    if (!member) return;
    let alive = true;
    void callCenter.refresh(); // a nursery joined since the app opened gets its line now
    void callCenter.familyChanged(); // and your line re-reads who's family (badges, labels on rings)
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

  // Debounced name search across Stream Studio members (names only — never emails).
  useEffect(() => {
    if (q.trim().length < 2) {
      setFound(null);
      return;
    }
    let alive = true;
    setFound(null);
    const t = window.setTimeout(() => {
      void searchPeople(q).then((r) => alive && setFound(r));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  // Opening Calls clears the missed-call badge.
  useEffect(() => {
    try {
      localStorage.setItem(CALLS_SEEN_KEY, String(Date.now()));
    } catch { /* storage unavailable */ }
  }, [calls.log.length]);

  const family = useMemo(() => familyMap(nurseries ?? [], people), [nurseries, people]);
  const favSet = useMemo(() => new Set(calls.favs.map((f) => f.uid)), [calls.favs]);
  const me = calls.uid;

  /** A family call, through the nursery (as always). */
  const place = async (nid: string, who: Who[], video: boolean) => {
    unlockCallAudio();
    setBusy(`${nid}:${who.map((w) => w.uid).join(',')}:${video}`);
    const err = await callCenter.call(nid, who, video);
    setBusy(null);
    if (err) push(err, { icon: 'alert', duration: 7000 });
  };

  /** Anyone else on Stream Studio, through your own line. */
  const placeDirect = async (who: Who[], video: boolean) => {
    unlockCallAudio();
    setBusy(`d:${who.map((w) => w.uid).join(',')}:${video}`);
    const err = await callCenter.callUser(who, video);
    setBusy(null);
    if (err) push(err, { icon: 'alert', duration: 7000 });
  };

  /** Call one person: family through their nursery, anyone else directly (checking first if they're new). */
  const callPerson = (p: Who, video: boolean, checked = false) => {
    const f: FamilyMember | undefined = family.get(p.uid);
    const line = f ? calls.lines.find((l) => l.nid === f.nid) : undefined;
    if (f && (line?.connected || !calls.directReady)) return void place(f.nid, [{ uid: p.uid, name: f.label || f.name }], video);
    if (!checked && needsConfirm(p.uid, { family, favs: calls.favs, log: calls.log, me, confirmed: loadConfirmed() })) {
      setConfirm({ p, video });
      return;
    }
    void placeDirect([p], video);
  };

  const toggleFav = (p: Who) => {
    const on = !favSet.has(p.uid);
    if (!callCenter.setFav(p, on)) push('Not connected right now — your favourites will update when you’re back online.', { icon: 'alert' });
    else if (on) push(`${p.name} is a favourite — one tap from the top of Calls`, { icon: 'star' });
  };

  const setWho = (who: CallWho) => {
    if (!callCenter.setWho(who)) push('Not connected right now — try again in a moment.', { icon: 'alert' });
    else push(who === 'family' ? 'Only people in your nurseries can call you now' : 'Anyone on Stream Studio can call you now', { icon: 'check' });
  };

  const toggleRing = async () => {
    if (calls.ringOn) {
      await callCenter.disableRinging();
      push('This device won’t ring when Stream Studio is closed', { icon: 'check' });
      return;
    }
    const r = await callCenter.enableRinging();
    if ('error' in r) push(r.error, { icon: 'alert', duration: 8000 });
    else push('This device will ring for calls, even with the app closed', { icon: 'bell' });
  };

  const nameOf = (uid: string): string | null => {
    const f = family.get(uid);
    return f ? f.label || f.name : callCenter.nameOf(uid);
  };

  if (account.status === 'loading') return <div className="page"><div className="skeleton" style={{ height: 120 }} aria-label="Loading account" /></div>;
  if (!member) {
    return (
      <div className="page page-narrow fade-in">
        <div className="monitor-hero">
          <div className="mh-icon"><Icon name="video" size={30} /></div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">Video and voice calls with your family — Grandma, the sitter, the other parent — or anyone on Stream Studio. Device to device, encrypted, never recorded.</p>
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

  const homeScreen = needsHomeScreen();
  const inCall = !!calls.active && calls.active.state !== 'ended';
  const searching = q.trim().length >= 2;
  const results = (found ?? []).filter((p) => p.user_id !== me);

  return (
    <div className="page fade-in calls-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">Video and voice calls with your family — or anyone on Stream Studio. Device to device, encrypted, never recorded.</p>
        </div>
      </div>

      <section className="card card-pad calls-search" data-tour="calls-search">
        <div className="search-box">
          <Icon name="search" size={15} className="faint" />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Stream Studio by name" aria-label="Search people to call" type="search" enterKeyHint="search" />
        </div>
        {searching && (
          <div className="call-results" aria-live="polite">
            {found === null ? (
              <div className="faint sr-empty">Searching…</div>
            ) : results.length === 0 ? (
              <div className="faint sr-empty">No one named “{q.trim()}” on Stream Studio yet. They need an account with the welcome code.</div>
            ) : (
              results.map((p) => {
                const who = { uid: p.user_id, name: p.display_name };
                const badge = badgeFor(p.user_id, family);
                const f = family.get(p.user_id);
                return (
                  <div key={p.user_id} className="call-sr">
                    <Avatar name={p.display_name} size={36} />
                    <div className="family-who">
                      <b>{p.display_name}{f?.label ? <span className="faint"> · {f.label}</span> : null}</b>
                      <span className={cx('call-badge', badge.family && 'fam')}>{badge.text}</span>
                    </div>
                    <PersonActions p={who} fav={favSet.has(who.uid)} off={inCall || busy != null || (!badge.family && !calls.directReady)} onCall={(v) => callPerson(who, v)} onFav={() => toggleFav(who)} />
                  </div>
                );
              })
            )}
          </div>
        )}
        {!searching && !calls.directReady && calls.on && <p className="faint call-search-note">Connecting your calls…</p>}
      </section>

      {calls.favs.length > 0 && (
        <section className="card card-pad favs-card" data-tour="calls-favs" aria-label="Favourites">
          <div className="row" style={{ gap: 10 }}>
            <Icon name="star" size={17} />
            <b style={{ flex: 1 }}>Favourites</b>
            <button className="linkish" onClick={() => setEditFavs((e) => !e)}>{editFavs ? 'Done' : 'Edit'}</button>
          </div>
          <div className="fav-row">
            {calls.favs.map((f) => {
              const label = nameOf(f.uid) ?? f.name;
              const who = { uid: f.uid, name: label };
              return (
                <div key={f.uid} className="fav">
                  <button className="fav-face" onClick={() => (editFavs ? toggleFav(who) : callPerson(who, true))} disabled={!editFavs && (inCall || busy != null)} aria-label={editFavs ? `Remove ${label} from favourites` : `Video call ${label}`}>
                    <Avatar name={f.name} size={56} />
                    {editFavs && <span className="fav-x"><Icon name="x" size={12} /></span>}
                  </button>
                  <span className="fav-name">{label}</span>
                  {!editFavs && (
                    <button className="fav-voice" onClick={() => callPerson(who, false)} disabled={inCall || busy != null} aria-label={`Voice call ${label}`}>
                      <Icon name="phone" size={13} />Voice
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

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
          <p>Search above to call anyone on Stream Studio. To keep your family one tap away, create a nursery and add them — or ask a parent to add you to theirs.</p>
          <Btn variant="ghost" icon="baby" onClick={() => nav.monitor()}>Open Baby monitor</Btn>
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
                {n.my_role === 'parent' && list.length > 0 && (
                  <IconBtn name="userPlus" label={`Invite family to ${n.name}`} onClick={() => openInvite(n.id)} />
                )}
                {list.length > 1 && (
                  <Btn variant="soft" size="sm" icon="video" disabled={!line?.connected || inCall} onClick={() => void place(n.id, group, true)}>
                    {list.length > MAX_IN_CALL - 1 ? `Call ${MAX_IN_CALL - 1}` : 'Call everyone'}
                  </Btn>
                )}
              </div>
              {people[n.id] == null ? (
                <div className="skeleton" style={{ height: 52 }} />
              ) : list.length === 0 ? (
                <p className="faint family-empty">
                  Nobody else is in this nursery yet.{' '}
                  {n.my_role === 'parent' ? (
                    <Btn variant="soft" size="sm" icon="userPlus" onClick={() => openInvite(n.id)} data-tour="calls-invite">Invite family</Btn>
                  ) : (
                    'Ask a parent to invite family.'
                  )}
                </p>
              ) : (
                <div className="family-list">
                  {list.map((p) => {
                    const who = { uid: p.user_id, name: p.label || p.display_name };
                    const off = !line?.connected || inCall || busy != null;
                    return (
                      <div key={p.user_id} className="family-row">
                        <Avatar name={p.display_name} size={40} />
                        <div className="family-who">
                          <b>{p.label || p.display_name}</b>
                          <small>{p.label ? `${p.display_name} · ` : ''}{ROLE_INFO[p.role]?.label ?? p.role}</small>
                        </div>
                        <PersonActions p={who} fav={favSet.has(who.uid)} off={off} onCall={(v) => void place(n.id, [who], v)} onFav={() => toggleFav({ uid: who.uid, name: p.display_name })} />
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
        {calls.log.length === 0 ? (
          <p className="faint family-empty">Your calls will show here — including any you miss.</p>
        ) : (
          <div className="recent-list">
            {calls.log.map((r) => {
              const out = r.from.uid === me;
              const missed = isMissed(r, me);
              const { names, back } = recentPeople(r, me, nameOf);
              const direct = r.nid === 'direct';
              const status = missed ? 'Missed' : r.answered ? length(r.secs) : out ? (r.why === 'declined' ? 'Declined' : r.why === 'cancelled' ? 'Cancelled' : 'No answer') : 'Declined';
              // Direct: their family badge if they're family, else Stream Studio.
              const place1 = direct && back.length === 1 && family.get(back[0].uid) ? family.get(back[0].uid)!.where : r.nursery;
              const again = () => {
                const who = back.slice(0, MAX_IN_CALL - 1);
                if (!direct) return void place(r.nid, who, r.video);
                if (who.length === 1) return callPerson(who[0], r.video, true);
                return void placeDirect(who, r.video);
              };
              return (
                <button key={r.id} className={cx('recent-row', missed && 'missed')} onClick={again} disabled={inCall || busy != null} title="Call back">
                  <span className="recent-ic"><Icon name={r.video ? 'video' : 'phone'} size={16} /></span>
                  <span className="recent-who">
                    <b>{names.join(', ')}</b>
                    <small>{out ? 'Outgoing' : 'Incoming'} · {status} · {place1}</small>
                  </span>
                  <span className="recent-when">{when(r.at)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="card card-pad who-card" data-tour="calls-privacy">
        <div className="row" style={{ gap: 10 }}>
          <Icon name="shield" size={17} />
          <b style={{ flex: 1 }}>Who can call you</b>
        </div>
        <Segmented
          full
          label="Who can call you"
          value={calls.who}
          onChange={(v) => setWho(v as CallWho)}
          options={[
            { value: 'everyone', label: 'Everyone on Stream Studio' },
            { value: 'family', label: 'Only my nurseries' },
          ]}
        />
        <small className="faint who-note">
          {calls.who === 'everyone'
            ? 'Anyone with a Stream Studio account can call you. People outside your nurseries show as “not in your family”, start with your camera off, and can be blocked from their call.'
            : 'Only people who share a nursery with you can call you. Anyone else is told you only take calls from your family.'}
        </small>
        <div className="blocked">
          <b className="blocked-head">Blocked{calls.blocked.length ? ` (${calls.blocked.length})` : ''}</b>
          {calls.blocked.length === 0 ? (
            <p className="faint family-empty">No one. Block someone with “Decline &amp; block” when they call — they won’t be able to tell.</p>
          ) : (
            calls.blocked.map((b) => (
              <div key={b.uid} className="blocked-row">
                <Avatar name={b.name} size={30} />
                <span>{b.name}</span>
                <Btn variant="ghost" size="sm" onClick={() => {
                  if (callCenter.setBlocked(b, false)) push(`${b.name} can call you again`, { icon: 'check' });
                  else push('Not connected right now — try again in a moment.', { icon: 'alert' });
                }}>Unblock</Btn>
              </div>
            ))
          )}
        </div>
      </section>

      <p className="faint calls-note">
        <Icon name="lock" size={13} /> Calls go straight between devices, encrypted (WebRTC) — our server only helps them find each other. Nothing is recorded. {calls.who === 'family' ? 'Only people in your nurseries can call you' : 'Anyone on Stream Studio can call you, and blocked people never reach you'}; share-link guests can’t call.
      </p>

      {confirm && (
        <div className="call-confirm-wrap" role="presentation" onClick={() => setConfirm(null)}>
          <div className="call-confirm card card-pad" role="dialog" aria-modal="true" aria-label={`Call ${confirm.p.name}?`} onClick={(e) => e.stopPropagation()}>
            <Avatar name={confirm.p.name} size={56} />
            <b>Call {confirm.p.name}?</b>
            <p className="faint">
              {confirm.p.name} isn’t in any of your nurseries. They’ll see your name{account.name ? `, ${account.name},` : ''} and that you’re not in their family. More than one person can have the same name — make sure it’s the right one.
            </p>
            <div className="row call-confirm-acts">
              <Btn variant="ghost" onClick={() => setConfirm(null)}>Cancel</Btn>
              <Btn
                variant="solid"
                icon={confirm.video ? 'video' : 'phone'}
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  saveConfirmed(c.p.uid);
                  callPerson(c.p, c.video, true);
                }}
              >
                {confirm.video ? 'Video call' : 'Voice call'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
