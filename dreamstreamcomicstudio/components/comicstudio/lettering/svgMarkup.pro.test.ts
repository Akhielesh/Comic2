// PE-LETTER svgMarkup: the Pro text styling draws as plain SVG (gradients and clip paths in a <defs> per balloon, glow as
// strokes, never a filter), ids never collide on a page, the print string and the board's React tree carry the same
// attributes, and a plan without Pro styling draws exactly as before (letterGolden.test.ts pins every QA fixture).

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure, letteringAspect, planLettering, type LetterPlan } from '../../../shared/comic/lettering/layout';
import type { LetterStylePatch } from '../../../shared/comic/lettering/style';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { LetteringSvg } from './LetteringSvg';
import { letteringNodes, letteringSvgMarkup, nodesToMarkup, type SvgNode } from './svgMarkup';

const ASPECT = 2 / 3;
/** A patch carrying a Pro id (the base unions stay narrow until the fold, collisions B-4). */
const pro = (p: Record<string, unknown>): LetterStylePatch => p as unknown as LetterStylePatch;
const plansOf = (doc: ComicDoc): LetterPlan[] => planLettering(doc, doc.pages[0], letteringAspect(doc, doc.pages[0]), estimateMeasure);
const all = (nodes: SvgNode[]): SvgNode[] => nodes.flatMap((n) => [n, ...all(n.children || [])]);
const styledDoc = (styles: Record<string, LetterStylePatch>) =>
  makeSampleDoc((d) => {
    for (const panel of d.pages[0].panels) for (const l of panel.lines) if (styles[l.id]) l.style = styles[l.id];
  });

const GRADIENT = { fillGradient: { from: '#ff0000', to: '#0000ff', angle: 90 } } as LetterStylePatch;

describe('Pro text styling in the SVG tree', () => {
  it('gradients and shatter clips get ids unique on the page, referenced from inside the same balloon', () => {
    const plans = plansOf(styledDoc({ pg_1_l1: GRADIENT, pg_1_l2: GRADIENT, pg_1_l4: GRADIENT, pg_1_l5: pro({ sfxEffect: 'shatter' }) }));
    const nodes = letteringNodes(plans, { aspect: ASPECT, idPrefix: 'pg' });
    const ids = all(nodes).map((n) => n.attrs.id).filter((v): v is string => typeof v === 'string');
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(new Set(ids).size).toBe(ids.length);
    for (const balloon of nodes.flatMap((n) => all([n]).filter((x) => x.attrs['data-testid'] === 'balloon'))) {
      const own = new Set(all([balloon]).map((n) => n.attrs.id).filter(Boolean));
      for (const n of all([balloon])) {
        for (const ref of [n.attrs.fill, n.attrs['clip-path']]) {
          const m = /^url\(#(.+)\)$/.exec(String(ref ?? ''));
          if (m) expect(own.has(m[1]), m[1]).toBe(true);
        }
      }
    }
    // Two pages on one screen: a different prefix, different ids.
    const other = all(letteringNodes(plans, { aspect: ASPECT, idPrefix: 'pg2' })).map((n) => n.attrs.id).filter(Boolean);
    expect(other.some((id) => ids.includes(id as string))).toBe(false);
  });

  it('the print string and the board’s React tree carry the gradient, stops and clip paths', () => {
    const plans = plansOf(styledDoc({ pg_1_l4: GRADIENT, pg_1_l5: pro({ sfxEffect: 'shatter' }) }));
    const markup = letteringSvgMarkup(plans, { aspect: ASPECT, idPrefix: 'p' });
    expect(markup).toContain('<linearGradient id="p-t');
    expect(markup).toContain('gradientUnits="userSpaceOnUse"');
    expect(markup).toContain('stop-color="#ff0000"');
    expect(markup).toMatch(/<clipPath id="p-t[^"]+-clip-a"><path d="M/);
    expect(markup).toMatch(/clip-path="url\(#p-t[^"]+-clip-a\)"/);
    const react = renderToStaticMarkup(React.createElement(LetteringSvg, { plans, aspect: ASPECT }));
    expect(react).toContain('<linearGradient');
    expect(react).toContain('stop-color="#ff0000"');
    expect(react).toMatch(/clip-path="url\(#ls[^"]+-clip-a\)"/);
    expect(react).toMatch(/fill="url\(#ls[^"]+-grad\)"/);
  });

  it('glow is strokes (no <filter> anywhere); strokes supersede textStroke; a plain plan has no <defs> and no data-pro', () => {
    const plans = plansOf(styledDoc({ pg_1_l4: { glow: { color: '#ffcc00', size: 0.2 }, strokes: [{ color: '#000000', w: 0.1 }] } as LetterStylePatch }));
    const nodes = letteringNodes(plans, { aspect: ASPECT });
    const tree = all(nodes);
    expect(tree.filter((n) => n.tag === 'filter' || n.attrs.filter !== undefined)).toHaveLength(0);
    expect(tree.filter((n) => n.attrs['data-pro'] === 'glow')).toHaveLength(4);
    expect(tree.filter((n) => n.attrs['data-pro'] === 'stroke')).toHaveLength(1);
    const plain = all(letteringNodes(plansOf(makeSampleDoc()), { aspect: ASPECT }));
    expect(plain.some((n) => n.tag === 'defs' || n.attrs['data-pro'] !== undefined)).toBe(false);
  });

  it('a stored glow or stroke past the write bound draws at the bound (the load keeps any finite number)', () => {
    const big = plansOf(styledDoc({ pg_1_l4: { glow: { color: '#ffcc00', size: 9 }, strokes: [{ color: '#000000', w: 5 }] } as LetterStylePatch }));
    const capped = plansOf(styledDoc({ pg_1_l4: { glow: { color: '#ffcc00', size: 0.5 }, strokes: [{ color: '#000000', w: 0.3 }] } as LetterStylePatch }));
    const text = (p: LetterPlan[]) => nodesToMarkup(letteringNodes(p.filter((x) => x.lineId === 'pg_1_l4'), { aspect: ASPECT }));
    expect(text(big)).toBe(text(capped));
  });

  it('user text in a Pro-styled balloon is escaped like any other', () => {
    const doc = styledDoc({ pg_1_l4: { ...GRADIENT, glow: { color: '#ffffff', size: 0.1 } } as LetterStylePatch });
    doc.pages[0].panels[2].lines[1].text = '<script>alert(1)</script> & co';
    const markup = letteringSvgMarkup(plansOf(doc), { aspect: ASPECT });
    expect(markup).not.toContain('<script');
    expect(markup).toContain('&lt;SCRIPT&gt;');
  });
});
