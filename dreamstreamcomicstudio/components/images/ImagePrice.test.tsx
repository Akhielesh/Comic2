// The standalone image's price (docs/features/pricing.md § Images workspace): the shared book's quote on the route's
// model and size, references on the list basis, the person's own key in dollars, DreamStream's allowance as a share
// of the usage (never dollars for a governed person), nothing before the route is known, and no colour. Synthetic data.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PLATFORM_MARKUP, getImageModel } from '../../shared/comic/models';
import { priceBookFromSources, priceSheetOf, registryPriceBook } from '../../shared/comic/priceBook';
import type { StandaloneRoute } from '../../shared/standaloneImage';
import { __resetAllowanceStore, publishAllowanceStatus, type AllowanceStatus } from '../../services/usageAllowance';
import { __resetPriceSheetForTests, __seedPriceSheetForTests } from '../../services/priceSheet';
import { ImagePrice, standaloneQuoteUsd, standaloneRefsSent } from './ImagePrice';

vi.mock('../../services/apiClient', () => ({ get: vi.fn(async () => Promise.reject(new Error('offline'))) }));

const OWNER = 'owner-img';
const own: StandaloneRoute = { provider: 'openrouter', payer: 'personal', model: 'google/gemini-2.5-flash-image' };
const platform: StandaloneRoute = { provider: 'openrouter', payer: 'platform', model: 'google/gemini-2.5-flash-image' };
const nb: StandaloneRoute = { provider: 'openrouter', payer: 'personal', model: 'google/gemini-nano-banana-2.1' };
const live = priceSheetOf(
  {
    rows: [
      { id: 'nano-banana-legacy', price: { '1K': { usd: 0.039, basis: 'vendor_table' } }, perRefUsd: null },
      { id: 'nano-banana-2.1', price: { '1K': { usd: 0.0336, basis: 'openrouter_endpoint' }, '2K': { usd: 0.0504, basis: 'openrouter_endpoint' } }, perRefUsd: 0.0005 }
    ],
    observed: [],
    qc: null
  },
  Date.parse('2026-11-20T12:00:00Z')
);
const governed = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  enabled: true,
  governed: true,
  pctUsed: 20,
  pctLeft: 80,
  exhausted: false,
  crossed: [],
  resetsAt: null,
  friendlyUnits: { standardPages: 100, draftPages: 300, pctPerStandardPage: 1, label: 'about 100 standard comic pages left' },
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false,
  ...over
});

beforeEach(() => {
  __resetPriceSheetForTests();
  __resetAllowanceStore();
});
afterEach(() => vi.clearAllMocks());

describe('the quote', () => {
  it('is the shared book\'s job quote: the route\'s model at the size Generate sends, no page check', () => {
    const book = priceBookFromSources(live.sources);
    expect(getImageModel(own.model)?.id).toBe('nano-banana-legacy');
    expect(standaloneQuoteUsd(book, own, 'native', 0)).toBe(0.039);
    expect(standaloneQuoteUsd(book, platform, 'native', 0)).toBe(Math.round(0.039 * PLATFORM_MARKUP * 10000) / 10000);
    expect(standaloneQuoteUsd(book, nb, '2K', 0)).toBe(0.0504);
    expect(standaloneQuoteUsd(book, nb, '2K', 0)).toBe(book.jobQuote('nano-banana-2.1', '2K', 'image', { byok: true }).usd);
  });

  it('prices the references the model really receives (Flash: at most three)', () => {
    const book = priceBookFromSources(live.sources);
    expect(standaloneRefsSent('native', 7)).toBe(3);
    expect(standaloneRefsSent('1K', 7)).toBe(7);
    expect(standaloneQuoteUsd(book, nb, '1K', 4)).toBe(Math.round((0.0336 + 4 * 0.0005) * 10000) / 10000);
  });

  it('an unknown model has no price (never a guess)', () => {
    expect(standaloneQuoteUsd(registryPriceBook(), { ...own, model: 'vendor/unknown-image' }, 'native', 0)).toBeNull();
  });
});

describe('what the workspace shows', () => {
  it('own key: dollars, the key named, a sentence for a screen reader, no colour', () => {
    __seedPriceSheetForTests(OWNER, live);
    const { container } = render(<ImagePrice userId={OWNER} route={own} quality="native" refs={0} id="image-price" />);
    const line = container.querySelector('[data-image-price]')!;
    expect(line.id).toBe('image-price');
    expect(line.textContent).toContain('≈ $0.04 an image on your OpenRouter key');
    expect(screen.getByText('Each image costs about $0.04 on your OpenRouter key.')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/--ds-(accent|spark|hue|success|warning|danger|info)|text-(red|green|amber|blue)-/);
  });

  it('DreamStream\'s allowance, governed: a share of the usage and never a dollar sign', () => {
    __seedPriceSheetForTests(OWNER, live);
    publishAllowanceStatus(governed());
    const { container } = render(<ImagePrice userId={OWNER} route={platform} quality="native" refs={0} />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/≈[\d.]+% of your usage an image/);
    expect(text).not.toContain('$');
  });

  it('governed before the share is known: plain words, still no dollars', () => {
    __seedPriceSheetForTests(OWNER, live);
    const { container } = render(<ImagePrice userId={OWNER} route={platform} quality="native" refs={0} />);
    expect(container.textContent).toContain('Each image uses a little of your usage');
    expect(container.textContent).not.toContain('$');
  });

  it('an admin on the allowance reads dollars', () => {
    __seedPriceSheetForTests(OWNER, live);
    publishAllowanceStatus(governed({ governed: false }));
    const { container } = render(<ImagePrice userId={OWNER} route={platform} quality="native" refs={0} />);
    expect(container.textContent).toContain('≈ $0.05 an image');
  });

  it('nothing until the route is known, and nothing while the sheet is on its way', () => {
    __seedPriceSheetForTests(OWNER, live);
    const { container, rerender } = render(<ImagePrice userId={OWNER} route={null} quality="native" refs={0} />);
    expect(container.innerHTML).toBe('');
    __resetPriceSheetForTests();
    rerender(<ImagePrice userId="someone-else" route={own} quality="native" refs={0} />);
    expect(container.innerHTML).toBe('');
  });
});
