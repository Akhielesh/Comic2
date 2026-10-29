/**
 * Shared helpers for the tests that read index.css as data (atlasSkin.test.ts, tokenContrast.test.ts).
 * index.css is a plain file no component test loads, so these parse it:
 *   - a small rule parser (every `selector { declarations }` at any nesting depth, with its at-rules);
 *   - the four `--ds-*` token blocks (default light `:root`, default dark `.dark`, Atlas light and
 *     Atlas dark) and the cascade an element sees in each context;
 *   - a colour resolver (hex / rgb[a] / oklch / color-mix(in srgb) / var() through that cascade),
 *     alpha compositing and the WCAG 2.x contrast ratio;
 *   - a selector specificity counter (escaped class names, :not / :is / :where, pseudo-elements).
 * Not a test file (no `.test.` in the name), so vitest does not collect it; the typecheck covers it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const indexCss = readFileSync(path.join(APP_ROOT, 'index.css'), 'utf8');

// ── Rules ───────────────────────────────────────────────────────────────────────────────────────
export interface Rule {
  selector: string;
  body: string;
  /** The enclosing at-rules, outermost first (e.g. ['@media (prefers-reduced-motion: no-preference)']). */
  parents: string[];
}
export const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parseRules(source: string): Rule[] {
  const text = stripComments(source);
  const rules: Rule[] = [];
  const stack: string[] = [];
  let i = 0;
  let pending = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      const selector = norm(pending);
      pending = '';
      // Find the matching brace; if the body has nested blocks it is an at-rule / nesting container.
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(i + 1, j - 1);
      if (body.includes('{')) {
        stack.push(selector);
        i += 1; // descend
        continue;
      }
      rules.push({ selector, body: body.trim(), parents: [...stack] });
      i = j;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      pending = '';
      i += 1;
      continue;
    }
    pending += ch;
    i += 1;
  }
  return rules;
}

/** Merge the custom-property declarations of every rule whose selector matches. */
export function tokensOf(rules: Rule[], match: (selector: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (!match(r.selector)) continue;
    for (const decl of r.body.split(';')) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (m) out.set(m[1], norm(m[2]));
    }
  }
  return out;
}
export const dsOnly = (m: Map<string, string>) => new Map([...m].filter(([k]) => k.startsWith('--ds-')));

export const ATLAS_LIGHT_SELECTOR = '[data-ds-skin="atlas"]';
export const ATLAS_DARK_SELECTOR = '.dark[data-ds-skin="atlas"], .dark [data-ds-skin="atlas"]';

export interface TokenBlocks {
  ROOT_TOKENS: Map<string, string>;
  DARK_TOKENS: Map<string, string>;
  ATLAS_LIGHT: Map<string, string>;
  ATLAS_DARK: Map<string, string>;
}
export function tokenBlocks(rules: Rule[]): TokenBlocks {
  return {
    ROOT_TOKENS: dsOnly(tokensOf(rules, (s) => s === ':root')),
    DARK_TOKENS: dsOnly(tokensOf(rules, (s) => s === '.dark')),
    ATLAS_LIGHT: dsOnly(tokensOf(rules, (s) => s === ATLAS_LIGHT_SELECTOR)),
    ATLAS_DARK: dsOnly(tokensOf(rules, (s) => s === ATLAS_DARK_SELECTOR))
  };
}

// ── Colour ──────────────────────────────────────────────────────────────────────────────────────
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function oklchToRgb(l: number, c: number, hDeg: number): Rgba {
  const h = (hDeg * Math.PI) / 180;
  const A = c * Math.cos(h);
  const B = c * Math.sin(h);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
  ];
  const gam = (v: number) => clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  return { r: gam(lin[0]), g: gam(lin[1]), b: gam(lin[2]), a: 1 };
}

