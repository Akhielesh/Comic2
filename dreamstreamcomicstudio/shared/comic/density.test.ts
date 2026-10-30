// shared/comic/density.ts: the one word-budget calibration (plan §4.1). Synthetic fixtures only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page } from './doc';
import { BALLOON_BASE, WORD_COST, fitState, hardFitLimit, lineNeed, panelFit, panelNeed, wordBudget } from './density';
import { estimateMeasure, letteringAspect, planLettering } from './lettering/layout';
import { resolveLetterStyle } from './lettering/style';
import { panelBoxesFor } from './pageGeometry';
import { PANEL_LIMITS } from './panelRules';

const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
const text = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');

const docWith = (patch: (d: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('doc_density', 'Gate Lights', 1);
  doc.format.pageAspect = '2:3';
  doc.cast = [
    { id: 'c_meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer with a wrist console' }, refs: [], sheet: emptyRender() },
    { id: 'c_kal', name: 'Kalyani', tier: 'support', look: { summary: 'Courier in a yellow raincoat' }, refs: [], sheet: emptyRender() }
  ];
  patch(doc);
  return doc;
};

const speech = (id: string, n: number, seed = 0, speakerId = 'c_meera'): Line => ({ id, kind: 'speech', speakerId, text: text(n, seed) });
const caption = (id: string, n: number, seed = 0): Line => ({ id, kind: 'caption', text: text(n, seed) });

/** Outline coverage of each panel as planLettering actually letters the page (placed widths, density steps). */
const letteredCoverage = (doc: ComicDoc, page: Page): number[] => {
  const aspect = letteringAspect(doc, page);
  const H = 1000 / aspect;
  const plans = planLettering(doc, page, aspect, estimateMeasure);
  const boxes = panelBoxesFor(doc, page);
  return page.panels.map((panel, i) => {
    const area = boxes[i].w * boxes[i].h;
    const covered = plans
      .filter((p) => p.panelN === panel.n)
      .reduce((sum, p) => {
        const line = panel.lines.find((l) => l.id === p.lineId)!;
        const shape = resolveLetterStyle(doc, line).shape;
        const fill = ['rect', 'rounded_rect', 'notched', 'scroll', 'ribbon', 'electronic', 'none'].includes(shape) ? 1 : Math.PI / 4;
        return sum + fill * (p.geometry.bounds.w / 1000) * (p.geometry.bounds.h / H);
      }, 0);
    return covered / area;
  });
};

