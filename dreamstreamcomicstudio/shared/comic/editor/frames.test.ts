import { describe, expect, it } from 'vitest';
import { cutFor, type Balloon, type ComicDoc } from '../doc.js';
import { EDITOR_LIMITS } from '../limits.js';
import { frameAffine } from '../panelize/space.js';
import { apply, ASSET, baseDoc, drawnPage, line, OLD_TAKE, pageOf, panel, undrawnPage, withPages } from './__fixtures__/editorDoc.js';
import {
  addFrameEdit,
  closeUpEdit,
  deleteFrameEdit,
  equalizeEdit,
  guttersOf,
  gutterDragEdit,
  joinFramesEdit,
  makeBiggestEdit,
  moveFrameEdit,
  reframeEdit,
  resizeFrameEdit,
  splitFrameEdit,
  swapPicturesEdit,
  useTakeEdit
} from './frames.js';
import type { EditOk, EditResult } from './scene.js';

/** Wire equality (undo.ts R4): a cleared key may come back as null. */
const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));
const okOf = (r: EditResult): EditOk => {
  if (r.ok === false) throw new Error(`refused: ${(r as { reason: string }).reason}`);
  return r as EditOk;
};
/** Apply an edit, then its inverse: the doc must come back. Returns the edited doc. */
const roundTrip = (doc: ComicDoc, r: EditResult): ComicDoc => {
  const e = okOf(r);
  const after = apply(doc, e.ops);
  expect(strip(apply(after, e.undo))).toEqual(strip(doc));
  return after;
};

const gridDoc = (lockP2 = false) => {
  const page = drawnPage('pg_a', 1, 'four-grid', [panel('p1', 1), panel('p2', 2), panel('p3', 3), panel('p4', 4)]);
  if (lockP2) page.panels[1].frame = { ...page.panels[1].frame!, locked: true };
  return withPages(baseDoc(), [page]);
};

describe('gutter drag', () => {
  it('conserves the row and never takes a panel below frameMin; undo restores it', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    const g = guttersOf(doc, page).find((x) => x.axis === 'x' && x.before.includes('p1'))!;
    expect(g.after).toEqual(['p2']);
    const [b1, b2] = [page.panels[0].frame!.box, page.panels[1].frame!.box];
    const row = b1.w + (b2.x - (b1.x + b1.w)) + b2.w;

    const wide = roundTrip(doc, gutterDragEdit(doc, page, g, 0.8));
    const [w1, w2] = [pageOf(wide, 'pg_a').panels[0].frame!.box, pageOf(wide, 'pg_a').panels[1].frame!.box];
    expect(w2.w).toBeCloseTo(EDITOR_LIMITS.frameMin, 4);
    expect(w1.w + (w2.x - (w1.x + w1.w)) + w2.w).toBeCloseTo(row, 4);
    expect(w2.x + w2.w).toBeCloseTo(b2.x + b2.w, 4);
    // The other row is untouched.
    expect(pageOf(wide, 'pg_a').panels[2].frame!.box).toEqual(page.panels[2].frame!.box);

    const narrow = apply(doc, okOf(gutterDragEdit(doc, page, g, -0.8)).ops);
    expect(pageOf(narrow, 'pg_a').panels[0].frame!.box.w).toBeCloseTo(EDITOR_LIMITS.frameMin, 4);
  });

  it('lands on ⅔ of the row when released near it', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    const g = guttersOf(doc, page).find((x) => x.axis === 'x' && x.before.includes('p1'))!;
    const b1 = page.panels[0].frame!.box;
    const b2 = page.panels[1].frame!.box;
    const content = b2.x + b2.w - b1.x - g.gap;
    const want = b1.x + (2 / 3) * content;
    const after = apply(doc, okOf(gutterDragEdit(doc, page, g, want - (b1.x + b1.w) - 0.01)).ops);
    expect(pageOf(after, 'pg_a').panels[0].frame!.box.w / content).toBeCloseTo(2 / 3, 3);
  });

  it('refuses when a panel it moves is locked', () => {
    const doc = gridDoc(true);
    const page = pageOf(doc, 'pg_a');
    const g = guttersOf(doc, page).find((x) => x.axis === 'x' && x.before.includes('p1'))!;
    expect(gutterDragEdit(doc, page, g, 0.1)).toEqual({ ok: false, reason: 'Panel 2 is locked. Unlock it to change it.' });
  });

  it('a resize handle on a shared edge moves the neighbour (the row stays tiled)', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    const after = roundTrip(doc, resizeFrameEdit(doc, page, 'p2', 'w', -0.1, 0));
    const [a1, a2] = [pageOf(after, 'pg_a').panels[0].frame!.box, pageOf(after, 'pg_a').panels[1].frame!.box];
    expect(a2.x - (a1.x + a1.w)).toBeCloseTo(page.panels[1].frame!.box.x - (page.panels[0].frame!.box.x + page.panels[0].frame!.box.w), 4);
    expect(a1.w).toBeCloseTo(page.panels[0].frame!.box.w - 0.1, 4);
  });
});

