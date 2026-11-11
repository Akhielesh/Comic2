// @vitest-environment node
/**
 * The colour-science checks (tests/config/paletteChecks.ts) are right: they reproduce the data-viz palette
 * validator's numbers that the colour layer's design report quotes (design.md §3.4, §3.10 and Verification V.1,
 * V.2-6, V.2-13), so huePalette.test.ts and tokenContrast.test.ts gate on the same maths the report decided with.
 */
import { describe, expect, it } from 'vitest';
import { checkCategorical, contrastRatio, deltaE, hexToSrgb, oklchOf, PALETTE_THRESHOLDS, separation, simulate } from './paletteChecks';

/** The report's validated set, as it computed it (dark slot 1 before the one-step lift the tokens ship). */
const REPORT_LIGHT = ['#3d44e8', '#d13d91', '#db6b04', '#079a94', '#9548cc'];
const REPORT_DARK = ['#5265f9', '#d84497', '#df6e07', '#04a19b', '#a155da'];

describe('paletteChecks — the basics', () => {
  it('WCAG contrast: white on black 21, #767676 on white ≈ 4.54, symmetric', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#767676')).toBe(contrastRatio('#767676', '#ffffff'));
  });

  it('OKLab ΔE ×100: white to black is 100, a colour to itself 0', () => {
    expect(deltaE('#ffffff', '#000000')).toBeCloseTo(100, 4);
    expect(deltaE('#3d44e8', '#3d44e8')).toBe(0);
  });

  it('OKLCH of the spark: ultramarine oklch(0.50 0.24 272) light, oklch(0.72 0.145 275) dark (the token comments)', () => {
    const light = oklchOf('#3d44e8');
    expect(light.L).toBeCloseTo(0.5, 2);
    expect(light.C).toBeCloseTo(0.24, 2);
    expect(light.h).toBeGreaterThan(271);
    expect(light.h).toBeLessThan(273);
    const dark = oklchOf('#8b9bfe');
    expect(dark.L).toBeCloseTo(0.72, 2);
    expect(dark.C).toBeCloseTo(0.145, 2);
    expect(Math.round(dark.h)).toBe(275);
  });

  it('a grey stays grey under every simulated deficiency (the Machado matrices preserve the neutral axis)', () => {
    for (const kind of ['protan', 'deutan', 'tritan'] as const) {
      const [r, g, b] = simulate('#808080', kind);
      expect(Math.max(r, g, b) - Math.min(r, g, b), kind).toBeLessThan(1e-4);
    }
  });

  it('fails closed on anything that is not #rrggbb (no NaN that would pass every check)', () => {
    for (const bad of ['', '#fff', 'red', '#12345g', 'var(--ds-spark)']) expect(() => hexToSrgb(bad), bad).toThrow(/not a #rrggbb/);
  });
});

