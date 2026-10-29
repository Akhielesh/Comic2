// Models tab (models.md §4.2 / §4.3 / §4.6, §5.1 acceptance): per-comic totals from the doc, live catalog facts
// with source and time, and the exact copy for every missing-data state — never an invented number.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock }));

import { createEmptyDoc, type SpendEntry } from '../../../shared/comic/doc';
import { MAX_SPEND_ENTRIES } from '../../../shared/comic/limits';
import { getImageModel } from '../../../shared/comic/models';
import { LAKE_MODEL, makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { costFormat } from '../conversation/cost';
import { __resetStatusStore } from '../reliability/statusStore';
import { NOT_RANKED_COPY, NO_OPENROUTER_PRICE_COPY, NO_UPTIME_COPY, PRICE_UNPUBLISHED_COPY, newerBuildCopy } from './copy';
import { insightsMoney } from './insightsModel';
import { ModelsTab } from './ModelsTab';
import { __resetInsightsCacheForTests } from './useInsights';

const dollars = insightsMoney(costFormat(DOLLAR_CONTEXT));
const governed = insightsMoney(costFormat({ governed: true, pctPerUsd: 20 }));
const NOW = Date.parse('2026-10-29T12:00:00Z');

const lakeRow = (over: Record<string, unknown> = {}) => ({
  id: LAKE_MODEL,
  nickname: 'Nano Banana 2.1',
  providerModel: 'google/gemini-nano-banana-2.1',
  pickable: true,
  lifecycle: 'ga',
  price: {
    '1K': { usd: 0.0336, basis: 'vendor_table', note: '1120 tokens × $30/M (Google token table)' },
    '2K': { usd: 0.0504, basis: 'vendor_table', note: '1680 tokens × $30/M (Google token table)' },
    '4K': { usd: 0.113, basis: 'vendor_table', note: 'Google lists 4K as $0.076 in one place and $0.113 in another; we quote $0.113' }
  },
  perRefUsd: null,
  endpoints: [{ provider: 'Google AI Studio', uptime1d: 97.72, uptime30m: null }],
  quality: [{ board: 'lmarena_edit', rank: 2, of: 60, score: 1220, asOf: '2026-10-20', source: 'LMArena (CC BY 4.0)' }],
  observed: [{ kind: 'page', res: '1K', n: 4, medianUsd: 0.047, minUsd: 0.0428, maxUsd: 0.0538, from: '2026-10-22', to: '2026-10-22', scope: 'you' }],
  fetchedAt: { catalog: '2026-10-29T11:30:00Z', uptime: '2026-10-29T11:45:00Z', quality: '2026-10-21T03:07:00Z' },
  stale: false,
  current: true,
  ...over
});

/** Route the mocked apiClient: the catalog answers `catalog`, the status route answers nothing. */
const serve = (catalog: unknown | (() => Promise<unknown>)) => {
  getMock.mockImplementation((path: string) => {
    if (path.startsWith('/api/comic/models/catalog')) return typeof catalog === 'function' ? (catalog as () => Promise<unknown>)() : Promise.resolve(catalog);
    if (path.startsWith('/api/comic/models/status')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
};

const mount = async (doc = makeLakeComic(), opts: { money?: typeof dollars; pro?: boolean } = {}) => {
  const openPicker = vi.fn();
  const utils = render(<ModelsTab doc={doc} money={opts.money ?? dollars} pro={opts.pro ?? false} openPicker={openPicker} now={NOW} />);
  await act(async () => {});
  return { ...utils, openPicker };
};

const item = (name: string) => screen.getByRole('listitem', { name });
const NUMBER = /\$\s?\d|\d+(\.\d+)?%/;

beforeEach(() => {
  getMock.mockReset();
  __resetInsightsCacheForTests();
  __resetStatusStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Models tab — this comic (acceptance)', () => {
  it('nano-banana-2.1 with 15 images and $0.7513 for an admin / own-key viewer; per size real cost vs list', async () => {
    serve([lakeRow()]);
    await mount();
    expect(getMock.mock.calls[0][0]).toBe(`/api/comic/models/catalog?projectId=${encodeURIComponent('f8312c86-test')}`);
    const nb = item('Nano Banana 2.1');
    expect(nb).toHaveTextContent('nano-banana-2.1');
    expect(nb).toHaveTextContent('15 images · $0.7513');
    expect(within(nb).getByText('Current')).toBeInTheDocument();
    const sizes = within(nb).getByRole('list', { name: 'Nano Banana 2.1 by size' });
    // 2K: page 1 + the five v1 pages; observed n = 6 with its range, vs the live list price labelled with its basis.
    expect(sizes).toHaveTextContent('2K: real ≈$0.06 per image (n = 6, $0.0579–$0.06) · list $0.0504 (vendor token table)');
    expect(sizes).toHaveTextContent('1K: real ≈');
  });

  it('a legacy doc without running totals and a capped entry list says "(recent 200)"', async () => {
    serve([lakeRow()]);
    let doc = createEmptyDoc('legacy', 'Legacy', 1);
    const e = (i: number): SpendEntry => ({ id: `e${i}`, at: i, kind: 'page', label: `Page ${i}`, usd: 0.04, model: LAKE_MODEL, byok: true, estimated: false, res: '1K' });
    doc = { ...doc, spend: { ...doc.spend, entries: Array.from({ length: MAX_SPEND_ENTRIES }, (_, i) => e(MAX_SPEND_ENTRIES - i)) } };
    await mount(doc);
    expect(document.body).toHaveTextContent(`Models in this comic(recent ${MAX_SPEND_ENTRIES})`);
    expect(item('Nano Banana 2.1')).toHaveTextContent(`${MAX_SPEND_ENTRIES} images · $8`);
  });

  it('a mixed-model legacy book says so and lists every model', async () => {
    serve([lakeRow()]);
    const doc = makeLakeComic((d) => {
      d.pages[1].render.asset!.model = 'nano-banana-pro';
      d.spend.entries.unshift({ id: 'pro', at: 9e12, kind: 'page', label: 'Page 2', usd: 0.13, model: 'nano-banana-pro', byok: true, estimated: false, res: '1K', target: 'page:pg_2' });
    });
    await mount(doc);
    expect(screen.getByText('This comic has images from 2 models.')).toBeInTheDocument();
    expect(item('Nano Banana Pro')).toHaveTextContent('1 image · $0.13');
  });

  it('the locked model gets the §2.5 "newer build" notice when OpenRouter’s canonical slug changed since the lock', async () => {
    const locked = (slug?: string) =>
      makeLakeComic((d) => {
        d.imageModel = { modelId: LAKE_MODEL, providerModel: 'google/gemini-nano-banana-2.1', ...(slug ? { canonicalSlug: slug } : {}), lockedAt: 1, origin: 'first_render' };
      });
    const newer = 'google/gemini-nano-banana-2.1-20261120';
    const copy = newerBuildCopy('Nano Banana 2.1', newer);
    expect(copy).toBe(`OpenRouter now serves a newer build of Nano Banana 2.1 (${newer}). The provider may have updated it.`);
    serve([lakeRow({ canonicalSlug: newer })]);
    const first = await mount(locked('google/gemini-nano-banana-2.1-20261006'));
    expect(item('Nano Banana 2.1')).toHaveTextContent(copy);
    first.unmount();
    // The same slug, or a lock that recorded none, says nothing.
    __resetInsightsCacheForTests();
    serve([lakeRow({ canonicalSlug: newer })]);
    const same = await mount(locked(newer));
    expect(document.body).not.toHaveTextContent('newer build');
    same.unmount();
    await mount(locked());
    expect(document.body).not.toHaveTextContent('newer build');
  });

  it('Pro has the Model row (§3.7) with the lock line; Change… and Compare models open the picker (client action)', async () => {
    serve([lakeRow()]);
    const { openPicker } = await mount(makeLakeComic(), { pro: true });
    expect(screen.getByText('Drawn with Nano Banana 2.1 · locked for this comic', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Model locked so every page matches' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare models' }));
    expect(openPicker).toHaveBeenCalledTimes(2);
  });

  it('L3: each model has "Details…", which opens the picker on that model (open_model_picker with suggest)', async () => {
    serve([lakeRow()]);
    const { openPicker } = await mount();
    fireEvent.click(within(item('Nano Banana 2.1')).getByRole('button', { name: 'Details… about Nano Banana 2.1' }));
    expect(openPicker).toHaveBeenCalledWith(LAKE_MODEL);
  });
});

describe('Models tab — live facts, with source and time', () => {
  it('prices per size with basis and fetch time; 24 h uptime alone when the 30-minute figure is null; ranks with dates; observed with n and range', async () => {
    serve([lakeRow()]);
    await mount();
    const nb = item('Nano Banana 2.1');
    expect(nb).toHaveTextContent('1K per image$0.0336');
    expect(nb).toHaveTextContent('Google lists 4K as $0.076 in one place and $0.113 in another; we quote $0.113'); // §4.6 sources disagree
    expect(nb).toHaveTextContent(/Prices: OpenRouter, (Oct 29, )?\d\d:30/);
    const uptime = within(nb).getByRole('list', { name: 'Providers and uptime' });
    expect(uptime).toHaveTextContent('Google AI Studio · 97.72% up (24 h)');
    expect(uptime).not.toHaveTextContent('30 min');
    expect(within(nb).getByRole('list', { name: 'Leaderboards' })).toHaveTextContent('LMArena edit #2 of 60 · score 1220 (Oct 20, 2026)');
    expect(within(nb).getByRole('list', { name: 'Observed cost' })).toHaveTextContent('Real cost, pages at 1K: $0.047 median (n = 4, $0.0428–$0.0538) · your calls');
  });

  it.each([
    ['per-image price unpublished', { '1K': { usd: null, basis: 'openrouter_endpoint', note: PRICE_UNPUBLISHED_COPY } }, PRICE_UNPUBLISHED_COPY],
    ['OpenRouter lists no price', { '1K': { usd: null, basis: 'openrouter_endpoint', note: NO_OPENROUTER_PRICE_COPY } }, NO_OPENROUTER_PRICE_COPY]
  ])('%s → the exact copy and no number in its place', async (_name, price, copy) => {
    serve([lakeRow({ price, observed: [] })]);
    await mount();
    const nb = item('Nano Banana 2.1');
    const cell = within(nb).getByText(copy);
    expect(cell.closest('div')!.textContent).not.toMatch(/\$\s?\d/);
  });

  it('a row with no price at any size says "OpenRouter doesn’t list a price for this model", with no number', async () => {
    serve([lakeRow({ price: {}, observed: [] })]);
    await mount();
    const cell = within(item('Nano Banana 2.1')).getByText(NO_OPENROUTER_PRICE_COPY);
    expect(cell.closest('div')!.textContent).not.toMatch(/\$\s?\d/);
  });

  it('a size with no list price anywhere reads "Price per image isn’t published …" in its size line', async () => {
    serve([lakeRow()]);
    const doc = makeLakeComic((d) => {
      d.spend.entries.unshift({ id: 'small', at: 9e12, kind: 'page', label: 'Page 6', usd: 0.03, model: LAKE_MODEL, byok: true, estimated: false, res: '512', target: 'page:pg_6' });
    });
    await mount(doc);
    const sizes = within(item('Nano Banana 2.1')).getByRole('list', { name: 'Nano Banana 2.1 by size' });
    expect(sizes).toHaveTextContent(`512: 1 image · ${PRICE_UNPUBLISHED_COPY}`);
  });

  it('fetch failed, cache exists → the cached value with "as of {time} · couldn’t refresh"', async () => {
    serve([lakeRow({ stale: true })]);
    await mount();
    expect(item('Nano Banana 2.1')).toHaveTextContent(/as of (Oct 29, )?\d\d:30 · couldn't refresh/);
    expect(item('Nano Banana 2.1')).toHaveTextContent('1K per image$0.0336');
  });

  it('a client refresh that fails keeps the held rows and says so', async () => {
    let fail = false;
    serve(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve([lakeRow()])));
    const { unmount } = await mount();
    unmount();
    fail = true;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
    await mount();
    now.mockRestore();
    expect(item('Nano Banana 2.1')).toHaveTextContent(/couldn't refresh/);
  });

  it('a server-side registry fallback row (no fetch time) never claims OpenRouter or a refresh time', async () => {
    serve([lakeRow({ price: { '1K': { usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22' } }, fetchedAt: {}, stale: true })]);
    await mount();
    const nb = item('Nano Banana 2.1');
    expect(nb).not.toHaveTextContent('OpenRouter');
    expect(nb).not.toHaveTextContent("couldn't refresh");
    expect(nb).toHaveTextContent('from our price list, 2026-10-22');
    // The size line labels the fallback list price with its own source.
    expect(within(nb).getByRole('list', { name: 'Nano Banana 2.1 by size' })).toHaveTextContent('1K: real ≈$0.0428 per image (n = 9, $0.0373–$0.0538) · list $0.0336 (from our price list, 2026-10-22)');
  });

  it('a live row whose sizes fell back to the registry names each source; the footer dates only live prices', async () => {
    serve([
      lakeRow({
        price: {
          '1K': { usd: 0.0336, basis: 'registry', note: 'from our price list, 2026-10-22 · OpenRouter: billed per token; tokens per image not published' },
          '2K': { usd: 0.0504, basis: 'vendor_table', note: '1680 tokens × $30/M (Google token table)' }
        }
      })
    ]);
    await mount();
    const sizes = within(item('Nano Banana 2.1')).getByRole('list', { name: 'Nano Banana 2.1 by size' });
    expect(sizes).toHaveTextContent('list $0.0336 (from our price list, 2026-10-22)');
    expect(sizes).toHaveTextContent('list $0.0504 (vendor token table)');
    expect(item('Nano Banana 2.1')).toHaveTextContent(/Prices: OpenRouter, (Oct 29, )?\d\d:30/);
  });

  it('fetch failed, no cache → registry facts "from our price list, {factsAsOf}" and "No uptime data right now"', async () => {
    serve(() => Promise.reject(Object.assign(new Error('Server error'), { status: 500 })));
    await mount();
    const nb = item('Nano Banana 2.1');
    const spec = getImageModel(LAKE_MODEL)!;
    expect(nb).toHaveTextContent(`from our price list, ${spec.factsAsOf}`);
    expect(nb).toHaveTextContent(NO_UPTIME_COPY);
    expect(within(nb).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('no endpoints → "No uptime data right now"; no leaderboard → "Not ranked on public leaderboards yet"; observed n < 3 → no real-cost line', async () => {
    serve([lakeRow({ endpoints: [], quality: [], observed: [{ kind: 'page', res: '1K', n: 2, medianUsd: 0.05, minUsd: 0.04, maxUsd: 0.06, from: '', to: '', scope: 'you' }] })]);
    await mount();
    const nb = item('Nano Banana 2.1');
    expect(within(nb).getByRole('list', { name: 'Providers and uptime' })).toHaveTextContent(NO_UPTIME_COPY);
    expect(within(nb).getByRole('list', { name: 'Providers and uptime' }).textContent).not.toMatch(NUMBER);
    expect(within(nb).getByRole('list', { name: 'Leaderboards' })).toHaveTextContent(NOT_RANKED_COPY);
    expect(within(nb).queryByRole('list', { name: 'Observed cost' })).toBeNull();
  });

  it('governed viewers read usage shares and never a price note or a dollar sign', async () => {
    serve([lakeRow()]);
    const doc = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((e) => ({ ...e, byok: false }));
    });
    const { container } = await mount(doc, { money: governed, pro: true });
    expect(container.textContent).not.toMatch(/\$/);
    expect(item('Nano Banana 2.1')).toHaveTextContent(/of your usage/);
  });
});
