// shared/comic/pageGeometry.ts is the one copy of the page-blueprint geometry (contract §11.1).
//   1. The board's pageLayout.ts is now a re-export (same functions, not copies).
//   2. Golden: the server twins (vision.ts estimatePanelBoxes, prompts.ts parseLayout /
//      synthesizeLayout) still agree with it, so P2-SERVER can switch them over safely.
import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import * as board from '../../components/comicstudio/board/pageLayout';
import { estimatePanelBoxes as serverBoxes } from '../../server/src/comic/vision';
import { parseLayout as serverParse, synthesizeLayout as serverSynth } from '../../server/src/comic/prompts';
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

describe('golden: the server twins agree (gate for P2-SERVER switching vision.ts / prompts.ts)', () => {
  it('parseLayout and synthesizeLayout match', () => {
    for (const [layout, sizes] of LAYOUTS) {
      expect(geo.parseLayout(layout)).toEqual(serverParse(layout));
      for (const kind of ['comic', 'manga', 'webtoon', 'strip', 'storybook'] as const) {
        for (const readingDirection of ['ltr', 'rtl'] as const) {
          expect(geo.synthesizeLayout(panelsOf(sizes), { kind, readingDirection })).toBe(serverSynth(panelsOf(sizes), { kind, readingDirection }));
        }
      }
    }
  });

  it('estimatePanelBoxes matches for every blueprint, kind and direction', () => {
    const doc = makeSampleDoc();
    const pages = [...doc.pages, ...LAYOUTS.map(([layout, sizes]) => pageOf(layout, sizes))];
    for (const page of pages) {
      for (const kind of ['comic', 'webtoon', 'strip'] as const) {
        for (const readingDirection of ['ltr', 'rtl'] as const) {
          expect(geo.estimatePanelBoxes(page, { kind, readingDirection })).toEqual(serverBoxes(page, { kind, readingDirection }));
        }
      }
    }
  });
});
