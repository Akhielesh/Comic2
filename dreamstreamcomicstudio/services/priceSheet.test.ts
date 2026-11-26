// The person's price sheet (docs/features/pricing.md): when it reads (missing or stale on open, after a run settles,
// never on a timer), concurrent asks sharing one request, a failed read keeping the old sheet and waiting, an account
// switch starting over, and the book it builds being the shared one. Synthetic sheets only.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { priceBookFromSources, priceSheetOf, type PriceSheet } from '../shared/comic/priceBook';
import { get } from './apiClient';
import {
  PRICE_SHEET_FRESH_MS,
  PRICE_SHEET_PATH,
  PRICE_SHEET_RETRY_MS,
  __resetPriceSheetForTests,
  __setPriceSheetClockForTests,
  notePriceSheetActivity,
  priceSheetFor,
  refreshPriceSheet,
  usePriceBook
} from './priceSheet';

vi.mock('./apiClient', () => ({ get: vi.fn() }));
const fetchSheet = vi.mocked(get);

const T0 = Date.parse('2026-11-20T12:00:00Z');
let now = T0;
const sheet = (pageUsd = 0.05): PriceSheet =>
  priceSheetOf(
    {
      rows: [{ id: 'nano-banana-2.1', price: { '1K': { usd: 0.0336, basis: 'openrouter_endpoint', note: 'endpoints differ: A $0.03 · B $0.04' } }, perRefUsd: 0.0003 }],
      observed: [{ modelId: 'nano-banana-2.1', kind: 'page', res: '1K', n: 4, medianUsd: pageUsd, minUsd: pageUsd, maxUsd: pageUsd, scope: 'you' }],
      qc: null,
      text: null
    },
    T0
  );
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetPriceSheetForTests();
  now = T0;
  __setPriceSheetClockForTests(() => now);
  fetchSheet.mockReset();
  fetchSheet.mockImplementation(async () => sheet() as never);
});
afterEach(() => vi.useRealTimers());

describe('when the sheet is read', () => {
  it('reads once for the owner (bearer only, the owner pinned), then not again while fresh', async () => {
    await refreshPriceSheet('owner-1');
    expect(fetchSheet).toHaveBeenCalledTimes(1);
    expect(fetchSheet).toHaveBeenCalledWith(PRICE_SHEET_PATH, { expectedAccountId: 'owner-1', authOnly: true });
    expect(priceSheetFor('owner-1').book?.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.05);
    now += PRICE_SHEET_FRESH_MS - 1;
    await refreshPriceSheet('owner-1');
    expect(fetchSheet).toHaveBeenCalledTimes(1);
    now += 2;
    await refreshPriceSheet('owner-1');
    expect(fetchSheet).toHaveBeenCalledTimes(2);
  });

  it('concurrent asks share one request', async () => {
    await Promise.all([refreshPriceSheet('owner-1'), refreshPriceSheet('owner-1'), refreshPriceSheet('owner-1')]);
    expect(fetchSheet).toHaveBeenCalledTimes(1);
  });

  it('a failed read keeps the sheet it had, and is not retried for two minutes', async () => {
    await refreshPriceSheet('owner-1');
    fetchSheet.mockRejectedValue(new Error('offline'));
    now += PRICE_SHEET_FRESH_MS + 1;
    await refreshPriceSheet('owner-1');
    expect(priceSheetFor('owner-1').book).toBeDefined();
    expect(priceSheetFor('owner-1').failedAt).toBe(now);
    const reads = fetchSheet.mock.calls.length;
    now += PRICE_SHEET_RETRY_MS - 1;
    await refreshPriceSheet('owner-1');
    expect(fetchSheet).toHaveBeenCalledTimes(reads);
  });

  it('a malformed answer is not a sheet (the quotes keep the registry list)', async () => {
    fetchSheet.mockResolvedValue({ v: 2 } as never);
    await refreshPriceSheet('owner-1');
    expect(priceSheetFor('owner-1').book).toBeUndefined();
    expect(priceSheetFor('owner-1').failedAt).toBeGreaterThan(0);
  });

  it('another account starts from nothing: one person\'s prices never price another\'s buttons', async () => {
    await refreshPriceSheet('owner-1');
    fetchSheet.mockImplementation(async () => sheet(0.09) as never);
    const pending = refreshPriceSheet('owner-2');
    expect(priceSheetFor('owner-1').book).toBeUndefined();
    await pending;
    expect(priceSheetFor('owner-2').book?.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.09);
  });

  it('a run that settles reads it again — once, however many views saw it', async () => {
    await refreshPriceSheet('owner-1');
    notePriceSheetActivity('owner-1', true);
    notePriceSheetActivity('owner-1', true);
    expect(fetchSheet).toHaveBeenCalledTimes(1);
    notePriceSheetActivity('owner-1', false);
    notePriceSheetActivity('owner-1', false);
    await flush();
    expect(fetchSheet).toHaveBeenCalledTimes(2);
  });

  it('nothing reads on a timer: an open view that does nothing makes no further request', async () => {
    vi.useFakeTimers();
    const Probe = () => {
      usePriceBook('owner-1');
      return null;
    };
    render(React.createElement(Probe));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSheet).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    });
    expect(fetchSheet).toHaveBeenCalledTimes(1);
  });

  it('no owner, no read', async () => {
    await refreshPriceSheet(null);
    expect(fetchSheet).not.toHaveBeenCalled();
  });
});

describe('the sheet itself', () => {
  it('carries no notes (some name dollars) and builds the same book as its sources', () => {
    const s = sheet();
    expect(JSON.stringify(s)).not.toContain('note');
    const direct = priceBookFromSources(s.sources);
    expect(direct.unit('nano-banana-2.1', '1K', 'page').usd).toBe(0.05);
    expect(direct.unit('nano-banana-2.1', '1K', 'sheet').usd).toBe(0.0336);
  });
});
