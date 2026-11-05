import { describe, expect, it } from 'vitest';
import type { Page, PageLayer } from '../doc.js';
import { EDITOR_LIMITS } from '../limits.js';
import { apply, baseDoc, drawnPage, line, pageOf, panel, withPages } from './__fixtures__/editorDoc.js';
import { i18nOf } from '../i18n.js';
import { alignBoxes, alignEdit, distributeBoxes, distributeEdit, DISTRIBUTE_LOCKED } from './align.js';
import { readingOrderOf } from './readingOrder.js';
import { BANDS, buildScene, objectAt, zOrderEdit, type EditOk } from './scene.js';
import { clampRot, EDITION_HEIGHT_SHARED, resizeBox, rotateEdit, rotationFromPointer, setBoxEdit } from './transform.js';

const shape = (id: string, box: PageLayer['box'], extra: Partial<PageLayer> = {}): PageLayer => ({ id, kind: 'shape', box, shape: { type: 'rect' }, ...extra });
const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));

const fixture = () => {
  const page: Page = {
    ...drawnPage('pg_a', 1, 'two-tiers', [panel('p1', 1, [line('l1', 'Hello there.', 'speech', 'c_maya')]), panel('p2', 2, [line('l2', 'Later', 'caption')])], {
      balloons: [
        { lineId: 'l1', x: 0.1, y: 0.1, w: 0.25, z: -100, pinned: true },
        { lineId: 'l2', x: 0.5, y: 0.55, w: 0.3, pinned: true }
      ]
    }),
    layers: [shape('ly_top', { x: 0.2, y: 0.2, w: 0.3, h: 0.2 }, { z: 100 }), shape('ly_in', { x: 0.1, y: 0.6, w: 0.2, h: 0.2 }, { clip: 'p2' }), shape('ly_lock', { x: 0.6, y: 0.7, w: 0.2, h: 0.1 }, { locked: true })]
  };
  const doc = withPages(baseDoc(), [page]);
  return { doc, page };
};

describe('scene and bands', () => {
  it('draws page → frames (each with its clipped overlays) → page overlays → lettering, whatever the z', () => {
    const { doc, page } = fixture();
    const scene = buildScene(doc, page);
    expect(scene.objects.map((o) => `${o.band}:${o.kind}:${o.id}`)).toEqual([
      '0:page:pg_a',
      '1:frame:p1',
      '1:frame:p2',
      '1:overlay:ly_in',
      '2:overlay:ly_lock',
      '2:overlay:ly_top',
      '3:balloon:l1',
      '3:balloon:l2'
    ]);
    // A z of 100 on a sticker never lifts it over lettering at z −100.
    expect(BANDS.lettering).toBeGreaterThan(BANDS.overlays);
    expect(scene.objects.find((o) => o.id === 'ly_in')!.clip).toEqual(page.panels[1].frame!.box);
    expect(scene.objects.find((o) => o.id === 'l1')!.label).toBe('Balloon: “Hello there.”');
    // Hits: topmost first; a clipped overlay only inside its frame.
    expect(objectAt(scene, { x: 0.15, y: 0.12 })!.id).toBe('l1');
    expect(objectAt(scene, { x: 0.3, y: 0.3 })!.id).toBe('ly_top');
  });

  it('z moves stay inside the band', () => {
    const { doc, page } = fixture();
    const r = zOrderEdit(doc, page, { kind: 'overlay', id: 'ly_lock' }, 'front');
    expect(r).toEqual({ ok: false, reason: 'Rectangle is locked. Unlock it to change it.' });
    const back = zOrderEdit(doc, page, { kind: 'overlay', id: 'ly_top' }, 'back') as EditOk;
    expect(back.ops).toEqual([{ op: 'layer', pageId: 'pg_a', id: 'ly_top', patch: { z: -1 } }]);
    const front = zOrderEdit(doc, page, { kind: 'balloon', id: 'l1' }, 'front') as EditOk;
    expect(front.ops).toEqual([{ op: 'balloon', pageId: 'pg_a', lineId: 'l1', patch: { z: 1 } }]);
  });
});

