// @vitest-environment node
// PE-SERVER (master plan §2.3 "Sanitizers", §2.5, §2.8 "Motion data", §2.9; collisions B-6, C-9): the motion and
// page_motion client-patch sanitizers and the batch-wide motion screen. The switch PRO_EDIT_OPS_PATCHABLE is a code
// constant (OFF in shared/comic/ops.ts): this file flips it locally (vi.mock, read live through a getter) and pins both
// states. Everything goes through jobs.ts sanitizePatchOps, the way a client batch reaches the doc.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../shared/comic/ops.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/ops.js')>();
  const withPro: ReadonlySet<string> = new Set<string>([...real.CLIENT_PATCHABLE_OPS, ...real.PRO_EDIT_OPS]);
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    },
    get CLIENT_PATCHABLE_OPS() {
      return sw.on ? withPro : real.CLIENT_PATCHABLE_OPS;
    }
  };
});

import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { normalizeDoc, type ComicDoc, type MotionClip, type Page, type PageLayer } from '../../../../shared/comic/doc.js';
import { MOTION_LIMITS } from '../../../../shared/comic/limits.js';
import { clipFlashHz, docMotionBytes, pageMotionBytes } from '../../../../shared/comic/motion/budget.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import type { SanitizeCtx } from '../extensions.js';
import { sanitizePatchOps } from '../jobs.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { opSanitizerFor, patchScreens } from './index.js';
import { MOTION_SANITIZERS, motionPatchScreen } from './motion.js';

afterEach(() => {
  sw.on = true;
});

const sctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 });
const sanitize = (doc: ComicDoc, ops: unknown[]) => sanitizePatchOps(doc, ops, sctx()) as DocOp[];
const rejects = (fn: () => unknown, status: number, message?: RegExp): StudioError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(status);
    if (message) expect((err as StudioError).message).toMatch(message);
    return err as StudioError;
  }
  throw new Error('expected the batch to be rejected');
};

const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
/** The planned book: page 1 has panels pn_1_1..3, the line ln_1_2 in pn_1_2, a printed shape overlay and an opaque one. */
const fixture = (motion?: Page['motion'], extraPages = 0): ComicDoc => {
  const raw = JSON.parse(JSON.stringify(plannedDoc())) as ComicDoc;
  raw.pages[0].layers = [
    { id: 'ly_box', kind: 'shape', box, shape: { type: 'rect' } },
    { id: 'ly_future', kind: 'hologram', box } as unknown as PageLayer
  ];
  if (motion) raw.pages[0].motion = motion;
  for (let i = 0; i < extraPages; i += 1) {
    const copy = JSON.parse(JSON.stringify(raw.pages[1])) as Page;
    raw.pages.push({ ...copy, id: `pg_x${i}`, n: raw.pages.length + 1, panels: copy.panels.map((p) => ({ ...p, id: `${p.id}_x${i}`, lines: p.lines.map((l) => ({ ...l, id: `${l.id}_x${i}` })) })) });
  }
  return normalizeDoc(raw);
};
const pop = (over: Record<string, unknown> = {}) => ({ target: { k: 'line', id: 'ln_1_2' }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 }, ...over });
const motionOp = (id: string, patch: Record<string, unknown> | null, pageId = 'pg_1') => ({ op: 'motion', pageId, id, patch });
const flicker = (id: string, flashes: number, dur = 1000, target = { k: 'line', id: 'ln_1_2' }): MotionClip =>
  ({ id, target, role: 'emphasis', preset: 'flicker', at: { anchor: 'reveal', ms: 0 }, dur, params: { flashes } }) as MotionClip;

