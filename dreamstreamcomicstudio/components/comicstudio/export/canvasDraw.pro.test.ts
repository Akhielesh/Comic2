// PE-LETTER: SVG and canvas parity for every Pro lettering feature (master plan §2.12 "SVG/canvas parity for each
// feature"), and the canvas exporter's new <defs>, <linearGradient> and <clipPath> support (§0.1 bug: "canvasDraw skips
// clipPath and defs"; §2.5 graft 7 needs clip masks for typewriter and wipes).
//
// The parity check is an operation recorder: every outline path the SVG tree draws is filled or stroked on the canvas,
// and every text draw in the tree (each <text>, or each glyph <tspan>, per painted fill and stroke) is one fillText /
// strokeText call. Before PE-LETTER none of these features drew in either renderer, a url(#…) fill painted the literal
// string, and a clip-path was ignored.

import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, planLettering, type LetterPlan } from '../../../shared/comic/lettering/layout';
import { PRO_BUBBLE_SHAPES, type LetterStylePatch } from '../../../shared/comic/lettering/style';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { letteringNodes, type SvgNode } from '../lettering/svgMarkup';
import { fakeContext, fakeLayers, fakePath, type FakeCtx } from './__fixtures__/fakeCanvas';
import { drawLetterPlan, drawSvgNodes } from './canvasDraw';

const ASPECT = 2 / 3;
/** A patch carrying a Pro id (the base unions stay narrow until the fold, collisions B-4). */
const pro = (p: Record<string, unknown>): LetterStylePatch => p as unknown as LetterStylePatch;
const plansOf = (doc: ComicDoc): LetterPlan[] => planLettering(doc, doc.pages[0], letteringAspect(doc, doc.pages[0]), estimateMeasure);
const pathD = (c: { args: unknown[] }) => (c.args[0] as { d?: string } | undefined)?.d;

interface FakeGradient {
  kind: 'gradient';
  at: number[];
  stops: [number, string][];
  addColorStop: (o: number, c: string) => void;
}
/** fakeContext plus createLinearGradient (recorded) — jsdom has no canvas. */
const ctxWithGradients = (w = 1000, h = 1500): FakeCtx & { gradients: FakeGradient[] } => {
  const f = fakeContext(w, h);
  const gradients: FakeGradient[] = [];
  (f.ctx as unknown as Record<string, unknown>).createLinearGradient = (...at: number[]) => {
    const g: FakeGradient = { kind: 'gradient', at, stops: [], addColorStop: (o, c) => g.stops.push([o, c]) };
    gradients.push(g);
    return g;
  };
  return { ...f, gradients };
};

const DEF_TAGS = new Set(['defs', 'mask', 'clipPath', 'linearGradient', 'title']);
/** Visit the drawn part of a tree (never the definitions), with the inherited fill and stroke. */
const walk = (nodes: readonly SvgNode[], visit: (n: SvgNode, paint: { fill?: string; stroke?: string; sw: number }) => void, paint = { fill: '#000000', stroke: 'none', sw: 1 } as { fill?: string; stroke?: string; sw: number }) => {
  for (const n of nodes) {
    if (DEF_TAGS.has(n.tag) || n.attrs.opacity === 0) continue;
    const p = { fill: n.attrs.fill !== undefined ? String(n.attrs.fill) : paint.fill, stroke: n.attrs.stroke !== undefined ? String(n.attrs.stroke) : paint.stroke, sw: n.attrs['stroke-width'] !== undefined ? Number(n.attrs['stroke-width']) : paint.sw };
    visit(n, p);
    if (n.tag !== 'text') walk(n.children || [], visit, p);
  }
};
const painted = (c?: string) => !!c && c !== 'none';

