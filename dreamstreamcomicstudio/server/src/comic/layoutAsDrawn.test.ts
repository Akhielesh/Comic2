// The layout measured as drawn (K1 fixer note 2): a stored page whose layout text contradicts its panel sizes is
// DRAWN on the layout synthesized from the sizes (pageGeometry effectiveLayout — the prompt's rule). The page-plan
// check, the Render-all hold-back and its quote, and the breakdown card's fit now measure that same layout, so the
// gate and the drawing agree both ways: a page that would be drawn overfull is held back, and a page that draws fine
// is never held back because of layout text the prompt ignores. Fakes only: no paid call, synthetic docs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, type Card, type ComicDoc } from '../../../shared/comic/doc.js';
import { drawnLayoutBoxes, effectiveLayout as sharedEffectiveLayout, estimatePanelBoxes, harmonizePanelSizes as sharedHarmonize, layoutConflicts as sharedConflicts } from '../../../shared/comic/pageGeometry.js';
import { checkPagePlan, panelBudgetSentence, planBoxes } from '../../../shared/comic/pagePlanCheck.js';
import { summarizeBook } from '../../../shared/comic/plan.js';
import { estimateSpendAction, runAction } from './jobs.js';
import { newSession, plannedDoc, testContext } from './orchestrator.fakes.js';
import { planCheckGate } from './planCheckGate.js';
import { compilePage, effectiveLayout, harmonizePanelSizes, layoutConflicts } from './prompts.js';
import { StudioError } from './types.js';
import { analyzePageRender } from './vision.js';

vi.mock('./vision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vision.js')>();
  return { ...actual, analyzePageRender: vi.fn(actual.analyzePageRender) };
});

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The page check is not what these tests are about: it is busy, and the run goes on without it.
  vi.mocked(analyzePageRender).mockRejectedValue(new StudioError('RATE_LIMIT', 'The page checker is busy.', { retryable: true }));
});

const LONG = (words: number) => Array.from({ length: words }, (_, i) => ['Listen', 'carefully', 'because', 'the', 'spice', 'map', 'leads', 'past', 'the', 'old', 'gate'][i % 11]).join(' ') + '.';

const ready = (doc: ComicDoc) => {
  doc.cast.forEach((c) => (c.sheet = { ...emptyRender(), status: 'ready', asset: { path: `${c.id}.webp`, source: 'generated', at: 1, w: 1536, h: 1024 } }));
  doc.planStatus = 'approved';
  doc.settings = { ...doc.settings, confirm: 'never' };
  return doc;
};

/**
 * Drawn overfull: the stored text gives panel 3 a large full-width row ("Row 2: one large panel"), but panel 1 is
 * "wide" in the shared first row, so the prompt draws the layout synthesized from the sizes — panel 3 shares the
 * bottom row and 70 words do not fit there.
 */
const drawnOverfull = (): ComicDoc => {
  const doc = ready(plannedDoc());
  const page = doc.pages[0];
  page.layout = 'Row 1: two equal panels. Row 2: one large panel.';
  page.panels[2].lines = [{ id: 'ln_long', kind: 'speech', speakerId: 'c_maya', text: LONG(70) }];
  return doc;
};

/**
 * Drawn fine: the stored text puts panel 3 in a shared bottom row (where 60 words would be overfull), but panel 3 is
 * "wide", so the prompt draws the synthesized layout with panel 3 on its own full-width row — and it fits there.
 */
const drawnFits = (): ComicDoc => {
  const doc = ready(plannedDoc());
  const page = doc.pages[0];
  page.layout = 'Row 1: one wide panel. Row 2: two equal panels.';
  page.panels = page.panels.map((p, i) => ({ ...p, size: i === 2 ? 'wide' : 'medium' }));
  page.panels[2].lines = [{ id: 'ln_long', kind: 'speech', speakerId: 'c_maya', text: LONG(60) }];
  return doc;
};

describe('one implementation: prompts.ts re-exports the shared layout-as-drawn functions', () => {
  it('effectiveLayout, harmonizePanelSizes and layoutConflicts are the shared ones', () => {
    expect(effectiveLayout).toBe(sharedEffectiveLayout);
    expect(harmonizePanelSizes).toBe(sharedHarmonize);
    expect(layoutConflicts).toBe(sharedConflicts);
  });
});

