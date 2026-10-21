// Stream Studio — app shell. Owns the URL (query = event identity, hash =
// screen), the appearance (theme / accent), the collapsible side rail (a
// bottom tab bar on phones), the account + sign-in sheet, help & tours and
// toasts. Screen contract:
//   ?e=ID#/studio?k=KEY    → Host Studio        (legacy ?e=ID&k=KEY accepted)
//   ?e=ID#/summary?k=KEY   → private recap
//   ?e=ID                  → invite page or watch page (meta decides)
//   (no params)            → dashboard, #/create, #/settings, #/summary/ID,
//                            #/account, #/monitor[/NURSERY[/camera|/watch]],
//                            #/calls, #/call/NURSERY/CALL (a call notification → Calls)
import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { consumeAuthReturn, openAuth, signOutEverywhereLocal, useAccount } from './account';
import { getEvent } from './api';
import { AuthSheetHost } from './components/AuthSheet';
import { GuideHost, openHelp, useFirstVisitTour, type TourId } from './components/Guide';
import { sweepDiscardedRecordings } from './components/SaveSheet';
import { findMyEvent } from './events';
import type { Nav } from './nav';
import { loadPrefs } from './prefs';
import { pullPrefsFromCloud } from './sync';
import { ACCENTS, applyAppearance, loadAppearance, saveAppearance, type Appearance } from './theme';
import { CreateView } from './views/CreateView';
import { DashboardView } from './views/DashboardView';
import { EventPage } from './views/EventPage';
import { GuestView } from './views/GuestView';
// Baby monitor screens load on demand — stream viewers never download them.
const MonitorHome = lazy(() => import('./views/MonitorHome').then((m) => ({ default: m.MonitorHome })));
const NurseryHub = lazy(() => import('./views/MonitorHome').then((m) => ({ default: m.NurseryHub })));
const MonitorCamera = lazy(() => import('./views/MonitorCamera').then((m) => ({ default: m.MonitorCamera })));
const MonitorViewer = lazy(() => import('./views/MonitorViewer').then((m) => ({ default: m.MonitorViewer })));
const MonitorJoin = lazy(() => import('./views/MonitorJoin').then((m) => ({ default: m.MonitorJoin })));
const CallsView = lazy(() => import('./views/CallsView').then((m) => ({ default: m.CallsView })));
import { useCalls } from './calls/callCenter';
import { CallHost } from './views/calls/CallHost';
import { StudiosCard } from './components/StudiosCard';
import { isMissed, CALLS_SEEN_KEY } from './views/callsBadge';
import { SettingsView } from './views/SettingsView';
import { StudioView } from './views/StudioView';
import { SummaryView } from './views/SummaryView';
import { ViewerView } from './views/ViewerView';
import { Icon } from './ui/icons';
import { LiveLegalLinks } from './ui/legalLinks';
import { StreamStudioLogo } from './ui/logo';
import { Avatar, Btn, cx, useToasts, type PushToast } from './ui/primitives';

export type Route =
  | { view: 'dashboard' | 'create' | 'settings' | 'monitor' | 'calls' }
  | { view: 'nursery' | 'monitor-camera' | 'monitor-watch'; nid: string }
  | { view: 'monitor-join'; nid: string; code: string }
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
  if (hash === 'settings' || hash === 'account') return { view: 'settings' };
  if (hash === 'monitor') return { view: 'monitor' };
  // A ringing call's notification lands on Calls; the call itself rings on top.
  if (hash === 'calls' || /^call\/[0-9a-f-]{36}\/[0-9a-f]{8,24}$/.test(hash)) return { view: 'calls' };
  // Share link: #/monitor/join/<nursery>/<code> (the passcode is typed, never in the link).
  const join = hash.match(/^monitor\/join\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{16,64})$/);
  if (join) return { view: 'monitor-join', nid: join[1], code: join[2] };
  const mon = hash.match(/^monitor\/([0-9a-f-]{36})(?:\/(camera|watch))?$/);
  if (mon) {
    if (mon[2] === 'camera') return { view: 'monitor-camera', nid: mon[1] };
    if (mon[2] === 'watch') return { view: 'monitor-watch', nid: mon[1] };
    return { view: 'nursery', nid: mon[1] };
  }
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
  { id: 'monitor', label: 'Baby monitor', icon: 'baby' },
  { id: 'calls', label: 'Calls', icon: 'video' },
  { id: 'settings', label: 'Customize', icon: 'sliders' },
] as const;

