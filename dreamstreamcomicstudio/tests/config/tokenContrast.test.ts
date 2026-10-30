// @vitest-environment node
/**
 * Text contrast of the `--ds-*` theme tokens (ui-tokens-contrast; P3-OVERFLOW `accent-text-contrast`,
 * `muted-text-contrast` and the axe `color-contrast` rows on the segmented radio labels).
 *
 * index.css is the single source of the studio colours, so this parses it (tests/config/cssTokens.ts,
 * shared with atlasSkin.test.ts) and, for each of the four contexts a page can be in — default light
 * (:root), default dark (.dark), Atlas light and Atlas dark (`[data-ds-skin="atlas"]`, with `.dark`) —
 * composes every surface a text token is actually used on (paper, sidebar, the three glass levels over
 * paper and sidebar, raised chips, wells, hover / active tints, the accent tints, a tint inside a well,
 * the status tone surfaces) and computes the WCAG 2.x contrast of every text token on each. Body /
 * label text must reach 4.5:1, with no known-gap list:
 *   ink, muted and the readable accent (--ds-accent-text) on every surface;
 *   on-accent text on the text-bearing accent fill (--ds-accent-fill and its hover), also at the 90 %
 *   opacity the secondary labels inside a button use;
 *   the status `-text` tokens on the page, glass, hover rows and their own tone surface;
 *   --ds-faint is measured too and is the one exempt token: a source scan holds every use of it to a
 *   placeholder or an aria-hidden glyph (the readable uses elsewhere are an exact, shrinking map).
 * Non-text (WCAG 1.4.11, which axe cannot check): the focus ring and accent state borders reach 3:1.
 * The test also proves the "accent contrast" block in index.css routes every accent text / text-
 * bearing fill utility found in the source tree to those tokens (so the 4.5:1 tokens are what the
 * page actually paints), that inside the Atlas skin the block paints exactly what the skin did (rule
 * by rule, by specificity), and that studioDesign's constants spell the readable tokens.
 *
 * (Atlas ink/muted on the skin's four base surfaces and every token's skin override stay in
 * atlasSkin.test.ts; this file adds the rest of the surfaces and the accent/status/faint tokens.)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import { escapeClass, listSourceFiles } from '../../scripts/design/atlas-skin-shim.mjs';
import {
  APP_ROOT as ROOT,
  type Rgba,
  indexCss as css,
  luminance,
  oklchToRgb,
  over,
  parseRules,
  ratio,
  compareSpecificity,
  resolveColor,
  rgbaString,
  specificity,
  spreadRingColor,
  tokenBlocks,
  tokensOf,
  topLevelSplit,
  withAlpha
} from './cssTokens';

const rules = parseRules(css);
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_DARK_MORE } = tokenBlocks(rules);

/**
 * The cascade an element sees, highest priority first. Atlas dark: the `.dark[data-ds-skin]` block
 * (0,2,0) beats the skin's light block, which comes after `.dark` in the file at equal specificity.
 * The two "more contrast" contexts are the skin under the OS "increase contrast" setting (Atlas wave
 * 5): the media query's blocks win over their base blocks of the same specificity (they come later),
 * and the dark base block (0,2,0) still beats the light high-contrast block (0,1,0).
 */
const CONTEXTS = {
  'default light': [ROOT_TOKENS],
  'default dark': [DARK_TOKENS, ROOT_TOKENS],
  'atlas light': [ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark': [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS],
  'atlas light more contrast': [ATLAS_LIGHT_MORE, ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark more contrast': [ATLAS_DARK_MORE, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS]
} as const;
type ContextName = keyof typeof CONTEXTS;
const isAtlas = (c: ContextName) => c.startsWith('atlas');

function lookup(name: string, ctx: ContextName): string {
  for (const block of CONTEXTS[ctx]) {
    const v = block.get(name);
    if (v !== undefined) return v;
  }
  throw new Error(`tokenContrast: ${name} is not defined for ${ctx}`);
}
/** Resolve a value (var() follows the context's cascade). */
const resolve = (value: string, ctx: ContextName) => resolveColor(value, (n) => lookup(n, ctx));
const token = (name: string, ctx: ContextName) => resolveColor(lookup(name, ctx), (n) => lookup(n, ctx), [name]);
const hexColor = (hex: string): Rgba => resolveColor(hex);

// ── The surfaces each text token is used on ────────────────────────────────────────────────────
const BRAND = '#D97757';
/** `bg-[#D97757]/15` chips and the `/20`–`/25` hover tints behind accent-text chips. Under the skin the shim maps these to accent-soft / hover / active. */
const LITERAL_TINTS = [0.15, 0.2, 0.25];

function surfaces(ctx: ContextName): Map<string, Rgba> {
  const t = (n: string) => token(n, ctx);
  const canvas = t('--ds-canvas');
  const sidebar = t('--ds-sidebar');
  const s = new Map<string, Rgba>([
    ['canvas', canvas],
    ['sidebar', sidebar],
    ['raised', over(t('--ds-raised'), canvas)],
    ['surface/canvas', over(t('--ds-surface'), canvas)],
    ['surface-soft/canvas', over(t('--ds-surface-soft'), canvas)],
    ['surface-strong/canvas', over(t('--ds-surface-strong'), canvas)],
    ['surface/sidebar', over(t('--ds-surface'), sidebar)],
    ['surface-soft/sidebar', over(t('--ds-surface-soft'), sidebar)]
  ]);
  // Rows, pills and tracks: one tint over the page, the sidebar or a glass level; on a raised overlay
  // (a menu, a sheet) the rows a menu highlights and a segmented track inside a sheet.
  for (const base of ['canvas', 'sidebar', 'surface/canvas', 'surface-soft/canvas', 'surface-strong/canvas', 'raised']) {
    const under = s.get(base)!;
    const tints = ['--ds-hover', '--ds-overlay-hover', '--ds-segment-track'];
    if (base !== 'raised') tints.push('--ds-well', '--ds-well-strong', '--ds-active', '--ds-accent-soft');
    for (const tint of tints) s.set(`${tint.slice(5)} on ${base}`, over(t(tint), under));
  }
  // A track or a hovered row inside a well (the segmented radio track that measured #e9e8e4).
  for (const base of ['canvas', 'surface/canvas', 'surface-strong/canvas']) {
    const well = over(t('--ds-well'), s.get(base)!);
    s.set(`well-strong on well on ${base}`, over(t('--ds-well-strong'), well));
    s.set(`hover on well on ${base}`, over(t('--ds-hover'), well));
  }
  return s;
}

/** Accent text also sits on the literal terracotta tints (outside the skin; inside it the shim makes them accent-soft / hover / active). */
function accentTextSurfaces(ctx: ContextName): Map<string, Rgba> {
  const s = surfaces(ctx);
  if (isAtlas(ctx)) return s;
  for (const base of ['canvas', 'surface/canvas', 'surface-strong/canvas']) {
    for (const a of LITERAL_TINTS) s.set(`accent ${Math.round(a * 100)}% on ${base}`, over(withAlpha(hexColor(BRAND), a), surfaces(ctx).get(base)!));
  }
  return s;
}

const TONES = ['success', 'warning', 'danger', 'info'] as const;
/** Status text: the page, the glass, hover rows, and its own TONE_SURFACE (10 % of the hue). */
function statusSurfaces(ctx: ContextName, tone: (typeof TONES)[number]): Map<string, Rgba> {
  const all = surfaces(ctx);
  const s = new Map<string, Rgba>();
  for (const k of ['canvas', 'sidebar', 'surface/canvas', 'surface-strong/canvas', 'well on canvas', 'hover on canvas', 'hover on surface/canvas']) s.set(k, all.get(k)!);
  // TONE_SURFACE's tint: the hue at 10 % (danger reads the danger mark, the brighter red in Atlas dark).
  const tint = withAlpha(token(tone === 'danger' ? '--ds-danger-mark' : `--ds-${tone}`, ctx), 0.1);
  for (const base of ['canvas', 'surface/canvas', 'surface-strong/canvas']) s.set(`${tone} tone surface on ${base}`, over(tint, all.get(base)!));
  return s;
}

/**
 * Atlas ink / muted on the skin's four base surfaces are asserted by atlasSkin.test.ts (c) (the skin's
 * own definition); this matrix adds every other surface and context rather than repeating them. The
 * skin's surfaces are opaque, so `surface/canvas` IS --ds-surface there.
 */
const ATLAS_BASE_PAIRS_ELSEWHERE = new Set(['canvas', 'surface/canvas', 'surface-soft/canvas', 'well on canvas']);

interface Pair {
  ctx: ContextName;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  /** Why this pair may stay below `min` — enforced elsewhere in this file, never a free pass. */
  exempt?: string;
}
/**
 * --ds-faint is the lowest-emphasis ink (≈ 2:1 light, ≈ 3:1 dark): far below 4.5:1 by design. It is
 * measured with the rest, and exempt ONLY where text contrast does not apply — a placeholder, or a
 * glyph hidden from assistive tech. The source scan below holds every use to that.
 */
const FAINT_EXEMPTION = 'placeholder or aria-hidden glyph only (see the --ds-faint scan)';
function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const ctx of Object.keys(CONTEXTS) as ContextName[]) {
    for (const fg of ['--ds-ink', '--ds-muted']) {
      for (const [bg, c] of surfaces(ctx)) {
        if (isAtlas(ctx) && !ctx.endsWith('more contrast') && ATLAS_BASE_PAIRS_ELSEWHERE.has(bg)) continue;
        out.push({ ctx, fg, bg, ratio: ratio(token(fg, ctx), c), min: 4.5 });
      }
    }
    for (const [bg, c] of surfaces(ctx)) out.push({ ctx, fg: '--ds-faint', bg, ratio: ratio(over(token('--ds-faint', ctx), c), c), min: 4.5, exempt: FAINT_EXEMPTION });
    for (const [bg, c] of accentTextSurfaces(ctx)) out.push({ ctx, fg: '--ds-accent-text', bg, ratio: ratio(token('--ds-accent-text', ctx), c), min: 4.5 });
    for (const fill of ['--ds-accent-fill', '--ds-accent-fill-hover']) {
      const bg = over(token(fill, ctx), token('--ds-canvas', ctx));
      const on = token('--ds-on-accent', ctx);
      out.push({ ctx, fg: '--ds-on-accent', bg: fill, ratio: ratio(on, bg), min: 4.5 });
      out.push({ ctx, fg: '--ds-on-accent at 90 %', bg: fill, ratio: ratio(over(withAlpha(on, 0.9), bg), bg), min: 4.5 });
    }
    for (const tone of TONES) {
      for (const [bg, c] of statusSurfaces(ctx, tone)) out.push({ ctx, fg: `--ds-${tone}-text`, bg, ratio: ratio(over(token(`--ds-${tone}-text`, ctx), c), c), min: 4.5 });
    }
  }
  return out;
}
const label = (p: Pair) => `${p.ctx}: ${p.fg} on ${p.bg}`;

