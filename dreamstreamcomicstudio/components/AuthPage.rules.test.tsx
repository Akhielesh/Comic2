// @vitest-environment jsdom
// The Atlas restyle of the sign-in page keeps every rule it enforced (username format and availability,
// terms, minimum age, password length and match, verified email, Turnstile, the backend mailer for every
// email) and adds field-level errors, live regions, IME-safe Enter, a show / hide toggle and the
// header's "Request access" reaching an already-open page.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signOut: vi.fn() }));
const rpc = vi.hoisted(() => vi.fn());
const persist = vi.hoisted(() => ({ set: vi.fn() }));
const mail = vi.hoisted(() => ({ request: vi.fn() }));
const captcha = vi.hoisted(() => ({ enabled: false, reset: vi.fn(), lastAction: '' as string | undefined }));

vi.mock('../services/supabase', () => ({
  supabase: { auth, rpc },
  getAuthPersistMode: () => 'local',
  setAuthPersistMode: persist.set,
  getAuthRedirectUrl: () => 'https://dreamstreamstudio.ai/auth/callback'
}));
vi.mock('../services/authEmail', () => ({
  EMAIL_SERVICE_DOWN: 'We couldn’t reach our email service just now — please try again in a minute.',
  requestAuthEmail: mail.request
}));
vi.mock('./Turnstile', () => ({
  Turnstile: ({ action }: { action?: string }) => {
    captcha.lastAction = action;
    return <div data-testid="turnstile" data-action={action} />;
  },
  resetTurnstile: captcha.reset
}));
vi.mock('./WaitlistForm', () => ({
  WaitlistForm: ({ kind, source }: { kind?: string; source?: string }) => <div data-testid="waitlist" data-kind={kind} data-source={source} />
}));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => captcha.enabled, buildApiUrl: (p: string) => p }));

import { AuthPage, MIN_SIGNUP_AGE_YEARS, isImeEnter } from './AuthPage';
import { FONT_DISPLAY } from './chat/studioDesign';

const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const noop = () => undefined;

const renderPage = (props: Partial<React.ComponentProps<typeof AuthPage>> = {}) =>
  render(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={noop} onOpenTerms={noop} {...props} />);

const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

const isoDaysAgo = (years: number, extraDays = 0) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setDate(d.getDate() + extraDays);
  return d.toISOString().slice(0, 10);
};

/** Fill a valid sign-up form (with an invite, the only way sign-up is open today). */
const fillSignup = (overrides: Partial<Record<'email' | 'username' | 'first' | 'password' | 'confirm' | 'dob', string>> = {}) => {
  type(/^Email/, overrides.email ?? 'Ada@Example.com');
  type(/^Username/, overrides.username ?? 'ada_lovelace');
  type(/^First name/, overrides.first ?? 'Ada');
  type(/^Password/, overrides.password ?? 'correct-horse');
  type(/^Confirm password/, overrides.confirm ?? overrides.password ?? 'correct-horse');
  type(/^Date of birth/, overrides.dob ?? isoDaysAgo(30));
};
const acceptTerms = () => fireEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms and Conditions/ }));

