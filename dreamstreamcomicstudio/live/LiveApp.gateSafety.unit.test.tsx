// @vitest-environment jsdom
// The sign-in gate's safety contract for the baby monitor, end to end: the REAL account store
// (live/account.ts) and shell, with only Supabase and the screens stubbed. A signed-in parent is
// never gated out of a nursery camera by a reload while the internet is down, a blip or a slow
// answer — only a definite "signed out" (or a code still owed) shows the sign-in screen.
import React, { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Me = { data: unknown; error: unknown };
type AuthCb = (event: string, session: unknown) => void;

const h = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  getSession: null as null | (() => Promise<{ data: { session: unknown }; error: unknown }>),
  me: null as null | (() => Promise<Me>),
  join: null as null | (() => Promise<Me>),
  authCb: null as AuthCb | null,
  failImport: false,
  cameraMounts: 0,
  stub: (id: string) => () => <div data-testid={id} />,
}));

vi.mock('@/services/supabase', () => {
  if (h.failImport) throw new Error('Failed to fetch dynamically imported module');
  return {
    supabase: {
      auth: {
        getSession: vi.fn(async () => (h.getSession ? h.getSession() : { data: { session: h.session }, error: null })),
        onAuthStateChange: vi.fn((cb: AuthCb) => {
          h.authCb = cb;
          return { data: { subscription: { unsubscribe: () => undefined } } };
        }),
        signOut: vi.fn(async () => {
          h.session = null;
          return { error: null };
        }),
        updateUser: vi.fn(async () => ({ data: {}, error: null })),
      },
      rpc: vi.fn(async (fn: string) => (fn === 'live_me' && h.me ? h.me() : fn === 'live_join' && h.join ? h.join() : { data: null, error: null })),
    },
    lookupAccessTokenEmail: vi.fn(),
  };
});
vi.mock('@/services/authEmail', () => ({ requestAuthEmail: vi.fn(), EMAIL_SERVICE_DOWN: 'down' }));
vi.mock('./sync', () => ({
  pullPrefsFromCloud: vi.fn(async () => undefined),
  signOut: vi.fn(async () => {
    h.session = null;
  }),
}));
vi.mock('./components/SaveSheet', () => ({ sweepDiscardedRecordings: vi.fn(async () => undefined) }));
vi.mock('./calls/callCenter', () => ({ useCalls: () => ({ log: [], uid: null }) }));
vi.mock('./views/calls/CallHost', () => ({ CallHost: () => null }));
vi.mock('./views/monitor/InviteHost', () => ({ InviteHost: () => null }));
vi.mock('./components/AuthSheet', () => ({ AuthSheetHost: () => null }));
vi.mock('./components/StudiosCard', () => ({ StudiosCard: () => null }));
vi.mock('./components/Guide', () => ({ GuideHost: () => null, openHelp: vi.fn(), useFirstVisitTour: () => undefined }));
vi.mock('./monitor/push', () => ({ reconcileLegacyAlerts: vi.fn(async () => undefined), closeAlertNotifications: vi.fn() }));
vi.mock('./views/DashboardView', () => ({ DashboardView: h.stub('dashboard') }));
vi.mock('./views/MonitorCamera', () => ({
  MonitorCamera: () => {
    useEffect(() => {
      h.cameraMounts++;
    }, []);
    return <div data-testid="monitor-camera" />;
  },
}));

const NID = '11111111-2222-4333-8444-555555555555';
const CAMERA = `/live#/monitor/${NID}/camera`;
const SESSION = { access_token: 'tok-1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'ada@example.com', user_metadata: {} } };
const MEMBER: Me = { data: { member: true, profile: { display_name: 'Ada' } }, error: null };
const UNREACHABLE = Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const signInHeading = () => screen.queryByRole('heading', { name: 'Sign in to Stream Studio' });

let LiveApp: typeof import('./LiveApp')['LiveApp'];

beforeEach(async () => {
  vi.resetModules(); // a fresh account store: every test is a fresh page load
  localStorage.clear();
  h.session = { ...SESSION };
  h.getSession = null;
  h.me = async () => MEMBER;
  h.join = null;
  h.authCb = null;
  h.failImport = false;
  h.cameraMounts = 0;
  history.replaceState(null, '', CAMERA);
  ({ LiveApp } = await import('./LiveApp'));
});

describe('a reload while the internet is down', () => {
  it('the stored session can’t be refreshed (auth server unreachable): not "signed out" — let through, nothing wiped', async () => {
    // The parent's camera phone: its data and its owner mark are on this device.
    localStorage.setItem('ds-live-owner', 'u1');
    localStorage.setItem(`ds-monitor-zones-${NID}`, '[{"x":1}]');
    h.getSession = async () => ({ data: { session: null }, error: UNREACHABLE });
    render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    expect(signInHeading()).toBeNull();
    expect(localStorage.getItem('ds-live-owner')).toBe('u1');
    expect(localStorage.getItem(`ds-monitor-zones-${NID}`)).toBe('[{"x":1}]');
  });

  it('the session is fine but the server can’t confirm it (live_me fails): let through', async () => {
    h.me = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    expect(signInHeading()).toBeNull();
  });

  it('the auth client itself couldn’t load: let through', async () => {
    vi.resetModules();
    h.failImport = true;
    ({ LiveApp } = await import('./LiveApp'));
    render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    expect(signInHeading()).toBeNull();
  });
});

describe('a running camera, then a blip', () => {
  it('a token refresh whose account check fails keeps the member — the same camera stays up', async () => {
    render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    h.me = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-2' }));
    await settle();
    expect(screen.getByTestId('monitor-camera')).toBeInTheDocument();
    expect(h.cameraMounts).toBe(1);
  });

  it('…and so does one whose session read fails or can’t reach the auth server', async () => {
    render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    h.getSession = async () => {
      throw new Error('storage unavailable');
    };
    await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-2' }));
    await settle();
    h.getSession = async () => ({ data: { session: null }, error: UNREACHABLE });
    await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-3' }));
    await settle();
    expect(screen.getByTestId('monitor-camera')).toBeInTheDocument();
    expect(signInHeading()).toBeNull();
    expect(h.cameraMounts).toBe(1);
  });
});

describe('a slow account check', () => {
  it('the splash while it’s asked (as the monitor’s own account check did), then the camera the moment it answers', async () => {
    let answer!: (m: Me) => void;
    const pending = new Promise<Me>((r) => (answer = r));
    h.me = () => pending;
    render(<LiveApp />);
    await settle();
    expect(screen.getByText('Checking your account…')).toBeInTheDocument();
    expect(signInHeading()).toBeNull();
    expect(screen.queryByTestId('monitor-camera')).toBeNull();
    await act(async () => answer(MEMBER));
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
  });
});

describe('only a definite answer gates', () => {
  it('no session on this device: the sign-in screen', async () => {
    h.session = null;
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Stream Studio' })).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-camera')).toBeNull();
  });

  it('a refresh token the server rejected (the session is gone): the sign-in screen', async () => {
    h.getSession = async () => ({ data: { session: null }, error: Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError', status: 400 }) });
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Stream Studio' })).toBeInTheDocument();
  });

  it('signed out everywhere (session_revoked): the sign-in screen, with the notice', async () => {
    h.me = async () => ({ data: { member: false, error: 'session_revoked' }, error: null });
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'Sign in to Stream Studio' })).toBeInTheDocument();
    // (The notice is a toast: it renders a moment after the screen.)
    expect(await screen.findByText(/your account was signed out on every device/)).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-camera')).toBeNull();
  });

  it('no welcome code yet: one more step', async () => {
    h.me = async () => ({ data: { member: false, needs_code: true, suggested_name: 'Ada Lovelace' }, error: null });
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-camera')).toBeNull();
  });
});

