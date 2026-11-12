// The Pro workspace's layout table (PE-SHELL; master plan §2.7 slice 1): docked from 1024 px with the 48 px rail and
// the aside-wide inspector (360 / 400), the 280 px left rail from 1440, a tool row on tablets, today's layout on
// phones.

import { describe, expect, it } from 'vitest';
import { formFactorFor } from '../useFormFactor';
import { PRO_LEFT_RAIL_W, PRO_RAIL_W, editorLayoutFor, proWorkspaceFor } from './editorModel';

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

// The dock never overlapping the page is measured in Chromium (tests/e2e/editor.proshell.spec.ts at 1024 / 1280 / 1440):
// the docked layout is CSS flex, so a formula here would test a model the product never runs.
