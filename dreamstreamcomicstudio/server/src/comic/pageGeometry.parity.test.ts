// Golden (moved from shared/comic/pageGeometry.test.ts by P2-AMEND so the client typecheck never pulls
// server code): the server twins — vision.ts estimatePanelBoxes, prompts.ts parseLayout / synthesizeLayout —
// agree with shared/comic/pageGeometry.ts on every blueprint, kind and direction. This is the gate that lets
// P2-SERVER switch vision.ts / prompts.ts over to the shared module safely (and keeps them equal after).
import { describe, expect, it } from 'vitest';
import type { Page, Panel, PanelSize } from '../../../shared/comic/doc.js';
import * as geo from '../../../shared/comic/pageGeometry.js';
import { plannedDoc } from './orchestrator.fakes.js';
import { parseLayout as serverParse, synthesizeLayout as serverSynth } from './prompts.js';
import { estimatePanelBoxes as serverBoxes } from './vision.js';

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
  ['Row 1: two panels.', ['medium', 'medium', 'medium']], // blueprint disagrees with the panel count
  ['Row 1: two equal panels side by side (panels 1–2). Row 2: two equal panels side by side (panels 3–4).', ['medium', 'medium', 'medium', 'medium']]
];

describe('golden: the server twins agree with shared/comic/pageGeometry', () => {
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
    const pages = [...plannedDoc().pages, ...LAYOUTS.map(([layout, sizes]) => pageOf(layout, sizes))];
    for (const page of pages) {
      for (const kind of ['comic', 'webtoon', 'strip'] as const) {
        for (const readingDirection of ['ltr', 'rtl'] as const) {
          expect(geo.estimatePanelBoxes(page, { kind, readingDirection })).toEqual(serverBoxes(page, { kind, readingDirection }));
        }
      }
    }
  });
});
