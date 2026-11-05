// @vitest-environment node
// Pro Edit contract (master plan §2.3, §2.10, §2.12 PE-0). Owner sign-off D5 is pending, so the contract is additive and
// invisible: every stored fixture normalizes to the object it did before PE-0 (goldens captured on f9ed104a), no spec
// hash moves, no client can write a Pro op, and nothing renders. These pin the object model, the ops and their exact
// inverses, the duplicate remaps, inert dangling targets, the opaque passthrough, the history words, the flags and the
// "free, never paid" rule.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as comic from './index';
import {
  coverSpecHash,
  isKnownLayerKind,
  isOpaqueLayer,
  knownLayersOf,
  layersOf,
  motionClipsOf,
  normalizeDoc,
  normalizeCameraMoves,
  normalizeLayerFx,
  normalizeMotionClip,
  normalizeOpaqueLayer,
  normalizePageLayer,
  normalizePageLayers,
  normalizePageMotion,
  pageSpecHash,
  pickReader,
  placeSpecHash,
  planInputHashOf,
  sheetSpecHash,
  stableStringify,
  hashString,
  type Box,
  type ComicDoc,
  type PageLayer,
  type PageMotion
} from './doc';
import {
  CLIENT_PATCHABLE_OPS,
  INVERTIBLE_OPS,
  KNOWN_DOC_OPS,
  NON_SPEND_ACTION_TYPES,
  PRO_EDIT_OPS,
  PRO_EDIT_OPS_PATCHABLE,
  SERVER_ONLY_OPS,
  SPEND_ACTION_TYPES,
  applyOp,
  isKnownDocOp,
  type DocOp
} from './ops';
import { describeOps, inverseOps, isUndoable } from './undo';
import { DOC_LIMITS, FX_LIMITS, MOTION_LIMITS, PRO_LETTER_LIMITS } from './limits';
import {
  BUBBLE_SHAPES,
  PRO_BUBBLE_SHAPES,
  PRO_LETTER_DEFAULTS,
  PRO_SFX_EFFECTS,
  SFX_EFFECTS,
  proLetterOf,
  resolveLetterStyle,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyle
} from './lettering/style';
import { PRO_FONT_IDS, isProFontId } from './lettering/proFonts';
import { FX_GENERATORS, fxName, fxParamsOf, renderFx } from './fx/index';
import { FX_NAMES, fxName as fxNameOnly } from './fx/names';
import { MOTION_PRESET_IDS, CAMERA_MOVE_IDS, motionPresetWord } from './motion/index';
import { libAssetUrl, normalizeAssetLibRef } from './assets/index';
import { PRO_EDIT_PARTS, PRO_FREE_FOOTER } from './pro/index';
import {
  DEFAULT_CAPS,
  PRO_FLAG_DEFAULTS,
  PRO_FLAG_ENV,
  proCapsFromEnv,
  proMotionOn,
  proStickersOn,
  readerMotionOn,
  readerMotionStage,
  resolveStudioCaps
} from './capabilities';
import { AI_ACTIONS, opActor, touchedKeys } from './history/touched';
import { describeChanges, panelMomentsOfOps, proEditLabel } from './history/describe';
import { SECTION_KEYS } from './history/sections';
import { buildScene, layerWord } from './editor/scene';
import { historyEmptyDoc, historyV4Doc, historyV5Doc } from './history/__fixtures__/books';
import { randomBook } from './history/__fixtures__/random';
import { compatBooks } from './__fixtures__/planCompat';
import { baseDoc } from './editor/__fixtures__/editorDoc';
import { part as composePart } from '../../components/comicstudio/compose/index';
import { part as renderPart } from '../../components/comicstudio/render/index';
import { part as kitPart } from '../../components/comicstudio/editor/kit/index';
import { part as inspectorPart } from '../../components/comicstudio/editor/inspector/index';
import { part as layersPart } from '../../components/comicstudio/editor/layers/index';
import { part as assetsPart } from '../../components/comicstudio/editor/assets/index';
import { part as animatePart } from '../../components/comicstudio/editor/animate/index';
import { part as stagePart } from '../../components/comicstudio/editor/stage/index';

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const bx = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
/** Apply ops without stamping updatedAt (applyOps would), so before/after compare exactly. */
const apply = (doc: ComicDoc, ops: DocOp[]): ComicDoc => ops.reduce(applyOp, doc);
const norm = (make: () => ComicDoc): ComicDoc => normalizeDoc(json(make()));
const fingerprint = (d: ComicDoc): string => hashString(stableStringify(d));
/** Postgres jsonb reorders object keys on save: reload a doc the way the server would. */
const jsonbOrder = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, jsonbOrder(x)])) : v;
const specHashes = (d: ComicDoc) => ({
  pages: d.pages.map((p) => pageSpecHash(d, p)),
  sheets: d.cast.map((c) => sheetSpecHash(d, c)),
  places: d.places.map((p) => placeSpecHash(d, p)),
  cover: coverSpecHash(d),
  plan: planInputHashOf(d)
});

// ── Goldens: the normalized-doc fingerprint and the page spec hashes of every stored fixture, captured on the base
//    (f9ed104a) before any PE-0 code existed. ──
const STORED: Record<string, { make: () => ComicDoc; norm: string; pages: string[] }> = {
  v4: { make: historyV4Doc, norm: '6da9d578', pages: ['e4ad3dae', '78c45272', '6dda590e', 'c2ceaab5', 'a07596b1'] },
  v5: { make: historyV5Doc, norm: '73b6edb8', pages: ['ef2237d9', '81f85b58', 'e7462403', 'e940374a', '8ae0118d', 'e653234c'] },
  empty: { make: historyEmptyDoc, norm: '0ff1d1f1', pages: [] },
  editor: { make: baseDoc, norm: 'fc7e5287', pages: [] },
  random1: { make: () => randomBook(1), norm: '0a270910', pages: ['7b65d84d'] },
  random7: { make: () => randomBook(7), norm: 'b500c97c', pages: ['65a7bd23', '1f50db21'] },
  random42: { make: () => randomBook(42), norm: '4e36403a', pages: ['99b6e87e', '2c7f6706'] },
  ...(() => {
    const books = compatBooks();
    const golden: Record<string, [string, string[]]> = {
      planned: ['b97b2f95', ['d9434364', '4ef2d35a', '52732f35']],
      drawn: ['18f0620b', ['314e34f4', 'c26f9da1', '9d395759']],
      mixed: ['c483cc91', ['d9434364', '4ef2d35a', '52732f35', 'a6abb4fa']],
      overfull: ['dfe084d8', ['d9434364', '4ef2d35a', '52732f35']],
      lake: ['e875e05e', ['1b560cae', '70045702', 'c6abb2c6', '5e2ede7f', '3bbb585a']],
      lakePro: ['4f7e20d0', ['1b560cae', '70045702', 'c6abb2c6', '5e2ede7f', '3bbb585a']],
      harbour: ['7cb10bb2', ['fa49f100', '8ba5bc76', '0f8df3d0', '805bc4f9', 'c8401166', 'd791592f']],
      ship2: ['a9db7b81', ['fa49f100', '8ba5bc76', '0f8df3d0', '805bc4f9', 'c8401166', 'd791592f']],
      lakeStory: ['c3d870ff', ['61285d0e', '7237d551', 'cc6a34ff', 'b3060c37', '507ed2e3']]
    };
    return Object.fromEntries(Object.entries(golden).map(([k, [n, pages]]) => [`compat_${k}`, { make: () => books[k], norm: n, pages }]));
  })()
};

