// @vitest-environment jsdom
// A nursery share-link guest (no account, or a DreamStream account without the welcome code)
// watches on `#/monitor/<nid>/watch` — the address the REAL MonitorJoin sends them to after the
// passcode, again whenever they reopen the share link, on every reload, and when they tap a
// crying or smoke alert (live-sw.js opens `…/watch`). The sign-in gate must let a guest pass this
// device holds through on that page (live/accessGate.ts, GUEST_PASS_ROUTES), in every account
// state — while a watch page with no pass still asks for the account.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from './account';
import type { GuestPass } from './monitor/guest';

const h = vi.hoisted(() => ({
  account: { status: 'signed_out' } as LiveAccount,
  joinAsGuest: null as null | ((nid: string) => Promise<unknown>),
}));

vi.mock('./account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  consumeAuthReturn: vi.fn(async () => null),
  useAccount: () => h.account,
  accessToken: vi.fn(async () => null),
  openAuth: vi.fn(),
}));
// The pass store is real (localStorage); only the network join is stood in for.
vi.mock('./monitor/guest', async (importOriginal) => {
  const real = await importOriginal<typeof import('./monitor/guest')>();
  return { ...real, joinAsGuest: vi.fn((nid: string) => h.joinAsGuest!(nid)) };
});
vi.mock('./monitor/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitor/client')>()),
  listNurseries: vi.fn(async () => ({ ok: true, nurseries: [] })),
}));
vi.mock('./sync', () => ({ pullPrefsFromCloud: vi.fn(async () => undefined) }));
vi.mock('./components/SaveSheet', () => ({ sweepDiscardedRecordings: vi.fn(async () => undefined) }));
vi.mock('./calls/callCenter', () => ({ useCalls: () => ({ log: [], uid: null }) }));
vi.mock('./views/calls/CallHost', () => ({ CallHost: () => null }));
vi.mock('./views/monitor/InviteHost', () => ({ InviteHost: () => null }));
vi.mock('./components/AuthSheet', () => ({ AuthSheetHost: () => null }));
vi.mock('./components/StudiosCard', () => ({ StudiosCard: () => null }));
vi.mock('./components/Guide', () => ({ GuideHost: () => null, openHelp: vi.fn(), useFirstVisitTour: () => undefined }));
vi.mock('./views/DashboardView', () => ({ DashboardView: () => <div data-testid="dashboard" /> }));
// The watch page: says whether it opened on the guest pass (MonitorViewer's own guest branch,
// useGuestPass, which never goes through MonitorGate) or on the account.
vi.mock('./views/MonitorViewer', async () => {
  const { useGuestPass } = await import('./views/monitor/useGuestPass');
  return {
    MonitorViewer: ({ id }: { id: string }) => {
      const [guest] = useGuestPass(id);
      return <div data-testid="monitor-watch" data-guest={guest ? guest.name : ''} />;
    },
  };
});

import { LiveApp } from './LiveApp';

const NID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const CODE = 'c'.repeat(24);
const PASS: GuestPass = { token: 'gp-1', name: 'Grandma Jo', role: 'viewer', until: Date.now() + 86_400_000, nursery: { name: 'Nursery', baby: 'Mia' } };
const holdPass = (nid = NID) => localStorage.setItem(`ds-monitor-guest-${nid}`, JSON.stringify(PASS));

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const gated = () =>
  screen.queryByRole('heading', { name: 'Sign in to Stream Studio' }) ??
  screen.queryByRole('heading', { name: 'One more step' }) ??
  screen.queryByRole('heading', { name: 'Finish signing in' }) ??
  screen.queryByText('Checking your account…');

/** Every account state a guest can be in on this device. */
const GUEST_STATES: [label: string, account: LiveAccount][] = [
  ['signed out', { status: 'signed_out' }],
  ['a DreamStream account without the welcome code', { status: 'needs_code', userId: 'u1', email: 'jo@example.com' }],
  ['a two-step code still owed', { status: 'needs_mfa', userId: 'u1', email: 'jo@example.com', mfa: true }],
  ['the account still loading', { status: 'loading' }],
];

beforeEach(() => {
  localStorage.clear();
  h.account = { status: 'signed_out' };
  h.joinAsGuest = async (nid: string) => {
    localStorage.setItem(`ds-monitor-guest-${nid}`, JSON.stringify(PASS));
    return { ok: true, pass: PASS, account: false };
  };
  history.replaceState(null, '', '/live');
});
afterEach(() => {
  localStorage.clear();
});

describe('a share-link guest watches the nursery, whatever the account says', () => {
  for (const [label, account] of GUEST_STATES) {
    describe(label, () => {
      it('join → watch: the real join form, the passcode, then the picture (not the sign-in screen)', async () => {
        h.account = account;
        history.replaceState(null, '', `/live#/monitor/join/${NID}/${CODE}`);
        render(<LiveApp />);
        fireEvent.change(await screen.findByPlaceholderText('e.g. Grandma Jo'), { target: { value: 'Grandma Jo' } });
        fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'amber-cedar-fern-42' } });
        fireEvent.click(screen.getByRole('button', { name: 'Join and watch' }));
        expect(await screen.findByTestId('monitor-watch')).toHaveAttribute('data-guest', 'Grandma Jo');
        expect(location.hash).toBe(`#/monitor/${NID}/watch`);
        expect(gated()).toBeNull();
      });

      it('reopening the share link with a pass already on this device: straight to the picture', async () => {
        h.account = account;
        holdPass();
        history.replaceState(null, '', `/live#/monitor/join/${NID}/${CODE}`);
        render(<LiveApp />);
        expect(await screen.findByTestId('monitor-watch')).toHaveAttribute('data-guest', 'Grandma Jo');
        expect(location.hash).toBe(`#/monitor/${NID}/watch`);
        expect(gated()).toBeNull();
      });

      it('a reload of the watch page, or a tap on a crying alert (…/watch opened directly): the picture', async () => {
        h.account = account;
        holdPass();
        history.replaceState(null, '', `/live#/monitor/${NID}/watch`);
        render(<LiveApp />);
        await settle();
        expect(await screen.findByTestId('monitor-watch')).toHaveAttribute('data-guest', 'Grandma Jo');
        expect(gated()).toBeNull();
      });
    });
  }
});

describe('the pass opens only its own nursery’s watch page', () => {
  it('no pass on this device: the watch page still asks for the account', async () => {
    history.replaceState(null, '', `/live#/monitor/${NID}/watch`);
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Sign in to Stream Studio' })).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-watch')).toBeNull();
  });

  it('a pass for another nursery opens nothing here', async () => {
    holdPass(OTHER);
    history.replaceState(null, '', `/live#/monitor/${NID}/watch`);
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('heading', { name: 'Sign in to Stream Studio' })).toBeInTheDocument();
  });

  it('…nor the nursery’s camera, its hub, the monitor home or the dashboard', async () => {
    holdPass();
    for (const path of [`/live#/monitor/${NID}/camera`, `/live#/monitor/${NID}`, '/live#/monitor', '/live']) {
      history.replaceState(null, '', path);
      const { unmount } = render(<LiveApp />);
      await settle();
      expect([path, !!screen.queryByRole('heading', { name: 'Sign in to Stream Studio' })]).toEqual([path, true]);
      unmount();
    }
  });
});
