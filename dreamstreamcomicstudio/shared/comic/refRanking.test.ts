// refs.md §2.5 / §9: reference ranking is pure, deterministic and matches the scoring table.
import { describe, expect, it } from 'vitest';
import { emptyRender, type Character, type RefAsset } from './doc';
import { dhashDistance, isPhotoLikeness, pickRefs, scoreRef, sheetRefs, sheetRefsChanged } from './refRanking';

const ref = (path: string, extra: Partial<RefAsset> = {}): RefAsset => ({ path, source: 'upload', at: 1, ...extra });

const maya = (refs: RefAsset[], extra: Partial<Character> = {}): Character => ({
  id: 'maya',
  name: 'Maya',
  tier: 'lead',
  look: { summary: 'Courier' },
  refs,
  sheet: emptyRender(),
  ...extra
});

// Four near-identical selfies (dHash within 6 bits of each other) and one side view.
const SELFIE = 'f0f0f0f0f0f0f0f0';
const selfies = [0, 1, 2, 3].map((i) => ref(`selfie${i}`, { label: 'face', dhash: `f0f0f0f0f0f0f0f${i}` }));
const side = ref('side', { label: 'side', dhash: '0f0f0f0f0f0f0f0f' });

describe('scoreRef (refs.md §2.5 table)', () => {
  it('priority: 100 − 6·index, +40 for the main ref, unlabeled +5', () => {
    expect(scoreRef(ref('a'), 0, 'sheet')).toBe(145);
    expect(scoreRef(ref('b'), 1, 'sheet')).toBe(99);
    expect(scoreRef(ref('c'), 3, 'page')).toBe(87);
  });

  it('label affinity per purpose', () => {
    expect(scoreRef(ref('a', { label: 'front' }), 1, 'sheet')).toBe(94 + 30);
    expect(scoreRef(ref('a', { label: 'three_quarter' }), 1, 'sheet')).toBe(94 + 28);
    expect(scoreRef(ref('a', { label: 'detail' }), 1, 'sheet')).toBe(94 + 4);
    expect(scoreRef(ref('a', { label: 'wide' }), 1, 'sheet')).toBe(94); // means nothing for a sheet
    expect(scoreRef(ref('a', { label: 'other' }), 1, 'sheet')).toBe(99); // = unlabeled
    expect(scoreRef(ref('a', { label: 'wide' }), 1, 'place_sheet')).toBe(124);
    expect(scoreRef(ref('a', { label: 'interior' }), 1, 'place_sheet')).toBe(119);
    expect(scoreRef(ref('a', { label: 'linework' }), 1, 'style')).toBe(114);
    expect(scoreRef(ref('a', { label: 'composition' }), 1, 'style')).toBe(104);
  });

  it('page/cover affinity follows the shot mix', () => {
    const close = { shots: ['close_up', 'extreme_close_up', 'medium'] as const };
    const wide = { shots: ['wide', 'establishing', 'full', 'close_up'] as const };
    const mixed = { shots: ['medium', 'close_up', 'wide', 'over_shoulder'] as const };
    const face = ref('f', { label: 'face' });
    const body = ref('b', { label: 'full_body' });
    expect(scoreRef(face, 1, 'page', { shots: [...close.shots] })).toBe(94 + 30);
    expect(scoreRef(body, 1, 'page', { shots: [...close.shots] })).toBe(94);
    expect(scoreRef(body, 1, 'page', { shots: [...wide.shots] })).toBe(94 + 30);
    expect(scoreRef(face, 1, 'page', { shots: [...wide.shots] })).toBe(94);
    expect(scoreRef(face, 1, 'cover', { shots: [...mixed.shots] })).toBe(94 + 18);
    expect(scoreRef(ref('t', { label: 'three_quarter' }), 1, 'page')).toBe(94 + 25); // no shots → mixed table
  });

  it('quality penalties apply to character purposes only', () => {
    const blurry = ref('a', { quality: { blurry: true, lowRes: true, dark: true, multiSubject: true } });
    expect(scoreRef(blurry, 1, 'sheet')).toBe(99 - 35 - 20 - 15 - 20);
    expect(scoreRef(blurry, 1, 'page')).toBe(99 - 90);
    expect(scoreRef(blurry, 1, 'style')).toBe(99);
    expect(scoreRef(blurry, 1, 'place_sheet')).toBe(99);
  });

  it('subject mismatch −40 and over-rating −50; blocked refs are never candidates', () => {
    expect(scoreRef(ref('a', { subject: 'place' }), 1, 'sheet')).toBe(59);
    expect(scoreRef(ref('a', { subject: 'person' }), 1, 'place_sheet')).toBe(59);
    expect(scoreRef(ref('a', { subject: 'animal' }), 1, 'place_sheet')).toBe(59);
    expect(scoreRef(ref('a', { subject: 'place' }), 1, 'place_sheet')).toBe(99);
    const pg13 = ref('a', { safety: { assessed: 'PG-13', at: 1 } });
    expect(scoreRef(pg13, 1, 'page', { effectiveRating: 'PG' })).toBe(49);
    expect(scoreRef(pg13, 1, 'page', { effectiveRating: 'PG-13' })).toBe(99);
    expect(scoreRef(pg13, 1, 'page')).toBe(99); // default = the PG-13 platform ceiling
    expect(scoreRef(ref('x', { safety: { assessed: 'X', at: 1 } }), 0, 'sheet')).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreRef(ref('q', { safety: { quarantined: true, at: 1 } }), 0, 'sheet')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('pickRefs', () => {
  it('diversity: 4 near-identical selfies + 1 side view, k = 2 → main + side', () => {
    const refs = [...selfies, side];
    expect(dhashDistance(selfies[0].dhash, selfies[3].dhash)).toBeLessThanOrEqual(6);
    expect(pickRefs(refs, 2, 'sheet').map((r) => r.path)).toEqual(['selfie0', 'side']);
    // Unlabeled near-duplicates are still pushed down by the dHash penalty alone.
    const plain = [0, 1, 2].map((i) => ref(`p${i}`, { dhash: `${SELFIE.slice(0, 15)}${i}` }));
    expect(pickRefs([...plain, ref('other', { dhash: '0123456789abcdef' })], 2, 'page').map((r) => r.path)).toEqual(['p0', 'other']);
  });

  it('same-label penalty spreads the labels', () => {
    const refs = [ref('a', { label: 'front' }), ref('b', { label: 'front' }), ref('c', { label: 'side' })];
    // b: 94+30−25 = 99 vs c: 88+18 = 106 after a is picked.
    expect(pickRefs(refs, 2, 'sheet').map((r) => r.path)).toEqual(['a', 'c']);
  });

  it('shot-mix switching changes the page pick', () => {
    const refs = [ref('main'), ref('face', { label: 'face' }), ref('body', { label: 'full_body' })];
    expect(pickRefs(refs, 2, 'page', { shots: ['close_up', 'close_up'] }).map((r) => r.path)).toEqual(['main', 'face']);
    expect(pickRefs(refs, 2, 'page', { shots: ['wide', 'establishing'] }).map((r) => r.path)).toEqual(['main', 'body']);
  });

  it('excludes blocked/quarantined refs, breaks ties by index, clamps k', () => {
    const refs = [ref('a', { safety: { assessed: 'X', at: 1 } }), ref('b'), ref('c', { safety: { quarantined: true, at: 1 } }), ref('d')];
    expect(pickRefs(refs, 5, 'page').map((r) => r.path)).toEqual(['b', 'd']);
    expect(pickRefs(refs, 0, 'page')).toEqual([]);
    expect(pickRefs(refs, -3, 'page')).toEqual([]);
    expect(pickRefs(refs, Number.NaN, 'page')).toEqual([]);
    expect(pickRefs(refs, 1.9, 'page').map((r) => r.path)).toEqual(['b']);
    // Equal scores → lower index first (face at 1: 94+22, three-quarter at 2: 88+28).
    const tie = [ref('x'), ref('z', { label: 'face' }), ref('y', { label: 'three_quarter' })];
    expect(scoreRef(tie[1], 1, 'sheet')).toBe(scoreRef(tie[2], 2, 'sheet'));
    expect(pickRefs(tie, 3, 'sheet').map((r) => r.path)).toEqual(['x', 'z', 'y']);
    expect(pickRefs([tie[0], tie[2], tie[1]], 3, 'sheet').map((r) => r.path)).toEqual(['x', 'y', 'z']);
  });

  it('is deterministic and never mutates its input', () => {
    const refs = [...selfies, side];
    const copy = JSON.parse(JSON.stringify(refs));
    expect(pickRefs(refs, 3, 'sheet')).toEqual(pickRefs(refs, 3, 'sheet'));
    expect(refs).toEqual(copy);
  });
});

describe('sheetRefs / sheetRefsChanged / isPhotoLikeness', () => {
  it('sheet uses ≤ 4 diverse refs and never more than the model allows', () => {
    const c = maya([...selfies, side, ref('back', { label: 'back' })]);
    const four = sheetRefs(c, 5).map((r) => r.path);
    expect(four).toHaveLength(4);
    expect(four.slice(0, 2)).toEqual(['selfie0', 'side']);
    expect(sheetRefs(c, 2)).toHaveLength(2);
    expect(sheetRefs(c, 0)).toEqual([]);
  });

  it('"drawn from older photos" compares the photo set (a reorder is not a change)', () => {
    const refs = [ref('a'), ref('b'), ref('c')];
    const drawn = (refPaths?: string[]) => maya(refs, { sheet: { ...emptyRender(), status: 'ready', asset: { path: 's', source: 'generated', at: 1 }, refPaths } });
    expect(sheetRefsChanged(drawn(['a', 'b', 'c']), 4)).toBe(false);
    expect(sheetRefsChanged(drawn(['c', 'a', 'b']), 4)).toBe(false);
    expect(sheetRefsChanged(drawn(['a', 'b']), 4)).toBe(true);
    expect(sheetRefsChanged(drawn(['a', 'b', 'old']), 4)).toBe(true);
    expect(sheetRefsChanged(drawn(undefined), 4)).toBe(false); // unknown → never nags
    expect(sheetRefsChanged({ ...drawn(['zzz']), sheet: { ...emptyRender(), status: 'none', refPaths: ['zzz'] } }, 4)).toBe(false);
  });

  it('isPhotoLikeness: main usable upload of a person/animal (unknown subject → cast kind)', () => {
    expect(isPhotoLikeness(maya([ref('a')]))).toBe(true);
    expect(isPhotoLikeness(maya([ref('a', { subject: 'animal' })]))).toBe(true);
    expect(isPhotoLikeness(maya([ref('a', { subject: 'artwork' })]))).toBe(false);
    expect(isPhotoLikeness(maya([ref('a', { source: 'generated' })]))).toBe(false);
    expect(isPhotoLikeness(maya([ref('a')], { kind: 'robot' }))).toBe(false);
    expect(isPhotoLikeness(maya([ref('x', { safety: { assessed: 'X', at: 1 } }), ref('b')]))).toBe(true);
    expect(isPhotoLikeness(maya([]))).toBe(false);
  });
});