beforeEach(() => {
  auth.signInWithPassword.mockReset();
  auth.signOut.mockReset();
  rpc.mockReset();
  persist.set.mockReset();
  mail.request.mockReset();
  captcha.enabled = false;
  captcha.reset.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe('AuthPage — sign-up rules (invite in hand)', () => {
  it('refuses a bad username, a short or mismatched password, missing terms and a too-young date of birth, each on its field', async () => {
    renderPage({ pendingInviteCode: 'INV-42' });
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByText('INV-42')).toBeInTheDocument();

    const cases: Array<[Parameters<typeof fillSignup>[0], RegExp | string, string, boolean?]> = [
      [{ email: 'not-an-email' }, /^Email/, 'Please enter a valid email.'],
      [{ username: 'ab' }, /^Username/, 'Username must be 3-20 chars and use only letters, numbers, or underscore.'],
      [{ username: 'bad name!' }, /^Username/, 'Username must be 3-20 chars and use only letters, numbers, or underscore.'],
      [{ first: '  ' }, /^First name/, 'First name is required.'],
      [{ password: 'short' }, /^Password/, 'Password must be at least 8 characters.'],
      [{ password: 'correct-horse', confirm: 'correct-horsf' }, /^Confirm password/, 'Passwords do not match.'],
      [{}, /I accept the Terms/, 'You must accept the Terms & Conditions.', true],
      [{ dob: isoDaysAgo(MIN_SIGNUP_AGE_YEARS, 1) }, /^Date of birth/, `You must be at least ${MIN_SIGNUP_AGE_YEARS} years old to sign up.`],
      [{ dob: isoDaysAgo(-1) }, /^Date of birth/, 'Date of birth cannot be in the future.']
    ];
    for (const [overrides, label, text, skipTerms] of cases) {
      fillSignup(overrides);
      const terms = screen.getByRole('checkbox', { name: /I accept the Terms/ }) as HTMLInputElement;
      if (!skipTerms && !terms.checked) acceptTerms();
      if (skipTerms && terms.checked) acceptTerms();
      submit('Create account');
      await settle();
      const field = screen.getByLabelText(label);
      expect(field, text).toHaveAttribute('aria-invalid', 'true');
      expect(field, text).toHaveAccessibleDescription(expect.stringContaining(text));
      expect(field, text).toHaveFocus();
      expect(rpc).not.toHaveBeenCalled();
      expect(mail.request).not.toHaveBeenCalled();
    }
  });

  it('a taken username is refused before any account is made; a free one signs up through our backend with the same metadata', async () => {
    renderPage({ pendingInviteCode: 'INV-42' });
    fillSignup();
    acceptTerms();
    rpc.mockResolvedValueOnce({ data: [{ email: 'someone@example.com' }], error: null });
    submit('Create account');
    await settle();
    expect(rpc).toHaveBeenCalledWith('resolve_email_from_username', { login_username: 'ada_lovelace' });
    expect(screen.getByLabelText(/^Username/)).toHaveAccessibleDescription(expect.stringContaining('Username is already taken. Please choose another.'));
    expect(mail.request).not.toHaveBeenCalled();

    type(/^Username/, 'ada_free');
    fireEvent.click(screen.getByRole('checkbox', { name: /marketing emails/ }));
    rpc.mockResolvedValueOnce({ data: [], error: null });
    mail.request.mockResolvedValueOnce({ status: 'ok' });
    submit('Create account');
    await settle();
    expect(mail.request).toHaveBeenCalledWith('signup', {
      app: 'main',
      email: 'ada@example.com',
      password: 'correct-horse',
      captchaToken: undefined,
      data: {
        username: 'ada_free',
        first_name: 'Ada',
        last_name: null,
        phone_number: null,
        dob: isoDaysAgo(30),
        terms_accepted: true,
        marketing_consent: true,
        email_pref_product_updates: true,
        email_pref_marketing: true
      }
    });
    // Back on sign-in, the result announced politely.
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="auth-status"]')).toHaveTextContent('Account created! Please check your email to confirm.');
  });

  it('without an invite there is no sign-up form: the second segment is Request access (the invite-only waitlist)', () => {
    renderPage();
    const group = screen.getByRole('radiogroup', { name: 'Account' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Request access' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Request access' })).toBeInTheDocument();
    expect(screen.getByTestId('waitlist')).toHaveAttribute('data-kind', 'access');
    expect(screen.getByTestId('waitlist')).toHaveAttribute('data-source', 'auth-request-access');
    expect(screen.queryByLabelText(/^Username/)).toBeNull();
  });

  it('the consent links open the legal pages in a new tab, so a half-filled form survives', () => {
    renderPage({ pendingInviteCode: 'INV-42' });
    const terms = screen.getByRole('link', { name: /Terms and Conditions/ });
    const privacy = screen.getByRole('link', { name: /Privacy Policy/ });
    expect(terms).toHaveAttribute('href', '/?view=terms');
    expect(privacy).toHaveAttribute('href', '/?view=privacy');
    for (const a of [terms, privacy]) expect(a).toHaveAttribute('target', '_blank');
  });
});

