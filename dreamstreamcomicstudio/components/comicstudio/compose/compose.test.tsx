// PE-COMPOSE (= pro plan B1): the page node tree, panels mode on the screen, overlays, guide-only and opaque layers,
// the border looks, and the Pro contract scan of the compose folder. Synthetic fixtures (__fixtures__/composeDocs.ts).

import React from 'react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_BORDER_STYLES } from '../../../shared/comic/doc';
import { EDITOR_LIMITS } from '../../../shared/comic/limits';
import { libAssetUrl } from '../../../shared/comic/assets/index';
import { borderMarks, composePage, framePathD, pageComposes, rectPathD, seedOf } from '../../../shared/comic/panelize/compose';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { frameAffine } from '../../../shared/comic/panelize/space';
import { framesShown } from '../../../shared/comic/editor/scene';
import { ComicPageView } from '../board/ComicPageView';
import { fakeUrlFor } from '../board/__fixtures__/sampleDoc';
import { makeQaDoc, QA_FIXTURES } from '../testing/qaFixtures';
import { composeScene, composeSvgNodes } from './pageNodes';
import { part } from './index';
import { fakePathUrl, framedDoc, LAYERS, layeredDoc, OTHER_PATHS, PHOTO_PATH, TAKE_PATH } from './__fixtures__/composeDocs';

const RASTER_URL = (doc: ReturnType<typeof framedDoc>) => fakeUrlFor(doc.pages[0].render.asset)!;

