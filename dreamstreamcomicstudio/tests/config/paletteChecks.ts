/**
 * Colour-science checks for the colour layer "Ink & Spark" (docs/design/design-system.md § Colour layer), as pure
 * functions over `#rrggbb` hexes. huePalette.test.ts and tokenContrast.test.ts read them; paletteChecks.test.ts
 * proves the maths against known values.
 *
 * The categorical checks are the data-viz palette validator's computable ones, ported 1:1 (same thresholds, same
 * simulation, same distance), so the numbers in the design report reproduce here:
 *   - lightness band   OKLCH L inside the mode's band (light 0.43–0.77, dark 0.48–0.67);
 *   - chroma floor     OKLCH C ≥ 0.10 (below it a hue reads as grey);
 *   - CVD separation   OKLab ΔE ×100 under simulated protanopia and deuteranopia ≥ 8 (tritanopia reported, not
 *                      gated: it is rare, and "a legend always" covers it), adjacent pairs or all pairs;
 *   - normal floor     OKLab ΔE ×100 under unsimulated vision ≥ 15 on the same pairs;
 *   - contrast         WCAG 2.x ≥ 3:1 against each surface a mark sits on. The validator only warns below 3:1; this
 *                      port makes it a hard gate, because the layer promises every hue on every listed surface.
 * The CVD simulation is Machado, Oliveira & Fernandes (2009) at severity 1.0 in linear sRGB; the thresholds are
 * calibrated to that model, so swapping the model would move borderline pairs. OKLab is Björn Ottosson's (2020).
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it; the typecheck covers it.
 */

export type CvdKind = 'protan' | 'deutan' | 'tritan';
export type PaletteMode = 'light' | 'dark';
type Vec3 = [number, number, number];

export const PALETTE_THRESHOLDS = {
  band: { light: [0.43, 0.77], dark: [0.48, 0.67] } as Record<PaletteMode, [number, number]>,
  chromaFloor: 0.1,
  /** min(protan, deutan) ΔE on the pairs: ≥ target passes; [floor, target) is legal only with direct labels. */
  cvdTarget: 8,
  cvdFloor: 6,
  normalFloor: 15,
  contrastMin: 3
} as const;

const MACHADO: Record<CvdKind, [Vec3, Vec3, Vec3]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881]
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039]
  ]
};

