// @vitest-environment node
/**
 * The Atlas skin's token layer (docs/design/atlas-skin.md, Phase D0). index.css is a plain file no
 * component test loads, so this parses it and checks:
 *   (a) every `--ds-*` token :root defines has an override in the Atlas light block and every one
 *       `.dark` defines has one in the Atlas dark block (reader tokens excepted), with the Atlas
 *       values for the core colours, fonts, radii and motion;
 *   (b) the NEW tokens' defaults reproduce today's look (panel 1rem, control .75rem, the old soft
 *       shadow, 200 ms, blur-md) and studioDesign's constants read them, so nothing changes outside
 *       the skin except the contrast fixes tokenContrast.test.ts measures (the ink label on an
 *       accent fill, the readable status text);
 *   (c) ink and muted text stay ≥ 4.5:1 on canvas, surface, surface-soft and well in both Atlas
 *       themes;
 *   plus the fonts, the theme switch (one view-transition cross-fade, Atlas wave 5) and the base rules.
 * (d), the transitional shim's coverage, lives in atlasSkinShim.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as design from '../../components/chat/studioDesign';
import { ATLAS_PRELOAD_FONTS, DS_NO_TRANSITIONS_CLASS, DS_THEME_TRANSITION_CLASS } from '../../services/dsSkin';
import { APP_ROOT, type Rule, contrastRatio, indexCss, parseRules, resolveColor, tokenBlocks, topLevelSplit } from './cssTokens';

const ROOT = APP_ROOT;
const css = indexCss;
const rules = parseRules(css);
const { ROOT_TOKENS, DARK_TOKENS, ATLAS_LIGHT, ATLAS_DARK, ATLAS_LIGHT_MORE, ATLAS_DARK_MORE } = tokenBlocks(rules);
const isReader = (name: string) => name.startsWith('--ds-reader-');
/** The semantic tokens Phase D0 added (brief item 1); everything else in :root pre-dates the skin. */
const NEW_TOKENS = [
  '--ds-on-accent', '--ds-accent-soft', '--ds-active',
  '--ds-success', '--ds-success-text', '--ds-warning', '--ds-warning-text', '--ds-danger', '--ds-danger-text', '--ds-info', '--ds-info-text',
  '--ds-ring', '--ds-font-sans', '--ds-font-display',
  '--ds-radius-panel', '--ds-radius-control', '--ds-radius-chip', '--ds-radius-sm',
  '--ds-shadow-soft', '--ds-shadow-panel', '--ds-shadow-lift',
  '--ds-motion-fast', '--ds-motion-medium', '--ds-motion-slow', '--ds-motion-panel', '--ds-motion-modal', '--ds-motion-theme',
  '--ds-ease', '--ds-ease-spring', '--ds-tooltip-delay', '--ds-surface-blur'
];
/**
 * The semantic tokens the wave 5 port added (Atlas 07935fcf → acd9fdfc, docs/design/atlas-skin.md
 * "Wave 5 port"): field edges, the focus colour, overlays, scrims, the dark danger mark, skeletons,
 * the segmented pill and the enter / exit motion vocabulary.
 */
const WAVE5_TOKENS = [
  '--ds-control-border', '--ds-control-border-hover', '--ds-focus',
  '--ds-overlay-edge', '--ds-shadow-overlay', '--ds-scrim', '--ds-danger-mark',
  '--ds-skeleton', '--ds-skeleton-glint', '--ds-segment-pill', '--ds-shadow-segment', '--ds-segment-track',
  '--ds-overlay-hover', '--ds-status-error-edge', '--ds-status-error-tint', '--ds-toast-edge',
  '--ds-ease-enter', '--ds-motion-enter', '--ds-motion-exit'
];
/** A token's colour in Atlas light / Atlas dark, var() followed through that block's cascade. */
const atlasColor = (name: string, theme: 'light' | 'dark') => {
  const blocks = theme === 'light' ? [ATLAS_LIGHT, ROOT_TOKENS] : [ATLAS_DARK, ATLAS_LIGHT, DARK_TOKENS, ROOT_TOKENS];
  const lookup = (n: string) => {
    for (const b of blocks) if (b.has(n)) return b.get(n)!;
    throw new Error(`atlasSkin: ${n} is undefined`);
  };
  return resolveColor(lookup(name), lookup, [name]);
};
// The WCAG helper lives in cssTokens.ts (shared with tokenContrast.test.ts); re-exported for old importers.
export { contrastRatio };