const TOUR_FOR: Partial<Record<Route['view'], TourId>> = {
  dashboard: 'welcome',
  create: 'create',
  studio: 'studio',
  monitor: 'monitor',
  calls: 'calls',
  nursery: 'nursery',
  'monitor-watch': 'watch',
  'monitor-camera': 'camera',
  settings: 'welcome',
};

/** Avatar button + menu: sign in / create, or who you are + sign out. */
function AccountButton({ onSettings, push, compact }: { onSettings: () => void; push: PushToast; compact?: boolean }) {
  const account = useAccount();
  const [menu, setMenu] = useState(false);
  const prefsName = loadPrefs().hostName;
  if (account.status !== 'member' && account.status !== 'needs_code') {
    if (compact) {
      return (
        <Btn variant="soft" size="sm" icon="user" onClick={() => openAuth('signin')} data-tour="account">Sign in</Btn>
      );
    }
    return (
      <button className="rail-user" data-tour="account" onClick={() => openAuth('signin')} aria-label="Sign in or create an account">
        <span className="avatar avatar-ghost" style={{ width: 32, height: 32 }}><Icon name="user" size={16} /></span>
        <div className="ru-txt">
          <div className="ru-name">{account.status === 'loading' ? 'Account' : 'Sign in'}</div>
          <div className="ru-meta">or create an account</div>
        </div>
      </button>
    );
  }
  const name = account.name || prefsName || account.email || 'You';
  return (
    <div className={cx('acct-wrap', compact && 'compact')}>
      <button className="rail-user" data-tour="account" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Account menu">
        <Avatar name={name} size={32} />
        <div className="ru-txt">
          <div className="ru-name">{name}</div>
          <div className="ru-meta">{account.status === 'needs_code' ? 'Enter welcome code' : 'Signed in'}</div>
        </div>
      </button>
      {menu && (
        <div className="acct-menu" role="menu" onMouseLeave={() => setMenu(false)}>
          <div className="acct-id">
            <b>{name}</b>
            <span className="faint">{account.email}</span>
          </div>
          <StudiosCard compact />
          {account.status === 'needs_code' && (
            <button role="menuitem" onClick={() => { setMenu(false); openAuth('code'); }}><Icon name="lock" size={15} />Enter welcome code</button>
          )}
          <button role="menuitem" onClick={() => { setMenu(false); onSettings(); }}><Icon name="user" size={15} />Account &amp; sync</button>
          <button role="menuitem" onClick={() => { setMenu(false); openHelp(); }}><Icon name="help" size={15} />Help &amp; tours</button>
          <button role="menuitem" onClick={() => {
            setMenu(false);
            void signOutEverywhereLocal().then(() => push('Signed out on this device', { icon: 'check' }));
          }}><Icon name="logout" size={15} />Sign out</button>
        </div>
      )}
    </div>
  );
}

function WelcomeTour({ ready }: { ready: boolean }) {
  useFirstVisitTour('welcome', ready);
  return null;
}

