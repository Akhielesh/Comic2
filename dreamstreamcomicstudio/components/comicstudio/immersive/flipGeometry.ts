// "Leaf" page-turn geometry (reader.md §3.1). Pure, no DOM.
//
// All math runs in LEAF SPACE: the turning leaf occupies [0,W]×[0,H] with its spine at x = 0 and the
// outer edge at x = W (an LTR forward turn of a right-hand page). The reader grabs a point C on the
// outer edge and drags it to P. Real paper folds along the perpendicular bisector of C→P: the part of
// the page on C's side (the "flap") is reflected across that line, everything else stays flat.
//
// RTL and backward turns use the same math in a MIRRORED frame (x' = −x on screen); the page content
// is never mirrored, only the matrices that place it (leafFrame below). Because a reflection is an
// isometry (|scale| = 1), lettering on the flap stays the right size and crisp mid-turn.
//
// Matrices are CSS `matrix(a, b, c, d, e, f)` tuples: x' = a·x + c·y + e, y' = b·x + d·y + f.

export interface Vec {
  x: number;
  y: number;
}

export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2 (apply m2 first, then m1). */
export const compose = (m1: Mat, m2: Mat): Mat => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
];

export const composeAll = (...ms: Mat[]): Mat => ms.reduce((acc, m) => compose(acc, m), IDENTITY);

export const det = (m: Mat): number => m[0] * m[3] - m[1] * m[2];

export const invert = (m: Mat): Mat => {
  const D = det(m) || 1e-12;
  const a = m[3] / D;
  const b = -m[1] / D;
  const c = -m[2] / D;
  const d = m[0] / D;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};

export const apply = (m: Mat, p: Vec): Vec => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
/** The linear part only (directions, normals). */
export const applyLinear = (m: Mat, v: Vec): Vec => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const rotate = (rad: number): Mat => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
};
/** x → W − x (the horizontal mirror of a page of width W onto itself). */
export const flipX = (W: number): Mat => [-1, 0, 0, 1, W, 0];

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** CSS `matrix(...)` text (rounded so style strings stay short and stable). */
export const cssMatrix = (m: Mat): string => `matrix(${m.map(r4).join(',')})`;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const len = (v: Vec) => Math.hypot(v.x, v.y);
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;

export interface FoldInput {
  W: number;
  H: number;
  /** Grab point on the outer edge (x = W); y is the grab height, clamped to [0, H]. */
  grab: Vec;
  /** Current pointer (leaf space). */
  pointer: Vec;
}

export interface FoldState {
  /** 0 = flat, 1 = fully turned (pointer at x = −W). */
  progress: number;
  /** Unit normal of the fold line, pointing from the corner (flap) side to the static side. */
  n: Vec;
  /** A point on the fold line (midpoint of grab → constrained pointer). */
  m: Vec;
  /** The constrained pointer. */
  pointer: Vec;
  /** Static (unturned) part of the front, polygon in leaf space. */
  frontClip: Vec[];
  /** Flap region in leaf space (before reflection; contains the grab point). */
  flapRegion: Vec[];
  /** The reflection across the fold line (det −1). */
  reflect: Mat;
  /** Transform for the BACK face element in a normal frame: reflection ∘ horizontal mirror (det +1). */
  backMatrix: Mat;
  /** Back-face clip polygon in the back element's own coordinates (normal frame). */
  backClip: Vec[];
  /** Mirrored ink seen through the paper (pure reflection, det −1). */
  showThroughMatrix: Mat;
  /** Fold-line endpoints clipped to the page. */
  foldA: Vec;
  foldB: Vec;
  /** Shadow / highlight intensities 0..1. */
  shade: { cast: number; curl: number; spec: number };
}

/**
 * Keep paper from stretching. The leaf is fixed along the spine (x = 0, y ∈ [0, H]); a folded point can
 * never be farther from a spine point than it was on the flat page. Because the condition is linear
 * along the spine, it is enough to enforce it at both spine corners (which also keeps the whole spine
 * on the static side of the fold) and at the spine point level with the grab (|P − (0, C.y)| ≤ W).
 */
