// The `credit` conversation card (credit-safety.md): what happened and what to do, in dollars for the person's own key
// and in plain words and percentages for people on DreamStream's allowance, with no colour on any action.
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreditCard } from '../../../shared/comic/credit';
import type { Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { CardRenderer } from '../conversation/cards/CardRenderer';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showUsagePrices } from '../conversation/testing/fixtures';
import { creditWords } from './CreditCard';

afterEach(resetUsageStatus);

const renderCard = (card: CreditCard, studio = makeFakeStudio({ caps: { ...DEFAULT_CAPS, byok: card.payer === 'own_key' } })) => {
  const message: Msg = { id: 'm_credit', role: 'assistant', text: '', at: 1, cards: [card] };
  const doc = makeSampleDoc({ conversation: [message] });
  const view = render(<CardRenderer card={card} studio={{ ...studio, doc }} message={message} />);
  return { ...view, studio, section: screen.getByRole('region') };
};

const stopped: CreditCard = {
  type: 'credit', id: 'c1', reason: 'stopped', payer: 'own_key', provider: 'openrouter', drawn: 1, notStarted: 2,
  rest: { action: { type: 'render_pages', pageIds: ['pg_2', 'pg_3'], quotedUsd: 0.11 }, usd: 0.11 }
};

describe('a run stopped on a key with no credit', () => {
  it('says what happened and what to do: Top up (OpenRouter), Switch key, and Draw the rest at its price', () => {
    const { studio, section } = renderCard(stopped);
    expect(within(section).getByText('Your OpenRouter key ran out of credit')).toBeInTheDocument();
    expect(section).toHaveTextContent('1 picture was drawn first. 2 pictures weren’t started and cost nothing.');
    expect(section).toHaveTextContent('Top up OpenRouter (or raise the key’s spending limit), or switch key in Settings, then draw the rest.');
    const top = within(section).getByRole('link', { name: /Top up/ });
    expect(top).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    expect(top).toHaveAttribute('target', '_blank');
    fireEvent.click(within(section).getByRole('button', { name: /Switch key/ }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_settings', section: 'keys' });
    fireEvent.click(within(section).getByRole('button', { name: /Draw the rest · ≈ \$0\.11/ }));
    expect(studio.act).toHaveBeenCalledWith(stopped.rest!.action);
  });

  it('a Gemini key with no image quota says so and links to its own billing page', () => {
    const { section } = renderCard({ type: 'credit', id: 'c2', reason: 'stopped', payer: 'own_key', provider: 'gemini', noQuota: true, drawn: 0, notStarted: 3 });
    expect(within(section).getByText('Your Gemini key has no image quota')).toBeInTheDocument();
    expect(section).toHaveTextContent('3 pictures weren’t started and cost nothing. Turn on billing for that key’s Google project');
    expect(within(section).getByRole('link', { name: /Top up/ }).getAttribute('href')).toMatch(/^https:\/\/aistudio\.google\.com\//);
    expect(within(section).queryByRole('button', { name: /Draw the rest/ })).toBeNull();
  });

  it('on DreamStream\'s allowance: plain words, no dollar sign anywhere, and no provider link', () => {
    showUsagePrices(2);
    const studio = makeFakeStudio({ caps: { ...DEFAULT_CAPS, byok: false, usage: { governed: true, pctLeft: 60, exhausted: false, pctPerStandardPage: 2 } } });
    const card: CreditCard = { ...stopped, payer: 'allowance', provider: undefined };
    const { section } = renderCard(card, studio);
    expect(within(section).getByText('Drawing paused')).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\$|¢/);
    expect(section).toHaveTextContent('Nothing more was used from your usage.');
    expect(within(section).queryByRole('link', { name: /Top up/ })).toBeNull();
    expect(within(section).getByRole('button', { name: /Use my own key/ })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /Draw the rest · .*of your usage/ })).toBeInTheDocument();
  });
});

