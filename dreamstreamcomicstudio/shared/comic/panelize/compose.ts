// One page as it is put together for screen, print and export (Ship 2 B1 + Pro Edit PE-COMPOSE; pro plan §4.3, master
// plan §2.3, §2.12). Pure and deterministic: no DOM, no URLs, no clock. The client builds its node tree from this
// (components/comicstudio/compose/pageNodes.ts) and draws it as SVG (screen, print) and on a canvas (PNG, PDF, ZIP); a
// server renderer (OG image, flatten, bake) can draw the same composition with sharp.
//
// The draw order is the editor scene's (shared/comic/editor/scene.ts): the page paper, then each panel frame by its z
// (ties in reading order) with the overlays kept inside that panel drawn right after it, then the page's free overlays
// by z, then the lettering (drawn by the lettering renderers, always on top).
//
// What is never drawn: a layer of a kind this build does not know (opaque, knownLayersOf), and a guide-only layer
// (print: false) unless the caller is the editor (`guides`). A page in page mode without a drawable overlay does not
// compose at all (pageComposes is false): renderers then take the old path, byte for byte.

import {
  artModeOf,
  frameStyleOf,
  knownLayersOf,
  type ArtMode,
  type Box,
  type ComicDoc,
  type Page,
  type PageLayer,
  type Panel,
  type PanelBorderStyle,
  type PanelFrameBorder
} from '../doc.js';
import { EDITOR_LIMITS } from '../limits.js';
import { panelBoxesFor } from '../pageGeometry.js';
import { composeAspect, frameAffine, upscaleOf, type FrameAffine } from './space.js';

/** Page units: the page is COMPOSE_UNIT wide and COMPOSE_UNIT / aspect tall (the lettering's viewBox). */
export const COMPOSE_UNIT = 1000;

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};
const finiteBox = (b: Box | undefined | null): b is Box =>
  !!b && [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v)) && b.w > 0 && b.h > 0;
const roundBox = (b: Box): Box => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });

/** A resolved panel border (page fractions of the page WIDTH, '#RRGGBB'). */
export interface ComposeBorder {
  style: PanelBorderStyle;
  w: number;
  color: string;
  /** int32 seed of the rough / brush / wavy / jagged looks (the stored one, else one derived from the panel id). */
  seed: number;
}

/** One panel frame and the picture it shows. */
export interface ComposePiece {
  panelId: string;
  /** Panel number (reading order). */
  n: number;
  /** Index in page.panels. */
  index: number;
  /** The frame on the page (page fractions). A 'bleed' frame reaches the page edges it sits on. */
  dst: Box;
  /** The part of the picture shown (image space); absent for an empty frame. */
  src?: Box;
  /** The picture's storage path: the page's drawing, or the frame's own source. */
  path?: string;
  /** The picture is the page's current drawing (every such piece shares ONE image). */
  raster: boolean;
  /** Nothing to show: no cut of the drawing for this panel, or a source past the page's picture cap. */
  empty: boolean;
  /** Corner radius (page fraction of the width). */
  radius: number;
  z: number;
  /** Absent: no border ('none', a zero width, or 'bleed'). */
  border?: ComposeBorder;
  bleed: boolean;
  /** How much the picture is enlarged at the drawing's own width (soft above EDITOR_LIMITS.upscaleSoft). */
  upscale?: number;
}

/** One overlay and where it is kept. */
export interface ComposeOverlay {
  layer: PageLayer;
  /** Index in page.layers (ties in z keep the stored order). */
  index: number;
  /** Guide only (print: false): only ever present when the caller asked for guides. */
  guide: boolean;
  /** Kept inside this panel: its frame (panels mode) or its box on the drawing (page mode). */
  clip?: { panelId: string; box: Box; radius: number };
}

export type ComposeItem = { kind: 'piece'; piece: ComposePiece } | { kind: 'overlay'; overlay: ComposeOverlay };

