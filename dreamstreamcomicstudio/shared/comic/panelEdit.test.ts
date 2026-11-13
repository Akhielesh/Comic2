import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type Page } from './doc';
import { panelEditBounds } from './panelEdit';

const top = { x: 0.02, y: 0.02, w: 0.96, h: 0.46 };
const bottom = { x: 0.02, y: 0.52, w: 0.96, h: 0.46 };
const page = (): Page => ({
  id: 'page', n: 1, summary: '', layout: '', balloons: [],
  panels: [1, 2].map((n) => ({ id: `panel-${n}`, n, size: 'wide', shot: 'wide', action: '', castIds: [], lines: [] })),
  render: {
    ...createEmptyDoc('doc', 'Test').cover.render,
    qc: { score: 0.9, issues: [], checkedAt: 1, panelBoxes: [top, bottom], boxesFrom: 'vision',
      beats: [1, 2], crosses: [], panelShapes: ['rect', 'rect'] }
  }
});

describe('panelEditBounds', () => {
  it('uses measured image bounds and follows an unambiguous script-to-drawn mapping', () => {
    const p = page();
    expect(panelEditBounds(p, 2)).toEqual({ ok: true, box: bottom });
    p.render.qc!.beats = [2, 1];
    expect(panelEditBounds(p, 2)).toEqual({ ok: true, box: top });
  });

  it('accepts a user-confirmed rectangle without inventing metadata on an old check', () => {
    const p = page();
    delete p.render.qc;
    p.render.cuts = { status: 'ok', by: 'user', at: 1, cuts: [
      { panelId: 'panel-2', drawn: 1, box: top, conf: 1 },
      { panelId: 'panel-1', drawn: 2, box: bottom, conf: 1 }
    ] };
    expect(panelEditBounds(p, 2)).toEqual({ ok: true, box: top });
  });

  it.each(['estimate', 'vision', 'detect'] as const)('does not treat %s cuts alone as proof of a rectangle', (by) => {
    const p = page();
    delete p.render.qc;
    p.render.cuts = { status: 'ok', by, at: 1, cuts: [{ panelId: 'panel-2', drawn: 1, box: top, conf: 1 }] };
    expect(panelEditBounds(p, 2).ok).toBe(false);
  });

  it.each([
    ['legacy shape', (p: Page) => { delete p.render.qc!.panelShapes; }],
    ['nonrectangular shape', (p: Page) => { p.render.qc!.panelShapes![1] = 'other'; }],
    ['estimated bounds', (p: Page) => { p.render.qc!.boxesFrom = 'estimate'; }],
    ['unknown crossings', (p: Page) => { delete p.render.qc!.crosses; }],
    ['crossing art', (p: Page) => { p.render.qc!.crosses = [1]; }],
    ['duplicate beat', (p: Page) => { p.render.qc!.beats = [2, 2]; }],
    ['unmapped beat', (p: Page) => { p.render.qc!.beats = [0, 2]; }],
    ['overlap', (p: Page) => { p.render.qc!.panelBoxes = [top, top]; }],
    ['invalid bounds', (p: Page) => { p.render.qc!.panelBoxes![1] = { ...bottom, w: NaN }; }],
    ['panels composition', (p: Page) => { p.artMode = 'panels'; }],
    ['separate picture', (p: Page) => { p.panels[1].frame = { box: bottom, src: { path: 'another.webp' } }; }],
    ['locked panel', (p: Page) => { p.panels[1].frame = { box: bottom, locked: true }; }],
    ['uncertain cuts', (p: Page) => { p.render.cuts = { status: 'unsure', by: 'user', at: 1, cuts: [] }; }]
  ])('refuses %s without an approximate or page-wide fallback', (_label, mutate) => {
    const p = page();
    mutate(p);
    const result = panelEditBounds(p, 2);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
  });

  it('does not mutate the measured boxes or accept duplicate panel numbers', () => {
    const p = page();
    const result = panelEditBounds(p, 2);
    if (result.ok) result.box.x = 0.8;
    expect(p.render.qc!.panelBoxes![1]).toEqual(bottom);
    p.panels[0].n = 2;
    expect(panelEditBounds(p, 2).ok).toBe(false);
  });
});
