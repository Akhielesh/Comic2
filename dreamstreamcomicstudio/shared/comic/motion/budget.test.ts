// PE-MOTION-ENGINE budgets (master plan §2.8 "Motion data", §2.9 "Flash ≤ 3 Hz"): the byte budgets PE-SERVER enforces
// and the flash rule shared by the sanitizer and the players (WCAG 2.3.1: at most three flashes in any one second).

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizePageMotion, type ComicDoc, type Page } from '../doc';
import { MOTION_LIMITS } from '../limits';
import {
  clipFlashHz,
  docMotionBytes,
  docMotionFits,
  motionBudgetReport,
  motionBytes,
  pageFlashCheck,
  pageMotionBytes,
  pageMotionFits,
  utf8Bytes
} from './budget';
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
    // Five a second on average; the seeded dips are uneven, so the busiest one-second window (what WCAG counts) holds 6.
    expect(run(3)).toBe(6);
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
    expect(pageFlashCheck(page)).toEqual({ ok: true, hz: 0, targets: [] });
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