/** Ship 2 objects on a v5 book (overlays, a framed panel with a border): normalized fingerprint 1bc7cb90 on the base. */
const withOverlays = (base: ComicDoc): ComicDoc => {
  const d = json(base);
  const page = d.pages[0];
  page.layers = [
    { id: 'ly_star', kind: 'shape', box: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }, shape: { type: 'ellipse', fill: '#ffcc00' }, z: 2 },
    { id: 'ly_photo', kind: 'image', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, src: { path: 'u/user-1/p/proj/img/sticker.webp' }, print: false, rot: 10 }
  ];
  page.panels[0].frame = { box: { x: 0.02, y: 0.02, w: 0.96, h: 0.4 }, border: { w: 0.004, color: '#202020' } };
  return d;
};

// ── Pro data on the v5 book (synthetic) ──
const FX = { gen: 'speed-lines', v: 1, seed: 42, params: { density: 0.6, color: '#111111', radial: true } };
const STICKER = { pack: 'fluent-flat', id: 'fire', v: 'abc123' };
const FUTURE: Record<string, unknown> = { id: 'ly_future', kind: 'hologram', box: bx(0.1, 0.6, 0.2, 0.2), glow: { hue: 200 }, beam: [1, 2, 3], z: 4 };
const PRO_LAYERS = (): PageLayer[] => [
  { id: 'ly_fx', kind: 'effect', box: bx(0, 0, 1, 0.5), fx: json(FX), blend: 'multiply', clip: 'pg_1_p1' },
  { id: 'ly_stk', kind: 'image', box: bx(0.7, 0.7, 0.2, 0.2), src: { lib: { ...STICKER } }, rot: 12 },
  json(FUTURE) as unknown as PageLayer
];
const PRO_MOTION = (): PageMotion => ({
  clips: [
    { id: 'mc_boom', target: { k: 'line', id: 'pg_1_l4' }, role: 'emphasis', preset: 'shake', at: { anchor: 'reveal', ms: 120 }, dur: 600, ease: 'spring', params: { amount: 0.4 }, repeat: 2, keys: [{ t: 0, s: 1 }, { t: 1, s: 1.2, o: 0.8 }] },
    { id: 'mc_fx', target: { k: 'layer', id: 'ly_fx' }, role: 'loop', preset: 'speed-line-scroll', at: { anchor: 'panel', panelId: 'pg_1_p1', ms: 0 } },
    { id: 'mc_p2', target: { k: 'panel', id: 'pg_1_p2' }, role: 'enter', preset: 'zoom-punch', at: { anchor: 'page', ms: -200 } }
  ],
  camera: [{ panelId: 'pg_1_p3', move: 'push' }],
  hold: 1500
});
const withProData = (base: ComicDoc): ComicDoc => {
  const d = json(base);
  const p1 = d.pages[0];
  p1.layers = PRO_LAYERS();
  p1.panels[0].frame = { box: bx(0.02, 0.02, 0.96, 0.3), border: { w: 0.004, style: 'rough', seed: 7 } };
  p1.motion = PRO_MOTION();
  d.reader = { ...d.reader!, motion: 'off' };
  return d;
};
const v5 = () => norm(historyV5Doc);
const proDoc = () => normalizeDoc(json(withProData(v5())));

describe('Pro Edit contract (PE-0): old documents and hashes', () => {
  it('every stored fixture normalizes deep-equal to what the base produced, and normalizing again changes nothing', () => {
    for (const [name, g] of Object.entries(STORED)) {
      const d = norm(g.make);
      expect(fingerprint(d), name).toBe(g.norm);
      expect(normalizeDoc(json(d)), name).toEqual(d);
      // No Pro key appears on an old doc.
      expect(d.pages.some((p) => 'motion' in p) || 'motion' in (d.reader || {}), name).toBe(false);
    }
    // The K2a overlays and frame border on a v5 book: unchanged too.
    expect(fingerprint(normalizeDoc(json(withOverlays(v5()))))).toBe('1bc7cb90');
  });

  it('the pageSpecHash goldens are unchanged, and no Pro field enters any spec hash', () => {
    for (const [name, g] of Object.entries(STORED)) {
      const d = norm(g.make);
      expect(d.pages.map((p) => pageSpecHash(d, p)), name).toEqual(g.pages);
    }
    // Every Pro field filled (effects, a sticker, an opaque layer, blend, border style, motion, reader motion, Pro text
    // styling on a line of an in-art comic, whose lines ARE hashed): every spec hash stays put.
    const old = v5();
    const full = proDoc();
    expect(specHashes(full)).toEqual(specHashes(old));
    const inArt = (d: ComicDoc): ComicDoc => ({ ...d, format: { ...d.format, lettering: 'in_art' } });
    const styled = json(inArt(full));
    styled.pages[0].panels[2].lines[1] = { ...styled.pages[0].panels[2].lines[1], style: { fillGradient: { from: '#ff0000', to: '#ffff00', angle: 90 }, strokes: [{ color: '#000000', w: 0.1 }], warp: 'arc', warpAmount: 0.5 } };
    expect(specHashes(styled)).toEqual(specHashes(inArt(old)));
  });
});

