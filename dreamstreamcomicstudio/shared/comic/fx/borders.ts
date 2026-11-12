// Border effects (master plan §2.6 "Effects": borders 10, PE-FX): a procedural frame drawn just inside the layer box,
// in ten styles: rough ink, brush, double rule, dashed, dotted, wavy, jagged, film strip, torn paper and scalloped.
// One generator, `frame-border@1`. Pure; registered by fx/generators.ts, never imported by the registry. Parameters
// arrive clamped (fxParamsOf). Every border is a filled ring (the outer contour, then the inner contour wound the other
// way, so the middle stays open) in the isotropic frame (seed.ts): corners stay square on any aspect, at most 400
// segments.
//
// The panel-border styles PanelFrameBorder.style rough, brush, double, dashed, wavy, jagged and film (doc.ts) are this
// generator's styles of the same name, so a frame border can be drawn through renderFx as well.

import type { FxNode } from './types.js';
import { fillPath, FxPath, fxFrame, fxRng, loopNoise, pNum, pStr, type FxParams, type Pt } from './seed.js';

const SALT = 0x7a1f33c9;

// The style ids are the registry's (FX_BORDER_STYLES in fx/registry.ts).

/** A rectangle's outline walked clockwise from its top-left corner: points, outward normals, side lengths. */
interface Rim {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const SIDES = (r: Rim) => {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  return [
    { from: [r.x0, r.y0] as Pt, dir: [1, 0] as Pt, n: [0, -1] as Pt, len: w },
    { from: [r.x1, r.y0] as Pt, dir: [0, 1] as Pt, n: [1, 0] as Pt, len: h },
    { from: [r.x1, r.y1] as Pt, dir: [-1, 0] as Pt, n: [0, 1] as Pt, len: w },
    { from: [r.x0, r.y1] as Pt, dir: [0, -1] as Pt, n: [-1, 0] as Pt, len: h }
  ];
};
/** The corner miter at the start of side i (sum of its normal and the previous side's): offsets keep corners square. */
const MITER: readonly Pt[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
];

interface RimSample {
  /** On the centre line. */
  c: Pt;
  /** Outward offset direction (a side normal, or the corner miter). */
  n: Pt;
  /** Perimeter fraction 0..1 (for noise). */
  t: number;
}
/** About `total` samples round the rim, every corner included, spread by side length. */
const rimSamples = (r: Rim, total: number): RimSample[] => {
  const sides = SIDES(r);
  const perim = sides.reduce((a, s) => a + s.len, 0) || 1;
  const out: RimSample[] = [];
  let walked = 0;
  sides.forEach((s, i) => {
    const k = Math.max(1, Math.round((total * s.len) / perim));
    for (let j = 0; j < k; j += 1) {
      const f = j / k;
      out.push({ c: [s.from[0] + s.dir[0] * s.len * f, s.from[1] + s.dir[1] * s.len * f], n: j === 0 ? MITER[i] : s.n, t: (walked + s.len * f) / perim });
    }
    walked += s.len;
  });
  return out;
};
/** Marks per side: `perLong` on the longer side, in proportion on the others (at least one). */
const marksOn = (len: number, long: number, perLong: number) => Math.max(1, Math.round((perLong * len) / (long || 1)));

/** A ring from its outer and inner contours (inner wound the other way). */
const ring = (path: FxPath, outer: readonly Pt[], inner: readonly Pt[]): void => {
  path.poly(outer);
  path.poly([...inner].reverse());
};
const rectPts = (r: Rim, d = 0): Pt[] => [
  [r.x0 - d, r.y0 - d],
  [r.x1 + d, r.y0 - d],
  [r.x1 + d, r.y1 + d],
  [r.x0 - d, r.y1 + d]
];

/** frame-border@1: a border just inside the box in one of ten styles. */
export const drawFrameBorder = (p: FxParams, seed: number, aspect: number): FxNode[] => {
  const { A, S } = fxFrame(aspect);
  const rand = fxRng(seed, SALT);
  const style = pStr(p, 'style');
  const rough = pNum(p, 'roughness');
  const step = pNum(p, 'step');
  // Weight and inset share at most 45 % of the shorter side, so the middle always stays open.
  const room = 0.45 * S;
  const want = pNum(p, 'weight') * S;
  const inset = Math.min(pNum(p, 'inset') * S, room * 0.5);
  // Jagged teeth and wavy crests reach past the band: keep room for them outside it.
  // (rough: outer jitter 0.25 w + drift 0.15 w; brush: swell 0.325 w + wander 0.2 w, scaled by the roughness.)
  const reachK = style === 'jagged' ? 0.6 + rough : style === 'wavy' ? 0.5 + rough * 0.5 : style === 'rough' ? 0.4 * rough : style === 'brush' ? 0.55 * rough : 0;
  const bandK = style === 'film' ? 2.4 : 1;
  const w = Math.min(want, (room - inset) / (bandK + reachK + 0.01));
  const hw = (w * bandK) / 2;
  const reach = w * reachK;
  // The centre line of the band.
  const e = inset + reach + hw;
  const rim: Rim = { x0: e, y0: e, x1: A - e, y1: 1 - e };
  const long = Math.max(rim.x1 - rim.x0, rim.y1 - rim.y0);
  const path = new FxPath(A);
  const off = (s: RimSample, d: number): Pt => [s.c[0] + s.n[0] * d, s.c[1] + s.n[1] * d];

  switch (style) {
    case 'rough': {
      const samples = rimSamples(rim, 120);
      const jo = samples.map(() => (rand() - 0.5) * rough * w * 0.5);
      const ji = samples.map(() => (rand() - 0.5) * rough * w * 0.5);
      const drift = samples.map(() => (rand() - 0.5) * rough * w * 0.3);
      ring(
        path,
        samples.map((s, i) => off(s, hw + jo[i] + drift[i])),
        samples.map((s, i) => off(s, -hw + ji[i] + drift[i]))
      );
      break;
    }
    case 'brush': {
      // A brush stroke swells and thins along the rim and wanders a little.
      const samples = rimSamples(rim, 140);
      const width = loopNoise(rand, 9);
      const wander = loopNoise(rand, 13);
      const ws = samples.map((s) => hw * (1 + rough * (1.3 * width(s.t) - 0.65)));
      const dr = samples.map((s) => (wander(s.t) - 0.5) * rough * w * 0.4);
      ring(
        path,
        samples.map((s, i) => off(s, ws[i] + dr[i])),
        samples.map((s, i) => off(s, -ws[i] + dr[i]))
      );
      break;
    }
    case 'double': {
      // Two clean rules: the outer one and the inner one, each a third of the weight, a third apart.
      const t = (2 * hw) / 3;
      ring(path, rectPts(rim, hw), rectPts(rim, hw - t));
      ring(path, rectPts(rim, -hw + t), rectPts(rim, -hw));
      break;
    }
    case 'dashed':
    case 'dotted': {
      // Square corner marks, then evenly spaced dashes (or dots) along each side.
      const dotted = style === 'dotted';
      const per = dotted ? Math.round(step * 0.8) : step;
      const r = dotted ? hw : 0;
      SIDES(rim).forEach((s) => {
        const corner = s.from;
        if (dotted) path.ellipse(corner, r, r);
        else path.poly(rectPts({ x0: corner[0], y0: corner[1], x1: corner[0], y1: corner[1] }, hw));
        const k = marksOn(s.len, long, per);
        const cell = s.len / (k + 1);
        for (let j = 1; j <= k; j += 1) {
          const c: Pt = [corner[0] + s.dir[0] * cell * j, corner[1] + s.dir[1] * cell * j];
          if (dotted) path.ellipse(c, r, r);
          else {
            const half = Math.min(cell * 0.3, cell / 2 - hw * 0.5);
            if (half <= 0) continue;
            const a: Pt = [c[0] - s.dir[0] * half, c[1] - s.dir[1] * half];
            const b: Pt = [c[0] + s.dir[0] * half, c[1] + s.dir[1] * half];
            path.poly([
              [a[0] + s.n[0] * hw, a[1] + s.n[1] * hw],
              [b[0] + s.n[0] * hw, b[1] + s.n[1] * hw],
              [b[0] - s.n[0] * hw, b[1] - s.n[1] * hw],
              [a[0] - s.n[0] * hw, a[1] - s.n[1] * hw]
            ]);
          }
        }
      });
      break;
    }
    case 'wavy': {
      // Each side holds whole waves, so every corner sits on the centre line; one quadratic per half wave.
      const amp = reach;
      const outer = new FxPath(A);
      const inner: { c: Pt; to: Pt }[] = [];
      const sides = SIDES(rim);
      const start: Pt = [rim.x0 - hw, rim.y0 - hw];
      outer.m(start);
      sides.forEach((s, i) => {
        const k = marksOn(s.len, long, step) * 2;
        const half = s.len / k;
        for (let j = 0; j < k; j += 1) {
          const sign = j % 2 === 0 ? 1 : -1;
          const midAlong = half * (j + 0.5);
          const mid: Pt = [s.from[0] + s.dir[0] * midAlong, s.from[1] + s.dir[1] * midAlong];
          const endAlong = half * (j + 1);
          const end: Pt = [s.from[0] + s.dir[0] * endAlong, s.from[1] + s.dir[1] * endAlong];
          const last = j === k - 1;
          const endN = last ? MITER[(i + 1) % 4] : s.n;
          outer.q([mid[0] + s.n[0] * (hw + 2 * amp * sign), mid[1] + s.n[1] * (hw + 2 * amp * sign)], [end[0] + endN[0] * hw, end[1] + endN[1] * hw]);
          inner.push({ c: [mid[0] + s.n[0] * (-hw + 2 * amp * sign), mid[1] + s.n[1] * (-hw + 2 * amp * sign)], to: [end[0] - endN[0] * hw, end[1] - endN[1] * hw] });
        }
      });
      outer.z();
      // The inner contour, walked backwards: from each end point back through its control to the one before.
      const firstInner: Pt = [rim.x0 + hw, rim.y0 + hw];
      outer.m(firstInner);
      for (let k = inner.length - 1; k >= 0; k -= 1) outer.q(inner[k].c, k === 0 ? firstInner : inner[k - 1].to);
      outer.z();
      return fillPath(outer, pStr(p, 'color'));
    }
    case 'jagged': {
      // Saw teeth outward from a straight inner edge.
      const outer: Pt[] = [];
      SIDES(rim).forEach((s, i) => {
        const k = marksOn(s.len, long, step);
        outer.push([s.from[0] + MITER[i][0] * hw, s.from[1] + MITER[i][1] * hw]);
        for (let j = 0; j < k; j += 1) {
          const tipAlong = (s.len * (j + 0.5)) / k;
          const baseAlong = (s.len * (j + 1)) / k;
          const tall = hw + reach * (0.55 + 0.45 * rand());
          outer.push([s.from[0] + s.dir[0] * tipAlong + s.n[0] * tall, s.from[1] + s.dir[1] * tipAlong + s.n[1] * tall]);
          if (j < k - 1) outer.push([s.from[0] + s.dir[0] * baseAlong + s.n[0] * hw, s.from[1] + s.dir[1] * baseAlong + s.n[1] * hw]);
        }
      });
      ring(path, outer, rectPts(rim, -hw));
      break;
    }
    case 'film': {
      // A film strip: a broad band with sprocket holes punched along every side (holes wound against the band).
      ring(path, rectPts(rim, hw), rectPts(rim, -hw));
      const holeAcross = hw * 0.42;
      SIDES(rim).forEach((s) => {
        const k = marksOn(s.len - 2 * hw, long, Math.round(step * 0.75));
        const usable = s.len - 2 * hw;
        if (usable <= 0) return;
        const cell = usable / k;
        const holeAlong = cell * 0.24;
        for (let j = 0; j < k; j += 1) {
          const along = hw + cell * (j + 0.5);
          const c: Pt = [s.from[0] + s.dir[0] * along, s.from[1] + s.dir[1] * along];
          const a: Pt = [c[0] - s.dir[0] * holeAlong, c[1] - s.dir[1] * holeAlong];
          const b: Pt = [c[0] + s.dir[0] * holeAlong, c[1] + s.dir[1] * holeAlong];
          // Counter-clockwise (inner side, along, outer side, back), against the band's clockwise outer contour.
          path.poly([
            [a[0] - s.n[0] * holeAcross, a[1] - s.n[1] * holeAcross],
            [b[0] - s.n[0] * holeAcross, b[1] - s.n[1] * holeAcross],
            [b[0] + s.n[0] * holeAcross, b[1] + s.n[1] * holeAcross],
            [a[0] + s.n[0] * holeAcross, a[1] + s.n[1] * holeAcross]
          ]);
        }
      });
      break;
    }
    case 'torn': {
      // Torn paper: a straight outer edge and a ragged inner one, with the odd deeper rip.
      const samples = rimSamples(rim, 150);
      const depth = samples.map(() => {
        const deep = rand() < 0.08 * (0.5 + rough) ? 1.6 : 1;
        return hw * 2 * (0.35 + 0.65 * rough * rand()) * deep;
      });
      const outer = rectPts(rim, hw);
      const inner = samples.map((s, i) => off(s, hw - Math.min(depth[i], hw * 2 + w)));
      ring(path, outer, inner);
      break;
    }
    case 'scallop': {
      // Round scallops bitten out of the inside edge: one quadratic each, corner to corner.
      const outer = rectPts(rim, hw);
      const innerEdge: { c: Pt; to: Pt }[] = [];
      SIDES(rim).forEach((s, i) => {
        const k = marksOn(s.len, long, step);
        for (let j = 0; j < k; j += 1) {
          const mid = (s.len * (j + 0.5)) / k;
          const end = (s.len * (j + 1)) / k;
          const dIn = -hw * (1 + 0.8 * (0.6 + 0.4 * rough));
          const endN = j === k - 1 ? MITER[(i + 1) % 4] : s.n;
          innerEdge.push({
            c: [s.from[0] + s.dir[0] * mid + s.n[0] * (dIn * 2 + hw), s.from[1] + s.dir[1] * mid + s.n[1] * (dIn * 2 + hw)],
            to: [s.from[0] + s.dir[0] * end - endN[0] * hw * 0.2, s.from[1] + s.dir[1] * end - endN[1] * hw * 0.2]
          });
        }
      });
      path.poly(outer);
      const first: Pt = [rim.x0 + hw * 0.2, rim.y0 + hw * 0.2];
      path.m(first);
      for (let k = innerEdge.length - 1; k >= 0; k -= 1) path.q(innerEdge[k].c, k === 0 ? first : innerEdge[k - 1].to);
      path.z();
      break;
    }
  }
  return fillPath(path, pStr(p, 'color'));
};
