// @vitest-environment jsdom
// Stream Studio's shell with a sign-in link this browser didn't ask for. The real LiveApp,
// LinkConfirmSheet and GuideHost (the first-visit tour); only the network-bound pieces
// (account calls, sync, calls, the dashboard's data) are stubbed.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthReturn, AuthReturnConfirm, LiveAccount } from './account';

const h = vi.hoisted(() => ({
  ret: null as AuthReturn | null,
  account: { status: 'signed_out' } as LiveAccount,
  openAuth: vi.fn(),
}));

vi.mock('./account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  consumeAuthReturn: vi.fn(async () => h.ret),
  useAccount: () => h.account,
  openAuth: h.openAuth,
}));
vi.mock('./sync', () => ({ pullPrefsFromCloud: vi.fn(async () => undefined) }));
vi.mock('./components/SaveSheet', () => ({ sweepDiscardedRecordings: vi.fn(async () => undefined) }));
vi.mock('./calls/callCenter', () => ({ useCalls: () => ({ log: [], uid: null }) }));
vi.mock('./views/calls/CallHost', () => ({ CallHost: () => null }));
vi.mock('./views/monitor/InviteHost', () => ({ InviteHost: () => null }));
vi.mock('./components/AuthSheet', () => ({ AuthSheetHost: () => null }));
vi.mock('./components/StudiosCard', () => ({ StudiosCard: () => null }));
vi.mock('./views/DashboardView', () => ({ DashboardView: () => <div data-testid="dashboard" /> }));

import { LiveApp } from './LiveApp';

const confirmFor = (over: Partial<AuthReturnConfirm> = {}): AuthReturnConfirm => ({
  confirm: true,
  email: Promise.resolve(null),
  proceed: vi.fn(async () => ({ confirmed: true as const })),
  dismiss: vi.fn(),
  ...over,
});
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  h.account = { status: 'signed_out' };
  h.openAuth.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiveApp — a sign-in link nobody here asked for', () => {
  it('the first-visit tour waits: the confirm sheet is on top, reachable, and Continue signs in', async () => {
    history.replaceState(null, '', '/live?after=monitor&token_hash=h&type=signup');
    const link = confirmFor();
    h.ret = link;
    render(<LiveApp />);
    await settle();
    await advance(1_500); // past the tour's 900 ms start
    expect(screen.getByRole('dialog', { name: 'Finish signing in?' })).toBeInTheDocument();
    expect(document.querySelector('.tour-root')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    await settle();
    expect(link.proceed).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Finish signing in?' })).toBeNull();
    expect(screen.getByText(/Email confirmed/)).toBeInTheDocument();
    // Settled: now the tour may start.
    await advance(1_500);
    expect(document.querySelector('.tour-root')).not.toBeNull();
  });

  it('Not now drops the link and leaves the dashboard as it was', async () => {
    history.replaceState(null, '', '/live?token_hash=h&type=magiclink');
    const link = confirmFor({ handoff: true });
    h.ret = link;
    render(<LiveApp />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(link.dismiss).toHaveBeenCalledOnce();
    expect(link.proceed).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Finish signing in?' })).toBeNull();
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('says who is signed in now, and what continuing does to their data on this device', async () => {
    h.account = { status: 'member', userId: 'u-ada', email: 'ada@example.com' };
    history.replaceState(null, '', '/live?token_hash=h&type=magiclink');
    h.ret = confirmFor();
    render(<LiveApp />);
    await settle();
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent(
      'You’re signed in as ada@example.com. If this link is for a different account, continuing switches this browser to it, and ada@example.com’s Stream Studio data on this device (alerts, nursery setup) is removed.'
    );
  });

  it('a fresh tab with nobody signed in, another account’s data still on the device (ds-live-owner): the sheet says continuing removes it', async () => {
    localStorage.setItem('ds-live-owner', 'u-ada');
    history.replaceState(null, '', '/live?token_hash=h&type=magiclink');
    h.ret = confirmFor();
    render(<LiveApp />);
    await settle();
    expect(screen.getByText(/Another account’s Stream Studio data is on this browser/)).toBeInTheDocument();
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
  });

  it('…and says nothing of the sort on a device nobody’s data is on', async () => {
    history.replaceState(null, '', '/live?token_hash=h&type=magiclink');
    h.ret = confirmFor();
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Finish signing in?' })).toBeInTheDocument();
    expect(screen.queryByText(/Another account’s Stream Studio data/)).toBeNull();
  });

  it('a link opened inside a frame says to open it in its own tab', async () => {
    history.replaceState(null, '', '/live?token_hash=h&type=signup');
    h.ret = { error: 'framed' };
    render(<LiveApp />);
    await settle();
    expect(h.openAuth).toHaveBeenCalledWith('signin', expect.stringMatching(/only work in their own tab/));
  });
});