export interface PageComposition {
  mode: ArtMode;
  /** Width / height of the page as shown (composeAspect). */
  aspect: number;
  /** Panels mode: the paper under the frames (frameStyle.bg). Page mode: the drawing is the page. */
  paper?: string;
  /** Everything in draw order. */
  items: ComposeItem[];
  pieces: ComposePiece[];
  overlays: ComposeOverlay[];
  /** Distinct pictures the frames show, the page's drawing first: at most 1 + EDITOR_LIMITS.sourcesPerPage. */
  paths: string[];
}

export interface ComposeOptions {
  /** The editor: guide-only overlays are drawn too. Readers, print and exports never pass it. */
  guides?: boolean;
}

/** An overlay this build can draw, and whether this caller draws it. */
const drawable = (layer: PageLayer, guides: boolean): boolean => {
  if (!layer || !finiteBox(layer.box)) return false;
  if (layer.print === false && !guides) return false;
  if (layer.kind === 'image') return !!(layer.src && (layer.src.path || layer.src.lib));
  if (layer.kind === 'shape') return !!layer.shape;
  if (layer.kind === 'effect') return !!layer.fx;
  return false;
};

/**
 * The page has something to compose: it is shown in its frames, or it carries an overlay this caller draws. When
 * false, every renderer takes the path it took before Ship 2 (the golden in compose/legacyGolden.test.tsx holds it).
 */
export const pageComposes = (page: Page | null | undefined, opts: ComposeOptions = {}): boolean => {
  if (!page) return false;
  if (artModeOf(page) === 'panels') return true;
  return knownLayersOf(page).some((l) => drawable(l, !!opts.guides));
};

/** A stable int32 from a string (the default seed of a seeded border). */
export const seedOf = (text: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
};

const borderOf = (panel: Panel, style: ReturnType<typeof frameStyleOf>): { border?: ComposeBorder; bleed: boolean } => {
  const b: PanelFrameBorder | undefined = panel.frame?.border;
  const look: PanelBorderStyle = b?.style ?? 'clean';
  if (look === 'bleed') return { bleed: true };
  if (b?.none) return { bleed: false };
  const w = typeof b?.w === 'number' && Number.isFinite(b.w) ? b.w : style.border;
  if (!(w > 0)) return { bleed: false };
  const color = typeof b?.color === 'string' && b.color ? b.color : style.color;
  const seed = typeof b?.seed === 'number' && Number.isInteger(b.seed) ? b.seed | 0 : seedOf(panel.id);
  return { border: { style: look, w, color, seed }, bleed: false };
};

/** A bleed frame reaches each page edge it sits within the margin of; the shown part of the picture grows with it. */
const bleedOf = (aff: FrameAffine | null, dst: Box, margin: number): { dst: Box; src?: Box } => {
  const tol = Math.max(0, margin) + 0.01;
  const x0 = dst.x <= tol ? 0 : dst.x;
  const y0 = dst.y <= tol ? 0 : dst.y;
  const x1 = dst.x + dst.w >= 1 - tol ? 1 : dst.x + dst.w;
  const y1 = dst.y + dst.h >= 1 - tol ? 1 : dst.y + dst.h;
  const grown: Box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (!aff) return { dst: roundBox(grown) };
  // The picture keeps its scale: the grown frame shows more of it, never past the picture's own edges.
  const img = aff.boxToImage(grown);
  const cx0 = Math.max(0, img.x);
  const cy0 = Math.max(0, img.y);
  const cx1 = Math.min(1, img.x + img.w);
  const cy1 = Math.min(1, img.y + img.h);
  const src: Box = { x: cx0, y: cy0, w: Math.max(1e-6, cx1 - cx0), h: Math.max(1e-6, cy1 - cy0) };
  const back = aff.boxToPage(src);
  return { dst: roundBox(back), src: roundBox(src) };
};

