// @vitest-environment jsdom
// The interest form on an Atlas surface (the sign-in card's "Register interest", qa scene `auth-access`): no comic
// chrome or orange reaches the DOM (the layout smoke's legacy-kit check), every field is a ds primitive inside a
// labelled Field, each checklist row is a 44 px target under a coarse pointer, and an error is an alert that clears
// when the email is edited. WaitlistForm.test.tsx covers the questions, the payload and the thank-you.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DENSITY } from './chat/studioDesign';

const waitlist = vi.hoisted(() => ({ submitWaitlistEmail: vi.fn() }));
vi.mock('../services/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/waitlist')>()),
  submitWaitlistEmail: waitlist.submitWaitlistEmail
}));
vi.mock('../services/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p, API_BASE_URL: '' }));

import { WaitlistForm } from './WaitlistForm';

// The layout smoke's legacy kit (tests/e2e/helpers/harness.ts legacyClasses) plus the raw hues it would flag for contrast.
const LEGACY = /border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red|black)|text-slate-|text-zinc-|text-red-|text-green-|border-2/;

beforeEach(() => waitlist.submitWaitlistEmail.mockReset());
afterEach(cleanup);

const emailField = () => screen.getByRole('textbox', { name: /Email address/ });
const fill = (email: string) => fireEvent.change(emailField(), { target: { value: email } });

describe('WaitlistForm on an Atlas surface (the sign-in card’s "Register interest")', () => {
  it('ds fields and button, no comic chrome or orange, every checklist row a 44 px target under a coarse pointer', () => {
    const { container } = render(<WaitlistForm kind="access" />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(container.innerHTML).not.toMatch(/orange|amber|hue-3|#[0-9a-f]{6}\b/i);
    expect(emailField()).toHaveAttribute('type', 'email');
    expect(emailField()).toBeRequired();
    for (const field of container.querySelectorAll('input:not([type="checkbox"]), textarea')) {
      expect(field.closest('[data-slot="field"]')).not.toBeNull();
    }
    expect(screen.getByRole('textbox', { name: /Anything you would like/ })).toHaveAttribute('data-slot', 'textarea');
    const submit = screen.getByRole('button', { name: 'Register interest' });
    expect(submit).toHaveAttribute('data-slot', 'button');
    const rows = [
      ...screen.getByRole('group', { name: /What would you use/ }).querySelectorAll('[data-slot="checkbox-row"]'),
      ...screen.getByRole('group', { name: /Other studios/ }).querySelectorAll('[data-slot="checkbox-row"]')
    ];
    expect(rows).toHaveLength(8);
    for (const row of rows) for (const cls of DENSITY.coarse.split(' ')) expect(row.className.split(/\s+/)).toContain(cls);
  });

  it('an error is an alert with its words, and editing the email clears it', async () => {
    waitlist.submitWaitlistEmail.mockResolvedValueOnce({ ok: false, status: 'rate-limited', message: 'Too many tries from this connection.' });
    render(<WaitlistForm kind="access" />);
    fill('retry@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Register interest' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many tries from this connection.');
    fill('retry2@example.com');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the main site’s list form takes the same token look', () => {
    const { container } = render(<WaitlistForm kind="updates" buttonLabel="Add me to the list" />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    // One field named for assistive tech (no visible label, so it suits a page's own fixed card) and the ds button.
    expect(emailField()).toBeRequired();
    expect(emailField().closest('[data-slot="field"]')?.querySelector('label')).toHaveClass('sr-only');
    expect(screen.getByRole('button', { name: 'Add me to the list' })).toHaveAttribute('data-slot', 'button');
  });
});