describe('the switch (PRO_EDIT_OPS_PATCHABLE) and the registry', () => {
  it('on: both ops have their own sanitizer and the batch screen runs after the safety screen', () => {
    expect(opSanitizerFor('motion')).toBe(MOTION_SANITIZERS[0]);
    expect(opSanitizerFor('page_motion')).toBe(MOTION_SANITIZERS[1]);
    expect(patchScreens()).toHaveLength(2);
    expect(patchScreens()[1]).toBe(motionPatchScreen);
  });

  it('off: a client batch with a motion op is refused exactly as before, and the sanitizers refuse on their own too', () => {
    const doc = fixture();
    sw.on = false;
    rejects(() => sanitize(doc, [motionOp('mc_a', pop())]), 400, /can't be changed directly/);
    rejects(() => sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { hold: 500 } }]), 400, /can't be changed directly/);
    expect(patchScreens()).toHaveLength(1);
    rejects(() => MOTION_SANITIZERS[0].sanitize(doc, motionOp('mc_a', pop()) as never, sctx()), 400, /can't be changed directly/);
    rejects(() => MOTION_SANITIZERS[1].sanitize(doc, { op: 'page_motion', pageId: 'pg_1', patch: null } as never, sctx()), 400, /can't be changed directly/);
  });
});

describe('one clip', () => {
  it('a valid clip is accepted from known keys only, its numbers clamped to MOTION_LIMITS, and stored as sent', () => {
    const doc = fixture();
    const ops = sanitize(doc, [motionOp('mc_a', { ...pop({ at: { anchor: 'reveal', ms: 99_999 }, preset: 'pulse', role: 'emphasis' }), dur: 50, repeat: 99, ease: 'spring', params: { amount: 0.2 }, bogus: 1, keys: [{ t: 2, s: 99, o: 0.5, z: 3 }] })]);
    expect(ops).toEqual([
      {
        op: 'motion',
        pageId: 'pg_1',
        id: 'mc_a',
        patch: { target: { k: 'line', id: 'ln_1_2' }, role: 'emphasis', preset: 'pulse', at: { anchor: 'reveal', ms: MOTION_LIMITS.atMsMax }, dur: MOTION_LIMITS.durMin, ease: 'spring', params: { amount: 0.2 }, repeat: MOTION_LIMITS.repeatMax, keys: [{ t: 1, s: MOTION_LIMITS.keyScaleMax, o: 0.5 }] }
      }
    ]);
    const clip = applyOps(doc, ops).pages[0].motion!.clips[0];
    expect(clip).toMatchObject({ id: 'mc_a', preset: 'pulse', dur: 100, repeat: 20 });
  });

  it('refuses an unknown preset, a preset of another role, an unknown ease, a non-number and a clip with no target', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ preset: 'teleport' }))]), 400, /isn't available/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ preset: 'shake' }))]), 400, /emphasis animation, so it can't play as an entrance/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ ease: 'wobbly' }))]), 400, /easing isn't available/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ at: { anchor: 'reveal', ms: Number.NaN } }))]), 400, /must be a number/);
    rejects(() => sanitize(doc, [motionOp('mc_a', { role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 } })]), 400, /needs a target/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ at: { anchor: 'panel', ms: 0 } }))]), 400, /needs that panel/);
    rejects(() => sanitize(doc, [motionOp('bad id', pop())]), 400, /animation id/);
  });

  it("refuses params outside the preset's schema: an unknown setting, out of range, not whole, too many", () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ params: { from: 2 } }))]), 400, /out of range/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ params: { speed: 1 } }))]), 400, /no setting called “speed”/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ params: JSON.parse('{"__proto__": 1}') }))]), 400, /Invalid animation settings/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ params: { from: Number.POSITIVE_INFINITY } }))]), 400, /Invalid animation settings/);
    rejects(() => sanitize(doc, [motionOp('mc_a', { ...flicker('mc_a', 2.5), id: undefined })]), 400, /out of range/);
    const many = Object.fromEntries(Array.from({ length: MOTION_LIMITS.paramsPerClip + 1 }, (_, i) => [`p${i}`, 1]));
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ params: many }))]), 400, /at most/);
    // Clearing the params of a preset is fine.
    expect(sanitize(doc, [motionOp('mc_a', pop({ params: null }))])[0]).toMatchObject({ patch: { params: null } });
  });

  it('refuses a 4 Hz flicker (WCAG 2.3.1) and accepts the same flicker at 3 Hz', () => {
    const doc = fixture();
    const four = flicker('mc_f', 4);
    expect(clipFlashHz(four)).toBe(4);
    rejects(() => sanitize(doc, [motionOp('mc_f', { ...four, id: undefined })]), 400, /^That animation would flash 4 times a second/);
    const three = flicker('mc_f', 3);
    expect(clipFlashHz(three)).toBe(3);
    expect(sanitize(doc, [motionOp('mc_f', { ...three, id: undefined })])).toHaveLength(1);
  });

  it('refuses a position outside the page\'s clip list and a start panel that is not on the page', () => {
    const doc = fixture({ clips: [{ id: 'mc_old', ...pop() } as MotionClip] });
    rejects(() => sanitize(doc, [{ ...motionOp('mc_a', pop()), index: -1 }]), 400, /animation position/);
    rejects(() => sanitize(doc, [{ ...motionOp('mc_a', pop()), index: 2 }]), 400, /animation position/);
    rejects(() => sanitize(doc, [{ ...motionOp('mc_a', pop()), index: 0.5 }]), 400, /animation position/);
    expect(applyOps(doc, sanitize(doc, [{ ...motionOp('mc_a', pop()), index: 0 }])).pages[0].motion!.clips.map((c) => c.id)).toEqual(['mc_a', 'mc_old']);
    expect(applyOps(doc, sanitize(doc, [{ ...motionOp('mc_a', pop()), index: 1 }])).pages[0].motion!.clips.map((c) => c.id)).toEqual(['mc_old', 'mc_a']);
    // A start panel elsewhere (pn_2_1 is on page 2) is refused; one of this page is accepted.
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ at: { anchor: 'panel', panelId: 'pn_2_1', ms: 0 } }))]), 400, /starts with a panel that is no longer on the page/);
    rejects(() => sanitize(doc, [motionOp('mc_old', { at: { anchor: 'panel', panelId: 'pn_2_1', ms: 0 } })]), 400, /starts with a panel/);
    expect(sanitize(doc, [motionOp('mc_a', pop({ at: { anchor: 'panel', panelId: 'pn_1_3', ms: 0 } }))])).toHaveLength(1);
  });

  it('a stored clip over 3 Hz (a newer build wrote it) may be edited while it flashes no faster; an edit that speeds it up is refused', () => {
    const fast = flicker('mc_f', 8, 2000);
    expect(clipFlashHz(fast)).toBe(4);
    const doc = fixture({ clips: [fast] });
    expect(clipFlashHz({ ...fast, dur: 2100 })).toBe(4);
    expect(sanitize(doc, [motionOp('mc_f', { dur: 2100 })])).toEqual([{ op: 'motion', pageId: 'pg_1', id: 'mc_f', patch: { dur: 2100 } }]);
    expect(sanitize(doc, [motionOp('mc_f', { at: { anchor: 'reveal', ms: 300 } })])).toHaveLength(1);
    // The clip's own check speaks first (the page check alone would say "Together, …").
    rejects(() => sanitize(doc, [motionOp('mc_f', { dur: 1000 })]), 400, /^That animation would flash 8 times a second/);
    rejects(() => sanitize(doc, [motionOp('mc_f', { params: { flashes: 8, depth: 0.8 }, repeat: 2, dur: 1000 })]), 400, /^That animation would flash/);
  });

  it("a stored ease from a newer build is kept when the client re-sends it; a different ease this build doesn't know is refused", () => {
    const doc = fixture({ clips: [{ id: 'mc_e', ...pop(), ease: 'future-bounce' } as unknown as MotionClip] });
    expect(doc.pages[0].motion!.clips[0].ease).toBe('future-bounce');
    const ops = sanitize(doc, [motionOp('mc_e', { ease: 'future-bounce', dur: 500 })]);
    expect(applyOps(doc, ops).pages[0].motion!.clips[0]).toMatchObject({ ease: 'future-bounce', dur: 500 });
    rejects(() => sanitize(doc, [motionOp('mc_e', { ease: 'future-wobble' })]), 400, /easing isn't available/);
    rejects(() => sanitize(doc, [motionOp('mc_new', pop({ ease: 'future-bounce' }))]), 400, /easing isn't available/);
    // Clearing it back to the preset's own ease is fine.
    expect(sanitize(doc, [motionOp('mc_e', { ease: null })])[0]).toMatchObject({ patch: { ease: null } });
  });

  it('refuses more than 12 keyframes per clip and more than 48 clips per page', () => {
    const doc = fixture();
    const keys = Array.from({ length: MOTION_LIMITS.keysPerClip + 1 }, (_, i) => ({ t: i / 20, x: 0.01 }));
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ keys }))]), 400, /up to 12 keyframes/);
    expect(sanitize(doc, [motionOp('mc_a', pop({ keys: keys.slice(0, 12) }))])).toHaveLength(1);
    const full = fixture({ clips: Array.from({ length: MOTION_LIMITS.clipsPerPage }, (_, i) => ({ id: `mc_${i}`, ...pop() }) as MotionClip) });
    expect(full.pages[0].motion!.clips).toHaveLength(48);
    rejects(() => sanitize(full, [motionOp('mc_new', pop())]), 409, /up to 48 animations/);
    // An edit of a clip that is there, and a delete, still pass.
    expect(sanitize(full, [motionOp('mc_3', { at: { anchor: 'reveal', ms: 200 } }), motionOp('mc_4', null)])).toHaveLength(2);
    // The count is the batch's (shakes here: 48 entrances on one balloon would also count as flashes on the page).
    const shake = (over: Record<string, unknown> = {}) => pop({ role: 'emphasis', preset: 'shake', ...over });
    const shakes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `mc_${i}`, ...shake() }) as MotionClip);
    // Two new clips on a page with room for one are refused (each alone would fit).
    const roomForOne = fixture({ clips: shakes(47) });
    expect(sanitize(roomForOne, [motionOp('mc_new', shake())])).toHaveLength(1);
    rejects(() => sanitize(roomForOne, [motionOp('mc_new', shake()), motionOp('mc_new2', shake())]), 409, /up to 48 animations/);
    // Deleting one clip of a full page and adding another in the same batch keeps it at 48, and its undo passes too.
    const fullShakes = fixture({ clips: shakes(48) });
    const swap = sanitize(fullShakes, [motionOp('mc_4', null), motionOp('mc_new', shake())]);
    const swapped = applyOps(fullShakes, swap);
    expect(swapped.pages[0].motion!.clips).toHaveLength(48);
    expect(swapped.pages[0].motion!.clips.map((c) => c.id)).toContain('mc_new');
    const undo = sanitize(swapped, inverseOps(fullShakes, swap));
    expect(applyOps(swapped, undo).pages[0]).toEqual(fullShakes.pages[0]);
  });
});