describe('a run that stopped after both of the person\'s keys were refused', () => {
  it('names both keys, says what each needs, and offers a Top up for each', () => {
    const card: CreditCard = {
      type: 'credit', id: 'c10', reason: 'stopped', payer: 'own_key', provider: 'gemini', drawn: 0, notStarted: 3,
      keys: [{ provider: 'openrouter' }, { provider: 'gemini' }]
    };
    const { section } = renderCard(card);
    expect(within(section).getByText('Your OpenRouter and Gemini keys ran out of credit')).toBeInTheDocument();
    expect(section).toHaveTextContent(
      'I stopped before the rest of this run: your OpenRouter key ran out of credit and your Gemini key ran out of credit. 3 pictures weren’t started and cost nothing. Top up OpenRouter or top up Gemini, or switch key in Settings, then draw the rest.'
    );
    expect(within(section).getByRole('link', { name: /Top up OpenRouter/ })).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    expect(within(section).getByRole('link', { name: /Top up Gemini/ }).getAttribute('href')).toMatch(/^https:\/\/aistudio\.google\.com\//);
  });

  it('mixed reasons read as what each key needs (credit for one, billing for the other)', () => {
    const words = creditWords({
      type: 'credit', id: 'c11', reason: 'stopped', payer: 'own_key', provider: 'gemini', noQuota: true, drawn: 1, notStarted: 2,
      keys: [{ provider: 'openrouter' }, { provider: 'gemini', noQuota: true }]
    });
    expect(words.title).toBe('Neither of your keys can draw right now');
    expect(words.body).toBe(
      'I stopped before the rest of this run: your OpenRouter key ran out of credit and your Gemini key has no image quota (its Google project has no billing). 1 picture was drawn first. 2 pictures weren’t started and cost nothing. Top up OpenRouter or turn on billing for that Google project, or switch key in Settings, then draw the rest.'
    );
  });
});

describe('"Not enough credit" before a paid step', () => {
  it('own key: what it needs and what is left in dollars, when the balance was read, and Draw what fits', () => {
    const card: CreditCard = {
      type: 'credit', id: 'c3', reason: 'short', payer: 'own_key', provider: 'openrouter', what: 'pages 1–3', needUsd: 0.21, leftUsd: 0.05, checkedAt: Date.now() - 4 * 60_000,
      fits: { action: { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: 0.04 }, usd: 0.04, pages: 1 }
    };
    const { studio, section } = renderCard(card);
    expect(within(section).getByText('Not enough credit')).toBeInTheDocument();
    expect(section).toHaveTextContent('It needs ≈ $0.21 for pages 1–3, and your OpenRouter key has $0.05 left. Nothing was started or charged.');
    expect(section).toHaveTextContent('OpenRouter reported the balance 4 min ago.');
    fireEvent.click(within(section).getByRole('button', { name: /Draw what fits · 1 page · ≈ \$0\.04/ }));
    expect(studio.act).toHaveBeenCalledWith(card.fits!.action);
  });

  it('governed: a percentage needed and left, a top-up asked for in words, never dollars', () => {
    showUsagePrices(2);
    const studio = makeFakeStudio({ caps: { ...DEFAULT_CAPS, byok: false, usage: { governed: true, pctLeft: 0.5, exhausted: false, pctPerStandardPage: 2 } } });
    const card: CreditCard = {
      type: 'credit', id: 'c4', reason: 'short', payer: 'allowance', what: 'pages 1–3', needPct: 4.2, leftPct: 0.5,
      fits: { action: { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: 0.06 }, usd: 0.06, pages: 1 }
    };
    const { section } = renderCard(card, studio);
    expect(section).toHaveTextContent('It needs about 4.2% of your usage for pages 1–3, and 0.5% is left. Nothing was started. Ask for a top-up, or use your own key.');
    expect(section.textContent).not.toMatch(/\$|¢/);
    expect(within(section).getByRole('button', { name: /Draw what fits · 1 page · ≈.*% of your usage/ })).toBeInTheDocument();
    // The way to ask is on the card: a mail to support with a subject and nothing about the account in it.
    const ask = within(section).getByRole('link', { name: /Ask for a top-up/ });
    expect(ask.getAttribute('href')).toBe('mailto:support@dreamstreamstudio.ai?subject=Comic%20Studio%3A%20more%20usage%2C%20please');
    expect(within(section).queryByRole('link', { name: /^Top up/ })).toBeNull();
  });

  it('says when what is left already sets aside what this comic is drawing now', () => {
    const own: CreditCard = { type: 'credit', id: 'c8', reason: 'short', payer: 'own_key', provider: 'openrouter', what: 'the cover', needUsd: 0.2, leftUsd: 0.1, held: true };
    expect(creditWords(own).body).toBe('It needs ≈ $0.20 for the cover, and your OpenRouter key has $0.10 left after what’s drawing now. Nothing was started or charged.');
    const governed: CreditCard = { type: 'credit', id: 'c9', reason: 'short', payer: 'allowance', what: 'the cover', needPct: 3, leftPct: 1, held: true };
    expect(creditWords(governed).body).toBe('It needs about 3% of your usage for the cover, and 1% is left after what’s drawing now. Nothing was started. Ask for a top-up, or use your own key.');
  });

  it('no colour on the card\'s money or its spend controls', () => {
    const { section } = renderCard({ ...stopped });
    for (const control of within(section).getAllByRole('button')) {
      expect(control.className).not.toMatch(/--ds-(?:hue|spark|accent-fill|success|warning|danger)|STATUS/);
    }
    expect(section.querySelector('[data-card="credit"]')!.innerHTML).not.toMatch(/--ds-(?:hue|spark|success|warning|danger)/);
  });

  it('words for a card with missing fields stay honest (older or partial cards)', () => {
    expect(creditWords({ type: 'credit', id: 'c5', reason: 'short', payer: 'own_key' }).body).toBe('It needs more than is left, and your OpenRouter key has too little left. Nothing was started or charged.');
    expect(creditWords({ type: 'credit', id: 'c6', reason: 'short', payer: 'allowance' }).body).toMatch(/^It needs more of your usage than is left, and none is left\./);
    expect(creditWords({ type: 'credit', id: 'c7', reason: 'stopped', payer: 'own_key' }).body).toMatch(/^I stopped before the rest of this run\. Top up OpenRouter/);
  });
});
