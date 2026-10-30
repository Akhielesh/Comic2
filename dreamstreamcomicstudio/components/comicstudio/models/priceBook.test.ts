// The client price book follows models.md §2.3 as the server does: live list → registry → none; references on the
// list basis only; observed medians from n ≥ 3 (the user's own first); never under the list. With it, shared
// redrawQuote gives the confirm's numbers for the f8312c86-shaped comic (§3.5 Example 1, with the default QC).

import { describe, expect, it } from 'vitest';
import type { Resolution } from '../../../shared/comic/doc';
import type { ObservedEntry } from '../../../shared/comic/modelCatalog';
import { redrawQuote, type PriceBook } from '../../../shared/comic/modelLock';
import { QC_USD_PER_PAGE, type ImageJobKind } from '../../../shared/comic/models';
import { clientPriceBook, registryPrice } from './priceBook';
import { registryCatalogRows } from './modelsApi';
import { NOW, catalogRows, lakeDoc } from './testing/fixtures';
import { getImageModel } from '../../../shared/comic/models';

describe('clientPriceBook', () => {
  it('uses the live list price and labels it with OpenRouter and the fetch time (no dollar in the label)', () => {
    const book = clientPriceBook(catalogRows(), { now: NOW });
    expect(book.quote('nano-banana-pro', '1K', 'page')).toMatchObject({ usd: 0.1344, source: 'list', label: 'OpenRouter, 5 min ago' });
    expect(book.unit('nano-banana-pro', '1K', 'page').basis).not.toMatch(/\$/);
  });

  it('falls back to the registry with its date, and to no price at all (null, never a guess)', () => {
    const book = clientPriceBook([], { now: NOW });
    expect(book.quote('nano-banana-2.1', '2K', 'page')).toMatchObject({ usd: 0.0504, source: 'registry', label: 'from our price list, 2026-10-22' });
    // GPT Image 2.5 has one fixed size: no 2K list anywhere.
    expect(book.quote('gpt-image-2.5', '2K', 'page')).toMatchObject({ usd: null, source: 'none' });
    expect(book.pagePrice('gpt-image-2.5', '2K', false)).toBeNull();
    // A live null (Seedream 2K) is not replaced by an invented number.
    expect(clientPriceBook(catalogRows(), { now: NOW }).quote('seedream-5-pro', '2K', 'page').usd).toBeNull();
    expect(registryPrice(getImageModel('seedream-5-pro')!, '2K')).toBeNull();
  });

  it('adds references to the list basis only, at the published per-reference price', () => {
    const book = clientPriceBook(catalogRows(), { now: NOW });
    expect(book.quote('seedream-5-pro', '1K', 'page', 4).usd).toBe(0.057); // 0.045 + 4 × 0.003
    // Unpublished per-reference price: nothing is added (and nothing invented).
    expect(book.quote('nano-banana-2.1', '1K', 'page', 4).usd).toBe(0.0336);
  });

  it('uses the observed median only from n ≥ 3 and never under the list', () => {
    const above = clientPriceBook(catalogRows({ observed: { n: 4, median: 0.0434, min: 0.043, max: 0.054 } }), { now: NOW });
    expect(above.quote('nano-banana-2.1', '1K', 'page')).toMatchObject({ usd: 0.0434, source: 'observed', label: 'your last 4 pages', listUsd: 0.0336 });
    const few = clientPriceBook(catalogRows({ observed: { n: 2, median: 0.06, min: 0.05, max: 0.07 } }), { now: NOW });
    expect(few.quote('nano-banana-2.1', '1K', 'page')).toMatchObject({ usd: 0.0336, source: 'list' });
    const below = clientPriceBook(catalogRows({ observed: { n: 7, median: 0.02, min: 0.019, max: 0.021 } }), { now: NOW });
    expect(below.quote('nano-banana-2.1', '1K', 'page').usd).toBe(0.0336);
  });

  it('a stale catalog says so in the label', () => {
    const book = clientPriceBook(catalogRows({ stale: true, ageMs: 3 * 3_600_000 }), { now: NOW });
    expect(book.quote('nano-banana-2.1', '1K', 'page').label).toBe("OpenRouter as of 3 h ago · couldn't refresh");
  });

  it('pagePrice = (unit + QC) × markup unless BYOK', () => {
    const book = clientPriceBook(catalogRows(), { now: NOW });
    expect(book.pagePrice('nano-banana-2.1', '1K', true)).toBe(0.0366);
    expect(book.pagePrice('nano-banana-2.1', '1K', false)).toBe(Math.round((0.0336 + QC_USD_PER_PAGE) * 1.3 * 10000) / 10000);
  });

  it('with shared redrawQuote: the f8312c86-shaped comic switching to Nano Banana Pro (§3.5 Example 1, default QC)', () => {
    const doc = lakeDoc();
    const book = clientPriceBook(catalogRows(), { now: NOW });
    // 5 pages × (0.1344 + 0.003) + cover 0.1344 = 0.8214 (BYOK); + 4 sheets × 0.1344 = 1.359.
    expect(redrawQuote(doc, 'nano-banana-pro', 'pages_cover', book, true).usd).toBe(0.8214);
    expect(redrawQuote(doc, 'nano-banana-pro', 'all', book, true).usd).toBe(1.359);
    // Not BYOK: × 1.3.
    expect(redrawQuote(doc, 'nano-banana-pro', 'pages_cover', book, false).usd).toBe(1.0678);
    expect(redrawQuote(doc, 'nano-banana-pro', 'all', book, false).usd).toBe(1.7667);
    expect(redrawQuote(doc, 'nano-banana-pro', 'none', book, false).usd).toBe(0);
    // A unit with no basis makes the whole total null (the UI shows no number): GPT Image 2.5 has no 2K price.
    const standard = lakeDoc();
    standard.settings = { ...standard.settings, quality: 'standard' };
    expect(redrawQuote(standard, 'gpt-image-2.5', 'pages_cover', book, false).usd).toBeNull();
  });

  it('uses the QC per page the server serves, so the confirm quote equals the server’s (§3.5 Example 1, observed QC)', () => {
    const doc = lakeDoc();
    // The server's PriceBook quotes QC at the observed median ($0.0049, n = 7) and serves it on the catalog rows.
    const served = catalogRows().map((r) => ({ ...r, qcUsd: 0.0049 }));
    const book = clientPriceBook(served, { now: NOW });
    expect(book.qcUsd).toBe(0.0049);
    // 6 × 0.1344 + 5 × 0.0049 = $0.83 (BYOK); × 1.3 = $1.08 (§3.5). The server recomputes with the same shared
    // redrawQuote (models.md §3.4 item 7.7), which rounds each line: 0.9054 + 0.1747 = 1.0801.
    expect(redrawQuote(doc, 'nano-banana-pro', 'pages_cover', book, true).usd).toBe(0.8309);
    expect(redrawQuote(doc, 'nano-banana-pro', 'pages_cover', book, false).usd).toBe(1.0801);
    expect(book.pagePrice('nano-banana-2.1', '1K', true)).toBe(0.0385); // 0.0336 + 0.0049
    // Without a served figure (or a malformed one): the default.
    expect(clientPriceBook(catalogRows(), { now: NOW }).qcUsd).toBe(QC_USD_PER_PAGE);
    expect(clientPriceBook(catalogRows().map((r) => ({ ...r, qcUsd: -1 })), { now: NOW }).qcUsd).toBe(QC_USD_PER_PAGE);
    // An explicit figure wins.
    expect(clientPriceBook(served, { now: NOW, qcUsd: 0.004 }).qcUsd).toBe(0.004);
  });

  it('the registry rows give the same prices as the registry fallback', () => {
    const book = clientPriceBook(registryCatalogRows(), { now: NOW });
    expect(book.quote('nano-banana-pro', '2K', 'page')).toMatchObject({ usd: 0.1344, source: 'registry' });
  });

  it("a Ship 2 'panel' quote reads the observed median of panel calls; every other quote is byte-identical", () => {
    // What the catalog serves once the server records panel calls (ObservedKind does not list 'panel' yet).
    const panelSeen = { kind: 'panel' as unknown as ObservedEntry['kind'], res: '1K', n: 5, medianUsd: 0.0412, minUsd: 0.039, maxUsd: 0.05, from: '2026-10-19T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z', scope: 'you' } satisfies ObservedEntry;
    const withPanels = catalogRows().map((r) => (r.id === 'nano-banana-2.1' ? { ...r, observed: [...r.observed, panelSeen] } : r));
    const book = clientPriceBook(withPanels, { now: NOW });
    expect(book.quote('nano-banana-2.1', '1K', 'panel')).toEqual({
      usd: 0.0412,
      source: 'observed',
      label: 'your last 5 panels',
      listUsd: 0.0336,
      observed: panelSeen,
      priceBasis: 'vendor_table'
    });
    // Through the shared PriceBook contract (what redrawQuote and the insights read).
    const shared: PriceBook = book;
    expect(shared.unit('nano-banana-2.1', '1K', 'panel')).toEqual({ usd: 0.0412, basis: 'your last 5 panels' });
    // No panel observations: a panel is priced on the list, never on a page's median.
    const pagesSeen = clientPriceBook(catalogRows({ observed: { n: 4, median: 0.0434, min: 0.043, max: 0.054 } }), { now: NOW });
    expect(pagesSeen.quote('nano-banana-2.1', '1K', 'panel')).toMatchObject({ usd: 0.0336, source: 'list' });
    // A panel observation never prices anything else: every existing kind quotes exactly as without it.
    const plain = clientPriceBook(catalogRows(), { now: NOW });
    const kinds: ImageJobKind[] = ['style_option', 'sheet', 'place', 'page', 'edit', 'cover'];
    const resolutions: Resolution[] = ['512', '1K', '2K', '4K'];
    for (const row of catalogRows())
      for (const res of resolutions)
        for (const kind of kinds) {
          expect(JSON.stringify(book.quote(row.id, res, kind, 2))).toBe(JSON.stringify(plain.quote(row.id, res, kind, 2)));
          expect(JSON.stringify(book.unit(row.id, res, kind))).toBe(JSON.stringify(plain.unit(row.id, res, kind)));
        }
    expect(book.pagePrice('nano-banana-2.1', '1K', false)).toBe(plain.pagePrice('nano-banana-2.1', '1K', false));
    expect(redrawQuote(lakeDoc(), 'nano-banana-2.1', 'all', book, false)).toEqual(redrawQuote(lakeDoc(), 'nano-banana-2.1', 'all', plain, false));
  });
});
