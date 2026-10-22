// shared/comic/plan.ts: the one target/estimate core (contract §11.2).
// The parity cases pin quoteRenderPages to the server gate's own estimateSpendAction, so the
// chat card, the board and the gate can never disagree about what "draw" would cost.
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { LOW_QC_SCORE as SERVER_LOW_QC_SCORE, estimateSpendAction } from '../../server/src/comic/jobs';
import { plannedDoc } from '../../server/src/comic/orchestrator.fakes';
import { normalizeDoc, pageSpecHash, type ComicDoc, type QualityTier } from './doc';
import { estimateJobs } from './models';
import { LOW_QC_SCORE, coverNeedsDraw, missingSheetsFor, pageTargets, quoteRenderPages, sheetTargets, spendByTarget, summarizeBook, unitPrice } from './plan';

const fixtures = (): Record<string, ComicDoc> => {
  const sample = normalizeDoc(makeSampleDoc());
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
  return { sample, planned, drawn, mixed };
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

describe('the money rule', () => {
  it('never quotes a ready, current page without force', () => {
    const { drawn, sample } = fixtures();
    const q = quoteRenderPages(drawn, { byok: false, tier: 'standard' });
    expect(q).toMatchObject({ nothing: true, usd: 0, imageCount: 0, pageIds: [], sheetIds: [], cover: false });
    expect(quoteRenderPages(drawn, { pageIds: [drawn.pages[1].id], byok: false, tier: 'standard' }).nothing).toBe(true);
    // force = an explicit new take: priced
    const forced = quoteRenderPages(drawn, { pageIds: [drawn.pages[1].id], force: true, byok: false, tier: 'standard' });
    expect(forced.pageIds).toEqual([drawn.pages[1].id]);
    expect(forced.usd).toBeGreaterThan(0);
    // sample: pg_1 ready+fresh is skipped; pg_5 is stale ⇒ counted; busy pg_3/pg_4 never
    expect(quoteRenderPages(sample, { byok: true, tier: 'standard' }).pageIds).toEqual(['pg_2', 'pg_5', 'pg_6']);
    expect(pageTargets(sample, { force: true }).map((p) => p.id)).not.toContain('pg_3');
  });

  it('pages without panels and busy pages are never targets', () => {
    const { mixed } = fixtures();
    expect(pageTargets(mixed).map((p) => p.id)).toEqual(['pg_1', 'pg_2']);
    expect(pageTargets(mixed, { force: true }).map((p) => p.id)).toEqual(['pg_1', 'pg_2']);
  });

  it('includeCover adds the cover only when it needs drawing (or forced, not busy)', () => {
    const { drawn } = fixtures();
    expect(coverNeedsDraw(drawn)).toBe(true);
    const withCover = quoteRenderPages(drawn, { includeCover: true, byok: false, tier: 'standard' });
    expect(withCover).toMatchObject({ cover: true, nothing: false, imageCount: 1 });
    expect(withCover.usd).toBe(unitPrice(drawn, 'cover', { byok: false, tier: 'standard' }).usd);
    const coverDone: ComicDoc = { ...drawn, cover: { ...drawn.cover, render: { status: 'ready', history: [], asset: { path: 'c.webp', source: 'generated', at: 1 } } } };
    expect(coverNeedsDraw(coverDone)).toBe(false);
    expect(quoteRenderPages(coverDone, { includeCover: true, byok: false, tier: 'standard' }).nothing).toBe(true);
    expect(quoteRenderPages(coverDone, { includeCover: true, force: true, pageIds: [drawn.pages[0].id], byok: false, tier: 'standard' }).cover).toBe(true);
    const coverBusy: ComicDoc = { ...drawn, cover: { ...drawn.cover, render: { status: 'queued', history: [] } } };
    expect(coverNeedsDraw(coverBusy)).toBe(false);
    expect(quoteRenderPages(coverBusy, { includeCover: true, force: true, byok: false, tier: 'standard' }).cover).toBe(false);
  });

  it('sheets: missing lead/support sheets ride along; extras never', () => {
    const { planned, sample } = fixtures();
    expect(missingSheetsFor(planned, planned.pages.slice(0, 1)).map((c) => c.id)).toEqual(['c_maya']);
    expect(quoteRenderPages(planned, { pageIds: ['pg_2'], byok: false, tier: 'standard' }).sheetIds).toEqual(['c_maya', 'c_arjun']);
    expect(sheetTargets(sample).map((c) => c.id)).toEqual(['ch_arjun']);
    expect(sheetTargets(sample, { characterIds: ['ch_vendor'], force: true })).toEqual([]);
  });
});

describe('unitPrice / spendByTarget', () => {
  it('prices one image from the registry with the model override', () => {
    const { mixed, planned } = fixtures();
    expect(unitPrice(planned, 'page', { byok: false }).usd).toBe(estimateJobs([{ kind: 'page', count: 1 }], planned.settings.quality, { byok: false }).usd);
    const over = unitPrice(mixed, 'page', { byok: true });
    expect(over.usd).toBe(estimateJobs([{ kind: 'page', count: 1 }], mixed.settings.quality, { byok: true, override: 'flux-3' }).usd);
    expect(over.model).toBe(estimateJobs([{ kind: 'page', count: 1 }], mixed.settings.quality, { override: 'flux-3' }).model);
  });

  it('groups the ledger by render target', () => {
    const doc = fixtures().planned;
    doc.spend = {
      totalUsd: 0.31,
      byKind: { page: 0.2, edit: 0.11 },
      entries: [
        { id: 'a', at: 3, kind: 'edit', label: 'edit', usd: 0.11, byok: false, estimated: false, target: 'page:pg_1' },
        { id: 'b', at: 2, kind: 'page', label: 'page', usd: 0.1, byok: false, estimated: false, target: 'page:pg_1' },
        { id: 'c', at: 1, kind: 'page', label: 'page', usd: 0.1, byok: false, estimated: true, target: 'page:pg_2', savedUsd: 0.05 },
        { id: 'd', at: 0, kind: 'chat', label: 'chat', usd: 0.01, byok: false, estimated: false }
      ]
    };
    const m = spendByTarget(doc);
    expect(m.get('page:pg_1')).toEqual({ usd: 0.21, savedUsd: 0, count: 2 });
    expect(m.get('page:pg_2')).toEqual({ usd: 0.1, savedUsd: 0.05, count: 1 });
    expect(m.size).toBe(2);
    expect(summarizeBook(doc, { byok: false }).pages[0].spentUsd).toBe(0.21);
  });
});

describe('summarizeBook', () => {
  it('summarizes pages, cover, totals and pricing with real numbers only', () => {
    const { sample } = fixtures();
    const s = summarizeBook(sample, { byok: false, rating: 'PG-13' });
    expect(s.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    const perPage = unitPrice(sample, 'page', { byok: false }).usd;
    expect(s.pages.filter((p) => p.quoteUsd !== undefined).map((p) => p.id)).toEqual(['pg_2', 'pg_5', 'pg_6']);
    expect(s.pages[1].quoteUsd).toBe(perPage);
    // a new take of drawn pg_1 is the gate's forced quote: the page plus ARJUN's missing sheet
    const redo = quoteRenderPages(sample, { pageIds: ['pg_1'], force: true, byok: false, tier: sample.settings.quality });
    expect(redo.sheetIds).toEqual(['ch_arjun']);
    expect(redo.usd).toBeGreaterThan(perPage);
    expect(s.pages[0]).toMatchObject({ status: 'ready', aspectOk: true, qcScore: 0.82, redrawUsd: redo.usd });
    expect(s.pages[0].model).toBeTruthy();
    expect(s.pages[0].quoteUsd).toBeUndefined();
    expect(s.totals.toDrawUsd).toBe(quoteRenderPages(sample, { byok: false, tier: sample.settings.quality }).usd);
    expect(s.pricing).toMatchObject({ pageUsd: perPage, tier: sample.settings.quality, byok: false, locked: false });
    expect(s.cover.quoteUsd).toBe(unitPrice(sample, 'cover', { byok: false }).usd);
    expect(LOW_QC_SCORE).toBe(SERVER_LOW_QC_SCORE);
  });

  it('scopes to a subset and flags off-aspect art and missing references', () => {
    const { sample } = fixtures();
    sample.pages[0].render.asset = { ...sample.pages[0].render.asset!, w: 1000, h: 1000 };
    const s = summarizeBook(sample, { pageIds: ['pg_1'], byok: true });
    expect(s.pages.map((p) => p.id)).toEqual(['pg_1']);
    expect(s.pages[0].aspectOk).toBe(false);
    expect(s.pages[0].missingRefCastIds).toEqual(['ch_arjun']);
    expect(s.totals.pages).toBe(6);
  });

  it('marks an adopted render without a spec hash as custom', () => {
    const { planned } = fixtures();
    planned.pages[0].render = { status: 'ready', history: [], origin: 'adopted', asset: { path: 'x.webp', source: 'upload', at: 1 } };
    expect(summarizeBook(planned, { byok: false }).pages[0].status).toBe('custom');
  });
});