describe('composePage: one page node tree (shared/comic/panelize/compose.ts)', () => {
  it('no QA fixture page composes: every renderer keeps its old path for them', () => {
    for (const name of QA_FIXTURES) {
      for (const rtl of [false, true]) {
        const doc = makeQaDoc(name, { rtl });
        expect(doc.pages.filter((p) => pageComposes(p)).map((p) => p.id)).toEqual([]);
        expect(doc.pages.filter((p) => pageComposes(p, { guides: true })).map((p) => p.id)).toEqual([]);
      }
    }
  });

  it('panels mode: one piece per frame, each showing its cut of the ONE drawing, on the book aspect', () => {
    const doc = framedDoc();
    const page = doc.pages[0];
    const c = composePage(doc, page);
    expect(c.mode).toBe('panels');
    expect(c.aspect).toBeCloseTo(2 / 3, 6);
    expect(c.paper).toBe('#ffffff');
    expect(c.pieces).toHaveLength(page.panels.length);
    expect(c.paths).toEqual([page.render.asset!.path]);
    c.pieces.forEach((piece, i) => {
      expect(piece.raster).toBe(true);
      expect(piece.empty).toBe(false);
      expect(piece.dst).toEqual(page.panels[i].frame!.box);
      const aff = frameAffine(doc, page, page.panels[i])!;
      expect(piece.src!.x).toBeCloseTo(aff.src.x, 4);
      expect(piece.src!.w).toBeCloseTo(aff.src.w, 4);
      // Absent border = today's clean line (the frame style's width and colour).
      expect(piece.border).toEqual({ style: 'clean', w: 0.004, color: '#111111', seed: seedOf(page.panels[i].id) });
    });
    // The frames are where the editor scene shows them.
    expect(c.pieces.map((p) => p.dst)).toEqual(framesShown(doc, page).boxes);
  });

  it('caps a page at 1 + sourcesPerPage pictures: a fourth picture shows the panel’s cut of the drawing instead', () => {
    const doc = framedDoc((page) => {
      page.panels.push({ ...page.panels[2], id: 'pg_1_p4', n: 4, lines: [], frame: { box: { x: 0.5, y: 0.8, w: 0.4, h: 0.15 } } });
      page.render.cuts!.cuts.push({ panelId: 'pg_1_p4', drawn: 4, box: { x: 0.5, y: 0.8, w: 0.4, h: 0.15 }, conf: 1 });
      page.panels.forEach((p, i) => (p.frame = { ...p.frame!, src: { path: [TAKE_PATH, ...OTHER_PATHS][i] } }));
    });
    const c = composePage(doc, doc.pages[0]);
    expect(c.paths.length).toBeLessThanOrEqual(1 + EDITOR_LIMITS.sourcesPerPage);
    expect(c.paths).toEqual([doc.pages[0].render.asset!.path, TAKE_PATH, OTHER_PATHS[0]]);
    expect(c.pieces.map((p) => p.raster)).toEqual([false, false, true, true]);
  });

  it('a frame without a cut is empty; the drawing is not fetched when no frame shows it', () => {
    const doc = framedDoc((page) => {
      page.render.cuts!.cuts = page.render.cuts!.cuts.slice(0, 1);
      page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } };
    });
    const c = composePage(doc, doc.pages[0]);
    expect(c.pieces.map((p) => [p.raster, p.empty])).toEqual([
      [true, false],
      [false, false],
      [false, true]
    ]);
    const only = framedDoc((page) => page.panels.forEach((p) => (p.frame = { ...p.frame!, src: { path: TAKE_PATH } })));
    expect(composePage(only, only.pages[0]).paths).toEqual([TAKE_PATH]);
  });

  it('borders: none and a zero width draw nothing; bleed reaches the page edges it sits on and draws no line', () => {
    const doc = framedDoc((page) => {
      page.panels[0].frame = { ...page.panels[0].frame!, border: { none: true } };
      page.panels[1].frame = { ...page.panels[1].frame!, border: { w: 0 } };
      page.panels[2].frame = { ...page.panels[2].frame!, border: { style: 'bleed' } };
    });
    const [a, b, c] = composePage(doc, doc.pages[0]).pieces;
    expect(a.border).toBeUndefined();
    expect(b.border).toBeUndefined();
    expect(c.border).toBeUndefined();
    expect(c.bleed).toBe(true);
    // Panel 3 sits in the bottom-right corner: its frame grows to those two page edges, and only those.
    const frame = doc.pages[0].panels[2].frame!.box;
    expect(frame.x + frame.w).toBeCloseTo(0.97, 4);
    expect(c.dst.x + c.dst.w).toBeCloseTo(1, 3);
    expect(c.dst.y + c.dst.h).toBeCloseTo(1, 3);
    expect(c.dst.x).toBeCloseTo(frame.x, 3);
    // The picture keeps its scale while the frame grows.
    expect(c.dst.w / c.src!.w).toBeCloseTo(frame.w / composePage(framedDoc(), framedDoc().pages[0]).pieces[2].src!.w, 3);
  });

  it('every border look draws deterministic marks from its seed; clean is one straight stroked outline', () => {
    const piece = { dst: { x: 0.1, y: 0.1, w: 0.5, h: 0.3 }, radius: 0 };
    for (const style of PANEL_BORDER_STYLES) {
      const border = { style, w: 0.004, color: '#222222', seed: 42 };
      const marks = borderMarks({ ...piece, border }, 2 / 3);
      if (style === 'bleed') continue;
      expect(marks.length, style).toBeGreaterThan(0);
      expect(borderMarks({ ...piece, border }, 2 / 3), style).toEqual(marks);
      for (const m of marks) expect(m.d, style).toMatch(/^M[-\d.]+ [-\d.]+[MLHVQAZ\d .-]*$/);
    }
    const clean = borderMarks({ ...piece, border: { style: 'clean', w: 0.004, color: '#222222', seed: 1 } }, 2 / 3);
    expect(clean).toEqual([{ d: rectPathD(100, 150, 500, 450), stroke: '#222222', strokeW: 4, join: 'miter' }]);
    const rough = (seed: number) => borderMarks({ ...piece, border: { style: 'rough', w: 0.004, color: '#222222', seed } }, 2 / 3)[0].d;
    expect(rough(1)).not.toEqual(rough(2));
  });

  it('draw order is the editor scene’s: each frame then the overlays kept in it, then free overlays by z', () => {
    const doc = framedDoc((page) => {
      page.panels[0].frame = { ...page.panels[0].frame!, z: 2 };
      page.layers = [
        { ...LAYERS.shape, id: 'ly_free_hi', z: 5 },
        { ...LAYERS.shape, id: 'ly_in_p2', clip: page.panels[1].id },
        { ...LAYERS.shape, id: 'ly_free_lo', z: -1 }
      ];
    });
    const items = composePage(doc, doc.pages[0]).items.map((i) => (i.kind === 'piece' ? `frame:${i.piece.n}` : i.overlay.layer.id));
    expect(items).toEqual(['frame:2', 'ly_in_p2', 'frame:3', 'frame:1', 'ly_free_lo', 'ly_free_hi']);
  });

  it('compose math: a square cut in a wide frame is cropped to the frame’s shape, centred; zoom and pan move inside the cut', () => {
    const square = (fit?: { s: number; x: number; y: number }) =>
      framedDoc((page) => {
        page.render.asset = { ...page.render.asset!, w: 1000, h: 1000 };
        page.render.cuts!.cuts[0] = { ...page.render.cuts!.cuts[0], box: { x: 0, y: 0, w: 1, h: 1 } };
        page.panels[0].frame = { box: { x: 0, y: 0, w: 1, h: 0.25 }, ...(fit ? { fit } : {}) };
      });
    const piece = (fit?: { s: number; x: number; y: number }) => {
      const d = square(fit);
      return composePage(d, d.pages[0]).pieces[0];
    };
    // Book 2:3, frame full width × a quarter height → 8:3 physically: the full width of the square, 37.5 % of it high.
    expect(piece().src).toEqual({ x: 0, y: 0.3125, w: 1, h: 0.375 });
    expect(piece({ s: 2, x: 0, y: 0 }).src).toEqual({ x: 0.25, y: 0.4063, w: 0.5, h: 0.1875 });
    expect(piece({ s: 2, x: -1, y: 1 }).src).toEqual({ x: 0, y: 0.8125, w: 0.5, h: 0.1875 });
    // Upscale: how much the picture is enlarged at the drawing's width (zoom 2 doubles it).
    expect(piece({ s: 2, x: 0, y: 0 }).upscale).toBeCloseTo(2 * piece().upscale!, 2);
  });

  it('still pages draw the rest pose: a page’s motion never changes what composes or draws', () => {
    const still = layeredDoc([LAYERS.shape]);
    const moving = layeredDoc([LAYERS.shape]);
    moving.pages[0].motion = { clips: [{ id: 'mc_1', target: { k: 'layer', id: 'ly_box' }, role: 'loop', preset: 'float', at: { anchor: 'page', ms: 0 } }] } as never;
    expect(composeScene(moving, moving.pages[0])).toEqual(composeScene(still, still.pages[0]));
    const legacy = makeQaDoc('lake-1p');
    legacy.pages[0].motion = { clips: [] };
    expect(pageComposes(legacy.pages[0])).toBe(false);
  });

  it('opaque kinds are never drawn; guide-only layers only for the editor', () => {
    const doc = layeredDoc([LAYERS.opaque, LAYERS.guide]);
    const page = doc.pages[0];
    expect(page.layers!.map((l) => l.id)).toEqual(['ly_future', 'ly_guide']);
    expect(pageComposes(page)).toBe(false);
    expect(composePage(doc, page).overlays).toEqual([]);
    expect(composePage(doc, page, { guides: true }).overlays.map((o) => [o.layer.id, o.guide])).toEqual([['ly_guide', true]]);
  });
});

