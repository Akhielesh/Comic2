// @vitest-environment node
/**
 * The categorical hues of the colour layer (--ds-hue-1…7 since CL-6, "Ink, Paper & Colour": leaf and sky joined the
 * five; design.md §3.4 and §3.9, V.1 and V.2-13), read from
 * index.css and validated as a data-viz palette with tests/config/paletteChecks.ts, light and dark:
 *   - lightness band and chroma floor (a hue that reads as grey is not a hue);
 *   - adjacent pairs ≥ 8 ΔE under protanopia and deuteranopia, and ≥ 15 under normal vision (stacks, bars, lines);
 *   - the first three slots ≥ the same floors for ALL pairs (scatter, maps, small multiples use them first);
 *   - every slot ≥ 3:1 against every surface a chart sits on: the page and a card in each context (the paper
 *     #FAF9F5, Atlas white, the soft #f4f4f4; dark #0a0a0a, #111111, #1a1a1a, the default #262624 and its card).
 * Tritanopia is reported, not gated (it is rare, and the rule "a legend always" covers it).
 * Mutation proofs live here too: the orange the report started from fails the paper, and the order is load-bearing.
 */
import { describe, expect, it } from 'vitest';
import { CHART_HUE_ORDER } from '../../components/chat/studioDesign';
import { checkCategorical, contrastRatio, deltaE, oklchOf, separation, type CvdKind, type PaletteMode } from './paletteChecks';
import { indexCss, over, parseRules, resolveColor, type Rgba, tokenBlocks } from './cssTokens';

const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(parseRules(indexCss));
const SLOTS = ['--ds-hue-1', '--ds-hue-2', '--ds-hue-3', '--ds-hue-4', '--ds-hue-5', '--ds-hue-6', '--ds-hue-7'] as const;
const hexOf = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** A token through a cascade of blocks (var() followed), as an opaque hex over the given page. */
function tokenHex(name: string, blocks: Array<Map<string, string>>, page?: Rgba): string {
  const lookup = (n: string) => {
    for (const b of blocks) if (b.has(n)) return b.get(n)!;
    throw new Error(`huePalette: ${n} is not defined`);
  };
  const c = resolveColor(lookup(name), lookup, [name]);
  return hexOf(page ? over(c, page) : c);
}
const CASCADES: Record<string, { mode: PaletteMode; blocks: Array<Map<string, string>> }> = {
  'default light': { mode: 'light', blocks: [ROOT_TOKENS] },
  'atlas light': { mode: 'light', blocks: [ATLAS_LIGHT, ROOT_TOKENS] },
  'default dark': { mode: 'dark', blocks: [DARK_TOKENS, ROOT_TOKENS] },
  'atlas dark': { mode: 'dark', blocks: [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS] }
};
/** The hues as index.css defines them (light = :root, dark = .dark; the skin restates the same values). */
const palette = (mode: PaletteMode) => SLOTS.map((s) => (mode === 'light' ? ROOT_TOKENS : DARK_TOKENS).get(s)!.toLowerCase());
/** Every surface a chart sits on in a mode: each context's page, its card, and the Atlas soft surface. */
function chartSurfaces(mode: PaletteMode): string[] {
  const out = new Set<string>();
  for (const { mode: m, blocks } of Object.values(CASCADES)) {
    if (m !== mode) continue;
    const page = resolveColor(tokenHex('--ds-canvas', blocks));
    out.add(hexOf(page));
    out.add(tokenHex('--ds-surface', blocks, page));
    out.add(tokenHex('--ds-surface-soft', blocks, page));
  }
  return [...out];
}

