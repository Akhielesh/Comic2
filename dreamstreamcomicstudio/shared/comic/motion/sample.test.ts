// PE-MOTION-ENGINE evaluator (master plan §2.5 "Evaluator"; §2.12 tests): sampleAt is pure and deterministic per seed,
// anchored to reading beats, keyframes override channel by channel, dangling targets are inert, a balloon chain moves
// as one unit keyed by its head, stored values past the write bounds are clamped at draw time, flashes stay ≤ 3 Hz, and
// reveals run in the text's direction (right to left for Urdu and Arabic).

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { letteringNodes, type SvgNode } from '../../../components/comicstudio/lettering/svgMarkup';
import { emptyRender, normalizeDoc, type ComicDoc, type Page, type PageLayer } from '../doc';
import { estimateMeasure, letteringAspect, planLettering } from '../lettering/layout';
import { MOTION_LIMITS } from '../limits';
import { lineRevealMs, pageBeats, panelBeatOf } from './beats';
import { CAMERA_MOVES, MOTION_PRESETS, presetDefaults, visibilityOf } from './presets';
import { cameraAt, planMotion, poseEntries, revealRect, revealSpans, revealWordCount, sampleAt, samplePlan, type MotionPlan } from './sample';
import type { MotionClip, PageMotion } from './types';

const overlayDoc = (mutate?: (d: ComicDoc) => void): ComicDoc =>
  makeSampleDoc((d) => {
    d.format = { ...d.format, lettering: 'overlay' };
    d.pages = d.pages.map((p) => ({ ...p, render: { ...emptyRender(), status: 'ready', asset: { path: `p${p.n}.webp`, source: 'generated', at: 1 } } }));
    mutate?.(d);
  });

const LAYER: PageLayer = { id: 'ly_star', kind: 'shape', box: { x: 0.6, y: 0.1, w: 0.1, h: 0.1 }, clip: 'pg_1_p2', shape: { type: 'ellipse' } };
const OPAQUE = { id: 'ly_holo', kind: 'hologram', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } } as PageLayer;

const clip = (id: string, patch: Partial<MotionClip>): MotionClip => ({
  id,
  target: { k: 'line', id: 'pg_1_l4' },
  role: 'enter',
  preset: 'pop',
  at: { anchor: 'reveal', ms: 0 },
  ...patch
});

/** Page 1 of the overlay sample with these clips (and a camera / hold when given). */
const animated = (clips: MotionClip[], extra: Omit<PageMotion, 'clips'> = {}, doc = overlayDoc()): { doc: ComicDoc; page: Page } => {
  const page: Page = { ...doc.pages[0], layers: [LAYER, OPAQUE], motion: { clips, ...extra } };
  return { doc: { ...doc, pages: [page, ...doc.pages.slice(1)] }, page };
};

const sample = (doc: ComicDoc, page: Page, ms: number, seed?: number) => sampleAt(doc, page, pageBeats(doc, page), ms, seed === undefined ? {} : { seed });

/**
 * The flashes a player draws on `key` in its busiest second, read frame by frame off the pose map (what the reader sees:
 * opacity, reveal and a collapsed scale), independently of budget.ts: a swing is a change of at least 0.1 against the
 * last turn, a flash two swings.
 */
const drawnFlashes = (plan: MotionPlan, key: string, toMs: number, stepMs = 1): number => {
  const times: number[] = [];
  const first = samplePlan(plan, 0).get(key);
  let dir = 0;
  let hi = first ? visibilityOf(first) : 1;
  let lo = hi;
  let ext = hi;
  for (let ms = 0; ms <= toMs; ms += stepMs) {
    const pose = samplePlan(plan, ms).get(key);
    const v = pose ? visibilityOf(pose) : 1;
    let turned = false;
    if (dir === 0) {
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
      if (hi - v >= 0.1) [dir, ext, turned] = [-1, v, true];
      else if (v - lo >= 0.1) [dir, ext, turned] = [1, v, true];
    } else if (dir > 0) {
      if (v > ext) ext = v;
      else if (ext - v >= 0.1) [dir, ext, turned] = [-1, v, true];
    } else if (v < ext) ext = v;
    else if (v - ext >= 0.1) [dir, ext, turned] = [1, v, true];
    if (turned) times.push(ms);
  }
  let best = 0;
  let l = 0;
  for (let h = 0; h < times.length; h += 1) {
    while (times[h] - times[l] >= 1000) l += 1;
    best = Math.max(best, h - l + 1);
  }
  return Math.floor(best / 2);
};

