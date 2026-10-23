// Canvas renderer for the lettering drawing (lettering.md §6.4, contract §10.2 draw order).
//
// The board, the reader and the print view draw lettering from `letteringNodes()` (svgMarkup.ts): one
// element tree per z-ordered balloon group. Exports draw THE SAME TREE onto a 2D canvas here, so a PNG,
// a PDF page or a motion-comic frame can never disagree with what the author arranged on screen:
//   - the order is the tree's order (extras → fat tail/neck strokes → body → tail/neck fills → inner →
//     text shadow → text with its outline), exactly as svgMarkup.ts documents it;
//   - `<g mask>` (translucent / transparent fills) is drawn into an offscreen layer and the mask's black
//     shapes are cut out of it with `destination-out` — the outside half of the 2× strokes stays, nothing
//     shows through the fill;
//   - `<g opacity>` (a translucent fill layer, a soft shadow) is drawn into a layer and composited once
//     with `globalAlpha`, so overlapping members never double up;
//   - text sets `ctx.direction` (rtl for Urdu / Arabic) and maps `text-anchor` to `textAlign` the way SVG
//     does (start/end follow the direction); glyph runs (`<tspan x y rotate>`) are drawn per glyph.
// Layers are sized to the group's bounds (not the whole page) so a phone never allocates a full-page
// buffer per translucent balloon. Without an offscreen canvas the group is drawn straight onto the page
// (strokes may show through a translucent fill — the only degradation).

import type { LetterPlan } from '../../../shared/comic/lettering/layout';
import { letteringNodes, planOutline, type SvgNode } from '../lettering/svgMarkup';

export type PathFactory = (d: string) => Path2D;
export interface CanvasLayer {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: CanvasRenderingContext2D;
}
export type LayerFactory = (width: number, height: number) => CanvasLayer | null;
export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DrawNodesOptions {
  makePath?: PathFactory;
  createLayer?: LayerFactory;
  /** Region (in the current user space) layers need to cover; default: the whole canvas. */
  layerBounds?: Bounds;
}

/** An offscreen 2D canvas (OffscreenCanvas when available, else a detached <canvas>). */
export const defaultLayerFactory: LayerFactory = (width, height) => {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D | null;
      if (ctx) return { canvas: canvas as unknown as CanvasLayer['canvas'], ctx };
    }
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) return { canvas, ctx };
    }
  } catch {
    /* fall through: draw without a layer */
  }
  return null;
};

const defaultPath: PathFactory = (d) => new Path2D(d);

// ── Attributes ────────────────────────────────────────────────────────────────

interface Paint {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  dash: number[];
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  textAnchor: 'start' | 'middle' | 'end';
  direction: 'ltr' | 'rtl';
  paintOrderStroke: boolean;
}

const ROOT_PAINT: Paint = {
  fill: '#000000',
  stroke: 'none',
  strokeWidth: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  dash: [],
  lineJoin: 'miter',
  lineCap: 'butt',
  fontFamily: 'sans-serif',
  fontSize: 16,
  fontWeight: '400',
  fontStyle: 'normal',
  textAnchor: 'start',
  direction: 'ltr',
  paintOrderStroke: false
};

const num = (v: unknown, fallback: number): number => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));

