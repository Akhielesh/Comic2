// shared/comic/pagePlanCheck.ts: the free page-plan check and the layout re-choice (plan §4.1).
// Synthetic fixtures shaped like the owner's b4b5774f p2 (6 panels; a pov panel with 29 words in a third-width
// cell) — no production text.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel } from './doc';
import { candidateLayouts, checkBookPlan, checkPagePlan, chooseLayout, heldBackOf, holdBackApplies, panelBudgetSentence, planBoxes, splashIssues, splitHeldBack } from './pagePlanCheck';
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
    // A drawn page letters into its measured panels: a big measured panel 6 holds more.
    const drawn = p2Shaped();
    const boxes = drawn.panels.map((_, i) => (i === 5 ? { x: 0.02, y: 0.5, w: 0.96, h: 0.48 } : { x: 0.02, y: 0.02 + i * 0.08, w: 0.3, h: 0.07 }));
    drawn.render = { status: 'ready', history: [], qc: { model: 'x', score: 1, issues: [], checkedAt: 1, panelBoxes: boxes } } as Page['render'];
    expect(panelBudgetSentence(docWith(drawn), drawn, 5)).toBe('That makes panel 6 about 29 words; it holds about 40.');
  });
});

describe('splash rule — a format fixed at one panel per page', () => {
  it('raises nothing when the author chose single-panel pages, while auto comics keep the rule', () => {
    const one = (n: number): Page => ({ ...p2Shaped(), id: `pg_${n}`, n, layout: 'One full-page splash panel.', panels: [panel(1, { size: 'splash', shot: 'wide' })] });
    const pages = [one(1), one(2), one(3)];
    const fixed = docWith(...pages);
    fixed.format.panelsPerPage = 1;
    expect(splashIssues(fixed, pages)).toEqual([]);
    expect(checkBookPlan(fixed).flatMap((c) => c.issues.filter((i) => i.severity === 'repair'))).toEqual([]);
    const manga = docWith(...pages);
    manga.format.kind = 'manga';
    manga.format.panelsPerPage = 1;
    expect(splashIssues(manga, pages)).toEqual([]);
    const auto = docWith(...pages);
    expect(splashIssues(auto, pages).map((s) => s.pageId)).toEqual(['pg_2', 'pg_3']);
    const two = docWith(...pages);
    two.format.panelsPerPage = 2; // a fixed count above 1 keeps the rule for its splash pages
    expect(splashIssues(two, pages)).toHaveLength(2);
  });
});

describe('char-unit languages (Japanese): counts, limits and sentences in characters', () => {
  // Synthetic Japanese lines (no production text).
  const JA = ['この荷台にはナンバーがない。', '朝から誰も降ろしていない。', '誰かが見張らせたいんだ。', '今夜はずっと見ていよう。'];
  const ja = (id: string, i: number, who = 'c_meera'): Line => ({ id, kind: 'speech', speakerId: who, text: JA[i] });

  it('a pov panel with one 27-character line breaks the quiet-shot limit (19 characters), said in characters', () => {
    const page: Page = {
      ...p2Shaped(),
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      panels: [
        panel(1, { size: 'wide', shot: 'establishing' }),
        panel(2, { shot: 'pov', castIds: ['c_kal'], lines: [{ id: 'j1', kind: 'speech', speakerId: 'c_meera', text: JA[0] + JA[1] }] }),
        panel(3, { castIds: ['c_kal'] })
      ]
    };
    const doc = docWith(page);
    doc.format.language = 'ja';
    const check = checkPagePlan(doc, page);
    expect(check.unit).toBe('chars');
    expect(check.panels[1].words).toBe(27);
    const quiet = check.issues.find((i) => i.kind === 'quiet_shot')!;
    expect(quiet).toMatchObject({ severity: 'repair', panel: 2 });
    expect(quiet.text).toBe(
      'Page 2, panel 2 is a point-of-view shot with 1 line (27 characters); a pov or insert panel carries at most 1 line of 19 characters or fewer — move the conversation to a panel that shows the speakers.'
    );
    // The same page in English counting would have seen one "word" and passed.
    expect(checkPagePlan({ ...doc, format: { ...doc.format, language: 'en' } }, page).issues.some((i) => i.kind === 'quiet_shot')).toBe(false);
  });

  it('5 panels carrying 40 characters is not a "nearly silent" fast sequence; held-back and budget sentences say characters', () => {
    const page: Page = {
      ...p2Shaped(),
      layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: two equal panels.',
      panels: [panel(1, { lines: [ja('a', 0)] }), panel(2, { lines: [ja('b', 1)] }), panel(3, { size: 'wide' }), panel(4, {}), panel(5, {})]
    };
    const doc = docWith(page);
    doc.format.language = 'ja';
    const count = checkPagePlan(doc, page).issues.find((i) => i.kind === 'count')!;
    expect(count.text).toContain('5 only for a fast, nearly silent sequence of 19 characters or fewer on the page');

    // A crowded small Japanese panel: the held-back sentence and the director's budget line count characters.
    const crowded = p2Shaped();
    crowded.panels[5] = { ...crowded.panels[5], lines: [ja('c', 0), ja('d', 1, 'c_kal'), ja('e', 2), ja('f', 3, 'c_kal')].slice(0, 3) };
    const jdoc = docWith(crowded);
    jdoc.format.language = 'ja';
    const c = checkPagePlan(jdoc, crowded);
    expect(c.panels[5].words).toBe(14 + 13 + 12);
    expect(c.panels[5].budget).toBe(Math.floor(c.panels[5].budget)); // whole characters
    if (c.state === 'overfull') {
      const held = heldBackOf(c);
      expect(held.text).toMatch(/^Page 2 is held back: panel \d has \d+ characters in \d+% of the page \(it holds about \d+\)/);
    }
    expect(panelBudgetSentence(jdoc, crowded, 5)).toMatch(/^That makes panel 6 about 39 characters; it holds about \d+\./);
  });
});

describe('hold-back scope: only pages "Render all" would draw', () => {
  it('never holds back a drawn, current page (a forced new take) or a busy one; a stale one is held back; exempt pages pass', () => {
    const current = p2Shaped();
    current.render = { status: 'ready', history: [], asset: { path: 'u/x/p2.webp', source: 'generated', at: 1 } };
    const stale = { ...p2Shaped(), id: 'pg_3', n: 3 };
    stale.render = { status: 'ready', history: [], specHash: 'an-older-plan', asset: { path: 'u/x/p3.webp', source: 'generated', at: 1 } };
    const busy = { ...p2Shaped(), id: 'pg_4', n: 4 };
    busy.render = { status: 'rendering', history: [] };
    const fresh = { ...p2Shaped(), id: 'pg_5', n: 5 };
    const doc = docWith(current, stale, busy, fresh);
    expect([current, stale, busy, fresh].map((p) => holdBackApplies(doc, p))).toEqual([false, true, false, true]);
    const split = splitHeldBack(doc, ['pg_2', 'pg_3', 'pg_4', 'pg_5']);
    expect(split.draw).toEqual(['pg_2', 'pg_4']);
    expect(split.heldBack.map((h) => h.pageId)).toEqual(['pg_3', 'pg_5']);
    expect(splitHeldBack(doc, ['pg_3', 'pg_5'], [], { exempt: (p) => p.id === 'pg_5' }).draw).toEqual(['pg_5']);
  });
});