const BUSY = [
  clip('mc_pop', { preset: 'pop', target: { k: 'line', id: 'pg_1_l1' } }),
  clip('mc_jit', { role: 'emphasis', preset: 'jitter', repeat: 3, target: { k: 'line', id: 'pg_1_l2' } }),
  clip('mc_type', { preset: 'typewriter', target: { k: 'line', id: 'pg_1_l4' } }),
  clip('mc_flick', { role: 'emphasis', preset: 'flicker', target: { k: 'panel', id: 'pg_1_p3' }, at: { anchor: 'panel', ms: 200 } }),
  clip('mc_float', { role: 'loop', preset: 'float', target: { k: 'layer', id: 'ly_star' }, at: { anchor: 'page', ms: 0 } }),
  clip('mc_spin', { preset: 'spin-in', ease: 'damped', target: { k: 'panel', id: 'pg_1_p2' }, at: { anchor: 'panel', ms: -100 } }),
  clip('mc_key', { role: 'emphasis', preset: 'pulse', target: { k: 'line', id: 'pg_1_l5' }, keys: [{ t: 0, s: 1, r: 0 }, { t: 0.5, s: 1.4, r: 30 }, { t: 1, s: 1, r: 0 }] })
];

describe('sampleAt is pure and deterministic per seed', () => {
  it('byte-identical JSON on repeat runs, frame by frame, and a different seed moves the seeded presets', () => {
    const { doc, page } = animated(BUSY, { camera: [{ panelId: 'pg_1_p3', move: 'shake' }], hold: 400 });
    const beats = pageBeats(doc, page);
    const frames = (seed: number) => {
      const plan = planMotion(doc, page, beats, { seed });
      const out: unknown[] = [];
      for (let ms = 0; ms <= beats.totalMs; ms += 33) out.push([ms, poseEntries(samplePlan(plan, ms))]);
      return JSON.stringify(out);
    };
    const a = frames(7);
    expect(frames(7)).toBe(a);
    // And the one-shot call agrees with plan + sample.
    expect(JSON.stringify(poseEntries(sampleAt(doc, page, beats, 3333, { seed: 7 })))).toBe(JSON.stringify(poseEntries(samplePlan(planMotion(doc, page, beats, { seed: 7 }), 3333))));
    expect(frames(8)).not.toBe(a);
    expect(a.length).toBeGreaterThan(10_000);
  });

  it('every animated target appears, in first-clip order, every frame', () => {
    const { doc, page } = animated(BUSY);
    const keys = [...sample(doc, page, 0).keys()];
    expect(keys).toEqual(['line:pg_1_l1', 'line:pg_1_l2', 'line:pg_1_l4', 'panel:pg_1_p3', 'layer:ly_star', 'panel:pg_1_p2', 'line:pg_1_l5']);
    expect([...sample(doc, page, 99_999).keys()]).toEqual(keys);
  });
});

describe('time is anchored to reading beats', () => {
  it('a clip starts at its anchor plus its offset: reveal, panel and page anchors', () => {
    const { doc, page } = animated([
      clip('mc_r', { preset: 'fade', target: { k: 'line', id: 'pg_1_l4' }, at: { anchor: 'reveal', ms: 100 } }),
      clip('mc_p', { preset: 'fade', target: { k: 'panel', id: 'pg_1_p2' }, at: { anchor: 'panel', ms: -200 } }),
      clip('mc_g', { preset: 'fade', target: { k: 'layer', id: 'ly_star' }, at: { anchor: 'page', ms: 50 } })
    ]);
    const beats = pageBeats(doc, page);
    const starts = new Map(planMotion(doc, page, beats).clips.map((c) => [c.pc.clip.id, c.startMs]));
    expect(starts.get('mc_r')).toBe(lineRevealMs(beats, 'pg_1_l4')! + 100);
    expect(starts.get('mc_p')).toBe(panelBeatOf(beats, 'pg_1_p2')!.startMs - 200);
    expect(starts.get('mc_g')).toBe(50);
  });

  it('when dialogue grows the reveal moves, and the clip moves with it', () => {
    const c = clip('mc_r', { preset: 'fade', target: { k: 'line', id: 'pg_1_l4' } });
    const { doc, page } = animated([c]);
    const longer: Page = { ...page, panels: page.panels.map((p) => (p.id === 'pg_1_p3' ? { ...p, lines: p.lines.map((l) => (l.id === 'pg_1_l3' ? { ...l, text: 'Thief! Stop her! Somebody stop that girl right now!' } : l)) } : p)) };
    const before = planMotion(doc, page, pageBeats(doc, page)).clips[0].startMs;
    const after = planMotion(doc, longer, pageBeats(doc, longer)).clips[0].startMs;
    const moved = lineRevealMs(pageBeats(doc, longer), 'pg_1_l4')! - lineRevealMs(pageBeats(doc, page), 'pg_1_l4')!;
    expect(moved).toBeGreaterThan(0);
    expect(after - before).toBe(moved);
  });

  it('entrances are hidden until they start and as drawn after; exits the other way; emphases rest outside their plays; loops keep cycling', () => {
    const { doc, page } = animated([
      clip('mc_in', { preset: 'fade', dur: 400, target: { k: 'line', id: 'pg_1_l1' }, at: { anchor: 'page', ms: 1000 } }),
      clip('mc_out', { role: 'exit', preset: 'fade-out', dur: 400, target: { k: 'line', id: 'pg_1_l2' }, at: { anchor: 'page', ms: 1000 } }),
      clip('mc_em', { role: 'emphasis', preset: 'pulse', dur: 400, repeat: 1, target: { k: 'line', id: 'pg_1_l3' }, at: { anchor: 'page', ms: 1000 } }),
      clip('mc_loop', { role: 'loop', preset: 'sway', dur: 400, target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 1000 } })
    ]);
    const at = (ms: number) => sample(doc, page, ms);
    expect(at(999).get('line:pg_1_l1')!.o).toBe(0);
    expect(at(1200).get('line:pg_1_l1')!.o).toBeGreaterThan(0);
    expect(at(1400).get('line:pg_1_l1')!.o).toBe(1);
    expect(at(999).get('line:pg_1_l2')!.o).toBe(1);
    expect(at(1400).get('line:pg_1_l2')!.o).toBe(0);
    expect(at(20_000).get('line:pg_1_l2')!.o).toBe(0);
    expect(at(999).get('line:pg_1_l3')!.s).toBe(1);
    expect(at(1200).get('line:pg_1_l3')!.s).toBeGreaterThan(1);
    expect(at(1600).get('line:pg_1_l3')!.s).toBeGreaterThan(1); // the repeat
    expect(at(1800).get('line:pg_1_l3')!.s).toBe(1);
    expect(at(999).get('panel:pg_1_p1')!.r).toBe(0);
    expect(at(1100).get('panel:pg_1_p1')!.r).toBeGreaterThan(0);
    expect(at(1100 + 400 * 25).get('panel:pg_1_p1')!.r).toBeCloseTo(at(1100).get('panel:pg_1_p1')!.r, 6);
  });
});

