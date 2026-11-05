import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { applyOps } from '../../../../shared/comic/ops';
import { lineSourceHash, localizeDoc } from '../../../../shared/comic/i18n';
import { formFactorFor } from '../useFormFactor';
import { makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import {
  coveredByBottomSheet,
  cycleToolsDetent,
  editionOps,
  editionViewDoc,
  editorImageWidth,
  editorLayoutFor,
  isEditionLang,
  nextToolsDetent,
  selectionOutOfView,
  swipeTurn,
  toolsSheetHeights,
  translationEditOp,
  turnTarget
} from './editorModel';

const NOW = 1_760_000_000_000;

/** The sample doc with a Telugu edition: two lines translated, one line moved in Telugu only. */
const withTelugu = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    const line = (id: string) => d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === id)!;
    d.i18n = {
      glossary: [],
      editions: {
        te: {
          lang: 'te',
          register: 'everyday',
          lines: {
            pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line('pg_1_l2')), at: NOW },
            pg_1_l4: { text: 'నువ్వు నాకు రుణపడి ఉన్నావు.', status: 'machine', sourceHash: lineSourceHash(line('pg_1_l4')), at: NOW }
          },
          balloons: {
            pg_1_l2: { x: 0.1, y: 0.52 },
            // pg_1_l4 has no stored source balloon (software-placed): Telugu moved it.
            pg_1_l4: { x: 0.3, y: 0.62, w: 0.33, pinned: true }
          }
        }
      }
    };
    mutate?.(d);
  });

describe('editorLayoutFor (mobile.md §5.6)', () => {
  it('phone portrait: bottom toolbar, tools in a bottom sheet, the inspector as a sheet', () => {
    const l = editorLayoutFor(formFactorFor({ w: 390, h: 844, coarse: true }));
    expect(l).toMatchObject({ kind: 'phone', tools: 'sheet', toolbar: 'bottom', fullBleed: true, compactInspector: true, filmstrip: 'tools' });
    expect(editorLayoutFor(formFactorFor({ w: 320, h: 640, coarse: true })).kind).toBe('phone');
    expect(editorLayoutFor(formFactorFor({ w: 344, h: 882, coarse: true })).kind).toBe('phone'); // Fold cover screen
  });

  it('phone landscape: a left rail and a 320 px side sheet; the inspector floats', () => {
    const l = editorLayoutFor(formFactorFor({ w: 844, h: 390, coarse: true }));
    expect(l).toMatchObject({ kind: 'phone-landscape', tools: 'side', toolbar: 'rail', toolsWidth: 320, compactInspector: false });
    expect(editorLayoutFor(formFactorFor({ w: 734, h: 343, coarse: true })).kind).toBe('phone-landscape');
  });

  it('tablet portrait: mode row on top, tools in a bottom sheet', () => {
    expect(editorLayoutFor(formFactorFor({ w: 820, h: 1180, coarse: true }))).toMatchObject({ kind: 'tablet-portrait', tools: 'sheet', toolbar: 'top', fullBleed: true });
    expect(editorLayoutFor(formFactorFor({ w: 1024, h: 1366, coarse: true })).kind).toBe('tablet-portrait'); // iPad Pro portrait
    // A tall desktop window with a mouse keeps the aside once it is wide enough.
    expect(editorLayoutFor(formFactorFor({ w: 1100, h: 1300, coarse: false })).kind).toBe('desktop');
  });

  it('tablet landscape and desktop: the aside (360, 400 from 1200); inset with a backdrop from 1024', () => {
    expect(editorLayoutFor(formFactorFor({ w: 1180, h: 820, coarse: true }))).toMatchObject({ kind: 'desktop', tools: 'aside', toolsWidth: 360, fullBleed: false });
    expect(editorLayoutFor(formFactorFor({ w: 1440, h: 900 }))).toMatchObject({ kind: 'desktop', toolsWidth: 400, fullBleed: false });
    expect(editorLayoutFor(formFactorFor({ w: 900, h: 700 }))).toMatchObject({ kind: 'desktop', toolsWidth: 360, fullBleed: true });
  });

  it('foldables: book posture splits columns at the hinge; tabletop splits rows', () => {
    const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRectReadOnly;
    const book = editorLayoutFor(
      formFactorFor({ w: 1688, h: 1080, coarse: true, segments: { count: 2, axis: 'horizontal', rects: [rect(0, 0, 828, 1080), rect(860, 0, 828, 1080)], hinge: { start: 828, end: 860 } } })
    );
    expect(book).toMatchObject({ kind: 'fold-book', tools: 'segment', split: { axis: 'columns', first: 828, gap: 32 }, toolsWidth: 828 });
    const table = editorLayoutFor(formFactorFor({ w: 720, h: 1500, coarse: true, segments: { count: 2, axis: 'vertical', rects: [], hinge: { start: 730, end: 760 } } }));
    expect(table).toMatchObject({ kind: 'fold-tabletop', split: { axis: 'rows', first: 730, gap: 30 } });
    // Media-query-only segments (no rects): an even split.
    expect(editorLayoutFor(formFactorFor({ w: 1600, h: 900, coarse: true, segments: { count: 2, axis: 'horizontal', rects: [] } })).split).toEqual({ axis: 'columns', first: 800, gap: 0 });
  });
});

