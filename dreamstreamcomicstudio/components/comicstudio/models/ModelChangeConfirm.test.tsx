// The change confirm (models.md §3.6 C/D; AT-3, AT-4): the only way the picker changes a comic's model. C says
// "character consistency can be affected", lists what is drawn, preselects "Keep them as they are" and focuses
// "Keep {Current}"; the primary label follows the scope; the prices are shared redrawQuote over the live price
// book; a price we do not have is never a number; a governed user never sees dollars; the action carries ack and
// the shown quote; a refusal keeps the dialog open with the server's words. D (before the lock) saves the choice.

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { ComicDoc } from '../../../shared/comic/doc';
import { redrawQuote } from '../../../shared/comic/modelLock';
import type { StudioActOutcome } from '../types';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { ModelChangeConfirm, type ModelChangeConfirmProps } from './ModelChangeConfirm';
import { clientPriceBook } from './priceBook';
import { NOW, catalogRows, freshDoc, lakeDoc } from './testing/fixtures';

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', modelOverride: true, qualityTiers: ['draft', 'standard', 'pro'] };
const OK: StudioActOutcome = { ok: true, aborted: false, retryable: false, gated: false };

beforeEach(() => showDollarPrices());
afterEach(() => resetUsageStatus());

const open = (props: Partial<ModelChangeConfirmProps> = {}) => {
  const act = vi.fn(async () => OK);
  const patch = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  const onDone = vi.fn();
  const onPricesStale = vi.fn();
  const utils = render(
    <ModelChangeConfirm
      open
      doc={lakeDoc()}
      caps={PAID}
      byok={false}
      mode="easy"
      targetId="nano-banana-pro"
      rows={catalogRows()}
      act={act}
      patch={patch}
      onCancel={onCancel}
      onDone={onDone}
      onPricesStale={onPricesStale}
      now={NOW}
      {...props}
    />
  );
  return { ...utils, act, patch, onCancel, onDone, onPricesStale, dialog: screen.getByRole('alertdialog') };
};

const radio = (name: RegExp | string) => screen.getByRole('radio', { name });
const primary = () => document.querySelector<HTMLButtonElement>('[data-confirm="primary"]')!;
const priceOf = (scope: string) => document.querySelector(`[data-scope="${scope}"] [data-price]`)!.textContent;

