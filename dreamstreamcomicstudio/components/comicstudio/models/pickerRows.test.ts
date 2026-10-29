// Picker order and selection (models.md §2.4 R2, §3.7): fit first (blocked rows at the bottom, models that cannot
// hold the comic below those that can), then quality, price, resilience; Easy shows at most 3 models a user may pick,
// keeping the suggested and the current model in view; the footer names its sources and dates.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities';
import { buildPickerRows, currentModelId, easyPickerRows, footerSources, isLocked, sortPickerRows, type PickerRowModel } from './pickerRows';
import { clientPriceBook } from './priceBook';
import { NOW, catalogRows, freshDoc, lakeDoc } from './testing/fixtures';

const PAID: StudioCaps = { ...DEFAULT_CAPS, plan: 'paid', modelOverride: true, qualityTiers: ['draft', 'standard', 'pro'] };

const rowsFor = (doc = lakeDoc(), caps: StudioCaps = PAID, suggest?: string) => {
  const rows = catalogRows();
  const prices = clientPriceBook(rows, { now: NOW });
  return buildPickerRows({ doc, caps, rows, prices, byok: false, suggest });
};
const ids = (rows: PickerRowModel[]) => rows.map((r) => r.id);

describe('buildPickerRows', () => {
  it('marks current, default, experimental and suggested; blocked rows carry their reasons', () => {
    const rows = rowsFor(lakeDoc(), PAID, 'nano-banana-pro');
    const nb = rows.find((r) => r.id === 'nano-banana-2.1')!;
    const pro = rows.find((r) => r.id === 'nano-banana-pro')!;
    const gpt = rows.find((r) => r.id === 'gpt-image-2.5')!;
    expect(nb).toMatchObject({ current: true, isDefault: true, disabled: false, providers: 1, uptime1d: 97.72, pageRes: '1K' });
    expect(pro).toMatchObject({ current: false, suggested: true, disabled: false, providers: 3, characters: 5 });
    // The price warning against the comic's model (shared modelFit with the price book).
    expect(pro.warns.map((w) => w.text)).toContain('About 4× the price of Nano Banana 2.1 per page');
    expect(gpt.disabled).toBe(true);
    expect(gpt.experimental).toBe(true);
    expect(gpt.blocks.map((b) => b.text)).toEqual(expect.arrayContaining(['Not available in Comic Studio yet', "Can't draw 4:5 pages"]));
    // GPT Image 2.5 draws one fixed size: its price is quoted at 1K.
    expect(gpt.pageRes).toBe('1K');
  });

  it('a free plan sees Nano Banana Pro listed but blocked, with the honest reason', () => {
    const pro = rowsFor(lakeDoc(), DEFAULT_CAPS).find((r) => r.id === 'nano-banana-pro')!;
    expect(pro.disabled).toBe(true);
    expect(pro.blocks.map((b) => b.text)).toContain('Needs a paid plan or your own key');
  });

  it('before the lock, "current" is the model the pages would draw with', () => {
    const doc = freshDoc();
    expect(isLocked(doc)).toBe(false);
    expect(currentModelId(doc)).toBe('nano-banana-2.1');
    doc.settings = { ...doc.settings, imageModelOverride: 'nano-banana-pro' };
    expect(currentModelId(doc)).toBe('nano-banana-pro');
    expect(rowsFor(doc).find((r) => r.current)?.id).toBe('nano-banana-pro');
  });
});

describe('sortPickerRows (R2)', () => {
  it('fit, then quality: the comic’s model ranks above Nano Banana Pro; blocked rows last', () => {
    expect(ids(sortPickerRows(rowsFor()))).toEqual(['nano-banana-2.1', 'nano-banana-pro', 'gpt-image-2.5', 'seedream-5-pro']);
  });

  it('a model that cannot hold the page drops below one that can (5 characters on page 3)', () => {
    expect(ids(sortPickerRows(rowsFor(lakeDoc({ page3Cast: 5 }))).slice(0, 2))).toEqual(['nano-banana-pro', 'nano-banana-2.1']);
  });

  it('sortable by price, quality and reliability (blocked rows still last)', () => {
    const rows = rowsFor();
    expect(ids(sortPickerRows(rows, 'price')).slice(0, 2)).toEqual(['nano-banana-2.1', 'nano-banana-pro']);
    expect(ids(sortPickerRows(rows, 'reliability')).slice(0, 2)).toEqual(['nano-banana-pro', 'nano-banana-2.1']);
    expect(ids(sortPickerRows(rows, 'quality')).slice(-2)).toEqual(['gpt-image-2.5', 'seedream-5-pro']);
  });
});

describe('easyPickerRows', () => {
  it('shows at most 3 models a user may pick (hidden models only in "Compare all")', () => {
    expect(ids(easyPickerRows(sortPickerRows(rowsFor())))).toEqual(['nano-banana-2.1', 'nano-banana-pro']);
    const many = sortPickerRows(rowsFor()).map((r) => ({ ...r, pickable: true }));
    expect(easyPickerRows(many)).toHaveLength(3);
  });

  it('keeps the suggested model in view even when it ranks 4th', () => {
    const many = sortPickerRows(rowsFor(lakeDoc(), PAID, 'seedream-5-pro')).map((r) => ({ ...r, pickable: true }));
    const easy = easyPickerRows(many);
    expect(easy).toHaveLength(3);
    expect(ids(easy)).toContain('seedream-5-pro');
    expect(ids(easy)).toContain('nano-banana-2.1'); // the current model stays too
  });
});

describe('footerSources', () => {
  it('names OpenRouter with the fetch time and each board with its date (AA "via OpenRouter" only when it is)', () => {
    expect(footerSources(catalogRows(), NOW, '2026-10-22')).toEqual({
      prices: 'OpenRouter, 5 min ago',
      rankings: ['LMArena (Oct 20, 2026)', 'Artificial Analysis (Oct 22, 2026)']
    });
    const via = catalogRows().map((r) => ({ ...r, quality: r.quality.map((q) => (q.board === 'aa_edit' ? { ...q, source: 'OpenRouter benchmarks API (aa_edit)' } : q)) }));
    expect(footerSources(via, NOW, '2026-10-22').rankings[1]).toBe('Artificial Analysis via OpenRouter (Oct 22, 2026)');
  });

  it('without live data: the registry price list with its date, no rankings', () => {
    expect(footerSources([], NOW, '2026-10-22')).toEqual({ prices: 'from our price list, 2026-10-22', rankings: [] });
    expect(footerSources(catalogRows({ stale: true, ageMs: 7_200_000 }), NOW, '2026-10-22').prices).toBe("OpenRouter, as of 2 h ago · couldn't refresh");
  });
});