export function LiveApp() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [railOpen, setRailOpen] = useState(true);
  const [push, toastNode] = useToasts();
  const calls = useCalls();
  // Missed family calls since Calls was last opened.
  const missed = useMemo(() => {
    if (route.view === 'calls') return 0;
    let seen = 0;
    try {
      seen = Number(localStorage.getItem(CALLS_SEEN_KEY)) || 0;
    } catch { /* storage unavailable */ }
    return calls.log.filter((r) => isMissed(r, calls.uid) && r.at > seen).length;
  }, [calls.log, calls.uid, route.view]);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);

  // Account settings follow the user: adopt cloud prefs when they're newer.
  // Also purge disk copies of recordings that were downloaded a while ago.
  useEffect(() => {
    void pullPrefsFromCloud();
    void sweepDiscardedRecordings();
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

  // Back from a confirmation email: adopt the session, land where the user started.
  useEffect(() => {
    void consumeAuthReturn().then((r) => {
      if (!r) return;
      setRoute(parseRoute());
      if ('confirmed' in r) push('Email confirmed — you’re signed in', { icon: 'sparkles' });
      else if (r.error === 'expired') {
        openAuth('signin', 'That link has expired or was already used. If you tapped it once already, your email is confirmed — just sign in.');
      } else {
        openAuth('signin', `That link didn’t work${r.message ? ` (${r.message})` : ''}. Sign in — we’ll send a fresh link if it’s still needed.`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      monitor: () => navigate('', '#/monitor'),
      calls: () => navigate('', '#/calls'),
      nursery: (id) => navigate('', `#/monitor/${id}`),
      monitorCamera: (id) => navigate('', `#/monitor/${id}/camera`),
      monitorWatch: (id) => navigate('', `#/monitor/${id}/watch`),
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
      case 'monitor':
        return <MonitorHome nav={nav} push={push} />;
      case 'calls':
        return <CallsView nav={nav} push={push} />;
      case 'nursery':
        return <NurseryHub id={route.nid} nav={nav} push={push} />;
      case 'monitor-camera':
        return <MonitorCamera id={route.nid} nav={nav} push={push} />;
      case 'monitor-watch':
        return <MonitorViewer id={route.nid} nav={nav} push={push} />;
      case 'monitor-join':
        return <MonitorJoin nid={route.nid} code={route.code} nav={nav} push={push} />;
      case 'dashboard':
      default:
        return <DashboardView nav={nav} push={push} />;
    }
  };

  // Full-bleed surfaces own the whole viewport — no side rail.
  const fullBleed = ['studio', 'viewer', 'event', 'event-auto', 'guest', 'monitor-camera', 'monitor-watch', 'monitor-join'].includes(route.view);
  const activeNav =
    route.view === 'create' ? 'create'
    : route.view === 'settings' ? 'settings'
    : route.view === 'monitor' || route.view === 'nursery' ? 'monitor'
    : route.view === 'calls' ? 'calls'
    : 'dashboard';
  const screenTour = TOUR_FOR[route.view] ?? null;

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
                data-tour={`nav-${n.id}`}
              >
                <Icon name={n.icon} size={18} />
                <span className="nav-label">{n.label}</span>
                {n.id === 'calls' && missed > 0 && <span className="nav-badge" aria-label={`${missed} missed`}>{missed}</span>}
              </button>
            ))}
            <button className="nav-item" onClick={openHelp} data-tour="help">
              <Icon name="help" size={18} />
              <span className="nav-label">Help &amp; tours</span>
            </button>
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
            <AccountButton onSettings={() => nav.settings()} push={push} />
          </div>
        </nav>
      )}

      <div className={cx('content', !fullBleed && 'has-tabbar')} style={fullBleed ? { minHeight: '100vh' } : undefined}>
        <Suspense fallback={<div className="page"><div className="skeleton" style={{ height: 140 }} aria-label="Loading" /></div>}>{screen()}</Suspense>
      </div>

      {/* Phones: compact top bar (brand + account) and a thumb-reach bottom tab bar. */}
      {!fullBleed && (
        <header className="mtop">
          <button className="rail-logo" onClick={() => nav.dashboard()}><StreamStudioLogo /></button>
          <span className="spacer" />
          <AccountButton onSettings={() => nav.settings()} push={push} compact />
        </header>
      )}
      {!fullBleed && (
        <nav className="tabbar" aria-label="Main">
          {NAV_ITEMS.map((n) => (
            <button key={n.id} className={cx('tab-item', activeNav === n.id && 'active')} aria-current={activeNav === n.id ? 'page' : undefined} onClick={() => nav[n.id]()}>
              <Icon name={n.icon} size={20} />
              <span>{n.id === 'create' ? 'Go live' : n.id === 'monitor' ? 'Monitor' : n.label === 'Customize' ? 'Settings' : n.label}</span>
              {n.id === 'calls' && missed > 0 && <span className="nav-badge">{missed}</span>}
            </button>
          ))}
          <button className="tab-item" onClick={openHelp} data-tour="help"><Icon name="help" size={20} /><span>Help</span></button>
        </nav>
      )}

      {route.view === 'dashboard' && <WelcomeTour ready />}
      <CallHost push={push} suspended={route.view === 'monitor-camera'} />
      <AuthSheetHost push={push} />
      <GuideHost screenTour={screenTour} />
      {toastNode}
    </div>
  );
}
