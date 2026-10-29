// ModelStatusBanner (reliability.md §3/§5): one calm line under the studio header while the comic's model is in
// trouble — what, seen since when (server evidence, not page-open time), source + time, "nothing is charged", ≤ 3
// options with real prices, dismissable per
// incident, aria-live polite, no red, 360 px safe; nothing at all (and no polling) while every model is fine.
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveStudioCaps } from '../../../shared/comic/capabilities';
import type { ComicDoc, Msg } from '../../../shared/comic/doc';
import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import { PLATFORM_MARKUP, formatUsd, getImageModel, imagePriceUsd } from '../../../shared/comic/models';
import { redrawQuote } from '../../../shared/comic/modelLock';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from '../conversation/testing/fixtures';
import { registeredHeaderSlots } from '../features';
import { HEADER_BANNER_MIN_ORDER } from '../mobile/headerSlots';
import { MODEL_STATUS_BANNER_ORDER, ModelStatusBanner, watchedModelIds } from './ModelStatusBanner';
import { registryPriceBook } from './options';
import { __resetRetries, getRetry } from './retryIntents';
import { __resetStatusStore, __setStatusFetcherForTests } from './statusStore';
import { STATUS_POLL_MS } from './useModelStatus';

const NB21 = 'nano-banana-2.1';
const PRO = 'nano-banana-pro';
const paidCaps = resolveStudioCaps({ planId: 'pro', byok: false, isAdmin: false });

const healthOf = (modelId: string, state: HealthState, at = Date.now()): ModelHealth => ({
  modelId,
  state,
  checkedAt: at,
  routes: [
    {
      route: 'openrouter',
      model: getImageModel(modelId)?.routes.openrouter || modelId,
      state,
      providers: [{ name: 'Google AI Studio', status: state === 'down' ? -1 : 0, uptime30m: state === 'down' ? 41 : state === 'degraded' ? 88 : 99, uptime1d: 95 }],
      ...(state === 'down' ? { reason: 'Every provider reports a problem' } : state === 'degraded' ? { reason: 'Provider uptime 88% in the last 30 min' } : {}),
      checkedAt: at,
      source: 'openrouter'
    }
  ]
});

let states: Record<string, HealthState>;
const answerFromStates = async (ids: readonly string[]) => ids.map((id) => healthOf(id, states[id] ?? 'ok'));
const fetcher = vi.fn(answerFromStates);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(2026, 9, 22, 16, 52, 0));
  states = {};
  fetcher.mockReset();
  fetcher.mockImplementation(answerFromStates);
  __resetStatusStore();
  __resetRetries();
  __setStatusFetcherForTests(fetcher);
  sessionStorage.clear();
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

const studioWith = (doc: ComicDoc = makeSampleDoc()) => makeFakeStudio({ doc, caps: paidCaps });

const renderBanner = async (studio = studioWith(), compact = false) => {
  const utils = render(<ModelStatusBanner studio={studio} compact={compact} />);
  await flush();
  return { ...utils, studio };
};