/** Presentation attributes inherit down the tree (opacity does not: it composites a group). */
function inherit(parent: Paint, attrs: SvgNode['attrs']): Paint {
  const p: Paint = { ...parent };
  const fill = str(attrs.fill);
  if (fill) p.fill = fill;
  const stroke = str(attrs.stroke);
  if (stroke) p.stroke = stroke;
  if (attrs['stroke-width'] !== undefined) p.strokeWidth = Math.max(0, num(attrs['stroke-width'], p.strokeWidth));
  if (attrs['fill-opacity'] !== undefined) p.fillOpacity = clamp01(num(attrs['fill-opacity'], 1));
  if (attrs['stroke-opacity'] !== undefined) p.strokeOpacity = clamp01(num(attrs['stroke-opacity'], 1));
  const dash = str(attrs['stroke-dasharray']);
  if (dash) p.dash = dash === 'none' ? [] : dash.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const join = str(attrs['stroke-linejoin']);
  if (join === 'round' || join === 'bevel' || join === 'miter') p.lineJoin = join;
  const cap = str(attrs['stroke-linecap']);
  if (cap === 'round' || cap === 'square' || cap === 'butt') p.lineCap = cap;
  const family = str(attrs['font-family']);
  if (family) p.fontFamily = family;
  if (attrs['font-size'] !== undefined) p.fontSize = Math.max(0.01, num(attrs['font-size'], p.fontSize));
  const weight = str(attrs['font-weight']);
  if (weight) p.fontWeight = weight;
  const style = str(attrs['font-style']);
  if (style) p.fontStyle = style;
  const anchor = str(attrs['text-anchor']);
  if (anchor === 'start' || anchor === 'middle' || anchor === 'end') p.textAnchor = anchor;
  const dir = str(attrs.direction);
  if (dir === 'rtl' || dir === 'ltr') p.direction = dir;
  const order = str(attrs['paint-order']);
  if (order) p.paintOrderStroke = /^\s*stroke/.test(order);
  return p;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const painted = (c: string) => !!c && c !== 'none' && c !== 'transparent';
const isBlack = (c: string) => /^(#000|#000000|#000000ff|black)$/i.test(c.trim());

const TRANSFORM_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
/** Apply an SVG transform list to the context (left to right, as SVG composes it). */
export function applySvgTransform(ctx: CanvasRenderingContext2D, transform: string): void {
  TRANSFORM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRANSFORM_RE.exec(transform))) {
    const a = m[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
      .map((n) => (Number.isFinite(n) ? n : 0));
    switch (m[1]) {
      case 'translate':
        ctx.translate(a[0] ?? 0, a[1] ?? 0);
        break;
      case 'scale':
        ctx.scale(a[0] ?? 1, a[1] ?? a[0] ?? 1);
        break;
      case 'rotate': {
        const rad = ((a[0] ?? 0) * Math.PI) / 180;
        if (a.length >= 3) {
          ctx.translate(a[1], a[2]);
          ctx.rotate(rad);
          ctx.translate(-a[1], -a[2]);
        } else ctx.rotate(rad);
        break;
      }
      case 'skewX':
        ctx.transform(1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0);
        break;
      case 'skewY':
        ctx.transform(1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0);
        break;
      case 'matrix':
        if (a.length >= 6) ctx.transform(a[0], a[1], a[2], a[3], a[4], a[5]);
        break;
    }
  }
}

// ── Renderer ──────────────────────────────────────────────────────────────────

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const currentMatrix = (ctx: CanvasRenderingContext2D): Matrix => {
  try {
    const m = ctx.getTransform?.();
    return m ? { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f } : IDENTITY;
  } catch {
    return IDENTITY;
  }
};
const apply = (m: Matrix, x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });

interface Env {
  makePath: PathFactory;
  createLayer: LayerFactory;
  masks: Map<string, SvgNode>;
  /** Device-pixel rectangle layers cover; null = off the canvas (draw nothing that needs a layer);
   *  undefined = unknown canvas size (draw straight onto the target). */
  region: { x: number; y: number; w: number; h: number } | null | undefined;
  /** Device-pixel origin of the current target (0,0 for the page; a layer's region otherwise). */
  offset: { x: number; y: number };
  pool: { layer: CanvasLayer; busy: boolean }[];
  /** Alpha multiplier when a group could not get a layer. */
  alpha: number;
  /** Mask-cut mode: black fills are erased (destination-out); nothing else draws. */
  cut: boolean;
}

const collectMasks = (nodes: readonly SvgNode[], into: Map<string, SvgNode>) => {
  for (const n of nodes) {
    if (n.tag === 'mask' && n.attrs.id !== undefined) into.set(String(n.attrs.id), n);
    if (n.children?.length) collectMasks(n.children, into);
  }
};

const acquire = (env: Env, w: number, h: number): CanvasLayer | null => {
  for (const slot of env.pool) {
    if (!slot.busy && slot.layer.canvas.width >= w && slot.layer.canvas.height >= h) {
      slot.busy = true;
      return slot.layer;
    }
  }
  const layer = env.createLayer(w, h);
  if (!layer) return null;
  env.pool.push({ layer, busy: true });
  return layer;
};
const release = (env: Env, layer: CanvasLayer) => {
  const slot = env.pool.find((s) => s.layer === layer);
  if (slot) slot.busy = false;
};

function fillAndStroke(ctx: CanvasRenderingContext2D, env: Env, p: Paint, draw: { fill: () => void; stroke: () => void }) {
  if (env.cut) {
    if (painted(p.fill) && isBlack(p.fill)) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      draw.fill();
    }
    return;
  }
  if (painted(p.fill) && p.fillOpacity > 0) {
    ctx.globalAlpha = env.alpha * p.fillOpacity;
    ctx.fillStyle = p.fill;
    draw.fill();
  }
  if (painted(p.stroke) && p.strokeWidth > 0 && p.strokeOpacity > 0) {
    ctx.globalAlpha = env.alpha * p.strokeOpacity;
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = p.strokeWidth;
    ctx.lineJoin = p.lineJoin;
    ctx.lineCap = p.lineCap;
    ctx.setLineDash(p.dash.length ? p.dash : []);
    draw.stroke();
    ctx.setLineDash([]);
  }
}

