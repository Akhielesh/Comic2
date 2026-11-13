// PageWireframe draws the frames when the page is shown in them (PE-COMPOSE, pro plan B1 "frames when present"); a
// page without frames draws exactly what it drew before.

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { framesShown } from '../../../shared/comic/editor/scene';
import { framedDoc } from '../compose/__fixtures__/composeDocs';
import { makeQaDoc } from '../testing/qaFixtures';
import { PageWireframe, wireframeFramesOf } from './PageWireframe';

const panels = [
  { n: 1, box: { x: 0, y: 0, w: 1, h: 0.5 }, shot: 'wide' as const, speech: 1, captions: 0, sfx: 0 },
  { n: 2, box: { x: 0, y: 0.5, w: 1, h: 0.5 }, shot: 'medium' as const, speech: 0, captions: 1, sfx: 0 }
];
const rects = (c: HTMLElement) => [...c.querySelectorAll('g > rect:first-child')].map((r) => [r.getAttribute('x'), r.getAttribute('y'), r.getAttribute('width')]);

describe('PageWireframe frames when present', () => {
  it('without frames the drawing is unchanged (same markup as passing none)', () => {
    const a = render(<PageWireframe panels={panels} aspect="2:3" />).container.innerHTML;
    const b = render(<PageWireframe panels={panels} aspect="2:3" frames={undefined} />).container.innerHTML;
    expect(a).toBe(b);
    // A frames list that does not match the panels is ignored.
    expect(render(<PageWireframe panels={panels} aspect="2:3" frames={[{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }]} />).container.innerHTML).toBe(a);
  });

  it('with frames: each panel at its frame, insets drawn above their host by z', () => {
    const frames = [
      { box: { x: 0.02, y: 0.02, w: 0.96, h: 0.96 }, z: 0 },
      { box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, z: -1 }
    ];
    const { container } = render(<PageWireframe panels={panels} aspect="2:3" frames={frames} />);
    // Drawn in z order: panel 2 (z −1) first, then panel 1; the H scale is 1.5 for a 2:3 page.
    expect(rects(container)).toEqual([
      ['0.6', String(0.6 * 1.5), '0.3'],
      ['0.02', String(0.02 * 1.5), '0.96']
    ]);
  });

  it('wireframeFramesOf: the frames a page is shown in (the editor scene’s rule), else undefined', () => {
    const doc = framedDoc((page) => (page.panels[1].frame = { ...page.panels[1].frame!, z: 3 }));
    const page = doc.pages[0];
    const frames = wireframeFramesOf(page)!;
    expect(frames.map((f) => f.box)).toEqual(framesShown(doc, page).boxes);
    expect(frames[1].z).toBe(3);
    expect(wireframeFramesOf(makeQaDoc('heist-12p').pages[0])).toBeUndefined();
    // A drawn page whose frames are not shown (no cuts: it is shown as drawn) uses its summary boxes.
    const drawn = framedDoc((p) => delete p.render.cuts);
    expect(wireframeFramesOf(drawn.pages[0])).toBeUndefined();
    // An undrawn page planned on frames shows them.
    const planned = framedDoc((p) => {
      delete p.render.asset;
      delete p.render.cuts;
      delete p.artMode;
    });
    expect(wireframeFramesOf(planned.pages[0])!.map((f) => f.box)).toEqual(framesShown(planned, planned.pages[0]).boxes);
  });
});