describe('tools sheet detents', () => {
  it('peek ≥ 208 px (≈ 30 %), half 50 %, full = the whole body', () => {
    expect(toolsSheetHeights(636)).toEqual({ peek: 208, half: 318, full: 636 });
    expect(toolsSheetHeights(1000)).toEqual({ peek: 300, half: 500, full: 1000 });
    expect(toolsSheetHeights(150)).toEqual({ peek: 150, half: 150, full: 150 });
    expect(toolsSheetHeights(0)).toEqual({ peek: 0, half: 0, full: 0 });
  });

  it('snaps a released drag by velocity; dismisses only when allowed', () => {
    expect(nextToolsDetent(300, 0, 636, true)).toBe('half');
    expect(nextToolsDetent(600, 0, 636, true)).toBe('full');
    expect(nextToolsDetent(220, -900, 636, true)).toBe('half'); // flick up from peek
    expect(nextToolsDetent(200, 900, 636, true)).toBeNull(); // flick down below peek closes
    expect(nextToolsDetent(200, 900, 636, false)).toBe('peek'); // tablets keep it
    expect(cycleToolsDetent('peek')).toBe('half');
    expect(cycleToolsDetent('full')).toBe('peek');
  });
});

describe('editorImageWidth (contract §13.4 variants)', () => {
  const phone = formFactorFor({ w: 390, h: 844, coarse: true });
  const desktop = formFactorFor({ w: 1440, h: 900 });
  it('phones at fit ask for ≤ 1080w (divided by the capped DPR); tablets/desktop and zoom > 1.6 get the original', () => {
    expect(editorImageWidth(phone, 1, 360, 3)).toBe(360);
    expect(editorImageWidth(phone, 1, 900, 2)).toBe(540); // 540 css × 2 = the 1080w variant, never the original
    expect(editorImageWidth(desktop, 1, 700, 2)).toBeUndefined();
    expect(editorImageWidth(phone, 2, 360, 2)).toBeUndefined();
  });
  it('saveData: 480w, 1080w once zoomed', () => {
    const save = { ...phone, saveData: true };
    expect(editorImageWidth(save, 1, 360, 2)).toBe(240);
    expect(editorImageWidth(save, 2, 360, 2)).toBe(360);
  });
});

