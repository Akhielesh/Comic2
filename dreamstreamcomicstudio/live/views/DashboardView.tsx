// Dashboard — live-now hero, lifetime stats, your streams (hydrated from the
// worker — cloud truth) and your recording downloads.
import React, { useEffect, useMemo, useState } from 'react';
import { addMyEvent, hydrateMyEvents, listMyRecordings, type MyEvent } from '../events';
import { fetchStudioAccess, pushEventToCloud, syncMyEvents, type StudioAccess } from '../sync';
import { fmtBytes, fmtDuration } from '../metrics';
import type { Nav } from '../nav';
import { viewerUrl } from '../nav';
import { loadPrefs } from '../prefs';
import { coverGradient } from '../theme';
import { Icon } from '../ui/icons';
import { Btn, IconBtn, Pill, Sparkline, Tabs, cx, type PushToast } from '../ui/primitives';

const fmtWhen = (ev: MyEvent): string => {
  if (ev.status === 'live') return 'Now';
  if (ev.scheduledAt && ev.scheduledAt > Date.now()) {
    return new Date(ev.scheduledAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const at = ev.endedAt ?? ev.startedAt ?? ev.createdAt;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const evDuration = (ev: MyEvent): string =>
  ev.startedAt && ev.endedAt ? fmtDuration((ev.endedAt - ev.startedAt) / 1000) : '—';

function StatTile({ label, value, sub, spark, color }: { label: string; value: string; sub: string; spark?: number[]; color?: string }) {
  return (
    <div className="stat-tile">
      <div className="st-label">{label}</div>
      <div className="st-value">{value}</div>
      <div className="st-row">
        <span className="st-sub">{sub}</span>
        {spark && spark.length > 1 && <Sparkline data={spark} color={color || 'var(--accent)'} w={64} h={22} />}
      </div>
    </div>
  );
}

function EventCard({ ev, nav, push }: { ev: MyEvent; nav: Nav; push: PushToast }) {
  const live = ev.status === 'live' || ev.status === 'paused';
  const ended = ev.status === 'ended';
  const scheduled = !live && !ended && ev.scheduledAt != null && ev.scheduledAt > Date.now();
  return (
    <div className={cx('event-card', live && 'is-live')}>
      <button
        className="ec-thumb"
        style={{ background: coverGradient(ev.cover ?? 0) }}
        aria-label={ended ? 'Open recap' : 'Open studio'}
        onClick={() => (ended ? nav.summary(ev.id, ev.hostKey) : nav.studio(ev.id, ev.hostKey))}
      >
        {live && <span className="ec-livebadge"><span className="pill-dot pulse" />LIVE</span>}
        <Icon name={ended ? 'play' : live ? 'broadcast' : 'calendar'} size={22} />
      </button>
      <div className="ec-body">
        <div className="ec-title">{ev.title}</div>
        <div className="ec-meta">
          <span className="mono">{fmtWhen(ev)}</span>
          <span className="dotsep">·</span>
          <span>{ev.quality || '720p'}</span>
          <span className="dotsep">·</span>
          <span className="row" style={{ gap: 4 }}>
            <Icon name={ev.access === 'approval' ? 'lock' : 'globe'} size={12} />
            {ev.access === 'approval' ? 'Approval' : 'Open'}
          </span>
        </div>
      </div>
      <div className="ec-side">
        {live && <span className="ec-stat"><Icon name="eye" size={13} />{ev.viewers ?? 0}</span>}
        {ended && <span className="ec-stat"><Icon name="eye" size={13} />{ev.peakViewers ?? ev.viewers ?? 0} · {evDuration(ev)}</span>}
        {scheduled && <Pill tone="neutral">Scheduled</Pill>}
        <IconBtn
          name="link"
          size={16}
          label="Copy viewer link"
          onClick={() => {
            navigator.clipboard?.writeText(viewerUrl(ev.id)).catch(() => undefined);
            push('Viewer link copied', { icon: 'check' });
          }}
        />
        {live && <Btn variant="solid" size="sm" icon="broadcast" onClick={() => nav.studio(ev.id, ev.hostKey)}>Open Studio</Btn>}
        {ended && <Btn variant="ghost" size="sm" icon="chart" onClick={() => nav.summary(ev.id, ev.hostKey)}>Recap</Btn>}
        {!live && !ended && <Btn variant="ghost" size="sm" onClick={() => nav.studio(ev.id, ev.hostKey)}>Open Studio</Btn>}
      </div>
    </div>
  );
}

export function DashboardView({ nav, push }: { nav: Nav; push: PushToast }) {
  const [tab, setTab] = useState('all');
  const [events, setEvents] = useState<MyEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [access, setAccess] = useState<StudioAccess | null>(null);
  const prefs = useMemo(loadPrefs, []);
  const recordings = useMemo(listMyRecordings, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Account sync first: cloud events land in the registry before hydrate,
      // so past sessions from other devices show up here.
      const acc = await fetchStudioAccess();
      if (cancelled) return;
      setAccess(acc);
      if (!acc.allowed) {
        setLoaded(true);
        return;
      }
      await syncMyEvents();
      const evs = await hydrateMyEvents();
      if (!cancelled) {
        setEvents(evs);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (access && !access.allowed) {
    return (
      <div className="page fade-in">
        <div className="page-head"><h1 className="page-title">Stream Studio</h1></div>
        <div className="banner warn">
          <Icon name="lock" size={15} />
          Streaming access for this account is currently disabled. If you think that's a mistake, contact an administrator.
        </div>
      </div>
    );
  }

  const live = events.filter((e) => e.status === 'live' || e.status === 'paused');
  const scheduled = events.filter((e) => e.status === 'idle' && e.scheduledAt != null && e.scheduledAt > Date.now());
  const past = events.filter((e) => e.status === 'ended');
  const filtered = tab === 'all' ? events : tab === 'live' ? live : tab === 'scheduled' ? scheduled : past;

  // Honest lifetime stats from what this browser knows (hydrated from the cloud).
  const totalSec = past.reduce((s, e) => s + (e.startedAt && e.endedAt ? (e.endedAt - e.startedAt) / 1000 : 0), 0);
  const peak = Math.max(0, ...past.map((e) => e.peakViewers ?? 0), ...live.map((e) => e.viewers ?? 0));
  const peaksSpark = past.slice(0, 8).map((e) => e.peakViewers ?? 0).reverse();

  const greet = (() => {
    const h = new Date().getHours();
    const who = prefs.hostName.trim();
    const day = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
    return `Good ${day}${who ? `, ${who}` : ''}`;
  })();

  /** Hosted from another device without signing in? Paste the private studio
   *  link and the event (with its logs, recap and recordings) appears here. */
  const importByLink = async () => {
    const raw = window.prompt('Paste your private studio link (the one with ?e=…&k=…):');
    if (!raw) return;
    try {
      const url = new URL(raw.trim());
      const id = url.searchParams.get('e');
      const key = url.searchParams.get('k');
      if (!id || !key) throw new Error('missing params');
      const mine: MyEvent = { id, hostKey: key, title: 'Imported stream', createdAt: Date.now(), scheduledAt: null };
      addMyEvent(mine);
      void pushEventToCloud(mine);
      const evs = await hydrateMyEvents();
      setEvents(evs);
      push('Event imported — recap and logs are available now', { icon: 'check' });
    } catch {
      push('That does not look like a studio link', { icon: 'alert' });
    }
  };

  const tabs = [
    { id: 'all', label: 'All' },
    { id: 'live', label: 'Live', badge: live.length },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'past', label: 'Past' },
  ];

  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">{greet}</h1>
          <p className="page-sub">
            {live.length > 0
              ? `You're live right now${scheduled.length ? ` and have ${scheduled.length} scheduled` : ''}.`
              : scheduled.length > 0
                ? `${scheduled.length} stream${scheduled.length > 1 ? 's' : ''} scheduled — share the invite links.`
                : 'Create an event and go live in under a minute.'}
            {' '}
            <span className="faint" style={{ fontSize: 13 }}>
              {access?.signedIn
                ? `Synced to your account${access.email ? ` (${access.email})` : ''}.`
                : 'Events live in this browser — sign in to the app to sync across devices.'}
            </span>
          </p>
        </div>
        <span className="spacer" />
        <Btn variant="ghost" icon="link" onClick={() => void importByLink()}>Import event</Btn>
        <Btn variant="solid" icon="plus" onClick={() => nav.create()}>New event</Btn>
      </div>

      {/* live now hero */}
      {live.map((ev) => (
        <div className="live-hero" key={ev.id}>
          <div className="lh-preview">
            <div className="lh-cover" style={{ background: coverGradient(ev.cover ?? 0) }} />
            <Icon name="broadcast" size={36} />
            <span className="lh-live"><span className="pill-dot pulse" />LIVE</span>
          </div>
          <div className="lh-body">
            <div className="lh-eyebrow"><Icon name="broadcast" size={14} />On air now</div>
            <h2 className="lh-title serif">{ev.title}</h2>
            <div className="lh-stats">
              <span><b>{ev.viewers ?? 0}</b> watching</span>
              {ev.startedAt && (
                <>
                  <span className="dotsep">·</span>
                  <span className="mono">{fmtDuration((Date.now() - ev.startedAt) / 1000)} elapsed</span>
                </>
              )}
            </div>
            <div className="lh-actions">
              <Btn variant="solid" icon="broadcast" onClick={() => nav.studio(ev.id, ev.hostKey)}>Back to Studio</Btn>
              <Btn
                variant="ghost"
                icon="link"
                onClick={() => {
                  navigator.clipboard?.writeText(viewerUrl(ev.id)).catch(() => undefined);
                  push('Viewer link copied', { icon: 'check' });
                }}
              >
                Copy viewer link
              </Btn>
            </div>
          </div>
        </div>
      ))}

      {/* stats */}
      <div className="stats-grid">
        <StatTile label="Streams" value={String(events.length)} sub={`${past.length} finished`} />
        <StatTile label="Hours streamed" value={(totalSec / 3600).toFixed(1)} sub="all time" color="var(--green)" />
        <StatTile label="Peak viewers" value={String(peak)} sub="best session" spark={peaksSpark} color="var(--blue)" />
        <StatTile label="Scheduled" value={String(scheduled.length)} sub="upcoming" />
      </div>

      <div className="dash-cols">
        <div className="dash-main">
          <div className="card">
            <div className="card-head">
              <h3>Your streams</h3>
              <span className="spacer" />
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
            </div>
            <div className="event-list">
              {filtered.map((ev) => (
                <EventCard key={ev.id} ev={ev} nav={nav} push={push} />
              ))}
              {filtered.length === 0 && (
                <div className="dash-empty">
                  {!loaded ? (
                    <div style={{ display: 'grid', gap: 10 }} aria-label="Loading streams">
                      <div className="skeleton" style={{ height: 56 }} />
                      <div className="skeleton" style={{ height: 56 }} />
                      <div className="skeleton" style={{ height: 56 }} />
                    </div>
                  ) : events.length === 0 ? (
                    <>
                      <div className="serif">No streams yet</div>
                      Create your first event — viewers join with just a name, no account needed.
                      <div style={{ marginTop: 14 }}>
                        <Btn variant="solid" icon="plus" onClick={() => nav.create()}>Create an event</Btn>
                      </div>
                    </>
                  ) : (
                    'Nothing here yet.'
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="dash-side">
          <div className="card">
            <div className="card-head"><h3>Recordings</h3><span className="spacer" /><Icon name="download" size={15} className="faint" /></div>
            <div className="rec-list">
              {recordings.length === 0 && (
                <div className="card-pad muted" style={{ fontSize: 13 }}>
                  Recordings save straight to this device when you stop them — the master copy is yours, never burned with chat.
                </div>
              )}
              {recordings.slice(0, 6).map((r) => (
                <div className="rec-item" key={`${r.eventId}-${r.at}`}>
                  <div className="rec-icon"><Icon name="play" size={15} /></div>
                  <div className="rec-meta">
                    <div className="rec-title">{r.title}</div>
                    <div className="rec-sub mono">{fmtBytes(r.bytes)} · {new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card card-pad" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 14.5 }}>How it works</h3>
            <span className="muted">
              Your camera becomes 6-second segments uploaded to the edge; viewers pull them through the CDN, so 100 viewers cost about the same as one. Chat, reactions and the lobby ride a websocket beside the video — and if your tab ever closes mid-stream, the room pauses for viewers and ends itself safely.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
