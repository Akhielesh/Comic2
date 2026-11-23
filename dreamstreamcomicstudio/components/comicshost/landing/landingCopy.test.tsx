// @vitest-environment jsdom
// The landing says only what landingCopy.ts and the registries say: every line of the hero and the sections below it
// is on the page, filled from the registries (no brace left), and the page never uses words it must not: a price or an
// amount, "free forever", promises of an email, a reply, early access or a date, or plans; not before the interest
// form is sent and not after. The register section is the app's own interest form (components/WaitlistForm.tsx, kind
// "access"), the one the sign-in card's Register interest tab shows, with its own questions and thank-you.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const waitlist = vi.hoisted(() => ({ submitWaitlistEmail: vi.fn() }));
/** Whether this build "has" a bot-check site key (off unless a test turns it on). */
const build = vi.hoisted(() => ({ turnstile: false }));
vi.mock('../../../services/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/waitlist')>()),
  submitWaitlistEmail: waitlist.submitWaitlistEmail
}));
vi.mock('../../../services/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../../services/clientConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/clientConfig')>()),
  TURNSTILE_SITE_KEY: 'test-site-key',
  turnstileEnabled: () => build.turnstile
}));

import { ComicsLanding } from '../ComicsLanding';
import { FAQ, FEATURES, HERO, HOW, MODELS, PRICING, fill } from './landingCopy';
import { INTEREST_HEARD_QUESTION, INTEREST_MAKES_QUESTION, INTEREST_THANKS, INTEREST_UPDATES } from '../../../shared/interest';
import { DEFAULT_MODEL, LANDING_VALUES, OTHER_MODELS } from './landingModels';

beforeEach(() => {
  waitlist.submitWaitlistEmail.mockReset();
  build.turnstile = false;
});
afterEach(() => {
  cleanup();
  for (const s of document.querySelectorAll('script[src]')) s.remove();
  delete (window as { __dsTurnstileLoading?: unknown }).__dsTurnstileLoading;
});

const renderLanding = (signedIn = false) =>
  render(
    <ComicsLanding signedIn={signedIn} onSignIn={vi.fn()} onRequestAccess={vi.fn()} onOpenComics={vi.fn()} onBrowseGallery={vi.fn()} onOpenPrivacy={vi.fn()} onOpenTerms={vi.fn()} />
  );
