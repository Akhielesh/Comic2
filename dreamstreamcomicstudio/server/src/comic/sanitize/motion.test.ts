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
    const doc = fixture({ clips: [{ id: 'mc_old', ...pop() } as MotionClip] });
    const gone = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: null }]);
    expect(gone.pages[0].motion!.clips).toHaveLength(1); // ops never prune (undo brings the balloon back)
    expect(sanitize(gone, [motionOp('mc_old', { dur: 500 })])).toHaveLength(1);
    rejects(() => sanitize(gone, [motionOp('mc_old', { target: { k: 'line', id: 'ln_1_2' } })]), 400, /no longer on the page/);
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
    rejects(() => sanitize(doc, [motionOp('mc_more', { ...pop(), keys })]), 409, /limit/);
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
    const doc = fixture({ clips: [{ id: 'mc_s3', target: { k: 'line', id: 'ln_1_2' }, role: 'emphasis', preset: 'hyperspin', at: { anchor: 'reveal', ms: 0 }, params: { spin: 9 } } as MotionClip], camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' as never }] });
    expect(doc.pages[0].motion!.clips[0].preset).toBe('hyperspin');
    const ops = sanitize(doc, [motionOp('mc_s3', { preset: 'hyperspin', at: { anchor: 'reveal', ms: 500 } }), { op: 'page_motion', pageId: 'pg_1', patch: { camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' }], hold: 200 } }]);
    expect(applyOps(doc, ops).pages[0].motion).toMatchObject({ clips: [{ id: 'mc_s3', preset: 'hyperspin', at: { ms: 500 }, params: { spin: 9 } }], camera: [{ panelId: 'pn_1_1', move: 'dolly-zoom' }], hold: 200 });
    rejects(() => sanitize(doc, [motionOp('mc_s3', { params: { spin: 3 } })]), 400, /can't be changed in this version/);
    rejects(() => sanitize(doc, [motionOp('mc_new', pop({ preset: 'hyperspin', role: 'emphasis' }))]), 400, /isn't available/);
  });
});
