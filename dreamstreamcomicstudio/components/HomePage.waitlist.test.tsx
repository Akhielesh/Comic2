// @vitest-environment jsdom
// The main home page (apex, signed out) after its Atlas conversion still carries the production sign-up form: the
// Stream Studio list block renders WaitlistForm itself (kind "updates", its own source tag and the button words from
// shared/interest.ts UPDATES_CARD), so the address a visitor leaves goes through the same submit as before. The page
// around it has no comic chrome.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.hoisted(() => vi.fn());
vi.mock('../services/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/waitlist')>()),
  submitWaitlistEmail: submit
}));
vi.mock('../services/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('./Turnstile', () => ({ Turnstile: () => null, resetTurnstile: vi.fn() }));
vi.mock('../services/clientConfig', () => ({ turnstileEnabled: () => false, buildApiUrl: (p: string) => p }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

import { HomePage } from './HomePage';
import { UPDATES_CARD } from '../shared/interest';

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => submit.mockReset());
afterEach(cleanup);

const renderHome = () =>
  render(<HomePage onEnterStudio={vi.fn()} onViewComics={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} onNavigate={vi.fn()} />);

describe('HomePage keeps the production sign-up form', () => {
  it('renders WaitlistForm with its own button and email field, and submits through it once', async () => {
    submit.mockResolvedValue({ ok: true, message: 'You are on the list.' });
    renderHome();
    const button = screen.getByRole('button', { name: UPDATES_CARD.button });
    const form = button.closest('form')!;
    expect(form).not.toBeNull();
    const email = within(form).getByLabelText(/^Email address/) as HTMLInputElement;
    expect(email).toHaveAttribute('type', 'email');
    fireEvent.change(email, { target: { value: 'reader@example.com' } });
    fireEvent.submit(form);
    await settle();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toBe('reader@example.com');
    expect(submit.mock.calls[0][1]).toBe('updates');
    expect(submit.mock.calls[0][2]).toEqual({ source: 'home-stay-updated' });
  });

  it('the page around it carries no comic chrome', () => {
    const { container } = renderHome();
    expect(container.innerHTML).not.toMatch(/border-black|shadow-comic|font-comic|(?<![\w-])font-display|brand-(?:yellow|blue|red|black)|#d97757/i);
  });
});