describe('transforms', () => {
  it('resizes from any handle, keeps the opposite edge, the minimum and the aspect', () => {
    const b = { x: 0.2, y: 0.2, w: 0.2, h: 0.1 };
    expect(resizeBox(b, 'e', 0.1, 0)).toEqual({ x: 0.2, y: 0.2, w: 0.3, h: 0.1 });
    expect(resizeBox(b, 'nw', 0.05, 0.02)).toEqual({ x: 0.25, y: 0.22, w: 0.15, h: 0.08 });
    expect(resizeBox(b, 'w', 0.5, 0, { minW: 0.04 })).toEqual({ x: 0.36, y: 0.2, w: 0.04, h: 0.1 });
    expect(resizeBox(b, 'se', 0.2, 0, { keepAspect: true })).toEqual({ x: 0.2, y: 0.2, w: 0.4, h: 0.2 });
    expect(resizeBox(b, 'e', 2, 0)).toEqual({ x: 0.2, y: 0.2, w: 0.8, h: 0.1 });
  });

  it('rotates with detents and limits', () => {
    expect(rotationFromPointer({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.2 }, { aspect: 2 / 3, limit: 180 })).toBe(0);
    expect(rotationFromPointer({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }, { aspect: 2 / 3, limit: 180 })).toBe(90);
    expect(rotationFromPointer({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }, { aspect: 2 / 3, limit: EDITOR_LIMITS.balloonRot })).toBe(45);
    expect(rotationFromPointer({ x: 0.5, y: 0.5 }, { x: 0.53, y: 0.2 }, { aspect: 2 / 3, limit: 180, snap: true })).toBe(0);
    expect(clampRot(200, 180)).toBe(-160);
  });

  it('commits a balloon move, width and height handle; overlays take their box; locks refuse', () => {
    const { doc, page } = fixture();
    const scene = buildScene(doc, page);
    const b = scene.objects.find((o) => o.id === 'l1')!;
    const r = setBoxEdit(doc, page, { kind: 'balloon', id: 'l1' }, { ...b.box, x: b.box.x + 0.1, w: b.box.w + 0.05, h: b.box.h + 0.05 }, scene) as EditOk;
    expect(r.label).toBe('Resize balloon');
    expect(r.ops).toEqual([{ op: 'balloon', pageId: 'pg_a', lineId: 'l1', patch: { x: 0.2, y: 0.1, pinned: true, w: 0.3, minH: Math.round((b.box.h + 0.05) * 10000) / 10000 } }]);
    expect(strip(apply(apply(doc, r.ops), r.undo))).toEqual(strip(doc));
    const o = setBoxEdit(doc, page, { kind: 'overlay', id: 'ly_top' }, { x: 0.25, y: 0.2, w: 0.3, h: 0.2 }, scene) as EditOk;
    expect(o.ops).toEqual([{ op: 'layer', pageId: 'pg_a', id: 'ly_top', patch: { box: { x: 0.25, y: 0.2, w: 0.3, h: 0.2 } } }]);
    expect(setBoxEdit(doc, page, { kind: 'overlay', id: 'ly_lock' }, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, scene)).toEqual({ ok: false, reason: 'Rectangle is locked. Unlock it to change it.' });
    expect(rotateEdit(doc, page, { kind: 'frame', id: 'p1' }, 10).ok).toBe(false);
    const rot = rotateEdit(doc, page, { kind: 'balloon', id: 'l1' }, 80) as EditOk;
    expect(rot.ops).toEqual([{ op: 'balloon', pageId: 'pg_a', lineId: 'l1', patch: { rot: 45, pinned: true } }]);
    expect(pageOf(apply(doc, rot.ops), 'pg_a').balloons[0].rot).toBe(45);
  });
});

describe('align and distribute', () => {
  it('aligns and spaces boxes', () => {
    const boxes = [
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { x: 0.4, y: 0.2, w: 0.2, h: 0.1 },
      { x: 0.3, y: 0.3, w: 0.1, h: 0.1 }
    ];
    expect(alignBoxes(boxes, 'left').map((b) => b.x)).toEqual([0.1, 0.1, 0.1]);
    expect(alignBoxes(boxes, 'right').map((b) => +(b.x + b.w).toFixed(4))).toEqual([0.6, 0.6, 0.6]);
    const d = distributeBoxes(boxes, 'h');
    expect(+(d[2].x - (d[0].x + d[0].w)).toFixed(4)).toBe(+(d[1].x - (d[2].x + d[2].w)).toFixed(4));
  });

  it('aligns balloons and overlays (locked ones anchor), refuses frames', () => {
    const { doc, page } = fixture();
    const r = alignEdit(doc, page, [{ kind: 'overlay', id: 'ly_top' }, { kind: 'overlay', id: 'ly_lock' }], 'left') as EditOk;
    expect(r.ops).toEqual([{ op: 'layer', pageId: 'pg_a', id: 'ly_top', patch: { box: { x: 0.6, y: 0.2, w: 0.3, h: 0.2 } } }]);
    expect(alignEdit(doc, page, [{ kind: 'frame', id: 'p1' }, { kind: 'frame', id: 'p2' }], 'left')).toEqual({ ok: false, reason: 'Panels tile the page. Use Equalize row or Equalize column instead.' });
    expect(distributeEdit(doc, page, [{ kind: 'overlay', id: 'ly_top' }], 'h').ok).toBe(false);
  });
});

