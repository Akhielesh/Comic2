// shared/comic/plan.ts × the page-plan check (plan A1): fit per panel, page status, the "Render all" quote
// without held-back (overfull) pages, missing references for recurring extras, the moments line.
// Synthetic fixtures (a b4b5774f-p2-shaped overfull page; no production text).
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel } from './doc';
import { quoteRenderPages, recurringCastIds, summarizeBook, unitPrice } from './plan';

const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
const text = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
const sp = (id: string, who: string, n: number, seed = 0): Line => ({ id, kind: 'speech', speakerId: who, text: text(n, seed) });
const panel = (id: string, n: number, over: Partial<Panel> = {}): Panel => ({ id, n, size: 'medium', shot: 'medium', action: `Beat ${n}.`, castIds: [], lines: [], ...over });

const roomy = (n: number, castIds: string[] = ['c_kal']): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [panel(`pn_${n}_1`, 1, { size: 'wide', shot: 'establishing', castIds }), panel(`pn_${n}_2`, 2, { castIds, lines: [sp(`l${n}`, 'c_kal', 10)] }), panel(`pn_${n}_3`, 3, { castIds })],
  render: emptyRender(),
  balloons: []
});

const overfull = (n: number): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
  panels: [
    panel(`pn_${n}_1`, 1, { shot: 'wide', castIds: ['c_kal', 'c_meera'], lines: [sp('a', 'c_meera', 10)] }),
    panel(`pn_${n}_2`, 2, { castIds: ['c_kal'] }),
    panel(`pn_${n}_3`, 3, { size: 'wide', shot: 'wide', castIds: ['c_kal', 'c_meera'] }),
    panel(`pn_${n}_4`, 4, { size: 'small', shot: 'insert' }),
    panel(`pn_${n}_5`, 5, { size: 'small', shot: 'close_up', castIds: ['c_meera'], lines: [sp('b', 'c_meera', 17, 3)] }),
    panel(`pn_${n}_6`, 6, { size: 'small', shot: 'pov', castIds: ['c_kal'], lines: [sp('c', 'c_meera', 15, 5), sp('d', 'c_kal', 14, 9)] })
  ],
  render: emptyRender(),
  balloons: []
});

const docOf = (...pages: Page[]): ComicDoc => {
  const doc = createEmptyDoc('doc_fit', 'Gate Lights', 1);
  doc.format.pageAspect = '2:3';
  doc.format.pageCount = pages.length;
  const ready = { status: 'ready' as const, history: [], asset: { path: 'u/x/sheet.webp', source: 'generated' as const, at: 1 } };
  doc.cast = [
    { id: 'c_kal', name: 'Kalyani', tier: 'lead', look: { summary: 'Courier' }, refs: [], sheet: ready },
    { id: 'c_meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer' }, refs: [], sheet: ready }
  ];
  doc.pages = pages;
  return doc;
};

