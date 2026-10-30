// @vitest-environment node
//
// BrandKit and skins (plan §6, §4.4, W1.3): the skin data IS index.css's token blocks (re-read here, so a skin port
// that changes one without the other fails); the built-in kits derive from those tokens and clear 4.5:1 text
// contrast; `checkBrandKit` rejects low contrast, malformed colours, unknown fonts and URL logos, and never throws.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATLAS_BRAND,
  ATLAS_SKIN,
  BRAND_KITS,
  DREAMSTREAM_BRAND,
  DREAMSTREAM_SKIN,
  brandKitById,
  checkBrandKit,
  contrastRatio,
  flattenColor,
  parseCssColor,
  platformFont,
  skinToken,
  type BrandKit,
} from './index.js';

const INDEX_CSS = fileURLToPath(new URL('../../../../index.css', import.meta.url));

interface CssBlock {
  media: string | null;
  selector: string;
  body: string;
}

/** Top-level rule blocks of a stylesheet (and the rules directly inside an @media), comments removed. */
const cssBlocks = (source: string): CssBlock[] => {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssBlock[] = [];
  let depth = 0;
  let start = 0;
  let media: string | null = null;
  let selector: string | null = null;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      const head = css.slice(start, i).trim();
      if (depth === 0 && head.startsWith('@media')) media = head;
      else {
        selector = head.replace(/\s+/g, ' ');
        bodyStart = i + 1;
      }
      depth++;
      start = i + 1;
    } else if (c === '}') {
      depth--;
      if (selector !== null) {
        out.push({ media, selector, body: css.slice(bodyStart, i) });
        selector = null;
      }
      if (depth === 0) media = null;
      start = i + 1;
    }
  }
  return out;
};

const tokensOf = (body: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1]] = m[2].trim();
  return out;
};

const blocks = cssBlocks(readFileSync(INDEX_CSS, 'utf8'));
const merged = (pick: (b: CssBlock) => boolean): Record<string, string> =>
  blocks.filter(pick).reduce<Record<string, string>>((acc, b) => Object.assign(acc, tokensOf(b.body)), {});
const ATLAS_SEL = '[data-ds-skin="atlas"]';
const ATLAS_DARK_SEL = '.dark[data-ds-skin="atlas"], .dark [data-ds-skin="atlas"]';

