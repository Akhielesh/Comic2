// The page node tree (master plan §2.12 PE-COMPOSE = pro plan B1): ONE description of a composed page — the paper, the
// panel frames with the picture each shows and its border, the overlays (images, shapes, effects, stickers) as
// g[data-layer-id], in the editor scene's draw order — that every renderer draws:
//   - the screen and the print document draw it as SVG (composeSvgNodes → React through svgNodeToReact, or markup
//     through nodesToMarkup);
//   - PNG, PDF and ZIP draw it on a canvas (composeCanvas.ts).
// The lettering is drawn on top by the lettering renderers (BalloonLayer / letteringSvgMarkup / canvasDraw), as before.
//
// Geometry is in page units: COMPOSE_UNIT (1000) wide, 1000 / aspect tall — the lettering's viewBox — so one SVG can
// hold both. Pure: no DOM, no clock; URLs come from the caller (resolve).
//
// Seams: effects draw through renderFx (shared/comic/fx/registry.ts), synchronously, whatever it returns ([] until a
// generators module registers drawings; this folder never imports one statically, collisions B-7). The drawings load
// lazily through the effect loader below (setFxLoader / ensureFxDrawings): the screen re-draws once they arrive, and
// every export and the print document wait for them before drawing a page that holds an effect. Stickers draw from the
// bundled library's same-origin file (libAssetUrl). Every Pro edit is free software: this folder never imports
// editActionFor and never calls studio.act (proEdit.contract.test.ts scans it).

import { knownLayersOf, type ComicDoc, type LayerBlend, type Page, type PageLayer } from '../../../shared/comic/doc';
import { libAssetUrl } from '../../../shared/comic/assets/index';
import type { AssetLibRef } from '../../../shared/comic/assets/types';
import { renderFx } from '../../../shared/comic/fx/registry';
import type { FxNode } from '../../../shared/comic/fx/types';
import {
  borderMarks,
  COMPOSE_UNIT,
  composePage,
  framePathD,
  layerMatrix,
  pageComposes,
  rectPathD,
  shapePathD,
  unitRect,
  type BorderMark,
  type ComposeOptions,
  type PageComposition,
  type UnitRect
} from '../../../shared/comic/panelize/compose';
import type { SvgNode } from '../lettering/svgMarkup';

export { pageComposes } from '../../../shared/comic/panelize/compose';

// ── Effect drawings, loaded lazily (PE-FX seam, collisions B-7) ─────────────────────────────────────────────────────

/** Loads the module that registers the effect drawings (PE-FX's fx/generators.ts), e.g. `() => import(…)`. */
export type FxLoader = () => Promise<unknown>;

let loadFx: FxLoader | undefined;
let fxLoading: Promise<boolean> | undefined;
let fxLoaded = false;

/**
 * Sets the effect loader (S2b-INT sets the default to PE-FX's generators module, a dynamic import; tests pass a fake).
 * Without one, renderFx draws what is registered now (nothing on this base), synchronously, and nothing waits.
 */
export const setFxLoader = (loader: FxLoader | undefined): void => {
  loadFx = loader;
  fxLoading = undefined;
  fxLoaded = false;
};

const holdsEffect = (page: Page | null | undefined): boolean => !!page && knownLayersOf(page).some((l) => l.kind === 'effect' && !!l.fx);

/** The page holds an effect whose drawings have not loaded yet (a loader is set and has not finished). */
export const fxDrawingsPending = (page: Page | null | undefined): boolean => !!loadFx && !fxLoaded && holdsEffect(page);

/**
 * Loads the effect drawings when the page holds an effect and they are not loaded yet (once for the whole app; a
 * failed load is tried again on the next call). Resolves true when this call made them available (the caller re-draws),
 * false when nothing was needed or the load failed (fxDrawingsPending stays true then). Never rejects.
 */
export const ensureFxDrawings = (page: Page | null | undefined): Promise<boolean> => {
  if (!fxDrawingsPending(page) || !loadFx) return Promise.resolve(false);
  if (!fxLoading) {
    fxLoading = loadFx().then(
      () => {
        fxLoaded = true;
        return true;
      },
      () => {
        fxLoading = undefined;
        return false;
      }
    );
  }
  return fxLoading;
};

/** Where the pictures come from. */
export interface ComposeResolve {
  /** The page's current drawing (the variant picked for this size). Every piece that shows it uses this ONE URL. */
  rasterUrl?: string;
  /**
   * A storage path's URL: frame sources (another take, an image; asked without a width, they are drawn enlarged) and
   * image overlays (asked with `widthPx`, the width in px the whole picture is drawn at, when the page's is known).
   */
  urlForPath?: (path: string, widthPx?: number) => string | undefined;
  /** A library sticker's URL (default: the same-origin file, libAssetUrl). */
  libUrl?: (ref: AssetLibRef) => string | undefined;
  /** The page's drawn width in px (screen CSS px, or the export canvas): sizes the overlay pictures it asks for. */
  widthPx?: number;
}

