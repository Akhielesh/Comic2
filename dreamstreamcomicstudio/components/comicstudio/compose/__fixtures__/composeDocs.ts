// Composed-page fixtures for the PE-COMPOSE tests: a QA fixture page turned into panels mode (frames on its panel
// boxes, cuts of its drawing), and one overlay of every kind. Synthetic; normalized like a stored doc.

import { normalizeDoc, type Box, type ComicDoc, type Page, type PageLayer } from '../../../../shared/comic/doc';
import { panelBoxesFor } from '../../../../shared/comic/pageGeometry';
import { makeQaDoc } from '../../testing/qaFixtures';

export const TAKE_PATH = 'qa/heist-take-1000x1500.png';
export const PHOTO_PATH = 'qa/photo-800x600.png';
export const OTHER_PATHS = ['qa/extra-a-1000x1000.png', 'qa/extra-b-1000x1000.png', 'qa/extra-c-1000x1000.png'];

/** A fake signer for storage paths (frame sources, image overlays). */
export const fakePathUrl = (path: string): string => `https://cdn.test/${path}`;

const inset = (b: Box, k = 0.01): Box => ({ x: b.x + k, y: b.y + k, w: Math.max(0.05, b.w - 2 * k), h: Math.max(0.05, b.h - 2 * k) });
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const round = (b: Box): Box => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });

/** heist-12p with page 1 shown in its frames (one frame per panel on its panel box, cuts of the drawing). */
export const framedDoc = (mutate?: (page: Page, doc: ComicDoc) => void): ComicDoc => {
  const doc = makeQaDoc('heist-12p');
  const page = doc.pages[0];
  const boxes = panelBoxesFor(doc, page).map((b) => round(inset(b)));
  page.artMode = 'panels';
  page.panels = page.panels.map((p, i) => ({ ...p, frame: { box: boxes[i] } }));
  page.render = {
    ...page.render,
    cuts: { status: 'ok', by: 'detect', at: 1, cuts: page.panels.map((p, i) => ({ panelId: p.id, drawn: i + 1, box: boxes[i], conf: 1 })) }
  };
  mutate?.(page, doc);
  return normalizeDoc(doc);
};

/** heist-12p page 1 (as drawn) carrying `layers`. */
export const layeredDoc = (layers: PageLayer[], framed = false): ComicDoc => {
  const make = framed ? framedDoc : (m: (p: Page, d: ComicDoc) => void) => {
    const d = makeQaDoc('heist-12p');
    m(d.pages[0], d);
    return normalizeDoc(d);
  };
  return make((page) => {
    page.layers = layers;
  });
};

/** One layer of each kind (plus a blend), in a known box. */
export const LAYERS = {
  image: { id: 'ly_photo', kind: 'image', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, src: { path: PHOTO_PATH, crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.6 } }, rot: 12 } as PageLayer,
  sticker: { id: 'ly_star', kind: 'image', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.15 }, src: { lib: { pack: 'fluent-flat', id: 'star', v: '1' } }, flip: 'h' } as PageLayer,
  shape: { id: 'ly_box', kind: 'shape', box: { x: 0.2, y: 0.5, w: 0.4, h: 0.2 }, shape: { type: 'rect', fill: '#ffeeaa', stroke: '#111111', strokeW: 0.004, radius: 0.2 }, opacity: 0.8 } as PageLayer,
  effect: { id: 'ly_fx', kind: 'effect', box: { x: 0.05, y: 0.6, w: 0.5, h: 0.3 }, fx: { gen: 'speed-lines', v: 1, seed: 7, params: { count: 3 } } } as PageLayer,
  blend: { id: 'ly_tone', kind: 'shape', box: { x: 0, y: 0, w: 1, h: 0.4 }, shape: { type: 'ellipse', fill: '#3355aa' }, blend: 'multiply', opacity: 0.5 } as PageLayer,
  guide: { id: 'ly_guide', kind: 'image', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, src: { path: PHOTO_PATH }, print: false } as PageLayer,
  opaque: { id: 'ly_future', kind: 'hologram', box: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }, beam: { strength: 3 } } as unknown as PageLayer
};
