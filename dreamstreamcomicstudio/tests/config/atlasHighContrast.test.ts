// @vitest-environment node
/**
 * The OS "increase contrast" setting under the Atlas skin (`@media (prefers-contrast: more)` in index.css), as
 * taken from the Atlas design branch: the hues and status colours that fall short of a firm mark on the page are
 * moved along their own hue, light hue-2 / hue-3 / hue-4 / hue-7 / success / warning darker, dark hue-1 / hue-5
 * lighter. Everything else in the colour layer is DERIVED from those (the soft tints, the solids, the status text
 * inks, the tone tints), so this file checks, with the suite's own maths (tests/config/cssTokens.ts and
 * paletteChecks.ts), that every derived token still meets the gate the colour layer promises for its role:
 *   - a hue as a mark: the categorical gates (band, chroma, CVD, the normal floor) and ≥ 3:1 on every chart surface;
 *   - a hue's text step on its own soft tint and on every surface: ≥ 4.5:1; the label on a solid: 4.5:1 where words
 *     are allowed (slots 1, 5, 6 in light, every slot in dark), 3:1 (an icon) elsewhere;
 *   - status text on its own tone tints (TONE_SURFACE 10 %, STATUS_SURFACE 6 % / 8 %, TONE_CHIP_ON_ART): ≥ 4.5:1;
 *   - a status colour as a mark (a dot, a bar): ≥ 3:1 on the page, a card, an overlay and the raised step.
 * tokenContrast.test.ts measures the whole matrix in the two "more contrast" contexts too; this file pins the
 * values, proves the move is the right way (stronger, same hue) and that no var() chain leaves a derived token stale.
 */
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import {
  ATLAS_DARK_SELECTOR,
  ATLAS_LIGHT_SELECTOR,
  MORE_CONTRAST_MEDIA,
  compareSpecificity,
  indexCss,
  over,
  parseRules,
  ratio,
  resolveColor,
  specificity,
  tokenBlocks,
  topLevelSplit,
  withAlpha,
  type Rgba
} from './cssTokens';
import { checkCategorical, oklchOf } from './paletteChecks';

const rules = parseRules(indexCss);
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_DARK_MORE } = tokenBlocks(rules);

/**
 * The eight overrides, by theme (the Atlas design branch's own high-contrast block), with one deliberate
 * difference: the light teal. The branch's #06847f has OKLCH chroma 0.095, under this tree's 0.10 floor for a hue
 * (below it a hue reads as grey; paletteChecks.ts), and no in-gamut teal that dark clears it, so this tree takes
 * #008e87: the darkest teal within 2° of the base hue that keeps chroma ≥ 0.10 (4.02:1 on white; the base is 3.47).
 */
const ATLAS_BRANCH_LIGHT_TEAL = '#06847f';
const LIGHT_OVERRIDES = {
  '--ds-hue-2': '#cd3c8e',
  '--ds-hue-3': '#ba5b03',
  '--ds-hue-4': '#008e87',
  '--ds-hue-7': '#006a9d',
  '--ds-success': '#12873d',
  '--ds-warning': '#a46a07'
} as const;
const DARK_OVERRIDES = {
  '--ds-hue-1': '#5a6dfd',
  '--ds-hue-5': '#a45adb'
} as const;

type Mode = 'light' | 'dark';
/** The cascade an element sees, highest priority first (as in tokenContrast.test.ts). */
const CASCADE: Record<Mode, { base: Map<string, string>[]; more: Map<string, string>[] }> = {
  light: { base: [ATLAS_LIGHT, ROOT_TOKENS], more: [ATLAS_LIGHT_MORE, ATLAS_LIGHT, ROOT_TOKENS] },
  dark: {
    base: [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS],
    more: [ATLAS_DARK_MORE, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS]
  }
};
const lookupIn = (chain: Map<string, string>[]) => (name: string) => {
  for (const b of chain) {
    const v = b.get(name);
    if (v !== undefined) return v;
  }
  throw new Error(`atlasHighContrast: ${name} is not defined`);
};
const tokenIn = (chain: Map<string, string>[], name: string): Rgba => resolveColor(lookupIn(chain)(name), lookupIn(chain), [name]);
const more = (mode: Mode, name: string) => tokenIn(CASCADE[mode].more, name);
const base = (mode: Mode, name: string) => tokenIn(CASCADE[mode].base, name);
const hexOf = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
const SLOTS = design.HUE_SLOTS;
const MODES: Mode[] = ['light', 'dark'];