describe('AuthPage — sign-in', () => {
  it('a username resolves to its email first; an unconfirmed email offers the resend, which goes through our backend', async () => {
    renderPage();
    type(/Email or username/, 'ada_lovelace');
    type(/^Password/, 'correct-horse');
    rpc.mockResolvedValueOnce({ data: [{ email: 'ada@example.com' }], error: null });
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Email not confirmed' } });
    submit('Sign in');
    await settle();
    expect(rpc).toHaveBeenCalledWith('resolve_email_from_username', { login_username: 'ada_lovelace' });
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct-horse', options: { captchaToken: undefined } });
    expect(persist.set).toHaveBeenCalledWith('local');
    expect(document.querySelector('[data-slot="auth-alert"]')).toHaveTextContent('Verify your email first. Use the resend button below if needed.');
    expect(screen.getByText(/Email not verified for/)).toHaveTextContent('ada@example.com');

    mail.request.mockResolvedValueOnce({ status: 'ok' });
    submit('Resend verification email');
    await settle();
    expect(mail.request).toHaveBeenCalledWith('resend', { email: 'ada@example.com', app: 'main', captchaToken: undefined });
    expect(document.querySelector('[data-slot="auth-status"]')).toHaveTextContent('Verification email sent. Check inbox and spam.');
  });

  it('a signed-in user without a confirmed email is signed out locally and never let in', async () => {
    const onLoginSuccess = vi.fn();
    renderPage({ onLoginSuccess });
    type(/Email or username/, 'Ada@Example.com');
    type(/^Password/, 'correct-horse');
    auth.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: 'u', email_confirmed_at: null } }, error: null });
    submit('Sign in');
    await settle();
    expect(auth.signInWithPassword).toHaveBeenCalledWith(expect.objectContaining({ email: 'ada@example.com' }));
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('empty fields are marked on the field (no browser bubble: the form validates in script), and Remember me off keeps the session to the tab', async () => {
    renderPage();
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    expect(form).toHaveAttribute('novalidate');
    submit('Sign in');
    await settle();
    expect(screen.getByLabelText(/Email or username/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/Email or username/)).toHaveFocus();
    // Typing clears the field's own message.
    type(/Email or username/, 'ada@example.com');
    expect(screen.getByLabelText(/Email or username/)).not.toHaveAttribute('aria-invalid');
    submit('Sign in');
    await settle();
    expect(screen.getByLabelText(/^Password/)).toHaveAccessibleDescription(expect.stringContaining('Enter your password.'));
    expect(auth.signInWithPassword).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    type(/^Password/, 'correct-horse');
    auth.signInWithPassword.mockResolvedValueOnce({ data: {}, error: { message: 'Invalid login credentials' } });
    submit('Sign in');
    await settle();
    expect(persist.set).toHaveBeenLastCalledWith('session');
    expect(document.querySelector('[data-slot="auth-alert"]')).toHaveTextContent('Invalid credentials. If this account is new, verify your email first.');
  });

  it('a second submit while one is running is ignored', async () => {
    renderPage();
    type(/Email or username/, 'ada@example.com');
    type(/^Password/, 'correct-horse');
    let release: (v: unknown) => void = () => undefined;
    auth.signInWithPassword.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const form = screen.getByRole('button', { name: 'Sign in' }).closest('form')!;
    fireEvent.submit(form);
    await settle();
    expect(screen.getByRole('button', { name: /Signing in/ })).toHaveAttribute('aria-busy', 'true');
    fireEvent.submit(form);
    await settle();
    expect(auth.signInWithPassword).toHaveBeenCalledOnce();
    await act(async () => release({ data: { user: { id: 'u', email_confirmed_at: '2026-01-01' } }, error: null }));
    await settle();
  });

  it('show password: one named toggle with aria-pressed, controlling the field', () => {
    renderPage();
    const input = screen.getByLabelText(/^Password/) as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(input.type).toBe('password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', input.id);
    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('AuthPage — email links', () => {
  it('the sign-in link path and the reset path ask our backend, with the right kind, and land back on sign-in', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const title = screen.getByRole('heading', { level: 1, name: 'Get a sign-in link' });
    expect(title).toHaveFocus(); // the pressed button is gone; focus lands on the new title
    type(/^Email/, 'nope');
    submit('Send sign-in link');
    await settle();
    expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(expect.stringContaining('Enter a valid email to receive a magic link.'));
    type(/^Email/, 'Ada@Example.com');
    mail.request.mockResolvedValueOnce({ status: 'ok' });
    submit('Send sign-in link');
    await settle();
    expect(persist.set).toHaveBeenCalledWith('local');
    expect(mail.request).toHaveBeenLastCalledWith('magiclink', { email: 'ada@example.com', app: 'main', captchaToken: undefined });
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="auth-status"]')).toHaveTextContent('Magic link sent! Check your email to continue.');

    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Reset your password' })).toHaveFocus();
    mail.request.mockResolvedValueOnce({ status: 'unreachable' });
    submit('Send reset link');
    await settle();
    expect(mail.request).toHaveBeenLastCalledWith('recovery', { email: 'ada@example.com', app: 'main', captchaToken: undefined });
    // Never falls back to Supabase's own mailer: an unreachable backend is an error.
    expect(document.querySelector('[data-slot="auth-alert"]')).toHaveTextContent('We couldn’t reach our email service');
  });
});