/** Draw the plans both ways and check the canvas drew what the tree says, path by path and text draw by text draw. */
const parity = (plans: LetterPlan[]) => {
  const nodes = letteringNodes(plans, { aspect: ASPECT, widthPx: 1000, idPrefix: 'ex0' });
  const paths: string[] = [];
  let textDraws = 0;
  walk(nodes, (n, p) => {
    if (n.tag === 'path' && n.attrs.d) paths.push(String(n.attrs.d));
    if (n.tag === 'text') {
      const spans = (n.children || []).filter((c) => c.tag === 'tspan').length || (n.text ? 1 : 0);
      textDraws += spans * ((painted(p.fill) ? 1 : 0) + (painted(p.stroke) && p.sw > 0 ? 1 : 0));
    }
  });
  const f = ctxWithGradients();
  drawLetterPlan(f.ctx, plans, { aspect: ASPECT, widthPx: 1000, makePath: fakePath, createLayer: fakeLayers().createLayer });
  const drawnPaths = new Set(f.calls.filter((c) => c.name === 'fill' || c.name === 'stroke').map(pathD));
  for (const d of paths) expect(drawnPaths.has(d), d.slice(0, 40)).toBe(true);
  const texts = f.calls.filter((c) => c.name === 'fillText' || c.name === 'strokeText');
  expect(texts.length).toBe(textDraws);
  expect(textDraws).toBeGreaterThan(0);
  return { nodes, f, texts };
};

const styled = (id: string, style: LetterStylePatch, mutate?: (d: ComicDoc) => void) =>
  plansOf(
    makeSampleDoc((d) => {
      for (const panel of d.pages[0].panels) for (const l of panel.lines) if (l.id === id) l.style = style;
      mutate?.(d);
    })
  ).filter((p) => p.lineId === id);
const find = (nodes: SvgNode[], pred: (n: SvgNode) => boolean): SvgNode[] => {
  const out: SvgNode[] = [];
  const go = (n: SvgNode) => {
    if (pred(n)) out.push(n);
    (n.children || []).forEach(go);
  };
  nodes.forEach(go);
  return out;
};

describe('canvas: <defs>, <linearGradient> and <clipPath>', () => {
  it('a url(#id) fill is the gradient at its userSpaceOnUse end points, with the stops and their opacity', () => {
    const f = ctxWithGradients();
    drawSvgNodes(
      f.ctx,
      [
        { tag: 'defs', attrs: {}, children: [{ tag: 'linearGradient', attrs: { id: 'g1', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 5, x2: 100, y2: 5 }, children: [{ tag: 'stop', attrs: { offset: 0, 'stop-color': '#ff0000' } }, { tag: 'stop', attrs: { offset: 1, 'stop-color': '#0000ff', 'stop-opacity': 0.5 } }] }] },
        { tag: 'path', attrs: { d: 'M0 0L100 0Z', fill: 'url(#g1)', stroke: 'none' } },
        { tag: 'text', attrs: { fill: 'url(#g1)', x: 1, y: 2 }, text: 'HI' }
      ],
      { makePath: fakePath }
    );
    expect(f.gradients).toHaveLength(2);
    expect(f.gradients[0].at).toEqual([0, 5, 100, 5]);
    expect(f.gradients[0].stops).toEqual([[0, '#ff0000'], [1, 'rgba(0, 0, 255, 0.5)']]);
    const [fill, text] = f.draws();
    expect(fill.state.fillStyle).toBe(f.gradients[0] as unknown as string);
    expect(text.name).toBe('fillText');
    expect(text.state.fillStyle).toBe(f.gradients[1] as unknown as string);
    // The definitions themselves paint nothing.
    expect(f.draws()).toHaveLength(2);
  });

  it('a reference to nothing paints nothing; without createLinearGradient the first stop stands in', () => {
    const f = fakeContext();
    drawSvgNodes(
      f.ctx,
      [
        { tag: 'linearGradient', attrs: { id: 'g', gradientUnits: 'userSpaceOnUse' }, children: [{ tag: 'stop', attrs: { offset: 0, 'stop-color': '#123456' } }] },
        { tag: 'path', attrs: { d: 'A', fill: 'url(#missing)', stroke: 'none' } },
        { tag: 'path', attrs: { d: 'B', fill: 'url(#g)', stroke: 'none' } }
      ],
      { makePath: fakePath }
    );
    expect(f.draws().map((c) => [pathD(c), c.state.fillStyle])).toEqual([['B', '#123456']]);
  });

  it('clip-path clips the element (after its own transform) to the union of the clip shapes, then restores', () => {
    const f = fakeContext();
    drawSvgNodes(
      f.ctx,
      [
        { tag: 'clipPath', attrs: { id: 'c' }, children: [{ tag: 'path', attrs: { d: 'M0 0L10 0L10 10Z' } }, { tag: 'rect', attrs: { x: 20, y: 0, width: 5, height: 5 } }] },
        { tag: 'g', attrs: { 'clip-path': 'url(#c)', transform: 'translate(3 4)' }, children: [{ tag: 'text', attrs: { fill: '#111111', x: 0, y: 0 }, text: 'A' }] },
        { tag: 'text', attrs: { fill: '#111111', x: 0, y: 0 }, text: 'B' }
      ],
      { makePath: fakePath }
    );
    const clips = f.calls.filter((c) => c.name === 'clip');
    expect(clips).toHaveLength(1);
    expect(pathD(clips[0])).toBe('M0 0L10 0L10 10ZM20 0L25 0L25 5L20 5Z');
    expect(clips[0].state.matrix.slice(4)).toEqual([3, 4]);
    const i = f.calls.indexOf(clips[0]);
    const a = f.calls.findIndex((c) => c.name === 'fillText' && c.args[0] === 'A');
    expect(a).toBeGreaterThan(i);
  });
});

