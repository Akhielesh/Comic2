// PE-MOTION-ENGINE budgets (master plan §2.8 "Motion data", §2.9 "Flash ≤ 3 Hz"): the byte budgets PE-SERVER enforces
// and the flash rule shared by the sanitizer and the players (WCAG 2.3.1: at most three flashes in any one second).

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizePageMotion, type ComicDoc, type Page } from '../doc';
import { MOTION_LIMITS } from '../limits';
import {
  clipFlashHz,
  clipFlashSwings,
  docMotionBytes,
  docMotionFits,
  motionBudgetReport,
  motionBytes,
  pageFlashCheck,
  pageMotionBytes,
  pageMotionFits,
  utf8Bytes
} from './budget';
import { visibilityOf } from './presets';
import type { MotionClip, PageMotion } from './types';

const clip = (id: string, patch: Partial<MotionClip>): MotionClip => ({
  id,
  target: { k: 'line', id: 'pg_1_l1' },
  role: 'emphasis',
  preset: 'pulse',
  at: { anchor: 'reveal', ms: 0 },
  ...patch
});
const withMotion = (page: Page, motion: PageMotion): Page => ({ ...page, motion });

describe('motion bytes', () => {
  it('counts UTF-8 bytes, never fewer than the load rule’s JSON length', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('ऋ')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('\ud800x')).toBe(4); // a lone surrogate is written as 3 bytes, then the x
    const motion: PageMotion = { clips: [clip('mc_a', { params: { word: 'ধীরে' } })], hold: 300 };
    expect(motionBytes(motion)).toBeGreaterThanOrEqual(JSON.stringify(motion).length);
    expect(motionBytes(undefined)).toBe(0);
  });

  it('page and document budgets: the trash’s pages count, the limits are inclusive', () => {
    const doc = makeSampleDoc();
    const big: PageMotion = { clips: Array.from({ length: 40 }, (_, i) => clip(`mc_${i}`, { params: { note: 'x'.repeat(300) } })) };
    const page = withMotion(doc.pages[0], big);
    expect(pageMotionBytes(page)).toBeGreaterThan(MOTION_LIMITS.pageBytes);
    expect(pageMotionFits(page)).toBe(false);
    expect(pageMotionFits(doc.pages[0])).toBe(true);
    // The load normalizer trims the same page under the budget: what it keeps fits here too.
    expect(pageMotionFits({ motion: normalizePageMotion(big) })).toBe(true);
    const small: PageMotion = { clips: [clip('mc_a', {})] };
    const each = motionBytes(small);
    const d: ComicDoc = { ...doc, pages: doc.pages.map((p) => withMotion(p, small)), trash: [{ page: withMotion(doc.pages[1], small), fromN: 2, deletedAt: 1 }] };
    expect(docMotionBytes(d)).toBe(each * (doc.pages.length + 1));
    expect(docMotionFits(d)).toBe(true);
    const many = Math.floor(MOTION_LIMITS.docBytes / each) + 1;
    const heavy = { pages: Array.from({ length: many }, (_, i) => ({ ...doc.pages[0], id: `pg_x${i}`, motion: small })) };
    expect(docMotionFits(heavy)).toBe(false);
  });
});

