// @vitest-environment jsdom
// "Not you? Secure my account" (ADR 0006 WS-5): nothing happens until the tap (mail scanners open
// links too); the result says exactly what happened.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../../nav';

const h = vi.hoisted(() => ({ secure: vi.fn(), openAuth: vi.fn() }));
vi.mock('../../account', () => ({
  SECURE_TOKEN: /^[A-Za-z0-9_-]{20,128}$/,
  failed: (r: { ok: boolean }) => r.ok === false,
  secureAccount: h.secure,
  openAuth: h.openAuth,
}));

import { SecureAccount } from './SecureAccount';

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123';
const nav = { dashboard: vi.fn(), settings: vi.fn() } as unknown as Nav;
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  h.secure.mockReset();
  h.openAuth.mockReset();
  (nav.dashboard as ReturnType<typeof vi.fn>).mockReset();
});

describe('SecureAccount', () => {
  it('explains what it will do and waits for the tap', async () => {
    render(<SecureAccount token={TOKEN} nav={nav} />);
    expect(screen.getByRole('heading', { name: 'Secure your account?' })).toBeInTheDocument();
    expect(screen.getByText(/including this one, and a phone running as a nursery camera/)).toBeInTheDocument();
    await flush();
    expect(h.secure).not.toHaveBeenCalled();
  });

  it('secures the account and says exactly what happened', async () => {
    h.secure.mockResolvedValue({ ok: true, signedOutEverywhere: true, sessionsEnded: 3, devicesRevoked: 1, resetEmail: 'sent', emailHint: 'a•••@example.com', thisDevice: true, kicked: false });
    render(<SecureAccount token={TOKEN} nav={nav} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    });
    await flush();
    expect(h.secure).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole('heading', { name: 'Your account is secured' })).toBeInTheDocument();
    expect(screen.getByText(/Every device was signed out \(3 sessions\)\. This browser is signed out too\./)).toBeInTheDocument();
    expect(screen.getByText(/One phone or watch added since that sign-in was signed out/)).toBeInTheDocument();
    // The kick didn't happen: never claimed.
    expect(screen.getByText(/may stay connected until it reconnects/)).toBeInTheDocument();
    expect(screen.getByText(/emailed a link to choose a new password to a•••@example\.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(h.openAuth).toHaveBeenCalledWith('signin');
  });

  it('never claims every device was signed out when the database couldn’t', async () => {
    h.secure.mockResolvedValue({ ok: true, signedOutEverywhere: false, sessionsEnded: null, devicesRevoked: 0, resetEmail: 'failed', emailHint: null, thisDevice: false, kicked: false });
    render(<SecureAccount token={TOKEN} nav={nav} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    });
    await flush();
    expect(screen.getByText(/couldn’t sign every device out just now/)).toBeInTheDocument();
    expect(screen.getByText(/couldn’t send the password email/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password' }));
    expect(h.openAuth).toHaveBeenCalledWith('reset');
  });

  it('a link used before says so, and offers a password reset', async () => {
    h.secure.mockResolvedValue({ ok: false, code: 'used', message: 'This link was already used — your account was secured then.' });
    render(<SecureAccount token={TOKEN} nav={nav} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    });
    await flush();
    expect(screen.getByRole('heading', { name: 'Already secured' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('already used');
    expect(screen.getByRole('button', { name: 'Forgot password' })).toBeInTheDocument();
  });

  it('offline: try again (the link still works)', async () => {
    h.secure.mockResolvedValueOnce({ ok: false, code: 'unreachable', message: 'Can’t reach DreamStream right now.' });
    render(<SecureAccount token={TOKEN} nav={nav} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    });
    await flush();
    h.secure.mockResolvedValueOnce({ ok: true, signedOutEverywhere: true, sessionsEnded: 1, devicesRevoked: 0, resetEmail: 'sent', emailHint: null, thisDevice: false, kicked: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await flush();
    expect(h.secure).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Monitors and calls that were open were disconnected/)).toBeInTheDocument();
  });

  it('"It was me" leaves everything as it is', () => {
    render(<SecureAccount token={TOKEN} nav={nav} />);
    fireEvent.click(screen.getByRole('button', { name: 'It was me' }));
    expect(nav.dashboard).toHaveBeenCalled();
    expect(h.secure).not.toHaveBeenCalled();
  });

  it('a cut-off link is explained, not sent', () => {
    render(<SecureAccount token="short" nav={nav} />);
    expect(screen.getByRole('heading', { name: 'This link isn’t complete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Secure my account' })).toBeNull();
  });
});
