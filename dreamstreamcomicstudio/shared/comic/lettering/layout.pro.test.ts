// PE-LETTER layout (master plan §0.1 bug "the layout reads only style.rotate, so Balloon.rot and Balloon.minH never draw";
// §2.4; agent-editor plan §4 C-CANVAS): rotation turns body and text while the tail tip stays on its point, the minimum
// height grows the outline, a rotated balloon's page fit uses its turned outline, per-glyph warp for Latin and CJK only,
// and the SFX wobble. Each test fails on the engine before PE-LETTER (756b5a70), which drew none of them.

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizeDoc, type Balloon, type ComicDoc } from '../doc';
import { EDITOR_LIMITS } from '../limits';
import { chainHeadOf, estimateMeasure, letteringAspect, outlineFill, planLettering, turnedOutlineBox, warpAvailableFor, WARP_SCRIPTS, type LetterPlan } from './layout';
import { bubbleGeometry } from './shapes';
import { WARP_SCRIPT_NOTE, WARP_STYLES, type LetterStylePatch } from './style';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;
const plansOf = (doc: ComicDoc, i = 0): LetterPlan[] => planLettering(doc, doc.pages[i], letteringAspect(doc, doc.pages[i]), estimateMeasure);
const planOf = (doc: ComicDoc, id: string) => plansOf(doc).find((p) => p.lineId === id)!;
const withBalloon = (id: string, patch: Partial<Balloon>) =>
  makeSampleDoc((d) => {
    d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === id ? { ...b, ...patch } : b));
  });
const withStyle = (id: string, style: LetterStylePatch, lang?: string) =>
  makeSampleDoc((d) => {
    for (const panel of d.pages[0].panels) for (const l of panel.lines) if (l.id === id) l.style = style;
    if (lang) d.format.language = lang;
  });

/** Turn a point `deg` degrees about (cx, cy), as SVG rotate() does. */
const turn = (p: { x: number; y: number }, deg: number, cx: number, cy: number) => {
  const r = (deg * Math.PI) / 180;
  return { x: cx + (p.x - cx) * Math.cos(r) - (p.y - cy) * Math.sin(r), y: cy + (p.x - cx) * Math.sin(r) + (p.y - cy) * Math.cos(r) };
};
const nums = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** The tail tip vertex of a drawn tail path (straight: M b1 L tip L b2 Z; curved: M b1 Q c1 tip Q c2 b2 Z), local units. */
const tailTip = (d: string) => {
  const n = nums(d);
  return /Q/.test(d) ? { x: n[4], y: n[5] } : { x: n[2], y: n[3] };
};
/** Where a plan's tail tip lands on the page, as svgMarkup / the canvas draw it. */
const drawnTip = (p: LetterPlan) => {
  const local = tailTip(p.geometry.tail!);
  const abs = { x: Math.round(p.x * 100) / 100 + local.x, y: Math.round(p.y * 100) / 100 + local.y };
  return p.transform?.rotate ? turn(abs, p.transform.rotate, p.transform.cx, p.transform.cy) : abs;
};

describe('Balloon.rot: body and text turn together, the tail tip stays on its stored point', () => {
  for (const rot of [45, -45, 30, -15]) {
    it(`at ${rot}° the straight tail of a pinned shout and the curved tail of a whisper land on their stored tips`, () => {
      const doc = makeSampleDoc((d) => {
        d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' || b.lineId === 'pg_1_l2' ? { ...b, rot } : b));
      });
      for (const [id, tx, ty] of [['pg_1_l3', 0.8, 0.75], ['pg_1_l2', 0.2, 0.7]] as const) {
        const p = planOf(doc, id);
        expect(p.transform?.rotate, id).toBeCloseTo(rot, 6);
        expect(p.tip, id).toEqual({ x: tx * 1000, y: ty * H });
        const at = drawnTip(p);
        expect(at.x, `${id} x`).toBeCloseTo(tx * 1000, 1);
        expect(at.y, `${id} y`).toBeCloseTo(ty * H, 1);
      }
    });
  }

  it('rot is clamped to ±EDITOR_LIMITS.balloonRot and adds to a style tilt; 0 or absent draws exactly as before', () => {
    expect(planOf(withBalloon('pg_1_l3', { rot: 200 }), 'pg_1_l3').transform?.rotate).toBe(EDITOR_LIMITS.balloonRot);
    expect(planOf(withBalloon('pg_1_l3', { rot: 0 }), 'pg_1_l3')).toEqual(planOf(makeSampleDoc(), 'pg_1_l3'));
    const tilted = makeSampleDoc((d) => {
      d.pages[0].panels[2].lines[0].style = { rotate: 10 };
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, rot: 20 } : b));
    });
    expect(planOf(tilted, 'pg_1_l3').transform?.rotate).toBe(30);
  });

  it('the page fit keeps a rotated balloon’s turned outline on the page', () => {
    const doc = withBalloon('pg_1_l3', { x: 0.74, y: 0.05, w: 0.26, rot: 45 });
    const p = planOf(doc, 'pg_1_l3');
    const g = p.geometry.bounds;
    const cx = p.transform!.cx;
    const cy = p.transform!.cy;
    const corners = [
      { x: p.x + g.x, y: p.y + g.y },
      { x: p.x + g.x + g.w, y: p.y + g.y },
      { x: p.x + g.x, y: p.y + g.y + g.h },
      { x: p.x + g.x + g.w, y: p.y + g.y + g.h }
    ].map((q) => turn(q, 45, cx, cy));
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(8 - 0.5);
      expect(c.x).toBeLessThanOrEqual(1000 - 8 + 0.5);
      expect(c.y).toBeGreaterThanOrEqual(8 * (1 / ASPECT) - 0.5);
    }
  });
});

