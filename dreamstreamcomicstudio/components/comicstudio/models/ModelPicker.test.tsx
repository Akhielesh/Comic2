// The model picker (models.md §3.6 B, §3.7, §4.6): Easy shows ≤ 3 models + "Compare all", Pro the full sortable
// table; every row shows its price, characters, providers/uptime with source and time, and leaderboards; rows that
// cannot be picked show why and never open the confirm; no "$" where there is no price, none at all for a governed
// user; the registry's dated facts when live data is missing; one request when it opens and none after (an hour of
// fake time passes with no fetch); axe clean, 44 px targets, nothing wider than a 320 px phone.

import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import type { ModelHealth } from '../../../shared/comic/modelHealth';
import type { ModelCatalogDetail, ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { __resetStatusStore, __setStatusFetcherForTests } from '../reliability/statusStore';
import { ModelPicker, ModelPickerPanel, type ModelPickerPanelProps } from './ModelPicker';
import { __resetModelCatalogForTests } from './useModelCatalog';
import { NOW, catalogRows, lakeDoc } from './testing/fixtures';

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', modelOverride: true, qualityTiers: ['draft', 'standard', 'pro'] };

const okHealth = (modelId: string): ModelHealth => ({ modelId, state: 'ok', checkedAt: NOW, routes: [] });

let statusFetches: string[][] = [];
let catalogFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  statusFetches = [];
  __resetStatusStore();
  __setStatusFetcherForTests(async (ids) => {
    statusFetches.push([...ids]);
    return ids.map(okHealth);
  });
  catalogFetch = vi.fn(async () => catalogRows());
  __resetModelCatalogForTests({ catalog: catalogFetch as unknown as (p?: string) => Promise<ModelCatalogRow[]> });
  showDollarPrices();
});

afterEach(() => {
  vi.useRealTimers();
  __setStatusFetcherForTests(null);
  resetUsageStatus();
});

const view = (rows: ModelCatalogRow[] | null = catalogRows(), extra: Partial<ModelPickerPanelProps['catalog']> = {}) => ({
  rows,
  loading: false,
  error: null,
  refresh: vi.fn(),
  ...extra
});

const panel = (props: Partial<ModelPickerPanelProps> = {}) => {
  const onPick = vi.fn();
  const utils = render(
    <ModelPickerPanel doc={lakeDoc()} caps={PAID} byok={false} mode="easy" catalog={view()} onPick={onPick} now={NOW} {...props} />
  );
  return { ...utils, onPick };
};

const rowOf = (id: string) => document.querySelector<HTMLElement>(`li[data-model="${id}"]`)!;
const listRows = () => within(screen.getByRole('list', { name: 'Image models' })).getAllByRole('listitem').filter((li) => li.hasAttribute('data-model'));

