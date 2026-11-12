// TransformSection (PE-INSPECT; agent-editor plan §4 Wave 1 C-INSPECT): X and Y write balloon {x, y, pinned: true}
// through setBoxEdit, W writes {w}, H writes {minH}, rotation writes balloon {rot} through rotateEdit; arrow steps
// coalesce per field; a locked balloon refuses; mm / in on the printed trim.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { sceneObject } from '../../../shared/comic/editor/scene';
import { resolvePlacements } from './useLetterPlans';
import { TransformSection, transformEdit } from './TransformSection';
import { sceneFor } from './proStyleOps';
import { COMIC_TRIM_WIDTH_PT } from '../export/pdfExport';
import { TRIM_WIDTH_IN, UNITS_KEY, unitScale } from '../editor/inspector/units';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;

const ctx = (mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const plans = planLettering(doc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(doc, page, ASPECT, estimateMeasure);
  return { doc, page, plans, placements };
};

const mount = (lineIds: string[], mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const c = ctx(mutate);
  const apply = vi.fn();
  render(<TransformSection doc={c.doc} page={c.page} plans={c.plans} H={H} lineIds={lineIds} balloons={c.placements.balloons} apply={apply} />);
  return { ...c, apply };
};

const type = (label: string, value: string) => {
  const input = screen.getByRole('spinbutton', { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

afterEach(() => {
  try {
    localStorage.removeItem(UNITS_KEY);
  } catch {
    /* no storage */
  }
});

describe('TransformSection', () => {
  it('each field belongs to its balloon: selecting another balloon gives fresh fields, a pending value never moves to it', () => {
    const c = ctx();
    const apply = vi.fn();
    const at = (ids: string[]) => <TransformSection doc={c.doc} page={c.page} plans={c.plans} H={H} lineIds={ids} balloons={c.placements.balloons} apply={apply} />;
    const { rerender } = render(at(['pg_1_l3']));
    const fields = ['X', 'Y', 'W', 'H (minimum)', 'Rotation'].map((name) => screen.getByRole('spinbutton', { name }));
    for (const f of fields) fireEvent.change(f, { target: { value: '12' } });
    rerender(at(['pg_1_l5']));
    const fresh = ['X', 'Y', 'W', 'H (minimum)', 'Rotation'].map((name) => screen.getByRole('spinbutton', { name }));
    fresh.forEach((f, i) => expect(f).not.toBe(fields[i]));
    for (const f of fresh) fireEvent.blur(f);
    expect(apply).not.toHaveBeenCalled();
  });

  it('X writes balloon {x, y, pinned: true} — the outline lands at the typed X, the text box moves with it', () => {
    const { doc, page, plans, apply } = mount(['pg_1_l3']);
    const me = sceneObject(sceneFor(doc, page, plans), { kind: 'balloon', id: 'pg_1_l3' })!;
    type('X', '40');
    expect(apply).toHaveBeenCalledTimes(1);
    const [ops, opts] = apply.mock.calls[0];
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('balloon');
    expect(ops[0].lineId).toBe('pg_1_l3');
    expect(Object.keys(ops[0].patch).sort()).toEqual(['pinned', 'x', 'y']);
    expect(ops[0].patch.pinned).toBe(true);
    expect(ops[0].patch.x).toBeCloseTo(me.text!.x + (0.4 - me.box.x), 4);
    expect(ops[0].patch.y).toBeCloseTo(me.text!.y, 4);
    expect(opts.label).toMatch(/^Move /);
    expect(opts.coalesce).toBeUndefined();
  });

  it('Y writes balloon {x, y, pinned: true} with the typed Y', () => {
    const { doc, page, plans, apply } = mount(['pg_1_l3']);
    const me = sceneObject(sceneFor(doc, page, plans), { kind: 'balloon', id: 'pg_1_l3' })!;
    type('Y', '20');
    const [ops] = apply.mock.calls[0];
    expect(Object.keys(ops[0].patch).sort()).toEqual(['pinned', 'x', 'y']);
    expect(ops[0].patch.y).toBeCloseTo(me.text!.y + (0.2 - me.box.y), 4);
    expect(ops[0].patch.x).toBeCloseTo(me.text!.x, 4);
  });

  it('rotation writes balloon {rot} (pinned) through rotateEdit, clamped to ±45°', () => {
    const { apply } = mount(['pg_1_l3']);
    type('Rotation', '15');
    expect(apply.mock.calls[0][0]).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { rot: 15, pinned: true } }]);
    expect(apply.mock.calls[0][1].label).toBe('Rotate balloon');
    type('Rotation', '80');
    expect(apply.mock.calls[1][0][0].patch.rot).toBe(45);
  });

  it('W writes {w}; H writes the minimum height {minH}', () => {
    const { apply } = mount(['pg_1_l3']);
    type('W', '30');
    expect(apply.mock.calls[0][0][0].patch).toHaveProperty('w');
    type('H (minimum)', '25');
    expect(apply.mock.calls[1][0][0].patch.minH).toBeCloseTo(0.25, 4);
  });

  it('arrow steps coalesce into one undo entry per field', () => {
    const { apply } = mount(['pg_1_l3']);
    const x = screen.getByRole('spinbutton', { name: 'X' });
    fireEvent.keyDown(x, { key: 'ArrowRight' });
    expect(apply).not.toHaveBeenCalled();
    fireEvent.keyDown(x, { key: 'ArrowUp' });
    fireEvent.keyDown(x, { key: 'ArrowUp', shiftKey: true });
    expect(apply).toHaveBeenCalledTimes(2);
    for (const call of apply.mock.calls) expect(call[1].coalesce).toBe('xform:pg_1:pg_1_l3:x');
  });

  it('a line the software placed (no stored balloon) is stored whole when rotated, so it never jumps', () => {
    const { placements, apply } = mount(['pg_1_l4']);
    type('Rotation', '-30');
    const [ops] = apply.mock.calls[0];
    const b = placements.balloons.get('pg_1_l4')!;
    expect(ops).toHaveLength(1);
    expect(ops[0].patch).toMatchObject({ x: b.x, y: b.y, w: b.w, rot: -30, pinned: true });
  });

  it('a locked balloon cannot be typed into, and several balloons are typed one at a time', () => {
    mount(['pg_1_l3'], (d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, locked: true, pinned: true } : b));
    });
    for (const name of ['X', 'Y', 'W', 'Rotation']) expect((screen.getByRole('spinbutton', { name }) as HTMLInputElement).disabled).toBe(true);
  });

  it('several balloons: says position is typed one balloon at a time', () => {
    mount(['pg_1_l3', 'pg_1_l5']);
    expect(screen.getByTestId('transform-many').textContent).toMatch(/one balloon at a time/);
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('mm and in are real lengths on the printed US comic trim (the PDF trim), and the choice is remembered', () => {
    expect(TRIM_WIDTH_IN).toBe(COMIC_TRIM_WIDTH_PT / 72);
    expect(unitScale('in', 'x', ASPECT)).toBeCloseTo(6.625, 6);
    expect(unitScale('mm', 'y', ASPECT)).toBeCloseTo((6.625 / ASPECT) * 25.4, 6);
    const { doc, page, plans, apply } = mount(['pg_1_l3']);
    const me = sceneObject(sceneFor(doc, page, plans), { kind: 'balloon', id: 'pg_1_l3' })!;
    fireEvent.click(screen.getByRole('radio', { name: 'mm' }));
    expect(localStorage.getItem(UNITS_KEY)).toBe('mm');
    expect(screen.getByRole('spinbutton', { name: 'X' }).getAttribute('aria-valuetext')).toMatch(/ mm$/);
    // 50.8 mm (2 in) across a 168.275 mm (6.625 in) wide page.
    type('X', '50.8');
    const [ops] = apply.mock.calls[0];
    expect(ops[0].patch.x).toBeCloseTo(me.text!.x + (2 / 6.625 - me.box.x), 3);
  });

  it('transformEdit refuses honestly for a line that is not on the page', () => {
    const { doc, page, plans, placements } = ctx();
    const r = transformEdit(doc, page, plans, 'nope', 'x', 0.2, placements.balloons);
    expect(r.ok).toBe(false);
  });
});