describe('keyframes, composition and the write bounds', () => {
  it('keyframes override the preset channel by channel', () => {
    const keyed = clip('mc_k', { preset: 'slide', ease: 'linear', dur: 1000, target: { k: 'line', id: 'pg_1_l1' }, at: { anchor: 'page', ms: 0 }, keys: [{ t: 0, s: 2 }, { t: 1, s: 1 }] });
    const plain = { ...keyed, id: 'mc_p', keys: undefined, target: { k: 'line' as const, id: 'pg_1_l2' } };
    const { doc, page } = animated([keyed, plain]);
    const poses = sample(doc, page, 500);
    const k = poses.get('line:pg_1_l1')!;
    const p = poses.get('line:pg_1_l2')!;
    expect(k.s).toBeCloseTo(1.5, 6); // keyed
    expect(p.s).toBe(1);
    expect(k.dx).toBe(p.dx); // the preset's slide, untouched by the keys
    expect(k.o).toBe(p.o);
    expect(k.dx).toBeLessThan(0);
  });

  it('several clips on one target compose: offsets add, scales and opacities multiply', () => {
    const a = clip('mc_a', { role: 'exit', preset: 'drop-out', ease: 'linear', dur: 1000, target: { k: 'line', id: 'pg_1_l1' }, at: { anchor: 'page', ms: 0 } });
    const b = clip('mc_b', { role: 'emphasis', preset: 'pulse', ease: 'linear', dur: 1000, target: { k: 'line', id: 'pg_1_l1' }, at: { anchor: 'page', ms: 0 } });
    const { doc, page } = animated([a, b]);
    const both = sample(doc, page, 500).get('line:pg_1_l1')!;
    const only = (c: MotionClip) => {
      const one = animated([c]);
      return sample(one.doc, one.page, 500).get('line:pg_1_l1')!;
    };
    expect(both.dy).toBeCloseTo(only(a).dy + only(b).dy, 6);
    expect(both.s).toBeCloseTo(only(a).s * only(b).s, 6);
    expect(both.o).toBeCloseTo(only(a).o * only(b).o, 6);
  });

  it('stacked clips cannot add up past the write bounds: the composed pose is clamped too', () => {
    const maxed = (id: string) =>
      clip(id, {
        role: 'emphasis',
        preset: 'pulse',
        dur: 1000,
        target: { k: 'line', id: 'pg_1_l1' },
        at: { anchor: 'page', ms: 0 },
        keys: [{ t: 0, s: MOTION_LIMITS.keyScaleMax, x: MOTION_LIMITS.keyOffsetMax, r: MOTION_LIMITS.keyRotateMax }, { t: 1, s: MOTION_LIMITS.keyScaleMax, x: MOTION_LIMITS.keyOffsetMax, r: MOTION_LIMITS.keyRotateMax }]
      });
    const { doc, page } = animated([maxed('mc_1'), maxed('mc_2'), maxed('mc_3')]);
    expect(sample(doc, page, 500).get('line:pg_1_l1')).toMatchObject({ s: MOTION_LIMITS.keyScaleMax, dx: MOTION_LIMITS.keyOffsetMax, r: MOTION_LIMITS.keyRotateMax });
  });

  it('an out-of-range stored value survives the load and is clamped at draw time', () => {
    const wild = clip('mc_w', {
      role: 'emphasis',
      preset: 'pulse',
      dur: 1000,
      target: { k: 'line', id: 'pg_1_l1' },
      at: { anchor: 'page', ms: 0 },
      params: { amount: 40 },
      keys: [{ t: 0, s: 50, x: 9, r: 5000 }, { t: 1, s: 50, x: 9, r: 5000 }]
    });
    const { doc } = animated([wild], { hold: 999_999 });
    const loaded = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    const stored = loaded.pages[0].motion!;
    // The load path keeps any finite stored value (PE-0: load bounds vs write bounds)...
    expect(stored.clips[0].keys![0]).toMatchObject({ s: 50, x: 9, r: 5000 });
    expect(stored.clips[0].params).toEqual({ amount: 40 });
    expect(stored.hold).toBe(999_999);
    // ...and every player clamps it to the MOTION_LIMITS write bounds.
    const pose = sample(loaded, loaded.pages[0], 500).get('line:pg_1_l1')!;
    expect(pose.s).toBe(MOTION_LIMITS.keyScaleMax);
    expect(pose.dx).toBe(MOTION_LIMITS.keyOffsetMax);
    expect(pose.r).toBe(MOTION_LIMITS.keyRotateMax);
    expect(pageBeats(loaded, loaded.pages[0]).holdMs).toBe(MOTION_LIMITS.holdMaxMs);
    // A param past its schema plays at the schema's edge (pulse amount ≤ 0.5).
    const spec = MOTION_PRESETS.pulse.params.amount;
    const edge = spec.kind === 'number' ? spec.max : Number.NaN;
    const unkeyed = animated([{ ...wild, keys: undefined }]);
    const atEdge = animated([{ ...wild, keys: undefined, params: { amount: edge } }]);
    const s = sample(unkeyed.doc, unkeyed.page, 500).get('line:pg_1_l1')!.s;
    expect(s).toBe(sample(atEdge.doc, atEdge.page, 500).get('line:pg_1_l1')!.s);
    const usual = animated([{ ...wild, keys: undefined, params: undefined }]);
    expect(s).toBeGreaterThan(sample(usual.doc, usual.page, 500).get('line:pg_1_l1')!.s);
    expect(s).toBeLessThanOrEqual(1 + edge);
  });
});

