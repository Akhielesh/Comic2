// @vitest-environment jsdom
// The home page's "Register interest" form on the ds primitives: the shared studio list, the consent text,
// and every outcome POST /api/interest can give (faked at fetch): pending (the only success), each error,
// the unavailable fallback, the confirm/unsubscribe landing, and where focus goes.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../../services/clientConfig', () => ({
  turnstileEnabled: () => false,
  buildApiUrl: (p: string) => p,
  API_BASE_URL: ''
}));

import { RegisterInterestForm } from './RegisterInterestForm';
import { STUDIO_INTERESTS } from '../../services/studioInterests';

const fetchMock = vi.fn();
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;

const pick = (...names: string[]) => {
  for (const name of names) fireEvent.click(screen.getByRole('checkbox', { name }));
};
const typeEmail = (value: string) => fireEvent.change(screen.getByLabelText('Email address'), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /Register interest/ }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RegisterInterestForm', () => {
  it('offers one checkbox per studio from the shared list, each named by the studio and described by its line', () => {
    render(<RegisterInterestForm />);
    const group = screen.getByRole('group', { name: 'Which studios do you want to hear about?' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes).toHaveLength(STUDIO_INTERESTS.length);
    for (const s of STUDIO_INTERESTS) {
      const box = within(group).getByRole('checkbox', { name: s.label });
      expect(box).not.toBeChecked();
      expect(box).toHaveAccessibleDescription(s.blurb);
    }
    expect(screen.queryByText(/Code Studio/)).toBeNull();
  });

  it('makes the whole studio card the checkbox’s label', () => {
    render(<RegisterInterestForm />);
    fireEvent.click(screen.getByText(STUDIO_INTERESTS[1].blurb));
    expect(screen.getByRole('checkbox', { name: STUDIO_INTERESTS[1].label })).toBeChecked();
  });

  it('shows the consent text with the privacy policy in a new tab', () => {
    render(<RegisterInterestForm />);
    const link = screen.getByRole('link', { name: /Privacy Policy/ });
    expect(link).toHaveAttribute('href', '/?view=privacy');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.closest('p')).toHaveTextContent(/confirm your address/);
    expect(link.closest('p')).toHaveTextContent(/one-click unsubscribe/);
    expect(link.closest('p')).toHaveTextContent(/never sell your address/);
  });

  it('asks for a studio before sending anything, and marks the picks invalid', async () => {
    render(<RegisterInterestForm />);
    typeEmail('ada@example.com');
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one studio.');
    expect(screen.getAllByRole('checkbox')[0]).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
    // Picking one clears the error.
    pick('Comic Studio');
    expect(screen.getAllByRole('checkbox')[0]).not.toHaveAttribute('aria-invalid');
  });

  it('posts email, canonical studios and the source, then shows "check your inbox" and focuses it', async () => {
    answer(200, { ok: true, status: 'pending', studios: ['comic_studio', 'atlas_studio'], message: 'Almost there! Check your inbox.' });
    const onJoined = vi.fn();
    render(<RegisterInterestForm onJoined={onJoined} />);
    pick('Atlas Studio', 'Comic Studio');
    typeEmail(' Ada@Example.com ');
    submit();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/interest');
    expect(sentBody()).toEqual({ email: 'ada@example.com', studios: ['comic_studio', 'atlas_studio'], source: 'home-register-interest' });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Check your inbox');
    expect(status).toHaveTextContent('Almost there! Check your inbox.');
    expect(document.activeElement).toBe(status);
    expect(onJoined).toHaveBeenCalledWith('ada@example.com');
    // Never "already subscribed": the page cannot tell, and does not claim to.
    expect(screen.queryByText(/already/i)).toBeNull();
  });

  it('goes back to an empty email field, focused, from "Use a different email"', async () => {
    answer(200, { ok: true, status: 'pending', message: 'Check your inbox.' });
    render(<RegisterInterestForm defaultStudios={['stream_studio']} />);
    typeEmail('ada@example.com');
    submit();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Use a different email/ }));
    await settle();
    const email = screen.getByLabelText('Email address');
    expect(email).toHaveValue('');
    expect(document.activeElement).toBe(email);
    expect(screen.getByRole('checkbox', { name: 'Stream Studio' })).toBeChecked();
  });

  it('marks only the email invalid for an invalid address, and says why', async () => {
    answer(400, { ok: false, code: 'invalid_email', message: 'That email doesn’t look right.' });
    render(<RegisterInterestForm defaultStudios={['chat_studio']} />);
    typeEmail('ada@example');
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('That email doesn’t look right');
    const email = screen.getByLabelText('Email address');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
  });

  it('reports a rate limit and a network failure honestly, without marking the email', async () => {
    answer(429, { error: { code: 'RATE_LIMITED' } });
    render(<RegisterInterestForm defaultStudios={['chat_studio']} />);
    typeEmail('ada@example.com');
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/Too many attempts/);
    expect(screen.getByLabelText('Email address')).not.toHaveAttribute('aria-invalid');

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    submit();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/Network hiccup/);
  });

  it('says so and offers the address to write to when registrations are unavailable, for the rest of the session', async () => {
    answer(503, { ok: false, code: 'interest_unavailable', message: 'Not available.' });
    const { unmount } = render(<RegisterInterestForm defaultStudios={['comic_studio']} />);
    typeEmail('ada@example.com');
    submit();
    await settle();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('isn’t available right now');
    expect(within(status).getByRole('link', { name: 'contact@dreamstreamstudio.ai' })).toHaveAttribute('href', 'mailto:contact@dreamstreamstudio.ai');
    unmount();
    render(<RegisterInterestForm />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('isn’t available right now');
  });

  it('shows the busy state while sending and ignores a second press', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<RegisterInterestForm defaultStudios={['comic_studio']} />);
    typeEmail('ada@example.com');
    submit();
    await settle();
    const button = screen.getByRole('button', { name: /Sending/ });
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve({ ok: true, status: 200, json: async () => ({ ok: true, status: 'pending', message: 'Check your inbox.' }) });
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Check your inbox');
  });

  it('greets a visitor arriving from a confirmation link, once, and drops the parameter', async () => {
    window.history.replaceState(null, '', '/?newsletter=confirmed');
    render(<RegisterInterestForm />);
    await settle();
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('You’re confirmed');
    expect(document.activeElement).toBe(banner);
    expect(window.location.search).toBe('');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/You’re confirmed/)).toBeNull();
    // The form itself is still there.
    expect(screen.getAllByRole('checkbox')).toHaveLength(STUDIO_INTERESTS.length);
  });

  it('explains an expired confirmation link', () => {
    window.history.replaceState(null, '', '/?newsletter=invalid');
    render(<RegisterInterestForm />);
    expect(screen.getByRole('status')).toHaveTextContent(/expired or was already used/);
  });
});