describe('paletteChecks — it reproduces the report', () => {
  it('spark vs status (§3.10): ultramarine stays far from Atlas danger, success and warning', () => {
    const danger = separation('#3d44e8', '#d4183d');
    expect(danger.normal).toBeCloseTo(37.1, 1);
    expect(danger.cvd).toBeCloseTo(27.5, 1);
    expect(danger.cvdKind).toBe('protan');
    expect(separation('#3d44e8', '#16a34a').cvd).toBeCloseTo(32.8, 1);
    expect(separation('#3d44e8', '#f59e0b').normal).toBeCloseTo(48.0, 1);
  });

  it('why not terracotta (§3.10): the logo colour sits ΔE 3.7 (deutan) / 10.7 (normal) from danger and 2.3 from success', () => {
    const danger = separation('#c2603f', '#d4183d');
    expect(danger.cvd).toBeCloseTo(3.7, 1);
    expect(danger.normal).toBeCloseTo(10.7, 1);
    expect(separation('#c2603f', '#16a34a').cvd).toBeCloseTo(2.3, 1);
    expect(separation('#AE5132', '#d4183d').cvd).toBeCloseTo(1.8, 1);
    expect(contrastRatio('#ffffff', '#c2603f')).toBeCloseTo(4.17, 2);
    expect(contrastRatio('#ffffff', '#3d44e8')).toBeCloseTo(6.58, 2);
  });

  it('the default info blue collided with the spark (V.2-6): 6.4 / 3.7 light, 5.2 / 0.7 dark', () => {
    const light = separation('#3d44e8', '#2563eb');
    expect(light.normal).toBeCloseTo(6.4, 1);
    expect(light.cvd).toBeCloseTo(3.7, 1);
    const dark = separation('#8b9bfe', '#60a5fa');
    expect(dark.normal).toBeCloseTo(5.2, 1);
    expect(dark.cvd).toBeCloseTo(0.7, 1);
  });

  it('the validated hues (§3.4): adjacent CVD 14.7 protan / normal 19.7 light; 13.8 deutan / 19.6 dark; first three all pairs 14.9 and 15.7', () => {
    const light = checkCategorical(REPORT_LIGHT, { mode: 'light', surfaces: ['#ffffff', '#FAF9F5', '#f4f4f4'] });
    expect(light.ok).toBe(true);
    expect([light.cvd.deltaE, light.cvd.kind, light.cvd.a, light.cvd.b]).toEqual([expect.closeTo(14.7, 1), 'protan', '#db6b04', '#079a94']);
    expect(light.normal.deltaE).toBeCloseTo(19.7, 1);
    expect(light.tritan).toBeCloseTo(6.3, 1); // V.2-13: reported, not gated
    const dark = checkCategorical(REPORT_DARK, { mode: 'dark', surfaces: ['#0a0a0a', '#111111', '#1a1a1a', '#262624'] });
    expect(dark.ok).toBe(true);
    expect([dark.cvd.deltaE, dark.cvd.kind]).toEqual([expect.closeTo(13.8, 1), 'deutan']);
    expect(dark.normal.deltaE).toBeCloseTo(19.6, 1);
    expect(dark.tritan).toBeCloseTo(5.5, 1);
    expect(checkCategorical(REPORT_LIGHT.slice(0, 3), { mode: 'light', surfaces: ['#ffffff'], pairs: 'all' }).cvd.deltaE).toBeCloseTo(14.9, 1);
    expect(checkCategorical(REPORT_DARK.slice(0, 3), { mode: 'dark', surfaces: ['#111111'], pairs: 'all' }).cvd.deltaE).toBeCloseTo(15.7, 1);
  });

  it('orange #e77412 on the paper is 2.89:1 (V.1): under the 3:1 gate, which this port makes hard', () => {
    expect(contrastRatio('#e77412', '#FAF9F5')).toBeCloseTo(2.89, 2);
    const report = checkCategorical(['#3d44e8', '#d13d91', '#e77412', '#079a94', '#9548cc'], { mode: 'light', surfaces: ['#FAF9F5'] });
    expect(report.ok).toBe(false);
    expect(report.lowContrast.map((l) => l.hex)).toEqual(['#e77412']);
  });
});

describe('paletteChecks — every gate can fail', () => {
  it('a monochrome ramp fails the categorical checks it was never meant for: band, chroma floor, normal floor', () => {
    const grey = checkCategorical(['#0a0a0a', '#525252', '#858585', '#b0b0b0', '#d4d4d4'], { mode: 'light', surfaces: ['#ffffff'] });
    expect(grey.ok).toBe(false);
    expect(grey.offBand.map((o) => o.hex)).toEqual(['#0a0a0a', '#d4d4d4']);
    expect(grey.lowChroma).toHaveLength(5);
    expect(grey.normal.pass).toBe(false);
  });

  it('two hues a dichromat cannot tell apart fail the CVD gate (red beside green)', () => {
    const report = checkCategorical(['#d4183d', '#16a34a'], { mode: 'light', surfaces: ['#ffffff'] });
    expect(report.cvd.deltaE).toBeLessThan(PALETTE_THRESHOLDS.cvdFloor);
    expect(report.cvd.state).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('all pairs is stricter than adjacent: slots that are fine as neighbours can collide across the set', () => {
    const palette = ['#3d44e8', '#db6b04', '#4a52f0'];
    expect(checkCategorical(palette, { mode: 'light', surfaces: ['#ffffff'] }).ok).toBe(true);
    expect(checkCategorical(palette, { mode: 'light', surfaces: ['#ffffff'], pairs: 'all' }).ok).toBe(false);
  });
});
