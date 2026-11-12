// @vitest-environment jsdom
// The sign-in card on Atlas (DS-3; master plan §1.3, the :315 card): the same auth logic (AuthPage.signIn.test.tsx
// pins it) in paper and ink — one <main> with a heading, every field named by its label, a keyboard-reachable
// "Remember me", calm status callouts instead of a shaking red banner, legal links that are real links, and no
// comic chrome (Bangers, black borders, comic shadows, brand hues) anywhere on the card.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DENSITY, STATUS_SURFACE } from './chat/studioDesign';

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signOut: vi.fn() }));
vi.mock('../services/supabase', () => ({
  supabase: { auth, rpc: vi.fn() },
  getAuthPersistMode: () => 'local',
  setAuthPersistMode: vi.fn(),
  getAuthRedirectUrl: () => 'https://dreamstreamstudio.ai/auth/callback'
}));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('./WaitlistForm', () => ({ WaitlistForm: ({ variant }: { variant?: string }) => <div data-testid="waitlist" data-variant={variant} /> }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));

import { AuthPage } from './AuthPage';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const LEGACY = /border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red|black)|text-white|animate-shake|#[0-9a-f]{6}\b/i;

beforeEach(() => auth.signInWithPassword.mockReset());
afterEach(cleanup);

describe('AuthPage on Atlas', () => {
  it('is one main landmark with a heading, its fields named by their labels, and no comic chrome', () => {
    const { container } = render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Email or username/)).toHaveAttribute('placeholder', 'user@example.com or username');
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password');
    expect(container.innerHTML).not.toMatch(LEGACY);
    // The two choices are one radio group (the DS Segmented), not two loose buttons.
    expect(screen.getByRole('radiogroup', { name: 'Sign in or join' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveAttribute('aria-checked', 'true');
  });

  it('“Remember me” is a real, reachable checkbox and the password toggle says what it does', () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    const remember = screen.getByRole('checkbox', { name: 'Remember me' });
    expect(remember).toBeChecked();
    expect(remember.className.split(/\s+/)).not.toContain('hidden');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'text');
  });

  it('a failed sign-in reads as a calm alert on the error surface, never a shaking red banner', async () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Email or username/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'wrong' } });
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Invalid login credentials' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Studio' }));
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Invalid credentials. If this account is new, verify your email first.');
    for (const cls of STATUS_SURFACE.error.split(' ')) expect(alert.className.split(/\s+/)).toContain(cls);
    expect(alert.className).not.toMatch(/animate-|red-\d/);
  });

  it('an invite opens sign-up: the invite is shown, and the legal words are links to the pages', () => {
    const onOpenTerms = vi.fn();
    const onOpenPrivacy = vi.fn();
    const { container } = render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={onOpenPrivacy} onOpenTerms={onOpenTerms} pendingInviteCode="DS-ABCD-EFGH" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/DS-ABCD-EFGH will be applied automatically/);
    const terms = screen.getByRole('link', { name: 'Terms and Conditions' });
    expect(terms).toHaveAttribute('href', '/?view=terms');
    fireEvent.click(terms);
    expect(onOpenTerms).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'Privacy Policy' }));
    expect(onOpenPrivacy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('checkbox', { name: /I accept the Terms and Conditions/ })).not.toBeChecked();
    expect(container.innerHTML).not.toMatch(LEGACY);
  });

  it('the sign-in link has one name, and every submit label is in sentence case (“Enter Studio” stays)', () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Email me a sign-in link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send the link' })).toHaveAttribute('type', 'submit');
    fireEvent.click(screen.getByRole('button', { name: 'Back to password sign-in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('button', { name: 'Send reset link' })).toHaveAttribute('type', 'submit');
    cleanup();
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} pendingInviteCode="DS-ABCD-EFGH" />);
    expect(screen.getByRole('button', { name: 'Create account' })).toHaveAttribute('type', 'submit');
    expect(document.body.textContent).not.toMatch(/magic link/i);
    expect(document.body.textContent).not.toMatch(/Send Magic Link|Send Reset Link|Create Account/);
  });

  it('pressing the checked “Sign in” on the reset or sign-in-link step goes back to the password step', () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    for (const step of ['Email me a sign-in link', 'Forgot password?']) {
      fireEvent.click(screen.getByRole('button', { name: step }));
      expect(screen.queryByRole('heading', { level: 1, name: 'Welcome back' })).toBeNull();
      const signIn = screen.getByRole('radio', { name: 'Sign in' });
      expect(signIn).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(signIn);
      expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    }
    // On the password step itself the press changes nothing.
    fireEvent.click(screen.getByRole('radio', { name: 'Sign in' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('an unverified email offers “Resend verification email” as a 44 px coarse target', async () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Email or username/), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'secret-pass' } });
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Email not confirmed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enter Studio' }));
    await settle();
    const resend = screen.getByRole('button', { name: 'Resend verification email' });
    for (const cls of DENSITY.coarse.split(' ')) expect(resend.className.split(/\s+/)).toContain(cls);
  });

  it('switching to “Request access” (sign-ups closed) shows the access request in place', () => {
    render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Request access' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Request access' })).toBeInTheDocument();
    // The access request is the waitlist form on the DS primitives, not the legacy home page's comic form.
    expect(screen.getByTestId('waitlist')).toHaveAttribute('data-variant', 'atlas');
    // "Already have an account? Sign in" is a button, so the inline-link exception does not cover it: 44 px square
    // under a coarse pointer, like the other small steps on the card.
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    for (const cls of DENSITY.coarseSquare.split(' ')) expect(signIn.className.split(/\s+/)).toContain(cls);
    fireEvent.click(signIn);
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });
});
