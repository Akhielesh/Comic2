// @vitest-environment jsdom
// The main app's sign-in link handler: links this browser asked for complete at once; any
// other link waits for "Continue". Real pendingSignIn / authLink / safeNext; only the
// Supabase auth calls (the network) are faked.
import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  setSession: vi.fn(),
  getUser: vi.fn()
}));
const lookup = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase', () => ({ supabase: { auth }, lookupAccessTokenEmail: lookup }));

import { useAuthLinkCallback } from './useAuthLinkCallback';
import { AuthCallbackPage } from '../components/AuthCallbackPage';
import { PENDING_SIGN_IN_KEY, SIGN_IN_INTENT_TTL_MS, hasFreshSignInIntent, markSignInStarted } from '../services/pendingSignIn';
import { EXPIRED_LINK_MESSAGE, FRAMED_LINK_MESSAGE } from '../services/authLink';

const go = (path: string) => window.history.replaceState(null, '', path);
const here = () => window.location.pathname + window.location.search + window.location.hash;

const mount = () => {
  const onOpen = vi.fn();
  const onDecline = vi.fn();
  const navigate = vi.fn();
  const hook = renderHook(() => useAuthLinkCallback({ onOpen, onDecline, navigate }));
  return { ...hook, onOpen, onDecline, navigate };
};
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(auth)) fn.mockReset();
  auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
  auth.exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });
  auth.setSession.mockResolvedValue({ data: {}, error: null });
  lookup.mockReset();
  lookup.mockResolvedValue({ email: 'mallory@example.com', dead: false });
  go('/');
});

describe('pages that are not sign-in landing pages', () => {
  it('a tokenless / does nothing', async () => {
    const { result, onOpen } = mount();
    await settle();
    expect(onOpen).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('ignores tokens on /models (and leaves the URL alone)', async () => {
    markSignInStarted('magiclink');
    go('/models#access_token=a&refresh_token=r');
    const { result, onOpen } = mount();
    await settle();
    expect(onOpen).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(here()).toBe('/models#access_token=a&refresh_token=r');
    expect(localStorage.getItem(PENDING_SIGN_IN_KEY)).not.toBeNull(); // not consumed
  });
});

describe('a link this browser asked for (it carries the nonce of a sign-in started here)', () => {
  it('/auth/callback?token_hash completes at once, uses up the intent and cleans the URL', async () => {
    const sn = markSignInStarted('magiclink');
    go(`/auth/callback?token_hash=h&type=magiclink&sn=${sn}`);
    const { result, onOpen } = mount();
    await settle();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'magiclink' });
    expect(result.current.status).toBe('success');
    expect(result.current.message).toBe('Authentication successful.');
    expect(here()).toBe('/');
    expect(localStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
  });

  it('a recovery link on /auth/callback/ (trailing slash) lands on the set-a-new-password step', async () => {
    const sn = markSignInStarted('recovery');
    go(`/auth/callback/?token_hash=r&type=recovery&sn=${sn}`);
    const { result } = mount();
    await settle();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'r', type: 'recovery' });
    expect(result.current.flow).toBe('recovery');
    expect(result.current.message).toMatch(/set a new password/);
  });

  it('/?token_hash (the Site URL fallback) and ?code= are handled too', async () => {
    let sn = markSignInStarted('signup');
    go(`/?token_hash=s&type=signup&sn=${sn}`);
    mount();
    await settle();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 's', type: 'signup' });

    sn = markSignInStarted('magiclink');
    go(`/auth/callback?code=c0de&sn=${sn}`);
    mount();
    await settle();
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('c0de');
  });

  it('follows a safe ?next= after signing in', async () => {
    const sn = markSignInStarted('handoff');
    go(`/auth/callback?token_hash=h&type=magiclink&sn=${sn}&next=%2Fmodels`);
    const { navigate } = mount();
    await settle();
    expect(navigate).toHaveBeenCalledWith('/models');
  });

  it('an expired intent no longer counts', async () => {
    const sn = 'a'.repeat(32);
    localStorage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify([{ nonce: sn, at: Date.now() - SIGN_IN_INTENT_TTL_MS - 1, kind: 'magiclink' }]));
    go(`/auth/callback?token_hash=h&type=magiclink&sn=${sn}`);
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('confirm');
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('a link nobody here asked for', () => {
  it('stops at the confirm step and signs in only on Continue', async () => {
    go('/auth/callback?token_hash=h&type=magiclink');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('confirm');
    expect(result.current.email).toBeNull(); // a token hash can't be read without using it
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    expect(here()).toBe('/auth/callback?token_hash=h&type=magiclink');

    await act(async () => result.current.confirm());
    await settle();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: 'h', type: 'magiclink' });
    expect(result.current.status).toBe('success');
    expect(here()).toBe('/');
  });

  it('names the account for fragment tokens without signing in; Not now drops the link and changes nothing', async () => {
    go('/?view=read&id=x#access_token=a&refresh_token=r&type=magiclink');
    const { result, onDecline } = mount();
    await settle();
    expect(result.current.status).toBe('confirm');
    expect(result.current.email).toBe('mallory@example.com');
    expect(lookup).toHaveBeenCalledWith('a');
    expect(auth.getUser).not.toHaveBeenCalled(); // supabase-js getUser(jwt) can sign the current session out
    expect(auth.setSession).not.toHaveBeenCalled();

    act(() => result.current.decline());
    expect(onDecline).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('idle');
    expect(here()).toBe('/?view=read&id=x');
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('an error link explains itself without any sign-in call', async () => {
    go('/auth/callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.message).toBe(EXPIRED_LINK_MESSAGE);
    expect(here()).toBe('/');
    go('/auth/callback');
    const second = mount();
    await settle();
    expect(second.result.current.message).toMatch(/Invalid callback link/);
  });

  it('a failed sign-in after Continue is reported honestly', async () => {
    auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { message: 'Email link is invalid or has expired', status: 403 } });
    go('/auth/callback?token_hash=used');
    const { result } = mount();
    await settle();
    await act(async () => result.current.confirm());
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.message).toBe('Email link is invalid or has expired');
  });
});

