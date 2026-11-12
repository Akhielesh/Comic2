// @vitest-environment node
// PE-SERVER (master plan §2.3 "Hashing and publication"; carry notes PE-0 3): the public snapshot and the content
// fingerprint learn the Pro Edit fields. publicLayers skips a layer of a kind this build does not know (opaque), copies an
// effect's numbers (`fx`), a library sticker's reference (`src.lib`: same-origin, nothing copied to pub/) and `blend`;
// publicMotion drops clips aimed at a guide-only overlay; layoutGeometryOf counts fx, blend, src.lib and the page's motion,
// so republishing sees an effect, blend or animation edit; a comic without any of them keeps its snapshot and fingerprint.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComicDoc, MotionClip, Page, PageLayer } from '../../../../shared/comic/doc.js';
import { buildSnapshot, contentFingerprint, layoutGeometryOf, planSnapshot, publicLayers, publicMotion, snapshotPaths } from './snapshot.js';
import { legacyPublishedDoc } from './__fixtures__/ship2Books.js';

const GOLDEN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '__fixtures__/legacy-snapshot.golden.json'), 'utf8'));
const KEY = 'K'.repeat(22);
const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const FX = { gen: 'speed-lines', v: 1, seed: 7, params: { count: 24, color: '#111111' } };
const LIB = { pack: 'fluent', id: 'star', v: '1' };
const snap = (doc: ComicDoc) => {
  const plan = { ...planSnapshot(doc, { assetKey: KEY, pageIds: doc.pages.map((p) => p.id), includeCover: true, languages: ['en'] }), publicationId: 'pub-fx', publishedAt: 77, rev: 9 };
  return { plan, snapshot: buildSnapshot(doc, plan) };
};
const clip = (id: string, target: MotionClip['target'], over: Partial<MotionClip> = {}): MotionClip => ({ id, target, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 }, ...over });

/** The legacy comic with Pro Edit data on page 1: an effect, a sticker, a blended shape, guide-only ones, an opaque layer
 *  that happens to carry a shape, a styled frame border, a named style on a line, and motion aimed at all of them. */
