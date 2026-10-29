// The `model_outage` card (reliability.md §3/§5): a calm card with who/what/"nothing was charged", a live
// status line with source and time, and real options. Switching only opens the picker (its confirm says
// consistency can be affected); "wait and retry" re-sends the blocked action once when the model is back.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../../shared/comic/doc';
import type { HealthState, ModelHealth, OutageOption } from '../../../shared/comic/modelHealth';
import type { StudioAction } from '../../../shared/comic/ops';
import { CardRenderer } from '../conversation/cards/CardRenderer';
import { makeFakeStudio, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { registeredCard } from '../features';
import { OutageCard } from './OutageCard';
import { __resetRetries, getRetry } from './retryIntents';
import { __resetStatusStore, __setStatusFetcherForTests } from './statusStore';
import { STATUS_POLL_MS } from './useModelStatus';

const NB21 = 'nano-banana-2.1';
const OR_MODEL = 'google/gemini-nano-banana-2.1';
const blocked: StudioAction = { type: 'render_style_options', quotedUsd: 0.13 };

const switchPro: OutageOption = {
  kind: 'switch_model',
  modelId: 'nano-banana-pro',
  nickname: 'Nano Banana Pro',
  usdPerImage: 0.1747,
  consistency: 'same_family',
  redrawCount: 3,
  redrawUsd: 0.5243
};

const outage = (extra: Partial<Extract<Card, { type: 'model_outage' }>> = {}): Extract<Card, { type: 'model_outage' }> => ({
  type: 'model_outage',
  id: 'card_out_1',
  modelId: NB21,
  options: [{ kind: 'wait_and_retry' }, { kind: 'add_key', route: 'gemini', label: 'Add a Gemini key to reach Nano Banana 2.1 directly' }, switchPro],
  blockedAction: blocked,
  ...extra
});

const healthOf = (state: HealthState, at = Date.now()): ModelHealth => ({
  modelId: NB21,
  state,
  checkedAt: at,
  routes: [
    {
      route: 'openrouter',
      model: OR_MODEL,
      state,
      providers: [{ name: 'Google AI Studio', status: state === 'ok' ? 0 : -1, uptime30m: state === 'ok' ? 99 : 41, uptime1d: 93 }],
      ...(state === 'down' ? { reason: 'Our last 3 calls failed (RATE_LIMIT)' } : {}),
      checkedAt: at,
      source: 'openrouter'
    }
  ]
});

let state: HealthState;
const fetcher = vi.fn(async (ids: readonly string[]) => ids.map(() => healthOf(state)));
const msg = { id: 'msg_1', role: 'assistant' as const, text: '', at: 1 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-22T16:52:00Z'));
  state = 'down';
  fetcher.mockClear();
  __resetStatusStore();
  __resetRetries();
  __setStatusFetcherForTests(fetcher);
  showDollarPrices();
});