describe('the page node tree (compose/pageNodes.ts)', () => {
  it('panels mode: N pieces with ONE image URL; frame pictures resolve through urlForPath, at most 3 distinct per page (overlays are bounded by layersPerPage)', () => {
    const doc = framedDoc();
    const url = RASTER_URL(doc);
    const scene = composeScene(doc, doc.pages[0], { resolve: { rasterUrl: url, urlForPath: fakePathUrl } });
    const pieces = scene.nodes.filter((n) => n.k === 'piece');
    expect(pieces).toHaveLength(3);
    expect(new Set(pieces.map((p) => (p.k === 'piece' ? p.image?.url : '')))).toEqual(new Set([url]));
    expect(scene.urls).toEqual([url]);

    const many = framedDoc((page) => page.panels.forEach((p, i) => (p.frame = { ...p.frame!, src: { path: OTHER_PATHS[i] } })));
    const s2 = composeScene(many, many.pages[0], { resolve: { rasterUrl: url, urlForPath: fakePathUrl } });
    expect(s2.urls.length).toBeLessThanOrEqual(3);
    expect(s2.urls).toEqual([fakePathUrl(OTHER_PATHS[0]), fakePathUrl(OTHER_PATHS[1]), url]);
  });

  it('a picture with no URL is reported, never drawn from a guess', () => {
    const doc = layeredDoc([LAYERS.image]);
    const scene = composeScene(doc, doc.pages[0], { resolve: { rasterUrl: 'https://cdn.test/x.png' } });
    expect(scene.missing).toEqual([LAYERS.image.src!.path]);
    expect(scene.nodes.filter((n) => n.k === 'layer')).toEqual([]);
  });

  it('stickers draw the bundled library’s same-origin file; every kind is a g[data-layer-id]', () => {
    const doc = layeredDoc([LAYERS.image, LAYERS.sticker, LAYERS.shape, LAYERS.effect, LAYERS.blend]);
    const scene = composeScene(doc, doc.pages[0], { resolve: { urlForPath: fakePathUrl } });
    expect(scene.urls).toEqual([fakePathUrl(LAYERS.image.src!.path!), libAssetUrl(LAYERS.sticker.src!.lib!)]);
    const groups = composeSvgNodes(scene).filter((n) => n.tag === 'g');
    expect(groups.map((g) => [g.attrs['data-layer-id'], g.attrs['data-layer-kind']])).toEqual([
      ['ly_photo', 'image'],
      ['ly_star', 'image'],
      ['ly_box', 'shape'],
      ['ly_fx', 'effect'],
      ['ly_tone', 'shape']
    ]);
  });
});

