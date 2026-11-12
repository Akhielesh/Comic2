// Guided View in panels mode (pro plan B1 test, PE-COMPOSE; collisions A-5): the stops a reader pans between are the
// page's FRAMES — where the composed page draws each panel — not the drawing's measured boxes or the blueprint. Uses
// guidedModel's exported API only (AV-0 owns the module in S2a).

import { describe, expect, it } from 'vitest';
import { composePage } from '../../../shared/comic/panelize/compose';
import { framedDoc } from '../compose/__fixtures__/composeDocs';
import type { ReaderItem } from '../reader/readerModel';
import { guidedStops, readingOrder } from './guidedModel';

const itemOf = (doc: ReturnType<typeof framedDoc>): ReaderItem => ({ key: doc.pages[0].id, kind: 'page', label: 'Page 1', asset: doc.pages[0].render.asset!, page: doc.pages[0] });

describe('Guided View stops equal the frames (panels mode)', () => {
  it('one stop per frame, each exactly the box the composed page draws that panel in', () => {
    const doc = framedDoc((page) => {
      // Move the frames well away from the drawing's panel boxes: the stops must follow the frames.
      page.panels[0].frame = { box: { x: 0.05, y: 0.04, w: 0.9, h: 0.3 } };
      page.panels[1].frame = { box: { x: 0.05, y: 0.37, w: 0.42, h: 0.58 } };
      page.panels[2].frame = { box: { x: 0.53, y: 0.37, w: 0.42, h: 0.58 } };
    });
    const page = doc.pages[0];
    const stops = guidedStops(doc, itemOf(doc), 0, { overview: false });
    const pieces = composePage(doc, page).pieces;
    expect(stops).toHaveLength(page.panels.length);
    for (const stop of stops) {
      expect(stop.box).toEqual(page.panels[stop.panelIndex].frame!.box);
      expect(stop.box).toEqual(pieces[stop.panelIndex].dst);
    }
    // Reading order is read off the frames too (the two lower frames side by side, left first).
    expect(stops.map((s) => s.panelIndex)).toEqual(readingOrder(page.panels.map((p) => p.frame!.box), false));
    expect(stops.map((s) => s.panelIndex)).toEqual([0, 1, 2]);
  });

  it('a manga book reads the frames right to left; the overview stop stays the whole page', () => {
    const doc = framedDoc((page, d) => {
      d.format.readingDirection = 'rtl';
      page.panels[0].frame = { box: { x: 0.05, y: 0.04, w: 0.9, h: 0.3 } };
      page.panels[1].frame = { box: { x: 0.05, y: 0.37, w: 0.42, h: 0.58 } };
      page.panels[2].frame = { box: { x: 0.53, y: 0.37, w: 0.42, h: 0.58 } };
    });
    const stops = guidedStops(doc, itemOf(doc), 0, { overview: true });
    expect(stops[0].panelIndex).toBe(-1);
    expect(stops.slice(1).map((s) => s.panelIndex)).toEqual([0, 2, 1]);
    for (const s of stops.slice(1)) expect(s.box).toEqual(doc.pages[0].panels[s.panelIndex].frame!.box);
  });

  it('a page shown as drawn keeps its old stops (the frames are ignored until the page is in panels mode)', () => {
    const doc = framedDoc((page) => {
      delete page.artMode;
      page.panels[0].frame = { box: { x: 0.05, y: 0.04, w: 0.9, h: 0.3 } };
    });
    const stops = guidedStops(doc, itemOf(doc), 0, { overview: false });
    expect(stops.find((s) => s.panelIndex === 0)!.box).not.toEqual({ x: 0.05, y: 0.04, w: 0.9, h: 0.3 });
  });
});
