// Probe: lettering-editor — does moving a balloon change its text size? (fitBalloonText bounds the text
// height by the room between the balloon's TOP and its panel's BOTTOM edge; a pinned balloon cannot grow,
// so it shrinks its font up to 18 % and is flagged `overflow` as soon as its bottom crosses the panel edge —
// even though every line still sits inside the balloon.)
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../components/comicstudio/lettering/fontFiles', () => ({ FONT_FILES: {} }));
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../shared/comic/lettering/layout';
import { panelBoxesFor } from '../../shared/comic/pageGeometry';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

/** l2 (whisper, panel 2 — the bottom-left panel) pinned at `y`. */
const whisperAt = (y: number, text: string) => {
  const doc = makeSampleDoc((d) => {
    const page = d.pages[0];
    page.panels[1].lines[0].text = text;
    page.balloons = page.balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, y, pinned: true } : b));
  });
  const page = doc.pages[0];
  const plan = planLettering(doc, page, ASPECT, estimateMeasure).find((p) => p.lineId === 'pg_1_l2')!;
  return { plan, panel: panelBoxesFor(doc, page)[1] };
};

/** l1 (caption, panel 1 — the wide top panel) pinned at `y`. */
const captionAt = (y: number, text: string) => {
  const doc = makeSampleDoc((d) => {
    const page = d.pages[0];
    page.panels[0].lines[0].text = text;
    page.balloons = page.balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, y, pinned: true } : b));
  });
  const page = doc.pages[0];
  const plan = planLettering(doc, page, ASPECT, estimateMeasure).find((p) => p.lineId === 'pg_1_l1')!;
  return { plan, panel: panelBoxesFor(doc, page)[0] };
};

const TEXT = 'Just one more and then we go home, I promise you that.';

describe('P5 — dragging a pinned balloon toward the bottom of its panel', () => {
  it('never changes the text size or claims the text does not fit while every line is inside the balloon', () => {
    const high = whisperAt(0.55, TEXT); // well inside panel 2
    const { panel } = high;
    expect(high.plan.overflow).toBe(false);
    const heightFrac = high.plan.h / H;
    // Bottom edge 0.4 × the balloon's height past the panel's bottom edge (a balloon straddling the gutter).
    const low = whisperAt(panel.y + panel.h - heightFrac * 0.6, TEXT);
    expect(low.plan.runs.length).toBeGreaterThan(0); // every wrapped line is drawn (the engine never clips)
    // Observed: the font drops to the 82 % floor and the editor shows "Text doesn’t fit".
    expect.soft(low.plan.fontSize).toBeCloseTo(high.plan.fontSize, 2);
    expect.soft(low.plan.overflow).toBe(false);
  });

  it('is continuous: a caption that straddles its panel’s bottom edge is shrunk, one dragged fully below it is not', () => {
    const inside = captionAt(0.1, TEXT);
    const { panel } = inside;
    const heightFrac = inside.plan.h / H;
    const crossing = captionAt(panel.y + panel.h - heightFrac * 0.6, TEXT);
    const below = captionAt(panel.y + panel.h + 0.02, TEXT);
    // Expected: the same size everywhere. Observed: crossing < inside === below (size jumps with position).
    expect.soft(crossing.plan.fontSize).toBeCloseTo(inside.plan.fontSize, 2);
    expect.soft(below.plan.fontSize).toBeCloseTo(inside.plan.fontSize, 2);
    expect.soft(crossing.plan.overflow).toBe(false);
  });
});