/** Split a function's (or a selector list's) items on top-level commas. */
export function topLevelSplit(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\') {
      cur += ch + (inner[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Resolve a CSS colour value. `lookup` resolves a custom property's raw value (throwing when it is
 * undefined); `seen` guards var() cycles. Without a lookup, var() throws (a literal is expected).
 */
export function resolveColor(value: string, lookup?: (name: string) => string, seen: string[] = []): Rgba {
  const v = value.trim();
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (ref) {
    if (!lookup) throw new Error(`cssTokens: "${v}" needs a token cascade`);
    if (seen.includes(ref[1])) throw new Error(`cssTokens: var() cycle ${[...seen, ref[1]].join(' → ')}`);
    return resolveColor(lookup(ref[1]), lookup, [...seen, ref[1]]);
  }
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v);
  if (ok) return oklchToRgb(+ok[1], +ok[2], +ok[3]);
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/.exec(v);
  if (mix) {
    const [first, second] = topLevelSplit(mix[1]);
    const pa = /^([\s\S]+?)\s+([\d.]+)%$/.exec(first);
    const pb = /^([\s\S]+?)\s+([\d.]+)%$/.exec(second);
    const ca = resolveColor(pa ? pa[1] : first, lookup, seen);
    const cb = resolveColor(pb ? pb[1] : second, lookup, seen);
    const wa = pa ? +pa[2] / 100 : pb ? 1 - +pb[2] / 100 : 0.5;
    const wb = 1 - wa;
    // CSS color-mix interpolates premultiplied components.
    const a = ca.a * wa + cb.a * wb;
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k: 'r' | 'g' | 'b') => (ca[k] * ca.a * wa + cb[k] * cb.a * wb) / a;
    return { r: ch('r'), g: ch('g'), b: ch('b'), a };
  }
  throw new Error(`cssTokens: cannot parse the colour "${v}"${seen.length ? ` (${seen.join(' → ')})` : ''}`);
}

/** Paint `top` over an opaque `under`. */
export const over = (top: Rgba, under: Rgba): Rgba => ({
  r: top.r * top.a + under.r * (1 - top.a),
  g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a),
  a: 1
});
export const withAlpha = (c: Rgba, a: number): Rgba => ({ ...c, a: c.a * a });
export const luminance = ({ r, g, b }: Rgba) => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** WCAG 2.x contrast ratio of two opaque colours. */
export const ratio = (fg: Rgba, bg: Rgba) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
/** The same for two opaque literal colours (hex / rgb / oklch). */
export const contrastRatio = (fg: string, bg: string): number => {
  const [a, b] = [resolveColor(fg), resolveColor(bg)];
  if (a.a !== 1 || b.a !== 1) throw new Error(`contrast check needs opaque colours, got "${fg}" / "${bg}"`);
  return ratio(a, b);
};

// ── Selectors ───────────────────────────────────────────────────────────────────────────────────
export type Specificity = [number, number, number];
const isIdentChar = (ch: string) => /[\w-]/.test(ch) || ch.charCodeAt(0) > 127;

/** Read an identifier (with CSS escapes) starting at `i`; returns the index after it. */
function skipIdent(sel: string, i: number): number {
  while (i < sel.length) {
    if (sel[i] === '\\') i += 2;
    else if (isIdentChar(sel[i])) i += 1;
    else break;
  }
  return i;
}
/** The index after the parenthesised group that opens at `i` (sel[i] === '('). */
function skipParens(sel: string, i: number): number {
  let depth = 0;
  for (; i < sel.length; i++) {
    if (sel[i] === '\\') {
      i += 1;
      continue;
    }
    if (sel[i] === '(') depth += 1;
    if (sel[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}
const addSpec = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const compareSpecificity = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Specificity of ONE complex selector (no top-level commas), per Selectors Level 4. */
export function specificity(selector: string): Specificity {
  const sel = selector.trim();
  let spec: Specificity = [0, 0, 0];
  let i = 0;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '.') {
      spec = addSpec(spec, [0, 1, 0]);
      i = skipIdent(sel, i + 1);
    } else if (ch === '#') {
      spec = addSpec(spec, [1, 0, 0]);
      i = skipIdent(sel, i + 1);
    } else if (ch === '[') {
      spec = addSpec(spec, [0, 1, 0]);
      while (i < sel.length && sel[i] !== ']') i += sel[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === ':' && sel[i + 1] === ':') {
      spec = addSpec(spec, [0, 0, 1]);
      i = skipIdent(sel, i + 2);
      if (sel[i] === '(') i = skipParens(sel, i);
    } else if (ch === ':') {
      const start = i + 1;
      i = skipIdent(sel, start);
      const name = sel.slice(start, i).toLowerCase();
      if (sel[i] === '(') {
        const end = skipParens(sel, i);
        const inner = sel.slice(i + 1, end - 1);
        i = end;
        if (name === 'where') continue;
        if (name === 'not' || name === 'is' || name === 'has' || name === 'matches') {
          const items = topLevelSplit(inner).map(specificity);
          spec = addSpec(spec, items.reduce((m, s) => (compareSpecificity(s, m) > 0 ? s : m), [0, 0, 0] as Specificity));
          continue;
        }
      }
      spec = addSpec(spec, [0, 1, 0]);
    } else if (/[A-Za-z]/.test(ch)) {
      spec = addSpec(spec, [0, 0, 1]); // a type selector
      i = skipIdent(sel, i);
    } else i += 1; // combinators, whitespace, `*`
  }
  return spec;
}