describe('Pro Edit contract (PE-0): the object model round-trips', () => {
  it('effect layers, library stickers, blend, border style, motion and reader motion survive normalize, a jsonb reload and a second pass', () => {
    const full = proDoc();
    const p1 = full.pages[0];
    expect(p1.layers).toEqual(PRO_LAYERS());
    expect(p1.panels[0].frame?.border).toEqual({ w: 0.004, style: 'rough', seed: 7 });
    expect(p1.motion).toEqual(PRO_MOTION());
    expect(full.reader?.motion).toBe('off');
    expect(normalizeDoc(json(full))).toEqual(full);
    expect(normalizeDoc(jsonbOrder(json(full)) as ComicDoc)).toEqual(full);
  });

  it('normalizers keep structure only: clamps, drops the malformed, and a newer build\'s preset or generator is kept (inert)', () => {
    // A preset or generator this build does not have is kept: the server checks the registry, a player skips it.
    expect(normalizeMotionClip({ id: 'mc_x', target: { k: 'line', id: 'l1' }, role: 'enter', preset: 'future-wipe', at: { anchor: 'reveal', ms: 99999 }, dur: 1, repeat: 99, keys: [{ t: 2, x: 9 }, { t: 0.5 }] })).toEqual({
      id: 'mc_x', target: { k: 'line', id: 'l1' }, role: 'enter', preset: 'future-wipe', at: { anchor: 'reveal', ms: MOTION_LIMITS.atMsMax }, dur: MOTION_LIMITS.durMin, repeat: MOTION_LIMITS.repeatMax, keys: [{ t: 0.5 }, { t: 1, x: 9 }]
    });
    for (const bad of [{ id: 'x' }, { id: 'mc_a', target: { k: 'balloon', id: 'l' }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 } }, { id: 'mc_a', target: { k: 'line', id: 'l' }, role: 'dance', preset: 'pop', at: { anchor: 'reveal', ms: 0 } }, { id: 'mc_a', target: { k: 'line', id: 'l' }, role: 'enter', preset: 'Pop!', at: { anchor: 'reveal', ms: 0 } }]) {
      expect(normalizeMotionClip(bad)).toBeUndefined();
    }
    expect(normalizePageMotion({ clips: [] })).toBeUndefined();
    expect(normalizePageMotion({ clips: Array.from({ length: 60 }, (_, i) => ({ id: `mc_${i}`, target: { k: 'panel', id: 'p1' }, role: 'loop', preset: 'float', at: { anchor: 'page', ms: 0 } })) })!.clips).toHaveLength(MOTION_LIMITS.clipsPerPage);
    expect(normalizePageMotion({ clips: [], camera: [{ panelId: 'p1', move: 'push' }, { panelId: 'p1', move: 'pull' }], hold: -5 })).toEqual({ clips: [], camera: [{ panelId: 'p1', move: 'push' }], hold: 0 });
    expect(normalizeLayerFx({ gen: 'future-gen', v: 3, seed: 2 ** 31 - 1, params: { a: 1.234567, __proto__x: 1, ok: 'x'.repeat(40) } })).toEqual({ gen: 'future-gen', v: 3, seed: 2147483647, params: { a: 1.2346, ok: 'x'.repeat(40) } });
    expect(normalizeLayerFx({ gen: 'g', v: 1, seed: 2 ** 31, params: {} })).toBeUndefined();
    expect(normalizeLayerFx({ gen: 'g', v: 1, seed: 1, params: { big: 'x'.repeat(32) }, extra: 'y'.repeat(2000) })).toEqual({ gen: 'g', v: 1, seed: 1, params: { big: 'x'.repeat(32) } });
    // An image needs exactly one picture: a path or a library sticker.
    expect(normalizePageLayer({ id: 'ly_a', kind: 'image', box: bx(0, 0, 0.1, 0.1), src: { path: 'u/x.webp', lib: STICKER } })).toBeUndefined();
    expect(normalizePageLayer({ id: 'ly_a', kind: 'image', box: bx(0, 0, 0.1, 0.1), src: { lib: { pack: 'fluent-flat', id: '../etc', v: '1' } } })).toBeUndefined();
    expect(normalizePageLayer({ id: 'ly_a', kind: 'effect', box: bx(0, 0, 0.1, 0.1) })).toBeUndefined();
    expect(normalizePageLayer({ id: 'ly_a', kind: 'shape', box: bx(0, 0, 0.1, 0.1), shape: { type: 'rect' }, blend: 'difference' })).toEqual({ id: 'ly_a', kind: 'shape', box: bx(0, 0, 0.1, 0.1), shape: { type: 'rect' } });
    expect(pickReader({ motion: 'maybe' }).motion).toBeUndefined();
    expect(pickReader({ motion: 'on' }).motion).toBe('on');
    expect(libAssetUrl(normalizeAssetLibRef(STICKER)!)).toBe('/library/fluent-flat/abc123/fire.svg');
  });

  it('load keeps the plan\'s bounds and the byte budgets only: an invented write bound never truncates stored data', () => {
    // Write bounds PE-0 invented (LEAD TO CONFIRM) are the sanitizer's: a newer build that widens one survives a rollback.
    const wide = normalizeMotionClip({
      id: 'mc_w', target: { k: 'layer', id: 'ly_fx' }, role: 'loop', preset: 'float', at: { anchor: 'page', ms: 0 },
      params: Object.fromEntries(Array.from({ length: MOTION_LIMITS.paramsPerClip + 4 }, (_, i) => [`p${i}`, i === 0 ? 'w'.repeat(MOTION_LIMITS.paramTextChars + 20) : i])),
      keys: [{ t: 0.5, x: MOTION_LIMITS.keyOffsetMax * 3, s: MOTION_LIMITS.keyScaleMax + 4, r: MOTION_LIMITS.keyRotateMax * 2, o: 2 }, { t: 1, s: -1 }]
    })!;
    expect(Object.keys(wide.params!)).toHaveLength(MOTION_LIMITS.paramsPerClip + 4);
    expect(wide.params!.p0).toBe('w'.repeat(MOTION_LIMITS.paramTextChars + 20));
    expect(wide.keys).toEqual([{ t: 0.5, x: 3, s: 12, r: 1440, o: 1 }, { t: 1, s: 0 }]);
    expect(normalizePageMotion({ clips: [], hold: MOTION_LIMITS.holdMaxMs * 6 })).toEqual({ clips: [], hold: MOTION_LIMITS.holdMaxMs * 6 });
    const fxParams = Object.fromEntries(Array.from({ length: FX_LIMITS.paramsPerFx + 4 }, (_, i) => [`k${i}`, i]));
    expect(normalizeLayerFx({ gen: 'g', v: 1, seed: 1, params: { ...fxParams, label: 'z'.repeat(FX_LIMITS.paramTextChars + 8) } })!.params).toEqual({ ...fxParams, label: 'z'.repeat(FX_LIMITS.paramTextChars + 8) });
    // The plan's own bounds and the byte budgets still apply on load.
    expect(MOTION_LIMITS.cameraMoves).toBe(DOC_LIMITS.panelsPerPage);
    expect(normalizeCameraMoves(Array.from({ length: 12 }, (_, i) => ({ panelId: `p${i}`, move: 'push' })))).toHaveLength(DOC_LIMITS.panelsPerPage);
    expect(normalizeLayerFx({ gen: 'g', v: 1, seed: 1, params: { big: 'b'.repeat(FX_LIMITS.fxBytes) } })).toBeUndefined();
    const heavy = (i: number) => ({ id: `mc_${i}`, target: { k: 'panel', id: 'p1' }, role: 'loop', preset: 'float', at: { anchor: 'page', ms: 0 }, params: { note: 'n'.repeat(500) } });
    const trimmed = normalizePageMotion({ clips: Array.from({ length: MOTION_LIMITS.clipsPerPage }, (_, i) => heavy(i)) })!;
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(MOTION_LIMITS.pageBytes);
    expect(trimmed.clips.length).toBeGreaterThan(0);
    expect(trimmed.clips.map((c) => c.id)).toEqual(Array.from({ length: trimmed.clips.length }, (_, i) => `mc_${i}`));
    expect(normalizePageMotion(json(trimmed))).toEqual(trimmed);
  });

  it('an unknown layer kind round-trips through normalize as written and is never drawn, listed, patched or deleted', () => {
    const full = proDoc();
    const page = full.pages[0];
    const opaque = layersOf(page).find((l) => l.id === 'ly_future')!;
    expect(opaque).toEqual(FUTURE);
    expect(isKnownLayerKind(opaque.kind)).toBe(false);
    expect(isOpaqueLayer(opaque)).toBe(true);
    expect(knownLayersOf(page).map((l) => l.id)).toEqual(['ly_fx', 'ly_stk']);
    // Never in the editor's scene (so never drawn, hit or selected there).
    const scene = buildScene(full, page);
    expect(scene.objects.filter((o) => o.kind === 'overlay').map((o) => o.id).sort()).toEqual(['ly_fx', 'ly_stk']);
    // Never client-writable: the strict normalizer (the layer op and the server sanitizer) refuses it, and the layer op
    // neither patches nor deletes it.
    expect(normalizePageLayer(opaque)).toBeUndefined();
    for (const patch of [{ box: bx(0, 0, 0.5, 0.5) }, { kind: 'shape', shape: { type: 'rect' } }, null] as const) {
      expect(applyOp(full, { op: 'layer', pageId: page.id, id: 'ly_future', patch: patch as never }), String(patch)).toBe(full);
    }
    // Bounds of the passthrough: a valid id, a word for a kind, a valid box, ≤ 2 KB; unsafe keys dropped at every depth.
    expect(normalizeOpaqueLayer({ ...FUTURE, id: 'nope' })).toBeUndefined();
    expect(normalizeOpaqueLayer({ ...FUTURE, kind: 42 })).toBeUndefined();
    expect(normalizeOpaqueLayer({ ...FUTURE, box: bx(0, 0, 0, 0) })).toBeUndefined();
    expect(normalizeOpaqueLayer({ ...FUTURE, blob: 'x'.repeat(FX_LIMITS.opaqueLayerBytes) })).toBeUndefined();
    const polluted = normalizeOpaqueLayer(JSON.parse('{"id":"ly_p","kind":"laser","box":{"x":0,"y":0,"w":0.1,"h":0.1},"__proto__":{"evil":1},"cfg":{"constructor":1,"ok":2}}'));
    expect(polluted).toEqual({ id: 'ly_p', kind: 'laser', box: bx(0, 0, 0.1, 0.1), cfg: { ok: 2 } });
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    // Before PE-0 the normalizer dropped it (a rolled-back build stripped the layer for good): it is kept now, in order.
    expect(normalizePageLayers([PRO_LAYERS()[0], FUTURE])!.map((l) => l.id)).toEqual(['ly_fx', 'ly_future']);
  });
});

