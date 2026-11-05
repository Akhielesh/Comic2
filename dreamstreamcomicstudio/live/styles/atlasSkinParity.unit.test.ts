// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { type Rgba, indexCss, parseRules, resolveColor, tokensOf, topLevelSplit } from '../../tests/config/cssTokens';
import { type ThemeName, color } from './skinTokens';

/**
 * Stream Studio's Atlas skin (live/styles/atlas-skin.css) can't import the main app's index.css
 * (Tailwind's preflight would reset its plain CSS), so it restates the Atlas values over its own
 * token names. This keeps the two layers from drifting: every Stream colour token below must
 * resolve to exactly the colour of the `--ds-*` token it mirrors in index.css's Atlas skin block
 * (`[data-ds-skin="atlas"]`, and its `.dark` twin), in both themes. Colours only — radii, shadows
 * and motion are Stream-shaped (and the shared radius is changing in the token commit).
 *
 * When the token owner changes an Atlas colour in index.css, this fails until atlas-skin.css
 * follows (or the mapping below says why it shouldn't).
 */

/** Stream token → the --ds-* token it mirrors (both themes unless a theme is named). */
const MAP: [stream: string, ds: string][] = [
  ['--bg', '--ds-canvas'],
  ['--panel', '--ds-surface'],
  ['--panel-2', '--ds-surface-soft'],
  ['--panel-3', '--ds-accent-soft'],
  ['--hover', '--ds-hover'],
  ['--sidebar', '--ds-sidebar'],
  ['--raised', '--ds-surface-strong'], // overlays: a step above the cards in dark (Atlas --popover)
  ['--line', '--ds-hairline'],
  ['--line-soft', '--ds-hairline-soft'],
  ['--text', '--ds-ink'],
  ['--muted', '--ds-muted'],
  ['--accent', '--ds-accent'],
  ['--accent-2', '--ds-accent-hover'],
  ['--accent-ink', '--ds-accent-text'],
  ['--accent-wash', '--ds-accent-soft'],
  ['--chip', '--ds-accent-soft'],
  ['--on-accent', '--ds-on-accent'],
  ['--nav-active', '--ds-active'],
  ['--control-border', '--ds-control-border'],
  ['--overlay-edge', '--ds-overlay-edge'],
  ['--scrim', '--ds-scrim'],
  // Status: the hue, and the readable ink Stream uses as text.
  ['--green-mark', '--ds-success'],
  ['--amber-mark', '--ds-warning'],
  ['--blue-mark', '--ds-info'],
  ['--live-mark', '--ds-danger-mark'],
  ['--green', '--ds-success-text'],
  ['--amber', '--ds-warning-text'],
  ['--blue', '--ds-info-text'],
  ['--live', '--ds-danger-text'],
];

const rules = parseRules(indexCss).filter((r) => r.parents.length === 0);
const selectors = (s: string) => topLevelSplit(s).map((x) => x.replace(/\s+/g, ' ').trim());
const defines = (body: string) => /--ds-canvas\s*:/.test(body);
/** The Atlas light block: a top-level rule naming the skin's element on its own (however written). */
const LIGHT_SUBJECT = /^(?:html|:root)?\[data-ds-skin="atlas"\]$/;
/** The Atlas dark block: the skin's element with `.dark` (not a descendant such as an inverse panel). */
const DARK_SUBJECT = /^(?:html|:root)?(?:\.dark\[data-ds-skin="atlas"\]|\[data-ds-skin="atlas"\]\.dark)$/;
const tokenRules = rules.filter((r) => defines(r.body));
const DS_LIGHT = tokensOf(tokenRules, (s) => selectors(s).some((x) => LIGHT_SUBJECT.test(x)));
const DS_DARK = tokensOf(tokenRules, (s) => selectors(s).some((x) => DARK_SUBJECT.test(x)));

const dsColor = (name: string, theme: ThemeName): Rgba => {
  const layers = theme === 'dark' ? [DS_DARK, DS_LIGHT] : [DS_LIGHT];
  const lookup = (n: string) => {
    for (const m of layers) {
      const v = m.get(n);
      if (v !== undefined) return v;
    }
    throw new Error(`${n} is not in index.css's Atlas skin (${theme})`);
  };
  return resolveColor(`var(${name})`, lookup);
};

const close = (a: Rgba, b: Rgba) => Math.abs(a.r - b.r) < 0.6 && Math.abs(a.g - b.g) < 0.6 && Math.abs(a.b - b.b) < 0.6 && Math.abs(a.a - b.a) < 0.005;
const show = ({ r, g, b, a }: Rgba) => `rgba(${r.toFixed(1)}, ${g.toFixed(1)}, ${b.toFixed(1)}, ${a.toFixed(3)})`;

describe('Stream Studio’s Atlas skin = the main app’s Atlas skin (colours)', () => {
  it('finds both Atlas token blocks in index.css', () => {
    expect(DS_LIGHT.get('--ds-canvas')).toBeTruthy();
    expect(DS_DARK.get('--ds-canvas')).toBeTruthy();
    expect(DS_LIGHT.get('--ds-canvas')).not.toEqual(DS_DARK.get('--ds-canvas'));
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`every mapped colour matches (${theme})`, () => {
      const drift: string[] = [];
      for (const [stream, ds] of MAP) {
        const a = color(stream, theme);
        const b = dsColor(ds, theme);
        if (!close(a, b)) drift.push(`${stream} ${show(a)} ≠ ${ds} ${show(b)}`);
      }
      expect(drift).toEqual([]);
    });
  }

  // The greyscale chart ramp: checked once index.css names it (the token commit adds --ds-chart-1…5);
  // until then the values are Atlas's --chart-1…5 (AtlasD app/globals.css), pinned here.
  const ATLAS_CHART = {
    light: ['#0a0a0a', '#525252', '#858585', '#b0b0b0', '#d4d4d4'],
    dark: ['#fafafa', '#b8b8b8', '#8a8a8a', '#5e5e5e', '#3d3d3d'],
  } as const;
  for (const theme of ['light', 'dark'] as const) {
    it(`the chart ramp is Atlas's (${theme})`, () => {
      const hasDs = DS_LIGHT.has('--ds-chart-1');
      ATLAS_CHART[theme].forEach((hex, i) => {
        const ours = color(`--chart-${i + 1}`, theme);
        const want = hasDs ? dsColor(`--ds-chart-${i + 1}`, theme) : color(hex, theme);
        expect(close(ours, want), `--chart-${i + 1} ${show(ours)} (${theme})`).toBe(true);
      });
    });
  }

  it('LIVE / REC fills are Atlas’s destructive red in both themes (white on it ≥ 4.5:1; the dark theme’s deep fill would read as a disabled control beside the stage)', () => {
    const red = dsColor('--ds-danger', 'light');
    expect(close(color('--live-fill', 'light'), red)).toBe(true);
    expect(close(color('--live-fill', 'dark'), red)).toBe(true);
  });

  it('--faint is Stream’s own (Atlas has no faint TEXT token; --ds-faint is 35 % ink, for placeholders only)', () => {
    // Recorded so a reader of this test sees the one deliberate difference.
    expect(MAP.some(([s]) => s === '--faint')).toBe(false);
  });
});