export interface ComposeSceneOptions extends ComposeOptions {
  resolve?: ComposeResolve;
  /** The page's composition when the caller already has it (composePage with the same `guides`). */
  composition?: PageComposition;
}

/** An image placed so its source rectangle lands on a target rectangle (both ways: SVG <image> and canvas drawImage). */
export interface PlacedImage {
  url: string;
  /** The whole picture in page units (SVG <image x y width height>, clipped). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The part shown (normalized on the picture) and where it lands (page units): canvas drawImage's 9 arguments. */
  src: { x: number; y: number; w: number; h: number };
  dst: UnitRect;
}

export type LayerContent =
  | { t: 'image'; image: PlacedImage; /** The picture is cropped: clip to the layer box. */ crop: boolean }
  | { t: 'shape'; d: string; fill?: string; stroke?: string; strokeW?: number; line: boolean }
  /** Effect nodes in the layer's 0..1 box, drawn under translate(rect) scale(rect) (renderFx's contract). */
  | { t: 'fx'; nodes: readonly FxNode[] };

export type ComposeNode =
  | { k: 'paper'; fill: string }
  | {
      k: 'piece';
      panelId: string;
      n: number;
      /** The frame outline (clip) in page units. */
      clipD: string;
      rect: UnitRect;
      image?: PlacedImage;
      /** An empty frame: the editor shows a dashed hairline placeholder, readers a blank bordered frame. */
      empty?: 'placeholder' | 'blank';
      marks: BorderMark[];
    }
  | {
      k: 'layer';
      id: string;
      kind: 'image' | 'shape' | 'effect';
      guide: boolean;
      rect: UnitRect;
      /** Kept inside its panel: that frame's outline, page units. */
      clipD?: string;
      /** Rotation and flip about the centre; absent = none. */
      matrix?: [number, number, number, number, number, number];
      /** 0..1 (1 = opaque). The layer composites ONCE with it (SVG group opacity; canvas offscreen layer). */
      opacity: number;
      blend?: LayerBlend;
      content?: LayerContent;
    };

export interface ComposeScene {
  aspect: number;
  /** Page units: width COMPOSE_UNIT, height H. */
  H: number;
  mode: PageComposition['mode'];
  nodes: ComposeNode[];
  /** Distinct picture URLs in draw order (the page's drawing first when shown). */
  urls: string[];
  /** Pictures that could not be resolved to a URL (their frame shows empty, their overlay is left out). */
  missing: string[];
  composition: PageComposition;
}

const r2 = (n: number) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
};
const clamp01 = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

/** Place the normalized rectangle `src` of a picture onto `dst` (page units). */
const place = (url: string, src: { x: number; y: number; w: number; h: number }, dst: UnitRect): PlacedImage => {
  const w = dst.w / src.w;
  const h = dst.h / src.h;
  return { url, x: r2(dst.x - src.x * w), y: r2(dst.y - src.y * h), w: r2(w), h: r2(h), src: { ...src }, dst: { ...dst } };
};

const layerContent = (layer: PageLayer, rect: UnitRect, resolve: ComposeResolve, missing: string[]): LayerContent | undefined => {
  if (layer.kind === 'image') {
    const src = layer.src;
    const crop = src?.crop && src.crop.w > 0 && src.crop.h > 0 ? src.crop : { x: 0, y: 0, w: 1, h: 1 };
    const cropped = !(crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1);
    let url: string | undefined;
    if (src?.lib) url = (resolve.libUrl ?? libAssetUrl)(src.lib);
    else if (src?.path) {
      // The whole picture is drawn rect.w / crop.w wide: ask for a picture that size (a variant), not the original.
      const widthPx = resolve.widthPx && resolve.widthPx > 0 ? Math.max(1, Math.ceil((rect.w / crop.w / COMPOSE_UNIT) * resolve.widthPx)) : undefined;
      url = widthPx ? resolve.urlForPath?.(src.path, widthPx) : resolve.urlForPath?.(src.path);
      if (!url && !missing.includes(src.path)) missing.push(src.path);
    }
    if (!url) return undefined;
    return { t: 'image', image: place(url, crop, rect), crop: cropped };
  }
  if (layer.kind === 'shape' && layer.shape) {
    const s = layer.shape;
    const line = s.type === 'line';
    const strokeW = typeof s.strokeW === 'number' && s.strokeW > 0 ? r2(s.strokeW * COMPOSE_UNIT) : undefined;
    return {
      t: 'shape',
      d: shapePathD(s, rect),
      line,
      ...(!line && s.fill ? { fill: s.fill } : {}),
      ...(s.stroke && (strokeW || line) ? { stroke: s.stroke, strokeW: strokeW ?? 2 } : {})
    };
  }
  if (layer.kind === 'effect' && layer.fx) {
    // The generator works in an isotropic frame: it is told the layer box's shape as shown.
    const nodes = renderFx(layer.fx, { aspect: rect.h > 0 ? rect.w / rect.h : 1 });
    return { t: 'fx', nodes: Array.isArray(nodes) ? nodes : [] };
  }
  return undefined;
};

