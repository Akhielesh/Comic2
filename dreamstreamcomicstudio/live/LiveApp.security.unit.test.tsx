// @vitest-environment jsdom
// Stream Studio's shell and account security (ADR 0006 WS-5): the "Not you?" route keeps its
// token out of the address bar, a session ended elsewhere is explained once, and a sign-in that
// still owes the two-step code asks for it.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveAccount } from './account';

const h = vi.hoisted(() => ({
  account: { status: 'signed_out' } as LiveAccount,
  secure: vi.fn(),
}));

vi.mock('./account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  consumeAuthReturn: vi.fn(async () => null),
  useAccount: () => h.account,
  secureAccount: h.secure,
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { secureAccountUrl } from '../email-worker/src/securityAlert';
import { SECURE_TOKEN } from './account';
import { LiveApp, parseRoute } from './LiveApp';

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123';
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  h.account = { status: 'signed_out' };
  h.secure.mockReset();
  history.replaceState(null, '', '/live');
});

describe('#/secure — the "Not you?" link', () => {
  it('routes to the page with its token', () => {
    history.replaceState(null, '', `/live#/secure/${TOKEN}`);
    expect(parseRoute()).toEqual({ view: 'secure', token: TOKEN });
    history.replaceState(null, '', '/live#/secure');
    expect(parseRoute()).toEqual({ view: 'secure', token: '' });
  });

  it('takes the token out of the address bar at once, and still uses it on the tap', async () => {
    h.secure.mockResolvedValue({ ok: true, signedOutEverywhere: true, sessionsEnded: 1, devicesRevoked: 0, resetEmail: 'sent', emailHint: null, thisDevice: false, kicked: false });
    history.replaceState(null, '', `/live#/secure/${TOKEN}`);
    render(<LiveApp />);
    await settle();
    expect(location.hash).toBe('#/secure');
    expect(location.href).not.toContain(TOKEN);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Secure my account' }));
    });
    await settle();
    expect(h.secure).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByRole('heading', { name: 'Your account is secured' })).toBeInTheDocument();
  });
});

describe('the new-sign-in email lands on this page (the SECURE_ACCOUNT_PAGE flip)', () => {
  // live_security_v2.sql: 24 random bytes, base64url without padding.
  const emailed = 'Ab-_0123456789abcdefghijklmnopqr';

  it('the email Worker sends the button: SECURE_ACCOUNT_PAGE is on in its deployed config', () => {
    // (jsdom: import.meta.url isn't a file URL here; tests run from the app's root.)
    const text = readFileSync(path.join(process.cwd(), 'email-worker/wrangler.jsonc'), 'utf8');
    const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
    expect(parsed.error).toBeUndefined();
    expect((parsed.config as { vars: Record<string, string> }).vars.SECURE_ACCOUNT_PAGE).toBe('on');
  });

  for (const streamHostOn of [false, true]) {
    it(`its link opens #/secure with the token, on either address (stream host ${streamHostOn ? 'on' : 'off'})`, () => {
      expect(SECURE_TOKEN.test(emailed)).toBe(true);
      const link = new URL(secureAccountUrl(emailed, 'https://dreamstreamstudio.ai', streamHostOn));
      history.replaceState(null, '', `${link.pathname}${link.search}${link.hash}`);
      expect(parseRoute()).toEqual({ view: 'secure', token: emailed });
    });
  }
});

describe('session lifecycle in the shell', () => {
  it('says once that the session was ended elsewhere', async () => {
    h.account = { status: 'signed_out', ended: 'revoked' };
    const { rerender } = render(<LiveApp />);
    await settle();
    expect(screen.getAllByText(/your account was signed out on every device/)).toHaveLength(1);
    rerender(<LiveApp />);
    await settle();
    expect(screen.getAllByText(/your account was signed out on every device/)).toHaveLength(1);
  });

  it('asks for the two-step code by itself after the password', async () => {
    h.account = { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com', mfa: true };
    render(<LiveApp />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Two-step sign-in' })).toBeInTheDocument();
    // The rail offers it too, instead of "Sign in".
    expect(screen.getByRole('button', { name: 'Finish signing in with your two-step code' })).toBeInTheDocument();
  });

  it('the account menu has both sign-out paths and Security', async () => {
    h.account = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada', mfa: false };
    render(<LiveApp />);
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: 'Account menu' })[0]);
    expect(screen.getByRole('menuitem', { name: 'Sign out of this device' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out everywhere…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Security' })).toBeInTheDocument();
  });
});
