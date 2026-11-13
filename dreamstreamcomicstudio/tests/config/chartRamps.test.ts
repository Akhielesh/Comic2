// @vitest-environment node
/**
 * The chart ramps of the colour layer "Ink, Paper & Colour" (CL-6; docs/design/design-system.md § Colour layer), read
 * from index.css in all four contexts (default and Atlas, light and dark):
 *   - sequential --ds-chart-seq-1…6: one hue, lightness moving one way, every step ≥ 0.06 OKLab L from the next, and
 *     the step nearest the plot surface still ≥ 2:1 on it (every step is checked on the plot surfaces);
 *   - diverging --ds-chart-div-1…7: an orange arm, a grey midpoint (chroma < 0.01), an ultramarine arm, the two arms
 *     equal within 0.01 L step for step, and the poles ≥ 20 ΔE apart under protanopia and deuteranopia (≥ 15 under
 *     tritanopia, which is rare: 19.5 in dark).
 * A plot draws on the page or a card (CHART_PLOT_BG), never on the raised step. Steps under 3:1 on a plot surface are
 * fills that always carry a value label or the table twin: the list of them is pinned here, so a ramp change that
 * adds one is a reviewed change. The ink steps --ds-chart-1…5 are the Atlas bridge and do not change
 * (atlasSkin.test.ts pins them).
 */
import { describe, expect, it } from 'vitest';
import { CHART_DIV_BG, CHART_DIV_FILL, CHART_SEQ_BG, CHART_SEQ_FILL } from '../../components/chat/studioDesign';
import { indexCss, over, parseRules, resolveColor, type Rgba, tokenBlocks } from './cssTokens';
import { contrastRatio, deltaE, oklabOf, oklchOf } from './paletteChecks';

const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(parseRules(indexCss));
const CONTEXTS: Record<string, { dark: boolean; blocks: Array<Map<string, string>> }> = {
  'default light': { dark: false, blocks: [ROOT_TOKENS] },
  'default dark': { dark: true, blocks: [DARK_TOKENS, ROOT_TOKENS] },
  'atlas light': { dark: false, blocks: [ATLAS_LIGHT, ROOT_TOKENS] },
  'atlas dark': { dark: true, blocks: [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS] }
};
const hexOf = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
function color(name: string, blocks: Array<Map<string, string>>): Rgba {
  const lookup = (n: string) => {
    for (const b of blocks) if (b.has(n)) return b.get(n)!;
    throw new Error(`chartRamps: ${n} is not defined`);
  };
  return resolveColor(lookup(name), lookup, [name]);
}
const ramp = (prefix: string, n: number, blocks: Array<Map<string, string>>) => Array.from({ length: n }, (_, i) => hexOf(color(`--ds-chart-${prefix}-${i + 1}`, blocks)));
/** The plot surfaces of a context: its page and a card on it. */
function plotSurfaces(blocks: Array<Map<string, string>>): Record<string, string> {
  const canvas = color('--ds-canvas', blocks);
  return { canvas: hexOf(canvas), card: hexOf(over(color('--ds-surface', blocks), canvas)) };
}
const L = (hex: string) => oklabOf(hex)[0];

describe('chart ramps — the recipes read the ramp tokens in order', () => {
  it('six sequential and seven diverging steps, as fills and as backgrounds', () => {
    expect(CHART_SEQ_FILL).toEqual([1, 2, 3, 4, 5, 6].map((n) => `fill-[var(--ds-chart-seq-${n})]`));
    expect(CHART_SEQ_BG).toEqual([1, 2, 3, 4, 5, 6].map((n) => `bg-[var(--ds-chart-seq-${n})]`));
    expect(CHART_DIV_FILL).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `fill-[var(--ds-chart-div-${n})]`));
    expect(CHART_DIV_BG).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `bg-[var(--ds-chart-div-${n})]`));
  });

  it('the values: one set per theme, the same with and without the skin', () => {
    for (const [name, { dark, blocks }] of Object.entries(CONTEXTS)) {
      expect(ramp('seq', 6, blocks), name).toEqual(dark ? ['#4452bf', '#5161e6', '#6275ff', '#7a90ff', '#95a9ff', '#b1c1ff'] : ['#98aaee', '#788eeb', '#5b71e8', '#4250e3', '#312bd2', '#231da3']);
      expect(ramp('div', 7, blocks), name).toEqual(dark ? ['#f4a25c', '#de6f11', '#91450d', '#4a4a4a', '#404dc1', '#7085ff', '#a2b2ff'] : ['#9a4900', '#d76900', '#eeae7b', '#d4d4d4', '#aabbf5', '#6a81f2', '#3d44e8']);
    }
  });
});