describe('Balloon.rot: the safe-area warning judges the turned outline, as the page fit does', () => {
  const SAFE = { x0: 30, y0: 0.03 * ASPECT * H, x1: 970, y1: H - 0.03 * ASPECT * H };
  /** The drawn (turned) outline's box of a plan, plan units. */
  const turnedBox = (p: LetterPlan) => {
    const g = p.geometry.bounds;
    const pts = [
      { x: p.x + g.x, y: p.y + g.y },
      { x: p.x + g.x + g.w, y: p.y + g.y },
      { x: p.x + g.x, y: p.y + g.y + g.h },
      { x: p.x + g.x + g.w, y: p.y + g.y + g.h }
    ].map((q) => (p.transform?.rotate ? turn(q, p.transform.rotate, p.transform.cx, p.transform.cy) : q));
    return { x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) };
  };
  const outside = (b: { x0: number; y0: number; x1: number; y1: number }) => b.x0 < SAFE.x0 - 0.5 || b.y0 < SAFE.y0 - 0.5 || b.x1 > SAFE.x1 + 0.5 || b.y1 > SAFE.y1 + 0.5;
  // A pinned caption (no tail), 0.3 of the page wide and much shorter than wide: turned 45° its box is narrower and taller.
  const caption = (patch: Partial<Balloon>) => planOf(withBalloon('pg_1_l1', { pinned: true, w: 0.3, rot: 45, ...patch }), 'pg_1_l1');

  it('a turned balloon inside the safe area is not flagged, though its unturned outline would reach past it', () => {
    const probe = caption({ x: 0.3, y: 0.3 });
    expect(probe.tip).toBeUndefined();
    const g = probe.geometry.bounds;
    // Stored so the UNTURNED outline's right edge sits at 980 (past the safe edge at 970).
    const p = caption({ x: (980 - (g.x + g.w)) / 1000, y: 0.3 });
    expect(p.x + g.x + g.w).toBeGreaterThan(SAFE.x1 + 1);
    const box = turnedBox(p);
    expect(box.x1).toBeLessThan(SAFE.x1);
    expect(outside(box)).toBe(false);
    expect(p.outOfSafeArea).toBe(false);
  });

  it('a turned balloon whose corner leaves the safe area is flagged, though its unturned outline is inside', () => {
    const p = caption({ x: 0.3, y: 0 });
    const g = p.geometry.bounds;
    // The page fit pushed the turned outline down onto the page edge margin: its top corner is above the safe line,
    // while the unturned outline's top is well inside.
    expect(p.y + g.y).toBeGreaterThan(SAFE.y0 + 1);
    expect(turnedBox(p).y0).toBeLessThan(SAFE.y0);
    expect(p.outOfSafeArea).toBe(true);
    // turnedOutlineBox (for the editor's safe-area fix) is that same turned box.
    const t = turnedOutlineBox(p);
    const b = turnedBox(p);
    for (const [got, want] of [[t.x, b.x0], [t.y, b.y0], [t.x + t.w, b.x1], [t.y + t.h, b.y1]]) expect(got).toBeCloseTo(want, 1);
    // And without the turn, the same stored balloon is drawn inside.
    expect(caption({ x: 0.3, y: 0.3, rot: 0 }).outOfSafeArea).toBe(false);
  });
});