describe('the batch, as it will be stored', () => {
  it('the target must be on the page once the batch is applied: a line added earlier in the batch counts', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ target: { k: 'line', id: 'ln_ghost' } }))]), 400, /no longer on the page/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ target: { k: 'panel', id: 'pn_2_1' } }))]), 400, /no longer on the page/);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop({ target: { k: 'layer', id: 'ly_future' } }))]), 400, /no longer on the page/);
    expect(sanitize(doc, [motionOp('mc_a', pop({ target: { k: 'layer', id: 'ly_box' } }))])).toHaveLength(1);
    const ops = sanitize(doc, [
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: 'ln_new', patch: { kind: 'sfx', text: 'BOOM' } },
      motionOp('mc_boom', { target: { k: 'line', id: 'ln_new' }, role: 'emphasis', preset: 'shake', at: { anchor: 'reveal', ms: 0 } })
    ]);
    expect(applyOps(doc, ops).pages[0].motion!.clips.map((c) => c.id)).toEqual(['mc_boom']);
    // A clip created and deleted in the same batch leaves nothing to check.
    expect(sanitize(doc, [motionOp('mc_tmp', pop()), motionOp('mc_tmp', null)])).toHaveLength(2);
  });

  it('a clip that already has a target keeps working when that target is gone (an edit of a dangling clip is not refused)', () => {
    const doc = fixture({ clips: [{ id: 'mc_old', ...pop({ at: { anchor: 'panel', panelId: 'pn_1_3', ms: 0 } }) } as MotionClip] });
    const gone = applyOps(doc, [
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: null },
      { op: 'panel_remove', pageId: 'pg_1', id: 'pn_1_3' } as DocOp
    ]);
    expect(gone.pages[0].panels.map((p) => p.id)).not.toContain('pn_1_3');
    expect(gone.pages[0].motion!.clips).toHaveLength(1); // ops never prune (undo brings the balloon back)
    expect(sanitize(gone, [motionOp('mc_old', { dur: 500 })])).toHaveLength(1);
    // The editor's spread of the stored clip re-sends its target and start as they are: not a re-aim.
    const stored = gone.pages[0].motion!.clips[0];
    expect(sanitize(gone, [motionOp('mc_old', { target: stored.target, at: { ...stored.at, ms: 250 }, dur: 600 })])).toHaveLength(1);
    // Re-aiming at something that is not on the page, or a new start panel that is not, is refused.
    rejects(() => sanitize(gone, [motionOp('mc_old', { target: { k: 'line', id: 'ln_ghost' } })]), 400, /no longer on the page/);
    rejects(() => sanitize(gone, [motionOp('mc_old', { target: { k: 'panel', id: 'pn_1_3' } })]), 400, /no longer on the page/);
    rejects(() => sanitize(gone, [motionOp('mc_old', { at: { anchor: 'panel', panelId: 'pn_2_1', ms: 0 } })]), 400, /starts with a panel/);
    // Re-aiming it at something on the page brings it back to life.
    expect(sanitize(gone, [motionOp('mc_old', { target: { k: 'panel', id: 'pn_1_1' } })])).toHaveLength(1);
  });

  it('dangling (S2 integration, carry note 11): re-creating a deleted clip whose target is already gone is a new clip and is refused today', () => {
    // Delete the balloon (its clip stays, inert), then the clip; the undo of the clip delete re-creates a clip aimed at
    // nothing on the page. The server cannot tell that undo from a new clip, so it is refused. With "prune in the
    // deleting op" this state cannot arise (the clip goes with its balloon, and that undo restores both); with
    // "tolerate", the S2 integration flips this expectation (wave note 8).
    const doc = fixture({ clips: [{ id: 'mc_c', ...pop() } as MotionClip] });
    const gone = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: null }]);
    const del = sanitize(gone, [motionOp('mc_c', null)]);
    const cleared = applyOps(gone, del);
    expect(cleared.pages[0].motion).toBeUndefined();
    rejects(() => sanitize(cleared, inverseOps(gone, del)), 400, /no longer on the page/);
  });

  it('two clips that each flash 2 Hz on one balloon flash 4 Hz together: the second is refused', () => {
    const doc = fixture({ clips: [flicker('mc_1', 2)] });
    rejects(() => sanitize(doc, [motionOp('mc_2', { ...flicker('mc_2', 2), id: undefined })]), 400, /Together, the animations on this page would flash 4 times/);
    // In one batch too (the per-op check sees each clip alone).
    rejects(() => sanitize(fixture(), [motionOp('mc_1', { ...flicker('mc_1', 2), id: undefined }), motionOp('mc_2', { ...flicker('mc_2', 2), id: undefined })]), 400, /flash 4 times/);
  });

  it('a page past a budget (a newer build wrote it) can always shrink: deleting a clip is accepted, adding one is not', () => {
    const doc = fixture({ clips: [flicker('mc_1', 3), flicker('mc_2', 3)] });
    expect(doc.pages[0].motion!.clips).toHaveLength(2);
    expect(sanitize(doc, [motionOp('mc_2', null)])).toEqual([{ op: 'motion', pageId: 'pg_1', id: 'mc_2', patch: null }]);
    rejects(() => sanitize(doc, [motionOp('mc_3', { ...flicker('mc_3', 1), id: undefined })]), 400, /would flash/);
  });

  it('refuses a clip that takes the page past 16 KB', () => {
    const keys = Array.from({ length: 12 }, (_, i) => ({ t: Math.round((i / 11) * 10000) / 10000, x: 0.1234, y: -0.6543, s: 1.2345, r: 123.4567, o: 0.9876 }));
    const heavy = (i: number) => ({ id: `mc_h${i}`, ...pop(), keys }) as MotionClip;
    let n = 0;
    const clips: MotionClip[] = [];
    while (pageMotionBytes({ motion: { clips: [...clips, heavy(n)] } }) <= MOTION_LIMITS.pageBytes) clips.push(heavy(n++));
    const doc = fixture({ clips });
    expect(doc.pages[0].motion!.clips).toHaveLength(clips.length);
    rejects(() => sanitize(doc, [motionOp('mc_more', { ...pop(), keys })]), 409, /size limit/);
  });

  describe('a page just under 16 KB: the op would push out a later, untouched clip, so the batch is refused', () => {
    const KEY = { x: 0.1234, y: -0.6543, s: 1.2345, r: 123.4567, o: 0.9876 };
    const keysOf = (n: number) => Array.from({ length: n }, (_, i) => ({ t: Math.round((i / 12) * 10000) / 10000, ...KEY }));
    /** Clips of 9 keys, then plain ones, until the page is within ~60 bytes of the budget. */
    const nearFull = (): ComicDoc => {
      const clips: MotionClip[] = [];
      const fits = (c: MotionClip) => pageMotionBytes({ motion: { clips: [...clips, c] } }) <= MOTION_LIMITS.pageBytes;
      for (let i = 0; fits({ id: `mc_s${i}`, ...pop(), keys: keysOf(9) } as MotionClip); i += 1) clips.push({ id: `mc_s${i}`, ...pop(), keys: keysOf(9) } as MotionClip);
      for (let i = 0; fits({ id: `mc_p${i}`, ...pop() } as MotionClip); i += 1) clips.push({ id: `mc_p${i}`, ...pop() } as MotionClip);
      const doc = fixture({ clips });
      expect(doc.pages[0].motion!.clips).toHaveLength(clips.length);
      const bytes = pageMotionBytes(doc.pages[0]);
      expect(bytes).toBeLessThanOrEqual(MOTION_LIMITS.pageBytes);
      expect(bytes).toBeGreaterThan(MOTION_LIMITS.pageBytes - 120);
      return doc;
    };
    const ids = (doc: ComicDoc) => doc.pages[0].motion!.clips.map((c) => c.id);

    it('an insert at the front (applied raw, the op would drop the last clip instead of the new one)', () => {
      const doc = nearFull();
      const op = { ...motionOp('mc_new', pop()), index: 0 } as DocOp;
      const raw = applyOps(doc, [op]);
      expect(ids(raw)[0]).toBe('mc_new');
      expect(ids(raw)).not.toContain(ids(doc).at(-1)); // the precondition: an untouched clip is silently lost
      rejects(() => sanitize(doc, [op]), 409, /size limit/);
      // At the end it is the new clip that would not fit: refused the same way.
      rejects(() => sanitize(doc, [motionOp('mc_new', pop())]), 409, /size limit/);
    });

    it('an edit that grows an early clip with keyframes', () => {
      const doc = nearFull();
      const op = motionOp('mc_s0', { keys: keysOf(12) }) as DocOp;
      expect(ids(applyOps(doc, [op]))).not.toContain(ids(doc).at(-1));
      rejects(() => sanitize(doc, [op]), 409, /size limit/);
      // The same edit after deleting another clip in the same batch fits, and every other clip stays.
      const ok = sanitize(doc, [motionOp('mc_s1', null), op]);
      const after = applyOps(doc, ok);
      expect(ids(after)).toEqual(ids(doc).filter((id) => id !== 'mc_s1'));
      expect(after.pages[0].motion!.clips[0].keys).toHaveLength(12);
    });

    it('camera moves that do not fit', () => {
      const doc = nearFull();
      const op = { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'push' }, { panelId: 'pn_1_2', move: 'pull' }, { panelId: 'pn_1_3', move: 'push' }] } } as DocOp;
      expect(ids(applyOps(doc, [op]))).not.toContain(ids(doc).at(-1));
      rejects(() => sanitize(doc, [op]), 409, /size limit/);
    });

    it('a delete and a shrink always pass', () => {
      const doc = nearFull();
      expect(sanitize(doc, [motionOp('mc_s3', null)])).toHaveLength(1);
      expect(sanitize(doc, [motionOp('mc_s0', { keys: null })])).toHaveLength(1);
    });

    it('a page the session holds past 16 KB (a page_duplicate copy, renamed without a trim) still takes a delete; an insert is refused', () => {
      const over = nearFull();
      const heavy = over.pages[0].motion!.clips[0];
      for (let i = 0; i < 4; i += 1) over.pages[0].motion!.clips.push({ ...heavy, id: `mc_over${i}` });
      expect(JSON.stringify(over.pages[0].motion).length).toBeGreaterThan(MOTION_LIMITS.pageBytes + 2000);
      // The op trims the end as the load would; the delete itself is accepted.
      const ops = sanitize(over, [motionOp('mc_s1', null)]);
      expect(ids(applyOps(over, ops))).not.toContain('mc_s1');
      expect(ids(applyOps(over, ops))).not.toContain('mc_over3');
      rejects(() => sanitize(over, [{ ...motionOp('mc_new', pop()), index: 0 }]), 409, /size limit/);
    });
  });

  it('counts the page in UTF-8 bytes too: text a newer build stored can pass 16 KB where the load reads fewer characters', () => {
    const wide = { id: 'mc_w', target: { k: 'line', id: 'ln_1_2' }, role: 'emphasis', preset: 'future-glyphs', at: { anchor: 'reveal', ms: 0 }, params: { label: '漢'.repeat(6000) } } as unknown as MotionClip;
    const doc = fixture({ clips: [wide] });
    expect(JSON.stringify(doc.pages[0].motion).length).toBeLessThan(MOTION_LIMITS.pageBytes);
    expect(pageMotionBytes(doc.pages[0])).toBeGreaterThan(MOTION_LIMITS.pageBytes);
    rejects(() => sanitize(doc, [motionOp('mc_a', pop())]), 409, /size limit/);
    expect(sanitize(doc, [motionOp('mc_w', null)])).toHaveLength(1);
  });

  it('refuses a clip that takes the document past 256 KB; a delete on a full document passes', () => {
    const keys = Array.from({ length: 12 }, (_, i) => ({ t: Math.round((i / 11) * 10000) / 10000, x: 0.1234, y: -0.6543, s: 1.2345, r: 123.4567, o: 0.9876 }));
    const raw = JSON.parse(JSON.stringify(fixture(undefined, 15))) as ComicDoc;
    const heavy = (page: Page, i: number) => ({ id: `mc_${page.id}_${i}`, target: { k: 'line', id: page.panels[1].lines[0].id }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 }, keys }) as MotionClip;
    // Fill page after page with heavy clips, each page under 16 KB, until one more clip would pass the document budget.
    let total = 0;
    let room: Page | undefined;
    for (const page of raw.pages) {
      const clips: MotionClip[] = [];
      for (;;) {
        const next = [...clips, heavy(page, clips.length)];
        const bytes = pageMotionBytes({ motion: { clips: next } });
        if (bytes > MOTION_LIMITS.pageBytes) break;
        if (total - pageMotionBytes({ motion: clips.length ? { clips } : undefined }) + bytes > MOTION_LIMITS.docBytes) {
          room = page;
          break;
        }
        total += bytes - pageMotionBytes({ motion: clips.length ? { clips } : undefined });
        clips.push(next[next.length - 1]);
      }
      if (clips.length) page.motion = { clips };
      if (room) break;
    }
    expect(room).toBeDefined();
    const doc = normalizeDoc(raw);
    expect(docMotionBytes(doc)).toBe(total);
    expect(total).toBeLessThanOrEqual(MOTION_LIMITS.docBytes);
    const page = doc.pages.find((p) => p.id === room!.id)!;
    const next = heavy(page, 999);
    rejects(() => sanitize(doc, [motionOp(next.id, { ...next, id: undefined }, page.id)]), 409, /256 KB/);
    expect(sanitize(doc, [motionOp(doc.pages[0].motion!.clips[0].id, null, doc.pages[0].id)])).toHaveLength(1);
  });
});