describe('token contrast — every text token on every surface it is used on (WCAG 2.x)', () => {
  // Measured inside the tests (not at collection), so a missing token fails a named test.
  let cached: Pair[] | null = null;
  const measure = () => (cached ??= pairs());

  it('measures a real matrix in all four contexts', () => {
    const all = measure();
    for (const ctx of Object.keys(CONTEXTS)) expect(all.filter((p) => p.ctx === ctx).length, ctx).toBeGreaterThan(100);
  });

  it('body and label text reach 4.5:1 everywhere (light, dark, Atlas light, Atlas dark) — no exceptions', () => {
    const failing = measure().filter((p) => !p.exempt && p.ratio < p.min).map((p) => `${label(p)} = ${p.ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
  });

  it('--ds-faint is in the matrix too: below 4.5:1 everywhere, and the only exempt token', () => {
    const faint = measure().filter((p) => p.fg === '--ds-faint');
    for (const ctx of Object.keys(CONTEXTS)) expect(faint.filter((p) => p.ctx === ctx).length, ctx).toBeGreaterThan(30);
    expect(faint.every((p) => p.exempt === FAINT_EXEMPTION)).toBe(true);
    // If faint ever reaches 4.5:1 it is just another text token and the exemption must go.
    expect(Math.max(...faint.map((p) => p.ratio))).toBeLessThan(4.5);
    expect(measure().filter((p) => p.exempt && p.fg !== '--ds-faint').map(label)).toEqual([]);
  });

  it('clears the exact rows the device matrix reported', () => {
    // accent-text-contrast: #D97757 text on #fefefe (3.09) and on the #f7efe8 tint (2.74) → the readable accent.
    expect(ratio(token('--ds-accent-text', 'default light'), hexColor('#fefefe'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('--ds-accent-text', 'default light'), hexColor('#f7efe8'))).toBeGreaterThanOrEqual(4.5);
    // accent-text-contrast: white (3.12) and white at 90 % (2.81) on the #D97757 fill. The text-bearing fill
    // and its label are what the routed utilities paint now.
    expect(ratio(hexColor('#ffffff'), hexColor(BRAND))).toBeLessThan(4.5);
    const fill = token('--ds-accent-fill', 'default light');
    const on = token('--ds-on-accent', 'default light');
    expect(ratio(on, fill)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(over(withAlpha(on, 0.9), fill), fill)).toBeGreaterThanOrEqual(4.5);
    // muted-text-contrast / the NEW segmented-label rows (#6e6a60 on #f0e5df 4.36, on #e9e8e4 4.39). The
    // DEFAULT light token is what chat, settings, home and every sheet that portals to <body> outside the
    // [data-ds-skin] root paint (PageEditor, ShareSheet, Bottom/Side/PopSheet on the apex host), so it
    // must clear the exact rows itself — not only the skin's muted.
    const light = surfaces('default light');
    expect(ratio(hexColor('#6e6a60'), light.get('active on canvas')!), 'the old token really failed').toBeLessThan(4.5);
    for (const bg of ['active on canvas', 'accent-soft on sidebar', 'well-strong on well on canvas', 'active on sidebar', 'hover on well on canvas']) {
      expect(ratio(token('--ds-muted', 'default light'), light.get(bg)!), `default light ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const ctx of ['atlas light', 'atlas dark'] as const) {
      const s = surfaces(ctx);
      for (const bg of ['active on canvas', 'accent-soft on sidebar', 'well-strong on well on canvas']) expect(ratio(token('--ds-muted', ctx), s.get(bg)!), `${ctx} ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // The dark theme: the old muted (#a8a29a) and the brand accent as text both fall short on the dark glass.
    expect(ratio(hexColor('#a8a29a'), surfaces('default dark').get('active on surface-strong/canvas')!)).toBeLessThan(4.5);
    expect(ratio(token('--ds-muted', 'default dark'), surfaces('default dark').get('active on surface-strong/canvas')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the hue family and the calm look: small lightness moves, brand accent untouched', () => {
    expect(lookup('--ds-accent', 'default light')).toBe(BRAND);
    expect(lookup('--ds-accent', 'default dark')).toBe(BRAND);
    const hue = ({ r, g, b }: Rgba) => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const d = max - min;
      const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const brandHue = hue(hexColor(BRAND));
    for (const ctx of ['default light', 'default dark'] as const) {
      for (const n of ['--ds-accent-text', '--ds-accent-fill', '--ds-accent-fill-hover']) {
        expect(Math.abs(hue(token(n, ctx)) - brandHue), `${ctx} ${n} stays terracotta`).toBeLessThan(6);
      }
    }
    // The dark muted only lifts a little (still clearly secondary to the ink).
    const dm = luminance(token('--ds-muted', 'default dark'));
    expect(dm - luminance(hexColor('#a8a29a'))).toBeLessThan(0.1);
    expect(ratio(token('--ds-ink', 'default dark'), token('--ds-muted', 'default dark'))).toBeGreaterThan(1.5);
  });

  /**
   * The spec: give text its own token "rather than darkening the brand accent used for buttons". So a
   * fill that carries a label stays the brand terracotta and the LABEL adapts (--ds-on-accent, ink).
   * (The other option — a deeper fill under white — is a token swap the matrix above would measure
   * just the same; it would flip this test, on purpose.)
   */
  it('buttons keep the brand: the text-bearing fill is the brand terracotta and only its label adapts', () => {
    for (const ctx of ['default light', 'default dark'] as const) {
      expect(token('--ds-accent-fill', ctx), ctx).toEqual(hexColor(BRAND));
      // The hover stays a hair from the brand (same hue — above — and a small luminance step).
      expect(Math.abs(luminance(token('--ds-accent-fill-hover', ctx)) - luminance(hexColor(BRAND))), ctx).toBeLessThan(0.08);
      expect(ratio(token('--ds-on-accent', ctx), token('--ds-ink', 'default light')), `${ctx}: the label is the ink`).toBeLessThan(1.1);
    }
  });

  it('the helper is right (white/black 21, #767676 ≈ 4.54, oklch and color-mix)', () => {
    expect(ratio(hexColor('#ffffff'), hexColor('#000000'))).toBeCloseTo(21, 5);
    expect(ratio(hexColor('#ffffff'), hexColor('#767676'))).toBeCloseTo(4.54, 1);
    // axe measured (and truncates to two places) #6e6a60 on #e9e8e4 = 4.39 and #d97757 on #fefefe = 3.09.
    const axe = (n: number) => Math.floor(n * 100) / 100;
    expect(axe(ratio(hexColor('#6e6a60'), hexColor('#e9e8e4')))).toBe(4.39);
    expect(axe(ratio(hexColor('#d97757'), hexColor('#fefefe')))).toBe(3.09);
    // --ds-active over the light paper is exactly the #e9e8e4 axe reported.
    const e9 = surfaces('default light').get('active on canvas')!;
    [233, 232, 228].forEach((v, i) => expect(Math.abs([e9.r, e9.g, e9.b][i] - v)).toBeLessThanOrEqual(0.51));
    const white = oklchToRgb(1, 0, 0);
    expect([white.r, white.g, white.b].map(Math.round)).toEqual([255, 255, 255]);
    const mixed = resolve('color-mix(in srgb, #ffffff 60%, #000000)', 'default light');
    expect(Math.round(mixed.r)).toBe(153);
    expect(resolve('color-mix(in srgb, #D97757 10%, transparent)', 'default light').a).toBeCloseTo(0.1, 5);
  });
});

// ── The accent-contrast block routes the existing utilities to the readable tokens ──────────────
const SOURCE = listSourceFiles(ROOT)
  .filter((f: string) => /\.(tsx?|html)$/.test(f))
  .map((f: string) => readFileSync(f, 'utf8'))
  .join('\n');
const classTokens = (re: RegExp) => [...new Set([...SOURCE.matchAll(re)].map((m) => m[0]))].sort();

/** Every rule body whose selector list contains `sel` (exact selector item). */
const bodiesFor = (sel: string) => rules.filter((r) => topLevelSplit(r.selector).includes(sel)).map((r) => r.body);

/**
 * The remap rule's selector for a `[variants:]utility` class token (the variants the tree uses).
 * Tailwind appends variant utilities AFTER index.css, so a variant form's rule repeats the class
 * (`double`) to outrank the variant utility it overrides; compound fills outrank it by construction.
 */
function utilitySelector(cls: string, compound = '', double = false): string {
  const parts = cls.split(':');
  const util = parts.pop()!;
  let prefix = '';
  let suffix = '';
  for (const v of parts) {
    if (v === 'hover') suffix += ':hover';
    else if (v === 'group-hover') prefix += '.group:hover ';
    else if (v.startsWith('group-hover/')) prefix += `.${escapeClass(`group/${v.slice('group-hover/'.length)}`)}:hover `;
    else throw new Error(`tokenContrast: no selector mapping for the "${v}:" variant in "${cls}" — add a rule to index.css's accent contrast block and here`);
  }
  void util;
  const own = `.${escapeClass(cls)}`;
  return `${prefix}${own}${double && parts.length ? own : ''}${compound}${suffix}`;
}

/** `[variant:]*` prefixes: plain (`hover:`, `group-hover/icon:`) and bracketed (`[@media(pointer:coarse)]:`). */
const VARIANTS = String.raw`(?:(?:[\w/-]+|\[[^\]\s"'\u0060]*\]):)*`;
/** The accent colours a text / fill utility can spell: the two tokens and the two literal terracottas, any case. */
const ACCENT = String.raw`(?:var\(--ds-accent(?:-hover)?\)|#(?:D97757|c2643f))`;
/** Accent text utilities, with any opacity modifier (which the routing cannot honour — the test fails on one). */
const ACCENT_TEXT_UTILITY = new RegExp(String.raw`(?<![\w-])${VARIANTS}text-\[${ACCENT}\](?:\/[\w.[\]]+)?(?![\w[-])`, 'gi');
/** Accent background utilities, with their opacity modifier. */
const ACCENT_FILL_UTILITY = new RegExp(String.raw`(?<![\w-])${VARIANTS}bg-\[${ACCENT}\](?:\/(?:\d{1,3}|\[[\d.]+\]))?(?![\w[-])`, 'gi');
/** The opacity a `/NN` or `/[0.NN]` modifier applies (1 without one). */
const alphaOf = (cls: string): number => {
  const m = /\/(\[[\d.]+\]|\d{1,3})$/.exec(cls);
  if (!m) return 1;
  return m[1].startsWith('[') ? parseFloat(m[1].slice(1, -1)) : Number(m[1]) / 100;
};
/** A tint (≤ 35 %) is a surface that text sits on; anything denser is a fill. */
const isTint = (cls: string) => alphaOf(cls) <= 0.35;

const ATLAS_PREFIX = '[data-ds-skin="atlas"] ';
const unescapeCss = (s: string) => s.replace(/\\(.)/g, '$1');
const CLASS = /\.((?:\\.|[\w-])+)/g;
/** One complex selector: its ancestor part (as written) and its subject compound's classes and pseudo-classes. */
function parseItem(item: string): { ancestors: string; classes: string[]; pseudos: string[] } {
  const parts = item.trim().split(/\s+/);
  const subject = parts.pop()!;
  const classes = [...subject.matchAll(CLASS)].map((m) => unescapeCss(m[1]));
  const pseudos = [...subject.replace(CLASS, '').matchAll(/:[\w-]+(?:\([^)]*\))?/g)].map((m) => m[0]);
  return { ancestors: parts.join(' '), classes, pseudos };
}
const declarations = (body: string) =>
  new Map(body.split(';').flatMap((d) => {
    const m = /^\s*([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d);
    return m ? [[m[1], m[2]] as [string, string]] : [];
  }));
/** What a compound's own utility paints for `prop` (text-white, text-[X], bg-[X], bg-[X]/NN). */
function ownValue(prop: string, classes: string[]): string | null {
  for (const c of classes) {
    const util = c.split(':').pop()!;
    if (prop === 'color') {
      if (util === 'text-white') return '#ffffff';
      const m = /^text-\[(.+)\]$/.exec(util);
      if (m) return m[1];
    }
    if (prop === 'background-color') {
      const m = /^bg-\[(.+)\](?:\/(\d+))?$/.exec(util);
      if (m) return m[2] ? `color-mix(in srgb, ${m[1]} ${m[2]}%, transparent)` : m[1];
    }
  }
  return null;
}
/** The shim's convention for a utility with no skin rule: terracotta → the skin accent, white on an accent fill → on-accent. */
const skinOwn = (prop: string, own: string) => (prop === 'color' && own === '#ffffff' ? 'var(--ds-on-accent)' : own.replace(/#(?:D97757|c2643f)/gi, 'var(--ds-accent)'));

describe('token contrast — the accent utilities paint the readable tokens', () => {
  it('every accent TEXT utility in the tree is routed to --ds-accent-text', () => {
    const found = classTokens(ACCENT_TEXT_UTILITY);
    expect(found).toContain('text-[var(--ds-accent)]');
    expect(found).toContain('text-[#D97757]');
    expect(found).toContain('text-[#c2643f]'); // TranslationReview's overflow fit label (3.84:1 on the paper as a literal)
    // An opacity-modified accent text utility cannot be routed (and `/NN` on a var() colour is invalid CSS anyway).
    expect(found.filter((c) => /\]\//.test(c)), 'use ACCENT_TEXT (fade the element with opacity-* if it must)').toEqual([]);
    for (const cls of found) {
      expect(bodiesFor(utilitySelector(cls, '', true)), cls).toContain('color: var(--ds-accent-text);');
    }
  });

  it('the scanners see every spelling: any case, opacity modifiers and bracketed variants', () => {
    const scan = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[0]);
    expect(scan(ACCENT_TEXT_UTILITY, 'a text-[#d97757] b text-[#C2643F] c')).toEqual(['text-[#d97757]', 'text-[#C2643F]']);
    expect(scan(ACCENT_TEXT_UTILITY, '"text-[var(--ds-accent)]/80"')).toEqual(['text-[var(--ds-accent)]/80']);
    expect(scan(ACCENT_TEXT_UTILITY, ' [@media(pointer:coarse)]:text-[var(--ds-accent)] ')).toEqual(['[@media(pointer:coarse)]:text-[var(--ds-accent)]']);
    expect(() => utilitySelector('[@media(pointer:coarse)]:text-[var(--ds-accent)]')).toThrow(/no selector mapping/);
    expect(scan(ACCENT_FILL_UTILITY, 'bg-[#d97757]/[0.9] text-white')).toEqual(['bg-[#d97757]/[0.9]']);
    expect(scan(ACCENT_FILL_UTILITY, 'bg-[var(--ds-accent-soft)] bg-[var(--ds-accent-fill)]')).toEqual([]);
    // Tints are parsed numerically: ≤ 35 % is a surface, anything denser is a fill.
    for (const c of ['bg-[#D97757]/15', 'bg-[#D97757]/35', 'bg-[#D97757]/[0.12]', 'bg-[#D97757]/[.3]']) expect(isTint(c), c).toBe(true);
    for (const c of ['bg-[#D97757]', 'bg-[#D97757]/36', 'bg-[#D97757]/85', 'bg-[#D97757]/[0.5]', 'bg-[#D97757]/[0.9]', 'bg-[#D97757]/[1]']) expect(isTint(c), c).toBe(false);
  });

  /**
   * Fills: a solid accent that carries white / on-accent text is routed to the fill tokens; a tint
   * (≤ 35 %) is a surface (accent text and ink on it are in the matrix above); the rest are marks
   * that never carry text (a resize hairline, a toggle track, a draft dot). Stage B's Insights cost bars
   * (insights/OverviewTab.tsx) paint `bg-[var(--ds-accent)]`, whose remap applies only beside text.
   */
  const TEXT_BEARING: Record<string, 'fill' | 'hover'> = {
    'bg-[var(--ds-accent)]': 'fill',
    'bg-[#D97757]': 'fill',
    'bg-[#D97757]/85': 'fill',
    'hover:bg-[var(--ds-accent-hover)]': 'hover',
    'group-hover:bg-[var(--ds-accent-hover)]': 'hover'
  };
  const DECORATIVE: Record<string, string> = {
    'hover:bg-[var(--ds-accent)]': 'chat/AIChatPlatform.tsx: the pane resize handle',
    'peer-checked:bg-[#D97757]': 'comicstudio/immersive/ReaderSettingsSheet.tsx: a switch track',
    'bg-[#D97757]/70': 'i18n/LanguageSwitch.tsx, chat/ChatSettingsModal.tsx: a draft dot and a swatch bar'
  };

  it('every solid accent fill in the tree is either routed (when it carries text) or a documented mark', () => {
    const found = classTokens(ACCENT_FILL_UTILITY);
    expect(found).toContain('bg-[var(--ds-accent)]');
    const unclassified = found.filter((c) => !isTint(c) && !(c in TEXT_BEARING) && !(c in DECORATIVE));
    expect(unclassified, 'classify a new accent fill: TEXT_BEARING (gets a rule) or DECORATIVE (never carries text)').toEqual([]);
    for (const cls of Object.keys(DECORATIVE)) expect(found, `${cls} is still used (drop it from DECORATIVE when it is not)`).toContain(cls);
    for (const [cls, kind] of Object.entries(TEXT_BEARING)) {
      if (!found.includes(cls)) continue;
      const want = kind === 'fill' ? 'var(--ds-accent-fill)' : 'var(--ds-accent-fill-hover)';
      // The pairing with the white / on-accent text it carries, never when disabled (the component's own
      // disabled style wins): the fill token AND its label token, so the pair the matrix measures is
      // exactly what paints (and the fill / label choice stays a token swap).
      for (const text of ['.text-white', ...(cls.includes('#') || cls.startsWith('group-') ? [] : ['.text-\\[var\\(--ds-on-accent\\)\\]'])]) {
        const sel = utilitySelector(cls, text) + ':not(:disabled)';
        const bodies = bodiesFor(sel).map(declarations);
        expect(bodies.length, sel).toBe(1);
        expect(bodies[0].get('background-color'), sel).toBe(want);
        expect(bodies[0].get('color'), sel).toBe('var(--ds-on-accent)');
      }
    }
  });

  it('a bare brand fill with no text is left alone (decoration keeps the brand terracotta)', () => {
    expect(bodiesFor('.bg-\\[var\\(--ds-accent\\)\\]')).toEqual([]);
    expect(bodiesFor('.bg-\\[\\#D97757\\]')).toEqual([]);
  });

  /**
   * Inside the Atlas skin the block must change nothing the skin decides. Specificity, not source
   * order, decides who wins, so for every selector in the block and every property it sets, this
   * finds the skin-scoped rules that style the same element and property. Where the block's rule
   * wins, it must paint what the strongest of those would — or, with none, what the utility itself
   * paints under the skin (a literal terracotta → the skin accent, white on an accent fill → the
   * skin's on-accent: the shim's own convention). Compared as colours in Atlas light and dark.
   */
  it('inside the Atlas skin the block paints exactly what the skin and its shim paint (rule by rule, by specificity)', () => {
    const blockCss = css.slice(css.indexOf('/* ---- Accent contrast'), css.indexOf('Device & layout tokens'));
    const block = parseRules(blockCss).filter((r) => r.selector);
    expect(block.length).toBeGreaterThanOrEqual(3);
    const indexOf = (r: { selector: string; body: string }) => rules.findIndex((x) => x.selector === r.selector && x.body === r.body);
    const skinItems = rules.flatMap((r, idx) => topLevelSplit(r.selector).filter((i) => i.startsWith(ATLAS_PREFIX)).map((item) => ({ item, idx, decls: declarations(r.body) })));
    let blockWins = 0;
    const problems: string[] = [];
    for (const r of block) {
      const idx = indexOf(r);
      expect(idx, r.selector).toBeGreaterThanOrEqual(0);
      for (const item of topLevelSplit(r.selector)) {
        const me = parseItem(item);
        for (const [prop, value] of declarations(r.body)) {
          const rivals = skinItems
            .filter((c) => c.decls.has(prop))
            .map((c) => ({ ...c, parsed: parseItem(c.item.slice(ATLAS_PREFIX.length)) }))
            .filter((c) => c.parsed.ancestors === me.ancestors && c.parsed.classes.every((k) => me.classes.includes(k)) && c.parsed.pseudos.every((p) => me.pseudos.includes(p)));
          const beats = (a: { item: string; idx: number }, bItem: string, bIdx: number) => {
            const d = compareSpecificity(specificity(a.item), specificity(bItem));
            return d > 0 || (d === 0 && a.idx > bIdx);
          };
          if (rivals.some((c) => beats(c, item, idx))) continue; // the skin's own rule paints it
          blockWins += 1;
          const strongest = rivals.sort((a, b) => (beats(a, b.item, b.idx) ? -1 : 1))[0];
          const own = ownValue(prop, me.classes);
          const expected = strongest ? strongest.decls.get(prop)! : own === null ? null : skinOwn(prop, own);
          if (expected === null) {
            problems.push(`${item} { ${prop} } — cannot tell what the utility paints`);
            continue;
          }
          for (const ctx of ['atlas light', 'atlas dark'] as const) {
            const [got, want] = [resolve(value, ctx), resolve(expected, ctx)];
            const same = (['r', 'g', 'b', 'a'] as const).every((k) => Math.abs(got[k] * (k === 'a' ? 255 : 1) - want[k] * (k === 'a' ? 255 : 1)) < 1);
            if (!same) problems.push(`${ctx}: ${item} { ${prop}: ${value} } paints ${JSON.stringify(got)}, the skin paints ${expected} = ${JSON.stringify(want)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(blockWins, 'the check compared real winners').toBeGreaterThan(5);
    // The 85 % badge: the block makes it solid, so the skin section restores the shim's own 85 %.
    expect(bodiesFor('[data-ds-skin="atlas"] .bg-\\[\\#D97757\\]\\/85.text-white:not(:disabled)')).toEqual(bodiesFor('[data-ds-skin="atlas"] .bg-\\[\\#D97757\\]\\/85'));
  });

  it('the specificity counter is right', () => {
    expect(specificity('.a')).toEqual([0, 1, 0]);
    expect(specificity('[data-ds-skin="atlas"] .bg-\\[\\#D97757\\]\\/85')).toEqual([0, 2, 0]);
    expect(specificity('.bg-\\[\\#D97757\\]\\/85.text-white:not(:disabled)')).toEqual([0, 3, 0]);
    expect(specificity('.hover\\:text-\\[var\\(--ds-accent\\)\\].hover\\:text-\\[var\\(--ds-accent\\)\\]:hover')).toEqual([0, 3, 0]);
    expect(specificity(':where([data-ds-skin="atlas"]) :focus-visible')).toEqual([0, 1, 0]);
    expect(specificity('#x .y::selection')).toEqual([1, 1, 1]);
    expect(specificity('html[data-ds-skin="atlas"] :is(.a, #b)')).toEqual([1, 1, 1]);
  });
});

/**
 * Atlas wave 5's one status vocabulary (studioDesign STATUS_*): its text on its own surface, both
 * themes, both skins and under "increase contrast". The surfaces are the 6 % / 8 % tints, the active
 * well and the waiting page; error tints read the danger MARK (the brighter red in dark).
 */
describe('token contrast — the status vocabulary (healthy / active / waiting / attention / error)', () => {
  const STATES: Array<[string, string, (ctx: ContextName, under: Rgba) => Rgba]> = [
    ['healthy', '--ds-success-text', (ctx, under) => over(withAlpha(token('--ds-success', ctx), 0.06), under)],
    ['active', '--ds-ink', (ctx, under) => over(token('--ds-well', ctx), under)],
    ['waiting', '--ds-muted', (ctx) => token('--ds-canvas', ctx)],
    ['attention', '--ds-warning-text', (ctx, under) => over(withAlpha(token('--ds-warning', ctx), 0.08), under)],
    // The error surface's tint is a token (Atlas: destructive 6 % in light, the brighter mark at 8 % in dark).
    ['error', '--ds-danger-text', (ctx, under) => over(token('--ds-status-error-tint', ctx), under)]
  ];

  it('the studioDesign maps spell exactly these tokens and tints', () => {
    for (const [state, text] of STATES) expect(design.STATUS_INK[state as keyof typeof design.STATUS_INK]).toBe(`text-[var(${text})]`);
    expect(design.STATUS_SURFACE.error).toBe('border-[var(--ds-status-error-edge)] bg-[var(--ds-status-error-tint)]');
  });

  it('the error surface is Atlas’s: destructive at 35 % / 6 % in light, the brighter mark at 40 % / 8 % in dark', () => {
    const alpha = (name: string, ctx: ContextName) => Math.round(token(name, ctx).a * 100);
    for (const ctx of ['default light', 'default dark', 'atlas light', 'atlas light more contrast'] as const) {
      expect([alpha('--ds-status-error-edge', ctx), alpha('--ds-status-error-tint', ctx)], ctx).toEqual([35, 6]);
    }
    for (const ctx of ['atlas dark', 'atlas dark more contrast'] as const) {
      expect([alpha('--ds-status-error-edge', ctx), alpha('--ds-status-error-tint', ctx)], ctx).toEqual([40, 8]);
      // …of the danger MARK (destructive-foreground), not the deep fill red.
      const { r, g, b } = token('--ds-status-error-tint', ctx);
      const mark = token('--ds-danger-mark', ctx);
      expect([r, g, b].map(Math.round), ctx).toEqual([mark.r, mark.g, mark.b].map(Math.round));
    }
  });

  it('every status text is ≥ 4.5:1 on its own surface (over the page, a card and a raised overlay) in every context', () => {
    const failing: string[] = [];
    for (const ctx of Object.keys(CONTEXTS) as ContextName[]) {
      const s = surfaces(ctx);
      for (const base of ['canvas', 'surface/canvas', 'raised', 'surface-strong/canvas']) {
        for (const [state, text, surface] of STATES) {
          const bg = surface(ctx, s.get(base)!);
          const r = ratio(over(token(text, ctx), bg), bg);
          if (r < 4.5) failing.push(`${ctx}: ${state} (${text}) on ${base} = ${r.toFixed(2)}`);
        }
      }
    }
    expect(failing).toEqual([]);
  });

  it('the danger tone surface (TONE_SURFACE) on its mark tint keeps the readable danger text ≥ 4.5:1', () => {
    for (const ctx of Object.keys(CONTEXTS) as ContextName[]) {
      const s = surfaces(ctx);
      for (const base of ['canvas', 'surface/canvas', 'surface-strong/canvas']) {
        const bg = over(withAlpha(token('--ds-danger-mark', ctx), 0.1), s.get(base)!);
        expect(ratio(over(token('--ds-danger-text', ctx), bg), bg), `${ctx} ${base}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('token contrast — studioDesign spells the readable tokens', () => {
  it('accent text, the text-bearing fill and the primary button', () => {
    expect(design.ACCENT_TEXT).toBe('text-[var(--ds-accent-text)]');
    expect(design.ACCENT_FILL).toBe('bg-[var(--ds-accent-fill)]');
    expect(design.ACCENT_FILL_HOVER).toBe('hover:bg-[var(--ds-accent-fill-hover)]');
    expect(design.PRIMARY_BTN).toContain(design.ACCENT_FILL);
    expect(design.PRIMARY_BTN).toContain(design.ACCENT_FILL_HOVER);
    expect(design.PRIMARY_BTN).toContain(design.ON_ACCENT_TEXT);
    expect(design.PRIMARY_BTN).not.toContain(design.ACCENT_BG);
    // The brand fill stays for marks without text.
    expect(design.ACCENT_BG).toBe('bg-[var(--ds-accent)]');
  });

  it('the inline-style hex escape hatches equal the light tokens', () => {
    expect(design.ACCENT_HEX).toBe(lookup('--ds-accent', 'default light'));
    expect(hexColor(design.ACCENT_TEXT_HEX)).toEqual(token('--ds-accent-text', 'default light'));
    expect(hexColor(design.ACCENT_FILL_HEX)).toEqual(token('--ds-accent-fill', 'default light'));
    // Light-theme values only: the readable accent text is far too dark for the dark canvas.
    expect(ratio(hexColor(design.ACCENT_TEXT_HEX), token('--ds-canvas', 'default dark'))).toBeLessThan(4.5);
  });

  it('every text constant reads a token this matrix measures', () => {
    // --ds-canvas as TEXT appears only on an ink fill (INVERSE_SURFACE): the same pair as ink on canvas.
    const measured = new Set(['--ds-ink', '--ds-muted', '--ds-accent-text', '--ds-on-accent', '--ds-canvas', ...TONES.map((t) => `--ds-${t}-text`)]);
    const textTokens = (s: string) => [...s.matchAll(/(?<![\w-])text-\[var\((--ds-[\w-]+)\)\]/g)].map((m) => m[1]);
    for (const [name, value] of Object.entries(design)) {
      const values = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).filter((v): v is string => typeof v === 'string') : [];
      for (const v of values) for (const t of textTokens(v)) expect(measured.has(t), `${name} uses ${t}`).toBe(true);
    }
  });
});

// ── --ds-faint: only placeholders and glyphs hidden from assistive tech ─────────────────────────
type FaintUse = 'placeholder' | 'glyph' | 'readable';

/** The index just past the `>` that ends the JSX opening tag whose attributes start at `i` (-1 if none). */
function openingTagEnd(src: string, i: number): number {
  const stack: Array<'brace' | 'tmpl'> = [];
  for (; i < src.length; i++) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === 'tmpl') {
      if (ch === '\\') i += 1;
      else if (ch === '`') stack.pop();
      else if (ch === '$' && src[i + 1] === '{') {
        stack.push('brace');
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i += 1; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i += 1;
      continue;
    }
    if (ch === '`') stack.push('tmpl');
    else if (ch === '{') stack.push('brace');
    else if (ch === '}') stack.pop();
    else if (ch === '>' && stack.length === 0) return i + 1;
  }
  return -1;
}

/** Classify one `…text-[var(--ds-faint)]` occurrence at `at` in a TSX source. */
function classifyFaint(src: string, at: number, variants: string, lucide: Set<string>): FaintUse {
  if (variants.split(':').includes('placeholder')) return 'placeholder';
  for (let lt = src.lastIndexOf('<', at); lt >= 0; lt = src.lastIndexOf('<', lt - 1)) {
    const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(lt, lt + 80));
    if (!m) continue;
    const end = openingTagEnd(src, lt + m[0].length);
    if (end < at) continue; // a sibling / attribute-expression tag that closed before the class
    const tag = src.slice(lt, end);
    const selfClosing = /\/\s*>$/.test(tag);
    const labelled = /\s(?:aria-label|aria-labelledby|title)=/.test(tag);
    const hidden = /\saria-hidden(?:\s|=\{?(?:true|"true")\}?|\/?>)/.test(tag);
    // A lucide icon with no label renders aria-hidden="true" (lucide-react ≥ 0.4xx).
    if (selfClosing) return hidden || (lucide.has(m[1]) && !labelled) ? 'glyph' : 'readable';
    if (!hidden) return 'readable';
    // aria-hidden with children: a glyph only when no text is inside (just elements or `{identifier}`).
    const close = src.indexOf('</', end);
    const inner = src.slice(end, close < 0 ? end : close);
    const left = inner.replace(/<[A-Za-z][\s\S]*?\/>/g, '').replace(/<[A-Za-z][^>]*>/g, '').replace(/\{\s*[\w.]+\s*\}/g, '');
    return left.trim() ? 'readable' : 'glyph';
  }
  return 'readable';
}

const FAINT_UTILITY = /(?<![\w-])((?:[\w/-]+:)*)text-\[var\(--ds-faint\)\]/g;
function faintUses(src: string): FaintUse[] {
  const lucide = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const name of m[1].split(',')) {
      const local = name.trim().split(/\s+as\s+/).pop()!.trim();
      if (local) lucide.add(local);
    }
  }
  return [...src.matchAll(FAINT_UTILITY)].map((m) => classifyFaint(src, m.index!, m[1], lucide));
}

/**
 * Readable uses of --ds-faint (≈ 2:1) that are neither a placeholder nor hidden from assistive tech:
 * real text (hints, captions, counts, empty-cell dashes, "·" separators) and labelled or meaningful
 * glyphs. These files belong to other packages; each owner switches the use to --ds-muted (text), or
 * marks a purely decorative glyph aria-hidden (wave notes list every line). The map is exact, so it
 * fails on a NEW faint text use and when one is fixed (drop it here then).
 */
const FAINT_READABLE_USES: Record<string, number> = {
  'components/chat/ComposerSlashMenu.tsx': 1,
  'components/chat/MarkdownTable.tsx': 1,
  'components/chat/artifacts/AgentActivityCard.tsx': 1,
  'components/chat/artifacts/CalendarAgenda.tsx': 3,
  'components/chat/artifacts/CalendarEventDraft.tsx': 1,
  'components/chat/artifacts/DashboardCard.tsx': 2,
  'components/chat/artifacts/DataTableCard.tsx': 3,
  'components/chat/artifacts/EmailCompose.tsx': 1,
  'components/chat/artifacts/EmailTerminal.tsx': 6,
  'components/chat/artifacts/FlightResults.tsx': 4,
  'components/chat/artifacts/NewsDigest.tsx': 2,
  'components/chat/artifacts/PlacesResults.tsx': 2,
  'components/chat/artifacts/ResearchReport.tsx': 1,
  'components/chat/artifacts/games/BreakoutGame.tsx': 2,
  'components/chat/artifacts/kit/game/GameShell.tsx': 1,
  'components/comicstudio/timeline/TimelineClip.tsx': 1
};

describe('token contrast — --ds-faint only paints placeholders and glyphs hidden from assistive tech', () => {
  it('classifies the forms it meets', () => {
    const lucide = 'import { Search, Plug } from "lucide-react";\n';
    expect(faintUses('<input className="placeholder:text-[var(--ds-faint)]" />')).toEqual(['placeholder']);
    expect(faintUses(`${lucide}<Search className="h-3 w-3 text-[var(--ds-faint)]" />`)).toEqual(['glyph']);
    expect(faintUses(`${lucide}<Search className="text-[var(--ds-faint)]" aria-label="Find" />`)).toEqual(['readable']);
    expect(faintUses('<Custom className="text-[var(--ds-faint)]" aria-hidden />')).toEqual(['glyph']);
    expect(faintUses('<Custom className="text-[var(--ds-faint)]" />')).toEqual(['readable']);
    expect(faintUses('<div className="mb-3 text-[var(--ds-faint)]" aria-hidden>{icon}</div>')).toEqual(['glyph']);
    expect(faintUses("<span className=\"text-[var(--ds-faint)]\" aria-hidden>{kind === 'cover' ? 'No cover yet' : 'Empty'}</span>")).toEqual(['readable']);
    expect(faintUses('<span className="text-[var(--ds-faint)]" aria-hidden>\n  <Glyph size={4} />\n</span>')).toEqual(['glyph']);
    expect(faintUses('<p className="text-[11px] text-[var(--ds-faint)]">Hint</p>')).toEqual(['readable']);
    expect(faintUses("<b onClick={() => go(a > b)} className={`x ${on ? 'y' : 'text-[var(--ds-faint)]'}`}>·</b>")).toEqual(['readable']);
  });

  it('every text-[var(--ds-faint)] in the tree is a placeholder, an aria-hidden glyph, or a tracked readable use', () => {
    const readable: Record<string, number> = {};
    let placeholders = 0;
    let glyphs = 0;
    for (const file of listSourceFiles(ROOT).filter((f: string) => /\.tsx?$/.test(f))) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('--ds-faint')) continue;
      for (const use of faintUses(src)) {
        if (use === 'placeholder') placeholders += 1;
        else if (use === 'glyph') glyphs += 1;
        else {
          const rel = file.slice(ROOT.length).replace(/^\/+/, '');
          readable[rel] = (readable[rel] ?? 0) + 1;
        }
      }
    }
    expect(placeholders).toBeGreaterThan(5);
    expect(glyphs).toBeGreaterThan(5);
    expect(readable, 'a faint TEXT use: use --ds-muted (or aria-hidden for a purely decorative glyph)').toEqual(FAINT_READABLE_USES);
  });
});

// ── Non-text contrast (WCAG 1.4.11): the focus ring and accent state borders ────────────────────
/**
 * axe-core has no non-text-contrast rule, so the device harness cannot assert 1.4.11; this asserts it
 * on the tokens, against every backdrop a ring or a state border is drawn on.
 */
const NON_TEXT_BACKDROPS = ['canvas', 'sidebar', 'raised', 'surface/canvas', 'surface-soft/canvas', 'surface-strong/canvas', 'surface/sidebar', 'well on canvas', 'hover on canvas'];

/**
 * The brand terracotta stays the brand (the spec: never darken the brand accent), and on the LIGHT
 * paper it is a little under 3:1 (2.96 on the canvas, 2.79 on the sidebar, 2.65 on a hover row). It
 * is the decorative accent: a brand-coloured border accompanies
 * another cue (the accent-soft fill, an ink label, a check). A border that is the ONLY cue for a state
 * uses the readable accent, `border-[var(--ds-accent-text)]`, which clears 3:1 everywhere (below).
 */
const BRAND_BORDER_ON_LIGHT_PAPER = [
  'default light: --ds-accent on canvas',
  'default light: --ds-accent on sidebar',
  'default light: --ds-accent on well on canvas',
  'default light: --ds-accent on hover on canvas'
];

describe('token contrast — non-text: the focus ring and accent state borders reach 3:1 (WCAG 1.4.11)', () => {
  const measureNonText = (fg: string) =>
    (Object.keys(CONTEXTS) as ContextName[]).flatMap((ctx) => {
      const s = surfaces(ctx);
      return NON_TEXT_BACKDROPS.map((bg) => {
        const c = s.get(bg)!;
        return { name: `${ctx}: ${fg} on ${bg}`, ratio: ratio(over(token(fg, ctx), c), c) };
      });
    });

  it('the focus ring (--ds-ring) is ≥ 3:1 on every backdrop in all four contexts', () => {
    const ring = measureNonText('--ds-ring');
    expect(ring.length).toBe(Object.keys(CONTEXTS).length * NON_TEXT_BACKDROPS.length);
    expect(ring.filter((p) => p.ratio < 3).map((p) => `${p.name} = ${p.ratio.toFixed(2)}`)).toEqual([]);
    // The old translucent rings really failed (45 % / 50 % terracotta: 1.6 and 2.2:1).
    expect(ratio(over(resolveColor('rgba(217,119,87,0.45)'), token('--ds-canvas', 'default light')), token('--ds-canvas', 'default light'))).toBeLessThan(3);
    expect(ratio(over(resolveColor('rgba(217,119,87,0.50)'), token('--ds-canvas', 'default dark')), token('--ds-canvas', 'default dark'))).toBeLessThan(3);
  });

  it('the keyboard focus colour (--ds-focus) is ≥ 3:1 on every backdrop in every context (the ink under the skin)', () => {
    const focus = measureNonText('--ds-focus');
    expect(focus.filter((p) => p.ratio < 3).map((p) => `${p.name} = ${p.ratio.toFixed(2)}`)).toEqual([]);
    for (const ctx of ['atlas light', 'atlas dark'] as const) expect(token('--ds-focus', ctx), ctx).toEqual(token('--ds-ink', ctx));
  });

  /**
   * Atlas wave 5: "a field's edge has to clear 3:1 against the page" (--control-border; --border is a
   * hairline for cards and dividers). Under the skin the field edge and its hover clear 3:1 on every
   * backdrop, in both themes and under "increase contrast". Outside the skin the token defaults to
   * today's hairline, which nothing reads yet (FIELD in studioDesign is new).
   */
  it('field edges (--ds-control-border, -hover) are ≥ 3:1 on every backdrop under the skin', () => {
    const atlas = (Object.keys(CONTEXTS) as ContextName[]).filter(isAtlas);
    expect(atlas.length).toBe(4);
    for (const fg of ['--ds-control-border', '--ds-control-border-hover']) {
      const under = measureNonText(fg).filter((p) => atlas.some((c) => p.name.startsWith(`${c}:`)) && p.ratio < 3);
      expect(under.map((p) => `${p.name} = ${p.ratio.toFixed(2)}`), fg).toEqual([]);
    }
    // The card hairline really is below 3:1 — that is why fields get their own edge.
    expect(ratio(over(token('--ds-hairline', 'atlas light'), token('--ds-canvas', 'atlas light')), token('--ds-canvas', 'atlas light'))).toBeLessThan(3);
  });

  it('the danger mark (status dots, bars, toast edges) is ≥ 3:1 on the skin pages; in dark it is the brighter red', () => {
    const atlas = (Object.keys(CONTEXTS) as ContextName[]).filter(isAtlas);
    for (const ctx of atlas) {
      const s = surfaces(ctx);
      for (const bg of ['canvas', 'raised', 'surface/canvas', 'surface-strong/canvas']) {
        expect(ratio(token('--ds-danger-mark', ctx), s.get(bg)!), `${ctx} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
    // The deep dark danger (destructive fills) is under 3:1 as a mark on the dark page.
    expect(ratio(token('--ds-danger', 'atlas dark'), token('--ds-canvas', 'atlas dark'))).toBeLessThan(3);
    expect(luminance(token('--ds-danger-mark', 'atlas dark'))).toBeGreaterThan(luminance(token('--ds-danger', 'atlas dark')));
  });

  it('a state border in the readable accent is ≥ 3:1 everywhere', () => {
    expect(measureNonText('--ds-accent-text').filter((p) => p.ratio < 3).map((p) => p.name)).toEqual([]);
  });

  it('the brand accent as a border is ≥ 3:1 everywhere except the documented light-paper near-miss', () => {
    const brand = measureNonText('--ds-accent');
    const under = brand.filter((p) => p.ratio < 3);
    expect(under.map((p) => p.name).sort()).toEqual([...BRAND_BORDER_ON_LIGHT_PAPER].sort());
    for (const p of under) expect(p.ratio, p.name).toBeGreaterThanOrEqual(2.6); // 2.65 (hover row) … 2.96 (paper)
  });
});

// ── Outcomes the Atlas wave 5 port must hold (measured from the token cascade) ──────────────────
/** The token names a recipe's classes read, by utility prefix (e.g. `focus-within:border-`). */
const classToken = (recipe: string, prefix: string): string => {
  const re = new RegExp(String.raw`(?:^|\s)${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\[var\((--ds-[\w-]+)\)\]`);
  const m = re.exec(recipe);
  if (!m) throw new Error(`tokenContrast: no ${prefix}[var(--ds-…)] in "${recipe}"`);
  return m[1];
};
const ALL_CONTEXTS = Object.keys(CONTEXTS) as ContextName[];

/**
 * The selected segment of a segmented control (SEGMENTED_ACTIVE: --ds-segment-pill with the
 * --ds-shadow-segment ring, on a --ds-segment-track well) must stand off its track: its fill OR its
 * 1 px ring differs from the track by at least this much. The wave 5 regression painted the dark
 * skin's #1a1a1a raised pill on its #1a1a1a well (1.00:1, its only cue a black 8 % drop shadow).
 */
const MIN_PILL_STEP = 1.08;
/** Where segmented controls sit: the page, a card, a sheet / overlay. */
const TRACK_BASES = ['canvas', 'surface/canvas', 'surface-strong/canvas', 'raised'];
/**
 * Outside the skin the paint is today's and must stay so (the skin changes nothing outside its
 * scope): in the default dark theme a segmented track on the frosted glass levels lifts the
 * well to the raised pill's own grey. Pre-existing, and the same with or without this port.
 */
const PILL_STEP_OUTSIDE_THE_SKIN = ['default dark: on surface/canvas', 'default dark: on surface-strong/canvas'];

function pillStep(ctx: ContextName, base: Rgba, pillToken = '--ds-segment-pill', shadowToken = '--ds-shadow-segment', trackToken = '--ds-segment-track') {
  const track = over(token(trackToken, ctx), base);
  const fill = ratio(over(token(pillToken, ctx), track), track);
  const ringValue = spreadRingColor(lookup(shadowToken, ctx));
  const ring = ringValue ? ratio(over(resolve(ringValue, ctx), track), track) : 1;
  return { fill, ring, step: Math.max(fill, ring) };
}

describe('Atlas wave 5 outcomes — the selected segment stands off its track in every context', () => {
  it('SEGMENTED_ACTIVE is the pill tokens, and the track recipe reads the track token', () => {
    expect(classToken(design.SEGMENTED_ACTIVE, 'bg-')).toBe('--ds-segment-pill');
    expect(design.SEGMENTED_ACTIVE).toContain('shadow-[shadow:var(--ds-shadow-segment)]');
    expect(classToken(design.SEGMENTED_TRACK, 'bg-')).toBe('--ds-segment-track');
    expect(classToken(design.SEGMENTED_PILL, 'bg-')).toBe('--ds-segment-pill');
  });

  it(`the pill's fill or ring differs from the track by ≥ ${MIN_PILL_STEP}:1 on the page, a card and an overlay`, () => {
    const under: string[] = [];
    for (const ctx of ALL_CONTEXTS) {
      const s = surfaces(ctx);
      for (const base of TRACK_BASES) {
        const { fill, ring, step } = pillStep(ctx, s.get(base)!);
        if (step < MIN_PILL_STEP) under.push(`${ctx}: on ${base} (fill ${fill.toFixed(3)}, ring ${ring.toFixed(3)})`);
      }
    }
    expect(under.map((u) => u.replace(/ \(.*$/, ''))).toEqual(PILL_STEP_OUTSIDE_THE_SKIN);
    // Under the skin the ring carries it everywhere, including on an overlay of the pill's own grey.
    for (const ctx of ALL_CONTEXTS.filter(isAtlas)) {
      for (const base of TRACK_BASES) expect(pillStep(ctx, surfaces(ctx).get(base)!).ring, `${ctx} ${base}`).toBeGreaterThanOrEqual(1.12);
    }
  });

  it('the paint it replaced really vanished in Atlas dark (raised pill on the well-strong track, no ring)', () => {
    for (const ctx of ['atlas dark', 'atlas dark more contrast'] as const) {
      const s = surfaces(ctx);
      for (const base of TRACK_BASES) {
        const old = pillStep(ctx, s.get(base)!, '--ds-raised', '--ds-shadow-soft', '--ds-well-strong');
        expect(old.step, `${ctx} ${base}`).toBeLessThan(MIN_PILL_STEP);
      }
    }
  });

  it('outside the skin the live controls paint exactly what they did (the raised pill, its 8 % drop shadow, the well)', () => {
    expect(lookup('--ds-segment-pill', 'default light')).toBe('var(--ds-raised)');
    expect(lookup('--ds-shadow-segment', 'default light')).toBe('0 1px 2px rgba(0,0,0,0.08)');
    expect(lookup('--ds-segment-track', 'default light')).toBe('var(--ds-well-strong)');
    for (const ctx of ['default light', 'default dark'] as const) {
      for (const [a, b] of [['--ds-segment-pill', '--ds-raised'], ['--ds-segment-track', '--ds-well-strong']]) expect(token(a, ctx), `${ctx} ${a}`).toEqual(token(b, ctx));
    }
  });

  /** The live segmented controls (the reader's Scroll / Page / Spread switch reaches board/ui through ComicReaderView). */
  const LIVE_SEGMENTED = [
    'components/comicstudio/board/ui.tsx',
    'components/comicstudio/conversation/ui.tsx',
    'components/comicstudio/lettering/ProLetteringPanel.tsx',
    'components/comicstudio/lettering/LetteringToolbar.tsx',
    'components/comicstudio/insights/CostInsights.tsx',
    'components/comicstudio/share/ShareSheet.tsx'
  ];
  it('every live segmented control paints SEGMENTED_ACTIVE on the segment track, and the old pill is gone from the tree', () => {
    for (const rel of LIVE_SEGMENTED) {
      const src = readFileSync(`${ROOT}/${rel}`, 'utf8');
      expect(src, rel).toMatch(/\bSEGMENTED_ACTIVE\b/);
      expect(src, rel).toContain('bg-[var(--ds-segment-track)]');
    }
    // The selected-pill paint the six controls used (a raised fill with a literal drop shadow or the soft shadow).
    const OLD_PILL = /bg-\[var\(--ds-raised\)\] text-\[var\(--ds-ink\)\] shadow-\[(?:0_1px_2px_rgba\(0,0,0,0\.08\)|shadow:var\(--ds-shadow-soft\))\]/;
    expect(SOURCE).not.toMatch(OLD_PILL);
  });
});

/**
 * A highlighted row inside a menu, a select or a list (MENU_ITEM's hover, FOCUS_ITEM) sits on an
 * overlay: the raised step or the strong glass. Atlas wave 5 raised dark overlays to #1a1a1a and
 * moved their item highlight to white 8 %, because the #1f1f1f menu hover was a hair above it.
 */
const MIN_ROW_STEP = 1.1;
const OVERLAY_BASES = ['raised', 'surface-strong/canvas'];
describe('Atlas wave 5 outcomes — a highlighted row on an overlay is a visible step', () => {
  it('MENU_ITEM and FOCUS_ITEM highlight in --ds-overlay-hover (the hover tint by default, so nothing changes outside the skin)', () => {
    expect(classToken(design.MENU_ITEM, 'hover:bg-')).toBe('--ds-overlay-hover');
    expect(classToken(design.FOCUS_ITEM, 'focus-visible:bg-')).toBe('--ds-overlay-hover');
    for (const ctx of ['default light', 'default dark'] as const) expect(token('--ds-overlay-hover', ctx), ctx).toEqual(token('--ds-hover', ctx));
  });

  it(`hover on raised and on surface-strong is ≥ ${MIN_ROW_STEP}:1 in every context`, () => {
    const under: string[] = [];
    for (const ctx of ALL_CONTEXTS) {
      const s = surfaces(ctx);
      for (const base of OVERLAY_BASES) {
        const r = ratio(s.get(`overlay-hover on ${base}`)!, s.get(base)!);
        if (r < MIN_ROW_STEP) under.push(`${ctx}: on ${base} = ${r.toFixed(3)}`);
      }
    }
    expect(under).toEqual([]);
  });

  it('the plain --ds-hover it replaced in the menus is under that step on the dark overlay', () => {
    for (const ctx of ['atlas dark', 'atlas dark more contrast'] as const) {
      const s = surfaces(ctx);
      for (const base of OVERLAY_BASES) expect(ratio(s.get(`hover on ${base}`)!, s.get(base)!), `${ctx} ${base}`).toBeLessThan(MIN_ROW_STEP);
    }
  });
});

/**
 * The inverse surface (INVERSE_SURFACE: bg ink, text canvas). In Atlas dark index.css swaps the ink
 * and page tokens back inside it. A custom property that is not redeclared on the panel inherits as
 * the value COMPUTED at the skin root, so the accent-derived tokens (--ds-accent-fill, -fill-hover,
 * -text), declared there as var(--ds-accent), do not follow a swap made inside the panel. This
 * models exactly that: declarations on the panel resolve inside it; everything else is the root's
 * computed colour.
 */
const INVERSE_LIGHT = tokensOf(rules, (sel) => sel === '[data-ds-skin="atlas"] .ds-inverse-surface');
const INVERSE_DARK = tokensOf(rules, (sel) => sel === '.dark[data-ds-skin="atlas"] .ds-inverse-surface, .dark [data-ds-skin="atlas"] .ds-inverse-surface');
function insideInverse(ctx: ContextName, panelDecls?: Map<string, string>) {
  const decls = panelDecls ?? new Map([...INVERSE_LIGHT, ...(ctx.startsWith('atlas dark') ? INVERSE_DARK : [])]);
  const inner = (name: string): string => decls.get(name) ?? rgbaString(token(name, ctx));
  const t = (name: string) => resolveColor(inner(name), inner, [name]);
  const panel = t('--ds-ink'); // INVERSE_SURFACE: bg-[var(--ds-ink)] text-[var(--ds-canvas)]
  return { t, panel };
}
describe('Atlas wave 5 outcomes — inside the inverse surface', () => {
  const SKIN = ALL_CONTEXTS.filter(isAtlas);

  it('the panel text, a primary button (ON_ACCENT_TEXT on ACCENT_FILL and its hover) and keyboard focus stay readable, both themes', () => {
    expect(design.INVERSE_SURFACE).toContain('bg-[var(--ds-ink)]');
    expect(design.INVERSE_SURFACE).toContain('text-[var(--ds-canvas)]');
    expect(classToken(design.PRIMARY_BTN, 'bg-')).toBe('--ds-accent-fill');
    expect(classToken(design.PRIMARY_BTN, 'text-')).toBe('--ds-on-accent');
    const problems: string[] = [];
    for (const ctx of SKIN) {
      const { t, panel } = insideInverse(ctx);
      const check = (what: string, r: number, min: number) => r < min && problems.push(`${ctx}: ${what} = ${r.toFixed(2)}`);
      check('panel text', ratio(t('--ds-canvas'), panel), 4.5);
      for (const fill of ['--ds-accent-fill', '--ds-accent-fill-hover']) {
        const bg = over(t(fill), panel);
        check(`ON_ACCENT_TEXT on ${fill}`, ratio(over(t('--ds-on-accent'), bg), bg), 4.5);
      }
      check('focus outline on the panel', ratio(over(t('--ds-focus'), panel), panel), 3);
    }
    expect(problems).toEqual([]);
  });

  it('in dark it is a raised dark panel (not a white slab), and the model catches an accent swap the derived tokens ignore', () => {
    for (const ctx of ['atlas dark', 'atlas dark more contrast'] as const) {
      const { panel } = insideInverse(ctx);
      expect(luminance(panel), ctx).toBeLessThan(0.02);
      // Swapping --ds-accent / --ds-on-accent inside the panel (the first wave 5 port) left the
      // root-computed fill behind: the paper label on the paper fill.
      const swapped = insideInverse(ctx, new Map([...INVERSE_LIGHT, ...INVERSE_DARK, ['--ds-accent', '#161616'], ['--ds-on-accent', '#fafafa']]));
      expect(ratio(swapped.t('--ds-on-accent'), swapped.t('--ds-accent-fill')), ctx).toBeLessThan(1.1);
    }
    // Atlas swaps only --foreground / --background there: no accent token is redeclared on the panel.
    expect([...INVERSE_DARK.keys()].filter((k) => k.startsWith('--ds-accent') || k === '--ds-on-accent')).toEqual([]);
  });
});

/**
 * FIELD_GROUP (a search pill around an embedded field) must show focus as a change the eye can
 * find: its edge at rest vs its edge when focused differs by ≥ 3:1, and the 2 px focus ring it adds
 * outside the edge is ≥ 3:1 on whatever the group sits on — in all six contexts, including the OS
 * "increase contrast" ones (where the first port's ink-70 % focus edge on an ink-70 % resting edge
 * changed nothing). The tokens are read off the recipe itself.
 */
describe('Atlas wave 5 outcomes — FIELD_GROUP focus is a visible change in every context', () => {
  // Read inside the tests, so a recipe that stops spelling a token fails a named test.
  const recipe = () => ({
    rest: classToken(design.FIELD_GROUP, 'border-'),
    focused: classToken(design.FIELD_GROUP, 'focus-within:border-'),
    ring: classToken(design.FIELD_GROUP, 'focus-within:ring-'),
    fill: classToken(design.FIELD_GROUP, 'bg-')
  });

  it('the focused edge differs from the resting edge by ≥ 3:1 (the edge is painted over the group’s own fill)', () => {
    const { rest, focused, fill } = recipe();
    const under: string[] = [];
    for (const ctx of ALL_CONTEXTS) {
      const bg = token(fill, ctx);
      const r = ratio(over(token(focused, ctx), bg), over(token(rest, ctx), bg));
      if (r < 3) under.push(`${ctx}: ${focused} vs ${rest} = ${r.toFixed(2)}`);
    }
    expect(under).toEqual([]);
  });

  it('the 2 px focus ring outside the edge is ≥ 3:1 on the page, a card and an overlay', () => {
    expect(design.FIELD_GROUP).toContain('focus-within:ring-2');
    const { ring } = recipe();
    const under: string[] = [];
    for (const ctx of ALL_CONTEXTS) {
      const s = surfaces(ctx);
      for (const base of ['canvas', 'surface/canvas', 'surface-strong/canvas', 'raised']) {
        const r = ratio(over(token(ring, ctx), s.get(base)!), s.get(base)!);
        if (r < 3) under.push(`${ctx}: ${ring} on ${base} = ${r.toFixed(2)}`);
      }
    }
    expect(under).toEqual([]);
  });
});

describe('Atlas wave 5 outcomes — "increase contrast" strengthens both hairlines in both themes', () => {
  it('the hairline and the soft hairline are each stronger than without the setting (light and dark)', () => {
    for (const [base, more] of [['atlas light', 'atlas light more contrast'], ['atlas dark', 'atlas dark more contrast']] as const) {
      const canvas = token('--ds-canvas', base);
      for (const line of ['--ds-hairline', '--ds-hairline-soft']) {
        const step = (ctx: ContextName) => ratio(over(token(line, ctx), canvas), canvas);
        expect(step(more) - step(base), `${more} ${line}`).toBeGreaterThan(0.25);
      }
    }
  });
});
