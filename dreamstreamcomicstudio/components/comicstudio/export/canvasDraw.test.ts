import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, planLettering, type LetterPlan } from '../../../shared/comic/lettering/layout';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import type { SvgNode } from '../lettering/svgMarkup';
import { fakeContext, fakeLayers, fakePath } from './__fixtures__/fakeCanvas';
import { applySvgTransform, drawLetterPlan, drawLetteringOnPage, drawSvgNodes, groupBounds, letterGroups } from './canvasDraw';

const plansOf = (doc: ComicDoc, i = 0): LetterPlan[] => planLettering(doc, doc.pages[i], letteringAspect(doc, doc.pages[i]), estimateMeasure);
const pathD = (c: { args: unknown[] }) => (c.args[0] as { d?: string } | undefined)?.d;

describe('applySvgTransform', () => {
  it('composes translate, rotate about a point, scale, skew and matrix left to right', () => {
    const { ctx } = fakeContext();
    applySvgTransform(ctx, 'translate(10 20) scale(2)');
    expect(ctx.getTransform()).toMatchObject({ a: 2, d: 2, e: 10, f: 20 });
    const r = fakeContext();
    applySvgTransform(r.ctx, 'rotate(90 50 50)');
    const m = r.ctx.getTransform();
    // (100, 50) rotated 90° about (50, 50) → (50, 100)
    expect(m.a * 100 + m.c * 50 + m.e).toBeCloseTo(50, 6);
    expect(m.b * 100 + m.d * 50 + m.f).toBeCloseTo(100, 6);
    const s = fakeContext();
    applySvgTransform(s.ctx, 'skewX(45) matrix(1 0 0 1 3 4)');
    expect(s.ctx.getTransform().c).toBeCloseTo(1, 6);
    expect(s.ctx.getTransform().e).toBeCloseTo(3 + 4, 6);
  });
});