export function hexToSrgb(hex: string): Vec3 {
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`paletteChecks: not a #rrggbb colour: ${JSON.stringify(hex)}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Vec3;
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};
export const linearOf = (hex: string): Vec3 => hexToSrgb(hex).map(toLinear) as Vec3;
export const hexOfLinear = (lin: Vec3): string =>
  `#${lin.map((c) => Math.round(toGamma(c) * 255).toString(16).padStart(2, '0')).join('')}`;

function oklabFromLinear([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}
export const oklabOf = (hex: string): Vec3 => oklabFromLinear(linearOf(hex));
/** OKLCH: lightness 0–1, chroma, hue in degrees. */
export function oklchOf(hex: string): { L: number; C: number; h: number } {
  const [L, a, b] = oklabOf(hex);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** The colour a dichromat sees (severity 1.0), in linear sRGB, clamped to the gamut. */
export function simulate(hex: string, kind: CvdKind): Vec3 {
  const [r, g, b] = linearOf(hex);
  const M = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [0, 1, 2].map((i) => clamp(M[i][0] * r + M[i][1] * g + M[i][2] * b)) as Vec3;
}

/** OKLab Euclidean distance ×100 (no kind: unsimulated vision). */
export function deltaE(a: string, b: string, kind?: CvdKind): number {
  const x = oklabFromLinear(kind ? simulate(a, kind) : linearOf(a));
  const y = oklabFromLinear(kind ? simulate(b, kind) : linearOf(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** How far apart two colours are: unsimulated, and the worst of protanopia / deuteranopia (tritanopia beside it). */
export function separation(a: string, b: string): { normal: number; cvd: number; cvdKind: 'protan' | 'deutan'; tritan: number } {
  const protan = deltaE(a, b, 'protan');
  const deutan = deltaE(a, b, 'deutan');
  return { normal: deltaE(a, b), cvd: Math.min(protan, deutan), cvdKind: protan <= deutan ? 'protan' : 'deutan', tritan: deltaE(a, b, 'tritan') };
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearOf(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface PairResult {
  a: string;
  b: string;
  deltaE: number;
  kind?: CvdKind;
}
export interface CategoricalReport {
  ok: boolean;
  /** Slots outside the mode's lightness band, with their L. */
  offBand: Array<{ hex: string; L: number }>;
  /** Slots under the chroma floor, with their C. */
  lowChroma: Array<{ hex: string; C: number }>;
  /** The worst protan / deutan pair, and its state against the target and floor. */
  cvd: PairResult & { state: 'pass' | 'floor' | 'fail' };
  /** Reported, never gated. */
  tritan: number;
  /** The worst unsimulated pair (hard floor). */
  normal: PairResult & { pass: boolean };
  /** Every slot × surface under 3:1 (a hard gate here). */
  lowContrast: Array<{ hex: string; surface: string; ratio: number }>;
}

/**
 * The categorical checks over a fixed-order palette. `pairs: 'adjacent'` for stacks, bars and lines; `'all'` for
 * scatter, maps and small multiples (every pair can sit side by side). `surfaces` are the backdrops the marks sit on.
 */
export function checkCategorical(
  palette: readonly string[],
  { mode, surfaces, pairs = 'adjacent' }: { mode: PaletteMode; surfaces: readonly string[]; pairs?: 'adjacent' | 'all' }
): CategoricalReport {
  const [lo, hi] = PALETTE_THRESHOLDS.band[mode];
  const offBand = palette.map((hex) => ({ hex, L: oklchOf(hex).L })).filter(({ L }) => L < lo || L > hi);
  const lowChroma = palette.map((hex) => ({ hex, C: oklchOf(hex).C })).filter(({ C }) => C < PALETTE_THRESHOLDS.chromaFloor);
  const n = palette.length;
  const pairList: Array<[number, number]> =
    pairs === 'all'
      ? Array.from({ length: n }, (_, i) => Array.from({ length: n - i - 1 }, (_, k) => [i, i + 1 + k] as [number, number])).flat()
      : Array.from({ length: Math.max(0, n - 1) }, (_, i) => [i, i + 1] as [number, number]);
  let cvd: PairResult = { a: '', b: '', deltaE: Infinity };
  for (const kind of ['protan', 'deutan'] as const) {
    for (const [i, j] of pairList) {
      const d = deltaE(palette[i], palette[j], kind);
      if (d < cvd.deltaE) cvd = { a: palette[i], b: palette[j], deltaE: d, kind };
    }
  }
  const tritan = pairList.length ? Math.min(...pairList.map(([i, j]) => deltaE(palette[i], palette[j], 'tritan'))) : Infinity;
  let normal: PairResult = { a: '', b: '', deltaE: Infinity };
  for (const [i, j] of pairList) {
    const d = deltaE(palette[i], palette[j]);
    if (d < normal.deltaE) normal = { a: palette[i], b: palette[j], deltaE: d };
  }
  const cvdState = cvd.deltaE >= PALETTE_THRESHOLDS.cvdTarget ? 'pass' : cvd.deltaE >= PALETTE_THRESHOLDS.cvdFloor ? 'floor' : 'fail';
  const normalPass = normal.deltaE >= PALETTE_THRESHOLDS.normalFloor;
  const lowContrast = palette.flatMap((hex) =>
    surfaces.map((surface) => ({ hex, surface, ratio: contrastRatio(hex, surface) })).filter((r) => r.ratio < PALETTE_THRESHOLDS.contrastMin)
  );
  return {
    ok: !offBand.length && !lowChroma.length && cvdState !== 'fail' && normalPass && !lowContrast.length,
    offBand,
    lowChroma,
    cvd: { ...cvd, state: cvdState },
    tritan,
    normal: { ...normal, pass: normalPass },
    lowContrast
  };
}
