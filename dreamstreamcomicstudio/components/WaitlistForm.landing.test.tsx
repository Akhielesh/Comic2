// @vitest-environment jsdom
// The options a page about one product gives the shared form (the comics landing's "Register your interest"):
// fixed products (no chips, no question, the products still sent), the page's own words for every accepted answer, and
// a bot check that mounts only once the visitor uses the form, in the theme the page asks for. Without the options the
// form is unchanged (WaitlistForm.test.tsx, WaitlistForm.atlas.test.tsx).
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.hoisted(() => vi.fn());
const build = vi.hoisted(() => ({ turnstile: false }));
vi.mock('../services/waitlist', () => ({ submitWaitlistEmail: submit }));
vi.mock('./Turnstile', () => ({
  Turnstile: ({ theme }: { theme?: string }) => <div data-testid="bot-check" data-theme={theme ?? ''} />,
  resetTurnstile: vi.fn()
}));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => build.turnstile, buildApiUrl: (p: string) => p }));

import { WaitlistForm } from './WaitlistForm';

beforeEach(() => {
  submit.mockReset();
  build.turnstile = false;
});
afterEach(cleanup);

const email = () => screen.getByRole('textbox', { name: 'Email address' });
const send = async (address = 'reader@example.com') => {
  fireEvent.change(email(), { target: { value: address } });
  await act(async () => {
    fireEvent.submit(email().closest('form')!);
  });
};

describe('WaitlistForm on a one-product page', () => {
  it('fixed products: no chips and no question, and the products go with the signup', async () => {
    submit.mockResolvedValue({ ok: true, message: 'x' });
    render(<WaitlistForm kind="access" source="landing" products={['comic_studio']} />);
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.body.textContent).not.toMatch(/first access|Chat Studio|Code Studio/);
    await send();
    expect(submit).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'landing' }, undefined, { productInterests: ['comic_studio'], feedback: undefined });
  });

  it.each([
    { ok: true, message: 'Thanks! We’ll email you the moment access opens up.' },
    { ok: true, alreadyJoined: true, status: 'already-registered', message: 'You’re already on the list.' },
    { ok: true, alreadyJoined: true, message: "You're already on the list — sit tight, we'll be in touch." }
  ])('the page’s own words replace every accepted answer ($message)', async (answer) => {
    submit.mockResolvedValue(answer);
    const onJoined = vi.fn();
    render(<WaitlistForm kind="access" successMessage="Recorded." onJoined={onJoined} />);
    await send();
    expect(screen.getByRole('status')).toHaveTextContent(/^Recorded\.$/);
    expect(onJoined).toHaveBeenCalledWith('reader@example.com');
  });

  it('a refusal still says the backend’s words (the page’s words are for accepted answers only)', async () => {
    submit.mockResolvedValue({ ok: false, message: 'That email doesn’t look right — please check it.' });
    render(<WaitlistForm kind="access" successMessage="Recorded." />);
    await send();
    expect(screen.getByRole('alert')).toHaveTextContent('That email doesn’t look right');
  });

  it('deferred bot check: nothing mounts until the visitor focuses the form, then it mounts in the asked theme', () => {
    build.turnstile = true;
    render(<WaitlistForm kind="access" deferVerification verificationTheme="dark" />);
    expect(screen.queryByTestId('bot-check')).toBeNull();
    fireEvent.focusIn(email());
    expect(screen.getByTestId('bot-check')).toHaveAttribute('data-theme', 'dark');
  });

  it('deferred bot check: a send without a token mounts it and asks for it, sending nothing', async () => {
    build.turnstile = true;
    render(<WaitlistForm kind="access" deferVerification />);
    fireEvent.change(email(), { target: { value: 'reader@example.com' } });
    await act(async () => {
      fireEvent.submit(email().closest('form')!);
    });
    expect(screen.getByTestId('bot-check')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/verification/i);
    expect(submit).not.toHaveBeenCalled();
  });

  it('without the option the bot check mounts with the form, as before', () => {
    build.turnstile = true;
    render(<WaitlistForm kind="access" />);
    expect(screen.getByTestId('bot-check')).toHaveAttribute('data-theme', '');
  });
});