/**
 * The page put together: pieces (frames and what they show) and overlays, in draw order. Page mode has no pieces (the
 * drawing is drawn whole, as before) and only its overlays. Panels mode lays the frames on the book aspect.
 */
export function composePage(doc: ComicDoc, page: Page, opts: ComposeOptions = {}): PageComposition {
  const guides = !!opts.guides;
  const mode = artModeOf(page);
  const aspect = composeAspect(doc, page);
  const style = frameStyleOf(page);
  const panels = Array.isArray(page.panels) ? page.panels : [];
  const drawing = page.render?.asset?.path;
  const boxes: Box[] = mode === 'panels' ? panels.map((p) => ({ ...p.frame!.box })) : panelBoxesFor(doc, page);

  const pieces: ComposePiece[] = [];
  const pieceOf = new Map<string, ComposePiece>();
  const paths: string[] = [];
  const extra: string[] = [];
  if (mode === 'panels') {
    panels.forEach((panel, index) => {
      const frame = panel.frame!;
      const own = frame.src?.path;
      // Extra pictures beyond the page's cap (EDITOR_LIMITS.sourcesPerPage, the sanitizer's rule) show the panel's cut
      // of the drawing instead, so a page never fetches more than 1 + sourcesPerPage pictures.
      let shown: Pick<Panel, 'id' | 'frame'> = panel;
      if (own && own !== drawing && !extra.includes(own)) {
        if (extra.length < EDITOR_LIMITS.sourcesPerPage) extra.push(own);
        else shown = { id: panel.id, frame: { ...frame, src: undefined } };
      }
      const aff = frameAffine(doc, page, shown);
      const { border, bleed } = borderOf(panel, style);
      let dst = roundBox(frame.box);
      let src = aff ? roundBox(aff.src) : undefined;
      if (bleed) {
        const grown = bleedOf(aff, frame.box, style.margin);
        dst = grown.dst;
        if (grown.src) src = grown.src;
      }
      const path = aff?.path;
      const raster = !!aff && (aff.raster || (!!path && path === drawing));
      const piece: ComposePiece = {
        panelId: panel.id,
        n: panel.n,
        index,
        dst,
        ...(src ? { src } : {}),
        ...(path ? { path } : {}),
        raster,
        empty: !aff,
        radius: Math.max(0, style.radius || 0),
        z: typeof frame.z === 'number' && Number.isFinite(frame.z) ? frame.z : 0,
        ...(border ? { border } : {}),
        bleed
      };
      if (aff) {
        const up = upscaleOf(doc, page, panel.id);
        if (up !== undefined && aff.path === path && shown === panel) piece.upscale = up;
      }
      if (path && !paths.includes(path)) paths.push(path);
      pieces.push(piece);
      pieceOf.set(panel.id, piece);
    });
    if (drawing && paths.includes(drawing)) paths.splice(0, paths.length, drawing, ...paths.filter((p) => p !== drawing));
  }

  const layers = knownLayersOf(page)
    .map((layer) => ({ layer, index: (page.layers ?? []).indexOf(layer) }))
    .filter(({ layer }) => drawable(layer, guides));
  const panelIndex = new Map(panels.map((p, i) => [p.id, i]));
  const byZ = (a: { layer: PageLayer; index: number }, b: { layer: PageLayer; index: number }) => (a.layer.z ?? 0) - (b.layer.z ?? 0) || a.index - b.index;
  const overlayOf = ({ layer, index }: { layer: PageLayer; index: number }, clip?: ComposeOverlay['clip']): ComposeOverlay => ({
    layer,
    index,
    guide: layer.print === false,
    ...(clip ? { clip } : {})
  });

  const items: ComposeItem[] = [];
  const overlays: ComposeOverlay[] = [];
  const order = panels.map((panel, i) => ({ panel, i, z: panel.frame?.z ?? 0 })).sort((a, b) => a.z - b.z || a.i - b.i);
  for (const { panel, i } of order) {
    const piece = pieceOf.get(panel.id);
    if (piece) items.push({ kind: 'piece', piece });
    const box = piece?.dst ?? boxes[i];
    if (!finiteBox(box)) continue;
    const clipped = layers.filter((x) => x.layer.clip === panel.id).sort(byZ);
    for (const x of clipped) {
      const o = overlayOf(x, { panelId: panel.id, box: roundBox(box), radius: mode === 'panels' ? Math.max(0, style.radius || 0) : 0 });
      overlays.push(o);
      items.push({ kind: 'overlay', overlay: o });
    }
  }
  for (const x of layers.filter((x) => !x.layer.clip || !panelIndex.has(x.layer.clip) || !finiteBox(boxes[panelIndex.get(x.layer.clip)!])).sort(byZ)) {
    const o = overlayOf(x);
    overlays.push(o);
    items.push({ kind: 'overlay', overlay: o });
  }

  return { mode, aspect, ...(mode === 'panels' ? { paper: style.bg } : {}), items, pieces, overlays, paths };
}