describe('Pro Edit contract (PE-0): ops', () => {
  const ops = (): DocOp[] => [
    { op: 'motion', pageId: 'pg_2', id: 'mc_new', patch: { target: { k: 'line', id: 'pg_2_l3' }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 } } },
    { op: 'motion', pageId: 'pg_1', id: 'mc_boom', patch: { dur: 900, ease: null, keys: null } },
    { op: 'motion', pageId: 'pg_1', id: 'mc_fx', patch: { dur: 300, repeat: 3 } },
    { op: 'motion', pageId: 'pg_1', id: 'mc_p2', patch: null },
    { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pg_1_p1', move: 'pan-left' }], hold: null } },
    { op: 'page_motion', pageId: 'pg_1', patch: null },
    { op: 'page_motion', pageId: 'pg_3', patch: { hold: 800 } },
    { op: 'layer', pageId: 'pg_2', id: 'ly_burst', patch: { kind: 'effect', box: bx(0.2, 0.2, 0.5, 0.5), fx: { gen: 'burst', v: 1, seed: -5, params: {} }, blend: 'screen' } },
    { op: 'layer', pageId: 'pg_1', id: 'ly_fx', patch: { fx: { ...FX, seed: 43 }, blend: null } },
    { op: 'layer', pageId: 'pg_1', id: 'ly_stk', patch: null }
  ];

  it('every new op followed by its inverse returns the original document (one by one and as one batch)', () => {
    const before = proDoc();
    for (const op of ops()) {
      const after = applyOp(before, op);
      expect(after, `${op.op} changes the doc`).not.toBe(before);
      const inverse = inverseOps(before, [op]);
      expect(inverse.length, op.op).toBeGreaterThan(0);
      for (const inv of inverse) expect(INVERTIBLE_OPS.has(inv.op), inv.op).toBe(true);
      expect(apply(after, inverse), `${op.op} ${JSON.stringify(op).slice(0, 80)}`).toEqual(before);
    }
    const all = ops();
    expect(apply(apply(before, all), inverseOps(before, all))).toEqual(before);
    // Each op's result is already normal (a reload changes nothing).
    const after = apply(before, all);
    expect(normalizeDoc(json(after))).toEqual(after);
    // The undo words.
    expect(describeOps([all[0]])).toBe('change an animation');
    expect(describeOps([all[0], all[1]])).toBe('change 2 animations');
    expect(describeOps([all[4]])).toBe('change the page animation');
  });

  it('a malformed motion op changes nothing (R6) and a page holds at most MOTION_LIMITS.clipsPerPage clips', () => {
    const doc = proDoc();
    for (const op of [
      { op: 'motion', pageId: 'pg_nope', id: 'mc_a', patch: { role: 'enter' } },
      { op: 'motion', pageId: 'pg_1', id: 'mc_new', patch: { role: 'enter' } },
      { op: 'motion', pageId: 'pg_1', id: 'mc_boom', patch: { target: null } },
      { op: 'motion', pageId: 'pg_1', id: 'mc_boom', patch: 'x' },
      { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: '', move: 'push' }] } },
      { op: 'page_motion', pageId: 'pg_1', patch: { hold: 'long' } }
    ] as unknown as DocOp[]) {
      expect(applyOp(doc, op), JSON.stringify(op)).toBe(doc);
    }
    const clip = (i: number) => ({ id: `mc_${i}`, target: { k: 'panel', id: 'pg_1_p1' }, role: 'loop', preset: 'float', at: { anchor: 'page', ms: 0 } });
    let full = { ...doc, pages: doc.pages.map((p, i) => (i ? p : { ...p, motion: { clips: Array.from({ length: MOTION_LIMITS.clipsPerPage }, (_, k) => clip(k)) } as PageMotion })) };
    full = applyOp(full, { op: 'motion', pageId: 'pg_1', id: 'mc_over', patch: { ...clip(0), id: undefined } as never });
    expect(motionClipsOf(full.pages[0])).toHaveLength(MOTION_LIMITS.clipsPerPage);
  });

  it('a duplicated page carries its motion renamed: line, panel and anchor targets and camera moves follow the copy', () => {
    const doc = proDoc();
    const dup = applyOp(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'pg_dup' });
    const copy = dup.pages.find((p) => p.id === 'pg_dup')!;
    const byId = new Map(copy.motion!.clips.map((c) => [c.id, c]));
    expect(byId.get('mc_boom')!.target).toEqual({ k: 'line', id: 'pg_dup_l2_1' });
    expect(copy.panels[2].lines[1].id).toBe('pg_dup_l2_1');
    expect(byId.get('mc_fx')!.target).toEqual({ k: 'layer', id: 'ly_fx' }); // layer ids are unique per page
    expect(byId.get('mc_fx')!.at).toEqual({ anchor: 'panel', panelId: 'pg_dup_p0', ms: 0 });
    expect(byId.get('mc_p2')!.target).toEqual({ k: 'panel', id: 'pg_dup_p1' });
    expect(copy.motion!.camera).toEqual([{ panelId: 'pg_dup_p2', move: 'push' }]);
    expect(copy.motion!.hold).toBe(1500);
    expect(copy.layers!.find((l) => l.id === 'ly_fx')!.clip).toBe('pg_dup_p0');
    // The source is untouched, every renamed target exists, and the copy survives a reload whole.
    expect(dup.pages[0]).toEqual(doc.pages[0]);
    expect(normalizeDoc(json(dup)).pages.find((p) => p.id === 'pg_dup')!.motion).toEqual(copy.motion);
    // Undo removes the copy exactly.
    expect(apply(dup, inverseOps(doc, [{ op: 'page_duplicate', id: 'pg_1', newId: 'pg_dup' }]))).toEqual(doc);
  });

  it('the generic page op strips motion: only the motion ops change it', () => {
    const doc = proDoc();
    const after = applyOp(doc, { op: 'page', id: 'pg_1', patch: { summary: 'Changed', motion: { clips: [] } } as never });
    expect(after.pages[0].summary).toBe('Changed');
    expect(after.pages[0].motion).toEqual(doc.pages[0].motion);
    const cleared = applyOp(doc, { op: 'page', id: 'pg_1', patch: { motion: undefined } as never });
    expect(cleared.pages[0].motion).toEqual(doc.pages[0].motion);
  });

  it('dangling targets are inert: a delete keeps the clip (undo brings it back); normalizeDoc prunes only what is gone from the whole doc', () => {
    const doc = proDoc();
    const del: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: null };
    const after = applyOp(doc, del);
    expect(motionClipsOf(after.pages[0]).map((c) => c.id)).toContain('mc_boom');
    expect(apply(after, inverseOps(doc, [del]))).toEqual(doc);
    // Reloaded while the line is gone from the whole doc: that clip (only) is pruned. KNOWN LIMIT (pro-edit.md §7, S2
    // integration): so normalizeDoc(after) differs from `after` here, which History's I5 and a refetch will meet once
    // motion is writable; S2 prunes in the deleting op or makes I5 and restore tolerate it, then updates this test.
    expect(motionClipsOf(normalizeDoc(json(after)).pages[0]).map((c) => c.id)).toEqual(['mc_fx', 'mc_p2']);
    expect(normalizeDoc(json(after))).not.toEqual(after);
    // A target on a trashed page still counts: a clip on page 2 aimed at page 1's line survives page 1 going to the trash.
    const cross = applyOp(doc, { op: 'motion', pageId: 'pg_2', id: 'mc_cross', patch: { target: { k: 'line', id: 'pg_1_l4' }, role: 'emphasis', preset: 'pulse', at: { anchor: 'page', ms: 0 } } });
    const trashed = applyOp(cross, { op: 'page_delete', id: 'pg_1', deletedAt: 5 });
    expect(trashed.trash?.some((t) => t.page.id === 'pg_1')).toBe(true);
    const reloaded = normalizeDoc(json(trashed));
    expect(motionClipsOf(reloaded.pages.find((p) => p.id === 'pg_2')!).map((c) => c.id)).toEqual(['mc_cross']);
    expect(reloaded.trash!.find((t) => t.page.id === 'pg_1')!.page.motion).toEqual(doc.pages[0].motion);
    // Emptied of the trash, it is gone from the whole doc: pruned, and the page has no motion left.
    expect(normalizeDoc(json({ ...trashed, trash: [] })).pages.find((p) => p.id === 'pg_2')!.motion).toBeUndefined();
    // A camera move on a panel that exists nowhere is pruned too; the page keeps its hold.
    const ghost = json(doc);
    ghost.pages[0].motion = { clips: [], camera: [{ panelId: 'pk_ghost', move: 'push' }], hold: 300 };
    expect(normalizeDoc(ghost).pages[0].motion).toEqual({ clips: [], hold: 300 });
  });
});

