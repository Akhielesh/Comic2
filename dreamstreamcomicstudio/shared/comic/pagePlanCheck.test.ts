// shared/comic/pagePlanCheck.ts: the free page-plan check and the layout re-choice (plan §4.1).
// Synthetic fixtures shaped like the owner's b4b5774f p2 (6 panels; a pov panel with 29 words in a third-width
// cell) — no production text.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel } from './doc';
import { candidateLayouts, checkBookPlan, checkPagePlan, chooseLayout, heldBackOf, panelBudgetSentence, planBoxes, splitHeldBack } from './pagePlanCheck';
import { parseLayout, layoutPanelCount } from './pageGeometry';

const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
const text = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
const sp = (id: string, who: string, n: number, seed = 0): Line => ({ id, kind: 'speech', speakerId: who, text: text(n, seed) });

const baseDoc = (): ComicDoc => {
  const doc = createEmptyDoc('doc_check', 'Gate Lights', 1);
  doc.format.pageAspect = '2:3';
  doc.cast = [
    { id: 'c_kal', name: 'Kalyani', tier: 'lead', look: { summary: 'Courier in a yellow raincoat' }, refs: [], sheet: emptyRender() },
    { id: 'c_meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer with a wrist console' }, refs: [], sheet: emptyRender() }
  ];
  return doc;
};

const panel = (n: number, over: Partial<Panel>): Panel => ({ id: `pn_${n}`, n, size: 'medium', shot: 'medium', action: `Beat ${n}.`, castIds: [], lines: [], ...over });

/** b4b5774f-p2-shaped: two equal / one wide (silent) / three small, the small pov panel 6 carrying 29 words. */
const p2Shaped = (): Page => ({
  id: 'pg_2',
  n: 2,
  summary: 'Kalyani spots the carrier.',
  layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
  panels: [
    panel(1, { shot: 'wide', castIds: ['c_kal', 'c_meera'], lines: [sp('ln_1', 'c_meera', 10)] }),
    panel(2, { castIds: ['c_kal'], lines: [{ id: 'ln_2', kind: 'sfx', text: 'BZZT' }] }),
    panel(3, { size: 'wide', shot: 'wide', castIds: ['c_kal', 'c_meera'] }),
    panel(4, { size: 'small', shot: 'insert', lines: [{ id: 'ln_4', kind: 'sfx', text: 'CLICK' }] }),
    panel(5, { size: 'small', shot: 'close_up', castIds: ['c_meera'], lines: [sp('ln_5', 'c_meera', 17, 3)] }),
    panel(6, { size: 'small', shot: 'pov', castIds: ['c_kal'], lines: [sp('ln_6a', 'c_meera', 15, 5), sp('ln_6b', 'c_kal', 14, 9)] })
  ],
  render: emptyRender(),
  balloons: []
});

const docWith = (...pages: Page[]): ComicDoc => {
  const doc = baseDoc();
  doc.pages = pages;
  doc.format.pageCount = pages.length;
  return doc;
};

