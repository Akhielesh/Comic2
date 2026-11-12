// SVG ↔ canvas operation-recorder parity, per layer kind (image, shape, effect through a fake generator, sticker,
// blend) and for panel frames: the SVG tree the screen and print draw, and the calls the PNG / PDF / ZIP canvas makes,
// reduce to the SAME primitive operations — the same paths, the same image mapping (picture → page), under the same
// matrix, clip, opacity, blend and fill rule. A renderer that drifts (a transform dropped, a crop mis-mapped, per-call
// opacity instead of one composite, a blend lost, the film ring's even-odd fill lost) fails here.

import { describe, expect, it, vi } from 'vitest';
import type { FxNode } from '../../../shared/comic/fx/types';
import { framePathD } from '../../../shared/comic/panelize/compose';
import { panelBoxesFor } from '../../../shared/comic/pageGeometry';
import { fakeContext, fakeLayers, fakePath, type DrawCall, type FakeCtx } from '../export/__fixtures__/fakeCanvas';
import type { SvgNode } from '../lettering/svgMarkup';
import { drawComposeScene, type ComposeImage } from './composeCanvas';
import { composeScene, composeSvgNodes, type ComposeScene } from './pageNodes';
import { fakePathUrl, framedDoc, LAYERS, layeredDoc } from './__fixtures__/composeDocs';

const FAKE_NODES: FxNode[] = vi.hoisted(() => [
  { tag: 'path', d: 'M0 0L1 0L0.5 1Z', fill: '#111111' },
  { tag: 'circle', cx: 0.5, cy: 0.5, r: 0.1, fill: '#ff0000', opacity: 0.5 },
  { tag: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.3, fill: '#00ff00', stroke: '#000000', strokeW: 0.01 }
]);

// The fake generator: what PE-FX's registered drawing would return for 'speed-lines'.
vi.mock('../../../shared/comic/fx/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/comic/fx/registry')>();
  return { ...real, renderFx: vi.fn((fx: { gen: string }) => (fx.gen === 'speed-lines' ? FAKE_NODES : [])) };
});

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
];
const parseTransform = (t: string): M => {
  let m = ID;
  for (const [, fn, args] of t.matchAll(/(matrix|translate|scale)\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn === 'matrix') m = mul(m, a as M);
    if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0], a[1] ?? 0]);
    if (fn === 'scale') m = mul(m, [a[0], 0, 0, a[1] ?? a[0], 0, 0]);
  }
  return m;
};

/** One primitive operation in page units, with everything that decides how it lands. */
interface Op {
  op: string;
  geom: number[] | string;
  paint: string;
  /** Fills only: 'evenodd' or 'nonzero' (the SVG fill-rule; canvas fill's second argument). */
  rule?: string;
  m: number[];
  alpha: number;
  blend: string;
  clips: string[];
}
const round = (n: number) => Math.round(n * 10) / 10;
const norm = (o: Op) => ({ ...o, geom: Array.isArray(o.geom) ? o.geom.map(round) : o.geom, m: o.m.map(round), alpha: round(o.alpha) });

