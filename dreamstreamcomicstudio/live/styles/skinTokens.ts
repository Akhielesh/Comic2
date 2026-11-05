/**
 * Shared by the Atlas-skin tests for Stream Studio (atlasSkinContrast / atlasSkinParity unit tests).
 * Stream Studio's CSS is plain files no component test loads, so these read them as data:
 *   - the token blocks of tokens.css (the cream studio) and atlas-skin.css (the skin), and the
 *     cascade <html> sees in each theme with the skin on;
 *   - every rule of every Stream Studio stylesheet (for the text-on-surface scan).
 * Colour maths (hex / rgb / oklch / color-mix / var(), compositing, the WCAG ratio) is the main
 * app's tests/config/cssTokens.ts, so the two apps' contrast tests can't disagree on arithmetic.
 * Not a test file (no `.test.` in the name): vitest doesn't collect it; the typecheck covers it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Rgba, type Rule, over, parseRules, resolveColor, tokensOf } from '../../tests/config/cssTokens';

export const STYLES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LIVE_DIR = path.resolve(STYLES_DIR, '..');
export const read = (abs: string) => readFileSync(abs, 'utf8');

export const tokensCss = read(path.join(STYLES_DIR, 'tokens.css'));
export const skinCss = read(path.join(STYLES_DIR, 'atlas-skin.css'));

export const SKIN_LIGHT = 'html[data-ds-skin="atlas"]';
export const SKIN_DARK = 'html[data-ds-skin="atlas"][data-theme="dark"]';

const top = (rules: Rule[]) => rules.filter((r) => r.parents.length === 0);
const tokenRules = top(parseRules(tokensCss));
const skinRules = top(parseRules(skinCss));

/** tokens.css: `:root, [data-theme='light']` and `[data-theme='dark']`. */
export const BASE_LIGHT = tokensOf(tokenRules, (s) => s.split(',').map((x) => x.trim()).includes("[data-theme='light']"));
export const BASE_DARK = tokensOf(tokenRules, (s) => s.trim() === "[data-theme='dark']");
/** atlas-skin.css: the two token blocks (top level, not the high-contrast overrides). */
export const ATLAS_SKIN_LIGHT = tokensOf(skinRules, (s) => s.trim() === SKIN_LIGHT);
export const ATLAS_SKIN_DARK = tokensOf(skinRules, (s) => s.trim() === SKIN_DARK);

export type ThemeName = 'light' | 'dark';

/**
 * What <html> sees with the skin on, highest priority first. Dark: the skin's dark block (0,2,1),
 * then its light block (0,1,1) — it also matches — then tokens.css's dark and light blocks.
 */
export const CASCADE: Record<ThemeName, Map<string, string>[]> = {
  light: [ATLAS_SKIN_LIGHT, BASE_LIGHT],
  dark: [ATLAS_SKIN_DARK, ATLAS_SKIN_LIGHT, BASE_DARK, BASE_LIGHT],
};

export function lookupIn(theme: ThemeName, extra?: Map<string, string>): (name: string) => string {
  const layers = extra ? [extra, ...CASCADE[theme]] : CASCADE[theme];
  return (name: string) => {
    for (const m of layers) {
      const v = m.get(name);
      if (v !== undefined) return v;
    }
    throw new Error(`skinTokens: ${name} is not defined in the ${theme} skin cascade`);
  };
}

/** A token (or any colour expression over tokens) resolved in a theme, with the skin on. */
export const color = (value: string, theme: ThemeName, extra?: Map<string, string>): Rgba =>
  resolveColor(value.startsWith('--') ? `var(${value})` : value, lookupIn(theme, extra));

/** Paint a possibly translucent colour over an opaque one. */
export const onto = (top: Rgba, under: Rgba): Rgba => (top.a >= 1 ? top : over(top, under));

/** Every Stream Studio stylesheet (live/styles/*.css and the account screens'), rules parsed. */
export function liveStylesheets(): { file: string; rules: Rule[] }[] {
  const files = [
    ...readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css')).map((f) => path.join(STYLES_DIR, f)),
    path.join(LIVE_DIR, 'views/account/account.css'),
  ];
  return files.map((f) => ({ file: path.relative(LIVE_DIR, f), rules: parseRules(read(f)) }));
}

/** One declaration's value in a rule body (the last one wins, as in CSS). */
export function declaration(body: string, prop: string): string | null {
  let found: string | null = null;
  for (const decl of body.split(';')) {
    const m = new RegExp(`^\\s*${prop}\\s*:\\s*([\\s\\S]+?)\\s*(!important)?\\s*$`).exec(decl);
    if (m) found = m[1].trim();
  }
  return found;
}
