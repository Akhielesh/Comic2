// @vitest-environment jsdom
// The waitlist form on an Atlas surface (the sign-in card's "Request access", qa scene `auth-access`). S2b built this
// as a separate `variant="atlas"` path; the Comics home release then put the WHOLE form on the page tokens (no variant
// left to choose), so these checks now hold the same promises on the one form every caller gets: no comic chrome
// reaches the DOM (the layout smoke's legacy-kit check), the note and the submit are DS primitives, the product chips
// are 44 px toggles under a coarse pointer, and the outcomes are calm status callouts that clear when the email is
// edited. WaitlistForm.test.tsx (the Comics home release's own file) covers the submit payload once more.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DENSITY } from './chat/studioDesign';

const waitlist = vi.hoisted(() => ({ submitWaitlistEmail: vi.fn() }));
vi.mock('../services/waitlist', () => ({ submitWaitlistEmail: waitlist.submitWaitlistEmail }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));

import { WaitlistForm } from './WaitlistForm';

// The layout smoke's legacy kit (tests/e2e/helpers/harness.ts legacyClasses) plus the raw hues it would flag for contrast.
const LEGACY = /border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red|black)|text-slate-|text-zinc-|text-red-|text-green-|border-2/;

beforeEach(() => waitlist.submitWaitlistEmail.mockReset());
afterEach(cleanup);

const emailField = () => screen.getByRole('textbox', { name: 'Email address' });
const fill = (email: string) => fireEvent.change(emailField(), { target: { value: email } });

describe('WaitlistForm on an Atlas surface (the sign-in card’s "Request access")', () => {
  it('renders the token field, the DS note and button with no comic chrome, every chip a 44 px toggle under a coarse pointer', () => {
    const { container } = render(<WaitlistForm kind="access" buttonLabel="Request access" />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    // The email is a real, required, named email field inside the token field group (44 px tall under a coarse pointer).
    expect(emailField()).toHaveAttribute('type', 'email');
    expect(emailField()).toBeRequired();
    for (const cls of DENSITY.coarse.split(' ')) expect(emailField().closest('label')!.className.split(/\s+/)).toContain(cls);
    expect(screen.getByLabelText(/Anything you'd want to see/)).toHaveAttribute('data-slot', 'textarea');
    const submit = screen.getByRole('button', { name: 'Request access' });
    expect(submit).toHaveAttribute('data-slot', 'button');
    expect(submit).toHaveAttribute('type', 'submit');
    const group = screen.getByRole('group', { name: /What do you want first access to\?/ });
    const chips = Array.from(group.querySelectorAll('button'));
    expect(chips.map((c) => c.textContent)).toEqual(['Comic Studio', 'Chat Studio', 'Code Studio', 'Stream Studio', 'Dashboards']);
    for (const chip of chips) {
      expect(chip).toHaveAttribute('aria-pressed', 'false');
      for (const cls of DENSITY.coarse.split(' ')) expect(chip.className.split(/\s+/)).toContain(cls);
    }
  });

  it('submits the email, the chosen products and the note, then shows the outcome as a status callout', async () => {
    waitlist.submitWaitlistEmail.mockResolvedValue({ ok: true, message: 'You’re on the list.' });
    const onJoined = vi.fn();
    render(<WaitlistForm kind="access" source="auth-request-access" buttonLabel="Request access" onJoined={onJoined} />);
    fill('Reader@Example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Comic Studio' }));
    expect(screen.getByRole('button', { name: 'Comic Studio' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByLabelText(/Anything you'd want to see/), { target: { value: '  page flips  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(await screen.findByRole('status')).toHaveTextContent('You’re on the list.');
    expect(waitlist.submitWaitlistEmail).toHaveBeenCalledWith('Reader@Example.com', 'access', { source: 'auth-request-access' }, undefined, {
      productInterests: ['comic_studio'],
      feedback: 'page flips'
    });
    expect(onJoined).toHaveBeenCalledWith('reader@example.com');
  });

  it('an existing account is pointed at sign-in, an error is an alert with its words, and editing the email clears it', async () => {
    const onSignIn = vi.fn();
    waitlist.submitWaitlistEmail.mockResolvedValueOnce({ ok: false, status: 'account-exists', message: 'You already have an account.' });
    render(<WaitlistForm kind="access" buttonLabel="Request access" onSignIn={onSignIn} />);
    fill('member@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(await screen.findByText('You already have an account.')).toBeInTheDocument();
    // The way to sign-in is a 44 px target under a coarse pointer, like the other small steps on the card.
    const signIn = screen.getByRole('button', { name: 'Sign in' });
    for (const cls of DENSITY.coarse.split(' ')) expect(signIn.className.split(/\s+/)).toContain(cls);
    fireEvent.click(signIn);
    expect(onSignIn).toHaveBeenCalledTimes(1);

    waitlist.submitWaitlistEmail.mockResolvedValueOnce({ ok: false, message: 'We couldn’t save that just now — please try again.' });
    fill('retry@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t save that just now — please try again.');
    fill('retry2@example.com');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the main site’s "Stay updated" form takes the same token look (the Comics home release: no legacy comic form is left)', () => {
    const { container } = render(<WaitlistForm kind="updates" buttonLabel="Keep me posted" />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(emailField()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep me posted' })).toHaveAttribute('data-slot', 'button');
  });
});