describe('AuthPage — Turnstile', () => {
  it('stays where it was: in the form, before the submit, named by the mode, required before anything is sent, reset after each attempt', async () => {
    captcha.enabled = true;
    renderPage();
    const widget = screen.getByTestId('turnstile');
    expect(widget).toHaveAttribute('data-action', 'signin');
    const submitButton = screen.getByRole('button', { name: 'Sign in' });
    expect(widget.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    type(/Email or username/, 'ada@example.com');
    type(/^Password/, 'correct-horse');
    submit('Sign in');
    await settle();
    expect(document.querySelector('[data-slot="auth-alert"]')).toHaveTextContent('Please complete the verification challenge.');
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(captcha.reset).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByTestId('turnstile')).toHaveAttribute('data-action', 'forgot');
  });
});

describe('AuthPage — keyboard and page', () => {
  it('Enter that commits an IME composition never submits; a plain Enter is left alone', () => {
    renderPage();
    const field = screen.getByLabelText(/Email or username/);
    expect(fireEvent.keyDown(field, { key: 'Enter', isComposing: true })).toBe(false); // default prevented
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })).toBe(false); // Safari: composition already ended
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })).toBe(true);
    expect(isImeEnter({ key: 'a', isComposing: true })).toBe(false);
  });

  it('the header’s Request access reaches the page while it is already open', () => {
    const { rerender } = renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    rerender(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={noop} onOpenTerms={noop} initialMode="request-access" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Request access' })).toBeInTheDocument();
    rerender(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={noop} onOpenTerms={noop} initialMode="signin" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('an invite captured after the page opened switches an untouched sign-in to sign-up; a half-typed sign-in stays', () => {
    const { rerender, unmount } = renderPage();
    rerender(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={noop} onOpenTerms={noop} pendingInviteCode="INV-7" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Create your account' })).toBeInTheDocument();
    expect(screen.getByText('INV-7')).toBeInTheDocument();
    unmount();
    const second = renderPage();
    type(/Email or username/, 'ada@example.com');
    second.rerender(<AuthPage onLoginSuccess={vi.fn()} onOpenPrivacy={noop} onOpenTerms={noop} pendingInviteCode="INV-7" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Create account' })).toBeInTheDocument();
  });

  it('only the page title carries the display face; the footer says DreamStream Studio, never "Inc."', () => {
    const { container } = renderPage();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className.split(/\s+/)).toContain(FONT_DISPLAY);
    expect(container.querySelectorAll(`.${FONT_DISPLAY}`)).toHaveLength(1);
    expect(container).toHaveTextContent(`© ${new Date().getFullYear()} DreamStream Studio`);
    expect(container.textContent).not.toMatch(/Inc\./);
    // No comic chrome in the rendered page.
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|brand-(yellow|blue)|(?<![\w-])font-display(?![\w-])/);
  });
});
