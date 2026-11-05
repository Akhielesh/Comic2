// @vitest-environment jsdom
// Sign-up's username check (authz-data-6): it asks public.username_available, which answers yes or
// no, and never calls resolve_email_from_username (which hands anyone the email behind a username).
// Before the function is deployed, sign-up skips the pre-check and relies on the database's unique
// index. Sign-in is untouched here (owner decision pending).
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sb = vi.hoisted(() => ({ rpc: vi.fn(), auth: { signInWithPassword: vi.fn(), signOut: vi.fn() } }));
vi.mock('../services/supabase', () => ({
  supabase: sb,
  getAuthPersistMode: () => 'local',
  setAuthPersistMode: vi.fn(),
  getAuthRedirectUrl: () => 'https://dreamstreamstudio.ai/auth/callback'
}));
const authEmail = vi.hoisted(() => ({ requestAuthEmail: vi.fn() }));
vi.mock('../services/authEmail', () => ({
  EMAIL_SERVICE_DOWN: 'email down',
  requestAuthEmail: authEmail.requestAuthEmail
}));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('./WaitlistForm', () => ({ WaitlistForm: () => null }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));

import { AuthPage } from './AuthPage';

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

const fillSignUp = (container: HTMLElement, username = 'Ada_L') => {
  fireEvent.change(screen.getByPlaceholderText('Super_hero'), { target: { value: `  ${username} ` } });
  fireEvent.change(screen.getByPlaceholderText('Super'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'Ada@Example.com' } });
  fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '1990-01-01' } });
  const [password, confirm] = screen.getAllByPlaceholderText('••••••••');
  fireEvent.change(password, { target: { value: 'correct-horse-battery' } });
  fireEvent.change(confirm, { target: { value: 'correct-horse-battery' } });
  const [terms] = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  fireEvent.click(terms);
};

const renderSignUp = () =>
  render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={() => undefined} onOpenTerms={() => undefined} pendingInviteCode="DS-ABCD-EFGH" />);

const submit = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Create Account/ }));
  await settle();
};

beforeEach(() => {
  sb.rpc.mockReset();
  authEmail.requestAuthEmail.mockReset();
  authEmail.requestAuthEmail.mockResolvedValue({ status: 'ok' });
});

describe('AuthPage — sign-up username availability', () => {
  it('asks username_available with the trimmed name, never the email resolver, and creates the account when free', async () => {
    sb.rpc.mockResolvedValue({ data: true, error: null });
    const { container } = renderSignUp();
    fillSignUp(container);
    await submit();
    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect(sb.rpc).toHaveBeenCalledWith('username_available', { p_username: 'Ada_L' });
    expect(sb.rpc.mock.calls.some(([fn]) => fn === 'resolve_email_from_username')).toBe(false);
    expect(authEmail.requestAuthEmail).toHaveBeenCalledWith('signup', expect.objectContaining({ email: 'ada@example.com', data: expect.objectContaining({ username: 'Ada_L' }) }));
    expect(screen.getByText('Account created! Please check your email to confirm.')).toBeTruthy();
  });

  it('a taken name stops before the account is created', async () => {
    sb.rpc.mockResolvedValue({ data: false, error: null });
    const { container } = renderSignUp();
    fillSignUp(container);
    await submit();
    expect(screen.getByText('Username is already taken. Please choose another.')).toBeTruthy();
    expect(authEmail.requestAuthEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['PostgREST', { code: 'PGRST202', message: 'Could not find the function public.username_available(p_username) in the schema cache' }],
    ['Postgres', { code: '42883', message: 'function public.username_available(text) does not exist' }]
  ])('before the function is deployed (%s says it is missing) sign-up goes ahead and the unique index decides', async (_who, error) => {
    sb.rpc.mockResolvedValue({ data: null, error });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { container } = renderSignUp();
    fillSignUp(container);
    await submit();
    expect(authEmail.requestAuthEmail).toHaveBeenCalledTimes(1);
    expect(sb.rpc.mock.calls.map(([fn]) => fn)).toEqual(['username_available']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relying on DB uniqueness'));
    warn.mockRestore();
  });

  it('the server’s uniqueness answer reaches the person when the pre-check could not run', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    authEmail.requestAuthEmail.mockResolvedValue({ status: 'error', code: 'database_error', message: 'Database error saving new user — that username may already be taken.' });
    const { container } = renderSignUp();
    fillSignUp(container);
    await submit();
    expect(screen.getByText('Database error saving new user — that username may already be taken.')).toBeTruthy();
  });

  it('any other failure is shown, not skipped', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const { container } = renderSignUp();
    fillSignUp(container);
    await submit();
    expect(screen.getByText('canceling statement due to statement timeout')).toBeTruthy();
    expect(authEmail.requestAuthEmail).not.toHaveBeenCalled();
  });
});