// ── Geometry in page units (COMPOSE_UNIT wide) ────────────────────────────────────────────────────────────────────

/** A rectangle in page units. */
export interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A page-fraction box in page units (COMPOSE_UNIT × COMPOSE_UNIT / aspect). */
export const unitRect = (box: Box, aspect: number): UnitRect => {
  const H = COMPOSE_UNIT / (aspect > 0 ? aspect : 2 / 3);
  return { x: r2(box.x * COMPOSE_UNIT), y: r2(box.y * H), w: r2(box.w * COMPOSE_UNIT), h: r2(box.h * H) };
};

const f = (n: number) => String(r2(n));

/** A rectangle path (rounded corners when r > 0; r is clamped to half the shorter side). */
export const rectPathD = (x: number, y: number, w: number, h: number, r = 0): string => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!(rr > 0.005)) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  const R = f(rr);
  return (
    `M${f(x + rr)} ${f(y)}H${f(x + w - rr)}A${R} ${R} 0 0 1 ${f(x + w)} ${f(y + rr)}V${f(y + h - rr)}` +
    `A${R} ${R} 0 0 1 ${f(x + w - rr)} ${f(y + h)}H${f(x + rr)}A${R} ${R} 0 0 1 ${f(x)} ${f(y + h - rr)}V${f(y + rr)}A${R} ${R} 0 0 1 ${f(x + rr)} ${f(y)}Z`
  );
};

/** An ellipse inscribed in a rectangle (two arcs). */
export const ellipsePathD = (x: number, y: number, w: number, h: number): string => {
  const rx = f(w / 2);
  const ry = f(h / 2);
  return `M${f(x)} ${f(y + h / 2)}A${rx} ${ry} 0 1 0 ${f(x + w)} ${f(y + h / 2)}A${rx} ${ry} 0 1 0 ${f(x)} ${f(y + h / 2)}Z`;
};

/** The frame's outline (the clip of what it shows), in page units. */
export const framePathD = (box: Box, radius: number, aspect: number): string => {
  const r = unitRect(box, aspect);
  return rectPathD(r.x, r.y, r.w, r.h, radius * COMPOSE_UNIT);
};

/**
 * An overlay's own transform in page units, about its centre: rotation (degrees) and flip. Undefined when it has
 * neither (no transform attribute, no canvas transform). [a, b, c, d, e, f] as in SVG matrix() and canvas transform().
 */
