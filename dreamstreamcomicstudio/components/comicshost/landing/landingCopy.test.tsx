// @vitest-environment jsdom
// The landing says only what landingCopy.ts and the registries say: every line of the sections below the hero is on
// the page, filled from the registries (no brace left), and the page never uses words it must not: a price or an
// amount, "free forever", promises of an email, a reply, early access or a date, or plans.
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComicsLanding } from '../ComicsLanding';
import { FAQ, FEATURES, HOW, MODELS, PRICING, fill } from './landingCopy';
import { DEFAULT_MODEL, LANDING_VALUES, OTHER_MODELS } from './landingModels';

afterEach(cleanup);

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