describe('Atlas skin — (a) every token has a skin override, with the Atlas values', () => {
  it('parses the four token blocks', () => {
    expect(ROOT_TOKENS.size).toBeGreaterThan(40);
    expect(DARK_TOKENS.size).toBeGreaterThan(20);
    expect(ATLAS_LIGHT.size).toBeGreaterThan(40);
    expect(ATLAS_DARK.size).toBeGreaterThan(20);
  });

  it('overrides every :root --ds-* token in the light block (reader tokens stay content)', () => {
    const missing = [...ROOT_TOKENS.keys()].filter((k) => !isReader(k) && !ATLAS_LIGHT.has(k));
    expect(missing).toEqual([]);
    expect([...ATLAS_LIGHT.keys()].filter(isReader)).toEqual([]);
  });

  it('overrides every .dark --ds-* token in the dark block', () => {
    const missing = [...DARK_TOKENS.keys()].filter((k) => !isReader(k) && !ATLAS_DARK.has(k));
    expect(missing).toEqual([]);
    expect([...ATLAS_DARK.keys()].filter(isReader)).toEqual([]);
  });

  it('writes the overrides against the attribute, so a skinned <div> on the apex works too', () => {
    const dark = rules.find((r) => r.selector.startsWith('.dark[data-ds-skin="atlas"]'));
    expect(dark?.selector).toBe('.dark[data-ds-skin="atlas"], .dark [data-ds-skin="atlas"]');
    expect(rules.some((r) => r.selector.startsWith('html[data-ds-skin') && /--ds-canvas\s*:/.test(r.body))).toBe(false);
  });

  it('maps the ten core colours to Atlas (light)', () => {
    expect(Object.fromEntries(ATLAS_LIGHT)).toMatchObject({
      '--ds-canvas': '#ffffff',
      '--ds-sidebar': '#fafafa',
      '--ds-surface': '#ffffff',
      '--ds-surface-soft': '#f4f4f4',
      '--ds-surface-strong': '#ffffff',
      '--ds-ink': '#0a0a0a',
      '--ds-muted': '#5c5c5c',
      '--ds-hairline': 'rgba(0,0,0,0.10)',
      '--ds-accent': '#0a0a0a',
      '--ds-on-accent': '#ffffff',
      '--ds-accent-soft': '#efefef',
      '--ds-well': '#fafafa',
      '--ds-hover': '#f2f2f2',
      '--ds-ring': 'oklch(0.55 0 0)'
    });
  });

  it('maps the ten core colours to Atlas (dark = the same system inverted)', () => {
    expect(Object.fromEntries(ATLAS_DARK)).toMatchObject({
      '--ds-canvas': '#0a0a0a',
      '--ds-sidebar': '#0d0d0d',
      '--ds-surface': '#111111',
      '--ds-surface-soft': '#1a1a1a',
      '--ds-surface-strong': '#1a1a1a', // wave 5: overlays sit a step above cards (#111111)
      '--ds-raised': '#1a1a1a',
      '--ds-ink': '#fafafa',
      '--ds-muted': '#a3a3a3',
      '--ds-hairline': 'rgba(255,255,255,0.12)',
      '--ds-accent': '#fafafa',
      '--ds-on-accent': '#0a0a0a',
      '--ds-accent-soft': '#1f1f1f',
      '--ds-hover': '#1f1f1f',
      '--ds-ring': '#8a8a8a'
    });
  });

  it('status hues are Atlas values and their text variants mix with the ink (≥ 4.5:1 rule)', () => {
    expect(ATLAS_LIGHT.get('--ds-success')).toBe('#16a34a');
    expect(ATLAS_LIGHT.get('--ds-warning')).toBe('#f59e0b');
    expect(ATLAS_LIGHT.get('--ds-danger')).toBe('#d4183d');
    expect(ATLAS_LIGHT.get('--ds-info')).toBe('#262626');
    expect(ATLAS_DARK.get('--ds-success')).toBe('oklch(0.5 0.15 142)');
    expect(ATLAS_DARK.get('--ds-danger')).toBe('oklch(0.396 0.141 25.723)');
    for (const block of [ATLAS_LIGHT, ATLAS_DARK]) {
      for (const tone of ['success', 'warning', 'danger', 'info']) {
        // Two deliberate deviations from Atlas's 60 % (tests/config/tokenContrast.test.ts measures every
        // status text on its surfaces): dark danger mixes 50 % — the deep dark red at 60 % is 4.36:1 on a
        // hover row and at 55 % 4.17:1 on a highlighted menu row (wave 8, the studio's danger menu items);
        // light warning mixes 57 % — at 60 % it is 4.35:1 on its own tint over the soft glass (wave 8).
        const pct = block === ATLAS_DARK && tone === 'danger' ? 50 : block === ATLAS_LIGHT && tone === 'warning' ? 57 : 60;
        expect(block.get(`--ds-${tone}-text`)).toBe(`color-mix(in srgb, var(--ds-${tone}) ${pct}%, var(--ds-ink))`);
      }
    }
  });

  it('fonts, radii, shadows, motion and blur follow Atlas', () => {
    expect(ATLAS_LIGHT.get('--ds-font-sans')).toBe('"IBM Plex Sans", sans-serif');
    expect(ATLAS_LIGHT.get('--ds-font-display')).toBe('"Space Grotesk", sans-serif');
    expect(ATLAS_LIGHT.get('--ds-radius-panel')).toBe('0.75rem');
    expect(ATLAS_LIGHT.get('--ds-radius-control')).toBe('0.625rem');
    expect(ATLAS_LIGHT.get('--ds-radius-chip')).toBe('0.625rem');
    expect(ATLAS_LIGHT.get('--ds-radius-sm')).toBe('0.25rem');
    expect(ATLAS_LIGHT.get('--ds-shadow-soft')).toBe('0 1px 2px 0 rgb(0 0 0 / 0.05)');
    expect(ATLAS_DARK.get('--ds-shadow-soft')).toBe('0 1px 2px 0 rgb(0 0 0 / 0.4)');
    expect(ATLAS_LIGHT.get('--ds-shadow-panel')).toBe('0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)');
    expect(ATLAS_DARK.get('--ds-shadow-panel')).toBe('0 16px 36px -16px rgb(0 0 0 / 0.7)');
    expect(ATLAS_DARK.get('--ds-shadow-lift')).toBe('0 22px 44px -18px rgb(0 0 0 / 0.8)');
    expect(ATLAS_LIGHT.get('--ds-motion-fast')).toBe('100ms');
    expect(ATLAS_LIGHT.get('--ds-motion-medium')).toBe('150ms');
    expect(ATLAS_LIGHT.get('--ds-motion-slow')).toBe('200ms');
    expect(ATLAS_LIGHT.get('--ds-motion-panel')).toBe('220ms');
    expect(ATLAS_LIGHT.get('--ds-motion-modal')).toBe('180ms');
    expect(ATLAS_LIGHT.get('--ds-motion-theme')).toBe('260ms');
    expect(ATLAS_LIGHT.get('--ds-ease')).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
    expect(ATLAS_LIGHT.get('--ds-tooltip-delay')).toBe('300ms');
    expect(ATLAS_LIGHT.get('--ds-surface-blur')).toBe('18px');
  });
});

