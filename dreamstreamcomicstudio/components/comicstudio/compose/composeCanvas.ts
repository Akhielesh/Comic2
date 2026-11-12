// The page node tree on a 2D canvas (PNG, PDF and ZIP exports): the very scene the screen and the print document draw
// as SVG (pageNodes.ts), call for call:
//   - paper: one fillRect;
//   - a frame: clip to its outline, drawImage of the part of the picture it shows (the 9-argument form: source
//     rectangle → frame), then its border marks (the same paths, through makePath);
//   - an overlay: clip to its panel when kept inside one, its rotation and flip as one transform(), then its content:
//     an image (drawImage of its crop onto its box), a shape (fill then stroke of its path) or an effect (renderFx's
//     nodes under translate(box) scale(box)). Opacity and blend composite the layer ONCE, like the SVG group: a layer
//     with more than one draw call is drawn into an offscreen layer, then drawn with globalAlpha and
//     globalCompositeOperation ('multiply' | 'screen' | 'overlay'); a single draw call gets them directly.
// Pictures must be loaded first (ComposeImage by URL); one that is missing is left out, never a crash. The lettering is
// drawn after this by canvasDraw.ts (PE-LETTER's renderer), always on top.

import type { FxNode } from '../../../shared/comic/fx/types';
import { COMPOSE_UNIT, rectPathD, type BorderMark, type UnitRect } from '../../../shared/comic/panelize/compose';
import { defaultLayerFactory, type LayerFactory, type PathFactory } from '../export/canvasDraw';
import type { ComposeNode, ComposeScene, LayerContent } from './pageNodes';

/** A loaded picture. */
export interface ComposeImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface ComposeCanvasOptions {
  /** Loaded pictures by URL (scene.urls). */
  images: ReadonlyMap<string, ComposeImage>;
  makePath?: PathFactory;
  createLayer?: LayerFactory;
}

const defaultPath: PathFactory = (d) => new Path2D(d);

const drawMark = (ctx: CanvasRenderingContext2D, m: BorderMark, path: PathFactory) => {
  const p = path(m.d);
  ctx.save();
  if (m.fill && m.fill !== 'none') {
    ctx.fillStyle = m.fill;
    if (m.evenodd) ctx.fill(p, 'evenodd');
    else ctx.fill(p);
  }
  if (m.stroke) {
    ctx.strokeStyle = m.stroke;
    ctx.lineWidth = m.strokeW ?? 1;
    ctx.setLineDash(m.dash ?? []);
    ctx.lineJoin = m.join ?? 'miter';
    ctx.lineCap = m.cap ?? 'butt';
    ctx.stroke(p);
  }
  ctx.restore();
};

const drawFxNode = (ctx: CanvasRenderingContext2D, n: FxNode, path: PathFactory) => {
  ctx.save();
  if (typeof n.opacity === 'number' && n.opacity < 1) ctx.globalAlpha *= Math.max(0, n.opacity);
  let p: Path2D | undefined;
  if (n.tag === 'path') p = path(n.d);
  else {
    ctx.beginPath();
    if (n.tag === 'circle') ctx.arc(n.cx, n.cy, n.r, 0, Math.PI * 2);
    else ctx.rect(n.x, n.y, n.w, n.h);
  }
  if (n.fill && n.fill !== 'none') {
    ctx.fillStyle = n.fill;
    if (p) ctx.fill(p);
    else ctx.fill();
  }
  if (n.stroke) {
    ctx.strokeStyle = n.stroke;
    ctx.lineWidth = n.strokeW ?? 0.01;
    if (p) ctx.stroke(p);
    else ctx.stroke();
  }
  ctx.restore();
};

/** How many draw calls a layer's content makes (one call can take opacity and blend directly). */
const drawCalls = (content: LayerContent | undefined): number => {
  if (!content) return 0;
  if (content.t === 'image') return 1;
  if (content.t === 'shape') return (content.fill ? 1 : 0) + (content.stroke ? 1 : 0);
  return content.nodes.reduce((n, node) => n + (node.fill && node.fill !== 'none' ? 1 : 0) + (node.stroke ? 1 : 0), 0);
};

