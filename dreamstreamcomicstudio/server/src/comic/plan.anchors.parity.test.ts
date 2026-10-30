// B4: the client quote equals the server estimate on books that carry Ship 2 consistency data, through the server's own
// estimate path (jobs.ts estimateSpendAction for render_pages, read-only). Without the anchors option (today's server
// call) plan.ts quotes exactly what the gate quotes; with anchors 'auto' the quote is the gate's lines plus the anchor
// lines, each priced the way the server prices that job (priceImageJobs), so once the server passes
// render_pages.anchors to quoteRenderPages (wave note) the gate and the card stay one number.
import { describe, expect, it } from 'vitest';
import { harbourComic, lakeStory } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import { compatBooks } from '../../../shared/comic/__fixtures__/planCompat.js';
import type { ComicDoc, QualityTier } from '../../../shared/comic/doc.js';
import { quoteRenderPages, summarizeBook, type AnchorRunOptions } from '../../../shared/comic/plan.js';
import { estimateSpendAction, priceImageJobs } from './jobs.js';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
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
            expect(q.lines.slice(0, gate.lines.length)).toEqual(gate.lines);
            const extras = q.lines.find((l) => l.label === 'recurring character sheets');
            if (extras) expect([extras]).toEqual(priceImageJobs(d, [{ kind: 'sheet', count: extras.count, label: 'recurring character sheets' }], byok).lines);
            const anchorUsd = q.lines.slice(gate.lines.length).reduce((s, l) => s + l.usd, 0);
            expect(q.usd).toBe(r4(gate.usd + anchorUsd));
            expect(q.imageCount).toBe(gate.imageCount + q.anchors!.keys.length);
          }
        }
      });
    }
  }
});
