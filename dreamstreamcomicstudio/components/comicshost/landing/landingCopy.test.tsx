// @vitest-environment jsdom
// The landing says only what landingCopy.ts and the registries say: every line of the hero and the sections below it
// is on the page, filled from the registries (no brace left), and the page never uses words it must not: a price or an
// amount, "free forever", promises of an email, a reply, early access or a date, or plans; not before the interest
// form is sent and not after, whatever the backend or the fallback answers. Reading the page loads nothing from
// another site: the form's bot check (on here, as in a build with a site key) waits for the visitor to use the form.
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const waitlist = vi.hoisted(() => ({ submitWaitlistEmail: vi.fn() }));
/** Whether this build "has" a bot-check site key (off unless a test turns it on). */
const build = vi.hoisted(() => ({ turnstile: false }));
vi.mock('../../../services/waitlist', () => ({ submitWaitlistEmail: waitlist.submitWaitlistEmail }));
vi.mock('../../../services/clientConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/clientConfig')>()),
  TURNSTILE_SITE_KEY: 'test-site-key',
  turnstileEnabled: () => build.turnstile
}));

import { ComicsLanding } from '../ComicsLanding';
import { FAQ, FEATURES, HERO, HOW, MODELS, PRICING, REGISTER, fill } from './landingCopy';
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
      HERO.invitation,
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

  it('pricing says only what is certain: invite-only beta, sign-up not open, no prices announced, registering costs nothing', () => {
    renderLanding();
    const pricing = within(document.getElementById('pricing') as HTMLElement);
    expect(pricing.getAllByRole('listitem').map((li) => squash(li.textContent || ''))).toEqual([
      'Comic Studio is in an invite-only beta.',
      'Sign-up is not open yet.',
      'Prices have not been announced.',
      'Registering your interest costs nothing.'
    ]);
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

  it('the interest form asks about Comic Studio only: no product chips, no question about access', async () => {
    waitlist.submitWaitlistEmail.mockResolvedValue({ ok: true, status: 'joined', message: 'x' });
    renderLanding();
    const register = document.getElementById('register') as HTMLElement;
    expect(within(register).queryByRole('group')).toBeNull();
    for (const product of ['Chat Studio', 'Code Studio', 'Stream Studio', 'Dashboards']) expect(register.textContent).not.toContain(product);
    fireEvent.change(within(register).getByRole('textbox', { name: 'Email address' }), { target: { value: 'reader@example.com' } });
    await act(async () => {
      fireEvent.submit(within(register).getByRole('textbox', { name: 'Email address' }).closest('form')!);
    });
    expect(waitlist.submitWaitlistEmail).toHaveBeenCalledWith('reader@example.com', 'access', { source: 'landing' }, undefined, {
      productInterests: ['comic_studio'],
      feedback: undefined
    });
  });

  // What the backend (routes/newsletter.ts) and the direct-insert fallback (services/waitlist.ts) say for an accepted
  // signup, new or repeat. Some of them promise an email; the landing shows its own words instead.
  const ACCEPTED = [
    { ok: true, status: 'joined', alreadyJoined: false, message: 'Thanks! We’ll email you the moment access opens up.' },
    { ok: true, status: 'already-registered', alreadyJoined: true, message: 'You’re already on the list.' },
    { ok: true, message: "Thanks! We'll email you the moment access opens up." },
    { ok: true, alreadyJoined: true, message: "You're already on the list — sit tight, we'll be in touch." }
  ];

  it.each(ACCEPTED)('after sending, the page shows its own words and no banned ones ($message)', async (answer) => {
    waitlist.submitWaitlistEmail.mockResolvedValue(answer);
    const { container } = renderLanding();
    const register = document.getElementById('register') as HTMLElement;
    const email = within(register).getByRole('textbox', { name: 'Email address' });
    fireEvent.change(email, { target: { value: 'reader@example.com' } });
    await act(async () => {
      fireEvent.submit(email.closest('form')!);
    });
    expect(waitlist.submitWaitlistEmail).toHaveBeenCalledTimes(1);
    expect(within(register).getByRole('status')).toHaveTextContent(REGISTER.recorded);
    const text = squash(container.textContent || '');
    expect(text).not.toContain(answer.message);
    for (const re of BANNED) expect(text.match(re), String(re)).toBeNull();
  });

  it('reading the page loads nothing from another site; the bot check loads once the visitor uses the form', () => {
    build.turnstile = true;
    const external = () => [...document.querySelectorAll<HTMLScriptElement>('script[src]')].filter((el) => new URL(el.src, location.href).origin !== location.origin);
    renderLanding();
    expect(external()).toEqual([]);
    const register = document.getElementById('register') as HTMLElement;
    fireEvent.focusIn(within(register).getByRole('textbox', { name: 'Email address' }));
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
