// shared/comic/pageGeometry.ts is the one copy of the page-blueprint geometry (contract §11.1).
// The board's pageLayout.ts is a re-export (same functions, not copies).
// The golden check against the server twins (vision.ts estimatePanelBoxes, prompts.ts parseLayout /
// synthesizeLayout) lives in server/src/comic/pageGeometry.parity.test.ts, so the client typecheck
// never pulls server code (P2-AMEND moved it).
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import * as board from '../../components/comicstudio/board/pageLayout';
import type { Page, Panel, PanelSize } from './doc';
import * as geo from './pageGeometry';

const panelsOf = (sizes: PanelSize[]): Panel[] =>
  sizes.map((size, i) => ({ id: `p${i}`, n: i + 1, size, shot: 'medium', action: '', castIds: [], lines: [] }));
const pageOf = (layout: string, sizes: PanelSize[]): Page => ({
  id: 'pg',
  n: 1,
  summary: '',
  layout,
  panels: panelsOf(sizes),
  render: { status: 'none', history: [] },
  balloons: []
});

const LAYOUTS: [string, PanelSize[]][] = [
  ['Row 1: one wide panel. Row 2: two equal panels.', ['wide', 'medium', 'medium']],
  ['Row 1: three small panels. Row 2: one wide panel. Row 3: two panels.', ['small', 'small', 'small', 'wide', 'medium', 'medium']],
  ['One full-page splash panel.', ['splash']],
  ['Row 1: a tall panel on the left beside two stacked panels. Row 2: one wide panel.', ['tall', 'medium', 'medium', 'wide']],
  ['Panels stacked vertically: 1, 2, 3.', ['large', 'medium', 'large']],
  ['', ['medium', 'medium', 'medium', 'medium']],
  ['Row 1: two panels.', ['medium', 'medium', 'medium']] // blueprint disagrees with the panel count
];

describe('pageGeometry is the single source', () => {
  it('the board re-exports the same functions', () => {
    expect(board.estimatePanelBoxes).toBe(geo.estimatePanelBoxes);
    expect(board.panelBoxesFor).toBe(geo.panelBoxesFor);
    expect(board.parseLayout).toBe(geo.parseLayout);
    expect(board.synthesizeLayout).toBe(geo.synthesizeLayout);
    expect(board.regionFromPoints).toBe(geo.regionFromPoints);
    expect(board.panelForRegion).toBe(geo.panelForRegion);
    expect(board.panelAtPoint).toBe(geo.panelAtPoint);
    expect(board.toPagePoint).toBe(geo.toPagePoint);
    expect(board.layoutPanelCount).toBe(geo.layoutPanelCount);
    expect(board.MIN_REGION).toBe(geo.MIN_REGION);
  });

  it('prefers measured qc.panelBoxes when the count matches', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const measured = [
      { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
      { x: 0.1, y: 0.5, w: 0.35, h: 0.4 },
      { x: 0.55, y: 0.5, w: 0.35, h: 0.4 }
    ];
    const withQc = { ...page, render: { ...page.render, qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: measured } } };
    expect(geo.panelBoxesFor(doc, withQc)).toEqual(measured);
    const wrongCount = { ...page, render: { ...page.render, qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: measured.slice(0, 2) } } };
    expect(geo.panelBoxesFor(doc, wrongCount)).toEqual(geo.estimatePanelBoxes(page, { readingDirection: doc.format.readingDirection, kind: doc.format.kind }));
  });
});

describe('blueprints the board and the server both feed in', () => {
  it('estimatePanelBoxes gives one box per panel inside the page, for every blueprint, kind and direction', () => {
    for (const [layout, sizes] of LAYOUTS) {
      const page = pageOf(layout, sizes);
      for (const kind of ['comic', 'webtoon', 'strip'] as const) {
        for (const readingDirection of ['ltr', 'rtl'] as const) {
          const boxes = geo.estimatePanelBoxes(page, { kind, readingDirection });
          expect(boxes).toHaveLength(sizes.length);
          for (const b of boxes) {
            expect(b.x).toBeGreaterThanOrEqual(0);
            expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-9);
            expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-9);
          }
          expect(board.estimatePanelBoxes(page, { kind, readingDirection })).toEqual(boxes);
        }
      }
      expect(typeof geo.synthesizeLayout(panelsOf(sizes), { kind: 'comic', readingDirection: 'ltr' })).toBe('string');
    }
  });
});