const openFeedback = () => {
  const details = screen.getByText('Tell us what you’d like to make').closest('details')!;
  act(() => {
    details.open = true;
    fireEvent(details, new Event('toggle'));
  });
};
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Words the page must never use. */
const BANNED = [
  /[$¢€£₹]/,
  /\bfree forever\b/i,
  /\bfree (?:plan|tier|trial)\b/i,
  /\bper (?:month|year|page|comic)\b/i,
  /\bearly access\b/i,
  /\bfirst access\b/i,
  /\bwe(?:’|')?ll (?:email|reply|be in touch|contact|let you know|get back)\b/i,
  /\bwe will (?:email|reply|contact)\b/i,
  /\b(?:pro|creator|studio) plan\b/i,
  /\bpaid plans?\b/i,
  /\bunlimited\b/i,
  /\bguarantee/i,
  /\bcoming soon\b/i
];

describe('landing copy', () => {
  it('every line below the hero is on the page, filled from the registries', () => {
    const { container } = renderLanding();
    const text = squash(container.textContent || '');
    const lines = [
      HERO.lead,
      ...FEATURES.flatMap((f) => [f.title, ...f.lines]),
      ...HOW.steps.flatMap((s) => [s.title, s.body]),
      ...MODELS.items.flatMap((m) => [m.title, m.body]),
      MODELS.note,
      ...PRICING.lines,
      ...FAQ.map((f) => f.q)
    ];
    for (const line of lines) expect(text, line).toContain(squash(fill(line, LANDING_VALUES)));
    expect(text).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('explains provider billing and studio limits before signup', () => {
    renderLanding();
    const pricing = document.getElementById('pricing')!;
    expect(pricing).toHaveTextContent(/provider bills usage on your key/);
    expect(pricing).toHaveTextContent(/studio usage limits/i);
    expect(pricing).not.toHaveTextContent(/invite.only|not open/);
  });

  it('names the image models as members see them and says the line-up can change', () => {
    renderLanding();
    const models = document.getElementById('models') as HTMLElement;
    const text = squash(models.textContent || '');
    expect(text).toContain(DEFAULT_MODEL.name);
    for (const name of OTHER_MODELS) expect(text).toContain(name);
    expect(text).toMatch(/line-up can change/i);
  });

  it('uses no banned word, signed out or in', () => {
    for (const signedIn of [false, true]) {
      const { container, unmount } = renderLanding(signedIn);
      const text = squash(container.textContent || '');
      for (const re of BANNED) expect(text.match(re), String(re)).toBeNull();
      unmount();
    }
  });

  it('the hero says, in its first lines, that an AI makes the pages', () => {
    renderLanding();
    const hero = squash((document.getElementById('top') as HTMLElement).textContent || '');
    expect(hero).toContain(HERO.lead);
    expect(hero).toMatch(/\bAI\b/);
  });

  it('the register section is the app’s own interest form: email, the sensible questions, one submit with source "landing"', async () => {
    waitlist.submitWaitlistEmail.mockResolvedValue({ ok: true, status: 'registered', message: INTEREST_THANKS.access });
    renderLanding();
    openFeedback();
    const register = document.getElementById('register') as HTMLElement;
    const esc = (s: string) => new RegExp(s.replace(/[?]/g, '\\?'));
    expect(within(register).getByRole('group', { name: esc(INTEREST_MAKES_QUESTION) })).toBeInTheDocument();
    expect(within(register).getByRole('combobox', { name: esc(INTEREST_HEARD_QUESTION) })).toBeInTheDocument();
    expect(within(register).getByRole('checkbox', { name: INTEREST_UPDATES.label })).not.toBeChecked();
    // No question about other studios: nothing on the page explains them.
    expect(register.textContent).not.toMatch(/Other studios|Chat Studio|Stream Studio|Dashboards/);
    const email = within(register).getByRole('textbox', { name: /Email address/ });
    fireEvent.change(email, { target: { value: 'reader@example.com' } });
    await act(async () => {
      fireEvent.submit(email.closest('form')!);
    });
    expect(waitlist.submitWaitlistEmail).toHaveBeenCalledTimes(1);
    expect(waitlist.submitWaitlistEmail).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'landing' }, undefined, { keepUpdated: false });
  });

  it('the FAQ says what happens after registering, the box included, and promises no email', () => {
    renderLanding();
    const after = FAQ.find((f) => f.q === 'What happens after I register my interest?')!;
    expect(after.a).toMatch(/can create an account at any time/);
    expect(after.a).toMatch(/updates preference/);
    const faq = squash((document.getElementById('faq') as HTMLElement).textContent || '');
    expect(faq).toContain(after.a);
  });

  // The form's thank-you, with or without answers and with or without the ticked box (shared/interest.ts INTEREST_THANKS):
  // it promises no email.
  it.each([
    INTEREST_THANKS.access,
    INTEREST_THANKS.accessWithAnswers,
    `${INTEREST_THANKS.access} ${INTEREST_THANKS.keptUpdated}`,
    `${INTEREST_THANKS.accessWithAnswers} ${INTEREST_THANKS.keptUpdated}`
  ])('after sending, the page shows the form’s thank-you and no banned words (%s)', async (message) => {
    waitlist.submitWaitlistEmail.mockResolvedValue({ ok: true, status: 'registered', message });
    const { container } = renderLanding();
    openFeedback();
    const register = document.getElementById('register') as HTMLElement;
    const email = within(register).getByRole('textbox', { name: /Email address/ });
    fireEvent.change(email, { target: { value: 'reader@example.com' } });
    await act(async () => {
      fireEvent.submit(email.closest('form')!);
    });
    expect(within(register).getByRole('status')).toHaveTextContent(message);
    const text = squash(container.textContent || '');
    for (const re of BANNED) expect(text.match(re), String(re)).toBeNull();
  });

  it('without a bot-check key the page loads no script from another site; with one, only the form’s check', () => {
    const external = () => [...document.querySelectorAll<HTMLScriptElement>('script[src]')].filter((el) => new URL(el.src, location.href).origin !== location.origin);
    const first = renderLanding();
    expect(external()).toEqual([]);
    first.unmount();
    build.turnstile = true;
    renderLanding();
    expect(external()).toEqual([]);
    openFeedback();
    expect(external().map((el) => new URL(el.src).hostname)).toEqual(['challenges.cloudflare.com']);
  });

  it('fill() refuses a missing value instead of shipping a brace', () => {
    expect(() => fill('{NOPE}', {})).toThrow(/NOPE/);
    expect(fill('Up to {N} pages', { N: 3 })).toBe('Up to 3 pages');
  });

  it('the questions answer from the same registries (default model, languages)', () => {
    renderLanding();
    const faq = squash((document.getElementById('faq') as HTMLElement).textContent || '');
    expect(faq).toContain(`New comics are drawn with ${DEFAULT_MODEL.name}`);
    expect(faq).toContain(`English and ${LANDING_VALUES.LANGS} more`);
    expect(screen.getByRole('link', { name: /support@/ })).toHaveAttribute('href', expect.stringMatching(/^mailto:/));
  });
});