/** The pure checks, so the mutation cases below run the same code. */
function sequentialProblems(steps: string[], surfaces: Record<string, string>): string[] {
  const out: string[] = [];
  const ls = steps.map(L);
  const dir = Math.sign(ls[ls.length - 1] - ls[0]);
  for (let i = 1; i < ls.length; i++) {
    const step = (ls[i] - ls[i - 1]) * dir;
    if (step < 0.06) out.push(`step ${i}→${i + 1} moves ${step.toFixed(3)} L (< 0.06)`);
  }
  const hues = steps.map((h) => oklchOf(h).h);
  if (Math.max(...hues) - Math.min(...hues) > 6) out.push(`not one hue: ${Math.min(...hues).toFixed(1)}° to ${Math.max(...hues).toFixed(1)}°`);
  // The step nearest the surface: the one with the lowest contrast on it.
  for (const [name, bg] of Object.entries(surfaces)) {
    const nearest = Math.min(...steps.map((s) => contrastRatio(s, bg)));
    if (nearest < 2) out.push(`the nearest step is ${nearest.toFixed(2)}:1 on the ${name} ${bg} (< 2)`);
  }
  return out;
}
function divergingProblems(steps: string[]): string[] {
  const out: string[] = [];
  const mid = steps[3];
  if (oklchOf(mid).C >= 0.01) out.push(`midpoint ${mid} has chroma ${oklchOf(mid).C.toFixed(3)} (not grey)`);
  for (let k = 1; k <= 3; k++) {
    const left = Math.abs(L(steps[3 - k]) - L(mid));
    const right = Math.abs(L(steps[3 + k]) - L(mid));
    if (Math.abs(left - right) > 0.01) out.push(`arm step ${k}: ${left.toFixed(3)} vs ${right.toFixed(3)} L from the midpoint`);
  }
  // Protanopia and deuteranopia are gated at 20; tritanopia (rare; the legend and the midpoint label cover it) at 15.
  for (const [kind, floor] of [['protan', 20], ['deutan', 20], ['tritan', 15]] as const) {
    const d = deltaE(steps[0], steps[6], kind);
    if (d < floor) out.push(`poles ${d.toFixed(1)} ΔE apart under ${kind} (< ${floor})`);
  }
  return out;
}

describe('chart ramps — sequential: one hue, even steps, readable on the plot', () => {
  for (const [name, { blocks }] of Object.entries(CONTEXTS)) {
    it(`${name}: steps ≥ 0.06 L, one hue, the nearest step ≥ 2:1 on the page and on a card`, () => {
      expect(sequentialProblems(ramp('seq', 6, blocks), plotSurfaces(blocks))).toEqual([]);
    });
  }
});

describe('chart ramps — diverging: grey midpoint, equal arms, poles apart for colour-blind readers', () => {
  for (const [name, { blocks }] of Object.entries(CONTEXTS)) {
    it(`${name}: midpoint chroma < 0.01, arms equal within 0.01 L, poles ≥ 20 ΔE (protan, deutan; tritan ≥ 15)`, () => {
      expect(divergingProblems(ramp('div', 7, blocks))).toEqual([]);
    });
  }
});

describe('chart ramps — every step on every plot surface', () => {
  it('the steps under 3:1 are exactly these (fills that always carry a value label or the table twin)', () => {
    const under: string[] = [];
    for (const [name, { blocks }] of Object.entries(CONTEXTS)) {
      for (const [surface, bg] of Object.entries(plotSurfaces(blocks))) {
        for (const [prefix, n] of [['seq', 6], ['div', 7]] as const) {
          ramp(prefix, n, blocks).forEach((hex, i) => {
            if (contrastRatio(hex, bg) < 3) under.push(`${name} ${surface}: ${prefix}-${i + 1}`);
          });
        }
      }
    }
    // The inner steps of each ramp: the two lightest sequential steps (light) or darkest (dark), and the diverging
    // midpoint with its two inner neighbours. Never a pole, never the strong end of a ramp.
    expect([...new Set(under.map((u) => u.split(': ')[1]))].sort()).toEqual(['div-3', 'div-4', 'div-5', 'seq-1', 'seq-2']);
    expect(under.filter((u) => u.endsWith('seq-2'))).toEqual(['default light canvas: seq-2', 'default dark card: seq-2']);
    // Every one of them still clears 1.2:1 on its surface (none vanishes into the card).
    for (const [, { blocks }] of Object.entries(CONTEXTS)) {
      for (const bg of Object.values(plotSurfaces(blocks))) {
        for (const hex of [...ramp('seq', 6, blocks), ...ramp('div', 7, blocks).filter((_, i) => i !== 3)]) expect(contrastRatio(hex, bg), hex).toBeGreaterThan(1.2);
      }
    }
  });
});

describe('chart ramps — mutation proofs (the gates bite)', () => {
  it('the original first sequential step (#9badf1 light, #2f36a1 dark) fails the 2:1 nearest-step floor', () => {
    const light = ramp('seq', 6, CONTEXTS['default light'].blocks);
    expect(sequentialProblems(['#9badf1', ...light.slice(1)], { soft: '#f4f4f4' }).join()).toMatch(/nearest step is 1\.9\d:1/);
    const dark = ramp('seq', 6, CONTEXTS['default dark'].blocks);
    expect(sequentialProblems(['#2f36a1', ...dark.slice(1)], plotSurfaces(CONTEXTS['default dark'].blocks)).join()).toMatch(/nearest step/);
  });

  it('a lopsided arm, a tinted midpoint and a too-small step each fail', () => {
    const div = ramp('div', 7, CONTEXTS['atlas light'].blocks);
    expect(divergingProblems([div[0], div[1], div[2], div[3], div[4], div[5], '#231da3'])).toEqual([expect.stringMatching(/^arm step 3/)]);
    expect(divergingProblems([...div.slice(0, 3), '#d4d0c8', ...div.slice(4)])).toEqual([expect.stringMatching(/^midpoint/)]);
    const seq = ramp('seq', 6, CONTEXTS['atlas light'].blocks);
    expect(sequentialProblems([seq[0], '#93a6ee', ...seq.slice(2)], {}).join()).toMatch(/step 1→2 moves/);
  });
});