describe('SVG / canvas parity for each Pro lettering feature', () => {
  it('gradient fill: one gradient per gradient-filled text draw, matching the SVG stops and end points', () => {
    const plans = styled('pg_1_l4', { fillGradient: { from: '#ff0000', to: '#ffff00', angle: 0 } } as LetterStylePatch);
    const { nodes, f, texts } = parity(plans);
    const grad = find(nodes, (n) => n.tag === 'linearGradient')[0];
    expect(grad.attrs.gradientUnits).toBe('userSpaceOnUse');
    const p = plans[0];
    expect([grad.attrs.x1, grad.attrs.x2]).toEqual([Math.round(p.x * 100) / 100, Math.round((p.x + p.w) * 100) / 100]);
    const gradFills = texts.filter((c) => (c.state.fillStyle as unknown as FakeGradient).kind === 'gradient');
    expect(gradFills.length).toBe(p.runs.length);
    expect(f.gradients[0].stops).toEqual([[0, '#ff0000'], [1, '#ffff00']]);
    expect(f.gradients[0].at).toEqual([grad.attrs.x1, grad.attrs.y1, grad.attrs.x2, grad.attrs.y2]);
  });

  it('stacked strokes: rings drawn outermost first at the summed widths; textStroke superseded', () => {
    const plans = styled('pg_1_l4', { strokes: [{ color: '#000000', w: 0.1 }, { color: '#ff0000', w: 0.05 }], textStroke: { color: '#00ff00', width: 0.2 } } as LetterStylePatch);
    const { texts } = parity(plans);
    const fs = plans[0].fontSize;
    const widths = texts.filter((c) => c.name === 'strokeText').map((c) => Math.round(c.state.lineWidth * 100) / 100);
    expect([...new Set(widths)]).toEqual([Math.round(0.15 * fs * 100) / 100, Math.round(0.1 * fs * 100) / 100]);
    expect(texts.some((c) => c.name === 'strokeText' && c.state.strokeStyle === '#00ff00')).toBe(false);
    // An explicit empty stack draws no outline at all.
    const none = parity(styled('pg_1_l5', { strokes: [] } as LetterStylePatch)).texts;
    expect(none.filter((c) => c.name === 'strokeText')).toHaveLength(0);
  });

  it('glow: four round strokes, widest and faintest first, no filter anywhere', () => {
    const plans = styled('pg_1_l4', { glow: { color: '#ffcc00', size: 0.2 } } as LetterStylePatch);
    const { nodes, texts } = parity(plans);
    expect(find(nodes, (n) => n.tag === 'filter' || n.attrs.filter !== undefined)).toHaveLength(0);
    const glows = texts.filter((c) => c.name === 'strokeText' && c.state.strokeStyle === '#ffcc00');
    const widths = [...new Set(glows.map((c) => c.state.lineWidth))];
    expect(widths).toHaveLength(4);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    const alphas = [...new Set(glows.map((c) => c.state.globalAlpha))];
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
  });

  it('warp: one glyph draw per character, each turned', () => {
    const plans = styled('pg_1_l4', { warp: 'wave', warpAmount: 0.7 } as LetterStylePatch);
    const { texts } = parity(plans);
    const glyphs = plans[0].runs.reduce((n, r) => n + [...r.text].length, 0);
    expect(texts.filter((c) => c.name === 'fillText').length).toBe(glyphs);
    expect(texts.some((c) => Math.abs(c.state.matrix[1]) > 1e-6)).toBe(true);
  });

  it('SFX effects: extrude3d, outline_stack, wobble, shatter, gradient', () => {
    // 3D extrusion: six offset copies behind the face.
    const ex = parity(styled('pg_1_l5', pro({ sfxEffect: 'extrude3d' })));
    const base = parity(styled('pg_1_l5', {})).texts.filter((c) => c.name === 'fillText').length;
    expect(ex.texts.filter((c) => c.name === 'fillText').length).toBe(base - 1 + 6 + 0); // the shadow copy becomes 6 steps
    expect(find(ex.nodes, (n) => n.attrs['data-pro'] === 'extrude')).toHaveLength(6);
    // Outline stack: three rings from the line's outline.
    const os = parity(styled('pg_1_l5', pro({ sfxEffect: 'outline_stack' })));
    expect(new Set(os.texts.filter((c) => c.name === 'strokeText').map((c) => c.state.lineWidth)).size).toBe(3);
    // Wobble: per glyph.
    const wb = styled('pg_1_l5', pro({ sfxEffect: 'wobble' }));
    parity(wb);
    expect(wb[0].runs[0].rotates?.length).toBe([...wb[0].runs[0].text].length);
    // Shatter: two clipped, offset pieces; the canvas clips each with the SVG clip path.
    const sh = parity(styled('pg_1_l5', pro({ sfxEffect: 'shatter' })));
    const clipPaths = find(sh.nodes, (n) => n.tag === 'clipPath').map((c) => c.children![0].attrs.d);
    expect(clipPaths).toHaveLength(2);
    const clips = sh.f.calls.filter((c) => c.name === 'clip').map(pathD);
    expect(clips).toEqual(clipPaths);
    expect(find(sh.nodes, (n) => typeof n.attrs['clip-path'] === 'string')).toHaveLength(2);
    // Gradient: the SFX face filled top to bottom from its colour.
    const gr = parity(styled('pg_1_l5', pro({ sfxEffect: 'gradient' })));
    expect(gr.f.gradients.length).toBeGreaterThan(0);
    expect(find(gr.nodes, (n) => n.tag === 'linearGradient')[0].attrs.x1).toBe(find(gr.nodes, (n) => n.tag === 'linearGradient')[0].attrs.x2);
  });

  it('every Pro shape: the same outline paths on both renderers', () => {
    for (const shape of PRO_BUBBLE_SHAPES) {
      const plans = styled('pg_1_l4', pro({ shape }));
      expect(plans[0].style.shape).toBe(shape);
      const { f } = parity(plans);
      const body = plans[0].geometry.body!;
      expect(f.calls.some((c) => c.name === 'fill' && pathD(c) === body), shape).toBe(true);
      expect(f.calls.some((c) => c.name === 'stroke' && pathD(c) === body), shape).toBe(true);
      if (plans[0].geometry.inner) expect(f.calls.some((c) => c.name === 'stroke' && pathD(c) === plans[0].geometry.inner), shape).toBe(true);
    }
  });

  it('rotation and minimum height: the body is drawn turned, and taller, on both', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, rot: 30, minH: 0.25 } : b));
    });
    const plans = plansOf(doc).filter((p) => p.lineId === 'pg_1_l3');
    const { nodes, f } = parity(plans);
    expect(find(nodes, (n) => String(n.attrs.transform || '').startsWith('rotate(30 '))).not.toHaveLength(0);
    const bodyFill = f.calls.find((c) => c.name === 'fill' && pathD(c) === plans[0].geometry.body)!;
    expect(bodyFill.state.matrix[1]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    const text = f.calls.find((c) => c.name === 'fillText')!;
    expect(text.state.matrix[1]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(plans[0].geometry.bounds.h).toBeGreaterThanOrEqual(0.25 * 1500 - 0.05);
  });

  describe('gradient text on per-glyph runs: each glyph takes the colour SVG gives it there', () => {
    type M = number[];
    const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    const invert = (m: M): M => {
      const det = m[0] * m[3] - m[1] * m[2];
      return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    };
    const about = (cx: number, cy: number, inner: M): M => mul(mul([1, 0, 0, 1, cx, cy], inner), [1, 0, 0, 1, -cx, -cy]);
    /** The text element's user space on the page: the balloon's turn, then the italic / SFX skew (svgMarkup texts()). */
    const textSpace = (p: LetterPlan): M => {
      const t = p.transform;
      if (!t) return [1, 0, 0, 1, 0, 0];
      const r = ((t.rotate || 0) * Math.PI) / 180;
      const rot = about(t.cx, t.cy, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
      const skew = about(t.cx, t.cy, [1, 0, Math.tan(((t.skewX || 0) * Math.PI) / 180), 1, 0, 0]);
      return mul(rot, skew);
    };
    /** The gradient parameter t of a point (pad spread: clamped), for the line x1 y1 → x2 y2. */
    const tAt = (q: { x: number; y: number }, at: number[]) => {
      const vx = at[2] - at[0];
      const vy = at[3] - at[1];
      return Math.min(1, Math.max(0, ((q.x - at[0]) * vx + (q.y - at[1]) * vy) / (vx * vx + vy * vy)));
    };
    /**
     * Every gradient-filled glyph draw on the canvas, checked at points of its own frame mapped back through the recorded
     * transform: the canvas's t equals SVG's (the userSpaceOnUse line across the text box, in the text element's user
     * space). Returns the t of each glyph's middle, so a caller can see the glyphs are not all one end stop.
     */
    const glyphTs = (plans: LetterPlan[]): number[] => {
      const p = plans[0];
      const { nodes, texts } = parity(plans);
      const grad = find(nodes, (n) => n.tag === 'linearGradient' && n.attrs.id === 'ex0-t0-0-grad')[0];
      expect(grad).toBeDefined();
      const line = [grad.attrs.x1, grad.attrs.y1, grad.attrs.x2, grad.attrs.y2].map(Number);
      const toText = invert(mul([1, 0, 0, 1, 0, 0], textSpace(p)));
      const fills = texts.filter((c) => c.name === 'fillText' && (c.state.fillStyle as unknown as FakeGradient).kind === 'gradient');
      const glyphs = p.runs.reduce((n, r) => n + [...r.text].length, 0);
      expect(fills.length).toBe(glyphs);
      const fs = p.fontSize;
      return fills.map((c) => {
        const at = (c.state.fillStyle as unknown as FakeGradient).at;
        const x = Number(c.args[1]);
        const y = Number(c.args[2]);
        let mid = 0;
        for (const [dx, dy] of [[0, 0], [0.3 * fs, -0.35 * fs], [0.6 * fs, -0.7 * fs], [-0.2 * fs, 0.1 * fs]]) {
          const local = { x: x + dx, y: y + dy };
          const device = apply(c.state.matrix, local.x, local.y);
          const inText = apply(toText, device.x, device.y);
          const want = tAt(inText, line);
          expect(Math.abs(tAt(local, at) - want), `${c.args[0]} at ${dx},${dy}`).toBeLessThan(0.01);
          if (dx === 0.3 * fs) mid = want;
        }
        return mid;
      });
    };
    const spread = (ts: number[]) => Math.max(...ts) - Math.min(...ts);
    const grad = (angle: number) => ({ from: '#ff0000', to: '#0000ff', angle });

    it('fillGradient with every warp (arc, wave, rise, flag turn each glyph; bulge scales it)', () => {
      for (const warp of ['arc', 'wave', 'rise', 'flag', 'bulge']) {
        const plans = styled('pg_1_l4', pro({ fillGradient: grad(0), warp, warpAmount: 0.6 }));
        expect(plans[0].runs.some((r) => r.rotates?.some((d) => d !== 0) || r.scales?.length), warp).toBe(true);
        expect(spread(glyphTs(plans)), warp).toBeGreaterThan(0.3);
      }
      // A vertical gradient on an arc (the review's probe) and on a bulge.
      glyphTs(styled('pg_1_l4', pro({ fillGradient: grad(90), warp: 'arc', warpAmount: 0.6 })));
      glyphTs(styled('pg_1_l4', pro({ fillGradient: grad(90), warp: 'bulge', warpAmount: 0.8 })));
      // An angled one on a wave.
      expect(spread(glyphTs(styled('pg_1_l4', pro({ fillGradient: grad(35), warp: 'wave', warpAmount: 0.8 }))))).toBeGreaterThan(0.2);
    });

    it('SFX: a gradient on wobble, arched and pop glyphs, and the SFX gradient effect on warped glyphs', () => {
      expect(spread(glyphTs(styled('pg_1_l5', pro({ fillGradient: grad(0), sfxEffect: 'wobble' }))))).toBeGreaterThan(0.15);
      expect(spread(glyphTs(styled('pg_1_l5', pro({ fillGradient: grad(0), sfxEffect: 'arched', arc: 0.5 }))))).toBeGreaterThan(0.15);
      expect(spread(glyphTs(styled('pg_1_l5', pro({ fillGradient: grad(0), sfxEffect: 'pop' }))))).toBeGreaterThan(0.15);
      // The SFX 'gradient' effect runs top to bottom, so on a wave each glyph sits at its own height in it.
      for (const warp of ['wave', 'bulge', 'arc']) glyphTs(styled('pg_1_l5', pro({ sfxEffect: 'gradient', warp, warpAmount: 0.9 })));
      expect(spread(glyphTs(styled('pg_1_l5', pro({ sfxEffect: 'gradient', warp: 'wave', warpAmount: 1 }))))).toBeGreaterThan(0.05);
    });
  });

  it('a turned linked pair (the head’s rot): one neck, centre to centre, joining both turned bodies, on both renderers', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, rot: 30 } : b.lineId === 'pg_1_l3' ? { ...b, linkTo: 'pg_1_l2' } : b));
    });
    const plans = plansOf(doc).filter((p) => p.lineId === 'pg_1_l2' || p.lineId === 'pg_1_l3');
    expect(plans.map((p) => p.transform?.rotate)).toEqual([30, 30]);
    const { nodes, f } = parity(plans);
    const group = find(nodes, (n) => n.attrs['data-link-group'] !== undefined);
    expect(group).toHaveLength(1);
    // The neck is drawn outside the members' turned groups (its fat stroke, then its fill over the body edges): one path.
    const necks = (group[0].children || []).filter((n) => n.tag === 'path');
    expect(necks.length).toBeGreaterThan(0);
    const ds = [...new Set(necks.map((n) => String(n.attrs.d)))];
    expect(ds).toHaveLength(1);
    // Its two ends are the members' turn centres, which a turn about that centre never moves: it reaches into both bodies.
    const v = (ds[0].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const ends = [{ x: (v[0] + v[11]) / 2, y: (v[1] + v[12]) / 2 }, { x: (v[2] + v[9]) / 2, y: (v[3] + v[10]) / 2 }];
    const byId = new Map(plans.map((p) => [p.lineId, p]));
    for (const [end, id] of [[ends[0], 'pg_1_l3'], [ends[1], 'pg_1_l2']] as const) {
      const t = byId.get(id)!.transform!;
      expect(end.x, id).toBeCloseTo(t.cx, 1);
      expect(end.y, id).toBeCloseTo(t.cy, 1);
    }
    // The canvas fills and strokes that same neck, untransformed (page space), as SVG does.
    const neckDraws = f.calls.filter((c) => (c.name === 'fill' || c.name === 'stroke') && pathD(c) === ds[0]);
    expect(neckDraws.length).toBeGreaterThanOrEqual(2);
    for (const c of neckDraws) expect(c.state.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('a Pro look on the page: every line draws in parity (robot: radio balloons, lightning tails, outline stack)', () => {
    const plans = plansOf(makeSampleDoc((d) => (d.letterStyle = { presetId: 'robot' as never })));
    expect(plans.some((p) => p.style.shape === ('radio' as never))).toBe(true);
    parity(plans);
  });
});
