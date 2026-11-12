// @vitest-environment jsdom
// The "Register interest" form (WaitlistForm, kind 'updates') and the request-access form it keeps
// for AuthPage (kind 'access'). Studios come from the shared list; the backend is faked at fetch.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({
  turnstileEnabled: () => false,
  buildApiUrl: (p: string) => p,
  API_BASE_URL: ''
}));

import { WaitlistForm } from './WaitlistForm';
import { STUDIO_INTERESTS } from '../services/studioInterests';

const fetchMock = vi.fn();
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });

const sentBody = (call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1].body)) as Record<string, unknown>;

const fill = (email = 'ada@example.com', studios: string[] = ['Atlas Studio', 'Comic Studio']) => {
  for (const name of studios) fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name) }));
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

describe('WaitlistForm — register interest', () => {
  it('offers one labelled checkbox per studio from the shared list, and no retired studio', () => {
    render(<WaitlistForm source="home-stay-updated" />);
    const group = screen.getByRole('group', { name: 'Which studios do you want to hear about?' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(STUDIO_INTERESTS.length);
    for (const s of STUDIO_INTERESTS) expect(within(group).getByRole('checkbox', { name: new RegExp(s.label) })).not.toBeChecked();
    expect(screen.queryByText(/Code Studio/)).toBeNull();
    expect(screen.queryByText(/Dashboards/)).toBeNull();
  });

  it('shows the consent text with a link to the privacy policy, in a new tab so the form survives', () => {
    render(<WaitlistForm />);
    const link = screen.getByRole('link', { name: /Privacy Policy/ });
    // The policy's section on these emails, at its canonical path.
    expect(link).toHaveAttribute('href', '/privacy#emails');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link).toHaveTextContent('opens in a new tab');
    expect(link.closest('p')).toHaveTextContent(/confirm your address/);
    // The confirmation email itself is essential mail with no unsubscribe link: only updates have one.
    expect(link.closest('p')).toHaveTextContent(/Every update has an unsubscribe link/);
    expect(link.closest('p')).not.toHaveTextContent(/Every email/);
  });

  it('asks for a studio before sending anything', async () => {
    render(<WaitlistForm />);
    fill('ada@example.com', []);
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one studio.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts email, canonical studios and source to /api/interest, then shows "check your inbox"', async () => {
    answer(200, { ok: true, status: 'pending', studios: ['comic_studio', 'atlas_studio'], message: 'Almost there! Check your inbox.' });
    const onJoined = vi.fn();
    render(<WaitlistForm source="home-stay-updated" buttonLabel="Keep me posted" onJoined={onJoined} />);
    fill(' Ada@Example.com ');
    fireEvent.click(screen.getByRole('button', { name: /Keep me posted/ }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/interest');
    expect(sentBody()).toEqual({ email: 'ada@example.com', studios: ['comic_studio', 'atlas_studio'], source: 'home-stay-updated' });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Check your inbox');
    expect(status).toHaveTextContent('Almost there!');
    expect(status).toHaveFocus();
    expect(onJoined).toHaveBeenCalledWith('ada@example.com');

    // "Wrong address?" brings the form back, picks kept, email cleared, focus on the field.
    fireEvent.click(screen.getByRole('button', { name: /Use a different email/ }));
    const field = screen.getByLabelText('Email address');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: /Atlas Studio/ })).toBeChecked();
  });

  it('has one success state, whatever the address: never "already subscribed"', async () => {
    answer(200, { ok: true, status: 'pending', studios: ['comic_studio'], message: 'Almost there.' });
    render(<WaitlistForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Check your inbox');
    expect(screen.queryByText(/on the list|already subscribed/i)).toBeNull();
  });

  it('keeps the form and shows the server message on a service error, without blaming the email', async () => {
    answer(503, { ok: false, code: 'email_unavailable', message: 'We couldn’t send the confirmation email right now.' });
    render(<WaitlistForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t send the confirmation email');
    const field = screen.getByLabelText('Email address');
    expect(field).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(screen.getAllByRole('checkbox')).toHaveLength(STUDIO_INTERESTS.length);
  });

  it('marks the email field invalid only for an invalid address', async () => {
    answer(400, { ok: false, code: 'invalid_email', message: 'That email doesn’t look right. Please check it.' });
    render(<WaitlistForm />);
    fill('ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.getByLabelText('Email address')).toHaveAttribute('aria-invalid', 'true');
    // Typing again clears it.
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.org' } });
    expect(screen.getByLabelText('Email address')).not.toHaveAttribute('aria-invalid');
  });

  it('reports a network failure honestly (no fake success)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<WaitlistForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/Network hiccup/);
  });

  it('hides the form after 503 interest_unavailable, for the rest of the session', async () => {
    answer(503, { ok: false, code: 'interest_unavailable', message: 'Registering interest isn’t available right now.' });
    const { unmount } = render(<WaitlistForm />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));
    await settle();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    const panel = screen.getByRole('status');
    // The routed support mailbox (contact@ has no route).
    expect(panel).toHaveTextContent('Registering interest isn’t available right now. Email support@dreamstreamstudio.ai and we’ll add you by hand.');
    expect(panel.textContent?.match(/support@dreamstreamstudio\.ai/g)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'support@dreamstreamstudio.ai' })).toHaveAttribute('href', 'mailto:support@dreamstreamstudio.ai');
    unmount();

    // A later mount (another page) stays hidden without asking the backend again — and without
    // stealing focus on load.
    render(<WaitlistForm />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('status')).not.toHaveFocus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pre-ticks defaultStudios', () => {
    render(<WaitlistForm defaultStudios={['stream_studio']} />);
    expect(screen.getByRole('checkbox', { name: /Stream Studio/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Comic Studio/ })).not.toBeChecked();
  });

  it.each([
    ['confirmed', /You’re confirmed/],
    ['invalid', /expired or was already used/],
    ['unsubscribed', /You’re unsubscribed/],
    ['unsub-invalid', /unsubscribe link didn’t work/]
  ])('explains the ?newsletter=%s landing from an email link and tidies the URL', (value, text) => {
    window.history.replaceState(null, '', `/?view=privacy&newsletter=${value}`);
    render(<WaitlistForm />);
    const banner = screen.getByText(text).closest('[role="status"]') as HTMLElement;
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveFocus();
    expect(window.location.search).toBe('?view=privacy');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(text)).toBeNull();
  });

  it('the landing banners promise an unsubscribe on updates only, name a routed mailbox, and say only the updates picks go', () => {
    window.history.replaceState(null, '', '/?newsletter=confirmed');
    const { unmount } = render(<WaitlistForm />);
    expect(screen.getByText(/You’re confirmed/)).toHaveTextContent('Every update has an unsubscribe link.');
    unmount();
    window.history.replaceState(null, '', '/?newsletter=unsub-invalid');
    const second = render(<WaitlistForm />);
    expect(screen.getByText(/unsubscribe link didn’t work/)).toHaveTextContent('or write to privacy@dreamstreamstudio.ai.');
    second.unmount();
    // Unsubscribing clears the picks of the updates row only; an early-access request keeps its own.
    window.history.replaceState(null, '', '/?newsletter=unsubscribed');
    render(<WaitlistForm />);
    expect(screen.getByText(/You’re unsubscribed/)).toHaveTextContent('the studio picks for your updates have been removed.');
  });
});

