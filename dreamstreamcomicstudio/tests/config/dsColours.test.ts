// @vitest-environment node
/**
 * The named `ds` colours (bridge D6; docs/design/design-system.md "Named ds colours"). tailwind.config.cjs maps
 * every `--ds-*` colour token of index.css to `ds-<name>`, through a colour function, so a slash opacity is
 * legal CSS: `text-ds-ink/60` compiles to color-mix() over the token, never to a slash on `var()` (invalid).
 * The list must equal index.css's colour tokens: a new colour token without a named colour fails, and so does a
 * named colour whose token is gone. A probe is compiled with this app's Tailwind and config.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { APP_ROOT, indexCss, parseRules, resolveColor, tokenBlocks } from './cssTokens';

const require = createRequire(import.meta.url);
const tailwind = require('tailwindcss') as (config: unknown) => postcss.AcceptedPlugin;
const config = require(path.join(APP_ROOT, 'tailwind.config.cjs')) as { theme: { extend: { colors: Record<string, unknown> } } };
const ds = config.theme.extend.colors.ds as Record<string, (o: { opacityValue?: string }) => string>;

const { ROOT_TOKENS } = tokenBlocks(parseRules(indexCss));
/** Every :root --ds-* token whose value is a colour (var() followed), by name without the prefix. */
const COLOUR_TOKENS = [...ROOT_TOKENS.keys()]
  .filter((k) => {
    try {
      resolveColor(ROOT_TOKENS.get(k)!, (n) => {
        const v = ROOT_TOKENS.get(n);
        if (v === undefined) throw new Error(n);
        return v;
      }, [k]);
      return true;
    } catch {
      return false;
    }
  })
  .map((k) => k.slice('--ds-'.length));

const compile = async (classes: string): Promise<string> => {
  const result = await postcss([tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }] })]).process('@tailwind utilities;', { from: undefined });
  return result.css.replace(/\s+/g, ' ');
};

describe('named ds colours (tailwind.config.cjs)', () => {
  it('cover every --ds-* colour token in index.css, and nothing else', () => {
    expect(COLOUR_TOKENS.length).toBeGreaterThan(50);
    expect(COLOUR_TOKENS.filter((n) => !(n in ds))).toEqual([]);
    expect(Object.keys(ds).filter((n) => !COLOUR_TOKENS.includes(n))).toEqual([]);
    for (const core of ['canvas', 'surface', 'surface-strong', 'raised', 'well', 'ink', 'muted', 'hairline', 'accent', 'on-accent', 'ring', 'danger']) expect(Object.keys(ds), core).toContain(core);
  });

  it('each is a colour function: the bare token without an opacity, color-mix() with one', () => {
    expect(ds.ink({})).toBe('var(--ds-ink)');
    expect(ds.ink({ opacityValue: '0.6' })).toBe('color-mix(in srgb, var(--ds-ink) calc(0.6 * 100%), transparent)');
  });

  it('a probe compiles: bg-ds-canvas reads the token, text-ds-ink/60 mixes 60 % of it with transparent', async () => {
    const css = await compile('bg-ds-canvas text-ds-ink/60 border-ds-hairline/50 fill-ds-ink');
    expect(css).toMatch(/\.bg-ds-canvas \{[^}]*background-color: color-mix\(in srgb, var\(--ds-canvas\) calc\(var\(--tw-bg-opacity, 1\) \* 100%\), transparent\)/);
    expect(css).toContain('.text-ds-ink\\/60 { color: color-mix(in srgb, var(--ds-ink) calc(0.6 * 100%), transparent) }');
    expect(css).toContain('.border-ds-hairline\\/50 { border-color: color-mix(in srgb, var(--ds-hairline) calc(0.5 * 100%), transparent) }');
    expect(css).toContain('.fill-ds-ink { fill: var(--ds-ink) }');
    // Never a slash on var() (what a `text-[var(--ds-ink)]/60` spelling would need).
    expect(css).not.toMatch(/var\(--ds-[\w-]+\)\s*\//);
  });

  it('is additive: the existing palettes and arbitrary token classes still compile as before', async () => {
    const css = await compile('bg-brand-yellow text-[var(--ds-ink)] bg-red-500');
    expect(css).toContain('.bg-brand-yellow');
    expect(css).toContain('.text-\\[var\\(--ds-ink\\)\\] { color: var(--ds-ink) }');
    expect(css).toContain('.bg-red-500');
  });
});