describe('split', () => {
  const splitDoc = () => {
    const balloons: Balloon[] = [
      { lineId: 'l1', x: 0.08, y: 0.06, w: 0.25, pinned: true },
      { lineId: 'l2', x: 0.66, y: 0.08, w: 0.25, pinned: true }
    ];
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Stop!', 'speech', 'c_maya'), line('l2', 'Run!', 'speech', 'c_ravi')]), panel('p2', 2)], { balloons });
    return withPages(baseDoc(), [page]);
  };

  it('routes each line to the half holding its balloon; balloons and the art under them stay put', () => {
    const doc = splitDoc();
    const page = pageOf(doc, 'pg_a');
    const r = okOf(splitFrameEdit(doc, page, 'p1', 'across'));
    expect(r.label).toBe('Split panel 1 side by side');
    const after = roundTrip(doc, r);
    const pa = pageOf(after, 'pg_a');
    expect(pa.panels.map((p) => [p.id, p.n, p.lines.map((l) => l.id)])).toEqual([
      ['p1', 1, ['l1']],
      ['pe1', 2, ['l2']],
      ['p2', 3, []]
    ]);
    expect(pa.balloons).toEqual(page.balloons);
    // A gutter between the halves; both at least frameMin; the halves fill the old frame.
    const [h1, h2] = [pa.panels[0].frame!.box, pa.panels[1].frame!.box];
    const F = page.panels[0].frame!.box;
    expect(h2.x - (h1.x + h1.w)).toBeCloseTo(0.02, 4);
    expect(h1.x).toBeCloseTo(F.x, 4);
    expect(h2.x + h2.w).toBeCloseTo(F.x + F.w, 4);
    // Each half shows exactly the art that was under it: a page point maps to the same picture point.
    const before = frameAffine(doc, page, 'p1')!;
    for (const [id, pt] of [
      ['p1', { x: 0.2, y: 0.2 }],
      ['pe1', { x: 0.8, y: 0.3 }]
    ] as const) {
      const aff = frameAffine(after, pa, id)!;
      expect(aff.path).toBe(ASSET);
      const a = aff.toImage(pt);
      const b = before.toImage(pt);
      expect(a.x).toBeCloseTo(b.x, 3);
      expect(a.y).toBeCloseTo(b.y, 3);
    }
    expect(cutFor(pa, pa.panels[1])!.panelId).toBe('pe1');
  });

  it('on an undrawn page adds a planned panel and the layout sentence follows the frames', () => {
    const page = undrawnPage('pg_u', 1, [panel('u1', 1, [], { size: 'wide' }), panel('u2', 2, [], { size: 'wide' })], 'Row 1: one wide panel. Row 2: one wide panel.');
    const doc = withPages(baseDoc(), [page]);
    const after = roundTrip(doc, splitFrameEdit(doc, page, 'u2', 'across'));
    const pa = pageOf(after, 'pg_u');
    expect(pa.panels).toHaveLength(3);
    expect(pa.panels[2].action).toBe('');
    expect(pa.layout).toBe('Row 1: one wide panel across the full width (panel 1). Row 2: two equal panels side by side (panels 2–3).');
    expect(pa.panels.map((p) => p.size)).toEqual(['wide', 'medium', 'medium']);
  });

  it('refuses a locked panel, a panel too small, and a tenth panel', () => {
    const doc = splitDoc();
    const page = pageOf(doc, 'pg_a');
    const locked = { ...page, panels: page.panels.map((p, i) => (i === 0 ? { ...p, frame: { ...p.frame!, locked: true as const } } : p)) };
    expect(splitFrameEdit(withPages(doc, [locked]), locked, 'p1', 'down')).toEqual({ ok: false, reason: 'Panel 1 is locked. Unlock it to change it.' });
    const tiny = { ...page, panels: page.panels.map((p, i) => (i === 0 ? { ...p, frame: { box: { x: 0.02, y: 0.02, w: 0.07, h: 0.4 } } } : p)) };
    expect(splitFrameEdit(withPages(doc, [tiny]), tiny, 'p1', 'across')).toEqual({ ok: false, reason: 'Panel 1 is too small to split.' });
  });
});