describe('WaitlistForm — request access (AuthPage)', () => {
  it('still posts to /api/newsletter/subscribe with the shared studio chips', async () => {
    answer(200, { ok: true, status: 'joined', alreadyJoined: false, message: 'Thanks! We’ll email you the moment access opens up.' });
    render(<WaitlistForm kind="access" source="auth-request-access" buttonLabel="Request access" />);
    expect(screen.getByText(/What do you want first access to/)).toBeInTheDocument();
    for (const s of STUDIO_INTERESTS) expect(screen.getByRole('button', { name: s.label })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/Code Studio/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Atlas Studio' }));
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Request access/ }));
    await settle();

    // Same-origin API (empty base) goes to the backend, not straight to the database.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/newsletter/subscribe');
    expect(sentBody()).toMatchObject({ email: 'ada@example.com', kind: 'access', source: 'auth-request-access', productInterests: ['atlas_studio'] });
    expect(screen.getByRole('status')).toHaveTextContent('access opens up');
  });

  it('shows the sign-in prompt for an existing account', async () => {
    answer(200, { ok: false, status: 'account-exists', message: 'You already have an account — sign in instead.' });
    const onSignIn = vi.fn();
    render(<WaitlistForm kind="access" onSignIn={onSignIn} />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Notify me/ }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalled();
  });
});
