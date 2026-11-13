// @vitest-environment node
/**
 * The colour layer recipes (components/chat/studioDesign.ts, re-exported by recipes.ts) compile with this app's
 * Tailwind to the intended declarations — the risky arbitrary values are an outline colour and a box shadow over
 * var(), and a custom property — and the hand-written classes exist in styles/ds-motion.css, pause off screen and
 * hold still under reduced motion.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import * as design from '../chat/studioDesign';
import { APP_ROOT, parseRules, tokenBlocks, topLevelSplit } from '../../tests/config/cssTokens';

const req = createRequire(path.join(APP_ROOT, 'package.json'));

describe('the colour layer recipes compile and exist', () => {
  const compile = async (classes: string): Promise<string> => {
    const tailwind = req('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
    const config = req(path.join(APP_ROOT, 'tailwind.config.cjs'));
    const result = await postcss([tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
    return result.css.replace(/\s+/g, ' ');
  };

  it('the arbitrary values Tailwind 3 could misread compile to the intended declarations', async () => {
    const css = await compile([design.SPARK_FILL, design.SPARK_TEXT, design.SPARK_SOFT_BG, design.SPARK_RING_ON_ART, design.MAKING_DOT, design.MAKING_TEXT, design.ART_PLACEHOLDER, design.ART_GLOW, ...design.HUE_DOT, ...design.HUE_FILL, ...design.HUE_STROKE].join(' '));
    expect(css).toContain('background-color: var(--ds-spark)');
    expect(css).toContain('color: var(--ds-on-spark)');
    expect(css).toContain('color: var(--ds-spark-text)');
    expect(css).toContain('background-color: var(--ds-spark-soft)');
    expect(css).toContain('outline-color: var(--ds-spark)');
    expect(css).toContain('outline-width: 2px');
    expect(css).toContain('--ds-shimmer-glint: var(--ds-spark-text)');
    expect(css).toContain('background-color: var(--ds-art)');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{[^}]*:hover \{ --tw-shadow: 0 10px 28px -10px color-mix\(in srgb,var\(--ds-art\) 55%,transparent\)/);
    for (let i = 1; i <= 5; i++) {
      expect(css).toContain(`background-color: var(--ds-hue-${i})`);
      expect(css).toContain(`fill: var(--ds-hue-${i})`);
      expect(css).toContain(`stroke: var(--ds-hue-${i})`);
    }
  });

  it('the hand-written classes (MAKING_SWEEP, MAKING_TEXT, BENDAY) are defined in styles/ds-motion.css, paused off screen and still under reduced motion', () => {
    const motion = readFileSync(path.join(APP_ROOT, 'styles/ds-motion.css'), 'utf8');
    expect(design.MAKING_SWEEP).toBe('ds-making-sweep');
    expect(design.BENDAY).toBe('ds-benday');
    expect(design.MAKING_TEXT.split(' ')[0]).toBe('ds-shimmer-text');
    expect(motion).toMatch(/\.ds-making-sweep::after \{[^}]*var\(--ds-spark-glow\)[^}]*animation: ds-making-sweep 2\.4s/);
    expect(motion).toMatch(/@keyframes ds-making-sweep \{\s*to \{ transform: translateX\(100%\); \}/);
    // Both off-screen forms sit in the shared paused list (other loops join that list too, so read its selectors).
    const paused = parseRules(motion).filter((r) => r.parents.length === 0 && /animation-play-state:\s*paused/.test(r.body));
    const pausedSelectors = paused.flatMap((r) => topLevelSplit(r.selector).map((sel) => sel.trim()));
    expect(pausedSelectors).toEqual(expect.arrayContaining(['[data-inview="false"] .ds-making-sweep::after', '.ds-making-sweep[data-inview="false"]::after']));
    const reduce = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.ds-making-sweep::after \{\s*animation: none;\s*transform: none;/);
    // Ben-Day: the spark at 22 % in both dot lattices, spelled on the layer itself, never animated.
    const benday = /\.ds-benday::before \{([^}]*)\}/.exec(motion)?.[1] ?? '';
    expect(benday.match(/radial-gradient\(circle, color-mix\(in srgb, var\(--ds-spark\) 22%, transparent\) 1\.6px, transparent 2px\)/g)).toHaveLength(2);
    expect(benday).not.toMatch(/animation|transition/);
  });

  it('Ben-Day dots and their fade sit on the host’s own ::before layer behind its content, so the hero art and the CTA never fade', () => {
    const motion = readFileSync(path.join(APP_ROOT, 'styles/ds-motion.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const host = [...motion.matchAll(/(^|\})\s*\.ds-benday \{([^}]*)\}/g)].map((m) => m[2]);
    expect(host).toHaveLength(1);
    // The element itself carries no mask, no dots and no grid-dot override (a nested .ds-grid-backdrop keeps ink dots).
    expect(host[0]).not.toMatch(/mask|background|--ds-grid-dot/);
    expect(host[0]).toMatch(/position: relative;/);
    expect(host[0]).toMatch(/isolation: isolate;/);
    const layer = /\.ds-benday::before \{([^}]*)\}/.exec(motion)?.[1] ?? '';
    expect(layer).toMatch(/content: "";/);
    expect(layer).toMatch(/position: absolute;\s*inset: 0;\s*z-index: -1;\s*pointer-events: none;/);
    expect(layer).toMatch(/(?<!-)mask-image: radial-gradient/);
    expect(layer).toMatch(/-webkit-mask-image: radial-gradient/);
    expect(layer).toContain('var(--ds-spark)');
    // No other .ds-benday rule masks or recolours what is inside the host.
    const others = [...motion.matchAll(/([^{}]*\.ds-benday[^{}]*)\{([^}]*)\}/g)].filter((m) => !/::before/.test(m[1]));
    for (const m of others) expect(m[2], m[1].trim()).not.toMatch(/mask|--ds-grid-dot/);
  });

  it('hueIndex is 0-based like the HUE_* arrays and folds past five; hueClass reads the slot (a sixth series joins "Other")', () => {
    expect([0, 1, 2, 3, 4, 5, -1, 1.5].map(design.hueIndex)).toEqual([0, 1, 2, 3, 4, null, null, null]);
    expect(design.HUE_DOT).toHaveLength(5);
    // The natural call reads the right slot: series 0 is hue-1 and series 4 is hue-5 (never undefined).
    for (let i = 0; i < 5; i++) {
      const at = design.hueIndex(i)!;
      expect(design.HUE_DOT[at]).toBe(`bg-[var(--ds-hue-${i + 1})]`);
      expect(design.hueClass('dot', i)).toBe(`bg-[var(--ds-hue-${i + 1})]`);
      expect(design.hueClass('fill', i)).toBe(`fill-[var(--ds-hue-${i + 1})]`);
      expect(design.hueClass('stroke', i)).toBe(`stroke-[var(--ds-hue-${i + 1})]`);
    }
    expect(design.hueClass('dot', 5)).toBeNull();
    expect(design.hueClass('fill', -1)).toBeNull();
  });

  it('the "Ink, Paper & Colour" recipes compile to their tokens (CL-6): marks, text steps, tints, solids, ramps, washes, art tint, studio', async () => {
    const all = [
      ...design.HUE_MARK.dot, ...design.HUE_MARK.fill, ...design.HUE_MARK.stroke, ...design.HUE_TEXT, ...design.HUE_SOFT_BG, ...design.HUE_SOLID,
      ...design.CHART_SEQ_FILL, ...design.CHART_SEQ_BG, ...design.CHART_DIV_FILL, ...design.CHART_DIV_BG,
      design.CHART_PLOT_BG, design.INK_TILE, design.WASH_HERO, design.WASH_EMPTY, design.ART_SOFT_BG, design.ART_EDGE, design.STUDIO_SOFT_BG, design.STUDIO_MARK
    ];
    const css = await compile(all.join(' '));
    for (let n = 1; n <= 7; n++) {
      for (const decl of [`background-color: var(--ds-hue-${n})`, `fill: var(--ds-hue-${n})`, `stroke: var(--ds-hue-${n})`, `color: var(--ds-hue-${n}-text)`, `background-color: var(--ds-hue-${n}-soft)`, `background-color: var(--ds-hue-${n}-solid)`]) expect(css, decl).toContain(decl);
    }
    expect(css).toContain('color: var(--ds-on-hue)');
    for (let n = 1; n <= 6; n++) expect(css).toContain(`fill: var(--ds-chart-seq-${n})`);
    for (let n = 1; n <= 7; n++) expect(css).toContain(`background-color: var(--ds-chart-div-${n})`);
    // The washes are background IMAGES (a gradient token), never a colour, and do not tile.
    expect(css).toContain('background-image: var(--ds-wash-hero)');
    expect(css).toContain('background-image: var(--ds-wash-empty)');
    expect(css).toContain('background-repeat: no-repeat');
    expect(css).toContain('background-color: var(--ds-art-soft)');
    expect(css).toContain('border-color: var(--ds-art-edge)');
    expect(css).toContain('background-color: var(--ds-studio-soft)');
    expect(css).toContain('background-color: var(--ds-studio)');
    expect(css).toContain('background-color: var(--ds-surface)');
  });

  it('the art scope is a hand-written class in index.css (ART_SCOPE), derived in light and dark', () => {
    const index = readFileSync(path.join(APP_ROOT, 'index.css'), 'utf8');
    expect(design.ART_SCOPE).toBe('ds-art-scope');
    expect(index).toMatch(/\n\.ds-art-scope \{[^}]*--ds-art-soft: color-mix\(in oklab, var\(--ds-art\) 12%, var\(--ds-canvas\)\)/);
    expect(index).toMatch(/\.dark \.ds-art-scope,\s*\.dark\.ds-art-scope \{[^}]*--ds-art-soft: color-mix\(in oklab, var\(--ds-art\) 18%/);
  });

  it('chartHue reads the chart order (ultramarine, magenta, leaf, sky, orange, teal, violet) and folds past seven; hueChip is ink on the tint', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => design.chartHue('fill', i))).toEqual([1, 2, 6, 7, 3, 4, 5].map((n) => `fill-[var(--ds-hue-${n})]`));
    expect(design.chartHue('dot', 2)).toBe('bg-[var(--ds-hue-6)]');
    expect(design.chartHue('stroke', 3)).toBe('stroke-[var(--ds-hue-7)]');
    expect([7, -1, 1.5].map((i) => design.chartHue('fill', i))).toEqual([null, null, null]);
    expect(design.HUE_MARK.dot).toHaveLength(7);
    for (let i = 0; i < 7; i++) expect(design.hueChip(i)).toBe(`bg-[var(--ds-hue-${i + 1}-soft)] text-[var(--ds-ink)]`);
    expect(design.hueChip(7)).toBe('bg-[var(--ds-well-strong)] text-[var(--ds-ink)]');
    // The five-slot series recipes keep their meaning (Sparkline's series 0-4, "Other" past five).
    expect(design.HUE_DOT).toEqual(design.HUE_MARK.dot.slice(0, 5));
    expect(design.HUE_FILL).toEqual(design.HUE_MARK.fill.slice(0, 5));
  });

  it('every var()-derived colour-layer token is restated in all four token blocks, so a nested .dark panel or skin root recomputes it', () => {
    const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(parseRules(readFileSync(path.join(APP_ROOT, 'index.css'), 'utf8')));
    const derived = [...ROOT_TOKENS].filter(([k, v]) => /^--ds-(?:hue-\d-(?:soft|solid)|studio(?:-soft)?|art-(?:soft|edge)|wash-\w+)$/.test(k) && /var\(/.test(v)).map(([k]) => k);
    expect(derived.length).toBe(7 + 7 + 2 + 2 + 2);
    for (const [name, block] of Object.entries({ DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK })) {
      expect(derived.filter((k) => !block.has(k)), name).toEqual([]);
    }
    // The soft tint follows its block's raised step: the dark blocks mix 16 %, the light ones 12 %.
    expect(DARK_TOKENS.get('--ds-hue-4-soft')).toBe('color-mix(in srgb, var(--ds-hue-4) 16%, var(--ds-raised))');
    expect(ATLAS_LIGHT.get('--ds-hue-4-soft')).toBe('color-mix(in srgb, var(--ds-hue-4) 12%, var(--ds-raised))');
  });
});