afterEach(() => {
  __setStatusFetcherForTests(null);
  resetUsageStatus();
  vi.useRealTimers();
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const renderCard = async (card = outage(), studio = makeFakeStudio()) => {
  const utils = render(<CardRenderer card={card} studio={studio} message={msg} />);
  await flush();
  return { ...utils, studio };
};

describe('OutageCard', () => {
  it('is the registered renderer for model_outage', () => {
    expect(registeredCard('model_outage')?.Component).toBe(OutageCard);
  });

  it('says who, what, that nothing was charged and that the comic stays on its model — with source and time', async () => {
    const { container } = await renderCard();
    expect(screen.getByText('Nano Banana 2.1 is paused')).toBeInTheDocument();
    const text = container.textContent || '';
    expect(text).toContain("Google AI Studio isn't serving Nano Banana 2.1 right now (our last 3 calls failed: rate limited).");
    expect(text).toContain("The style tests weren't started, and nothing was charged.");
    expect(text).toContain('Your comic stays on Nano Banana 2.1 so every page matches.');
    expect(text).toContain('Status: OpenRouter status, just now');
    // Calm: no red, no error tone anywhere in the card.
    expect(container.innerHTML).not.toMatch(/\bred-|ds-danger|text-red/);
    expect(screen.getByRole('img', { name: /Nano Banana 2.1: Paused · OpenRouter status, just now/ })).toBeInTheDocument();
  });

  it('shows every option with its real price; the key link opens Settings → API keys in a new tab', async () => {
    await renderCard();
    const group = screen.getByRole('group', { name: 'Ways to continue' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('data-option'))).toEqual(['wait_and_retry', 'switch_model']);
    expect(buttons[0]).toHaveTextContent('Wait and retry automatically· Free');
    expect(buttons[1]).toHaveTextContent('Try Nano Banana Pro instead· ≈ $0.17 per image');
    expect(buttons[1]).toHaveTextContent('same family · redraw 3 drawn images ≈ $0.52 to keep the book consistent');
    const link = within(group).getByRole('link', { name: /Add a Gemini key/ });
    expect(link).toHaveAttribute('href', '/?view=settings&tab=settings');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('switching only opens the model picker on that model — it never changes the model itself', async () => {
    const { studio } = await renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Try Nano Banana Pro instead/ }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker', suggest: 'nano-banana-pro' });
    expect(studio.act).not.toHaveBeenCalled();
  });

  it('wait and retry: says it only runs while the page is open, can be cancelled, and re-sends the action once when the model is back', async () => {
    const { studio } = await renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Wait and retry automatically/ }));
    expect(getRetry('card_out_1')?.state).toBe('waiting');
    const live = screen.getAllByRole('status').find((n) => n.getAttribute('aria-live') === 'polite')!;
    expect(live).toHaveTextContent("Waiting for Nano Banana 2.1. The style tests will start once, automatically, when it's back — only while this page stays open. If you close it, nothing runs later.");
    // The wait option is not offered twice.
    expect(screen.queryByRole('button', { name: /Wait and retry automatically/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Don't retry" }));
    expect(getRetry('card_out_1')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /Wait and retry automatically/ }));
    await flush(STATUS_POLL_MS);
    expect(studio.act).not.toHaveBeenCalled(); // still down
    state = 'ok';
    await flush(STATUS_POLL_MS);
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(studio.act).toHaveBeenCalledWith(blocked);
    expect(screen.getByText(/Nano Banana 2.1 answered again at \d\d:\d\d, so the style tests were started once\./)).toBeInTheDocument();
    await flush(5 * STATUS_POLL_MS);
    expect(studio.act).toHaveBeenCalledTimes(1);
  });

  it('when the model is fine again it says so and offers "Try again now" (no options to pick from)', async () => {
    state = 'ok';
    const { studio } = await renderCard();
    expect(screen.getByText('Nano Banana 2.1 is answering again')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ways to continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Try again now/ }));
    expect(studio.act).toHaveBeenCalledWith(blocked);
  });

  it('a card without a blocked action offers no retry buttons (nothing to re-send)', async () => {
    await renderCard(outage({ blockedAction: undefined }));
    expect(screen.queryByRole('button', { name: /Wait and retry/ })).toBeNull();
    expect(screen.getByText(/Nothing was drawn and nothing was charged\./)).toBeInTheDocument();
  });

  it('governed users see usage, never dollars', async () => {
    resetUsageStatus();
    showUsagePrices(1);
    const { container } = await renderCard();
    expect(container.textContent).not.toContain('$');
    expect(screen.getByRole('button', { name: /Try Nano Banana Pro instead/ }).textContent).toMatch(/% of your usage/);
  });

  it('fits 360 px: shrinkable shell, wrapping option row, long words break', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    const long = 'Add a Gemini key to reach Nano Banana 2.1 directly through Google AI Studio without waiting for anything at all';
    const { container } = await renderCard(outage({ options: [{ kind: 'add_key', route: 'gemini', label: long }, switchPro] }));
    const section = container.querySelector('section')!;
    expect(section.className).toContain('min-w-0');
    const group = screen.getByRole('group', { name: 'Ways to continue' });
    expect(group.className).toContain('flex-wrap');
    expect(group.className).toContain('min-w-0');
    for (const el of within(group).getAllByRole('button').concat(within(group).getAllByRole('link'))) {
      expect(el.className).toContain('max-w-full');
      expect(el.className).toContain('coarse:min-h-11'); // 44 px touch targets
    }
    expect(container.querySelector('[data-card="model_outage"] p')!.className).toContain('[overflow-wrap:anywhere]');
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  });
});
