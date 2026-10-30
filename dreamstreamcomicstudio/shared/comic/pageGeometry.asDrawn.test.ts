// The layout as drawn, shared (moved from server prompts.ts): effectiveLayout is the page's blueprint when it agrees
// with its panels, else the blueprint synthesized from the sizes; drawnLayoutBoxes / drawnPanelBoxes measure it.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Box, type ComicDoc, type Page, type PanelSize } from './doc';
import { drawnLayoutBoxes, drawnPanelBoxes, effectiveLayout, estimatePanelBoxes, harmonizePanelSizes, layoutConflicts, panelBoxesFor, parseLayout, synthesizeLayout } from './pageGeometry';

const page = (layout: string, sizes: PanelSize[], qcBoxes?: Box[]): Page => ({
  id: 'pg',
  n: 1,
  summary: '',
  layout,
  panels: sizes.map((size, i) => ({ id: `p${i}`, n: i + 1, size, shot: 'medium', action: '', castIds: [], lines: [] })),
  render: qcBoxes ? { status: 'ready', history: [], qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: qcBoxes } } : { status: 'none', history: [] },
  balloons: []
});
const comic: Pick<ComicDoc, 'format'> = { format: { ...createEmptyDoc('geo').format, kind: 'comic', readingDirection: 'ltr' } };

describe('effectiveLayout (shared)', () => {
  it('keeps a blueprint that agrees with its panels; replaces one whose sizes contradict it', () => {
    const agrees = page('Row 1: one wide panel. Row 2: two equal panels.', ['wide', 'medium', 'medium']);
    expect(effectiveLayout(agrees, comic.format)).toBe(agrees.layout);
    const conflicts = page('Row 1: two equal panels. Row 2: one large panel.', ['wide', 'medium', 'medium']);
    expect(layoutConflicts(parseLayout(conflicts.layout!)!, conflicts.panels)).toBe(true);
    expect(effectiveLayout(conflicts, comic.format)).toBe(synthesizeLayout(conflicts.panels, comic.format));
    // Harmonized sizes make the blueprint drawable as written.
    const harmonized = { ...conflicts, panels: harmonizePanelSizes(conflicts.panels, parseLayout(conflicts.layout!)!) };
    expect(effectiveLayout(harmonized, comic.format)).toBe(conflicts.layout);
    // Another panel count, or a row grid on a webtoon, is synthesized too.
    expect(effectiveLayout(page('Row 1: two panels.', ['medium', 'medium', 'medium']), comic.format)).toBe(synthesizeLayout(page('', ['medium', 'medium', 'medium']).panels, comic.format));
    expect(effectiveLayout(page('Row 1: two equal panels.', ['medium', 'medium']), { kind: 'webtoon', readingDirection: 'ltr' })).toContain('Stacked vertically');
  });
});

describe('drawnLayoutBoxes / drawnPanelBoxes', () => {
  it('equal the blueprint estimate when the layout agrees with the sizes', () => {
    const p = page('Row 1: one wide panel. Row 2: two equal panels.', ['wide', 'medium', 'medium']);
    expect(drawnLayoutBoxes(comic, p)).toEqual(estimatePanelBoxes(p, { kind: 'comic', readingDirection: 'ltr' }));
  });

  it('measure the synthesized layout when the stored text contradicts the sizes (what the prompt draws)', () => {
    const p = page('Row 1: two equal panels. Row 2: one large panel.', ['wide', 'medium', 'medium']);
    const drawn = drawnLayoutBoxes(comic, p);
    expect(drawn).toEqual(estimatePanelBoxes({ ...p, layout: effectiveLayout(p, comic.format) }, { kind: 'comic', readingDirection: 'ltr' }));
    expect(drawn).not.toEqual(estimatePanelBoxes(p, { kind: 'comic', readingDirection: 'ltr' }));
    // Panel 1 (wide) spans the page as drawn; on the stored text it would be half width.
    expect(drawn[0].w).toBeGreaterThan(0.9);
    expect(drawnPanelBoxes(comic, p)).toEqual(drawn);
    // panelBoxesFor (the editor's and the board's reader) is unchanged: it still reads the stored text.
    expect(panelBoxesFor(comic, p)).toEqual(estimatePanelBoxes(p, { kind: 'comic', readingDirection: 'ltr' }));
  });

  it('a drawn take with measured boxes is measured on them', () => {
    const measured: Box[] = [{ x: 0.02, y: 0.02, w: 0.96, h: 0.3 }, { x: 0.02, y: 0.34, w: 0.47, h: 0.64 }, { x: 0.51, y: 0.34, w: 0.47, h: 0.64 }];
    const p = page('Row 1: two equal panels. Row 2: one large panel.', ['wide', 'medium', 'medium'], measured);
    expect(drawnPanelBoxes(comic, p)).toEqual(measured);
    // A count mismatch falls back to the layout as drawn.
    expect(drawnPanelBoxes(comic, page(p.layout!, ['wide', 'medium', 'medium'], measured.slice(0, 2)))).toEqual(drawnLayoutBoxes(comic, p));
  });

  it("a check that fell back stored an estimate on the stored text: it is not a measurement, so the layout as drawn wins", () => {
    // vision.ts stores `panelBoxes: estimated` with `boxesFrom: 'estimate'` when the check returns nothing or finds
    // another panel count; that estimate was made on the stored layout text, which the prompt did not draw.
    const conflicting = page('Row 1: two equal panels. Row 2: one large panel.', ['wide', 'medium', 'medium']);
    const storedTextEstimate = estimatePanelBoxes(conflicting, { kind: 'comic', readingDirection: 'ltr' });
    const fellBack: Page = {
      ...conflicting,
      render: { status: 'ready', history: [], qc: { score: 0.5, issues: [], checkedAt: 1, panelBoxes: storedTextEstimate, boxesFrom: 'estimate' } }
    };
    expect(storedTextEstimate).not.toEqual(drawnLayoutBoxes(comic, conflicting));
    expect(drawnPanelBoxes(comic, fellBack)).toEqual(drawnLayoutBoxes(comic, conflicting));
    expect(drawnPanelBoxes(comic, fellBack)[0].w).toBeGreaterThan(0.9);
    // Boxes the check really measured are used, whether marked 'vision' or written before the marker existed.
    const measured: Box[] = [{ x: 0.02, y: 0.02, w: 0.96, h: 0.3 }, { x: 0.02, y: 0.34, w: 0.47, h: 0.64 }, { x: 0.51, y: 0.34, w: 0.47, h: 0.64 }];
    const vision: Page = { ...conflicting, render: { status: 'ready', history: [], qc: { score: 1, issues: [], checkedAt: 1, panelBoxes: measured, boxesFrom: 'vision' } } };
    expect(drawnPanelBoxes(comic, vision)).toEqual(measured);
    expect(drawnPanelBoxes(comic, page(conflicting.layout!, ['wide', 'medium', 'medium'], measured))).toEqual(measured);
  });
});