describe('skins are index.css token blocks, as data', () => {
  it('dreamstream: every --ds-* of the top-level :root blocks (minus the reader-room tokens) and of .dark', () => {
    const light = merged((b) => !b.media && b.selector === ':root');
    for (const k of Object.keys(light)) if (k.indexOf('--ds-reader-') === 0) delete light[k];
    expect(Object.keys(light).length).toBeGreaterThan(60);
    expect(DREAMSTREAM_SKIN.light).toEqual(light);
    expect(DREAMSTREAM_SKIN.dark).toEqual(merged((b) => !b.media && b.selector === '.dark'));
  });

  it('atlas: the [data-ds-skin="atlas"] token block, its dark block and its prefers-contrast: more overrides', () => {
    const tokenBlocks = blocks.filter((b) => !b.media && b.selector === ATLAS_SEL && Object.keys(tokensOf(b.body)).length > 0);
    expect(tokenBlocks).toHaveLength(1);
    expect(ATLAS_SKIN.light).toEqual(tokensOf(tokenBlocks[0].body));
    expect(ATLAS_SKIN.dark).toEqual(merged((b) => !b.media && b.selector === ATLAS_DARK_SEL));
    const hc = (sel: string) => merged((b) => b.media !== null && /prefers-contrast:\s*more/.test(b.media) && b.selector === sel);
    expect(ATLAS_SKIN.highContrast).toEqual({ light: hc(ATLAS_SEL), dark: hc(ATLAS_DARK_SEL) });
  });

  it('a skin declares only --ds-* design tokens: no url(), no @import, no script', () => {
    for (const skin of [DREAMSTREAM_SKIN, ATLAS_SKIN]) {
      const all = [skin.light, skin.dark, skin.highContrast?.light ?? {}, skin.highContrast?.dark ?? {}];
      for (const map of all) {
        for (const k of Object.keys(map)) {
          expect(k).toMatch(/^--ds-[a-z0-9-]+$/);
          expect(map[k]).not.toMatch(/url\(|@import|<|expression\(/i);
        }
      }
    }
  });

  it('skinToken follows var() references and lets dark fall back to light', () => {
    expect(skinToken(ATLAS_SKIN, '--ds-accent-text')).toBe('#0a0a0a');
    expect(skinToken(DREAMSTREAM_SKIN, '--ds-accent-fill')).toBe('#D97757');
    expect(skinToken(DREAMSTREAM_SKIN, '--ds-font-sans', 'dark')).toBe('Inter, sans-serif');
    expect(skinToken(DREAMSTREAM_SKIN, '--ds-ink', 'dark')).toBe('#eeece8');
    expect(skinToken(DREAMSTREAM_SKIN, '--ds-nope')).toBeUndefined();
    expect(skinToken({ id: 'atlas', light: { '--a': 'var(--b)', '--b': 'var(--a)' }, dark: {} }, '--a')).toBeUndefined();
  });
});

describe('the built-in kits derive from the skins', () => {
  it('colours are the skin tokens (flattened onto the surface where translucent)', () => {
    expect(DREAMSTREAM_BRAND.colors).toEqual({
      canvas: '#faf9f5',
      surface: '#ffffff',
      ink: '#1a1915',
      muted: '#67635a',
      accent: '#d97757',
      accentText: '#a0472a',
      onAccent: '#1a1915',
      border: '#e6e6e6',
    });
    expect(ATLAS_BRAND.colors).toEqual({
      canvas: '#ffffff',
      surface: '#ffffff',
      ink: '#0a0a0a',
      muted: '#5c5c5c',
      accent: '#0a0a0a',
      accentText: '#0a0a0a',
      onAccent: '#ffffff',
      border: '#e6e6e6',
    });
  });

  it("fonts are the skin's --ds-font-sans / --ds-font-display families, from the registry", () => {
    const first = (stack: string | undefined) => (stack ?? '').split(',')[0].replace(/["']/g, '').trim();
    for (const kit of BRAND_KITS) {
      const skin = kit.skin === 'atlas' ? ATLAS_SKIN : DREAMSTREAM_SKIN;
      expect(platformFont(kit.fonts.body)?.family).toBe(first(skinToken(skin, '--ds-font-sans')));
      expect(platformFont(kit.fonts.display)?.family).toBe(first(skinToken(skin, '--ds-font-display')));
      expect(kit.docStyles.headingFont).toBe(kit.fonts.display);
      expect(kit.deckTheme.titleFont).toBe(kit.fonts.display);
    }
  });

  it('radii are the skin panel and control radii in px', () => {
    expect(DREAMSTREAM_BRAND.emailTheme).toMatchObject({ radius: 16, buttonRadius: 12, header: 'none' });
    expect(ATLAS_BRAND.emailTheme).toMatchObject({ radius: 12, buttonRadius: 10, header: 'none' });
  });

  it('every built-in kit passes checkBrandKit, and every text pair clears 4.5:1', () => {
    for (const kit of BRAND_KITS) {
      expect(checkBrandKit(kit)).toEqual([]);
      expect(contrastRatio(kit.colors.ink, kit.colors.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(kit.colors.onAccent, kit.colors.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('brandKitById finds a built-in kit and falls back to the default', () => {
    expect(brandKitById('atlas')).toBe(ATLAS_BRAND);
    expect(brandKitById('dreamstream')).toBe(DREAMSTREAM_BRAND);
    expect(brandKitById('nope')).toBe(DREAMSTREAM_BRAND);
    expect(brandKitById(undefined)).toBe(DREAMSTREAM_BRAND);
  });
});

describe('colour maths', () => {
  it('contrastRatio is the WCAG 2.x ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('#d97757', '#ffffff')).toBeCloseTo(3.1, 1); // the brand terracotta is a fill, never text
    expect(contrastRatio('nope', '#fff')).toBeNaN();
  });

  it('parses #rgb, #rrggbb, rgba() and the space/slash form; flattens alpha', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor('rgba(0,0,0,0.10)')).toEqual({ r: 0, g: 0, b: 0, a: 0.1 });
    expect(parseCssColor('rgb(0 0 0 / 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('oklch(0.55 0 0)')).toBeUndefined();
    expect(flattenColor('rgba(0,0,0,0.5)', '#ffffff')).toBe('#808080');
    expect(flattenColor('color-mix(in srgb, red 50%, blue)')).toBeUndefined();
  });
});

describe('checkBrandKit refuses an unusable kit', () => {
  const kit = (patch: (k: BrandKit) => void): BrandKit => {
    const k = JSON.parse(JSON.stringify(DREAMSTREAM_BRAND)) as BrandKit;
    patch(k);
    return k;
  };
  const codes = (k: unknown) => checkBrandKit(k).map((i) => `${i.path}:${i.code}`);

  it('low-contrast link text (the bare terracotta on white) fails', () => {
    expect(codes(kit((k) => (k.colors.accentText = '#d97757')))).toEqual(['colors.accentText:contrast']);
  });

  it('a white label on the terracotta fill fails; ink passes', () => {
    expect(codes(kit((k) => (k.colors.onAccent = '#ffffff')))).toEqual(['colors.onAccent:contrast']);
  });

  it('colours must be #RRGGBB (no CSS injection through a colour)', () => {
    expect(codes(kit((k) => (k.colors.ink = 'red;background:url(https://x.example/a.png)')))).toContain('colors.ink:color');
    expect(codes(kit((k) => (k.docStyles.linkColor = 'blue')))).toContain('docStyles.linkColor:color');
  });

  it('fonts must be registry ids, never CSS', () => {
    expect(codes(kit((k) => (k.fonts.body = "Arial'; x:url(y)")))).toEqual(['fonts.body:font']);
  });

  it('a logo is a data: image or an asset id, never a URL', () => {
    expect(codes(kit((k) => (k.logo = { kind: 'data', dataUri: 'https://evil.example/logo.png' })))).toEqual(['logo:logo']);
    expect(codes(kit((k) => (k.emailTheme.header = 'logo')))).toEqual(['emailTheme.header:logo']);
  });

  it('a footer is one plain line; radii are bounded; the id is an id', () => {
    expect(codes(kit((k) => (k.emailTheme.footer = 'a\nb')))).toEqual(['emailTheme.footer:text']);
    expect(codes(kit((k) => (k.emailTheme.radius = 999)))).toEqual(['emailTheme.radius:radius']);
    expect(codes(kit((k) => (k.id = '../x')))).toEqual(['id:id']);
  });

  it('a deck text colour under 4.5:1 on its background fails', () => {
    expect(codes(kit((k) => (k.deckTheme.theme = { preset: 'brand', background: '#ffffff', text: '#aaaaaa' })))).toEqual(['deckTheme.theme.text:contrast']);
  });

  it('never throws, whatever it is given', () => {
    for (const v of [null, undefined, 3, 'kit', [], {}, { colors: 7, fonts: [], emailTheme: 'x', docStyles: null, deckTheme: { theme: 1 } }]) {
      expect(() => checkBrandKit(v)).not.toThrow();
      expect(checkBrandKit(v).length).toBeGreaterThan(0);
    }
  });
});
