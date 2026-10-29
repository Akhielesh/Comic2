// @vitest-environment jsdom
// Stream Studio needs your DreamStream account (live/accessGate.ts), in the real shell: a
// signed-out visitor gets the sign-in screen on every studio screen — no rail, no dashboard, no
// tour — while the links people were sent still open their pages. Loading is a splash, 'offline'
// lets through as before, and a running screen is never torn down by a status blip. The views are
// stand-ins (each one only says which it is); the shell, the gate screens and the tours are real.
import React, { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from './account';

const h = vi.hoisted(() => ({
  account: { status: 'signed_out' } as LiveAccount,
  openAuth: vi.fn(),
  openInvite: vi.fn(),
  cameraMounts: 0,
  studioMounts: 0,
  studioUnmounts: 0,
  /** A stand-in screen that says which it is. */
  stub: (id: string) => () => <div data-testid={id} />,
}));

vi.mock('./account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  consumeAuthReturn: vi.fn(async () => null),
  useAccount: () => h.account,
  openAuth: h.openAuth,
}));
vi.mock('./sync', () => ({ pullPrefsFromCloud: vi.fn(async () => undefined) }));
vi.mock('./components/SaveSheet', () => ({ sweepDiscardedRecordings: vi.fn(async () => undefined) }));
vi.mock('./calls/callCenter', () => ({ useCalls: () => ({ log: [], uid: null }) }));
vi.mock('./views/calls/CallHost', () => ({ CallHost: () => null }));
vi.mock('./views/monitor/InviteHost', () => ({ InviteHost: () => null }));
vi.mock('./monitor/invite', () => ({ openInvite: h.openInvite }));
vi.mock('./components/AuthSheet', () => ({ AuthSheetHost: () => null }));
vi.mock('./components/StudiosCard', () => ({ StudiosCard: () => null }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  getEvent: vi.fn(async () => ({ status: 'live', scheduledAt: null })),
}));
// The screens: stand-ins that say which they are.
vi.mock('./views/DashboardView', () => ({ DashboardView: h.stub('dashboard') }));
vi.mock('./views/CreateView', () => ({ CreateView: h.stub('create') }));
vi.mock('./views/SettingsView', () => ({ SettingsView: h.stub('settings') }));
vi.mock('./views/StudioView', () => ({
  // Counts mounts and teardowns: unmounting the real one stops the camera, closes the room and
  // drops every viewer and guest — a running broadcast must never be torn down by an account change.
  StudioView: () => {
    useEffect(() => {
      h.studioMounts++;
      return () => {
        h.studioUnmounts++;
      };
    }, []);
    return <div data-testid="studio" />;
  },
}));
vi.mock('./views/SummaryView', () => ({ SummaryView: h.stub('summary') }));
vi.mock('./views/ViewerView', () => ({ ViewerView: h.stub('viewer') }));
vi.mock('./views/EventPage', () => ({ EventPage: h.stub('event') }));
vi.mock('./views/GuestView', () => ({ GuestView: h.stub('guest') }));
vi.mock('./views/MonitorHome', () => ({ MonitorHome: h.stub('monitor'), NurseryHub: h.stub('nursery') }));
vi.mock('./views/MonitorViewer', () => ({ MonitorViewer: h.stub('monitor-watch') }));
vi.mock('./views/MonitorJoin', () => ({ MonitorJoin: h.stub('monitor-join') }));
vi.mock('./views/CallsView', () => ({ CallsView: h.stub('calls') }));
vi.mock('./views/MonitorCamera', () => ({
  // Counts mounts: a running camera must never be torn down and started again by a status change.
  MonitorCamera: () => {
    useEffect(() => {
      h.cameraMounts++;
    }, []);
    return <div data-testid="monitor-camera" />;
  },
}));

import { LiveApp } from './LiveApp';

const NID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123';
const STUDIO_VIEWS = ['dashboard', 'create', 'settings', 'studio', 'summary', 'monitor', 'nursery', 'monitor-camera', 'monitor-watch', 'calls'];

/** Every studio screen, by the address it opens from, and the stand-in it renders when open. */
const STUDIO_SCREENS: [path: string, testId: string][] = [
  ['/live', 'dashboard'],
  ['/live#/create', 'create'],
  ['/live#/settings', 'settings'],
  ['/live#/settings?s=security', 'settings'],
  ['/live#/monitor', 'monitor'],
  [`/live#/monitor/${NID}`, 'nursery'],
  [`/live#/monitor/${NID}/camera`, 'monitor-camera'],
  // (No guest pass on this device: a share-link guest's watch page — LiveApp.gateGuestPass.unit.test.tsx.)
  [`/live#/monitor/${NID}/watch`, 'monitor-watch'],
  ['/live#/calls', 'calls'],
  [`/live#/call/${NID}/abcdef0123456789`, 'calls'],
  ['/live?e=ev1#/studio?k=hostkey', 'studio'],
  ['/live?e=ev1#/summary?k=hostkey', 'summary'],
];

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const noStudio = () => {
  for (const id of STUDIO_VIEWS) expect(screen.queryByTestId(id)).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
};