// B9 FIX amendment: the blueprint reads the editor's inset clause. The inset is its own panel (outside every row), in a
// corner of its host, at layoutText's geometry; the rows keep the other reading numbers. A sentence without the clause
// reads as before (server/src/comic/layoutSentences.golden.test.ts pins every sentence the code and fixtures make).
describe('the inset clause', () => {
  const pageWith = (layout: string, n: number): Pick<Page, 'panels' | 'layout'> => ({ layout, panels: panelsOf(new Array(n).fill('medium')) });

  it('Hero + inset: one row for the hero, the inset in its lower right corner', () => {
    const s = 'Row 1: one dominant splash panel across the full page (panel 1) with a small inset panel in its lower right corner (panel 2).';
    expect(geo.parseLayout(s)).toEqual({ mode: 'rows', rows: [{ panels: [0], weight: 2.2 }], insets: [{ panel: 1, host: 0, vert: 'lower', horiz: 'right' }] });
    const [hero, inset] = geo.estimatePanelBoxes(pageWith(s, 2));
    expect(hero).toEqual({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 });
    expect(inset).toEqual(geo.layoutInsetBox(hero, 'lower', 'right'));
    expect(inset).toEqual({ x: 0.63, y: 0.7004, w: 0.32, h: 0.2496 });
    // The board's re-export reads it the same way.
    expect(board.estimatePanelBoxes(pageWith(s, 2))).toEqual([hero, inset]);
  });

  it('an inset in a stacked panel is counted (the old parse counted 3 of these 4 panels) and keeps the reading numbers', () => {
    const s = 'Rows 1–2: one tall panel on the left (panel 1) beside two stacked panels on the right (panels 2–3) with a small inset panel in the upper left corner of panel 3 (panel 4).';
    const parsed = geo.parseLayout(s)!;
    expect(geo.layoutPanelCount(parsed)).toBe(4);
    expect(parsed.rows).toEqual([{ panels: [0, 1, 2], weight: 2, span: { tallSide: 'left', stacked: 2 } }]);
    expect(parsed.insets).toEqual([{ panel: 3, host: 2, vert: 'upper', horiz: 'left' }]);
    const boxes = geo.estimatePanelBoxes(pageWith(s, 4));
    expect(boxes[3]).toEqual(geo.layoutInsetBox(boxes[2], 'upper', 'left'));
  });

  it('an inset before the next row takes its reading number; the next row panels follow it', () => {
    const s = 'Row 1: one large panel across the full width (panel 1) with a small inset panel in its upper left corner (panel 2). Row 2: two equal panels side by side (panels 3–4).';
    const parsed = geo.parseLayout(s)!;
    expect(parsed.rows.map((r) => r.panels)).toEqual([[0], [2, 3]]);
    expect(parsed.insets).toEqual([{ panel: 1, host: 0, vert: 'upper', horiz: 'left' }]);
  });

  it('a sentence without the clause, or with one that does not add up, parses exactly as before', () => {
    const plain = 'Row 1: one wide panel. Row 2: two equal panels.';
    expect(geo.parseLayout(plain)).toEqual({ mode: 'rows', rows: [{ panels: [0], weight: 1 }, { panels: [1, 2], weight: 1 }] });
    expect('insets' in geo.parseLayout(plain)!).toBe(false);
    const broken = 'Row 1: one wide panel across the full width (panel 1) with a small inset panel in its lower right corner (panel 7).';
    // (The old reading: two panels side by side, the word "small" making the row short.)
    expect(geo.parseLayout(broken)).toEqual({ mode: 'rows', rows: [{ panels: [0, 1], weight: 0.85 }] });
  });
});
