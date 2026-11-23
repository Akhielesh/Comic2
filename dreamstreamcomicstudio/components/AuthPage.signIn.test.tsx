// @vitest-environment jsdom
// The main sign-in form: a password sign-in that succeeds forgets any sign-in link this browser
// asked for earlier (a "Forgot password" email, say) — nothing here waits for a link any more, so
// no link opened later may skip the "Finish signing in?" step on its account.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), setSession: vi.fn(), signOut: vi.fn() }));
vi.mock('../services/supabase', () => ({
  supabase: { auth },
  getAuthPersistMode: () => 'local',
  setAuthPersistMode: vi.fn(),
  getAuthRedirectUrl: () => 'https://dreamstreamstudio.ai/auth/callback'
}));
vi.mock('../services/googleSignIn', () => ({ googleSignInAvailable: vi.fn(async () => false), startGoogleSignIn: vi.fn(), pendingGoogleSignIn: () => null, completeGoogleSignIn: vi.fn(), cancelGoogleSignIn: vi.fn() }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('./WaitlistForm', () => ({ WaitlistForm: () => null }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));

import { AuthPage } from './AuthPage';
import { hasFreshSignInIntent, markSignInStarted } from '../services/pendingSignIn';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  localStorage.clear();
  auth.signInWithPassword.mockReset();
});

describe('AuthPage — password sign-in', () => {
  it('a sign-in that succeeds forgets the pending link sign-in; a failed one keeps it', async () => {
    markSignInStarted('recovery'); // "Forgot password" → email sent; then the password came back to mind
    const onLoginSuccess = vi.fn();
    render(<AuthPage onLoginSuccess={onLoginSuccess} onOpenPrivacy={() => undefined} onOpenTerms={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com or username'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } });

    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Invalid login credentials' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Studio' }));
    await settle();
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(hasFreshSignInIntent()).toBe(true); // still waiting for the reset link

    auth.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: 'u', email_confirmed_at: '2026-01-01' } }, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Studio' }));
    await settle();
    expect(onLoginSuccess).toHaveBeenCalledOnce();
    expect(auth.signInWithPassword).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'ada@example.com' }));
    expect(hasFreshSignInIntent()).toBe(false);
  });
});


it('submits a handle privately and adopts the password-verified session without looking up a mailbox in the browser', async () => {
  const onLoginSuccess = vi.fn();
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'verified-access', refresh_token: 'verified-refresh' }));
  auth.setSession.mockResolvedValue({ data: { user: { id: 'member', email_confirmed_at: 'today' } }, error: null });
  try {
    render(<AuthPage onLoginSuccess={onLoginSuccess} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Email or username/ }), { target: { value: 'My_Handle' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'fixture-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Studio' }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('/api/auth/username/signin', expect.objectContaining({ body: JSON.stringify({ username: 'My_Handle', password: 'fixture-password' }) }));
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'verified-access', refresh_token: 'verified-refresh' });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});

it.each([true, false])('passes the standalone image destination on magic link requests only when requested (%s)', async (returnToImages) => {
  const sent = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', sent);
  try {
    render(<AuthPage returnToWorkspace={returnToImages ? 'images' : undefined} onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'fixture@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    await waitFor(() => expect(sent).toHaveBeenCalledOnce());
    const [url, options] = sent.mock.calls[0];
    expect(url).toBe('/api/auth/email/magiclink');
    const body = JSON.parse(String(options.body));
    expect(body.sn).toBeTruthy();
    expect(body.returnToWorkspace).toBe(returnToImages ? 'images' : undefined);
    expect(await screen.findByText('Sign-in link sent. Check your email to continue.')).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('creates an ordinary account without an invitation and can resend verification from the same workspace', async () => {
  const post = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', post);
  const onLoginSuccess = vi.fn();
  try {
    window.history.replaceState({}, '', '/?view=images&ref=' + 'a'.repeat(32));
    render(<AuthPage initialMode="signup" returnToWorkspace="images" onLoginSuccess={onLoginSuccess} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    for (const [label, value] of [
      [/^Username/, 'public_creator'], [/^First name/, 'Ada'], [/^Email/, 'ada@example.test'], [/^Date of birth/, '2000-03-14'],
      [/^Password/, 'fixture-passphrase'], [/^Confirm password/, 'fixture-passphrase'],
    ] as const) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText(/open the verification link/);
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(post.mock.calls[0][0]).toBe('/api/auth/email/signup');
    expect(JSON.parse(String(post.mock.calls[0][1].body))).toMatchObject({
      app: 'main', email: 'ada@example.test', returnToWorkspace: 'images', data: { username: 'public_creator', terms_accepted: true, marketing_consent: false, referral_code: 'a'.repeat(32) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await screen.findByText(/Verification email sent/);
    expect(post.mock.calls[1][0]).toBe('/api/auth/email/resend');
    expect(JSON.parse(String(post.mock.calls[1][1].body))).toMatchObject({ email: 'ada@example.test', returnToWorkspace: 'images' });
  } finally {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});