describe('ComicPageView composes a page from the node tree', () => {
  const pieces = (container: HTMLElement) => [...container.querySelectorAll('[data-testid="composed-art"] g[data-panel-id]')];
  const hrefs = (container: HTMLElement) => [...container.querySelectorAll('[data-testid="composed-art"] image')].map((i) => i.getAttribute('href'));

  it('panels mode: no <img>; N pieces share one image URL; the page keeps the book aspect; lettering on top', () => {
    const doc = framedDoc();
    const page = doc.pages[0];
    const { container, getByRole } = render(<ComicPageView doc={doc} page={page} imageUrl={RASTER_URL(doc)} />);
    expect(container.querySelector('img')).toBeNull();
    expect(pieces(container)).toHaveLength(page.panels.length);
    expect(new Set(hrefs(container))).toEqual(new Set([RASTER_URL(doc)]));
    expect(getByRole('img', { name: /^Page 1/ }).getAttribute('data-testid')).toBe('composed-art');
    const box = container.querySelector<HTMLElement>('[data-testid="comic-page"]')!;
    expect(parseFloat(box.style.aspectRatio)).toBeCloseTo(2 / 3, 4);
    expect(container.querySelectorAll('[data-testid="balloon"]').length).toBeGreaterThan(0);
  });

  it('panels mode: the frames use at most 3 distinct picture URLs per page, other takes through urlForPath', () => {
    const doc = framedDoc((page) => {
      page.panels.push({ ...page.panels[2], id: 'pg_1_p4', n: 4, lines: [], frame: { box: { x: 0.5, y: 0.8, w: 0.4, h: 0.15 } } });
      page.render.cuts!.cuts.push({ panelId: 'pg_1_p4', drawn: 4, box: { x: 0.5, y: 0.8, w: 0.4, h: 0.15 }, conf: 1 });
      page.panels.forEach((p, i) => (p.frame = { ...p.frame!, src: { path: OTHER_PATHS[i] ?? TAKE_PATH } }));
    });
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} />);
    expect(pieces(container)).toHaveLength(4);
    expect(new Set(hrefs(container)).size).toBeLessThanOrEqual(3);
  });

  it('picks the variant for the most zoomed frame, and falls back like the <img> when the drawing fails', () => {
    const doc = framedDoc((page) => (page.panels[0].frame = { ...page.panels[0].frame!, fit: { s: 2, x: 0, y: 0 } }));
    const srcWidth = vi.fn((w: number) => `https://cdn.test/v-${w}.png`);
    const onImageError = vi.fn();
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 450, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 450, toJSON: () => ({}) }) as DOMRect;
    try {
      const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} srcWidth={srcWidth} onImageError={onImageError} />);
      expect(srcWidth).toHaveBeenLastCalledWith(600);
      expect(new Set(hrefs(container))).toEqual(new Set(['https://cdn.test/v-600.png']));
      // The variant fails: the original drawing; then the original fails too: the sketch, reported once.
      fireEvent.error(container.querySelector('[data-testid="composed-art"] image')!);
      expect(new Set(hrefs(container))).toEqual(new Set([RASTER_URL(doc)]));
      fireEvent.error(container.querySelector('[data-testid="composed-art"] image')!);
      expect(onImageError).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="composed-art"]')).toBeNull();
      expect(container.querySelector('[role="img"][aria-label="Page 1 plan sketch"]')).not.toBeNull();
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('page mode: overlays draw over the drawing as g[data-layer-id]; guide-only only with guides; opaque never', () => {
    const doc = layeredDoc([LAYERS.image, LAYERS.sticker, LAYERS.shape, LAYERS.effect, LAYERS.blend, LAYERS.guide, LAYERS.opaque]);
    const page = doc.pages[0];
    const ids = (c: HTMLElement) => [...c.querySelectorAll('g[data-layer-id]')].map((g) => g.getAttribute('data-layer-id'));
    const reader = render(<ComicPageView doc={doc} page={page} imageUrl={fakeUrlFor(page.render.asset)} urlForPath={fakePathUrl} paper letteringAriaHidden />);
    expect(reader.container.querySelector('img')).not.toBeNull();
    expect(ids(reader.container)).toEqual(['ly_photo', 'ly_star', 'ly_box', 'ly_fx', 'ly_tone']);
    // Overlays are part of the art: under the reader's paper and the lettering.
    const order = [...reader.container.querySelectorAll('[data-testid="composed-overlays"], [data-testid="reader-paper"]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['composed-overlays', 'reader-paper']);
    reader.unmount();
    const editor = render(<ComicPageView doc={doc} page={page} imageUrl={fakeUrlFor(page.render.asset)} urlForPath={fakePathUrl} guides />);
    expect(ids(editor.container)).toContain('ly_guide');
    expect(editor.container.querySelector('g[data-layer-id="ly_guide"]')!.getAttribute('data-guide')).toBe('true');
    expect(ids(editor.container)).not.toContain('ly_future');
  });

  it('an empty frame is a blank bordered frame for readers and a dashed placeholder in the editor', () => {
    const doc = framedDoc((page) => (page.render.cuts!.cuts = page.render.cuts!.cuts.slice(0, 2)));
    const reader = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} />);
    const empty = reader.container.querySelector('g[data-panel-id="pg_1_p3"]')!;
    expect(empty.getAttribute('data-empty')).toBe('blank');
    expect(empty.querySelector('image')).toBeNull();
    expect(empty.querySelector('path[stroke="#111111"]')).not.toBeNull();
    reader.unmount();
    const editor = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} guides />);
    expect(editor.container.querySelector('g[data-panel-id="pg_1_p3"] [data-placeholder]')).not.toBeNull();
  });

  it('frames that show only other pictures render without the page’s drawing URL', () => {
    const doc = framedDoc((page) => page.panels.forEach((p) => (p.frame = { ...p.frame!, src: { path: TAKE_PATH } })));
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} urlForPath={fakePathUrl} />);
    expect(new Set(hrefs(container))).toEqual(new Set([fakePathUrl(TAKE_PATH)]));
  });
});