describe('clipFlashHz (the most flashes in any one second of the clip, as drawn)', () => {
  it('a 4 Hz flicker gives clipFlashHz > 3, however it is made', () => {
    expect(clipFlashHz(clip('mc_f', { preset: 'flicker', dur: 1000, params: { flashes: 4 } }))).toBe(4);
    expect(clipFlashHz(clip('mc_f', { preset: 'flicker', dur: 250, repeat: 7, params: { flashes: 1 } }))).toBe(4);
    expect(clipFlashHz(clip('mc_b', { role: 'loop', preset: 'blink', dur: 250 }))).toBe(4);
    for (const c of [
      clip('mc_f', { preset: 'flicker', dur: 1000, params: { flashes: 4 } }),
      clip('mc_b', { role: 'loop', preset: 'blink', dur: 250 })
    ])
      expect(clipFlashHz(c)).toBeGreaterThan(MOTION_LIMITS.flashHzMax);
  });

  it('a long run reads exactly like its busiest second (20 repeats count as 3 do), a short burst counts only its flashes', () => {
    const run = (repeat: number) => clipFlashHz(clip('mc_f', { preset: 'flicker', dur: 400, repeat, params: { flashes: 2 } }));
    // Two evenly spaced dips every 400 ms: five in any one-second window.
    expect(run(3)).toBe(5);
    expect(run(20)).toBe(run(3));
    expect(run(0)).toBe(2);
    expect(clipFlashHz(clip('mc_b', { role: 'loop', preset: 'blink', dur: 100 }))).toBe(10);
  });

  it('the presets as shipped stay at or under 3; a stored out-of-range param is read clamped', () => {
    expect(clipFlashHz(clip('mc_f', { preset: 'flicker' }))).toBeLessThanOrEqual(3);
    expect(clipFlashHz(clip('mc_b', { role: 'loop', preset: 'blink' }))).toBe(1);
    expect(clipFlashHz(clip('mc_s', { role: 'loop', preset: 'sparkle-twinkle' }))).toBe(1);
    // flashes: 50 is past the schema (1..8): it plays as 8.
    expect(clipFlashHz(clip('mc_f', { preset: 'flicker', dur: 1000, params: { flashes: 50 } }))).toBe(8);
    // A flicker too faint to count (depth under the 10 % rule) never flashes.
    expect(clipFlashHz(clip('mc_f', { preset: 'flicker', dur: 1000, params: { flashes: 8, depth: 0.05 } }))).toBe(0);
  });

  it('keyed opacity is read off the keys: four dips a second is 4; one dip is 1; scale keys never flash', () => {
    const dips = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t, i) => ({ t, o: i % 2 ? 0 : 1 }));
    expect(clipFlashHz(clip('mc_k', { preset: 'pulse', dur: 1000, keys: dips }))).toBe(4);
    expect(clipFlashHz(clip('mc_k', { preset: 'pulse', dur: 1000, keys: [{ t: 0, o: 1 }, { t: 0.5, o: 0.2 }, { t: 1, o: 1 }] }))).toBe(1);
    expect(clipFlashHz(clip('mc_k', { preset: 'pulse', dur: 200, keys: [{ t: 0, s: 1 }, { t: 0.5, s: 3 }, { t: 1, s: 1 }], repeat: 20 }))).toBe(0);
  });

  it('entrances, exits and unknown presets do not flash', () => {
    expect(clipFlashHz(clip('mc_a', { role: 'enter', preset: 'fade', dur: 100, repeat: 0 }))).toBe(0);
    expect(clipFlashHz(clip('mc_a', { role: 'exit', preset: 'fade-out', dur: 100 }))).toBe(0);
    expect(clipFlashHz(clip('mc_a', { preset: 'strobe' as MotionClip['preset'] }))).toBe(0);
    expect(clipFlashHz(clip('mc_a', { ease: 'zigzag' as MotionClip['ease'], preset: 'flicker', params: { flashes: 8 }, dur: 100 }))).toBe(0);
  });

  it('an entrance or exit plays once, so a stored repeat never snaps it from shown back to hidden', () => {
    // Each of these made 4 flashes in its busiest second when a repeat replayed it (and 10 for the 100 ms fade).
    for (const [role, preset] of [
      ['enter', 'pop'],
      ['enter', 'zoom-punch'],
      ['exit', 'pop-out'],
      ['exit', 'zoom-out'],
      ['enter', 'typewriter'],
      ['enter', 'ink-wipe'],
      ['exit', 'ink-wipe-out']
    ] as const) {
      expect(clipFlashSwings(clip('mc_r', { role, preset, repeat: 5 })), preset).toBe(1);
      expect(clipFlashHz(clip('mc_r', { role, preset, repeat: 5 })), preset).toBe(0);
    }
    expect(clipFlashHz(clip('mc_r', { role: 'enter', preset: 'fade', dur: 100, repeat: 20 }))).toBe(0);
    // Keys still decide an entrance's own play: four keyed dips in one second are four flashes, repeat or not.
    const dips = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t, i) => ({ t, o: i % 2 ? 0 : 1 }));
    expect(clipFlashHz(clip('mc_k', { role: 'enter', preset: 'fade', dur: 1000, keys: dips, repeat: 5 }))).toBe(4);
  });

  it('counts what the reader sees go: fading, un-revealing or shrinking to nothing all flash', () => {
    expect(visibilityOf({ o: 1, reveal: 1, s: 1, sy: 1 })).toBe(1);
    expect(visibilityOf({ o: 1, reveal: 0, s: 1, sy: 1 })).toBe(0);
    expect(visibilityOf({ o: 1, reveal: 1, s: 0, sy: 1 })).toBe(0);
    expect(visibilityOf({ o: 1, reveal: 1, s: 1, sy: 0 })).toBe(0);
    expect(visibilityOf({ o: 0.5, reveal: 0.5, s: 2, sy: 1 })).toBe(0.25);
    // A keyed scale to nothing and back, ten times a second: the opacity never moves, the object still blinks out.
    const vanish = [{ t: 0, s: 1 }, { t: 0.5, s: 0 }, { t: 1, s: 1 }];
    expect(clipFlashHz(clip('mc_v', { role: 'loop', preset: 'float', dur: 100, keys: vanish }))).toBe(10);
    expect(clipFlashHz(clip('mc_v', { role: 'emphasis', preset: 'pulse', dur: 100, repeat: 20, keys: vanish }))).toBeGreaterThan(3);
    // A squash or a pulse that never comes close to vanishing is movement, not a flash.
    expect(clipFlashHz(clip('mc_v', { role: 'loop', preset: 'float', dur: 100, keys: [{ t: 0, s: 1 }, { t: 0.5, s: 0.3 }, { t: 1, s: 1 }] }))).toBe(0);
    expect(clipFlashHz(clip('mc_q', { preset: 'squash-stretch', dur: 100, repeat: 20, params: { amount: 0.5 } }))).toBe(0);
  });

  it('the count is the same for every player seed (the sanitizer reads seed 0)', () => {
    const flicker = clip('mc_f', { preset: 'flicker', dur: 700, repeat: 6, params: { flashes: 2 } });
    const at0 = clipFlashHz(flicker, 0);
    expect(at0).toBeLessThanOrEqual(MOTION_LIMITS.flashHzMax);
    for (let seed = 0; seed <= 40; seed += 1) expect(clipFlashHz(flicker, seed), `seed ${seed}`).toBe(at0);
    for (const seed of [-7, 99, 0x7fffffff]) expect(clipFlashHz(clip('mc_b', { role: 'loop', preset: 'blink', dur: 250 }), seed)).toBe(4);
  });

  it('a count is read by value: an edited clip is counted afresh, an equal one is not counted again', () => {
    const c = clip('mc_e', { preset: 'flicker', dur: 1000, params: { flashes: 2 } });
    expect(clipFlashHz(c)).toBe(2);
    (c.params as Record<string, number>).flashes = 5;
    expect(clipFlashHz(c)).toBe(5);
    expect(clipFlashHz({ ...c, params: { flashes: 5 } })).toBe(5);
    expect(clipFlashHz({ ...c, dur: 2000 })).toBe(3);
  });
});