describe('checkPagePlan', () => {
  it('measures every panel on the blueprint: area, need, fit, state, words and budget', () => {
    const page = p2Shaped();
    const doc = docWith(page);
    const check = checkPagePlan(doc, page);
    expect(check.panels.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(check.panels[2]).toMatchObject({ fit: 0, state: 'roomy', words: 0, budget: 40 });
    expect(check.panels[5]).toMatchObject({ words: 29, balloons: 2, budget: 9, state: 'overfull' });
    expect(check.panels[5].area).toBeCloseTo(0.0842, 3);
    expect(check).toMatchObject({ state: 'overfull', worstPanel: 6, hard: 0.3 });
    expect(check.worst).toBeGreaterThanOrEqual(0.55);
    expect(check.issues.map((i) => i.kind)).toEqual(expect.arrayContaining(['count', 'overfull', 'quiet_shot', 'min_area']));
  });

  it('reads a drawn page on its blueprint, never on the old take’s measured boxes (the gate checks what will be drawn)', () => {
    const page = p2Shaped();
    page.render = { status: 'ready', history: [], qc: { model: 'x', score: 1, issues: [], checkedAt: 1, panelBoxes: page.panels.map(() => ({ x: 0, y: 0, w: 1, h: 1 })) } } as Page['render'];
    const doc = docWith(page);
    expect(checkPagePlan(doc, page).state).toBe('overfull');
    expect(checkPagePlan(doc, page, { boxes: planBoxes(doc, page) }).panels[5].area).toBeCloseTo(0.0842, 3);
  });

  it('a 3-panel page with room is quiet: no issues, all panels roomy or fitting', () => {
    const page: Page = {
      ...p2Shaped(),
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      panels: [
        panel(1, { size: 'wide', shot: 'establishing', castIds: ['c_kal'], placeId: 'pl_gate', lines: [{ id: 'c', kind: 'caption', text: 'The east gate. Midnight.' }] }),
        panel(2, { castIds: ['c_kal'], lines: [sp('a', 'c_kal', 14)] }),
        panel(3, { shot: 'close_up', castIds: ['c_meera'], lines: [sp('b', 'c_meera', 12, 4)] })
      ]
    };
    const check = checkPagePlan(docWith(page), page);
    expect(check.issues).toEqual([]);
    expect(check.panels.every((p) => p.state === 'roomy' || p.state === 'fits')).toBe(true);
  });
});

describe('chooseLayout', () => {
  it('takes a b4b5774f-p2-shaped page from ≥ 0.55 to ≤ 0.22 with the one blueprint that fits', () => {
    const page = p2Shaped();
    const doc = docWith(page);
    expect(checkPagePlan(doc, page, { fixLayout: false }).worst).toBeGreaterThanOrEqual(0.55);
    const fix = chooseLayout(doc, page)!;
    expect(fix).toBeTruthy();
    expect(fix.layout).toBe('Row 1: three small panels. Row 2: two equal panels. Row 3: one wide panel.');
    expect(fix.worst).toBeLessThanOrEqual(0.22);
    expect(fix.fits).toHaveLength(6);
    expect(fix.shrunk).toBe(1); // the writer's wide panel 3 had to give up its row
    const after = checkPagePlan(doc, { ...page, layout: fix.layout });
    expect(after.worst).toBeLessThanOrEqual(0.22);
    expect(checkPagePlan(doc, page).layoutFix?.layout).toBe(fix.layout);
    // The overfull issue then needs no writer repair: it names the layout instead.
    expect(checkPagePlan(doc, page).issues.find((i) => i.kind === 'overfull')).toMatchObject({ severity: 'note', panel: 6 });
  });

  it('returns none when nothing fits, and the overfull issue becomes one precise repair problem', () => {
    const page: Page = {
      ...p2Shaped(),
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      panels: [1, 2, 3].map((n) =>
        panel(n, { castIds: ['c_kal', 'c_meera'], lines: [sp(`a${n}`, 'c_kal', 25), sp(`b${n}`, 'c_meera', 25, 4), sp(`c${n}`, 'c_kal', 25, 8)] })
      )
    };
    const doc = docWith(page);
    expect(chooseLayout(doc, page)).toBeNull();
    const check = checkPagePlan(doc, page);
    expect(check.layoutFix).toBeUndefined();
    const overfull = check.issues.filter((i) => i.kind === 'overfull');
    expect(overfull).toHaveLength(1);
    expect(overfull[0].severity).toBe('repair');
    expect(overfull[0].text).toMatch(/^Page 2, panel \d: 75 words in a (small|medium|large) panel \(\d+% of the page; it holds about \d+ in 3 balloons\)/);
  });

  it('prefers keeping a wide establishing panel wide when another blueprint fits too', () => {
    const page: Page = {
      ...p2Shaped(),
      layout: 'Row 1: one wide panel. Row 2: three small panels.',
      panels: [
        panel(1, { size: 'wide', shot: 'establishing' }),
        panel(2, { size: 'small', castIds: ['c_kal'], lines: [sp('a', 'c_kal', 28)] }),
        panel(3, { size: 'small', shot: 'close_up' }),
        panel(4, { size: 'small', shot: 'close_up' })
      ]
    };
    const doc = docWith(page);
    expect(checkPagePlan(doc, page).state).toBe('overfull');
    const fix = chooseLayout(doc, page)!;
    expect(fix.shrunk).toBe(0);
    expect(fix.layout.startsWith('Row 1: one wide panel.') || fix.layout.startsWith('Row 1: one large panel.')).toBe(true);
  });

  it('every candidate parses to the same panel count; strips have none; webtoons get extra-tall variants', () => {
    const doc = baseDoc();
    for (const n of [2, 3, 4, 5, 6]) {
      const cands = candidateLayouts(doc, n);
      expect(cands.length).toBeGreaterThan(0);
      for (const c of cands) expect(layoutPanelCount(parseLayout(c)), c).toBe(n);
    }
    expect(candidateLayouts({ format: { ...doc.format, kind: 'strip' } }, 4)).toEqual([]);
    const tall = candidateLayouts({ format: { ...doc.format, kind: 'webtoon' } }, 3);
    expect(tall).toContain('Stacked vertically: 3 full-width panels (panels 1–3), top to bottom. Panel 2 is extra tall.');
    expect(tall.every((c) => parseLayout(c)?.mode === 'stack')).toBe(true);
  });
});

describe('checkBookPlan', () => {
  it('flags a second splash within 4 pages for repair, and a scene that opens without a full-width establishing panel as a note', () => {
    const splash = (n: number): Page => ({ ...p2Shaped(), id: `pg_${n}`, n, layout: 'One full-page splash panel.', panels: [panel(1, { size: 'splash', shot: 'wide', placeId: 'pl_gate' })] });
    const plain = (n: number, placeId: string, shot: Panel['shot']): Page => ({
      ...p2Shaped(),
      id: `pg_${n}`,
      n,
      layout: 'Row 1: two equal panels. Row 2: one wide panel.',
      panels: [panel(1, { shot, placeId }), panel(2, { placeId }), panel(3, { size: 'wide', placeId })]
    });
    const doc = docWith(splash(1), plain(2, 'pl_gate', 'medium'), splash(3), plain(4, 'pl_yard', 'close_up'));
    const checks = checkBookPlan(doc);
    expect(checks[2].issues.find((i) => i.kind === 'splash')).toMatchObject({ severity: 'repair' });
    expect(checks[2].issues.find((i) => i.kind === 'splash')!.text).toContain('Page 3 is a splash only 2 pages after the splash on page 1');
    expect(checks[0].issues.some((i) => i.kind === 'splash')).toBe(false);
    const est = checks[3].issues.find((i) => i.kind === 'establishing');
    expect(est).toMatchObject({ severity: 'note', panel: 1 });
    expect(checks[1].issues.some((i) => i.kind === 'establishing')).toBe(false); // same place continues
  });
});

describe('splitHeldBack / heldBackOf / panelBudgetSentence', () => {
  it('holds back an overfull page with its free fixes, and lets it through with drawOverfull', () => {
    const page = p2Shaped();
    const ok: Page = { ...p2Shaped(), id: 'pg_1', n: 1, layout: 'Row 1: one wide panel. Row 2: two equal panels.', panels: [panel(1, { size: 'wide' }), panel(2, {}), panel(3, {})] };
    const doc = docWith(ok, page);
    const split = splitHeldBack(doc, ['pg_1', 'pg_2', 'pg_gone']);
    expect(split.draw).toEqual(['pg_1', 'pg_gone']);
    expect(split.heldBack).toHaveLength(1);
    expect(split.heldBack[0]).toMatchObject({ pageId: 'pg_2', n: 2, panel: 6, layoutFix: 'Row 1: three small panels. Row 2: two equal panels. Row 3: one wide panel.' });
    expect(split.heldBack[0].text).toBe(
      'Page 2 is held back: panel 6 has 29 words in 8% of the page (it holds about 9). Free fixes: use the layout that fits, split the page, move a line, make it a caption — or draw it anyway.'
    );
    expect(split.heldBack[0].text).not.toContain('$');
    expect(splitHeldBack(doc, ['pg_1', 'pg_2'], ['pg_2'])).toEqual({ draw: ['pg_1', 'pg_2'], heldBack: [] });
    expect(heldBackOf(checkPagePlan(doc, page)).pageId).toBe('pg_2');
  });

  it('reports a panel budget in plain words for the director', () => {
    const page = p2Shaped();
    const doc = docWith(page);
    expect(panelBudgetSentence(doc, page, 5)).toBe("That makes panel 6 about 29 words; it holds about 9. That's too much text for this panel.");
    expect(panelBudgetSentence(doc, page, 2)).toBe('That makes panel 3 about 0 words; it holds about 40.');
    expect(panelBudgetSentence(doc, page, 9)).toBeUndefined();
  });
});