/**
 * The page node tree for one page. `guides` (the editor) also draws guide-only overlays and empty-frame placeholders.
 * Page mode carries only the overlays (the drawing itself is drawn whole, as before); panels mode carries the paper
 * and the frames too.
 */
export function composeScene(doc: ComicDoc, page: Page, opts: ComposeSceneOptions = {}): ComposeScene {
  const composition = opts.composition ?? composePage(doc, page, { guides: opts.guides });
  const resolve = opts.resolve ?? {};
  const aspect = composition.aspect > 0 ? composition.aspect : 2 / 3;
  const H = r2(COMPOSE_UNIT / aspect);
  const drawing = page.render?.asset?.path;
  const nodes: ComposeNode[] = [];
  const urls: string[] = [];
  const missing: string[] = [];
  const use = (url: string) => {
    if (!urls.includes(url)) urls.push(url);
  };
  if (composition.paper) nodes.push({ k: 'paper', fill: composition.paper });
  for (const item of composition.items) {
    if (item.kind === 'piece') {
      const p = item.piece;
      const rect = unitRect(p.dst, aspect);
      let image: PlacedImage | undefined;
      if (!p.empty && p.src && p.path) {
        const url = p.raster || p.path === drawing ? resolve.rasterUrl : resolve.urlForPath?.(p.path);
        if (url) {
          image = place(url, p.src, rect);
          use(url);
        } else if (!missing.includes(p.path)) missing.push(p.path);
      }
      nodes.push({
        k: 'piece',
        panelId: p.panelId,
        n: p.n,
        clipD: framePathD(p.dst, p.radius, aspect),
        rect,
        ...(image ? { image } : { empty: opts.guides ? ('placeholder' as const) : ('blank' as const) }),
        marks: borderMarks(p, aspect, composition.paper)
      });
      continue;
    }
    const o = item.overlay;
    const layer = o.layer;
    const rect = unitRect(layer.box, aspect);
    const content = layerContent(layer, rect, resolve, missing);
    if (layer.kind === 'image' && !content) continue;
    if (content?.t === 'image') use(content.image.url);
    const matrix = layerMatrix(layer, rect);
    nodes.push({
      k: 'layer',
      id: layer.id,
      kind: layer.kind as 'image' | 'shape' | 'effect',
      guide: o.guide,
      rect,
      ...(o.clip ? { clipD: framePathD(o.clip.box, o.clip.radius, aspect) } : {}),
      ...(matrix ? { matrix } : {}),
      opacity: clamp01(layer.opacity),
      ...(layer.blend ? { blend: layer.blend } : {}),
      ...(content ? { content } : {})
    });
  }
  return { aspect, H, mode: composition.mode, nodes, urls, missing, composition };
}

/** The page's composition scene, or undefined when it has nothing to compose (the old path draws it). */
export const composeSceneIfAny = (doc: ComicDoc, page: Page, opts: ComposeSceneOptions = {}): ComposeScene | undefined =>
  pageComposes(page, { guides: opts.guides }) ? composeScene(doc, page, opts) : undefined;

// ── SVG (screen and print draw this tree) ─────────────────────────────────────────────────────────────────────────

const attrsOfMark = (m: BorderMark): SvgNode['attrs'] => ({
  d: m.d,
  fill: m.fill ?? 'none',
  ...(m.evenodd ? { 'fill-rule': 'evenodd' } : {}),
  ...(m.stroke ? { stroke: m.stroke, 'stroke-width': m.strokeW ?? 1 } : {}),
  ...(m.dash ? { 'stroke-dasharray': m.dash.join(' ') } : {}),
  ...(m.stroke && m.join ? { 'stroke-linejoin': m.join } : {}),
  ...(m.stroke && m.cap ? { 'stroke-linecap': m.cap } : {})
});

const fxNodeSvg = (n: FxNode): SvgNode => {
  const paint: SvgNode['attrs'] = {
    fill: n.fill ?? 'none',
    ...(n.stroke ? { stroke: n.stroke, 'stroke-width': n.strokeW ?? 0.01 } : {}),
    ...(typeof n.opacity === 'number' && n.opacity < 1 ? { opacity: n.opacity } : {})
  };
  if (n.tag === 'circle') return { tag: 'circle', attrs: { cx: n.cx, cy: n.cy, r: n.r, ...paint } };
  if (n.tag === 'rect') return { tag: 'rect', attrs: { x: n.x, y: n.y, width: n.w, height: n.h, ...paint } };
  return { tag: 'path', attrs: { d: n.d, ...paint } };
};