describe('Linked chains turn as one unit keyed by the chain head (master plan §2.4)', () => {
  it('every member takes the head’s Balloon.rot about its own centre; a member’s own rot is not drawn; tails stay on their tips', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, rot: 30 } : b.lineId === 'pg_1_l3' ? { ...b, linkTo: 'pg_1_l2', rot: -10 } : b));
    });
    const head = planOf(doc, 'pg_1_l2');
    const member = planOf(doc, 'pg_1_l3');
    expect(member.linkTo).toBe('pg_1_l2');
    // The editor finds the same head (a rotate edit on any member writes the head's balloon).
    expect([chainHeadOf(doc.pages[0], 'pg_1_l3'), chainHeadOf(doc.pages[0], 'pg_1_l2'), chainHeadOf(doc.pages[0], 'pg_1_l1')]).toEqual(['pg_1_l2', 'pg_1_l2', 'pg_1_l1']);
    expect(head.transform?.rotate).toBe(30);
    expect(member.transform?.rotate).toBe(30);
    // Each about its own text-box centre (where the link neck starts and ends).
    expect(member.transform!.cx).toBeCloseTo(member.x + member.w / 2, 1);
    expect(member.transform!.cy).toBeCloseTo(member.y + member.h / 2, 1);
    for (const [p, tx, ty] of [[head, 0.2, 0.7], [member, 0.8, 0.75]] as const) {
      const at = drawnTip(p);
      expect(at.x).toBeCloseTo(tx * 1000, 1);
      expect(at.y).toBeCloseTo(ty * H, 1);
    }
    // Unlinked, the member draws its own turn again; a head without a turn leaves the chain unturned.
    const apart = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, rot: -10 } : b));
    });
    expect(planOf(apart, 'pg_1_l3').transform?.rotate).toBe(-10);
    const flatHead = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, linkTo: 'pg_1_l2', rot: -10 } : b));
    });
    expect(planOf(flatHead, 'pg_1_l3').transform).toBeUndefined();
    // A linkTo cycle still gives every member one head (its smallest id), so the pair turns together.
    const cycle = makeSampleDoc((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) =>
        b.lineId === 'pg_1_l2' ? { ...b, linkTo: 'pg_1_l3', rot: 20 } : b.lineId === 'pg_1_l3' ? { ...b, linkTo: 'pg_1_l2', rot: -10 } : b
      );
    });
    expect([planOf(cycle, 'pg_1_l2').transform?.rotate, planOf(cycle, 'pg_1_l3').transform?.rotate]).toEqual([20, 20]);
    expect([chainHeadOf(cycle.pages[0], 'pg_1_l2'), chainHeadOf(cycle.pages[0], 'pg_1_l3')]).toEqual(['pg_1_l2', 'pg_1_l2']);
  });
});

describe('Balloon.minH: the outline grows to at least the minimum height, the text centred in it', () => {
  it('a pinned shout with minH 0.3 is drawn ≥ 0.3 of the page tall; without it, as before', () => {
    const before = planOf(makeSampleDoc(), 'pg_1_l3');
    const p = planOf(withBalloon('pg_1_l3', { minH: 0.3 }), 'pg_1_l3');
    expect(before.geometry.bounds.h).toBeLessThan(0.3 * H);
    expect(p.geometry.bounds.h).toBeGreaterThanOrEqual(0.3 * H - 0.05);
    expect(p.geometry.bounds.h).toBeLessThan(0.3 * H + 2);
    expect(p.h).toBeGreaterThan(before.h);
    // Same lines and size; the text block sits in the middle of the taller box.
    expect(p.runs.map((r) => r.text)).toEqual(before.runs.map((r) => r.text));
    expect(p.fontSize).toBe(before.fontSize);
    const textMid = (q: LetterPlan) => (q.runs[0].y + q.runs[q.runs.length - 1].y) / 2;
    expect(textMid(p) - p.y).toBeCloseTo(textMid(before) - before.y + (p.h - before.h) / 2, 1);
    // A minimum below the drawn height changes nothing.
    expect(planOf(withBalloon('pg_1_l3', { minH: 0.01 }), 'pg_1_l3')).toEqual(before);
  });

  it('works for every shape family (boxy, round, spiky, Pro) and is capped at EDITOR_LIMITS.minHMax', () => {
    for (const shape of ['rect', 'oval', 'burst', 'cloud', 'heart', 'icicle', 'radio'] as const) {
      const doc = makeSampleDoc((d) => {
        d.pages[0].panels[2].lines[0].style = { shape: shape as never };
        d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l3' ? { ...b, minH: 0.25 } : b));
      });
      const p = planOf(doc, 'pg_1_l3');
      expect(p.style.shape).toBe(shape);
      expect(p.geometry.bounds.h, shape).toBeGreaterThanOrEqual(0.25 * H - 0.05);
    }
    const capped = planOf(withBalloon('pg_1_l3', { minH: 5 }), 'pg_1_l3');
    expect(capped.geometry.bounds.h).toBeLessThan(EDITOR_LIMITS.minHMax * H + 2);
  });
});