describe('hue palette — the tokens are a validated categorical set', () => {
  it('seven slots, the same values with and without the skin, in a fixed order whose first slot is the spark family', () => {
    for (const mode of ['light', 'dark'] as const) {
      const base = mode === 'light' ? ROOT_TOKENS : DARK_TOKENS;
      const skin = mode === 'light' ? ATLAS_LIGHT : ATLAS_DARK;
      for (const s of SLOTS) expect(skin.get(s), `${mode} ${s}`).toBe(base.get(s));
      // Slot 1 is ultramarine, the spark's hue (within 5° of it): "this one" in a chart reads as the spark.
      const spark = oklchOf(base.get('--ds-spark')!);
      expect(Math.abs(oklchOf(palette(mode)[0]).h - spark.h), mode).toBeLessThan(5);
    }
    expect(palette('light')).toEqual(['#3d44e8', '#d13d91', '#db6b04', '#079a94', '#9548cc', '#567d01', '#0089c9']);
    expect(palette('dark')).toEqual(['#5568fd', '#d84497', '#df6e07', '#04a19b', '#a155da', '#6e9e01', '#0c9edc']);
    // No eighth slot: an eighth series reads the neutral chart step (gold was dropped: it read as the warning colour).
    for (const block of [ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK]) expect(block.has('--ds-hue-8')).toBe(false);
  });

  it('the chart surfaces are the real ones: paper, Atlas white and soft, the dark pages and the default dark card', () => {
    expect(chartSurfaces('light')).toEqual(expect.arrayContaining(['#faf9f5', '#ffffff', '#f4f4f4']));
    expect(chartSurfaces('dark')).toEqual(expect.arrayContaining(['#0a0a0a', '#111111', '#1a1a1a', '#262624', '#2f2f2d']));
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: band, chroma, adjacent CVD ≥ 8 and normal ≥ 15, ≥ 3:1 on every chart surface`, () => {
      const report = checkCategorical(palette(mode), { mode, surfaces: chartSurfaces(mode) });
      expect(report.offBand).toEqual([]);
      expect(report.lowChroma).toEqual([]);
      expect(report.cvd.state, `worst ${report.cvd.a}↔${report.cvd.b} ${report.cvd.deltaE.toFixed(1)} (${report.cvd.kind})`).toBe('pass');
      expect(report.normal.pass, `worst ${report.normal.a}↔${report.normal.b} ${report.normal.deltaE.toFixed(1)}`).toBe(true);
      expect(report.lowContrast).toEqual([]);
      expect(report.ok).toBe(true);
      // The margins the report published (V.1): 14.7 / 19.7 light, 13.8 / 19.6 dark.
      expect(report.cvd.deltaE).toBeGreaterThan(mode === 'light' ? 14.6 : 13.7);
      expect(report.normal.deltaE).toBeGreaterThan(19.5);
    });

    it(`${mode}: the first three slots pass for ALL pairs (scatter, maps, small multiples)`, () => {
      const report = checkCategorical(palette(mode).slice(0, 3), { mode, surfaces: chartSurfaces(mode), pairs: 'all' });
      expect(report.ok).toBe(true);
      expect(report.cvd.deltaE).toBeGreaterThan(14);
    });

    it(`${mode}: tritanopia is reported, not gated (V.2-13), and stays above the validator floor of 5`, () => {
      const report = checkCategorical(palette(mode), { mode, surfaces: chartSurfaces(mode) });
      expect(report.tritan).toBeLessThan(8);
      expect(report.tritan).toBeGreaterThan(5);
    });
  }

  it('the dark slot 1 is one step lighter than the report’s #5265f9, which was 2.93:1 on the default dark card', () => {
    expect(contrastRatio('#5265f9', '#2f2f2d')).toBeLessThan(3);
    expect(contrastRatio(palette('dark')[0], '#2f2f2d')).toBeGreaterThanOrEqual(3);
    // The lift changes no other gate: the worst pairs are elsewhere in the set.
    const before = checkCategorical(['#5265f9', ...palette('dark').slice(1)], { mode: 'dark', surfaces: ['#111111'] });
    const after = checkCategorical(palette('dark'), { mode: 'dark', surfaces: ['#111111'] });
    expect(after.cvd.deltaE).toBeCloseTo(before.cvd.deltaE, 5);
    expect(after.normal.deltaE).toBeCloseTo(before.normal.deltaE, 5);
  });

  it('hues are never status: the nearest status colour is a modest ΔE ≥ 10 away, so status never shares a chart with them', () => {
    // design §3.4: orange↔warning 10.2, magenta↔danger 11.4, teal↔success 11.3 (Atlas light).
    const status = ['#16a34a', '#f59e0b', '#d4183d'];
    for (const hue of palette('light')) {
      const nearest = Math.min(...status.map((s) => separation(hue, s).normal));
      expect(nearest, hue).toBeGreaterThan(10);
    }
  });
});

describe('hue palette — mutation proofs (the gates bite)', () => {
  it('orange #e77412 in slot 3 fails the paper contrast check (2.89:1 on #FAF9F5)', () => {
    const mutated = [...palette('light')];
    mutated[2] = '#e77412';
    const report = checkCategorical(mutated, { mode: 'light', surfaces: chartSurfaces('light') });
    expect(report.ok).toBe(false);
    const paper = report.lowContrast.find((l) => l.surface.toLowerCase() === '#faf9f5');
    expect(paper?.hex).toBe('#e77412');
    expect(paper?.ratio).toBeCloseTo(2.89, 2);
    // Only the contrast gate: band, chroma, CVD and the normal floor all still pass.
    expect([report.offBand, report.lowChroma, report.cvd.state, report.normal.pass]).toEqual([[], [], 'pass', true]);
  });

  it('the order is load-bearing: swapping slots 2 and 4 puts magenta beside violet (normal ΔE 14.9 light, 14.5 dark) and fails', () => {
    for (const mode of ['light', 'dark'] as const) {
      const p = palette(mode);
      const swapped = [p[0], p[3], p[2], p[1], p[4]];
      const report = checkCategorical(swapped, { mode, surfaces: chartSurfaces(mode) });
      expect(report.ok, mode).toBe(false);
      expect(report.normal.pass, mode).toBe(false);
      expect(report.normal.deltaE, mode).toBeGreaterThan(14);
    }
  });

  it('…while the one harmless swap (slots 4 and 5, teal and violet) still passes: the gate rejects collisions, not change', () => {
    for (const mode of ['light', 'dark'] as const) {
      const p = palette(mode);
      expect(checkCategorical([p[0], p[1], p[2], p[4], p[3]], { mode, surfaces: chartSurfaces(mode) }).ok, mode).toBe(true);
    }
  });
});

// ── CL-6: the chart order and the raised step ────────────────────────
const KINDS: Array<CvdKind | undefined> = [undefined, 'protan', 'deutan', 'tritan'];
/** The worst ΔE of all pairs of a set, over normal vision and the three simulated dichromacies. */
function worstAllPairs(hexes: readonly string[]): { deltaE: number; pair: string } {
  let worst = { deltaE: Infinity, pair: '' };
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      for (const kind of KINDS) {
        const d = deltaE(hexes[i], hexes[j], kind);
        if (d < worst.deltaE) worst = { deltaE: d, pair: `${hexes[i]}↔${hexes[j]} (${kind ?? 'normal'})` };
      }
    }
  }
  return worst;
}
const inChartOrder = (mode: PaletteMode) => CHART_HUE_ORDER.map((slot) => palette(mode)[slot - 1]);

describe('hue palette — charts take the hues in CHART_HUE_ORDER', () => {
  it('the order is ultramarine, magenta, leaf, sky, then orange, teal, violet: every slot once', () => {
    expect([...CHART_HUE_ORDER]).toEqual([1, 2, 6, 7, 3, 4, 5]);
    expect([...CHART_HUE_ORDER].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: the first four of the chart order are ≥ 8 ΔE apart for ALL pairs, in normal, protan, deutan and tritan vision`, () => {
      const worst = worstAllPairs(inChartOrder(mode).slice(0, 4));
      expect(worst.deltaE, worst.pair).toBeGreaterThanOrEqual(8);
      // The measured margins: 8.9 light, 9.1 dark.
      expect(worst.deltaE).toBeGreaterThan(mode === 'light' ? 8.8 : 9);
    });

    it(`${mode}: …while the plain slot order 1-4 fails that test (magenta and teal collapse under deuteranopia)`, () => {
      const worst = worstAllPairs(palette(mode).slice(0, 4));
      expect(worst.deltaE).toBeLessThan(2);
      expect(worst.pair).toContain('deutan');
      expect(worst.pair).toContain(palette(mode)[1]);
      expect(worst.pair).toContain(palette(mode)[3]);
    });
  }

  it('the chart order still passes the adjacent gates as a sequence (stacks and lines draw neighbours side by side)', () => {
    for (const mode of ['light', 'dark'] as const) {
      const report = checkCategorical(inChartOrder(mode), { mode, surfaces: chartSurfaces(mode) });
      expect(report.ok, mode).toBe(true);
    }
  });
});