describe('page_motion: camera and hold', () => {
  it('accepts known moves on panels of the page and clamps the hold; refuses an unknown move, a panel elsewhere, a duplicate', () => {
    const doc = fixture();
    expect(sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'push' }], hold: 99_999 } }])).toEqual([
      { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'push' }], hold: MOTION_LIMITS.holdMaxMs } }
    ]);
    rejects(() => sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'barrel-roll' }] } }]), 400, /camera move isn't available/);
    rejects(() => sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_2_1', move: 'push' }] } }]), 400, /no longer on the page/);
    rejects(() => sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'push' }, { panelId: 'pn_1_1', move: 'pull' }] } }]), 400, /one camera move/);
    rejects(() => sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { hold: 'long' } }]), 400, /must be a number/);
    expect(sanitize(doc, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [] } }])[0]).toEqual({ op: 'page_motion', pageId: 'pg_1', patch: { camera: null } });
  });

  it('after a panel is removed its camera move stays (inert): re-sending the stored list with a new move is accepted', () => {
    const doc = fixture({ clips: [], camera: [{ panelId: 'pn_1_3', move: 'push' }] });
    const removed = applyOps(doc, [{ op: 'panel_remove', pageId: 'pg_1', id: 'pn_1_3' } as DocOp]);
    expect(removed.pages[0].panels.map((p) => p.id)).not.toContain('pn_1_3');
    expect(removed.pages[0].motion!.camera).toEqual([{ panelId: 'pn_1_3', move: 'push' }]);
    const ops = sanitize(removed, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [...removed.pages[0].motion!.camera!, { panelId: 'pn_1_1', move: 'pull' }] } }]);
    expect(applyOps(removed, ops).pages[0].motion!.camera).toEqual([{ panelId: 'pn_1_3', move: 'push' }, { panelId: 'pn_1_1', move: 'pull' }]);
    // A changed move for the removed panel, or a move for a panel elsewhere, is still refused.
    rejects(() => sanitize(removed, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_3', move: 'pull' }] } }]), 400, /no longer on the page/);
    rejects(() => sanitize(removed, [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_3', move: 'push' }, { panelId: 'pn_2_1', move: 'push' }] } }]), 400, /no longer on the page/);
  });
});

describe('undo and rollback', () => {
  it("every motion edit's inverse is accepted and gives the page back exactly", () => {
    const doc = fixture({ clips: [{ id: 'mc_old', ...pop(), dur: 400 } as MotionClip], camera: [{ panelId: 'pn_1_2', move: 'pull' }], hold: 300 });
    const batches: unknown[][] = [
      [motionOp('mc_new', pop({ target: { k: 'panel', id: 'pn_1_3' }, preset: 'fade' }))],
      [motionOp('mc_old', { dur: null, ease: 'linear', keys: [{ t: 0.5, r: 30 }] })],
      [motionOp('mc_old', null)],
      [{ op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'pan-left' }], hold: null } }],
      [{ op: 'page_motion', pageId: 'pg_1', patch: null }]
    ];
    for (const batch of batches) {
      const ops = sanitize(doc, batch);
      const after = applyOps(doc, ops);
      expect(after.pages[0].motion, JSON.stringify(batch)).not.toEqual(doc.pages[0].motion);
      const undo = sanitize(after, inverseOps(doc, ops));
      expect(applyOps(after, undo).pages[0], JSON.stringify(batch)).toEqual(doc.pages[0]);
    }
  });

  it("a newer build's preset and camera move (inert here) are kept when the client re-sends them; never written new", () => {
    const doc = fixture({ clips: [{ id: 'mc_s3', target: { k: 'line', id: 'ln_1_2' }, role: 'emphasis', preset: 'hyperspin', at: { anchor: 'reveal', ms: 0 }, params: { spin: 9 } } as unknown as MotionClip], camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' as never }] });
    expect(doc.pages[0].motion!.clips[0].preset).toBe('hyperspin');
    const ops = sanitize(doc, [motionOp('mc_s3', { preset: 'hyperspin', at: { anchor: 'reveal', ms: 500 } }), { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' }], hold: 200 } }]);
    expect(applyOps(doc, ops).pages[0].motion).toMatchObject({ clips: [{ id: 'mc_s3', preset: 'hyperspin', at: { ms: 500 }, params: { spin: 9 } }], camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' }], hold: 200 });
    rejects(() => sanitize(doc, [motionOp('mc_s3', { params: { spin: 3 } })]), 400, /can't be changed in this version/);
    rejects(() => sanitize(doc, [motionOp('mc_new', pop({ preset: 'hyperspin', role: 'emphasis' }))]), 400, /isn't available/);
  });
});