describe('join, delete, add', () => {
  it('joins an empty frame into its drawn neighbour; two drawn panels refuse in plain words', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    expect(joinFramesEdit(doc, page, 'p1', 'p2')).toEqual({ ok: false, reason: 'These two panels are drawn separately. Keep both, or redraw them as one panel.' });
    // p2 has no cut: an empty frame.
    const cuts = { ...page.render.cuts!, cuts: page.render.cuts!.cuts.filter((c) => c.panelId !== 'p2') };
    const p = { ...page, render: { ...page.render, cuts } };
    const d2 = withPages(doc, [p]);
    const after = roundTrip(d2, joinFramesEdit(d2, p, 'p1', 'p2'));
    const pa = pageOf(after, 'pg_a');
    expect(pa.panels.map((x) => x.id)).toEqual(['p1', 'p3', 'p4']);
    expect(pa.panels[0].frame!.box.w).toBeCloseTo(0.96, 4);
  });

  it('deleting a panel closes the gap and sends its lines to the previous panel', () => {
    const page = drawnPage('pg_a', 1, 'big-top-two', [panel('p1', 1), panel('p2', 2), panel('p3', 3, [line('l3', 'Hi')])]);
    const doc = withPages(baseDoc(), [page]);
    const r = okOf(deleteFrameEdit(doc, page, 'p3'));
    expect(r.notes).toEqual(['Its lines moved to panel 2.']);
    const after = roundTrip(doc, r);
    const pa = pageOf(after, 'pg_a');
    expect(pa.panels.map((x) => x.id)).toEqual(['p1', 'p2']);
    expect(pa.panels[1].lines.map((l) => l.id)).toEqual(['l3']);
    expect(pa.panels[1].frame!.box.w).toBeCloseTo(0.96, 4);
  });

  it('adds a frame where it reads, refuses an overlap, and makes an inset inside another frame', () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1), panel('p2', 2)]);
    const doc = withPages(baseDoc(), [page]);
    expect(addFrameEdit(doc, page, { x: 0.3, y: 0.3, w: 0.4, h: 0.4 })).toEqual({ ok: false, reason: 'Panels cannot overlap. Draw it in free space, or fully inside another panel as an inset.' });
    const after = roundTrip(doc, addFrameEdit(doc, page, { x: 0.6, y: 0.3, w: 0.3, h: 0.15 }));
    const pa = pageOf(after, 'pg_a');
    expect(pa.panels.map((p) => p.id)).toEqual(['p1', 'pe1', 'p2']);
    expect(pa.panels[1].frame!.z).toBe(1);
  });
});

describe('sizes', () => {
  it('equalizes a row and makes a panel the biggest, keeping every frame above frameMin', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    const g = guttersOf(doc, page).find((x) => x.axis === 'x' && x.before.includes('p1'))!;
    const uneven = apply(doc, okOf(gutterDragEdit(doc, page, g, 0.2, { detents: false })).ops);
    const eq = roundTrip(uneven, equalizeEdit(uneven, pageOf(uneven, 'pg_a'), 'p2', 'row'));
    expect(pageOf(eq, 'pg_a').panels[0].frame!.box).toEqual(page.panels[0].frame!.box);
    expect(equalizeEdit(doc, page, 'p1', 'row')).toEqual({ ok: false, reason: 'It already looks like that.' });

    const big = roundTrip(doc, makeBiggestEdit(doc, page, 'p3'));
    const areas = pageOf(big, 'pg_a').panels.map((p) => p.frame!.box.w * p.frame!.box.h);
    expect(Math.max(...areas)).toBe(areas[2]);
    expect(pageOf(big, 'pg_a').panels.every((p) => p.frame!.box.w >= EDITOR_LIMITS.frameMin && p.frame!.box.h >= EDITOR_LIMITS.frameMin)).toBe(true);
  });

  it('moves a frame only into free space', () => {
    const doc = gridDoc();
    const page = pageOf(doc, 'pg_a');
    expect(moveFrameEdit(doc, page, 'p1', { x: 0.3, y: 0.02, w: 0.47, h: 0.47 }).ok).toBe(false);
    roundTrip(doc, moveFrameEdit(doc, page, 'p1', { x: 0.02, y: 0.02, w: 0.3, h: 0.3 }));
  });
});

