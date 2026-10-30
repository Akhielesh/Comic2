import { describe, expect, it } from 'vitest';
import type { ComicDoc, Page } from '../doc.js';
import { estimateTextHeight, estimateWidthForText } from '../textLayout.js';
import { apply, ASSET, baseDoc, drawnPage, line, OLD_TAKE, pageOf, panel, undrawnPage, withPages } from './__fixtures__/editorDoc.js';
import { dropLabel, resolveDrop, type DropOk, type DropResult } from './drop.js';
import { buildScene } from './scene.js';

const PHOTO = 'u_test/proj_test/refs/ref_cat.png';
const PERSON = 'u_test/proj_test/refs/ref_kid.png';
const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));
const okOf = (r: DropResult): DropOk => {
  if (r.ok === false) throw new Error(`refused: ${(r as { reason: string }).reason}`);
  return r as DropOk;
};
const undoes = (doc: ComicDoc, r: DropOk) => expect(strip(apply(apply(doc, r.ops), r.undo))).toEqual(strip(doc));

const fixture = (): { doc: ComicDoc; undrawn: Page; drawn: Page } => {
  const undrawn = undrawnPage('pg_u', 1, [panel('u1', 1), panel('u2', 2, [line('lu', 'Look!', 'speech', 'c_maya')])], 'Row 1: one wide panel. Row 2: one wide panel.');
  const drawn = drawnPage('pg_a', 2, 'two-tiers', [panel('p1', 1, [line('l1', 'Hello there.', 'speech', 'c_maya'), line('l2', 'Later that day', 'caption')]), panel('p2', 2)], {
    balloons: [
      { lineId: 'l1', x: 0.1, y: 0.1, w: 0.25, pinned: true },
      { lineId: 'l2', x: 0.6, y: 0.04, w: 0.3, pinned: true }
    ],
    qc: { heads: [{ panel: 1, characterId: 'c_ravi', head: { x: 0.5, y: 0.35 }, mouth: { x: 0.5, y: 0.38 } }] }
  });
  let doc = withPages(baseDoc(), [undrawn, drawn]);
  doc = apply(doc, [
    { op: 'ref_add', owner: { kind: 'character', id: 'c_maya' }, ref: { path: PHOTO, source: 'upload', at: 1, w: 800, h: 400 } },
    { op: 'ref_add', owner: { kind: 'character', id: 'c_ravi' }, ref: { path: PERSON, source: 'upload', at: 2, w: 600, h: 600, subject: 'person' } }
  ]);
  return { doc, undrawn: pageOf(doc, 'pg_u'), drawn: pageOf(doc, 'pg_a') };
};