const drawContent = (ctx: CanvasRenderingContext2D, content: LayerContent, rect: UnitRect, opts: ComposeCanvasOptions, path: PathFactory) => {
  if (content.t === 'image') {
    const img = opts.images.get(content.image.url);
    if (!img) return;
    const { src, dst } = content.image;
    // A crop shows only its box (as the SVG's crop clip does); the source rectangle already keeps it inside.
    if (content.crop) {
      ctx.save();
      ctx.clip(path(rectPathD(rect.x, rect.y, rect.w, rect.h)));
    }
    ctx.drawImage(img.source, src.x * img.width, src.y * img.height, src.w * img.width, src.h * img.height, dst.x, dst.y, dst.w, dst.h);
    if (content.crop) ctx.restore();
    return;
  }
  if (content.t === 'shape') {
    const p = path(content.d);
    if (content.fill) {
      ctx.fillStyle = content.fill;
      ctx.fill(p);
    }
    if (content.stroke) {
      ctx.strokeStyle = content.stroke;
      ctx.lineWidth = content.strokeW ?? 1;
      ctx.setLineDash([]);
      ctx.lineCap = content.line ? 'round' : 'butt';
      ctx.lineJoin = 'miter';
      ctx.stroke(p);
    }
    return;
  }
  if (!content.nodes.length) return;
  ctx.save();
  ctx.translate(rect.x, rect.y);
  ctx.scale(rect.w, rect.h);
  for (const node of content.nodes) drawFxNode(ctx, node, path);
  ctx.restore();
};

/** The layer box under its transform, in page units (the offscreen layer's extent). */
const boundsOf = (rect: UnitRect, m: [number, number, number, number, number, number] | undefined, pad: number): UnitRect => {
  const corners: [number, number][] = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h]
  ].map(([x, y]) => (m ? [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] : [x, y]) as [number, number]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
};

const drawLayer = (ctx: CanvasRenderingContext2D, node: Extract<ComposeNode, { k: 'layer' }>, opts: ComposeCanvasOptions, path: PathFactory, sx: number, sy: number) => {
  const content = node.content;
  if (!content) return;
  ctx.save();
  if (node.clipD) ctx.clip(path(node.clipD));
  const grouped = (node.opacity < 1 || !!node.blend) && drawCalls(content) > 1;
  if (grouped) {
    const pad = content.t === 'shape' ? (content.strokeW ?? 0) + 2 : 2;
    const b = boundsOf(node.rect, node.matrix, pad);
    const lw = Math.max(1, Math.ceil(b.w * sx));
    const lh = Math.max(1, Math.ceil(b.h * sy));
    const layer = (opts.createLayer ?? defaultLayerFactory)(lw, lh);
    if (layer) {
      const lctx = layer.ctx;
      lctx.save();
      lctx.scale(sx, sy);
      lctx.translate(-b.x, -b.y);
      if (node.matrix) lctx.transform(...node.matrix);
      drawContent(lctx, content, node.rect, opts, path);
      lctx.restore();
      if (node.opacity < 1) ctx.globalAlpha = node.opacity;
      if (node.blend) ctx.globalCompositeOperation = node.blend;
      ctx.drawImage(layer.canvas, b.x, b.y, lw / sx, lh / sy);
      ctx.restore();
      return;
    }
  }
  if (node.opacity < 1) ctx.globalAlpha = node.opacity;
  if (node.blend) ctx.globalCompositeOperation = node.blend;
  if (node.matrix) ctx.transform(...node.matrix);
  drawContent(ctx, content, node.rect, opts, path);
  ctx.restore();
};

/**
 * Draw a scene onto (0, 0, widthPx, heightPx) of the context's current user space (the page box on the canvas). The
 * page drawing in page mode is the caller's (drawn whole first, exactly as before); this draws what composes on it.
 */
export function drawComposeScene(ctx: CanvasRenderingContext2D, scene: ComposeScene, widthPx: number, heightPx: number, opts: ComposeCanvasOptions): void {
  const path = opts.makePath ?? defaultPath;
  const sx = widthPx / COMPOSE_UNIT;
  const sy = heightPx / scene.H;
  ctx.save();
  ctx.scale(sx, sy);
  for (const node of scene.nodes) {
    if (node.k === 'paper') {
      ctx.fillStyle = node.fill;
      ctx.fillRect(0, 0, COMPOSE_UNIT, scene.H);
      continue;
    }
    if (node.k === 'piece') {
      const img = node.image ? opts.images.get(node.image.url) : undefined;
      if (node.image && img) {
        const { src, dst } = node.image;
        ctx.save();
        ctx.clip(path(node.clipD));
        ctx.drawImage(img.source, src.x * img.width, src.y * img.height, src.w * img.width, src.h * img.height, dst.x, dst.y, dst.w, dst.h);
        ctx.restore();
      }
      for (const m of node.marks) drawMark(ctx, m, path);
      continue;
    }
    drawLayer(ctx, node, opts, path, sx, sy);
  }
  ctx.restore();
}