describe('pictures in frames', () => {
  const doc = () => {
    const page = drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hi', 'speech', 'c_maya')]), panel('p2', 2)], {
      qc: { heads: [{ panel: 1, characterId: 'c_maya', head: { x: 0.7, y: 0.2 } }] }
    });
    return withPages(baseDoc(), [page]);
  };

  it('uses a panel from an earlier take, by its version number', () => {
    const d = doc();
    const page = pageOf(d, 'pg_a');
    const r = okOf(useTakeEdit(d, page, 'p2', { path: OLD_TAKE }));
    expect(r.label).toBe('Use panel 2 from take 1');
    const after = roundTrip(d, r);
    expect(pageOf(after, 'pg_a').panels[1].frame!.src).toEqual({ path: OLD_TAKE, box: page.render.cuts!.cuts[1].box });
    expect(useTakeEdit(d, page, 'p2', { path: 'u_other/x.png' })).toEqual({ ok: false, reason: 'That picture is not a take of this page.' });
  });

  it('swaps two pictures and crops one, both undoable', () => {
    const d = doc();
    const page = pageOf(d, 'pg_a');
    const swapped = roundTrip(d, swapPicturesEdit(d, page, 'p1', 'p2'));
    expect(pageOf(swapped, 'pg_a').panels[0].frame!.src).toEqual({ path: ASSET, box: page.render.cuts!.cuts[1].box });
    roundTrip(d, reframeEdit(d, page, 'p1', { s: 2, x: 0.5, y: 0 }));
    expect(reframeEdit(d, page, 'p1', { s: 9, x: 0, y: 0 }).ok && pageOf(apply(d, okOf(reframeEdit(d, page, 'p1', { s: 9, x: 0, y: 0 })).ops), 'pg_a').panels[0].frame!.fit!.s).toBe(EDITOR_LIMITS.fitZoomMax);
  });

  it('makes a close-up of the speaker from the same drawing, in the half that does not show her', () => {
    const d = doc();
    const page = pageOf(d, 'pg_a');
    const r = okOf(closeUpEdit(d, page, 'p1'));
    const after = roundTrip(d, r);
    const pa = pageOf(after, 'pg_a');
    // Maya's head is on the right: the close-up takes the left half and reads first.
    expect(pa.panels.map((p) => p.id)).toEqual(['pe1', 'p1', 'p2']);
    const cu = pa.panels[0];
    expect(cu.action).toBe('Close-up of Maya');
    expect(cu.castIds).toEqual(['c_maya']);
    expect(cu.shot).toBe('close_up');
    expect(cu.frame!.src!.path).toBe(ASSET);
    const box = cu.frame!.src!.box!;
    expect(box.x + box.w / 2).toBeCloseTo(0.7, 3);
    expect(box.y + box.h / 2).toBeCloseTo(0.2, 3);
  });

  it('every frame op refuses a locked panel with a plain-words reason', () => {
    const d = doc();
    const page = pageOf(d, 'pg_a');
    const locked = { ...page, panels: page.panels.map((p) => ({ ...p, frame: { ...p.frame!, locked: true as const } })) };
    const ld = withPages(d, [locked]);
    const reason = 'Panel 1 is locked. Unlock it to change it.';
    for (const r of [
      splitFrameEdit(ld, locked, 'p1', 'down'),
      resizeFrameEdit(ld, locked, 'p1', 'se', 0.01, 0.01),
      moveFrameEdit(ld, locked, 'p1', { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
      joinFramesEdit(ld, locked, 'p1', 'p2'),
      deleteFrameEdit(ld, locked, 'p1'),
      equalizeEdit(ld, locked, 'p1', 'column'),
      makeBiggestEdit(ld, locked, 'p1'),
      closeUpEdit(ld, locked, 'p1'),
      useTakeEdit(ld, locked, 'p1', { path: OLD_TAKE }),
      swapPicturesEdit(ld, locked, 'p1', 'p2'),
      reframeEdit(ld, locked, 'p1', { s: 2, x: 0, y: 0 })
    ]) {
      expect(r).toEqual({ ok: false, reason });
    }
  });
});
