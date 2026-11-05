// CostInsights (models.md §4.1): the L1 cost card rows (Translate, failed only when n > 0, real cost per page only
// at n ≥ 3 with n and range, the lock line), the L2 tabs (inline for Pro, "More details" for Easy) with the WAI-ARIA
// tab keyboard model, governed users never reading dollars, and no horizontal overflow at 320 px.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock }));

import type { ComicDoc } from '../../../shared/comic/doc';
import { quoteRenderPages, summarizeBook } from '../../../shared/comic/plan';
import { makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { costFormat } from '../conversation/cost';
import { __resetStatusStore } from '../reliability/statusStore';
import { CostInsights } from './CostInsights';
import { PRICE_UNPUBLISHED_COPY } from './copy';
import { __resetInsightsCacheForTests } from './useInsights';

const NO_DOLLARS = /\$\s?\d|\$0\b|<\$/;

const mount = (doc: ComicDoc = makeLakeComic(), opts: { pro?: boolean; governed?: boolean; byok?: boolean } = {}) => {
  const byok = opts.byok ?? !opts.governed;
  const cost = costFormat(opts.governed ? { governed: true, pctPerUsd: 20 } : DOLLAR_CONTEXT);
  const book = summarizeBook(doc, { byok, rating: 'PG-13' });
  const quote = quoteRenderPages(doc, { byok, tier: doc.settings.quality });
  const runClientAction = vi.fn();
  const utils = render(
    <CostInsights doc={doc} book={book} quote={quote} byok={byok} pro={opts.pro ?? false} cost={cost} coverLine="Drawn" runClientAction={runClientAction} />
  );
  return { ...utils, runClientAction };
};

const card = () => screen.getByRole('region', { name: 'Cost breakdown' });
const rowOf = (label: string | RegExp) => within(card()).getByText(label).closest('div')!;

beforeEach(() => {
  getMock.mockReset();
  getMock.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/comic/models/catalog') ? [] : path.includes('/trends') ? {} : []));
  __resetInsightsCacheForTests();
  __resetStatusStore();
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('L1 — the cost card', () => {
  it('lists Translate in "Where it went" when the comic paid for translation', () => {
    mount(makeLakeComic((d) => { d.spend.byKind.translate = 0.02; }));
    const where = within(card()).getByRole('list', { name: 'Where it went' });
    expect(within(where).getByText('Translations')).toBeInTheDocument();
    expect(within(where).getByText('$0.02')).toBeInTheDocument();
  });

  it('a governed viewer\'s "Where it went" overline keeps "· share of your usage" whole (it breaks at the dot on a phone, never mid-phrase)', () => {
    mount(makeLakeComic((d) => { d.spend.byKind.translate = 0.02; }), { governed: true });
    const suffix = within(card()).getByText('· share of your usage');
    expect(suffix.tagName).toBe('SPAN');
    expect(suffix).toHaveClass('whitespace-nowrap');
    expect(suffix.parentElement).toHaveTextContent(/^Where it went · share of your usage$/);
  });

  it('the failed-attempts row is hidden at 0 and shows "{n} · {$}" when there were failures', () => {
    const { unmount } = mount();
    expect(within(card()).queryByText('Failed attempts')).toBeNull();
    unmount();
    mount(makeLakeComic((d) => { d.spend.failed = { count: 2, usd: 0 }; }));
    expect(rowOf('Failed attempts')).toHaveTextContent('Failed attempts');
    expect(within(card()).getByText('2 · $0')).toBeInTheDocument();
    expect(within(card()).getByText('Nothing was charged for them.')).toBeInTheDocument();
  });

  it('observed cost: "Real cost per page" shows n and the range next to the list price; hidden below 3', () => {
    const { unmount } = mount();
    const label = within(card()).getByText('Real cost per page');
    const row = label.closest('div')!;
    expect(row).toHaveTextContent('≈$0.047');
    expect(row).toHaveTextContent('(your last 4: $0.0428–$0.0538) · list $0.0336 (from our price list, 2026-10-22) · Nano Banana 2.1 at 1K');
    unmount();
    mount(makeLakeComic((d) => { d.spend.entries = d.spend.entries.filter((e) => !(e.res === '1K' && (e.label === 'Page 2' || e.label === 'Page 3'))); }));
    expect(within(card()).queryByText('Real cost per page')).toBeNull();
  });

  it('real cost on a model with no published per-image price at this size says so with the exact §4.6 copy', () => {
    // Seedream 5 Pro lists 1K only; Standard draws its pages at 2K.
    const doc = makeLakeComic((d) => {
      d.settings.quality = 'standard';
      d.imageModel = { modelId: 'seedream-5-pro', lockedAt: 1, origin: 'user_change' };
      for (let i = 0; i < 3; i += 1) {
        d.spend.entries.unshift({ id: `sd${i}`, at: 9e12 + i, kind: 'page', label: `Page ${i + 1}`, usd: 0.05 + i * 0.001, model: 'seedream-5-pro', byok: true, estimated: false, res: '2K', target: `page:pg_${i + 1}` });
      }
    });
    mount(doc);
    const row = within(card()).getByText('Real cost per page').closest('div')!;
    expect(row).toHaveTextContent(`(your last 3: $0.05–$0.052) · ${PRICE_UNPUBLISHED_COPY} · Seedream 5 Pro at 2K`);
  });

  it('the next page is priced like a quote: this comic’s observed median at n ≥ 3 (never under list), with its source', () => {
    const { unmount } = mount();
    const lockRow = within(card()).getByText('Drawn with Nano Banana 2.1 · locked for this comic').closest('div')!;
    // 1K pages: observed median $0.047 (n = 4) beats the $0.0336 list → $0.047 + QC $0.003, own key, no markup.
    expect(lockRow).toHaveTextContent('≈$0.05/page');
    expect(lockRow).toHaveTextContent('Draft quality · 1K · a page ≈$0.05 (your last 4) · cover ≈$0.03 (from our price list, 2026-10-22) · no markup on your key');
    expect(within(card()).getByText('Real cost per page').closest('div')!).toHaveTextContent('≈$0.047');
    unmount();
    // Below n = 3 the dated list price, × PLATFORM_MARKUP when the platform pays.
    mount(makeLakeComic((d) => { d.spend.entries = d.spend.entries.filter((e) => !(e.res === '1K' && (e.label === 'Page 2' || e.label === 'Page 3'))); }), { byok: false });
    const listRow = within(card()).getByText('Drawn with Nano Banana 2.1 · locked for this comic').closest('div')!;
    expect(listRow).toHaveTextContent('Draft quality · 1K · a page ≈$0.05 · cover ≈$0.04 · from our price list, 2026-10-22');
    expect(listRow).not.toHaveTextContent('your last');
  });

  it('the lock line (§3.6 A) with its lock icon; Change… opens the picker through the client action', () => {
    const { runClientAction } = mount();
    expect(within(card()).getByText('Drawn with Nano Banana 2.1 · locked for this comic')).toBeInTheDocument();
    expect(within(card()).getByRole('img', { name: 'Model locked so every page matches' })).toBeInTheDocument();
    fireEvent.click(within(card()).getByRole('button', { name: 'Change…' }));
    expect(runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker' });
  });

  it('held-back pages are never "drawn and up to date", and a price that leaves them out says so (A5 note 2)', () => {
    const doc = makeLakeComic();
    const cost = costFormat(DOLLAR_CONTEXT);
    const book = summarizeBook(doc, { byok: true, rating: 'PG-13' });
    const base = quoteRenderPages(doc, { byok: true, tier: doc.settings.quality, pageIds: [doc.pages[0].id], force: true });
    const props = { doc, book, byok: true, pro: false, cost, coverLine: 'Drawn', runClientAction: vi.fn() };
    const row = () => rowOf('To draw now');
    // Nothing to draw but two pages held back.
    const { rerender } = render(<CostInsights {...props} quote={{ ...base, usd: 0, lines: [], pageIds: [], sheetIds: [], cover: false, nothing: true, heldBackIds: ['pg_2', 'pg_3'] }} />);
    expect(row()).toHaveTextContent('Nothing yet');
    expect(row()).toHaveTextContent('2 pages held back — too many words for a panel, not in this price. Fix free or draw anyway.');
    expect(within(card()).queryByText('Every page here is drawn and up to date.')).toBeNull();
    // Something to draw, one page held back: the quote lines, then the held-back page.
    rerender(<CostInsights {...props} quote={{ ...base, heldBackIds: ['pg_3'] }} />);
    expect(row()).toHaveTextContent(cost.badge(base.usd));
    expect(within(row()).getByText(/ · 1 page held back \(not in this price\)$/)).toBeInTheDocument();
    // Nothing held back: the plain quote lines.
    rerender(<CostInsights {...props} quote={base} />);
    expect(row()).not.toHaveTextContent('held back');
  });

  it('saved by software is shown quietly with the owner’s words', () => {
    mount(makeLakeComic((d) => { d.spend.savedUsd = 0.05; }));
    expect(rowOf('Saved by software')).toHaveTextContent('Free — done by the editor, no AI cost.');
  });
});

describe('L2 — tabs', () => {
  it('Easy: no tabs inline; "More details" opens them in a sheet', async () => {
    mount();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: 'More details' }));
    const sheet = screen.getByRole('dialog', { name: 'Cost details' });
    expect(within(sheet).getByRole('tablist', { name: 'Cost details' })).toBeInTheDocument();
    expect(within(sheet).getByRole('tabpanel')).toHaveTextContent('Spent on this comic$0.7918');
    await act(async () => {});
  });

  it('Pro: tabs inline; arrow keys move and select (wrapping), Home/End jump, one Tab stop (roving tabindex)', async () => {
    mount(makeLakeComic(), { pro: true });
    const tabs = within(screen.getByRole('tablist', { name: 'Cost details' })).getAllByRole('tab');
    const selected = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true')!.textContent;
    const stops = () => tabs.filter((t) => t.tabIndex === 0).map((t) => t.textContent);
    expect(selected()).toBe('Overview');
    expect(stops()).toEqual(['Overview']);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(selected()).toBe('Pages');
    expect(document.activeElement).toBe(tabs[1]);
    expect(stops()).toEqual(['Pages']);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs[1].id);
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(selected()).toBe('Trends');
    fireEvent.keyDown(tabs[3], { key: 'ArrowRight' });
    expect(selected()).toBe('Overview'); // wraps
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(selected()).toBe('Trends'); // wraps back
    fireEvent.keyDown(tabs[3], { key: 'Home' });
    expect(selected()).toBe('Overview');
    expect(document.activeElement).toBe(tabs[0]);
    await act(async () => {});
  });

  it('the Models tab’s "Details…" dispatches open_model_picker with that model as suggest (never a switch)', async () => {
    const { runClientAction } = mount(makeLakeComic(), { pro: true });
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Details… about Nano Banana 2.1' }));
    expect(runClientAction).toHaveBeenCalledWith({ type: 'open_model_picker', suggest: 'nano-banana-2.1' });
    expect(runClientAction).toHaveBeenCalledTimes(1);
  });

  it('only the open tab is mounted: the catalog is asked when Models opens, the trends when Trends opens', async () => {
    mount(makeLakeComic(), { pro: true });
    await act(async () => {});
    expect(getMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/comic/models/catalog'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await act(async () => {});
    expect(getMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/comic/models/catalog'))).toHaveLength(1);
    expect(getMock.mock.calls.filter((c) => String(c[0]).includes('/trends'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Trends' }));
    await act(async () => {});
    expect(getMock.mock.calls.filter((c) => String(c[0]).includes('/trends'))).toHaveLength(1);
  });
});

describe('governed users never see dollars', () => {
  it('in the card and every tab', async () => {
    const doc = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((e) => ({ ...e, byok: false }));
      d.spend.failed = { count: 1, usd: 0.01 };
      d.spend.savedUsd = 0.05;
      d.spend.byKind.translate = 0.02;
    });
    const { container } = mount(doc, { pro: true, governed: true });
    expect(container.textContent).not.toMatch(NO_DOLLARS);
    expect(within(card()).getByText('Real cost per page').closest('div')!).toHaveTextContent(/of your usage/);
    for (const name of ['Pages', 'Models', 'Trends', 'Overview']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      await act(async () => {});
      expect(container.textContent, name).not.toMatch(NO_DOLLARS);
    }
  });
});

describe('no horizontal overflow at 320 px', () => {
  it('nothing has a fixed width over the viewport; rows wrap; tabs share the width; long words break', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    const { container } = mount(makeLakeComic(), { pro: true });
    const check = (what: string) => {
      for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
        const w = el.style?.width;
        if (w && w.endsWith('px')) expect(parseFloat(w), `${what}: inline width`).toBeLessThanOrEqual(320);
        const cls = typeof el.className === 'string' ? el.className : '';
        for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)) expect(Number(m[1]), `${what}: ${cls}`).toBeLessThanOrEqual(320);
        if (/(^|\s)whitespace-nowrap(\s|$)/.test(cls)) expect(cls, `${what}: nowrap must truncate`).toMatch(/truncate|min-w-0/);
      }
    };
    check('card');
    const tablist = screen.getByRole('tablist', { name: 'Cost details' });
    expect(tablist.className).toMatch(/grid-cols-4/);
    expect(tablist.className).toMatch(/min-w-0/);
    for (const t of within(tablist).getAllByRole('tab')) {
      expect(t.className).toMatch(/min-w-0/);
      expect(t.className).toMatch(/truncate/);
      expect(t.className).toMatch(/coarse:min-h-11/); // 44 px on touch
    }
    for (const name of ['Pages', 'Models', 'Trends']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      await act(async () => {});
      check(name);
    }
    // A model id has no spaces: it must be allowed to break.
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    await act(async () => {});
    const id = screen.getAllByText('nano-banana-2.1').find((el) => el.tagName === 'CODE')!;
    expect(id.className).toContain('[overflow-wrap:anywhere]');
  });
});