describe('hue palette — the raised step is reported, never a plot surface', () => {
  /** Each context's raised step, painted over its page. */
  const raisedOf = (mode: PaletteMode) =>
    Object.entries(CASCADES)
      .filter(([, c]) => c.mode === mode)
      .map(([name, { blocks }]) => ({ name, hex: tokenHex('--ds-raised', blocks, resolveColor(tokenHex('--ds-canvas', blocks))) }));

  it('reports every hue under 3:1 on a raised fill: in default dark, ultramarine, magenta and violet', () => {
    const under: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
      for (const { name, hex } of raisedOf(mode)) {
        palette(mode).forEach((hue, i) => {
          if (contrastRatio(hue, hex) < 3) under.push(`${name}: hue-${i + 1} ${contrastRatio(hue, hex).toFixed(2)}:1 on raised ${hex}`);
        });
      }
    }
    expect(under.map((u) => u.split(' ').slice(0, 4).join(' '))).toEqual(['default dark: hue-1 2.60:1', 'default dark: hue-2 2.82:1', 'default dark: hue-5 2.62:1']);
  });

  it('so a plot area sits on the card: CHART_PLOT_BG reads --ds-surface (≥ 3:1 for every hue), never --ds-raised', async () => {
    const { CHART_PLOT_BG } = await import('../../components/chat/studioDesign');
    expect(CHART_PLOT_BG).toBe('bg-[var(--ds-surface)]');
    expect(CHART_PLOT_BG).not.toMatch(/raised/);
    for (const mode of ['light', 'dark'] as const) {
      const report = checkCategorical(palette(mode), { mode, surfaces: chartSurfaces(mode) });
      expect(report.lowContrast, mode).toEqual([]);
    }
  });
});
