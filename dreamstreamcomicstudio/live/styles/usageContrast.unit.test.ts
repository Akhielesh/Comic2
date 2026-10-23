// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Usage UI's small text (11.5–13.5 px) must reach WCAG AA, 4.5:1, on the surfaces it sits
 * on, in BOTH themes. The plain --green / --amber tokens don't on the light panel (3.8:1 and
 * 3.2:1), nor --live on the dark one (4.1:1): they're for icons and meter bars (3:1); text uses
 * them mixed toward the ink. This reads the real CSS, so a revert to `var(--green)` fails here.
 */
const css = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const tokensCss = css('./tokens.css');
const usageCss = css('./usage.css');

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
};

function themeTokens(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  const block = tokensCss.slice(tokensCss.indexOf('{', start) + 1, tokensCss.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
  return out;
}
const THEMES = { light: themeTokens("[data-theme='light']"), dark: themeTokens("[data-theme='dark']") };

/** The last `color:` usage.css gives exactly this selector (grouped selectors included). */
function colorOf(selector: string): string | null {
  let found: string | null = null;
  for (const m of usageCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    const c = /(?:^|;)\s*color:\s*([^;]+)/.exec(m[2]);
    if (c) found = c[1].trim();
  }
  return found;
}

/** var(--x) or color-mix(in srgb, var(--a) N%, var(--b)) → the colour in one theme. */
function resolve(value: string, t: Record<string, string>): RGB {
  const v = /^var\((--[\w-]+)\)$/.exec(value);
  if (v) return hex(t[v[1]]);
  const mix = /^color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*(\d+)%,\s*var\((--[\w-]+)\)\)$/.exec(value);
  if (mix) {
    const p = Number(mix[2]) / 100;
    const a = hex(t[mix[1]]);
    const b = hex(t[mix[3]]);
    return a.map((x, i) => x * p + b[i] * (1 - p)) as RGB;
  }
  throw new Error(`unsupported colour: ${value}`);
}

const luminance = ([r, g, b]: RGB) => {
  const f = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SMALL_TEXT = [
  '.usage-allow.is-warn .usage-pct', // the 80% state's percent
  '.usage-allow.is-full .usage-pct', // the 100% state's percent
  '.usage-empty', // "Nothing went through our servers this month…"
  '.usage-free .usage-group-title', // "FREE · ON YOUR DEVICES AND DIRECT LINKS"
  '.cost-line', // Quick start's path line (12 px)
  '.cost-line.servers',
  '.usage-card .faint', // "resets November 1", the card's foot note
];
const SURFACES = ['--panel', '--panel-2', '--bg'];

describe('Usage UI contrast (WCAG AA, small text)', () => {
  it('reads both themes’ tokens', () => {
    for (const t of Object.values(THEMES)) for (const k of ['--panel', '--text', '--green', '--amber', '--live']) expect(t[k]).toMatch(/^#/);
  });

  for (const sel of SMALL_TEXT) {
    it(`${sel}: at least 4.5:1 on the panel in light and dark`, () => {
      const value = colorOf(sel);
      expect(value, `${sel} sets a colour`).toBeTruthy();
      for (const [name, t] of Object.entries(THEMES)) {
        const fg = resolve(value!, t);
        for (const s of SURFACES) expect(contrast(fg, hex(t[s])), `${sel} on ${s} (${name})`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