describe('dangling targets are inert', () => {
  it('a clip whose target or anchor panel is not on the page, an opaque overlay, an unknown preset or ease is skipped', () => {
    const { doc, page } = animated([
      clip('mc_ok', { target: { k: 'line', id: 'pg_1_l1' } }),
      clip('mc_gone_line', { target: { k: 'line', id: 'pg_9_l1' } }),
      clip('mc_gone_layer', { target: { k: 'layer', id: 'ly_nope' } }),
      clip('mc_gone_panel', { target: { k: 'panel', id: 'pg_9_p1' } }),
      clip('mc_opaque', { target: { k: 'layer', id: 'ly_holo' } }),
      clip('mc_anchor', { target: { k: 'line', id: 'pg_1_l2' }, at: { anchor: 'panel', panelId: 'pg_9_p1', ms: 0 } }),
      clip('mc_layer_free', { target: { k: 'layer', id: 'ly_star' }, at: { anchor: 'panel', ms: 0 } }),
      clip('mc_preset', { target: { k: 'line', id: 'pg_1_l3' }, preset: 'warp-in' as MotionClip['preset'] }),
      clip('mc_ease', { target: { k: 'line', id: 'pg_1_l5' }, ease: 'wobble' as MotionClip['ease'] })
    ]);
    // ly_star is clipped to pg_1_p2, so its 'panel' anchor resolves; only mc_ok and mc_layer_free play.
    expect([...sample(doc, page, 5000).keys()]).toEqual(['line:pg_1_l1', 'layer:ly_star']);
    // A layer with no panel and a 'panel' anchor without panelId has nothing to count from: inert too.
    const free = { ...page, layers: [{ ...LAYER, clip: undefined }] };
    expect([...sample(doc, free, 5000).keys()]).toEqual(['line:pg_1_l1']);
  });

  it('undoing a delete brings the animation back: the clip was kept, only skipped', () => {
    const { doc, page } = animated([clip('mc_l2', { preset: 'fade', target: { k: 'line', id: 'pg_1_l2' } })]);
    const deleted: Page = { ...page, panels: page.panels.map((p) => (p.id === 'pg_1_p2' ? { ...p, lines: [] } : p)) };
    expect(sample(doc, deleted, 100_000).size).toBe(0);
    expect(sample(doc, page, 100_000).get('line:pg_1_l2')).toBeDefined();
  });

  it('in-art lettering draws no balloons, so a line clip is inert there; panels and overlays still play', () => {
    const doc = overlayDoc((d) => (d.format.lettering = 'in_art'));
    const { page } = animated([clip('mc_l', { target: { k: 'line', id: 'pg_1_l1' } }), clip('mc_p', { target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'reveal', ms: 0 } })], {}, doc);
    expect([...sample(doc, page, 0).keys()]).toEqual(['panel:pg_1_p1']);
    // A reveal anchor on a panel means the moment its reveals begin.
    const beats = pageBeats(doc, page);
    expect(planMotion(doc, page, beats).clips[0].startMs).toBe(panelBeatOf(beats, 'pg_1_p1')!.startMs + 450);
  });

  it('only the first MOTION_LIMITS.clipsPerPage clips are read', () => {
    const many = Array.from({ length: MOTION_LIMITS.clipsPerPage + 5 }, (_, i) => clip(`mc_${i}`, { target: { k: 'line', id: i < MOTION_LIMITS.clipsPerPage ? 'pg_1_l1' : 'pg_1_l2' } }));
    const { doc, page } = animated(many);
    expect([...sample(doc, page, 0).keys()]).toEqual(['line:pg_1_l1']);
  });
});