const imageSvg = (img: PlacedImage, extra: SvgNode['attrs'] = {}): SvgNode => ({
  tag: 'image',
  attrs: { href: img.url, x: img.x, y: img.y, width: img.w, height: img.h, preserveAspectRatio: 'none', ...extra }
});

/** One leaf of a layer's content. */
const contentSvg = (content: LayerContent, rect: UnitRect, clipId: (what: string) => string, defs: SvgNode[]): SvgNode[] => {
  if (content.t === 'image') {
    if (!content.crop) return [imageSvg(content.image)];
    const id = clipId('crop');
    defs.push({ tag: 'clipPath', attrs: { id }, children: [{ tag: 'path', attrs: { d: rectPathD(rect.x, rect.y, rect.w, rect.h) } }] });
    return [imageSvg(content.image, { 'clip-path': `url(#${id})` })];
  }
  if (content.t === 'shape') {
    return [
      {
        tag: 'path',
        attrs: {
          d: content.d,
          fill: content.fill ?? 'none',
          ...(content.stroke ? { stroke: content.stroke, 'stroke-width': content.strokeW ?? 1 } : {}),
          ...(content.line ? { 'stroke-linecap': 'round' } : {})
        }
      }
    ];
  }
  if (!content.nodes.length) return [];
  return [{ tag: 'g', attrs: { transform: `translate(${rect.x} ${rect.y}) scale(${rect.w} ${rect.h})` }, children: content.nodes.map(fxNodeSvg) }];
};

/** A clip id that is a valid XML name for any layer or panel id. */
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * The scene as an SVG element tree (one drawing for the screen and the print document). Layers are g[data-layer-id]:
 * clip, opacity and mix-blend-mode on that group (it composites once, as the canvas does), rotation and flip on the
 * group inside it. `idPrefix` keeps clip ids unique when several pages share a document.
 */
export function composeSvgNodes(scene: ComposeScene, idPrefix = 'cp'): SvgNode[] {
  const defs: SvgNode[] = [];
  const body: SvgNode[] = [];
  for (const node of scene.nodes) {
    if (node.k === 'paper') {
      body.push({ tag: 'rect', attrs: { x: 0, y: 0, width: COMPOSE_UNIT, height: scene.H, fill: node.fill, 'data-compose': 'paper' } });
      continue;
    }
    if (node.k === 'piece') {
      const id = `${idPrefix}-f-${safe(node.panelId)}`;
      const children: SvgNode[] = [];
      if (node.image) {
        defs.push({ tag: 'clipPath', attrs: { id }, children: [{ tag: 'path', attrs: { d: node.clipD } }] });
        children.push(imageSvg(node.image, { 'clip-path': `url(#${id})` }));
      } else if (node.empty === 'placeholder') {
        children.push({
          tag: 'path',
          attrs: { d: node.clipD, fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '6 5', style: 'stroke: var(--ds-faint)', 'data-placeholder': 'true' }
        });
      }
      children.push(...node.marks.map((m) => ({ tag: 'path', attrs: attrsOfMark(m) })));
      body.push({ tag: 'g', attrs: { 'data-panel-id': node.panelId, 'data-frame': node.n, ...(node.empty ? { 'data-empty': node.empty } : {}) }, children });
      continue;
    }
    const clipId = (what: string) => `${idPrefix}-${what}-${safe(node.id)}`;
    const groupAttrs: SvgNode['attrs'] = { 'data-layer-id': node.id, 'data-layer-kind': node.kind };
    if (node.guide) groupAttrs['data-guide'] = 'true';
    if (node.clipD) {
      const id = clipId('k');
      defs.push({ tag: 'clipPath', attrs: { id }, children: [{ tag: 'path', attrs: { d: node.clipD } }] });
      groupAttrs['clip-path'] = `url(#${id})`;
    }
    if (node.opacity < 1) groupAttrs.opacity = node.opacity;
    if (node.blend) groupAttrs.style = `mix-blend-mode: ${node.blend}`;
    const leaves = node.content ? contentSvg(node.content, node.rect, clipId, defs) : [];
    const children: SvgNode[] = node.matrix ? [{ tag: 'g', attrs: { transform: `matrix(${node.matrix.join(' ')})` }, children: leaves }] : leaves;
    body.push({ tag: 'g', attrs: groupAttrs, children });
  }
  return defs.length ? [{ tag: 'defs', attrs: {}, children: defs }, ...body] : body;
}
