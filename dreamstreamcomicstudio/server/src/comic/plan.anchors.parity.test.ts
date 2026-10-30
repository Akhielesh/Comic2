// B4: the client quote equals the server estimate on books that carry Ship 2 consistency data, through the server's own
// estimate path (jobs.ts estimateSpendAction for render_pages, read-only). Without the anchors option (today's server
// call) plan.ts quotes exactly what the gate quotes; with anchors 'auto' the quote is the gate's lines plus the anchor
// lines, each priced the way the server prices that job (priceImageJobs), so once the server passes
// render_pages.anchors to quoteRenderPages (wave note) the gate and the card stay one number. The anchor lines come
// separately (RenderQuote.anchors.lines, tagged by kind), so the gate's PriceBook branch re-prices exactly them — the
// base has 0–3 lines, so a fixed-index slice of `lines` would drop or double-count anchor lines.
import { describe, expect, it } from 'vitest';
import { ANCHOR_SHEET_RES } from '../../../shared/comic/anchors.js';
import { harbourComic, lakeStory } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import { compatBooks } from '../../../shared/comic/__fixtures__/planCompat.js';
import type { ComicDoc, QualityTier } from '../../../shared/comic/doc.js';
import type { PriceBook } from '../../../shared/comic/modelLock.js';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel, imagePriceUsd, nearestResolution } from '../../../shared/comic/models.js';
import { quoteRenderPages, summarizeBook, type AnchorQuoteLine, type AnchorRunOptions } from '../../../shared/comic/plan.js';
import { estimateSpendAction, priceImageJobs, resolveJobFor, runPinOf } from './jobs.js';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const strip = (lines: AnchorQuoteLine[]) => lines.map(({ kind: _kind, ...l }) => l);

/** What K2b's PriceBook branch of estimateSpendAction(render_pages) does with the quote's anchor lines (wave note 2b). */
const repriceAnchorLines = (doc: ComicDoc, lines: AnchorQuoteLine[], byok: boolean, prices: PriceBook) => {
  const pin = runPinOf(doc);
  const markup = byok ? 1 : PLATFORM_MARKUP;
  return lines.map((l) => {
    if (l.kind === 'sheet') return priceImageJobs(doc, [{ kind: 'sheet', count: l.count, label: l.label }], byok, prices, pin).lines[0];
    if (l.kind === 'refs') return { label: l.label, count: l.count, usd: l.usd };
    const { spec } = resolveJobFor(pin, 'place');
    const res = nearestResolution(spec, ANCHOR_SHEET_RES);
    const unit = prices.unit(spec.id, res, 'place').usd ?? imagePriceUsd(spec, res);
    return { label: l.label, count: l.count, usd: r4(unit * l.count * markup) };
  });
};

/** A PriceBook at `factor` × the registry list price (QC as listed). */
const bookAt = (factor: number): PriceBook => ({
  unit: (modelId, res) => {
    const spec = getImageModel(modelId);
    return { usd: spec ? imagePriceUsd(spec, res) * factor : null, basis: `test ×${factor}` };
  },
  qcUsd: QC_USD_PER_PAGE
});
const books = (): Record<string, ComicDoc> => ({ ...compatBooks(), harbour: harbourComic(), lake: lakeStory() });
const tiers: QualityTier[] = ['draft', 'standard', 'pro'];
const clientOpts = (d: ComicDoc) => ({ tier: d.settings.quality, modelOverride: d.settings.imageModelOverride });

describe('client quote === server estimate (estimateSpendAction render_pages) on books with consistency data', () => {
  for (const [name, doc] of Object.entries(books())) {
    it(`${name}: every tier, payer, subset and force`, () => {
      const first = [...doc.pages].sort((a, b) => a.n - b.n)[0]?.id;
      const cases: { pageIds?: string[]; force?: boolean; includeCover?: boolean }[] = [
        {},
        { force: true },
        { includeCover: true },
        ...(first ? [{ pageIds: [first] }, { pageIds: [first], force: true }] : [])
      ];
      for (const tier of tiers) {
        const d: ComicDoc = { ...doc, settings: { ...doc.settings, quality: tier } };
        for (const byok of [false, true]) {
          for (const c of cases) {
            const gate = estimateSpendAction(d, { type: 'render_pages', ...c }, byok);
            // "Render all" (no pageIds, no force) is held back exactly as the gate holds it back.
            const holdBack = !c.force && !c.pageIds ? { holdBack: {} } : {};
            const q = quoteRenderPages(d, { ...c, byok, ...clientOpts(d), ...holdBack });
            expect({ usd: q.usd, imageCount: q.imageCount, model: q.model, lines: q.lines }).toEqual(gate);
          }
          // The breakdown card's "Render all" total is the gate's number.
          expect(summarizeBook(d, { byok }).totals.toDrawUsd).toBe(estimateSpendAction(d, { type: 'render_pages' }, byok).usd);
        }
      }
    });
  }
});

