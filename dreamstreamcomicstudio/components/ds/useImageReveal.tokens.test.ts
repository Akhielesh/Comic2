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