describe('C — after the lock', () => {
  it('says consistency can be affected, lists what is drawn, preselects "Keep them as they are", focuses "Keep {Current}"', () => {
    const { dialog } = open();
    expect(dialog).toHaveAccessibleName('Switch this comic to Nano Banana Pro?');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const lead = dialog.querySelector('[data-confirm="lead"]')!;
    expect(lead).toHaveTextContent(
      'Your pages, character sheets and cover were drawn with Nano Banana 2.1. A different model draws faces, colors and line work its own way, so character consistency can be affected.'
    );
    expect(within(lead as HTMLElement).getByText('character consistency can be affected').tagName).toBe('STRONG');
    expect(screen.getByText('Already drawn with Nano Banana 2.1: 5 pages · 4 character sheets · cover')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'What should happen to the drawn images?' })).toBeInTheDocument();
    expect(radio(/Keep them as they are/)).toBeChecked();
    expect(radio(/Redraw the pages and cover/)).not.toBeChecked();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep Nano Banana 2.1' }));
    expect(screen.getByText('New pages and redraws use Nano Banana Pro. The book may look mixed.')).toBeInTheDocument();
    expect(screen.getByText('5 pages + cover on Nano Banana Pro. Character sheets stay.')).toBeInTheDocument();
    expect(screen.getByText('Pages, cover and 4 character sheets.')).toBeInTheDocument();
  });

  it('prices are shared redrawQuote over the live price book; the facts name both models', () => {
    open();
    const book = clientPriceBook(catalogRows(), { now: NOW });
    expect(redrawQuote(lakeDoc(), 'nano-banana-pro', 'pages_cover', book, false).usd).toBe(1.0678);
    expect(priceOf('none')).toBe('Free now');
    expect(priceOf('pages_cover')).toBe('≈$1.07');
    expect(priceOf('all')).toBe('≈$1.77');
    expect(screen.getByText('Nano Banana Pro: ≈$0.18 per page at 1K · holds up to 5 characters per image · 2 providers · 100% up (24 h)')).toBeInTheDocument();
    expect(screen.getByText('Nano Banana 2.1: ≈$0.05 per page at 1K')).toBeInTheDocument();
    expect(document.querySelector('[data-confirm="fineprint"]')).toHaveTextContent('Prices: OpenRouter, 5 min ago. You can switch back the same way.');
  });

  it('the primary label follows the scope', () => {
    open();
    expect(primary()).toHaveTextContent('Switch to Nano Banana Pro');
    fireEvent.click(radio(/Redraw the pages and cover/));
    expect(primary()).toHaveTextContent('Switch and redraw · ≈$1.07');
    fireEvent.click(radio(/Redraw everything/));
    expect(primary()).toHaveTextContent('Switch and redraw · ≈$1.77');
    fireEvent.click(radio(/Keep them as they are/));
    expect(primary()).toHaveTextContent('Switch to Nano Banana Pro');
  });

  it('confirming sends change_image_model with ack and the quote shown (free for "keep")', async () => {
    const { act: send, onDone } = open();
    fireEvent.click(radio(/Redraw the pages and cover/));
    await act(async () => fireEvent.click(primary()));
    expect(send).toHaveBeenCalledWith({ type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'pages_cover', quotedUsd: 1.0678, ack: true });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('quotes QC at the figure the server serves, so the quote sent equals the server’s recomputation', async () => {
    const { act: send } = open({ rows: catalogRows().map((r) => ({ ...r, qcUsd: 0.0049 })) });
    expect(priceOf('pages_cover')).toBe('≈$1.08');
    fireEvent.click(radio(/Redraw the pages and cover/));
    await act(async () => fireEvent.click(primary()));
    expect(send).toHaveBeenCalledWith({ type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'pages_cover', quotedUsd: 1.0801, ack: true });
  });

  it('"keep" switches for free', async () => {
    const { act: send } = open();
    await act(async () => fireEvent.click(primary()));
    expect(send).toHaveBeenCalledWith({ type: 'change_image_model', modelId: 'nano-banana-pro', redraw: 'none', quotedUsd: 0, ack: true });
  });

  it('a refusal keeps the dialog open with the server’s words and asks for fresh prices on a stale quote', async () => {
    const refused: StudioActOutcome = { ok: false, aborted: false, retryable: false, gated: false, code: 'REQUOTE', error: 'The price changed since you opened this. Here is the new quote.' };
    const { act: send, onDone, onPricesStale } = open();
    send.mockResolvedValueOnce(refused);
    fireEvent.click(radio(/Redraw everything/));
    await act(async () => fireEvent.click(primary()));
    expect(screen.getByRole('alert')).toHaveTextContent('The price changed since you opened this. Here is the new quote.');
    expect(onDone).not.toHaveBeenCalled();
    expect(onPricesStale).toHaveBeenCalledTimes(1);
  });

  it('a stopped switch is not a success: the dialog stays open and says it may not have gone through', async () => {
    const stopped: StudioActOutcome = { ok: false, aborted: true, retryable: true, gated: false };
    const { act: send, onDone, onPricesStale, dialog } = open();
    send.mockResolvedValueOnce(stopped);
    await act(async () => fireEvent.click(primary()));
    expect(send).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(onPricesStale).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The switch was stopped before it finished, so it may not have gone through. Check which model this comic shows before trying again.'
    );
    // The user can try again from the same dialog.
    expect(primary()).not.toBeDisabled();
  });

  it('Keep and Esc cancel without sending anything', () => {
    const { act: send, onCancel } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Nano Banana 2.1' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('warns when the new model holds fewer characters than a page has', () => {
    open({ doc: lakeDoc({ model: 'nano-banana-pro', page3Cast: 5 }), targetId: 'nano-banana-2.1' });
    expect(screen.getByText('Nano Banana 2.1 holds up to 4 characters per image; page 3 has 5.')).toBeInTheDocument();
  });

  it('warns when the chosen redraw is over the budget (only once it is chosen)', () => {
    open({ doc: lakeDoc({ budgetUsd: 1, spentUsd: 0.75 }) });
    expect(screen.queryByText(/over your budget/)).toBeNull();
    fireEvent.click(radio(/Redraw the pages and cover/));
    expect(screen.getByText('This is over your budget by ≈$0.82.')).toBeInTheDocument();
  });

  it('a legacy lock the catalog no longer lists still shows its registry price (never "no price" by omission)', () => {
    open({ doc: lakeDoc({ model: 'nano-banana-2' }), targetId: 'nano-banana-2.1' });
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Switch this comic to Nano Banana 2.1?');
    // (0.067 + 0.003) × 1.3 = 0.091 → ≈$0.09 per 1K page, from the registry's dated list.
    expect(screen.getByText('Nano Banana 2: ≈$0.09 per page at 1K')).toBeInTheDocument();
    expect(document.querySelector('[data-confirm="fineprint"]')).toHaveTextContent('from our price list, 2026-10-21');
  });

  it('BYOK: the fine print says the user’s own key pays', () => {
    open({ byok: true });
    expect(document.querySelector('[data-confirm="fineprint"]')).toHaveTextContent('Prices: OpenRouter, 5 min ago. Paid by your own key. You can switch back the same way.');
  });

  it('Pro adds a Details disclosure with the per-target redraw lines', () => {
    open({ mode: 'pro' });
    const details = document.querySelector('[data-confirm="details"]') as HTMLElement;
    expect(within(details).getByText('Details')).toBeInTheDocument();
    expect(details).toHaveTextContent('Pages (5): ≈$0.89');
    expect(details).toHaveTextContent('Cover (1): ≈$0.17');
    expect(details).toHaveTextContent('Character sheets (4): ≈$0.70');
  });
});

