// @vitest-environment node
// The page layout guide (plan §4.2, C9): black borders exactly where the boxes say (±1 px), pure
// white gutters, a near-white fill, no text or anti-aliasing, at the job's aspect.
import sharp from 'sharp';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../../lib/logger.js';
import { createEmptyDoc, emptyRender, type Box, type Page, type Panel } from '../../../../shared/comic/doc.js';
import { estimatePanelBoxes } from '../../../../shared/comic/pageGeometry.js';
import { pageLayoutBoxes } from '../prompts.js';
import { StudioError } from '../types.js';
import {
  COMIC_LAYOUT_GUIDE_FLAG,
  GUIDE_BORDER,
  GUIDE_FILL,
  GUIDE_GUTTER,
  guideStrokePx,
  layoutGuideEnabled,
  layoutGuideSize,
  renderLayoutGuide,
  renderPageLayoutGuide,
  tryRenderPageLayoutGuide,
  type GuideRect
} from './wireframe.js';

const panels = (n: number): Panel[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, n: i + 1, size: 'medium', shot: 'medium', action: `Beat ${i + 1}.`, castIds: [], lines: [] }));

const THREE = 'Row 1: one wide panel. Row 2: two equal panels.';
const SPAN = 'Row 1: one wide panel. Rows 2–3: one tall panel on the left beside two stacked panels on the right.';

/** Decode a PNG to raw RGB and give a grey-level reader. */
const decode = async (png: Buffer) => {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { data, info, at };
};

/** First x in [from, to] (stepping ±1) whose pixel is black on row y. */
const firstBlack = (at: (x: number, y: number) => number[], y: number, from: number, to: number, axis: 'x' | 'y' = 'x'): number => {
  const step = to >= from ? 1 : -1;
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
    const p = axis === 'x' ? at(v, y) : at(y, v);
    if (p[0] === GUIDE_BORDER) return v;
  }
  return Number.NaN;
};

describe('layout guide size and flag', () => {
  it('follows the job aspect, the resolution class on the long edge, capped at 2K', () => {
    expect(layoutGuideSize('2:3', '2K')).toEqual({ width: 1365, height: 2048 });
    expect(layoutGuideSize('4:5', '1K')).toEqual({ width: 819, height: 1024 });
    expect(layoutGuideSize('16:9', '2K')).toEqual({ width: 2048, height: 1152 });
    expect(layoutGuideSize('1:4', '2K')).toEqual({ width: 512, height: 2048 });
    expect(layoutGuideSize('2:3', '4K')).toEqual({ width: 1365, height: 2048 });
    expect(guideStrokePx(1365)).toBe(5);
    expect(guideStrokePx(512)).toBe(2);
    expect(guideStrokePx(1000, { stroke: 0.01 })).toBe(10);
    expect(guideStrokePx(1000, { stroke: 9 })).toBe(4); // out of range → default
  });

  it('is OFF unless COMIC_LAYOUT_GUIDE is set (provisional default until the A/B)', () => {
    expect(COMIC_LAYOUT_GUIDE_FLAG).toBe('COMIC_LAYOUT_GUIDE');
    expect(layoutGuideEnabled({})).toBe(false);
    expect(layoutGuideEnabled({ COMIC_LAYOUT_GUIDE: '0' })).toBe(false);
    expect(layoutGuideEnabled({ COMIC_LAYOUT_GUIDE: '' })).toBe(false);
    expect(layoutGuideEnabled({ COMIC_LAYOUT_GUIDE: '1' })).toBe(true);
    expect(layoutGuideEnabled({ COMIC_LAYOUT_GUIDE: 'true' })).toBe(true);
  });
});

