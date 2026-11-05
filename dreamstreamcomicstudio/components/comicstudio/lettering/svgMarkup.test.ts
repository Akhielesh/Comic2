import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { balloonShape, dashArray, hashSeed, tailTipOf } from '../board/balloonGeometry';
import { estimateMeasure, planLettering, type LetterPlan } from '../../../shared/comic/lettering/layout';
import { letteringNodes, letteringSvgMarkup, nodesToMarkup, paintOf, planOutline, strokeFor, type SvgNode } from './svgMarkup';

const ASPECT = 2 / 3;
const plansFor = (mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  return { doc, plans: planLettering(doc, doc.pages[0], ASPECT, estimateMeasure) };
};
const find = (nodes: SvgNode[], pred: (n: SvgNode) => boolean): SvgNode[] => {
  const out: SvgNode[] = [];
  const walk = (n: SvgNode) => {
    if (pred(n)) out.push(n);
    (n.children || []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
};
const group = (nodes: SvgNode[], id: string) => find(nodes, (n) => n.attrs['data-line-id'] === id)[0];

describe('paintOf', () => {
  it('splits #rrggbbaa into colour + opacity; none/invalid paint nothing', () => {
    expect(paintOf('#FFFFFF')).toEqual({ color: '#ffffff', opacity: 1 });
    expect(paintOf('#11111180')).toEqual({ color: '#111111', opacity: 0.502 });
    expect(paintOf('none')).toBeNull();
    expect(paintOf('red; fill: url(javascript:x)')).toBeNull();
  });
});

describe('classic parity with the pre-v5 board', () => {
  it('draws the same outline and tail path strings the old balloonShape produced, in the old order', () => {
    const { plans } = plansFor();
    const plan = plans.find((p) => p.lineId === 'pg_1_l2')!; // whisper with an explicit tail
    const nodes = letteringNodes([plan], { aspect: ASPECT });
    const paths = find(nodes, (n) => n.tag === 'path');
    const tipLocal = { x: 0.2 * 1000 - plan.x, y: 0.7 * (1000 / ASPECT) - plan.y };
    const old = balloonShape('whisper', plan.w, plan.h, { tip: tipLocal, seed: hashSeed('pg_1_l2'), inset: plan.pad });
    expect(paths.map((p) => p.attrs.d)).toEqual([old.tail, old.body, old.tail]);
    // tail fat stroke (2×, dashed) under, body 1× dashed, tail fill over the join
    expect(paths[0].attrs['stroke-width']).toBe(2 * plan.stroke);
    expect(paths[0].attrs['stroke-dasharray']).toBe(dashArray(plan.stroke));
    expect(paths[1].attrs['stroke-width']).toBe(plan.stroke);
    expect(paths[2].attrs.stroke).toBe('none');
    expect(tailTipOf({ lineId: 'pg_1_l2', x: 0.06, y: 0.5, w: 0.22, tailX: 0.2, tailY: 0.7 }, 'whisper', 0.05)).toEqual({ tailX: 0.2, tailY: 0.7 });
  });

  it('SFX: classic tilt, palette colour, 0.12 em outline under the fill and a 0.05 em shadow copy', () => {
    const { plans } = plansFor();
    const plan = plans.find((p) => p.lineId === 'pg_1_l5')!;
    const g = group(letteringNodes([plan], { aspect: ASPECT }), 'pg_1_l5');
    const texts = find([g], (n) => n.tag === 'text');
    const main = texts.find((t) => t.attrs['paint-order'] === 'stroke')!;
    expect(main.attrs['stroke-width']).toBeCloseTo(0.12 * plan.fontSize, 2);
    expect(main.attrs.fill).toBe(plan.style.textColor);
    const shadow = find([g], (n) => typeof n.attrs.transform === 'string' && (n.attrs.transform as string).startsWith('translate('))[0];
    expect(shadow).toBeTruthy();
    if (plan.transform?.rotate) expect(find([g], (n) => String(n.attrs.transform || '').startsWith('rotate('))).not.toHaveLength(0);
  });
});

describe('fill opacity and transparent bubbles', () => {
  it('translucent fills draw masked fat strokes then one fill layer at the fill alpha', () => {
    const { plans } = plansFor((d) => (d.pages[0].panels[2].lines[1].style = { fill: '#ffffff80' }));
    const nodes = letteringNodes(plans, { aspect: ASPECT, idPrefix: 't' });
    const g = group(nodes, 'pg_1_l4');
    const mask = find([g], (n) => n.tag === 'mask')[0];
    expect(mask).toBeTruthy();
    const masked = find([g], (n) => n.attrs.mask === `url(#${mask.attrs.id})`)[0];
    expect(find([masked], (n) => n.tag === 'path').every((p) => p.attrs.fill === 'none')).toBe(true);
    const fillLayer = find([g], (n) => n.attrs.opacity === 0.502)[0];
    expect(find([fillLayer], (n) => n.tag === 'path').every((p) => p.attrs.fill === '#ffffff' && p.attrs.stroke === 'none')).toBe(true);
  });

  it('a transparent bubble keeps only its outline (no fill layer)', () => {
    const { plans } = plansFor((d) => (d.pages[0].panels[2].lines[1].style = { fill: 'none' }));
    const g = group(letteringNodes(plans, { aspect: ASPECT }), 'pg_1_l4');
    expect(find([g], (n) => n.tag === 'mask')).toHaveLength(1);
    expect(find([g], (n) => n.tag === 'path' && n.attrs.fill !== 'none' && n.attrs.fill !== '#000000')).toHaveLength(0);
  });

  it('borderStyle none / borderWidth 0 draw no strokes', () => {
    const { plans } = plansFor((d) => (d.pages[0].panels[2].lines[1].style = { borderStyle: 'none' }));
    const plan = plans.find((p) => p.lineId === 'pg_1_l4')!;
    expect(strokeFor(plan, 600)).toBe(0);
    const g = group(letteringNodes([plan], { aspect: ASPECT }), 'pg_1_l4');
    expect(find([g], (n) => n.tag === 'path' && !!n.attrs.stroke && n.attrs.stroke !== 'none')).toHaveLength(0);
  });
});

describe('screen and print draw the same numbers', () => {
  it('the string renderer serializes exactly the React nodes (same paths, same text positions)', () => {
    const { plans } = plansFor();
    const nodes = letteringNodes(plans, { aspect: ASPECT, widthPx: 600, idPrefix: 'p' });
    const markup = letteringSvgMarkup(plans, { aspect: ASPECT, widthPx: 600, idPrefix: 'p' });
    expect(markup).toContain(nodesToMarkup(nodes));
    for (const p of find(nodes, (n) => n.tag === 'path')) expect(markup).toContain(`d="${p.attrs.d}"`);
    for (const t of find(nodes, (n) => n.tag === 'text' && n.attrs.x !== undefined)) expect(markup).toContain(`x="${t.attrs.x}"`);
    expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1500"')).toBe(true);
  });

  it('escapes user text and drops unsafe attribute names', () => {
    const { plans } = plansFor((d) => (d.pages[0].panels[2].lines[1].text = '<img src=x onerror=alert(1)> & "quotes"'));
    const markup = letteringSvgMarkup(plans, { aspect: ASPECT });
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;IMG');
    expect(markup).toContain('&amp;');
    expect(markup).toContain('&quot;QUOTES&quot;');
    expect(nodesToMarkup([{ tag: 'g', attrs: { onclick: 'x()', 'bad attr': 1, ok: 'a"b' } }])).toBe('<g ok="a&quot;b"></g>');
    expect(nodesToMarkup([{ tag: 'script>', attrs: {} }])).toBe('');
  });

  it('outline helper matches the plan geometry', () => {
    const { plans } = plansFor();
    const p = plans[0] as LetterPlan;
    expect(planOutline(p)).toEqual({ x: p.x + p.geometry.bounds.x, y: p.y + p.geometry.bounds.y, w: p.geometry.bounds.w, h: p.geometry.bounds.h });
  });
});

describe('linked balloons', () => {
  it('draw a neck (fat stroke under, fill over) inside one link group', () => {
    const { plans } = plansFor((d) => {
      d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.55, y: 0.62, w: 0.3, pinned: true, linkTo: 'pg_1_l3' });
      d.pages[0].panels[2].lines[0].kind = 'speech';
    });
    const nodes = letteringNodes(plans, { aspect: ASPECT });
    const linkGroup = find(nodes, (n) => typeof n.attrs['data-link-group'] === 'string')[0];
    expect(linkGroup).toBeTruthy();
    expect(String(linkGroup.attrs['data-link-group']).split(' ').sort()).toEqual(['pg_1_l3', 'pg_1_l4']);
    expect(find([linkGroup], (n) => n.attrs['data-testid'] === 'balloon')).toHaveLength(2);
  });
});
