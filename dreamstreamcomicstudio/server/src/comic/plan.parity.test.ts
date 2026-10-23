// Parity (moved from shared/comic/plan.test.ts by P2-AMEND so the client typecheck never pulls server code):
// shared/comic/plan.ts quoteRenderPages / pageTargets / missingSheetsFor / LOW_QC_SCORE are pinned to the
// server gate's own estimateSpendAction and jobs.ts helpers, so the chat card, the board and the gate can never
// disagree about what "draw" would cost — or which pages and sheets it would draw.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, pageSpecHash, type ComicDoc, type QualityTier } from '../../../shared/comic/doc.js';
import {
  LOW_QC_SCORE,
  missingSheetsFor as planMissingSheetsFor,
  pageTargets as planPageTargets,
  quoteRenderPages
} from '../../../shared/comic/plan.js';
import { LOW_QC_SCORE as SERVER_LOW_QC_SCORE, estimateSpendAction, missingSheetsFor, pageTargets } from './jobs.js';
import { plannedDoc } from './orchestrator.fakes.js';

const fixtures = (): Record<string, ComicDoc> => {
  const planned = normalizeDoc(plannedDoc());
  // A fully drawn, current book (the owner's "generate all pages" on a drawn book must be $0).
  const drawn = normalizeDoc(plannedDoc());
  drawn.cast = drawn.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/x/${c.id}.webp`, source: 'generated', at: 1 } } }));
  drawn.pages = drawn.pages.map((p) => ({
    ...p,
    render: { status: 'ready', history: [], asset: { path: `u/x/${p.id}.webp`, source: 'generated', at: 1, w: 800, h: 1200 }, specHash: pageSpecHash(drawn, p) }
  }));
  // Mixed: one stale page, one failed, one busy, one empty page, model override.
  const mixed = normalizeDoc(plannedDoc());
  mixed.pages[0].render = { status: 'ready', history: [], asset: { path: 'u/x/p1.webp', source: 'generated', at: 1 }, specHash: 'old-hash' };
  mixed.pages[1].render = { status: 'failed', history: [], error: 'boom' };
  mixed.pages[2].render = { status: 'rendering', history: [] };
  mixed.pages.push({ ...mixed.pages[0], id: 'pg_empty', n: 4, panels: [], render: { status: 'none', history: [] } });
  mixed.settings = { ...mixed.settings, imageModelOverride: 'flux-3' };
  // Every render state at once (the old client sample fixture's coverage): ready+fresh, queued, stale; a sheet drawn.
  const states = normalizeDoc(plannedDoc());
  states.cast[0].sheet = { status: 'ready', history: [], asset: { path: 'u/x/maya.webp', source: 'generated', at: 1 } };
  states.pages[0].render = { status: 'ready', history: [], asset: { path: 'u/x/s1.webp', source: 'generated', at: 1 }, specHash: pageSpecHash(states, states.pages[0]) };
  states.pages[1].render = { status: 'queued', history: [] };
  states.pages[2].render = { status: 'ready', history: [], asset: { path: 'u/x/s3.webp', source: 'generated', at: 1 }, specHash: 'stale' };
  states.cover = { ...states.cover, render: { status: 'ready', history: [], asset: { path: 'u/x/cover.webp', source: 'generated', at: 1 }, specHash: 'old-cover' } };
  return { planned, drawn, mixed, states };
};

const tiers: QualityTier[] = ['draft', 'standard', 'pro'];

describe('quoteRenderPages === the server gate (estimateSpendAction render_pages)', () => {
  for (const [name, doc] of Object.entries(fixtures())) {
    it(`matches on the ${name} fixture for every tier, payer, subset and force`, () => {
      const cases: { pageIds?: string[]; force?: boolean; includeCover?: boolean }[] = [
        {},
        { force: true },
        { pageIds: [doc.pages[0].id] },
        { pageIds: [doc.pages[0].id], force: true },
        { pageIds: doc.pages.slice(1).map((p) => p.id) },
        { includeCover: true },
        { includeCover: true, force: true },
        { pageIds: [doc.pages[0].id], includeCover: true }
      ];
      for (const tier of tiers) {
        for (const byok of [false, true]) {
          const d: ComicDoc = { ...doc, settings: { ...doc.settings, quality: tier } };
          for (const c of cases) {
            const gate = estimateSpendAction(d, { type: 'render_pages', ...c }, byok);
            const q = quoteRenderPages(d, { ...c, byok, tier, modelOverride: d.settings.imageModelOverride });
            expect({ usd: q.usd, imageCount: q.imageCount, model: q.model, lines: q.lines }).toEqual(gate);
          }
        }
      }
    });
  }
});

describe('the server draws exactly what the shared plan says', () => {
  it('pageTargets and missingSheetsFor agree on every fixture, subset and force; LOW_QC_SCORE is one number', () => {
    for (const doc of Object.values(fixtures())) {
      for (const action of [{}, { force: true }, { pageIds: [doc.pages[0].id] }, { pageIds: doc.pages.map((p) => p.id), force: true }]) {
        expect(planPageTargets(doc, action).map((p) => p.id)).toEqual(pageTargets(doc, action).map((p) => p.id));
      }
      for (let i = 0; i < doc.pages.length; i += 1) {
        const pages = doc.pages.slice(i, i + 1);
        expect(planMissingSheetsFor(doc, pages).map((c) => c.id)).toEqual(missingSheetsFor(doc, pages).map((c) => c.id));
      }
    }
    expect(LOW_QC_SCORE).toBe(SERVER_LOW_QC_SCORE);
  });

  it('the states fixture never re-draws a ready, current page or a busy one without force', () => {
    const { states } = fixtures();
    expect(pageTargets(states, {}).map((p) => p.id)).toEqual(['pg_3']);
    expect(quoteRenderPages(states, { byok: false, tier: 'standard' }).pageIds).toEqual(['pg_3']);
    expect(pageTargets(states, { force: true }).map((p) => p.id)).not.toContain('pg_2');
  });
});