/** The page, a card, the soft glass, an overlay and the raised step, each opaque over the page. */
function surfaces(mode: Mode): Map<string, Rgba> {
  const t = (n: string) => more(mode, n);
  const canvas = t('--ds-canvas');
  return new Map<string, Rgba>([
    ['canvas', canvas],
    ['sidebar', t('--ds-sidebar')],
    ['surface', over(t('--ds-surface'), canvas)],
    ['surface-soft', over(t('--ds-surface-soft'), canvas)],
    ['surface-strong', over(t('--ds-surface-strong'), canvas)],
    ['raised', over(t('--ds-raised'), canvas)],
    ['hover on canvas', over(t('--ds-hover'), canvas)],
    ['overlay-hover on raised', over(t('--ds-overlay-hover'), over(t('--ds-raised'), canvas))]
  ]);
}
/** The surfaces a chart's marks sit on (huePalette.test.ts: the page, its card, the soft surface). */
const chartSurfaces = (mode: Mode) => ['canvas', 'surface', 'surface-soft'].map((k) => hexOf(surfaces(mode).get(k)!));
const palette = (mode: Mode) => SLOTS.map((s) => hexOf(more(mode, `--ds-hue-${s}`)));

describe('Atlas skin under "increase contrast" — the hue and status overrides', () => {
  it('pins the eight values, each in its own theme block inside @media (prefers-contrast: more)', () => {
    for (const [k, v] of Object.entries(LIGHT_OVERRIDES)) expect(ATLAS_LIGHT_MORE.get(k), k).toBe(v);
    for (const [k, v] of Object.entries(DARK_OVERRIDES)) expect(ATLAS_DARK_MORE.get(k), k).toBe(v);
    // Light-only overrides are not in the dark block, nor the dark ones in the light block.
    for (const k of Object.keys(LIGHT_OVERRIDES)) expect(ATLAS_DARK_MORE.has(k), `dark restates ${k}`).toBe(false);
    for (const k of Object.keys(DARK_OVERRIDES)) expect(ATLAS_LIGHT_MORE.has(k), `light restates ${k}`).toBe(false);
    // They are what an element sees: the resolved colour in each "more contrast" context.
    for (const [k, v] of Object.entries(LIGHT_OVERRIDES)) expect(hexOf(more('light', k)), k).toBe(v);
    for (const [k, v] of Object.entries(DARK_OVERRIDES)) expect(hexOf(more('dark', k)), k).toBe(v);
  });

  it('the light overrides never reach the dark theme: the dark base block outranks the light high-contrast block and restates each', () => {
    const top = (sel: string) => topLevelSplit(sel).map(specificity);
    const lightHc = rules.find((r) => r.parents[0] === MORE_CONTRAST_MEDIA && r.selector === ATLAS_LIGHT_SELECTOR);
    expect(lightHc, 'the light high-contrast block').toBeDefined();
    for (const darkSpec of top(ATLAS_DARK_SELECTOR)) {
      for (const lightSpec of top(ATLAS_LIGHT_SELECTOR)) expect(compareSpecificity(darkSpec, lightSpec)).toBeGreaterThan(0);
    }
    for (const k of Object.keys(LIGHT_OVERRIDES)) {
      expect(ATLAS_DARK.has(k), `the dark base block defines ${k}`).toBe(true);
      expect(hexOf(more('dark', k)), k).toBe(hexOf(base('dark', k)));
    }
  });

  it('each override moves its colour along its own hue (≤ 6° of OKLCH h) and only ever strengthens it on the page', () => {
    for (const [mode, overrides] of [['light', LIGHT_OVERRIDES], ['dark', DARK_OVERRIDES]] as const) {
      const canvas = more(mode, '--ds-canvas');
      for (const k of Object.keys(overrides)) {
        const [was, now] = [hexOf(base(mode, k)), hexOf(more(mode, k))];
        expect(now, `${mode} ${k} actually moves`).not.toBe(was);
        const dh = Math.abs(oklchOf(now).h - oklchOf(was).h);
        expect(Math.min(dh, 360 - dh), `${mode} ${k} hue shift`).toBeLessThanOrEqual(6);
        expect(ratio(more(mode, k), canvas), `${mode} ${k} on the page`).toBeGreaterThan(ratio(base(mode, k), canvas));
      }
    }
  });
});