describe('no number without a price basis; no dollars for a governed user', () => {
  it('a redraw that cannot be priced shows no "$", is not offered, and says why', () => {
    const doc: ComicDoc = lakeDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    open({ doc, targetId: 'seedream-5-pro' });
    expect(priceOf('pages_cover')).toBe("Can't price yet");
    expect(priceOf('all')).toBe("Can't price yet");
    expect(radio(/Redraw the pages and cover/)).toBeDisabled();
    expect(screen.getByText("We can't price this redraw yet. The first image will show the real cost.")).toBeInTheDocument();
    // The facts use the §4.6 words for the missing price (the same line the picker row shows).
    const facts = document.querySelector('[data-confirm="facts"]')!;
    expect(facts.firstElementChild).toHaveTextContent(
      "Seedream 5 Pro: Price per image isn't published · you'll see the real cost after the first image · holds up to 4 characters per image · No uptime data right now"
    );
    expect(facts.textContent).not.toMatch(/no published price/);
    expect(facts.firstElementChild!.textContent).not.toMatch(/\$/);
    for (const el of document.querySelectorAll('[data-scope] [data-price]')) expect(el.textContent).not.toMatch(/\$/);
    // A model that cannot be picked here is never sent (its reason is shown, the primary is off).
    expect(screen.getByText('Not available in Comic Studio yet')).toBeInTheDocument();
    expect(primary()).toBeDisabled();
  });

  it('a model OpenRouter lists no price for says exactly that (§4.6)', () => {
    const doc: ComicDoc = lakeDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    const rows = catalogRows().map((r) =>
      r.id === 'seedream-5-pro' ? { ...r, price: { '1K': { usd: null, basis: 'openrouter_endpoint' as const, note: "OpenRouter doesn't list a price for this model" }, '2K': { usd: null, basis: 'openrouter_endpoint' as const, note: "OpenRouter doesn't list a price for this model" } } } : r
    );
    open({ doc, targetId: 'seedream-5-pro', rows });
    expect(document.querySelector('[data-confirm="facts"]')!.firstElementChild).toHaveTextContent(/^Seedream 5 Pro: OpenRouter doesn't list a price for this model · holds up to 4/);
  });

  it('a governed user reads usage shares only', () => {
    showUsagePrices(1);
    const { dialog } = open({ mode: 'pro' });
    fireEvent.click(radio(/Redraw everything/));
    expect(dialog.textContent).not.toMatch(/\$/);
    expect(primary().textContent).toMatch(/^Switch and redraw · ≈[\d.]+% of your usage$/);
  });
});

describe('D — before the lock', () => {
  it('says consistency can be affected later, focuses "Keep {Current}" and saves the pre-lock choice', async () => {
    const { dialog, patch, act: send, onDone } = open({ doc: freshDoc() });
    expect(dialog).toHaveAccessibleName('Draw this comic with Nano Banana Pro?');
    expect(dialog.querySelector('[data-confirm="body"]')).toHaveTextContent(
      'Every image in a comic uses one model so characters stay consistent. Nano Banana Pro will be locked for this comic when the first image is drawn. If you change it later, character consistency can be affected.'
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep Nano Banana 2.1' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use Nano Banana Pro' })));
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { imageModelOverride: 'nano-banana-pro' } }]);
    expect(send).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('choosing the tier’s own model clears the pre-lock choice', async () => {
    const doc = freshDoc();
    doc.settings = { ...doc.settings, imageModelOverride: 'nano-banana-pro' };
    const { patch } = open({ doc, targetId: 'nano-banana-2.1' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Use Nano Banana 2.1' })));
    expect(patch).toHaveBeenCalledWith([{ op: 'settings', patch: { imageModelOverride: null } }]);
  });
});

describe('a11y and layout', () => {
  it('axe clean; every control a 44 px target; a real modal alert', async () => {
    const { dialog } = open({ mode: 'pro' });
    const res = await axe.run(dialog, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice', 'experimental'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'label-content-name-mismatch': { enabled: true } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
    for (const el of dialog.querySelectorAll<HTMLElement>('button, summary')) expect(el.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    for (const label of dialog.querySelectorAll<HTMLElement>('label[data-scope]')) expect(label.className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(dialog.className).toMatch(/max-w-\[520px\]/);
    expect(dialog.className).toMatch(/w-full/);
  });
});