describe('reading order', () => {
  it('reads a tall panel before its stack, and a right-hand tall panel after the top of its stack', () => {
    const tall = { x: 0.02, y: 0.02, w: 0.42, h: 0.96 };
    const top = { x: 0.46, y: 0.02, w: 0.52, h: 0.47 };
    const bottom = { x: 0.46, y: 0.51, w: 0.52, h: 0.47 };
    expect(readingOrderOf([bottom, tall, top])).toEqual([1, 2, 0]);
    const tallR = { ...tall, x: 0.56 };
    const topL = { ...top, x: 0.02 };
    const bottomL = { ...bottom, x: 0.02 };
    expect(readingOrderOf([topL, tallR, bottomL])).toEqual([0, 1, 2]);
    // Right to left: the right-hand panel of a row first.
    expect(readingOrderOf([{ x: 0.02, y: 0.02, w: 0.47, h: 0.47 }, { x: 0.51, y: 0.02, w: 0.47, h: 0.47 }], true)).toEqual([1, 0]);
    // Staggered balloons read the higher one first.
    expect(readingOrderOf([{ x: 0.1, y: 0.15, w: 0.2, h: 0.08 }, { x: 0.5, y: 0.1, w: 0.2, h: 0.08 }])).toEqual([1, 0]);
  });
});

describe('language editions', () => {
  /** A Hindi edition whose balloon for l1 sits elsewhere than the original's. */
  const editionDoc = () => {
    const { doc, page } = fixture();
    const d = apply(doc, [
      { op: 'edition', lang: 'hi', patch: { register: 'everyday' } },
      { op: 'edition_balloon', lang: 'hi', lineId: 'l1', patch: { x: 0.15, y: 0.12, w: 0.3 } }
    ]);
    return { doc: d, page: pageOf(d, page.id) };
  };

  it('a scene knows its edition (never the original language)', () => {
    const { doc, page } = editionDoc();
    expect(buildScene(doc, page, { lang: 'hi' }).lang).toBe('hi');
    expect(buildScene(doc, page, { lang: doc.format.language }).lang).toBeUndefined();
    expect(buildScene(doc, page).lang).toBeUndefined();
  });

  it('moving a balloon in an edition moves it for that language only; undo restores it', () => {
    const { doc, page } = editionDoc();
    const scene = buildScene(doc, page, { lang: 'hi' });
    const b = scene.objects.find((o) => o.id === 'l1')!;
    expect(b.text).toEqual({ x: 0.15, y: 0.12, w: 0.3 });
    const r = setBoxEdit(doc, page, { kind: 'balloon', id: 'l1' }, { ...b.box, x: b.box.x + 0.1, w: b.box.w + 0.05 }, scene) as EditOk;
    expect(r.ops).toEqual([{ op: 'edition_balloon', lang: 'hi', lineId: 'l1', patch: { x: 0.25, y: 0.12, pinned: true, w: 0.35 } }]);
    const after = apply(doc, r.ops);
    // The original language's balloon has not moved.
    expect(pageOf(after, 'pg_a').balloons).toEqual(page.balloons);
    expect(i18nOf(after).editions.hi.balloons.l1).toMatchObject({ x: 0.25, y: 0.12, w: 0.35 });
    expect(strip(apply(after, r.undo))).toEqual(strip(doc));
    // The height is one for every language.
    expect(setBoxEdit(doc, page, { kind: 'balloon', id: 'l1' }, { ...b.box, h: b.box.h + 0.05 }, scene)).toEqual({ ok: false, reason: EDITION_HEIGHT_SHARED });
    // Align in the edition writes the edition too.
    const aligned = alignEdit(doc, page, [{ kind: 'balloon', id: 'l1' }, { kind: 'balloon', id: 'l2' }], 'left', { scene }) as EditOk;
    expect(aligned.ops.every((o) => o.op === 'edition_balloon')).toBe(true);
  });
});

describe('distribute with locked objects', () => {
  const row = (lockedId?: string) => {
    const { doc, page } = fixture();
    const layers = [shape('ly_a', { x: 0.1, y: 0.4, w: 0.1, h: 0.05 }), shape('ly_b', { x: 0.25, y: 0.4, w: 0.1, h: 0.05 }), shape('ly_c', { x: 0.7, y: 0.4, w: 0.1, h: 0.05 })].map((l) =>
      l.id === lockedId ? { ...l, locked: true as const } : l
    );
    const p: Page = { ...page, layers };
    return { doc: withPages(doc, [p]), page: p };
  };
  const refs = [{ kind: 'overlay' as const, id: 'ly_a' }, { kind: 'overlay' as const, id: 'ly_b' }, { kind: 'overlay' as const, id: 'ly_c' }];

  it('a locked one in the middle refuses (the gaps could not come out even); at an end it stays put and the rest space evenly', () => {
    const mid = row('ly_b');
    expect(distributeEdit(mid.doc, mid.page, refs, 'h')).toEqual({ ok: false, reason: DISTRIBUTE_LOCKED });
    const end = row('ly_c');
    const r = distributeEdit(end.doc, end.page, refs, 'h') as EditOk;
    expect(r.ops).toEqual([{ op: 'layer', pageId: 'pg_a', id: 'ly_b', patch: { box: { x: 0.4, y: 0.4, w: 0.1, h: 0.05 } } }]);
  });
});
