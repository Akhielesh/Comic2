// @vitest-environment node
/**
 * Text contrast of the `--ds-*` theme tokens (ui-tokens-contrast; P3-OVERFLOW `accent-text-contrast`,
 * `muted-text-contrast` and the axe `color-contrast` rows on the segmented radio labels).
 *
 * index.css is the single source of the studio colours, so this parses it and, for each of the four
 * contexts a page can be in — default light (:root), default dark (.dark), Atlas light and Atlas dark
 * (`[data-ds-skin="atlas"]`, with `.dark`) — composes every surface a text token is actually used on
 * (paper, sidebar, the three glass levels over paper and sidebar, raised chips, wells, hover / active
 * tints, the accent tints, a tint inside a well, the status tone surfaces) and computes the WCAG 2.x
 * contrast of every text token on each. Body / label text must reach 4.5:1:
 *   ink, muted and the readable accent (--ds-accent-text) on every surface;
 *   on-accent text on the text-bearing accent fill (--ds-accent-fill and its hover), also at the 90 %
 *   opacity the secondary labels inside a button use;
 *   the status `-text` tokens on the page, glass, hover rows and their own tone surface.
 * The test also proves the "accent contrast" block in index.css routes every accent text / text-
 * bearing fill utility found in the source tree to those tokens (so the 4.5:1 tokens are what the
 * page actually paints), and that studioDesign's constants spell the readable tokens.
 *
 * (The Atlas-only checks — every token has a skin override, ink/muted on the four base surfaces —
 * stay in atlasSkin.test.ts; this file adds the rest of the surfaces and the accent/status tokens.)
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
  specificity,
  tokenBlocks,
  topLevelSplit,
  withAlpha
} from './cssTokens';

const rules = parseRules(css);
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK } = tokenBlocks(rules);

/**
 * The cascade an element sees, highest priority first. Atlas dark: the `.dark[data-ds-skin]` block
 * (0,2,0) beats the skin's light block, which comes after `.dark` in the file at equal specificity.
 */
const CONTEXTS = {
  'default light': [ROOT_TOKENS],
  'default dark': [DARK_TOKENS, ROOT_TOKENS],
  'atlas light': [ATLAS_LIGHT, ROOT_TOKENS],
  'atlas dark': [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS]
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
  // Rows, pills and tracks: one tint over the page, the sidebar or a glass level.
  for (const base of ['canvas', 'sidebar', 'surface/canvas', 'surface-soft/canvas', 'surface-strong/canvas']) {
    const under = s.get(base)!;
    for (const tint of ['--ds-well', '--ds-well-strong', '--ds-hover', '--ds-active', '--ds-accent-soft']) s.set(`${tint.slice(5)} on ${base}`, over(t(tint), under));
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
  const tint = withAlpha(token(`--ds-${tone}`, ctx), 0.1);
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
}
function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const ctx of Object.keys(CONTEXTS) as ContextName[]) {
    for (const fg of ['--ds-ink', '--ds-muted']) {
      for (const [bg, c] of surfaces(ctx)) {
        if (isAtlas(ctx) && ATLAS_BASE_PAIRS_ELSEWHERE.has(bg)) continue;
        out.push({ ctx, fg, bg, ratio: ratio(token(fg, ctx), c), min: 4.5 });
      }
    }
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
    const failing = measure().filter((p) => p.ratio < p.min).map((p) => `${label(p)} = ${p.ratio.toFixed(2)}`);
    expect(failing).toEqual([]);
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
   * that never carry text (a resize hairline, a toggle track, a cost bar, a draft dot).
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
    'group-focus-visible:bg-[var(--ds-accent)]': 'comicstudio/mobile/shell/StudioLayout.tsx: the split resizer hairline',
    'group-hover:bg-[#D97757]/50': 'comicstudio/mobile/shell/StudioLayout.tsx: the split resizer hairline',
    'peer-checked:bg-[#D97757]': 'comicstudio/immersive/ReaderSettingsSheet.tsx: a switch track',
    'bg-[#D97757]/60': 'comicstudio/breakdown/BreakdownCard.tsx: a cost bar',
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
    const measured = new Set(['--ds-ink', '--ds-muted', '--ds-accent-text', '--ds-on-accent', ...TONES.map((t) => `--ds-${t}-text`)]);
    const textTokens = (s: string) => [...s.matchAll(/(?<![\w-])text-\[var\((--ds-[\w-]+)\)\]/g)].map((m) => m[1]);
    for (const [name, value] of Object.entries(design)) {
      const values = typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).filter((v): v is string => typeof v === 'string') : [];
      for (const v of values) for (const t of textTokens(v)) expect(measured.has(t), `${name} uses ${t}`).toBe(true);
    }
  });
});
