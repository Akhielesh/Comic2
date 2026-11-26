// @vitest-environment node
// One true price (docs/features/pricing.md): the quote a button computes in the studio — shared/comic/plan.ts with the
// person's PriceBook from their price sheet — is the quote the server's gate, chips and run compute with the book it
// builds for the same person (jobs.ts estimateSpendAction / priceImageJobs → shared/comic/models.ts estimateJobs).
// Prices are chosen so the observed medians and the live list sit well above the registry, so a surface that still
// read the registry could not pass. Synthetic docs and prices only.
import { describe, expect, it } from 'vitest';
import { estimateJobs, getImageModel, resolveImageJob } from '../../../shared/comic/models.js';
import { estimateDocJobs, quoteRenderPages, unitPrice } from '../../../shared/comic/plan.js';
import { priceBookFromSources, priceSheetOf, sanitizePriceSheet, type PriceBookSources } from '../../../shared/comic/priceBook.js';
import { estimateSpendAction, nextStepsFor, priceImageJobs } from './jobs.js';
import { plannedDoc } from './orchestrator.fakes.js';

const doc = plannedDoc();
const tier = doc.settings.quality;
const page = resolveImageJob('page', tier);
const sheet = resolveImageJob('sheet', tier);
const cover = resolveImageJob('cover', tier);
const median = (kind: string, spec: { id: string }, res: string, usd: number) => ({ modelId: spec.id, kind, res: res as '1K', n: 6, medianUsd: usd, minUsd: usd, maxUsd: usd, scope: 'you' as const });
const sources: PriceBookSources = {
  rows: [{ id: page.spec.id, price: { [page.resolution]: { usd: (page.spec.priceUsd[page.resolution] ?? 0.04) * 1.5, basis: 'openrouter_endpoint' } }, perRefUsd: null }],
  observed: [median('page', page.spec, page.resolution, 0.31), median('sheet', sheet.spec, sheet.resolution, 0.27), median('cover', cover.spec, cover.resolution, 0.33)],
  qc: { medianUsd: 0.0071, n: 8 },
  text: { planPerPageUsd: 0.02, styleDirectionsUsd: 0.03, translateFactor: 1.2 }
};
/** The studio's book: built from the sheet the server serves (through the wire's own sanitizer). */
const clientBook = priceBookFromSources(sanitizePriceSheet(JSON.parse(JSON.stringify(priceSheetOf(sources, 1))))!.sources);
/** The server's book for the same person. */
const serverBook = priceBookFromSources(sources);

describe('the studio and the server name one price', () => {
  for (const byok of [true, false]) {
    it(`draw everything, one page, a redraw, sheets and the cover (${byok ? 'own key' : 'platform'})`, () => {
      const opts = { byok, tier, modelOverride: doc.settings.imageModelOverride };
      // Draw everything (the board's Render all, the plan card's Approve & draw, the chip's quote).
      const all = quoteRenderPages(doc, { ...opts, prices: clientBook }).usd;
      expect(all).toBe(estimateSpendAction(doc, { type: 'render_pages' }, byok, serverBook).usd);
      expect(all).not.toBe(quoteRenderPages(doc, opts).usd);
      // One page (a page card's Draw), and a forced redraw (Redraw, the timeline, the progress card's Retry).
      expect(quoteRenderPages(doc, { ...opts, pageIds: ['pg_2'], prices: clientBook }).usd).toBe(estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_2'] }, byok, serverBook).usd);
      expect(quoteRenderPages(doc, { ...opts, pageIds: ['pg_2'], force: true, prices: clientBook }).usd).toBe(
        estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_2'], force: true }, byok, serverBook).usd
      );
      // Sheets and the cover (Cast tab, the cover card).
      // (The two lead/support characters; a place is drawn when it is asked for by name.)
      expect(estimateDocJobs(doc, [{ kind: 'sheet', count: 2, label: 'character sheets' }], { byok, prices: clientBook }).usd).toBe(
        estimateSpendAction(doc, { type: 'render_sheets' }, byok, serverBook).usd
      );
      expect(unitPrice(doc, 'cover', { byok, prices: clientBook }).usd).toBe(estimateSpendAction(doc, { type: 'render_cover' }, byok, serverBook).usd);
      // The chips the server posts carry the same figure the board shows.
      const chip = nextStepsFor(doc, { byok, prices: serverBook }).find((s) => s.action?.type === 'render_pages');
      expect(chip?.usd).toBe(all);
    });
  }

  it('the server prices image jobs through the very function the buttons call', () => {
    const jobs = [{ kind: 'page' as const, count: 3, label: 'pages' }, { kind: 'cover' as const, count: 1, label: 'cover' }];
    expect(priceImageJobs(doc, jobs, false, serverBook)).toEqual(estimateJobs(jobs, tier, { override: doc.settings.imageModelOverride, byok: false, prices: clientBook }));
    expect(getImageModel(page.spec.id)).toBeTruthy();
  });
});
