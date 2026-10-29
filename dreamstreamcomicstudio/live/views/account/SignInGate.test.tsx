// @vitest-environment jsdom
// The screens Stream Studio shows instead of the studio (live/accessGate.ts): the splash, sign in
// with your DreamStream account, the welcome-code step and the two-step code. Each one: what it
// says, where focus lands, and what its buttons do.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from '../../account';

const h = vi.hoisted(() => ({
  account: { status: 'signed_out' } as LiveAccount,
  openAuth: vi.fn(),
  signOut: vi.fn(async () => undefined),
  askForCode: vi.fn(async () => true),
  handoff: vi.fn(),
  onStreamHost: false,
  streamHostOn: false,
}));

vi.mock('../../account', () => ({
  useAccount: () => h.account,
  openAuth: h.openAuth,
  signOutThisDevice: h.signOut,
}));
vi.mock('./StepUp', () => ({ askForCode: h.askForCode }));
vi.mock('../../host', () => ({
  get ON_STREAM_HOST() {
    return h.onStreamHost;
  },
}));
vi.mock('@/shared/streamHost', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/shared/streamHost')>();
  return {
    ...real,
    get STREAM_HOST_ON() {
      return h.streamHostOn;
    },
  };
});
vi.mock('@/services/liveLink', () => ({
  mainAppUrl: (p = '/') => p,
  continueWithDreamStream: h.handoff,
}));

import { SignInGate } from './SignInGate';

const push = vi.fn();
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  h.account = { status: 'signed_out' };
  h.onStreamHost = false;
  h.streamHostOn = false;
  for (const fn of [h.openAuth, h.signOut, h.askForCode, h.handoff, push]) fn.mockClear();
  history.replaceState(null, '', '/live');
});

describe('splash — the account isn’t known yet', () => {
  it('is quiet: a status line, no heading, no buttons, nothing of the studio', () => {
    render(<SignInGate gate="splash" view="dashboard" push={push} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking your account…');
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says a sign-in link is being finished', () => {
    render(<SignInGate gate="splash" view="dashboard" finishing push={push} />);
    expect(screen.getByRole('status')).toHaveTextContent('Finishing sign-in…');
  });
});

describe('sign in — signed out', () => {
  it('asks for the DreamStream account (the same one as Comic Studio and Chat Studio), focused on its heading', () => {
    render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Sign in to Stream Studio' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAccessibleName('Sign in to Stream Studio');
    expect(screen.getByText(/Sign in with your DreamStream account — the same account you use for Comic Studio and Chat Studio\./)).toBeInTheDocument();
    expect(screen.getByText('New accounts need a welcome code while Stream Studio is in private beta.')).toBeInTheDocument();
  });

  it('Sign in and Create account open the sign-in sheet', () => {
    render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(h.openAuth).toHaveBeenLastCalledWith('signin');
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(h.openAuth).toHaveBeenLastCalledWith('create');
  });

  it('tells people who were sent a link to open that link — it needs only a name', () => {
    render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    expect(screen.getByText(/Were you sent a link\? Open that link instead — watching a stream or joining a meeting needs only a name/)).toBeInTheDocument();
    expect(screen.getByText(/a nursery share link a name and the passcode you were told/)).toBeInTheDocument();
  });

  it('names what the visitor was opening', () => {
    const { unmount } = render(<SignInGate gate="sign-in" view="monitor-camera" push={push} />);
    expect(screen.getByText(/Sign in with your DreamStream account to start the nursery camera —/)).toBeInTheDocument();
    unmount();
    render(<SignInGate gate="sign-in" view="calls" push={push} />);
    expect(screen.getByText(/Sign in with your DreamStream account to open your calls —/)).toBeInTheDocument();
  });

  it('a way home and the legal links', () => {
    render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    expect(screen.getByRole('link', { name: 'DreamStream home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('navigation', { name: 'Legal and support links' })).toBeInTheDocument();
  });

  it('Continue with DreamStream only on Stream Studio’s own address, and never from a private event link (its key would be lost)', () => {
    const { unmount } = render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    expect(screen.queryByRole('button', { name: 'Continue with DreamStream' })).toBeNull();
    unmount();

    h.onStreamHost = true;
    h.streamHostOn = true;
    history.replaceState(null, '', '/#/monitor');
    const second = render(<SignInGate gate="sign-in" view="monitor" push={push} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DreamStream' }));
    expect(h.handoff).toHaveBeenCalledWith('monitor');
    second.unmount();

    history.replaceState(null, '', '/?e=ev1#/studio?k=hostkey');
    render(<SignInGate gate="sign-in" view="studio" push={push} />);
    expect(screen.queryByRole('button', { name: 'Continue with DreamStream' })).toBeNull();
  });

  it('leaves focus in a sheet that already has it (the sign-in sheet stays usable)', () => {
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    sheet.appendChild(input);
    document.body.appendChild(sheet);
    input.focus();
    render(<SignInGate gate="sign-in" view="dashboard" push={push} />);
    expect(input).toHaveFocus();
    sheet.remove();
  });
});

describe('one more step — signed in, no welcome code yet', () => {
  it('shows who is signed in (the account’s name from the other studios) and asks for the code once', () => {
    h.account = { status: 'needs_code', userId: 'u1', email: 'ada@example.com', suggestedName: 'Ada Lovelace' };
    render(<SignInGate gate="needs-code" view="dashboard" push={push} />);
    expect(screen.getByRole('heading', { level: 1, name: 'One more step' })).toHaveFocus();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/needs the welcome code you were given, once/)).toBeInTheDocument();
    expect(screen.getByText(/You’ll appear as Ada Lovelace — you can change it when you enter the code\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter your welcome code' }));
    expect(h.openAuth).toHaveBeenCalledWith('code');
  });

  it('without a name yet: the email is who’s signed in', () => {
    h.account = { status: 'needs_code', userId: 'u1', email: 'ada@example.com' };
    render(<SignInGate gate="needs-code" view="dashboard" push={push} />);
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/You’ll appear as/)).toBeNull();
  });

  it('Sign out signs this device out and says so', async () => {
    h.account = { status: 'needs_code', userId: 'u1', email: 'ada@example.com' };
    render(<SignInGate gate="needs-code" view="dashboard" push={push} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('status')).toHaveTextContent('Signing out…');
    await flush();
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('Signed out on this device', { icon: 'check' });
  });
});

describe('finish signing in — the two-step code is owed', () => {
  it('names the account and opens the code sheet', () => {
    h.account = { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com', mfa: true };
    render(<SignInGate gate="needs-mfa" view="monitor" push={push} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Finish signing in' })).toHaveFocus();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText(/has two-step sign-in on\. Type the\s+6-digit code/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enter your code' }));
    expect(h.askForCode).toHaveBeenCalledWith(undefined, 'signin');
  });

  it('Sign out instead', async () => {
    h.account = { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com', mfa: true };
    render(<SignInGate gate="needs-mfa" view="monitor" push={push} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await flush();
    expect(h.signOut).toHaveBeenCalledOnce();
  });
});
