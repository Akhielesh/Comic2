// The Pro workspace's layout table (PE-SHELL; master plan §2.7 slice 1): docked from 1024 px with the 48 px rail and
// the aside-wide inspector (360 / 400), the 280 px left rail from 1440, a tool row on tablets, today's layout on
// phones — and at 1280 × 800 the docked inspector never overlaps the page.

import { describe, expect, it } from 'vitest';
import { formFactorFor } from '../useFormFactor';
import { PRO_LEFT_RAIL_W, PRO_RAIL_W, editorLayoutFor, proDockedGeometry, proWorkspaceFor } from './editorModel';

const wsAt = (w: number, h: number, coarse = false) => {
  const ff = formFactorFor({ w, h, coarse });
  return proWorkspaceFor(editorLayoutFor(ff), w);
};

describe('proWorkspaceFor', () => {
  it('1024 × 768: docked, 48 px rail, 360 px inspector, no left rail', () => {
    expect(wsAt(1024, 768)).toEqual({ kind: 'docked', railW: PRO_RAIL_W, dockW: 360, leftRailW: 0 });
  });
  it('1280 × 800: the inspector is 400 px', () => {
    expect(wsAt(1280, 800)).toEqual({ kind: 'docked', railW: 48, dockW: 400, leftRailW: 0 });
  });
  it('1440 × 900: adds the 280 px Layers / Assets rail', () => {
    expect(wsAt(1440, 900)).toEqual({ kind: 'docked', railW: 48, dockW: 400, leftRailW: PRO_LEFT_RAIL_W });
  });
  it('768 × 1024 tablet: a tool row; 360 phone and 320 reflow: today’s phone layout', () => {
    expect(wsAt(768, 1024, true).kind).toBe('tool-row');
    expect(wsAt(360, 740, true).kind).toBe('phone');
    expect(wsAt(320, 640, true).kind).toBe('phone');
    expect(wsAt(844, 390, true).kind).toBe('phone');
  });
});

describe('proDockedGeometry: the dock never overlaps the page', () => {
  const ASPECT = 2 / 3; // a portrait comic page
  for (const [w, h] of [
    [1024, 768],
    [1280, 800],
    [1440, 900],
    [1920, 1080]
  ] as const) {
    it(`${w} × ${h}`, () => {
      const ws = wsAt(w, h);
      for (const leftRail of [false, true]) {
        const g = proDockedGeometry({ w, h }, ws, { aspect: ASPECT, chromeH: 52 + 56 + 76, leftRail });
        expect(g.dockLeft).toBe(w - ws.dockW);
        expect(g.page.width).toBeGreaterThan(200);
        expect(g.page.left).toBeGreaterThanOrEqual(g.stage.left);
        expect(g.page.right).toBeLessThanOrEqual(g.dockLeft);
      }
    });
  }
  it('a landscape page at 1280 × 800 is width-bound and still clears the dock', () => {
    const ws = wsAt(1280, 800);
    const g = proDockedGeometry({ w: 1280, h: 800 }, ws, { aspect: 16 / 9, chromeH: 184 });
    expect(g.page.right).toBeLessThanOrEqual(g.dockLeft - 24);
  });
});