export const constrainPointer = (W: number, H: number, grab: Vec, p: Vec): Vec => {
  const C = { x: W, y: clamp(grab.y, 0, H) };
  const anchors: { s: Vec; r: number }[] = [
    { s: { x: 0, y: C.y }, r: W },
    { s: { x: 0, y: 0 }, r: Math.hypot(W, C.y) },
    { s: { x: 0, y: H }, r: Math.hypot(W, H - C.y) }
  ];
  let q = { x: Number.isFinite(p.x) ? p.x : C.x, y: Number.isFinite(p.y) ? p.y : C.y };
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    for (const { s, r } of anchors) {
      const v = sub(q, s);
      const l = len(v);
      if (l > r + 1e-9) {
        q = { x: s.x + (v.x / l) * r, y: s.y + (v.y / l) * r };
        moved = true;
      }
    }
    if (!moved) break;
  }
  return q;
};

/** Sutherland–Hodgman clip of a convex polygon against the half-plane sign·((X − m)·d) ≥ 0. */
export const clipHalfPlane = (poly: Vec[], m: Vec, d: Vec, sign: 1 | -1): Vec[] => {
  const out: Vec[] = [];
  const side = (p: Vec) => sign * dot(sub(p, m), d);
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
};

export const reflectionMatrix = (m: Vec, d: Vec): Mat => {
  const a = 1 - 2 * d.x * d.x;
  const b = -2 * d.x * d.y;
  const e = 1 - 2 * d.y * d.y;
  const k = 2 * dot(m, d);
  return [a, b, b, e, k * d.x, k * d.y];
};

/** The page outline in leaf space. */
export const pageRect = (W: number, H: number): Vec[] => [
  { x: 0, y: 0 },
  { x: W, y: 0 },
  { x: W, y: H },
  { x: 0, y: H }
];

/** Fold for a grab/pointer pair, or null when the page is flat (|P − C| < 0.5 px). */
export const computeFold = (input: FoldInput): FoldState | null => {
  const { W, H } = input;
  if (!(W > 0 && H > 0)) return null;
  const C = { x: W, y: clamp(input.grab.y, 0, H) };
  const P = constrainPointer(W, H, C, input.pointer);
  const v = sub(P, C);
  const l = len(v);
  if (l < 0.5) return null;
  const d = { x: v.x / l, y: v.y / l };
  const m = { x: (C.x + P.x) / 2, y: (C.y + P.y) / 2 };
  const rect = pageRect(W, H);
  const flapRegion = clipHalfPlane(rect, m, d, -1);
  const frontClip = clipHalfPlane(rect, m, d, 1);
  const R = reflectionMatrix(m, d);
  const F = flipX(W);
  const backMatrix = compose(R, F);
  const backClip = flapRegion.map((X) => apply(F, X));
  const onFold = flapRegion.filter((X) => Math.abs(dot(sub(X, m), d)) < 1e-6);
  const foldA = onFold[0] ?? m;
  const foldB = onFold[onFold.length - 1] ?? m;
  const progress = clamp((C.x - P.x) / (2 * W), 0, 1);
  const s = Math.sin(Math.PI * progress);
  return {
    progress,
    n: d,
    m,
    pointer: P,
    frontClip,
    flapRegion,
    reflect: R,
    backMatrix,
    backClip,
    showThroughMatrix: R,
    foldA,
    foldB,
    shade: { cast: 0.5 * Math.pow(s, 0.6), curl: 0.22 * s, spec: 0.12 * s }
  };
};

// ── Frames: leaf space ↔ book (screen) space ─────────────────────────────────

/**
 * Where a leaf lives in the book box. `spineX`/`top` are book coordinates of the leaf's spine top.
 * A normal frame has the leaf to the right of the spine (LTR forward turn of a right page); a mirrored
 * frame has it to the left (LTR backward turn of a left page, RTL forward turns, single RTL pages).
 */
export interface LeafFrame {
  W: number;
  H: number;
  mirrored: boolean;
  /** leaf → book. */
  S: Mat;
  /** front element local (u, v) → leaf. */
  front: Mat;
  /** back element local (u, v) → leaf, before the fold (at rest the back page lies under the front, mirrored). */
  back: Mat;
  /** Book position of the front element's top-left. */
  frontAt: Vec;
  /** Book position of the back element's top-left once the turn completes (its final slot). */
  backAt: Vec;
}