describe('Atlas skin under "increase contrast" — every derived token still meets its gate', () => {
  for (const mode of MODES) {
    it(`${mode}: the hues as marks pass the categorical gates and are ≥ 3:1 on every chart surface (slot order and chart order)`, () => {
      const surfacesHex = chartSurfaces(mode);
      const report = checkCategorical(palette(mode), { mode, surfaces: surfacesHex });
      expect(report.lowContrast, mode).toEqual([]);
      expect(report.offBand, mode).toEqual([]);
      expect(report.lowChroma, mode).toEqual([]);
      expect(report.cvd.state, `${mode} worst ${report.cvd.a}↔${report.cvd.b} ${report.cvd.deltaE.toFixed(1)}`).toBe('pass');
      expect(report.normal.pass, mode).toBe(true);
      const ordered = design.CHART_HUE_ORDER.map((slot) => palette(mode)[slot - 1]);
      expect(checkCategorical(ordered, { mode, surfaces: surfacesHex }).ok, `${mode} chart order`).toBe(true);
    });

    it(`${mode}: each hue's text step is ≥ 4.5:1 on its own soft tint (mixed from the moved hue) and on every surface`, () => {
      const failing: string[] = [];
      const canvas = more(mode, '--ds-canvas');
      for (const slot of SLOTS) {
        const text = more(mode, `--ds-hue-${slot}-text`);
        const soft = over(more(mode, `--ds-hue-${slot}-soft`), canvas);
        for (const [bg, c] of [...surfaces(mode), [`hue-${slot}-soft`, soft] as const]) {
          const r = ratio(text, c);
          if (r < 4.5) failing.push(`${mode} hue-${slot}-text on ${bg} = ${r.toFixed(2)}`);
        }
      }
      expect(failing).toEqual([]);
    });

    it(`${mode}: the label on each solid is ≥ 4.5:1 where words are allowed and ≥ 3:1 (an icon) elsewhere`, () => {
      const canvas = more(mode, '--ds-canvas');
      const on = more(mode, '--ds-on-hue');
      for (const slot of SLOTS) {
        const words = mode === 'dark' || design.HUE_SOLID_TEXT_SLOTS.includes(slot);
        const solid = over(more(mode, `--ds-hue-${slot}-solid`), canvas);
        expect(ratio(on, solid), `${mode} on-hue on hue-${slot}-solid`).toBeGreaterThanOrEqual(words ? 4.5 : 3);
      }
    });

    it(`${mode}: status text is ≥ 4.5:1 on every surface and on its own tone tints (10 %, 6 % / 8 %, the chip on art)`, () => {
      const failing: string[] = [];
      const s = surfaces(mode);
      const raised = s.get('raised')!;
      for (const [tone, statusAlpha] of [['success', 0.06], ['warning', 0.08]] as const) {
        const text = more(mode, `--ds-${tone}-text`);
        const mark = more(mode, `--ds-${tone}`);
        const bgs = new Map<string, Rgba>(s);
        for (const k of ['canvas', 'surface', 'surface-soft', 'surface-strong', 'raised']) {
          bgs.set(`tone 10 % on ${k}`, over(withAlpha(mark, 0.1), s.get(k)!));
          bgs.set(`status ${statusAlpha * 100} % on ${k}`, over(withAlpha(mark, statusAlpha), s.get(k)!));
        }
        // TONE_CHIP_ON_ART: the tone mixed 10 % into the opaque raised step.
        bgs.set('chip on art', over(withAlpha(mark, 0.1), raised));
        for (const [bg, c] of bgs) {
          const r = ratio(over(text, c), c);
          if (r < 4.5) failing.push(`${mode} --ds-${tone}-text on ${bg} = ${r.toFixed(2)}`);
        }
      }
      expect(failing).toEqual([]);
    });

    it(`${mode}: success and warning as marks are ≥ 3:1 on the page, a card, an overlay and the raised step`, () => {
      const s = surfaces(mode);
      for (const tone of ['success', 'warning'] as const) {
        for (const bg of ['canvas', 'surface', 'surface-strong', 'raised']) {
          expect(ratio(more(mode, `--ds-${tone}`), s.get(bg)!), `${mode} ${tone} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  it('the derived tokens follow the moved colour (no stale var() chain): soft, solid and status text are mixed from the override', () => {
    for (const [mode, overrides] of [['light', LIGHT_OVERRIDES], ['dark', DARK_OVERRIDES]] as const) {
      const raised = more(mode, '--ds-raised');
      const share = mode === 'light' ? 0.12 : 0.16;
      for (const k of Object.keys(overrides)) {
        const src = more(mode, k);
        const slot = /^--ds-hue-(\d)$/.exec(k)?.[1];
        if (slot) {
          expect(hexOf(more(mode, `--ds-hue-${slot}-solid`)), `${mode} hue-${slot}-solid`).toBe(hexOf(src));
          expect(hexOf(more(mode, `--ds-hue-${slot}-soft`)), `${mode} hue-${slot}-soft`).toBe(hexOf(over(withAlpha(src, share), raised)));
        } else {
          // The status text ink is a mix of the status colour into the ink: it moved with it.
          expect(hexOf(more(mode, `${k}-text`)), `${mode} ${k}-text`).not.toBe(hexOf(base(mode, `${k}-text`)));
        }
      }
    }
  });

  it('every token the skin derives from an overridden colour is declared on the skin element itself, so it recomputes there', () => {
    // A custom property inherits as a computed value: a token derived on an ancestor (the plain :root / .dark blocks)
    // from a colour the skin's high-contrast block changes would reach the skin root stale. So every :root / .dark
    // token that reads an overridden colour must be restated in the skin block of the same theme.
    const sources = [...Object.keys(LIGHT_OVERRIDES), ...Object.keys(DARK_OVERRIDES)];
    const reads = (v: string) => sources.some((s) => new RegExp(`var\\(\\s*${s}\\s*[,)]`).test(v));
    const stale: string[] = [];
    for (const [name, plain, skin] of [['light', ROOT_TOKENS, ATLAS_LIGHT], ['dark', DARK_TOKENS, ATLAS_DARK]] as const) {
      for (const [k, v] of plain) if (reads(v) && !skin.has(k)) stale.push(`${name} ${k}`);
    }
    expect(stale).toEqual([]);
    // …and the check sees the real chains (it is not vacuous): the soft tints, the status inks and the washes.
    const derived = [...ATLAS_LIGHT].filter(([, v]) => reads(v)).map(([k]) => k);
    expect(derived).toEqual(expect.arrayContaining(['--ds-hue-2-soft', '--ds-hue-7-solid', '--ds-success-text', '--ds-warning-text', '--ds-wash-hero']));
  });

  it('the light teal differs from the Atlas design branch on purpose: its #06847f fails the chroma floor, ours clears it', () => {
    expect(oklchOf(ATLAS_BRANCH_LIGHT_TEAL).C).toBeLessThan(0.1);
    const mutated = palette('light').map((h, i) => (i === 3 ? ATLAS_BRANCH_LIGHT_TEAL : h));
    const report = checkCategorical(mutated, { mode: 'light', surfaces: chartSurfaces('light') });
    expect(report.lowChroma.map((l) => l.hex)).toEqual([ATLAS_BRANCH_LIGHT_TEAL]);
    expect(oklchOf(LIGHT_OVERRIDES['--ds-hue-4']).C).toBeGreaterThanOrEqual(0.1);
  });

  it('the gates bite: Atlas base warning (#f59e0b) as a mark is under 3:1 on white, the reason it moves under more contrast', () => {
    expect(ratio(resolveColor('#f59e0b'), resolveColor('#ffffff'))).toBeLessThan(3);
    expect(ratio(resolveColor(LIGHT_OVERRIDES['--ds-warning']), resolveColor('#ffffff'))).toBeGreaterThanOrEqual(3);
  });
});
