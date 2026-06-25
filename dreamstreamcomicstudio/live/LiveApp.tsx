// Stream Studio — app shell. Owns the URL (query = event identity, hash =
// screen), the appearance (theme / accent), the collapsible side rail and
// toasts. Screen contract:
//   ?e=ID#/studio?k=KEY    → Host Studio        (legacy ?e=ID&k=KEY accepted)
//   ?e=ID#/summary?k=KEY   → private recap
//   ?e=ID                  → invite page or watch page (meta decides)
//   (no params)            → dashboard, #/create, #/settings, #/summary/ID
import React, { useEffect, useMemo, useState } from 'react';
import { getEvent } from './api';
import { findMyEvent } from './events';
import type { Nav } from './nav';
import { loadPrefs } from './prefs';
import { pullPrefsFromCloud } from './sync';
import { ACCENTS, applyAppearance, loadAppearance, saveAppearance, type Appearance } from './theme';
import { CreateView } from './views/CreateView';
import { DashboardView } from './views/DashboardView';
import { EventPage } from './views/EventPage';
import { GuestView } from './views/GuestView';
import { SettingsView } from './views/SettingsView';
import { StudioView } from './views/StudioView';
import { SummaryView } from './views/SummaryView';
import { ViewerView } from './views/ViewerView';
import { Icon } from './ui/icons';
import { LiveLegalLinks } from './ui/legalLinks';
import { StreamStudioLogo } from './ui/logo';
import { Avatar, cx, useToasts, type PushToast } from './ui/primitives';

export type Route =
  | { view: 'dashboard' | 'create' | 'settings' }
  | { view: 'studio' | 'summary'; id: string; k: string }
  | { view: 'guest'; id: string; g: string }
  | { view: 'summary-lookup'; id: string }
  | { view: 'viewer' | 'event' | 'event-auto'; id: string };