export const layerMatrix = (layer: Pick<PageLayer, 'rot' | 'flip'>, rect: UnitRect): [number, number, number, number, number, number] | undefined => {
  const rot = typeof layer.rot === 'number' && Number.isFinite(layer.rot) ? layer.rot : 0;
  const sx = layer.flip === 'h' ? -1 : 1;
  const sy = layer.flip === 'v' ? -1 : 1;
  if (!rot && sx === 1 && sy === 1) return undefined;
  const t = (rot * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const m4 = (n: number) => {
    const v = Math.round(n * 10000) / 10000;
    return Object.is(v, -0) ? 0 : v;
  };
  return [m4(a), m4(b), m4(c), m4(d), r2(cx - (a * cx + c * cy)), r2(cy - (b * cx + d * cy))];
};

/** A shape layer's outline (rect with its radius, ellipse, or the box's diagonal for a line), in page units. */
export const shapePathD = (shape: NonNullable<PageLayer['shape']>, rect: UnitRect): string => {
  if (shape.type === 'ellipse') return ellipsePathD(rect.x, rect.y, rect.w, rect.h);
  if (shape.type === 'line') return `M${f(rect.x)} ${f(rect.y)}L${f(rect.x + rect.w)} ${f(rect.y + rect.h)}`;
  const radius = typeof shape.radius === 'number' && shape.radius > 0 ? shape.radius * Math.min(rect.w, rect.h) : 0;
  return rectPathD(rect.x, rect.y, rect.w, rect.h, radius);
};

// ── Panel borders (procedural, seeded; absent style = today's clean line) ─────────────────────────────────────────

/** One mark of a border: a path filled or stroked, in page units. */
export interface BorderMark {
  d: string;
  fill?: string;
  stroke?: string;
  strokeW?: number;
  dash?: number[];
  join?: 'miter' | 'round';
  cap?: 'butt' | 'round';
  /** Fill with the even-odd rule (the film strip's ring). */
  evenodd?: true;
}

/** mulberry32: a small deterministic PRNG (the same seed gives the same border forever). */
const rng = (seed: number) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Pt = [number, number];
/** The four edges clockwise from the top-left: start, end, outward normal. */
const edgesOf = (r: UnitRect): [Pt, Pt, Pt][] => [
  [[r.x, r.y], [r.x + r.w, r.y], [0, -1]],
  [[r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [1, 0]],
  [[r.x + r.w, r.y + r.h], [r.x, r.y + r.h], [0, 1]],
  [[r.x, r.y + r.h], [r.x, r.y], [-1, 0]]
];
const polyD = (pts: Pt[]): string => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;

/** Points along the perimeter every ~step, each pushed along its edge's normal by offset(i). */
const perimeter = (r: UnitRect, step: number, offset: (k: number, edge: number) => number): Pt[] => {
  const pts: Pt[] = [];
  let k = 0;
  edgesOf(r).forEach(([a, b, nrm], e) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i += 1) {
      const t = i / n;
      const o = offset(k, e);
      pts.push([a[0] + (b[0] - a[0]) * t + nrm[0] * o, a[1] + (b[1] - a[1]) * t + nrm[1] * o]);
      k += 1;
    }
  });
  return pts;
};

/**
 * The marks that draw a frame's border, in page units (W = border width × COMPOSE_UNIT). Deterministic per seed: the
 * SVG and the canvas draw these very paths. 'clean' (and an absent style) is one straight stroked outline.
 */