describe('ModelStatusBanner', () => {
  it('is registered as the banner-tier header slot', () => {
    const slot = registeredHeaderSlots().find((s) => s.id === 'model-status');
    expect(slot?.Component).toBe(ModelStatusBanner);
    expect(slot!.order).toBe(MODEL_STATUS_BANNER_ORDER);
    expect(slot!.order).toBeGreaterThanOrEqual(HEADER_BANNER_MIN_ORDER);
  });

  it('watches the locked model for every kind, else each kind’s tier model and the style-test model', () => {
    const doc = makeSampleDoc();
    expect(watchedModelIds(doc)).toEqual([NB21]);
    expect(watchedModelIds({ ...doc, settings: { ...doc.settings, quality: 'pro' } })).toEqual([PRO, NB21]);
    expect(watchedModelIds({ ...doc, imageModel: { modelId: PRO, lockedAt: 1, origin: 'first_render' } })).toEqual([PRO]);
    expect(watchedModelIds(null)).toEqual([]);
  });

  it('says nothing (an empty polite live region) and never polls while the model is fine', async () => {
    states = { [NB21]: 'ok' };
    const { container } = await renderBanner();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toBeEmptyDOMElement();
    expect(container.querySelector('[data-model-status-banner]')).toBeNull();
    await flush(60 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('paused model: what, since when, source + time, nothing charged, and ≤ 3 options with real registry prices', async () => {
    states = { [NB21]: 'down' };
    const doc = makeSampleDoc();
    const { container, studio } = await renderBanner(studioWith(doc));
    const banner = container.querySelector('[data-model-status-banner="down"]') as HTMLElement;
    expect(banner).not.toBeNull();
    const text = banner.textContent || '';
    expect(text).toContain("Nano Banana 2.1 is paused — Google AI Studio isn't serving it right now (every provider reports a problem). New images wait, so nothing is charged.");
    expect(text).toContain('Seen since 16:52 · OpenRouter status, just now');
    expect(screen.getByRole('status')).toContainElement(banner);
    // No card yet: the options are built from the registry (no wait button — there is nothing to retry).
    const group = screen.getByRole('group', { name: /Ways to continue without Nano Banana 2.1/ });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.length).toBeLessThanOrEqual(3);
    expect(buttons.map((b) => b.getAttribute('data-option'))).toEqual(['switch_model']);
    const pro = getImageModel(PRO)!;
    const unit = Math.round(imagePriceUsd(pro, '2K') * PLATFORM_MARKUP * 10000) / 10000;
    expect(buttons[0]).toHaveTextContent(`Try Nano Banana Pro instead· ≈ ${formatUsd(unit)} per image`);
    const redraw = redrawQuote(doc, PRO, 'pages_cover', registryPriceBook(), false).usd!;
    expect(buttons[0].getAttribute('title')).toContain(`redraw 1 drawn image ≈ ${formatUsd(redraw)}`);
    // Switching opens the picker; it never acts.
    fireEvent.click(buttons[0]);
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker', suggest: PRO });
    expect(studio.act).not.toHaveBeenCalled();
    // Calm: warning tokens, no red.
    expect(banner.className).toContain('var(--ds-warning)');
    expect(container.innerHTML).not.toMatch(/\bred-|ds-danger/);
  });

  it('"Seen since" is the server’s evidence (our first failure seen), not when this page opened', async () => {
    // The page opens at 17:30, 38 minutes into an outage our calls have been failing in since 16:52.
    vi.setSystemTime(new Date(2026, 9, 22, 17, 30, 0));
    const failedAt = new Date(2026, 9, 22, 16, 52, 0).getTime();
    const opened = Date.now();
    fetcher.mockImplementation(async (ids: readonly string[]) =>
      ids.map((id) => ({
        modelId: id,
        state: 'down' as const,
        checkedAt: Date.now(),
        routes: [
          {
            route: 'openrouter' as const,
            model: getImageModel(id)?.routes.openrouter || id,
            state: 'down' as const,
            reason: 'Our last 3 calls failed (RATE_LIMIT)',
            observed: { ok: 0, upstreamFailures: 3, lastCode: 'RATE_LIMIT', lastFailureAt: failedAt },
            checkedAt: failedAt,
            source: 'observed' as const
          }
        ]
      }))
    );
    const { container } = await renderBanner();
    const text = container.querySelector('[data-model-status-banner="down"]')?.textContent || '';
    expect(text).toContain('Seen since 16:52 · our recent calls, 38 min ago');
    expect(text).not.toContain('17:30');
    expect(opened).toBeGreaterThan(failedAt);
  });

  it('switch opens the picker only; with an outage card the wait option arms that card’s retry', async () => {
    states = { [NB21]: 'down' };
    const doc = makeSampleDoc();
    const card = {
      type: 'model_outage' as const,
      id: 'card_out_9',
      modelId: NB21,
      options: [
        { kind: 'wait_and_retry' as const },
        { kind: 'add_key' as const, route: 'gemini' as const, label: 'Add a Gemini key to reach Nano Banana 2.1 directly' },
        { kind: 'switch_model' as const, modelId: PRO, nickname: 'Nano Banana Pro', usdPerImage: 0.1747, consistency: 'same_family' as const, redrawCount: 1, redrawUsd: 0.1786 },
        { kind: 'switch_model' as const, modelId: 'x-extra', nickname: 'Extra', usdPerImage: 0.2, consistency: 'different' as const, redrawCount: 1, redrawUsd: 0.2 }
      ],
      blockedAction: { type: 'render_pages' as const, pageIds: ['pg_2'], quotedUsd: 0.07 }
    };
    const message: Msg = { id: 'm1', role: 'assistant', text: "I've paused — nothing was charged.", at: 1, cards: [card] };
    const studio = studioWith({ ...doc, conversation: [message] });
    await renderBanner(studio);
    const group = screen.getByRole('group', { name: /Ways to continue without Nano Banana 2.1/ });
    const controls = [...group.querySelectorAll('[data-option]')].map((n) => n.getAttribute('data-option'));
    expect(controls).toEqual(['wait_and_retry', 'add_key', 'switch_model']); // ≤ 3, the card's own order
    fireEvent.click(within(group).getByRole('button', { name: /Try Nano Banana Pro instead/ }));
    expect(studio.runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker', suggest: PRO });
    expect(studio.act).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole('button', { name: /Wait and retry automatically/ }));
    expect(getRetry('card_out_9')?.state).toBe('waiting');
    // The banner's runner re-sends it once when the model is back.
    await flush(STATUS_POLL_MS);
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    expect(studio.act).toHaveBeenCalledTimes(1);
    expect(studio.act).toHaveBeenCalledWith(card.blockedAction);
  });

  it('dismiss hides this incident; it returns when the trouble gets worse, and after a recovery', async () => {
    states = { [NB21]: 'degraded' };
    const { container } = await renderBanner();
    expect(container.querySelector('[data-model-status-banner="degraded"]')?.textContent).toContain('Nano Banana 2.1 is unsteady');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the Nano Banana 2.1 status notice' }));
    expect(container.querySelector('[data-model-status-banner]')).toBeNull();
    await flush(STATUS_POLL_MS);
    expect(container.querySelector('[data-model-status-banner]')).toBeNull(); // same incident stays hidden
    states = { [NB21]: 'down' };
    await flush(STATUS_POLL_MS);
    expect(container.querySelector('[data-model-status-banner="down"]')).not.toBeNull(); // worse → shown again
    fireEvent.click(screen.getByRole('button', { name: 'Hide the Nano Banana 2.1 status notice' }));
    expect(container.querySelector('[data-model-status-banner]')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('comicstudio.modelStatus.dismissed') || '{}')).toEqual({ [NB21]: 'down' });
    states = { [NB21]: 'ok' };
    await flush(STATUS_POLL_MS);
    // The incident ended: its dismissal is forgotten…
    expect(sessionStorage.getItem('comicstudio.modelStatus.dismissed')).toBeNull();
    // …so a new incident, found by the next status read (here: the studio opened again a minute later), shows.
    states = { [NB21]: 'down' };
    await flush(STATUS_POLL_MS);
    const { container: again } = await renderBanner();
    expect(again.querySelector('[data-model-status-banner="down"]')).not.toBeNull();
  });

  it('fits 360 px: wrapping row, shrinkable text, 44 px targets on touch', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    states = { [NB21]: 'down' };
    const { container } = await renderBanner(undefined, true);
    const banner = container.querySelector('[data-model-status-banner]') as HTMLElement;
    const row = banner.firstElementChild as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    expect(row.className).toContain('min-w-0');
    const sentence = row.querySelector('p')!;
    expect(sentence.className).toContain('min-w-0');
    expect(sentence.className).toContain('[overflow-wrap:anywhere]');
    const close = screen.getByRole('button', { name: /Hide the/ });
    expect(close.className).toContain('coarse:h-11');
    for (const b of within(screen.getByRole('group')).getAllByRole('button')) expect(b.className).toContain('max-w-full');
  });
});