const proDoc = (): ComicDoc => {
  const doc = legacyPublishedDoc();
  const p1 = doc.pages[0];
  const layers: PageLayer[] = [
    { id: 'ly_fx', kind: 'effect', box, fx: JSON.parse(JSON.stringify(FX)), blend: 'screen' },
    { id: 'ly_star', kind: 'image', box, src: { lib: { ...LIB }, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
    { id: 'ly_box', kind: 'shape', box, shape: { type: 'rect' }, blend: 'multiply' },
    { id: 'ly_guide_fx', kind: 'effect', box, fx: JSON.parse(JSON.stringify(FX)), print: false },
    { id: 'ly_future', kind: 'hologram', box, shape: { type: 'rect' } } as unknown as PageLayer
  ];
  const page: Page = {
    ...p1,
    panels: p1.panels.map((pn, j) => ({
      ...pn,
      ...(j === 0 ? { frame: { box: { x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, border: { w: 0.006, style: 'rough' as const, seed: 42 } } } : {}),
      lines: pn.lines.map((l) => (j === 1 ? { ...l, styleId: 'st_villain' } : l))
    })),
    layers,
    motion: {
      clips: [
        clip('mc_line', { k: 'line', id: 'ln_1_1' }),
        clip('mc_panel', { k: 'panel', id: 'pn_1_2' }, { role: 'emphasis', preset: 'shake' }),
        clip('mc_fx', { k: 'layer', id: 'ly_fx' }, { role: 'loop', preset: 'speed-line-scroll' }),
        clip('mc_guide', { k: 'layer', id: 'ly_guide_fx' }),
        clip('mc_future', { k: 'layer', id: 'ly_future' }),
        clip('mc_gone', { k: 'line', id: 'ln_9_9' })
      ],
      camera: [{ panelId: 'pn_1_1', move: 'push' }, { panelId: 'pn_9_9', move: 'pull' }],
      hold: 400
    }
  };
  doc.pages = [page, doc.pages[1]];
  doc.letterStyle = { presetId: 'classic', named: { st_villain: { name: 'Villain', patch: { italic: true } } } };
  return doc;
};

describe('publicLayers', () => {
  it('skips a layer of a kind this build does not know, even one carrying a shape (it would publish as a shape of an unknown kind)', () => {
    const { plan } = snap(proDoc());
    const ids = publicLayers(proDoc().pages[0].layers, plan).map((l) => l.id);
    expect(ids).not.toContain('ly_future');
    expect(ids).toEqual(['ly_fx', 'ly_star', 'ly_box']);
  });

  it("copies an effect's fx, a sticker's library reference (nothing copied to pub/) and blend; guide-only ones never go out", () => {
    const doc = proDoc();
    const { plan, snapshot } = snap(doc);
    expect(snapshot.pages[0].layers).toEqual([
      { id: 'ly_fx', kind: 'effect', box, fx: FX, blend: 'screen' },
      { id: 'ly_star', kind: 'image', box, src: { lib: LIB, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } },
      { id: 'ly_box', kind: 'shape', box, shape: { type: 'rect' }, blend: 'multiply' }
    ]);
    // A library sticker is a same-origin /library/… file: no copy is planned and no storage path is published for it.
    expect(Object.keys(plan.paths).some((p) => p.includes('star') || p.includes('library'))).toBe(false);
    expect(snapshotPaths(snapshot).some((p) => p.includes('star'))).toBe(false);
  });

  it('a malformed effect or sticker reference is left out rather than published', () => {
    const doc = proDoc();
    doc.pages[0].layers = [
      { id: 'ly_badfx', kind: 'effect', box, fx: { gen: 'Not An Id', v: 1, seed: 1, params: {} } },
      { id: 'ly_badlib', kind: 'image', box, src: { lib: { pack: '../etc', id: 'x', v: '1' } } }
    ];
    expect(snap(doc).snapshot.pages[0].layers).toBeUndefined();
  });
});

describe('publicMotion', () => {
  it('drops clips aimed at a guide-only, opaque or missing target, and camera moves of panels not on the page', () => {
    const doc = proDoc();
    const { snapshot } = snap(doc);
    expect(snapshot.pages[0].motion).toEqual({
      clips: [clip('mc_line', { k: 'line', id: 'ln_1_1' }), clip('mc_panel', { k: 'panel', id: 'pn_1_2' }, { role: 'emphasis', preset: 'shake' }), clip('mc_fx', { k: 'layer', id: 'ly_fx' }, { role: 'loop', preset: 'speed-line-scroll' })],
      camera: [{ panelId: 'pn_1_1', move: 'push' }],
      hold: 400
    });
    expect(publicMotion(doc.pages[0], [])!.clips.map((c) => c.id)).toEqual(['mc_line', 'mc_panel']);
    expect(publicMotion({ ...doc.pages[0], motion: { clips: [clip('mc_guide', { k: 'layer', id: 'ly_guide_fx' })] } }, [])).toBeUndefined();
    // A page without motion has no motion key.
    expect(snapshot.pages[1]).not.toHaveProperty('motion');
  });
});

describe('frames and lines', () => {
  it("a frame's border look and a line's named style go out (readers draw them as the studio does)", () => {
    const { snapshot } = snap(proDoc());
    expect(snapshot.pages[0].panels[0].frame!.border).toEqual({ w: 0.006, style: 'rough', seed: 42 });
    expect(snapshot.pages[0].panels[1].lines[0].styleId).toBe('st_villain');
    expect(snapshot.pages[0].panels[0].lines[0]).not.toHaveProperty('styleId');
    expect(snapshot.letterStyle!.named).toEqual({ st_villain: { name: 'Villain', patch: { italic: true } } });
  });
});

describe('the content fingerprint ("changes since publishing")', () => {
  const fp = (doc: ComicDoc) => contentFingerprint(doc, ['en']);
  const edit = (fn: (page: Page) => void): ComicDoc => {
    const doc = proDoc();
    fn(doc.pages[0]);
    return doc;
  };

  it('a comic without Pro Edit data keeps its fingerprint and its snapshot', () => {
    expect(fp(legacyPublishedDoc())).toBe(GOLDEN.fingerprint);
    expect(snap(legacyPublishedDoc()).snapshot).toEqual(GOLDEN.snapshot);
  });

  it('an effect param change, a blend, a sticker and an animation edit each alter layoutGeometryOf and the fingerprint', () => {
    const base = proDoc();
    const geometry = layoutGeometryOf(base.pages[0]);
    const changes: [string, ComicDoc][] = [
      ['effect param', edit((p) => (p.layers![0].fx!.params.count = 30))],
      ['effect seed', edit((p) => (p.layers![0].fx!.seed = 8))],
      ['blend', edit((p) => (p.layers![2].blend = 'overlay'))],
      ['blend cleared', edit((p) => delete p.layers![2].blend)],
      ['sticker', edit((p) => (p.layers![1].src = { lib: { ...LIB, id: 'moon' } }))],
      ['clip', edit((p) => (p.motion!.clips[0].at.ms = 500))],
      ['camera', edit((p) => (p.motion!.camera = [{ panelId: 'pn_1_1', move: 'pull' }]))],
      ['hold', edit((p) => (p.motion!.hold = 900))],
      ['border look', edit((p) => (p.panels[0].frame!.border!.style = 'wavy'))],
      ['named style', edit((p) => (p.panels[1].lines[0].styleId = 'st_radio'))]
    ];
    for (const [what, doc] of changes) {
      if (what !== 'named style') expect(layoutGeometryOf(doc.pages[0]), what).not.toEqual(geometry);
      expect(fp(doc), what).not.toBe(fp(base));
    }
  });

  it('what readers never see does not move it: a guide-only effect, a clip aimed at it, an opaque layer', () => {
    const base = proDoc();
    const same: [string, ComicDoc][] = [
      ['guide-only effect param', edit((p) => (p.layers![3].fx!.params.count = 99))],
      ['clip on a guide-only effect', edit((p) => (p.motion!.clips[3].at.ms = 900))],
      ['opaque layer', edit((p) => ((p.layers![4] as unknown as Record<string, unknown>).hue = 'teal'))]
    ];
    for (const [what, doc] of same) expect(fp(doc), what).toBe(fp(base));
  });

  it('a page with motion and nothing else from Ship 2 has a layout geometry (an animation-only edit is a change)', () => {
    const doc = legacyPublishedDoc();
    expect(layoutGeometryOf(doc.pages[1])).toBeUndefined();
    doc.pages[1] = { ...doc.pages[1], motion: { clips: [clip('mc_a', { k: 'line', id: 'ln_2_1' })] } };
    expect(layoutGeometryOf(doc.pages[1])).toBeDefined();
    expect(fp(doc)).not.toBe(GOLDEN.fingerprint);
  });
});
