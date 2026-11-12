// @vitest-environment jsdom
// The access request (the sign-in card's "Request access" step, one click off the comics landing) on the page tokens:
// a labelled email field, the ink submit, outline toggle chips, a calm callout per answer. The submit itself is
// unchanged: the email, the kind, the source, the chosen products and the note go to submitWaitlistEmail once.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.hoisted(() => vi.fn());
vi.mock('../services/waitlist', () => ({ submitWaitlistEmail: submit }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));

import { WaitlistForm } from './WaitlistForm';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => submit.mockReset());
afterEach(cleanup);

describe('WaitlistForm on the tokens', () => {
  it('no comic chrome: no black borders, yellow, comic face, mono or hex anywhere in its markup', () => {
    const { container } = render(<WaitlistForm kind="access" source="auth-request-access" buttonLabel="Request access" />);
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|font-mono|(?<![\w-])font-display|brand-(?:yellow|blue|red)|text-white|#[0-9a-f]{6}\b/i);
    expect(screen.getByRole('button', { name: /request access/i })).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('group', { name: /what do you want first access to/i })).toBeInTheDocument();
  });

  it('submits the email, the chosen products and the note once, then says so calmly', async () => {
    submit.mockResolvedValue({ ok: true, message: 'You are on the list.' });
    const onJoined = vi.fn();
    render(<WaitlistForm kind="access" source="auth-request-access" buttonLabel="Request access" onJoined={onJoined} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), { target: { value: 'Reader@Example.com' } });
    const chip = screen.getByRole('button', { name: 'Comic Studio' });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: /anything you'd want to see/i }), { target: { value: 'Manga looks' } });
    fireEvent.submit(screen.getByRole('button', { name: /request access/i }).closest('form')!);
    await settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('Reader@Example.com', 'access', { source: 'auth-request-access' }, undefined, {
      productInterests: ['comic_studio'],
      feedback: 'Manga looks'
    });
    expect(screen.getByRole('status')).toHaveTextContent('You are on the list.');
    expect(onJoined).toHaveBeenCalledWith('reader@example.com');
  });

  it('an existing account is pointed at sign-in; a failure reads as a calm alert with a word and an icon', async () => {
    submit.mockResolvedValueOnce({ ok: false, status: 'account-exists', message: 'You already have an account.' });
    const onSignIn = vi.fn();
    render(<WaitlistForm kind="access" onSignIn={onSignIn} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Email address' }).closest('form')!);
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('You already have an account.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);

    submit.mockResolvedValueOnce({ ok: false, status: 'error', message: 'Something went wrong. Try again.' });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Email address' }).closest('form')!);
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again.');
    expect(alert.querySelector('svg')).not.toBeNull();
  });
});