describe('ComicPageView: what a composed page fetches, and when', () => {
  const art = (c: HTMLElement) => c.querySelector('[data-testid="composed-art"], [data-testid="composed-overlays"]');
  const hrefs = (c: HTMLElement) => [...c.querySelectorAll('[data-testid="composed-art"] image, [data-testid="composed-overlays"] image')].map((i) => i.getAttribute('href'));

  it('a frame picture or an overlay that fails to load leaves the drawing in place (never the page’s error)', () => {
    const doc = framedDoc((page) => {
      page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } };
      page.layers = [LAYERS.image];
    });
    const onImageError = vi.fn();
    const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} onImageError={onImageError} />);
    fireEvent.error(container.querySelector(`image[href="${fakePathUrl(TAKE_PATH)}"]`)!);
    fireEvent.error(container.querySelector(`image[href="${fakePathUrl(PHOTO_PATH)}"]`)!);
    expect(container.querySelector('[data-testid="composed-art"]')).not.toBeNull();
    expect(onImageError).not.toHaveBeenCalled();
    expect(hrefs(container)).toContain(RASTER_URL(doc));
  });

  it('page mode: an overlay kept in a panel is clipped to that panel’s box on the drawing', () => {
    const doc = layeredDoc([{ ...LAYERS.shape, clip: 'pg_1_p1' }]);
    const page = doc.pages[0];
    const { container } = render(<ComicPageView doc={doc} page={page} imageUrl={fakeUrlFor(page.render.asset)} />);
    const g = container.querySelector('g[data-layer-id="ly_box"]')!;
    const id = /url\(#(.+)\)/.exec(g.getAttribute('clip-path') || '')![1];
    const box = panelBoxesFor(doc, page)[0];
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const aspect = composePage(doc, page).aspect;
    expect(container.querySelector(`[id="${id}"] path`)!.getAttribute('d')).toBe(framePathD({ x: r4(box.x), y: r4(box.y), w: r4(box.w), h: r4(box.h) }, 0, aspect));
  });

  it('an image overlay is asked for at the width it is drawn (a variant), frame pictures at full size', () => {
    const doc = framedDoc((page) => {
      page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } };
      page.layers = [LAYERS.image];
    });
    const urlForPath = vi.fn((path: string, widthPx?: number) => `${fakePathUrl(path)}${widthPx ? `?w=${widthPx}` : ''}`);
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 450, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 450, toJSON: () => ({}) }) as DOMRect;
    try {
      const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={urlForPath} />);
      // The photo is 0.3 of the page wide, showing 0.8 of its picture: the whole picture is 300 × 0.3 / 0.8 px.
      expect(urlForPath).toHaveBeenLastCalledWith(PHOTO_PATH, Math.ceil((300 * 0.3) / 0.8));
      expect(urlForPath).toHaveBeenCalledWith(TAKE_PATH);
      expect(hrefs(container)).toContain(`${fakePathUrl(PHOTO_PATH)}?w=113`);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  describe('loading="lazy" holds a composed page’s pictures until it is near the screen', () => {
    type Rec = { cb: IntersectionObserverCallback; targets: Element[]; options?: IntersectionObserverInit; off: boolean };
    const observers: Rec[] = [];
    class FakeObserver {
      private rec: Rec;
      constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.rec = { cb, targets: [], options, off: false };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.targets.push(el);
      }
      unobserve() {}
      disconnect() {
        this.rec.off = true;
      }
      takeRecords() {
        return [];
      }
    }
    const fire = (rec: Rec, isIntersecting: boolean) =>
      act(() => rec.cb([{ isIntersecting, target: rec.targets[0] } as IntersectionObserverEntry], {} as IntersectionObserver));
    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal('IntersectionObserver', FakeObserver);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('panels mode: no <image href> until the observer fires (one viewport ahead), then the drawing; eager at once', () => {
      const doc = framedDoc((page) => (page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } }));
      const lazy = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} loading="lazy" />);
      expect(art(lazy.container)).not.toBeNull();
      expect(hrefs(lazy.container)).toEqual([]);
      // The frames and their borders are there, waiting.
      expect(lazy.container.querySelectorAll('g[data-panel-id]')).toHaveLength(3);
      expect(observers).toHaveLength(1);
      expect(observers[0].options?.rootMargin).toBe('100%');
      expect(observers[0].targets[0].getAttribute('data-testid')).toBe('comic-page');
      fire(observers[0], false);
      expect(hrefs(lazy.container)).toEqual([]);
      fire(observers[0], true);
      expect(new Set(hrefs(lazy.container))).toEqual(new Set([RASTER_URL(doc), fakePathUrl(TAKE_PATH)]));
      expect(observers[0].off).toBe(true);
      lazy.unmount();

      const eager = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} loading="eager" />);
      expect(new Set(hrefs(eager.container))).toEqual(new Set([RASTER_URL(doc), fakePathUrl(TAKE_PATH)]));
      expect(observers).toHaveLength(1);
    });

    it('page mode: overlay pictures wait with the lazy <img>; a page without frames or overlays never observes', () => {
      const doc = layeredDoc([LAYERS.image, LAYERS.sticker, LAYERS.shape]);
      const page = doc.pages[0];
      const lazy = render(<ComicPageView doc={doc} page={page} imageUrl={fakeUrlFor(page.render.asset)} urlForPath={fakePathUrl} />);
      expect(lazy.container.querySelector('img')!.getAttribute('loading')).toBe('lazy');
      expect(hrefs(lazy.container)).toEqual([]);
      expect(lazy.container.querySelector('g[data-layer-id="ly_box"] path')).not.toBeNull();
      fire(observers[0], true);
      expect(hrefs(lazy.container)).toEqual([fakePathUrl(PHOTO_PATH), libAssetUrl(LAYERS.sticker.src!.lib!)]);
      lazy.unmount();
      observers.length = 0;
      const legacy = makeQaDoc('heist-12p');
      render(<ComicPageView doc={legacy} page={legacy.pages[1]} imageUrl={fakeUrlFor(legacy.pages[1].render.asset)} />);
      expect(observers).toHaveLength(0);
    });
  });

  describe('each other picture is judged on its own safety verdict', () => {
    const rated = () =>
      framedDoc((page) => {
        page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } };
        page.panels[2].frame = { ...page.panels[2].frame!, src: { path: OTHER_PATHS[0] } };
        page.render.history = [
          ...(page.render.history || []),
          { path: TAKE_PATH, source: 'generated', at: 1, w: 1000, h: 1500, safety: { assessed: 'PG-13', at: 1 } },
          { path: OTHER_PATHS[0], source: 'upload', at: 1, w: 1000, h: 1000, safety: { quarantined: true, at: 1 } }
        ];
      });

    it('a frame picture rated above the comic veils the page (as it would on its own); a blocked one is never asked for', () => {
      const doc = rated();
      const urlForPath = vi.fn(fakePathUrl);
      const { container } = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={urlForPath} safety={{ rating: 'G' }} />);
      expect(container.querySelector('[data-safety="over_rating"]')).not.toBeNull();
      expect(container.textContent).toContain('Rated PG-13 — your comic is G');
      expect(urlForPath).not.toHaveBeenCalledWith(OTHER_PATHS[0], expect.anything());
      expect(urlForPath.mock.calls.map((c) => c[0])).not.toContain(OTHER_PATHS[0]);
      expect(container.querySelector('g[data-panel-id="pg_1_p3"]')!.getAttribute('data-empty')).toBe('blank');
    });

    it('within the rating nothing is veiled; without `safety` the blocked picture is still left out', () => {
      const doc = rated();
      const ok = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} safety={{ rating: 'PG-13' }} />);
      expect(ok.container.querySelector('[data-safety]')).toBeNull();
      ok.unmount();
      const plain = render(<ComicPageView doc={doc} page={doc.pages[0]} imageUrl={RASTER_URL(doc)} urlForPath={fakePathUrl} />);
      expect(hrefs(plain.container)).not.toContain(fakePathUrl(OTHER_PATHS[0]));
      expect(hrefs(plain.container)).toContain(fakePathUrl(TAKE_PATH));
    });
  });
});

describe('the compose part', () => {
  it('is ready (PE-COMPOSE built it) and the compose code never imports editActionFor nor calls studio.act', () => {
    expect(part).toEqual({ id: 'compose', ready: true });
    const files = [
      ...readdirSync(__dirname)
        .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
        .map((f) => join(__dirname, f)),
      join(__dirname, '../board/ComposedArt.tsx'),
      join(__dirname, '../../../shared/comic/panelize/compose.ts')
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/\beditActionFor\b/);
      expect(src, file).not.toMatch(/\bstudio\s*\.\s*act\b|\{\s*[^}]*\bact\b[^}]*\}\s*=\s*studio/);
      // Generators load through the registry seam and the lazy loader only (collisions B-7): never a static import (a
      // dynamic import() of the generators module, which the effect loader may use, is its own chunk).
      expect(src, file).not.toMatch(/(?:\bfrom\s*|\bimport\s+)['"][^'"]*fx\/(generators|lines|bursts|emanata|atmosphere|borders|seed|draw)(?:\.js)?['"]/);
    }
  });
});

