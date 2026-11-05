// @vitest-environment node
// The page prompt reads an inset the way the blueprint now places it (B9 FIX amendment): the rows are measured without
// the inset, and the inset is named in its host's corner — never "row 2" beside its own hero. A page with no inset
// reads exactly as before (the Ship 1 golden prompts and anchors.parity.test.ts pin that).
import { describe, expect, it } from 'vitest';
import type { ComicDoc, Page } from '../../../shared/comic/doc.js';
import { plannedDoc } from './orchestrator.fakes.js';
import { compilePage } from './prompts.js';

const HERO_INSET = 'Row 1: one dominant splash panel across the full page (panel 1) with a small inset panel in its lower right corner (panel 2).';

const withLayout = (layout: string, n: number, sizes: Page['panels'][number]['size'][]): { doc: ComicDoc; page: Page } => {
  const doc = plannedDoc();
  const base = doc.pages[0];
  const panels = Array.from({ length: n }, (_, i) => ({ ...base.panels[i % base.panels.length], id: `pi${i}`, n: i + 1, size: sizes[i] }));
  const page: Page = { ...base, layout, panels };
  return { doc: { ...doc, pages: [page, ...doc.pages.slice(1)] }, page };
};
const lines = (doc: ComicDoc, page: Page) => compilePage(doc, page).prompt.split('\n');

describe('the page prompt and insets', () => {
  it('Hero + inset: the hero is one row, the inset sits in its lower right corner', () => {
    const { doc, page } = withLayout(HERO_INSET, 2, ['medium', 'small']);
    const all = lines(doc, page);
    const measured = all.find((l) => l.startsWith('Measured proportions:'))!;
    expect(measured).toBe(
      'Measured proportions: Row 1 (top 96% of the page): panel 1, full width. Inset: panel 2, a small panel drawn over the lower right corner of panel 1, 32% wide × 25% tall.'
    );
    expect(all).toContain(HERO_INSET);
    expect(all.find((l) => l.startsWith('PANEL 1 of 2'))).toContain('(row 1, full width; 96% wide × 96% tall)');
    expect(all.find((l) => l.startsWith('PANEL 2 of 2'))).toContain('(a small inset in the lower right corner of box 1, drawn over it; 32% wide × 25% tall)');
  });

  it('an inset in a shared row is named in its own host, and the other rows are measured as before', () => {
    const layout =
      'Row 1: one wide panel across the full width (panel 1). Row 2: one panel (panel 2), one panel (panel 3) side by side with a small inset panel in the upper left corner of panel 3 (panel 4).';
    const { doc, page } = withLayout(layout, 4, ['wide', 'medium', 'medium', 'small']);
    const all = lines(doc, page);
    const measured = all.find((l) => l.startsWith('Measured proportions:'))!;
    expect(measured).toMatch(/^Measured proportions: Row 1 \(top \d+% of the page\): panel 1, full width\. Row 2 \(next \d+%\): panels 2 and 3 side by side, 47% wide each\. Inset: panel 4, a small panel drawn over the upper left corner of panel 3, 16% wide × \d+% tall\.$/);
    expect(all.find((l) => l.startsWith('PANEL 4 of 4'))).toContain('a small inset in the upper left corner of box 3, drawn over it;');
  });

  it('a full-page splash with its inset numbered first does not add up: the page compiles on its synthesized layout', () => {
    // The blueprint once placed the splash as panel 2 with no box for panel 1, and rowTopsOf threw on the hole.
    const s = 'One full-page splash panel with a small inset panel in the upper left corner of panel 2 (panel 1).';
    const { doc, page } = withLayout(s, 2, ['splash', 'small']);
    const prompt = compilePage(doc, page).prompt;
    expect(prompt).not.toContain(s);
    expect(prompt).not.toMatch(/\binset\b/i);
    expect(prompt).toMatch(/PANEL 1 of 2/);
    expect(prompt).toMatch(/PANEL 2 of 2/);
  });

  it('a page without an inset never mentions one', () => {
    const { doc, page } = withLayout('Row 1: one wide panel across the full width (panel 1). Row 2: two equal panels side by side (panels 2–3).', 3, ['wide', 'medium', 'medium']);
    const prompt = compilePage(doc, page).prompt;
    expect(prompt).not.toMatch(/inset/i);
    expect(prompt).toContain('Measured proportions: Row 1 (top ');
  });
});
