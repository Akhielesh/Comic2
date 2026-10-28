// @vitest-environment jsdom
// The main sign-in form: a password sign-in that succeeds forgets any sign-in link this browser
// asked for earlier (a "Forgot password" email, say) — nothing here waits for a link any more, so
// no link opened later may skip the "Finish signing in?" step on its account.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signOut: vi.fn() }));
vi.mock('../services/supabase', () => ({
  supabase: { auth },
  getAuthPersistMode: () => 'local',
  setAuthPersistMode: vi.fn(),
  getAuthRedirectUrl: () => 'https://dreamstreamstudio.ai/auth/callback'
}));
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