describe('resolveDrop: every row of the drop table', () => {
  it('character on a panel not drawn yet: cast plus staging from the drop x, free', () => {
    const { doc, undrawn } = fixture();
    const r = okOf(resolveDrop(doc, undrawn, { kind: 'cast', id: 'c_ravi' }, { point: { x: 0.1, y: 0.25 }, ref: { kind: 'frame', id: 'u1' } }));
    expect(r.ops).toEqual([{ op: 'panel', pageId: 'pg_u', id: 'u1', patch: { direction: { cast: { c_ravi: { pos: 'left' } }, by: 'user' }, castIds: ['c_maya', 'c_ravi'] } }]);
    expect(r.label).toBe('Add Ravi to panel 1, on the left');
    expect(r.cost).toBe('free');
    undoes(doc, r);
    // Already in the panel: it only moves.
    const again = okOf(resolveDrop(doc, undrawn, { kind: 'cast', id: 'c_maya' }, { point: { x: 0.9, y: 0.25 }, ref: { kind: 'frame', id: 'u1' } }));
    expect(again.label).toBe('Move Maya on the right in panel 1');
    expect(again.ops).toEqual([{ op: 'panel', pageId: 'pg_u', id: 'u1', patch: { direction: { cast: { c_maya: { pos: 'right' } }, by: 'user' } } }]);
  });

  it('character on a drawn panel: the same edit, free now, the redraw quoted later', () => {
    const { doc, drawn } = fixture();
    const r = okOf(resolveDrop(doc, drawn, { kind: 'cast', id: 'c_ravi' }, { point: { x: 0.5, y: 0.75 } }));
    expect(r.ops).toEqual([{ op: 'panel', pageId: 'pg_a', id: 'p2', patch: { direction: { cast: { c_ravi: { pos: 'center' } }, by: 'user' }, castIds: ['c_maya', 'c_ravi'] } }]);
    expect(r.label).toBe('Add Ravi to panel 2, in the middle (shows after a redraw)');
    expect(r.cost).toEqual({ redraw: 'panel' });
  });

  it('character on a balloon: the speaker, and the tail aimed at their mouth', () => {
    const { doc, drawn } = fixture();
    const scene = buildScene(doc, drawn);
    const b = scene.objects.find((o) => o.id === 'l1')!;
    const r = okOf(resolveDrop(doc, drawn, { kind: 'cast', id: 'c_ravi' }, { point: { x: b.box.x + 0.01, y: b.box.y + 0.01 } }, { scene }));
    const c = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 };
    const d = Math.hypot(c.x - 0.5, c.y - 0.38);
    const r4 = (n: number) => Math.round(n * 10000) / 10000;
    expect(r.ops).toEqual([
      { op: 'line', pageId: 'pg_a', panelId: 'p1', id: 'l1', patch: { speakerId: 'c_ravi' } },
      { op: 'balloon', pageId: 'pg_a', lineId: 'l1', patch: { tailX: r4(0.5 + ((c.x - 0.5) / d) * 0.02), tailY: r4(0.38 + ((c.y - 0.38) / d) * 0.02), pinned: true } }
    ]);
    expect(r.label).toBe('Ravi says this line, with the tail pointing at Ravi');
    expect(r.cost).toBe('free');
    undoes(doc, r);
    const cap = scene.objects.find((o) => o.id === 'l2')!;
    expect(resolveDrop(doc, drawn, { kind: 'cast', id: 'c_ravi' }, { point: { x: cap.box.x + 0.01, y: cap.box.y + 0.01 } }, { scene })).toEqual({ ok: false, reason: 'Captions have no speaker.' });
  });

  it('place on a panel', () => {
    const { doc, undrawn } = fixture();
    const r = okOf(resolveDrop(doc, undrawn, { kind: 'place', id: 'pl_park' }, { point: { x: 0.5, y: 0.75 } }));
    expect(r.ops).toEqual([{ op: 'panel', pageId: 'pg_u', id: 'u2', patch: { placeId: 'pl_park' } }]);
    expect(r.label).toBe('Set panel 2 in the park');
    expect(r.cost).toBe('free');
  });

  it('lettering preset in a panel: a new line there, its balloon at the drop point, the text editor opens', () => {
    const { doc, undrawn } = fixture();
    const r = okOf(resolveDrop(doc, undrawn, { kind: 'lettering', lineKind: 'shout' }, { point: { x: 0.5, y: 0.7 } }));
    const w = Math.round(estimateWidthForText('A new line of dialogue', 'en') * 10000) / 10000;
    const h = estimateTextHeight('A new line of dialogue', w, 2 / 3, 'en');
    const x = Math.round((0.5 - w / 2) * 10000) / 10000;
    const y = Math.round((0.7 - h / 2) * 10000) / 10000;
    expect(r.ops).toEqual([
      { op: 'line', pageId: 'pg_u', panelId: 'u2', id: 'le1', patch: { kind: 'shout', text: '', speakerId: 'c_maya' } },
      { op: 'balloon', pageId: 'pg_u', lineId: 'le1', patch: { x, y, w, pinned: true, tailX: Math.round((x + w * 0.42) * 10000) / 10000, tailY: Math.round((y + h + 0.05) * 10000) / 10000 } }
    ]);
    expect(r.label).toBe('New shout in panel 2');
    expect(r.focusLineId).toBe('le1');
    undoes(doc, r);
  });

  it('image on a frame: fill the panel, or a sticker kept in it', () => {
    const { doc, drawn } = fixture();
    const target = { point: { x: 0.5, y: 0.25 }, ref: { kind: 'frame' as const, id: 'p1' } };
    const both = okOf(resolveDrop(doc, drawn, { kind: 'image', path: PHOTO }, target));
    expect(both.choices!.map((c) => [c.key, c.label])).toEqual([
      ['fill', 'Fill panel 1 with this image'],
      ['sticker', 'Place as a sticker in panel 1']
    ]);
    const fill = okOf(resolveDrop(doc, drawn, { kind: 'image', path: PHOTO }, target, { as: 'fill' }));
    expect(fill.ops).toEqual([{ op: 'page_frames', pageId: 'pg_a', frames: [{ panelId: 'p1', frame: { box: drawn.panels[0].frame!.box, src: { path: PHOTO } } }] }]);
    undoes(doc, fill);
    const sticker = okOf(resolveDrop(doc, drawn, { kind: 'image', path: PHOTO }, target, { as: 'sticker' }));
    // 40% of the frame wide, the photo's 2:1 shape on a 2:3 page.
    const fw = drawn.panels[0].frame!.box.w * 0.4;
    const fh = (fw * (2 / 3)) / 2;
    expect(sticker.ops).toEqual([
      {
        op: 'layer',
        pageId: 'pg_a',
        id: 'ly_e1',
        patch: { kind: 'image', box: { x: Math.round((0.5 - fw / 2) * 10000) / 10000, y: Math.round((0.25 - fh / 2) * 10000) / 10000, w: Math.round(fw * 10000) / 10000, h: Math.round(fh * 10000) / 10000 }, src: { path: PHOTO }, clip: 'p1' }
      }
    ]);
    undoes(doc, sticker);
  });

  it("a real person's photo as a sticker starts as a guide only, with a warning", () => {
    const { doc, drawn } = fixture();
    const r = okOf(resolveDrop(doc, drawn, { kind: 'image', path: PERSON }, { point: { x: 0.5, y: 0.25 } }, { as: 'sticker' }));
    expect((r.ops[0] as { patch: { print?: boolean } }).patch.print).toBe(false);
    expect(r.warning).toMatch(/guide only/);
  });

  it('image on the page outside the frames: a page overlay', () => {
    const { doc, drawn } = fixture();
    const r = okOf(resolveDrop(doc, drawn, { kind: 'image', path: PHOTO }, { point: { x: 0.005, y: 0.495 } }));
    expect(r.label).toBe('Place the image on the page');
    expect(r.choices).toBeUndefined();
    expect((r.ops[0] as { patch: { clip?: string } }).patch.clip).toBeUndefined();
  });

  it('an earlier take on a frame: "Use panel 2 from take 1"', () => {
    const { doc, drawn } = fixture();
    const r = okOf(resolveDrop(doc, drawn, { kind: 'take', path: OLD_TAKE }, { point: { x: 0.5, y: 0.75 } }));
    expect(r.label).toBe('Use panel 2 from take 1');
    expect(r.ops).toEqual([{ op: 'page_frames', pageId: 'pg_a', frames: [{ panelId: 'p2', frame: { box: drawn.panels[1].frame!.box, src: { path: OLD_TAKE, box: drawn.render.cuts!.cuts[1].box } } }] }]);
    expect(r.cost).toBe('free');
  });

  it('a shape anywhere: an overlay, kept in the panel it lands in', () => {
    const { doc, drawn } = fixture();
    const r = okOf(resolveDrop(doc, drawn, { kind: 'shape', shape: 'rect' }, { point: { x: 0.5, y: 0.75 } }));
    expect(r.label).toBe('Add a rectangle in panel 2');
    expect(r.ops[0]).toMatchObject({ op: 'layer', pageId: 'pg_a', id: 'ly_e1', patch: { kind: 'shape', clip: 'p2', shape: { type: 'rect', fill: '#ffffff', stroke: '#111111', strokeW: 0.003 } } });
    undoes(doc, r);
  });

  it('anything on a locked object, or a panel thing on the margin, refuses and says why', () => {
    const { doc, drawn } = fixture();
    const locked: Page = { ...drawn, panels: drawn.panels.map((p, i) => (i === 0 ? { ...p, frame: { ...p.frame!, locked: true as const } } : p)), balloons: drawn.balloons.map((b) => ({ ...b, locked: true })) };
    const ld = withPages(doc, [doc.pages[0], locked]);
    const frameTarget = { point: { x: 0.9, y: 0.4 }, ref: { kind: 'frame' as const, id: 'p1' } };
    for (const item of [{ kind: 'cast', id: 'c_ravi' }, { kind: 'place', id: 'pl_park' }, { kind: 'image', path: PHOTO }, { kind: 'take', path: OLD_TAKE }, { kind: 'shape', shape: 'ellipse' }, { kind: 'lettering', lineKind: 'speech' }] as const) {
      const r = resolveDrop(ld, locked, item, frameTarget);
      expect(r).toEqual({ ok: false, reason: 'Panel 1 is locked. Unlock it to drop things on it.' });
      expect(dropLabel(r)).toBe('Panel 1 is locked. Unlock it to drop things on it.');
    }
    expect(resolveDrop(ld, locked, { kind: 'cast', id: 'c_ravi' }, { point: { x: 0.2, y: 0.12 }, ref: { kind: 'balloon', id: 'l1' } })).toEqual({ ok: false, reason: 'This balloon is locked. Unlock it to drop things on it.' });
    expect(resolveDrop(doc, drawn, { kind: 'cast', id: 'c_ravi' }, { point: { x: 0.005, y: 0.495 } })).toEqual({ ok: false, reason: 'Drop Ravi on a panel.' });
    expect(resolveDrop(doc, drawn, { kind: 'lettering', lineKind: 'caption' }, { point: { x: 0.005, y: 0.495 } })).toEqual({ ok: false, reason: 'Drop it inside a panel.' });
    // An image this comic does not have refuses (the server only places its own images).
    expect(resolveDrop(doc, drawn, { kind: 'image', path: 'elsewhere/x.png' }, frameTarget)).toEqual({ ok: false, reason: 'Add the image to this comic first (upload it), then place it.' });
    expect(ASSET).toBeTruthy();
  });
});