describe('a definite "not yet" survives a blip too (only member status did before)', () => {
  const NEEDS_CODE: Me = { data: { member: false, needs_code: true, suggested_name: 'Ada Lovelace' }, error: null };
  const NEEDS_MFA: Me = { data: { member: false, error: 'mfa_required' }, error: null };
  const FAILED: Me = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  const studioShown = () => !!screen.queryByTestId('dashboard') || screen.queryAllByRole('navigation', { name: 'Main' }).length > 0;

  for (const [label, first, heading] of [
    ['no welcome code yet', NEEDS_CODE, 'One more step'],
    ['the two-step code owed', NEEDS_MFA, 'Finish signing in'],
  ] as [string, Me, string][]) {
    it(`${label}: an hourly token refresh whose account check fails keeps the gate — never the studio`, async () => {
      history.replaceState(null, '', '/live');
      h.me = async () => first;
      render(<LiveApp />);
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      h.me = async () => FAILED;
      await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-2' }));
      await settle();
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(studioShown()).toBe(false);
    });

    it(`${label}: …and so does one whose session read fails or can’t reach the auth server`, async () => {
      history.replaceState(null, '', '/live');
      h.me = async () => first;
      render(<LiveApp />);
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      h.getSession = async () => {
        throw new Error('storage unavailable');
      };
      await act(async () => h.authCb!('USER_UPDATED', { access_token: 'tok-2' }));
      await settle();
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      h.getSession = async () => ({ data: { session: null }, error: UNREACHABLE });
      await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-3' }));
      await settle();
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
      expect(studioShown()).toBe(false);
    });
  }

  it('the welcome code entered: the next answer lets them in', async () => {
    history.replaceState(null, '', '/live');
    h.me = async () => NEEDS_CODE;
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeInTheDocument();
    h.me = async () => MEMBER;
    await act(async () => h.authCb!('USER_UPDATED', { access_token: 'tok-2' }));
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
  });

  it('a different account signing in on this device is asked afresh — nothing carries over', async () => {
    history.replaceState(null, '', '/live');
    h.me = async () => NEEDS_CODE;
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeInTheDocument();
    h.session = { ...SESSION, user: { id: 'u2', email: 'bo@example.com', user_metadata: {} } };
    h.me = async () => FAILED;
    await act(async () => h.authCb!('SIGNED_IN', { access_token: 'tok-u2' }));
    await settle();
    // No answer for the new account: let through ('offline'), as for any first check that fails.
    expect(screen.queryByRole('heading', { name: 'One more step' })).toBeNull();
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });
});

describe('an account that needs no code is never asked for one because a request failed', () => {
  it('a pre-launch account whose automatic join fails on a blip: let through, not "One more step" — and in on the next check', async () => {
    history.replaceState(null, '', '/live');
    h.me = async () => ({ data: { member: false, needs_code: false, suggested_name: 'Ada' }, error: null });
    h.join = async () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    render(<LiveApp />);
    expect(await screen.findByTestId('dashboard')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'One more step' })).toBeNull();
    h.join = async () => ({ data: { ok: true, profile: { display_name: 'Ada' } }, error: null });
    await act(async () => h.authCb!('TOKEN_REFRESHED', { access_token: 'tok-2' }));
    await settle();
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('…while the server’s own "welcome code required" is a definite answer: one more step', async () => {
    history.replaceState(null, '', '/live');
    h.me = async () => ({ data: { member: false, needs_code: false }, error: null });
    h.join = async () => ({ data: { ok: false, error: 'welcome_code_required' }, error: null });
    render(<LiveApp />);
    expect(await screen.findByRole('heading', { name: 'One more step' })).toBeInTheDocument();
  });
});