describe('editing a translated edition', () => {
  it('only a real edition counts (never the source language)', () => {
    const doc = withTelugu();
    expect(isEditionLang(doc, 'te')).toBe(true);
    expect(isEditionLang(doc, doc.format.language)).toBe(false);
    expect(isEditionLang(doc, 'hi')).toBe(false);
    expect(isEditionLang(doc, null)).toBe(false);
  });

  it('the edition view shows the translation and applies the edition positions — also for software-placed lines', () => {
    const doc = withTelugu();
    const view = editionViewDoc(doc, 'te');
    const page = view.pages[0];
    const text = (id: string) => page.panels.flatMap((p) => p.lines).find((l) => l.id === id)!.text;
    expect(text('pg_1_l2')).toBe('పదండి!');
    expect(view.format.language).toBe('te');
    expect(page.balloons.find((b) => b.lineId === 'pg_1_l2')).toMatchObject({ x: 0.1, y: 0.52, w: 0.22 });
    expect(page.balloons.find((b) => b.lineId === 'pg_1_l4')).toEqual({ lineId: 'pg_1_l4', x: 0.3, y: 0.62, w: 0.33, pinned: true });
    // The source doc is untouched.
    expect(doc.pages[0].balloons.find((b) => b.lineId === 'pg_1_l4')).toBeUndefined();
    expect(editionViewDoc(doc, doc.format.language)).toBe(doc);
  });

  it('the edition view IS the reader’s localized doc (one implementation: clamps, fontScale, reading order)', () => {
    const doc = withTelugu((d) => {
      // Out-of-range geometry and a font scale on a software-placed line: the reader clamps both.
      d.i18n!.editions.te.balloons.pg_1_l4 = { x: 1.4, y: -0.2, w: 1.6, fontScale: 2, tailX: 0.5, tailY: 1.2, pinned: true };
    });
    const view = editionViewDoc(doc, 'te');
    expect(view).toEqual(localizeDoc(doc, 'te'));
    expect(view.pages[0].balloons.find((b) => b.lineId === 'pg_1_l4')).toMatchObject({ x: 1, y: 0, w: 1, tailX: 0.5, tailY: 1, pinned: true });
    // No edition for this language: the doc itself.
    expect(editionViewDoc(doc, 'hi')).toBe(doc);
  });

  it('balloon geometry becomes edition_balloon; stacking/lock stay on a stored source balloon only', () => {
    const doc = withTelugu();
    const { ops, dropped } = editionOps(
      [
        { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.12, y: 0.5, w: 0.25, pinned: true } },
        { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { z: 3, locked: true } },
        { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l4', patch: { z: 2 } }
      ],
      'te',
      doc
    );
    expect(ops).toEqual([
      { op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l2', patch: { x: 0.12, y: 0.5, w: 0.25, pinned: true } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { z: 3, locked: true } }
    ]);
    expect(dropped).toBe(1); // pg_1_l4 has no stored source balloon: inventing one would move the original
  });

  it('Tidy in an edition re-places that language only; typed text becomes a translation; structure is dropped', () => {
    const doc = withTelugu();
    const { ops, dropped } = editionOps(
      [
        { op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'pg_1_l1', x: 0.05, y: 0.05, w: 0.3, pinned: false }] },
        { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: '  కొత్త వాక్యం  ' } },
        { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { kind: 'shout' } },
        { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l5', patch: null },
        { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffd84a' } }
      ],
      'te',
      doc,
      NOW
    );
    expect(ops[0]).toEqual({ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l1', patch: { x: 0.05, y: 0.05, w: 0.3 } });
    const line4 = doc.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l4')!;
    expect(ops[1]).toEqual({ op: 'translation', lang: 'te', lineId: 'pg_1_l4', patch: { text: 'కొత్త వాక్యం', status: 'edited', sourceHash: lineSourceHash(line4), at: NOW } });
    expect(ops[2]).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffd84a' } });
    expect(dropped).toBe(2);
    // The ops apply cleanly (optimistic doc == what the server commits) and never touch the source text.
    const after = applyOps(doc, ops as DocOp[]);
    expect(after.i18n?.editions.te.lines.pg_1_l4.text).toBe('కొత్త వాక్యం');
    expect(after.i18n?.editions.te.balloons.pg_1_l1).toEqual({ x: 0.05, y: 0.05, w: 0.3 });
    expect(after.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l4')!.text).toBe(line4.text);
  });

  it('a first translation of an untranslated line carries every field the doc needs', () => {
    const doc = withTelugu();
    const op = translationEditOp(doc, 'te', 'pg_1', 'pg_1_l1', 'హైదరాబాద్, 1999', NOW)!;
    const after = applyOps(doc, [op]);
    expect(after.i18n?.editions.te.lines.pg_1_l1).toMatchObject({ text: 'హైదరాబాద్, 1999', status: 'edited', at: NOW });
    expect(translationEditOp(doc, 'te', 'pg_1', 'pg_1_l1', '   ')).toBeNull();
    expect(translationEditOp(doc, 'te', 'pg_1', 'nope', 'x')).toBeNull();
  });

  it('a "don’t translate" line never gets a translation (every edition draws its original), so an edit there is dropped', () => {
    const doc = withTelugu((d) => {
      d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l1')!.noTranslate = true;
    });
    expect(translationEditOp(doc, 'te', 'pg_1', 'pg_1_l1', 'హైదరాబాద్', NOW)).toBeNull();
    const r = editionOps([{ op: 'line', pageId: 'pg_1', panelId: doc.pages[0].panels.find((p) => p.lines.some((l) => l.id === 'pg_1_l1'))!.id, id: 'pg_1_l1', patch: { text: 'హైదరాబాద్' } }], 'te', doc, NOW);
    expect(r).toEqual({ ops: [], dropped: 1 });
  });
});

describe('gestures and sheets', () => {
  it('a header swipe ≥ 60 px, mostly horizontal, turns the page (reversed for right-to-left books)', () => {
    expect(swipeTurn(-80, 10)).toBe(1);
    expect(swipeTurn(80, 10)).toBe(-1);
    expect(swipeTurn(-50, 0)).toBe(0);
    expect(swipeTurn(-80, 70)).toBe(0);
    expect(swipeTurn(-80, 10, true)).toBe(-1);
    const doc = makeSampleDoc();
    expect(turnTarget(doc.pages, 'pg_2', 1)?.id).toBe('pg_3');
    expect(turnTarget(doc.pages, 'pg_1', -1)).toBeUndefined();
    expect(turnTarget(doc.pages, 'pg_1', 0)).toBeUndefined();
  });

  it('how much a bottom sheet covers the stage, and whether a selection left the view', () => {
    expect(coveredByBottomSheet(700, 460)).toBe(240);
    expect(coveredByBottomSheet(400, 460)).toBe(0);
    const view = { top: 50, bottom: 460, left: 0, right: 390 };
    expect(selectionOutOfView({ top: 300, bottom: 400, left: 20, right: 200 }, view)).toBe(false);
    expect(selectionOutOfView({ top: 470, bottom: 520, left: 20, right: 200 }, view)).toBe(true); // under the sheet
    // A big balloon that overhangs a zoomed view is still "in view" (its centre is visible).
    expect(selectionOutOfView({ top: 0, bottom: 600, left: -100, right: 500 }, view)).toBe(false);
    expect(selectionOutOfView(null, view)).toBe(false);
  });
});