describe('pageFlashCheck', () => {
  const page = makeSampleDoc().pages[0];

  it('adds up the clips on one drawn target; separate targets are judged apart', () => {
    const twoHz = (id: string, target: MotionClip['target']) => clip(id, { target, preset: 'flicker', dur: 1000, params: { flashes: 2 } });
    const same = withMotion(page, { clips: [twoHz('mc_1', { k: 'line', id: 'pg_1_l1' }), twoHz('mc_2', { k: 'line', id: 'pg_1_l1' })] });
    const check = pageFlashCheck(same);
    expect(check.ok).toBe(false);
    expect(check.hz).toBe(4);
    expect(check.targets).toEqual([{ key: 'line:pg_1_l1', hz: 4, clipIds: ['mc_1', 'mc_2'] }]);
    const apart = withMotion(page, { clips: [twoHz('mc_1', { k: 'line', id: 'pg_1_l1' }), twoHz('mc_2', { k: 'panel', id: 'pg_1_p2' })] });
    expect(pageFlashCheck(apart)).toMatchObject({ ok: true, hz: 2 });
    expect(pageFlashCheck(page)).toEqual({ ok: true, hz: 0, targets: [], regions: [] });
  });

  it('one target’s entrance and exit add their changes to its flicker (as if all in one second)', () => {
    const on = (patch: Partial<MotionClip>, id: string) => clip(id, { target: { k: 'line', id: 'pg_1_l1' }, ...patch });
    const flicker = on({ preset: 'flicker' }, 'mc_f'); // as shipped: 3 in its busiest second
    expect(pageFlashCheck(withMotion(page, { clips: [flicker] }))).toMatchObject({ ok: true, hz: 3 });
    expect(pageFlashCheck(withMotion(page, { clips: [on({ role: 'enter', preset: 'pop' }, 'mc_in'), flicker] }))).toMatchObject({ ok: true, hz: 3 });
    const both = pageFlashCheck(withMotion(page, { clips: [on({ role: 'enter', preset: 'pop' }, 'mc_in'), flicker, on({ role: 'exit', preset: 'pop-out' }, 'mc_out')] }));
    expect(both).toMatchObject({ ok: false, hz: 4 });
    expect(both.targets[0]).toEqual({ key: 'line:pg_1_l1', hz: 4, clipIds: ['mc_in', 'mc_f', 'mc_out'] });
  });

  it('flashes drawn in one panel’s area add up: the panel, its balloons and the overlays clipped to it (LEAD TO CONFIRM)', () => {
    const threeHz = (id: string, target: MotionClip['target']) => clip(id, { target, preset: 'flicker', dur: 1000, params: { flashes: 3 } });
    // A flickering panel and a flickering balloon inside it: 6 changes of that area a second.
    const nested = pageFlashCheck(withMotion(page, { clips: [threeHz('mc_p', { k: 'panel', id: 'pg_1_p3' }), threeHz('mc_l', { k: 'line', id: 'pg_1_l4' })] }));
    expect(nested.ok).toBe(false);
    expect(nested.hz).toBe(6);
    expect(nested.regions[0]).toEqual({ region: 'pg_1_p3', hz: 6, clipIds: ['mc_p', 'mc_l'] });
    expect(nested.targets.map((t) => t.hz)).toEqual([3, 3]);
    // Two balloons side by side in one panel add up too; the same two in different panels do not.
    expect(pageFlashCheck(withMotion(page, { clips: [threeHz('mc_a', { k: 'line', id: 'pg_1_l3' }), threeHz('mc_b', { k: 'line', id: 'pg_1_l5' })] })).ok).toBe(false);
    expect(pageFlashCheck(withMotion(page, { clips: [threeHz('mc_a', { k: 'line', id: 'pg_1_l1' }), threeHz('mc_b', { k: 'line', id: 'pg_1_l2' })] })).ok).toBe(true);
    // An overlay clipped to a panel counts there; an unclipped one floats over every panel.
    const layered = { ...page, layers: [{ id: 'ly_in', kind: 'shape', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, clip: 'pg_1_p1' }, { id: 'ly_free', kind: 'shape', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] } as Page;
    expect(pageFlashCheck(withMotion(layered, { clips: [threeHz('mc_a', { k: 'layer', id: 'ly_in' }), threeHz('mc_b', { k: 'line', id: 'pg_1_l2' })] })).ok).toBe(true);
    expect(pageFlashCheck(withMotion(layered, { clips: [threeHz('mc_a', { k: 'layer', id: 'ly_in' }), threeHz('mc_b', { k: 'line', id: 'pg_1_l1' })] })).ok).toBe(false);
    expect(pageFlashCheck(withMotion(layered, { clips: [threeHz('mc_a', { k: 'layer', id: 'ly_free' }), threeHz('mc_b', { k: 'line', id: 'pg_1_l2' })] })).ok).toBe(false);
    // Balloons that each appear and go once never add up: a balloon appearing while another goes is no flash.
    const inAndOut = ['pg_1_l3', 'pg_1_l4', 'pg_1_l5'].flatMap((id) => [
      clip(`mc_in_${id}`, { target: { k: 'line', id }, role: 'enter', preset: 'fade', dur: 100 }),
      clip(`mc_out_${id}`, { target: { k: 'line', id }, role: 'exit', preset: 'fade-out', dur: 100 })
    ]);
    expect(pageFlashCheck(withMotion(page, { clips: [...inAndOut, clip('mc_p', { target: { k: 'panel', id: 'pg_1_p3' }, role: 'loop', preset: 'blink' })] }))).toMatchObject({ ok: true, hz: 1 });
  });

  it('only the first MOTION_LIMITS.clipsPerPage clips count (the players read no more)', () => {
    const quiet = Array.from({ length: MOTION_LIMITS.clipsPerPage }, (_, i) => clip(`mc_${i}`, { target: { k: 'line', id: 'pg_1_l1' } }));
    const loud = clip('mc_loud', { target: { k: 'line', id: 'pg_1_l1' }, preset: 'flicker', dur: 1000, params: { flashes: 8 } });
    expect(pageFlashCheck(withMotion(page, { clips: [...quiet, loud] }))).toEqual({ ok: true, hz: 0, targets: [], regions: [] });
    expect(pageFlashCheck(withMotion(page, { clips: [loud, ...quiet] })).ok).toBe(false);
  });

  it('a linked balloon chain flashes as one target, keyed by its head', () => {
    const chained = {
      ...page,
      balloons: [...page.balloons, { lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' }],
      motion: {
        clips: [
          clip('mc_1', { target: { k: 'line', id: 'pg_1_l3' }, preset: 'flicker', dur: 1000, params: { flashes: 2 } }),
          clip('mc_2', { target: { k: 'line', id: 'pg_1_l4' }, preset: 'flicker', dur: 1000, params: { flashes: 2 } })
        ]
      }
    };
    expect(pageFlashCheck(chained).targets).toEqual([{ key: 'line:pg_1_l3', hz: 4, clipIds: ['mc_1', 'mc_2'] }]);
  });
});

describe('motionBudgetReport', () => {
  it('names each page over a budget, and the document', () => {
    const doc = makeSampleDoc();
    const flashy: PageMotion = { clips: [clip('mc_f', { preset: 'flicker', dur: 1000, params: { flashes: 5 } })] };
    const d = { ...doc, pages: doc.pages.map((p, i) => (i === 1 ? withMotion(p, flashy) : p)) };
    const report = motionBudgetReport(d);
    expect(report.ok).toBe(false);
    expect(report.overDoc).toBe(false);
    expect(report.pages).toEqual([{ pageId: 'pg_2', bytes: motionBytes(flashy), overBytes: false, clips: 1, overClips: false, flashHz: 5, overFlash: true }]);
    expect(motionBudgetReport(doc)).toEqual({ docBytes: 0, overDoc: false, pages: [], ok: true });
  });
});