describe('a linked balloon chain animates as one unit keyed by its head', () => {
  const chainDoc = () =>
    overlayDoc((d) => {
      d.pages[0] = {
        ...d.pages[0],
        balloons: [
          ...d.pages[0].balloons.filter((b) => b.lineId !== 'pg_1_l5'),
          { lineId: 'pg_1_l4', x: 0.5, y: 0.62, w: 0.2, linkTo: 'pg_1_l3' },
          { lineId: 'pg_1_l5', x: 0.6, y: 0.8, w: 0.2, linkTo: 'pg_1_l4' }
        ]
      };
    });

  it('a clip on any member moves the whole chain, under the head’s key, from the head’s reveal', () => {
    const doc = chainDoc();
    const onTail = animated([clip('mc_t', { preset: 'pop', target: { k: 'line', id: 'pg_1_l5' } })], {}, doc);
    const onHead = animated([clip('mc_t', { preset: 'pop', target: { k: 'line', id: 'pg_1_l3' } })], {}, doc);
    const beats = pageBeats(doc, onTail.page);
    const headReveal = lineRevealMs(beats, 'pg_1_l3')!;
    expect(planMotion(doc, onTail.page, beats).clips[0].startMs).toBe(headReveal);
    for (const ms of [0, headReveal + 50, headReveal + 150, 99_999]) {
      const tail = sample(doc, onTail.page, ms);
      expect([...tail.keys()]).toEqual(['line:pg_1_l3']);
      expect(tail).toEqual(sample(doc, onHead.page, ms));
    }
    // Two members' clips compose on the one unit.
    const both = animated([clip('mc_1', { role: 'emphasis', preset: 'pulse', target: { k: 'line', id: 'pg_1_l4' } }), clip('mc_2', { role: 'emphasis', preset: 'wiggle', target: { k: 'line', id: 'pg_1_l5' } })], {}, doc);
    const mid = sample(doc, both.page, headReveal + 250);
    expect([...mid.keys()]).toEqual(['line:pg_1_l3']);
    expect(mid.get('line:pg_1_l3')!.s).toBeGreaterThan(1);
    expect(mid.get('line:pg_1_l3')!.r).not.toBe(0);
  });

  /** The data-link-group units svgMarkup draws for a page (each a list of line ids). */
  const drawnGroups = (doc: ComicDoc, page: Page): string[][] => {
    const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
    const groups: string[][] = [];
    const walk = (nodes: readonly SvgNode[]) => {
      for (const n of nodes) {
        const g = n.attrs?.['data-link-group'];
        if (typeof g === 'string') groups.push(g.split(' '));
        if (n.children) walk(n.children);
      }
    };
    walk(letteringNodes(plans, { aspect: letteringAspect(doc, page) }));
    return groups;
  };
  const withText = (doc: ComicDoc, lineId: string, text: string): ComicDoc => ({
    ...doc,
    pages: doc.pages.map((p, i) => (i ? p : { ...p, panels: p.panels.map((pl) => ({ ...pl, lines: pl.lines.map((l) => (l.id === lineId ? { ...l, text } : l)) })) }))
  });

  it('a chain broken by a line the lettering does not draw is two balloons here too', () => {
    // l3 ← l4 ← l5 with l4 empty: svgMarkup draws l3 and l5 alone, so a clip on l5 moves l5, keyed by l5.
    const broken = withText(chainDoc(), 'pg_1_l4', '   ');
    expect(drawnGroups(broken, broken.pages[0])).toEqual([]);
    const { page } = animated([clip('mc_t', { role: 'emphasis', preset: 'pulse', target: { k: 'line', id: 'pg_1_l5' } })], {}, broken);
    expect([...sample(broken, page, 99_999).keys()]).toEqual(['line:pg_1_l5']);
    expect(planMotion(broken, page, pageBeats(broken, page)).clips[0].startMs).toBe(lineRevealMs(pageBeats(broken, page), 'pg_1_l5'));
    // With the head empty, the chain that is drawn is l4 ← l5, keyed by l4.
    const headless = withText(chainDoc(), 'pg_1_l3', '');
    const groups = drawnGroups(headless, headless.pages[0]);
    expect(groups.map((g) => [...g].sort())).toEqual([['pg_1_l4', 'pg_1_l5']]);
    const onTail = animated([clip('mc_t', { role: 'emphasis', preset: 'pulse', target: { k: 'line', id: 'pg_1_l5' } })], {}, headless);
    expect([...sample(headless, onTail.page, 99_999).keys()]).toEqual(['line:pg_1_l4']);
  });

  it('the unit is the lettering’s own data-link-group, and its head is in it', () => {
    const doc = chainDoc();
    const page = doc.pages[0];
    const plans = planLettering(doc, page, letteringAspect(doc, page), estimateMeasure);
    const groups: string[][] = [];
    const walk = (nodes: readonly SvgNode[]) => {
      for (const n of nodes) {
        const g = n.attrs?.['data-link-group'];
        if (typeof g === 'string') groups.push(g.split(' '));
        if (n.children) walk(n.children);
      }
    };
    walk(letteringNodes(plans, { aspect: letteringAspect(doc, page) }));
    expect(groups).toHaveLength(1);
    expect([...groups[0]].sort()).toEqual(['pg_1_l3', 'pg_1_l4', 'pg_1_l5']);
    const { page: p } = animated([clip('mc_x', { target: { k: 'line', id: groups[0][groups[0].length - 1] } })], {}, doc);
    expect(groups[0]).toContain([...sample(doc, p, 0).keys()][0].slice('line:'.length));
  });
});