const canvasAlign = (anchor: Paint['textAnchor']): CanvasTextAlign => (anchor === 'middle' ? 'center' : anchor === 'end' ? 'end' : 'start');

function drawText(ctx: CanvasRenderingContext2D, env: Env, node: SvgNode, p: Paint) {
  if (env.cut) return;
  const style = p.fontStyle === 'italic' || p.fontStyle === 'oblique' ? 'italic ' : '';
  ctx.font = `${style}${p.fontWeight} ${Math.round(p.fontSize * 100) / 100}px ${p.fontFamily}`;
  ctx.textAlign = canvasAlign(p.textAnchor);
  ctx.textBaseline = 'alphabetic';
  if ('direction' in ctx) (ctx as CanvasRenderingContext2D & { direction: CanvasDirection }).direction = p.direction;
  const paintText = (text: string, x: number, y: number, tp: Paint) => {
    if (!text) return;
    const stroke = painted(tp.stroke) && tp.strokeWidth > 0 && tp.strokeOpacity > 0;
    const fill = painted(tp.fill) && tp.fillOpacity > 0;
    const doStroke = () => {
      ctx.globalAlpha = env.alpha * tp.strokeOpacity;
      ctx.strokeStyle = tp.stroke;
      ctx.lineWidth = tp.strokeWidth;
      ctx.lineJoin = tp.lineJoin;
      ctx.setLineDash([]);
      ctx.strokeText(text, x, y);
    };
    const doFill = () => {
      ctx.globalAlpha = env.alpha * tp.fillOpacity;
      ctx.fillStyle = tp.fill;
      ctx.fillText(text, x, y);
    };
    if (tp.paintOrderStroke) {
      if (stroke) doStroke();
      if (fill) doFill();
    } else {
      if (fill) doFill();
      if (stroke) doStroke();
    }
  };
  const x0 = num(node.attrs.x, 0);
  const y0 = num(node.attrs.y, 0);
  const spans = (node.children || []).filter((c) => c.tag === 'tspan');
  if (!spans.length) {
    paintText(node.text ?? '', x0, y0, p);
    return;
  }
  if (node.text) paintText(node.text, x0, y0, p);
  let y = y0;
  for (const span of spans) {
    const sp = inherit(p, span.attrs);
    const x = num(span.attrs.x, x0);
    y = span.attrs.y !== undefined ? num(span.attrs.y, y) : y + num(span.attrs.dy, 0);
    const rotate = num(span.attrs.rotate, 0);
    if (rotate) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rotate * Math.PI) / 180);
      paintText(span.text ?? '', 0, 0, sp);
      ctx.restore();
    } else paintText(span.text ?? '', x, y, sp);
  }
}

function drawShape(ctx: CanvasRenderingContext2D, env: Env, node: SvgNode, p: Paint) {
  const a = node.attrs;
  switch (node.tag) {
    case 'path': {
      const d = str(a.d);
      if (!d) return;
      let path: Path2D;
      try {
        path = env.makePath(d);
      } catch {
        return;
      }
      fillAndStroke(ctx, env, p, { fill: () => ctx.fill(path), stroke: () => ctx.stroke(path) });
      return;
    }
    case 'circle': {
      const r = num(a.r, 0);
      if (!(r > 0)) return;
      const trace = () => {
        ctx.beginPath();
        ctx.arc(num(a.cx, 0), num(a.cy, 0), r, 0, Math.PI * 2);
      };
      fillAndStroke(ctx, env, p, {
        fill: () => {
          trace();
          ctx.fill();
        },
        stroke: () => {
          trace();
          ctx.stroke();
        }
      });
      return;
    }
    case 'rect': {
      const w = num(a.width, 0);
      const h = num(a.height, 0);
      if (!(w > 0 && h > 0)) return;
      const trace = () => {
        ctx.beginPath();
        ctx.rect(num(a.x, 0), num(a.y, 0), w, h);
      };
      fillAndStroke(ctx, env, p, {
        fill: () => {
          trace();
          ctx.fill();
        },
        stroke: () => {
          trace();
          ctx.stroke();
        }
      });
      return;
    }
    case 'text':
      drawText(ctx, env, node, p);
      return;
  }
}