const axeViolations = async (el: HTMLElement) => {
  const res = await axe.run(el, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice', 'experimental'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'label-content-name-mismatch': { enabled: true } }
  });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.failureSummary).join(' | ')}`);
};

/** Every control is a 44 px target; nothing is laid out wider than a 320 px phone. */
const expectTouchAndWidth = (root: HTMLElement) => {
  for (const el of root.querySelectorAll<HTMLElement>('button, select, summary, a[href]')) {
    expect(el.className, `${el.tagName} "${el.textContent?.slice(0, 40)}" is a 44 px target`).toMatch(/(^|\s)(coarse:)?min-h-11(\s|$)/);
  }
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), `fixed width in "${cls}"`).toBeLessThanOrEqual(288);
    const w = parseFloat(el.style.width || el.style.minWidth || '0');
    expect(w, 'no inline width wider than the phone').toBeLessThanOrEqual(288);
  }
};

describe('Easy', () => {
  it('shows the locked subtitle and ≤ 3 rows, each with price, characters, providers + source/time and leaderboards', () => {
    panel();
    expect(screen.getByText('This comic is drawn with Nano Banana 2.1. Changing it can affect consistency.')).toBeInTheDocument();
    const rows = listRows();
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.map((r) => r.getAttribute('data-model'))).toEqual(['nano-banana-2.1', 'nano-banana-pro']);
    const nb = rowOf('nano-banana-2.1');
    expect(within(nb).getByText('Current')).toBeInTheDocument();
    expect(within(nb).getByText('Default')).toBeInTheDocument();
    expect(nb.querySelector('[data-line="price"]')).toHaveTextContent(/^≈\$0\.05 per page at 1K$/);
    expect(nb.querySelector('[data-line="characters"]')).toHaveTextContent('Holds 4 characters per image');
    expect(nb.querySelector('[data-line="uptime"]')).toHaveTextContent('1 provider · 97.7% up (24 h) · OpenRouter, 5 min ago');
    expect(nb.querySelector('[data-line="leaderboards"]')).toHaveTextContent('Leaderboards: LMArena edit #5 · AA edit #4');
    const pro = rowOf('nano-banana-pro');
    expect(pro.querySelector('[data-line="uptime"]')).toHaveTextContent('3 providers · 99.1% up (24 h)');
    expect(within(pro).getByText('About 4× the price of Nano Banana 2.1 per page')).toBeInTheDocument();
    expect(screen.getByText('Prices: OpenRouter, 5 min ago · Rankings: LMArena (Oct 20, 2026), Artificial Analysis (Oct 22, 2026)')).toBeInTheDocument();
  });

  it('"Compare all models" opens the full table in place: hidden models listed with their reasons', () => {
    panel();
    fireEvent.click(screen.getByRole('button', { name: 'Compare all models' }));
    expect(listRows()).toHaveLength(4);
    expect(screen.getByLabelText('Sort models by')).toBeInTheDocument();
    const gpt = rowOf('gpt-image-2.5');
    expect(within(gpt).getByText("Can't draw 4:5 pages")).toBeInTheDocument();
    expect(within(gpt).getByText('Not available in Comic Studio yet')).toBeInTheDocument();
    expect(within(gpt).getByText('Experimental')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the best fits' }));
    expect(listRows()).toHaveLength(2);
  });

  it('keeps a suggested model in view, highlighted, within the 3 rows', () => {
    panel({ suggest: 'seedream-5-pro' });
    const rows = listRows();
    expect(rows).toHaveLength(3);
    const s = rowOf('seedream-5-pro');
    expect(s).toHaveAttribute('data-suggested');
    expect(within(s).getByText('Suggested')).toBeInTheDocument();
  });
});

describe('picking', () => {
  it('a pickable row opens the confirm; disabled rows and the current model never do, and say why', () => {
    const { onPick } = panel({ caps: DEFAULT_CAPS });
    const pro = rowOf('nano-banana-pro');
    // The pick button's name is the visible name (+ badges); its lines and reasons describe it.
    const main = within(pro).getByRole('button', { name: 'Nano Banana Pro' });
    expect(main).toHaveAccessibleDescription(/Needs a paid plan or your own key/);
    expect(main).toHaveAttribute('aria-disabled', 'true');
    expect(within(pro).getByText('Needs a paid plan or your own key')).toBeInTheDocument();
    fireEvent.click(main);
    fireEvent.click(within(rowOf('nano-banana-2.1')).getByRole('button', { name: /^Nano Banana 2\.1/ }));
    expect(within(rowOf('nano-banana-2.1')).getByText('This comic already uses it.')).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('the current model keeps its blocking reason (free plan, legacy Nano Banana Pro lock — §3.9) and is not offered', () => {
    const { onPick } = panel({ caps: DEFAULT_CAPS, doc: lakeDoc({ model: 'nano-banana-pro' }) });
    const pro = rowOf('nano-banana-pro');
    expect(pro).toHaveAttribute('data-current');
    expect(within(pro).getByText('This comic already uses it.')).toBeInTheDocument();
    const reason = within(pro).getByText('Needs a paid plan or your own key');
    expect(reason.closest('[data-reason]')).toHaveAttribute('data-severity', 'block');
    const main = within(pro).getByRole('button', { name: /^Nano Banana Pro/ });
    expect(main).toHaveAccessibleDescription(/Needs a paid plan or your own key/);
    expect(main).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(main);
    expect(onPick).not.toHaveBeenCalled();
    // The model every plan may use is offered.
    expect(within(rowOf('nano-banana-2.1')).getByRole('button', { name: /^Nano Banana 2\.1/ })).not.toHaveAttribute('aria-disabled');
  });

  it('a paid user picks Nano Banana Pro', () => {
    const { onPick } = panel();
    fireEvent.click(within(rowOf('nano-banana-pro')).getByRole('button', { name: 'Nano Banana Pro' }));
    expect(onPick).toHaveBeenCalledWith('nano-banana-pro');
  });
});

describe('prices', () => {
  it('no "$" when there is no price: the §4.6 copy instead', () => {
    const doc = lakeDoc();
    doc.settings = { ...doc.settings, quality: 'standard' };
    panel({ doc, suggest: 'seedream-5-pro' });
    const s = rowOf('seedream-5-pro');
    expect(s.querySelector('[data-line="price"]')).toHaveTextContent("Price per image isn't published · you'll see the real cost after the first image");
    expect(s.textContent).not.toMatch(/\$/);
  });

  it('a governed user sees usage shares, never dollars', () => {
    showUsagePrices(1);
    const { container } = panel({ mode: 'pro', catalog: view(catalogRows({ observed: { n: 4, median: 0.0434, min: 0.043, max: 0.054 } })) });
    expect(container.textContent).not.toMatch(/\$/);
    expect(container.textContent).toMatch(/% of your usage per page at 1K/);
  });

  it('Pro: per-resolution prices, the real cost with its n and range, our reliability; sortable', () => {
    const { container } = panel({ mode: 'pro', catalog: view(catalogRows({ observed: { n: 4, median: 0.0434, min: 0.043, max: 0.054 } })) });
    const nb = rowOf('nano-banana-2.1');
    expect(nb.querySelector('[data-line="prices"]')).toHaveTextContent('Per page: 1K ≈$0.06 · 2K ≈$0.07 · 4K ≈$0.15');
    expect(nb.querySelector('[data-line="observed"]')).toHaveTextContent('Real cost, your last 4 pages: ≈$0.06 ($0.06–$0.07)');
    expect(nb.querySelector('[data-line="reliability"]')).toHaveTextContent('Your last 24 h: 12 calls · 1 failed · 1 rate-limited');
    // The price line names its basis when it is our observed median.
    expect(nb.querySelector('[data-line="price"]')).toHaveTextContent('· your last 4 pages');
    fireEvent.change(screen.getByLabelText('Sort models by'), { target: { value: 'reliability' } });
    expect(listRows()[0]).toHaveAttribute('data-model', 'nano-banana-pro');
    expect(container.querySelector('[data-mode="pro"]')).toBeTruthy();
    // Pro has no "Compare all" (it is the full table).
    expect(screen.queryByRole('button', { name: 'Compare all models' })).toBeNull();
  });
});

describe('missing live data (§4.6)', () => {
  it('falls back to the registry with its date, no uptime, the registry citations; Try again asks once', () => {
    const refresh = vi.fn();
    panel({ catalog: view(null, { error: 'offline', refresh }) });
    expect(screen.getByText("Couldn't load live prices or uptime right now, so these come from our price list, 2026-10-22.")).toBeInTheDocument();
    const nb = rowOf('nano-banana-2.1');
    expect(nb.querySelector('[data-line="price"]')).toHaveTextContent('≈$0.05 per page at 1K · from our price list, 2026-10-22');
    expect(nb.querySelector('[data-line="uptime"]')).toHaveTextContent(/^No uptime data right now$/);
    expect(nb.querySelector('[data-line="leaderboards"]')).toHaveTextContent('Leaderboards: AA Edit #4 · LMArena edit #5 (2026-10-22)');
    expect(screen.getByText('Prices: from our price list, 2026-10-22')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a model no board lists says so', () => {
    panel({ suggest: 'seedream-5-pro' });
    expect(rowOf('seedream-5-pro').querySelector('[data-line="leaderboards"]')).toHaveTextContent('Not ranked on public leaderboards yet');
    expect(rowOf('seedream-5-pro').querySelector('[data-line="uptime"]')).toHaveTextContent('No uptime data right now');
  });
});

describe('detail (L3) in place', () => {
  it('Details opens the model view with sources; Back returns to the list', async () => {
    const detail: ModelCatalogDetail = {
      ...catalogRows()[1],
      facts: { factsAsOf: '2026-10-22', priceBasis: 'per_token_table', refs: { total: 14, characters: 5, objects: 6, style: 3 }, aspects: ['2:3', '4:5'], resolutions: ['1K', '2K', '4K'] },
      priceHistory: [],
      qualityHistory: []
    };
    __resetModelCatalogForTests({ catalog: catalogFetch as never, detail: async () => detail });
    panel();
    fireEvent.click(screen.getByRole('button', { name: 'Details for Nano Banana Pro' }));
    await act(async () => undefined);
    const root = document.querySelector('[data-model-detail="nano-banana-pro"]') as HTMLElement;
    expect(within(root).getByText('Google Vertex: 98.4% up (24 h)')).toBeInTheDocument();
    expect(within(root).getByText(/LMArena edit #13 of 60/)).toBeInTheDocument();
    expect(within(root).getByText('Holds 5 characters per image · up to 14 reference images')).toBeInTheDocument();
    fireEvent.click(within(root).getByRole('button', { name: 'Back to the models' }));
    expect(listRows().length).toBeGreaterThan(0);
  });
});

describe('a11y and layout', () => {
  it('axe clean (Easy and the full table); 44 px targets; nothing wider than a phone', async () => {
    const { container } = panel();
    expect(await axeViolations(container)).toEqual([]);
    expectTouchAndWidth(container);
    fireEvent.click(screen.getByRole('button', { name: 'Compare all models' }));
    expect(await axeViolations(container)).toEqual([]);
    expectTouchAndWidth(container);
  });
});

describe('network (no timers; AT-8)', () => {
  it('one catalog request and one status request when it opens; an hour later, still none more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.setSystemTime(NOW);
    const doc = lakeDoc();
    const { rerender } = render(<ModelPicker open onClose={() => undefined} doc={doc} caps={PAID} byok={false} mode="easy" onPick={() => undefined} />);
    await act(async () => undefined);
    expect(catalogFetch).toHaveBeenCalledTimes(1);
    expect(catalogFetch).toHaveBeenCalledWith('proj_lake');
    expect(statusFetches).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(catalogFetch).toHaveBeenCalledTimes(1);
    expect(statusFetches).toHaveLength(1);
    // Closed: nothing is asked; reopened within the freshness window: the cached answer, no request.
    rerender(<ModelPicker open={false} onClose={() => undefined} doc={doc} caps={PAID} byok={false} mode="easy" onPick={() => undefined} />);
    expect(catalogFetch).toHaveBeenCalledTimes(1);
  });
});