describe('drawSvgNodes', () => {
  it('fills then strokes a path with its width, dashes and opacity', () => {
    const f = fakeContext();
    const nodes: SvgNode[] = [{ tag: 'path', attrs: { d: 'M0 0 L10 0 Z', fill: '#ffffff', stroke: '#111111', 'stroke-width': 3, 'stroke-dasharray': '4 2', 'stroke-opacity': 0.5 } }];
    drawSvgNodes(f.ctx, nodes, { makePath: fakePath });
    const [fill, stroke] = f.draws();
    expect(fill.name).toBe('fill');
    expect(fill.state.fillStyle).toBe('#ffffff');
    expect(stroke.name).toBe('stroke');
    expect(stroke.state).toMatchObject({ strokeStyle: '#111111', lineWidth: 3, dash: [4, 2], globalAlpha: 0.5 });
    expect(pathD(stroke)).toBe('M0 0 L10 0 Z');
  });

  it('draws text with paint-order stroke, SVG anchors and the text direction', () => {
    const f = fakeContext();
    drawSvgNodes(f.ctx, [
      {
        tag: 'text',
        attrs: { 'font-family': '"Noto Nastaliq Urdu", serif', 'font-size': 20, 'font-weight': 700, 'text-anchor': 'middle', direction: 'rtl', fill: '#ffffff', stroke: '#000000', 'stroke-width': 2, 'paint-order': 'stroke', x: 100, y: 50 },
        text: 'سلام'
      }
    ]);
    const texts = f.calls.filter((c) => c.name === 'fillText' || c.name === 'strokeText');
    expect(texts.map((c) => c.name)).toEqual(['strokeText', 'fillText']);
    expect(texts[1].args).toEqual(['سلام', 100, 50]);
    expect(texts[1].state).toMatchObject({ textAlign: 'center', direction: 'rtl', font: '700 20px "Noto Nastaliq Urdu", serif' });
  });

  it('draws glyph runs one glyph at a time, rotated in place', () => {
    const f = fakeContext();
    drawSvgNodes(f.ctx, [
      {
        tag: 'text',
        attrs: { 'text-anchor': 'start', fill: '#e63946' },
        children: [
          { tag: 'tspan', attrs: { x: 10, y: 20 }, text: 'B' },
          { tag: 'tspan', attrs: { x: 30, y: 22, rotate: 90 }, text: 'A' }
        ]
      }
    ]);
    const fills = f.calls.filter((c) => c.name === 'fillText');
    expect(fills[0].args).toEqual(['B', 10, 20]);
    expect(fills[1].args).toEqual(['A', 0, 0]);
    expect(fills[1].state.matrix[4]).toBeCloseTo(30, 6);
    expect(fills[1].state.matrix[1]).toBeCloseTo(1, 6); // rotated 90°
  });

  it('composites a translucent group once through a layer (no double alpha where members overlap)', () => {
    const f = fakeContext(400, 400);
    const layers = fakeLayers();
    drawSvgNodes(
      f.ctx,
      [{ tag: 'g', attrs: { opacity: 0.5 }, children: [{ tag: 'path', attrs: { d: 'M0 0', fill: '#ffffff', stroke: 'none' } }, { tag: 'circle', attrs: { cx: 5, cy: 5, r: 3, fill: '#ffffff', stroke: 'none' } }] }],
      { makePath: fakePath, createLayer: layers.createLayer, layerBounds: { x: 0, y: 0, w: 100, h: 100 } }
    );
    expect(layers.made).toHaveLength(1);
    const inLayer = layers.made[0].draws().filter((c) => c.name === 'fill');
    expect(inLayer).toHaveLength(2);
    expect(inLayer.every((c) => c.state.globalAlpha === 1)).toBe(true);
    const composite = f.draws().filter((c) => c.name === 'drawImage');
    expect(composite).toHaveLength(1);
    expect(composite[0].state.globalAlpha).toBe(0.5);
    // The layer covers only the group's bounds (+ a 2 px margin), not the whole page.
    expect(composite[0].args.slice(5)).toEqual([0, 0, 102, 102]);
  });

  it('applies a mask by cutting its black shapes out of the layer (destination-out)', () => {
    const f = fakeContext(300, 300);
    const layers = fakeLayers();
    drawSvgNodes(
      f.ctx,
      [
        { tag: 'mask', attrs: { id: 'm1' }, children: [{ tag: 'rect', attrs: { x: -5000, y: -5000, width: 11000, height: 11000, fill: '#ffffff' } }, { tag: 'path', attrs: { d: 'BODY', fill: '#000000', stroke: 'none' } }] },
        { tag: 'g', attrs: { mask: 'url(#m1)' }, children: [{ tag: 'path', attrs: { d: 'BODY', fill: 'none', stroke: '#111111', 'stroke-width': 6 } }] }
      ],
      { makePath: fakePath, createLayer: layers.createLayer }
    );
    const layerDraws = layers.made[0].draws();
    expect(layerDraws.map((c) => c.name)).toEqual(['stroke', 'fill']);
    expect(layerDraws[1].state.globalCompositeOperation).toBe('destination-out');
    expect(f.draws().map((c) => c.name)).toEqual(['drawImage']);
  });

  it('skips hidden groups and never paints the mask definition itself', () => {
    const f = fakeContext();
    drawSvgNodes(f.ctx, [
      { tag: 'g', attrs: { opacity: 0 }, children: [{ tag: 'path', attrs: { d: 'X', fill: '#000' } }] },
      { tag: 'mask', attrs: { id: 'x' }, children: [{ tag: 'path', attrs: { d: 'Y', fill: '#000' } }] },
      { tag: 'title', attrs: {}, text: 'hello' }
    ], { makePath: fakePath });
    expect(f.draws()).toHaveLength(0);
  });
});