describe('lineNeed / panelNeed', () => {
  it('is within 15% of planLettering coverage on 3 synthetic panels (wide, medium, small)', () => {
    const doc = docWith();
    const page: Page = {
      id: 'pg_cal',
      n: 1,
      summary: '',
      layout: 'Row 1: one wide panel. Row 2: two equal panels. Row 3: three small panels.',
      panels: [
        { id: 'pn_1', n: 1, size: 'wide', shot: 'wide', action: 'a', castIds: ['c_meera', 'c_kal'], lines: [caption('ln_c', 9, 2), speech('ln_1a', 14, 0), speech('ln_1b', 9, 5, 'c_kal')] },
        { id: 'pn_2', n: 2, size: 'medium', shot: 'medium', action: 'a', castIds: ['c_meera', 'c_kal'], lines: [speech('ln_2a', 12, 3, 'c_kal'), speech('ln_2b', 7, 8)] },
        { id: 'pn_3', n: 3, size: 'medium', shot: 'medium', action: 'a', castIds: [], lines: [] },
        { id: 'pn_4', n: 4, size: 'small', shot: 'close_up', action: 'a', castIds: ['c_meera'], lines: [speech('ln_4', 10, 11)] },
        { id: 'pn_5', n: 5, size: 'small', shot: 'insert', action: 'a', castIds: [], lines: [] },
        { id: 'pn_6', n: 6, size: 'small', shot: 'medium', action: 'a', castIds: [], lines: [] }
      ],
      render: emptyRender(),
      balloons: []
    };
    doc.pages = [page];
    const boxes = panelBoxesFor(doc, page);
    const covered = letteredCoverage(doc, page);
    for (const i of [0, 1, 3]) {
      const fit = panelFit(panelNeed(page.panels[i].lines, doc, { box: boxes[i] }), boxes[i].w * boxes[i].h);
      expect(covered[i], `panel ${i + 1}`).toBeGreaterThan(0.02);
      expect(Math.abs(fit - covered[i]) / covered[i], `panel ${i + 1}: fit ${fit} vs lettered ${covered[i]}`).toBeLessThanOrEqual(0.15);
    }
  });

  it('tracks the balloonfit oracle (speech ≈ 0.0029 + 0.0014/word, caption ≈ 0.0047 + 0.0011/word) within 20%', () => {
    const doc = docWith();
    for (const n of [6, 12, 20]) {
      const s = lineNeed(speech('s', n), doc, { box: { w: 0.47 } });
      const c = lineNeed(caption('c', n), doc, { box: { w: 0.47 } });
      expect(Math.abs(s - (BALLOON_BASE + WORD_COST * n)) / (BALLOON_BASE + WORD_COST * n), `speech ${n}`).toBeLessThan(0.2);
      expect(Math.abs(c - (0.0047 + 0.0011 * n)) / (0.0047 + 0.0011 * n), `caption ${n}`).toBeLessThan(0.2);
    }
  });

  it('uses the engine sizer: more words need more room, empty lines need none, a narrow panel wraps taller', () => {
    const doc = docWith();
    expect(lineNeed(speech('a', 20), doc)).toBeGreaterThan(lineNeed(speech('b', 5), doc));
    expect(lineNeed({ id: 'e', kind: 'speech', text: '   ' }, doc)).toBe(0);
    expect(panelNeed([], doc)).toBe(0);
    // The storybook preset letters 15% larger, so the same words need more of the page.
    const story = docWith((d) => (d.letterStyle = { presetId: 'storybook' }));
    expect(lineNeed(speech('a', 12), story)).toBeGreaterThan(lineNeed(speech('a', 12), doc));
    expect(panelNeed([speech('x', 8), speech('y', 8, 4)], doc)).toBeCloseTo(lineNeed(speech('x', 8), doc) + lineNeed(speech('y', 8, 4), doc), 4);
  });
});

describe('panelFit / fitState', () => {
  it('maps need ÷ area onto roomy / fits / tight / overfull with the kids hard limit', () => {
    expect(panelFit(0.0464, 0.084)).toBeCloseTo(0.5524, 3);
    expect(panelFit(0, 0)).toBe(0);
    expect(panelFit(0.01, 0)).toBe(Number.POSITIVE_INFINITY);
    expect([0.1, 0.2, 0.26, 0.31].map((f) => fitState(f))).toEqual(['roomy', 'fits', 'tight', 'overfull']);
    expect(fitState(0.27, PANEL_LIMITS.fitHardKids)).toBe('overfull');
    expect(hardFitLimit(docWith())).toBe(0.3);
    expect(hardFitLimit(docWith((d) => (d.brief.audience = 'kids 5–8')))).toBe(0.25);
    expect(hardFitLimit(docWith((d) => (d.format.kind = 'storybook')))).toBe(0.25);
  });
});

describe('wordBudget', () => {
  it('gives 11 / 20 / 32 / 40 words for 0.084 / 0.144 / 0.221 / 0.451 of the page', () => {
    expect([0.084, 0.144, 0.221, 0.451].map((a) => wordBudget(a))).toEqual([11, 20, 32, 40]);
  });

  it('charges about 2 words per extra balloon and never goes below 0', () => {
    expect(wordBudget(0.221, 2)).toBe(30);
    expect(wordBudget(0.084, 2)).toBe(9);
    expect(wordBudget(0.01)).toBe(0);
    expect(wordBudget(0)).toBe(0);
  });
});
