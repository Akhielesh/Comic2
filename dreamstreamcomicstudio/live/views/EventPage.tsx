// Invite / event page (Luma-style) — fully cloud-backed: cover, date block,
// host, description and RSVPs all come from the worker, so the link works on
// any device. Viewers join (or save a spot) with just a name.
import React, { useEffect, useState } from 'react';
import { getEvent, rsvpEvent } from '../api';
import { loadViewerName, saveViewerName } from '../events';
import type { Nav } from '../nav';
import { viewerUrl } from '../nav';
import type { EventMeta } from '../protocol';
import { downloadIcs, formatCountdown } from '../schedule';
import { coverGradient } from '../theme';
import { Icon } from '../ui/icons';
import { StreamStudioLogo } from '../ui/logo';
import { Avatar, Btn, Pill, cx, type PushToast } from '../ui/primitives';

function fmtEventDate(ms: number | null): { day: string; time: string; mon: string; date: string } {
  if (!ms) return { day: 'Soon', time: '', mon: '—', date: '·' };
  const d = new Date(ms);
  return {
    day: d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    mon: d.toLocaleDateString([], { month: 'short' }).toUpperCase(),
    date: String(d.getDate()),
  };
}

export function EventPage({ eventId, nav, push }: { eventId: string; nav: Nav; push: PushToast }) {
  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(loadViewerName);
  const [rsvped, setRsvped] = useState(false);
  const [, setClock] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getEvent(eventId)
        .then((m) => {
          if (cancelled) return;
          setMeta(m);
          // The invite flips to the watch page the moment the host goes live.
          if (m.status === 'live' || m.status === 'paused') nav.viewer(eventId);
        })
        .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : 'Event not found.'));
    void load();
    const poll = window.setInterval(load, 30_000);
    const tick = window.setInterval(() => setClock((c) => c + 1), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  if (err) {
    return (
      <div className="event-page-root">
        <div className="center-screen">
          <div className="center-card fade-in">
            <h2>Event not found</h2>
            <p>{err}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="event-page-root">
        <div className="center-screen"><div className="muted">Loading event…</div></div>
      </div>
    );
  }

  const upcoming = meta.scheduledAt != null && meta.scheduledAt > Date.now();
  const when = fmtEventDate(meta.scheduledAt);
  const share = viewerUrl(meta.id);
  const going = meta.rsvpNames ?? [];

  const saveSpot = async () => {
    const clean = name.trim();
    if (!clean) {
      push('Enter your name first', { icon: 'info' });
      return;
    }
    saveViewerName(clean);
    if (upcoming) {
      try {
        const res = await rsvpEvent(meta.id, clean);
        setRsvped(true);
        setMeta((m) => (m ? { ...m, rsvpCount: res.rsvpCount } : m));
        push("You're on the list — see you there", { icon: 'check' });
      } catch {
        push('Could not save your spot — try again', { icon: 'alert' });
      }
    } else {
      nav.viewer(meta.id);
    }
  };

  return (
    <div className="event-page-root">
      <div className="event-topbar">
        <span className="rail-logo" style={{ cursor: 'default' }}><StreamStudioLogo /></span>
        <span className="spacer" />
        {meta.status === 'ended' && <Pill tone="neutral">Ended</Pill>}
      </div>

      <div className="event-page fade-in">
        <div className="ev-cover" style={{ background: coverGradient(meta.cover) }}>
          <span className="ev-rel">
            <span className={cx('pill-dot', upcoming && 'pulse')} />
            {meta.status === 'ended' ? 'This event has ended' : upcoming ? `Live ${formatCountdown(meta.scheduledAt! - Date.now())}` : 'Starting soon'}
          </span>
          <Icon name="broadcast" size={34} />
        </div>

        <div className="ev-body">
          <h1 className="ev-title serif">{meta.title}</h1>

          {meta.scheduledAt != null && (
            <div className="ev-when">
              <div className="ev-when-cal" aria-hidden>
                <span className="ev-cal-m">{when.mon}</span>
                <span className="ev-cal-d">{when.date}</span>
              </div>
              <div>
                <div className="ev-when-day">{when.day}</div>
                <div className="ev-when-time mono">{when.time} · your local time</div>
              </div>
            </div>
          )}

          <div className="ev-host">
            <Avatar name={meta.host} size={38} />
            <div>
              <div className="ev-host-name">Hosted by {meta.host}</div>
              <div className="ev-host-sub">{meta.quality} stream · {meta.access === 'approval' ? 'host approves viewers' : 'open to anyone with the link'}</div>
            </div>
          </div>

          {meta.desc && <p className="ev-desc">{meta.desc}</p>}

          {(meta.rsvpCount > 0 || going.length > 0) && (
            <div className="ev-going">
              <div className="ev-avatars">
                {going.slice(0, 5).map((n) => <Avatar key={n} name={n} size={30} className="ev-av" />)}
              </div>
              <span className="muted" style={{ fontSize: 13 }}>
                <b style={{ color: 'var(--text)' }}>{meta.rsvpCount}</b> going
              </span>
            </div>
          )}

          {meta.status !== 'ended' && (
            <div className="ev-join">
              <div className="ev-join-head">
                <Icon name="user" size={15} /> Join the stream <span className="ev-noacct">no account needed</span>
              </div>
              <div className="ev-join-row">
                <input
                  className="input"
                  placeholder="Enter your name"
                  value={name}
                  maxLength={24}
                  aria-label="Your name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveSpot()}
                />
                <Btn variant="solid" iconRight="arrowRight" onClick={() => void saveSpot()} disabled={rsvped && upcoming}>
                  {upcoming ? (rsvped ? 'Spot saved' : 'Save my spot') : 'Join now'}
                </Btn>
              </div>
              <div className="ev-join-foot">
                {meta.scheduledAt != null && meta.scheduledAt > Date.now() && (
                  <button className="ev-rsvp" onClick={() => downloadIcs({ title: meta.title, startMs: meta.scheduledAt!, url: share })}>
                    <Icon name="calendar" size={14} />Add to calendar
                  </button>
                )}
                <button
                  className="ev-rsvp"
                  onClick={() => {
                    navigator.clipboard?.writeText(share).catch(() => undefined);
                    push('Invite link copied', { icon: 'check' });
                  }}
                >
                  <Icon name="share" size={14} />Share
                </button>
                {upcoming && (
                  <button className="ev-rsvp" onClick={() => nav.viewer(meta.id)}>
                    <Icon name="film" size={14} />Open the watch page
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