describe('renderLayoutGuide', () => {
  for (const [name, layout, n] of [
    ['3 panels (wide over a pair)', THREE, 3],
    ['tall beside a stack', SPAN, 4]
  ] as const) {
    it(`${name}: borders at the expected pixels (±1), white gutters, flat fill, no text`, async () => {
      const boxes = estimatePanelBoxes({ panels: panels(n), layout }, { kind: 'comic', readingDirection: 'ltr' });
      const guide = await renderLayoutGuide(boxes, '2:3', '1K');
      expect(guide.mimeType).toBe('image/png');
      expect(guide.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(guide.rects).toHaveLength(n);
      const { info, data, at } = await decode(guide.buffer);
      expect([info.width, info.height]).toEqual([683, 1024]);
      const s = guide.stroke;
      expect(s).toBe(3);

      for (const [i, b] of boxes.entries()) {
        const left = b.x * info.width;
        const right = (b.x + b.w) * info.width;
        const top = b.y * info.height;
        const bottom = (b.y + b.h) * info.height;
        const midY = Math.round(top + (bottom - top) / 2);
        const midX = Math.round(left + (right - left) / 2);
        // Outer edges of the black border, scanning in from the gutter.
        expect(Math.abs(firstBlack(at, midY, Math.round(left) - 6, Math.round(left) + 6) - left), `box ${i + 1} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(firstBlack(at, midY, Math.round(right) + 5, Math.round(right) - 7) + 1 - right), `box ${i + 1} right`).toBeLessThanOrEqual(1);
        expect(Math.abs(firstBlack(at, midX, Math.round(top) - 6, Math.round(top) + 6, 'y') - top), `box ${i + 1} top`).toBeLessThanOrEqual(1);
        expect(Math.abs(firstBlack(at, midX, Math.round(bottom) + 5, Math.round(bottom) - 7, 'y') + 1 - bottom), `box ${i + 1} bottom`).toBeLessThanOrEqual(1);
        // The border is exactly `stroke` pixels wide, then the near-white fill.
        const l = guide.rects[i].left;
        for (let k = 0; k < s; k += 1) expect(at(l + k, midY)).toEqual([GUIDE_BORDER, GUIDE_BORDER, GUIDE_BORDER]);
        expect(at(l + s, midY)).toEqual([GUIDE_FILL, GUIDE_FILL, GUIDE_FILL]);
        expect(at(midX, midY)).toEqual([GUIDE_FILL, GUIDE_FILL, GUIDE_FILL]);
      }

      // Every pixel outside the panel rectangles (gutters and margin) is pure white.
      const inside = (x: number, y: number, rects: GuideRect[]) => rects.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom);
      let nonWhiteGutter = 0;
      let gutterPixels = 0;
      let tinted = 0;
      const colours = new Set<number>();
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const i = (y * info.width + x) * info.channels;
          const r = data[i];
          colours.add(r);
          if (r !== data[i + 1] || r !== data[i + 2]) tinted += 1;
          if (!inside(x, y, guide.rects)) {
            gutterPixels += 1;
            if (r !== GUIDE_GUTTER || data[i + 1] !== GUIDE_GUTTER || data[i + 2] !== GUIDE_GUTTER) nonWhiteGutter += 1;
          }
        }
      }
      expect(tinted).toBe(0);
      expect(gutterPixels).toBeGreaterThan(info.width * 10);
      expect(nonWhiteGutter).toBe(0);
      // Three flat levels only: no text, no anti-aliased strokes, nothing to copy but the borders.
      expect([...colours].sort((a, b) => a - b)).toEqual([GUIDE_BORDER, GUIDE_FILL, GUIDE_GUTTER]);
    });
  }

  it('a frame style sets the border width; a webtoon stack keeps its tall aspect', async () => {
    const boxes = estimatePanelBoxes({ panels: panels(2), layout: 'Row 1: one wide panel. Row 2: one wide panel.' }, { kind: 'comic' });
    const thick = await renderLayoutGuide(boxes, '2:3', '1K', { stroke: 0.012 });
    expect(thick.stroke).toBe(8);
    const { at } = await decode(thick.buffer);
    const r = thick.rects[0];
    const midY = Math.round((r.top + r.bottom) / 2);
    expect(at(r.left + 7, midY)[0]).toBe(GUIDE_BORDER);
    expect(at(r.left + 8, midY)[0]).toBe(GUIDE_FILL);
    const tall = await renderLayoutGuide(estimatePanelBoxes({ panels: panels(4), layout: '' }, { kind: 'webtoon' }), '1:4', '2K');
    expect([tall.width, tall.height]).toEqual([512, 2048]);
    expect(tall.rects).toHaveLength(4);
  });

  it('refuses when no box is drawable; skips invalid boxes', async () => {
    await expect(renderLayoutGuide([], '2:3', '1K')).rejects.toBeInstanceOf(StudioError);
    await expect(renderLayoutGuide([{ x: 0.1, y: 0.1, w: 0, h: 0.5 }], '2:3', '1K')).rejects.toThrow(/no panel boxes/);
    const bad = [{ x: Number.NaN, y: 0, w: 0.5, h: 0.5 }, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }] as Box[];
    expect((await renderLayoutGuide(bad, '2:3', '1K')).rects).toHaveLength(1);
  });

  it('renderPageLayoutGuide draws exactly the boxes the prompt describes', async () => {
    const doc = createEmptyDoc('d', 'T', 1);
    const page: Page = { id: 'pg', n: 1, summary: '', layout: SPAN, panels: panels(4), render: emptyRender(), balloons: [] };
    const guide = await renderPageLayoutGuide(doc, page, '2:3', '1K');
    const boxes = pageLayoutBoxes(doc, page);
    expect(guide.rects).toEqual(
      boxes.map((b) => ({
        left: Math.round(b.x * 683),
        top: Math.round(b.y * 1024),
        right: Math.round((b.x + b.w) * 683),
        bottom: Math.round((b.y + b.h) * 1024)
      }))
    );
  });
});

describe('tryRenderPageLayoutGuide (a guide failure never fails the page job)', () => {
  afterEach(() => vi.restoreAllMocks());
  const pageOf = (n: number, layout = ''): Page => ({ id: `pg_${n}`, n: 1, summary: '', layout, panels: panels(n), render: emptyRender(), balloons: [] });

  it('returns the same guide as renderPageLayoutGuide and logs nothing when it draws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const doc = createEmptyDoc('d', 'T', 1);
    const guide = await tryRenderPageLayoutGuide(doc, pageOf(3, THREE), '2:3', '1K');
    expect(guide).not.toBeNull();
    expect(guide!.rects).toEqual((await renderPageLayoutGuide(doc, pageOf(3, THREE), '2:3', '1K')).rects);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and logs comic_layout_guide_failed instead of throwing (no drawable box)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const doc = createEmptyDoc('d', 'T', 1);
    // The plain renderer refuses this page with a 400 …
    await expect(renderPageLayoutGuide(doc, pageOf(0), '2:3', '1K')).rejects.toBeInstanceOf(StudioError);
    // … the safe one resolves to null, so the runner recompiles without the guide and draws on.
    await expect(tryRenderPageLayoutGuide(doc, pageOf(0), '2:3', '1K', undefined, { jobId: 'job_1' })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('comic_layout_guide_failed');
    expect(warn.mock.calls[0][1]).toMatchObject({ jobId: 'job_1', pageId: 'pg_0', panels: 0, aspect: '2:3', res: '1K' });
    expect(String(warn.mock.calls[0][1]?.message)).toMatch(/no panel boxes/);
  });
});