describe("anchors 'auto': the gate's lines plus anchor lines priced like the server prices them", () => {
  const runs: Record<string, AnchorRunOptions> = {
    extras: { mode: 'auto' },
    places: { mode: 'auto', kinds: { places: true } },
    all: { mode: 'auto', kinds: { places: true, props: true, styleKey: true, sheetV2: true } }
  };
  for (const [name, doc] of Object.entries({ harbour: harbourComic(), ship2: compatBooks().ship2 })) {
    for (const [runName, run] of Object.entries(runs)) {
      it(`${name} / ${runName}`, () => {
        for (const tier of tiers) {
          const d: ComicDoc = { ...doc, settings: { ...doc.settings, quality: tier } };
          for (const byok of [false, true]) {
            const gate = estimateSpendAction(d, { type: 'render_pages' }, byok);
            const q = quoteRenderPages(d, { byok, ...clientOpts(d), holdBack: {}, anchors: run });
            expect(q.lines).toEqual([...gate.lines, ...strip(q.anchors!.lines)]);
            const extras = q.lines.find((l) => l.label === 'recurring character sheets');
            if (extras) expect([extras]).toEqual(priceImageJobs(d, [{ kind: 'sheet', count: extras.count, label: 'recurring character sheets' }], byok).lines);
            const anchorUsd = q.anchors!.lines.reduce((s, l) => s + l.usd, 0);
            expect(q.usd).toBe(r4(gate.usd + anchorUsd));
            expect(q.imageCount).toBe(gate.imageCount + q.anchors!.keys.length);
            // At registry prices the PriceBook branch's re-pricing is the quote itself.
            expect(repriceAnchorLines(d, q.anchors!.lines, byok, bookAt(1))).toEqual(strip(q.anchors!.lines));
          }
        }
      });
    }
  }
});

describe('the PriceBook branch re-prices the anchor lines by kind, whatever the base line count', () => {
  it("a quote whose base has ONE line ('pages'): every anchor line is priced, none dropped", () => {
    const doc = harbourComic();
    const run: AnchorRunOptions = { mode: 'auto', kinds: { places: true, props: true } };
    for (const byok of [false, true]) {
      const q = quoteRenderPages(doc, { byok, ...clientOpts(doc), holdBack: {}, anchors: run });
      const prices = bookAt(2);
      const gate = estimateSpendAction(doc, { type: 'render_pages' }, byok, prices);
      expect(gate.lines.map((l) => l.label)).toEqual(['pages']);
      expect(q.anchors!.lines.map((l) => l.kind)).toEqual(['sheet', 'place', 'prop', 'refs']);
      // A fixed index (the base's maximum of 3 lines) would have dropped the first two anchor lines here.
      expect(q.lines.slice(3)).toHaveLength(q.anchors!.lines.length - 2);
      const priced = [...gate.lines, ...repriceAnchorLines(doc, q.anchors!.lines, byok, prices)];
      const markup = byok ? 1 : PLATFORM_MARKUP;
      const nb = getImageModel('nano-banana-2.1')!;
      const count = (kind: AnchorQuoteLine['kind']) => q.anchors!.lines.find((l) => l.kind === kind)!.count;
      expect(priced).toEqual([
        { label: 'pages', count: 6, usd: r4((2 * nb.priceUsd['2K']! + QC_USD_PER_PAGE) * 6 * markup) },
        { label: 'recurring character sheets', count: count('sheet'), usd: r4(2 * nb.priceUsd['2K']! * count('sheet') * markup) },
        { label: 'place sheets', count: count('place'), usd: r4(2 * nb.priceUsd['1K']! * count('place') * markup) },
        { label: 'prop sheets', count: count('prop'), usd: r4(2 * nb.priceUsd['1K']! * count('prop') * markup) },
        strip(q.anchors!.lines.filter((l) => l.kind === 'refs'))[0]
      ]);
      expect(count('place')).toBe(3);
    }
  });
});
