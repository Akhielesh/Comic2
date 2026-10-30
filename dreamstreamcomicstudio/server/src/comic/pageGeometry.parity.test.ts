// Golden (moved from shared/comic/pageGeometry.test.ts by P2-AMEND so the client typecheck never pulls
// server code): the server twins — vision.ts estimatePanelBoxes, prompts.ts parseLayout / synthesizeLayout —
// agree with shared/comic/pageGeometry.ts on every blueprint, kind and direction. This is the gate that lets
// P2-SERVER switch vision.ts / prompts.ts over to the shared module safely (and keeps them equal after).
import { describe, expect, it } from 'vitest';
import type { Box, Page, Panel, PanelSize } from '../../../shared/comic/doc.js';
import { framesFromLayoutText, INSET, insetBox, layoutTextOf } from '../../../shared/comic/editor/layoutText.js';
import { PAGE_TEMPLATES, templateLayout } from '../../../shared/comic/editor/templates.js';
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

// B9 FIX amendment: the blueprint reads the inset clause the editor's layoutText writes. Every form it writes — an
// inset in a full-width row panel ("its … corner"), in the full-page hero, in a tall span panel, in a cell of a shared
// row or in a stacked panel ("the … corner of panel H"), several on one page, in all four corners, in both reading
// directions — is built from real frames here. The server twins (vision.ts estimatePanelBoxes, prompts.ts
// parseLayout) read it exactly like the shared module, and the estimate puts each inset where the editor's frames are.
describe('golden: the inset clause, client and server alike', () => {
  const CORNERS = [
    ['upper', 'left'],
    ['upper', 'right'],
    ['lower', 'left'],
    ['lower', 'right']
  ] as const;
  /** Inset-bearing frames (reading order) from every template's frames: one inset per host and corner, right after it. */
  const insetCases = (): { frames: Box[]; rtl: boolean; label: string }[] => {
    const out: { frames: Box[]; rtl: boolean; label: string }[] = [];
    for (const t of PAGE_TEMPLATES.filter((x) => !x.webtoon && x.id !== 'hero-inset' && x.id !== 'splash')) {
      for (const rtl of [false, true]) {
        const base = templateLayout(t, { rtl }).frames;
        base.forEach((host, h) => {
          for (const [vert, horiz] of CORNERS) {
            const frames = [...base];
            frames.splice(h + 1, 0, insetBox(host, vert, horiz));
            out.push({ frames, rtl, label: `${t.id} rtl=${rtl} host ${h + 1} ${vert} ${horiz}` });
          }
        });
        // Two insets on one page: in the first and the last panel.
        if (base.length >= 2) {
          const frames = [...base];
          frames.push(insetBox(base[base.length - 1], 'lower', 'left'));
          frames.splice(1, 0, insetBox(base[0], 'upper', 'right'));
          out.push({ frames, rtl, label: `${t.id} rtl=${rtl} two insets` });
        }
      }
    }
    return out;
  };

  it('every inset form layoutText writes parses to its panel count, with the inset outside the rows', () => {
    const cases = insetCases();
    expect(cases.length).toBeGreaterThan(150);
    const forms = new Set<string>();
    for (const { frames, rtl, label } of cases) {
      const sentence = layoutTextOf(frames, { rtl });
      expect(sentence, label).toMatch(/with a small inset panel in (its|the) (upper|lower) (left|right) corner/);
      forms.add(sentence.replace(/\d+/g, '#').replace(/(upper|lower) (left|right)/g, 'C'));
      const parsed = geo.parseLayout(sentence);
      expect(geo.layoutPanelCount(parsed), `${label}: ${sentence}`).toBe(frames.length);
      expect(serverParse(sentence), label).toEqual(parsed);
      const rowPanels = parsed!.rows.flatMap((r) => r.panels);
      for (const inset of parsed!.insets!) {
        expect(rowPanels, label).not.toContain(inset.panel);
        expect(rowPanels, label).toContain(inset.host);
      }
    }
    // The "its" form (full-width rows, the hero, a tall span panel) and the "of panel H" form (shared rows, stacks).
    expect([...forms].some((f) => /in its C corner \(panel #\)/.test(f))).toBe(true);
    expect([...forms].some((f) => /in the C corner of panel # \(panel #\)/.test(f))).toBe(true);
    expect([...forms].some((f) => /tall panel[^.]*in its C corner/.test(f))).toBe(true);
    expect([...forms].some((f) => /stacked panels[^.]*in the C corner of panel #/.test(f))).toBe(true);
  });

  it('estimatePanelBoxes (shared and vision.ts) places every inset at the frames the sentence gives (framesFromLayoutText)', () => {
    for (const { frames, rtl, label } of insetCases()) {
      const sentence = layoutTextOf(frames, { rtl });
      const page = pageOf(sentence, frames.map(() => 'medium' as PanelSize));
      const readingDirection = rtl ? 'rtl' : 'ltr';
      const shared = geo.estimatePanelBoxes(page, { kind: 'comic', readingDirection });
      expect(serverBoxes(page, { kind: 'comic', readingDirection }), label).toEqual(shared);
      const planned = framesFromLayoutText(sentence, frames.length, { rtl })!;
      expect(planned, `${label}: ${sentence}`).toBeTruthy();
      shared.forEach((b, i) => {
        for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(b[k] - planned[i][k]), `${label} panel ${i + 1} ${k}`).toBeLessThanOrEqual(2e-4);
      });
      // The inset boxes are layoutText.insetBox of their (estimated) host, to the digit.
      for (const inset of geo.parseLayout(sentence)!.insets!) {
        expect(shared[inset.panel], label).toEqual(insetBox(shared[inset.host], inset.vert, inset.horiz));
        expect(geo.layoutInsetBox(shared[inset.host], inset.vert, inset.horiz), label).toEqual(insetBox(shared[inset.host], inset.vert, inset.horiz));
      }
    }
  });

  it('the shared inset geometry is the editor\'s (one set of numbers)', () => {
    expect(geo.LAYOUT_INSET).toEqual(INSET);
  });

  it('a clause that does not add up reads as before (rows only, the old count)', () => {
    for (const s of [
      'Row 1: one wide panel across the full width (panel 1) with a small inset panel in its lower right corner (panel 5).',
      'Row 1: one wide panel across the full width (panel 1) with a small inset panel in its lower right corner (panel 1).',
      'Row 1: two equal panels side by side (panels 1–2) with a small inset panel in the lower right corner of panel 3 (panel 3).'
    ]) {
      const parsed = geo.parseLayout(s);
      expect(parsed?.insets, s).toBeUndefined();
      expect(serverParse(s), s).toEqual(parsed);
    }
  });
});