export const leafFrame = (spineX: number, top: number, W: number, H: number, mirrored: boolean): LeafFrame => ({
  W,
  H,
  mirrored,
  S: mirrored ? [-1, 0, 0, 1, spineX, top] : translate(spineX, top),
  front: mirrored ? flipX(W) : IDENTITY,
  back: mirrored ? IDENTITY : flipX(W),
  frontAt: { x: mirrored ? spineX - W : spineX, y: top },
  backAt: { x: mirrored ? spineX : spineX - W, y: top }
});

/** A point in book space → leaf space. */
export const bookToLeaf = (f: LeafFrame, p: Vec): Vec => apply(invert(f.S), p);

const r1 = (n: number) => Math.round(n * 10) / 10;
/** CSS `polygon(...)` in px. */
export const cssPolygon = (pts: Vec[]): string => (pts.length >= 3 ? `polygon(${pts.map((p) => `${r1(p.x)}px ${r1(p.y)}px`).join(',')})` : 'polygon(0 0,0 0,0 0)');

/** Far reach of the shadow clip and the gradient bands (CSS px); larger than any page we draw. */
export const BAND_REACH = 6000;

/** A big quad covering the half-plane sign·((X − m)·n) ≥ 0 (for clipping shadows that spill past the page). */
export const halfPlaneQuad = (m: Vec, n: Vec, sign: 1 | -1, reach = BAND_REACH): Vec[] => {
  const nn = { x: n.x * sign, y: n.y * sign };
  const t = { x: -nn.y, y: nn.x };
  return [
    { x: m.x + t.x * reach, y: m.y + t.y * reach },
    { x: m.x + t.x * reach + nn.x * reach, y: m.y + t.y * reach + nn.y * reach },
    { x: m.x - t.x * reach + nn.x * reach, y: m.y - t.y * reach + nn.y * reach },
    { x: m.x - t.x * reach, y: m.y - t.y * reach }
  ];
};

/**
 * Everything the DOM needs to draw one fold frame. Elements keep their natural slot positions (no
 * re-parenting, so nothing remounts at turn start or end); the per-frame writes are:
 * - front page element: `clip-path: frontClip` (its static part, in its own px);
 * - back face element (the page that lands on the other side, placed at its FINAL slot):
 *   `transform: backTransform` + `clip-path: backClip` — identity at progress 1, so the turn ends
 *   without a jump;
 * - flap drop shadow: same transform as the back face, `clip-path: shadowClip` (only the flap side);
 * - cast-shadow band (in a box at the turning page's slot, over the revealed page) and curl band
 *   (inside the back face): `transform` of a fixed gradient strip anchored on the fold line, plus
 *   opacity. Bands run perpendicular to the fold: local x points away from the fold, y along it.
 */
export interface LeafStyles {
  progress: number;
  frontClip: string;
  backTransform: Mat;
  backClip: string;
  shadowClip: string;
  castBand: Mat;
  curlBand: Mat;
  shade: FoldState['shade'];
}

const bandAt = (m: Vec, dir: Vec, widthScale = 1): Mat => {
  const angle = Math.atan2(dir.y, dir.x);
  return composeAll(translate(m.x, m.y), rotate(angle), [widthScale, 0, 0, 1, 0, -BAND_REACH / 2]);
};

export const leafStyles = (f: LeafFrame, fold: FoldState): LeafStyles => {
  const frontInv = invert(f.front);
  const backInv = invert(f.back);
  const flapDir = { x: -fold.n.x, y: -fold.n.y };
  const s = Math.sin(Math.PI * fold.progress);
  // Cast shadow widens with the lift: 4% + 18%·sin of the page width (band element is W wide).
  const castScale = 0.04 + 0.18 * s;
  const mFront = apply(frontInv, fold.m);
  const mBack = apply(backInv, fold.m);
  return {
    progress: fold.progress,
    frontClip: cssPolygon(fold.frontClip.map((p) => apply(frontInv, p))),
    backTransform: composeAll(translate(-f.backAt.x, -f.backAt.y), f.S, fold.reflect, f.back),
    backClip: cssPolygon(fold.flapRegion.map((p) => apply(backInv, p))),
    shadowClip: cssPolygon(halfPlaneQuad(mBack, applyLinear(backInv, flapDir), 1)),
    castBand: bandAt(mFront, applyLinear(frontInv, flapDir), castScale),
    curlBand: bandAt(mBack, applyLinear(backInv, flapDir)),
    shade: fold.shade
  };
};