beforeEach(() => {
  localStorage.clear();
  h.account = { status: 'signed_out' };
  h.openAuth.mockReset();
  h.openInvite.mockReset();
  h.cameraMounts = 0;
  h.studioMounts = 0;
  h.studioUnmounts = 0;
  history.replaceState(null, '', '/live');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('signed out: the sign-in screen, and nothing of the studio behind it', () => {
  for (const [path] of STUDIO_SCREENS) {
    it(path, async () => {
      history.replaceState(null, '', path);
      render(<LiveApp />);
      await settle();
      expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Stream Studio' })).toHaveFocus();
      expect(screen.getByText(/your DreamStream account/)).toBeInTheDocument();
      noStudio();
      // The address is kept: once signed in, the screen they were opening opens.
      expect(location.pathname + location.search + location.hash).toBe(path);
    });
  }

  it('Sign in opens the sign-in sheet; signing in opens the screen they were opening', async () => {
    history.replaceState(null, '', `/live#/monitor/${NID}/watch`);
    const { rerender } = render(<LiveApp />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(h.openAuth).toHaveBeenCalledWith('signin');
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada' };
    rerender(<LiveApp />);
    expect(await screen.findByTestId('monitor-watch')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in to Stream Studio' })).toBeNull();
  });

  it('no welcome tour starts behind it', async () => {
    vi.useFakeTimers();
    render(<LiveApp />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(document.querySelector('.tour-root')).toBeNull();
  });

  it('…while a member’s first visit still gets it', async () => {
    vi.useFakeTimers();
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada' };
    render(<LiveApp />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(document.querySelector('.tour-root')).not.toBeNull();
  });

  it('a link straight to a nursery’s Invite waits for the sign-in, then opens it', async () => {
    history.replaceState(null, '', `/live#/monitor/${NID}/invite`);
    const { rerender } = render(<LiveApp />);
    await settle();
    expect(h.openInvite).not.toHaveBeenCalled();
    expect(location.hash).toBe(`#/monitor/${NID}/invite`);
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com' };
    rerender(<LiveApp />);
    await settle();
    expect(h.openInvite).toHaveBeenCalledWith(NID);
    expect(location.hash).toBe(`#/monitor/${NID}`);
  });
});

describe('signed out: the links people were sent open their pages', () => {
  const LINKS: [label: string, path: string, testId: string][] = [
    ['the watch link', '/live?e=ev1#/watch', 'viewer'],
    ['the invite page', '/live?e=ev1#/event', 'event'],
    ['the share link (meta decides watch or invite)', '/live?e=ev1', 'viewer'],
    ['a meeting guest seat', '/live?e=ev1#/guest?g=guestkey&m=1', 'guest'],
    ['an older guest link', '/live?e=ev1&g=guestkey', 'guest'],
    ['a nursery share link', `/live#/monitor/join/${NID}/${'c'.repeat(24)}`, 'monitor-join'],
  ];
  for (const [label, path, testId] of LINKS) {
    it(label, async () => {
      history.replaceState(null, '', path);
      render(<LiveApp />);
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Sign in to Stream Studio' })).toBeNull();
    });
  }

  it('"Not you? Secure my account" from a new-sign-in email', async () => {
    history.replaceState(null, '', `/live#/secure/${TOKEN}`);
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Secure your account?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secure my account' })).toBeInTheDocument();
  });

  it('…and while the account is still loading, or before the welcome code: no splash, no gate', async () => {
    for (const account of [{ status: 'loading' }, { status: 'needs_code', userId: 'u1' }, { status: 'needs_mfa', userId: 'u1' }] as LiveAccount[]) {
      h.account = account;
      history.replaceState(null, '', '/live?e=ev1#/watch');
      const { unmount } = render(<LiveApp />);
      expect(await screen.findByTestId('viewer')).toBeInTheDocument();
      expect(screen.queryByText('Checking your account…')).toBeNull();
      unmount();
    }
  });
});

describe('loading: a quiet splash — never the dashboard, never a flash of "Sign in"', () => {
  for (const [path] of [STUDIO_SCREENS[0], STUDIO_SCREENS[6]]) {
    it(path, async () => {
      h.account = { status: 'loading' };
      history.replaceState(null, '', path);
      render(<LiveApp />);
      await settle();
      // (The toasts are a status region too.)
      expect(screen.getAllByRole('status').some((el) => el.textContent === 'Checking your account…')).toBe(true);
      expect(screen.queryByRole('heading', { name: 'Sign in to Stream Studio' })).toBeNull();
      noStudio();
    });
  }

  it('then the answer: the studio for a member', async () => {
    h.account = { status: 'loading' };
    const { rerender } = render(<LiveApp />);
    await settle();
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada' };
    rerender(<LiveApp />);
    await settle();
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main' }).length).toBeGreaterThan(0);
  });
});

describe('signed in', () => {
  it('member: the studio as today, on every screen', async () => {
    for (const [path, testId] of STUDIO_SCREENS) {
      h.account = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada' };
      history.replaceState(null, '', path);
      const { unmount } = render(<LiveApp />);
      expect([path, (await screen.findByTestId(testId)).dataset.testid]).toEqual([path, testId]);
      expect(screen.queryByRole('heading', { name: 'Sign in to Stream Studio' })).toBeNull();
      unmount();
    }
  });

  it('offline (a session the server couldn’t confirm): let through exactly as before, on every screen', async () => {
    for (const [path, testId] of STUDIO_SCREENS) {
      h.account = { status: 'offline', userId: 'u1', email: 'ada@example.com' };
      history.replaceState(null, '', path);
      const { unmount } = render(<LiveApp />);
      expect([path, (await screen.findByTestId(testId)).dataset.testid]).toEqual([path, testId]);
      unmount();
    }
  });

  it('no welcome code yet: "One more step" with the account, not the studio', async () => {
    h.account = { status: 'needs_code', userId: 'u1', email: 'ada@example.com', suggestedName: 'Ada Lovelace' };
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('heading', { name: 'One more step' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter your welcome code' }));
    expect(h.openAuth).toHaveBeenCalledWith('code');
    noStudio();
  });

  it('two-step code owed: "Finish signing in", not the studio', async () => {
    h.account = { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com', mfa: true };
    history.replaceState(null, '', '/live#/monitor');
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Finish signing in' })).toBeInTheDocument();
    noStudio();
  });
});

describe('safety: a running nursery camera is never torn down by a status blip', () => {
  it('member → offline → member keeps the same camera mounted (no gate, no restart)', async () => {
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com' };
    history.replaceState(null, '', `/live#/monitor/${NID}/camera`);
    const { rerender } = render(<LiveApp />);
    expect(await screen.findByTestId('monitor-camera')).toBeInTheDocument();
    h.account = { status: 'offline', userId: 'u1', email: 'ada@example.com' };
    rerender(<LiveApp />);
    await settle();
    expect(screen.getByTestId('monitor-camera')).toBeInTheDocument();
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com' };
    rerender(<LiveApp />);
    await settle();
    expect(screen.getByTestId('monitor-camera')).toBeInTheDocument();
    expect(h.cameraMounts).toBe(1);
  });
});

describe('a running broadcast or meeting is gated on entry only', () => {
  const STUDIO = '/live?e=ev1#/studio?k=hostkey';
  const MEMBER: LiveAccount = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada' };

  for (const [label, after] of [
    ['signed out in another tab (Comic Studio shares the session)', { status: 'signed_out' }],
    ['signed out everywhere', { status: 'signed_out', ended: 'revoked' }],
    ['the two-step code asked for again', { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com', mfa: true }],
    ['the welcome code asked for', { status: 'needs_code', userId: 'u1', email: 'ada@example.com' }],
  ] as [string, LiveAccount][]) {
    it(`${label}: the same studio stays up (no teardown, no remount), with a notice`, async () => {
      h.account = MEMBER;
      history.replaceState(null, '', STUDIO);
      const { rerender } = render(<LiveApp />);
      expect(await screen.findByTestId('studio')).toBeInTheDocument();
      h.account = after;
      rerender(<LiveApp />);
      await settle();
      expect(screen.getByTestId('studio')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: /Sign in to Stream Studio|One more step|Finish signing in/ })).toBeNull();
      expect([h.studioMounts, h.studioUnmounts]).toEqual([1, 0]);
      expect(await screen.findByText(/this stream keeps going until you end it/)).toBeInTheDocument();
      // …and back in: still the same studio.
      h.account = MEMBER;
      rerender(<LiveApp />);
      await settle();
      expect([h.studioMounts, h.studioUnmounts]).toEqual([1, 0]);
    });
  }

  it('leaving it (the stream ended, or Back) applies the gate; coming back to the address asks again', async () => {
    h.account = MEMBER;
    history.replaceState(null, '', STUDIO);
    const { rerender } = render(<LiveApp />);
    expect(await screen.findByTestId('studio')).toBeInTheDocument();
    h.account = { status: 'signed_out' };
    rerender(<LiveApp />);
    await settle();
    expect(screen.getByTestId('studio')).toBeInTheDocument();
    await act(async () => {
      history.pushState(null, '', '/live?e=ev1#/summary?k=hostkey');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Stream Studio' })).toBeInTheDocument();
    expect(screen.queryByTestId('summary')).toBeNull();
    expect(h.studioUnmounts).toBe(1);
    await act(async () => {
      history.pushState(null, '', STUDIO);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Stream Studio' })).toBeInTheDocument();
    expect(screen.queryByTestId('studio')).toBeNull();
  });

  it('only the host studio: the dashboard, settings and the monitor screens still close on a sign-out', async () => {
    for (const [path, testId] of STUDIO_SCREENS.filter(([, id]) => id !== 'studio')) {
      h.account = MEMBER;
      history.replaceState(null, '', path);
      const { rerender, unmount } = render(<LiveApp />);
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      h.account = { status: 'signed_out' };
      rerender(<LiveApp />);
      await settle();
      expect([path, !!screen.queryByRole('heading', { level: 1, name: 'Sign in to Stream Studio' })]).toEqual([path, true]);
      unmount();
    }
  });
});
