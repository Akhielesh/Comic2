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
import { APP_ROOT } from '../../tests/config/cssTokens';

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
    expect(motion).toMatch(/\[data-inview="false"\] \.ds-making-sweep::after,\s*\.ds-making-sweep\[data-inview="false"\]::after \{\s*animation-play-state: paused;/);
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
});