describe('flashes never pass 3 Hz at draw time', () => {
  it('a target whose clips would flash faster keeps its opacity as drawn; a slow flicker still flickers', () => {
    const fast = clip('mc_fast', { role: 'emphasis', preset: 'flicker', dur: 1000, params: { flashes: 5 }, target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 0 } });
    const slow = clip('mc_slow', { role: 'emphasis', preset: 'flicker', dur: 1000, params: { flashes: 2 }, target: { k: 'panel', id: 'pg_1_p2' }, at: { anchor: 'page', ms: 0 } });
    const { doc, page } = animated([fast, slow]);
    const opacities = (key: string) => Array.from({ length: 500 }, (_, i) => sample(doc, page, i * 2).get(key)!.o);
    expect(new Set(opacities('panel:pg_1_p1'))).toEqual(new Set([1]));
    expect(Math.min(...opacities('panel:pg_1_p2'))).toBeLessThan(0.5);
    // Two slow flickers on one target add up past the limit: both are calmed.
    const twice = animated([slow, { ...slow, id: 'mc_slow2', at: { anchor: 'page', ms: 100 } }]);
    expect(new Set(Array.from({ length: 300 }, (_, i) => sample(twice.doc, twice.page, i * 4).get('panel:pg_1_p2')!.o))).toEqual(new Set([1]));
  });
});

describe('entrances and exits play once (a repeat would flash)', () => {
  it('a repeated pop, zoom punch, pop-out or zoom-out draws no flash, and settles after one play', () => {
    for (const [role, preset] of [
      ['enter', 'pop'],
      ['enter', 'zoom-punch'],
      ['exit', 'pop-out'],
      ['exit', 'zoom-out']
    ] as const) {
      const { doc, page } = animated([clip('mc_r', { role, preset, repeat: 5, target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 1000 } })]);
      const plan = planMotion(doc, page, pageBeats(doc, page));
      const dur = MOTION_PRESETS[preset].dur;
      expect(drawnFlashes(plan, 'panel:pg_1_p1', 1000 + dur * 6 + 1000), preset).toBe(0);
      const after = samplePlan(plan, 1000 + dur + 1).get('panel:pg_1_p1')!;
      expect(after.o, preset).toBe(role === 'enter' ? 1 : 0);
    }
  });

  it('a 100 ms fade repeated 20 times fades in once and stays (it drew 10 flashes a second when it replayed)', () => {
    const { doc, page } = animated([clip('mc_f', { preset: 'fade', dur: 100, repeat: 20, target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 0 } })]);
    const plan = planMotion(doc, page, pageBeats(doc, page));
    expect(drawnFlashes(plan, 'panel:pg_1_p1', 3000)).toBe(0);
    for (let ms = 100; ms < 3000; ms += 7) expect(samplePlan(plan, ms).get('panel:pg_1_p1')!.o).toBe(1);
  });

  it('a repeated typewriter types once: the text never vanishes and comes back', () => {
    const { doc, page } = animated([clip('mc_t', { preset: 'typewriter', dur: 200, repeat: 10, target: { k: 'line', id: 'pg_1_l4' } })]);
    const beats = pageBeats(doc, page);
    const start = lineRevealMs(beats, 'pg_1_l4')!;
    const plan = planMotion(doc, page, beats);
    let last = 0;
    for (let ms = start; ms < start + 2400; ms += 5) {
      const r = samplePlan(plan, ms).get('line:pg_1_l4')!.reveal;
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(last).toBe(1);
  });
});