describe('Pro Edit contract (PE-0): no client can write a Pro op, and Pro is never paid', () => {
  it('PRO_EDIT_OPS ∩ CLIENT_PATCHABLE_OPS = ∅ while the switch is false; every build knows and inverts them', () => {
    expect(PRO_EDIT_OPS_PATCHABLE).toBe(false);
    expect([...PRO_EDIT_OPS].sort()).toEqual(['motion', 'page_motion']);
    expect(PRO_EDIT_OPS.filter((op) => CLIENT_PATCHABLE_OPS.has(op))).toEqual([]);
    expect(PRO_EDIT_OPS.filter((op) => SERVER_ONLY_OPS.includes(op))).toEqual([]);
    for (const op of PRO_EDIT_OPS) {
      expect(KNOWN_DOC_OPS.has(op), op).toBe(true);
      expect(isKnownDocOp({ op }), op).toBe(true);
      expect(INVERTIBLE_OPS.has(op), op).toBe(true);
    }
    // A client cannot send them yet, so a batch holding one is not undoable through `patch`.
    expect(isUndoable(proDoc(), [{ op: 'page_motion', pageId: 'pg_1', patch: { hold: 10 } }])).toBe(false);
  });

  it('the Pro ops contain no spend action, commit no spend, and the Pro modules name no spend action', () => {
    for (const op of PRO_EDIT_OPS) {
      expect(SPEND_ACTION_TYPES.has(op), op).toBe(false);
      expect(NON_SPEND_ACTION_TYPES.has(op), op).toBe(false); // ops, not actions
    }
    const doc = proDoc();
    const after = apply(doc, [
      { op: 'motion', pageId: 'pg_2', id: 'mc_a', patch: { target: { k: 'panel', id: 'pg_2_p1' }, role: 'enter', preset: 'fade', at: { anchor: 'panel', ms: 0 } } },
      { op: 'page_motion', pageId: 'pg_2', patch: { hold: 500 } }
    ]);
    expect(after.spend).toEqual(doc.spend);
    expect(after.gate).toEqual(doc.gate);
    const here = dirname(fileURLToPath(import.meta.url));
    // No spend action type as a literal, and no price field, anywhere in the Pro Edit modules (later packages included).
    const spendPatterns = [...SPEND_ACTION_TYPES, 'approve_gate'].map((word) => new RegExp(`['"\`]${word}['"\`]`)).concat([/\bquotedUsd\b/, /\busd\b/i]);
    let scanned = 0;
    for (const dir of ['fx', 'motion', 'assets', 'pro']) {
      for (const file of readdirSync(join(here, dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
        const src = readFileSync(join(here, dir, file), 'utf8');
        scanned += 1;
        for (const re of spendPatterns) expect(re.test(src), `${dir}/${file}: ${re}`).toBe(false);
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(8);
    expect(PRO_FREE_FOOTER).toBe('Free — done by the editor, no AI cost');
  });

  it('source scan: the Pro editor folders never import editActionFor and never call studio.act', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../components/comicstudio');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    for (const dir of ['editor', 'compose', 'render']) walk(join(root, dir));
    expect(files.length).toBeGreaterThanOrEqual(9);
    const offences: string[] = [];
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const where = relative(root, file);
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
          if (/board\/PageEditor/.test(spec) && /\beditActionFor\b/.test(node.getText(sf))) offences.push(`${where}: imports editActionFor`);
        }
        if (ts.isIdentifier(node) && node.text === 'editActionFor') offences.push(`${where}: uses editActionFor`);
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'act' && /\bstudio$/.test(node.expression.getText(sf))) offences.push(`${where}: calls studio.act`);
        if (ts.isBindingElement(node) && (node.propertyName ?? node.name).getText(sf) === 'act' && ts.isObjectBindingPattern(node.parent) && /\bstudio\b/.test(node.parent.parent.getText(sf))) {
          offences.push(`${where}: takes act from studio`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(offences).toEqual([]);
  });
});

describe('Pro Edit contract (PE-0): history, the scene and lettering', () => {
  it('History learns motion, effects and stickers, with plain labels', () => {
    const doc = proDoc();
    const motionOp: DocOp = { op: 'motion', pageId: 'pg_1', id: 'mc_new', patch: { target: { k: 'line', id: 'pg_1_l4' }, role: 'emphasis', preset: 'shake', at: { anchor: 'reveal', ms: 0 } } };
    expect(touchedKeys(motionOp, doc)).toEqual([SECTION_KEYS.page('pg_1')]);
    expect(touchedKeys({ op: 'page_motion', pageId: 'pg_1', patch: null }, doc)).toEqual([SECTION_KEYS.page('pg_1')]);
    expect(opActor(motionOp, 'job', doc)).toBe('editor');
    expect(opActor(motionOp, 'user', doc)).toBe('you');
    expect(opActor(motionOp, 'director', doc)).toBe('ai');
    // The W0 note: answering a conflict card with "Use the director's" is the AI's change in History.
    expect(AI_ACTIONS.has('resolve_conflict')).toBe(true);
    expect(opActor({ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'BAM' } }, 'user', doc, 'resolve_conflict')).toBe('ai');
    const effectOp: DocOp = { op: 'layer', pageId: 'pg_2', id: 'ly_new', patch: { kind: 'effect', box: bx(0, 0, 1, 1), fx: { ...FX } } };
    const stickerOp: DocOp = { op: 'layer', pageId: 'pg_3', id: 'ly_s', patch: { kind: 'image', box: bx(0, 0, 0.2, 0.2), src: { lib: { ...STICKER } } } };
    const shapeOp: DocOp = { op: 'layer', pageId: 'pg_4', id: 'ly_r', patch: { kind: 'shape', box: bx(0, 0, 0.2, 0.2), shape: { type: 'rect' } } };
    const moments = panelMomentsOfOps([motionOp, effectOp, stickerOp, shapeOp, { op: 'layer', pageId: 'pg_1', id: 'ly_fx', patch: { box: bx(0, 0, 0.5, 0.5) } }], 'you', doc);
    expect(moments.map((m) => [m.moment, m.pageNs])).toEqual([
      ['motion', [1]],
      ['effects', [2]],
      ['stickers', [3]],
      ['overlays', [4]],
      ['effects', [1]]
    ]);
    expect(describeChanges(panelMomentsOfOps([motionOp], 'you', doc), 'edits')).toBe('You changed the animation on page 1');
    expect(describeChanges(panelMomentsOfOps([effectOp], 'editor', doc), 'edits')).toMatch(/^The editor changed the effects on page 2/);
    expect(proEditLabel(doc, motionOp)).toBe('Animated “GRAB”: Shake');
    expect(proEditLabel(doc, { op: 'motion', pageId: 'pg_1', id: 'mc_p2', patch: null })).toBe('Removed the animation from panel 2');
    expect(proEditLabel(doc, { op: 'motion', pageId: 'pg_1', id: 'mc_boom', patch: { preset: 'jitter' } })).toBe('Animated “GRAB”: Jitter');
    expect(proEditLabel(doc, { op: 'page_motion', pageId: 'pg_1', patch: { camera: null } })).toBe('Changed the camera on page 1');
    expect(proEditLabel(doc, effectOp)).toBe('Added speed lines');
    expect(proEditLabel(doc, { op: 'layer', pageId: 'pg_1', id: 'ly_fx', patch: null })).toBe('Removed speed lines');
    expect(proEditLabel(doc, stickerOp)).toBe('Added a sticker');
    expect(proEditLabel(doc, shapeOp)).toBeUndefined();
    expect(motionPresetWord('zoom-punch')).toBe('Zoom punch');
  });

  it('the scene keeps effects and stickers in the overlay bands under the lettering, with their own words', () => {
    const doc = proDoc();
    const scene = buildScene(doc, doc.pages[0]);
    const fx = scene.objects.find((o) => o.id === 'ly_fx')!;
    const stk = scene.objects.find((o) => o.id === 'ly_stk')!;
    expect([fx.band, fx.label, fx.panelId]).toEqual([1, 'Speed lines', 'pg_1_p1']);
    expect([stk.band, stk.label]).toEqual([2, 'Sticker']);
    const firstLettering = scene.objects.findIndex((o) => o.kind === 'balloon');
    expect(firstLettering === -1 || scene.objects.indexOf(fx) < firstLettering).toBe(true);
    expect(layerWord({ id: 'ly_x', kind: 'effect', box: bx(0, 0, 1, 1), fx: { gen: 'focus-lines', v: 2, seed: 0, params: {} } })).toBe('Focus lines');
    expect(fxName(undefined)).toBe('Effect');
  });

  it('effect names come from fx/names.ts (metadata only): the scene and History never import the generator registry', () => {
    expect(fxName).toBe(fxNameOnly);
    // Every registered generator's name is its FX_NAMES entry (PE-FX keeps the two in step).
    for (const g of FX_GENERATORS) expect(g.name, `${g.gen}@${g.v}`).toBe(FX_NAMES[g.gen]);
    // Source scan: shared modules that the editor scene, History or every doc user loads import fx names or types only,
    // so generator code (PE-FX) never follows into those bundles (§2.6: generators load in the lazy Pro chunk).
    const here = dirname(fileURLToPath(import.meta.url));
    const files = ['doc.ts', 'ops.ts', 'undo.ts', ...['editor', 'history'].flatMap((dir) => readdirSync(join(here, dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(dir, f)))];
    expect(files).toEqual(expect.arrayContaining(['editor/scene.ts', 'history/describe.ts']));
    const offences: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(here, file), 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]*\/fx\/[^'"]*)['"]/g)) if (!/\/fx\/(names|types)(\.js)?$/.test(m[1])) offences.push(`${file}: ${m[1]}`);
    }
    expect(offences).toEqual([]);
  });

  it('Pro text styling is neutral and the lettering sanitizer does not accept a Pro key or id until the drawing lands', () => {
    const doc = v5();
    const line = doc.pages[0].panels[2].lines[0];
    const before = JSON.stringify(resolveLetterStyle(doc, line));
    expect(before).not.toMatch(/fillGradient|strokes|glow|warp/);
    expect(proLetterOf(resolveLetterStyle(doc, line))).toEqual(PRO_LETTER_DEFAULTS);
    expect(PRO_LETTER_DEFAULTS).toEqual({ fillGradient: null, strokes: [], glow: null, warp: 'none', warpAmount: 0 });
    expect(sanitizeLetterStylePatch({ fillGradient: { from: '#000000', to: '#ffffff', angle: 0 }, strokes: [{ color: '#000000', w: 0.1 }], glow: { color: '#ffffff', size: 0.2 }, warp: 'arc', warpAmount: 0.5 })).toBeUndefined();
    for (const shape of PRO_BUBBLE_SHAPES) expect(sanitizeLetterStylePatch({ shape }), shape).toBeUndefined();
    for (const sfxEffect of PRO_SFX_EFFECTS) expect(sanitizeLetterStylePatch({ sfxEffect }), sfxEffect).toBeUndefined();
    expect(PRO_BUBBLE_SHAPES.filter((s) => (BUBBLE_SHAPES as readonly string[]).includes(s))).toEqual([]);
    expect(PRO_SFX_EFFECTS.filter((s) => (SFX_EFFECTS as readonly string[]).includes(s))).toEqual([]);
    expect(PRO_FONT_IDS).toEqual([]);
    expect(isProFontId('bungee')).toBe(false);
  });

  // ── Rollback (§2.3 graft 1, §6.4): S2 writes Pro lettering; rolled back to PE-0, a load + write-back must keep it. ──
  const PRO_LINE_STYLE = {
    italic: true,
    font: 'bungee',
    shape: 'heart',
    sfxEffect: 'wobble',
    fillGradient: { from: '#ff0000', to: '#ffff00', angle: 90 },
    strokes: [{ color: '#000000', w: 0.1 }, { color: '#ffffff', w: 0.05 }],
    glow: { color: '#ffcc00', size: 0.2 },
    warp: 'arc',
    warpAmount: 0.5
  };
  const NAMED = {
    st_radio: { name: 'Radio', patch: { shape: 'radio', textColor: '#00aa00', glow: { color: '#00ff00', size: 0.1 } } },
    st_plain: { name: 'Plain', patch: { italic: false } }
  };
  /** The v5 book as S2 would store it: Pro text styling on a line and in the comic-wide base, and named styles. */
  const proLettered = (): ComicDoc => {
    const d = json(v5());
    const line = d.pages[0].panels[2].lines[0];
    d.pages[0].panels[2].lines[0] = { ...line, styleId: 'st_radio', style: json(PRO_LINE_STYLE) as never };
    d.letterStyle = { ...(d.letterStyle ?? { presetId: 'classic' }), base: { warp: 'wave', warpAmount: -0.25, textColor: '#222222' } as never, named: json(NAMED) as never };
    return d;
  };

  it('stored Pro lettering and named styles round-trip normalizeDoc (rollback-safe) and draw exactly as today', () => {
    const stored = proLettered();
    const loaded = normalizeDoc(json(stored));
    expect(loaded.pages[0].panels[2].lines[0].style).toEqual(PRO_LINE_STYLE);
    expect(loaded.letterStyle).toEqual(stored.letterStyle);
    expect(loaded.letterStyle?.named).toEqual(NAMED);
    // Idempotent, and a jsonb reload (keys reordered) changes nothing.
    expect(normalizeDoc(json(loaded))).toEqual(loaded);
    expect(normalizeDoc(jsonbOrder(json(loaded)) as ComicDoc)).toEqual(loaded);
    // Draws exactly as today: the cascade skips what this build cannot draw (Pro text keys, a Pro shape, SFX effect or
    // font), so the line resolves as if only its base keys were stored, and every id is one the exhaustive records know.
    const line = loaded.pages[0].panels[2].lines[0];
    const today = { ...loaded, letterStyle: { ...loaded.letterStyle!, base: { textColor: '#222222' } } };
    const resolved = resolveLetterStyle(loaded, line);
    expect(resolved).toEqual(resolveLetterStyle(today, { ...line, style: { italic: true } }));
    expect(BUBBLE_SHAPES).toContain(resolved.shape);
    expect(SFX_EFFECTS).toContain(resolved.sfxEffect);
    expect(JSON.stringify(resolved)).not.toMatch(/fillGradient|strokes|glow|warp|bungee|heart|wobble/);
    const sfx = { ...line, kind: 'sfx' as const };
    expect(resolveLetterStyle(loaded, sfx)).toEqual(resolveLetterStyle(today, { ...sfx, style: { italic: true } }));
    // No spec hash moves.
    expect(specHashes(loaded)).toEqual(specHashes(v5()));
  });

  it('the load keep is structural and bounded; a client patch still gets none of it', () => {
    // A client patch (no option): every Pro key and id is dropped, exactly as before.
    expect(sanitizeLetterStylePatch(PRO_LINE_STYLE)).toEqual({ italic: true });
    expect(sanitizeLetteringStyle({ presetId: 'classic', base: { warp: 'arc' }, named: NAMED })).toEqual({ presetId: 'classic' });
    // Load: malformed Pro values are dropped; finite numbers are kept as stored (write bounds are the sanitizer's).
    const keep = { keepStoredPro: true };
    expect(sanitizeLetterStylePatch({ fillGradient: { from: 'nope', to: '#fff', angle: 0 }, glow: { color: '#fff', size: -1 }, warp: 'twist', warpAmount: 7, shape: 'blob', sfxEffect: 'melt', font: 'Not A Font' }, keep)).toEqual({ warpAmount: 7 });
    expect(sanitizeLetterStylePatch({ strokes: Array.from({ length: 5 }, () => ({ color: '#000', w: 2 })) }, keep)).toEqual({ strokes: Array.from({ length: PRO_LETTER_LIMITS.strokes }, () => ({ color: '#000000', w: 2 })) });
    expect(sanitizeLetterStylePatch({ strokes: [], fillGradient: null, glow: null }, keep)).toEqual({ fillGradient: null, strokes: [], glow: null });
    expect(sanitizeLetterStylePatch({ strokes: [{ color: 'x', w: 1 }] }, keep)).toBeUndefined();
    // Named styles: names ≤ 40, ≤ 32 styles, keys are short ids (never __proto__), each patch sanitized with the keep.
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`st_${i}`, { name: `Style ${i}`, patch: {} }]));
    expect(Object.keys(sanitizeLetteringStyle({ presetId: 'classic', named: many }, keep).named!)).toHaveLength(PRO_LETTER_LIMITS.namedStyles);
    const named = sanitizeLetteringStyle(
      JSON.parse('{"presetId":"classic","named":{"__proto__":{"name":"Evil","patch":{}},"st_long":{"name":"' + 'x'.repeat(41) + '","patch":{}},"bad key":{"name":"A","patch":{}},"st_ok":{"name":"Ok","patch":{"shape":"heart","nope":1}},"st_nopatch":{"name":"B"}}}'),
      keep
    ).named;
    expect(named).toEqual({ st_ok: { name: 'Ok', patch: { shape: 'heart' } } });
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  it('the letter_style op and its exact inverse keep named styles; a reset keeps them too', () => {
    const doc = normalizeDoc(json(proLettered()));
    for (const op of [
      { op: 'letter_style', patch: { presetId: 'manga' } },
      { op: 'letter_style', patch: { base: { italic: true }, safeMargin: 0.05 } },
      { op: 'letter_style', patch: null }
    ] as DocOp[]) {
      const after = applyOp(doc, op);
      expect(after.letterStyle?.named, JSON.stringify(op)).toEqual(NAMED);
      expect(apply(after, inverseOps(doc, [op])).letterStyle, JSON.stringify(op)).toEqual(doc.letterStyle);
    }
  });
});

describe('Pro Edit contract (PE-0): opaque layers through frames and panel removal', () => {
  /** The Pro doc with the opaque layer clipped to the first panel (a newer build's layer, kept as written). */
  const clippedOpaque = (): ComicDoc => {
    const d = json(proDoc());
    d.pages[0].layers = d.pages[0].layers!.map((l) => (l.id === 'ly_future' ? ({ ...l, clip: 'pg_1_p1' } as PageLayer) : l));
    // The drawing is cut into its panels and shown in frames, so a frame edit moves what is clipped to the panel.
    const frames = [bx(0.02, 0.02, 0.96, 0.3), bx(0.02, 0.34, 0.47, 0.64), bx(0.51, 0.34, 0.47, 0.64)];
    d.pages[0].render = { ...d.pages[0].render, cuts: { status: 'ok', by: 'detect', at: 11, cuts: frames.map((box, i) => ({ panelId: d.pages[0].panels[i].id, drawn: i + 1, box, conf: 0.95 })) } };
    d.pages[0].artMode = 'panels';
    d.pages[0].panels.forEach((p, i) => (p.frame = { ...p.frame, box: frames[i] }));
    return normalizeDoc(d);
  };
  const opaqueOf = (d: ComicDoc) => d.pages[0].layers!.find((l) => l.id === 'ly_future');

  it('an opaque layer clipped to a panel survives page_frames and panel_remove unchanged, and op + inverse is exact', () => {
    const doc = clippedOpaque();
    const written = json(opaqueOf(doc));
    expect(written).toEqual({ ...FUTURE, clip: 'pg_1_p1' });
    const frames: DocOp = { op: 'page_frames', pageId: 'pg_1', frames: [{ panelId: 'pg_1_p1', frame: { box: bx(0.1, 0.05, 0.8, 0.45) } }] };
    const remove: DocOp = { op: 'panel_remove', pageId: 'pg_1', id: 'pg_1_p1', linesTo: 'pg_1_p2' };
    for (const op of [frames, remove]) {
      const after = applyOp(doc, op);
      expect(after, op.op).not.toBe(doc);
      expect(opaqueOf(after), op.op).toEqual(written);
      const inverse = inverseOps(doc, [op]);
      // No inverse op names the opaque layer (the server refuses any patch to one).
      expect(inverse.filter((o) => o.op === 'layer' && o.id === 'ly_future'), op.op).toEqual([]);
      expect(apply(after, inverse), op.op).toEqual(doc);
    }
    // The known effect layer clipped to the same panel still follows and unclips (unchanged behaviour).
    expect(applyOp(doc, frames).pages[0].layers!.find((l) => l.id === 'ly_fx')!.box).not.toEqual(doc.pages[0].layers!.find((l) => l.id === 'ly_fx')!.box);
    expect(applyOp(doc, remove).pages[0].layers!.find((l) => l.id === 'ly_fx')!.clip).toBeUndefined();
    // A layer op on the opaque layer is a no-op, so its inverse is empty.
    expect(inverseOps(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_future', patch: null }])).toEqual([]);
  });
});

describe('Pro Edit contract (PE-0): flags and seams', () => {
  it('the three flags default off; motion and stickers are stages, reader motion is off | all only (a bare on = everyone)', () => {
    expect(PRO_FLAG_ENV).toEqual({ proMotion: 'COMIC_PRO_MOTION', proStickers: 'COMIC_PRO_STICKERS', readerMotion: 'COMIC_READER_MOTION' });
    expect(PRO_FLAG_DEFAULTS).toEqual({ proMotion: 'off', proStickers: 'off', readerMotion: 'off' });
    for (const admin of [false, true]) expect(proCapsFromEnv({}, admin)).toEqual({ proMotion: false, proStickers: false, readerMotion: false });
    const env = { COMIC_PRO_MOTION: 'on', COMIC_PRO_STICKERS: 'all', COMIC_READER_MOTION: 'admins' };
    expect(proCapsFromEnv(env, false)).toEqual({ proMotion: false, proStickers: true, readerMotion: false });
    expect(proCapsFromEnv(env, true)).toEqual({ proMotion: true, proStickers: true, readerMotion: false });
    // Lead decision (S1): a bare switch turns reader motion on for everyone; 'admins' stays off for readers (signed-out
    // readers cannot be checked); anything else is off.
    const readerCases: readonly (readonly [unknown, 'off' | 'all'])[] = [
      ['on', 'all'], [' ON ', 'all'], ['true', 'all'], ['TRUE', 'all'], ['1', 'all'], ['all', 'all'], [' Everyone ', 'all'],
      ['admins', 'off'], ['Admins', 'off'], ['admin', 'off'], ['off', 'off'], ['false', 'off'], ['0', 'off'], ['yes', 'off'],
      ['', 'off'], ['bogus', 'off'], [undefined, 'off'], [null, 'off'], [1, 'off'], [true, 'off']
    ];
    for (const [value, stage] of readerCases) expect(readerMotionStage(value), String(value)).toBe(stage);
    expect(proCapsFromEnv({ COMIC_READER_MOTION: 'all' }, false).readerMotion).toBe(true);
    for (const admin of [false, true]) {
      expect(proCapsFromEnv({ COMIC_READER_MOTION: 'on' }, admin).readerMotion, `on, admin=${admin}`).toBe(true);
      expect(proCapsFromEnv({ COMIC_READER_MOTION: 'admins' }, admin).readerMotion, `admins, admin=${admin}`).toBe(false);
    }
    // Motion and stickers keep the W0 reading: a bare 'on' is admins only.
    expect(proCapsFromEnv({ COMIC_PRO_MOTION: 'on', COMIC_PRO_STICKERS: 'on' }, false)).toMatchObject({ proMotion: false, proStickers: false });
    // Absent caps (DEFAULT_CAPS, an older server) = every Pro Edit behaviour off.
    for (const caps of [DEFAULT_CAPS, resolveStudioCaps({ byok: false, isAdmin: true }), null, undefined]) {
      expect([proMotionOn(caps), proStickersOn(caps), readerMotionOn(caps)]).toEqual([false, false, false]);
    }
    for (const key of ['proMotion', 'proStickers', 'readerMotion']) expect(key in DEFAULT_CAPS, key).toBe(false);
  });

  it('the stubs carry their final names and do nothing yet: no generator, no font, no part ready', () => {
    expect(FX_GENERATORS).toEqual([]);
    expect(renderFx(FX, { aspect: 1 })).toEqual([]);
    expect(fxParamsOf({ params: { n: { kind: 'number', min: 0, max: 1, default: 0.5 }, c: { kind: 'color', default: '#000000' } } }, { n: 4, c: 'red', x: 1 })).toEqual({ n: 1, c: '#000000' });
    expect(MOTION_PRESET_IDS).toHaveLength(30);
    expect(CAMERA_MOVE_IDS).toHaveLength(6);
    const parts = [composePart, renderPart, kitPart, inspectorPart, layersPart, assetsPart, animatePart, stagePart];
    expect(parts.map((p) => p.id).sort()).toEqual([...PRO_EDIT_PARTS].sort());
    expect(parts.every((p) => p.ready === false)).toBe(true);
    // The barrel reaches the contracts under their namespaces.
    expect(comic.fx.renderFx).toBe(renderFx);
    expect(comic.motion.MOTION_PRESET_IDS).toBe(MOTION_PRESET_IDS);
    expect(comic.assets.libAssetUrl).toBe(libAssetUrl);
    expect(comic.pro.PRO_FREE_FOOTER).toBe(PRO_FREE_FOOTER);
    expect(comic.PRO_EDIT_OPS).toBe(PRO_EDIT_OPS);
    expect(comic.knownLayersOf).toBe(knownLayersOf);
  });
});