describe('a sign-in started here never vouches for someone else’s link', () => {
  it('a password-reset intent (then a password sign-in instead) does not let an attacker’s magic link through', async () => {
    markSignInStarted('recovery'); // "Forgot password" → email sent; then the visitor remembered it
    go('/auth/callback?token_hash=ATTACKER&type=magiclink');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('confirm');
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('nor fragment tokens for another account, nor a link with a guessed nonce', async () => {
    markSignInStarted('magiclink');
    go('/#access_token=AT_MALLORY&refresh_token=RT_MALLORY&type=magiclink');
    const first = mount();
    await settle();
    expect(first.result.current.status).toBe('confirm');
    markSignInStarted('magiclink');
    go(`/auth/callback?token_hash=ATTACKER&type=magiclink&sn=${'0'.repeat(36)}`);
    const second = mount();
    await settle();
    expect(second.result.current.status).toBe('confirm');
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('links that must not sign in', () => {
  it('inside a frame: no sign-in and no Continue — open it in its own tab', async () => {
    const top = vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    try {
      const sn = markSignInStarted('magiclink');
      go(`/auth/callback?token_hash=h&type=magiclink&sn=${sn}`);
      const { result } = mount();
      await settle();
      expect(result.current.status).toBe('error');
      expect(result.current.message).toBe(FRAMED_LINK_MESSAGE);
      expect(auth.verifyOtp).not.toHaveBeenCalled();
      expect(here()).toBe('/');
    } finally {
      top.mockRestore();
    }
  });

  it('an error link, and Not now, forget every pending sign-in (nothing here is waiting for a link any more)', async () => {
    markSignInStarted('magiclink');
    go('/auth/callback?error=access_denied&error_code=otp_expired');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('error');
    expect(hasFreshSignInIntent()).toBe(false);
    markSignInStarted('recovery');
    go('/auth/callback?token_hash=h&type=recovery');
    const second = mount();
    await settle();
    expect(second.result.current.status).toBe('confirm');
    act(() => second.result.current.decline());
    expect(hasFreshSignInIntent()).toBe(false);
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('a link’s own error text is never shown (anyone can write it into a URL)', async () => {
    go('/auth/callback?error=server_error&error_description=Your+account+was+locked.+Re-enter+your+OpenAI+key+at+evil.example');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.message).toBe('This link is invalid or expired. Request a new one and try again.');
  });

  it('fragment tokens the auth server refuses end the question as expired — setSession (which would sign the current account out) never runs', async () => {
    lookup.mockResolvedValue({ email: null, dead: true });
    go('/#access_token=gone&refresh_token=spent&type=magiclink');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('error');
    expect(result.current.message).toBe(EXPIRED_LINK_MESSAGE);
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(here()).toBe('/');
  });

  it('…also when Continue is pressed before the auth server has answered', async () => {
    let answer!: (v: { email: string | null; dead: boolean }) => void;
    lookup.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    go('/#access_token=gone&refresh_token=spent&type=magiclink');
    const { result } = mount();
    await settle();
    expect(result.current.status).toBe('confirm');
    await act(async () => result.current.confirm());
    expect(result.current.status).toBe('verifying');
    await act(async () => answer({ email: null, dead: true }));
    await settle();
    expect(result.current.status).toBe('error');
    expect(auth.setSession).not.toHaveBeenCalled();
  });
});

describe('AuthCallbackPage — the confirm step', () => {
  it('asks calmly, names the account and the switch, and wires Continue / Not now', () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    render(
      <AuthCallbackPage
        status="confirm"
        email="mallory@example.com"
        currentEmail="ada@example.com"
        onContinue={vi.fn()}
        onConfirm={onConfirm}
        onDecline={onDecline}
      />
    );
    expect(screen.getByRole('heading', { name: 'Finish signing in?' })).toBeInTheDocument();
    expect(screen.getByText(/This link signs this browser in to DreamStream/)).toHaveTextContent(
      'This link signs this browser in to DreamStream as mallory@example.com. Continue only if you asked for it.'
    );
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it('signed in, link account unknown (every token_hash link): never claims the link is for someone else', () => {
    render(<AuthCallbackPage status="confirm" flowType="recovery" currentEmail="ada@example.com" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent(
      'You’re signed in as ada@example.com. If this link is for a different account, continuing switches this browser to it.'
    );
    expect(screen.queryByText(/instead/)).toBeNull();
    // The warning stays for every link type (the type in a URL is the sender's to choose).
    expect(screen.getByText(/Continue only if you asked for it/)).toBeInTheDocument();
  });

  it('…the same account: nothing about switching; a sign-up link says it also confirms the email', () => {
    const { rerender } = render(
      <AuthCallbackPage status="confirm" email="ada@example.com" currentEmail="Ada@Example.com" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />
    );
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
    rerender(<AuthCallbackPage status="confirm" flowType="signup" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText('Continuing also confirms the account’s email.')).toBeInTheDocument();
  });

  it('a11y: a plain section (not a non-modal "dialog"), focus moves to the heading, one live region announces each status', () => {
    const { rerender } = render(<AuthCallbackPage status="confirm" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Finish signing in?' })).toHaveFocus();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    rerender(<AuthCallbackPage status="verifying" onContinue={vi.fn()} />);
    expect(document.querySelector('[aria-live="polite"]')).toBe(live); // the same node: its new text is announced
    expect(live).toHaveTextContent('Please wait while we verify your secure sign-in link.');
    expect(screen.getByRole('heading', { name: 'Verifying Link' })).toHaveFocus();
    rerender(<AuthCallbackPage status="error" message="This link has expired or was already used." onContinue={vi.fn()} />);
    expect(document.querySelector('[aria-live="polite"]')).toBe(live);
    expect(live).toHaveTextContent('This link has expired or was already used.');
  });

  it('uses generic copy when the account can’t be known', () => {
    render(<AuthCallbackPage status="confirm" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/This link signs this browser in to DreamStream/)).toHaveTextContent(
      'This link signs this browser in to DreamStream. Continue only if you asked for it.'
    );
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
  });

  it('a fresh tab with nobody signed in ("Remember me" off) still warns when another account’s data is on this browser — not on a clean device, and not instead of the signed-in account’s own line', () => {
    const { rerender } = render(<AuthCallbackPage status="confirm" otherAccountOnDevice onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/Another account’s data is on this browser/)).toHaveTextContent(
      'Another account’s data is on this browser. Continuing removes it here (that account gets it back from its cloud copy when it signs in).'
    );
    expect(screen.queryByText(/You’re signed in as/)).toBeNull();
    expect(screen.getByText(/Continue only if you asked for it/)).toBeInTheDocument();
    rerender(<AuthCallbackPage status="confirm" otherAccountOnDevice={false} onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByText(/Another account’s data/)).toBeNull();
    // Someone is signed in here: their line (the email is known) says what continuing does.
    rerender(<AuthCallbackPage status="confirm" otherAccountOnDevice currentEmail="ada@example.com" onContinue={vi.fn()} onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.queryByText(/Another account’s data/)).toBeNull();
    expect(screen.getByText(/You’re signed in as/)).toHaveTextContent('ada@example.com');
  });
});