describe('the flash guard reads what the reader sees, with the player’s own seed', () => {
  it('a flicker the sanitizer passes at seed 0 never draws more than 3 flashes a second, whatever seed the player uses', () => {
    const { doc, page } = animated([clip('mc_f', { role: 'emphasis', preset: 'flicker', dur: 700, repeat: 6, params: { flashes: 2 }, target: { k: 'panel', id: 'pg_1_p2' }, at: { anchor: 'page', ms: 0 } })]);
    const beats = pageBeats(doc, page);
    for (let seed = 0; seed <= 40; seed += 1) {
      const plan = planMotion(doc, page, beats, { seed });
      const drawn = drawnFlashes(plan, 'panel:pg_1_p2', 700 * 7 + 100, 2);
      expect(drawn, `seed ${seed}`).toBeLessThanOrEqual(MOTION_LIMITS.flashHzMax);
      if (!plan.clips[0].holdOpacity) expect(drawn, `seed ${seed}`).toBe(3);
    }
  });

  it('a keyed shrink to nothing ten times a second is held: the object stays in sight and still moves', () => {
    const vanish = clip('mc_v', { role: 'loop', preset: 'float', dur: 100, params: { amount: 0.05 }, keys: [{ t: 0, s: 1 }, { t: 0.5, s: 0 }, { t: 1, s: 1 }], target: { k: 'panel', id: 'pg_1_p1' }, at: { anchor: 'page', ms: 0 } });
    const { doc, page } = animated([vanish]);
    const plan = planMotion(doc, page, pageBeats(doc, page));
    expect(plan.clips[0].holdOpacity).toBe(true);
    expect(drawnFlashes(plan, 'panel:pg_1_p1', 2000)).toBe(0);
    const dys = new Set(Array.from({ length: 50 }, (_, i) => samplePlan(plan, i * 3).get('panel:pg_1_p1')!.dy));
    expect(dys.size).toBeGreaterThan(5);
  });

  it('a flickering panel and a flickering balloon inside it add up: both are held; apart, each still flickers', () => {
    const flick = (id: string, target: MotionClip['target']) => clip(id, { role: 'emphasis', preset: 'flicker', dur: 1000, params: { flashes: 3 }, target, at: { anchor: 'page', ms: 0 } });
    const nested = animated([flick('mc_p', { k: 'panel', id: 'pg_1_p3' }), flick('mc_l', { k: 'line', id: 'pg_1_l4' })]);
    const plan = planMotion(nested.doc, nested.page, pageBeats(nested.doc, nested.page));
    expect(plan.clips.map((c) => c.holdOpacity)).toEqual([true, true]);
    expect(drawnFlashes(plan, 'panel:pg_1_p3', 1200)).toBe(0);
    expect(drawnFlashes(plan, 'line:pg_1_l4', 1200)).toBe(0);
    const apart = animated([flick('mc_p', { k: 'panel', id: 'pg_1_p1' }), flick('mc_l', { k: 'line', id: 'pg_1_l4' })]);
    const free = planMotion(apart.doc, apart.page, pageBeats(apart.doc, apart.page));
    expect(free.clips.map((c) => c.holdOpacity)).toEqual([false, false]);
    expect(drawnFlashes(free, 'panel:pg_1_p1', 1200)).toBe(3);
  });

  it('re-planning after an edit is cheap: every clip’s flash count is read once', () => {
    const keyed = Array.from({ length: MOTION_LIMITS.clipsPerPage }, (_, i) =>
      clip(`mc_${i}`, {
        role: 'loop',
        preset: 'blink',
        dur: 300 + i,
        target: { k: 'panel', id: `pg_1_p${(i % 3) + 1}` },
        at: { anchor: 'page', ms: 0 },
        keys: Array.from({ length: MOTION_LIMITS.keysPerClip }, (_, k) => ({ t: k / (MOTION_LIMITS.keysPerClip - 1), o: k % 2 ? 0.2 : 1, s: 1 + (k % 3) / 10 }))
      })
    );
    const { doc, page } = animated(keyed);
    const beats = pageBeats(doc, page);
    planMotion(doc, page, beats, { seed: 5 });
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      planMotion(doc, page, beats, { seed: 5 });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(10);
  });
});