describe('Atlas skin — (b) the defaults reproduce today’s look outside the skin (contrast fixes aside)', () => {
  it('defines every new semantic token in :root (brief item 1, and the wave 5 port)', () => {
    expect(NEW_TOKENS.filter((k) => !ROOT_TOKENS.has(k))).toEqual([]);
    expect(WAVE5_TOKENS.filter((k) => !ROOT_TOKENS.has(k))).toEqual([]);
  });

  it('new tokens default to the classes the constants used to spell out', () => {
    expect(ROOT_TOKENS.get('--ds-radius-panel')).toBe('1rem'); // rounded-2xl
    expect(ROOT_TOKENS.get('--ds-radius-control')).toBe('0.75rem'); // rounded-xl
    expect(ROOT_TOKENS.get('--ds-radius-chip')).toBe('9999px'); // rounded-full
    expect(ROOT_TOKENS.get('--ds-shadow-soft')).toBe('0 1px 2px rgba(0,0,0,0.04), 0 8px 24px var(--ds-hairline)');
    expect(ROOT_TOKENS.get('--ds-motion-medium')).toBe('200ms'); // duration-200
    expect(ROOT_TOKENS.get('--ds-ease')).toBe('cubic-bezier(0.4, 0, 0.2, 1)'); // tailwind's default curve
    expect(ROOT_TOKENS.get('--ds-surface-blur')).toBe('12px'); // backdrop-blur-md
    expect(ROOT_TOKENS.get('--ds-motion-theme')).toBe('0ms'); // no cross-fade outside a skin
    // The one deliberate change: the label on a solid accent fill is ink (5.6:1 on the brand
    // terracotta; the old text-white measured 3.1:1). tests/config/tokenContrast.test.ts.
    expect(ROOT_TOKENS.get('--ds-on-accent')).toBe('#1a1915');
    expect(ROOT_TOKENS.get('--ds-accent-soft')).toBe('rgba(217,119,87,0.10)'); // bg-[#D97757]/10
    expect(ROOT_TOKENS.get('--ds-font-sans')).toBe('Inter, sans-serif'); // font-sans
    expect(ROOT_TOKENS.get('--ds-font-display')).toBe('Inter, sans-serif'); // headings inherit
    // The pre-existing tokens are untouched.
    expect(ROOT_TOKENS.get('--ds-canvas')).toBe('#FAF9F5');
    expect(ROOT_TOKENS.get('--ds-accent')).toBe('#D97757');
    expect(DARK_TOKENS.get('--ds-canvas')).toBe('#262624');
  });

  it('every .dark token exists in :root, and a NEW token is only redefined in .dark when its dark value differs', () => {
    for (const k of DARK_TOKENS.keys()) expect(ROOT_TOKENS.get(k), `${k} exists in :root`).toBeDefined();
    // (--ds-accent is pre-existing and theme-invariant by design; the new tokens must not add noise.)
    for (const [k, v] of DARK_TOKENS) {
      if (!NEW_TOKENS.includes(k) && !WAVE5_TOKENS.includes(k)) continue;
      expect(v, `${k} differs in .dark`).not.toBe(ROOT_TOKENS.get(k));
    }
  });

  it('studioDesign reads the tokens (same look by default, skinnable)', () => {
    expect(design.RADIUS_PANEL).toBe('rounded-[var(--ds-radius-panel)]');
    expect(design.RADIUS_CONTROL).toBe('rounded-[var(--ds-radius-control)]');
    expect(design.RADIUS_PILL).toBe('rounded-[var(--ds-radius-chip)]');
    expect(design.SHADOW_SOFT).toBe('shadow-[shadow:var(--ds-shadow-soft)]');
    expect(design.TRANSITION).toBe('transition-all duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]');
    expect(design.GLASS).toContain('backdrop-blur-[var(--ds-surface-blur)]');
    expect(design.GLASS_STRONG).toContain('backdrop-blur-[var(--ds-surface-blur)]');
    expect(design.ACCENT_SOFT_BG).toBe('bg-[var(--ds-accent-soft)]');
    expect(design.ON_ACCENT_TEXT).toBe('text-[var(--ds-on-accent)]');
    expect(design.PRIMARY_BTN).toContain(design.ON_ACCENT_TEXT);
    expect(design.PRIMARY_BTN).not.toContain('text-white');
    expect(design.HEADING).toContain(design.FONT_DISPLAY);
    expect(design.PRESS).toBe('ds-press');
    for (const tone of ['success', 'warning', 'danger', 'info'] as const) {
      expect(design.TONE_TEXT[tone]).toBe(`text-[var(--ds-${tone}-text)]`);
      expect(design.TONE_CHIP[tone]).toBe(`${design.TONE_SURFACE[tone]} ${design.TONE_TEXT[tone]}`);
      // Danger marks read the danger mark (wave 5): = --ds-danger outside the skin and in Atlas light.
      expect(design.TONE_FILL[tone]).toBe(tone === 'danger' ? 'bg-[var(--ds-danger-mark)]' : `bg-[var(--ds-${tone})]`);
    }
    // No literal accent left in the constants (ACCENT_HEX is the documented inline-style escape hatch).
    for (const [name, value] of Object.entries(design)) {
      if (typeof value !== 'string' || name.endsWith('_HEX')) continue;
      expect(value, name).not.toContain('#D97757');
    }
  });

  it('TRANSITION keeps `transition-all`: consumers outside the skin animate position with it', () => {
    // components/ApiConfiguration.tsx slides the provider governance switch knob with
    // `${TRANSITION} left-[18px] / left-0.5`; an explicit property list (colour, shadow, opacity,
    // transform) would make it snap on the Settings page, which is outside the skin's scope.
    expect(design.TRANSITION).toMatch(/^transition-all /);
    expect(design.TRANSITION).not.toMatch(/transition-\[/);
    const apiConfig = readFileSync(path.join(ROOT, 'components/ApiConfiguration.tsx'), 'utf8');
    expect(apiConfig).toMatch(/\$\{TRANSITION\} \$\{enabled \? 'left-\[18px\]' : 'left-0\.5'\}/);
    // Outside the skin the token defaults make this exactly the old `transition-all duration-200`.
    expect(ROOT_TOKENS.get('--ds-motion-medium')).toBe('200ms');
    expect(ROOT_TOKENS.get('--ds-ease')).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
  });

});

describe('Atlas skin — wave 5 tokens (Atlas acd9fdfc)', () => {
  it('dark overlays sit a step above cards: popover and raised surfaces are #1a1a1a (cards stay #111111)', () => {
    expect(ATLAS_DARK.get('--ds-surface-strong')).toBe('#1a1a1a');
    expect(ATLAS_DARK.get('--ds-raised')).toBe('#1a1a1a');
    expect(ATLAS_DARK.get('--ds-surface')).toBe('#111111');
  });

  it('fields get their own edge (3:1 against the page): ink at 45 %, 60 % on hover', () => {
    expect(ATLAS_LIGHT.get('--ds-control-border')).toBe('color-mix(in srgb, var(--ds-ink) 45%, transparent)');
    expect(ATLAS_LIGHT.get('--ds-control-border-hover')).toBe('color-mix(in srgb, var(--ds-ink) 60%, transparent)');
    // Written against the ink, so the dark skin needs no second copy.
    expect(ATLAS_DARK.has('--ds-control-border')).toBe(false);
  });

  it('keyboard focus is the solid ink (the focus colour), the ring token stays Atlas --ring', () => {
    expect(ATLAS_LIGHT.get('--ds-focus')).toBe('var(--ds-ink)');
    expect(ATLAS_LIGHT.get('--ds-ring')).toBe('oklch(0.55 0 0)');
  });

  it('overlays: a lighter edge and a deeper shadow with a top highlight in dark; the scrim dims without blur', () => {
    expect(ATLAS_LIGHT.get('--ds-overlay-edge')).toBe('rgba(0,0,0,0.08)');
    expect(ATLAS_LIGHT.get('--ds-shadow-overlay')).toBe('0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)');
    expect(ATLAS_DARK.get('--ds-overlay-edge')).toBe('rgba(255,255,255,0.14)');
    expect(ATLAS_DARK.get('--ds-shadow-overlay')).toBe('inset 0 1px 0 0 rgb(255 255 255 / 0.06), 0 18px 40px -12px rgb(0 0 0 / 0.75)');
    expect(ATLAS_LIGHT.get('--ds-scrim')).toBe('rgba(0,0,0,0.40)');
    expect(ATLAS_DARK.get('--ds-scrim')).toBe('rgba(0,0,0,0.60)');
  });

  it('the danger mark (dots, bars, status edges) is the brighter Atlas red in dark, the danger hue in light', () => {
    expect(ATLAS_LIGHT.get('--ds-danger-mark')).toBe('var(--ds-danger)');
    expect(ATLAS_DARK.get('--ds-danger-mark')).toBe('oklch(0.637 0.237 25.331)');
  });

  it('skeletons: the muted block with a page-colour glint in light, lifted with ink in dark — translucent in both', () => {
    // .studio-shimmer is an absolute overlay over a page's plan wireframe (a queued page card), so the
    // block must be translucent: ink at 4.5 % paints Atlas's --muted (#f4f4f4) over the white card
    // without hiding what is under it (an opaque #f4f4f4 blanked the queued page's shot list).
    expect(ATLAS_LIGHT.get('--ds-skeleton')).toBe('color-mix(in srgb, var(--ds-ink) 4.5%, transparent)');
    // Measured: the token, painted over the skin's card, is Atlas's --muted (#f4f4f4) to the unit; and it is translucent.
    const block = atlasColor('--ds-skeleton', 'light');
    const card = atlasColor('--ds-surface', 'light');
    expect(block.a).toBeLessThan(0.1);
    const painted = (['r', 'g', 'b'] as const).map((k) => block[k] * block.a + card[k] * (1 - block.a));
    for (const v of painted) expect(Math.abs(v - 0xf4)).toBeLessThan(1);
    expect(ATLAS_LIGHT.get('--ds-skeleton-glint')).toBe('color-mix(in srgb, var(--ds-canvas) 55%, transparent)');
    expect(ATLAS_DARK.get('--ds-skeleton')).toBe('color-mix(in srgb, var(--ds-ink) 9%, transparent)');
    expect(ATLAS_DARK.get('--ds-skeleton-glint')).toBe('color-mix(in srgb, var(--ds-ink) 7%, transparent)');
  });

  it('the segmented pill: paper with a hairline ring in light, the accent step ringed in white 8 % in dark, on Atlas’s half-strength track', () => {
    expect(ATLAS_LIGHT.get('--ds-segment-pill')).toBe('#ffffff');
    expect(ATLAS_LIGHT.get('--ds-shadow-segment')).toBe('0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.06)');
    expect(ATLAS_DARK.get('--ds-segment-pill')).toBe('#1f1f1f');
    expect(ATLAS_DARK.get('--ds-shadow-segment')).toBe('inset 0 1px 0 rgb(255 255 255 / 0.06), 0 0 0 1px rgb(255 255 255 / 0.08)');
    // PanelTabs: bg-muted/60, dark:bg-muted/50 (tokenContrast.test.ts measures the pill against it).
    expect(ATLAS_LIGHT.get('--ds-segment-track')).toBe('color-mix(in srgb, var(--ds-well-strong) 60%, transparent)');
    expect(ATLAS_DARK.get('--ds-segment-track')).toBe('color-mix(in srgb, var(--ds-well-strong) 50%, transparent)');
  });

  it('overlay rows highlight as Atlas menu items do: the accent in light, white 8 % in dark', () => {
    expect(ATLAS_LIGHT.get('--ds-overlay-hover')).toBe('var(--ds-accent-soft)');
    expect(ATLAS_DARK.get('--ds-overlay-hover')).toBe('rgba(255,255,255,0.08)');
  });

  it('the error status surface and the toast edge take Atlas’s per-theme values', () => {
    expect(ATLAS_LIGHT.get('--ds-status-error-edge')).toBe('color-mix(in srgb, var(--ds-danger-mark) 35%, transparent)');
    expect(ATLAS_LIGHT.get('--ds-status-error-tint')).toBe('color-mix(in srgb, var(--ds-danger-mark) 6%, transparent)');
    expect(ATLAS_DARK.get('--ds-status-error-edge')).toBe('color-mix(in srgb, var(--ds-danger-mark) 40%, transparent)');
    expect(ATLAS_DARK.get('--ds-status-error-tint')).toBe('color-mix(in srgb, var(--ds-danger-mark) 8%, transparent)');
    // Toast: border-border/70 in light (= black 7 %), dark:border-white/[0.12].
    const light = atlasColor('--ds-toast-edge', 'light');
    expect([light.r, light.g, light.b, Math.round(light.a * 1000)]).toEqual([0, 0, 0, 70]);
    expect(ATLAS_DARK.get('--ds-toast-edge')).toBe('rgba(255,255,255,0.12)');
  });

  it('the enter / exit vocabulary: long-tail ease-out to arrive, quicker exits', () => {
    expect(ATLAS_LIGHT.get('--ds-ease-enter')).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(ATLAS_LIGHT.get('--ds-motion-enter')).toBe('280ms');
    expect(ATLAS_LIGHT.get('--ds-motion-exit')).toBe('160ms');
  });

  it('outside the skin the wave 5 tokens default to what the page paints today', () => {
    expect(ROOT_TOKENS.get('--ds-control-border')).toBe('var(--ds-hairline)');
    expect(ROOT_TOKENS.get('--ds-control-border-hover')).toBe('var(--ds-hairline)');
    expect(ROOT_TOKENS.get('--ds-focus')).toBe('var(--ds-ring)');
    expect(ROOT_TOKENS.get('--ds-overlay-edge')).toBe('var(--ds-hairline)');
    expect(ROOT_TOKENS.get('--ds-shadow-overlay')).toBe('var(--ds-shadow-soft)');
    expect(ROOT_TOKENS.get('--ds-danger-mark')).toBe('var(--ds-danger)');
    // .studio-shimmer's own slate block and glint, and the board Segmented's raised pill.
    expect(ROOT_TOKENS.get('--ds-skeleton')).toBe('rgba(148,163,184,0.12)');
    expect(ROOT_TOKENS.get('--ds-skeleton-glint')).toBe('rgba(148,163,184,0.22)');
    expect(ROOT_TOKENS.get('--ds-segment-pill')).toBe('var(--ds-raised)');
    expect(ROOT_TOKENS.get('--ds-shadow-segment')).toBe('0 1px 2px rgba(0,0,0,0.08)');
    expect(ROOT_TOKENS.get('--ds-segment-track')).toBe('var(--ds-well-strong)');
    // MENU_ITEM's hover, the error surface STATUS_SURFACE spelled out, TOAST's edge.
    expect(ROOT_TOKENS.get('--ds-overlay-hover')).toBe('var(--ds-hover)');
    expect(ROOT_TOKENS.get('--ds-status-error-edge')).toBe('color-mix(in srgb, var(--ds-danger-mark) 35%, transparent)');
    expect(ROOT_TOKENS.get('--ds-status-error-tint')).toBe('color-mix(in srgb, var(--ds-danger-mark) 6%, transparent)');
    expect(ROOT_TOKENS.get('--ds-toast-edge')).toBe('var(--ds-overlay-edge)');
    expect(ROOT_TOKENS.get('--ds-scrim')).toBe('rgba(0,0,0,0.40)');
    expect(DARK_TOKENS.get('--ds-scrim')).toBe('rgba(0,0,0,0.60)');
    // Nothing outside the skin read the old ones: the defaults equal today's surfaces.
    expect(DARK_TOKENS.get('--ds-surface-strong')).toBe('rgba(48,48,46,0.97)');
  });

  it('OS "increase contrast" applies the high-contrast tokens under the skin (light and dark)', () => {
    expect(Object.fromEntries(ATLAS_LIGHT_MORE)).toEqual({
      '--ds-hairline': 'rgba(0,0,0,0.32)',
      '--ds-hairline-soft': 'color-mix(in srgb, var(--ds-hairline) 60%, transparent)',
      '--ds-muted': '#404040',
      '--ds-ring': '#000000',
      '--ds-control-border': 'color-mix(in srgb, var(--ds-ink) 70%, transparent)',
      '--ds-control-border-hover': 'var(--ds-ink)'
    });
    // The dark base block (0,2,0) outranks the light high-contrast block (0,1,0), so the soft
    // hairline is restated for dark (tokenContrast.test.ts measures it strengthening in both themes).
    expect(Object.fromEntries(ATLAS_DARK_MORE)).toEqual({
      '--ds-hairline': 'oklch(0.52 0 0)',
      '--ds-hairline-soft': 'color-mix(in srgb, var(--ds-hairline) 60%, transparent)',
      '--ds-muted': '#d4d4d4',
      '--ds-ring': '#ffffff'
    });
    // Only under the skin: no :root or .dark block in the media query.
    expect(rules.some((r) => r.parents.includes('@media (prefers-contrast: more)') && /^(:root|\.dark)$/.test(r.selector))).toBe(false);
  });
});

describe('Atlas skin — (c) text contrast in both skin themes', () => {
  const pairs: Array<[string, string]> = [];
  for (const fg of ['--ds-ink', '--ds-muted']) for (const bg of ['--ds-canvas', '--ds-surface', '--ds-surface-soft', '--ds-well']) pairs.push([fg, bg]);

  it.each(pairs)('%s on %s ≥ 4.5:1 (light and dark)', (fg, bg) => {
    expect(contrastRatio(ATLAS_LIGHT.get(fg)!, ATLAS_LIGHT.get(bg)!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ATLAS_DARK.get(fg)!, ATLAS_DARK.get(bg)!)).toBeGreaterThanOrEqual(4.5);
  });

  it('on-accent text on the accent fill ≥ 4.5:1', () => {
    expect(contrastRatio(ATLAS_LIGHT.get('--ds-on-accent')!, ATLAS_LIGHT.get('--ds-accent')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ATLAS_DARK.get('--ds-on-accent')!, ATLAS_DARK.get('--ds-accent')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('the readable accent tokens (accent text, text-bearing fill) are the ink accent under the skin, so they fade with it', () => {
    // Outside the skin they are deeper terracottas (tokenContrast.test.ts); inside it nothing changes.
    expect(ATLAS_LIGHT.get('--ds-accent-text')).toBe('var(--ds-accent)');
    expect(ATLAS_LIGHT.get('--ds-accent-fill')).toBe('var(--ds-accent)');
    expect(ATLAS_LIGHT.get('--ds-accent-fill-hover')).toBe('var(--ds-accent-hover)');
    expect(ATLAS_DARK.get('--ds-accent-text')).toBe('var(--ds-accent)');
    // A selection inside a text-bearing fill flips like one inside the accent fill.
    const flip = rules.find((r) => r.selector.startsWith('[data-ds-skin="atlas"] :is(.bg-\\[var\\(--ds-ink\\)\\]') && r.selector.includes('::selection'));
    expect(flip?.selector).toContain('.bg-\\[var\\(--ds-accent-fill\\)\\]');
  });

  it('the helper itself is right (white on black = 21, white on #767676 ≈ 4.54)', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 1);
    expect(contrastRatio('rgba(0,0,0,1)', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('Atlas skin — fonts', () => {
  const faces = rules.filter((r) => r.selector === '@font-face');
  it('declares IBM Plex Sans 400/500/600/700 and Space Grotesk 500/600/700, swap, latin', () => {
    const got = faces.map((f) => {
      const fam = /font-family:\s*'([^']+)'/.exec(f.body)?.[1];
      const weight = /font-weight:\s*(\d+)/.exec(f.body)?.[1];
      const src = /url\(([^)]+)\)/.exec(f.body)?.[1];
      expect(f.body, fam).toContain('font-display: swap');
      expect(f.body, fam).toContain('unicode-range: U+0000-00FF');
      return `${fam} ${weight} ${src}`;
    });
    expect(got.sort()).toEqual([
      'IBM Plex Sans 400 /fonts/ibm-plex-sans-latin-400-normal.woff2',
      'IBM Plex Sans 500 /fonts/ibm-plex-sans-latin-500-normal.woff2',
      'IBM Plex Sans 600 /fonts/ibm-plex-sans-latin-600-normal.woff2',
      'IBM Plex Sans 700 /fonts/ibm-plex-sans-latin-700-normal.woff2',
      'Space Grotesk 500 /fonts/space-grotesk-latin-500-normal.woff2',
      'Space Grotesk 600 /fonts/space-grotesk-latin-600-normal.woff2',
      'Space Grotesk 700 /fonts/space-grotesk-latin-700-normal.woff2'
    ]);
  });

  it('ships the woff2 files and their OFL notice; the preloads are two of them', () => {
    for (const f of faces) {
      const src = /url\(([^)]+)\)/.exec(f.body)![1];
      expect(existsSync(path.join(ROOT, 'public', src)), src).toBe(true);
    }
    const licence = readFileSync(path.join(ROOT, 'public/fonts/LICENSE-OFL.md'), 'utf8');
    expect(licence).toMatch(/IBM Plex Sans/);
    expect(licence).toMatch(/Space Grotesk/);
    expect(licence).toMatch(/SIL Open Font License/);
    expect(licence).toMatch(/IBM Corp/);
    expect(licence).toMatch(/Space Grotesk Project Authors/);
    for (const href of ATLAS_PRELOAD_FONTS) expect(existsSync(path.join(ROOT, 'public', href)), href).toBe(true);
    expect(ATLAS_PRELOAD_FONTS).toEqual(['/fonts/ibm-plex-sans-latin-400-normal.woff2', '/fonts/ibm-plex-sans-latin-600-normal.woff2']);
  });

  it('does not add a Google Fonts link for them (index.html keeps only the lettering fonts)', () => {
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/Plex|Grotesk/i);
    expect(html).not.toMatch(/data-ds-skin/);
  });
});

describe('Atlas skin — base rules and the cross-fade', () => {
  const skinRule = (pred: (r: Rule) => boolean) => rules.find(pred);

  it('sets the body face and the display face for headings inside the skin', () => {
    const base = rules.filter((r) => r.selector === '[data-ds-skin="atlas"]').map((r) => r.body).join(';');
    expect(base).toContain('font-family: var(--ds-font-sans)');
    expect(base).toContain('-webkit-tap-highlight-color: transparent');
    expect(base).toMatch(/scrollbar-color: color-mix\(in srgb, var\(--ds-ink\) 22%, transparent\) transparent/);
    const headings = skinRule((r) => r.selector === '[data-ds-skin="atlas"] :is(h1, h2, h3, h4, .ds-font-display)');
    expect(headings?.body).toContain('font-family: var(--ds-font-display)');
    expect(headings?.body).toContain('text-wrap-style: balance');
    expect(skinRule((r) => r.selector === '[data-ds-skin="atlas"] :is(p, li, dd, figcaption, blockquote)')?.body).toContain('text-wrap-style: pretty');
    expect(skinRule((r) => r.selector === '[data-ds-skin="atlas"] .font-sans')?.body).toContain('var(--ds-font-sans)');
  });

  it('inverts selection with the inverted-surface exception', () => {
    const sel = skinRule((r) => r.selector === '[data-ds-skin="atlas"] *::selection, [data-ds-skin="atlas"]::selection');
    expect(sel?.body).toContain('background-color: var(--ds-ink)');
    const flip = skinRule((r) => r.selector.startsWith('[data-ds-skin="atlas"] :is(.bg-\\[var\\(--ds-ink\\)\\]') && r.selector.includes('::selection'));
    expect(flip?.body).toContain('background-color: var(--ds-canvas)');
  });

  it('keyboard focus: 2 px ink outline offset 2 px in the base layer (3 px under prefers-contrast: more)', () => {
    const focus = skinRule((r) => r.selector === ':where([data-ds-skin="atlas"]) :focus-visible' && r.parents.length === 1);
    expect(focus?.parents).toEqual(['@layer base']);
    expect(focus?.body).toContain('outline: 2px solid var(--ds-ink)');
    expect(focus?.body).toContain('outline-offset: 2px');
    const more = skinRule((r) => r.selector === ':where([data-ds-skin="atlas"]) :focus-visible' && r.parents.includes('@media (prefers-contrast: more)'));
    expect(more?.body).toContain('outline-width: 3px');
  });

  it('press feedback is motion-safe and skin-scoped', () => {
    const press = skinRule((r) => r.selector === '[data-ds-skin="atlas"] .ds-press:active:not(:disabled):not([aria-disabled="true"])');
    expect(press?.parents).toEqual(['@media (prefers-reduced-motion: no-preference)']);
    expect(press?.body).toContain('transform: scale(0.97)');
    const soft = skinRule((r) => r.selector === '[data-ds-skin="atlas"] .ds-press-soft:active:not(:disabled):not([aria-disabled="true"])');
    expect(soft?.body).toContain('transform: scale(0.98)');
    expect(rules.some((r) => r.selector === '.ds-press')).toBe(false);
  });

  it('theme switch (wave 5): one view-transition cross-fade of the page over --ds-motion-theme, on <html> under the skin only', () => {
    const vt = rules.filter((r) => r.selector.includes('::view-transition-'));
    expect(vt.map((r) => r.selector)).toEqual([
      `html[data-ds-skin="atlas"].${DS_THEME_TRANSITION_CLASS}::view-transition-old(root), html[data-ds-skin="atlas"].${DS_THEME_TRANSITION_CLASS}::view-transition-new(root)`
    ]);
    expect(vt[0].body).toContain('animation-duration: var(--ds-motion-theme)');
    expect(vt[0].body).toContain('animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1)');
  });

  it('theme switch: element transitions are held for the one frame that flips the theme (skin-scoped)', () => {
    const hold = rules.find((r) => r.selector.includes(`.${DS_NO_TRANSITIONS_CLASS}`));
    expect(hold?.selector).toBe(
      [``, ` *`, ` *::before`, ` *::after`].map((tail) => `[data-ds-skin="atlas"].${DS_NO_TRANSITIONS_CLASS}${tail}`).join(', ')
    );
    expect(hold?.body).toBe('transition: none !important;');
    expect(hold?.parents).toEqual([]);
  });

  it('theme switch: no registered or transitioned colour tokens any more (they restyled every element per frame)', () => {
    expect(css).not.toMatch(/@property\s+--ds-/);
    expect(css).not.toMatch(/data-ds-skin-fade/);
    for (const r of rules) expect(r.body, r.selector).not.toMatch(/transition-property:[^;]*--ds-/);
  });

  it('every rule in the skin section is scoped to the attribute (nothing outside the skin changes)', () => {
    const start = css.indexOf('ATLAS SKIN — `[data-ds-skin="atlas"]`');
    expect(start).toBeGreaterThan(0);
    const section = parseRules(css.slice(css.lastIndexOf('/* ===', start)));
    const unscoped = section
      .filter((r) => r.selector !== '@font-face' && !r.parents.some((p) => p.startsWith('@keyframes')))
      .flatMap((r) => topLevelSplit(r.selector).filter((item) => !item.includes('[data-ds-skin="atlas"]')).map((item) => `${item} (${r.parents.join(' / ') || 'top level'})`));
    expect(unscoped).toEqual([]);
    expect(section.length).toBeGreaterThan(80);
  });

  it('nothing in the skin section targets html by element, and the reader room stays content', () => {
    for (const r of rules) {
      if (!r.selector.includes('data-ds-skin')) continue;
      expect(r.body, r.selector).not.toMatch(/--ds-reader-/);
    }
  });
});

describe('Atlas skin — wave 5 base rules (motion, skeletons, toasts, the inverse surface)', () => {
  const REDUCE = '@media (prefers-reduced-motion: reduce)';
  const find = (selector: string, parents: string[] = []) =>
    rules.find((r) => r.selector === selector && r.parents.join('|') === parents.join('|'));

  it('reduced motion: hover nudges land without travelling, Tailwind spinners and pings hold still (skin only)', () => {
    expect(find('[data-ds-skin="atlas"] .transition-transform', [REDUCE])?.body).toBe('transition-duration: 0s !important;');
    expect(find('[data-ds-skin="atlas"] :is(.animate-spin, .animate-ping, .animate-bounce)', [REDUCE])?.body).toBe('animation: none;');
    // Never outside the skin.
    expect(rules.some((r) => /^\.(transition-transform|animate-spin)$/.test(r.selector) && r.parents.includes(REDUCE))).toBe(false);
  });

  it('skeletons (.studio-shimmer) take the Atlas block and glint under the skin: no slate hue, lifted in dark', () => {
    const sk = find('[data-ds-skin="atlas"] .studio-shimmer');
    expect(sk?.body).toContain('background-color: var(--ds-skeleton)');
    expect(sk?.body).toContain('background-image: linear-gradient(100deg, transparent 30%, var(--ds-skeleton-glint) 50%, transparent 70%)');
    // Motion is the existing rule's (and stays off under reduced motion there).
    expect(sk?.body).not.toMatch(/animation/);
  });

  it('toasts: a time-left bar that drains on the compositor, holds with the dismiss clock and hides under reduced motion', () => {
    expect(rules.some((r) => r.parents[0] === '@keyframes ds-toast-countdown')).toBe(true);
    const bar = find('[data-ds-skin="atlas"] .ds-toast-countdown');
    expect(bar?.body).toContain('transform-origin: left center');
    expect(bar?.body).toContain('animation: ds-toast-countdown var(--ds-toast-duration, 4s) linear forwards');
    expect(find('[data-ds-skin="atlas"] .ds-toast[data-paused] .ds-toast-countdown')?.body).toBe('animation-play-state: paused;');
    expect(find('[data-ds-skin="atlas"] .ds-toast-countdown', [REDUCE])?.body).toBe('display: none;');
  });

  it('toasts arrive on the enter curve in 300 ms and leave in 200 ms (Atlas), the removal timer outlasting the exit; neither moves under reduced motion', () => {
    expect(find('[data-ds-skin="atlas"] .ds-toast-enter')?.body).toBe('animation: ds-toast-in 300ms var(--ds-ease-enter) backwards;');
    expect(find('[data-ds-skin="atlas"] .ds-toast-exit')?.body).toBe(`animation: ds-toast-out ${design.TOAST_EXIT_MS}ms var(--ds-ease) forwards;`);
    expect(design.TOAST_EXIT_MS).toBe(200);
    expect(design.TOAST_EXIT_FALLBACK_MS - design.TOAST_EXIT_MS).toBeGreaterThanOrEqual(16); // a frame of slack
    // Atlas: the enter slides 12 px (slide-in-from-top-3) with zoom .98, the exit 8 px (slide-out-to-top-2).
    expect(rules.find((r) => r.parents[0] === '@keyframes ds-toast-in' && r.selector === 'from')?.body).toContain('translateY(-12px) scale(0.98)');
    expect(rules.find((r) => r.parents[0] === '@keyframes ds-toast-out' && r.selector === 'to')?.body).toContain('translateY(-8px)');
    expect(find('[data-ds-skin="atlas"] :is(.ds-toast-enter, .ds-toast-exit)', [REDUCE])?.body).toBe('animation: none;');
    // The keyframes end on `transform: none` / leave no transform behind on arrival.
    expect(rules.find((r) => r.parents[0] === '@keyframes ds-toast-in' && r.selector === 'to')?.body).toContain('transform: none');
  });

  it('the inverse surface stays a raised dark panel in dark (ink and page swapped back inside, as Atlas; never the accent), and its focus is visible', () => {
    const dark = find('.dark[data-ds-skin="atlas"] .ds-inverse-surface, .dark [data-ds-skin="atlas"] .ds-inverse-surface');
    expect(dark?.body).toContain('--ds-ink: #161616');
    expect(dark?.body).toContain('--ds-canvas: #fafafa');
    // Atlas swaps --foreground / --background only. The accent-derived tokens are computed at the skin
    // root, so an accent swap here left the primary button's paper fill under a paper label
    // (tokenContrast.test.ts measures the panel, its primary button and its focus in both themes).
    expect(dark?.body).not.toMatch(/--ds-(?:accent|on-accent)[\w-]*\s*:/);
    expect(dark?.body).toContain('box-shadow: 0 0 0 1px rgb(255 255 255 / 0.1), var(--ds-shadow-panel)');
    expect(find('[data-ds-skin="atlas"] .ds-inverse-surface')?.body).toBe('--ds-focus: var(--ds-canvas);');
    expect(find('[data-ds-skin="atlas"] .ds-inverse-surface :focus-visible')?.body).toBe('outline-color: var(--ds-canvas);');
  });
});

describe('Atlas skin — wave 5 recipes in studioDesign (focus, fields, overlays, chips, status, tabs, section cards, toasts)', () => {
  const classes = (v: string) => v.split(/\s+/).filter(Boolean);
  const all = Object.entries(design).flatMap(([name, v]) =>
    typeof v === 'string' ? [[name, v] as const] : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => [`${name}.${k}`, String(x)] as const) : []
  );

  it('focus: the solid 2 px focus-colour outline offset 2 px (flush for tabs), 3 px under increase contrast; inset ring for list items', () => {
    expect(classes(design.FOCUS_RING)).toEqual([
      'focus-visible:outline', 'focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-[color:var(--ds-focus)]', 'contrast-more:focus-visible:outline-[3px]'
    ]);
    expect(design.FOCUS_RING_FLUSH).toBe(design.FOCUS_RING.replace('outline-offset-2', 'outline-offset-0'));
    expect(design.FOCUS_ITEM).toBe(
      'focus-visible:outline-none focus-visible:bg-[var(--ds-overlay-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-ring)]'
    );
    // The menu row's hover is the same overlay highlight (the hover tint outside the skin).
    expect(classes(design.MENU_ITEM)).toContain('hover:bg-[var(--ds-overlay-hover)]');
  });

  it('fields: the 3:1 control edge, focus drawn as a ring (2 px of focus colour set 2 px off) so an embedded field can drop it', () => {
    for (const c of [
      'border-[var(--ds-control-border)]', 'hover:border-[var(--ds-control-border-hover)]', 'focus-visible:border-[var(--ds-focus)]',
      'focus-visible:outline-none', 'focus-visible:ring-2', 'focus-visible:ring-[var(--ds-focus)]', 'focus-visible:ring-offset-2',
      'focus-visible:ring-offset-[color:var(--ds-canvas)]', 'placeholder:text-[var(--ds-muted)]', design.RADIUS_CONTROL
    ]) expect(classes(design.FIELD), c).toContain(c);
    // Embedded in a group that shows focus itself: drop BOTH the ring and its offset (ring-0 alone
    // leaves the page-coloured offset painted over a 0 px ring: no visible focus at all).
    expect(classes(design.FIELD_EMBEDDED)).toEqual(expect.arrayContaining(['focus-visible:ring-0', 'focus-visible:ring-offset-0', 'focus-visible:outline-none']));
    // The group (Atlas's search pills) rests on the hairline and shows focus as a field does: the edge
    // in the focus colour and a 2 px focus ring set 2 px off (tokenContrast.test.ts: ≥ 3:1 change).
    for (const c of [
      'border-[var(--ds-hairline)]', 'hover:border-[color:color-mix(in_srgb,var(--ds-ink)_25%,transparent)]', 'focus-within:border-[var(--ds-focus)]',
      'focus-within:ring-2', 'focus-within:ring-[var(--ds-focus)]', 'focus-within:ring-offset-2', 'focus-within:ring-offset-[color:var(--ds-canvas)]'
    ]) expect(classes(design.FIELD_GROUP), c).toContain(c);
  });

  it('overlays and scrims read the overlay tokens; the scrim has no blur', () => {
    for (const c of ['bg-[var(--ds-raised)]', 'border-[var(--ds-overlay-edge)]', 'shadow-[shadow:var(--ds-shadow-overlay)]', design.RADIUS_PANEL])
      expect(classes(design.OVERLAY), c).toContain(c);
    expect(design.SCRIM).toBe('bg-[var(--ds-scrim)]');
    expect(design.SCRIM).not.toMatch(/blur/);
  });

  it('the overline: 11 px semibold, 0.12em tracking, uppercase, muted', () => {
    expect(design.OVERLINE).toBe('text-[11px] font-semibold leading-4 tracking-[0.12em] uppercase text-[var(--ds-muted)]');
  });

  it('chips: one shape, three variants (outline, filled, dashed)', () => {
    expect(classes(design.CHIP)).toEqual(expect.arrayContaining([design.RADIUS_PILL, 'border', 'text-[11px]', 'font-medium', 'leading-4']));
    expect(Object.keys(design.CHIP_VARIANT)).toEqual(['outline', 'filled', 'dashed']);
    expect(design.CHIP_VARIANT.dashed).toContain('border-dashed');
    expect(design.CHIP_VARIANT.filled).toContain('bg-[color:color-mix(in_srgb,var(--ds-ink)_6%,transparent)]');
  });

  it('one status vocabulary: healthy / active / waiting / attention / error, ink + surface + dot, hue only where it means something', () => {
    const states = ['healthy', 'active', 'waiting', 'attention', 'error'] as const;
    for (const m of [design.STATUS_INK, design.STATUS_EDGE, design.STATUS_SURFACE, design.STATUS_DOT, design.STATUS_CHIP_TONE]) expect(Object.keys(m)).toEqual([...states]);
    // Wave 8: the edge alone (a neutral toast or hint bubble that borders in the state's colour) is the
    // surface's own edge, so the two never drift apart.
    for (const st of states) {
      expect(design.STATUS_EDGE[st]).toMatch(/^border-\[/);
      expect(design.STATUS_SURFACE[st].startsWith(`${design.STATUS_EDGE[st]} bg-[`), st).toBe(true);
    }
    expect(design.STATUS_INK).toEqual({
      healthy: design.TONE_TEXT.success, active: 'text-[var(--ds-ink)]', waiting: 'text-[var(--ds-muted)]', attention: design.TONE_TEXT.warning, error: design.TONE_TEXT.danger
    });
    expect(design.STATUS_SURFACE.healthy).toContain('var(--ds-success)_6%');
    expect(design.STATUS_SURFACE.attention).toContain('var(--ds-warning)_8%');
    expect(design.STATUS_SURFACE.error).toBe('border-[var(--ds-status-error-edge)] bg-[var(--ds-status-error-tint)]');
    expect(design.STATUS_DOT.error).toBe('bg-[var(--ds-danger-mark)]');
    expect(design.STATUS_DOT.active).toBe('bg-[var(--ds-ink)]');
    for (const st of states) expect(design.STATUS_CHIP_TONE[st]).toBe(`${design.STATUS_SURFACE[st]} ${design.STATUS_INK[st]}`);
    expect(classes(design.STATUS_CHIP)).toEqual(expect.arrayContaining([design.RADIUS_PILL, 'border', 'px-2.5', 'py-0.5', 'text-[11px]', 'font-medium']));
    // The danger MARK (brighter in dark) for fills and tone surfaces; the readable danger text is unchanged.
    expect(design.TONE_FILL.danger).toBe('bg-[var(--ds-danger-mark)]');
    expect(design.TONE_SURFACE.danger).toContain('var(--ds-danger-mark)');
  });

  it('segmented tabs: a soft track, the pill that glides on the panel time and the spring, flush focus', () => {
    // PanelTabs: bg-muted/60 (dark /50) through --ds-segment-track, border-border/70.
    for (const c of ['bg-[var(--ds-segment-track)]', 'border-[color:color-mix(in_srgb,var(--ds-hairline)_70%,transparent)]', 'p-0.5', design.RADIUS_CONTROL])
      expect(classes(design.SEGMENTED_TRACK), c).toContain(c);
    expect(design.SEGMENTED_ITEM).toContain(design.FOCUS_RING_FLUSH);
    expect(classes(design.SEGMENTED_ITEM)).toEqual(expect.arrayContaining(['text-[var(--ds-muted)]', 'hover:text-[var(--ds-ink)]', 'aria-checked:text-[var(--ds-ink)]', 'aria-selected:text-[var(--ds-ink)]', 'text-[13px]']));
    expect(design.SEGMENTED_ACTIVE).toBe('bg-[var(--ds-segment-pill)] text-[var(--ds-ink)] shadow-[shadow:var(--ds-shadow-segment)]');
    expect(classes(design.SEGMENTED_PILL)).toEqual(expect.arrayContaining([
      'bg-[var(--ds-segment-pill)]', 'shadow-[shadow:var(--ds-shadow-segment)]', 'transition-[transform,width]', 'duration-[var(--ds-motion-panel)]', 'ease-[var(--ds-ease-spring)]', 'motion-reduce:transition-none'
    ]));
  });

  it('section cards: the settings-style header (36 px icon tile, 16 px title, muted description, divider)', () => {
    for (const c of ['overflow-hidden', design.RADIUS_PANEL, 'border-[var(--ds-hairline)]', 'bg-[var(--ds-surface)]', design.SHADOW_SOFT]) expect(design.SECTION_CARD, c).toContain(c);
    expect(classes(design.SECTION_HEADER)).toEqual(expect.arrayContaining(['border-b', 'border-[var(--ds-hairline)]', 'px-5', 'py-5', 'sm:px-6', 'flex-wrap']));
    expect(classes(design.SECTION_ICON_TILE)).toEqual(expect.arrayContaining(['h-9', 'w-9', 'bg-[var(--ds-well)]', 'border-[var(--ds-hairline)]']));
    expect(classes(design.SECTION_TITLE)).toEqual(expect.arrayContaining(['text-[length:var(--ds-text-lg)]', 'font-semibold', 'leading-6', 'tracking-[-0.01em]', design.FONT_DISPLAY]));
    expect(classes(design.SECTION_DESCRIPTION)).toEqual(expect.arrayContaining(['text-[var(--ds-muted)]', 'text-[length:var(--ds-text-base)]']));
    expect(design.SECTION_BODY).toBe('px-5 py-5 sm:px-6');
  });

  it('toasts: a monochrome card with a status edge and a time-left bar; the hue lives on the edge, bar and icon only', () => {
    // GlobalNotificationBar: rounded-2xl, border-border/70 (dark white 12 %), bg-card (dark surface-elevated), shadow-panel.
    for (const c of ['ds-toast', 'rounded-2xl', 'border-[var(--ds-toast-edge)]', 'bg-[var(--ds-raised)]', 'shadow-[shadow:var(--ds-shadow-panel)]', 'text-[var(--ds-ink)]'])
      expect(classes(design.TOAST), c).toContain(c);
    expect(classes(design.TOAST_TITLE)).toContain('line-clamp-2');
    expect(classes(design.TOAST_MESSAGE)).toContain('line-clamp-3');
    // Atlas light: bg-card #ffffff, dark: bg-surface-elevated #1a1a1a — the raised step in both.
    expect(atlasColor('--ds-raised', 'light')).toEqual(atlasColor('--ds-surface', 'light'));
    expect(ATLAS_DARK.get('--ds-raised')).toBe('#1a1a1a');
    expect(design.TOAST).not.toMatch(/--ds-(success|warning|danger|info)/);
    expect(classes(design.TOAST_EDGE)).toEqual(expect.arrayContaining(['absolute', 'inset-y-0', 'left-0', 'w-1']));
    expect(classes(design.TOAST_COUNTDOWN)).toEqual(expect.arrayContaining(['ds-toast-countdown', 'absolute', 'bottom-0', 'h-0.5', 'w-full']));
    expect([design.TOAST_ENTER, design.TOAST_EXIT]).toEqual(['ds-toast-enter', 'ds-toast-exit']);
    expect(design.TOAST_MESSAGE).toContain('text-[var(--ds-muted)]');
    expect(classes(design.TOAST_SLOT)).toEqual(expect.arrayContaining(['grid', 'transition-[grid-template-rows]', 'motion-reduce:transition-none']));
    expect([design.TOAST_SLOT_OPEN, design.TOAST_SLOT_CLOSED]).toEqual(['grid-rows-[1fr]', 'grid-rows-[0fr]']);
  });

  it('the inverse surface helper', () => {
    expect(design.INVERSE_SURFACE).toBe('ds-inverse-surface bg-[var(--ds-ink)] text-[var(--ds-canvas)]');
  });

  it('every wave 5 recipe is token-driven: no hex, no rgb literal, no Tailwind palette colour', () => {
    const recipes = all.filter(([n]) => /^(FOCUS_|FIELD|OVERLAY|SCRIM|OVERLINE|CHIP|STATUS_|SEGMENTED_|SECTION_|TOAST|INVERSE_)/.test(n));
    expect(recipes.length).toBeGreaterThan(30);
    for (const [n, v] of recipes) {
      expect(v, n).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|\b(?:bg|text|border|ring|outline)-(?:white|black|gray|slate|zinc|neutral|red|green|amber|blue)\b/i);
    }
  });

  it('overlay entrances (.animate-scale-in: popovers, sheets, toasts) run on the enter curve under the skin', () => {
    const r = rules.find((x) => x.selector === '[data-ds-skin="atlas"] .animate-scale-in');
    expect(r?.body).toBe('animation-timing-function: var(--ds-ease-enter);');
  });
});