export const borderMarks = (piece: Pick<ComposePiece, 'dst' | 'radius' | 'border'>, aspect: number, paper = '#ffffff'): BorderMark[] => {
  const border = piece.border;
  if (!border) return [];
  const r = unitRect(piece.dst, aspect);
  const W = Math.max(0.25, border.w * COMPOSE_UNIT);
  const color = border.color;
  const radius = piece.radius * COMPOSE_UNIT;
  const rand = rng(border.seed);
  const jit = (amp: number) => (rand() - 0.5) * 2 * amp;
  switch (border.style) {
    case 'double': {
      const inset = W * 1.75;
      const inner = r.w > inset * 3 && r.h > inset * 3;
      return [
        { d: rectPathD(r.x, r.y, r.w, r.h, radius), stroke: color, strokeW: r2(W * 0.5), join: 'miter' },
        ...(inner ? [{ d: rectPathD(r.x + inset, r.y + inset, r.w - inset * 2, r.h - inset * 2, Math.max(0, radius - inset)), stroke: color, strokeW: r2(W * 0.5), join: 'miter' as const }] : [])
      ];
    }
    case 'dashed':
      return [{ d: rectPathD(r.x, r.y, r.w, r.h, radius), stroke: color, strokeW: r2(W), dash: [r2(W * 3.5), r2(W * 2.2)], join: 'miter', cap: 'butt' }];
    case 'rough': {
      const step = Math.max(12, W * 6);
      return [{ d: polyD(perimeter(r, step, () => jit(W * 0.6))), stroke: color, strokeW: r2(W), join: 'round' }];
    }
    case 'brush': {
      const step = Math.max(10, W * 5);
      const a = polyD(perimeter(r, step, () => jit(W * 0.35)));
      const b = polyD(perimeter(r, step * 1.3, () => jit(W * 0.5)));
      return [
        { d: a, stroke: color, strokeW: r2(W * 1.15), join: 'round', cap: 'round' },
        { d: b, stroke: color, strokeW: r2(W * 0.55), join: 'round', cap: 'round' }
      ];
    }
    case 'jagged': {
      const step = Math.max(8, W * 3.5);
      return [{ d: polyD(perimeter(r, step, (k) => (k % 2 ? 1 : -1) * W * (0.9 + rand() * 0.6))), stroke: color, strokeW: r2(W * 0.8), join: 'miter' }];
    }
    case 'wavy': {
      const wave = Math.max(24, W * 10);
      const amp = W * 1.1;
      const phase = rand() < 0.5 ? 1 : -1;
      let d = '';
      edgesOf(r).forEach(([a, b, nrm], e) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(2, Math.round(len / (wave / 2)));
        if (e === 0) d += `M${f(a[0])} ${f(a[1])}`;
        for (let i = 0; i < n; i += 1) {
          const t0 = i / n;
          const t1 = (i + 1) / n;
          const tm = (t0 + t1) / 2;
          const s = (i % 2 ? -1 : 1) * phase * amp * 2;
          const cx = a[0] + (b[0] - a[0]) * tm + nrm[0] * s;
          const cy = a[1] + (b[1] - a[1]) * tm + nrm[1] * s;
          d += `Q${f(cx)} ${f(cy)} ${f(a[0] + (b[0] - a[0]) * t1)} ${f(a[1] + (b[1] - a[1]) * t1)}`;
        }
      });
      return [{ d: `${d}Z`, stroke: color, strokeW: r2(W * 0.9), join: 'round', cap: 'round' }];
    }
    case 'film': {
      const T = Math.max(W * 4, 10);
      if (r.w < T * 3 || r.h < T * 3) return [{ d: rectPathD(r.x, r.y, r.w, r.h), stroke: color, strokeW: r2(W * 2), join: 'miter' }];
      const ring = `${rectPathD(r.x, r.y, r.w, r.h)}${rectPathD(r.x + T, r.y + T, r.w - T * 2, r.h - T * 2)}`;
      const hw = T * 0.42;
      const hh = T * 0.34;
      const pitch = T * 1.15;
      const count = Math.max(1, Math.floor((r.w - T) / pitch));
      const start = r.x + (r.w - (count - 1) * pitch) / 2 - hw / 2;
      let holes = '';
      for (let i = 0; i < count; i += 1) {
        const hx = start + i * pitch;
        holes += rectPathD(hx, r.y + (T - hh) / 2, hw, hh, hh * 0.25);
        holes += rectPathD(hx, r.y + r.h - T + (T - hh) / 2, hw, hh, hh * 0.25);
      }
      return [
        { d: ring, fill: color, evenodd: true },
        { d: holes, fill: paper }
      ];
    }
    case 'clean':
    default:
      return [{ d: rectPathD(r.x, r.y, r.w, r.h, radius), stroke: color, strokeW: r2(W), join: 'miter' }];
  }
};