/** The SVG tree → ops (group opacity and blend carried down; clip-path resolved to its path d). */
const svgOps = (nodes: SvgNode[], images: Map<string, ComposeImage>): Op[] => {
  const clipD = new Map<string, string>();
  const collect = (n: SvgNode) => {
    if (n.tag === 'clipPath') clipD.set(String(n.attrs.id), String(n.children![0].attrs.d));
    n.children?.forEach(collect);
  };
  nodes.forEach(collect);
  const out: Op[] = [];
  const walk = (n: SvgNode, m: M, alpha: number, blend: string, clips: string[]) => {
    if (n.tag === 'defs' || n.tag === 'clipPath') return;
    const own = n.attrs['clip-path'] ? [...clips, clipD.get(String(n.attrs['clip-path']).replace(/^url\(#|\)$/g, ''))!] : clips;
    const mm = n.attrs.transform ? mul(m, parseTransform(String(n.attrs.transform))) : m;
    const a = alpha * (n.attrs.opacity !== undefined ? Number(n.attrs.opacity) : 1);
    const b = n.attrs.style ? String(n.attrs.style).replace(/^mix-blend-mode:\s*/, '') : blend;
    if (n.tag === 'g') return n.children?.forEach((c) => walk(c, mm, a, b, own));
    const fill = String(n.attrs.fill ?? '');
    const stroke = n.attrs.stroke ? `${n.attrs.stroke}/${n.attrs['stroke-width']}` : '';
    const base = { m: mm, alpha: a, blend: b, clips: own };
    if (n.tag === 'image') {
      // The whole picture lands on (x, y, width, height): the map from the picture's pixel square.
      const img = images.get(String(n.attrs.href))!;
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => Number(n.attrs[k]));
      const geom = mul(mm, [w / img.width, 0, 0, h / img.height, x, y]);
      out.push({ op: 'image', geom, paint: String(n.attrs.href), ...base, m: ID });
      return;
    }
    const geom = n.tag === 'path' ? String(n.attrs.d) : n.tag === 'circle' ? [n.attrs.cx, n.attrs.cy, n.attrs.r].map(Number) : [n.attrs.x, n.attrs.y, n.attrs.width, n.attrs.height].map(Number);
    if (fill && fill !== 'none') out.push({ op: `${n.tag}:fill`, geom, paint: fill, rule: String(n.attrs['fill-rule'] ?? 'nonzero'), ...base });
    if (stroke) out.push({ op: `${n.tag}:stroke`, geom, paint: stroke, ...base });
  };
  nodes.forEach((n) => walk(n, ID, 1, 'normal', []));
  return out.map(norm);
};

/** The canvas recording → ops. Offscreen layers are folded back into the page through the drawImage that composites them. */
const canvasOps = (scene: ComposeScene, images: Map<string, ComposeImage>): Op[] => {
  const W = 1000;
  const H = scene.H;
  const page = fakeContext(W, H);
  const layers = fakeLayers();
  const wrap = (f: ReturnType<typeof fakeContext>) => {
    const ctx = f.ctx as unknown as Record<string, () => void>;
    for (const name of ['save', 'restore']) {
      const orig = ctx[name];
      ctx[name] = () => {
        f.calls.push({ name, args: [], state: f.calls[f.calls.length - 1]?.state } as DrawCall);
        orig();
      };
    }
    return f;
  };
  wrap(page);
  const createLayer = (w: number, h: number) => {
    const l = layers.createLayer(w, h);
    wrap(layers.made[layers.made.length - 1]);
    return l;
  };
  drawComposeScene(page.ctx, scene, W, H, { images, makePath: fakePath, createLayer });
  const byLabel = new Map<string, FakeCtx>(layers.made.map((f, i) => [`layer${i}`, f]));
  // A pooled buffer is reused: each use starts with a clearRect, and each composite reads the next use.
  const uses = new Map<string, DrawCall[][]>(
    layers.made.map((f, i) => {
      const segments: DrawCall[][] = [];
      for (const c of f.calls) {
        if (c.name === 'clearRect') segments.push([]);
        else segments[segments.length - 1]?.push(c);
      }
      return [`layer${i}`, segments];
    })
  );
  const sourceOf = (src: unknown) => [...images].find(([, i]) => i.source === src);
  const out: Op[] = [];
  const read = (calls: DrawCall[], outer: M, alpha0: number, blend0: string, clips0: string[]) => {
    const stack: string[][] = [];
    let clips = clips0;
    let pending: { d?: string; geom?: number[]; tag?: string } = {};
    for (const c of calls) {
      if (c.name === 'save') stack.push(clips);
      else if (c.name === 'restore') clips = stack.pop() ?? clips0;
      else if (c.name === 'clip') clips = [...clips, (c.args[0] as { d: string }).d];
      else if (c.name === 'beginPath') pending = {};
      else if (c.name === 'arc') pending = { tag: 'circle', geom: [c.args[0], c.args[1], c.args[2]] as number[] };
      else if (c.name === 'rect') pending = { tag: 'rect', geom: c.args as number[] };
      else {
        const m = mul(outer, c.state.matrix);
        const alpha = alpha0 * c.state.globalAlpha;
        const blend = c.state.globalCompositeOperation === 'source-over' ? blend0 : c.state.globalCompositeOperation;
        if (c.name === 'drawImage') {
          const [src, sx, sy, sw, sh, dx, dy, dw, dh] = c.args as [unknown, number, number, number, number, number, number, number, number];
          const label = (src as { label?: string }).label;
          const layer = label ? byLabel.get(label) : undefined;
          if (layer) {
            // An offscreen layer: the calls of its next use land through this drawImage (layer pixels → page), the
            // 9-argument form reading only the part that use drew.
            expect(c.args).toHaveLength(9);
            const use = uses.get(label!)!.shift();
            expect(use, `a composite of ${label} without a use`).toBeDefined();
            read(use!, mul(m, [dw / sw, 0, 0, dh / sh, dx - (sx * dw) / sw, dy - (sy * dh) / sh]), alpha, blend, clips);
            continue;
          }
          const [url, img] = sourceOf(src)!;
          const k = dw / sw;
          const l = dh / sh;
          out.push({ op: 'image', geom: mul(m, [k, 0, 0, l, dx - sx * k, dy - sy * l]), paint: url, m: ID, alpha, blend, clips });
          void img;
          continue;
        }
        const pathArg = c.args[0] as { d?: string } | undefined;
        const tag = pathArg?.d !== undefined ? 'path' : pending.tag!;
        const geom = pathArg?.d !== undefined ? pathArg.d : pending.geom!;
        if (c.name === 'fill') {
          const rule = typeof c.args[1] === 'string' ? c.args[1] : typeof c.args[0] === 'string' ? c.args[0] : 'nonzero';
          out.push({ op: `${tag}:fill`, geom, paint: String(c.state.fillStyle), rule, m, alpha, blend, clips });
        }
        if (c.name === 'stroke') out.push({ op: `${tag}:stroke`, geom, paint: `${c.state.strokeStyle}/${c.state.lineWidth}`, m, alpha, blend, clips });
        if (c.name === 'fillRect') out.push({ op: 'rect:fill', geom: c.args as number[], paint: String(c.state.fillStyle), rule: 'nonzero', m, alpha, blend, clips });
      }
    }
  };
  read(page.calls, ID, 1, 'normal', []);
  // Every use of every offscreen buffer was composited exactly once.
  for (const [label, rest] of uses) expect(rest, `${label}: uses never composited`).toEqual([]);
  return out.map(norm);
};

const pictures = (scene: ComposeScene): Map<string, ComposeImage> =>
  new Map(scene.urls.map((url, i) => [url, { source: { tag: `pic${i}` } as unknown as CanvasImageSource, width: 800 + i * 100, height: 600 + i * 50 }]));

const parity = (scene: ComposeScene) => {
  const images = pictures(scene);
  const svg = svgOps(composeSvgNodes(scene, 'pt'), images);
  const canvas = canvasOps(scene, images);
  expect(svg.length).toBeGreaterThan(0);
  expect(canvas).toEqual(svg);
  return svg;
};

const sceneOf = (layers: Parameters<typeof layeredDoc>[0], framed = false) => {
  const doc = layeredDoc(layers, framed);
  return composeScene(doc, doc.pages[0], { resolve: { rasterUrl: 'https://cdn.test/raster.png', urlForPath: fakePathUrl } });
};

describe('SVG and canvas draw the same operations (one node tree)', () => {
  it('image: a cropped, rotated photo lands through the same picture → page map, inside its crop', () => {
    const ops = parity(sceneOf([LAYERS.image]));
    expect(ops.map((o) => o.op)).toEqual(['image']);
  });

  it('shape: fill and stroke of the same path; opacity composites the layer once (offscreen on the canvas)', () => {
    const ops = parity(sceneOf([LAYERS.shape]));
    expect(ops.map((o) => [o.op, o.alpha])).toEqual([
      ['path:fill', 0.8],
      ['path:stroke', 0.8]
    ]);
  });

  it('a translucent layer composites ONCE, like its SVG group: fill and stroke go to one offscreen layer drawn at its opacity', () => {
    const scene = sceneOf([LAYERS.shape]);
    const svgGroup = composeSvgNodes(scene).find((n) => n.attrs['data-layer-id'] === 'ly_box')!;
    expect(svgGroup.attrs.opacity).toBe(0.8);
    const page = fakeContext(1000, scene.H);
    const layers = fakeLayers();
    drawComposeScene(page.ctx, scene, 1000, scene.H, { images: new Map(), makePath: fakePath, createLayer: layers.createLayer });
    expect(layers.made).toHaveLength(1);
    expect(layers.made[0].draws().map((c) => [c.name, c.state.globalAlpha])).toEqual([
      ['fill', 1],
      ['stroke', 1]
    ]);
    expect(page.draws().map((c) => [c.name, c.state.globalAlpha])).toEqual([['drawImage', 0.8]]);
  });

  it('effect: the generator’s paths, circles and rects under translate(box) scale(box)', () => {
    const ops = parity(sceneOf([LAYERS.effect]));
    expect(ops.map((o) => o.op)).toEqual(['path:fill', 'circle:fill', 'rect:fill', 'rect:stroke']);
    expect(ops[1].alpha).toBe(0.5);
  });

  it('sticker: the library file, flipped about its centre', () => {
    const ops = parity(sceneOf([LAYERS.sticker]));
    expect(ops.map((o) => [o.op, o.paint])).toEqual([['image', '/library/fluent-flat/1/star.svg']]);
    expect((ops[0].geom as number[])[0]).toBeLessThan(0);
  });

  it('blend: multiply on the layer, kept inside its panel', () => {
    const blended = { ...LAYERS.blend, clip: 'pg_1_p1' };
    const ops = parity(sceneOf([blended], true));
    const layerOps = ops.filter((o) => o.blend === 'multiply');
    expect(layerOps.map((o) => [o.op, o.alpha])).toEqual([['path:fill', 0.5]]);
    expect(layerOps[0].clips).toHaveLength(1);
  });

  it('frames: every piece clipped to its frame, the drawing mapped by its cut, then its border', () => {
    const doc = framedDoc((page) => {
      page.panels[1].frame = { ...page.panels[1].frame!, border: { style: 'rough', seed: 9 } };
      page.panels[2].frame = { ...page.panels[2].frame!, border: { style: 'film' } };
    });
    const ops = parity(composeScene(doc, doc.pages[0], { resolve: { rasterUrl: 'https://cdn.test/raster.png' } }));
    expect(ops.filter((o) => o.op === 'image')).toHaveLength(3);
    expect(ops.filter((o) => o.op === 'image').every((o) => o.clips.length === 1)).toBe(true);
  });

  it('a rotated, flipped translucent shape composites once WITH its transform (grouped through the offscreen layer)', () => {
    const scene = sceneOf([{ ...LAYERS.shape, id: 'ly_rot', rot: 20, flip: 'v' }]);
    const ops = parity(scene);
    expect(ops.map((o) => [o.op, o.alpha])).toEqual([
      ['path:fill', 0.8],
      ['path:stroke', 0.8]
    ]);
    for (const o of ops) expect(o.m, o.op).not.toEqual(ID);
  });

  it('an effect with a blend and opacity composites once, multiplied, through the offscreen layer', () => {
    const scene = sceneOf([{ ...LAYERS.effect, id: 'ly_fxb', blend: 'multiply', opacity: 0.6 }]);
    const ops = parity(scene);
    expect(ops).toHaveLength(4);
    for (const o of ops) expect(o.blend, o.op).toBe('multiply');
    expect(ops.map((o) => o.alpha)).toEqual([0.6, 0.3, 0.6, 0.6]);
  });

  it('the page’s translucent layers share ONE offscreen buffer (made once, cleared between layers)', () => {
    const scene = sceneOf([LAYERS.shape, { ...LAYERS.shape, id: 'ly_box2', box: { x: 0.1, y: 0.1, w: 0.8, h: 0.3 } }, { ...LAYERS.effect, id: 'ly_fxb', opacity: 0.5 }]);
    parity(scene);
    const page = fakeContext(1000, scene.H);
    const layers = fakeLayers();
    drawComposeScene(page.ctx, scene, 1000, scene.H, { images: new Map(), makePath: fakePath, createLayer: layers.createLayer });
    expect(layers.made.length).toBeLessThanOrEqual(1);
    expect(layers.made[0].calls.filter((c) => c.name === 'clearRect')).toHaveLength(3);
    expect(page.draws().filter((c) => c.name === 'drawImage')).toHaveLength(3);
  });

  it('frames: the film border’s ring is filled even-odd in both (else it would cover the whole frame)', () => {
    const doc = framedDoc((page) => (page.panels[0].frame = { ...page.panels[0].frame!, border: { style: 'film' } }));
    const ops = parity(composeScene(doc, doc.pages[0], { resolve: { rasterUrl: 'https://cdn.test/raster.png' } }));
    expect(ops.some((o) => o.op === 'path:fill' && o.rule === 'evenodd')).toBe(true);
  });

  it('page mode: an overlay kept in a panel is clipped to that panel’s box on the drawing', () => {
    const doc = layeredDoc([{ ...LAYERS.shape, clip: 'pg_1_p1' }]);
    const scene = composeScene(doc, doc.pages[0], { resolve: { urlForPath: fakePathUrl } });
    expect(scene.mode).toBe('page');
    const box = panelBoxesFor(doc, doc.pages[0])[0];
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    const expected = framePathD({ x: r4(box.x), y: r4(box.y), w: r4(box.w), h: r4(box.h) }, 0, scene.aspect);
    const ops = parity(scene);
    for (const o of ops) expect(o.clips, o.op).toEqual([expected]);
  });

  it('everything at once (every kind, in frames, with a blend): one tree, one order', () => {
    parity(sceneOf([LAYERS.image, LAYERS.sticker, LAYERS.shape, LAYERS.effect, { ...LAYERS.blend, clip: 'pg_1_p2' }], true));
  });
});