describe('drawLetterPlan (the board’s drawing on a canvas)', () => {
  it('draws every lettered line, fat tail strokes under the body, tail fills over it, text last', () => {
    const doc = makeSampleDoc();
    const plans = plansOf(doc);
    expect(plans.length).toBe(5);
    const f = fakeContext(1000, 1500);
    drawLetterPlan(f.ctx, plans, { aspect: 2 / 3, widthPx: 1000, makePath: fakePath, createLayer: fakeLayers().createLayer });
    const texts = f.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    for (const p of plans) for (const run of p.runs) expect(texts).toContain(run.text);

    const speech = plans.find((p) => p.lineId === 'pg_1_l4')!;
    expect(speech.geometry.tail).toBeTruthy();
    const calls = f.calls.filter((c) => (c.name === 'fill' || c.name === 'stroke') && (pathD(c) === speech.geometry.tail || pathD(c) === speech.geometry.body));
    const fatTail = calls.findIndex((c) => c.name === 'stroke' && pathD(c) === speech.geometry.tail);
    const bodyFill = calls.findIndex((c) => c.name === 'fill' && pathD(c) === speech.geometry.body);
    const tailFillOver = calls.findIndex((c, i) => i > bodyFill && c.name === 'fill' && pathD(c) === speech.geometry.tail);
    expect(fatTail).toBeGreaterThanOrEqual(0);
    expect(bodyFill).toBeGreaterThan(fatTail);
    expect(tailFillOver).toBeGreaterThan(bodyFill);
    const bodyStroke = calls.find((c) => c.name === 'stroke' && pathD(c) === speech.geometry.body)!;
    expect(calls[fatTail].state.lineWidth).toBeCloseTo(bodyStroke.state.lineWidth * 2, 5);
    // Text of that balloon comes after its art.
    const lastArt = f.calls.lastIndexOf(calls[tailFillOver]);
    const firstText = f.calls.findIndex((c) => c.name === 'fillText' && c.args[0] === speech.runs[0].text);
    expect(firstText).toBeGreaterThan(lastArt);
  });

  it('draws a whisper with dashes from the border style', () => {
    const doc = makeSampleDoc();
    const plans = plansOf(doc).filter((p) => p.kind === 'whisper');
    const f = fakeContext(1000, 1500);
    drawLetterPlan(f.ctx, plans, { aspect: 2 / 3, widthPx: 1000, makePath: fakePath });
    expect(f.calls.some((c) => c.name === 'stroke' && c.state.dash.length > 0)).toBe(true);
  });

  it('masks the strokes of a translucent balloon so nothing shows through the fill', () => {
    const doc = makeSampleDoc((d) => {
      d.letterStyle = { presetId: 'classic', base: { fill: '#ffffff80' } };
    });
    const plans = plansOf(doc).filter((p) => p.kind === 'speech');
    const f = fakeContext(1000, 1500);
    const layers = fakeLayers();
    drawLetterPlan(f.ctx, plans, { aspect: 2 / 3, widthPx: 1000, makePath: fakePath, createLayer: layers.createLayer });
    const cuts = layers.made.flatMap((l) => l.calls).filter((c) => c.state.globalCompositeOperation === 'destination-out' && c.name === 'fill');
    expect(cuts.length).toBeGreaterThan(0);
    const composites = f.calls.filter((c) => c.name === 'drawImage');
    expect(composites.length).toBeGreaterThanOrEqual(2); // masked strokes + the fill layer at its alpha
    expect(composites.some((c) => Math.abs(c.state.globalAlpha - 128 / 255) < 0.01)).toBe(true);
  });

  it('letters an Urdu edition right to left', () => {
    const doc = makeSampleDoc((d) => {
      d.format.language = 'ur';
      d.pages[0].panels[2].lines[1].text = 'تم مجھے وضاحت دینے کے پابند ہو';
    });
    const plans = plansOf(doc).filter((p) => p.lineId === 'pg_1_l4');
    expect(plans[0].dir).toBe('rtl');
    const f = fakeContext(1000, 1500);
    drawLetterPlan(f.ctx, plans, { aspect: 2 / 3, widthPx: 1000, makePath: fakePath });
    const texts = f.calls.filter((c) => c.name === 'fillText');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((c) => c.state.direction === 'rtl')).toBe(true);
  });

  it('scales plan units to the page box', () => {
    const doc = makeSampleDoc();
    const f = fakeContext(2000, 3000);
    drawLetteringOnPage(f.ctx, plansOf(doc).slice(0, 1), { x: 0, y: 0, width: 2000, height: 3000 }, { makePath: fakePath });
    const first = f.calls.find((c) => c.name === 'fillText')!;
    expect(first.state.matrix[0]).toBeCloseTo(2, 6);
  });
});

describe('groups and bounds', () => {
  it('draws a linked chain as one group, where its last member sits', () => {
    const plans = plansOf(makeSampleDoc());
    const linked = plans.map((p, i) => (i === 3 ? { ...p, linkTo: plans[0].lineId } : p));
    const groups = letterGroups(linked);
    expect(groups.length).toBe(plans.length - 1);
    const chain = groups.find((g) => g.length === 2)!;
    expect(chain.map((p) => p.lineId).sort()).toEqual([plans[0].lineId, plans[3].lineId].sort());
    expect(groups.indexOf(chain)).toBe(2); // after the groups of plans 1 and 2
  });

  it('bounds cover the outline, the text and the tail tip', () => {
    const speech = plansOf(makeSampleDoc()).find((p) => p.lineId === 'pg_1_l2')!;
    const b = groupBounds([speech]);
    expect(speech.tip).toBeTruthy();
    expect(b.x).toBeLessThanOrEqual(speech.x);
    expect(b.y).toBeLessThanOrEqual(speech.y);
    expect(b.x + b.w).toBeGreaterThanOrEqual(Math.max(speech.x + speech.w, speech.tip!.x));
    expect(b.y + b.h).toBeGreaterThanOrEqual(Math.max(speech.y + speech.h, speech.tip!.y));
  });
});
