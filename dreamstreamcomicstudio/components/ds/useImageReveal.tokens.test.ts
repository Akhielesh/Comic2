// @vitest-environment node
/**
 * useImageReveal reads its durations and curve from the --ds-motion-* tokens at run time; where it cannot (no
 * computed style), it falls back to revealTokenFallbacks. Those must be index.css's own :root values, so an
 * entrance never runs on a number nobody chose.
 */
import { describe, expect, it } from 'vitest';
import { indexCss, parseRules, tokenBlocks } from '../../tests/config/cssTokens';
import { parseMotionMs, revealTokenFallbacks } from './useImageReveal';

describe('useImageReveal token fallbacks', () => {
  it('equal index.css’s :root values', () => {
    const { ROOT_TOKENS } = tokenBlocks(parseRules(indexCss));
    for (const [token, value] of Object.entries(revealTokenFallbacks)) {
      const css = ROOT_TOKENS.get(token);
      expect(css, token).toBeDefined();
      expect(typeof value === 'number' ? parseMotionMs(css!, -1) : css, token).toBe(value);
    }
  });
});

describe('the develop light and sheen (ImageDevelop, MO-1)', () => {
  // ImageDevelop paints var(--ds-develop-light, rgb(255 255 255)) under a 0.35 opacity peak and one
  // var(--ds-develop-sheen, rgba(255,255,255,0.18)) sweep. Light keeps those fallbacks; dark softens the light so a
  // noir page does not start milky, and keeps the sheen faint. Both, with and without the Atlas skin.
  const blocks = tokenBlocks(parseRules(indexCss));
  const alpha = (v: string | undefined) => {
    const m = /^rgba?\((?:\s*\d+\s*[ ,]){2}\s*\d+\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(v ?? '');
    if (!m) throw new Error(`not an rgb() colour: ${v}`);
    return m[1] === undefined ? 1 : Number(m[1]);
  };

  it('light: the inline fallbacks, defined in the skin', () => {
    for (const [name, block] of Object.entries({ root: blocks.ROOT_TOKENS, atlas: blocks.ATLAS_LIGHT })) {
      expect(block.get('--ds-develop-light'), name).toBe('rgb(255 255 255)');
      expect(block.get('--ds-develop-sheen'), name).toBe('rgba(255,255,255,0.18)');
    }
  });

  it('dark: a softened light (about half) and a faint sheen (0.12–0.18)', () => {
    for (const [name, block] of Object.entries({ dark: blocks.DARK_TOKENS, 'atlas dark': blocks.ATLAS_DARK })) {
      expect(alpha(block.get('--ds-develop-light')), name).toBeCloseTo(0.55, 5);
      const sheen = alpha(block.get('--ds-develop-sheen'));
      expect(sheen, name).toBeGreaterThanOrEqual(0.12);
      expect(sheen, name).toBeLessThanOrEqual(0.18);
    }
  });
});
