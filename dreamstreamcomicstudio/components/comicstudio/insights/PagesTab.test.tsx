// Pages tab (models.md §4.2, §5.1 acceptance): one row per drawn target with spend, versions, model and size,
// quiet badges for mixed sizes / older models, and a redraw quote on the locked model — no request of its own.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/apiClient', () => ({ get: getMock }));

import { getImageModel, QC_USD_PER_PAGE } from '../../../shared/comic/models';
import { LAKE_MODEL, makeLakeComic } from '../../../shared/comic/__fixtures__/lakeComic';
import { DOLLAR_CONTEXT } from '../../../services/costDisplay';
import { costFormat } from '../conversation/cost';
import { insightsMoney } from './insightsModel';
import { PagesTab, insightsPriceBook } from './PagesTab';

const dollars = insightsMoney(costFormat(DOLLAR_CONTEXT));
const governed = insightsMoney(costFormat({ governed: true, pctPerUsd: 20 }));
const row = (label: string) => screen.getByRole('listitem', { name: label });

describe('Pages tab', () => {
  it('acceptance: page 1 at 2K, pages 2–5 at 1K; spend, versions, model and size per row; no request', () => {
    render(<PagesTab doc={makeLakeComic()} money={dollars} byok />);
    const rows = within(screen.getByRole('list', { name: 'Spend per page' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Cover', 'Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5', 'THE BABY sheet', 'DUCKLINGS sheet', 'FROG sheet', 'BUNNY sheet']);
    expect(within(row('Page 1')).getByText('2K')).toBeInTheDocument();
    for (const n of [2, 3, 4, 5]) {
      expect(within(row(`Page ${n}`)).getByText('1K')).toBeInTheDocument();
      expect(within(row(`Page ${n}`)).queryByText('2K')).toBeNull();
    }
    expect(row('Page 1')).toHaveTextContent('Nano Banana 2.1 · 1856×2304 (4:5) · 2 versions');
    expect(row('Page 1')).toHaveTextContent('$0.1277 spent'); // two renders + two QC passes, from the ledger
    expect(getMock).not.toHaveBeenCalled();
  });

  it('a redraw is quoted on the locked model from the registry list, never under this comic’s observed cost', () => {
    render(<PagesTab doc={makeLakeComic()} money={dollars} byok />);
    // Page 2 is 1K: observed median $0.047 (n = 4) beats the $0.0336 list → $0.047 + QC.
    expect(QC_USD_PER_PAGE).toBe(0.003);
    expect(row('Page 2')).toHaveTextContent('Redraw now on Nano Banana 2.1: ≈$0.05');
    const spec = getImageModel(LAKE_MODEL)!;
    expect(document.body).toHaveTextContent(`from our price list, ${spec.factsAsOf}`);
    const book = insightsPriceBook(makeLakeComic(), null);
    expect(book.unit(LAKE_MODEL, '2K', 'sheet')).toEqual({ usd: spec.priceUsd['2K'], basis: 'registry' }); // no sheet calls at 2K → list
  });

  it('an older-model page and mixed sizes get quiet badges; held catalog rows price the redraw', () => {
    const doc = makeLakeComic((d) => {
      d.pages[2].render.asset!.model = 'nano-banana-pro';
    });
    const rows = [{ id: LAKE_MODEL, price: { '1K': { usd: 0.05, basis: 'openrouter_endpoint' } }, fetchedAt: { catalog: '2026-10-29T10:00:00Z' } }] as never;
    render(<PagesTab doc={doc} money={dollars} byok rows={rows} />);
    expect(within(row('Page 3')).getByText('older model')).toBeInTheDocument();
    expect(document.body).toHaveTextContent(/OpenRouter, (Oct 29, )?\d\d:00/);
  });

  it('governed viewers never see dollars; platform redraws carry the markup into the share', () => {
    const doc = makeLakeComic((d) => {
      d.spend.entries = d.spend.entries.map((e) => ({ ...e, byok: false }));
    });
    const { container } = render(<PagesTab doc={doc} money={governed} byok={false} />);
    expect(container.textContent).not.toMatch(/\$/);
    expect(row('Page 2')).toHaveTextContent(/Redraw now on Nano Banana 2\.1: (≈[\d.]+%|<0\.1%) of your usage/);
  });

  it('rows stack below 480 px (one column) and long words wrap', () => {
    render(<PagesTab doc={makeLakeComic()} money={dollars} byok />);
    for (const li of within(screen.getByRole('list', { name: 'Spend per page' })).getAllByRole('listitem')) {
      expect(li.className).toContain('min-[480px]:grid-cols-');
      expect(li.className).not.toMatch(/(^|\s)grid-cols-/);
    }
  });
});