export function parseHashRoute(rawHash: string): { screen: string; params: URLSearchParams } {
  const clean = rawHash.replace(/^#\/?/, '');
  const q = clean.indexOf('?');
  if (q === -1) return { screen: clean, params: new URLSearchParams() };
  return { screen: clean.slice(0, q), params: new URLSearchParams(clean.slice(q + 1)) };
}

export function parseRoute(): Route {
  const params = new URLSearchParams(location.search);
  const { screen: hash, params: hashParams } = parseHashRoute(location.hash);
  const e = params.get('e');
  const k = params.get('k') ?? hashParams.get('k');
  const g = params.get('g') ?? hashParams.get('g');
  if (e && k) {
    if (hash === 'summary') return { view: 'summary', id: e, k };
    return { view: 'studio', id: e, k };
  }
  if (e && g) return { view: 'guest', id: e, g };
  if (e) {
    if (hash === 'event') return { view: 'event', id: e };
    if (hash === 'watch') return { view: 'viewer', id: e };
    return { view: 'event-auto', id: e };
  }
  if (hash === 'create') return { view: 'create' };
  if (hash === 'settings') return { view: 'settings' };
  const sum = hash.match(/^summary\/([a-z0-9]+)$/);
  if (sum) return { view: 'summary-lookup', id: sum[1] };
  return { view: 'dashboard' };
}

/** ?e=ID with no explicit screen: scheduled events open as an invite,
 *  anything else goes straight to the watch page. */
function EventAutoGate({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const [decided, setDecided] = useState<'event' | 'viewer' | null>(null);
  useEffect(() => {
    let cancelled = false;
    getEvent(id)
      .then((m) => {
        if (cancelled) return;
        const upcoming = m.status === 'idle' && m.scheduledAt != null && m.scheduledAt > Date.now();
        setDecided(upcoming ? 'event' : 'viewer');
      })
      .catch(() => !cancelled && setDecided('viewer')); // viewer view renders the error
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (decided === 'event') return <EventPage eventId={id} nav={nav} push={push} />;
  if (decided === 'viewer') return <ViewerView eventId={id} nav={nav} push={push} />;
  return (
    <div className="viewer-root">
      <div className="center-screen"><div className="muted">Loading…</div></div>
    </div>
  );
}

function SummaryLookup({ id, nav, push }: { id: string; nav: Nav; push: PushToast }) {
  const mine = findMyEvent(id);
  if (!mine) {
    return (
      <div className="page fade-in">
        <div className="banner warn">
          <Icon name="info" size={15} />
          This recap belongs to an event created on another device. Open your private studio link, then choose “View recap”.
        </div>
      </div>
    );
  }
  return <SummaryView eventId={id} hostKey={mine.hostKey} nav={nav} push={push} />;
}

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'create', label: 'New event', icon: 'plus' },
  { id: 'settings', label: 'Customize', icon: 'sliders' },
] as const;

export function LiveApp() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [railOpen, setRailOpen] = useState(true);
  const [push, toastNode] = useToasts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prefs = useMemo(loadPrefs, [route]); // re-read when screens change (settings edits hostName)

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  // Account settings follow the user: adopt cloud prefs when they're newer.
  useEffect(() => {
    void pullPrefsFromCloud();
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);

  const nav: Nav = useMemo(() => {
    const navigate = (search: string, hash: string) => {
      history.pushState(null, '', `${location.pathname}${search}${hash}` || location.pathname);
      setRoute(parseRoute());
      window.scrollTo(0, 0);
    };
    return {
      dashboard: () => navigate('', ''),
      create: () => navigate('', '#/create'),
      settings: () => navigate('', '#/settings'),
      studio: (id, k) => navigate(`?e=${encodeURIComponent(id)}`, `#/studio?k=${encodeURIComponent(k)}`),
      viewer: (id) => navigate(`?e=${encodeURIComponent(id)}`, '#/watch'),
      event: (id) => navigate(`?e=${encodeURIComponent(id)}`, '#/event'),
      summary: (id, key) => (key
        ? navigate(`?e=${encodeURIComponent(id)}`, `#/summary?k=${encodeURIComponent(key)}`)
        : navigate('', `#/summary/${id}`)),
    };
  }, []);

  const screen = () => {
    switch (route.view) {
      case 'studio':
        return <StudioView eventId={route.id} hostKey={route.k} nav={nav} push={push} />;
      case 'summary':
        return <SummaryView eventId={route.id} hostKey={route.k} nav={nav} push={push} />;
      case 'summary-lookup':
        return <SummaryLookup id={route.id} nav={nav} push={push} />;
      case 'guest':
        return <GuestView eventId={route.id} guestKey={route.g} nav={nav} push={push} />;
      case 'viewer':
        return <ViewerView eventId={route.id} nav={nav} push={push} />;
      case 'event':
        return <EventPage eventId={route.id} nav={nav} push={push} />;
      case 'event-auto':
        return <EventAutoGate id={route.id} nav={nav} push={push} />;
      case 'create':
        return <CreateView nav={nav} push={push} />;
      case 'settings':
        return <SettingsView nav={nav} push={push} />;
      case 'dashboard':
      default:
        return <DashboardView nav={nav} push={push} />;
    }
  };

  // Full-bleed surfaces own the whole viewport — no side rail.
  const fullBleed = ['studio', 'viewer', 'event', 'event-auto', 'guest'].includes(route.view);
  const activeNav = route.view === 'create' ? 'create' : route.view === 'settings' ? 'settings' : 'dashboard';

  return (
    <div className="app">
      {!fullBleed && (
        <nav className={cx('rail', !railOpen && 'slim')} aria-label="Main">
          <div className="rail-top">
            <button className="rail-logo" onClick={() => nav.dashboard()}>
              <StreamStudioLogo />
            </button>
            <button className="rail-collapse" onClick={() => setRailOpen((o) => !o)} aria-label={railOpen ? 'Collapse navigation' : 'Expand navigation'}>
              <Icon name={railOpen ? 'chevronLeft' : 'chevronRight'} size={16} />
            </button>
          </div>
          <div className="rail-nav">
            {NAV_ITEMS.map((n) => (
              <button
                key={n.id}
                className={cx('nav-item', activeNav === n.id && 'active')}
                aria-current={activeNav === n.id ? 'page' : undefined}
                onClick={() => nav[n.id]()}
              >
                <Icon name={n.icon} size={18} />
                <span className="nav-label">{n.label}</span>
              </button>
            ))}
          </div>
          <div className="rail-foot">
            <button
              className="nav-item"
              onClick={() => setAppearance((a) => ({ ...a, theme: a.theme === 'dark' ? 'light' : 'dark' }))}
            >
              <Icon name={appearance.theme === 'dark' ? 'sun' : 'moon'} size={18} />
              <span className="nav-label">{appearance.theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </button>
            {railOpen && (
              <div className="accent-swatches" role="radiogroup" aria-label="Accent color">
                {Object.entries(ACCENTS).map(([k, a]) => (
                  <button
                    key={k}
                    role="radio"
                    aria-checked={appearance.accent === k}
                    aria-label={`${a.label} accent`}
                    className={cx('acc-sw', appearance.accent === k && 'sel')}
                    style={{ background: a.sw }}
                    onClick={() => setAppearance((ap) => ({ ...ap, accent: k }))}
                  />
                ))}
              </div>
            )}
            <hr className="divider" />
            {railOpen && <LiveLegalLinks />}
            <button className="rail-user" onClick={() => nav.settings()} aria-label="Account & sync settings">
              <Avatar name={prefs.hostName || 'You'} size={32} />
              <div className="ru-txt">
                <div className="ru-name">{prefs.hostName || 'You'}</div>
                <div className="ru-meta">Account &amp; sync</div>
              </div>
            </button>
          </div>
        </nav>
      )}

      <div className="content" style={fullBleed ? { minHeight: '100vh' } : undefined}>{screen()}</div>

      {toastNode}
    </div>
  );
}