describe('Pro shapes draw through the plan', () => {
  it('a stored Pro shape survives load and its plan carries the Pro outline', () => {
    const doc = normalizeDoc(JSON.parse(JSON.stringify(withStyle('pg_1_l4', { shape: 'heart' as never }))));
    const p = planOf(doc, 'pg_1_l4');
    expect(p.style.shape).toBe('heart');
    const g = bubbleGeometry('heart', p.w, p.h, { inset: p.pad, seed: 0, tail: 'none', tailWidth: 1, stroke: 1 });
    expect(p.geometry.body).toBe(g.body);
    expect(outlineFill('sticky')).toBe(1);
    expect(outlineFill('heart')).toBeCloseTo(Math.PI / 4, 6);
  });
});

describe('Warp: per glyph, Latin and CJK editions only', () => {
  const run0 = (style: LetterStylePatch, lang?: string) => planOf(withStyle('pg_1_l4', style, lang), 'pg_1_l4').runs[0];

  it('each warp style bends the glyphs; none or a tiny amount draws plain text', () => {
    const plain = run0({});
    expect(plain.xs).toBeUndefined();
    for (const warp of WARP_STYLES.filter((w) => w !== 'none')) {
      const r = run0({ warp, warpAmount: 0.6 } as LetterStylePatch);
      expect(r.xs?.length, warp).toBe([...r.text].length);
      if (warp === 'bulge') {
        expect(new Set(r.scales).size, warp).toBeGreaterThan(1);
        // Bigger in the middle than at the ends.
        expect(Math.max(...r.scales!)).toBeGreaterThan(r.scales![0]);
      } else {
        expect(new Set(r.ys).size, warp).toBeGreaterThan(1);
        expect(r.rotates?.some((d) => d !== 0), warp).toBe(true);
      }
      // A negative amount bends the other way.
      const neg = run0({ warp, warpAmount: -0.6 } as LetterStylePatch);
      expect(JSON.stringify(neg), warp).not.toBe(JSON.stringify(r));
    }
    expect(run0({ warp: 'wave', warpAmount: 0.01 } as LetterStylePatch).xs).toBeUndefined();
    expect(run0({ warp: 'none', warpAmount: 0.6 } as LetterStylePatch).xs).toBeUndefined();
    // A stored amount past the write bound draws at the bound (the load keeps any finite number).
    expect(run0({ warp: 'rise', warpAmount: 9 } as LetterStylePatch)).toEqual(run0({ warp: 'rise', warpAmount: 1 } as LetterStylePatch));
  });

  it('a Hindi or Urdu edition draws unwarped; Japanese warps; the note names why', () => {
    for (const lang of ['hi', 'ur', 'te']) {
      expect(warpAvailableFor(lang), lang).toBe(false);
      const r = planOf(withStyle('pg_1_l4', { warp: 'arc', warpAmount: 0.8 } as LetterStylePatch, lang), 'pg_1_l4').runs[0];
      expect(r.ys, lang).toBeUndefined();
    }
    expect(warpAvailableFor('en')).toBe(true);
    expect(warpAvailableFor('ru')).toBe(true);
    expect(warpAvailableFor('ja')).toBe(true);
    expect(WARP_SCRIPTS).toEqual(['Latn', 'Jpan', 'Kore', 'Hans']);
    expect(WARP_SCRIPT_NOTE).toBe("Warp isn't available for this script yet");
  });

  it('SFX wobble jitters each glyph, the same every time, differently per line', () => {
    const doc = withStyle('pg_1_l5', { sfxEffect: 'wobble' as never });
    const a = planOf(doc, 'pg_1_l5').runs[0];
    expect(a.ys?.length).toBe([...a.text].length);
    expect(a.rotates?.some((d) => d !== 0)).toBe(true);
    expect(planOf(withStyle('pg_1_l5', { sfxEffect: 'wobble' as never }), 'pg_1_l5').runs[0]).toEqual(a);
    const other = makeSampleDoc((d) => {
      d.pages[0].panels[2].lines[2].id = 'pg_1_l5b';
      d.pages[0].panels[2].lines[2].style = { sfxEffect: 'wobble' as never };
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l5' ? { ...b, lineId: 'pg_1_l5b' } : b));
    });
    expect(planOf(other, 'pg_1_l5b').runs[0].ys).not.toEqual(a.ys);
  });
});