const SKIP = new Set(['mask', 'title', 'desc', 'defs', 'clipPath', 'tspan']);

function drawNode(ctx: CanvasRenderingContext2D, env: Env, node: SvgNode, parent: Paint): void {
  if (SKIP.has(node.tag)) return;
  const opacity = node.attrs.opacity !== undefined ? clamp01(num(node.attrs.opacity, 1)) : 1;
  if (opacity <= 0) return;
  const p = inherit(parent, node.attrs);
  const maskId = /^url\(#([^)]+)\)$/.exec(String(node.attrs.mask ?? '').trim())?.[1];
  const mask = maskId ? env.masks.get(maskId) : undefined;
  ctx.save();
  const transform = str(node.attrs.transform);
  if (transform) applySvgTransform(ctx, transform);
  const body = (target: CanvasRenderingContext2D) => {
    drawShape(target, env, node, p);
    for (const child of node.children || []) drawNode(target, env, child, p);
  };
  const needsLayer = !env.cut && (opacity < 1 || !!mask);
  const region = env.region;
  const layer = needsLayer && region && region.w > 0 && region.h > 0 ? acquire(env, region.w, region.h) : null;
  if (needsLayer && layer && region) {
    const m = currentMatrix(ctx);
    const off = env.offset;
    const lc = layer.ctx;
    lc.save();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.globalAlpha = 1;
    lc.clearRect(0, 0, region.w, region.h);
    // target px = device − off; layer px = device − region.
    lc.setTransform(m.a, m.b, m.c, m.d, m.e + off.x - region.x, m.f + off.y - region.y);
    const saved = env.alpha;
    env.alpha = 1;
    env.offset = { x: region.x, y: region.y };
    body(lc);
    if (mask) {
      const wasCut = env.cut;
      env.cut = true;
      for (const child of mask.children || []) drawNode(lc, env, child, ROOT_PAINT);
      env.cut = wasCut;
      lc.globalCompositeOperation = 'source-over';
    }
    env.offset = off;
    env.alpha = saved;
    lc.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = env.alpha * opacity;
    ctx.drawImage(layer.canvas, 0, 0, region.w, region.h, region.x - off.x, region.y - off.y, region.w, region.h);
    ctx.restore();
    release(env, layer);
  } else if (needsLayer && region === null) {
    // The group lies entirely off the canvas: nothing to draw.
  } else {
    // No layer needed, or none available: draw straight onto the target (alpha multiplied).
    const saved = env.alpha;
    env.alpha = saved * opacity;
    body(ctx);
    env.alpha = saved;
  }
  ctx.restore();
}

/** Device-pixel rectangle covering `bounds` (current user space) clipped to the canvas; null when empty. */
function regionFor(ctx: CanvasRenderingContext2D, bounds: Bounds | undefined): Env['region'] {
  const canvas = (ctx as CanvasRenderingContext2D & { canvas?: { width: number; height: number } }).canvas;
  const cw = canvas?.width ?? 0;
  const ch = canvas?.height ?? 0;
  if (!bounds) return cw > 0 && ch > 0 ? { x: 0, y: 0, w: cw, h: ch } : undefined;
  const m = currentMatrix(ctx);
  const pts = [apply(m, bounds.x, bounds.y), apply(m, bounds.x + bounds.w, bounds.y), apply(m, bounds.x, bounds.y + bounds.h), apply(m, bounds.x + bounds.w, bounds.y + bounds.h)];
  let x0 = Math.floor(Math.min(...pts.map((q) => q.x))) - 2;
  let y0 = Math.floor(Math.min(...pts.map((q) => q.y))) - 2;
  let x1 = Math.ceil(Math.max(...pts.map((q) => q.x))) + 2;
  let y1 = Math.ceil(Math.max(...pts.map((q) => q.y))) + 2;
  if (cw > 0 && ch > 0) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(cw, x1);
    y1 = Math.min(ch, y1);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Draw drawing nodes (svgMarkup's SvgNode tree) onto a canvas at the current transform. */
export function drawSvgNodes(ctx: CanvasRenderingContext2D, nodes: readonly SvgNode[], opts: DrawNodesOptions = {}): void {
  const masks = new Map<string, SvgNode>();
  collectMasks(nodes, masks);
  const env: Env = {
    makePath: opts.makePath ?? defaultPath,
    createLayer: opts.createLayer ?? defaultLayerFactory,
    masks,
    region: regionFor(ctx, opts.layerBounds),
    offset: { x: 0, y: 0 },
    pool: [],
    alpha: 1,
    cut: false
  };
  ctx.save();
  for (const n of nodes) drawNode(ctx, env, n, ROOT_PAINT);
  ctx.restore();
}

// ── Lettering ─────────────────────────────────────────────────────────────────

/** Linked chains drawn as one group, in svgMarkup's order (a group sits where its last member is). */
export function letterGroups(plans: readonly LetterPlan[]): LetterPlan[][] {
  const index = new Map(plans.map((p, i) => [p.lineId, i]));
  const parent = plans.map((_p, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  plans.forEach((p, i) => {
    const j = p.linkTo ? index.get(p.linkTo) : undefined;
    if (j !== undefined && j !== i) parent[find(i)] = find(j);
  });
  const by = new Map<number, LetterPlan[]>();
  plans.forEach((p, i) => {
    const r = find(i);
    by.set(r, [...(by.get(r) || []), p]);
  });
  const last = (g: LetterPlan[]) => Math.max(...g.map((p) => index.get(p.lineId)!));
  return [...by.values()].sort((a, b) => last(a) - last(b));
}

/** Conservative bounds of a group in plan units: outlines, text boxes, tails, trails, shadows, rotation. */
export function groupBounds(group: readonly LetterPlan[]): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of group) {
    const pts: { x: number; y: number }[] = [];
    const o = planOutline(p);
    pts.push({ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: p.x, y: p.y }, { x: p.x + p.w, y: p.y + p.h });
    if (p.tip) pts.push(p.tip);
    for (const c of p.geometry.bubbles) pts.push({ x: p.x + c.cx - c.r, y: p.y + c.cy - c.r }, { x: p.x + c.cx + c.r, y: p.y + c.cy + c.r });
    const margin = Math.max(4 * (p.stroke || 0), 0.6 * (p.fontSize || 0)) + 2;
    const rot = p.transform?.rotate ?? 0;
    const skew = p.transform?.skewX ?? 0;
    const cx = p.transform?.cx ?? p.x + p.w / 2;
    const cy = p.transform?.cy ?? p.y + p.h / 2;
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lo = { x: Math.min(...pts.map((q) => q.x)) - margin, y: Math.min(...pts.map((q) => q.y)) - margin };
    const hi = { x: Math.max(...pts.map((q) => q.x)) + margin, y: Math.max(...pts.map((q) => q.y)) + margin };
    const skewPad = skew ? Math.abs(Math.tan((skew * Math.PI) / 180)) * (hi.y - lo.y) : 0;
    const corners = [
      { x: lo.x - skewPad, y: lo.y },
      { x: hi.x + skewPad, y: lo.y },
      { x: lo.x - skewPad, y: hi.y },
      { x: hi.x + skewPad, y: hi.y }
    ];
    for (const c of corners) {
      if (!rot) add(c.x, c.y);
      else add(cx + (c.x - cx) * cos - (c.y - cy) * sin, cy + (c.x - cx) * sin + (c.y - cy) * cos);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface LetterDrawOptions {
  /** Plan aspect (page width / height). */
  aspect: number;
  /** Drawn page width in device px (keeps outlines ≥ 1.25 px, as on screen). */
  widthPx: number;
  makePath?: PathFactory;
  createLayer?: LayerFactory;
}

/**
 * Draw LetterPlans at the current transform, where 1 plan unit = 1 user unit (callers scale by
 * pageWidthPx / 1000 — see `drawLetteringOnPage`). Same nodes and order as the board's SVG.
 */
export function drawLetterPlan(ctx: CanvasRenderingContext2D, plans: readonly LetterPlan[], opts: LetterDrawOptions): void {
  letterGroups(plans).forEach((group, i) => {
    const nodes = letteringNodes(group, { aspect: opts.aspect, widthPx: opts.widthPx, idPrefix: `ex${i}` });
    drawSvgNodes(ctx, nodes, { makePath: opts.makePath, createLayer: opts.createLayer, layerBounds: groupBounds(group) });
  });
}

/** Lettering over a page drawn at (x, y, width, height) device px. */
export function drawLetteringOnPage(
  ctx: CanvasRenderingContext2D,
  plans: readonly LetterPlan[],
  box: { x: number; y: number; width: number; height: number },
  opts: Omit<LetterDrawOptions, 'aspect' | 'widthPx'> = {}
): void {
  if (!plans.length || !(box.width > 0) || !(box.height > 0)) return;
  const s = box.width / 1000;
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.scale(s, s);
  drawLetterPlan(ctx, plans, { ...opts, aspect: box.width / box.height, widthPx: box.width });
  ctx.restore();
}