describe('reveals run in the text’s direction (typewriter, word cascade, ink wipe)', () => {
  const urduDoc = () =>
    overlayDoc((d) => {
      d.format = { ...d.format, language: 'ur' };
      d.pages[0] = { ...d.pages[0], panels: d.pages[0].panels.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l, text: 'سلام دوست چلو چاند تک چلیں' })) })) };
    });

  it('the RTL wipe runs right to left: the shown part grows from the right edge', () => {
    const doc = urduDoc();
    const { page } = animated([clip('mc_wipe', { preset: 'ink-wipe', dur: 600, target: { k: 'line', id: 'pg_1_l1' } })], {}, doc);
    const beats = pageBeats(doc, page);
    const start = lineRevealMs(beats, 'pg_1_l1')!;
    const box = { x: 0.1, y: 0.1, w: 0.4, h: 0.1 };
    const rects = [100, 300, 500].map((dt) => {
      const pose = sampleAt(doc, page, beats, start + dt).get('line:pg_1_l1')!;
      expect(pose).toMatchObject({ mask: 'wipe', dir: 'rtl' });
      return revealRect(box, pose.reveal, pose.dir!);
    });
    for (const r of rects) expect(r.x + r.w).toBeCloseTo(box.x + box.w, 9);
    expect(rects[0].x).toBeGreaterThan(rects[1].x);
    expect(rects[1].x).toBeGreaterThan(rects[2].x);
    // Done: no mask left, the whole balloon shows.
    const done = sampleAt(doc, page, beats, start + 600).get('line:pg_1_l1')!;
    expect(done.reveal).toBe(1);
    expect(done.mask).toBeUndefined();
    // The same clip on an English book wipes left to right.
    const en = animated([clip('mc_wipe', { preset: 'ink-wipe', dur: 600, target: { k: 'line', id: 'pg_1_l1' } })]);
    const enPose = sample(en.doc, en.page, lineRevealMs(pageBeats(en.doc, en.page), 'pg_1_l1')! + 300).get('line:pg_1_l1')!;
    expect(enPose.dir).toBe('ltr');
    expect(revealRect(box, enPose.reveal, 'ltr').x).toBe(box.x);
  });

  it('a line in another language keeps its own direction; typewriter and cascade masks follow it', () => {
    const doc = overlayDoc((d) => {
      d.pages[0] = { ...d.pages[0], panels: d.pages[0].panels.map((p) => ({ ...p, lines: p.lines.map((l) => (l.id === 'pg_1_l1' ? { ...l, lang: 'ar', text: 'مرحبا يا صديقي' } : l)) })) };
    });
    const { page } = animated([clip('mc_t', { preset: 'typewriter', target: { k: 'line', id: 'pg_1_l1' } }), clip('mc_w', { preset: 'word-cascade', target: { k: 'line', id: 'pg_1_l2' } })], {}, doc);
    const beats = pageBeats(doc, page);
    const t = sampleAt(doc, page, beats, lineRevealMs(beats, 'pg_1_l1')! + 600).get('line:pg_1_l1')!;
    const w = sampleAt(doc, page, beats, lineRevealMs(beats, 'pg_1_l2')! + 500).get('line:pg_1_l2')!;
    expect(t).toMatchObject({ mask: 'lines', dir: 'rtl' });
    expect(w).toMatchObject({ mask: 'words', dir: 'ltr' });
    expect(t.reveal).toBeCloseTo(0.5, 6);
  });

  it('the masks read the lettering as laid out: line widths for the typewriter, a word count for the cascade', () => {
    expect(revealSpans([100, 80, 20], 0)).toEqual([0, 0, 0]);
    expect(revealSpans([100, 80, 20], 0.5)).toEqual([1, 0, 0]);
    expect(revealSpans([100, 80, 20], 0.7)).toEqual([1, 0.5, 0]);
    expect(revealSpans([100, 80, 20], 1)).toEqual([1, 1, 1]);
    expect(revealWordCount(5, 0)).toBe(0);
    expect(revealWordCount(5, 0.6)).toBe(3);
    expect(revealWordCount(5, 1)).toBe(5);
    expect(revealRect({ x: 0, y: 0, w: 1, h: 1 }, 0.25, 'rtl')).toEqual({ x: 0.75, y: 0, w: 0.25, h: 1 });
  });
});

describe('the camera', () => {
  it('a push plays across its panel’s shot; no move, still, an unknown move or a missing panel is no camera', () => {
    const { doc, page } = animated([], { camera: [{ panelId: 'pg_1_p2', move: 'push' }, { panelId: 'pg_1_p1', move: 'still' }, { panelId: 'pg_1_p3', move: 'orbit' as never }, { panelId: 'pg_9_p1', move: 'pull' }] });
    const beats = pageBeats(doc, page);
    const p2 = panelBeatOf(beats, 'pg_1_p2')!;
    const early = cameraAt(doc, page, beats, p2.startMs + 1)!;
    const late = cameraAt(doc, page, beats, p2.startMs + p2.durationMs - 1)!;
    expect(early.panelId).toBe('pg_1_p2');
    expect(late.pose.s).toBeGreaterThan(early.pose.s);
    expect(late.pose.s).toBeLessThanOrEqual(1 + (presetDefaults(CAMERA_MOVES.push.params).amount as number));
    expect(cameraAt(doc, page, beats, panelBeatOf(beats, 'pg_1_p1')!.startMs + 10)).toBeUndefined();
    expect(cameraAt(doc, page, beats, panelBeatOf(beats, 'pg_1_p3')!.startMs + 10)).toBeUndefined();
    expect(cameraAt(doc, page, beats, 10)).toBeUndefined();
  });

  it('an animated pose is always inside the write bounds', () => {
    const { doc, page } = animated(BUSY);
    const beats = pageBeats(doc, page);
    for (let ms = 0; ms < beats.totalMs; ms += 50) {
      for (const pose of sample(doc, page, ms).values()) {
        expect(Math.abs(pose.dx)).toBeLessThanOrEqual(MOTION_LIMITS.keyOffsetMax);
        expect(pose.s).toBeGreaterThanOrEqual(0);
        expect(pose.s).toBeLessThanOrEqual(MOTION_LIMITS.keyScaleMax);
        expect(pose.o).toBeGreaterThanOrEqual(0);
        expect(pose.o).toBeLessThanOrEqual(1);
      }
    }
  });
});