describe('a stored page whose layout text and panel sizes conflict: the gate and the drawing agree', () => {
  it('fixtures: the conflict is real, and the stored text and the drawn layout disagree about the fit', () => {
    for (const make of [drawnOverfull, drawnFits]) {
      const doc = make();
      const page = doc.pages[0];
      const drawn = effectiveLayout(page, doc.format);
      expect(drawn).not.toBe(page.layout);
      const asText = estimatePanelBoxes(page, { readingDirection: doc.format.readingDirection, kind: doc.format.kind });
      expect(drawnLayoutBoxes(doc, page)).not.toEqual(asText);
      // On the stored text the verdict would be the opposite one.
      const textCheck = checkPagePlan(doc, page, { boxes: asText, fixLayout: false });
      const drawnCheck = checkPagePlan(doc, page, { fixLayout: false });
      expect(textCheck.state === 'overfull').not.toBe(drawnCheck.state === 'overfull');
    }
  });

  it('drawn overfull: the check measures the drawn layout, and Render all holds the page back from the run and its quote', async () => {
    const doc = drawnOverfull();
    const page = doc.pages[0];
    const prompt = compilePage(doc, page).prompt;
    expect(prompt).toContain(effectiveLayout(page, doc.format));
    expect(prompt).not.toContain(page.layout!);
    // The check's boxes are the boxes of the layout in the prompt.
    expect(planBoxes(doc, page)).toEqual(estimatePanelBoxes({ panels: page.panels, layout: effectiveLayout(page, doc.format) }, { readingDirection: doc.format.readingDirection, kind: doc.format.kind }));
    const check = checkPagePlan(doc, page);
    expect(check.state).toBe('overfull');
    expect(check.panels.map((p) => p.box)).toEqual(planBoxes(doc, page));
    // The gate and the quote leave it out; the breakdown card says it is held back.
    const gate = planCheckGate(doc, doc.pages.map((p) => p.id));
    expect(gate.pageIds).toEqual(['pg_2', 'pg_3']);
    expect(gate.heldBack.map((h) => h.pageId)).toEqual(['pg_1']);
    expect(estimateSpendAction(doc, { type: 'render_pages' }, false).imageCount).toBe(2);
    const summary = summarizeBook(doc, { byok: false });
    expect(summary.pages[0].planFit).toMatchObject({ state: 'overfull', heldBack: true });
    expect(summary.pages[0].panels.map((p) => p.box)).toEqual(planBoxes(doc, page));
    expect(summary.totals.heldBack).toBe(1);
    // A real Render all draws the other two pages and leaves page 1 for its free fix.
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['none', 'ready', 'ready']);
    expect(ctx.imagesFake.calls.some((c) => /Action 1\.1/.test(c.prompt))).toBe(false);
    const cards: Card[] = session.doc.conversation.flatMap((m) => m.cards || []);
    expect(cards.some((c) => c.type === 'notice' && /Page 1 is held back/.test(c.text))).toBe(true);
  });

  it('drawn fine: never held back because of layout text the prompt does not draw; it is drawn on the layout that fits', async () => {
    const doc = drawnFits();
    const page = doc.pages[0];
    const check = checkPagePlan(doc, page);
    expect(check.state).not.toBe('overfull');
    const gate = planCheckGate(doc, doc.pages.map((p) => p.id));
    expect(gate.heldBack).toEqual([]);
    expect(gate.pageIds).toEqual(['pg_1', 'pg_2', 'pg_3']);
    expect(estimateSpendAction(doc, { type: 'render_pages' }, false).imageCount).toBe(3);
    const summary = summarizeBook(doc, { byok: false });
    expect(summary.pages[0].planFit?.heldBack).toBeUndefined();
    expect(summary.totals.heldBack).toBeUndefined();
    // The director's line-edit budget reads the same panel as drawn.
    expect(panelBudgetSentence(doc, page, 2)).toBe(`That makes panel 3 about 60 words; it holds about ${check.panels[2].budget}.`);
    const session = newSession(doc);
    const ctx = testContext(session);
    await runAction(ctx, { type: 'render_pages' }, { confirmed: true });
    await ctx.settled();
    expect(session.doc.pages.map((p) => p.render.status)).toEqual(['ready', 'ready', 'ready']);
    const drawn = ctx.imagesFake.calls.find((c) => /Action 1\.1/.test(c.prompt))!;
    expect(drawn.prompt).toContain(effectiveLayout(page, doc.format));
  });
});