describe('summarizeBook — plan fit', () => {
  it('the "Render all" quote excludes held-back pages, and includes them with drawOverfull', () => {
    const doc = docOf(roomy(1), overfull(2), roomy(3));
    const page = unitPrice(doc, 'page', { byok: false }).usd;
    const s = summarizeBook(doc, { byok: false });
    expect(s.totals.heldBack).toBe(1);
    expect(s.totals.toDrawUsd).toBeCloseTo(2 * page, 3);
    expect(s.totals.toDrawUsd).toBe(quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, pageIds: ['pg_1', 'pg_3'] }).usd);
    const anyway = summarizeBook(doc, { byok: false, drawOverfull: ['pg_2'] });
    expect(anyway.totals.heldBack).toBeUndefined();
    expect(anyway.totals.toDrawUsd).toBeCloseTo(3 * page, 3);
    expect(anyway.totals.toDrawUsd).toBe(quoteRenderPages(doc, { byok: false, tier: doc.settings.quality }).usd);
  });

  it('quoteRenderPages leaves held-back pages out only when asked (holdBack), and names them', () => {
    const doc = docOf(roomy(1), overfull(2));
    const plain = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality });
    expect(plain.pageIds).toEqual(['pg_1', 'pg_2']);
    expect(plain.heldBackIds).toBeUndefined();
    const held = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: {} });
    expect(held.pageIds).toEqual(['pg_1']);
    expect(held.heldBackIds).toEqual(['pg_2']);
    expect(held.usd).toBeLessThan(plain.usd);
    expect(quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: { drawOverfull: ['pg_2'] } }).pageIds).toEqual(['pg_1', 'pg_2']);
    // Everything held back: nothing to draw, $0 (never "all pages" by accident).
    const only = docOf(overfull(1));
    expect(quoteRenderPages(only, { byok: false, tier: only.settings.quality, holdBack: {} })).toMatchObject({ pageIds: [], usd: 0, nothing: true, heldBackIds: ['pg_1'] });
  });

  it('gives fit per panel and the page status, with the reason and the free layout for a held-back page', () => {
    const doc = docOf(roomy(1), overfull(2));
    const s = summarizeBook(doc, { byok: false });
    const p2 = s.pages[1];
    expect(p2.panels[5]).toMatchObject({ words: 29, budget: 9, fitState: 'overfull' });
    expect(p2.panels[5].fit!).toBeGreaterThan(0.5);
    expect(p2.panels[2]).toMatchObject({ fit: 0, fitState: 'roomy', budget: 40 });
    expect(p2.planFit).toMatchObject({ state: 'overfull', panel: 6, heldBack: true, layoutFix: 'Row 1: three small panels. Row 2: two equal panels. Row 3: one wide panel.' });
    expect(p2.planFit!.text).toContain('Page 2 is held back: panel 6 has 29 words');
    expect(p2.quoteUsd).toBe(unitPrice(doc, 'page', { byok: false }).usd); // "Draw anyway" still shows its price
    expect(s.pages[0].planFit!.heldBack).toBeUndefined();
    expect(['roomy', 'fits']).toContain(s.pages[0].planFit!.state);
    const anyway = summarizeBook(doc, { byok: false, drawOverfull: ['pg_2'] }).pages[1].planFit!;
    expect(anyway.state).toBe('overfull');
    expect(anyway.heldBack).toBeUndefined();
  });

  it('never holds back a drawn, current page (old pages are not re-checked into a refusal)', () => {
    const doc = docOf(overfull(1));
    doc.pages[0].render = { status: 'ready', history: [], asset: { path: 'u/x/p1.webp', source: 'generated', at: 1 } };
    const s = summarizeBook(doc, { byok: false });
    expect(s.pages[0].planFit).toMatchObject({ state: 'overfull' });
    expect(s.pages[0].planFit!.heldBack).toBeUndefined();
    expect(s.totals.heldBack).toBeUndefined();
  });

  it('a stale drawn page reads its dots and its hold-back from the same (blueprint) boxes, never the old take\'s', () => {
    // b4b5774f p2 shape, drawn once (measured qc boxes give panel 6 a big full-width cell), then re-planned (stale).
    const page = overfull(1);
    const measured = page.panels.map((_, i) => (i === 5 ? { x: 0.02, y: 0.5, w: 0.96, h: 0.48 } : { x: 0.02 + (i % 3) * 0.32, y: 0.02 + Math.floor(i / 3) * 0.24, w: 0.3, h: 0.22 }));
    page.render = {
      status: 'ready',
      history: [],
      specHash: 'an-older-plan',
      asset: { path: 'u/x/p1.webp', source: 'generated', at: 1 },
      qc: { model: 'x', score: 0.9, issues: [], checkedAt: 1, panelBoxes: measured }
    } as Page['render'];
    const doc = docOf(page);
    const s = summarizeBook(doc, { byok: false });
    const p1 = s.pages[0];
    expect(p1.status).toBe('stale');
    expect(p1.planFit).toMatchObject({ state: 'overfull', panel: 6, heldBack: true });
    // The dot agrees with the hold-back: panel 6 is red on the boxes the gate uses, and its box is the blueprint's.
    expect(p1.panels[5].fitState).toBe('overfull');
    expect(p1.panels[5].fit).toBe(p1.planFit!.worst);
    expect(p1.panels[5].budget).toBe(9);
    expect(p1.panels[5].box.w).toBeLessThan(0.4);
    expect(p1.planFit!.worst).toBe(Math.max(...p1.panels.map((ps) => ps.fit ?? 0)));
    // The same page drawn and current is read on its measured panels: roomy dot, nothing held back.
    const current = overfull(1);
    current.render = { ...page.render, specHash: undefined } as Page['render'];
    const drawn = summarizeBook(docOf(current), { byok: false }).pages[0];
    expect(drawn.status).toBe('ready');
    expect(drawn.panels[5].box).toEqual(measured[5]);
    expect(drawn.panels[5].fitState).toBe('roomy');
    expect(drawn.planFit!.heldBack).toBeUndefined();
    expect(drawn.planFit!.worst).toBe(Math.max(...drawn.panels.map((ps) => ps.fit ?? 0)));
  });

  it('budgets for a Japanese book are in characters, and the summary says so', () => {
    const doc = docOf(roomy(1));
    doc.format.language = 'ja';
    doc.pages[0].panels[1].lines = [{ id: 'j', kind: 'speech', speakerId: 'c_kal', text: 'この荷台にはナンバーがない。' }];
    const s = summarizeBook(doc, { byok: false });
    expect(s.budgetUnit).toBe('chars');
    expect(summarizeBook(docOf(roomy(1)), { byok: false }).budgetUnit).toBe('words');
    const en = summarizeBook(docOf(roomy(1)), { byok: false }).pages[0].panels[1].budget!;
    expect(s.pages[0].panels[1].budget).toBe(Math.floor(en * 1.6 + 1e-9));
  });

  it('missing references include recurring on-page extras without a sheet; extras with a ready sheet and one-off walk-ons are not flagged', () => {
    const doc = docOf(roomy(1, ['c_kal', 'c_pip', 'c_frog', 'c_crow']), roomy(2, ['c_kal', 'c_pip', 'c_frog']));
    doc.pages[0].panels[0].castIds = ['c_kal', 'c_owl'];
    doc.cast.push(
      { id: 'c_pip', name: 'Pip', tier: 'extra', look: { summary: 'Duckling' }, refs: [], sheet: emptyRender() },
      { id: 'c_frog', name: 'Frog', tier: 'extra', look: { summary: 'Frog' }, refs: [], sheet: { status: 'ready', history: [], asset: { path: 'u/x/frog.webp', source: 'generated', at: 1 } } },
      { id: 'c_owl', name: 'Owl', tier: 'extra', look: { summary: 'Owl' }, refs: [], sheet: emptyRender() }
    );
    expect([...recurringCastIds(doc)].sort()).toEqual(['c_frog', 'c_kal', 'c_pip']);
    const s = summarizeBook(doc, { byok: false });
    expect(s.pages[0].missingRefCastIds).toEqual(['c_pip']);
    expect(s.pages[1].missingRefCastIds).toEqual(['c_pip']);
  });

  it('states pages and panels for "Want more moments? Add a page." with the page price for the UI to format', () => {
    const doc = docOf(roomy(1), roomy(2));
    expect(summarizeBook(doc, { byok: false }).moments).toEqual({
      pages: 2,
      panels: 6,
      addPageUsd: unitPrice(doc, 'page', { byok: false }).usd,
      line: '2 pages · 6 panels. Want more moments? Add a page.'
    });
  });
});
